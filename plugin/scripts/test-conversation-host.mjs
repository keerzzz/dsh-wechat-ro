#!/usr/bin/env node
import { homedir as desktopHome } from 'node:os';
import { resolve as desktopPath } from 'node:path';
// Coordinator isolation tests plus controlled public-SDK Session/scope carriers.
// Native Agent/SQLite/UI also have separate real-SDK suites.
// Every credential, transport, domain and archive below is synthetic; no live action.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createConversationRuntime, requireConversationOwner, WechatConversationService } from '../lib/conversation-controller.js';
import { CONVERSATION_METHOD_NAMES, CONVERSATION_ACTION_NAMES, actionSchema, actionResultSchema, TASK_WIRE } from '../lib/conversation-wire.js';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import { createSessionBridge, SESSION_BRIDGE_PRESET_ID } from '../lib/session-bridge.js';
import { SESSION_BRIDGE_TOOL } from '../lib/session-bridge-agent.js';
import { createWeixinApi, WeixinApiError } from '../lib/weixin-api.js';
import { createWeixinChannel } from '../lib/weixin-channel.js';
const SID = 'wechat-native-ro-00000000-0000-4000-8000-000000000001';
const SID2 = 'wechat-native-ro-00000000-0000-4000-8000-000000000002';
const CONTEXT = 'synthetic-desktop-session';
const ROOT = '/tmp/SYNTHETIC_COORDINATOR_SNAPSHOT_NOT_READ';
const ORIGINAL = desktopPath(desktopHome(), 'Documents/xwechat_files');
let cases = 0;
const fixtures = [], carriers = [];
const watchedIo = { filesystem: 0, process: 0, network: 0 };
const restore = [];
function watch(object, names, kind) {
  for (const name of names) {
    const previous = object[name]; if (typeof previous !== 'function') continue;
    object[name] = () => { watchedIo[kind]++; throw new Error('UNEXPECTED_POST_IMPORT_' + kind.toUpperCase()); };
    restore.push(() => { object[name] = previous; });
  }
}
watch(fs, ['access', 'accessSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'realpath', 'realpathSync', 'open', 'openSync', 'readFile', 'readFileSync', 'readdir', 'readdirSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'mkdir', 'mkdirSync', 'createReadStream', 'createWriteStream'], 'filesystem');
watch(fs.promises, ['access', 'stat', 'lstat', 'realpath', 'open', 'readFile', 'readdir', 'writeFile', 'appendFile', 'unlink', 'rename', 'mkdir'], 'filesystem');
watch(childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'], 'process');
const previousFetch = globalThis.fetch;
globalThis.fetch = () => { watchedIo.network++; throw new Error('UNEXPECTED_LIVE_NETWORK'); };
restore.push(() => { globalThis.fetch = previousFetch; });
syncBuiltinESMExports();
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function test(label, fn) { await fn(); cases++; console.log('PASS ' + label); }
function abortError() { return Object.assign(new Error('synthetic cancelled'), { code: 'aborted' }); }
function untilAbort(signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(abortError()), { once: true }));
}
function fixture(options = {}) {
  const records = options.records || new Map();
  const counts = { open: 0, close: 0, writes: 0, markers: 0, credentialFactory: 0, apiFactory: 0,
    qrRequests: 0, polls: 0, discard: 0, forget: 0, cancelledQr: 0, queries: 0, originalAccesses: 0, metadataReads: 0, ensures: 0 };
  const events = [], grants = new Map(), prepared = new Set([SID, SID2]);
  let hooks;
  const table = {
    get size() { return records.size; }, get: id => records.get(id),
    put: async (id, value) => { counts.writes++; events.push('put'); if (options.putError) throw options.putError; if (options.putBarrier) await options.putBarrier.promise; records.set(id, value); },
    update: async (id, transform) => {
      counts.markers++; events.push('marker');
      if (options.markerFails) throw new Error('SYNTHETIC_PRIVATE_PERSISTENCE_TEXT');
      if (options.markerBarrier) await options.markerBarrier.promise;
      const value = transform(records.get(id)); records.set(id, value); return value;
    },
  };
  const archive = {
    getState(id) { const grant = grants.get(id); const known = hooks.hasArchiveHistory(id); return {
      granted: Boolean(grant), allowWechat: Boolean(grant?.allowWechat), allConversations: Boolean(grant?.allConversations),
      talkers: grant?.talkers || [], fromTs: grant?.fromTs ?? null, toTs: grant?.toTs ?? null,
      historyKnown: known !== 'unknown', sessionMayContainArchiveData: known === true,
      shareable: archive.canShare(id), formatVerified: false,
    }; },
    canShare(id) { const known = hooks.hasArchiveHistory(id); return known !== 'unknown' && (known === false || grants.get(id)?.allowWechat === true); },
    async grant(id, grant, signal) { if (signal?.aborted) throw abortError(); grants.set(id, grant); return archive.getState(id); },
    revoke(id) { grants.delete(id); return archive.getState(id); },
    async query(id, query, signal, destination) {
      counts.queries++; assert.equal(destination, 'local');
      if (!grants.has(id)) throw Object.assign(new Error('private'), { code: 'not-granted' });
      await hooks.markArchiveHistory(id);
      if (options.queryBarrier) await options.queryBarrier.promise;
      if (signal?.aborted || !grants.has(id)) throw abortError();
      return { action: query.action, rows: [{ content: 'SYNTHETIC_ROW', untrusted: true }], source: { snapshotRef: 'synthetic-only' }, untrusted: true };
    },
    async dispose() { grants.clear(); events.push('archive-dispose'); },
  };
  let bridge = {
    isPrepared: id => prepared.has(id),
    async ensure(id, signal) { counts.ensures++; if (signal?.aborted) throw abortError(); if (!prepared.has(id)) throw Object.assign(new Error('private'), { code: 'not-prepared' }); },
    async createConversation(contextId) { assert.equal(contextId, CONTEXT); events.push('create'); createStarted.resolve();
      if (options.creationBarrier) await options.creationBarrier.promise;
      if (options.creationError) throw options.creationError;
      if (options.creationFailsOnce && events.filter(x => x === 'create').length === 1) throw new Error('SYNTHETIC_CREATE_FAILURE');
      return options.newSid || SID; },
    async reply() { throw new Error('Synthetic test never runs an LLM'); },
    async dispose() { events.push('bridge-dispose'); },
  };
  const identityStarted = deferred(), pollStarted = deferred(), createStarted = deferred(), recoveryRead = deferred();
  const deps = {
    createArchiveAccess(config) { hooks = config; assert.equal(typeof config.hasArchiveHistory, 'function'); assert.equal(typeof config.markArchiveHistory, 'function'); return archive; },
    createSessionBridge(ctx, config) {
      assert.equal(config.archive, archive);
      if (options.bridgeFactory) {
        const provider = options.bridgeFactory(ctx, config);
        bridge = { ...provider, ensure: async (id, signal) => { counts.ensures++; await provider.ensure(id, signal); } };
      }
      return bridge;
    },
    storageDomain: { async open(spec) { counts.open++; events.push('open'); assert.equal(spec.name, 'wechat_native_ro_history_v1');
      if (options.openError) throw options.openError;
      return { table(name) { assert.equal(name, 'sessions'); return table; }, async close() { counts.close++; events.push('close'); } }; } },
    credentials: {}, fetcher() { throw new Error('Synthetic test never invokes fetch'); },
    createStateStore(credentials, sid) { counts.credentialFactory++; assert.ok([SID, SID2].includes(sid)); return options.stateStore || {}; },
    createApi() { counts.apiFactory++; return options.realApi || {}; },
    createChannel(config) {
      assert.ok([SID, SID2].includes(config.sessionId)); assert.equal(config.enabled, true); assert.equal(typeof config.beforeSend, 'function');
      if (options.realApi) return createWeixinChannel(config);
      let phase = 'paired', operating = false, pendingRecovery = false;
      async function op(fn) {
        assert.equal(operating, false, 'single-operation channel must never overlap'); operating = true;
        try { return await fn(); } finally { operating = false; }
      }
      return {
        getStatus: () => op(async () => { const status = { enabled: true, phase, hasStoredLogin: phase === 'paired', pendingRecovery }; if (pendingRecovery) recoveryRead.resolve(); return status; }),
        cancelLogin: () => op(async () => { counts.cancelledQr++; }),
        beginLogin: () => op(async () => { counts.qrRequests++; phase = 'qr-ready'; return { qrContent: 'SYNTHETIC_LOCAL_QR_PAYLOAD' }; }),
        pollLoginForOwner: () => op(async () => ({ status: 'confirmed', expectedOwnerId: 'synthetic-owner', botId: 'synthetic-bot' })),
        confirmPairingForOwner: owner => op(async () => { if (owner !== 'synthetic-owner') throw Object.assign(new Error('SYNTHETIC_PRIVATE_OWNER'), { code: 'owner-mismatch' }); phase = 'paired'; return { paired: true }; }),
        getPairingIdentity: signal => op(async () => { identityStarted.resolve(); if (options.identityBarrier) { await options.identityBarrier.promise; if (signal?.aborted) throw abortError(); }
          return { botId: options.account || 'synthetic-bot', userId: 'synthetic-owner' }; }),
        pollOnce: signal => op(async () => { counts.polls++; events.push('poll'); pollStarted.resolve(); if (options.pollFailure) { pendingRecovery = true; throw Object.assign(new Error('synthetic-poll-failure'), { code: 'api-failed' }); } return untilAbort(signal); }),
        discardPending: confirmation => op(async () => { assert.equal(confirmation, 'discard-without-retry'); counts.discard++; events.push('discard'); }),
        forget: confirmation => op(async () => { assert.equal(confirmation, 'forget-local-credentials'); counts.forget++; phase = 'unpaired'; }),
        dispose() { assert.equal(operating, false, 'dispose must drain operations'); events.push('channel-dispose'); },
      };
    },
    prepareQr: async () => { events.push('encoder-ready'); if (options.qrFails) throw Object.assign(new Error('SYNTHETIC_PRIVATE_QR_ERROR'), { code: 'QR_UNAVAILABLE' });
      return payload => { assert.equal(payload, 'SYNTHETIC_LOCAL_QR_PAYLOAD'); return { rows: Array(21).fill('0'.repeat(21)), payloadKind: 'ilink-login' }; }; },
  };
  const liveSessions = options.liveSessions || new Map();
  const ctx = options.ctx || { sessions: { get(id) { counts.metadataReads++; return liveSessions.get(id); } } };
  const runtime = createConversationRuntime(ctx, { sourceRoot: ORIGINAL, maxRows: 500 }, deps);
  const f = { runtime, counts, events, records, grants, archive, bridge, liveSessions, identityStarted, pollStarted, createStarted, recoveryRead };
  fixtures.push(f); return f;
}
// No persistence plugin or AgentLoop: the native log/scope are real public SDK
// objects, while agent factories, preset services, archive and stores are controlled.
// The real Bridge owns its own fresh map and performs its actual history/policy proof.
async function controlledCarrier() {
  const base = new Context();
  const stored = new Map(), liveAgents = new Map(), sessions = new Map(), compositions = new WeakMap(), handles = new Set();
  const calls = { creates: 0, resumes: 0, flushes: 0, disposes: 0, sends: 0, contextHistory: 0,
    serviceReads: 0, sessionReads: 0, agentReads: 0, mounts: 0, policies: 0 };
  const controls = { resumeBarrier: null, resumeStarted: deferred(), pendingInputs: [] };
  const cwd = '/synthetic/controlled-native-conversation';
  const ordinary = { id: CONTEXT, header: Object.freeze({ id: CONTEXT, cwd, agentPreset: 'synthetic-ordinary-preset' }),
    authorization: Object.freeze({ syntheticOnly: true }),
    snapshotEvents() { calls.contextHistory++; throw new Error('Ordinary history must not be read or copied.'); } };
  sessions.set(CONTEXT, ordinary);
  const sandboxPolicy = { resolve({ session }) {
    const modes = session.snapshotEvents().filter(event => event.type === 'sandbox/mode');
    return { mode: modes.at(-1)?.data.mode || 'danger-full-access' };
  } };
  const agentPresets = {
    async resolve(id) { assert.equal(id, SESSION_BRIDGE_PRESET_ID); return { id }; },
    async mount(ctx, id) { assert.equal(id, SESSION_BRIDGE_PRESET_ID); calls.mounts++; compositions.set(ctx, id); },
    composedPreset: ctx => compositions.get(ctx),
  };
  async function factory(options, fresh) {
    const id = fresh ? options.sessionId : options.resumeSessionId;
    assert.deepEqual(Object.keys(options).sort(), fresh
      ? ['meta', 'sessionId', 'setup', 'signal'] : ['resumeSessionId', 'setup', 'signal']);
    if (fresh) {
      calls.creates++;
      assert.deepEqual(options.meta, { cwd, agentPreset: SESSION_BRIDGE_PRESET_ID });
    } else {
      calls.resumes++; controls.resumeStarted.resolve(id);
      if (controls.resumeBarrier) await Promise.race([controls.resumeBarrier.promise, untilAbort(options.signal)]);
    }
    if (options.signal?.aborted) throw abortError();
    const saved = stored.get(id);
    if (!fresh && !saved) throw new Error('SYNTHETIC_PRIVATE_MISSING_SESSION');
    const header = fresh ? { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, ...options.meta } : saved.header;
    const session = Session.create(SessionId(id), fresh ? [] : saved.events, header);
    const scope = createScope(base, {}), agentCtx = scope.ctx, definitions = new Map();
    const disposer = () => {};
    const tools = {
      restrict(value) { assert.deepEqual(value, { allow: [] }); calls.policies++; return disposer; },
      guard(value) { assert.equal(typeof value, 'function'); return disposer; },
      presentAs(value) { assert.equal(value, 'native'); return disposer; },
      register(definition) { assert.equal(definition.name, SESSION_BRIDGE_TOOL); definitions.set(definition.name, definition);
        return () => definitions.delete(definition.name); },
      get(name, key) { assert.equal(key, scopeOf(agentCtx)); return definitions.get(name); },
    };
    const systemPrompt = { section(value) { assert.equal(value.complete, true); assert.equal(value.interpolate, false); return disposer; } };
    const inheritedGet = agentCtx.get.bind(agentCtx);
    Object.defineProperty(agentCtx, 'get', { value: name => name === 'tools' ? tools : name === 'systemPrompt' ? systemPrompt : inheritedGet(name) });
    const inbox = { nextTurn: [...controls.pendingInputs], nextStep: [], remove(id) {
      inbox.nextTurn = inbox.nextTurn.filter(message => message.id !== id);
      inbox.nextStep = inbox.nextStep.filter(message => message.id !== id);
    } };
    const agent = { session, ctx: agentCtx, inbox, send() { calls.sends++; throw new Error('Carrier must not run a model.'); } };
    let disposed = false;
    const handle = { agent, async dispose() {
      if (disposed) return; disposed = true; calls.disposes++; handles.delete(handle);
      if (liveAgents.get(id) === agent) liveAgents.delete(id);
      if (sessions.get(id) === session) sessions.delete(id);
      await scope.dispose();
    } };
    handles.add(handle);
    try { await options.setup(agentCtx, agent); } catch (error) { await handle.dispose(); throw error; }
    liveAgents.set(id, agent); sessions.set(id, session);
    return handle;
  }
  const agents = {
    get(id) { calls.agentReads++; return liveAgents.get(id); },
    create: options => factory(options, true), resume: options => factory(options, false),
  };
  const sessionService = {
    get(id) { calls.sessionReads++; return sessions.get(id); },
    async flush(session) { calls.flushes++; stored.set(session.id, { header: session.header, events: [...session.snapshotEvents()] }); return true; },
  };
  const services = { agents, sessions: sessionService, agentPresets, sandboxPolicy };
  const ctx = { sessions: sessionService, get(name) { calls.serviceReads++; return services[name]; } };
  const records = new Map();
  const carrier = { calls, controls, stored, liveAgents, sessions, compositions, ordinary, records,
    newRuntime: options => fixture({ ...options, ctx, records, liveSessions: sessions, bridgeFactory: createSessionBridge }),
    save(id, headerOverrides = {}, modes = ['read-only'], forbiddenTool) {
      const header = { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd, agentPreset: SESSION_BRIDGE_PRESET_ID, ...headerOverrides };
      const session = Session.create(SessionId(id), [], header);
      for (const mode of modes) session.append('sandbox/mode', { mode });
      if (forbiddenTool) session.append('tool/call', { callId: 'synthetic-forbidden-tool', name: forbiddenTool, arguments: '{}' });
      stored.set(id, { header: session.header, events: [...session.snapshotEvents()] });
      return session;
    },
    async dispose() { for (const handle of [...handles]) await handle.dispose(); await base.fiber.dispose(); },
  };
  carriers.push(carrier); return carrier;
}
const TASK_SID = 'wechat-task-00000000-0000-4000-8000-000000000001';
const TASK_WORKSPACE = '/tmp/SYNTHETIC_TASK_WORKSPACE_NOT_READ';
const TASK_EXTRA = '/tmp/SYNTHETIC_TASK_EXTRA_NOT_READ';
const DIAGNOSTIC_EMPTY = { version: 1, outcome: 'valid', errorCode: null, validationField: null, msgsShape: 'array', cursorShape: 'string',
  messageCount: 0, textCount: 0, ignoredCount: 0, httpStatus: 200, businessCode: null };
function taskFixture(options = {}) {
  const counts = { dataConstructors: 0, bridgeConstructors: 0, creates: 0, ensures: 0, workspaces: 0, directories: 0,
    sessions: 0, snapshots: 0, revokes: 0, shareChanges: 0, queries: 0, files: 0, replies: 0, legacyReplies: 0,
    oldOpen: 0, oldWrites: 0, oldGrants: 0, oldQueries: 0, metadataReads: 0, credentialFactory: 0,
    apiFactory: 0, channelFactory: 0, polls: 0, textPolls: 0, resumePolls: 0, continuedReplies: 0, sends: 0, diagnostics: 0, dataDisposes: 0, bridgeDisposes: 0, rosterReads: 0 };
  const events = [], oldRecords = new Map(), oldGrants = new Map(), taskRecords = new Map(), channels = [], rosterRequests = [];
  const pending = new Set(), createStarted = deferred(), queryStarted = deferred(), grantStarted = deferred(), rosterStarted = deferred();
  const pollStarted = deferred(), identityStarted = deferred(), replySettled = deferred(), diagnosticStarted = deferred();
  const foreignId = 'wechat-task-00000000-0000-4000-8000-000000000099';
  const foreign = Object.freeze({ header: Object.freeze({ id: foreignId, cwd: TASK_WORKSPACE, agentPreset: 'dsh-wechat-task-v1' }),
    dispose() { throw new Error('A Task coordinator must never tear down this foreign Session.'); } });
  const liveSessions = new Map([[CONTEXT, { header: Object.freeze({ id: CONTEXT, cwd: TASK_WORKSPACE }) }], [foreignId, foreign]]);
  let oldHooks, sourceGeneration = 0, dataDisposed = false, bridgeDisposed = false;
  function check(signal) { if (signal?.aborted) throw abortError(); }
  function entry(id) {
    assert.equal(id, TASK_SID, 'only the explicitly selected synthetic Task may acquire data');
    let record = taskRecords.get(id);
    if (!record) { record = { prepared: false, workspace: null, sources: new Map(), consumed: new Map(), share: false }; taskRecords.set(id, record); }
    return record;
  }
  function source(record, sourceId, value) { record.sources.set(sourceId, { ...value, sourceId, generation: ++sourceGeneration }); }
  function shareable(record) {
    return !dataDisposed && record.prepared && record.share && record.sources.has('workspace')
      && [...record.consumed.values()].every(item => record.sources.get(item.sourceId)?.generation === item.generation
        && record.sources.get(item.sourceId)?.allowWechat === true);
  }
  function state(id) {
    const record = entry(id);
    return { version: 1, sessionId: id, disposed: dataDisposed, prepared: !dataDisposed && record.prepared,
      historyKnown: record.prepared, workspace: record.workspace, allowWechat: !dataDisposed && record.share,
      shareable: shareable(record), sessionMayContainData: record.consumed.size > 0,
      contextBlocked: !record.prepared || [...record.consumed.values()].some(item => record.sources.get(item.sourceId)?.generation !== item.generation),
      sources: dataDisposed ? [] : [...record.sources.values()].map(({ generation, ...value }) => value), lastError: null };
  }
  function tracked(operation) {
    pending.add(operation); operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
  }
  const data = {
    async grantWorkspace(id, request, signal) {
      check(signal); assert.equal(request.confirmation, 'read-and-write-task-workspace'); assert.equal(request.root, TASK_WORKSPACE);
      counts.workspaces++; const record = entry(id); record.workspace = { id: 'synthetic-task-workspace', root: request.root, title: request.title };
      source(record, 'workspace', { kind: 'directory', root: request.root, title: request.title, write: true, allowWechat: request.allowWechat });
      return state(id);
    },
    grantDirectory(id, request, signal) {
      counts.directories++; grantStarted.resolve(); assert.equal(request.confirmation, 'read-task-directory'); assert.equal(request.root, TASK_EXTRA);
      return tracked((async () => {
        if (options.grantBarrier) await options.grantBarrier.promise;
        check(signal); const record = entry(id);
        source(record, request.sourceId || 'synthetic-extra-source', { kind: 'directory', root: request.root, title: request.title, write: false, allowWechat: request.allowWechat });
        return state(id);
      })());
    },
    grantSession(id, request) {
      assert.equal(request.confirmation, 'read-task-session'); assert.equal(request.sessionId, 'synthetic-source-session');
      assert.deepEqual(Object.keys(request).sort(), ['allowWechat', 'confirmation', 'sessionId', 'title']);
      counts.sessions++; const record = entry(id);
      source(record, 'synthetic-session-source', { kind: 'session', sessionId: request.sessionId, title: request.title, allowWechat: request.allowWechat });
      return state(id);
    },
    async grantSnapshot(id, request, signal) {
      check(signal); assert.equal(request.confirmation, 'read-decrypted-snapshot'); assert.equal(request.root, ROOT); counts.snapshots++;
      const record = entry(id);
      source(record, 'archive', { kind: 'archive', title: 'Synthetic archive', allowWechat: request.allowWechat,
        archive: { granted: true, talkers: request.talkers, allConversations: request.allConversations,
          fromTs: request.fromTs, toTs: request.toTs, allowWechat: request.allowWechat } });
      return state(id);
    },
    revoke(id, sourceId) { counts.revokes++; const record = entry(id); record.sources.delete(sourceId); return state(id); },
    revokeAll(id) { const record = entry(id); record.sources.clear(); record.share = false; return state(id); },
    setSharing(id, request) {
      assert.equal(request.confirmation, 'share-whole-task-context'); counts.shareChanges++; entry(id).share = request.allowWechat; return state(id);
    },
    getState: state,
    canShare: id => shareable(entry(id)),
    getWorkspace: id => entry(id).workspace,
    async prepare(id) { entry(id).prepared = true; },
    query(id, query, signal, destination) {
      assert.equal(destination, 'local'); counts.queries++; queryStarted.resolve();
      if (query.action === 'status') return Promise.resolve({ action: 'status', untrusted: true });
      const record = entry(id), sourceId = query.action === 'archive' ? 'archive' : query.sourceId;
      const value = record.sources.get(sourceId); assert.ok(value, 'query must bind a currently authorized source');
      record.consumed.set(sourceId + ':' + value.generation, { sourceId, generation: value.generation });
      return tracked((async () => {
        if (options.queryBarrier) await options.queryBarrier.promise;
        else check(signal);
        return { action: query.action, untrusted: true, rows: [{ text: 'SYNTHETIC_LATE_TASK_ROW' }], returned: 1, hasMore: false };
      })());
    },
    async file(id, request, signal, destination) {
      check(signal); assert.equal(destination, 'local'); assert.ok(['list', 'read'].includes(request.action)); counts.files++;
      const record = entry(id), sourceId = request.sourceId || 'workspace', value = record.sources.get(sourceId); assert.ok(value);
      record.consumed.set(sourceId + ':' + value.generation, { sourceId, generation: value.generation });
      return { action: request.action, untrusted: true, rows: [{ name: 'synthetic-document.md' }], text: 'SYNTHETIC_TASK_FILE' };
    },
    async dispose() { if (dataDisposed) return; dataDisposed = true; counts.dataDisposes++; events.push('task-data-dispose');
      for (const record of taskRecords.values()) { record.sources.clear(); record.share = false; } await Promise.allSettled([...pending]); },
  };
  const taskBridge = {
    createConversation(contextId, workspaceRequest, signal) {
      assert.equal(contextId, CONTEXT); counts.creates++; createStarted.resolve();
      return tracked((async () => {
        try {
          await data.grantWorkspace(TASK_SID, workspaceRequest, signal);
          if (options.creationBarrier) await options.creationBarrier.promise;
          check(signal); entry(TASK_SID).prepared = true; return TASK_SID;
        } catch (error) { data.revokeAll(TASK_SID); throw error; }
      })());
    },
    async ensure(id, signal) { check(signal); assert.equal(id, TASK_SID); counts.ensures++; entry(id).prepared = true; },
    isPrepared: id => id === TASK_SID && !bridgeDisposed && taskRecords.get(id)?.prepared === true,
    async reply(id, text, metadata, signal) { check(signal); assert.equal(id, TASK_SID); assert.equal(text, 'SYNTHETIC_TASK_PHONE_INPUT');
      assert.deepEqual(metadata, { messageId: options.realApi ? '1' : 'synthetic-task-phone-message' }); counts.replies++; return 'SYNTHETIC_TASK_REPLY'; },
    async continueReply(id, text, metadata, signal) {
      check(signal); assert.equal(id, TASK_SID); assert.equal(text, 'SYNTHETIC_TASK_PHONE_INPUT');
      assert.deepEqual(metadata, { messageId: 'synthetic-retained-message' }); counts.continuedReplies++; events.push('task-continue-reply');
      if (options.continueBarrier) await Promise.race([options.continueBarrier.promise, untilAbort(signal)]);
      check(signal); return 'SYNTHETIC_CONTINUED_TASK_REPLY';
    },
    async dispose() { if (bridgeDisposed) return; bridgeDisposed = true; counts.bridgeDisposes++; events.push('task-bridge-dispose');
      for (const record of taskRecords.values()) record.prepared = false; await Promise.allSettled([...pending]); },
  };
  const archive = {
    getState(id) { const granted = oldGrants.get(id), known = oldHooks.hasArchiveHistory(id);
      return { granted: Boolean(granted), allowWechat: Boolean(granted?.allowWechat), historyKnown: known !== 'unknown',
        sessionMayContainArchiveData: known === true, shareable: false, talkers: granted?.talkers || [], fromTs: granted?.fromTs ?? null, toTs: granted?.toTs ?? null }; },
    canShare: () => false,
    async grant(id, request, signal) { check(signal); counts.oldGrants++; oldGrants.set(id, request); return archive.getState(id); },
    revoke(id) { oldGrants.delete(id); return archive.getState(id); },
    async query(id, request, signal, destination) { check(signal); assert.equal(destination, 'local'); counts.oldQueries++;
      await oldHooks.markArchiveHistory(id); return { action: request.action, untrusted: true, rows: [{ text: 'SYNTHETIC_OLD_ARCHIVE_ROW' }] }; },
    browseRoster(root, query, signal) {
      check(signal); assert.equal(root, ROOT); assert.equal(query.confirmation, 'browse-snapshot-roster');
      assert.ok(!Object.hasOwn(query, 'action')); counts.rosterReads++; rosterRequests.push({ ...query }); rosterStarted.resolve();
      return tracked((async () => {
        if (options.rosterBarrier) await options.rosterBarrier.promise;
        else check(signal);
        return { action: 'contacts', untrusted: true, rows: [{ talker: 'synthetic-talker', displayName: 'Synthetic contact' }], returned: 1,
          source: { kind: 'decrypted-wechat-archive', snapshotRef: '0123456789abcdef01234567' }, hasMore: false };
      })());
    },
    async dispose() { oldGrants.clear(); events.push('old-archive-dispose'); await Promise.allSettled([...pending]); },
  };
  const legacyBridge = { isPrepared: () => false, ensure() { throw new Error('Task operations must not ensure the old Bridge.'); },
    createConversation() { throw new Error('Task operations must not create the old Bridge.'); },
    reply() { counts.legacyReplies++; throw new Error('Task input must never use the old Bridge reply callback.'); },
    async dispose() { events.push('old-bridge-dispose'); } };
  const workspaceEntity = { id: 'synthetic-task-workspace', path: TASK_WORKSPACE, title: 'Synthetic workspace', sessionIds: [],
    async attachSession(id) { assert.equal(id, TASK_SID); } };
  const ctx = { sessions: { get(id) { counts.metadataReads++; return liveSessions.get(id); } },
    agents: {}, agentPresets: {}, sandboxPolicy: {}, fs: {},
    workspaceRegistry: { list: () => [workspaceEntity], get: id => id === workspaceEntity.id ? workspaceEntity : undefined,
      create: async () => workspaceEntity } };
  const deps = {
    ...(options.runLocalHistory ? { runLocalHistory: options.runLocalHistory } : {}),
    createArchiveAccess(hooks) { oldHooks = hooks; return archive; },
    createSessionBridge(_, config) { assert.equal(config.archive, archive); return legacyBridge; },
    createTaskAccess(context, config) { assert.equal(context, ctx); assert.equal(config.sourceRoot, ORIGINAL); assert.equal(typeof config.beforeArchiveQuery, 'function'); counts.dataConstructors++; return data; },
    createTaskSessionBridge(context, config) { assert.equal(context, ctx); assert.deepEqual(config, { data }); counts.bridgeConstructors++; return taskBridge; },
    storageDomain: { async open(spec) { counts.oldOpen++; assert.equal(spec.name, 'wechat_native_ro_history_v1');
      return { table(name) { assert.equal(name, 'sessions'); return { get size() { return oldRecords.size; }, get: id => oldRecords.get(id),
        async put(id, value) { counts.oldWrites++; oldRecords.set(id, value); },
        async update(id, transform) { counts.oldWrites++; const value = transform(oldRecords.get(id)); oldRecords.set(id, value); return value; } }; },
      async close() { events.push('old-domain-close'); } }; } },
    credentials: {}, fetcher() { throw new Error('Task fixture never uses live fetch.'); },
    createStateStore(_, id) { assert.equal(id, TASK_SID); counts.credentialFactory++; return options.stateStore || {}; },
    createApi() { counts.apiFactory++; return options.realApi || {}; },
    createChannel(config) {
      assert.equal(config.sessionId, TASK_SID); assert.equal(config.enabled, true); counts.channelFactory++; channels.push(config);
      if (options.realApi) return createWeixinChannel(config);
      let operating = false, resumeAvailable = options.resumeAvailable === true;
      async function op(work) { assert.equal(operating, false, 'Task channel operations cannot overlap'); operating = true;
        try { return await work(); } finally { operating = false; } }
      return { getStatus: () => op(async () => ({ enabled: true, phase: 'paired', hasStoredLogin: true,
          pendingRecovery: options.resumeAvailable === true ? resumeAvailable : false, resumeAvailable })),
        getPairingIdentity: signal => op(async () => { identityStarted.resolve(); if (options.identityBarrier) await options.identityBarrier.promise;
          check(signal); return { botId: options.account || 'synthetic-task-account', userId: 'synthetic-owner' }; }),
        pollOnce: signal => op(async () => { counts.polls++; events.push('task-poll'); pollStarted.resolve();
          if (options.driveReply) {
            try {
              const text = await config.reply('SYNTHETIC_TASK_PHONE_INPUT', { messageId: 'synthetic-task-phone-message' }, signal);
              assert.equal(text, 'SYNTHETIC_TASK_REPLY'); assert.equal(config.beforeSend(), true);
            } finally { replySettled.resolve(); }
          }
          return untilAbort(signal);
        }),
        pollTextOnce: options.withoutTextOnce ? undefined : signal => op(async () => {
          counts.textPolls++; events.push('task-text-once'); pollStarted.resolve();
          if (options.textBarrier) await Promise.race([options.textBarrier.promise, untilAbort(signal)]);
          check(signal);
          if (options.textFailure) throw Object.assign(new Error('synthetic-text-failure'), { code: 'api-failed' });
          if (options.textEmpty) return { received: 0, replied: 0, ignored: 0, duplicates: 0, remaining: 0 };
          assert.equal(config.beforeSend(), true, 'one-text sends require the account/run-generation permit');
          const text = await config.reply('SYNTHETIC_TASK_PHONE_INPUT', { messageId: 'synthetic-task-phone-message' }, signal);
          assert.equal(text, 'SYNTHETIC_TASK_REPLY');
          assert.equal(config.beforeSend(), true);
          return { received: 3, replied: 1, ignored: 0, duplicates: 0, remaining: 2 };
        }),
        resumeTextOnce: options.withoutResume ? undefined : (confirmation, signal) => op(async () => {
          assert.equal(confirmation, 'continue-unanswered-message'); assert.equal(resumeAvailable, true);
          counts.resumePolls++; events.push('task-resume-text'); pollStarted.resolve();
          check(signal);
          const reply = await config.resumeReply('SYNTHETIC_TASK_PHONE_INPUT', { messageId: 'synthetic-retained-message' }, signal);
          assert.equal(reply, 'SYNTHETIC_CONTINUED_TASK_REPLY'); check(signal);
          assert.equal(config.beforeSend(), true, 'continued reply retains the exact Task/account permit');
          counts.sends++; config.onTextAccepted(); resumeAvailable = false;
          return { received: 1, replied: 1, ignored: 0, duplicates: 0, remaining: 0 };
        }),
        diagnoseUpdatesOnce: options.withoutDiagnostics ? undefined : signal => op(async () => {
          counts.diagnostics++; diagnosticStarted.resolve();
          if (options.diagnosticBarrier) await Promise.race([options.diagnosticBarrier.promise, untilAbort(signal)]);
          check(signal);
          assert.equal(config.beforeSend(), false, 'diagnostic account ownership must never grant sending');
          return options.diagnosticResult;
        }),
        cancelLogin: () => op(async () => {}), beginLogin: () => op(async () => ({ qrContent: 'SYNTHETIC_TASK_QR' })),
        pollLoginForOwner: () => op(async () => ({ status: 'confirmed', expectedOwnerId: 'synthetic-owner' })),
        confirmPairingForOwner: owner => op(async () => { assert.equal(owner, 'synthetic-owner'); return { paired: true }; }),
        discardPending: confirmation => op(async () => { assert.equal(confirmation, 'discard-without-retry'); }),
        forget: confirmation => op(async () => { assert.equal(confirmation, 'forget-local-credentials'); }),
        dispose() { assert.equal(operating, false); events.push('task-channel-dispose'); } };
    },
    prepareQr: async () => () => ({ rows: Array(21).fill('0'.repeat(21)), payloadKind: 'ilink-login' }),
  };
  const runtime = createConversationRuntime(ctx, { sourceRoot: ORIGINAL, maxRows: 500 }, deps);
  const f = { runtime, counts, events, taskRecords, oldRecords, oldGrants, liveSessions, foreignId, foreign, data, taskBridge,
    channels, rosterRequests, createStarted, queryStarted, grantStarted, rosterStarted, pollStarted, identityStarted, replySettled, diagnosticStarted };
  fixtures.push(f); return f;
}
const taskCreate = (f, signal) => f.runtime.action({ kind: 'task', action: 'createConversation', contextSessionId: CONTEXT,
  workspace: { root: TASK_WORKSPACE, title: 'Synthetic task workspace', allowWechat: true, confirmation: 'read-and-write-task-workspace' } }, signal);
const taskAction = (f, action, shape = {}, signal) => f.runtime.action({ kind: 'task', action, sessionId: TASK_SID, ...shape }, signal);
const taskShare = (f, allowWechat = true) => taskAction(f, 'setSharing', { allowWechat, confirmation: 'share-whole-task-context' });
const taskStart = f => taskAction(f, 'startChannel', { allowSharedContext: true, confirmation: 'poll-and-reply' });
const taskTextOnce = (f, signal) => taskAction(f, 'pollTextOnce', { allowSharedContext: true, confirmation: 'poll-one-text-reply' }, signal);
const taskStop = f => taskAction(f, 'stopChannel', { confirmation: 'stop-channel' });
const create = f => f.runtime.action({ action: 'createConversation', contextSessionId: CONTEXT, confirmation: 'create-readonly-conversation' });
const resume = (f, sid = SID, signal) => f.runtime.action({ action: 'resumeConversation', sessionId: sid, confirmation: 'resume-readonly-conversation' }, signal);
const grant = (f, allowWechat = false) => f.runtime.action({ action: 'grantSnapshot', sessionId: SID, root: ROOT,
  allConversations: false, talkers: ['synthetic-talker'], fromTs: null, toTs: null, allowWechat, confirmation: 'read-decrypted-snapshot' });
const start = (f, sid = SID) => f.runtime.action({ action: 'startChannel', sessionId: sid, allowSharedContext: true, confirmation: 'poll-and-reply' });
const stop = f => f.runtime.action({ action: 'stopChannel', sessionId: SID, confirmation: 'stop-channel' });
const revoke = f => f.runtime.action({ action: 'revokeSnapshot', sessionId: SID, confirmation: 'revoke-snapshot' });
try {
  await test('canonical owner required; outside/guest/request-actor cannot authorize', () => {
    for (const invocation of [undefined, null, {}, { owner: true }, { actor: 'owner' }, { peer: { principal: { kind: 'guest' } } }, { peer: {} }])
      assert.throws(() => requireConversationOwner(invocation), error => error.code === 'NOT_AUTHORIZED');
    requireConversationOwner({ peer: { principal: { kind: 'owner' } } });
    const markers = WechatConversationService.prototype['@deepseek-ai/dsh-typert-protocol/remote-methods'];
    assert.deepEqual(markers.methods.map(x => x.method), [...CONVERSATION_METHOD_NAMES]);
  });
  await test('resume wire is strict and invalid confirmation/options have zero capability effects', async () => {
    assert.equal(CONVERSATION_ACTION_NAMES.length, 12);
    assert.equal(CONVERSATION_ACTION_NAMES.filter(name => name === 'resumeConversation').length, 1);
    assert.deepEqual([...CONVERSATION_METHOD_NAMES], ['getConversationState', 'conversationAction']);
    const carrier = await controlledCarrier(), f = carrier.newRuntime();
    const valid = { action: 'resumeConversation', sessionId: SID, confirmation: 'resume-readonly-conversation' };
    assert.equal(actionSchema.safeParse(valid).success, true);
    const { confirmation, ...missingConfirmation } = valid;
    const invalid = [missingConfirmation, ...[null, true, '', 'cancel', 'create-readonly-conversation', 'RESUME-READONLY-CONVERSATION'].map(confirmation => ({ ...valid, confirmation })),
      ...['', 1, null, '   ', 'x'.repeat(257), 'bad\nSID', 'bad\0SID'].map(sessionId => ({ ...valid, sessionId })),
      { ...valid, contextSessionId: CONTEXT }, { ...valid, allowWechat: true }, { ...valid, root: ROOT },
      { ...valid, actor: 'owner' }, { ...valid, signal: {} }, { ...valid, action: 'resumeconversation' }];
    const before = { ...f.counts }, beforeCarrier = { ...carrier.calls }, beforeEvents = [...f.events];
    for (const request of invalid) {
      assert.equal(actionSchema.safeParse(request).success, false);
      const value = await f.runtime.action(request);
      assert.equal(value.ok, false); assert.equal(value.error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(f.counts, before); assert.deepEqual(carrier.calls, beforeCarrier); assert.deepEqual(f.events, beforeEvents);
    assert.equal(f.records.size, 0); assert.equal(f.grants.size, 0);
    assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  });
  await test('owner confirmed runtime replacement resumes the same native SID once without grant/channel migration', async () => {
    const carrier = await controlledCarrier(), first = carrier.newRuntime();
    const ordinaryRecord = { createdAt: 1, mayContainArchiveData: true }; carrier.records.set(CONTEXT, ordinaryRecord);
    const created = await create(first); assert.equal(created.ok, true); assert.equal(created.state.prepared, true);
    const id = created.result.sessionId; assert.notEqual(id, CONTEXT); assert.equal(created.state.sessionId, id);
    assert.equal(carrier.calls.creates, 1); assert.equal(carrier.calls.resumes, 0);
    const granted = await first.runtime.action({ action: 'grantSnapshot', sessionId: id, root: ROOT, allConversations: false,
      talkers: ['synthetic-talker'], fromTs: null, toTs: null, allowWechat: false, confirmation: 'read-decrypted-snapshot' });
    assert.equal(granted.ok, true); assert.equal(first.grants.has(id), true);
    const rows = await first.runtime.action({ action: 'queryArchive', sessionId: id, query: { action: 'messages' } });
    assert.equal(rows.ok, true); const stickyRecord = carrier.records.get(id); assert.equal(stickyRecord.mayContainArchiveData, true);
    await first.runtime.dispose(); assert.equal(carrier.liveAgents.has(id), false); assert.equal(carrier.calls.disposes, 1);
    const second = carrier.newRuntime(), before = { ...second.counts }, beforeCarrier = { ...carrier.calls };
    for (const sessionId of [id, CONTEXT, id]) {
      const state = second.runtime.getState({ sessionId }); assert.equal(state.prepared, false);
      assert.equal(state.archive.granted, false); assert.equal(state.channel.hasStoredLogin, false);
    }
    assert.deepEqual(second.counts, before); assert.deepEqual(carrier.calls, beforeCarrier);
    const request = { action: 'resumeConversation', sessionId: id, confirmation: 'resume-readonly-conversation' };
    for (const invocation of [undefined, null, {}, { owner: true }, { actor: 'owner' }, { peer: { principal: { kind: 'guest' } } }]) {
      const denied = await WechatConversationService.prototype.conversationAction.call({ ctx: { invocation }, runtime: second.runtime }, request);
      assert.deepEqual(denied, { ok: false, error: { code: 'NOT_AUTHORIZED' } });
    }
    assert.deepEqual(second.counts, before); assert.deepEqual(carrier.calls, beforeCarrier);
    const resumed = await WechatConversationService.prototype.conversationAction.call({ ctx: { invocation: { peer: { principal: { kind: 'owner' } } } }, runtime: second.runtime }, request);
    assert.equal(resumed.ok, true); assert.equal(actionResultSchema.safeParse(resumed).success, true);
    assert.equal(resumed.state.prepared, true); assert.equal(resumed.state.sessionId, id);
    assert.deepEqual(resumed.result, { sessionId: id, sameSession: true });
    assert.equal(carrier.calls.resumes, 1); assert.equal(carrier.calls.creates, 1); assert.equal(second.counts.ensures, 1);
    assert.equal(second.runtime.getState({ sessionId: id }).prepared, true); assert.equal(second.counts.ensures, 1);
    assert.equal((await resume(second, id)).ok, true); assert.equal(carrier.calls.resumes, 1); assert.equal(second.counts.ensures, 2);
    assert.equal(second.records.get(id), stickyRecord); assert.equal(second.records.get(CONTEXT), ordinaryRecord);
    assert.equal(second.counts.writes + second.counts.markers, 0); assert.equal(second.grants.size, 0);
    assert.equal(resumed.state.archive.granted, false); assert.equal(resumed.state.archive.shareable, false);
    assert.equal(resumed.state.channel.enabled, false); assert.equal(resumed.state.channel.hasStoredLogin, false);
    assert.equal(resumed.state.channel.automaticPolling, false);
    assert.equal(second.counts.credentialFactory + second.counts.apiFactory + second.counts.qrRequests + second.counts.polls + second.counts.queries, 0);
    assert.equal(carrier.calls.contextHistory + carrier.calls.sends, 0); assert.equal(carrier.sessions.get(CONTEXT), carrier.ordinary);
    assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  });
  await test('pre-cancelled resume and invalid signal cannot ensure/open/resume or mutate a marker', async () => {
    const carrier = await controlledCarrier(); carrier.save(SID); const f = carrier.newRuntime();
    const abort = new AbortController(); abort.abort(); const before = { ...f.counts }, beforeCarrier = { ...carrier.calls };
    const cancelled = await resume(f, SID, abort.signal); assert.equal(cancelled.ok, false); assert.equal(cancelled.error.code, 'CANCELLED');
    const invalid = await resume(f, SID, {}); assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'INVALID_REQUEST');
    assert.deepEqual(f.counts, before); assert.deepEqual(carrier.calls, beforeCarrier); assert.equal(f.records.size, 0);
    assert.equal(f.runtime.getState({ sessionId: SID }).prepared, false);
    assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  });
  await test('in-flight resume cancellation drops preparation and can explicitly retry the same SID', async () => {
    const carrier = await controlledCarrier(); carrier.save(SID); const f = carrier.newRuntime();
    const marker = { createdAt: 1, mayContainArchiveData: true }; carrier.records.set(SID, marker);
    carrier.controls.resumeBarrier = deferred(); const abort = new AbortController();
    const pending = resume(f, SID, abort.signal); await carrier.controls.resumeStarted.promise; abort.abort();
    const cancelled = await pending; assert.equal(cancelled.ok, false); assert.equal(cancelled.error.code, 'CANCELLED');
    assert.equal(f.runtime.getState({ sessionId: SID }).prepared, false); assert.equal(carrier.liveAgents.has(SID), false);
    assert.equal(carrier.calls.creates + carrier.calls.flushes + carrier.calls.policies + carrier.calls.sends, 0);
    assert.equal(f.counts.writes + f.counts.markers + f.counts.credentialFactory + f.counts.apiFactory + f.counts.queries, 0);
    assert.equal(f.records.get(SID), marker);
    carrier.controls.resumeBarrier = null;
    const retry = await resume(f); assert.equal(retry.ok, true); assert.equal(retry.state.prepared, true);
    assert.deepEqual(retry.result, { sessionId: SID, sameSession: true });
    assert.equal(carrier.calls.resumes, 2); assert.equal(carrier.calls.creates, 0); assert.equal(f.records.get(SID), marker);
    await f.runtime.dispose(); // Release the real per-SID archive lease before another controlled carrier uses SID.
    assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  });
  await test('ordinary/invalid SID and forged non-owned live Agent cannot be resumed or disposed', async () => {
    const carrier = await controlledCarrier(), f = carrier.newRuntime(); const before = { ...f.counts }, beforeCarrier = { ...carrier.calls };
    for (const id of [CONTEXT, 'bad/session', 'bad\\session', 'wechat-native-ro-not-a-native-uuid']) {
      const value = await resume(f, id); assert.equal(value.ok, false); assert.equal(value.error.code, 'SESSION_NOT_READY');
    }
    assert.deepEqual(f.counts, before); assert.deepEqual(carrier.calls, beforeCarrier);
    const session = carrier.save(SID), forgedCtx = {}, agent = { session, ctx: forgedCtx, dispose() { throw new Error('Non-owned Agent must not be disposed.'); } };
    carrier.compositions.set(forgedCtx, SESSION_BRIDGE_PRESET_ID); carrier.liveAgents.set(SID, agent); carrier.sessions.set(SID, session);
    const value = await resume(f); assert.equal(value.ok, false); assert.equal(value.error.code, 'SESSION_NOT_READY');
    assert.equal(JSON.stringify(value).includes('SYNTHETIC_PRIVATE'), false);
    assert.equal(carrier.liveAgents.get(SID), agent); assert.equal(carrier.sessions.get(SID), session);
    assert.equal(f.runtime.getState({ sessionId: SID }).prepared, false);
    assert.equal(carrier.calls.creates + carrier.calls.resumes + carrier.calls.disposes + carrier.calls.flushes + carrier.calls.policies, 0);
    assert.equal(f.counts.writes + f.counts.markers + f.counts.credentialFactory + f.counts.apiFactory + f.counts.queries, 0);
    assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  });
  await test('unsafe stored native history/preset/cwd/delegation rejects without restoring grants or running a model', async () => {
    const unsafe = [
      [{ agentPreset: 'synthetic-ordinary-preset' }, ['read-only']],
      [{ cwd: ORIGINAL }, ['read-only']], [{}, []], [{}, ['read-only', 'danger-full-access']],
      [{}, ['read-only'], 'bash'], [{ origin: 'subagent', delegationDepth: 1 }, ['read-only']],
    ];
    for (const [header, modes, forbiddenTool] of unsafe) {
      const carrier = await controlledCarrier(); carrier.save(SID, header, modes, forbiddenTool);
      const f = carrier.newRuntime(), marker = { createdAt: 1, mayContainArchiveData: true }; carrier.records.set(SID, marker);
      const stored = carrier.stored.get(SID), value = await resume(f);
      assert.equal(value.ok, false); assert.equal(value.error.code, 'SESSION_NOT_READY');
      assert.equal(JSON.stringify(value).includes('SYNTHETIC_PRIVATE'), false);
      assert.equal(f.runtime.getState({ sessionId: SID }).prepared, false); assert.equal(carrier.liveAgents.has(SID), false);
      assert.equal(f.records.get(SID), marker); assert.equal(carrier.stored.get(SID), stored); assert.equal(f.grants.size, 0);
      assert.equal(carrier.calls.resumes, 1); assert.equal(carrier.calls.creates + carrier.calls.flushes + carrier.calls.policies + carrier.calls.sends + carrier.calls.contextHistory, 0);
      assert.equal(f.counts.writes + f.counts.markers + f.counts.credentialFactory + f.counts.apiFactory + f.counts.qrRequests + f.counts.polls + f.counts.queries, 0);
      await f.runtime.dispose();
    }
    assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  });
  await test('Task history verification failures use a fixed persistence error before grants or communication', async () => {
    const requests = [
      ['resumeConversation', { confirmation: 'resume-task-conversation' }],
      ['setSharing', { allowWechat: true, confirmation: 'share-whole-task-context' }],
      ['pollTextOnce', { allowSharedContext: true, confirmation: 'poll-one-text-reply' }],
    ];
    for (const [action, shape] of requests) {
      const f = taskFixture(); await taskCreate(f);
      f.taskBridge.ensure = async () => { throw Object.assign(new Error('SYNTHETIC_PRIVATE_TASK_HISTORY'), { code: 'history-unavailable' }); };
      const value = await taskAction(f, action, shape);
      assert.deepEqual(value, { ok: false, error: { code: 'SESSION_PERSIST_FAILED' } });
      assert.equal(TASK_WIRE.actionResultSchema.safeParse(value).success, true);
      assert.equal(f.counts.shareChanges + f.counts.credentialFactory + f.counts.apiFactory + f.counts.textPolls + f.counts.polls + f.counts.replies, 0);
      assert.equal(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).task.allowWechat, false);
    }
    assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  });
  await test('real default unconfigured runtime constructor and memory state are no-I/O', async () => {
    const runtime = createConversationRuntime({}, { sourceRoot: ORIGINAL, snapshotEnabled: false });
    const state = runtime.getState(); assert.equal(state.prepared, false); assert.equal(state.channel.automaticPolling, false);
    await runtime.dispose(); assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  });
  await test('real default ordinary Bridge actions reject consistently before any history or channel I/O', async () => {
    const runtime = createConversationRuntime({}, { sourceRoot: ORIGINAL, snapshotEnabled: false });
    const requests = [
      { action: 'resumeConversation', confirmation: 'resume-readonly-conversation' },
      { action: 'beginLogin', confirmation: 'network-login' }, { action: 'pollLogin' },
      { action: 'confirmPairing', expectedOwnerId: 'synthetic-owner', confirmation: 'persist-pairing' },
      { action: 'startChannel', allowSharedContext: true, confirmation: 'poll-and-reply' },
      { action: 'forgetPairing', confirmation: 'forget-local-credentials' },
      { action: 'discardPending', confirmation: 'discard-without-retry' },
    ];
    try {
      for (const request of requests) {
        const result = await runtime.action({ ...request, sessionId: CONTEXT });
        assert.equal(result.ok, false); assert.equal(result.error.code, 'SESSION_NOT_READY');
        assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
      }
    } finally { await runtime.dispose(); }
  });
  await test('constructors and memory GET never open domain/credentials/transport', () => {
    const f = fixture(); const state = f.runtime.getState({ sessionId: SID });
    assert.equal(state.version, '0.2.0'); assert.equal(state.channel.automaticPolling, false); assert.equal(state.archive.historyKnown, false);
    assert.equal(f.counts.open + f.counts.credentialFactory + f.counts.apiFactory + f.counts.qrRequests + f.counts.polls, 0);
  });
  await test('strict requests and forbidden original/ancestor paths reject before domain open', async () => {
    const f = fixture();
    for (const request of [{ action: 'send', sessionId: SID }, { action: 'createConversation', contextSessionId: CONTEXT, actor: 'owner', confirmation: 'create-readonly-conversation' },
      { action: 'startChannel', sessionId: SID, allowSharedContext: false, confirmation: 'poll-and-reply' },
      { action: 'queryArchive', sessionId: SID, query: { action: 'sql', query: 'SELECT 1' } }]) assert.equal((await f.runtime.action(request)).ok, false);
    for (const root of [ORIGINAL, ORIGINAL + '/db', desktopPath(desktopHome(), 'Documents')]) {
      const value = await f.runtime.action({ action: 'grantSnapshot', sessionId: SID, root, allConversations: true, talkers: [], fromTs: null, toTs: null, allowWechat: false, confirmation: 'read-decrypted-snapshot' });
      assert.equal(value.ok, false); assert.equal(value.error.code, 'SNAPSHOT_DENIED');
    }
    assert.equal(f.counts.open + f.counts.credentialFactory + f.counts.apiFactory + f.counts.queries, 0);
  });
  await test('creation failures identify fixed stages without private details or automatic retries', async () => {
    const privateError = code => Object.assign(new Error('SYNTHETIC_PRIVATE_CREATION_FAILURE'), code ? { code } : {});
    const scenarios = [
      [{ openError: privateError() }, 'HISTORY_OPEN_FAILED'],
      [{ openError: privateError('already-open') }, 'HISTORY_ALREADY_OPEN'],
      [{ openError: privateError('invalid-record') }, 'HISTORY_INVALID'],
      [{ openError: privateError('version-mismatch') }, 'HISTORY_INVALID'],
      [{ creationError: privateError() }, 'SESSION_CREATE_FAILED'],
      [{ creationError: privateError('persistence-failed') }, 'SESSION_PERSIST_FAILED'],
      [{ putError: privateError() }, 'HISTORY_WRITE_FAILED'],
      [{ openError: abortError() }, 'CANCELLED'],
    ];
    for (const [options, code] of scenarios) {
      const f = fixture(options), value = await create(f);
      assert.deepEqual(value, { ok: false, error: { code } });
      assert.equal(actionResultSchema.safeParse(value).success, true);
      assert.equal(f.runtime.getState({ sessionId: CONTEXT }).lastError, code);
      assert.equal(f.events.filter(event => event === 'create').length, options.openError ? 0 : 1);
      assert.equal(f.counts.open, 1);
      assert.equal(f.records.size, 0);
      assert.equal(f.counts.credentialFactory + f.counts.apiFactory + f.counts.polls + f.counts.queries, 0);
      assert.equal(JSON.stringify(value).includes('SYNTHETIC_PRIVATE'), false);
    }
  });
  await test('native creation and authoritative known-clean marker are durable before result', async () => {
    const f = fixture(); const value = await create(f); assert.equal(value.ok, true); assert.equal(value.result.sessionId, SID);
    assert.deepEqual(f.events.slice(0, 3), ['open', 'create', 'put']); assert.equal(f.records.get(SID).mayContainArchiveData, false);
    assert.equal(value.state.archive.historyKnown, true); assert.equal(value.state.archive.shareable, true);
    assert.equal(f.counts.qrRequests + f.counts.polls, 0); assert.equal(actionResultSchema.safeParse(value).success, true);
  });
  await test('concurrent creates reserve remaining history capacity before native side effects', async () => {
    const records = new Map(Array.from({ length: 255 }, (_, i) => ['synthetic-existing-' + i, { createdAt: 1, mayContainArchiveData: false }]));
    const barrier = deferred(), f = fixture({ records, creationBarrier: barrier });
    const pending = create(f); await f.createStarted.promise;
    const blocked = await f.runtime.action({ action: 'createConversation', contextSessionId: 'synthetic-second-context', confirmation: 'create-readonly-conversation' });
    assert.equal(blocked.ok, false); assert.equal(blocked.error.code, 'BUSY'); assert.equal(f.events.filter(x => x === 'create').length, 1);
    barrier.resolve(); assert.equal((await pending).ok, true); assert.equal(records.size, 256);
  });
  await test('failed native create releases reservation without writing a clean marker', async () => {
    const records = new Map(Array.from({ length: 255 }, (_, i) => ['synthetic-existing-' + i, { createdAt: 1, mayContainArchiveData: false }]));
    const f = fixture({ records, creationFailsOnce: true });
    assert.equal((await create(f)).ok, false); assert.equal(records.size, 255);
    assert.equal((await create(f)).ok, true); assert.equal(records.size, 256);
  });
  await test('late aborted native create cannot write or expose a clean history marker', async () => {
    const barrier = deferred(), f = fixture({ creationBarrier: barrier }), control = new AbortController();
    const pending = f.runtime.action({ action: 'createConversation', contextSessionId: CONTEXT, confirmation: 'create-readonly-conversation' }, control.signal);
    await f.createStarted.promise; control.abort(); barrier.resolve();
    const result = await pending; assert.equal(result.ok, false); assert.equal(result.error.code, 'CANCELLED'); assert.equal(f.records.size, 0);
    assert.equal(f.events.filter(x => x === 'put').length, 0); assert.equal(f.counts.polls, 0);
  });
  await test('failed polling caches pending recovery after driver settlement without retrying', async () => {
    const f = fixture({ account: 'synthetic-cached-recovery', pollFailure: true }); await create(f); assert.equal((await start(f)).ok, true);
    await f.recoveryRead.promise; await stop(f);
    assert.equal(f.runtime.getState({ sessionId: SID }).channel.pendingRecovery, true); assert.equal(f.counts.polls, 1);
    assert.equal(f.runtime.getState({ sessionId: SID }).channel.automaticPolling, false);
  });
  await test('unknown authoritative history cannot start, before credential factory', async () => {
    const f = fixture(); const value = await start(f); assert.equal(value.ok, false); assert.equal(value.error.code, 'SHARED_CONTEXT_DENIED');
    assert.equal(f.counts.credentialFactory + f.counts.apiFactory + f.counts.polls, 0);
  });
  await test('local query marks sticky before rows; revoke never clears it', async () => {
    const f = fixture(); await create(f); assert.equal((await grant(f)).ok, true);
    const value = await f.runtime.action({ action: 'queryArchive', sessionId: SID, query: { action: 'messages', talker: 'synthetic-talker', limit: 2 } });
    assert.equal(value.ok, true); assert.equal(f.records.get(SID).mayContainArchiveData, true); assert.equal(value.state.archive.shareable, false);
    const revoked = await revoke(f); assert.equal(revoked.ok, true); assert.equal(revoked.state.archive.sessionMayContainArchiveData, true);
    assert.equal((await start(f)).error.code, 'SHARED_CONTEXT_DENIED'); assert.equal(f.counts.polls, 0);
  });
  await test('failed history persistence cannot return archive rows or private error text', async () => {
    const f = fixture({ markerFails: true }); await create(f); await grant(f);
    const value = await f.runtime.action({ action: 'queryArchive', sessionId: SID, query: { action: 'messages' } });
    assert.equal(value.ok, false); assert.ok(!JSON.stringify(value).includes('SYNTHETIC_PRIVATE')); assert.equal(f.records.get(SID).mayContainArchiveData, false);
  });
  await test('revoke during trusted marker barrier drops late rows and retains sticky mark', async () => {
    const barrier = deferred(), f = fixture({ markerBarrier: barrier }); await create(f); await grant(f);
    const pending = f.runtime.action({ action: 'queryArchive', sessionId: SID, query: { action: 'messages' } });
    while (!f.counts.markers) await Promise.resolve();
    assert.equal((await revoke(f)).ok, true); barrier.resolve();
    const value = await pending; assert.equal(value.ok, false); assert.equal(value.error.code, 'CANCELLED'); assert.equal(f.records.get(SID).mayContainArchiveData, true);
  });
  await test('QR encoder readiness must precede any QR request; failure makes zero requests', async () => {
    const f = fixture({ qrFails: true }); await create(f);
    const value = await f.runtime.action({ action: 'beginLogin', sessionId: SID, confirmation: 'network-login' });
    assert.equal(value.ok, false); assert.equal(value.error.code, 'QR_UNAVAILABLE'); assert.equal(f.counts.qrRequests, 0);
    const good = fixture(); await create(good);
    const qr = await good.runtime.action({ action: 'beginLogin', sessionId: SID, confirmation: 'network-login' });
    assert.equal(qr.ok, true); assert.equal(qr.qr.rows.length, 21); assert.equal(good.counts.qrRequests, 1); assert.ok(good.events.includes('encoder-ready'));
    assert.ok(!JSON.stringify(good.runtime.getState({ sessionId: SID })).includes('SYNTHETIC_LOCAL_QR_PAYLOAD'));
  });
  await test('real API and channel preserve closed failures through Owner RPC without retry or persistence', async () => {
    const expected = {
      'not-configured': 'UNAVAILABLE', 'invalid-options': 'INVALID_REQUEST', 'invalid-input': 'INVALID_REQUEST', aborted: 'CANCELLED',
      'network-error': 'WECHAT_NETWORK_FAILED', timeout: 'WECHAT_REQUEST_TIMEOUT',
      'http-error': 'WECHAT_HTTP_REJECTED', 'business-error': 'WECHAT_REQUEST_REJECTED',
      'invalid-mime': 'WECHAT_RESPONSE_TYPE_INVALID', 'invalid-json': 'WECHAT_RESPONSE_JSON_INVALID',
      'response-too-large': 'WECHAT_RESPONSE_TOO_LARGE', 'invalid-response': 'WECHAT_RESPONSE_INVALID',
      'unsupported-origin': 'WECHAT_ORIGIN_REJECTED', 'unsupported-redirect': 'WECHAT_REDIRECT_REJECTED',
    };
    for (const [apiCode, code] of Object.entries(expected)) {
      let requests = 0, writes = 0;
      const response = apiCode === 'invalid-json'
        ? () => new Response('SYNTHETIC_PRIVATE_BAD_JSON', { headers: { 'content-type': 'application/json' } }) : null;
      const api = createWeixinApi({ fetcher: async () => { requests++; return response(); } });
      const realApi = response ? api : { ...api, async requestQrCode() { requests++; throw new WeixinApiError(apiCode, { httpStatus: 200, businessCode: -14 }); } };
      const f = fixture({ realApi, stateStore: { async read() { return undefined; }, async commit() { writes++; } } });
      await create(f);
      const value = await f.runtime.action({ action: 'beginLogin', sessionId: SID, confirmation: 'network-login' });
      assert.deepEqual(value, { ok: false, error: { code } });
      assert.equal(actionResultSchema.safeParse(value).success, true);
      assert.equal(TASK_WIRE.actionResultSchema.safeParse(value).success, true);
      assert.equal(f.runtime.getState({ sessionId: SID }).lastError, code);
      assert.equal(f.runtime.getState({ sessionId: SID }).channel.automaticPolling, false);
      assert.equal(requests, 1); assert.equal(writes, 0); assert.equal(f.counts.polls, 0);
      assert.equal(JSON.stringify(value).includes('SYNTHETIC_PRIVATE'), false);
    }
  });
  await test('login failures distinguish stored pairing, unreadable records and invalid binding without message work', async () => {
    for (const task of [false, true]) {
      const sid = task ? TASK_SID : SID;
      const pairing = { version: task ? 3 : 2, sessionId: sid, revision: 1,
        credentials: { botToken: 'SYNTHETIC_PRIVATE_TOKEN', botId: 'synthetic-bot', userId: 'synthetic-owner', baseUrl: 'https://ilinkai.weixin.qq.com' },
        cursor: '', seenMessageIds: [], pending: null, queuedBatch: null };
      const cases = [
        { state: pairing, code: 'PAIRING_ALREADY_STORED' },
        { readFails: true, code: 'PAIRING_STORAGE_FAILED' },
        { state: { ...pairing, revision: -1 }, code: 'PAIRING_STATE_INVALID' },
        { state: { ...pairing, sessionId: task ? SID : TASK_SID }, code: 'PAIRING_STATE_INVALID' },
        { code: 'WECHAT_RESPONSE_INVALID' },
      ];
      for (const scenario of cases) {
        let requests = 0, writes = 0;
        const api = createWeixinApi({ fetcher: async () => { throw new Error('No live transport in login regression'); } });
        const realApi = { ...api, async requestQrCode() { requests++; return { qrcode: 'SYNTHETIC_PRIVATE_QR' }; } };
        const stateStore = { async read() { if (scenario.readFails) throw new Error('SYNTHETIC_PRIVATE_STORAGE_FAILURE'); return scenario.state; },
          async commit() { writes++; } };
        const f = task ? taskFixture({ realApi, stateStore }) : fixture({ realApi, stateStore });
        await (task ? taskCreate(f) : create(f));
        const value = await f.runtime.action({ ...(task ? { kind: 'task' } : {}), action: 'beginLogin', sessionId: sid, confirmation: 'network-login' });
        assert.deepEqual(value, { ok: false, error: { code: scenario.code } });
        assert.equal(actionResultSchema.safeParse(value).success, true);
        assert.equal(TASK_WIRE.actionResultSchema.safeParse(value).success, true);
        const state = f.runtime.getState({ ...(task ? { kind: 'task' } : {}), sessionId: sid });
        assert.equal(state.lastError, scenario.code); assert.equal(state.channel.automaticPolling, false);
        if (scenario.code === 'PAIRING_ALREADY_STORED') {
          assert.equal(state.channel.phase, 'paired'); assert.equal(state.channel.hasStoredLogin, true);
        }
        assert.equal(requests, scenario.code === 'WECHAT_RESPONSE_INVALID' ? 1 : 0);
        assert.equal(writes, 0); assert.equal(f.counts.polls, 0);
        assert.equal(JSON.stringify([value, state]).includes('SYNTHETIC_PRIVATE'), false);
      }
    }
  });
  await test('real login JSON accepts other MIME but waits for Owner confirmation before persistence', async () => {
    for (const mime of ['text/plain', 'application/x-synthetic-qr', null]) {
      let requests = 0, writes = 0;
      const realApi = createWeixinApi({ fetcher: async (url, init) => {
        requests++;
        let payload;
        if (requests === 1) {
          assert.equal(url, 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
          assert.equal(init.method, 'POST');
          payload = { qrcode: 'SYNTHETIC_PRIVATE_QR', qrcode_img_content: 'SYNTHETIC_LOCAL_QR_PAYLOAD' };
        } else {
          assert.equal(requests, 2); assert.equal(init.method, 'GET');
          assert.equal(new URL(url).pathname, '/ilink/bot/get_qrcode_status');
          assert.equal(new URL(url).searchParams.get('qrcode'), 'SYNTHETIC_PRIVATE_QR');
          assert.equal(new Headers(init.headers).has('authorization'), false);
          payload = { status: 'confirmed', bot_token: 'SYNTHETIC_PRIVATE_TOKEN', ilink_bot_id: 'synthetic-bot',
            ilink_user_id: 'synthetic-owner', baseurl: 'https://ilinkai.weixin.qq.com' };
        }
        return new Response(JSON.stringify(payload), { headers: mime === null ? {} : { 'content-type': mime } });
      } });
      const f = fixture({ realApi, stateStore: { async read() { return undefined; }, async commit() { writes++; } } });
      await create(f);
      const value = await f.runtime.action({ action: 'beginLogin', sessionId: SID, confirmation: 'network-login' });
      assert.equal(value.ok, true); assert.equal(value.qr.rows.length, 21);
      assert.equal(actionResultSchema.safeParse(value).success, true);
      assert.equal(value.state.channel.phase, 'qr-ready');
      assert.equal(value.state.channel.hasStoredLogin, false);
      assert.equal(value.state.channel.automaticPolling, false);
      assert.equal(requests, 1); assert.equal(writes, 0); assert.equal(f.counts.polls, 0);
      const polled = await f.runtime.action({ action: 'pollLogin', sessionId: SID });
      assert.equal(polled.ok, true);
      assert.deepEqual(polled.result, { status: 'confirmed', expectedOwnerId: 'synthetic-owner', botId: 'synthetic-bot' });
      assert.equal(polled.state.channel.phase, 'awaiting-confirmation');
      assert.equal(polled.state.channel.hasStoredLogin, false); assert.equal(polled.state.channel.automaticPolling, false);
      assert.equal(requests, 2); assert.equal(writes, 0); assert.equal(f.counts.polls, 0);
      const serialized = JSON.stringify([value, polled]);
      for (const secret of ['SYNTHETIC_PRIVATE_QR', 'SYNTHETIC_LOCAL_QR_PAYLOAD', 'SYNTHETIC_PRIVATE_TOKEN']) assert.equal(serialized.includes(secret), false);
    }
  });
  await test('owner poll candidate and mismatched owner cannot persist pairing', async () => {
    const f = fixture(); await create(f);
    const polled = await f.runtime.action({ action: 'pollLogin', sessionId: SID }); assert.equal(polled.result.expectedOwnerId, 'synthetic-owner');
    const bad = await f.runtime.action({ action: 'confirmPairing', sessionId: SID, expectedOwnerId: 'not-owner', confirmation: 'persist-pairing' });
    assert.equal(bad.ok, false); assert.equal(bad.error.code, 'OWNER_MISMATCH'); assert.ok(!JSON.stringify(bad).includes('SYNTHETIC_PRIVATE_OWNER'));
    assert.equal((await f.runtime.action({ action: 'confirmPairing', sessionId: SID, expectedOwnerId: 'synthetic-owner', confirmation: 'persist-pairing' })).ok, true);
  });
  await test('explicit start publishes real running flag; stop drains before discard', async () => {
    const f = fixture({ account: 'synthetic-explicit-start' }); await create(f);
    const value = await start(f); assert.equal(value.ok, true); assert.equal(value.state.channel.phase, 'running'); assert.equal(value.state.channel.automaticPolling, true);
    await f.pollStarted.promise; assert.equal(f.counts.polls, 1);
    const discarded = await f.runtime.action({ action: 'discardPending', sessionId: SID, confirmation: 'discard-without-retry' });
    assert.equal(discarded.ok, true); assert.equal(discarded.state.channel.automaticPolling, false); assert.equal(f.counts.discard, 1);
  });
  await test('one loaded Host-generation account lock blocks a second Session and releases on stop', async () => {
    const records = new Map([[SID, { createdAt: 1, mayContainArchiveData: false }], [SID2, { createdAt: 1, mayContainArchiveData: false }]]);
    const one = fixture({ records, account: 'synthetic-shared-lock' }), two = fixture({ records, account: 'synthetic-shared-lock' });
    assert.equal((await start(one)).ok, true); await one.pollStarted.promise;
    const denied = await start(two, SID2); assert.equal(denied.ok, false); assert.equal(denied.error.code, 'BUSY'); assert.equal(two.counts.polls, 0);
    await stop(one); assert.equal((await start(two, SID2)).ok, true); await two.pollStarted.promise; await two.runtime.action({ action: 'stopChannel', sessionId: SID2, confirmation: 'stop-channel' });
  });
  await test('stop while pairing identity is late cannot restart a background loop', async () => {
    const barrier = deferred(), f = fixture({ identityBarrier: barrier }); await create(f);
    const pending = start(f); await f.identityStarted.promise;
    assert.equal((await stop(f)).ok, true); barrier.resolve(); const value = await pending;
    assert.equal(value.ok, false); assert.equal(value.error.code, 'CANCELLED'); assert.equal(f.counts.polls, 0); assert.equal(f.runtime.getState({ sessionId: SID }).channel.automaticPolling, false);
  });
  await test('persistent sticky record survives runtime replacement with no inherited grant', async () => {
    const records = new Map([[SID, { createdAt: 1, mayContainArchiveData: true }]]), f = fixture({ records });
    const value = await start(f); assert.equal(value.ok, false); assert.equal(value.error.code, 'SHARED_CONTEXT_DENIED'); assert.equal(f.counts.polls, 0);
  });
  await test('dispose stops owned loops, then bridge/archive, then closes own domain', async () => {
    const f = fixture({ account: 'synthetic-dispose' }); await create(f); await start(f); await f.pollStarted.promise;
    await f.runtime.dispose(); assert.equal(f.counts.close, 1); assert.equal(f.events.at(-1), 'close'); assert.equal(f.runtime.action && (await f.runtime.action({})).error.code, 'UNAVAILABLE');
    assert.throws(() => f.runtime.getState({ sessionId: SID }), error => error.code === 'UNAVAILABLE');
  });
  const ordinaryGrant = (f, id = CONTEXT, allowWechat = false, signal) => f.runtime.action({ action: 'grantSnapshot', sessionId: id, root: ROOT,
    allConversations: false, talkers: ['synthetic-talker'], fromTs: null, toTs: null, allowWechat, confirmation: 'read-decrypted-snapshot' }, signal);
  const ordinaryQuery = (f, id = CONTEXT) => f.runtime.action({ action: 'queryArchive', sessionId: id, query: { action: 'messages', talker: 'synthetic-talker', limit: 2 } });
  const live = id => new Map([[id, { header: Object.freeze({ id, createdAt: 1, cwd: '/tmp/SYNTHETIC_NOT_READ' }) }]]);
  await test('ordinary current SSE Session grants data without creating/resuming Agent or reading history', async () => {
    const f = fixture({ liveSessions: live(CONTEXT) });
    f.runtime.getState({ sessionId: CONTEXT }); assert.equal(f.counts.metadataReads, 0); assert.equal(f.counts.open, 0);
    const value = await ordinaryGrant(f); assert.equal(value.ok, true); assert.equal(value.state.prepared, false);
    assert.equal(value.state.archive.granted, true); assert.equal(value.state.archive.allowWechat, false);
    assert.equal(f.records.get(CONTEXT).mayContainArchiveData, true); assert.equal(f.counts.ensures, 0);
    assert.equal(f.events.filter(x => x === 'create').length, 0); assert.equal(f.counts.credentialFactory + f.counts.apiFactory + f.counts.polls, 0);
    const reads = f.counts.metadataReads; f.runtime.getState({ sessionId: CONTEXT }); assert.equal(f.counts.metadataReads, reads);
  });
  await test('ordinary data-only local query works with prepared=false and no WeChat egress grant', async () => {
    const f = fixture({ liveSessions: live(CONTEXT) }); assert.equal((await ordinaryGrant(f)).ok, true);
    const value = await ordinaryQuery(f); assert.equal(value.ok, true); assert.equal(value.state.prepared, false);
    assert.equal(value.result.rows[0].content, 'SYNTHETIC_ROW'); assert.equal(value.state.archive.shareable, false);
    assert.equal(f.counts.ensures, 0); assert.equal(f.records.get(CONTEXT).mayContainArchiveData, true);
    f.liveSessions.delete(CONTEXT); const revoked = await f.runtime.action({ action: 'revokeSnapshot', sessionId: CONTEXT, confirmation: 'revoke-snapshot' });
    assert.equal(revoked.ok, true); assert.equal(revoked.state.archive.granted, false); assert.equal(revoked.state.archive.sessionMayContainArchiveData, true);
  });
  await test('unknown/non-live/mismatched ordinary Session metadata fails before domain or archive grant', async () => {
    for (const liveSessions of [new Map(), new Map([[CONTEXT, { header: { id: 'synthetic-wrong-id' } }]])]) {
      const f = fixture({ liveSessions }); const value = await ordinaryGrant(f);
      assert.equal(value.ok, false); assert.equal(value.error.code, 'SESSION_NOT_READY');
      assert.equal(f.counts.open + f.counts.ensures + f.counts.writes + f.counts.credentialFactory, 0); assert.equal(f.grants.size, 0);
    }
  });
  await test('ordinary query without an explicit grant does not open persistent state or resume', async () => {
    const f = fixture({ liveSessions: live(CONTEXT) }); const value = await ordinaryQuery(f);
    assert.equal(value.ok, false); assert.equal(value.error.code, 'SNAPSHOT_REQUIRED'); assert.equal(f.counts.open + f.counts.ensures + f.counts.queries, 0);
  });
  await test('ordinary Session cannot opt into sharing/login/polling or acquire channel capabilities', async () => {
    const f = fixture({ liveSessions: live(CONTEXT) });
    const share = await ordinaryGrant(f, CONTEXT, true); assert.equal(share.ok, false); assert.equal(share.error.code, 'SHARED_CONTEXT_DENIED'); assert.equal(f.counts.open, 0);
    assert.equal((await ordinaryGrant(f)).ok, true);
    const requests = [
      { action: 'resumeConversation', confirmation: 'resume-readonly-conversation' },
      { action: 'beginLogin', confirmation: 'network-login' }, { action: 'pollLogin' },
      { action: 'confirmPairing', expectedOwnerId: 'synthetic-owner', confirmation: 'persist-pairing' },
      { action: 'startChannel', allowSharedContext: true, confirmation: 'poll-and-reply' },
      { action: 'forgetPairing', confirmation: 'forget-local-credentials' },
      { action: 'discardPending', confirmation: 'discard-without-retry' },
    ];
    for (const request of requests) { const result = await f.runtime.action({ ...request, sessionId: CONTEXT }); assert.equal(result.ok, false); assert.equal(result.error.code, 'SESSION_NOT_READY'); }
    assert.equal(f.counts.credentialFactory + f.counts.apiFactory + f.counts.qrRequests + f.counts.polls, 0);
    assert.equal(f.events.filter(x => x === 'create').length, 0);
  });
  await test('ordinary existing marker is upgraded monotonically before grant; persistence failure grants nothing', async () => {
    const records = new Map([[CONTEXT, { createdAt: 1, mayContainArchiveData: false }]]);
    const good = fixture({ records, liveSessions: live(CONTEXT) }); assert.equal((await ordinaryGrant(good)).ok, true);
    assert.equal(records.get(CONTEXT).mayContainArchiveData, true); assert.equal(good.counts.markers, 1); assert.equal(good.counts.ensures, 0);
    const bad = fixture({ records: new Map([[CONTEXT, { createdAt: 1, mayContainArchiveData: false }]]), liveSessions: live(CONTEXT), markerFails: true });
    assert.equal((await ordinaryGrant(bad)).ok, false); assert.equal(bad.grants.size, 0); assert.equal(bad.counts.queries + bad.counts.ensures, 0);
  });
  await test('ordinary Session unloading during query drops late rows without a hidden resume', async () => {
    const barrier = deferred(), f = fixture({ liveSessions: live(CONTEXT), queryBarrier: barrier }); await ordinaryGrant(f);
    const pending = ordinaryQuery(f); while (!f.counts.queries) await Promise.resolve();
    f.liveSessions.delete(CONTEXT); barrier.resolve(); const value = await pending;
    assert.equal(value.ok, false); assert.equal(value.error.code, 'SESSION_NOT_READY'); assert.equal(f.counts.ensures, 0);
    assert.equal(f.records.get(CONTEXT).mayContainArchiveData, true); assert.ok(!JSON.stringify(value).includes('SYNTHETIC_ROW'));
  });
  await test('ordinary grant and native creation share the same 256-entry reservation budget', async () => {
    const records = new Map(Array.from({ length: 255 }, (_, i) => ['synthetic-existing-' + i, { createdAt: 1, mayContainArchiveData: false }]));
    const barrier = deferred(), f = fixture({ records, liveSessions: live(CONTEXT), putBarrier: barrier });
    const pending = ordinaryGrant(f); while (!f.events.includes('put')) await Promise.resolve();
    const blocked = await f.runtime.action({ action: 'createConversation', contextSessionId: 'synthetic-other-context', confirmation: 'create-readonly-conversation' });
    assert.equal(blocked.ok, false); assert.equal(blocked.error.code, 'BUSY'); assert.equal(f.events.filter(x => x === 'create').length, 0);
    barrier.resolve(); assert.equal((await pending).ok, true); assert.equal(records.size, 256);
  });
  await test('native creation reservation also blocks a distinct ordinary data grant at capacity', async () => {
    const records = new Map(Array.from({ length: 255 }, (_, i) => ['synthetic-existing-' + i, { createdAt: 1, mayContainArchiveData: false }]));
    const barrier = deferred(), other = 'synthetic-other-live-session', f = fixture({ records, liveSessions: live(other), creationBarrier: barrier });
    const pending = create(f); await f.createStarted.promise; const blocked = await ordinaryGrant(f, other);
    assert.equal(blocked.ok, false); assert.equal(blocked.error.code, 'BUSY'); assert.equal(f.events.filter(x => x === 'put').length, 0);
    barrier.resolve(); assert.equal((await pending).ok, true); assert.equal(records.size, 256);
  });
  await test('cancelling ordinary grant during durable marker write never grants or returns rows', async () => {
    const barrier = deferred(), f = fixture({ liveSessions: live(CONTEXT), putBarrier: barrier }), control = new AbortController();
    const pending = ordinaryGrant(f, CONTEXT, false, control.signal); while (!f.events.includes('put')) await Promise.resolve();
    control.abort(); barrier.resolve(); const value = await pending;
    assert.equal(value.ok, false); assert.equal(value.error.code, 'CANCELLED'); assert.equal(f.grants.size, 0); assert.equal(f.counts.ensures + f.counts.queries, 0);
    assert.equal(f.records.get(CONTEXT).mayContainArchiveData, true);
  });
  await test('ordinary and Bot archive grants keep independent scopes through Bot revoke', async () => {
    const f = fixture({ liveSessions: new Map([[CONTEXT, { header: { id: CONTEXT, cwd: '/tmp/SYNTHETIC_NOT_READ' } }]]) });
    const ordinary = await f.runtime.action({ action: 'grantSnapshot', sessionId: CONTEXT, root: ROOT, allConversations: false,
      talkers: ['synthetic-context-talker'], fromTs: 1700000000, toTs: 1700000600, allowWechat: false, confirmation: 'read-decrypted-snapshot' });
    assert.equal(ordinary.ok, true); assert.equal(ordinary.state.archive.granted, true);
    assert.equal(ordinary.state.archive.allowWechat, false); assert.equal(ordinary.state.archive.shareable, false);
    assert.deepEqual(ordinary.state.archive.talkers, ['synthetic-context-talker']);
    assert.equal(ordinary.state.archive.fromTs, 1700000000); assert.equal(ordinary.state.archive.toTs, 1700000600);
    const ordinaryGrant = f.grants.get(CONTEXT), ordinaryState = { ...ordinary.state.archive, talkers: [...ordinary.state.archive.talkers] };
    assert.equal((await create(f)).ok, true); assert.equal((await grant(f, true)).ok, true);
    const bot = f.runtime.getState({ sessionId: SID });
    assert.equal(f.grants.size, 2); assert.notEqual(f.grants.get(SID), ordinaryGrant);
    assert.equal(f.grants.get(SID).allowWechat, true); assert.equal(f.grants.get(CONTEXT).allowWechat, false);
    assert.equal(bot.archive.granted, true); assert.equal(bot.archive.allowWechat, true); assert.equal(bot.archive.shareable, true);
    assert.equal(bot.archive.allConversations, false); assert.deepEqual(bot.archive.talkers, ['synthetic-talker']);
    assert.equal(bot.archive.fromTs, null); assert.equal(bot.archive.toTs, null);
    assert.deepEqual(f.runtime.getState({ sessionId: CONTEXT }).archive, ordinaryState);
    const rows = await f.runtime.action({ action: 'queryArchive', sessionId: SID, query: { action: 'messages', talker: 'synthetic-talker', limit: 2 } });
    assert.equal(rows.ok, true); assert.deepEqual(rows.result.rows, [{ content: 'SYNTHETIC_ROW', untrusted: true }]);
    assert.equal(f.records.get(SID).mayContainArchiveData, true); assert.equal(rows.state.archive.shareable, true);
    const revoked = await revoke(f); assert.equal(revoked.ok, true);
    assert.equal(revoked.state.archive.granted, false); assert.equal(revoked.state.archive.sessionMayContainArchiveData, true);
    assert.equal(f.grants.size, 1); assert.equal(f.grants.has(SID), false); assert.equal(f.grants.get(CONTEXT), ordinaryGrant);
    assert.deepEqual(f.runtime.getState({ sessionId: CONTEXT }).archive, ordinaryState);
    const denied = await start(f); assert.equal(denied.ok, false); assert.equal(denied.error.code, 'SHARED_CONTEXT_DENIED');
    assert.equal(f.counts.credentialFactory + f.counts.apiFactory + f.counts.qrRequests + f.counts.polls, 0);
  });
  await test('running archive-authorized Bot grant replacement drains polling without restarting', async () => {
    const f = fixture({ account: 'synthetic-running-bot-grant-replacement' });
    assert.equal((await create(f)).ok, true); assert.equal((await grant(f, true)).ok, true);
    const rows = await f.runtime.action({ action: 'queryArchive', sessionId: SID, query: { action: 'messages', talker: 'synthetic-talker', limit: 2 } });
    assert.equal(rows.ok, true); assert.equal(rows.result.rows[0].content, 'SYNTHETIC_ROW');
    const running = await start(f); assert.equal(running.ok, true);
    assert.equal(running.state.channel.messagingEnabled, true); assert.equal(running.state.channel.automaticPolling, true);
    await f.pollStarted.promise; assert.equal(f.counts.polls, 1);
    const previousGrant = f.grants.get(SID), stickyRecord = f.records.get(SID);
    const updated = await f.runtime.action({ action: 'grantSnapshot', sessionId: SID, root: ROOT, allConversations: false,
      talkers: ['synthetic-updated-bot-talker'], fromTs: 1700001200, toTs: 1700001800, allowWechat: true, confirmation: 'read-decrypted-snapshot' });
    assert.equal(updated.ok, true); const state = f.runtime.getState({ sessionId: SID });
    assert.equal(state.channel.messagingEnabled, false); assert.equal(state.channel.automaticPolling, false); assert.equal(f.counts.polls, 1);
    assert.equal(f.grants.size, 1); assert.notEqual(f.grants.get(SID), previousGrant); assert.equal(f.grants.get(SID).allowWechat, true);
    assert.equal(state.archive.granted, true); assert.equal(state.archive.allowWechat, true); assert.equal(state.archive.shareable, true);
    assert.deepEqual(state.archive.talkers, ['synthetic-updated-bot-talker']);
    assert.equal(state.archive.fromTs, 1700001200); assert.equal(state.archive.toTs, 1700001800);
    assert.equal(state.archive.sessionMayContainArchiveData, true); assert.equal(f.records.get(SID), stickyRecord);
    assert.equal(stickyRecord.mayContainArchiveData, true);
    await f.runtime.dispose(); assert.ok(f.events.includes('channel-dispose')); assert.equal(f.counts.polls, 1);
  });
  await test('running Bot revoke drains polling without restarting or clearing archive history', async () => {
    const f = fixture({ account: 'synthetic-running-bot-revoke' });
    assert.equal((await create(f)).ok, true); assert.equal((await grant(f, true)).ok, true);
    const rows = await f.runtime.action({ action: 'queryArchive', sessionId: SID, query: { action: 'messages', talker: 'synthetic-talker', limit: 2 } });
    assert.equal(rows.ok, true); assert.equal(rows.result.rows[0].content, 'SYNTHETIC_ROW');
    const running = await start(f); assert.equal(running.ok, true);
    assert.equal(running.state.channel.messagingEnabled, true); assert.equal(running.state.channel.automaticPolling, true);
    await f.pollStarted.promise; assert.equal(f.counts.polls, 1);
    const stickyRecord = f.records.get(SID), revoked = await revoke(f); assert.equal(revoked.ok, true);
    const state = f.runtime.getState({ sessionId: SID });
    assert.equal(state.channel.messagingEnabled, false); assert.equal(state.channel.automaticPolling, false); assert.equal(f.counts.polls, 1);
    assert.equal(f.grants.size, 0); assert.equal(f.grants.has(SID), false);
    assert.equal(state.archive.granted, false); assert.equal(state.archive.allowWechat, false); assert.equal(state.archive.shareable, false);
    assert.equal(state.archive.sessionMayContainArchiveData, true); assert.equal(f.records.get(SID), stickyRecord);
    assert.equal(stickyRecord.mayContainArchiveData, true);
    await f.runtime.dispose(); assert.ok(f.events.includes('channel-dispose')); assert.equal(f.counts.polls, 1);
  });
  await test('Task wire and Owner authentication reject forged requests before capability effects', async () => {
    assert.deepEqual([...CONVERSATION_METHOD_NAMES], ['getConversationState', 'conversationAction']);
    assert.equal(CONVERSATION_ACTION_NAMES.length, 12);
    const f = taskFixture(), before = { ...f.counts };
    const valid = { kind: 'task', action: 'resumeConversation', sessionId: TASK_SID, confirmation: 'resume-task-conversation' };
    assert.equal(TASK_WIRE.actionSchema.safeParse(valid).success, true);
    for (const invocation of [undefined, null, {}, { actor: 'owner' }, { peer: {} }, { peer: { principal: { kind: 'guest' } } }]) {
      const receiver = { ctx: { invocation }, runtime: f.runtime };
      const denied = await WechatConversationService.prototype.conversationAction.call(receiver, valid);
      assert.deepEqual(denied, { ok: false, error: { code: 'NOT_AUTHORIZED' } });
      assert.throws(() => WechatConversationService.prototype.getConversationState.call(receiver, { kind: 'task', sessionId: TASK_SID }), error => error.code === 'NOT_AUTHORIZED');
    }
    const invalid = [
      { ...valid, kind: 'assistant' }, { ...valid, confirmation: 'resume-readonly-conversation' }, { ...valid, actor: 'owner' },
      ...[CONTEXT, SID, 'wechat-task-not-a-uuid', 'wechat-task-00000000-0000-1000-8000-000000000001'].map(sessionId => ({ ...valid, sessionId })),
      { kind: 'task', action: 'createConversation', contextSessionId: CONTEXT,
        workspace: { root: TASK_WORKSPACE, title: 'Synthetic workspace', allowWechat: true } },
      { kind: 'task', action: 'createConversation', contextSessionId: CONTEXT,
        workspace: { root: TASK_WORKSPACE, title: 'Synthetic workspace', allowWechat: true, confirmation: 'read-task-directory' } },
      { kind: 'task', action: 'queryFiles', sessionId: TASK_SID, query: { action: 'write', reference: 'synthetic', content: 'No UI write capability' } },
      { kind: 'task', action: 'querySource', sessionId: TASK_SID, query: { action: 'sql', query: 'SELECT 1' } },
    ];
    for (const request of invalid) {
      assert.equal(TASK_WIRE.actionSchema.safeParse(request).success, false);
      assert.deepEqual(await f.runtime.action(request), { ok: false, error: { code: 'INVALID_REQUEST' } });
    }
    assert.deepEqual(f.counts, before); assert.equal(f.taskRecords.size, 0); assert.equal(f.oldRecords.size, 0);
    assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  });
  await test('one-text Task wire requires its own consent and canonical Owner before any effects', async () => {
    const f = taskFixture(), before = { ...f.counts };
    const request = { kind: 'task', action: 'pollTextOnce', sessionId: TASK_SID, allowSharedContext: true, confirmation: 'poll-one-text-reply' };
    assert.equal(TASK_WIRE.actionSchema.safeParse(request).success, true);
    assert.equal(actionSchema.safeParse(request).success, false);
    const { kind, allowSharedContext, confirmation, ...withoutKind } = request;
    for (const invalid of [withoutKind, { ...request, allowSharedContext: false }, { ...request, allowSharedContext: undefined },
      { ...request, confirmation: 'poll-and-reply' }, { ...request, confirmation: undefined }, { ...request, maxMessages: 2 },
      { ...request, attachments: true }, { ...request, sessionId: SID }, { ...request, actor: 'owner' }]) {
      assert.deepEqual(await f.runtime.action(invalid), { ok: false, error: { code: 'INVALID_REQUEST' } });
    }
    for (const invocation of [undefined, {}, { actor: 'owner' }, { peer: { principal: { kind: 'guest' } } }]) {
      const receiver = { ctx: { invocation }, runtime: f.runtime };
      assert.deepEqual(await WechatConversationService.prototype.conversationAction.call(receiver, request), { ok: false, error: { code: 'NOT_AUTHORIZED' } });
    }
    assert.deepEqual(f.counts, before); assert.equal(f.taskRecords.size, 0);
    void [kind, allowSharedContext, confirmation];
  });
  await test('update diagnostic requires exact Task confirmation and authenticated Owner before any effects', async () => {
    const f = taskFixture(), before = { ...f.counts };
    const request = { kind: 'task', action: 'diagnoseUpdatesOnce', sessionId: TASK_SID, confirmation: 'read-one-wechat-update-diagnostic' };
    assert.equal(TASK_WIRE.actionSchema.safeParse(request).success, true);
    assert.equal(actionSchema.safeParse(request).success, false);
    const { kind, ...withoutKind } = request;
    for (const invalid of [withoutKind, { ...request, confirmation: undefined }, { ...request, confirmation: 'poll-one-text-reply' },
      { ...request, allowSharedContext: true }, { ...request, retry: true }, { ...request, body: 'SYNTHETIC_PRIVATE_TEXT' },
      { ...request, sessionId: SID }, { ...request, actor: 'owner' }]) {
      assert.deepEqual(await f.runtime.action(invalid), { ok: false, error: { code: 'INVALID_REQUEST' } });
    }
    for (const invocation of [undefined, {}, { actor: 'owner' }, { peer: { principal: { kind: 'guest' } } }]) {
      assert.deepEqual(await WechatConversationService.prototype.conversationAction.call({ ctx: { invocation }, runtime: f.runtime }, request),
        { ok: false, error: { code: 'NOT_AUTHORIZED' } });
    }
    assert.deepEqual(f.counts, before); assert.equal(f.taskRecords.size, 0);
    void kind;
  });
  await test('new first-text decision has a strict exact-Task request and canonical Owner before effects', async () => {
    const f = taskFixture(), before = { ...f.counts };
    const request = { kind: 'task', action: 'allowNewFirstText', sessionId: TASK_SID,
      priorRunId: '10000000-0000-4000-8000-000000000001', priorConsentId: '20000000-0000-4000-8000-000000000001', confirmation: 'allow-new-first-text-after-unknown' };
    assert.equal(TASK_WIRE.TASK_ACTION_NAMES.length, 35); assert.equal(TASK_WIRE.TASK_ACTION_NAMES.at(-1), 'refreshDailyCards');
    assert.equal(TASK_WIRE.actionSchema.safeParse(request).success, true); assert.equal(actionSchema.safeParse(request).success, false);
    const { kind, ...withoutKind } = request;
    for (const invalid of [withoutKind, { ...request, priorRunId: undefined }, { ...request, priorConsentId: undefined },
      { ...request, priorRunId: 'synthetic-invalid-id' }, { ...request, confirmation: undefined }, { ...request, confirmation: 'poll-one-text-reply-with-first-task-text' },
      { ...request, retry: true }, { ...request, allowSharedContext: true }, { ...request, body: 'SYNTHETIC_PRIVATE_TEXT' },
      { ...request, sessionId: SID }, { ...request, actor: 'owner' }]) {
      assert.deepEqual(await f.runtime.action(invalid), { ok: false, error: { code: 'INVALID_REQUEST' } });
    }
    for (const invocation of [undefined, {}, { actor: 'owner' }, { peer: { principal: { kind: 'guest' } } }]) {
      assert.deepEqual(await WechatConversationService.prototype.conversationAction.call({ ctx: { invocation }, runtime: f.runtime }, request),
        { ok: false, error: { code: 'NOT_AUTHORIZED' } });
    }
    assert.deepEqual(f.counts, before); assert.equal(f.taskRecords.size, 0); void kind;
  });
  await test('new first-text receipt remains FIRST-only and old context defaults to no new-input authority', async () => {
    const receipt = { purpose: 'first-text-once', operation: 'new-input', priorRunId: '10000000-0000-4000-8000-000000000001',
      priorConsentId: '20000000-0000-4000-8000-000000000001', decisionId: '30000000-0000-4000-8000-000000000001', newInputAllowed: true, auditCommitted: true };
    assert.equal(TASK_WIRE.firstTextReceiptSchema.safeParse(receipt).success, true);
    for (const invalid of [{ ...receipt, purpose: 'history-text-once' }, { ...receipt, newInputAllowed: false }, { ...receipt, auditCommitted: false },
      { ...receipt, body: 'SYNTHETIC_PRIVATE_TEXT' }, { ...receipt, priorRunId: undefined }, { ...receipt, priorConsentId: undefined }]) {
      assert.equal(TASK_WIRE.firstTextReceiptSchema.safeParse(invalid).success, false);
    }
    const { purpose, ...historyReceipt } = receipt; assert.equal(TASK_WIRE.historyReceiptSchema.safeParse(historyReceipt).success, false);
    const context = { version: 1, purpose: 'first-text-once', supported: false, required: false, reason: 'run-unresolved', phase: 'blocked',
      workspace: null, consumedCount: 0, consentId: null, sharingConfirmed: false, executable: false, receipts: [], model: null, native: null, preparation: null };
    assert.equal(TASK_WIRE.firstTextContextSchema.parse(context).newInputAllowed, false);
    assert.equal(TASK_WIRE.firstTextResultSchema.safeParse({ firstTextContext: { ...context, newInputAllowed: true }, receipt }).success, true);
    assert.equal(TASK_WIRE.firstTextResultSchema.safeParse({ firstTextContext: context, receipt: { ...receipt, auditCommitted: false } }).success, false);
    void purpose;
  });
  await test('new first-text Owner forwards only the prior IDs and validates the result without channel effects', async () => {
    const priorRunId = '10000000-0000-4000-8000-000000000001', priorConsentId = '20000000-0000-4000-8000-000000000001';
    const receipt = { purpose: 'first-text-once', operation: 'new-input', priorRunId, priorConsentId,
      decisionId: '30000000-0000-4000-8000-000000000001', newInputAllowed: true, auditCommitted: true };
    for (const malformed of [false, true, 'missing-capability']) {
      const f = taskFixture(); await taskCreate(f); let forwarded = 0;
      for (const name of ['getHistoricalState', 'reviewHistoricalContext', 'authorizeHistoricalContext', 'shareHistoricalContext',
        'revokeHistoricalContext', 'reserveHistoricalText', 'verifyHistoricalText', 'finishHistoricalText']) f.data[name] = () => { throw new Error('New-input route must not call historical execution'); };
      f.taskBridge.replyHistorical = () => { throw new Error('New-input route must not call model execution'); };
      const context = { version: 1, purpose: 'first-text-once', supported: true, required: true, reason: null, phase: 'blocked',
        workspace: { id: 'synthetic-task-workspace', root: TASK_WORKSPACE }, consumedCount: 1, consentId: null, sharingConfirmed: false,
        executable: false, receipts: [receipt], model: null, native: null, preparation: null, newInputAllowed: true };
      if (malformed !== 'missing-capability') f.data.allowNewFirstText = async (id, request, signal) => {
        forwarded++; assert.equal(id, TASK_SID); assert.equal(signal.aborted, false);
        assert.deepEqual(request, { priorRunId, priorConsentId, confirmation: 'allow-new-first-text-after-unknown' });
        return { firstTextContext: context, receipt: malformed ? { ...receipt, body: 'SYNTHETIC_PRIVATE_TEXT' } : receipt };
      };
      const before = structuredClone(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).task);
      const result = await taskAction(f, 'allowNewFirstText', { priorRunId, priorConsentId, confirmation: 'allow-new-first-text-after-unknown' });
      assert.equal(result.ok, malformed === false);
      if (malformed === false) assert.deepEqual(result.result, { firstTextContext: context, receipt });
      if (malformed === 'missing-capability') assert.deepEqual(result, { ok: false, error: { code: 'UNAVAILABLE' } });
      assert.equal(forwarded, malformed === 'missing-capability' ? 0 : 1);
      assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_TEXT'), false);
      assert.deepEqual(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).task, before);
      assert.equal(f.counts.credentialFactory + f.counts.channelFactory + f.counts.apiFactory + f.counts.polls + f.counts.textPolls + f.counts.replies, 0);
    }
  });
  await test('update diagnostic refuses unavailable capability without polling or replying', async () => {
    const f = taskFixture({ withoutDiagnostics: true }); await taskCreate(f);
    assert.deepEqual(await taskAction(f, 'diagnoseUpdatesOnce', { confirmation: 'read-one-wechat-update-diagnostic' }),
      { ok: false, error: { code: 'UNAVAILABLE' } });
    assert.equal(f.counts.diagnostics + f.counts.polls + f.counts.textPolls + f.counts.replies, 0);
    assert.equal(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).task.allowWechat, false);
  });
  await test('update diagnostic keeps sending disabled and serializes only the same paired account', async () => {
    const barrier = deferred(), f = taskFixture({ account: 'synthetic-diagnostic-lock', diagnosticBarrier: barrier, diagnosticResult: DIAGNOSTIC_EMPTY });
    await taskCreate(f);
    const before = structuredClone(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).task);
    const pending = taskAction(f, 'diagnoseUpdatesOnce', { confirmation: 'read-one-wechat-update-diagnostic' });
    await f.diagnosticStarted.promise;
    const same = taskFixture({ account: 'synthetic-diagnostic-lock', diagnosticResult: DIAGNOSTIC_EMPTY }); await taskCreate(same);
    assert.deepEqual(await taskAction(same, 'diagnoseUpdatesOnce', { confirmation: 'read-one-wechat-update-diagnostic' }),
      { ok: false, error: { code: 'BUSY' } });
    const different = taskFixture({ account: 'synthetic-diagnostic-other', diagnosticResult: DIAGNOSTIC_EMPTY }); await taskCreate(different);
    assert.equal((await taskAction(different, 'diagnoseUpdatesOnce', { confirmation: 'read-one-wechat-update-diagnostic' })).ok, true);
    assert.deepEqual(await taskTextOnce(f), { ok: false, error: { code: 'BUSY' } });
    barrier.resolve(); const result = await pending;
    assert.equal(result.ok, true); assert.deepEqual(result.result, { diagnostic: DIAGNOSTIC_EMPTY });
    assert.deepEqual(result.state.task, before); assert.equal(result.state.channel.messagingEnabled, false);
    assert.equal(result.state.channel.automaticPolling, false); assert.equal(result.state.channel.requestAccepted, 0);
    assert.equal((await taskAction(same, 'diagnoseUpdatesOnce', { confirmation: 'read-one-wechat-update-diagnostic' })).ok, true);
    assert.equal(f.counts.diagnostics, 1); assert.equal(same.counts.diagnostics, 1); assert.equal(different.counts.diagnostics, 1);
    assert.equal(f.counts.replies + f.counts.textPolls + f.counts.polls + f.counts.shareChanges + f.counts.oldWrites, 0);
  });
  await test('update diagnostic cancellation releases the account without retry or result', async () => {
    const f = taskFixture({ account: 'synthetic-diagnostic-cancel', diagnosticBarrier: deferred(), diagnosticResult: DIAGNOSTIC_EMPTY }); await taskCreate(f);
    const pending = taskAction(f, 'diagnoseUpdatesOnce', { confirmation: 'read-one-wechat-update-diagnostic' }); await f.diagnosticStarted.promise;
    assert.equal((await taskAction(f, 'stopChannel', { confirmation: 'stop-channel' })).ok, true);
    assert.deepEqual(await pending, { ok: false, error: { code: 'CANCELLED' } });
    const next = taskFixture({ account: 'synthetic-diagnostic-cancel', diagnosticResult: DIAGNOSTIC_EMPTY }); await taskCreate(next);
    assert.equal((await taskAction(next, 'diagnoseUpdatesOnce', { confirmation: 'read-one-wechat-update-diagnostic' })).ok, true);
    assert.equal(f.counts.diagnostics, 1); assert.equal(f.counts.replies + f.counts.textPolls + f.counts.polls, 0);
  });
  await test('update diagnostic rejects private or contradictory results at the Owner wire', async () => {
    for (const diagnosticResult of [{ ...DIAGNOSTIC_EMPTY, body: 'SYNTHETIC_PRIVATE_BODY' }, { ...DIAGNOSTIC_EMPTY, validationField: 'SYNTHETIC_PRIVATE_FIELD' },
      { ...DIAGNOSTIC_EMPTY, messageCount: 1 }, { ...DIAGNOSTIC_EMPTY, errorCode: 'network-error' },
      { ...DIAGNOSTIC_EMPTY, msgsShape: 'other' }, { ...DIAGNOSTIC_EMPTY, msgsShape: 'omitted', messageCount: 1, textCount: 1 },
      { ...DIAGNOSTIC_EMPTY, outcome: 'failed', errorCode: 'network-error', textCount: null, ignoredCount: null, validationField: 'text' }]) {
      assert.equal(TASK_WIRE.updatesDiagnosticSchema.safeParse(diagnosticResult).success, false);
      const f = taskFixture({ account: 'synthetic-diagnostic-malformed', diagnosticResult }); await taskCreate(f);
      const result = await taskAction(f, 'diagnoseUpdatesOnce', { confirmation: 'read-one-wechat-update-diagnostic' });
      assert.deepEqual(result, { ok: false, error: { code: 'ACTION_FAILED' } });
      assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'), false); assert.equal(f.counts.diagnostics, 1);
      assert.equal(f.counts.replies + f.counts.textPolls + f.counts.polls, 0);
    }
  });
  await test('update diagnostic drives one real parser request and preserves a retained v3 inbox and sending outbox', async () => {
    for (const invalid of [false, true]) {
      const auth = { baseUrl: 'https://ilinkai.weixin.qq.com', botId: 'synthetic-diagnostic-real-' + invalid,
        userId: 'synthetic-owner', botToken: 'SYNTHETIC_PRIVATE_TOKEN' };
      const retained = { messageId: 'retained-1', fromUserId: auth.userId, toUserId: auth.botId,
        contextToken: 'SYNTHETIC_PRIVATE_RETAINED_CONTEXT', text: 'SYNTHETIC_PRIVATE_RETAINED_INPUT' };
      const stored = { version: 3, revision: 7, sessionId: TASK_SID, credentials: auth, cursor: 'SYNTHETIC_PRIVATE_CURSOR', seenMessageIds: ['previous-1'],
        queuedBatch: { messages: [retained], received: 1, replied: 0, ignored: 0, duplicates: 0 },
        pending: { messageId: retained.messageId, phase: 'sending', next: 0,
          parts: [{ kind: 'text', clientId: 'retained-client', text: 'SYNTHETIC_PRIVATE_UNSENT_REPLY' }] } };
      const before = JSON.stringify(stored); let transports = 0, commits = 0;
      const realApi = createWeixinApi({ fetcher: async (url, init) => {
        transports++; assert.equal(new URL(url).pathname, '/ilink/bot/getupdates');
        assert.equal(JSON.parse(init.body).get_updates_buf, stored.cursor);
        const message = { message_id: '1', message_type: 1, message_state: 2, from_user_id: auth.userId, to_user_id: auth.botId,
          context_token: invalid ? '' : 'SYNTHETIC_PRIVATE_NEW_CONTEXT', item_list: [{ type: 1, text_item: { text: 'SYNTHETIC_PRIVATE_NEW_INPUT' } }] };
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'SYNTHETIC_PRIVATE_NEW_CURSOR', msgs: [message] }));
      } });
      const stateStore = { read: async () => structuredClone(stored), commit: async () => { commits++; throw new Error('Diagnostic cannot commit'); } };
      const f = taskFixture({ realApi, stateStore }); await taskCreate(f);
      const beforeTask = structuredClone(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).task);
      const result = await taskAction(f, 'diagnoseUpdatesOnce', { confirmation: 'read-one-wechat-update-diagnostic' });
      assert.equal(result.ok, true, JSON.stringify(result));
      const diagnostic = result.result.diagnostic;
      assert.equal(TASK_WIRE.updatesDiagnosticSchema.safeParse(diagnostic).success, true);
      assert.equal(diagnostic.outcome, invalid ? 'invalid' : 'valid'); assert.equal(diagnostic.errorCode, invalid ? 'invalid-response' : null);
      assert.equal(diagnostic.validationField, invalid ? 'context_token' : null);
      assert.equal(diagnostic.messageCount, 1); assert.equal(diagnostic.textCount, invalid ? null : 1); assert.equal(diagnostic.ignoredCount, invalid ? null : 0);
      assert.equal(transports, 1); assert.equal(commits, 0); assert.equal(f.counts.replies + f.counts.textPolls + f.counts.polls, 0);
      assert.equal(JSON.stringify(stored), before); assert.deepEqual(result.state.task, beforeTask);
      assert.equal(result.state.channel.pendingRecovery, true); assert.equal(result.state.channel.messagingEnabled, false);
      assert.equal(result.state.channel.automaticPolling, false); assert.equal(result.state.channel.requestAccepted, 0);
      assert.equal(JSON.stringify(diagnostic).includes('SYNTHETIC_PRIVATE'), false);
      assert.deepEqual(f.oldRecords.size, 0); assert.equal(f.counts.shareChanges + f.counts.oldWrites, 0);
    }
  });
  await test('retained Task text continuation requires exact schema and canonical Owner before effects', async () => {
    const f = taskFixture({ resumeAvailable: true }), before = { ...f.counts };
    const request = { kind: 'task', action: 'resumeTextOnce', sessionId: TASK_SID, allowSharedContext: true, confirmation: 'continue-unanswered-message' };
    assert.equal(TASK_WIRE.actionSchema.safeParse(request).success, true); assert.equal(actionSchema.safeParse(request).success, false);
    const { kind, ...withoutKind } = request;
    for (const invalid of [withoutKind, { ...request, confirmation: undefined }, { ...request, confirmation: 'poll-one-text-reply' },
      { ...request, allowSharedContext: false }, { ...request, sessionId: SID }, { ...request, actor: 'owner' }, { ...request, messageId: 'foreign-message' }]) {
      assert.deepEqual(await f.runtime.action(invalid), { ok: false, error: { code: 'INVALID_REQUEST' } });
    }
    for (const invocation of [undefined, {}, { actor: 'owner' }, { peer: { principal: { kind: 'guest' } } }]) {
      assert.deepEqual(await WechatConversationService.prototype.conversationAction.call({ ctx: { invocation }, runtime: f.runtime }, request),
        { ok: false, error: { code: 'NOT_AUTHORIZED' } });
    }
    assert.deepEqual(f.counts, before); assert.equal(f.taskRecords.size, 0); void kind;
  });
  await test('retained Task text continues exactly once without new polling or replacing archive grants', async () => {
    const account = 'synthetic-retained-text-success', f = taskFixture({ account, resumeAvailable: true });
    await taskCreate(f);
    await taskAction(f, 'grantSnapshot', { root: ROOT, allConversations: false, talkers: ['synthetic-talker'], fromTs: null, toTs: null,
      allowWechat: true, confirmation: 'read-decrypted-snapshot' });
    await taskShare(f);
    const source = structuredClone(f.taskRecords.get(TASK_SID).sources.get('archive')), before = { ...f.counts };
    const value = await taskAction(f, 'resumeTextOnce', { allowSharedContext: true, confirmation: 'continue-unanswered-message' });
    assert.equal(value.ok, true, JSON.stringify(value));
    assert.deepEqual(value.result, { received: 1, replied: 1, ignored: 0, duplicates: 0, remaining: 0 });
    assert.equal(f.counts.resumePolls, 1); assert.equal(f.counts.continuedReplies, 1); assert.equal(f.counts.sends, 1);
    assert.equal(f.counts.replies + f.counts.legacyReplies + f.counts.polls + f.counts.textPolls, 0);
    for (const key of ['creates', 'workspaces', 'directories', 'snapshots', 'revokes', 'queries', 'files', 'shareChanges']) assert.equal(f.counts[key], before[key]);
    assert.deepEqual(f.taskRecords.get(TASK_SID).sources.get('archive'), source);
    assert.equal(value.state.channel.requestAccepted, 1); assert.equal(value.state.channel.messagingEnabled, false);
    assert.equal(value.state.channel.automaticPolling, false); assert.equal(value.state.channel.resumeAvailable, false);
    assert.equal(f.channels[0].beforeSend(), false);
    const again = await taskAction(f, 'resumeTextOnce', { allowSharedContext: true, confirmation: 'continue-unanswered-message' });
    assert.equal(again.ok, false); assert.equal(again.error.code, 'SHARED_CONTEXT_DENIED');
    assert.equal(f.counts.resumePolls, 1); assert.equal(f.counts.continuedReplies, 1); assert.equal(f.counts.sends, 1);
    const other = fixture({ account }); await create(other); assert.equal((await start(other)).ok, true); await stop(other);
  });
  await test('retained Task text preflight rejects unavailable continuation and missing sharing', async () => {
    for (const options of [{ resumeAvailable: false }, { resumeAvailable: true, withoutResume: true }, { resumeAvailable: true, noSharing: true }]) {
      const f = taskFixture(options); await taskCreate(f); if (!options.noSharing) await taskShare(f);
      const value = await taskAction(f, 'resumeTextOnce', { allowSharedContext: true, confirmation: 'continue-unanswered-message' });
      assert.equal(value.ok, false); assert.equal(value.error.code, 'SHARED_CONTEXT_DENIED');
      assert.equal(f.counts.resumePolls + f.counts.continuedReplies + f.counts.sends + f.counts.polls + f.counts.textPolls + f.counts.replies, 0);
    }
  });
  await test('Stop aborts a retained Task continuation and releases ownership without late send or retry', async () => {
    const account = 'synthetic-retained-text-stop', barrier = deferred(), f = taskFixture({ account, resumeAvailable: true, continueBarrier: barrier });
    await taskCreate(f); await taskShare(f);
    const pending = taskAction(f, 'resumeTextOnce', { allowSharedContext: true, confirmation: 'continue-unanswered-message' });
    await f.pollStarted.promise; await Promise.resolve();
    assert.equal(f.counts.resumePolls, 1); assert.equal(f.counts.continuedReplies, 1);
    const busy = fixture({ account }); await create(busy); assert.deepEqual(await start(busy), { ok: false, error: { code: 'BUSY' } });
    assert.equal((await taskStop(f)).ok, true);
    const result = await pending; assert.equal(result.ok, false); assert.equal(result.error.code, 'CANCELLED');
    assert.equal(f.counts.sends, 0); assert.equal(f.counts.replies + f.counts.polls + f.counts.textPolls, 0);
    assert.equal(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).channel.messagingEnabled, false);
    assert.equal(f.channels[0].beforeSend(), false);
    barrier.resolve(); await Promise.resolve(); assert.equal(f.counts.sends, 0); assert.equal(f.counts.resumePolls, 1);
    assert.equal((await start(busy)).ok, true); await stop(busy);
  });
  await test('one-text Task start is awaited, consumes one call, and releases the account permit', async () => {
    const account = 'synthetic-one-text-success', f = taskFixture({ account });
    assert.equal((await taskCreate(f)).ok, true);
    assert.deepEqual(await taskTextOnce(f), { ok: false, error: { code: 'SHARED_CONTEXT_DENIED' } });
    assert.equal(f.counts.channelFactory, 0); assert.equal(f.counts.textPolls + f.counts.replies, 0);
    await taskShare(f);
    const value = await taskTextOnce(f);
    assert.equal(value.ok, true); assert.deepEqual(value.result, { received: 3, replied: 1, ignored: 0, duplicates: 0, remaining: 2 });
    assert.equal(value.state.channel.messagingEnabled, false); assert.equal(value.state.channel.automaticPolling, false);
    assert.equal(value.state.channel.requestAccepted, 1); assert.equal(f.counts.textPolls, 1); assert.equal(f.counts.replies, 1);
    assert.equal(f.counts.polls + f.counts.legacyReplies, 0); assert.equal(f.channels[0].beforeSend(), false);
    await Promise.resolve(); await Promise.resolve(); assert.equal(f.counts.textPolls, 1);
    const other = fixture({ account }); await create(other);
    assert.equal((await start(other)).ok, true); await other.pollStarted.promise; await stop(other);
    assert.equal(f.channels[0].beforeSend(), false);
  });
  await test('one-text mode never falls back to an old continuous channel implementation', async () => {
    const f = taskFixture({ withoutTextOnce: true }); await taskCreate(f); await taskShare(f);
    assert.deepEqual(await taskTextOnce(f), { ok: false, error: { code: 'UNAVAILABLE' } });
    assert.equal(f.counts.polls + f.counts.textPolls + f.counts.replies, 0);
    assert.equal(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).channel.automaticPolling, false);
    assert.equal(f.channels[0].beforeSend(), false);
  });
  await test('one-text empty result and failure finish without background work or automatic retry', async () => {
    for (const [mode, options] of [['empty', { textEmpty: true }], ['failure', { textFailure: true }]]) {
      const account = 'synthetic-one-text-' + mode, f = taskFixture({ ...options, account });
      await taskCreate(f); await taskShare(f);
      const value = await taskTextOnce(f);
      if (mode === 'empty') { assert.equal(value.ok, true); assert.deepEqual(value.result, { received: 0, replied: 0, ignored: 0, duplicates: 0, remaining: 0 }); }
      else { assert.equal(value.ok, false); assert.equal(value.error.code, 'ACTION_FAILED'); }
      const state = f.runtime.getState({ kind: 'task', sessionId: TASK_SID });
      assert.equal(state.channel.messagingEnabled, false); assert.equal(state.channel.automaticPolling, false);
      assert.equal(state.channel.requestAccepted, 0); assert.equal(f.counts.replies + f.counts.polls, 0); assert.equal(f.counts.textPolls, 1);
      assert.equal(f.channels[0].beforeSend(), false);
      await Promise.resolve(); await Promise.resolve(); assert.equal(f.counts.textPolls, 1);
      const other = fixture({ account }); await create(other); assert.equal((await start(other)).ok, true); await stop(other);
    }
  });
  await test('one-text request cancellation, stop and revocation abort and drain the same account permit', async () => {
    for (const mode of ['request', 'stop', 'revoke', 'sharing']) {
      const account = 'synthetic-one-text-cancel-' + mode, barrier = deferred(), f = taskFixture({ account, textBarrier: barrier });
      await taskCreate(f); await taskShare(f);
      const control = new AbortController(), pending = taskTextOnce(f, control.signal);
      await f.pollStarted.promise;
      const active = f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).channel;
      assert.equal(active.phase, 'polling'); assert.equal(active.messagingEnabled, true); assert.equal(active.automaticPolling, false);
      assert.deepEqual(await taskStart(f), { ok: false, error: { code: 'BUSY' } });
      const other = fixture({ account }); await create(other);
      assert.deepEqual(await start(other), { ok: false, error: { code: 'BUSY' } });
      if (mode === 'request') control.abort();
      else if (mode === 'stop') assert.equal((await taskStop(f)).ok, true);
      else if (mode === 'revoke') assert.equal((await taskAction(f, 'revokeSource', { sourceId: '*', confirmation: 'revoke-task-source' })).ok, true);
      else assert.equal((await taskShare(f, false)).ok, true);
      const cancelled = await pending; assert.equal(cancelled.ok, false); assert.equal(cancelled.error.code, 'CANCELLED');
      assert.equal(f.counts.textPolls, 1); assert.equal(f.counts.polls + f.counts.replies, 0); assert.equal(f.channels[0].beforeSend(), false);
      const stopped = f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).channel;
      assert.equal(stopped.messagingEnabled, false); assert.equal(stopped.automaticPolling, false);
      barrier.resolve(); await Promise.resolve(); assert.equal(f.counts.replies, 0);
      assert.equal((await start(other)).ok, true); await stop(other);
    }
  });
  await test('one-text cold preflight checks stored pairing locally and stops before any network when absent', async () => {
    let network = 0, commits = 0;
    const unpaired = { version: 3, revision: 1, sessionId: TASK_SID, credentials: null, cursor: '', seenMessageIds: [], queuedBatch: null, pending: null };
    const realApi = createWeixinApi({ fetcher: async () => { network++; throw new Error('No transport is authorized without stored pairing'); } });
    const stateStore = { read: async () => structuredClone(unpaired), commit: async () => { commits++; throw new Error('Preflight cannot pair or write'); } };
    const f = taskFixture({ realApi, stateStore }); await taskCreate(f); await taskShare(f);
    assert.equal(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).channel.enabled, false);
    const result = await taskTextOnce(f);
    assert.deepEqual(result, { ok: false, error: { code: 'PAIRING_REQUIRED' } });
    const channel = f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).channel;
    assert.equal(channel.enabled, true); assert.equal(channel.phase, 'unpaired'); assert.equal(channel.hasStoredLogin, false);
    assert.equal(channel.messagingEnabled, false); assert.equal(channel.automaticPolling, false);
    assert.equal(network + commits + f.counts.replies, 0); assert.equal(f.channels[0].beforeSend(), false);
  });
  await test('one-text Owner action drives real API and durable v3 text-only outbox with one Task text callback', async () => {
    const auth = { baseUrl: 'https://ilinkai.weixin.qq.com', botId: 'synthetic-one-text-real-bot', userId: 'synthetic-owner', botToken: 'SYNTHETIC_TOKEN' };
    let stored = { version: 3, revision: 1, sessionId: TASK_SID, credentials: auth, cursor: '', seenMessageIds: [], queuedBatch: null, pending: null };
    const requests = [], states = [];
    const realApi = createWeixinApi({ fetcher: async (url, init) => {
      const body = JSON.parse(init.body); requests.push({ url, body });
      if (url.endsWith('/getupdates')) {
        const message = id => ({ message_id: id, from_user_id: auth.userId, to_user_id: auth.botId, message_type: 1,
          message_state: 2, context_token: 'synthetic-context-' + id, item_list: [{ type: 1, text_item: { text: id === 1 ? 'SYNTHETIC_TASK_PHONE_INPUT' : 'SYNTHETIC_RETAINED_TEXT' } }] });
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'synthetic-one-text-cursor', msgs: [message(1), message(2), message(3),
          { ...message(4), item_list: [{ type: 4, file_item: { name: 'SYNTHETIC_ATTACHMENT' } }] }] }), { headers: { 'content-type': 'application/json' } });
      }
      assert.ok(url.endsWith('/sendmessage'), 'No media/CDN/login request is permitted in the bounded action');
      assert.equal(body.msg.to_user_id, auth.userId); assert.equal(body.msg.item_list.length, 1); assert.equal(body.msg.item_list[0].type, 1);
      return new Response('{"ret":0}', { headers: { 'content-type': 'application/json' } });
    } });
    const stateStore = { read: async () => structuredClone(stored), async commit(expected, next) {
      assert.equal(expected, stored.revision); assert.equal(next.revision, expected + 1); stored = structuredClone(next); states.push(structuredClone(next));
    } };
    const f = taskFixture({ realApi, stateStore }); await taskCreate(f); await taskShare(f);
    const value = await taskTextOnce(f);
    assert.equal(value.ok, true, JSON.stringify(value));
    assert.deepEqual(value.result, { received: 4, replied: 1, ignored: 1, duplicates: 0, remaining: 2 });
    assert.equal(requests.filter(request => request.url.endsWith('/getupdates')).length, 1);
    assert.equal(requests.filter(request => request.url.endsWith('/sendmessage')).length, 1);
    assert.equal(requests.length, 2); assert.equal(f.counts.replies, 1); assert.equal(f.counts.legacyReplies, 0);
    assert.equal(states[0].pending, null); assert.equal(states[0].queuedBatch.messages.length, 3);
    assert.deepEqual(states.filter(state => state.pending).map(state => state.pending.phase), ['replying', 'ready', 'sending']);
    assert.equal(states.find(state => state.pending?.phase === 'ready').pending.parts.length, 1);
    assert.equal(states.find(state => state.pending?.phase === 'ready').pending.parts[0].kind, 'text');
    assert.deepEqual(stored.queuedBatch.messages.map(message => message.messageId), ['2', '3']); assert.deepEqual(stored.seenMessageIds, ['1']);
    assert.equal(stored.pending, null); assert.equal(value.state.channel.requestAccepted, 1);
    assert.equal(value.state.channel.messagingEnabled, false); assert.equal(value.state.channel.automaticPolling, false);
    assert.equal(f.channels[0].beforeSend(), false); assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  });
  await test('Task constructor and GET selection remain memory-only without resuming or granting a source', () => {
    const f = taskFixture(), before = { ...f.counts };
    assert.equal(before.dataConstructors, 1); assert.equal(before.bridgeConstructors, 1);
    for (const sessionId of [undefined, TASK_SID, CONTEXT, TASK_SID]) {
      const request = sessionId === undefined ? { kind: 'task' } : { kind: 'task', sessionId };
      const value = f.runtime.getState(request);
      assert.equal(TASK_WIRE.stateSchema.safeParse(value).success, true); assert.equal(value.kind, 'task');
      assert.equal(value.sessionId, sessionId ?? null); assert.equal(value.prepared, false);
      assert.equal(value.task, null); assert.deepEqual(value.tasks, []); assert.equal(value.channel.automaticPolling, false);
      assert.deepEqual(value.workspaces, [{ id: 'synthetic-task-workspace', root: TASK_WORKSPACE, title: 'Synthetic workspace' }]);
    }
    assert.throws(() => f.runtime.getState({ sessionId: TASK_SID }), error => error.code === 'SESSION_NOT_READY');
    assert.deepEqual(f.counts, { ...before, metadataReads: before.metadataReads + 4 });
    assert.equal(f.oldRecords.size, 0); assert.equal(f.taskRecords.size, 0);
    assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  });
  await test('Owner Task creation binds only the explicitly confirmed workspace and never writes old RO history', async () => {
    const f = taskFixture(), value = await taskCreate(f);
    assert.equal(value.ok, true, JSON.stringify(value)); assert.equal(TASK_WIRE.actionResultSchema.safeParse(value).success, true);
    assert.equal(value.state.kind, 'task'); assert.equal(value.state.sessionId, TASK_SID); assert.equal(value.state.prepared, true);
    assert.deepEqual(value.result, { sessionId: TASK_SID });
    assert.equal(value.state.task.workspace.root, TASK_WORKSPACE); assert.equal(value.state.task.sources.length, 1);
    assert.equal(value.state.task.sources[0].sourceId, 'workspace'); assert.equal(value.state.task.sources[0].write, true);
    assert.equal(value.state.task.allowWechat, false); assert.equal(value.state.task.shareable, false);
    assert.deepEqual(value.state.tasks.map(task => task.sessionId), [TASK_SID]);
    assert.equal(f.counts.creates, 1); assert.equal(f.counts.workspaces, 1); assert.equal(f.oldRecords.size, 0);
    assert.equal(f.counts.oldOpen + f.counts.oldWrites + f.counts.oldGrants + f.counts.oldQueries, 0);
    assert.equal(f.counts.credentialFactory + f.counts.apiFactory + f.counts.channelFactory + f.counts.polls + f.counts.replies, 0);
    assert.equal(f.liveSessions.get(f.foreignId), f.foreign);
  });
  await test('explicit Task resume preserves the same SID without restoring grants, sharing or channel work', async () => {
    const f = taskFixture();
    f.taskRecords.set(TASK_SID, { prepared: false, workspace: { id: 'synthetic-task-workspace', root: TASK_WORKSPACE, title: 'Synthetic saved workspace' },
      sources: new Map(), consumed: new Map(), share: false });
    const before = { ...f.counts };
    assert.equal(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).prepared, false);
    assert.equal(f.counts.ensures, before.ensures);
    const value = await taskAction(f, 'resumeConversation', { confirmation: 'resume-task-conversation' });
    assert.equal(value.ok, true); assert.equal(value.state.prepared, true);
    assert.deepEqual(value.result, { sessionId: TASK_SID, sameSession: true });
    assert.deepEqual(value.state.task.sources, []); assert.equal(value.state.task.allowWechat, false);
    assert.equal(value.state.task.shareable, false); assert.equal(value.state.channel.automaticPolling, false);
    assert.equal(f.counts.ensures, 1); assert.equal(f.counts.creates + f.counts.workspaces + f.counts.shareChanges, 0);
    assert.equal(f.counts.oldOpen + f.counts.oldWrites + f.counts.credentialFactory + f.counts.channelFactory + f.counts.queries, 0);
    assert.equal(f.liveSessions.get(f.foreignId), f.foreign);
  });
  await test('Task directory, exact Session and snapshot RPC grants never migrate an ordinary data-only grant', async () => {
    const f = taskFixture(); assert.equal((await taskCreate(f)).ok, true);
    const ordinary = await f.runtime.action({ action: 'grantSnapshot', sessionId: CONTEXT, root: ROOT, allConversations: false,
      talkers: ['synthetic-old-talker'], fromTs: null, toTs: null, allowWechat: false, confirmation: 'read-decrypted-snapshot' });
    assert.equal(ordinary.ok, true); assert.equal(ordinary.state.prepared, false); assert.equal(ordinary.state.archive.allowWechat, false);
    const oldGrant = f.oldGrants.get(CONTEXT), oldRecord = f.oldRecords.get(CONTEXT);
    assert.equal(f.counts.oldGrants, 1); assert.equal(f.counts.ensures, 0);
    assert.equal((await taskAction(f, 'grantDirectory', { root: TASK_EXTRA, title: 'Synthetic extra directory', allowWechat: false, confirmation: 'read-task-directory' })).ok, true);
    assert.equal((await taskAction(f, 'grantSession', { sourceSessionId: 'synthetic-source-session', title: 'Synthetic exact source', allowWechat: true, confirmation: 'read-task-session' })).ok, true);
    assert.equal((await taskAction(f, 'grantSnapshot', { root: ROOT, allConversations: false, talkers: ['synthetic-talker'],
      fromTs: null, toTs: null, allowWechat: true, confirmation: 'read-decrypted-snapshot' })).ok, true);
    const archive = await taskAction(f, 'querySource', { query: { action: 'archive', query: { action: 'messages', talker: 'synthetic-talker', limit: 2 } } });
    const session = await taskAction(f, 'querySource', { query: { action: 'session', sourceId: 'synthetic-session-source', limit: 2 } });
    const files = await taskAction(f, 'queryFiles', { query: { action: 'list', sourceId: 'synthetic-extra-source' } });
    assert.equal(archive.ok, true); assert.equal(session.ok, true); assert.equal(files.ok, true);
    assert.equal(f.counts.directories, 1); assert.equal(f.counts.sessions, 1); assert.equal(f.counts.snapshots, 1);
    assert.equal(f.counts.queries, 2); assert.equal(f.counts.files, 1); assert.equal(f.counts.oldQueries, 0);
    assert.equal(f.oldGrants.get(CONTEXT), oldGrant); assert.equal(f.oldRecords.get(CONTEXT), oldRecord);
    const badLegacy = await f.runtime.action({ action: 'grantSnapshot', sessionId: TASK_SID, root: ROOT, allConversations: false,
      talkers: ['synthetic-talker'], fromTs: null, toTs: null, allowWechat: false, confirmation: 'read-decrypted-snapshot' });
    assert.equal(badLegacy.ok, false); assert.equal(badLegacy.error.code, 'SESSION_NOT_READY');
    const missingKind = await f.runtime.action({ action: 'grantDirectory', sessionId: TASK_SID, root: TASK_EXTRA,
      title: 'Synthetic extra directory', allowWechat: false, confirmation: 'read-task-directory' });
    assert.equal(missingKind.ok, false); assert.equal(missingKind.error.code, 'INVALID_REQUEST');
    assert.equal((await taskAction(f, 'revokeSource', { sourceId: 'archive', confirmation: 'revoke-task-source' })).ok, true);
    assert.equal(f.taskRecords.get(TASK_SID).sources.has('archive'), false); assert.equal(f.oldGrants.get(CONTEXT), oldGrant);
    assert.equal(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).task.contextBlocked, true);
  });
  await test('Task start requires whole-context sharing and every consumed source generation before channel creation', async () => {
    const f = taskFixture(); assert.equal((await taskCreate(f)).ok, true);
    const closed = await taskStart(f); assert.equal(closed.ok, false); assert.equal(closed.error.code, 'SHARED_CONTEXT_DENIED');
    assert.equal((await taskShare(f)).ok, true);
    const record = f.taskRecords.get(TASK_SID); record.sources.get('workspace').allowWechat = false;
    assert.equal((await taskAction(f, 'queryFiles', { query: { action: 'read', path: 'synthetic-document.md' } })).ok, true);
    const denied = await taskStart(f); assert.equal(denied.ok, false); assert.equal(denied.error.code, 'SHARED_CONTEXT_DENIED');
    assert.equal((await taskAction(f, 'grantWorkspace', { workspace: { root: TASK_WORKSPACE, title: 'Synthetic workspace reauthorization',
      allowWechat: true, confirmation: 'read-and-write-task-workspace' } })).ok, true);
    const oldContext = await taskStart(f); assert.equal(oldContext.ok, false); assert.equal(oldContext.error.code, 'SHARED_CONTEXT_DENIED');
    assert.equal(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).task.contextBlocked, true);
    assert.equal(f.counts.credentialFactory + f.counts.apiFactory + f.counts.channelFactory + f.counts.polls, 0);
    assert.equal(f.counts.oldOpen + f.counts.oldWrites, 0);
  });
  await test('Task and readonly channels use one Host account lock with no second poller', async () => {
    const account = 'synthetic-task-readonly-shared-account', old = fixture({ account }), task = taskFixture({ account });
    assert.equal((await create(old)).ok, true); assert.equal((await taskCreate(task)).ok, true); assert.equal((await taskShare(task)).ok, true);
    assert.equal((await start(old)).ok, true); await old.pollStarted.promise;
    const deniedTask = await taskStart(task); assert.equal(deniedTask.ok, false); assert.equal(deniedTask.error.code, 'BUSY');
    assert.equal(task.counts.polls, 0); assert.equal(old.counts.polls, 1);
    await stop(old); assert.equal((await taskStart(task)).ok, true); await task.pollStarted.promise;
    const deniedOld = await start(old); assert.equal(deniedOld.ok, false); assert.equal(deniedOld.error.code, 'BUSY');
    assert.equal(task.counts.polls, 1); assert.equal(old.counts.polls, 1);
    assert.equal((await taskStop(task)).ok, true); assert.equal(task.runtime.getState({ kind: 'task', sessionId: TASK_SID }).channel.automaticPolling, false);
  });
  await test('Task channel reply uses the Task bridge and source revocation stops and drains its send permission', async () => {
    const f = taskFixture({ account: 'synthetic-task-revoke-reply', driveReply: true });
    assert.equal((await taskCreate(f)).ok, true); assert.equal((await taskShare(f)).ok, true);
    const running = await taskStart(f); assert.equal(running.ok, true); assert.equal(running.state.channel.automaticPolling, true);
    await f.pollStarted.promise; await f.replySettled.promise;
    assert.equal(f.counts.replies, 1); assert.equal(f.counts.legacyReplies, 0); assert.equal(f.channels[0].beforeSend(), true);
    const revoked = await taskAction(f, 'revokeSource', { sourceId: 'workspace', confirmation: 'revoke-task-source' });
    assert.equal(revoked.ok, true); assert.equal(revoked.state.channel.automaticPolling, false);
    assert.equal(revoked.state.task.shareable, false); assert.equal(f.channels[0].beforeSend(), false);
    assert.equal(f.counts.polls, 1); assert.equal(f.counts.replies, 1); assert.equal(f.counts.revokes, 1);
    assert.equal(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).task.sources.some(source => source.sourceId === 'workspace'), false);
    assert.equal(f.counts.oldOpen + f.counts.oldQueries, 0);
  });
  await test('Task source revocation cancels an in-flight read and withholds a deliberately late provider result', async () => {
    const barrier = deferred(), f = taskFixture({ queryBarrier: barrier }); assert.equal((await taskCreate(f)).ok, true);
    assert.equal((await taskAction(f, 'grantSession', { sourceSessionId: 'synthetic-source-session', title: 'Synthetic exact source',
      allowWechat: true, confirmation: 'read-task-session' })).ok, true);
    const pendingRead = taskAction(f, 'querySource', { query: { action: 'session', sourceId: 'synthetic-session-source', limit: 2 } });
    await f.queryStarted.promise;
    const revokeRead = taskAction(f, 'revokeSource', { sourceId: 'synthetic-session-source', confirmation: 'revoke-task-source' });
    await Promise.resolve(); barrier.resolve();
    const [revoked, read] = await Promise.all([revokeRead, pendingRead]);
    assert.equal(revoked.ok, true); assert.equal(read.ok, false); assert.equal(read.error.code, 'CANCELLED');
    assert.equal(JSON.stringify(read).includes('SYNTHETIC_LATE_TASK_ROW'), false);
    assert.equal(f.taskRecords.get(TASK_SID).consumed.size, 1); assert.equal(f.taskRecords.get(TASK_SID).sources.has('synthetic-session-source'), false);
    assert.equal(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).task.contextBlocked, true);
  });
  await test('Task stop cancels an in-flight directory grant without restoring a late authorization', async () => {
    const barrier = deferred(), f = taskFixture({ grantBarrier: barrier }); assert.equal((await taskCreate(f)).ok, true);
    const pendingGrant = taskAction(f, 'grantDirectory', { root: TASK_EXTRA, title: 'Synthetic late directory', allowWechat: true,
      confirmation: 'read-task-directory' });
    await f.grantStarted.promise; const stopping = taskStop(f); await Promise.resolve(); barrier.resolve();
    const [stopped, granted] = await Promise.all([stopping, pendingGrant]);
    assert.equal(stopped.ok, true); assert.equal(granted.ok, false); assert.equal(granted.error.code, 'CANCELLED');
    assert.equal(f.taskRecords.get(TASK_SID).sources.has('synthetic-extra-source'), false);
    assert.equal(f.counts.directories, 1); assert.equal(f.counts.files + f.counts.polls + f.counts.credentialFactory, 0);
  });
  await test('Task stop during late pairing identity cannot schedule a restarted loop', async () => {
    const barrier = deferred(), f = taskFixture({ account: 'synthetic-task-late-identity', identityBarrier: barrier });
    assert.equal((await taskCreate(f)).ok, true); assert.equal((await taskShare(f)).ok, true);
    const pendingStart = taskStart(f); await f.identityStarted.promise;
    const stopping = taskStop(f); await Promise.resolve(); barrier.resolve();
    const [stopped, started] = await Promise.all([stopping, pendingStart]);
    assert.equal(stopped.ok, true); assert.equal(started.ok, false); assert.equal(started.error.code, 'CANCELLED');
    assert.equal(f.counts.polls, 0); assert.equal(f.runtime.getState({ kind: 'task', sessionId: TASK_SID }).channel.automaticPolling, false);
  });
  await test('Owner roster preparation reads only explicitly confirmed contacts and never grants model message access', async () => {
    const f = taskFixture();
    const request = { kind: 'task', action: 'prepareSnapshot', contextSessionId: CONTEXT, root: ROOT, query: 'Synthetic',
      limit: 7, offset: 0, confirmation: 'browse-snapshot-roster' };
    const outside = { ctx: { invocation: undefined }, runtime: f.runtime };
    assert.deepEqual(await WechatConversationService.prototype.conversationAction.call(outside, request), { ok: false, error: { code: 'NOT_AUTHORIZED' } });
    assert.equal(f.counts.rosterReads, 0);
    const owner = { ctx: { invocation: { peer: { principal: { kind: 'owner' } } } }, runtime: f.runtime };
    const value = await WechatConversationService.prototype.conversationAction.call(owner, request);
    assert.equal(value.ok, true); assert.equal(value.result.action, 'contacts');
    assert.deepEqual(value.result.rows, [{ talker: 'synthetic-talker', displayName: 'Synthetic contact' }]);
    assert.equal(f.counts.rosterReads, 1);
    assert.deepEqual(f.rosterRequests, [{ confirmation: 'browse-snapshot-roster', query: 'Synthetic', limit: 7, offset: 0 }]);
    assert.equal(f.taskRecords.size, 0); assert.equal(f.oldRecords.size, 0);
    assert.equal(f.counts.creates + f.counts.ensures + f.counts.snapshots + f.counts.queries + f.counts.oldGrants + f.counts.oldQueries + f.counts.oldOpen, 0);
    f.liveSessions.delete(CONTEXT);
    const unloaded = await f.runtime.action(request); assert.equal(unloaded.ok, false); assert.equal(unloaded.error.code, 'SESSION_NOT_READY');
    assert.equal(f.counts.rosterReads, 1);
    for (const root of [ORIGINAL, ORIGINAL + '/db', desktopPath(desktopHome(), 'Documents')]) {
      const forbidden = await f.runtime.action({ ...request, root }); assert.equal(forbidden.ok, false); assert.equal(forbidden.error.code, 'SNAPSHOT_DENIED');
    }
    assert.equal(f.counts.rosterReads, 1); assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  });
  await test('Owner roster result arriving after context unload is dropped without an Agent resume or Task grant', async () => {
    const barrier = deferred(), f = taskFixture({ rosterBarrier: barrier });
    const pendingRoster = f.runtime.action({ kind: 'task', action: 'prepareSnapshot', contextSessionId: CONTEXT, root: ROOT,
      confirmation: 'browse-snapshot-roster' });
    await f.rosterStarted.promise; f.liveSessions.delete(CONTEXT); barrier.resolve();
    const value = await pendingRoster; assert.equal(value.ok, false); assert.equal(value.error.code, 'SESSION_NOT_READY');
    assert.equal(JSON.stringify(value).includes('Synthetic contact'), false); assert.equal(f.taskRecords.size, 0); assert.equal(f.oldRecords.size, 0);
    assert.equal(f.counts.creates + f.counts.ensures + f.counts.snapshots + f.counts.queries + f.counts.oldOpen, 0);
  });
  await test('managed history owner actions import once; stopped updates and manual archive grants cannot restore automatic reads', async () => {
    let runs=0;
    const f=taskFixture({runLocalHistory:async()=>{runs++;return {account_ref:'a'.repeat(12),snapshot_directory:ROOT,captured_at:'2026-11-18T22:00:00+08:00',snapshot_id:'a'.repeat(32),changed:true,database_count:3};}});
    await taskCreate(f);
    const imported=await taskAction(f,'importLocalHistory',{autoUpdate:false,allowWechat:false,confirmation:'import-own-wechat-history'});
    assert.equal(imported.ok,true);assert.equal(runs,1);assert.equal(f.counts.snapshots,1);
    assert.equal(imported.state.channel.localHistory.enabled,true);assert.equal(imported.state.channel.localHistory.autoUpdate,false);
    assert.equal(f.data.canShare(TASK_SID),false);assert.equal(f.counts.polls,0);
    await taskAction(f,'grantSnapshot',{root:ROOT,allConversations:true,talkers:[],fromTs:null,toTs:null,allowWechat:false,confirmation:'read-decrypted-snapshot'});
    assert.equal(f.runtime.getState({kind:'task',sessionId:TASK_SID}).channel.localHistory.phase,'stopped');
    await taskAction(f,'refreshLocalHistory',{confirmation:'refresh-own-wechat-history'});assert.equal(runs,1);
  });
  await test('managed refresh failure keeps the granted archive and revocation stops later checks', async () => {
    let runs=0;
    const f=taskFixture({runLocalHistory:async()=>{if(++runs>1)throw new Error('synthetic failure');return {account_ref:'a'.repeat(12),snapshot_directory:ROOT,captured_at:'2026-11-18T22:00:00+08:00',snapshot_id:'a'.repeat(32),changed:true,database_count:3};}});
    await taskCreate(f);await taskAction(f,'importLocalHistory',{autoUpdate:true,allowWechat:true,confirmation:'import-own-wechat-history'});
    const original=structuredClone(f.taskRecords.get(TASK_SID).sources.get('archive'));
    const refreshed=await taskAction(f,'refreshLocalHistory',{confirmation:'refresh-own-wechat-history'});
    assert.equal(refreshed.ok,true);assert.equal(refreshed.state.channel.localHistory.phase,'failed');
    assert.deepEqual(f.taskRecords.get(TASK_SID).sources.get('archive'),original);
    await taskAction(f,'revokeSource',{sourceId:'archive',confirmation:'revoke-task-source'});
    assert.equal(f.runtime.getState({kind:'task',sessionId:TASK_SID}).channel.localHistory.enabled,false);
    await taskAction(f,'refreshLocalHistory',{confirmation:'refresh-own-wechat-history'});assert.equal(runs,2);
  });
  await test('Task disposal drains its poll and owns only its data and bridge, leaving a foreign Session untouched', async () => {
    const f = taskFixture({ account: 'synthetic-task-owned-disposal' });
    assert.equal((await taskCreate(f)).ok, true); assert.equal((await taskShare(f)).ok, true); assert.equal((await taskStart(f)).ok, true);
    await f.pollStarted.promise; await f.runtime.dispose(); await f.runtime.dispose();
    assert.equal(f.counts.bridgeDisposes, 1); assert.equal(f.counts.dataDisposes, 1);
    assert.ok(f.events.includes('task-channel-dispose')); assert.equal(f.taskRecords.get(TASK_SID).sources.size, 0);
    assert.equal(f.liveSessions.get(f.foreignId), f.foreign); assert.equal(f.foreign.header.id, f.foreignId);
    assert.equal(f.channels[0].beforeSend(), false);
    assert.throws(() => f.runtime.getState({ kind: 'task', sessionId: TASK_SID }), error => error.code === 'UNAVAILABLE');
    assert.deepEqual(await taskStop(f), { ok: false, error: { code: 'UNAVAILABLE' } });
    assert.equal(f.counts.oldOpen + f.counts.oldWrites, 0);
  });
  await test('cancelled Task creation cannot publish a late prepared catalog entry or restore its workspace grant', async () => {
    const preCancelled = taskFixture(), preControl = new AbortController(); preControl.abort();
    assert.deepEqual(await taskCreate(preCancelled, preControl.signal), { ok: false, error: { code: 'CANCELLED' } });
    assert.deepEqual(await taskCreate(preCancelled, {}), { ok: false, error: { code: 'INVALID_REQUEST' } });
    assert.equal(preCancelled.counts.creates + preCancelled.counts.workspaces + preCancelled.counts.oldOpen, 0);
    const barrier = deferred(), f = taskFixture({ creationBarrier: barrier }), control = new AbortController();
    const pendingCreate = taskCreate(f, control.signal); await f.createStarted.promise; control.abort(); barrier.resolve();
    const value = await pendingCreate; assert.equal(value.ok, false); assert.equal(value.error.code, 'CANCELLED');
    const memory = f.runtime.getState({ kind: 'task', sessionId: TASK_SID });
    assert.equal(memory.prepared, false); assert.deepEqual(memory.tasks, []); assert.equal(memory.channel.automaticPolling, false);
    assert.equal(f.taskRecords.get(TASK_SID)?.sources.size || 0, 0); assert.equal(f.counts.creates, 1);
    assert.equal(f.counts.oldOpen + f.counts.oldWrites + f.counts.credentialFactory + f.counts.channelFactory, 0);
  });
  assert.deepEqual(watchedIo, { filesystem: 0, process: 0, network: 0 });
  console.log(JSON.stringify({ passed: true, cases, watchedPostImportIo: watchedIo,
    limits: ['Module imports occur before instrumentation; real Bridge reattach uses public SDK Session/scope carriers with controlled in-memory services, not a running Agent.', 'Separate suites validate real Agent/SQLite/UI. No live QR, pairing, messages, credentials or active profile actions.'] }));
} finally {
  await Promise.all(fixtures.map(f => f.runtime.dispose()));
  for (const carrier of carriers) await carrier.dispose();
  for (const undo of restore.reverse()) undo();
  syncBuiltinESMExports();
}
