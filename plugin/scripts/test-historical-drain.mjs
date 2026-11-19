// Offline integration regression: actual Controller -> Channel -> NativeBridge.
// All Session, pairing, storage and sealedHistory services below are synthetic
// memory carriers. No Host, model, credential backend or source path is opened.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConversationRuntime } from '../lib/conversation-controller.js';
import { createNativeSessionBridge } from '../lib/native-session-bridge.js';
import { createTaskHistoryAuthority, TASK_HISTORY_AUDIT_SPEC, TASK_FIRST_TEXT_AUDIT_SPEC } from '../lib/task-history.js';
import { createWeixinApi } from '../lib/weixin-api.js';
import { createWeixinChannel, WeixinChannelError } from '../lib/weixin-channel.js';

const previousFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = () => { networkAttempts++; throw new Error('OFFLINE_HISTORICAL_DRAIN'); };
after(() => { globalThis.fetch = previousFetch; assert.equal(networkAttempts, 0); });

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turnOfEventLoop = () => new Promise(done => setImmediate(done));
const fail = code => { throw Object.assign(new Error('Synthetic refusal'), { code }); };
const unexpected = () => { throw new Error('Unexpected source, login, factory or media operation'); };
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

function fixture({ account = randomUUID(), historical = true, empty = false, statusFailureAfterSend = false,
  updatesFailure = false, sendFailure = null, commitFailurePhase = null, pollFailure = null } = {}) {
  const id = `wechat-task-${randomUUID()}`, entered = deferred(), nativeDrained = deferred();
  const events = [], listeners = new Map(), auditRows = new Map(), order = [];
  const workspace = { id: 'synthetic-workspace-' + randomUUID(), root: '/synthetic/never-read/' + randomUUID(), title: 'Synthetic workspace' };
  const meter = { updates: 0, sends: 0, followups: 0, nativeCancels: 0, nativePending: false, turnActive: false,
    sealedRequests: 0, recordedRequests: null, leaseReleased: false, finishes: 0, statusRefreshFailures: 0, sentText: null,
    commits: 0, transports: 0, pollError: null };
  const session = { id, header: { id, cwd: workspace.root, agentPreset: 'dsh-wechat-task-v1', isSeeded: false }, seq: 1,
    snapshotEvents: () => events, requestContext: () => ({ provider: 'synthetic', model: 'synthetic-model' }) };
  const agentCtx = { on(name, callback) {
    const callbacks = listeners.get(name) || new Set(); callbacks.add(callback); listeners.set(name, callbacks);
    return () => callbacks.delete(callback);
  } };
  const emit = (name, ...args) => { for (const callback of [...(listeners.get(name) || [])]) callback(...args); };
  const append = (type, data) => { const event = { seq: ++session.seq, type, data }; events.push(event); emit('session/event', session, event); };
  let leaseOptions, leased = false, sdkReady = true;
  const agent = { session, ctx: agentCtx, inbox: { nextTurn: [], nextStep: [], remove() {} },
    sealedHistory: { version: 1, probe: () => ({ supported: sdkReady && !leased }), acquire(options) {
      assert.equal(leased, false); leaseOptions = options; leased = true;
      return { get requestsReserved() { return meter.sealedRequests; }, release() {
        order.push('lease-release'); meter.leaseReleased = true; leased = false;
      } };
    } },
    followup(message) {
      assert.equal(meter.turnActive, false); meter.turnActive = true; meter.followups++;
      append('turn/start', { turn: 1 }); emit('agent/inbox/claimed', { agent, message, turn: 1 }); append('user/message', message);
      if (leased) {
        assert.equal(leaseOptions.verify({ agent, session, input: message, turn: 1, attempt: 1 }), true);
        meter.sealedRequests = 1; // Simulate the SDK budget reservation, not a model call.
      }
      entered.resolve();
    },
    cancel() { meter.nativeCancels++; }, // Deliberately hold turn/end until the test releases it.
  };
  const value = { prepared: true, historyKnown: true, workspace, cwd: workspace.root,
    consumed: historical ? [{ sourceId: 'workspace', kind: 'directory', generation: randomUUID() }] : [],
    revision: 1, shareContext: false };
  const table = { get size() { return auditRows.size; }, get: key => auditRows.get(key),
    async put(key, record) { auditRows.set(key, TASK_HISTORY_AUDIT_SPEC.tables.tasks.valueSchema.parse(structuredClone(record))); },
    async update(key, transform) {
      const next = TASK_HISTORY_AUDIT_SPEC.tables.tasks.valueSchema.parse(structuredClone(transform(auditRows.get(key))));
      order.push('audit-' + next.events.at(-1).operation); auditRows.set(key, next);
    } };
  const firstAuditRows = new Map();
  const firstTable = { get size() { return firstAuditRows.size; }, get: key => firstAuditRows.get(key),
    async put(key, record) { firstAuditRows.set(key, TASK_FIRST_TEXT_AUDIT_SPEC.tables.tasks.valueSchema.parse(structuredClone(record))); },
    async update(key, transform) { firstAuditRows.set(key, TASK_FIRST_TEXT_AUDIT_SPEC.tables.tasks.valueSchema.parse(structuredClone(transform(firstAuditRows.get(key))))); } };
  const historyOptions = {
    snapshot: () => ({ ...value, sdkAvailable: true, sdkReady: sdkReady && !leased, sdkOwner: agent, sdkSequence: session.seq }),
    storage: () => ({ async open(spec) {
      assert.ok(spec === TASK_HISTORY_AUDIT_SPEC || spec === TASK_FIRST_TEXT_AUDIT_SPEC);
      return { table: name => { assert.equal(name, 'tasks'); return spec === TASK_HISTORY_AUDIT_SPEC ? table : firstTable; }, async close() {} };
    } }),
    closeSharing: () => { value.shareContext = false; }, openSharing: () => { value.shareContext = true; }, fail,
  };
  const history = createTaskHistoryAuthority(historyOptions);
  const canShare = () => !historical && value.prepared && value.shareContext;
  const data = { canShare, getState: () => ({ version: 1, sessionId: id, disposed: false, prepared: true, historyKnown: true, workspace,
    allowWechat: value.shareContext, shareable: canShare(), sessionMayContainData: historical, contextBlocked: historical,
    sources: historical ? [] : [{ sourceId: 'workspace', kind: 'directory', root: workspace.root, title: workspace.title, write: true, allowWechat: true }], lastError: null }),
    setSharing(key, request) { assert.equal(key, id); assert.equal(request.confirmation, 'share-whole-task-context'); history.invalidate(id, 'sharing-changed'); value.shareContext = request.allowWechat; return data.getState(id); },
    getHistoricalState: history.status, readHistoricalState: history.inspect, reviewHistoricalContext: history.review,
    authorizeHistoricalContext: history.authorize, shareHistoricalContext: history.share, revokeHistoricalContext: history.revoke,
    reserveHistoricalText: history.reserve, verifyHistoricalText: history.verify,
    finishHistoricalText(permit, result) { order.push('finish-permit'); meter.finishes++; return history.finish(permit, result); },
    releaseDeliveries: unexpected, prepareDelivery: unexpected, dispose: history.dispose,
  };
  const ctx = { agents: { get: key => key === id ? agent : undefined, create: unexpected, resume: unexpected },
    sessions: { get: key => key === id ? session : undefined, async flush(target) { assert.equal(target, session); return true; } },
    agentPresets: { async resolve() { return { id: 'dsh-wechat-task-v1' }; }, mount: unexpected, composedPreset() { return 'dsh-wechat-task-v1'; } },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, workspaceRegistry: { list: () => [] },
    fs: new Proxy({}, { get: unexpected }),
  };
  const core = createNativeSessionBridge(ctx, data, 30000, {
    info: { agentPreset: 'dsh-wechat-task-v1', messageSource: 'wechat-task-weixin', maxInputBytes: 16384, maxReplyBytes: 16384 },
    isSessionId: key => key === id, requireData: target => assert.equal(target, data), bindData: () => () => {},
    assertHistory: () => true, hasPolicy: () => true,
    historical: { verify: history.verify, bindInput: history.bindInput,
      recordRequests(permit, count) { order.push('record-requests'); meter.recordedRequests = count; history.recordModelRequests(permit, count); },
      finishReply({ text, historyPermit }) { history.completeModel(historyPermit); return Object.freeze({ text, deliverables: [] }); },
    },
  });
  const bridge = { ensure: (key, signal) => core.ensure(key, signal), isPrepared: key => core.isPrepared(key),
    reply: (key, text, metadata, signal) => core.reply(key, text, metadata, signal),
    replyHistorical(key, text, metadata, signal, permit) {
      const work = core.reply(key, text, metadata, signal, permit); meter.nativePending = true;
      const done = () => { meter.nativePending = false; nativeDrained.resolve(); };
      work.then(done, done); return work;
    },
    replyWithDeliverables: unexpected, dispose: () => core.dispose(),
  };
  const botId = 'synthetic-bot-' + account, userId = 'synthetic-owner';
  let channelState = { version: 3, sessionId: id, revision: 1,
    credentials: { botId, userId, botToken: 'SYNTHETIC_NOT_A_CREDENTIAL', baseUrl: 'https://ilinkai.weixin.qq.com' },
    cursor: '', seenMessageIds: [], pending: null, queuedBatch: null };
  const store = { async read() { return structuredClone(channelState); }, async commit(expected, next) {
    assert.equal(expected, channelState.revision); meter.commits++;
    const failCommit = commitFailurePhase === 'inbox' && channelState.queuedBatch === null && next.queuedBatch !== null
      || commitFailurePhase === 'sending' && next.pending?.phase === 'sending'
      || commitFailurePhase === 'completed' && channelState.pending?.phase === 'sending' && next.pending === null;
    channelState = structuredClone(next);
    if (failCommit) throw new Error('Synthetic commit acknowledgement lost after the write');
  } };
  const transportApi = createWeixinApi({ fetcher: async input => {
    meter.transports++;
    const path = new URL(input).pathname;
    if (path === '/ilink/bot/getupdates') {
      assert.equal(updatesFailure, true);
      return new Response(JSON.stringify({ ret: 0, msgs: 'invalid-synthetic-update-page' }), { headers: { 'content-type': 'application/json' } });
    }
    assert.equal(path, '/ilink/bot/sendmessage'); assert.ok(sendFailure);
    if (sendFailure === 'network-error') throw new Error('Synthetic transport failure after send dispatch');
    return new Response(JSON.stringify(sendFailure === 'business-error' ? { ret: 1 } : {}), { headers: { 'content-type': 'application/json' } });
  } });
  const api = { requestQrCode: unexpected, getQrStatus: unexpected,
    diagnoseUpdatesOnce: (auth, cursor, signal) => transportApi.diagnoseUpdatesOnce(auth, cursor, signal),
    async getUpdates(auth, cursor, signal) {
    meter.updates++;
    if (updatesFailure) return transportApi.getUpdates(auth, cursor, signal);
    return { cursor: 'synthetic-cursor', ignored: 0, messages: empty ? [] : [{ messageId: 'synthetic-input-1', fromUserId: userId,
      toUserId: botId, contextToken: 'synthetic-context-token', text: 'Synthetic Owner text.' }] };
  }, async sendText(auth, request, signal) {
    meter.sends++; meter.sentText = request.text;
    if (sendFailure) return transportApi.sendText(auth, request, signal);
    return { accepted: true };
  } };
  const createChannel = options => {
    const channel = createWeixinChannel(options);
    if (!statusFailureAfterSend && !updatesFailure && !sendFailure && !commitFailurePhase && !pollFailure) return channel;
    return Object.freeze({ ...channel, async pollTextOnce(signal) {
      try {
        if (pollFailure) throw pollFailure;
        return await channel.pollTextOnce(signal);
      } catch (error) {
        meter.pollError = { code: error.code, deliveryUnknown: error.deliveryUnknown,
          apiErrorCode: error.apiErrorCode, actual: error instanceof WeixinChannelError };
        throw error;
      }
    }, async getStatus(signal) {
      if (statusFailureAfterSend && meter.sends > 0 && meter.statusRefreshFailures === 0) {
        meter.statusRefreshFailures++; throw new Error('Synthetic post-accept status refresh refusal');
      }
      return channel.getStatus(signal);
    } });
  };
  const runtime = createConversationRuntime(ctx, {}, {
    createArchiveAccess: () => ({ async dispose() {} }),
    createSessionBridge: () => ({ isPrepared: () => false, async dispose() {} }),
    createTaskAccess: () => data, createTaskSessionBridge: () => bridge,
    credentials: {}, fetcher: globalThis.fetch, createStateStore: () => store, createApi: () => api,
    createMediaApi: () => ({ sendMedia: unexpected }), createChannel,
  });
  const action = (name, shape = {}, signal) => runtime.action({ kind: 'task', sessionId: id, action: name, ...shape }, signal);
  const prepare = async () => {
    assert.equal((await action('resumeConversation', { confirmation: 'resume-task-conversation' })).ok, true);
  };
  const approveHistory = async () => {
    const reviewed = await action('reviewHistoricalContext'); assert.equal(reviewed.ok, true);
    const approved = await action('authorizeHistoricalContext', { reviewId: reviewed.result.reviewId, confirmation: 'authorize-reviewed-task-history-text' });
    assert.equal(approved.ok, true); const consentId = approved.result.receipt.consentId;
    assert.equal((await action('setSharing', { allowWechat: true, historyConsentId: consentId, confirmation: 'share-reviewed-task-history-context' })).ok, true);
    return consentId;
  };
  const shareOrdinary = async () => {
    assert.equal((await action('setSharing', { allowWechat: true, confirmation: 'share-whole-task-context' })).ok, true);
  };
  const poll = (consentId, signal) => action('pollTextOnce', { allowSharedContext: true,
    ...(consentId === undefined ? { confirmation: 'poll-one-text-reply' }
      : { historyConsentId: consentId, confirmation: 'poll-one-text-reply-with-reviewed-history' }),
  }, signal);
  const finishNativeTurn = ({ completed = false, text = 'Synthetic completed assistant reply.' } = {}) => {
    if (!meter.turnActive) return;
    if (completed) append('assistant/message', { turn: 1, interrupted: false,
      message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'synthetic', model: 'synthetic-model' }, content: [{ type: 'text', text }] },
      stream: [{ type: 'chunk', chunk: { type: 'finish' } }],
    });
    meter.turnActive = false; append('turn/end', { turn: 1, reason: { kind: completed ? 'completed' : 'cancelled' } });
  };
  const terminalEvents = () => (auditRows.get(id)?.events || []).filter(event => event.operation === 'terminal');
  return { id, runtime, history, historyOptions, meter, order, entered, nativeDrained, prepare, approveHistory, shareOrdinary, poll, finishNativeTurn, terminalEvents,
    getChannelState: () => structuredClone(channelState),
    getAudit: () => structuredClone(auditRows.get(id)),
    diagnose: signal => action('diagnoseUpdatesOnce', { confirmation: 'read-one-wechat-update-diagnostic' }, signal),
    setSdkReady(ready) { assert.equal(typeof ready, 'boolean'); sdkReady = ready; },
    async dispose() { finishNativeTurn(); await runtime.dispose(); },
  };
}

test('historical cancellation retains RPC, account lock and terminal audit until native turn drains', async () => {
  const account = randomUUID(), f = fixture({ account }), sameAccount = fixture({ account, historical: false, empty: true });
  const otherAccount = fixture({ historical: false, empty: true }), controller = new AbortController();
  let pending;
  try {
    await f.prepare(); await sameAccount.prepare(); await otherAccount.prepare();
    await sameAccount.shareOrdinary(); await otherAccount.shareOrdinary();
    const consentId = await f.approveHistory();
    let rpcSettled = false;
    pending = f.poll(consentId, controller.signal); pending.then(() => { rpcSettled = true; }, () => { rpcSettled = true; });
    await bounded(f.entered.promise, 'historical input admission');
    assert.equal(f.meter.sealedRequests, 1); assert.equal(f.meter.updates, 1);
    controller.abort(); await turnOfEventLoop();
    assert.equal(f.meter.nativePending, true); assert.ok(f.meter.nativeCancels > 0);
    assert.equal(rpcSettled, false, 'Channel abort must not let the Owner RPC outrun native work');
    assert.equal(f.meter.leaseReleased, false); assert.equal(f.meter.recordedRequests, null);
    assert.equal(f.meter.finishes, 0, 'permit settlement must wait for SDK request accounting');
    assert.equal(f.terminalEvents().length, 0, 'do not persist a zero-request terminal before the lease drains');

    const blocked = await bounded(sameAccount.poll(), 'same-account lock rejection');
    assert.deepEqual(blocked, { ok: false, error: { code: 'BUSY' } });
    assert.equal(sameAccount.meter.updates, 0, 'another Task must not poll the locked account');
    assert.equal(sameAccount.meter.followups, 0);
    const independent = await bounded(otherAccount.poll(), 'independent-account empty poll');
    assert.equal(independent.ok, true, 'the drain fence is account-scoped, not a global channel lock');
    assert.equal(otherAccount.meter.updates, 1);
    assert.equal(rpcSettled, false); assert.equal(f.terminalEvents().length, 0);

    f.finishNativeTurn(); await bounded(f.nativeDrained.promise, 'native turn drain');
    const result = await bounded(pending, 'historical RPC terminal');
    assert.deepEqual(result, { ok: false, error: { code: 'CANCELLED' } });
    assert.equal(f.meter.nativePending, false); assert.equal(f.meter.leaseReleased, true);
    assert.equal(f.meter.recordedRequests, 1); assert.equal(f.meter.finishes, 1);
    const terminal = f.history.status(f.id).receipts.find(receipt => receipt.operation === 'terminal');
    assert.ok(terminal); assert.equal(terminal.modelRequestsReserved, 1); assert.equal(terminal.requestAccepted, 0);
    assert.equal(terminal.runOutcome, 'unknown'); assert.equal(terminal.auditOutcome, 'committed');
    assert.equal(terminal.permissionRevoked, true); assert.equal(terminal.sharingClosed, true);
    assert.equal(f.terminalEvents().length, 1); assert.equal(f.terminalEvents()[0].modelRequestsReserved, 1);
    assert.equal(f.terminalEvents()[0].outcome, 'unknown'); assert.equal(f.history.status(f.id).reason, 'run-unresolved');
    assert.ok(f.order.indexOf('record-requests') < f.order.indexOf('lease-release'));
    assert.ok(f.order.indexOf('lease-release') < f.order.indexOf('finish-permit'));
    assert.ok(f.order.indexOf('finish-permit') < f.order.indexOf('audit-terminal'));
    assert.equal(f.meter.sends, 0); assert.equal(f.meter.followups, 1);
    assert.equal(f.runtime.getState({ kind: 'task', sessionId: f.id }).channel.messagingEnabled, false);
    await assert.rejects(Promise.resolve().then(() => f.history.review(f.id)), error => error.code === 'share-forbidden');

    const afterDrain = await bounded(sameAccount.poll(), 'same-account poll after drain');
    assert.equal(afterDrain.ok, true); assert.equal(sameAccount.meter.updates, 1);
  } finally {
    controller.abort(); f.finishNativeTurn();
    if (pending) await pending;
    await Promise.all([f.dispose(), sameAccount.dispose(), otherAccount.dispose()]);
  }
});

test('ordinary single-text cancellation keeps the existing bounded return path', async () => {
  const f = fixture({ historical: false }), controller = new AbortController();
  let pending;
  try {
    await f.prepare(); await f.shareOrdinary();
    pending = f.poll(undefined, controller.signal);
    await bounded(f.entered.promise, 'ordinary input admission'); controller.abort();
    const result = await bounded(pending, 'ordinary bounded cancellation');
    assert.deepEqual(result, { ok: false, error: { code: 'CANCELLED' } });
    assert.equal(f.meter.turnActive, true, 'the ordinary RPC still returns before its synthetic late turn/end');
    assert.equal(f.meter.sealedRequests, 0); assert.equal(f.meter.finishes, 0);
    assert.equal(f.terminalEvents().length, 0); assert.equal(f.meter.sends, 0);
  } finally {
    controller.abort(); f.finishNativeTurn();
    if (pending) await pending;
    await f.dispose();
  }
});

test('a shared matching history Consent is spent when SDK readiness fails before reservation admission', async () => {
  const f = fixture();
  try {
    await f.prepare(); const consentId = await f.approveHistory();
    assert.equal(f.history.status(f.id).sharingConfirmed, true);
    f.setSdkReady(false);
    const result = await bounded(f.poll(consentId), 'pre-reserve SDK readiness refusal');
    assert.deepEqual(result, { ok: false, error: { code: 'SHARED_CONTEXT_DENIED' } });
    const state = f.history.status(f.id), terminal = state.receipts.find(receipt => receipt.operation === 'terminal');
    assert.equal(state.consentId, null); assert.equal(state.sharingConfirmed, false); assert.equal(state.executable, false);
    assert.equal(f.runtime.getState({ kind: 'task', sessionId: f.id }).task.allowWechat, false);
    assert.ok(terminal); assert.equal(terminal.consentId, consentId); assert.equal(terminal.runOutcome, 'blocked');
    assert.equal(terminal.requestAccepted, 0); assert.equal(terminal.modelRequestsReserved, 0);
    assert.equal(terminal.permissionRevoked, true); assert.equal(terminal.sharingClosed, true); assert.equal(terminal.auditOutcome, 'committed');
    assert.equal(f.terminalEvents().length, 1); assert.equal(f.terminalEvents()[0].outcome, 'blocked');
    assert.equal(f.terminalEvents()[0].modelRequestsReserved, 0);
    assert.equal(f.meter.updates, 0); assert.equal(f.meter.followups, 0); assert.equal(f.meter.sealedRequests, 0); assert.equal(f.meter.sends, 0);

    f.setSdkReady(true);
    const reused = await bounded(f.poll(consentId), 'spent-Consent reuse refusal');
    assert.deepEqual(reused, { ok: false, error: { code: 'SHARED_CONTEXT_DENIED' } });
    assert.equal(f.history.status(f.id).consentId, null); assert.equal(f.history.status(f.id).sharingConfirmed, false);
    assert.equal(f.meter.updates, 0); assert.equal(f.meter.followups, 0); assert.equal(f.meter.sends, 0);
  } finally { await f.dispose(); }
});

test('an actual updates parsing failure is blocked before inbox, model and send work and requires fresh Consent', async () => {
  const f = fixture({ updatesFailure: true });
  let cold;
  try {
    await f.prepare(); const consentId = await f.approveHistory();
    const result = await bounded(f.poll(consentId), 'updates parsing failure');
    assert.deepEqual(result, { ok: false, error: { code: 'WECHAT_RESPONSE_INVALID' } });
    assert.deepEqual(f.meter.pollError, { code: 'api-failed', deliveryUnknown: false, apiErrorCode: 'invalid-response', actual: true });
    assert.equal(f.meter.updates, 1); assert.equal(f.meter.transports, 1); assert.equal(f.meter.commits, 0);
    assert.equal(f.meter.followups, 0); assert.equal(f.meter.sealedRequests, 0); assert.equal(f.meter.sends, 0);
    const stored = f.getChannelState();
    assert.equal(stored.cursor, ''); assert.equal(stored.queuedBatch, null); assert.equal(stored.pending, null);
    const state = f.history.status(f.id), terminal = state.receipts.find(receipt => receipt.operation === 'terminal');
    assert.ok(terminal); assert.equal(terminal.consentId, consentId); assert.equal(terminal.runOutcome, 'blocked');
    assert.equal(terminal.modelRequestsReserved, 0); assert.equal(terminal.requestAccepted, 0); assert.equal(terminal.auditOutcome, 'committed');
    assert.equal(terminal.permissionRevoked, true); assert.equal(terminal.sharingClosed, true);
    assert.equal(state.consentId, null); assert.equal(state.sharingConfirmed, false); assert.equal(state.executable, false);
    assert.notEqual(state.reason, 'run-unresolved');
    assert.equal(f.runtime.getState({ kind: 'task', sessionId: f.id }).task.allowWechat, false);
    assert.equal(f.terminalEvents().length, 1); assert.equal(f.terminalEvents()[0].outcome, 'blocked');

    const reused = await bounded(f.poll(consentId), 'spent updates-failure Consent refusal');
    assert.deepEqual(reused, { ok: false, error: { code: 'SHARED_CONTEXT_DENIED' } });
    assert.equal(f.meter.updates, 1); assert.equal(f.meter.sends, 0); assert.equal(f.terminalEvents().length, 1);
    const reviewed = await f.history.review(f.id); assert.equal(typeof reviewed.reviewId, 'string');
    assert.equal(f.history.status(f.id).consentId, null, 'a new review does not reinstate the old Consent');

    cold = createTaskHistoryAuthority(f.historyOptions);
    const restored = await cold.inspect(f.id), restoredTerminal = restored.receipts.find(receipt => receipt.operation === 'terminal');
    assert.ok(restoredTerminal); assert.equal(restoredTerminal.runId, terminal.runId); assert.equal(restoredTerminal.runOutcome, 'blocked');
    assert.equal(restoredTerminal.modelRequestsReserved, 0); assert.equal(restoredTerminal.requestAccepted, 0);
    assert.equal(restored.consentId, null); assert.equal(restored.sharingConfirmed, false); assert.equal(restored.executable, false);
    assert.notEqual(restored.reason, 'run-unresolved');
    await assert.rejects(Promise.resolve().then(() => cold.reserve(f.id, { historyConsentId: consentId,
      confirmation: 'poll-one-text-reply-with-reviewed-history' })), error => error.code === 'share-forbidden');
    assert.equal(typeof (await cold.review(f.id)).reviewId, 'string');
  } finally { await cold?.dispose(); await f.dispose(); }
});

for (const sendFailure of ['invalid-response', 'network-error', 'business-error']) {
  test('an actual send ' + sendFailure + ' remains unknown after the native model completes', async () => {
    const f = fixture({ sendFailure });
    let pending;
    try {
      await f.prepare(); const consentId = await f.approveHistory(); pending = f.poll(consentId);
      await bounded(f.entered.promise, 'native input before send failure'); f.finishNativeTurn({ completed: true });
      const result = await bounded(pending, 'historical send failure');
      const code = { 'invalid-response': 'WECHAT_RESPONSE_INVALID', 'network-error': 'WECHAT_NETWORK_FAILED', 'business-error': 'WECHAT_REQUEST_REJECTED' }[sendFailure];
      assert.deepEqual(result, { ok: false, error: { code } });
      assert.deepEqual(f.meter.pollError, { code: 'send-failed', deliveryUnknown: sendFailure !== 'business-error',
        apiErrorCode: sendFailure, actual: true });
      assert.equal(f.meter.updates, 1); assert.equal(f.meter.sends, 1); assert.equal(f.meter.transports, 1);
      assert.equal(f.meter.followups, 1); assert.equal(f.meter.sealedRequests, 1); assert.equal(f.meter.recordedRequests, 1);
      assert.equal(f.getChannelState().pending.phase, 'sending');
      const state = f.history.status(f.id), terminal = state.receipts.find(receipt => receipt.operation === 'terminal');
      assert.ok(terminal); assert.equal(terminal.runOutcome, 'unknown'); assert.equal(terminal.modelRequestsReserved, 1);
      assert.equal(terminal.requestAccepted, 0); assert.equal(terminal.auditOutcome, 'committed');
      assert.equal(terminal.permissionRevoked, true); assert.equal(terminal.sharingClosed, true); assert.equal(state.reason, 'run-unresolved');
      assert.equal(f.terminalEvents().length, 1); assert.equal(f.terminalEvents()[0].outcome, 'unknown');
      await assert.rejects(Promise.resolve().then(() => f.history.review(f.id)), error => error.code === 'share-forbidden');
    } finally {
      f.finishNativeTurn(); if (pending) await pending; await f.dispose();
    }
  });
}

for (const commitFailurePhase of ['inbox', 'sending', 'completed']) {
  test('a lost ' + commitFailurePhase + ' commit acknowledgement remains unknown and preserves accepted facts', async () => {
    const f = fixture({ commitFailurePhase });
    let pending, cold;
    try {
      await f.prepare(); const consentId = await f.approveHistory(); pending = f.poll(consentId);
      if (commitFailurePhase !== 'inbox') {
        await bounded(f.entered.promise, 'native input before commit failure'); f.finishNativeTurn({ completed: true });
      }
      const result = await bounded(pending, 'historical commit acknowledgement loss');
      assert.deepEqual(result, { ok: false, error: { code: 'ACTION_FAILED' } });
      assert.equal(f.meter.pollError.code, 'store-outcome-unknown'); assert.equal(f.meter.pollError.actual, true);
      assert.equal(f.meter.updates, 1); assert.equal(f.meter.transports, 0);
      const accepted = commitFailurePhase === 'completed' ? 1 : 0, reserved = commitFailurePhase === 'inbox' ? 0 : 1;
      assert.equal(f.meter.sends, accepted); assert.equal(f.meter.followups, reserved); assert.equal(f.meter.sealedRequests, reserved);
      const state = f.history.status(f.id), terminal = state.receipts.find(receipt => receipt.operation === 'terminal');
      assert.ok(terminal); assert.equal(terminal.runOutcome, 'unknown'); assert.equal(terminal.modelRequestsReserved, reserved);
      assert.equal(terminal.requestAccepted, accepted); assert.equal(terminal.auditOutcome, 'committed');
      assert.equal(terminal.permissionRevoked, true); assert.equal(terminal.sharingClosed, true); assert.equal(state.reason, 'run-unresolved');
      assert.equal(f.terminalEvents().length, 1); assert.equal(f.terminalEvents()[0].outcome, 'unknown');
      assert.equal(f.runtime.getState({ kind: 'task', sessionId: f.id }).channel.requestAccepted, accepted);
      cold = createTaskHistoryAuthority(f.historyOptions);
      const restored = await cold.inspect(f.id), restoredTerminal = restored.receipts.find(receipt => receipt.operation === 'terminal');
      assert.ok(restoredTerminal); assert.equal(restoredTerminal.runOutcome, 'unknown');
      assert.equal(restoredTerminal.requestAccepted, accepted); assert.equal(restoredTerminal.modelRequestsReserved, reserved);
      assert.equal(restored.consentId, null); assert.equal(restored.executable, false); assert.equal(restored.reason, 'run-unresolved');
      await assert.rejects(Promise.resolve().then(() => cold.review(f.id)), error => error.code === 'share-forbidden');
    } finally {
      f.finishNativeTurn(); if (pending) await pending; await cold?.dispose(); await f.dispose();
    }
  });
}

for (const pollFailure of [Object.assign(new Error('Synthetic api-failed lookalike'), { code: 'api-failed', deliveryUnknown: false }),
  new WeixinChannelError('api-failed', true, 'invalid-response')]) {
  test('a polled failure outside the trusted known updates boundary stays unknown: ' + pollFailure.name, async () => {
    const f = fixture({ pollFailure });
    try {
      await f.prepare(); const consentId = await f.approveHistory();
      assert.equal((await bounded(f.poll(consentId), 'untrusted or unknown poll failure')).ok, false);
      assert.equal(f.meter.updates, 0); assert.equal(f.meter.followups, 0); assert.equal(f.meter.sends, 0);
      const terminal = f.history.status(f.id).receipts.find(receipt => receipt.operation === 'terminal');
      assert.ok(terminal); assert.equal(terminal.runOutcome, 'unknown'); assert.equal(terminal.modelRequestsReserved, 0);
      assert.equal(terminal.requestAccepted, 0); assert.equal(terminal.auditOutcome, 'committed');
      assert.equal(f.history.status(f.id).reason, 'run-unresolved');
    } finally { await f.dispose(); }
  });
}

test('a read-only update diagnostic preserves an unresolved zero-request terminal and all source authority', async () => {
  const f = fixture({ updatesFailure: true, pollFailure: Object.assign(new Error('Historical public failure without trusted stage'), { code: 'api-failed' }) });
  let cold;
  try {
    await f.prepare(); const consentId = await f.approveHistory();
    assert.equal((await f.poll(consentId)).ok, false);
    const before = f.history.status(f.id), audit = f.getAudit(), channel = f.getChannelState();
    assert.equal(before.reason, 'run-unresolved'); assert.equal(before.receipts.find(receipt => receipt.operation === 'terminal').runOutcome, 'unknown');
    const diagnostic = await f.diagnose();
    assert.equal(diagnostic.ok, true, JSON.stringify(diagnostic));
    assert.equal(diagnostic.result.diagnostic.outcome, 'invalid'); assert.equal(diagnostic.result.diagnostic.validationField, 'msgs');
    assert.equal(f.meter.transports, 1); assert.equal(f.meter.updates, 0); assert.equal(f.meter.commits, 0);
    assert.equal(f.meter.followups + f.meter.sealedRequests + f.meter.sends, 0);
    assert.deepEqual(f.history.status(f.id), before); assert.deepEqual(f.getAudit(), audit); assert.deepEqual(f.getChannelState(), channel);
    assert.equal(diagnostic.state.task.allowWechat, false); assert.equal(diagnostic.state.channel.messagingEnabled, false);
    cold = createTaskHistoryAuthority(f.historyOptions);
    const restored = await cold.inspect(f.id), terminal = restored.receipts.find(receipt => receipt.operation === 'terminal');
    assert.equal(restored.reason, 'run-unresolved'); assert.equal(restored.executable, false);
    assert.equal(terminal.runOutcome, 'unknown'); assert.equal(terminal.modelRequestsReserved, 0); assert.equal(terminal.requestAccepted, 0);
    assert.equal(terminal.runId, before.receipts.find(receipt => receipt.operation === 'terminal').runId);
  } finally { await cold?.dispose(); await f.dispose(); }
});

test('a post-accept status refresh refusal preserves the known accepted count in the historical terminal', async () => {
  const f = fixture({ statusFailureAfterSend: true }), controller = new AbortController();
  const text = 'Synthetic completed post-accept status failure reply.';
  let pending;
  try {
    await f.prepare(); const consentId = await f.approveHistory();
    pending = f.poll(consentId, controller.signal);
    await bounded(f.entered.promise, 'successful historical input admission');
    f.finishNativeTurn({ completed: true, text });
    const result = await bounded(pending, 'post-accept status refresh failure');
    assert.deepEqual(result, { ok: false, error: { code: 'ACTION_FAILED' } });
    assert.equal(f.meter.statusRefreshFailures, 1, 'the injected refusal is after the actual Channel accepted a reply');
    assert.equal(f.meter.sends, 1); assert.equal(f.meter.sentText, text); assert.equal(f.meter.updates, 1);
    assert.equal(f.meter.followups, 1); assert.equal(f.meter.sealedRequests, 1); assert.equal(f.meter.recordedRequests, 1);
    assert.equal(f.meter.leaseReleased, true); assert.equal(f.meter.nativePending, false);
    const terminal = f.history.status(f.id).receipts.find(receipt => receipt.operation === 'terminal');
    assert.ok(terminal); assert.equal(terminal.consentId, consentId); assert.equal(terminal.requestAccepted, 1);
    assert.equal(terminal.modelRequestsReserved, 1); assert.equal(terminal.auditOutcome, 'committed');
    assert.equal(terminal.permissionRevoked, true); assert.equal(terminal.sharingClosed, true);
    assert.equal(f.terminalEvents().length, 1); assert.equal(f.terminalEvents()[0].requestAccepted, 1);
    assert.equal(f.terminalEvents()[0].modelRequestsReserved, 1);
    const state = f.runtime.getState({ kind: 'task', sessionId: f.id });
    assert.equal(state.channel.requestAccepted, 1);
    assert.equal(state.channel.messagingVerified, false, 'API acceptance is not proof of delivery to a phone');
    assert.equal(state.channel.messagingEnabled, false); assert.equal(state.task.allowWechat, false);
  } finally {
    controller.abort(); f.finishNativeTurn();
    if (pending) await pending;
    await f.dispose();
  }
});
