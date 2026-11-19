// Offline contract tests: actual public SDK helpers, injected DSH service doubles.
// No real agent loop/model call, credential backend, network or WeChat file is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { WEIXIN_DSH_INFO, WeixinDshError, createWeixinCredentialStore, createWeixinSessionCredentialStore,
  createDshWeixinReply, createDshWeixinChannel } from '../lib/weixin-dsh.js';

const SOURCE = 'wechat-ro-weixin';
const CREDENTIALS = { botToken: 'synthetic-token', botId: 'bot-1', userId: 'user-1', baseUrl: 'https://ilinkai.weixin.qq.com' };
const state = (revision = 1, more = {}) => ({ version: 1, revision, credentials: { ...CREDENTIALS }, cursor: '', seenMessageIds: [], pending: null, ...more });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function errorCode(code) {
  return error => {
    assert.ok(error instanceof WeixinDshError);
    assert.equal(error.code, code);
    assert.equal(Object.isFrozen(error), true);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(error.message.includes('SYNTHETIC_PRIVATE'), false);
    return true;
  };
}
function memoryCredentials(initial) {
  let record = initial;
  let tail = Promise.resolve();
  const calls = [];
  const service = {
    async readRecord(key) { calls.push(['read', key]); return structuredClone(record); },
    modifyRecord(key, mutate) {
      calls.push(['modify', key]);
      const result = tail.then(async () => {
        const next = await mutate(structuredClone(record));
        if (next !== undefined) record = structuredClone(next);
        return structuredClone(record);
      });
      tail = result.catch(() => {});
      return result;
    },
    deleteRecord() { throw new Error('deleteRecord must never be used'); },
  };
  return { service, calls, record: () => structuredClone(record) };
}

function fakeHost(config = {}) {
  const handles = [], calls = { created: 0, disposed: 0, cancelled: 0, rollbacks: 0, toolBodies: 0 };
  const serviceOwners = new WeakMap();
  const ctx = {
    tools: { restrict() { throw new Error('root restriction forbidden'); }, guard() { throw new Error('root guard forbidden'); } },
    workingDirectory: { ensure(agent, signal) { return serviceOwners.get(agent.session).workingDirectory.ensure(agent, signal); } },
    sandboxPolicy: { resolve(request) { return serviceOwners.get(request.session).sandboxPolicy.resolve(request); } },
    fs: {
      async resolve(path, options) {
        assert.equal(path, '/synthetic-workspace');
        assert.ok(options.signal instanceof AbortSignal);
        if (config.resolveGate) await config.resolveGate.promise;
        if (config.resolveError) throw new Error('SYNTHETIC_PRIVATE filesystem failure');
        return { targetKey: 'opaque-target', displayPath: '/synthetic-workspace' };
      },
      async stat(target, signal) { assert.equal(target.targetKey, 'opaque-target'); assert.ok(signal instanceof AbortSignal); return config.absent ? undefined : { type: 'directory', version: 'synthetic-version' }; },
      processPath() { return '/synthetic-workspace'; },
    },
    agents: {
      async create(options) {
        calls.created++;
        assert.equal(typeof options.sessionId, 'string');
        assert.match(options.sessionId, /^[0-9a-f-]{36}$/u);
        assert.deepEqual(options.meta, { cwd: '/synthetic-workspace' });
        assert.ok(options.signal instanceof AbortSignal);
        const listeners = [];
        let mode, idle = Promise.resolve();
        const session = { id: options.sessionId, header: options.meta, append(type, data) { assert.equal(type, 'sandbox/mode'); mode = data.mode; } };
        const record = { session, message: null, guards: [], masks: [], closed: false, published: false, listenerCount: () => listeners.length };
        const emit = (type, data, forSession = session) => { for (const listener of listeners) listener(forSession, { type, data, seq: 0, time: 0 }); };
        record.emit = emit;
        const agentCtx = {
          tools: {
            restrict(mask) { assert.equal(record.published, false); record.masks.push(mask); return () => {}; },
            guard(fn) { assert.equal(record.published, false); record.guards.push(fn); return () => {}; },
          },
          workingDirectory: { async ensure(agent, signal) { assert.equal(agent.session, session); assert.equal(signal, options.signal); return config.changedCwd ? '/wrong-workspace' : '/synthetic-workspace'; } },
          sandboxPolicy: { resolve(request) { assert.equal(request.session, session); return { mode: config.badPolicy ? 'danger-full-access' : mode }; } },
          on(event, listener) { assert.equal(event, 'session/event'); assert.equal(record.published, false); listeners.push(listener); return () => {}; },
        };
        serviceOwners.set(session, { workingDirectory: agentCtx.workingDirectory, sandboxPolicy: agentCtx.sandboxPolicy });
        if (config.factoryOnlyInjectsNativeDeps) {
          for (const key of ['workingDirectory', 'sandboxPolicy']) Object.defineProperty(agentCtx, key, {
            get() { throw new Error('cannot get property "' + key + '" without inject'); },
          });
        }
        if (config.missingGuard) delete agentCtx.tools.guard;
        const agent = {
          ctx: agentCtx, session, status: 'idle',
          followup(message) {
            assert.equal(record.published, true);
            assert.deepEqual(record.masks, [{ allow: [] }]);
            assert.equal(mode, 'read-only');
            assert.ok(record.guards.every(fn => typeof fn({}) === 'string'));
            assert.ok(Object.isFrozen(message));
            assert.deepEqual(message.source, { kind: SOURCE, messageId: '1' });
            record.message = message;
            if (config.idleGate) { idle = config.idleGate.promise; return; }
            idle = Promise.resolve().then(() => {
              if (config.driverError) throw new Error('SYNTHETIC_PRIVATE driver failure');
              emit('turn/start', { turn: 99 }, {}); // another session must be ignored
              emit('assistant/message', { turn: 99, message: { role: 'assistant', content: [{ type: 'text', text: 'wrong session' }] } }, {});
              emit('turn/start', { turn: 1 });
              if (!config.skipInput) emit('user/message', config.wrongInput ? { ...message, id: 'different-id' } : message);
              if (config.duplicateInput) emit('user/message', message);
              if (config.otherHuman) emit('user/message', { id: 'foreign-input', source: { kind: 'user' } });
              if (config.toolCall) {
                if (!record.guards.some(fn => fn({}))) calls.toolBodies++;
                emit('tool/call', { turn: 1, callId: 'synthetic-call', name: 'bash', arguments: '{}' });
              }
              emit('assistant/message', {
                turn: config.wrongTurn ? 2 : 1, step: 0, interrupted: config.interrupted,
                message: { role: 'assistant', content: config.blocks ?? [{ type: 'reasoning', text: 'SYNTHETIC_PRIVATE reasoning' }, { type: 'text', text: '合成回复' }] },
              });
              if (config.latest) emit('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '最终合成回复' }] } });
              if (!config.noEnd) emit('turn/end', { turn: 1, reason: { kind: config.reason ?? 'completed' } });
              if (config.extraTurn) { emit('turn/start', { turn: 2 }); emit('turn/end', { turn: 2, reason: { kind: 'completed' } }); }
            });
          },
          whenIdle() { return idle; },
          cancel(cause) { assert.equal(cause.kind, 'hook'); calls.cancelled++; if (config.cancelSettles) config.idleGate?.resolve(); },
        };
        record.agent = agent;
        try { const commit = await options.setup(agentCtx, agent); commit?.commit(); }
        catch (error) { calls.rollbacks++; listeners.length = 0; throw error; }
        record.published = true;
        handles.push(record);
        if (config.createGate) await config.createGate.promise;
        return { agent, async dispose() {
          calls.disposed++;
          if (config.cleanupGate) await config.cleanupGate.promise;
          record.closed = true;
          listeners.length = 0;
          if (config.cleanupError) throw new Error('SYNTHETIC_PRIVATE cleanup failure');
        } };
      },
    },
  };
  return { ctx, calls, handles };
}
const bridgeFor = (host, options = {}) => createDshWeixinReply(host.ctx, { workspace: '/synthetic-workspace', timeoutMs: 1000, ...options });
const replyOne = bridge => bridge.reply('合成输入', { messageId: '1' });

test('import/construction/default composition perform no I/O and remain disabled', async () => {
  const host = fakeHost();
  const disabled = createDshWeixinChannel(host.ctx);
  assert.equal((await disabled.channel.getStatus()).enabled, false);
  assert.equal((await disabled.channel.getStatus()).messagingVerified, false);
  assert.equal(host.calls.created, 0);
  await disabled.dispose();
  const bridge = createDshWeixinReply(host.ctx);
  await assert.rejects(replyOne(bridge), errorCode('not-configured'));
  assert.equal(host.calls.created, 0);
  assert.throws(() => createDshWeixinChannel(host.ctx, { enabled: true }), errorCode('not-configured'));
  assert.deepEqual(WEIXIN_DSH_INFO.sandboxMode, 'read-only');
});

test('strict options, workspace, budgets and inputs fail before I/O', async () => {
  const host = fakeHost();
  for (const options of [null, [], { workspace: 'relative' }, { workspace: '/bad\npath' }, { timeoutMs: 0 }, { timeoutMs: 300001 }, { timeoutMs: 1.2 }, { baseUrl: 'https://other.invalid' }]) {
    assert.throws(() => createDshWeixinReply(host.ctx, options), errorCode('invalid-options'));
  }
  for (const options of [{ enabled: 'yes' }, { sendMessage: true }]) assert.throws(() => createDshWeixinChannel(host.ctx, options), errorCode('invalid-options'));
  const bridge = bridgeFor(host);
  for (const text of ['', ' ', 42, '界'.repeat(1334), '\ud800']) await assert.rejects(bridge.reply(text, { messageId: '1' }), errorCode('invalid-input'));
  for (const metadata of [undefined, {}, { messageId: 1 }, { messageId: '0' }, { messageId: '9007199254740992' }, { messageId: '1', token: 'secret' }]) await assert.rejects(bridge.reply('test', metadata), errorCode('invalid-input'));
  await assert.rejects(bridge.reply('test', { messageId: '1' }, {}), errorCode('invalid-input'));
  assert.equal(host.calls.created, 0);
});

test('fixed owning grant, detached validation, serialized CAS and no deletion', async () => {
  const memory = memoryCredentials();
  const store = createWeixinCredentialStore(memory.service);
  assert.equal(memory.calls.length, 0);
  assert.equal(await store.read(), undefined);
  await store.commit(null, state());
  const read = await store.read();
  assert.ok(Object.isFrozen(read) && Object.isFrozen(read.credentials));
  const contested = await Promise.allSettled([store.commit(1, state(2, { cursor: 'next' })), store.commit(1, state(2, { cursor: 'other' }))]);
  assert.equal(contested.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(contested.find(x => x.status === 'rejected').reason.code, 'state-conflict');
  assert.ok(memory.calls.every(([, key]) => key === 'wechat-ro-weixin/account'));
  assert.equal(memory.record().kind, 'grant');
  await assert.rejects(store.commit(null, state()), errorCode('state-conflict'));
  await assert.rejects(store.commit(2, undefined), errorCode('invalid-state'));
  await assert.rejects(store.commit(2, state(4)), errorCode('state-conflict'));
  await assert.rejects(store.commit(-1, state()), errorCode('invalid-input'));
});

test('tombstone forget/re-pair keeps revisions monotone and rejects stale claims', async () => {
  const memory = memoryCredentials({ kind: 'grant', payload: state(1) });
  const store = createWeixinCredentialStore(memory.service);
  await store.commit(1, state(2, { credentials: null }));
  assert.equal((await store.read()).credentials, null);
  await store.commit(2, state(3));
  await assert.rejects(store.commit(1, state(2, { pending: { messageId: '1', clientId: '00000000-0000-4000-8000-000000000000' } })), errorCode('state-conflict'));
  assert.equal((await store.read()).revision, 3);
});

test('store validation and raw backend failures remain redacted', async () => {
  assert.throws(() => createWeixinCredentialStore({}), errorCode('not-configured'));
  for (const record of [{ kind: 'api-key', value: 'SYNTHETIC_PRIVATE' }, { kind: 'grant', payload: { token: 'SYNTHETIC_PRIVATE' } }]) {
    const store = createWeixinCredentialStore(memoryCredentials(record).service);
    await assert.rejects(store.read(), errorCode('invalid-state'));
    await assert.rejects(store.commit(null, state()), errorCode('invalid-state'));
  }
  const store = createWeixinCredentialStore({ async readRecord() { throw new Error('SYNTHETIC_PRIVATE'); }, async modifyRecord() { throw new Error('SYNTHETIC_PRIVATE'); } });
  await assert.rejects(store.read(), errorCode('storage-failed'));
  await assert.rejects(store.commit(null, state()), errorCode('storage-failed'));
});

test('fresh owned session, scoped guards, input identity and text-only completed reply', async () => {
  const host = fakeHost();
  const bridge = bridgeFor(host);
  assert.equal(await replyOne(bridge), '合成回复');
  assert.equal(await replyOne(bridge), '合成回复');
  assert.equal(host.calls.created, 2);
  assert.equal(host.calls.disposed, 2);
  assert.notEqual(host.handles[0].session.id, host.handles[1].session.id);
  assert.ok(host.handles.every(x => x.closed && x.listenerCount() === 0));
  assert.ok(host.handles.every(x => x.message.role === 'user' && Object.isFrozen(x.message.content)));
  await bridge.dispose();
  await bridge.dispose();
  await assert.rejects(replyOne(bridge), errorCode('disposed'));
});

test('latest settled step replaces prior text; reasoning never goes out', async () => {
  const host = fakeHost({ latest: true });
  assert.equal(await replyOne(bridgeFor(host)), '最终合成回复');
});

for (const [name, config, code] of [
  ['missing workspace', { absent: true }, 'invalid-workspace'],
  ['fallback workspace', { changedCwd: true }, 'invalid-workspace'],
  ['missing monotonic guard', { missingGuard: true }, 'not-configured'],
  ['wider session policy', { badPolicy: true }, 'not-configured'],
  ['missing input attribution', { skipInput: true }, 'turn-unattributed'],
  ['wrong input ID', { wrongInput: true }, 'turn-unattributed'],
  ['duplicate input event', { duplicateInput: true }, 'turn-unattributed'],
  ['other human in session', { otherHuman: true }, 'turn-unattributed'],
  ['extra turn', { extraTurn: true }, 'turn-unattributed'],
  ['interrupted assistant', { interrupted: true }, 'turn-unattributed'],
  ['tool call denied', { toolCall: true }, 'turn-unattributed'],
  ['non-text result', { blocks: [{ type: 'image' }] }, 'turn-unattributed'],
  ['unsafe text type', { blocks: [{ type: 'text', text: 42 }] }, 'turn-unattributed'],
  ['oversized UTF8 result', { blocks: [{ type: 'text', text: '界'.repeat(1334) }] }, 'turn-unattributed'],
  ['wrong assistant turn', { wrongTurn: true }, 'invalid-reply'],
  ['missing turn closer', { noEnd: true }, 'turn-incomplete'],
  ['reasoning-only response', { blocks: [{ type: 'reasoning', text: 'SYNTHETIC_PRIVATE' }] }, 'invalid-reply'],
  ['blank response', { blocks: [{ type: 'text', text: ' ' }] }, 'invalid-reply'],
  ['malformed unicode reply', { blocks: [{ type: 'text', text: '\ud800' }] }, 'invalid-reply'],
  ['filesystem failure', { resolveError: true }, 'dsh-failed'],
  ['driver failure', { driverError: true }, 'dsh-failed'],
  ['cleanup failure', { cleanupError: true }, 'cleanup-failed'],
]) test(name + ' fails closed', async () => {
  const host = fakeHost(config);
  await assert.rejects(replyOne(bridgeFor(host)), errorCode(code));
  assert.equal(host.calls.toolBodies, 0);
  assert.ok(host.handles.every(handle => handle.closed));
});
for (const reason of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked', 'unknown']) test('turn end ' + reason + ' is not success', async () => {
  const host = fakeHost({ reason });
  await assert.rejects(replyOne(bridgeFor(host)), errorCode('turn-incomplete'));
  assert.equal(host.calls.disposed, 1);
});

test('pre-aborted request does not create a session', async () => {
  const host = fakeHost(); const controller = new AbortController(); controller.abort();
  await assert.rejects(bridgeFor(host).reply('test', { messageId: '1' }, controller.signal), errorCode('aborted'));
  assert.equal(host.calls.created, 0);
});

test('abort before a slow resolver settles stays busy and never drives', async () => {
  const gate = deferred(); const host = fakeHost({ resolveGate: gate }); const bridge = bridgeFor(host);
  const controller = new AbortController(); const result = bridge.reply('test', { messageId: '1' }, controller.signal);
  await tick(); controller.abort();
  await assert.rejects(result, errorCode('aborted'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(replyOne(bridge), errorCode('busy'));
  gate.resolve(); await bridge.dispose();
  assert.equal(host.calls.created, 0);
});

test('late factory completion after abort is disposed without followup', async () => {
  const gate = deferred(); const host = fakeHost({ createGate: gate }); const bridge = bridgeFor(host);
  const controller = new AbortController(); const result = bridge.reply('test', { messageId: '1' }, controller.signal);
  await tick(); controller.abort(); await assert.rejects(result, errorCode('aborted'));
  await assert.rejects(replyOne(bridge), errorCode('busy'));
  gate.resolve(); await bridge.dispose();
  assert.equal(host.calls.created, 1); assert.equal(host.calls.disposed, 1);
  assert.equal(host.handles[0].message, null);
});

test('active cancellation and late rejection have no unhandled rejection or foreign cancellation', async () => {
  const gate = deferred(); const host = fakeHost({ idleGate: gate }); const bridge = bridgeFor(host);
  const controller = new AbortController(); const result = bridge.reply('test', { messageId: '1' }, controller.signal);
  await tick(); controller.abort(); await assert.rejects(result, errorCode('aborted'));
  assert.equal(host.calls.cancelled, 1);
  gate.reject(new Error('SYNTHETIC_PRIVATE late driver rejection'));
  await bridge.dispose();
  assert.equal(host.calls.disposed, 1);
});

test('timeout returns locally but keeps ignored work owned until cleanup', async () => {
  const gate = deferred(); const host = fakeHost({ idleGate: gate }); const bridge = bridgeFor(host, { timeoutMs: 10 });
  await assert.rejects(replyOne(bridge), errorCode('timeout'));
  assert.equal(host.calls.cancelled, 1);
  await assert.rejects(replyOne(bridge), errorCode('busy'));
  gate.resolve(); await bridge.dispose();
  assert.equal(host.calls.disposed, 1);
});

test('slow cleanup is bounded for callers but is still owned and drained', async () => {
  const gate = deferred(); const host = fakeHost({ cleanupGate: gate }); const bridge = bridgeFor(host, { timeoutMs: 10 });
  await assert.rejects(replyOne(bridge), errorCode('timeout'));
  await assert.rejects(replyOne(bridge), errorCode('busy'));
  assert.equal(host.calls.disposed, 1);
  gate.resolve(); await bridge.dispose();
  assert.ok(host.handles[0].closed);
});

test('factory scope need not inherit caller-owned cwd and policy services', async () => {
  const host = fakeHost({ factoryOnlyInjectsNativeDeps: true });
  const bridge = bridgeFor(host);
  try { assert.equal(await replyOne(bridge), '合成回复'); }
  finally { await bridge.dispose(); }
  assert.equal(host.calls.created, 1); assert.equal(host.calls.disposed, 1);
  assert.deepEqual(host.handles[0].masks, [{ allow: [] }]);
});

// These records belong only to this synthetic service double. No real grants
// are read/enumerated. The two sessions deliberately have the SAME credentials.
function sessionCredentials(initial = []) {
  const records = new Map(structuredClone(initial));
  const calls = [];
  let tail = Promise.resolve();
  const service = {
    async readRecord(key) { calls.push(['read', key]); return structuredClone(records.get(key)); },
    modifyRecord(key, mutate) {
      calls.push(['modify', key]);
      const work = tail.then(async () => {
        const next = await mutate(structuredClone(records.get(key)));
        if (next !== undefined) records.set(key, structuredClone(next));
        return structuredClone(records.get(key));
      });
      tail = work.catch(() => {});
      return work;
    },
  };
  return { service, calls, records };
}
const SESSION_A = 'wechat-native-ro-11111111-1111-4111-8111-111111111111';
const SESSION_B = 'wechat-native-ro-22222222-2222-4222-8222-222222222222';
const sessionKey = id => `wechat-ro-weixin/session-${createHash('sha256').update(id, 'utf8').digest('hex')}`;

test('fixed-session grant construction is inert, restart-stable and never adopts legacy or same-credential session state', async () => {
  const legacy = state(1, { cursor: 'legacy-cursor', seenMessageIds: ['legacy-message'] });
  const memory = sessionCredentials([['wechat-ro-weixin/account', { kind: 'grant', payload: legacy }]]);
  const a = createWeixinSessionCredentialStore(memory.service, SESSION_A);
  const b = createWeixinSessionCredentialStore(memory.service, SESSION_B);
  assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(b));
  assert.deepEqual(memory.calls, []);
  assert.equal(await a.read(), undefined); assert.equal(await b.read(), undefined);
  const pending = { messageId: 'message-a', clientId: 'stable-client-a' };
  await a.commit(null, state(1, { cursor: 'cursor-a', pending }));
  // A different native Session cannot restore A's claim even for this same account.
  assert.equal(await b.read(), undefined);
  await b.commit(null, state(1, { cursor: 'cursor-b' }));
  const restarted = createWeixinSessionCredentialStore(memory.service, SESSION_A);
  assert.deepEqual(await restarted.read(), state(1, { cursor: 'cursor-a', pending }));
  assert.deepEqual(await b.read(), state(1, { cursor: 'cursor-b' }));
  assert.ok(memory.calls.every(([, key]) => key === sessionKey(SESSION_A) || key === sessionKey(SESSION_B)));
  assert.notEqual(sessionKey(SESSION_A), sessionKey(SESSION_B));
  assert.deepEqual(await createWeixinCredentialStore(memory.service).read(), legacy);
});

test('fixed-session CAS and monotone tombstone affect only that session key', async () => {
  const memory = sessionCredentials();
  const a = createWeixinSessionCredentialStore(memory.service, SESSION_A);
  const duplicateA = createWeixinSessionCredentialStore(memory.service, SESSION_A);
  const b = createWeixinSessionCredentialStore(memory.service, SESSION_B);
  const outcomes = await Promise.allSettled([
    a.commit(null, state()), duplicateA.commit(null, state()), b.commit(null, state()),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected'); errorCode('state-conflict')(outcomes[1].reason);
  assert.equal(outcomes[2].status, 'fulfilled');
  const tombstone = state(2, { credentials: null });
  await a.commit(1, tombstone);
  assert.deepEqual(await duplicateA.read(), tombstone);
  assert.deepEqual(await b.read(), state());
  assert.equal(memory.records.has('wechat-ro-weixin/account'), false);
  await assert.rejects(duplicateA.commit(null, state()), errorCode('state-conflict'));
  await assert.rejects(duplicateA.commit(2, state(2)), errorCode('state-conflict'));
  assert.deepEqual(await a.read(), tombstone);
});

test('fixed-session key validation is bounded and redacted before any dependency access', () => {
  let reads = 0;
  const untouched = {
    get readRecord() { reads++; throw new Error('SYNTHETIC_PRIVATE'); },
    get modifyRecord() { reads++; throw new Error('SYNTHETIC_PRIVATE'); },
  };
  for (const bad of [undefined, null, 7, {}, '', '-bad', 'a/b', 'a\\b', 'a.b', 'a:b',
    'SYNTHETIC_PRIVATE bad', 'a\n', '中', '\ud800', 'a'.repeat(513)]) {
    assert.throws(() => createWeixinSessionCredentialStore(untouched, bad), errorCode('invalid-input'));
  }
  assert.equal(reads, 0);
  const memory = sessionCredentials();
  createWeixinSessionCredentialStore(memory.service, 'a'.repeat(512));
  assert.deepEqual(memory.calls, []);
});

test('fixed-session store failure redaction and detached snapshots retain legacy adapter semantics', async () => {
  const memory = sessionCredentials();
  const a = createWeixinSessionCredentialStore(memory.service, SESSION_A);
  const input = state();
  await a.commit(null, input); input.credentials.botToken = 'SYNTHETIC_PRIVATE';
  const restored = await a.read();
  assert.equal(restored.credentials.botToken, CREDENTIALS.botToken);
  assert.ok(Object.isFrozen(restored)); assert.ok(Object.isFrozen(restored.credentials));
  const broken = createWeixinSessionCredentialStore({
    async readRecord() { throw new Error('SYNTHETIC_PRIVATE'); },
    async modifyRecord() { throw new Error('SYNTHETIC_PRIVATE'); },
  }, SESSION_A);
  await assert.rejects(broken.read(), errorCode('storage-failed'));
  await assert.rejects(broken.commit(null, state()), errorCode('storage-failed'));
});
