import { homedir as desktopHome } from 'node:os';
import { resolve as desktopPath } from 'node:path';
// Disabled/unconfigured deployment regression. No fixture, SQLite database,
// WeChat process, keys or network is used. Source-root strings are inert data.
// Static module loading finishes BEFORE the synthetic IO denial probes start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import * as wire from '../lib/wire.js';
import * as methods from '../lib/methods.js';
import * as controller from '../lib/controller.js';
import * as plugin from '../lib/index.js';
import { buildExport } from '../lib/export.js';
import { TYPERT } from '../lib/typert.host.js';
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js';

// This is only an adversarial STRING: no operation may resolve/access it.
const informationalSource = desktopPath(desktopHome(), 'Documents/xwechat_files');
const explicitSnapshot = '/synthetic/never-opened/decrypted-snapshot';
const disabledError = /快照读取已禁用.*snapshotEnabled=false/;
const missingError = /独立解密快照尚未配置/;
const results = [];
const io = { fs: [], sqlite: [], crypto: [], host: [] };
const restore = [];
const environment = process.env.WECHAT_SNAPSHOT_DIR;
const originalBuiltin = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule');

function deny(target, key, kind) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.writable) return;
  const trip = () => {
    io[kind].push(String(key));
    throw new Error('UNEXPECTED_SYNTHETIC_' + kind.toUpperCase() + '_IO:' + String(key));
  };
  if (Object.hasOwn(descriptor.value, 'native')) trip.native = trip;
  Object.defineProperty(target, key, { ...descriptor, value: trip });
  restore.push(() => Object.defineProperty(target, key, descriptor));
}

// Block sync, callback and promise filesystem operations, including every
// named import used by snapshot.js. No denial delegates to a real operation.
const promises = fs.promises;
for (const target of [fs, promises]) {
  for (const key of Object.keys(target)) {
    if (/^[a-z]/.test(key)) deny(target, key, 'fs');
  }
}
for (const key of ['createHash', 'createHmac', 'createDecipheriv', 'createDecipher']) deny(crypto, key, 'crypto');
syncBuiltinESMExports();
process.getBuiltinModule = (name) => {
  if (name === 'node:sqlite') {
    io.sqlite.push('import');
    throw new Error('UNEXPECTED_SYNTHETIC_SQLITE_IMPORT');
  }
  return originalBuiltin?.value?.call(process, name);
};
const sqliteProbe = new Proxy({}, {
  get(_target, key) {
    io.sqlite.push(String(key));
    throw new Error('UNEXPECTED_SYNTHETIC_SQLITE_ACCESS:' + String(key));
  },
});
function hostTrip(key) {
  io.host.push(key);
  throw new Error('UNEXPECTED_SYNTHETIC_HOST_IO:' + key);
}
function setup(config) {
  const commands = [];
  const tools = [];
  const ctx = {
    fs: new Proxy({}, { get(_target, key) { return hostTrip('fs.' + String(key)); } }),
    workingDirectory: { ensure() { return hostTrip('workingDirectory.ensure'); } },
    get() { return hostTrip('policy.resolve'); },
    commands: { register(definition) { commands.push(definition); return () => {}; } },
    tools: { register(definition) { tools.push(definition); return () => {}; } },
    effect(fn) { return fn(); },
  };
  plugin.apply(ctx, config);
  assert.equal(commands.length, 1, 'exactly the original command is registered');
  assert.equal(tools.length, 1, 'exactly the original export tool is registered');
  assert.equal(tools[0].name, wire.EXPORT_TOOL);
  const agent = { session: { id: 'synthetic-unconfigured-only' } };
  return {
    tools,
    execute: (args = {}, signal = new AbortController().signal) => tools[0].execute(args, { agent, signal }),
    command: (rawInput = '', signal = new AbortController().signal) => commands[0].handler({ agent, signal, rawInput, attachments: [] }),
  };
}
function assertUnconfigured(value, enabled, source = '') {
  assert.equal(value.ok, false);
  assert.equal(value.configured, false);
  assert.equal(value.snapshot_enabled, enabled);
  assert.equal(value.source_root, source);
  for (const key of ['root', 'snapshot_time', 'read_at']) assert.equal(value[key], '', key);
  for (const key of ['captured_at', 'snapshot_id', 'capture_complete', 'capture_consistency', 'contact_table', 'session_table', 'contact_rows', 'session_rows', 'message_db_count', 'message_table_count', 'indexed_message_table_count']) assert.equal(value[key], null, key + ' is unknown');
  assert.equal(value.db_count, 0, 'zero loaded descriptors, not an observed empty database');
  assert.deepEqual(value.dbs, []);
  assert.equal(value.scan_complete, false);
  assert.equal(value.message_table_count_is_exact, false);
  assert.match(value.notes.join('\n'), /未访问任何快照文件或数据库/);
  assert.match(value.notes.join('\n'), /数量均未知，不代表空库/);
  assert.match(value.notes.join('\n'), /source_root 仅为来源说明字符串/);
  assert.doesNotThrow(() => JSON.stringify(value));
}
async function test(id, fn) {
  try {
    await fn();
    results.push({ id, passed: true });
    console.log('PASS ' + id);
  } catch (error) {
    results.push({ id, passed: false });
    console.error('FAIL ' + id + '\n' + (error.stack || error));
    process.exitCode = 1;
  }
}

try {
  await test('U01 legacy explicit/fallback configuration stays lazy and compatible', () => {
    assert.deepEqual(wire.normalizeConfig(undefined), { snapshotDir: '', snapshotEnabled: true, sourceRoot: '', maxRows: 500 });
    assert.deepEqual(wire.normalizeConfig(undefined, explicitSnapshot), { snapshotDir: explicitSnapshot, snapshotEnabled: true, sourceRoot: '', maxRows: 500 });
    const config = wire.normalizeConfig({ snapshotDir: explicitSnapshot, sourceRoot: informationalSource, maxRows: 7 }, '/synthetic/unused-fallback');
    assert.equal(config.snapshotDir, explicitSnapshot);
    const store = methods.createContext({ ...config, sqlite: sqliteProbe });
    assert.equal(store.configured, true);
    assert.equal(store.snapshotEnabled, true);
    assert.equal(store.sourceRoot, informationalSource);
    assert.equal(store.maxRows, 7);
    store.requireConfigured(); // pure check only; never open the configured path
  });
  await test('U02 new configuration fields reject coercion without IO', () => {
    for (const snapshotEnabled of [null, 0, 1, '', 'false', 'true', {}, []]) assert.throws(() => wire.normalizeConfig({ snapshotEnabled }), /snapshotEnabled must be a boolean/);
    for (const sourceRoot of [null, 0, true, {}, []]) assert.throws(() => wire.normalizeConfig({ sourceRoot }), /sourceRoot must be a string/);
    for (const snapshotDir of ['', '   ', 1, null]) assert.throws(() => wire.normalizeConfig({ snapshotEnabled: false, snapshotDir }), /snapshotDir must be a non-empty path/);
    assert.equal(wire.normalizeConfig({ snapshotEnabled: false, sourceRoot: '' }).sourceRoot, '');
  });
  await test('U03 explicit disablement defeats both ambient env and explicit snapshot paths', () => {
    process.env.WECHAT_SNAPSHOT_DIR = informationalSource;
    const config = wire.normalizeConfig({ snapshotEnabled: false, snapshotDir: explicitSnapshot, sourceRoot: informationalSource }, process.env.WECHAT_SNAPSHOT_DIR);
    assert.deepEqual(config, { snapshotDir: '', snapshotEnabled: false, sourceRoot: informationalSource, maxRows: 500 });
    const store = methods.createContext({ ...config, snapshotDir: explicitSnapshot, sqlite: sqliteProbe });
    assert.equal(store.root, '');
    assert.equal(store.configured, false);
    assert.throws(() => store.snap(), disabledError);
    assertUnconfigured(methods.status(store), false, informationalSource);
  });
  await test('U04 omitted, empty and blank context paths never inspect cwd manifest', () => {
    for (const options of [undefined, {}, { snapshotDir: '' }, { snapshotDir: '   ' }, { sourceRoot: informationalSource }]) {
      const store = methods.createContext(options);
      assertUnconfigured(methods.status(store), true, options?.sourceRoot || '');
      assert.throws(() => store.snap(), missingError);
    }
  });
  const disabled = methods.createContext({ snapshotEnabled: false, snapshotDir: explicitSnapshot, sourceRoot: informationalSource, sqlite: sqliteProbe });
  const missing = methods.createContext({ sourceRoot: informationalSource, sqlite: sqliteProbe });
  await test('U05 all seven query methods and legacy dispatch reject before SQLite/fs', () => {
    const args = { session: 'synthetic-session', query: 'SELECT 1', room: 'synthetic-room', database: 'synthetic.db' };
    for (const [store, expected] of [[disabled, disabledError], [missing, missingError]]) {
      for (const method of ['contacts', 'sessions', 'messages', 'searchMessages', 'timeline', 'chatroomMembers', 'sql']) assert.throws(() => methods[method](store, args), expected, method);
      for (const method of methods.METHOD_NAMES.filter((name) => name !== 'status')) {
        const result = methods.callMethod(store, method, args);
        assert.equal(result.ok, false, method);
        assert.match(result.error, expected);
      }
      assertUnconfigured(methods.callMethod(store, 'status'), store.snapshotEnabled, informationalSource);
    }
  });
  await test('U06 every in-memory export format/scope rejects unconfigured sources', () => {
    for (const [store, expected] of [[disabled, disabledError], [missing, missingError]]) {
      for (const format of ['md', 'json', 'txt', 'agents']) {
        for (const scope of ['library', 'sessions', 'timeline', 'contacts']) assert.throws(() => buildExport(store, { format, scope }), expected, format + '/' + scope);
      }
    }
  });
  await test('U07 all nine Remote methods retain markers and use guarded context', () => {
    const service = new controller.WechatRoService(new Context(), { snapshotEnabled: false, sourceRoot: informationalSource });
    assert.equal(service.snapshotDir, '');
    assert.equal(service.snapshotEnabled, false);
    assert.equal(service.sourceRoot, informationalSource);
    assertUnconfigured(service.status(), false, informationalSource);
    for (const method of wire.METHOD_NAMES.filter((name) => name !== 'status')) assert.throws(() => service[method]({}), disabledError, method);
    const markers = controller.WechatRoService.prototype[controller.REMOTE_METHOD_DESCRIPTOR];
    assert.equal(markers.version, 1);
    assert.deepEqual(markers.methods.map((item) => item.method), wire.METHOD_NAMES);
    assert.equal(wire.METHOD_NAMES.length, 9);
    assert.ok(markers.methods.every((item) => item.invocation.kind === 'direct'));
  });
  await test('U08 old runtimes without node:sqlite still report safe not-ready status', () => {
    const guardedBuiltin = process.getBuiltinModule;
    process.getBuiltinModule = undefined;
    try {
      assertUnconfigured(methods.status(methods.createContext()), true);
      assertUnconfigured(methods.status(disabled), false, informationalSource);
      assert.throws(() => methods.contacts(missing, {}), missingError);
    } finally { process.getBuiltinModule = guardedBuiltin; }
  });
  await test('U09 wire/host/remote status codecs retain additive safety metadata', () => {
    const spec = wire.METHOD_SPECS.find((item) => item.method === 'status');
    const descriptors = [wire.descriptorFor(spec), TYPERT.invocations.find((item) => item.method === 'status'), TYPERT_REMOTE.descriptors.find((item) => item.method === 'status')];
    for (const value of [methods.status(disabled), methods.status(missing)]) {
      for (const descriptor of descriptors) assert.deepEqual(descriptor.result.create().parse(value), value);
    }
    assert.equal(TYPERT.invocations.length, 11);
    assert.equal(TYPERT_REMOTE.descriptors.length, 11);
    for (const descriptors of [TYPERT.invocations, TYPERT_REMOTE.descriptors]) {
      assert.deepEqual(descriptors.filter(item => item.namespace === wire.NAMESPACE).map(item => item.method), wire.METHOD_NAMES);
      assert.deepEqual(descriptors.filter(item => item.namespace === 'wechatConversation').map(item => item.method), ['getConversationState', 'conversationAction']);
    }
  });
  await test('U10 Host export tool/command defeat ambient env before workspace/policy/fs', async () => {
    process.env.WECHAT_SNAPSHOT_DIR = informationalSource;
    for (const config of [{ snapshotEnabled: false, sourceRoot: informationalSource }, { snapshotEnabled: false, snapshotDir: explicitSnapshot, sourceRoot: informationalSource }]) {
      const host = setup(config);
      await assert.rejects(host.execute(), disabledError);
      const command = await host.command('json contacts 1');
      assert.equal(command.kind, 'error');
      assert.match(command.text, disabledError);
      assert.equal((await host.command('help')).kind, 'success');
    }
  });
  await test('U11 Host entrypoints with no snapshot refuse instead of defaulting to cwd', async () => {
    delete process.env.WECHAT_SNAPSHOT_DIR;
    for (const config of [undefined, {}, { sourceRoot: informationalSource }]) {
      const host = setup(config);
      await assert.rejects(host.execute({ format: 'json', scope: 'contacts' }), missingError);
      const command = await host.command();
      assert.equal(command.kind, 'error');
      assert.match(command.text, missingError);
    }
  });
  await test('U12 cancellation and missing Session still precede export work', async () => {
    const service = Object.assign(Object.create(controller.WechatRoService.prototype), { store: disabled });
    const abort = new AbortController();
    abort.abort(new Error('SYNTHETIC_ABORT_BEFORE_SNAPSHOT'));
    for (const method of wire.METHOD_NAMES) assert.throws(() => service[method]({}, abort.signal), /SYNTHETIC_ABORT_BEFORE_SNAPSHOT/);
    const host = setup({ snapshotEnabled: false });
    await assert.rejects(host.execute({}, abort.signal), /SYNTHETIC_ABORT_BEFORE_SNAPSHOT/);
    const command = await host.command('', abort.signal);
    assert.equal(command.kind, 'error');
    assert.match(command.text, /SYNTHETIC_ABORT_BEFORE_SNAPSHOT/);
    await assert.rejects(host.tools[0].execute({}), /requires an agent Session/);
  });
  await test('U13 disabled and unconfigured scenarios attempted zero IO/hash/decrypt', () => {
    assert.deepEqual(io, { fs: [], sqlite: [], crypto: [], host: [] });
  });
} finally {
  if (environment === undefined) delete process.env.WECHAT_SNAPSHOT_DIR;
  else process.env.WECHAT_SNAPSHOT_DIR = environment;
  if (originalBuiltin) Object.defineProperty(process, 'getBuiltinModule', originalBuiltin);
  else delete process.getBuiltinModule;
  for (const undo of restore.reverse()) undo();
  syncBuiltinESMExports();
}
console.log(JSON.stringify({ cases: results.length, failures: results.filter((item) => !item.passed).length, io_attempts: Object.fromEntries(Object.entries(io).map(([key, value]) => [key, value.length])) }));
