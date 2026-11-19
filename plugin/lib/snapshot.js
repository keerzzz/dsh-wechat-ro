// Read-only access to a decrypted WeChat 4.x db_storage snapshot.
//
// Design constraints, inherited from wechat_ro_mcp/:
//   * SQL is logically read-only: readOnly:true + query_only protect database
//     contents. SQLite may create snapshot-local WAL/SHM or temporary files;
//     this is not a filesystem-level no-write guarantee. Never use immutable
//     against a database whose live WAL still matters.
//   * schema tolerance - WeChat 4.1.x renames columns between builds, so table
//     and column names are introspected at runtime and resolved from candidate
//     lists; anything missing becomes a note instead of a crash;
//   * zstd - message_content may be zstd-compressed bytes (magic 28 b5 2f fd);
//     Node's built-in zlib handles that, so no third-party dependency is needed;
//   * fixed +08:00 offset - WeChat stores UTC epoch seconds; the operator zone
//     has no DST, so a fixed offset avoids a tzdata dependency.

import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const LOCAL_OFFSET_MINUTES = 480; // +08:00
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const MAX_ROWS = 500;
export const MAX_TEXT = 1200;
export const SCAN_CAP = 3000;
const MAX_MSG_TABLES = 300;
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|truncate|reindex|pragma|load_extension|begin|commit|rollback|savepoint|release|analyze|writable_schema)\b/i;

const TYPE_LABELS = {
  1: 'text', 3: 'image', 34: 'voice', 43: 'video', 47: 'sticker',
  49: 'appmsg/link/file', 50: 'voip', 10000: 'system', 10002: 'system',
  51: 'video_status', 42: 'card', 48: 'location', 37: 'friend_request',
};

const CONTACT_COLMAP = {
  uname: ['username', 'user_name', 'wxid', 'usr_name', 'UserName', 0],
  alias: ['alias', 'Alias', 'alias_name'],
  remark: ['remark', 'Remark', 'remark_name', 'conRemark', 'con_remark'],
  nick: ['nick_name', 'nickname', 'NickName', 'nick'],
  ctype: ['local_type', 'type', 'contact_type', 'LocalType'],
};

const SESSION_COLMAP = {
  uname: ['username', 'user_name', 'session_username', 'wxid', 'strUsrName', 0],
  summary: ['summary', 'last_msg_preview', 'last_message', 'digest', 'content'],
  ts: ['last_timestamp', 'last_time', 'lastTime', 'sort_timestamp', 'timestamp', 'update_time'],
  unread: ['unread_count', 'unreadCount', 'unread', 'UnreadCount'],
};

const MSG_COLMAP = {
  local_id: ['local_id', 'localId', 'msgLocalId', 'id'],
  sender: ['real_sender_id', 'sender_id', 'sender', 'real_sender', 'sender_username'],
  ltype: ['local_type', 'localType', 'msg_type', 'type', 3],
  time: ['create_time', 'createTime', 'time', 'timestamp', 4],
  content: ['message_content', 'messageContent', 'content', 'msg_content', 'text', 5],
  source: ['source', 'source_name', 6],
};

// ---------------------------------------------------------------- helpers

export function qi(ident) {
  return '"' + String(ident).replace(/"/g, '""') + '"';
}

export function md5Hex(s) {
  return createHash('md5').update(String(s), 'utf8').digest('hex');
}

export function truncate(s, n = MAX_TEXT) {
  const t = s === null || s === undefined ? '' : String(s);
  let length = 0;
  let end = 0;
  for (const point of t) {
    if (length < n) end += point.length;
    length += 1;
  }
  return length <= n ? t : t.slice(0, end) + '…[截断, 共' + length + '字符]';
}

// Node's synchronous zstd decoder can accept an unfinished frame and return
// partial output, even with finishFlush=ZSTD_e_end. Check frame boundaries only;
// the native codec still validates compressed blocks, checksums and dictionaries.
export function decodeZstd(raw) {
  let offset = 4; // decodeContent already checked the standard frame magic.
  const requireBytes = (end) => {
    if (end > raw.length) throw new Error('不完整的 zstd frame');
  };
  requireBytes(offset + 1);
  const descriptor = raw[offset++];
  const singleSegment = (descriptor & 0x20) !== 0;
  const sizeFlag = descriptor >>> 6;
  const sizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][sizeFlag];
  offset += (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + sizeBytes;
  requireBytes(offset);
  let last = false;
  while (!last) {
    requireBytes(offset + 3);
    const block = raw.readUIntLE(offset, 3);
    offset += 3;
    last = (block & 1) !== 0;
    const type = (block >>> 1) & 3;
    if (type === 3) throw new Error('无效的 zstd block type');
    offset += type === 1 ? 1 : block >>> 3;
    requireBytes(offset);
  }
  if (descriptor & 4) offset += 4;
  requireBytes(offset);
  if (offset !== raw.length) throw new Error('不支持 zstd 尾随数据或多个 frame');
  return zstdDecompressSync(raw, { maxOutputLength: MAX_DECODED_BYTES });
}

export function decodeContent(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  let raw;
  if (Buffer.isBuffer(value)) raw = value;
  else if (value instanceof Uint8Array) raw = Buffer.from(value);
  else return String(value);
  if (raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try {
      raw = decodeZstd(raw);
    } catch (err) {
      return '[zstd 解压失败: ' + (err && err.message ? err.message : String(err)) + ']';
    }
  }
  return raw.toString('utf8');
}

export function normTs(value) {
  if (value === null || value === undefined) return [null, null];
  let n;
  try {
    n = Number(value);
  } catch {
    return [null, null];
  }
  if (!Number.isFinite(n) || n <= 0) return [null, null];
  n = Math.trunc(n);
  if (n > 1e14) n = Math.floor(n / 1e6);
  else if (n > 1e11) n = Math.floor(n / 1000);
  const ms = (n + LOCAL_OFFSET_MINUTES * 60) * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return [null, null];
  return [n, isoLocal(d)];
}

function isoLocal(d) {
  const pad = (v, w = 2) => String(v).padStart(w, '0');
  return (
    d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
    'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) +
    '+08:00'
  );
}

export function nowLocalIso() {
  return isoLocal(new Date(Date.now() + LOCAL_OFFSET_MINUTES * 60 * 1000));
}

export function typeLabel(value) {
  let n;
  try {
    n = Number(value);
  } catch {
    return 'unknown';
  }
  if (!Number.isFinite(n)) return 'unknown';
  const low = n >>> 0;
  const label = TYPE_LABELS[low] || 'type_' + low;
  const hi = Math.floor(n / 4294967296) >>> 0;
  return hi ? label + ' (subtype ' + hi + ')' : label;
}

export function clean(value, textLimit = MAX_TEXT) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return truncate(decodeContent(value), textLimit);
  if (typeof value === 'string') return truncate(value, textLimit);
  if (typeof value === 'bigint') return Number(value);
  return value === undefined ? null : value;
}

export function pickCol(cols, candidates) {
  const low = new Map();
  for (const c of cols) low.set(c.toLowerCase(), c);
  for (const cand of candidates) {
    if (typeof cand === 'number') {
      if (cand >= 0 && cand < cols.length) return cols[cand];
    } else if (low.has(String(cand).toLowerCase())) {
      return low.get(String(cand).toLowerCase());
    }
  }
  return null;
}

export function guardSelect(sql) {
  let s = String(sql === null || sql === undefined ? '' : sql).trim();
  while (s.endsWith(';')) s = s.slice(0, -1).trimEnd();
  if (!s) return ['', 'SQL 为空'];
  if (s.includes(';')) return ['', '只允许单条 SELECT 语句（检测到额外的分号）'];
  if (s.includes('?')) return ['', '不支持带 ? 占位符的查询，请把值直接写在 SQL 里'];
  s = s.replace(/^\s*(?:(?:--[^\n]*\n)|(?:\/\*[\s\S]*?\*\/\s*))*/i, '');
  const tokens = s.split(/\s+/);
  const head = tokens.length ? tokens[0].toUpperCase() : '';
  if (head !== 'SELECT' && head !== 'WITH') return ['', '只允许 SELECT 或 WITH ... SELECT 只读查询'];
  const noStrings = s.replace(/'(?:[^']|'')*'/g, "''");
  const m = WRITE_WORDS.exec(noStrings);
  if (m) return ['', '检测到禁止的写操作关键字: ' + m[0]];
  return [s, null];
}

// ---------------------------------------------------------------- snapshot

function fileIdentity(path) {
  try {
    const st = statSync(path, { bigint: true });
    return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].map(String).join(':');
  } catch {
    return 'missing';
  }
}

export function listDatabases(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.db')) {
        let st;
        try {
          st = statSync(full, { bigint: true });
        } catch {
          continue;
        }
        out.push({
          rel: relative(root, full).split(sep).join('/'),
          path: full,
          size: Number(st.size),
          mtime: isoLocal(new Date(Number(st.mtimeNs) / 1e6 + LOCAL_OFFSET_MINUTES * 60 * 1000)),
          mtime_ns: String(st.mtimeNs),
          identity: [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].map(String).join(':'),
          wal_identity: fileIdentity(full + '-wal'),
        });
      }
    }
  };
  if (root && existsSync(root)) walk(root);
  return out;
}

export class Snapshot {
  constructor(root, dbs, sqlite) {
    this.root = root;
    this.dbs = dbs;
    this.sqlite = sqlite;
    this.notes = [];
    this.byRel = new Map(dbs.map((d) => [d.rel, d]));
    this.contactDb = this.find('contact/contact.db') || this.findSuffix('contact/contact.db');
    this.sessionDb = this.find('session/session.db') || this.findSuffix('session/session.db');
    this.messageDbs = dbs
      .filter((d) => d.rel.startsWith('message/') && d.rel.endsWith('.db'))
      .map((d) => d.path);
    if (!this.contactDb) this.notes.push('未找到 contact/contact.db：联系人显示名可能退化为 wxid');
    if (!this.sessionDb) this.notes.push('未找到 session/session.db：会话列表可能为空');
    if (!this.messageDbs.length) this.notes.push('未找到 message/*.db：消息检索不可用');
    this._displayMap = null;
    this._msgIndex = null;
  }

  captureMetadata() {
    const unknown = { snapshot_id: null, captured_at: null, capture_complete: null, capture_consistency: null };
    let fd;
    try {
      fd = openSync(join(this.root, '.wechat-ro-manifest.json'),
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0));
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) throw new Error('必须是 root 内不超过 1 MiB 的普通文件');
      const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const n = readSync(fd, bytes, length, bytes.length - length, null);
        if (!n) break;
        length += n;
      }
      if (length > MAX_MANIFEST_BYTES) throw new Error('manifest 超过 1 MiB');
      const m = JSON.parse(bytes.toString('utf8', 0, length));
      const validFile = (f) => f && typeof f.path === 'string' && f.path.length > 0 &&
        !f.path.includes('\\') && f.path.split('/').every((part) => part && part !== '.' && part !== '..') &&
        Number.isSafeInteger(f.size) && f.size >= 0 && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(f.sha256);
      if (!m || m.schema_version !== 1 || typeof m.snapshot_id !== 'string' || !m.snapshot_id.trim() ||
        typeof m.captured_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00$/.test(m.captured_at) ||
        m.complete !== true || !['stable-db-only-verified', 'stable-db-wal-committed-verified'].includes(m.consistency) || !Array.isArray(m.files) ||
        !m.files.length || !m.files.every(validFile) || new Set(m.files.map((f) => f.path)).size !== m.files.length) {
        throw new Error('manifest schema 不符合 schema_version:1');
      }
      parseBound(m.captured_at); // Validate the calendar, not just its spelling.
      return { snapshot_id: m.snapshot_id, captured_at: m.captured_at, capture_complete: m.complete,
        capture_consistency: m.consistency, notes: [] };
    } catch (err) {
      const note = err && err.code === 'ENOENT'
        ? '缺少采集 manifest：采集时间未知；snapshot_time/read_at 仅表示本次读取时间'
        : '采集 manifest 无效，采集时间未知: ' + (err && err.message ? err.message : String(err));
      return { ...unknown, notes: [note] };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  find(rel) {
    const d = this.byRel.get(rel);
    return d ? d.path : null;
  }

  // Tolerate snapshots that keep the databases one directory deeper.
  findSuffix(suffix) {
    const hits = this.dbs.filter((d) => d.rel.endsWith(suffix)).map((d) => d.path);
    return hits.length === 1 ? hits[0] : null;
  }

  // Validate a caller-supplied database name against the discovered set.
  // Accepts 'contact/contact.db', 'contact/contact', or a unique suffix.
  resolveDb(database) {
    const raw = database === null || database === undefined ? '' : String(database);
    if (!raw.trim()) return [null, '请指定 database（用 wechat_status 查看可用值）'];
    const d = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    for (const key of [d, d + '.db']) {
      const hit = this.byRel.get(key);
      if (hit) return [hit.path, null];
    }
    const hits = this.dbs.filter(
      (x) =>
        x.rel === d ||
        x.rel.endsWith('/' + d) ||
        x.rel.endsWith('/' + d + '.db') ||
        x.rel === d + '.db',
    );
    if (hits.length === 1) return [hits[0].path, null];
    if (hits.length > 1) return [null, 'database 不唯一，匹配到 ' + hits.length + ' 个，请写完整相对路径'];
    return [null, '未知 database ' + JSON.stringify(d) + '；用 wechat_status 查看可用值'];
  }

  open(path) {
    const db = new this.sqlite.DatabaseSync(path, { readOnly: true });
    // Defence in depth: readOnly:true already rejects writes at the VFS layer,
    // and query_only makes SQLite itself refuse any write statement even if a
    // future call path forgets the flag. Both guards stay on for the whole
    // lifetime of the connection.
    try {
      db.exec('PRAGMA query_only = ON');
    } catch {
      /* pragma unavailable on this build: readOnly:true remains the guard */
    }
    return db;
  }

  tables(db) {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
  }

  columns(db, table) {
    return db.prepare('PRAGMA table_info(' + qi(table) + ')').all().map((r) => r.name);
  }

  rowCount(db, table) {
    // Let the caller retain the original SQLite error instead of turning unknown into zero.
    return Number(db.prepare('SELECT count(*) AS n FROM ' + qi(table)).get().n);
  }

  resolveTable(db, nameCandidates, colmap, require) {
    const names = [...new Set(nameCandidates.map((n) => String(n).toLowerCase()))];
    const scored = [];
    for (const t of this.tables(db)) {
      const lowName = t.toLowerCase();
      const cols = this.columns(db, t);
      const resolved = {};
      for (const [key, cands] of Object.entries(colmap)) {
        const c = pickCol(cols, cands);
        if (c) resolved[key] = c;
      }
      if ((require || []).some((key) => !resolved[key])) continue;
      const score = names.includes(lowName) ? 2 : names.some((n) => lowName.includes(n)) ? 1 : 0;
      scored.push({ score, table: t, cols: resolved });
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    const best = scored.filter((candidate) => candidate.score === scored[0].score);
    if (best.length !== 1) {
      this.notes.push('表候选不唯一，拒绝猜测: ' + best.map((t) => t.table).sort().join(', '));
      return null;
    }
    return best[0];
  }

  withDb(path, fn) {
    const db = this.open(path);
    try {
      return fn(db);
    } finally {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
  }

  contactTable() {
    if (!this.contactDb) return null;
    return this.withDb(this.contactDb, (db) =>
      this.resolveTable(db, ['contact', 'friend', 'user', 'WCContact'], CONTACT_COLMAP, ['uname']),
    );
  }

  sessionTable() {
    if (!this.sessionDb) return null;
    return this.withDb(this.sessionDb, (db) =>
      this.resolveTable(db, ['SessionTable', 'session', 'sessions', 'Session'], SESSION_COLMAP, ['uname']),
    );
  }

  displayMap() {
    if (this._displayMap) return this._displayMap;
    const out = new Map();
    for (const [path, getTable, label] of [
      [this.contactDb, () => this.contactTable(), '联系人'],
      [this.sessionDb, () => this.sessionTable(), '会话'],
    ]) {
      if (!path) continue;
      try {
        const table = getTable();
        if (!table) continue;
        const c = table.cols;
        this.withDb(path, (db) => {
          for (const r of db.prepare('SELECT * FROM ' + qi(table.table)).all()) {
            const u = r[c.uname];
            if (!u || out.has(String(u))) continue;
            const name = (c.remark ? r[c.remark] : '') || (c.nick ? r[c.nick] : '') ||
              (c.alias ? r[c.alias] : '') || String(u);
            out.set(String(u), String(name));
          }
        });
      } catch (err) {
        this.notes.push(label + '映射读取失败: ' + (err && err.message ? err.message : String(err)));
      }
    }
    this._displayMap = out;
    return out;
  }

  msgTables(db) {
    const tables = [];
    const notes = [];
    let discovered = 0;
    let discoveryComplete = true;
    for (const t of this.tables(db)) {
      if (!/^Msg_/i.test(t)) continue;
      try {
        const cols = this.columns(db, t);
        const resolved = {};
        for (const [key, cands] of Object.entries(MSG_COLMAP)) {
          const c = pickCol(cols, cands);
          if (c) resolved[key] = c;
        }
        if (!resolved.content) {
          notes.push(t + ' 缺少可识别的消息内容列，已跳过');
          discoveryComplete = false;
          continue;
        }
        discovered += 1;
        if (tables.length < MAX_MSG_TABLES) tables.push({ table: t, cols: resolved });
      } catch (err) {
        discoveryComplete = false;
        notes.push(t + ' 结构读取失败: ' + (err && err.message ? err.message : String(err)));
      }
    }
    if (discovered > tables.length) notes.push('发现 ' + discovered + ' 个消息表，仅索引前 ' + MAX_MSG_TABLES + ' 个；结果可能不完整');
    return { tables, discovered, discovery_complete: discoveryComplete,
      scan_complete: discoveryComplete && discovered === tables.length, notes };
  }

  name2id(db) {
    const map = new Map();
    for (const t of this.tables(db)) {
      if (!/^name2id$/i.test(t)) continue;
      const cols = this.columns(db, t);
      const ucol = pickCol(cols, ['user_name', 'username', 'userName', 'name', 1]);
      if (!ucol) continue;
      try {
        for (const r of db.prepare('SELECT rowid AS rid, ' + qi(ucol) + ' AS u FROM ' + qi(t)).all()) {
          map.set(Number(r.rid), String(r.u));
        }
      } catch {
        return map;
      }
      break;
    }
    return map;
  }

  messageIndex() {
    if (this._msgIndex) return this._msgIndex;
    const hash2user = new Map();
    for (const u of this.displayMap().keys()) hash2user.set(md5Hex(u), u);
    const out = [];
    // No message source is unknown, not a verified empty message dataset.
    if (!this.messageDbs.length) out.push({ scan_complete: false, discovery_complete: false });
    for (const p of this.messageDbs) {
      try {
        this.withDb(p, (db) => {
          const n2i = this.name2id(db);
          const info = this.msgTables(db);
          out.push({ db: p, notes: info.notes, scan_complete: info.scan_complete,
            discovered_tables: info.discovered, discovery_complete: info.discovery_complete });
          for (const t of info.tables) {
            const suffix = t.table.split('_').slice(1).join('_');
            out.push({ db: p, table: t.table, cols: t.cols,
              username: hash2user.get(suffix.toLowerCase()) || null, name2id: n2i });
          }
        });
      } catch (err) {
        out.push({ db: p, scan_complete: false, discovery_complete: false,
          error: err && err.message ? err.message : String(err) });
      }
    }
    this._msgIndex = out;
    return out;
  }

  resolveUsername(text) {
    const disp = this.displayMap();
    const t = String(text === null || text === undefined ? '' : text).trim();
    if (!t) return [null, ['请指定会话：传 wxid/群 id，或用 wechat_sessions 查到的 display_name']];
    if (disp.has(t)) return [t, []];
    const low = t.toLowerCase();
    const exact = [...disp.entries()].filter(([, n]) => n && n.toLowerCase() === low).map(([u]) => u);
    if (exact.length === 1) return [exact[0], []];
    const fuzzy = [...disp.entries()]
      .filter(([u, n]) => (u + ' ' + (n || '')).toLowerCase().includes(low))
      .map(([u]) => u);
    if (fuzzy.length === 1) return [fuzzy[0], []];
    if (fuzzy.length > 1) {
      return [null, ['会话名 ' + JSON.stringify(text) + ' 匹配到多个候选: ' + fuzzy.sort().slice(0, 10).join(', ') + '；请传完整 username（用 wechat_sessions 查看）']];
    }
    return [null, ['未找到会话 ' + JSON.stringify(text) + '；用 wechat_sessions 查看可用 username，或直接传 wxid / 群 id']];
  }
}

// ---------------------------------------------------------------- read paths

export function readMessages(snap, entries, opts) {
  const o = opts || {};
  const disp = snap.displayMap();
  const notes = [...snap.notes];
  const rows = [];
  let scanComplete = true;
  let scannedTables = 0;
  for (const e of entries) {
    if (!e) continue;
    if (e.notes) notes.push(...e.notes.map((note) => String(e.db).split('/').pop() + ': ' + note));
    if (e.error) notes.push(String(e.db).split('/').pop() + ' 读取失败: ' + e.error);
    if (e.error || e.scan_complete === false) scanComplete = false;
    if (!e.table) continue;
    const c = e.cols;
    const n2i = e.name2id || new Map();
    let sql = 'SELECT * FROM ' + qi(e.table);
    if (c.time) sql += ' ORDER BY _wechat_ro_epoch(' + qi(c.time) + ') DESC';
    sql += ' LIMIT ' + (SCAN_CAP + 1);
    let raw;
    scannedTables += 1;
    try {
      raw = snap.withDb(e.db, (db) => {
        if (c.time) db.function('_wechat_ro_epoch', { deterministic: true }, (value) => normTs(value)[0]);
        return db.prepare(sql).all();
      });
    } catch (err) {
      scanComplete = false;
      notes.push(e.table + ' 读取失败: ' + (err && err.message ? err.message : String(err)));
      continue;
    }
    if (raw.length > SCAN_CAP) {
      scanComplete = false;
      notes.push(e.table + ' 超过扫描上限 ' + SCAN_CAP + ' 行，结果可能不完整');
      raw = raw.slice(0, SCAN_CAP);
    }
    for (const r of raw) {
      const [epoch, iso] = normTs(c.time ? r[c.time] : null);
      if (o.after !== null && o.after !== undefined && (epoch === null || epoch < o.after)) continue;
      if (o.before !== null && o.before !== undefined && (epoch === null || epoch > o.before)) continue;
      const content = decodeContent(c.content ? r[c.content] : null);
      if (o.contains && !content.toLowerCase().includes(String(o.contains).toLowerCase())) continue;
      let sender = null;
      const senderRaw = c.sender ? r[c.sender] : null;
      if (senderRaw !== null && senderRaw !== undefined) {
        const mapped = n2i.get(Number(senderRaw));
        sender = mapped === undefined ? String(senderRaw) : mapped;
      }
      rows.push({
        local_id: c.local_id ? r[c.local_id] : null,
        create_time: iso,
        create_epoch: epoch,
        sender,
        sender_name: sender ? disp.get(sender) || sender : null,
        type: typeLabel(c.ltype ? r[c.ltype] : null),
        content,
        source: c.source ? r[c.source] : null,
        session: e.username || null,
        database: String(e.db).split('/').pop(),
        table: e.table,
      });
    }
  }
  rows.sort((a, b) => (b.create_epoch || 0) - (a.create_epoch || 0));
  if (!scanComplete) notes.push('扫描不完整：total 仅是已观察到的匹配数下界，未扫描数据不计入 has_more');
  return { rows, notes: [...new Set(notes)], scan_complete: scanComplete, scanned_tables: scannedTables };
}

export function parseBound(value) {
  if (value === null || value === undefined || value === '') return null;
  const invalid = () => { throw new RangeError('无效时间边界: ' + String(value)); };
  if (typeof value !== 'string' && typeof value !== 'number') return invalid();
  const s = String(value).trim();
  if (/^-?\d+$/.test(s)) {
    const [epoch, iso] = normTs(s);
    return epoch !== null && iso !== null ? epoch : invalid();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(s);
  if (!m) return invalid();
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map((part) => Number(part || 0));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return invalid();
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, 0);
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return invalid();
  let offset = LOCAL_OFFSET_MINUTES;
  if (m[8] === 'Z') offset = 0;
  else if (m[8]) {
    const h = Number(m[8].slice(1, 3));
    const min = Number(m[8].slice(4, 6));
    if (h > 23 || min > 59) return invalid();
    offset = (h * 60 + min) * (m[8][0] === '-' ? -1 : 1);
  }
  return Math.floor(utc.getTime() / 1000) - offset * 60;
}

// Callers pass raw fields; exactly one output boundary owns truncation.
export function pageResult(rows, total, notes, limit, offset, options = {}) {
  const lim = limit === undefined || limit === null ? MAX_ROWS : limit;
  const off = offset || 0;
  const slice = rows.slice(0, lim);
  const scanComplete = options.scan_complete !== false;
  const exact = options.total_is_exact === undefined ? scanComplete : options.total_is_exact;
  const hasMore = off + slice.length < Number(total);
  const resultNotes = [...(notes || [])];
  if (!exact) resultNotes.push('total 是已观察到的匹配数下界，不是全量精确总数');
  return {
    total: Number(total),
    returned: slice.length,
    offset: off,
    truncated: hasMore || !scanComplete,
    has_more: hasMore,
    scan_complete: scanComplete,
    total_is_exact: exact,
    rows: slice.map((r) => {
      const out = {};
      for (const [k, v] of Object.entries(r)) out[k] = clean(v, options.text_limits?.[k] ?? MAX_TEXT);
      return out;
    }),
    notes: [...new Set(resultNotes.map(String))],
  };
}
// ---------------------------------------------------------------- cache

let _cache = { sig: null, snap: null, sqlite: null };

// Display mtime is deliberately rounded; cache identity is not. Resolve root
// aliases and include inode/ctime/ns-mtime plus WAL state, without hashing DBs.
function snapshotSignature(root, dbs) {
  let canonical = root ? resolve(root) : '';
  try { canonical = realpathSync(canonical); } catch { /* absent root */ }
  return JSON.stringify([canonical, root ? fileIdentity(canonical) : 'missing',
    dbs.map((d) => [d.rel, d.identity || d.mtime_ns || d.mtime, d.size, d.wal_identity])]);
}

export function getSnapshot(root, sqlite) {
  let canonical = root;
  try { canonical = realpathSync(root); } catch { /* missing snapshots are reportable */ }
  const dbs = listDatabases(canonical);
  const sig = snapshotSignature(canonical, dbs);
  if (_cache.sig === sig && _cache.sqlite === sqlite && _cache.snap) return _cache.snap;
  const snap = new Snapshot(canonical, dbs, sqlite);
  _cache = { sig, snap, sqlite };
  return snap;
}
