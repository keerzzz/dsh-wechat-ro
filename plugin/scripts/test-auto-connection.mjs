// Production coordinator with explicit synthetic capabilities. No real account,
// profile, files, model or network. Real TaskAccess/SDK coverage lives in test-task-context.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createConversationRuntime, WechatConversationService } from '../lib/conversation-controller.js';
import { TASK_WIRE, CONVERSATION_ACTION_NAMES } from '../lib/conversation-wire.js';

const ORIGIN = 'synthetic-auto-context', ROOT = '/synthetic/explicit-workspace';
const TASK = 'wechat-task-77777777-7777-4777-8777-777777777777';
const OTHER = 'wechat-task-88888888-8888-4888-8888-888888888888';
const pending = new Set();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const aborted = signal => new Promise((_, reject) => {
  const fail = () => reject(Object.assign(new Error('Synthetic cancellation'), { code: 'aborted' }));
  if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
});
async function eventually(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); }
  assert.fail('Synthetic transition did not settle');
}
function fixture(options = {}, shared = { sessions: new Map([[ORIGIN, { id: ORIGIN, header: { id: ORIGIN, cwd: ROOT } }]]), tasks: new Map(), domains: new Map(), paired: false }) {
  const count = { opens: 0, writes: 0, finds: 0, creates: 0, ensures: 0, grants: 0, authorizations: 0, qr: 0, scanChecks: 0, saves: 0, polls: 0, models: 0, sends: 0, media: 0, historyHelpers: 0, historyImports: 0 };
  const scan = deferred(), replyGate = deferred(), modelStarted = deferred(), qrGate = deferred(), qrEntered = deferred();
  const listeners = new Set(), controls = new Map(), grants = new Map();
  let disposed = false, channelConfig, recovery = false, historyRestored = false;
  function stored(id) { const value = shared.tasks.get(id); if (!value) throw Object.assign(new Error('No synthetic Task'), { code: 'not-owned' }); return value; }
  function control(id) { if (!controls.has(id)) controls.set(id, new AbortController()); return controls.get(id); }
  function state(id) {
    const value = stored(id), source = grants.get(id);
    return { version: 1, sessionId: id, disposed, prepared: !disposed && value.prepared, historyKnown: true,
      workspace: value.workspace, allowWechat: value.share === true, shareable: !disposed && value.prepared && value.share === true && Boolean(source) && (!options.legacyHistory || historyRestored),
      sessionMayContainData: options.legacyHistory === true, contextBlocked: options.legacyHistory === true && !historyRestored,
      sources: source ? [{ sourceId: 'workspace', kind: 'directory', title: value.workspace.title, root: ROOT, write: true, allowWechat: true }] : [], lastError: null };
  }
  const data = {
    getState: state, canShare: id => state(id).shareable, getWorkspace: id => stored(id).workspace,
    contextSignal: id => control(id).signal,
    async findWorkspaceTasks(root, signal) { signal.throwIfAborted(); assert.equal(root, ROOT); count.finds++; return [...shared.tasks].map(([sessionId, value]) => ({ sessionId, workspace: value.workspace })); },
    async grantWorkspace(id, workspace, signal) { signal.throwIfAborted(); count.grants++; grants.set(id, { generation: 1 }); shared.tasks.set(id, { workspace: { id: 'persistent-workspace-id', root: workspace.root, title: workspace.title }, prepared: shared.tasks.get(id)?.prepared ?? false, share: false }); },
    async grantSnapshot(id, request, signal) { signal.throwIfAborted(); assert.equal(request.root, '/synthetic/prepared-history');historyRestored = true;return state(id); },
    async authorizeAutoWorkspace(id, workspace, signal) { signal.throwIfAborted(); assert.equal(workspace.root, ROOT); assert.equal(workspace.allowWechat, true); count.authorizations++;
      if(options.legacyHistory && !historyRestored) throw Object.assign(new Error('Retained synthetic archive requires a grant'),{code:'share-forbidden'});
      grants.set(id, grants.get(id) || { generation: 1 }); return state(id); },
    async readHistoricalState() { return { phase: 'blocked', reason: options.historyUnknown || options.firstUnknown ? 'run-unresolved' : 'not-required', receipts: options.historyReceipts || [] }; },
    async readFirstTextState() { return { phase: 'blocked', reason: options.auditUnknown ? 'audit-unresolved' : options.firstUnknown ? 'run-unresolved' : null,
      receipts: options.firstReceipts || [] }; },
    setSharing(id, request) { control(id).abort(); controls.set(id, new AbortController()); stored(id).share = request.allowWechat; return state(id); },
    revokeAll(id) { control(id).abort(); grants.delete(id); stored(id).share = false; return state(id); },
    async dispose() { disposed = true; for (const value of controls.values()) value.abort(); for (const value of shared.tasks.values()) { value.prepared = false; value.share = false; } },
  };
  if (options.stopClosesSharing) data.stopTextContexts = async id => data.setSharing(id, { allowWechat: false });
  const agents = new Map();
  const bridge = {
    async createConversation(origin, workspace, signal, reserve) {
      assert.equal(origin, ORIGIN); count.creates++; await reserve(TASK);
      if (options.failCreation) throw Object.assign(new Error('Synthetic uncertain creation'), { code: 'create-failed' });
      await data.grantWorkspace(TASK, workspace, signal);
      const session = { id: TASK, header: { id: TASK, cwd: ROOT } }; shared.sessions.set(TASK, session);
      stored(TASK).prepared = true; agents.set(TASK, { session, options: options.noModel ? {} : { provider: 'synthetic', model: 'offline' } });
      return TASK;
    },
    async ensure(id, signal) {
      signal.throwIfAborted(); count.ensures++; const value = stored(id), session = shared.sessions.get(id);
      assert.ok(session, 'a reserved but absent Task must never be replaced'); value.prepared = true;
      if (!agents.has(id)) agents.set(id, { session, options: options.noModel ? {} : { provider: 'synthetic', model: 'offline' } });
    },
    isPrepared: id => !disposed && shared.tasks.get(id)?.prepared === true,
    async reply(id, text, metadata, signal) {
      assert.equal(id, TASK); assert.equal(text, 'Synthetic owner text'); assert.equal(metadata.messageId, 'synthetic-message'); count.models++; modelStarted.resolve();
      if (options.holdReply) await Promise.race([replyGate.promise, aborted(signal)]);
      signal.throwIfAborted(); return 'Synthetic complete reply';
    },
    async dispose() {},
  };
  const workspace = { id: 'registry-rebuilt-id', path: ROOT, title: 'Synthetic workspace', sessionIds: options.ambiguous ? [TASK, OTHER] : [] };
  const ctx = { sessions: { get: id => shared.sessions.get(id) }, agents: { get: id => agents.get(id) }, agentPresets: {}, sandboxPolicy: {}, fs: {},
    workspaceRegistry: { list: () => [workspace] }, on(name, callback) { assert.equal(name, 'session/event'); listeners.add(callback); return () => listeners.delete(callback); } };
  const runtime = createConversationRuntime(ctx, { sourceRoot: '/synthetic/forbidden-account' }, {
    createArchiveAccess: () => ({ dispose: async () => {} }), createSessionBridge: () => ({ isPrepared: () => false, dispose: async () => {} }),
    createTaskAccess: () => data, createTaskSessionBridge: () => bridge, credentials: {}, fetcher: () => { throw new Error('No network is allowed'); },
    runLocalHistory: async command => {
      count.historyHelpers++;
      if (command === 'import') count.historyImports++;
      if (options.importFailure) throw Object.assign(new Error('Synthetic import failure'), { code: options.importFailure });
      return { account_ref: 'a'.repeat(12), snapshot_directory: '/synthetic/prepared-history', captured_at:'2026-11-19T00:00:00+08:00',snapshot_id:'a'.repeat(32),changed:true,database_count:3 };
    },
    createStateStore: () => ({}), createApi: () => ({}), createMediaApi: () => ({}),
    storageDomain: { async open(spec) {
      count.opens++; assert.equal(spec.name, 'wechat_task_bindings_v1');
      if (!shared.domains.has(spec.name)) shared.domains.set(spec.name, new Map());
      const rows = shared.domains.get(spec.name), schema = spec.tables.contexts.valueSchema;
      return { table(name) { assert.equal(name, 'contexts'); return { get size() { return rows.size; }, get: id => rows.get(id),
        async put(id, value) { count.writes++; rows.set(id, schema.parse(value)); }, async update(id, fn) { count.writes++; rows.set(id, schema.parse(fn(rows.get(id)))); } }; }, async close() {} };
    } },
    prepareQr: async () => () => ({ payloadKind: 'ilink-login', rows: Array(21).fill('0'.repeat(21)) }),
    createChannel(config) {
      assert.equal(config.sessionId, TASK); channelConfig = config;
      return {
        async getStatus(signal) { signal?.throwIfAborted(); return { enabled: true, phase: recovery ? 'recovery-required' : shared.paired ? 'paired' : 'qr-ready', hasStoredLogin: shared.paired, pendingRecovery: recovery }; },
        async cancelLogin(signal) { signal.throwIfAborted(); },
        async beginLogin(signal) {
          signal.throwIfAborted(); count.qr++; qrEntered.resolve();
          if (options.holdQr) await Promise.race([qrGate.promise, aborted(signal)]);
          signal.throwIfAborted(); return { qrContent: 'SYNTHETIC_NOT_A_REAL_QR' };
        },
        async pollLoginForOwner(_, signal) { count.scanChecks++; await Promise.race([scan.promise, aborted(signal)]); signal.throwIfAborted(); return { status: 'confirmed', expectedOwnerId: 'synthetic-owner' }; },
        async confirmPairingForOwner(owner, signal) { signal.throwIfAborted(); assert.equal(owner, 'synthetic-owner'); count.saves++; shared.paired = true; return { paired: true }; },
        async getPairingIdentity(signal) { signal.throwIfAborted(); assert.equal(shared.paired, true); return { botId: 'synthetic-bot', userId: 'synthetic-owner' }; },
        async pollTextOnce(signal) {
          count.polls++; const text = await config.reply('Synthetic owner text', { messageId: 'synthetic-message' }, signal);
          assert.equal(text, 'Synthetic complete reply'); assert.equal(config.beforeSend(), true); count.sends++; config.onTextAccepted();
          if (options.failAfterAccepted) { recovery = true; throw Object.assign(new Error('Synthetic completion CAS failure'), { code: 'send-failed' }); }
          return { received: 1, replied: 1, ignored: 0, duplicates: 0, remaining: 0 };
        },
        async pollOnce() { count.media++; assert.fail('Automatic connection must not use batch/media polling'); }, dispose() {},
      };
    },
  });
  pending.add(runtime);
  return { runtime, count, scan, replyGate, modelStarted, qrGate, qrEntered, shared, data, agents, controls,
    sendAllowed: () => channelConfig.beforeSend(),
    changeOriginDirectory() {
      const session = shared.sessions.get(ORIGIN);
      session.header = { ...session.header, cwd: '/synthetic/changed-origin' };
      for (const listener of listeners) listener(session, { type: 'working-directory/change', data: { cwd: session.header.cwd } });
    },
    changeDirectory() { shared.sessions.get(TASK).header = { id: TASK, cwd: '/synthetic/changed-directory' }; for (const listener of listeners) listener(shared.sessions.get(TASK), { type: 'working-directory/change', data: { cwd: '/synthetic/changed-directory' } }); },
  };
}
const connect = f => f.runtime.action({ kind: 'task', action: 'connectConversation', contextSessionId: ORIGIN, expectedDirectory: ROOT, confirmation: 'connect-own-wechat-auto-reply' });
const stop = f => f.runtime.action({ kind: 'task', action: 'stopChannel', sessionId: TASK, confirmation: 'stop-channel' });
const taskState = f => f.runtime.getState({ kind: 'task', sessionId: TASK });
after(async () => { for (const runtime of pending) await runtime.dispose(); });

test('strict explicit scope; constructor and GET have zero capability effects', async () => {
  assert.equal(CONVERSATION_ACTION_NAMES.length, 12); assert.equal(TASK_WIRE.TASK_ACTION_NAMES.length, 33);
  assert.ok(TASK_WIRE.TASK_ACTION_NAMES.includes('allowNewFirstText'));
  assert.deepEqual(TASK_WIRE.TASK_ACTION_NAMES.slice(-3), ['importLocalHistory', 'refreshLocalHistory', 'stopLocalHistory']);
  const f = fixture(), before = { ...f.count };
  const state = f.runtime.getState({ kind: 'task', sessionId: ORIGIN }); assert.equal(state.channel.setup.root, ROOT);
  assert.deepEqual(f.count, before);
  const valid = { kind: 'task', action: 'connectConversation', contextSessionId: ORIGIN, expectedDirectory: ROOT, confirmation: 'connect-own-wechat-auto-reply' };
  for (const invalid of [{ ...valid, confirmation: 'network-login' }, { ...valid, allowWechat: true }, { ...valid, sessionId: TASK }, { ...valid, model: 'forged' }]) {
    assert.equal(TASK_WIRE.actionSchema.safeParse(invalid).success, false); assert.equal((await f.runtime.action(invalid)).ok, false);
  }
  const denied = await WechatConversationService.prototype.conversationAction.call({ ctx: { invocation: { peer: { principal: { kind: 'guest' } } } }, runtime: f.runtime }, valid);
  assert.equal(denied.error.code, 'NOT_AUTHORIZED'); assert.deepEqual(f.count, before);
});
test('one connect: reserve exact SID, show QR, verify owner, then automatic text replies', async () => {
  const f = fixture(), response = await connect(f); assert.equal(response.ok, true); assert.equal(response.state.sessionId, TASK); assert.ok(response.qr);
  assert.equal(f.shared.domains.get('wechat_task_bindings_v1').get(ORIGIN).sessionId, TASK); assert.equal(f.count.models, 0);
  assert.equal((await f.runtime.action({ kind: 'task', action: 'beginLogin', sessionId: TASK, confirmation: 'network-login' })).error.code, 'BUSY');
  f.scan.resolve(); await eventually(() => f.count.sends === 1);
  assert.equal(taskState(f).channel.automaticPolling, true); assert.equal(taskState(f).channel.requestAccepted, 1);
  assert.equal(f.count.saves, 1); assert.equal(f.count.media, 0);
  const again = await connect(f); assert.equal(again.ok, true); assert.equal(again.state.sessionId, TASK); assert.equal(f.count.creates, 1); assert.equal(f.count.qr, 1);
  assert.equal((await stop(f)).ok, true); assert.equal(taskState(f).channel.automaticPolling, false); assert.equal(f.sendAllowed(), false);
});
test('native model selection completes setup without another pairing or permission click', async () => {
  const f = fixture({ noModel: true }); assert.equal((await connect(f)).ok, true); f.scan.resolve();
  await eventually(() => taskState(f).channel.setup.phase === 'model-required'); assert.equal(f.count.models, 0);
  f.agents.get(TASK).options = { provider: 'synthetic', model: 'offline' }; await eventually(() => f.count.sends === 1);
  assert.equal(f.count.creates, 1); assert.equal(f.count.qr, 1); assert.equal(f.count.saves, 1); await stop(f);
});
test('setup deadline cannot stop an established automatic reply loop', async t => {
  const deadline = new AbortController(), realTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => ms === 10 * 60 * 1000 ? deadline.signal : realTimeout(ms));
  const f = fixture(); assert.equal((await connect(f)).ok, true); f.scan.resolve();
  await eventually(() => f.count.sends === 1);
  deadline.abort();
  await eventually(() => f.count.sends >= 2);
  assert.equal(taskState(f).channel.automaticPolling, true);
  assert.equal(taskState(f).channel.setup.phase, 'running');
  await stop(f); assert.equal(taskState(f).channel.setup.phase, 'stopped');
});
test('source cancellation cannot leave stopped automatic replies displayed as running', async () => {
  const f = fixture(); assert.equal((await connect(f)).ok, true); f.scan.resolve();
  await eventually(() => f.count.sends === 1);
  f.controls.get(TASK).abort();
  await eventually(() => taskState(f).channel.automaticPolling === false);
  assert.equal(taskState(f).channel.setup.phase, 'stopped');
  assert.equal(f.sendAllowed(), false);
});
test('explicit reconnect restores managed history sharing after Stop without another import or QR', async () => {
  const f = fixture({ legacyHistory: true, stopClosesSharing: true });
  assert.equal((await connect(f)).ok, true); f.scan.resolve();
  await eventually(() => taskState(f).channel.setup.phase === 'history-required');
  assert.equal((await f.runtime.action({ kind: 'task', action: 'importLocalHistory', sessionId: TASK,
    autoUpdate: true, allowWechat: true, confirmation: 'import-own-wechat-history' })).ok, true);
  await eventually(() => f.count.sends === 1); await stop(f);
  assert.equal(f.data.canShare(TASK), false);
  assert.equal((await connect(f)).ok, true);
  await eventually(() => f.count.sends === 2);
  assert.equal(f.count.historyImports, 1); assert.equal(f.count.qr, 1); assert.equal(f.count.creates, 1);
  await stop(f);
});
test('known retained archive blocks replies while QR pairing succeeds; explicit import resumes the same paired task', async () => {
  const f = fixture({legacyHistory:true});
  const connected=await connect(f);assert.equal(connected.ok,true);assert.ok(connected.qr);assert.equal(f.count.models+f.count.polls+f.count.sends,0);
  f.scan.resolve();await eventually(()=>taskState(f).channel.setup.phase==='history-required');
  assert.equal(f.count.saves,1);assert.equal(f.count.models+f.count.polls+f.count.sends,0);assert.equal(f.sendAllowed(),false);
  const second=await connect(f);assert.equal(second.ok,true);assert.equal(f.count.qr,1);assert.equal(f.count.creates,1);
  const imported=await f.runtime.action({kind:'task',action:'importLocalHistory',sessionId:TASK,autoUpdate:true,allowWechat:true,confirmation:'import-own-wechat-history'});
  assert.equal(imported.ok,true,JSON.stringify(imported.error));await eventually(()=>f.count.sends===1);
  assert.equal(f.count.qr,1);assert.equal(f.count.saves,1);assert.equal(f.count.creates,1);assert.equal(taskState(f).channel.automaticPolling,true);
  await stop(f);
});
test('stopping history-wait pairing prevents later source approval from starting replies',async()=>{
  const f=fixture({legacyHistory:true});assert.equal((await connect(f)).ok,true);f.scan.resolve();
  await eventually(()=>taskState(f).channel.setup.phase==='history-required');await stop(f);
  const imported=await f.runtime.action({kind:'task',action:'importLocalHistory',sessionId:TASK,autoUpdate:false,allowWechat:true,confirmation:'import-own-wechat-history'});
  assert.equal(imported.ok,true,JSON.stringify(imported.error));
  await delay(20);assert.equal(f.count.models+f.count.sends,0);assert.equal(taskState(f).channel.setup.phase,'stopped');
});
test('retained paired task after restart waits for import and never requests a replacement QR', async () => {
  const shared = { sessions: new Map([[ORIGIN, { id: ORIGIN, header: { id: ORIGIN, cwd: ROOT } }],
    [TASK, { id: TASK, header: { id: TASK, cwd: ROOT } }]]),
    tasks: new Map([[TASK, { prepared: false, workspace: { id: 'persistent-workspace-id', root: ROOT, title: 'Original workspace' }, share: false }]]),
    domains: new Map(), paired: true };
  const f = fixture({ legacyHistory: true }, shared);
  const response = await connect(f);
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.state.sessionId, TASK);
  await eventually(() => taskState(f).channel.setup.phase === 'history-required');
  assert.equal(f.count.creates + f.count.qr + f.count.saves + f.count.polls + f.count.models + f.count.sends, 0);
  assert.equal(f.sendAllowed(), false);
  const imported = await f.runtime.action({ kind: 'task', action: 'importLocalHistory', sessionId: TASK,
    autoUpdate: true, allowWechat: true, confirmation: 'import-own-wechat-history' });
  assert.equal(imported.ok, true, JSON.stringify(imported.error));
  await eventually(() => f.count.sends === 1);
  assert.equal(f.count.creates + f.count.qr + f.count.saves, 0);
  await stop(f);
});
test('helper failure returns a known import error while keeping pairing and all replies stopped', async () => {
  for (const code of ['LOCAL_HISTORY_CLIENT_REQUIRED', 'LOCAL_HISTORY_FAILED']) {
    const f = fixture({ legacyHistory: true, importFailure: code });
    assert.equal((await connect(f)).ok, true); f.scan.resolve();
    await eventually(() => taskState(f).channel.setup.phase === 'history-required');
    const imported = await f.runtime.action({ kind: 'task', action: 'importLocalHistory', sessionId: TASK,
      autoUpdate: true, allowWechat: true, confirmation: 'import-own-wechat-history' });
    assert.deepEqual(imported, { ok: false, error: { code } });
    assert.equal(taskState(f).channel.localHistory.enabled, false);
    assert.equal(taskState(f).channel.setup.phase, 'stopped');
    assert.equal(f.shared.paired, true);
    assert.equal(f.count.polls + f.count.models + f.count.sends, 0);
  }
});
test('uncertain creation keeps its reservation and cannot create a replacement on retry', async () => {
  const f = fixture({ failCreation: true }); assert.equal((await connect(f)).ok, false);
  assert.deepEqual(f.shared.domains.get('wechat_task_bindings_v1').get(ORIGIN), { root: ROOT, sessionId: TASK, ready: false });
  assert.equal((await connect(f)).ok, false); assert.equal(f.count.creates, 1); assert.equal(f.count.qr + f.count.models + f.count.sends, 0);
});
test('ambiguous legacy tasks and unknown text audit never get a new task or channel', async () => {
  const ambiguous = fixture({ ambiguous: true }); assert.equal((await connect(ambiguous)).error.code, 'SESSION_NOT_READY'); assert.equal(ambiguous.count.creates + ambiguous.count.qr, 0);
  const unknown = fixture({ historyUnknown: true }); assert.equal((await connect(unknown)).error.code, 'SHARED_CONTEXT_DENIED');
  assert.equal(unknown.count.authorizations + unknown.count.qr + unknown.count.models, 0);
});
test('an explicit normal connection accepts an unused first-text failure and keeps its old terminal', async () => {
  const terminal = { operation: 'terminal', purpose: 'first-text-once', runOutcome: 'unknown', auditOutcome: 'committed', modelRequestsReserved: 0, requestAccepted: 0 };
  const shared = { sessions: new Map([[ORIGIN, { id: ORIGIN, header: { id: ORIGIN, cwd: ROOT } }], [TASK, { id: TASK, header: { id: TASK, cwd: ROOT } }]]),
    tasks: new Map([[TASK, { prepared: true, workspace: { id: 'persistent-workspace-id', root: ROOT, title: 'Original workspace' }, share: false }]]), domains: new Map(), paired: true };
  const f = fixture({ firstUnknown: true, firstReceipts: [terminal] }, shared);
  assert.equal((await connect(f)).ok, true);
  await eventually(() => f.count.sends === 1);
  assert.equal(f.count.creates, 0); assert.equal(f.count.qr, 0); assert.equal(f.count.saves, 0);
  assert.equal(f.count.authorizations, 1);
  assert.deepEqual((await f.data.readFirstTextState()).receipts, [terminal]);
  assert.equal(taskState(f).channel.automaticPolling, true);
  await stop(f);
});
test('normal connection still blocks nonzero, missing, multiple or unsettled prior run evidence', async () => {
  const terminal = { operation: 'terminal', purpose: 'first-text-once', runOutcome: 'unknown', auditOutcome: 'committed', modelRequestsReserved: 0, requestAccepted: 0 };
  for (const options of [
    { firstReceipts: [{ ...terminal, modelRequestsReserved: 1 }] }, { firstReceipts: [{ ...terminal, requestAccepted: 1 }] },
    { firstReceipts: [{ ...terminal, modelRequestsReserved: undefined }] }, { firstReceipts: [{ ...terminal, auditOutcome: 'unknown' }] },
    { firstReceipts: [terminal, { ...terminal }] }, { firstReceipts: [] },
    { firstReceipts: [terminal], historyReceipts: [{ ...terminal, purpose: 'history-text-once' }] },
    { firstReceipts: [terminal], auditUnknown: true },
  ]) {
    const f = fixture({ firstUnknown: true, ...options });
    assert.equal((await connect(f)).error.code, 'SHARED_CONTEXT_DENIED');
    assert.equal(f.count.authorizations + f.count.qr + f.count.models + f.count.sends, 0);
  }
});
test('Stop during pending scan cancels background setup and cannot activate later', async () => {
  const f = fixture(); assert.equal((await connect(f)).ok, true); assert.equal((await stop(f)).ok, true); f.scan.resolve(); await delay(20);
  assert.equal(f.count.saves + f.count.models + f.count.sends, 0); assert.equal(taskState(f).channel.setup.phase, 'stopped');
});
test('origin directory change before QR registration cannot save pairing or start replies', async () => {
  const f = fixture({ holdQr: true }), request = connect(f);
  await f.qrEntered.promise;
  f.changeOriginDirectory(); f.qrGate.resolve();
  const response = await request;
  assert.equal(response.ok, false); assert.equal(response.error.code, 'CANCELLED');
  f.scan.resolve(); await delay(20);
  assert.equal(f.count.scanChecks + f.count.saves + f.count.models + f.count.sends, 0);
  assert.equal(taskState(f).channel.setup.qr, null);
  assert.equal(f.sendAllowed(), false);
});
test('origin directory change after registration stops pending pairing without late activation', async () => {
  const f = fixture(); assert.equal((await connect(f)).ok, true);
  f.changeOriginDirectory(); f.scan.resolve();
  await eventually(() => taskState(f).channel.setup.phase === 'stopped');
  assert.equal(f.count.saves + f.count.models + f.count.sends, 0);
  assert.equal(taskState(f).channel.setup.qr, null); assert.equal(f.sendAllowed(), false);
});
test('Owner memory GET recovers the same transient QR with no repeated connection effects', async () => {
  const f = fixture(), response = await connect(f); assert.equal(response.ok, true);
  const before = { ...f.count };
  const origin = f.runtime.getState({ kind: 'task', sessionId: ORIGIN });
  const target = taskState(f);
  assert.equal(origin.channel.setup.sessionId, TASK);
  assert.deepEqual(origin.channel.setup.qr, response.qr); assert.deepEqual(target.channel.setup.qr, response.qr);
  assert.deepEqual(f.count, before);
  assert.equal(TASK_WIRE.connectionSetupSchema.safeParse({ ...target.channel.setup, qr: { ...response.qr, token: 'forged' } }).success, false);
  assert.equal(TASK_WIRE.connectionSetupSchema.safeParse({ ...target.channel.setup, qr: { payloadKind: 'ilink-login', rows: ['<svg/>'] } }).success, false);
  target.channel.setup.qr.rows[0] = '1'.repeat(21);
  assert.deepEqual(taskState(f).channel.setup.qr, response.qr, 'GET returns a detached rendered matrix, not mutable runtime state');
  assert.deepEqual(f.count, before);
  await stop(f); assert.equal(taskState(f).channel.setup.qr, null);
});
test('directory change stops a pending native reply and retires its send permit', async () => {
  const f = fixture({ holdReply: true }); assert.equal((await connect(f)).ok, true); f.scan.resolve(); await f.modelStarted.promise;
  f.changeDirectory(); f.replyGate.resolve(); await eventually(() => taskState(f).channel.automaticPolling === false);
  assert.equal(f.count.models, 1); assert.equal(f.count.sends, 0); assert.equal(f.sendAllowed(), false);
});
test('accepted API fact survives completion failure; automatic mode never retries', async () => {
  const f = fixture({ failAfterAccepted: true }); assert.equal((await connect(f)).ok, true); f.scan.resolve();
  await eventually(() => taskState(f).channel.setup.phase === 'blocked' && taskState(f).channel.automaticPolling === false);
  assert.equal(taskState(f).channel.requestAccepted, 1); assert.equal(taskState(f).channel.pendingRecovery, true);
  await delay(1100); assert.equal(f.count.polls, 1); assert.equal(f.count.models, 1); assert.equal(f.count.sends, 1);
  assert.equal((await connect(f)).error.code, 'SHARED_CONTEXT_DENIED'); assert.equal(f.count.sends, 1); assert.equal(f.count.creates, 1);
});
test('runtime restart reuses the durable exact SID but never restores automatic authority through GET', async () => {
  const first = fixture(); assert.equal((await connect(first)).ok, true); await stop(first); await first.runtime.dispose();
  const second = fixture({}, first.shared), before = { ...second.count };
  second.runtime.getState({ kind: 'task', sessionId: ORIGIN }); assert.deepEqual(second.count, before);
  assert.equal((await connect(second)).ok, true); assert.equal(second.count.creates, 0); assert.equal(second.count.ensures > 0, true);
  assert.equal(second.shared.domains.get('wechat_task_bindings_v1').get(ORIGIN).sessionId, TASK); await stop(second);
});
