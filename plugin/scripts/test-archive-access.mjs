import { homedir as desktopHome } from 'node:os';
import { resolve as desktopPath } from 'node:path';
// Synthetic fixtures only. Never probes, reads, hashes or copies the original WeChat directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { zstdCompressSync } from 'node:zlib';
import { createArchiveAccess, ARCHIVE_ACCESS_LIMITS } from '../lib/archive-access.js';
import { captureArchiveMetadata, runArchiveQuery } from '../lib/archive-query-worker.js';

const ORIGINAL = desktopPath(desktopHome(), 'Documents/xwechat_files'); // String/denial testing only.
const BASE_TS = 1700000000;
const base = fs.mkdtempSync('/tmp/wechat-native-access-test-');
assert.equal(resolve(base), base);
assert.ok(base.startsWith('/tmp/wechat-native-access-test-') && base !== '/tmp');
const alpha = 'alpha', beta = 'beta', evil = "evil' OR 1=1 --";
const tableName = user => 'Msg_' + createHash('md5').update(user).digest('hex');
const qi = value => '"' + value.replaceAll('"', '""') + '"';
const accesses = [], forks = [], factories = [], timings = [], byteMetrics = [];
let originalAccesses = 0, dbByteReads = 0, passed = 0;
const originalFs = new Map();
for (const name of ['openSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'readlinkSync', 'realpathSync', 'opendirSync', 'copyFileSync', 'readSync', 'renameSync']) {
  const original = fs[name]; originalFs.set(name, original);
  fs[name] = function (...args) {
    const path = args[0] instanceof URL ? args[0].pathname : typeof args[0] === 'string' ? args[0] : '';
    if (path === ORIGINAL || path.startsWith(ORIGINAL + '/')) { originalAccesses++; throw new Error('TEST FORBIDS ORIGINAL DATA I/O'); }
    if (name === 'renameSync') for (const target of args.slice(0, 2)) { assert.equal(resolve(target), target); assert.ok(target.startsWith(base + '/')); }
    if (name === 'readSync') dbByteReads++;
    accesses.push({ name, path }); return original.apply(this, args);
  };
}
const originalFork = childProcess.fork;
childProcess.fork = function (path, args, options) {
  const child = originalFork.call(this, path, args, options), item = { path, args, options, child, ready: false, closed: false, exitSignal: null, payloads: [] };
  const originalSend = child.send;
  child.send = function (payload, ...rest) { item.payloads.push(payload); return originalSend.call(this, payload, ...rest); };
  item.readyPromise = new Promise((done, reject) => {
    child.on('message', message => { if (message?.kind === 'query-ready') { item.ready = true; done(); } });
    child.once('close', (_, signal) => { item.closed = true; item.exitSignal = signal; if (!item.ready) reject(new Error('child closed before query-ready')); });
  });
  item.readyPromise.catch(() => {}); forks.push(item); return child;
};
syncBuiltinESMExports();
function fixture(name, { betaText = false, longText = null } = {}) {
  const root = join(base, name); fs.mkdirSync(root);
  for (const dir of ['contact', 'session', 'message']) fs.mkdirSync(join(root, dir));
  let db = new DatabaseSync(join(root, 'contact/contact.db'));
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE contact(username TEXT COLLATE NOCASE, remark TEXT, nick_name TEXT, alias TEXT)');
  for (const [user, label] of [[alpha, 'Alpha'], [beta, 'UNAUTHORIZED CONTACT'], [evil, 'Injection-as-data'], ['ALPHA', 'Uppercase not alpha']])
    db.prepare('INSERT INTO contact VALUES(?,?,?,?)').run(user, label, '', ''); db.close();
  db = new DatabaseSync(join(root, 'session/session.db'));
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE SessionTable(username TEXT COLLATE NOCASE, last_timestamp INTEGER, summary TEXT)');
  for (const [user, ts, summary] of [[alpha, BASE_TS + 5, 'Needle alpha'], [beta, BASE_TS + 5, Buffer.from('UNAUTHORIZED BLOB SUMMARY')], [evil, BASE_TS + 5, 'Injection-as-data'], ['ALPHA', BASE_TS + 5, 'Not alpha']])
    db.prepare('INSERT INTO SessionTable VALUES(?,?,?)').run(user, ts, summary); db.close();
  db = new DatabaseSync(join(root, 'message/message0.db')); db.exec('PRAGMA journal_mode=DELETE');
  for (const user of [alpha, beta, evil]) db.exec('CREATE TABLE ' + qi(tableName(user)) + '(local_id INTEGER, create_time INTEGER, message_content TEXT, local_type INTEGER)');
  const statement = db.prepare('INSERT INTO ' + qi(tableName(alpha)) + ' VALUES(?,?,?,1)');
  for (const [id, ts, content] of [[1, BASE_TS - 1, 'outside-before'], [2, BASE_TS, longText ?? 'Needle lower'], [3, (BASE_TS + 5) * 1000, 'Needle milliseconds'], [4, (BASE_TS + 10) * 1000000, 'Needle microseconds'], [5, BASE_TS + 11, 'outside-after']]) statement.run(id, ts, content);
  db.prepare('INSERT INTO ' + qi(tableName(beta)) + ' VALUES(?,?,?,1)').run(6, BASE_TS + 5, betaText ? 'Needle beta' : Buffer.from('UNAUTHORIZED BLOB MESSAGE'));
  db.prepare('INSERT INTO ' + qi(tableName(evil)) + ' VALUES(?,?,?,1)').run(7, BASE_TS + 5, 'Injection-as-data'); db.close(); return root;
}
const grantFor = (root, overrides = {}) => ({ root, allConversations: false, talkers: [alpha], fromTs: null, toTs: null, allowWechat: false, confirmation: 'read-decrypted-snapshot', ...overrides });
function factory(ids = ['session'], options = {}, history = new Map(ids.map(id => [id, false]))) {
  const access = createArchiveAccess({ hasArchiveHistory: id => history.get(id) ?? 'unknown', markArchiveHistory: id => { history.set(id, true); }, ...options });
  factories.push(access); return { access, history };
}
async function check(name, fn) { await fn(); passed++; console.log('ok - ' + name); }
const rejects = (fn, code) => assert.rejects(fn, error => { assert.equal(error.code, code); assert.equal(error.message, 'Archive access: ' + code); return true; });
const directPayload = (root, q, scope = {}, limits = {}) => ({ kind: 'query', root, limits: { ...ARCHIVE_ACCESS_LIMITS, ...limits }, expected: captureArchiveMetadata(root),
  scope: { allConversations: false, talkers: [alpha], fromTs: null, toTs: null, ...scope }, query: { limit: 100, offset: 0, fromTs: null, toTs: null, ...q } });
try {
  await check('fixed child reads a pinned descriptor URI, not a path argument', async () => {
    const root = fixture('smoke'); const { access } = factory();
    await access.grant('session', grantFor(root, { fromTs: BASE_TS, toTs: BASE_TS + 10 }));
    const page = await access.query('session', { action: 'messages', talker: alpha });
    assert.deepEqual(page.rows.map(row => row.ts), [BASE_TS + 10, BASE_TS + 5, BASE_TS]);
    assert.equal(page.scopeApplied, 'sql-before-rows'); assert.equal(page.untrusted, true);
    assert.equal(page.bytes, Buffer.byteLength(JSON.stringify(page))); assert.equal(JSON.stringify(page).includes(root), false);
  });
  await check('default grant is closed and has no filesystem/spawn/environment fallback', async () => {
    const beforeFs = accesses.length, beforeForks = forks.length, old = process.env.WECHAT_SNAPSHOT_DIR;
    process.env.WECHAT_SNAPSHOT_DIR = ORIGINAL;
    const access = createArchiveAccess({ sourceRoot: ORIGINAL }); factories.push(access);
    assert.equal(access.getState('closed').granted, false); assert.equal(access.canShare('closed'), false);
    await rejects(() => access.query('closed', { action: 'status' }), 'not-granted');
    for (const root of [ORIGINAL, ORIGINAL + '/metadata-only.db', desktopPath(desktopHome(), 'Documents'), '/home', '/', ORIGINAL + '/'])
      await rejects(() => access.grant('closed', grantFor(root)), 'forbidden-root');
    await rejects(() => access.grant('closed', { ...grantFor('/tmp/not-used'), confirmation: 'wrong' }), 'invalid-request');
    const aborted = new AbortController(); aborted.abort();
    await rejects(() => access.grant('closed', grantFor('/tmp/not-used'), aborted.signal), 'aborted');
    await access.dispose();
    if (old === undefined) delete process.env.WECHAT_SNAPSHOT_DIR; else process.env.WECHAT_SNAPSHOT_DIR = old;
    assert.equal(accesses.length, beforeFs); assert.equal(forks.length, beforeForks);
  });
  await check('invalid grant shapes, accessors and array holes fail before I/O', async () => {
    const { access } = factory(), before = forks.length; const request = grantFor('/tmp/not-used');
    for (const change of [{ allConversations: true }, { talkers: [] }, { talkers: [alpha, alpha] }, { talkers: Array(1) }, { fromTs: NaN }, { fromTs: 10, toTs: 9 }, { sql: 'SELECT *' }, { allowWechat: 'yes' }, { fromTs: undefined }])
      await rejects(() => access.grant('session', { ...request, ...change }), 'invalid-request');
    let getterCalls = 0; const bad = { ...request }; Object.defineProperty(bad, 'root', { get() { getterCalls++; return '/tmp/not-used'; } });
    await rejects(() => access.grant('session', bad), 'invalid-request'); assert.equal(getterCalls, 0);
    assert.equal(forks.length, before);
    assert.throws(() => createArchiveAccess({ maxRows: 201 }), error => error.code === 'invalid-options');
    assert.throws(() => createArchiveAccess({ maxBytes: 131073 }), error => error.code === 'invalid-options');
    assert.throws(() => createArchiveAccess({ queryTimeoutMs: 15001 }), error => error.code === 'invalid-options');
    assert.throws(() => createArchiveAccess({ hasArchiveHistory: () => false }), error => error.code === 'invalid-options');
  });
  const root = fixture('scope');
  await check('explicit Owner roster is ephemeral, contact-only, bounded, and grants no model or send permission', async () => {
    const access = createArchiveAccess({ sourceRoot: ORIGINAL }); factories.push(access);
    const before = forks.length;
    for (const path of [ORIGINAL, ORIGINAL + '/contacts', desktopPath(desktopHome(), 'Documents'), '/'])
      await rejects(() => access.browseRoster(path, { confirmation: 'browse-snapshot-roster' }), 'forbidden-root');
    for (const change of [{ confirmation: 'read-decrypted-snapshot' }, { action: 'messages' }, { sessionId: 'session' }, { allowWechat: true }, { query: '' }, { limit: 101 }, { offset: 1001 }, { sql: 'SELECT *' }])
      await rejects(() => access.browseRoster(root, { confirmation: 'browse-snapshot-roster', ...change }), 'invalid-request');
    const cancelled = new AbortController(); cancelled.abort();
    await rejects(() => access.browseRoster(root, { confirmation: 'browse-snapshot-roster' }, cancelled.signal), 'aborted');
    assert.equal(forks.length, before);
    const first = await access.browseRoster(root, { confirmation: 'browse-snapshot-roster', limit: 1, offset: 0 });
    assert.equal(first.action, 'contacts'); assert.equal(first.metadataOnly, true); assert.equal(first.hasMore, true);
    assert.equal(first.bytes, Buffer.byteLength(JSON.stringify(first))); assert.equal(first.rows.length, 1);
    const second = await access.browseRoster(root, { confirmation: 'browse-snapshot-roster', limit: 1, offset: first.returned });
    assert.notEqual(second.rows[0].talker, first.rows[0].talker);
    const found = await access.browseRoster(root, { confirmation: 'browse-snapshot-roster', query: 'UNAUTHORIZED CONTACT' });
    assert.deepEqual(found.rows.map(row => row.talker), [beta]);
    const injection = await access.browseRoster(root, { confirmation: 'browse-snapshot-roster', query: "%' OR 1=1 --" });
    assert.deepEqual(injection.rows, []);
    assert.equal(access.getState('session').granted, false); assert.equal(access.canShare('session'), false);
    await rejects(() => access.query('session', { action: 'messages', talker: beta }), 'not-granted');
    const packets = forks.slice(before).flatMap(item => item.payloads);
    assert.ok(packets.some(packet => packet.kind === 'inspect'));
    assert.ok(packets.filter(packet => packet.kind === 'query').every(packet => packet.query.action === 'contacts'));
    assert.equal(JSON.stringify([first, second, found]).includes('UNAUTHORIZED BLOB MESSAGE'), false);
  });
  await check('scope is session-bound and SQL/path/foreign-session fields are not parameters', async () => {
    const { access } = factory(['owner', 'foreign']); await access.grant('owner', grantFor(root));
    await rejects(() => access.query('foreign', { action: 'contacts' }), 'not-granted');
    const before = forks.length;
    for (const change of [{ sql: 'SELECT * FROM contact' }, { path: root }, { root }, { sessionId: 'owner' }, { destination: 'wechat' }, { limit: 201 }, { limit: 0 }, { offset: 1001 }, { offset: -1 }])
      await rejects(() => access.query('owner', { action: 'contacts', ...change }), 'invalid-request');
    await rejects(() => access.query('owner', { action: 'messages', talker: beta }), 'scope-forbidden');
    await rejects(() => access.query('owner', { action: 'contacts', talker: 'ALPHA' }), 'scope-forbidden');
    assert.equal(forks.length, before);
    const page = await access.query('owner', { action: 'contacts' }); assert.deepEqual(page.rows.map(r => r.talker), [alpha]);
    assert.equal(JSON.stringify(page).includes('UNAUTHORIZED'), false);
    await rejects(() => access.query('owner', { action: 'contacts' }, undefined, 'wechat'), 'share-forbidden');
  });
  await check('SQL selects contact/time scopes before rows and never selects unauthorized message tables', async () => {
    const calls = [], original = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = original.call(this, sql);
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args) => { calls.push({ sql, args }); return value.apply(target, args); };
      } });
    };
    try {
      const page = runArchiveQuery(directPayload(root, { action: 'messages', talker: alpha }, { fromTs: BASE_TS, toTs: BASE_TS + 10 }));
      assert.deepEqual(page.rows.map(r => r.ts), [BASE_TS + 10, BASE_TS + 5, BASE_TS]);
      assert.ok(calls.some(c => c.sql.includes(' AS content') && c.sql.includes(' >= ?') && c.sql.includes(' <= ?') && c.args[0] === BASE_TS && c.args[1] === BASE_TS + 10));
      assert.equal(calls.some(c => c.sql.includes(qi(tableName(beta)))), false);
      calls.length = 0;
      const contacts = runArchiveQuery(directPayload(root, { action: 'contacts', query: 'Alpha' }));
      assert.deepEqual(contacts.rows.map(r => r.talker), [alpha]);
      assert.ok(calls.some(c => c.sql.includes(' AS displayName') && c.sql.includes('COLLATE BINARY IN (?)') && c.args[0] === alpha));
    } finally { DatabaseSync.prototype.prepare = original; }
  });
  await check('inclusive time constraints cannot be broadened; unknown temporal contacts fail closed', async () => {
    const { access } = factory(); await access.grant('session', grantFor(root, { fromTs: BASE_TS, toTs: BASE_TS + 10 }));
    const before = forks.length;
    await rejects(() => access.query('session', { action: 'messages', talker: alpha, fromTs: BASE_TS - 1 }), 'scope-forbidden');
    await rejects(() => access.query('session', { action: 'messages', talker: alpha, toTs: BASE_TS + 11 }), 'scope-forbidden');
    await rejects(() => access.query('session', { action: 'contacts' }), 'unsupported-scope'); assert.equal(forks.length, before);
    const messages = await access.query('session', { action: 'messages', talker: alpha, fromTs: BASE_TS + 5, toTs: BASE_TS + 5 });
    assert.equal(messages.rows.length, 1); assert.equal(messages.rows[0].ts, BASE_TS + 5);
    const sessions = await access.query('session', { action: 'sessions' }); assert.deepEqual(sessions.rows.map(r => r.talker), [alpha]);
    assert.throws(() => runArchiveQuery(directPayload(root, { action: 'messages', talker: beta })), error => error.code === 'scope-forbidden');
    assert.throws(() => runArchiveQuery(directPayload(root, { action: 'messages', talker: alpha, fromTs: BASE_TS - 1 }, { fromTs: BASE_TS, toTs: BASE_TS + 10 })), error => error.code === 'scope-forbidden');
  });
  await check('epoch zero and maximum Unix seconds keep their true inclusive scope', async () => {
    const epochRoot = fixture('epoch-boundaries'); const db = new DatabaseSync(join(epochRoot, 'message/message0.db'));
    db.exec('DELETE FROM ' + qi(tableName(alpha))); const insert = db.prepare('INSERT INTO ' + qi(tableName(alpha)) + ' VALUES(?,?,?,1)');
    insert.run(1, 0, 'epoch-zero'); insert.run(2, 253402300799, 'maximum-seconds'); db.close(); const { access } = factory();
    for (const ts of [0, 253402300799]) {
      await access.grant('session', grantFor(epochRoot, { fromTs: ts, toTs: ts }));
      const page = await access.query('session', { action: 'messages', talker: alpha }); assert.deepEqual(page.rows.map(r => r.ts), [ts]);
    }
  });
  await check('without the paired durable history barrier local query fails before spawning', async () => {
    const access = createArchiveAccess(); factories.push(access); await access.grant('untracked', grantFor(root)); const before = forks.length;
    await rejects(() => access.query('untracked', { action: 'contacts' }), 'history-persistence-failed');
    assert.equal(forks.length, before); assert.equal(access.canShare('untracked'), false);
  });
  await check('metadata-only status does not claim decrypted format detection', async () => {
    const unverified = fixture('unverified'); fs.writeFileSync(join(unverified, 'contact/contact.db'), Buffer.alloc(1024, 255)); const { access } = factory();
    const state = await access.grant('session', grantFor(unverified)); assert.equal(state.formatVerified, false);
    const status = await access.query('session', { action: 'status' }); assert.equal(status.rows[0].metadataOnly, true); assert.equal(status.rows[0].formatVerified, false);
    await rejects(() => access.query('session', { action: 'contacts' }), 'unsupported-layout'); assert.equal(access.getState('session').granted, false);
  });
  await check('search and quote-bearing talkers are data, not SQL or wildcard access', async () => {
    const { access } = factory(); await access.grant('session', grantFor(root));
    const matches = await access.query('session', { action: 'search', query: 'needle' }); assert.equal(matches.rows.length, 3);
    const empty = await access.query('session', { action: 'search', query: "%' OR 1=1 --" }); assert.equal(empty.rows.length, 0);
    await access.grant('session', grantFor(root, { talkers: [evil] }));
    const page = await access.query('session', { action: 'messages', talker: evil }); assert.deepEqual(page.rows.map(r => r.talker), [evil]);
  });
  await check('limits, stable offset, source citations and read-only data are bounded', async () => {
    const hashed = () => ['contact/contact.db', 'session/session.db', 'message/message0.db'].map(rel => createHash('sha256').update(fs.readFileSync(join(root, rel))).digest('hex'));
    const before = hashed(), { access } = factory(['session'], { maxRows: 1, maxOffset: 2 }); await access.grant('session', grantFor(root));
    const first = await access.query('session', { action: 'messages', talker: alpha, limit: 200 });
    const second = await access.query('session', { action: 'messages', talker: alpha, offset: 1 });
    assert.equal(first.rows.length, 1); assert.equal(first.limit, 1); assert.equal(first.hasMore, true);
    assert.notEqual(first.rows[0].id, second.rows[0].id); assert.match(first.rows[0].citation.recordRef, /^[0-9a-f]{32}$/);
    assert.equal(first.rows[0].citation.snapshotRef, first.source.snapshotRef);
    await rejects(() => access.query('session', { action: 'messages', talker: alpha, offset: 3 }), 'invalid-request');
    assert.deepEqual(hashed(), before);
  });
  await check('duplicate local IDs have distinct stable citations without private sort keys', async () => {
    const duplicate = fixture('duplicate-ids'); const db = new DatabaseSync(join(duplicate, 'message/message0.db'));
    db.exec('DELETE FROM ' + qi(tableName(alpha))); const insert = db.prepare('INSERT INTO ' + qi(tableName(alpha)) + ' VALUES(?,?,?,1)');
    insert.run(1, BASE_TS, 'first-physical-row'); insert.run(1, BASE_TS, 'second-physical-row'); db.close(); const { access } = factory();
    await access.grant('session', grantFor(duplicate)); const first = await access.query('session', { action: 'messages', talker: alpha, limit: 1 });
    const next = await access.query('session', { action: 'messages', talker: alpha, limit: 1, offset: 1 });
    assert.notEqual(first.rows[0].citation.recordRef, next.rows[0].citation.recordRef); assert.equal(first.rows[0].content, 'first-physical-row'); assert.equal(next.rows[0].content, 'second-physical-row');
    assert.equal(first.hasMore, true); assert.equal(next.hasMore, false);
    assert.equal(first.timezone, 'Asia/Shanghai');
    assert.ok([...first.rows, ...next.rows].every(row => Date.parse(row.localTime) === row.ts * 1000 && row.localTime.endsWith('+08:00')));
    assert.equal(first.rows[0].localTime, '2023-11-15T06:13:20+08:00');
    assert.equal(first.bytes, Buffer.byteLength(JSON.stringify(first)));
    assert.equal('_file' in first.rows[0], false); assert.equal('_rowRef' in first.rows[0], false); assert.equal(JSON.stringify(first).includes('message0.db'), false);
  });
  await check('UTF-8 byte budgets and field truncation are measured, not guessed', async () => {
    const longRoot = fixture('bytes', { longText: '中'.repeat(5000) }); const { access } = factory(['session'], { maxBytes: 4096 });
    await access.grant('session', grantFor(longRoot, { fromTs: BASE_TS, toTs: BASE_TS }));
    const page = await access.query('session', { action: 'messages', talker: alpha });
    assert.equal(page.rows[0].content.length, 1024); assert.equal(page.rows[0].contentTruncated, true); assert.equal(page.truncated, true);
    assert.equal(page.bytes, Buffer.byteLength(JSON.stringify(page))); assert.ok(page.bytes <= 4096);
    byteMetrics.push({ maxBytes: 4096, actualBytes: page.bytes, originalChars: 5000, returnedChars: page.rows[0].content.length });
    const small = factory(['small'], { maxBytes: 512 }).access; await small.grant('small', grantFor(longRoot, { fromTs: BASE_TS, toTs: BASE_TS }));
    await rejects(() => small.query('small', { action: 'messages', talker: alpha }), 'byte-budget-exceeded');
  });
  await check('sticky history survives revoke, regrant, identity replacement and a new access instance', async () => {
    const history = new Map([['sticky', false]]), { access } = factory(['sticky'], {}, history);
    assert.equal(access.canShare('sticky'), true); await access.grant('sticky', grantFor(root));
    await access.query('sticky', { action: 'contacts' }); assert.equal(history.get('sticky'), true); assert.equal(access.canShare('sticky'), false);
    const revoked = access.revoke('sticky'); assert.equal(revoked.sessionMayContainArchiveData, true); assert.equal(revoked.granted, false);
    await access.grant('sticky', grantFor(root)); assert.equal(access.canShare('sticky'), false);
    const other = factory(['sticky'], {}, history).access; assert.equal(other.getState('sticky').sessionMayContainArchiveData, true); assert.equal(other.canShare('sticky'), false);
    await other.grant('sticky', grantFor(root, { allowWechat: true })); assert.equal(other.canShare('sticky'), true);
    const page = await other.query('sticky', { action: 'contacts' }, undefined, 'wechat'); assert.equal(page.rows.length, 1);
    other.revoke('sticky'); assert.equal(other.canShare('sticky'), false); assert.equal(other.getState('sticky').sessionMayContainArchiveData, true);
    const unknown = factory([], {}, new Map()).access; assert.equal(unknown.canShare('missing'), false);
    await unknown.grant('missing', grantFor(root, { allowWechat: true })); assert.equal(unknown.canShare('missing'), false);
  });
  await check('durable history barrier precedes result delivery and cannot be washed by revoke', async () => {
    let entered, release; const started = new Promise(done => { entered = done; }), barrier = new Promise(done => { release = done; });
    const history = new Map([['barrier', false]]), { access } = factory(['barrier'], { markArchiveHistory: async id => { entered(); await barrier; history.set(id, true); } }, history);
    await access.grant('barrier', grantFor(root)); let delivered = false;
    const query = access.query('barrier', { action: 'contacts' }).then(() => { delivered = true; }); query.catch(() => {});
    await started; assert.equal(delivered, false); assert.equal(access.canShare('barrier'), false);
    access.revoke('barrier'); release(); await rejects(() => query, 'revoked');
    assert.equal(history.get('barrier'), true); assert.equal(access.getState('barrier').sessionMayContainArchiveData, true);
  });
  await check('failed persistence produces no archive page', async () => {
    const { access } = factory(['session'], { markArchiveHistory: () => { throw new Error('do not expose raw storage details'); } });
    await access.grant('session', grantFor(root)); await rejects(() => access.query('session', { action: 'contacts' }), 'history-persistence-failed');
    assert.equal(access.getState('session').sessionMayContainArchiveData, true); assert.equal(access.canShare('session'), false);
  });
  await check('root ancestor/root/database symlinks reject without reading their targets', async () => {
    const alias = join(base, 'original-alias'); fs.symlinkSync(ORIGINAL, alias, 'dir');
    let before = dbByteReads; assert.throws(() => captureArchiveMetadata(alias), error => error.code === 'path-rejected'); assert.equal(dbByteReads, before);
    const { access } = factory(); await rejects(() => access.grant('session', grantFor(alias)), 'path-rejected');
    const nested = join(base, 'ancestor-alias'); fs.symlinkSync(root, nested, 'dir');
    assert.throws(() => captureArchiveMetadata(join(nested, 'message')), error => error.code === 'path-rejected');
    const linkedRoot = fixture('linked-db'); const dbPath = join(linkedRoot, 'message/message0.db');
    fs.renameSync(dbPath, join(linkedRoot, 'message/old.backup')); fs.symlinkSync(ORIGINAL + '/metadata-only.db', dbPath);
    before = dbByteReads; assert.throws(() => captureArchiveMetadata(linkedRoot), error => error.code === 'path-rejected'); assert.equal(dbByteReads, before);
    assert.equal(originalAccesses, 0);
  });
  await check('hardlinks, live WAL sidecars, directory and file budgets fail closed', async () => {
    const linked = fixture('hardlink'); fs.linkSync(join(linked, 'message/message0.db'), join(linked, 'message/hard.backup'));
    assert.throws(() => captureArchiveMetadata(linked), error => error.code === 'path-rejected');
    const wal = fixture('wal'); fs.writeFileSync(join(wal, 'message/message0.db-wal'), 'synthetic');
    assert.throws(() => captureArchiveMetadata(wal), error => error.code === 'unsupported-layout');
    const many = fixture('files'); for (let i = 0; i < 33; i++) fs.writeFileSync(join(many, 'metadata-' + i), 'fixture');
    assert.throws(() => captureArchiveMetadata(many), error => error.code === 'file-budget-exceeded');
    const dirs = fixture('directories'); for (let i = 0; i < 17; i++) fs.mkdirSync(join(dirs, 'directory-' + i));
    assert.throws(() => captureArchiveMetadata(dirs), error => error.code === 'file-budget-exceeded');
    assert.throws(() => captureArchiveMetadata(root, { ...ARCHIVE_ACCESS_LIMITS, maxDbBytes: 1024 }), error => error.code === 'file-budget-exceeded');
    const huge = fixture('file-bytes'); fs.truncateSync(join(huge, 'message/message0.db'), ARCHIVE_ACCESS_LIMITS.maxDbBytes + 1);
    assert.throws(() => captureArchiveMetadata(huge), error => error.code === 'file-budget-exceeded');
  });
  await check('replacement and root metadata changes invalidate before any new database byte read', async () => {
    const replaced = fixture('replacement'), { access } = factory(); await access.grant('session', grantFor(replaced));
    const payload = directPayload(replaced, { action: 'messages', talker: alpha }); fs.renameSync(replaced, join(base, 'replacement-old')); fixture('replacement', { betaText: true });
    const before = dbByteReads; assert.throws(() => runArchiveQuery(payload), error => error.code === 'snapshot-changed'); assert.equal(dbByteReads, before);
    await rejects(() => access.query('session', { action: 'messages', talker: alpha }), 'snapshot-changed'); assert.equal(access.getState('session').granted, false);
    const changed = fixture('changed-root'), p = directPayload(changed, { action: 'contacts' }); fs.writeFileSync(join(changed, 'new-metadata'), 'synthetic');
    assert.throws(() => runArchiveQuery(p), error => error.code === 'snapshot-changed');
  });
  await check('in-flight path replacement cannot redirect the pinned SQLite fd', async () => {
    const race = fixture('inflight'), p = directPayload(race, { action: 'messages', talker: alpha }); let mutated = false;
    assert.throws(() => runArchiveQuery(p, () => {
      mutated = true; const path = join(race, 'message/message0.db'); fs.renameSync(path, join(race, 'message/old.backup'));
      fs.symlinkSync(ORIGINAL + '/metadata-only.db', path);
    }), error => error.code === 'path-rejected');
    assert.equal(mutated, true); assert.equal(originalAccesses, 0);
    const sameInode = fixture('inplace'), pending = directPayload(sameInode, { action: 'messages', talker: alpha });
    assert.throws(() => runArchiveQuery(pending, () => {
      const db = new DatabaseSync(join(sameInode, 'message/message0.db')); db.prepare('UPDATE ' + qi(tableName(alpha)) + ' SET message_content=?').run('changed after authorization'); db.close();
    }), error => error.code === 'snapshot-changed');
  });
  await check('unknown/ambiguous/virtual/BLOB formats are errors, never fake empty successes', async () => {
    const blob = factory(['session']).access; await blob.grant('session', grantFor(root, { talkers: [beta] }));
    await rejects(() => blob.query('session', { action: 'messages', talker: beta }), 'unsupported-content');
    const ambiguous = fixture('ambiguous'); let db = new DatabaseSync(join(ambiguous, 'contact/contact.db')); db.exec('ALTER TABLE contact ADD COLUMN wxid TEXT'); db.close();
    const a = factory(['session']).access; await a.grant('session', grantFor(ambiguous)); await rejects(() => a.query('session', { action: 'contacts' }), 'unsupported-schema');
    const virtual = fixture('virtual'); db = new DatabaseSync(join(virtual, 'contact/contact.db')); db.exec('DROP TABLE contact; CREATE VIRTUAL TABLE contact USING fts5(username,remark)'); db.close();
    const v = factory(['session']).access; await v.grant('session', grantFor(virtual)); await rejects(() => v.query('session', { action: 'contacts' }), 'unsupported-schema');
    const absent = fixture('absent'); db = new DatabaseSync(join(absent, 'message/message0.db')); db.exec('DROP TABLE ' + qi(tableName(alpha))); db.close();
    const missing = factory(['session']).access; await missing.grant('session', grantFor(absent)); await rejects(() => missing.query('session', { action: 'messages', talker: alpha }), 'unsupported-schema');
    const unknownTime = fixture('unknown-time'); db = new DatabaseSync(join(unknownTime, 'session/session.db')); db.prepare('UPDATE SessionTable SET last_timestamp=NULL WHERE username=? COLLATE BINARY').run(alpha); db.close();
    const t = factory(['session']).access; await t.grant('session', grantFor(unknownTime)); await rejects(() => t.query('session', { action: 'sessions' }), 'unsupported-content');
    const noText = fixture('null-text'); db = new DatabaseSync(join(noText, 'message/message0.db')); db.exec('UPDATE ' + qi(tableName(alpha)) + ' SET message_content=NULL'); db.close();
    const n = factory(['session']).access; await n.grant('session', grantFor(noText)); await rejects(() => n.query('session', { action: 'messages', talker: alpha }), 'unsupported-content');
    const noRowid = fixture('without-rowid'); db = new DatabaseSync(join(noRowid, 'message/message0.db'));
    db.exec('DROP TABLE ' + qi(tableName(alpha)) + '; CREATE TABLE ' + qi(tableName(alpha)) + '(local_id INTEGER PRIMARY KEY, create_time INTEGER, message_content TEXT, local_type INTEGER) WITHOUT ROWID');
    db.prepare('INSERT INTO ' + qi(tableName(alpha)) + ' VALUES(1,?,?,1)').run(BASE_TS, 'known text but unsupported locator'); db.close();
    const w = factory(['session']).access; await w.grant('session', grantFor(noRowid)); await rejects(() => w.query('session', { action: 'messages', talker: alpha }), 'unsupported-schema');
  });
  await check('message senders resolve exact selected Name2Id rows without attributing unresolved IDs', async () => {
    const senderRoot = fixture('sender-identities');
    const db = new DatabaseSync(join(senderRoot, 'message/message0.db'));
    db.exec('ALTER TABLE ' + qi(tableName(alpha)) + ' ADD COLUMN real_sender_id INTEGER; CREATE TABLE Name2Id(user_name TEXT, is_session INTEGER)');
    db.prepare('INSERT INTO Name2Id(rowid,user_name,is_session) VALUES(?,?,1)').run(7, alpha);
    db.prepare('INSERT INTO Name2Id(rowid,user_name,is_session) VALUES(?,?,1)').run(8, beta);
    db.exec("WITH RECURSIVE ids(n) AS (VALUES(100) UNION ALL SELECT n+1 FROM ids WHERE n<6100) INSERT INTO Name2Id(rowid,user_name,is_session) SELECT n,'SYNTHETIC_UNSELECTED_SENDER',0 FROM ids");
    db.prepare('INSERT INTO Name2Id(rowid,user_name,is_session) VALUES(?,?,0)').run(10000, Buffer.from('SYNTHETIC_UNSELECTED_BLOB_SENDER'));
    for (const [id, sender] of [[2, 7], [3, 8], [4, 9]]) db.prepare('UPDATE ' + qi(tableName(alpha)) + ' SET real_sender_id=? WHERE local_id=?').run(sender, id);
    db.close();
    const { access } = factory(); await access.grant('session', grantFor(senderRoot, { fromTs: BASE_TS, toTs: BASE_TS + 10 }));
    const first = await access.query('session', { action: 'messages', talker: alpha, limit: 2 });
    const next = await access.query('session', { action: 'messages', talker: alpha, limit: 2, offset: 2 });
    const rows = [...first.rows, ...next.rows];
    assert.equal(first.hasMore, true); assert.equal(next.hasMore, false);
    assert.deepEqual(rows.map(row => [row.id, row.senderId, row.senderTalker, row.senderIsTalker]), [['4', '9', null, null], ['3', '8', beta, false], ['2', '7', alpha, true]]);
    const search = await access.query('session', { action: 'search', talker: alpha, query: 'Needle' });
    assert.deepEqual(search.rows.map(row => row.citation), rows.map(row => row.citation));
    assert.deepEqual(search.rows.map(row => [row.senderId, row.senderTalker, row.senderIsTalker]), rows.map(row => [row.senderId, row.senderTalker, row.senderIsTalker]));
    assert.equal(JSON.stringify(search).includes('SYNTHETIC_UNSELECTED'), false);
    const legacy = runArchiveQuery(directPayload(root, { action: 'messages', talker: alpha }));
    assert.ok(legacy.rows.every(row => row.senderId === null && row.senderTalker === null && row.senderIsTalker === null));
    const missingRoot = fixture('sender-missing-name2id');
    const missing = new DatabaseSync(join(missingRoot, 'message/message0.db'));
    missing.exec('ALTER TABLE ' + qi(tableName(alpha)) + ' ADD COLUMN real_sender_id INTEGER');
    missing.prepare('UPDATE ' + qi(tableName(alpha)) + ' SET real_sender_id=7').run(); missing.close();
    const unmapped = runArchiveQuery(directPayload(missingRoot, { action: 'messages', talker: alpha }));
    assert.ok(unmapped.rows.every(row => row.senderId === '7' && row.senderTalker === null && row.senderIsTalker === null));
  });
  await check('sparse text searches count scanned candidates before decoding and retain date filters', async () => {
    const candidateRoot = fixture('sparse-search-budget');
    const db = new DatabaseSync(join(candidateRoot, 'message/message0.db'));
    const insert = db.prepare('INSERT INTO ' + qi(tableName(alpha)) + ' VALUES(?,?,?,1)');
    db.exec('BEGIN');
    for (let i = 0; i < 5001; i++) insert.run(100 + i, BASE_TS - 100, 'SYNTHETIC_NONMATCHING_HISTORY');
    db.exec('COMMIT'); db.close();
    const { access } = factory(); await access.grant('session', grantFor(candidateRoot));
    await rejects(() => access.query('session', { action: 'search', talker: alpha, query: 'Needle' }), 'row-budget-exceeded');
    assert.equal(access.getState('session').granted, true);
    const scoped = await access.query('session', { action: 'search', talker: alpha, query: 'Needle', fromTs: BASE_TS, toTs: BASE_TS + 10 });
    assert.equal(scoped.returned, 3); assert.equal(scoped.hasMore, false);
    assert.ok(scoped.rows.every(row => row.talker === alpha && row.ts >= BASE_TS && row.ts <= BASE_TS + 10));
  });
  await check('zstd message content supports bounded messages and search with record references', async () => {
    const compressed = fixture('zstd-content');
    const content = '高伟确认：周五交付合同，预算为三万元。';
    const db = new DatabaseSync(join(compressed, 'message/message0.db'));
    db.prepare('UPDATE ' + qi(tableName(alpha)) + ' SET message_content=? WHERE local_id=2').run(zstdCompressSync(Buffer.from(content)));
    db.close();
    const access = factory(['session']).access; await access.grant('session', grantFor(compressed));
    const page = await access.query('session', { action: 'messages', talker: alpha });
    assert.equal(page.rows.find(row => row.id === '2').content, content);
    const found = await access.query('session', { action: 'search', talker: alpha, query: '合同' });
    assert.equal(found.rows.length, 1);
    assert.equal(found.rows[0].content, content);
    assert.deepEqual(found.rows[0].citation, page.rows.find(row => row.id === '2').citation);
    const broken = fixture('zstd-truncated');
    const invalid = new DatabaseSync(join(broken, 'message/message0.db'));
    invalid.prepare('UPDATE ' + qi(tableName(alpha)) + ' SET message_content=? WHERE local_id=2').run(zstdCompressSync(Buffer.from(content)).subarray(0, 8));
    invalid.close();
    const damaged = factory(['session']).access; await damaged.grant('session', grantFor(broken));
    await rejects(() => damaged.query('session', { action: 'messages', talker: alpha }), 'unsupported-content');
  });
  await check('one contact remains queryable when other contacts exceed the table enumeration budget', async () => {
    const large = fixture('many-contact-tables');
    const db = new DatabaseSync(join(large, 'message/message0.db'));
    Array.from({ length: ARCHIVE_ACCESS_LIMITS.maxTables + 1 }, (_, i) => i).forEach(i =>
      db.exec('CREATE TABLE ' + qi(tableName('unrelated-' + i)) + '(id INTEGER, content TEXT)'));
    db.close();
    const access = factory(['session']).access; await access.grant('session', grantFor(large));
    const page = await access.query('session', { action: 'messages', talker: alpha, fromTs: BASE_TS, toTs: BASE_TS + 10 });
    assert.equal(page.rows.length, 3);
    assert.ok(page.rows.every(row => row.talker === alpha));
  });
  await check('all-conversation search supports only completely mapped fixed tables', async () => {
    const allRoot = fixture('all', { betaText: true }), { access } = factory(); await access.grant('session', grantFor(allRoot, { allConversations: true, talkers: [] }));
    const page = await access.query('session', { action: 'search', query: 'Needle' }); assert.equal(page.rows.length, 4); assert.ok(page.rows.some(r => r.talker === beta));
    const unknown = fixture('unknown-table', { betaText: true }); const db = new DatabaseSync(join(unknown, 'message/message0.db')); db.exec('CREATE TABLE Msg_not_a_hash(id INTEGER, content TEXT)'); db.close();
    const narrow = factory(['narrow', 'all']).access; await narrow.grant('narrow', grantFor(unknown)); assert.equal((await narrow.query('narrow', { action: 'search', query: 'needle' })).rows.length, 3);
    await narrow.grant('all', grantFor(unknown, { allConversations: true, talkers: [] })); await rejects(() => narrow.query('all', { action: 'search', query: 'needle' }), 'unsupported-schema');
    const retained = fixture('retained-conversation', { betaText: true }), retainedDb = new DatabaseSync(join(retained, 'message/message0.db'));
    retainedDb.exec('CREATE TABLE Name2Id(user_name TEXT, is_session INTEGER); CREATE TABLE ' + qi(tableName('retained-only'))
      + '(local_id INTEGER, create_time INTEGER, message_content TEXT, local_type INTEGER)');
    retainedDb.prepare('INSERT INTO Name2Id VALUES(?,1)').run('retained-only');
    retainedDb.prepare('INSERT INTO ' + qi(tableName('retained-only')) + ' VALUES(?,?,?,1)').run(8, BASE_TS + 5, 'Needle retained'); retainedDb.close();
    await access.grant('retained', grantFor(retained, { allConversations: true, talkers: [] }));
    const retainedPage = await access.query('retained', { action: 'search', query: 'needle' });
    assert.equal(retainedPage.rows.length, 5); assert.equal(retainedPage.rows.find(row => row.talker === 'retained-only').content, 'Needle retained');
  });
  await check('actual read-row and global-contact budgets stop before oversized results', async () => {
    assert.throws(() => runArchiveQuery(directPayload(root, { action: 'messages', talker: alpha }, {}, { maxReadRows: 1 })), error => error.code === 'row-budget-exceeded');
    const many = fixture('many-rows', { betaText: true }), users = [];
    let db = new DatabaseSync(join(many, 'message/message0.db')); db.exec('BEGIN');
    for (let i = 0; i < 64; i++) { const user = 'scope-user-' + i; users.push(user); db.exec('CREATE TABLE ' + qi(tableName(user)) + '(local_id INTEGER, create_time INTEGER, message_content TEXT, local_type INTEGER)');
      const insert = db.prepare('INSERT INTO ' + qi(tableName(user)) + ' VALUES(?,?,?,1)'); for (let j = 0; j < 100; j++) insert.run(j, BASE_TS + j, 'Needle'); }
    db.exec('COMMIT'); db.close(); const { access } = factory(); await access.grant('session', grantFor(many, { talkers: users }));
    await rejects(() => access.query('session', { action: 'search', query: 'needle', limit: 100 }), 'row-budget-exceeded');
    const people = fixture('many-contacts', { betaText: true }); db = new DatabaseSync(join(people, 'contact/contact.db')); db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO contact VALUES(?,?,?,?)'); for (let i = 0; i < 129; i++) insert.run('many-' + i, 'fixture', '', ''); db.exec('COMMIT'); db.close();
    const all = factory(['all']).access; await all.grant('all', grantFor(people, { allConversations: true, talkers: [] }));
    const page = await all.query('all', { action: 'search', query: 'needle' });
    assert.equal(page.rows.length, 4);
    await rejects(() => all.grant('selected-overflow', grantFor(people, { talkers: Array.from({ length: 129 }, (_, i) => 'selected-' + i) })), 'invalid-request');
    db = new DatabaseSync(join(people, 'contact/contact.db')); db.exec('BEGIN');
    const extend = db.prepare('INSERT INTO contact VALUES(?,?,?,?)');
    for (let i = 129; i < 3886; i++) extend.run('extra-' + i, '', '', '');
    db.exec('COMMIT'); db.close();
    await all.grant('all', grantFor(people, { allConversations: true, talkers: [] }));
    assert.equal((await all.query('all', { action: 'search', query: 'needle' })).rows.length, 4);
    // Contact rows without a message table cannot produce a result, so the
    // identity read no longer scales with the address book. Its bound is now
    // structural — maxFiles message databases times maxTables tables each —
    // which stays below maxReadRows, so an oversized contact table is no
    // longer a runtime failure but an unreachable one. The property that
    // still has to hold is that the real conversations remain readable.
    db = new DatabaseSync(join(people, 'contact/contact.db')); db.exec('BEGIN');
    const overflow = db.prepare('INSERT INTO contact VALUES(?,?,?,?)');
    for (let i = 3886; i < ARCHIVE_ACCESS_LIMITS.maxReadRows; i++) overflow.run('extra-' + i, '', '', '');
    db.exec('COMMIT'); db.close();
    await all.grant('all', grantFor(people, { allConversations: true, talkers: [] }));
    assert.equal((await all.query('all', { action: 'search', query: 'needle' })).rows.length, 4);
    assert.ok(ARCHIVE_ACCESS_LIMITS.maxFiles * ARCHIVE_ACCESS_LIMITS.maxTables < ARCHIVE_ACCESS_LIMITS.maxReadRows,
      'the identity read is bounded by message databases and tables, which must stay below the row budget');
    // A page must not pay for the address book on every read. The identity
    // read used to select the whole contact table, so a padded address book
    // spent the row budget before the page was read and a day spanning
    // several pages failed partway through. Reading the same page twice must
    // therefore cost the same and stay well inside the budget no matter how
    // many contact rows exist.
    const wide = fixture('wide-address-book', { betaText: true });
    db = new DatabaseSync(join(wide, 'contact/contact.db')); db.exec('BEGIN');
    const pad = db.prepare('INSERT INTO contact VALUES(?,?,?,?)');
    for (let i = 0; i < 3800; i++) pad.run('pad-' + i, '', '', '');
    db.exec('COMMIT'); db.close();
    const wideAccess = factory(['wide']).access; await wideAccess.grant('wide', grantFor(wide, { allConversations: true, talkers: [] }));
    const widePage = await wideAccess.query('wide', { action: 'search', query: 'needle', limit: 20, offset: 0 });
    assert.equal(widePage.rows.length, 4, 'a padded address book must not change which conversations are readable');
    // Same query against an archive whose address book is small: the page is
    // identical, so the address book no longer scales the read.
    const narrow = fixture('narrow-address-book', { betaText: true });
    const narrowAccess = factory(['narrow']).access; await narrowAccess.grant('narrow', grantFor(narrow, { allConversations: true, talkers: [] }));
    const narrowPage = await narrowAccess.query('narrow', { action: 'search', query: 'needle', limit: 20, offset: 0 });
    assert.deepEqual(widePage.rows.map(row => row.talker), narrowPage.rows.map(row => row.talker));
  });
  const heavy = fixture('heavy', { betaText: true });
  {
    const db = new DatabaseSync(join(heavy, 'message/message0.db')); db.exec('DELETE FROM ' + qi(tableName(alpha)) + '; BEGIN');
    const insert = db.prepare('INSERT INTO ' + qi(tableName(alpha)) + ' VALUES(?,?,?,1)'), content = 'a'.repeat(8000000);
    for (let i = 0; i < 4; i++) insert.run(i, BASE_TS + i, content); db.exec('COMMIT'); db.close();
  }
  const slowQuery = { action: 'search', talker: alpha, query: 'a'.repeat(511) + 'b' };
  await check('real synchronous SQLite CPU query is SIGKILLed by wall deadline', async () => {
    const { access } = factory(['timeout'], { queryTimeoutMs: 250 }); await access.grant('timeout', grantFor(heavy));
    const before = forks.length, start = performance.now(); await rejects(() => access.query('timeout', slowQuery), 'timeout');
    const item = forks[before]; assert.equal(item.ready, true); assert.equal(item.closed, true); assert.equal(item.exitSignal, 'SIGKILL');
    const elapsedMs = performance.now() - start; assert.ok(elapsedMs < 2000); assert.equal(access.getState('timeout').activeQueries, 0);
    timings.push({ kind: 'timeout', deadlineMs: 250, elapsedMs: Number(elapsedMs.toFixed(1)), exitSignal: item.exitSignal });
  });
  await check('AbortSignal, revoke and dispose kill and drain the real active child', async () => {
    for (const mode of ['abort', 'revoke', 'dispose']) {
      const { access } = factory([mode], { queryTimeoutMs: 5000 }); await access.grant(mode, grantFor(heavy));
      const controller = new AbortController(), before = forks.length, query = access.query(mode, slowQuery, controller.signal); query.catch(() => {});
      await Promise.resolve(); const item = forks[before]; await item.readyPromise;
      const start = performance.now();
      if (mode === 'abort') controller.abort(); else if (mode === 'revoke') access.revoke(mode); else await access.dispose();
      await rejects(() => query, mode === 'abort' ? 'aborted' : mode === 'revoke' ? 'revoked' : 'disposed');
      const elapsedMs = performance.now() - start; assert.equal(item.closed, true); assert.equal(item.exitSignal, 'SIGKILL'); assert.ok(elapsedMs < 2000);
      timings.push({ kind: mode, elapsedMs: Number(elapsedMs.toFixed(1)), exitSignal: item.exitSignal });
      assert.equal(access.getState(mode).activeQueries, 0); assert.equal(access.getState(mode).sessionMayContainArchiveData, true);
    }
  });
  await check('grant identity changes cancel the old query and do not inherit its scope', async () => {
    const { access } = factory(['switch'], { queryTimeoutMs: 5000 }); await access.grant('switch', grantFor(heavy));
    const before = forks.length, query = access.query('switch', slowQuery); query.catch(() => {}); await Promise.resolve(); await forks[before].readyPromise;
    await access.grant('switch', grantFor(root, { talkers: [evil] })); await rejects(() => query, 'revoked');
    assert.deepEqual(access.getState('switch').talkers, [evil]); assert.equal(access.getState('switch').sessionMayContainArchiveData, true);
    await rejects(() => access.query('switch', { action: 'messages', talker: alpha }), 'scope-forbidden');
  });
  await check('root is private IPC only; worker path, argv and environment are fixed', async () => {
    for (const item of forks) {
      assert.equal(item.path, resolve(import.meta.dirname, '../lib/archive-query-worker.js')); assert.deepEqual(item.args, []);
      assert.deepEqual(item.options.env, { LANG: 'C', TZ: 'UTC' }); assert.deepEqual(item.options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
      assert.deepEqual(item.options.execArgv, ['--max-old-space-size=64', '--disable-proto=throw', '--no-warnings']);
      assert.equal(item.options.shell, undefined); assert.equal(JSON.stringify(item.options).includes(base), false);
      for (const payload of item.payloads) { assert.ok(payload.root.startsWith(base + '/')); assert.equal(payload.root.startsWith(ORIGINAL), false); }
    }
    assert.equal(originalAccesses, 0);
  });
  console.log(JSON.stringify({ passed, originalAccesses, children: forks.length, sigkillChildren: forks.filter(item => item.exitSignal === 'SIGKILL').length, timings, byteMetrics }));
} finally {
  await Promise.allSettled(factories.map(access => access.dispose()));
  for (const item of forks) if (!item.closed) await new Promise(done => item.child.once('close', done));
  for (const [name, value] of originalFs) fs[name] = value;
  childProcess.fork = originalFork; syncBuiltinESMExports();
  // The exact mkdtemp result is checked before deleting only this test's temporary tree.
  assert.ok(base.startsWith('/tmp/wechat-native-access-test-') && base !== '/tmp' && resolve(base) === base);
  fs.rmSync(base, { recursive: true, force: true });
}
