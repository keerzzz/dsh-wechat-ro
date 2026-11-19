#!/usr/bin/env node
// Corrected-behavior regression tests. All databases and side effects are synthetic.
// Refuses to run without explicit isolation paths inside this repair's evidence root.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as sqlite from 'node:sqlite';
import { constants as zstdConstants, zstdCompressSync } from 'node:zlib';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configuredEvidence = process.env.WECHAT_JS_TEST_EVIDENCE_ROOT;
const evidence = configuredEvidence || join(project, 'audit/2026-11-06-fixes/js-data');
assert.ok(isAbsolute(evidence) && resolve(evidence) === evidence, 'WECHAT_JS_TEST_EVIDENCE_ROOT must be an absolute normalized path');
// Overrides must be pre-existing isolated directories supplied by the caller.
// Validate the selected root before creating any fixture directories.
if (!configuredEvidence) fs.mkdirSync(evidence, { recursive: true });
assert.ok(fs.lstatSync(evidence).isDirectory() && !fs.lstatSync(evidence).isSymbolicLink(), 'The evidence root must be a real directory');
assert.equal(fs.realpathSync(evidence), evidence, 'The evidence root must not contain symlink components');
const inside = (path, root = evidence) => {
  const rel = relative(root, resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};
for (const key of ['WECHAT_FIXTURE_DIR', 'WECHAT_SNAPSHOT_DIR', 'TMPDIR']) {
  const path = process.env[key];
  assert.ok(path && isAbsolute(path) && inside(path), key + ' must be an explicit path below ' + evidence);
  fs.mkdirSync(path, { recursive: true });
  assert.ok(inside(fs.realpathSync(path)), key + ' must not escape via symlink');
}
assert.equal(process.env.PYTHONDONTWRITEBYTECODE, '1', 'Set PYTHONDONTWRITEBYTECODE=1 for isolated runs');
const fixtures = process.env.WECHAT_FIXTURE_DIR;
const runtime = resolve(process.env.WECHAT_TEST_RUNTIME_DIR || join(project, 'plugin/lib'));
const allowedRuntime = [join(project, 'plugin/lib'), join(project, 'audit/2026-11-06-fixes/baseline-files/plugin/lib')];
assert.ok(allowedRuntime.includes(runtime), 'Only current runtime or the preserved baseline may be tested');
const S = await import(pathToFileURL(join(runtime, 'snapshot.js')).href);
const M = await import(pathToFileURL(join(runtime, 'methods.js')).href);
const NOW = Date.parse('2026-11-01T00:00:00Z') / 1000;
const ROOM = '123@chatroom';
const findings = [];
const results = [];
const digest = (path) => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const noteText = (result) => (result.notes || []).join('\n');
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const referenceTruncate = (text, limit = 1200) => {
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join('') + '…[截断, 共' + points.length + '字符]';
};
function test(id, ids, title, fn) {
  const started = performance.now();
  const result = { id, findings: ids, title, passed: false };
  try {
    result.evidence = fn() ?? null;
    result.passed = true;
  } catch (error) {
    result.error = { name: error.name, message: error.message, stack: error.stack };
  }
  result.duration_ms = Math.round((performance.now() - started) * 1000) / 1000;
  results.push(result);
  console.log((result.passed ? 'PASS ' : 'FAIL ') + id + ' ' + title);
  if (!result.passed) console.error(result.error.stack);
}
function database(root, rel, fn) {
  const path = join(root, rel);
  assert.ok(inside(path));
  fs.mkdirSync(dirname(path), { recursive: true });
  const db = new sqlite.DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('BEGIN');
    const value = fn(db);
    db.exec('COMMIT');
    return value;
  } finally { db.close(); }
}
function messageTable(db, user, rows, table = 'Msg_' + S.md5Hex(user)) {
  db.exec('CREATE TABLE ' + quote(table) + ' (local_id INTEGER, sender TEXT, local_type INTEGER, create_time, message_content, source)');
  const insert = db.prepare('INSERT INTO ' + quote(table) + ' VALUES (?, ?, ?, ?, ?, ?)');
  rows.forEach((row, index) => insert.run(row.id ?? index + 1, row.sender ?? user, 1, row.time ?? NOW - index, row.content ?? 'needle-' + index, row.source ?? 'fixture'));
  return table;
}
function fixture(name, options = {}) {
  const root = fs.mkdtempSync(join(fixtures, name + '-'));
  const contacts = options.contacts ?? [['alice', 'Alice'], ['bob', 'Bob'], [ROOM, 'Fixture room']];
  if (options.contact !== false) database(root, 'contact/contact.db', (db) => {
    db.exec('CREATE TABLE contact (username TEXT, nick_name TEXT, alias TEXT, remark TEXT)');
    const insert = db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?)');
    for (const [username, label] of contacts) insert.run(username, label, '', '');
    if (options.groupRows) {
      db.exec('CREATE TABLE ChatRoomMember (room_name TEXT COLLATE NOCASE, member_username TEXT, display_name TEXT)');
      const member = db.prepare('INSERT INTO ChatRoomMember VALUES (?, ?, ?)');
      for (const [room, username, label = username] of options.groupRows) member.run(room, username, label);
    }
  });
  if (options.session !== false) database(root, 'session/session.db', (db) => {
    db.exec('CREATE TABLE SessionTable (username TEXT, last_timestamp INTEGER, summary, unread_count INTEGER)');
    const insert = db.prepare('INSERT INTO SessionTable VALUES (?, ?, ?, ?)');
    for (const [username] of contacts) insert.run(username, NOW, options.summary ?? 'synthetic summary', 0);
  });
  if (options.messages) database(root, 'message/message_0.db', (db) => {
    for (const [username, rows] of options.messages) messageTable(db, username, rows);
  });
  return { root, ctx: M.createContext({ snapshotDir: root, maxRows: options.maxRows ?? 500, sqlite }) };
}
function call(ctx, name, args = {}) {
  const result = M.callMethod(ctx, name, args);
  assert.notEqual(result.ok, false, name + ' failed: ' + JSON.stringify(result));
  return result;
}
function atTime(seconds, fn) {
  const old = Date.now;
  Date.now = () => seconds * 1000;
  try { return fn(); } finally { Date.now = old; }
}
function assertIncomplete(page, pattern) {
  assert.equal(page.scan_complete, false);
  assert.equal(page.total_is_exact, false);
  if ('returned' in page) assert.equal(page.truncated, true);
  assert.match(noteText(page), pattern);
}
function manifest(root, overrides = {}) {
  const rel = 'contact/contact.db';
  const path = join(root, rel);
  return { schema_version: 1, snapshot_id: 'synthetic-snapshot-01', captured_at: '2026-10-30T01:02:03+08:00',
    complete: true, consistency: 'stable-db-only-verified',
    files: [{ path: rel, size: fs.statSync(path).size, sha256: digest(path) }], ...overrides };
}
function writeManifest(root, value) {
  fs.writeFileSync(join(root, '.wechat-ro-manifest.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

test('J00-readonly', ['JSD-00'], 'SQL writes are denied and the main database hash is unchanged', () => {
  const { root, ctx } = fixture('readonly');
  const path = join(root, 'contact/contact.db');
  const before = digest(path);
  const db = ctx.snap().open(path);
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM contact').get().n, 3);
    assert.throws(() => db.exec("UPDATE contact SET nick_name='changed'"), /readonly|read.only/i);
  } finally { db.close(); }
  const denied = call(ctx, 'sql', { database: 'contact/contact.db', query: 'DELETE FROM contact' });
  assert.equal(denied.returned, 0);
  assert.match(noteText(denied), /拒绝/);
  assert.equal(digest(path), before);
  return { database_sha256: before, logical_sql_readonly: true };
});

test('J00-wal-scope', ['JSD-00'], 'WAL reads may create snapshot-local sidecars without changing database content', () => {
  const { root, ctx } = fixture('readonly-wal');
  const path = join(root, 'contact/contact.db');
  const writer = new sqlite.DatabaseSync(path);
  writer.exec('PRAGMA journal_mode=WAL');
  writer.close();
  const before = digest(path);
  const db = ctx.snap().open(path);
  let sidecars;
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM contact').get().n, 3);
    assert.throws(() => db.exec("INSERT INTO contact VALUES ('x','x','','')"), /readonly|read.only/i);
    sidecars = ['-wal', '-shm'].map((suffix) => ({ suffix, exists: fs.existsSync(path + suffix), size: fs.existsSync(path + suffix) ? fs.statSync(path + suffix).size : null }));
    assert.equal(digest(path), before);
  } finally { db.close(); }
  return { sidecars, main_database_sha256_unchanged: digest(path) === before, no_filesystem_no_write_claim: true };
});

test('J01-default-limits', ['JSD-01'], 'Every paged method clamps default and nonfinite limits to configured maxRows', () => {
  const { ctx } = fixture('limits', { maxRows: 1, messages: [['alice', [{}, {}, {}]]], groupRows: [[ROOM, 'm1'], [ROOM, 'm2'], [ROOM, 'm3']] });
  const cases = [['contacts', {}], ['sessions', {}], ['messages', { session: 'alice' }], ['search_messages', { query: 'needle' }],
    ['chatroom_members', { room: ROOM }], ['sql', { database: 'contact/contact.db', query: 'SELECT * FROM contact' }]];
  for (const [name, args] of cases) for (const limit of [undefined, NaN, Infinity, 'not-a-number', 0, -10, 5000]) {
    const page = call(ctx, name, { ...args, limit });
    assert.equal(page.returned, 1, name + ' limit=' + String(limit));
  }
  const ordinary = fixture('ordinary-limit', { messages: [['alice', [{}, {}, {}]]] });
  assert.equal(call(ordinary.ctx, 'contacts').returned, 3);
  assert.equal(call(ordinary.ctx, 'messages', { session: 'alice', limit: 2 }).returned, 2);
  return { methods: cases.map(([name]) => name), variants_per_method: 7 };
});

test('J02-sql-more', ['JSD-02'], 'SQL limit+1 reports an observed lower bound and has_more without arbitrary COUNT', () => {
  const { ctx } = fixture('sql-more');
  const page = call(ctx, 'sql', { database: 'contact/contact.db', query: 'SELECT username FROM contact ORDER BY username', limit: 1 });
  assert.equal(page.returned, 1);
  assert.equal(page.total, 2);
  assert.equal(page.total_is_exact, false);
  assert.equal(page.has_more, true);
  assert.equal(page.truncated, true);
  assert.equal(page.scan_complete, true);
  assert.match(noteText(page), /下界/);
  return { total: page.total, returned: page.returned, flags: [page.has_more, page.total_is_exact, page.scan_complete] };
});

test('J02-sql-tail', ['JSD-02'], 'SQL empty, exact-limit and aggregate tails remain exact with no false has_more', () => {
  const { ctx } = fixture('sql-tail');
  for (const [query, expected] of [['SELECT username FROM contact LIMIT 2', 2], ['SELECT username FROM contact WHERE 0', 0], ['SELECT count(*) AS n FROM contact', 1]]) {
    const page = call(ctx, 'sql', { database: 'contact/contact.db', query, limit: 2 });
    assert.equal(page.returned, expected);
    assert.equal(page.total, expected);
    assert.equal(page.total_is_exact, true);
    assert.equal(page.has_more, false);
    assert.equal(page.truncated, false);
  }
});

test('J03-unreadable-database', ['JSD-03'], 'Unreadable database errors survive search, per-session filtering, timeline and status', () => {
  const { root, ctx } = fixture('bad-message-db', { messages: [['alice', [{ content: 'needle healthy' }]]] });
  fs.writeFileSync(join(root, 'message/bad.db'), 'not a database\n');
  for (const [name, args] of [['search_messages', { query: 'needle' }], ['messages', { session: 'alice' }], ['timeline', { days: 1 }]]) {
    const result = atTime(NOW, () => call(ctx, name, args));
    assertIncomplete(result, /bad\.db.*file is not a database/);
    assert.equal(name === 'timeline' ? result.total_messages : result.returned, 1);
    if (name !== 'timeline') assert.equal(result.has_more, false, 'unknown omitted data is not observed has_more');
  }
  const state = call(ctx, 'status');
  assert.equal(state.message_table_count, null);
  assert.equal(state.indexed_message_table_count, 1);
  assert.equal(state.message_table_count_is_exact, false);
  assert.equal(state.scan_complete, false);
  assert.equal(state.dbs.find((db) => db.rel === 'message/bad.db').tables, null);
  assert.match(noteText(state), /file is not a database/);
});

test('J03-view-error', ['JSD-03'], 'Table SELECT failures keep valid rows and original SQLite errors in timeline', () => {
  const { root, ctx } = fixture('bad-message-view', { messages: [['alice', [{ content: 'needle healthy' }]]] });
  database(root, 'message/message_0.db', (db) => db.exec('CREATE VIEW ' + quote('Msg_' + S.md5Hex('bob')) + " AS SELECT abs(-9223372036854775808) AS local_id, 'bob' AS sender, 1 AS local_type, " + NOW + " AS create_time, 'needle broken' AS message_content, 'fixture' AS source"));
  for (const name of ['search_messages', 'timeline']) {
    const result = atTime(NOW, () => call(ctx, name, { query: 'needle', days: 1 }));
    assertIncomplete(result, /integer overflow/);
    assert.equal(name === 'timeline' ? result.total_messages : result.returned, 1);
  }
});

test('J03-table-cap', ['JSD-03'], '301 discovered message tables report exact discovery count but incomplete indexing', () => {
  const { root, ctx } = fixture('table-cap');
  database(root, 'message/message_0.db', (db) => {
    for (let i = 0; i < 301; i += 1) messageTable(db, 'synthetic-' + i, i === 300 ? [{ content: 'excluded-last-table' }] : i === 0 ? [{ content: 'kept-first-table' }] : [], 'Msg_' + String(i).padStart(6, '0'));
  });
  const state = call(ctx, 'status');
  assert.equal(state.message_table_count, 301);
  assert.equal(state.indexed_message_table_count, 300);
  assert.equal(state.message_table_count_is_exact, true);
  assert.equal(state.scan_complete, false);
  assert.match(noteText(state), /300/);
  const hidden = call(ctx, 'search_messages', { query: 'excluded-last-table' });
  assertIncomplete(hidden, /300/);
  assert.equal(hidden.total, 0);
  assert.equal(hidden.has_more, false);
  assert.equal(call(ctx, 'search_messages', { query: 'kept-first-table' }).returned, 1);
  assertIncomplete(atTime(NOW, () => call(ctx, 'timeline', { days: 1 })), /300/);
  return { discovered: state.message_table_count, indexed: state.indexed_message_table_count, omitted_match_is_not_exact_zero: true };
});

test('J03-row-cap', ['JSD-03'], '3001 rows expose a scan cap; exactly 3000 rows are not falsely incomplete', () => {
  for (const count of [3000, 3001]) {
    const { ctx } = fixture('row-cap-' + count, { messages: [['alice', Array.from({ length: count }, (_, i) => ({ time: NOW - i, content: i === count - 1 ? 'last-only' : 'other' }))]] });
    const page = call(ctx, 'search_messages', { query: 'last-only' });
    assert.equal(page.scan_complete, count === 3000);
    assert.equal(page.total_is_exact, count === 3000);
    assert.equal(page.returned, count === 3000 ? 1 : 0);
    assert.equal(page.has_more, false);
    assert.equal(page.truncated, count === 3001);
    if (count === 3001) assert.match(noteText(page), /3000/);
  }
});

test('J03-page-offsets', ['JSD-03'], 'Complete known result pagination distinguishes page tails from unknown scan gaps', () => {
  const { ctx } = fixture('offsets', { messages: [['alice', [{}, {}, {}, {}, {}]]] });
  for (const [offset, count, more] of [[0, 2, true], [2, 2, true], [4, 1, false], [8, 0, false]]) {
    const page = call(ctx, 'messages', { session: 'alice', limit: 2, offset });
    assert.equal(page.total, 5);
    assert.equal(page.returned, count);
    assert.equal(page.offset, offset);
    assert.equal(page.total_is_exact, true);
    assert.equal(page.scan_complete, true);
    assert.equal(page.has_more, more);
    assert.equal(page.truncated, more);
  }
});

test('J03-status-count-error', ['JSD-03'], 'Failed count is null with the original SQLite error rather than zero or minus one', () => {
  const { root, ctx } = fixture('count-error', { contact: false });
  database(root, 'contact/contact.db', (db) => db.exec("CREATE VIEW contact AS SELECT 'alice' AS username, 'Alice' AS nick_name WHERE abs(-9223372036854775808)"));
  const state = call(ctx, 'status');
  assert.equal(state.contact_rows, null);
  assert.equal(state.scan_complete, false);
  assert.match(noteText(state), /integer overflow/);
});

test('J04-zone-bounds', ['JSD-04'], 'UTC Z, positive/negative offsets, local dates and numeric units denote correct instants', () => {
  for (const value of ['2026-11-01T00:00:00Z', '2026-11-01T08:00:00+08:00', '2026-11-01T05:30:00+05:30', '2026-10-31T18:30:00-05:30', '2026-11-01 08:00', String(NOW), String(NOW * 1000), String(NOW * 1000000)]) assert.equal(S.parseBound(value), NOW, value);
  assert.equal(S.parseBound('2026-11-01'), NOW - 28800);
  assert.equal(S.parseBound('2026-11-01T00:00:00.999Z'), NOW);
  assert.equal(S.parseBound('2024-02-29T00:00Z'), Date.parse('2024-02-29T00:00Z') / 1000);
  for (const empty of [null, undefined, '']) assert.equal(S.parseBound(empty), null);
});

test('J04-invalid-bounds', ['JSD-04'], 'Impossible calendars, trailing junk, invalid offsets and huge integers fail closed', () => {
  const invalid = ['2026-02-30', '2026-02-29', '2026-13-01', '2026-01-00', '2026-01-01T24:00Z', '2026-01-01T12:60Z', '2026-01-01T12:00:60Z', '2026-01-01junk', '2026-01-01T00:00+24:00', '2026-01-01T00:00+00:60', ' ', 'nonsense', '9'.repeat(400), 1e300, Infinity, NaN, true, {}];
  for (const value of invalid) assert.throws(() => S.parseBound(value), /无效时间边界/, String(value));
  const { ctx } = fixture('invalid-bound', { messages: [['alice', [{}]]] });
  for (const [name, args] of [['messages', { session: 'alice' }], ['messages', { session: 'missing' }]]) {
    const result = M.callMethod(ctx, name, { ...args, after: '2026-02-30' });
    assert.equal(result.ok, false);
    assert.match(result.error, /无效时间边界/);
  }
  return { invalid_values: invalid.length, invalid_input_never_removes_filter: true };
});

test('J04-date-properties', ['JSD-04'], 'Deterministic timezone and timestamp-unit property matrix agrees with ISO instants', () => {
  let checked = 0;
  for (let year = 2000; year < 2030; year += 3) for (const month of [1, 2, 6, 12]) for (const zone of ['Z', '+08:00', '-05:30', '+14:00']) {
    const value = year + '-' + String(month).padStart(2, '0') + '-15T12:34:56' + zone;
    const expected = Date.parse(value) / 1000;
    assert.equal(S.parseBound(value), expected);
    for (const scale of [1, 1000, 1000000]) assert.equal(S.parseBound(String(expected * scale)), expected);
    checked += 4;
  }
  return { independently_checked_instants: checked };
});

test('J04-bound-filter', ['JSD-04'], 'UTC bounds filter messages at the actual instant rather than silently shifting eight hours', () => {
  const { ctx } = fixture('bound-filter', { messages: [['alice', [{ time: NOW - 3600 }, { time: NOW, content: 'middle' }, { time: NOW + 3600 }]]] });
  const page = call(ctx, 'messages', { session: 'alice', after: '2026-11-01T00:00:00Z', before: '2026-11-01T08:00:00+08:00' });
  assert.equal(page.returned, 1);
  assert.equal(page.rows[0].content, 'middle');
});

test('J05-read-vs-capture', ['JSD-05'], 'snapshot_time remains read time; missing capture manifest is explicitly unknown', () => {
  const { ctx } = fixture('read-time');
  const first = atTime(NOW, () => call(ctx, 'status'));
  const second = atTime(NOW + 2, () => call(ctx, 'status'));
  assert.equal(first.snapshot_time, first.read_at);
  assert.equal(second.snapshot_time, second.read_at);
  assert.notEqual(first.read_at, second.read_at);
  for (const field of ['captured_at', 'snapshot_id', 'capture_complete', 'capture_consistency']) assert.equal(first[field], null);
  assert.match(noteText(first), /未知|unknown/);
  return { first_read_at: first.read_at, second_read_at: second.read_at, captured_at: first.captured_at };
});

test('J05-valid-manifest', ['JSD-05'], 'Validated manifest capture metadata is independent of read time', () => {
  const { root, ctx } = fixture('valid-manifest');
  const value = manifest(root);
  writeManifest(root, value);
  const state = atTime(NOW, () => call(ctx, 'status'));
  assert.equal(state.captured_at, value.captured_at);
  assert.equal(state.snapshot_id, value.snapshot_id);
  assert.equal(state.capture_complete, true);
  assert.equal(state.capture_consistency, value.consistency);
  assert.equal(state.read_at, state.snapshot_time);
  assert.notEqual(state.read_at, state.captured_at);
});

test('J05-wal-manifest', ['JSD-05'], 'Committed WAL capture keeps its own consistency metadata', () => {
  const { root, ctx } = fixture('wal-manifest');
  const value = { ...manifest(root), consistency: 'stable-db-wal-committed-verified' };
  writeManifest(root, value);
  const state = call(ctx, 'status');
  assert.equal(state.snapshot_id, value.snapshot_id);
  assert.equal(state.captured_at, value.captured_at);
  assert.equal(state.capture_complete, true);
  assert.equal(state.capture_consistency, value.consistency);
});

test('J05-invalid-manifests', ['JSD-05'], 'Malformed, incomplete, unsafe-path, oversized and nonregular manifests stay unknown', () => {
  const variants = ['broken-json', 'incomplete', 'invalid-date', 'unsafe-path', 'oversized', 'directory', 'symlink'];
  for (const variant of variants) {
    const { root, ctx } = fixture('manifest-' + variant);
    const path = join(root, '.wechat-ro-manifest.json');
    if (variant === 'broken-json') writeManifest(root, '{');
    else if (variant === 'incomplete') writeManifest(root, manifest(root, { complete: false }));
    else if (variant === 'invalid-date') writeManifest(root, manifest(root, { captured_at: '2026-02-30T00:00:00+08:00' }));
    else if (variant === 'unsafe-path') writeManifest(root, manifest(root, { files: [{ path: '../elsewhere.db', size: 0, sha256: '0'.repeat(64) }] }));
    else if (variant === 'oversized') writeManifest(root, 'x'.repeat(1024 * 1024 + 1));
    else if (variant === 'directory') fs.mkdirSync(path);
    else { const target = join(root, 'manifest-target.json'); fs.writeFileSync(target, JSON.stringify(manifest(root))); fs.symlinkSync(target, path); }
    const state = call(ctx, 'status');
    for (const field of ['captured_at', 'snapshot_id', 'capture_complete', 'capture_consistency']) assert.equal(state[field], null, variant + ':' + field);
    assert.match(noteText(state), /manifest|清单/);
  }
  return { rejected_variants: variants };
});

test('J06-field-cleaning', ['JSD-06', 'JSD-12'], 'TEXT, BLOB and zstd use one final Unicode truncation with the original length', () => {
  const text = '😀'.repeat(6000);
  for (const [kind, value] of [['text', text], ['blob', Buffer.from(text)], ['zstd', zstdCompressSync(Buffer.from(text))]]) {
    const { ctx } = fixture('content-' + kind, { messages: [['alice', [{ content: value, source: Buffer.from(text) }]]], summary: value, contacts: [['alice', text]] });
    const message = call(ctx, 'messages', { session: 'alice' }).rows[0];
    assert.equal(message.content, referenceTruncate(text));
    assert.equal(message.source, referenceTruncate(text));
    assert.equal(call(ctx, 'search_messages', { query: '😀' }).rows[0].content, referenceTruncate(text, 300));
    assert.equal(call(ctx, 'sessions').rows[0].summary, referenceTruncate(text));
    assert.equal(call(ctx, 'contacts').rows[0].display_name, referenceTruncate(text));
    assert.equal(call(ctx, 'sql', { database: 'message/message_0.db', query: 'SELECT message_content AS body FROM ' + quote('Msg_' + S.md5Hex('alice')) }).rows[0].body, referenceTruncate(text));
  }
});

test('J06-literal-markers', ['JSD-06'], 'User-authored truncation-looking text is not reinterpreted as length metadata', () => {
  const short = 'literal …[截断, 共9999字符]';
  assert.equal(S.clean(short), short);
  const long = short + 'x'.repeat(2000);
  const { ctx } = fixture('literal-marker', { messages: [['alice', [{ content: long }]]] });
  assert.equal(call(ctx, 'messages', { session: 'alice' }).rows[0].content, referenceTruncate(long));
  assert.equal(call(ctx, 'search_messages', { query: 'literal' }).rows[0].content, referenceTruncate(long, 300));
});

test('J07-zstd-completion', ['JSD-07'], 'Magic-only and every truncated complete-frame prefix produce an error marker', () => {
  const frame = zstdCompressSync(Buffer.from('a complete compressed message'));
  for (let size = 4; size < frame.length; size += 1) assert.match(S.decodeContent(frame.subarray(0, size)), /^\[zstd 解压失败:/, 'prefix=' + size);
  assert.match(S.decodeContent(Buffer.from('28b52ffd', 'hex')), /^\[zstd 解压失败:/);
  assert.equal(S.decodeContent(frame), 'a complete compressed message');
  assert.equal(S.decodeContent(zstdCompressSync(Buffer.alloc(0))), '');
  assert.equal(S.decodeContent(Buffer.from('plain UTF-8 文本')), 'plain UTF-8 文本');
  return { rejected_incomplete_prefixes: frame.length - 4, valid_empty_frame_preserved: true };
});

test('J07-zstd-boundaries', ['JSD-07'], 'Trailing frames/data and invalid checksums fail rather than returning partial success', () => {
  const frame = zstdCompressSync(Buffer.from('first'));
  for (const tail of [Buffer.from('x'), Buffer.from('28b52ffd', 'hex'), frame]) assert.match(S.decodeContent(Buffer.concat([frame, tail])), /^\[zstd 解压失败:/);
  const checksumFrame = zstdCompressSync(Buffer.from('checksummed message'), { params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } });
  assert.equal(S.decodeContent(checksumFrame), 'checksummed message');
  checksumFrame[checksumFrame.length - 1] ^= 1;
  assert.match(S.decodeContent(checksumFrame), /^\[zstd 解压失败:/);
});

test('J07-zstd-roundtrip', ['JSD-07'], 'Native valid frames across header sizes and multiblock payloads still round trip', () => {
  const sizes = [0, 1, 3, 17, 255, 256, 257, 65536, 130000, 131073, 300000];
  for (const size of sizes) {
    const text = '0123456789abcdef'.repeat(Math.ceil(size / 16)).slice(0, size);
    assert.equal(S.decodeContent(zstdCompressSync(Buffer.from(text))), text, 'bytes=' + size);
  }
  return { payload_sizes: sizes };
});

test('J07-zstd-budget', ['JSD-07'], 'Decoded output exceeding 16 MiB is rejected with an explicit error', () => {
  const cap = 16 * 1024 * 1024;
  const atCap = zstdCompressSync(Buffer.alloc(cap, 97));
  assert.equal(S.decodeContent(atCap).length, cap);
  const tooLarge = zstdCompressSync(Buffer.alloc(cap + 1, 97));
  const result = S.decodeContent(tooLarge);
  assert.match(result, /^\[zstd 解压失败:/);
  return { accepted_decoded_bytes: cap, rejected_decoded_bytes: cap + 1, error: result };
});

test('J08-exact-room', ['JSD-08'], 'Full case-sensitive group ID excludes overlapping IDs and NULL/empty rows', () => {
  const { ctx } = fixture('exact-room', { groupRows: [[ROOM, 'real-a'], ['x' + ROOM, 'not-a'], [ROOM + '-suffix', 'not-b'], ['123@CHATROOM', 'not-c'], [null, 'not-d'], ['', 'not-e'], [ROOM, 'real-b']] });
  const page = call(ctx, 'chatroom_members', { room: ROOM });
  assert.deepEqual(page.rows.map((row) => row.member).sort(), ['real-a', 'real-b']);
  assert.ok(page.rows.every((row) => row.chatroom === ROOM));
  assertIncomplete(page, /NULL|空群ID/);
  assert.equal(page.has_more, false);
});

test('J08-missing-identity-columns', ['JSD-08'], 'Unknown positional room/member columns cannot invent group membership', () => {
  const { root, ctx } = fixture('missing-room');
  database(root, 'contact/contact.db', (db) => {
    db.exec('CREATE TABLE ChatRoomUnknown (mystery TEXT, member_username TEXT)');
    db.prepare('INSERT INTO ChatRoomUnknown VALUES (?, ?)').run(ROOM, 'rogue-room');
    db.exec('CREATE TABLE ChatRoomUnknownMember (room_name TEXT, mystery TEXT)');
    db.prepare('INSERT INTO ChatRoomUnknownMember VALUES (?, ?)').run(ROOM, 'rogue-member');
  });
  const page = call(ctx, 'chatroom_members', { room: ROOM });
  assert.equal(page.returned, 0);
  assertIncomplete(page, /缺少明确群ID或成员列/);
});

test('J08-filter-before-cap', ['JSD-08'], 'Other rooms do not displace exact members before the per-table scan cap', () => {
  const groupRows = Array.from({ length: 3010 }, (_, i) => ['other@chatroom', 'other-' + i]);
  groupRows.push([ROOM, 'real-a'], [ROOM, 'real-b']);
  const { ctx } = fixture('group-filter-cap', { groupRows });
  const page = call(ctx, 'chatroom_members', { room: ROOM });
  assert.deepEqual(page.rows.map((row) => row.member).sort(), ['real-a', 'real-b']);
  assert.equal(page.scan_complete, true);
  assert.equal(page.total_is_exact, true);
  assert.equal(page.truncated, false);
});

test('J09-normalize-before-limit', ['JSD-09'], 'Newest seconds or milliseconds survive 3000 older rows in larger timestamp units', () => {
  const evidence = [];
  for (const [olderScale, newestScale] of [[1000, 1], [1000000, 1000]]) {
    const rows = Array.from({ length: 3000 }, (_, i) => ({ time: (NOW - 100 - i) * olderScale, content: 'older' }));
    rows.push({ time: NOW * newestScale, content: 'newest-mixed-unit' });
    const { ctx } = fixture('mixed-time-' + olderScale, { messages: [['alice', rows]] });
    const page = call(ctx, 'search_messages', { query: 'newest-mixed-unit' });
    assert.equal(page.returned, 1);
    assert.equal(page.rows[0].create_epoch, NOW);
    assertIncomplete(page, /3000/);
    evidence.push({ older_unit_scale: olderScale, newest_unit_scale: newestScale, observed_newest_epoch: page.rows[0].create_epoch });
  }
  return evidence;
});

test('J10-subsecond-cache', ['JSD-10'], 'Same-second same-size updates invalidate cache while unchanged snapshots reuse it', () => {
  const { root, ctx } = fixture('subsecond-cache', { contacts: [['alice', 'Alice1']] });
  const path = join(root, 'contact/contact.db');
  fs.utimesSync(path, NOW + 0.1, NOW + 0.1);
  const beforeInfo = S.listDatabases(root).find((db) => db.rel === 'contact/contact.db');
  const first = ctx.snap();
  assert.equal(first.displayMap().get('alice'), 'Alice1');
  assert.equal(ctx.snap(), first, 'unchanged metadata must reuse the cache');
  database(root, 'contact/contact.db', (db) => db.exec("UPDATE contact SET nick_name='Bravo2' WHERE username='alice'"));
  fs.utimesSync(path, NOW + 0.9, NOW + 0.9);
  const afterInfo = S.listDatabases(root).find((db) => db.rel === 'contact/contact.db');
  assert.equal(afterInfo.size, beforeInfo.size);
  assert.equal(afterInfo.mtime, beforeInfo.mtime);
  const second = ctx.snap();
  assert.notEqual(second, first);
  assert.equal(second.displayMap().get('alice'), 'Bravo2');
  return { unchanged_size: beforeInfo.size, identical_display_mtime: beforeInfo.mtime, before_mtime_ns: beforeInfo.mtime_ns, after_mtime_ns: afterInfo.mtime_ns };
});

test('J10-root-cache', ['JSD-10'], 'Retargeting one synthetic root symlink cannot reuse the previous root cache', () => {
  const firstRoot = fixture('root-a', { contacts: [['alice', 'Alice1']] }).root;
  const secondRoot = fixture('root-b', { contacts: [['alice', 'Bravo2']] }).root;
  for (const root of [firstRoot, secondRoot]) for (const db of S.listDatabases(root)) fs.utimesSync(db.path, NOW, NOW);
  const container = fs.mkdtempSync(join(fixtures, 'root-alias-'));
  const alias = join(container, 'current');
  fs.symlinkSync(firstRoot, alias);
  const first = S.getSnapshot(alias, sqlite);
  assert.equal(first.displayMap().get('alice'), 'Alice1');
  // Verify the exact synthetic symlink before unlinking; never unlink a database/root.
  assert.equal(resolve(alias), join(fs.realpathSync(container), 'current'));
  assert.ok(inside(alias) && fs.lstatSync(alias).isSymbolicLink());
  fs.unlinkSync(alias);
  fs.symlinkSync(secondRoot, alias);
  const second = S.getSnapshot(alias, sqlite);
  assert.notEqual(second, first);
  assert.equal(second.displayMap().get('alice'), 'Bravo2');
  assert.equal(second.root, fs.realpathSync(secondRoot));
});

test('J10-wal-cache', ['JSD-10'], 'WAL-only changes invalidate cached names even when the main database metadata is stable', () => {
  const { root, ctx } = fixture('wal-cache', { contacts: [['alice', 'Alice1']] });
  const path = join(root, 'contact/contact.db');
  const writer = new sqlite.DatabaseSync(path);
  try {
    writer.exec('PRAGMA journal_mode=WAL');
    const first = ctx.snap();
    assert.equal(first.displayMap().get('alice'), 'Alice1');
    const before = fs.statSync(path, { bigint: true });
    writer.exec("UPDATE contact SET nick_name='Bravo2' WHERE username='alice'");
    const after = fs.statSync(path, { bigint: true });
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    const second = ctx.snap();
    assert.notEqual(second, first);
    assert.equal(second.displayMap().get('alice'), 'Bravo2');
    return { main_mtime_ns_unchanged: String(before.mtimeNs), observed_wal: fs.existsSync(path + '-wal') };
  } finally { writer.close(); }
});

test('J10-sqlite-identity', ['JSD-10'], 'Cache identity includes the injected SQLite implementation', () => {
  const { root } = fixture('sqlite-identity');
  const first = S.getSnapshot(root, sqlite);
  const other = { DatabaseSync: sqlite.DatabaseSync };
  const second = S.getSnapshot(root, other);
  assert.notEqual(second, first);
  assert.equal(second.sqlite, other);
});

test('J11-ranking-identity', ['JSD-11'], 'Identical display names stay separate stable-ID rankings; future data is excluded', () => {
  const { ctx } = fixture('ranking', { contacts: [['alice', 'Same'], ['bob', 'Same']], messages: [
    ['alice', [{ time: NOW - 100 }, { time: NOW + 3600, content: 'future' }, { time: NOW - 3 * 86400, content: 'too old' }]],
    ['bob', [{ time: NOW - 200 }]],
  ] });
  const result = atTime(NOW, () => call(ctx, 'timeline', { days: 1 }));
  assert.equal(result.total_messages, 2);
  assert.equal(result.top_sessions.length, 2);
  assert.deepEqual(result.top_sessions.map((row) => row.username).sort(), ['alice', 'bob']);
  assert.ok(result.top_sessions.every((row) => row.messages === 1 && row.session === 'Same' && row.display_name === 'Same'));
  assert.equal(result.scan_complete, true);
  assert.equal(result.total_is_exact, true);
});

test('J11-no-cross-session-fallback', ['JSD-11', 'JSD-03'], 'A known empty session never receives the only other session message table', () => {
  const { ctx } = fixture('session-identity', { messages: [['alice', [{ content: 'only-alice' }]]] });
  const page = call(ctx, 'messages', { session: 'bob' });
  assert.equal(page.returned, 0);
  assert.ok(!page.rows.some((row) => row.content === 'only-alice'));
});

test('J12-unicode-properties', ['JSD-12', 'JSD-06'], 'Truncation preserves Unicode code points and counts the original code point length', () => {
  const boundary = 'a'.repeat(1199) + '😀b';
  assert.equal(S.truncate(boundary), referenceTruncate(boundary));
  assert.equal(S.truncate('😀'.repeat(1200)), '😀'.repeat(1200));
  const alphabet = ['a', '中', '😀', '𝄞', '\u0301'];
  let seed = 123456789;
  let checked = 0;
  for (let length = 0; length <= 2000; length += 37) {
    let text = '';
    for (let i = 0; i < length; i += 1) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += alphabet[seed % alphabet.length]; }
    for (const limit of [0, 1, 299, 300, 1199, 1200]) {
      const expected = referenceTruncate(text, limit);
      assert.equal(S.truncate(text, limit), expected);
      assert.equal(S.clean(new Uint8Array(Buffer.from(text)), limit), expected);
      checked += 2;
    }
  }
  return { seed: 123456789, deterministic_property_assertions: checked, counting_unit: 'Unicode code points, not grapheme clusters' };
});

// IJ-07: unresolved source is unknown, not a verified empty table.
// Keep these cases separate so every failing combination is recorded in a red run.
for (const [method, kind, exactTable] of [['contacts', 'contact', 'contact'], ['sessions', 'session', 'SessionTable']]) {
  for (const variant of ['empty', 'nonempty', 'missing-db', 'no-table', 'ambiguous']) {
    test('IJ07-' + method + '-' + variant, ['JSD-03', 'IJ-07'], method + ' source quality: ' + variant, () => {
      const { root, ctx } = fixture('ij07-' + method + '-' + variant, { contact: false, session: false });
      const known = variant === 'empty' || variant === 'nonempty';
      const candidates = variant === 'ambiguous' ? [exactTable + 'A', exactTable + 'B'] : [exactTable];
      if (variant !== 'missing-db') database(root, kind + '/' + kind + '.db', (db) => {
        if (variant === 'no-table') {
          db.exec('PRAGMA user_version = 1'); // A real SQLite database with no candidate tables.
          assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
        } else {
          for (const table of candidates) {
            db.exec('CREATE TABLE ' + quote(table) + ' (username TEXT, nick_name TEXT, last_timestamp INTEGER)');
            if (variant !== 'empty') db.prepare('INSERT INTO ' + quote(table) + ' VALUES (?, ?, ?)').run('fixture-user', 'Fixture user', NOW);
            assert.equal(db.prepare('SELECT count(*) AS n FROM ' + quote(table)).get().n, variant === 'empty' ? 0 : 1);
          }
        }
      });
      const page = call(ctx, method, { limit: 2 });
      console.log('IJ07_OBSERVATION ' + JSON.stringify({ method, variant, page }));
      const expected = variant === 'nonempty' ? 1 : 0;
      assert.equal(page.total, expected);
      assert.equal(page.returned, expected);
      assert.equal(page.offset, 0);
      assert.equal(page.rows.length, expected);
      assert.equal(page.has_more, false, 'Unobserved rows must not imply another page');
      if (expected) assert.equal(page.rows[0].username, 'fixture-user');
      if (!known) {
        assert.ok(page.notes.includes(kind + ' 表未解析成功'), 'Keep the original unresolved-source note');
        if (variant === 'ambiguous') assert.ok(page.notes.includes('表候选不唯一，拒绝猜测: ' + candidates.slice().sort().join(', ')));
        if (variant === 'missing-db') {
          assert.ok(page.notes.includes('未找到 contact/contact.db：联系人显示名可能退化为 wxid'));
          assert.ok(page.notes.includes('未找到 session/session.db：会话列表可能为空'));
          assert.ok(page.notes.includes('快照目录 ' + root + ' 不存在或没有可读的 .db 文件。'));
          assert.ok(page.notes.includes('请核对 snapshotDir / WECHAT_SNAPSHOT_DIR 配置，并按 README 由操作者手动准备合规快照。'));
          assert.ok(page.notes.includes('本查询只读取已准备的快照，不会自动采集、提取密钥或触发 GDB。'));
        }
      } else {
        assert.ok(!page.notes.includes(kind + ' 表未解析成功'));
        assert.doesNotMatch(noteText(page), /下界/);
      }
      assert.ok(page.notes.includes('未找到 message/*.db：消息检索不可用'), 'Keep existing snapshot notes');
      assert.equal(page.scan_complete, known);
      assert.equal(page.total_is_exact, known);
      assert.equal(page.truncated, !known);
      if (!known) assert.match(noteText(page), /total 是已观察到的匹配数下界/);
      return { method, variant, candidate_tables: variant === 'missing-db' || variant === 'no-table' ? [] : candidates, page };
    });
  }
}

// IJ-17: absent message sources are unknown; a present empty Msg table is exact.
for (const [method, args] of [['messages', { session: 'alice' }], ['searchMessages', { query: 'token' }], ['timeline', { days: 3650 }]]) {
  for (const variant of ['empty', 'missing-db']) {
    test('IJ17-' + method + '-' + variant, ['JSD-03', 'IJ-17'], method + ' message source quality: ' + variant, () => {
      const known = variant === 'empty';
      const { ctx } = fixture('ij17-' + method + '-' + variant, {
        contacts: [['alice', 'Alice']], messages: known ? [['alice', []]] : undefined,
      });
      assert.equal(ctx.snap().messageDbs.length, known ? 1 : 0);
      assert.equal(call(ctx, 'contacts').total, 1);
      assert.equal(call(ctx, 'sessions').total, 1);
      const page = call(ctx, method === 'searchMessages' ? 'search_messages' : method, args);
      console.log('IJ17_OBSERVATION ' + JSON.stringify({ method, variant, page }));
      assert.equal(method === 'timeline' ? page.total_messages : page.total, 0);
      assert.equal(page.rows.length, 0);
      if (method !== 'messages') assert.equal(page.scanned_tables, known ? 1 : 0);
      if (method !== 'timeline') {
        assert.equal(page.returned, 0);
        assert.equal(page.offset, 0);
        assert.equal(page.has_more, false, 'Unobserved messages must not imply another page');
      } else {
        assert.equal(Object.hasOwn(page, 'has_more'), false);
        assert.equal(Object.hasOwn(page, 'truncated'), false);
      }
      if (known) {
        assert.doesNotMatch(noteText(page), /消息检索不可用|下界/);
      } else {
        assert.ok(page.notes.includes('未找到 message/*.db：消息检索不可用'), 'Keep the original missing-message-source note');
      }
      assert.equal(page.scan_complete, known);
      assert.equal(page.total_is_exact, known);
      if (method !== 'timeline') assert.equal(page.truncated, !known);
      if (!known) assert.match(noteText(page), /下界/);
      return { method, variant, message_databases: ctx.snap().messageDbs.length, page };
    });
  }
}

// IJ-18: a missing member schema is not a verified empty membership table.
for (const variant of ['empty', 'no-member-table']) {
  test('IJ18-chatroomMembers-' + variant, ['JSD-03', 'IJ-18'], 'chatroomMembers source quality: ' + variant, () => {
    const known = variant === 'empty';
    const { root, ctx } = fixture('ij18-' + variant, { contacts: [[ROOM, 'Fixture room']], session: false });
    if (known) database(root, 'contact/contact.db', (db) => {
      db.exec('CREATE TABLE chatroom_members (room_id TEXT, member_username TEXT)');
      assert.equal(db.prepare('SELECT count(*) AS n FROM chatroom_members').get().n, 0);
    });
    assert.equal(call(ctx, 'contacts').total, 1);
    const page = call(ctx, 'chatroom_members', { room: ROOM, limit: 2 });
    console.log('IJ18_OBSERVATION ' + JSON.stringify({ method: 'chatroomMembers', variant, page }));
    assert.equal(page.total, 0);
    assert.equal(page.returned, 0);
    assert.equal(page.rows.length, 0);
    assert.equal(page.offset, 0);
    assert.equal(page.has_more, false, 'Unknown membership must not imply another page');
    assert.ok(page.notes.includes('未找到 session/session.db：会话列表可能为空'));
    assert.ok(page.notes.includes('未找到 message/*.db：消息检索不可用'));
    assert.ok(page.notes.includes('未在 contact.db 找到 ' + ROOM + ' 的群成员；候选表: ' + (known ? 'chatroom_members' : '无')));
    assert.equal(page.scan_complete, known);
    assert.equal(page.total_is_exact, known);
    assert.equal(page.truncated, !known);
    if (known) assert.doesNotMatch(noteText(page), /下界/);
    else assert.match(noteText(page), /total 是已观察到的匹配数下界/);
    return { method: 'chatroomMembers', variant, page };
  });
}

for (let n = 0; n <= 12; n += 1) {
  const id = 'JSD-' + String(n).padStart(2, '0');
  const covered = results.filter((test) => test.findings.includes(id));
  findings.push({ id, tests: covered.map((test) => test.id), passed: covered.length > 0 && covered.every((test) => test.passed) });
}
const report = { schema_version: 1, runtime, node: process.version, sqlite: process.versions.sqlite, zstd: process.versions.zstd,
  evidence_root: evidence, fixture_root: fixtures, snapshot_env: process.env.WECHAT_SNAPSHOT_DIR, tmpdir: process.env.TMPDIR,
  scope: 'Synthetic fixtures only; no real WeChat data, processes, credentials or live decryption',
  tests: results.length, passed: results.filter((test) => test.passed).length, failed: results.filter((test) => !test.passed).length,
  findings, results };
const output = join(process.env.TMPDIR, 'test-results.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('RESULT ' + report.passed + '/' + report.tests + ' passed; report=' + output);
process.exitCode = report.failed ? 1 : 0;
