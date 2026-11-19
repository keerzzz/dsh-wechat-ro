// The eight read-only queries behind the wechat_* tools and the Remote panel.
//
// This is a 1:1 port of wechat_ro_mcp/service.py: same function names, same
// argument order, same result shape ({total, returned, offset, truncated, rows,
// notes}) so the MCP tools, the slash command and the browser panel all speak
// one contract. No SQL mutations or WeChat access occur here. SQLite can still
// create WAL/SHM or temporary files inside the configured snapshot scope.

import {
  MAX_ROWS,
  SCAN_CAP,
  Snapshot,
  decodeContent,
  getSnapshot,
  guardSelect,
  md5Hex,
  normTs,
  nowLocalIso,
  pageResult,
  parseBound,
  pickCol,
  qi,
  readMessages,
  typeLabel,
} from './snapshot.js';

const SCAN_NOTE = '每个消息表仅扫描最近 ' + SCAN_CAP + ' 行';

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  return Math.max(lo, Math.min(Math.trunc(Number.isFinite(v) ? v : fallback), hi));
}

function unique(list) {
  return [...new Set(list.map((x) => String(x)))];
}

// ---------------------------------------------------------------- context

export function createContext(options) {
  const opts = options || {};
  const snapshotEnabled = opts.snapshotEnabled !== false;
  const root = snapshotEnabled ? opts.snapshotDir || '' : '';
  const sourceRoot = typeof opts.sourceRoot === 'string' ? opts.sourceRoot : '';
  const configured = typeof root === 'string' && root.trim() !== '';
  const maxRows = clamp(opts.maxRows, 1, MAX_ROWS, MAX_ROWS);
  const requireConfigured = () => {
    if (!configured) throw new Error(unconfiguredNote(snapshotEnabled));
  };
  let sqlite = opts.sqlite || null;
  const load = () => {
    if (!sqlite) {
      // node:sqlite ships with Node >= 22; keep the import lazy so the module
      // still loads (and the panel can explain itself) on an older runtime.
      sqlite = process.getBuiltinModule ? process.getBuiltinModule('node:sqlite') : null;
      if (!sqlite) throw new Error('当前 Node 运行时不提供 node:sqlite（需要 Node >= 22）');
    }
    return sqlite;
  };
  return {
    root,
    snapshotEnabled,
    sourceRoot,
    configured,
    maxRows,
    requireConfigured,
    snap() {
      // Check before both the lazy SQLite import and any Snapshot/manifest IO.
      requireConfigured();
      return getSnapshot(root, load());
    },
  };
}

function unconfiguredNote(snapshotEnabled) {
  return snapshotEnabled === false
    ? '快照读取已禁用（snapshotEnabled=false）；请由操作者配置独立解密快照后再启用查询与导出。'
    : '独立解密快照尚未配置；请由操作者配置 snapshotDir 后再查询或导出。';
}

function notesOf(ctx, snap) {
  const base = [...snap.notes];
  if (snap.dbs.length) return base;
  return base.concat([
    '快照目录 ' + ctx.root + ' 不存在或没有可读的 .db 文件。',
    '请核对 snapshotDir / WECHAT_SNAPSHOT_DIR 配置，并按 README 由操作者手动准备合规快照。',
    '本查询只读取已准备的快照，不会自动采集、提取密钥或触发 GDB。',
  ]);
}

// ---------------------------------------------------------------- 1. status

export function status(ctx) {
  if (ctx.configured === false) {
    return {
      ok: false,
      configured: false,
      snapshot_enabled: ctx.snapshotEnabled,
      source_root: ctx.sourceRoot,
      root: '',
      snapshot_time: '',
      read_at: '',
      captured_at: null,
      snapshot_id: null,
      capture_complete: null,
      capture_consistency: null,
      // Legacy wire requires a number here: zero loaded descriptors, NOT an
      // observed empty database. configured/scan_complete explicitly gate it.
      db_count: 0,
      dbs: [],
      contact_table: null,
      session_table: null,
      contact_rows: null,
      session_rows: null,
      message_db_count: null,
      message_table_count: null,
      indexed_message_table_count: null,
      message_table_count_is_exact: false,
      scan_complete: false,
      notes: [
        unconfiguredNote(ctx.snapshotEnabled),
        '未访问任何快照文件或数据库，未执行库/表/行数统计；数量均未知，不代表空库。',
        'source_root 仅为来源说明字符串，不用于读取、哈希、复制或解密；不会连接微信、自动采集或提取密钥。',
      ],
    };
  }
  const snap = ctx.snap();
  const notes = [];
  const dbs = [];
  let scanComplete = true;
  for (const d of snap.dbs) {
    let tables = null;
    try {
      tables = snap.withDb(d.path, (db) => snap.tables(db).length);
    } catch (err) {
      scanComplete = false;
      notes.push(d.rel + ' 读取失败: ' + (err && err.message ? err.message : String(err)));
    }
    dbs.push({ rel: d.rel, size: d.size, mtime: d.mtime, tables });
  }
  const counts = [];
  for (const [path, lookup, label] of [
    [snap.contactDb, () => snap.contactTable(), 'contact'],
    [snap.sessionDb, () => snap.sessionTable(), 'session'],
  ]) {
    let table = null;
    let count = null;
    try {
      table = lookup();
      if (table && path) {
        const found = snap.withDb(path, (db) => snap.rowCount(db, table.table));
        if (found >= 0) count = found;
        else notes.push(label + ' 行数读取失败');
      }
    } catch (err) {
      notes.push(label + ' 读取失败: ' + (err && err.message ? err.message : String(err)));
    }
    if (path && count === null) scanComplete = false;
    counts.push({ table: table ? table.table : null, count });
  }
  const index = snap.messageIndex();
  let discovered = 0;
  let discoveryComplete = true;
  for (const entry of index) {
    if (entry.table) continue;
    discovered += entry.discovered_tables || 0;
    if (entry.scan_complete === false) scanComplete = false;
    if (entry.discovery_complete === false) discoveryComplete = false;
    if (entry.notes) notes.push(...entry.notes.map((note) => String(entry.db).split('/').pop() + ': ' + note));
    if (entry.error) notes.push(String(entry.db).split('/').pop() + ' 读取失败: ' + entry.error);
  }
  const { notes: captureNotes, ...capture } = snap.captureMetadata();
  const readAt = nowLocalIso();
  return {
    ok: snap.dbs.length > 0,
    configured: true,
    snapshot_enabled: ctx.snapshotEnabled ?? true,
    source_root: ctx.sourceRoot ?? '',
    root: snap.root,
    snapshot_time: readAt,
    read_at: readAt,
    ...capture,
    db_count: snap.dbs.length,
    dbs,
    contact_table: counts[0].table,
    session_table: counts[1].table,
    contact_rows: counts[0].count,
    session_rows: counts[1].count,
    message_db_count: snap.messageDbs.length,
    message_table_count: discoveryComplete ? discovered : null,
    indexed_message_table_count: index.filter((entry) => entry.table).length,
    message_table_count_is_exact: discoveryComplete,
    scan_complete: scanComplete,
    notes: unique(notesOf(ctx, snap).concat(notes, captureNotes)),
  };
}

// ---------------------------------------------------------------- 2. contacts

export function contacts(ctx, args) {
  const a = args || {};
  const snap = ctx.snap();
  const limit = clamp(a.limit, 1, ctx.maxRows, 50);
  const ct = snap.contactTable();
  if (!ct) return pageResult([], 0, notesOf(ctx, snap).concat(['contact 表未解析成功']), limit, 0, { scan_complete: false });
  const c = ct.cols;
  const q = String(a.query || '').trim().toLowerCase();
  const rows = [];
  snap.withDb(snap.contactDb, (db) => {
    for (const r of db.prepare('SELECT * FROM ' + qi(ct.table)).all()) {
      const u = r[c.uname];
      if (!u) continue;
      const username = String(u);
      const alias = c.alias ? String(r[c.alias] || '') : '';
      const remark = c.remark ? String(r[c.remark] || '') : '';
      const nick = c.nick ? String(r[c.nick] || '') : '';
      const display = remark || nick || alias || username;
      if (q && ![username, alias, remark, nick, display].join(' ').toLowerCase().includes(q)) continue;
      rows.push({
        username,
        display_name: display,
        alias,
        remark,
        nick_name: nick,
        type: c.ctype ? r[c.ctype] : null,
      });
    }
  });
  rows.sort((x, y) => {
    const d = String(x.display_name || '').localeCompare(String(y.display_name || ''), 'zh-Hans-CN');
    return d !== 0 ? d : x.username.localeCompare(y.username);
  });
  return pageResult(rows, rows.length, notesOf(ctx, snap), limit);
}

// ---------------------------------------------------------------- 3. sessions

export function sessions(ctx, args) {
  const a = args || {};
  const snap = ctx.snap();
  const limit = clamp(a.limit, 1, ctx.maxRows, 50);
  const st = snap.sessionTable();
  if (!st) return pageResult([], 0, notesOf(ctx, snap).concat(['session 表未解析成功']), limit, 0, { scan_complete: false });
  const disp = snap.displayMap();
  const c = st.cols;
  const q = String(a.query || '').trim().toLowerCase();
  const rows = [];
  snap.withDb(snap.sessionDb, (db) => {
    for (const r of db.prepare('SELECT * FROM ' + qi(st.table)).all()) {
      const u = r[c.uname];
      if (!u) continue;
      const username = String(u);
      const name = disp.get(username) || username;
      if (q && !(username + ' ' + name).toLowerCase().includes(q)) continue;
      const [epoch, iso] = normTs(c.ts ? r[c.ts] : null);
      rows.push({
        username,
        display_name: name,
        summary: c.summary ? r[c.summary] : null,
        last_time: iso,
        last_epoch: epoch,
        unread: c.unread ? r[c.unread] : null,
        is_chatroom: username.endsWith('@chatroom'),
      });
    }
  });
  rows.sort((x, y) => (y.last_epoch || 0) - (x.last_epoch || 0));
  return pageResult(rows, rows.length, notesOf(ctx, snap), limit);
}

// ---------------------------------------------------------------- 4. messages

export function messages(ctx, args) {
  const a = args || {};
  const before = parseBound(a.before);
  const after = parseBound(a.after);
  const snap = ctx.snap();
  const limit = clamp(a.limit, 1, ctx.maxRows, 50);
  const offset = Math.max(0, clamp(a.offset, 0, Number.MAX_SAFE_INTEGER, 0));
  const notes = notesOf(ctx, snap);
  const [u, errs] = snap.resolveUsername(a.session);
  if (errs.length) return pageResult([], 0, notes.concat(snap.notes, errs), limit, offset, { scan_complete: false });
  const idx = snap.messageIndex();
  const target = md5Hex(u).toLowerCase();
  // Keep discovery/error sentinels so a per-session filter cannot hide failures.
  const entries = idx.filter((e) => !e.table || e.username === u || e.table.toLowerCase() === 'msg_' + target);
  if (!entries.some((entry) => entry.table)) notes.push(
    '未找到会话 ' + u + ' 对应的 Msg_<hash> 表；该快照共索引 ' + idx.filter((e) => e.table).length + ' 个消息表。',
    '可改用 wechat_search_messages 全库检索，或 wechat_sql 直接查询。',
  );
  const read = readMessages(snap, entries, { contains: a.contains || '', before, after });
  return pageResult(read.rows.slice(offset, offset + limit), read.rows.length,
    notes.concat(read.notes, [SCAN_NOTE]), limit, offset, { scan_complete: read.scan_complete });
}

// ---------------------------------------------------------------- 5. search

export function searchMessages(ctx, args) {
  const a = args || {};
  const snap = ctx.snap();
  const limit = clamp(a.limit, 1, ctx.maxRows, 50);
  const notes = notesOf(ctx, snap);
  const q = String(a.query || '').trim();
  if (!q) return pageResult([], 0, notes.concat(['query 不能为空']), limit, 0, { scan_complete: false });
  let u = null;
  if (a.session) {
    const [resolved, errs] = snap.resolveUsername(a.session);
    if (errs.length) return pageResult([], 0, notes.concat(snap.notes, errs), limit, 0, { scan_complete: false });
    u = resolved;
  }
  let entries = snap.messageIndex();
  if (u) entries = entries.filter((e) => !e.table || e.username === u || e.table.toLowerCase() === 'msg_' + md5Hex(u));
  const read = readMessages(snap, entries, { contains: q });
  const disp = snap.displayMap();
  for (const r of read.rows) r.session_name = r.session ? disp.get(r.session) || r.session : null;
  const res = pageResult(read.rows, read.rows.length, notes.concat(read.notes), limit, 0,
    { scan_complete: read.scan_complete, text_limits: { content: 300 } });
  res.scanned_tables = read.scanned_tables;
  return res;
}

// ---------------------------------------------------------------- 6. timeline

export function timeline(ctx, args) {
  const a = args || {};
  const snap = ctx.snap();
  const days = clamp(a.days, 1, 3650, 30);
  const notes = notesOf(ctx, snap);
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - days * 86400;
  let u = null;
  if (a.session) {
    const [resolved, errs] = snap.resolveUsername(a.session);
    if (errs.length) return { days, total_messages: 0, rows: [], busiest_hours: [], top_sessions: [],
      scanned_tables: 0, scan_complete: false, total_is_exact: false, notes: unique(notes.concat(snap.notes, errs)) };
    u = resolved;
  }
  const disp = snap.displayMap();
  const perDay = new Map();
  const perHour = new Map();
  const perSession = new Map();
  let entries = snap.messageIndex();
  if (u) entries = entries.filter((e) => !e.table || e.username === u || e.table.toLowerCase() === 'msg_' + md5Hex(u));
  const read = readMessages(snap, entries, { after: cutoff, before: now });
  for (const r of read.rows) {
    const local = new Date((r.create_epoch + 480 * 60) * 1000);
    const day = local.toISOString().slice(0, 10);
    const hour = String(local.getUTCHours()).padStart(2, '0') + ':00';
    perDay.set(day, (perDay.get(day) || 0) + 1);
    perHour.set(hour, (perHour.get(hour) || 0) + 1);
    if (r.session) perSession.set(r.session, (perSession.get(r.session) || 0) + 1);
  }
  const byCount = (m) => [...m.entries()].sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0])));
  return {
    days,
    total_messages: read.rows.length,
    rows: [...perDay.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([date, n]) => ({ date, messages: n })),
    busiest_hours: byCount(perHour).slice(0, 5).map(([hour, n]) => ({ hour, messages: n })),
    top_sessions: byCount(perSession).slice(0, 10).map(([username, n]) => {
      const name = disp.get(username) || username;
      return { session: name, username, display_name: name, messages: n };
    }),
    scanned_tables: read.scanned_tables,
    scan_complete: read.scan_complete,
    total_is_exact: read.scan_complete,
    notes: unique(notes.concat(read.notes, [SCAN_NOTE + '（规范化时间倒序）；窗口截止于本次读取时间'])),
  };
}

// ---------------------------------------------------------------- 7. chatroom

export function chatroomMembers(ctx, args) {
  const a = args || {};
  const snap = ctx.snap();
  const limit = clamp(a.limit, 1, ctx.maxRows, 100);
  const notes = notesOf(ctx, snap);
  if (!snap.contactDb) return pageResult([], 0, notes.concat(['无 contact 数据库']), limit, 0, { scan_complete: false });
  const [u, errs] = snap.resolveUsername(a.room);
  if (errs.length) return pageResult([], 0, notes.concat(snap.notes, errs), limit, 0, { scan_complete: false });
  const disp = snap.displayMap();
  const rows = [];
  let cand = [];
  let scanComplete = true;
  snap.withDb(snap.contactDb, (db) => {
    cand = snap.tables(db).filter((t) => /chatroom|chat_room|member/i.test(t));
    scanComplete = cand.length > 0;
    for (const t of cand) {
      try {
        const cols = snap.columns(db, t);
        // Room identity is never guessed from a positional or missing column.
        const roomc = pickCol(cols, ['chatroom_username', 'chatroom_name', 'chat_room_name', 'room_name', 'chatroom_id', 'room_id', 'room']);
        const memc = pickCol(cols, ['member_username', 'user_name', 'username', 'member_name', 'user']);
        const dc = pickCol(cols, ['display_name', 'nick_name', 'remark', 'name', 2]);
        if (!roomc || !memc) {
          notes.push(t + ' 缺少明确群ID或成员列，已跳过，未将未知成员归入目标群');
          scanComplete = false;
          continue;
        }
        if (db.prepare('SELECT 1 FROM ' + qi(t) + ' WHERE ' + qi(roomc) + " IS NULL OR " + qi(roomc) + " = '' LIMIT 1").get()) {
          notes.push(t + ' 含 NULL/空群ID，已排除，未归入目标群');
          scanComplete = false;
        }
        const raw = db.prepare('SELECT * FROM ' + qi(t) + ' WHERE ' + qi(roomc) + ' = ? COLLATE BINARY LIMIT ' + (SCAN_CAP + 1)).all(u);
        if (raw.length > SCAN_CAP) {
          scanComplete = false;
          notes.push(t + ' 目标群成员超过扫描上限 ' + SCAN_CAP + '，结果可能不完整');
        }
        for (const r of raw.slice(0, SCAN_CAP)) {
          const rv = r[roomc];
          if (rv === null || rv === undefined || String(rv) !== u) continue;
          const m = r[memc];
          if (!m) continue;
          const member = String(m);
          const fallback = dc ? String(r[dc] || member) : member;
          rows.push({ chatroom: String(rv), member, display_name: disp.get(member) || fallback, source_table: t });
        }
      } catch (err) {
        scanComplete = false;
        notes.push(t + ' 读取失败: ' + (err && err.message ? err.message : String(err)));
      }
    }
  });
  if (!rows.length) notes.push('未在 contact.db 找到 ' + u + ' 的群成员；候选表: ' + (cand.length ? cand.join(', ') : '无'));
  return pageResult(rows, rows.length, notes.concat(snap.notes), limit, 0, { scan_complete: scanComplete });
}

// ---------------------------------------------------------------- 8. sql

export function sql(ctx, args) {
  const a = args || {};
  const snap = ctx.snap();
  const limit = clamp(a.limit, 1, ctx.maxRows, 100);
  const notes = notesOf(ctx, snap);
  const [cleanSql, err] = guardSelect(a.query);
  if (err) return pageResult([], 0, notes.concat(['wechat_sql 拒绝: ' + err]), limit, 0, { scan_complete: false });
  const [path, dbErr] = snap.resolveDb(a.database);
  if (dbErr) return pageResult([], 0, notes.concat([dbErr]), limit, 0, { scan_complete: false });
  try {
    const rows = snap.withDb(path, (db) => db.prepare('SELECT * FROM (' + cleanSql + ') AS _q LIMIT ?').all(limit + 1));
    const exact = rows.length <= limit;
    return pageResult(rows, rows.length,
      notes.concat(['database=' + a.database + '；只读 SELECT，最多返回 limit=' + limit + ' 行；额外读取一行仅用于判断 has_more']),
      limit, 0, { total_is_exact: exact });
  } catch (e) {
    return pageResult([], 0, notes.concat(['SQL 执行失败: ' + (e && e.message ? e.message : String(e))]),
      limit, 0, { scan_complete: false });
  }
}

// ---------------------------------------------------------------- dispatch

export const METHOD_NAMES = [
  'status',
  'contacts',
  'sessions',
  'messages',
  'search_messages',
  'timeline',
  'chatroom_members',
  'sql',
];

const IMPL = {
  status: (ctx) => status(ctx),
  contacts,
  sessions,
  messages,
  search_messages: searchMessages,
  timeline,
  chatroom_members: chatroomMembers,
  sql,
};

export function callMethod(ctx, name, args) {
  const fn = IMPL[name];
  if (!fn) return { ok: false, error: 'unknown method: ' + name };
  try {
    return fn(ctx, args || {});
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

export { Snapshot, decodeContent, typeLabel };
