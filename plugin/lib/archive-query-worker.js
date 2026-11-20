// Fixed entry, private IPC only. Linux descriptor pinning rejects symlink/path replacement before database reads.
import { constants as F, openSync, closeSync, fstatSync, lstatSync, opendirSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ARCHIVE_ACCESS_LIMITS, ArchiveAccessError, validateArchiveRoot } from './archive-access.js';
import { decodeZstd, ZSTD_MAGIC } from './snapshot.js';
const fail = code => { throw new ArchiveAccessError(code); };
const qi = text => '"' + String(text).replaceAll('"', '""') + '"';
const digest = value => createHash('sha256').update(value).digest('hex');
const localTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' });
const identity = st => [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs, st.mode].map(String).join(':');
const directoryFlags = F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW;
const fileFlags = F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK;
function limitsFor(raw = ARCHIVE_ACCESS_LIMITS) {
  const out = {};
  for (const [key, ceiling] of Object.entries(ARCHIVE_ACCESS_LIMITS)) {
    const value = raw[key];
    if (!Number.isSafeInteger(value) || value < (key === 'maxOffset' ? 0 : 1) || value > ceiling) fail('invalid-options'); out[key] = value;
  }
  return out;
}
function capture(root, rawLimits, forbiddenRoots) {
  validateArchiveRoot(root, forbiddenRoots);
  if (process.platform !== 'linux' || !F.O_NOFOLLOW || !F.O_DIRECTORY) fail('unsupported-platform');
  const limits = limitsFor(rawLimits), descriptors = [], files = new Map(), entries = [], ancestors = [];
  let entryCount = 0, directoryCount = 0, fileCount = 0, totalDbBytes = 0;
  const close = () => { for (const fd of descriptors.reverse()) { try { closeSync(fd); } catch {} } descriptors.length = 0; };
  const opened = (path, flags) => { try { const fd = openSync(path, flags); descriptors.push(fd); return fd; } catch { fail('path-rejected'); } };
  try {
    let current = opened('/', directoryFlags), prefix = '';
    for (const part of root.slice(1).split('/')) {
      if (!part || part === '.' || part === '..') fail('forbidden-root');
      current = opened('/proc/self/fd/' + current + '/' + part, directoryFlags); prefix += '/' + part;
      const st = fstatSync(current, { bigint: true });
      if (!st.isDirectory()) fail('path-rejected'); ancestors.push([prefix, String(st.dev), String(st.ino)]);
    }
    const rootFd = current;
    const walk = (fd, rel, depth) => {
      if (++directoryCount > limits.maxDirectories || depth > limits.maxDepth) fail('file-budget-exceeded');
      const st = fstatSync(fd, { bigint: true }); entries.push([rel || '.', 'directory', identity(st)]);
      const directory = opendirSync('/proc/self/fd/' + fd, { bufferSize: 16 });
      try {
        for (let item; (item = directory.readSync());) {
          if (++entryCount > limits.maxEntries || Buffer.byteLength(item.name) > 256) fail('file-budget-exceeded');
          const relativePath = rel ? rel + '/' + item.name : item.name, path = '/proc/self/fd/' + fd + '/' + item.name;
          const before = lstatSync(path, { bigint: true });
          if (before.isSymbolicLink()) fail('path-rejected');
          if (before.isDirectory()) {
            const child = opened(path, directoryFlags), after = fstatSync(child, { bigint: true });
            if (identity(before) !== identity(after)) fail('snapshot-changed'); walk(child, relativePath, depth + 1);
          } else if (before.isFile()) {
            if (++fileCount > limits.maxFiles) fail('file-budget-exceeded');
            if (before.nlink !== 1n) fail('path-rejected');
            entries.push([relativePath, 'file', identity(before)]);
            if (/\.db-(?:wal|shm|journal)$/i.test(item.name)) fail('unsupported-layout');
            if (item.name.endsWith('.db')) {
              if (!['contact/contact.db', 'session/session.db', 'sns/sns.db', 'favorite/favorite.db', 'content/content.db'].includes(relativePath) && !/^message\/[a-zA-Z0-9_.-]+\.db$/.test(relativePath)) fail('unsupported-layout');
              const dbFd = opened(path, fileFlags), after = fstatSync(dbFd, { bigint: true });
              if (!after.isFile() || after.nlink !== 1n || identity(before) !== identity(after)) fail('snapshot-changed');
              if (after.size < 100n || after.size > BigInt(limits.maxDbBytes)) fail('file-budget-exceeded');
              totalDbBytes += Number(after.size); if (totalDbBytes > limits.maxTotalDbBytes) fail('file-budget-exceeded');
              files.set(relativePath, dbFd);
            }
          } else fail('path-rejected');
        }
      } finally { directory.closeSync(); }
    };
    walk(rootFd, '', 0); if (!files.size) fail('unsupported-layout');
    entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const metadata = { version: 1, fingerprint: digest(JSON.stringify({ root, ancestors, entries })), files: [...files.keys()].sort() };
    return { root, metadata, files, limits, close };
  } catch (error) { close(); if (error instanceof ArchiveAccessError) throw error; fail('path-rejected'); }
}
export function captureArchiveMetadata(root, limits = ARCHIVE_ACCESS_LIMITS, forbiddenRoots = []) {
  const catalog = capture(root, limits, forbiddenRoots); try { return catalog.metadata; } finally { catalog.close(); }
}
function epoch(value) {
  if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  let n = Number(value); if (!Number.isSafeInteger(n) || n < 0) return null;
  const maximumSeconds = 253402300799;
  if (n > maximumSeconds * 1000) n = Math.floor(n / 1e6); else if (n > maximumSeconds) n = Math.floor(n / 1000);
  return n <= maximumSeconds ? n : null;
}
function withDb(catalog, rel, fn) {
  const fd = catalog.files.get(rel); if (fd === undefined) fail('unsupported-layout');
  const header = Buffer.alloc(100);
  if (readSync(fd, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') fail('unsupported-layout');
  // Only quiescent rollback-mode SQLite files. No live WAL/SHM/journal fallback.
  if (header[18] !== 1 || header[19] !== 1) fail('unsupported-layout');
  let db;
  try {
    db = new DatabaseSync('file:/proc/self/fd/' + fd + '?mode=ro&immutable=1', { readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false, timeout: 0 });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
    db.function('_archive_epoch', { deterministic: true }, epoch);
    db.function('_archive_text', { deterministic: true }, value => {
      if (typeof value === 'string') return value;
      if (!(value instanceof Uint8Array)) fail('unsupported-content');
      const raw = Buffer.from(value);
      if (!raw.subarray(0, 4).equals(ZSTD_MAGIC)) fail('unsupported-content');
      try { return new TextDecoder('utf-8', { fatal: true }).decode(decodeZstd(raw)); }
      catch { fail('unsupported-content'); }
    });
    return fn(db);
  } catch (error) { if (error instanceof ArchiveAccessError) throw error; fail('unsupported-schema'); }
  finally { if (db) { try { db.close(); } catch {} } }
}
function tables(db, limits, names) {
  const selectedNames = names ? ' AND lower(name) IN (' + names.map(() => '?').join(',') + ')' : '';
  const rows = db.prepare("SELECT name, substr(sql,1,64) AS declaration FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'"
    + selectedNames + ' ORDER BY name LIMIT ?').all(...(names?.map(name => name.toLowerCase()) ?? []), limits.maxTables + 1);
  if (rows.length > limits.maxTables) fail('file-budget-exceeded');
  return rows.map(row => ({ name: row.name, regular: typeof row.name === 'string' && /^\s*CREATE\s+TABLE\b/i.test(row.declaration || '') }));
}
function columns(db, table) {
  const rows = db.prepare('PRAGMA table_xinfo(' + qi(table.name) + ')').all();
  if (!rows.length || rows.length > 64 || rows.some(row => row.hidden !== 0)) fail('unsupported-schema'); return rows.map(row => row.name);
}
const pick = (cols, candidates) => {
  const aliases = new Set(candidates.map(name => name.toLowerCase()));
  const matches = cols.filter(column => aliases.has(String(column).toLowerCase()));
  if (matches.length > 1) fail('unsupported-schema'); return matches[0] ?? null;
};
function knownTable(db, limits, names, mapping, required) {
  const hits = tables(db, limits).filter(t => typeof t.name === 'string' && names.some(name => name.toLowerCase() === t.name.toLowerCase()));
  if (hits.length !== 1 || !hits[0].regular) fail('unsupported-schema');
  const table = hits[0], cols = columns(db, table), resolved = {};
  for (const [key, names] of Object.entries(mapping)) resolved[key] = pick(cols, names);
  if (required.some(key => !resolved[key])) fail('unsupported-schema'); return { name: table.name, cols: resolved };
}
const CONTACT = { talker: ['username', 'user_name', 'wxid', 'usr_name', 'UserName'], remark: ['remark', 'remark_name', 'conRemark', 'con_remark'], nick: ['nick_name', 'nickname', 'NickName', 'nick'], alias: ['alias', 'alias_name'] };
const SESSION = { talker: ['username', 'user_name', 'session_username', 'wxid', 'strUsrName'], time: ['last_timestamp', 'last_time', 'lastTime', 'sort_timestamp', 'timestamp', 'update_time'], summary: ['summary', 'last_msg_preview', 'last_message', 'digest', 'content'] };
const MESSAGE = { id: ['local_id', 'localId', 'msgLocalId', 'id'], time: ['create_time', 'createTime', 'time', 'timestamp'], content: ['message_content', 'messageContent', 'content', 'msg_content', 'text'], type: ['local_type', 'localType', 'msg_type', 'type'], sender: ['real_sender_id', 'sender_id', 'sender', 'real_sender', 'sender_username'] };
function acl(column, scope, q) {
  const talkers = q.talker === undefined ? scope.allConversations ? null : scope.talkers : [q.talker];
  if (talkers === null) return { sql: '1', params: [] };
  return { sql: 'CAST(' + qi(column) + ' AS TEXT) COLLATE BINARY IN (' + talkers.map(() => '?').join(',') + ')', params: talkers };
}
function timed(column, q) {
  if (!column && (q.fromTs !== null || q.toTs !== null)) fail('unsupported-scope');
  const parts = [], params = [];
  if (column) {
    parts.push('_archive_epoch(' + qi(column) + ') IS NOT NULL');
    if (q.fromTs !== null) { parts.push('_archive_epoch(' + qi(column) + ') >= ?'); params.push(q.fromTs); }
    if (q.toTs !== null) { parts.push('_archive_epoch(' + qi(column) + ') <= ?'); params.push(q.toTs); }
  }
  return { sql: parts.length ? parts.join(' AND ') : '1', params };
}
const bounded = (expr, chars) => 'substr(CAST(' + expr + ' AS TEXT),1,' + chars + ')';
const text = value => value === null || value === undefined ? '' : String(value);
function selected(db, sql, params, budget) {
  const rows = [];
  for (const row of db.prepare(sql).iterate(...params)) { if (++budget.count > budget.max) fail('row-budget-exceeded'); rows.push(row); }
  return rows;
}
function contacts(catalog, scope, q, budget) {
  return withDb(catalog, 'contact/contact.db', db => {
    const t = knownTable(db, catalog.limits, ['contact', 'friend', 'user', 'WCContact'], CONTACT, ['talker']), a = acl(t.cols.talker, scope, q);
    const names = [t.cols.remark, t.cols.nick, t.cols.alias].filter(Boolean).map(c => "NULLIF(" + qi(c) + ",'')");
    const display = names.length ? 'COALESCE(' + [...names, qi(t.cols.talker)].join(',') + ')' : qi(t.cols.talker);
    const clauses = [a.sql], params = [...a.params];
    if (q.query !== undefined) { clauses.push('instr(lower(CAST(' + qi(t.cols.talker) + ' AS TEXT)),lower(?)) > 0 OR instr(lower(CAST(' + display + ' AS TEXT)),lower(?)) > 0'); params.push(q.query, q.query); }
    const where = clauses.map(c => '(' + c + ')').join(' AND ');
    if (db.prepare('SELECT 1 FROM ' + qi(t.name) + ' WHERE ' + where + ' AND (' + qi(t.cols.talker) + ' IS NULL OR typeof(' + qi(t.cols.talker) + ")='blob' OR length(CAST(" + qi(t.cols.talker) + ' AS BLOB)) > 256 OR typeof(' + display + ")='blob') LIMIT 1").get(...params)) fail('unsupported-content');
    return selected(db, 'SELECT ' + bounded(qi(t.cols.talker), 256) + ' AS talker, ' + bounded(display, 256) + ' AS displayName, length(CAST(' + display + ' AS TEXT)) > 256 AS cut FROM ' + qi(t.name)
      + ' WHERE ' + where + ' ORDER BY CAST(' + qi(t.cols.talker) + ' AS TEXT) COLLATE BINARY LIMIT ? OFFSET ?', [...params, q.limit + 1, q.offset], budget)
      .map(r => ({ talker: text(r.talker), displayName: text(r.displayName), displayNameTruncated: Boolean(r.cut) }));
  });
}
function sessions(catalog, scope, q, budget) {
  return withDb(catalog, 'session/session.db', db => {
    const t = knownTable(db, catalog.limits, ['SessionTable', 'session', 'sessions', 'Session'], SESSION, ['talker']), a = acl(t.cols.talker, scope, q), ti = timed(t.cols.time, q);
    const clauses = [a.sql, ti.sql], params = [...a.params, ...ti.params], summary = t.cols.summary ? qi(t.cols.summary) : "''";
    if (q.query !== undefined) { clauses.push('instr(lower(CAST(' + summary + ' AS TEXT)),lower(?)) > 0'); params.push(q.query); }
    const where = clauses.map(c => '(' + c + ')').join(' AND ');
    if (t.cols.time && db.prepare('SELECT 1 FROM ' + qi(t.name) + ' WHERE (' + a.sql + ') AND _archive_epoch(' + qi(t.cols.time) + ') IS NULL LIMIT 1').get(...a.params)) fail('unsupported-content');
    if (db.prepare('SELECT 1 FROM ' + qi(t.name) + ' WHERE ' + where + ' AND (' + qi(t.cols.talker) + ' IS NULL OR typeof(' + qi(t.cols.talker) + ")='blob' OR length(CAST(" + qi(t.cols.talker) + ' AS BLOB)) > 256) LIMIT 1').get(...params)) fail('unsupported-content');
    if (t.cols.summary && db.prepare('SELECT 1 FROM ' + qi(t.name) + ' WHERE ' + where + ' AND typeof(' + summary + ")='blob' LIMIT 1").get(...params)) fail('unsupported-content');
    const ts = t.cols.time ? '_archive_epoch(' + qi(t.cols.time) + ')' : 'NULL';
    return selected(db, 'SELECT ' + bounded(qi(t.cols.talker), 256) + ' AS talker, ' + ts + ' AS ts, ' + bounded(summary, 1024)
      + ' AS summary, length(CAST(' + summary + ' AS TEXT)) > 1024 AS cut FROM ' + qi(t.name) + ' WHERE ' + where + ' ORDER BY ts DESC, talker COLLATE BINARY LIMIT ? OFFSET ?', [...params, q.limit + 1, q.offset], budget)
      .map(r => ({ talker: text(r.talker), ts: r.ts, summary: text(r.summary), summaryTruncated: Boolean(r.cut) }));
  });
}
function authorizedTalkers(catalog, scope, q, budget) {
  if (q.talker !== undefined) return [q.talker]; if (!scope.allConversations) return scope.talkers;
  return withDb(catalog, 'contact/contact.db', db => {
    const t = knownTable(db, catalog.limits, ['contact', 'friend', 'user', 'WCContact'], CONTACT, ['talker']);
    // Whole-archive authority is bounded by total rows read. maxTalkers limits
    // explicitly selected ACL lists, not the size of an authorized directory.
    const rows = selected(db, 'SELECT ' + bounded(qi(t.cols.talker), 256) + ' AS talker, typeof(' + qi(t.cols.talker) + ")='blob' OR length(CAST(" + qi(t.cols.talker) + ' AS BLOB)) > 256 AS bad FROM ' + qi(t.name) + ' ORDER BY talker COLLATE BINARY LIMIT ?', [budget.max - budget.count + 1], budget);
    if (rows.some(r => r.bad || !r.talker || Buffer.byteLength(r.talker) > 256)) fail('unsupported-content');
    return [...new Set(rows.map(r => text(r.talker)))];
  });
}
function statistics(catalog, scope, q, budget) {
  const files = catalog.metadata.files.filter(path => path.startsWith('message/'));
  if (!files.length) fail('unsupported-layout');
  const byHash = new Map(), labels = new Map(), kinds = new Map();
  const kindFor = user => kinds.get(user) ?? (user.endsWith('@chatroom') ? 'group' : user === 'filehelper' ? 'system' : user.startsWith('gh_') ? 'official' : 'personal');
  // Read only identities with a message table. Counts never decode message text.
  const hashes = new Set();
  for (const rel of files) withDb(catalog, rel, db => {
    for (const table of tables(db, catalog.limits)) if (/^Msg_[a-f0-9]{32}$/i.test(table.name)) hashes.add(table.name.slice(4).toLowerCase());
  });
  withDb(catalog, 'contact/contact.db', db => {
    const t = knownTable(db, catalog.limits, ['contact', 'friend', 'user', 'WCContact'], CONTACT, ['talker']);
    const verify = pick(columns(db, t), ['verify_flag', 'VerifyFlag']);
    db.function('_archive_hash', { deterministic: true }, value => typeof value === 'string' ? createHash('md5').update(value).digest('hex') : null);
    const a = acl(t.cols.talker, scope, q), names = [t.cols.remark, t.cols.nick, t.cols.alias].filter(Boolean).map(c => "NULLIF(" + qi(c) + ",'')");
    const rows = selected(db, 'SELECT ' + bounded(qi(t.cols.talker), 256) + ' AS talker, '
      + bounded('coalesce(' + [...names, qi(t.cols.talker)].join(',') + ')', 160) + ' AS name, ' + (verify ? qi(verify) : '0') + ' AS verifyFlag FROM ' + qi(t.name)
      + ' WHERE (' + a.sql + ') AND _archive_hash(' + qi(t.cols.talker) + ') IN (' + [...hashes].map(() => '?').join(',') + ')', [...a.params, ...hashes], budget);
    for (const row of rows) {
      const hash = createHash('md5').update(row.talker).digest('hex'); byHash.set(hash, row.talker); labels.set(row.talker, row.name);
      if (!row.talker.endsWith('@chatroom') && (Number(row.verifyFlag) & 8)) kinds.set(row.talker, 'official');
    }
    // The current client stores subscription/service classification in biz_info.type.
    // Keep unknown official subtypes in the official bucket, never infer from a name.
    const biz = tables(db, catalog.limits, ['biz_info']).find(table => table.regular);
    if (biz) {
      const cols = columns(db, biz), user = pick(cols, ['username', 'user_name']), type = pick(cols, ['type']);
      if (user && type) {
        const allowed = acl(user, scope, q);
        for (const row of selected(db, 'SELECT ' + bounded(qi(user), 256) + ' AS talker, ' + qi(type) + ' AS kind FROM ' + qi(biz.name)
          + ' WHERE (' + allowed.sql + ') AND _archive_hash(' + qi(user) + ') IN (' + [...hashes].map(() => '?').join(',') + ') AND ' + qi(type) + ' IN (0,1)', [...allowed.params, ...hashes], budget)) {
          if (!row.talker.endsWith('@chatroom')) kinds.set(row.talker, Number(row.kind) === 1 ? 'service' : 'official');
        }
      }
    }
  });
  if (q.talker !== undefined) byHash.set(createHash('md5').update(q.talker).digest('hex'), q.talker);
  else if (!scope.allConversations) for (const user of scope.talkers) byHash.set(createHash('md5').update(user).digest('hex'), user);
  const days = new Map();
  for (let ts = q.fromTs; ts <= q.toTs; ts += 86400) {
    const day = new Date((ts + 28800) * 1000).toISOString().slice(0, 10);
    days.set(day, { day, messageCount: 0, textCount: 0, activeContacts: 0, activeGroups: 0, lastMessageTs: null, conversations: new Map() });
  }
  let matched = 0;
  for (const rel of files) withDb(catalog, rel, db => {
    const all = tables(db, catalog.limits).filter(t => /^Msg_/i.test(t.name));
    if (scope.allConversations && q.talker === undefined) {
      const missing = all.map(t => t.name.slice(4).toLowerCase()).filter(hash => !byHash.has(hash));
      if (missing.length) {
        const nt = tables(db, catalog.limits, ['Name2Id']).find(t => t.regular);
        if (nt) {
          const nc = pick(columns(db, nt), ['user_name', 'username', 'userName', 'name']);
          if (!nc) fail('unsupported-schema');
          db.function('_archive_hash', { deterministic: true }, value => typeof value === 'string' ? createHash('md5').update(value).digest('hex') : null);
          for (const row of selected(db, 'SELECT ' + bounded(qi(nc), 256) + ' AS talker FROM ' + qi(nt.name)
            + ' WHERE _archive_hash(' + qi(nc) + ') IN (' + missing.map(() => '?').join(',') + ')', missing, budget)) {
            byHash.set(createHash('md5').update(row.talker).digest('hex'), row.talker);
          }
        }
      }
    }
    for (const table of all) {
      const user = byHash.get(table.name.slice(4).toLowerCase());
      if (!user) { if (scope.allConversations && q.talker === undefined) fail('unsupported-schema'); continue; }
      if (!table.regular) fail('unsupported-schema');
      const cols = columns(db, table), time = pick(cols, MESSAGE.time), type = pick(cols, MESSAGE.type);
      if (!time || !type) fail('unsupported-schema'); matched++;
      if (db.prepare('SELECT 1 FROM ' + qi(table.name) + ' WHERE _archive_epoch(' + qi(time) + ') IS NULL LIMIT 1').get()) fail('unsupported-content');
      const ti = timed(time, q);
      const rows = selected(db, "SELECT date(_archive_epoch(" + qi(time) + "),'unixepoch','+8 hours') AS day, count(*) AS total, "
        + 'sum(CASE WHEN CAST(' + qi(type) + " AS TEXT)='1' THEN 1 ELSE 0 END) AS texts, max(_archive_epoch(" + qi(time) + ')) AS latest FROM '
        + qi(table.name) + ' WHERE ' + ti.sql + ' GROUP BY day', ti.params, budget);
      for (const row of rows) {
        const day = days.get(row.day); if (!day) fail('invalid-request');
        day.messageCount += row.total; day.textCount += row.texts; day.lastMessageTs = Math.max(day.lastMessageTs ?? 0, row.latest);
        const conversation = day.conversations.get(user) ?? { talker: user, displayName: labels.get(user) ?? user, messageCount: 0, textCount: 0, sourceKind: kindFor(user) };
        conversation.messageCount += row.total; conversation.textCount += row.texts; day.conversations.set(user, conversation);
      }
    }
  });
  if (!matched) fail('unsupported-schema');
  if (catalog.files.has('content/content.db')) withDb(catalog, 'content/content.db', db => {
    const a = acl('talker', scope, q), ti = timed('ts', q);
    for (const row of db.prepare('SELECT record_ref,kind,ts,title,content,url FROM records WHERE (' + a.sql + ') AND (' + ti.sql + ') ORDER BY record_ref').iterate(...a.params, ...ti.params)) {
      if (++budget.count > budget.max) fail('row-budget-exceeded');
      const day = days.get(new Date((row.ts + 28800) * 1000).toISOString().slice(0, 10));
      if (!day) continue;
      day.contentCounts ??= {};
      day.contentCounts[row.kind] = (day.contentCounts[row.kind] ?? 0) + 1;
      day.contentSignature = digest((day.contentSignature ?? '') + JSON.stringify(row));
    }
  });
  return [...days.values()].map(day => {
    const conversations = [...day.conversations.values()].sort((a, b) => b.messageCount - a.messageCount || a.talker.localeCompare(b.talker));
    return { ...day, activeContacts: conversations.filter(c => !c.talker.endsWith('@chatroom')).length,
      activeGroups: conversations.filter(c => c.talker.endsWith('@chatroom')).length, conversations: conversations.slice(0, 10), conversationListTruncated: conversations.length > 10,
      sources: conversations.map(({ talker, displayName, sourceKind }) => ({ talker, displayName, sourceKind })) };
  });
}
function messages(catalog, scope, q, budget) {
  const users = authorizedTalkers(catalog, scope, q, budget), byHash = new Map(users.map(u => [createHash('md5').update(u).digest('hex'), u]));
  const rows = [], messageFiles = catalog.metadata.files.filter(p => p.startsWith('message/')); let matched = 0;
  if (!messageFiles.length) fail('unsupported-layout');
  for (const rel of messageFiles) withDb(catalog, rel, db => {
    const names = scope.allConversations && q.talker === undefined ? undefined : [...byHash.keys()].map(hash => 'Msg_' + hash);
    const messageTables = tables(db, catalog.limits, names).filter(t => typeof t.name === 'string' && /^Msg_/i.test(t.name));
    const missing = names === undefined ? messageTables.map(table => table.name.slice(4).toLowerCase())
      .filter(hash => /^[0-9a-f]{32}$/.test(hash) && !byHash.has(hash)) : [];
    if (missing.length) {
      // Retained conversations may be absent from the current contact roster.
      // Reuse the same database's Name2Id relation used for sender identities.
      const nameTables = tables(db, catalog.limits, ['Name2Id']);
      if (nameTables.length === 1 && nameTables[0].regular) {
        const nameColumn = pick(columns(db, nameTables[0]), ['user_name', 'username', 'userName', 'name']);
        if (!nameColumn) fail('unsupported-schema');
        db.function('_archive_username_hash', { deterministic: true }, value => typeof value === 'string' && Buffer.byteLength(value) <= 256
          ? createHash('md5').update(value).digest('hex') : null);
        const mapped = selected(db, 'SELECT ' + bounded(qi(nameColumn), 256) + ' AS talker FROM ' + qi(nameTables[0].name)
          + ' WHERE _archive_username_hash(' + qi(nameColumn) + ') IN (' + missing.map(() => '?').join(',') + ') ORDER BY talker COLLATE BINARY LIMIT ?',
          [...missing, budget.max - budget.count + 1], budget);
        for (const row of mapped) {
          const user = text(row.talker), hash = createHash('md5').update(user).digest('hex');
          if (!user || byHash.has(hash) && byHash.get(hash) !== user) fail('unsupported-schema');
          byHash.set(hash, user);
        }
      }
    }
    for (const table of messageTables) {
      const hash = table.name.slice(4).toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(hash)) { if (scope.allConversations && q.talker === undefined) fail('unsupported-schema'); continue; }
      const user = byHash.get(hash);
      if (!user) { if (scope.allConversations && q.talker === undefined) fail('unsupported-schema'); continue; }
      if (!table.regular) fail('unsupported-schema'); matched++;
      const cols = columns(db, table), c = {}; for (const [key, names] of Object.entries(MESSAGE)) c[key] = pick(cols, names);
      if (!c.id || !c.time || !c.content) fail('unsupported-schema');
      const intrinsic = ['_rowid_', 'rowid', 'oid'].find(name => !cols.some(column => String(column).toLowerCase() === name));
      if (!intrinsic) fail('unsupported-schema'); const rowRef = 'CAST(' + qi(intrinsic) + ' AS TEXT)';
      const range = timed(c.time, q);
      if (q.action === 'digest' && !c.type) fail('unsupported-schema');
      const ti = { ...range, sql: range.sql + (q.action === 'digest' ? ' AND CAST(' + qi(c.type) + ' AS TEXT)=\'1\'' : '') };
      const content = '_archive_text(' + qi(c.content) + ')', clauses = [ti.sql], params = [...ti.params];
      if (db.prepare('SELECT 1 FROM ' + qi(table.name) + ' WHERE _archive_epoch(' + qi(c.time) + ') IS NULL LIMIT 1').get()) fail('unsupported-content');
      if (q.action === 'digest' && !db.prepare('SELECT 1 FROM ' + qi(table.name) + ' WHERE ' + ti.sql + ' LIMIT 1').get(...ti.params)) continue;
      if (db.prepare('SELECT 1 FROM ' + qi(table.name) + ' WHERE ' + ti.sql + ' AND ' + qi(c.content) + ' IS NULL LIMIT 1').get(...ti.params)) fail('unsupported-content');
      if (db.prepare('SELECT 1 FROM ' + qi(table.name) + ' WHERE ' + ti.sql + ' AND (' + qi(c.id) + ' IS NULL OR typeof(' + qi(c.id) + ")='blob' OR length(CAST(" + qi(c.id) + ' AS BLOB)) > 128) LIMIT 1').get(...ti.params)) fail('unsupported-content');
      if (c.type && db.prepare('SELECT 1 FROM ' + qi(table.name) + ' WHERE ' + ti.sql + ' AND typeof(' + qi(c.type) + ")='blob' LIMIT 1").get(...ti.params)) fail('unsupported-content');
      if (q.action === 'search') {
        // SQLite can evaluate many text UDF inputs before returning one match.
        // Count those candidates before decoding, so sparse full-text searches
        // cannot bypass the existing row budget and exhaust the fixed child heap.
        const candidates = db.prepare('SELECT count(*) AS count FROM (SELECT 1 FROM ' + qi(table.name)
          + ' WHERE ' + ti.sql + ' LIMIT ?)').get(...ti.params, budget.max - budget.count + 1).count;
        if (budget.count + candidates > budget.max) fail('row-budget-exceeded');
        budget.count += candidates;
        clauses.push('instr(lower(CAST(' + content + ' AS TEXT)),lower(?)) > 0'); params.push(q.query);
      }
      const id = bounded(qi(c.id), 128), type = c.type ? bounded(qi(c.type), 32) : 'NULL';
      const sender = c.sender ? 'CASE WHEN typeof(' + qi(c.sender) + ")!='blob' AND length(CAST(" + qi(c.sender) + ' AS BLOB)) <= 128 THEN CAST(' + qi(c.sender) + ' AS TEXT) END' : 'NULL';
      const selectedRows = selected(db, 'SELECT ' + rowRef + ' AS rowRef, ' + id + ' AS id, _archive_epoch(' + qi(c.time) + ') AS ts, ' + type + ' AS type, ' + sender + ' AS senderId, '
        + 'substr(CAST(' + content + ' AS TEXT),' + ((q.contentOffset ?? 0) + 1) + ',1024) AS content, length(CAST(' + content + ' AS TEXT)) > ' + ((q.contentOffset ?? 0) + 1024) + ' AS cut FROM ' + qi(table.name)
        + ' WHERE ' + clauses.map(c => '(' + c + ')').join(' AND ') + ' ORDER BY ts DESC, id COLLATE BINARY, rowRef COLLATE BINARY LIMIT ?', [...params, q.offset + q.limit + 1], budget);
      const senderIds = [...new Set(selectedRows.filter(row => row.senderId !== null && Number.isSafeInteger(Number(row.senderId))).map(row => Number(row.senderId)))];
      const nameTables = senderIds.length ? tables(db, catalog.limits, ['Name2Id']).filter(item => item.regular) : [];
      const nameColumns = nameTables.length === 1 ? columns(db, nameTables[0]) : [];
      const nameColumn = pick(nameColumns, ['user_name', 'username', 'userName', 'name']);
      const nameRowId = ['_rowid_', 'rowid', 'oid'].find(name => !nameColumns.some(column => String(column).toLowerCase() === name));
      // Keep Snapshot.name2id's rowid -> username relation, reading only senders
      // referenced by the authorized message page instead of the whole directory.
      const senderNames = nameColumn && nameRowId ? new Map(selected(db, 'SELECT CAST(' + qi(nameRowId) + ' AS TEXT) AS senderId, CASE WHEN typeof(' + qi(nameColumn)
        + ")='text' AND length(CAST(" + qi(nameColumn) + ' AS BLOB)) <= 256 THEN ' + qi(nameColumn) + ' END AS senderTalker FROM ' + qi(nameTables[0].name)
        + ' WHERE ' + qi(nameRowId) + ' IN (' + senderIds.map(() => '?').join(',') + ')', senderIds, budget).map(row => [Number(row.senderId), row.senderTalker === null ? null : text(row.senderTalker)])) : new Map();
      for (const r of selectedRows) {
        const senderTalker = r.senderId === null ? null : senderNames.get(Number(r.senderId)) ?? null;
        rows.push({ _file: rel, _rowRef: r.rowRef, talker: user, id: r.id === null ? null : text(r.id), ts: r.ts, localTime: localTime.format(new Date(r.ts * 1000)).replace(' ', 'T').replace(' GMT', ''), type: r.type === null ? null : text(r.type), content: text(r.content), contentTruncated: Boolean(r.cut),
          senderId: r.senderId === null ? null : text(r.senderId), senderTalker, senderIsTalker: senderTalker === null ? null : senderTalker === user,
          citation: { snapshotRef: catalog.metadata.fingerprint.slice(0, 24), recordRef: digest(rel + '/' + table.name + '/' + r.id + '/' + r.ts + '/' + r.rowRef).slice(0, 32) } });
      }
    }
  });
  // Unsupported/missing layout is not a proof of an empty conversation.
  if (!matched) fail('unsupported-schema');
  const compare = (a, b) => Buffer.compare(Buffer.from(text(a)), Buffer.from(text(b)));
  rows.sort((a, b) => b.ts - a.ts || compare(a.talker, b.talker) || compare(a.id, b.id) || compare(a._file, b._file) || compare(a._rowRef, b._rowRef));
  return rows.slice(q.offset).map(({ _file, _rowRef, ...row }) => row);
}
function contentRows(catalog, scope, q, budget) {
  if (!catalog.files.has('content/content.db')) return [];
  return withDb(catalog, 'content/content.db', db => {
    const a = acl('talker', scope, q), ti = timed('ts', q), clauses = [a.sql], params = [...a.params];
    // Collections contain items without an original date. Include those only
    // when the caller has no date filter; never invent a creation timestamp.
    if (q.fromTs !== null || q.toTs !== null) { clauses.push(ti.sql); params.push(...ti.params); }
    if (q.sourceKind) { clauses.push('kind = ?'); params.push(q.sourceKind); }
    if (q.query !== undefined) {
      clauses.push("instr(lower(coalesce(title,'') || char(10) || coalesce(content,'') || char(10) || coalesce(url,'')),lower(?))>0"); params.push(q.query);
    }
    const where = clauses.map(c => '(' + c + ')').join(' AND ');
    if (q.action === 'contentStats') return selected(db, 'SELECT kind AS sourceKind,count(*) AS total,max(ts) AS latestTs FROM records WHERE ' + where + ' GROUP BY kind ORDER BY kind', params, budget);
    const contentOffset = q.contentOffset ?? 0;
    return selected(db, 'SELECT record_ref,kind,talker,ts,substr(title,' + (contentOffset + 1) + ',1024) AS title,substr(content,' + (contentOffset + 1) + ',1024) AS content,(length(content)>' + (contentOffset + 1024) + ' OR length(title)>' + (contentOffset + 1024) + ') AS cut,substr(url,1,2048) AS url,metadata FROM records WHERE '
      + where + ' ORDER BY ts DESC,record_ref LIMIT ? OFFSET ?', [...params, q.limit + 1, q.offset], budget)
      .map(row => ({ sourceKind: row.kind, talker: row.talker, ts: row.ts,
        localTime: row.ts === null ? null : localTime.format(new Date(row.ts * 1000)).replace(' ', 'T').replace(' GMT', ''),
        title: row.title, content: row.content, contentTruncated: Boolean(row.cut), url: row.url,
        metadata: JSON.parse(row.metadata), citation: { snapshotRef: catalog.metadata.fingerprint.slice(0, 24), recordRef: row.record_ref } }));
  });
}
function voiceRows(catalog, scope, q, budget) {
  return withDb(catalog, 'message/media_0.db', db => {
    const ti = timed('create_time', q);
    // acl quotes a single identifier. The joined username has a unique name,
    // so use the unqualified column for the fixed Name2Id relation.
    const allowed = acl('user_name', scope, q);
    const rows = selected(db, 'SELECT n.user_name AS talker,v.local_id AS id,v.create_time AS ts FROM VoiceInfo v JOIN Name2Id n ON n.rowid=v.chat_name_id WHERE ('
      + allowed.sql + ') AND (' + ti.sql + ') ORDER BY ts DESC,v.local_id DESC LIMIT ? OFFSET ?', [...allowed.params, ...ti.params, q.limit + 1, q.offset], budget);
    return rows.map(row => ({ talker: row.talker, id: String(row.id), ts: row.ts, sourceKind: 'voice', type: '34',
      content: '', localTime: localTime.format(new Date(row.ts * 1000)).replace(' ', 'T').replace(' GMT', ''),
      citation: { snapshotRef: catalog.metadata.fingerprint.slice(0, 24), recordRef: digest('message/media_0.db/VoiceInfo/' + row.talker + '/' + row.id + '/' + row.ts + '/voice').slice(0, 32) } }));
  });
}
function resourceRows(catalog, scope, q, budget) {
  return withDb(catalog, 'message/message_resource.db', db => {
    const allowed = acl('user_name', scope, q), ti = timed('message_create_time', q);
    return selected(db, 'SELECT n.user_name AS talker,i.message_local_id AS id,i.message_create_time AS ts,i.message_local_type AS type FROM MessageResourceInfo i JOIN ChatName2Id n ON n.rowid=i.chat_id WHERE i.message_local_type IN(3,43) AND ('
      + allowed.sql + ') AND (' + ti.sql + ') ORDER BY ts DESC,i.message_id DESC LIMIT ? OFFSET ?', [...allowed.params, ...ti.params, q.limit + 1, q.offset], budget)
      .map(row => ({ talker: row.talker, id: String(row.id), ts: row.ts, type: String(row.type), sourceKind: row.type === 3 ? 'image' : 'video',
        localTime: localTime.format(new Date(row.ts * 1000)).replace(' ', 'T').replace(' GMT', ''),
        citation: { snapshotRef: catalog.metadata.fingerprint.slice(0, 24), recordRef: digest('message/message_resource.db/MessageResourceInfo/' + row.talker + '/' + row.id + '/' + row.ts).slice(0, 32) } }));
  });
}
export function readArchiveResource(root, scope, request) {
  if (!/^\d{1,20}$/.test(request.localId)) fail('invalid-request');
  const q = effectiveQuery(scope, { action: 'media', talker: request.talker, fromTs: request.ts, toTs: request.ts, limit: 1, offset: 0 }, ARCHIVE_ACCESS_LIMITS);
  const catalog = capture(root, ARCHIVE_ACCESS_LIMITS, []);
  try {
    const result = withDb(catalog, 'message/message_resource.db', db => {
      const rows = db.prepare('SELECT i.message_local_type AS type,i.packed_info FROM MessageResourceInfo i JOIN ChatName2Id n ON n.rowid=i.chat_id WHERE n.user_name COLLATE BINARY=? AND i.message_local_id=? AND i.message_create_time=? AND i.message_local_type IN(3,43) LIMIT 2').all(q.talker, request.localId, request.ts);
      if (rows.length !== 1) fail('unsupported-content');
      const raw = Buffer.from(rows[0].packed_info || []);
      // Observed protobuf: field 2, containing field 1 with a 32-byte hash.
      if (raw.length !== 36 || raw.subarray(0, 4).toString('hex') !== '12220a20' || !/^[a-f0-9]{32}$/.test(raw.toString('ascii', 4))) fail('unsupported-content');
      return { ...request, mediaHash: raw.toString('ascii', 4), sourceKind: rows[0].type === 3 ? 'image' : 'video',
        citation: { snapshotRef: catalog.metadata.fingerprint.slice(0, 24), recordRef: digest('message/message_resource.db/MessageResourceInfo/' + request.talker + '/' + request.localId + '/' + request.ts).slice(0, 32) } };
    });
    const verified = capture(root, ARCHIVE_ACCESS_LIMITS, []);
    try { if (verified.metadata.fingerprint !== catalog.metadata.fingerprint) fail('snapshot-changed'); } finally { verified.close(); }
    return result;
  } finally { catalog.close(); }
}
export function readArchiveVoice(root, scope, request) {
  if (!/^\d{1,20}$/.test(request.localId)) fail('invalid-request');
  const q = effectiveQuery(scope, { action: 'media', talker: request.talker, fromTs: request.ts, toTs: request.ts, limit: 1, offset: 0 }, ARCHIVE_ACCESS_LIMITS);
  const catalog = capture(root, ARCHIVE_ACCESS_LIMITS, []);
  try {
    const voice = withDb(catalog, 'message/media_0.db', db => {
      const rows = db.prepare('SELECT v.voice_data FROM VoiceInfo v JOIN Name2Id n ON n.rowid=v.chat_name_id WHERE n.user_name COLLATE BINARY=? AND v.local_id=? AND v.create_time=? LIMIT 2').all(q.talker, request.localId, request.ts);
      if (rows.length !== 1 || !(rows[0].voice_data instanceof Uint8Array) || rows[0].voice_data.byteLength > 67108864) fail('unsupported-content');
      return rows[0].voice_data;
    });
    const verified = capture(root, ARCHIVE_ACCESS_LIMITS, []);
    try { if (verified.metadata.fingerprint !== catalog.metadata.fingerprint) fail('snapshot-changed'); } finally { verified.close(); }
    return voice;
  } finally { catalog.close(); }
}
function page(catalog, q, rawRows) {
  const rows = rawRows.slice(0, q.limit), hasMore = rawRows.length > q.limit;
  const value = { action: q.action, rows, limit: q.limit, offset: q.offset, returned: rows.length, hasMore, truncated: hasMore || rows.some(r => r.contentTruncated || r.summaryTruncated || r.displayNameTruncated),
    ...(['messages', 'search', 'stats', 'digest', 'content'].includes(q.action) ? { timezone: 'Asia/Shanghai' } : {}),
    bytes: 0, scopeApplied: q.action === 'status' ? 'grant-metadata' : 'sql-before-rows', source: { kind: 'decrypted-wechat-archive', snapshotRef: catalog.metadata.fingerprint.slice(0, 24) }, untrusted: true };
  const measure = () => { for (let i = 0; i < 4; i++) value.bytes = Buffer.byteLength(JSON.stringify(value)); return value.bytes; };
  while (measure() > catalog.limits.maxBytes && rows.length) { rows.pop(); value.returned = rows.length; value.hasMore = true; value.truncated = true; }
  if (measure() > catalog.limits.maxBytes || (!rows.length && rawRows.length)) fail('byte-budget-exceeded'); return value;
}
function effectiveQuery(scope, query, limits) {
  const timestamp = value => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 253402300799);
  const user = value => typeof value === 'string' && value.length > 0 && value.trim() === value && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!scope || typeof scope.allConversations !== 'boolean' || !Array.isArray(scope.talkers) || scope.talkers.length > limits.maxTalkers
    || scope.talkers.some(value => !user(value)) || new Set(scope.talkers).size !== scope.talkers.length
    || (scope.allConversations ? scope.talkers.length !== 0 : scope.talkers.length === 0)
    || !timestamp(scope.fromTs) || !timestamp(scope.toTs) || (scope.fromTs !== null && scope.toTs !== null && scope.fromTs > scope.toTs)) fail('invalid-request');
  if (!query || !['status', 'contacts', 'sessions', 'messages', 'search', 'stats', 'digest', 'content', 'contentStats', 'media'].includes(query.action)
    || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > limits.maxRows
    || !Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset > limits.maxOffset) fail('invalid-request');
  const q = { ...query, fromTs: query.fromTs ?? scope.fromTs, toTs: query.toTs ?? scope.toTs };
  if (q.sourceKind !== undefined && (!['messages', 'moments', 'favorites', 'miniprogram', 'voice', 'image', 'video'].includes(q.sourceKind)
    || !['content', 'search', 'contentStats', 'media'].includes(q.action))) fail('invalid-request');
  if (!timestamp(q.fromTs) || !timestamp(q.toTs)) fail('invalid-request');
  if ((scope.fromTs !== null && q.fromTs < scope.fromTs) || (scope.toTs !== null && q.toTs > scope.toTs)) fail('scope-forbidden');
  if (q.fromTs !== null && q.toTs !== null && q.fromTs > q.toTs) fail('invalid-request');
  if (q.talker !== undefined && (!user(q.talker) || (!scope.allConversations && !scope.talkers.includes(q.talker)))) fail('scope-forbidden');
  if ((q.action === 'messages' && q.talker === undefined) || (q.action === 'search' && (typeof q.query !== 'string' || !q.query.trim()))) fail('invalid-request');
  if (q.query !== undefined && (typeof q.query !== 'string' || Buffer.byteLength(q.query) > 512 || q.query.includes('\0'))) fail('invalid-request');
  if (q.action === 'contacts' && (q.fromTs !== null || q.toTs !== null)) fail('unsupported-scope');
  if (['stats', 'digest'].includes(q.action) && (q.fromTs === null || q.toTs === null
    || q.toTs - q.fromTs >= (q.action === 'stats' ? 7 : 1) * 86400 || q.query !== undefined)) fail('invalid-request');
  return q;
}
export function runArchiveQuery(payload, onReady) {
  const limits = limitsFor(payload.limits), scope = payload.scope, q = effectiveQuery(scope, payload.query, limits);
  const catalog = capture(payload.root, limits, payload.forbiddenRoots || []);
  try {
    if (catalog.metadata.fingerprint !== payload.expected?.fingerprint) fail('snapshot-changed');
    const budget = { count: 0, max: catalog.limits.maxReadRows };
    onReady?.(); let rows;
    if (q.action === 'status') rows = [{ readOnly: true, format: 'fixed-sql-plaintext', formatVerified: false, metadataOnly: true, allConversations: scope.allConversations, fromTs: scope.fromTs, toTs: scope.toTs }];
    else if (q.action === 'contacts') rows = contacts(catalog, scope, q, budget);
    else if (q.action === 'sessions') rows = sessions(catalog, scope, q, budget);
    else if (q.action === 'media') rows = q.sourceKind === 'messages' ? resourceRows(catalog, scope, q, budget) : voiceRows(catalog, scope, q, budget);
    else if (q.action === 'messages' || q.action === 'digest' || q.action === 'search' && q.sourceKind === 'messages') rows = messages(catalog, scope, q, budget);
    else if (q.action === 'contentStats') {
      rows = contentRows(catalog, scope, q, budget);
      if (q.sourceKind === undefined && q.talker === undefined && q.fromTs === null && q.toTs === null) {
        rows.push(withDb(catalog, 'contact/contact.db', db => {
          const t = knownTable(db, catalog.limits, ['contact', 'friend', 'user', 'WCContact'], CONTACT, ['talker']), a = acl(t.cols.talker, scope, q);
          return { sourceKind: 'contacts', total: db.prepare('SELECT count(*) AS total FROM ' + qi(t.name) + ' WHERE ' + a.sql).get(...a.params).total };
        }));
        if (catalog.files.has('message/media_0.db')) rows.push(withDb(catalog, 'message/media_0.db', db => {
          const a = acl('user_name', scope, q);
          return { sourceKind: 'voice', total: db.prepare('SELECT count(*) AS total FROM VoiceInfo v JOIN Name2Id n ON n.rowid=v.chat_name_id WHERE ' + a.sql).get(...a.params).total };
        }));
        if (catalog.files.has('message/message_resource.db')) rows.push(withDb(catalog, 'message/message_resource.db', db => {
          const a = acl('user_name', scope, q);
          return { sourceKind: 'media', total: db.prepare('SELECT count(*) AS total FROM MessageResourceInfo i JOIN ChatName2Id n ON n.rowid=i.chat_id WHERE i.message_local_type IN(3,43) AND (' + a.sql + ')').get(...a.params).total };
        }));
      }
    }
    else if (q.action === 'content' || q.action === 'search' && q.sourceKind) rows = contentRows(catalog, scope, q, budget);
    else if (q.action === 'search') {
      const window = { ...q, offset: 0, limit: q.limit + q.offset };
      rows = [...messages(catalog, scope, window, budget), ...contentRows(catalog, scope, window, budget)]
        .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0) || a.citation.recordRef.localeCompare(b.citation.recordRef)).slice(q.offset);
    }
    else if (q.action === 'stats') rows = statistics(catalog, scope, q, budget);
    else fail('invalid-request');
    if (q.action === 'media' && rows.length && catalog.files.has('content/content.db')) {
      const texts = withDb(catalog, 'content/content.db', db => new Map(selected(db,
        'SELECT record_ref,substr(content,1,1024) AS content,length(content)>1024 AS cut,metadata FROM records WHERE record_ref IN (' + rows.map(() => '?').join(',') + ')',
        rows.map(row => row.citation.recordRef), budget).map(row => [row.record_ref, row])));
      rows = rows.map(row => { const cached = texts.get(row.citation.recordRef); return cached ? { ...row, content: cached.content, contentTruncated: Boolean(cached.cut), metadata: JSON.parse(cached.metadata) } : row; });
    }
    const contentTalkers = [...new Set(rows.filter(row => row.sourceKind && row.talker).map(row => row.talker))];
    if (contentTalkers.length && catalog.files.has('contact/contact.db')) {
      const labels = new Map(contacts(catalog, { ...scope, allConversations: false, talkers: contentTalkers },
        { ...q, talker: undefined, query: undefined, offset: 0, limit: contentTalkers.length }, budget).map(row => [row.talker, row.displayName]));
      rows = rows.map(row => row.sourceKind ? { ...row, displayName: labels.get(row.talker) || row.talker } : row);
    }
    const verified = capture(payload.root, payload.limits, payload.forbiddenRoots || []);
    try { if (verified.metadata.fingerprint !== catalog.metadata.fingerprint) fail('snapshot-changed'); } finally { verified.close(); }
    return page(catalog, q, rows);
  } finally { catalog.close(); }
}
if (typeof process.send === 'function') process.once('message', payload => {
  try {
    const value = payload?.kind === 'inspect' ? captureArchiveMetadata(payload.root, payload.limits, payload.forbiddenRoots || [])
      : payload?.kind === 'query' ? runArchiveQuery(payload, () => process.send({ kind: 'query-ready' })) : fail('invalid-request');
    process.send({ ok: true, value }, () => process.exit(0));
  } catch (error) { process.send({ ok: false, code: error instanceof ArchiveAccessError ? error.code : 'worker-failed' }, () => process.exit(0)); }
});
