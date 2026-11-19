import { homedir as desktopHome } from 'node:os';
import { resolve as desktopPath } from 'node:path';
// Owner-only native conversation coordinator. No constructor snapshot/credential/network I/O.
import { z } from 'zod';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createArchiveAccess, validateArchiveRoot } from './archive-access.js';
import { createSessionBridge, isSessionBridgeId } from './session-bridge.js';
import { createTaskAccess, isTaskSessionId, validateTaskDirectory } from './task-access.js';
import { createTaskSessionBridge } from './task-session-bridge.js';
import { createWeixinSessionCredentialStore, createWeixinTaskCredentialStore } from './weixin-dsh.js';
import { createWeixinApi } from './weixin-api.js';
import { createWeixinMediaApi } from './weixin-media.js';
import { createWeixinChannel, WeixinChannelError } from './weixin-channel.js';
import { prepareLocalQrRenderer } from './qr-renderer.js';
import { createLocalHistory } from './local-history.js';
import { createDailyCards } from './daily-cards.js';
import { CONVERSATION_NAMESPACE, CONVERSATION_METHOD_NAMES, CONVERSATION_ERROR_CODES,
  stateSchema, actionResultSchema, TASK_WIRE, conversationRequestSchemaFor } from './conversation-wire.js';

export const CONVERSATION_VERSION = '0.2.0';
const ORIGINAL_SOURCE = desktopPath(desktopHome(), 'Documents/xwechat_files'); // Denied metadata, never probed.
const POLLER_OWNERS = new Map(); // One active binding per account in this loaded Host generation.
const FIXED_CODES = new Set(CONVERSATION_ERROR_CODES);
const API_ERROR_CODES = Object.freeze({
  'not-configured': 'UNAVAILABLE', 'invalid-options': 'INVALID_REQUEST', 'invalid-input': 'INVALID_REQUEST', aborted: 'CANCELLED',
  'network-error': 'WECHAT_NETWORK_FAILED', timeout: 'WECHAT_REQUEST_TIMEOUT',
  'http-error': 'WECHAT_HTTP_REJECTED', 'business-error': 'WECHAT_REQUEST_REJECTED',
  'invalid-mime': 'WECHAT_RESPONSE_TYPE_INVALID', 'invalid-json': 'WECHAT_RESPONSE_JSON_INVALID',
  'response-too-large': 'WECHAT_RESPONSE_TOO_LARGE', 'invalid-response': 'WECHAT_RESPONSE_INVALID',
  'unsupported-origin': 'WECHAT_ORIGIN_REJECTED', 'unsupported-redirect': 'WECHAT_REDIRECT_REJECTED',
});
const HISTORY_SPEC = Object.freeze({
  name: 'wechat_native_ro_history_v1', version: 1, layout: 'per-record',
  tables: { sessions: { valueSchema: z.strictObject({ createdAt: z.number().int().nonnegative(), mayContainArchiveData: z.boolean() }) } },
});
export class ConversationError extends Error {
  constructor(code) { const safe = FIXED_CODES.has(code) ? code : 'ACTION_FAILED'; super('WeChat conversation: ' + safe); this.name = 'ConversationError'; this.code = safe; }
}
const fail = code => { throw new ConversationError(code); };
function errorCode(error) {
  const code = error?.code;
  if (FIXED_CODES.has(code)) return code;
  if (error instanceof WeixinChannelError && ['api-failed', 'send-failed'].includes(code)) {
    const apiErrorCode = Object.getOwnPropertyDescriptor(error, 'apiErrorCode')?.value;
    if (typeof apiErrorCode === 'string' && Object.hasOwn(API_ERROR_CODES, apiErrorCode)) return API_ERROR_CODES[apiErrorCode];
  }
  if (error instanceof WeixinChannelError) {
    if (code === 'already-paired') return 'PAIRING_ALREADY_STORED';
    if (code === 'store-failed') return 'PAIRING_STORAGE_FAILED';
    if (['invalid-state', 'session-mismatch'].includes(code)) return 'PAIRING_STATE_INVALID';
    if (code === 'invalid-response') return 'WECHAT_RESPONSE_INVALID';
  }
  if (['invalid-options', 'invalid-input', 'invalid-request', 'invalid-session'].includes(code)) return 'INVALID_REQUEST';
  if (['not-granted'].includes(code)) return 'SNAPSHOT_REQUIRED';
  if (['forbidden-root', 'scope-forbidden', 'path-rejected', 'unsupported-layout', 'unsupported-schema', 'unsupported-content', 'unsupported-scope', 'snapshot-changed'].includes(code)) return 'SNAPSHOT_DENIED';
  if (['share-forbidden', 'archive-denied', 'send-policy-denied', 'send-blocked'].includes(code)) return 'SHARED_CONTEXT_DENIED';
  if (['query-budget-exceeded', 'row-budget-exceeded', 'file-budget-exceeded', 'byte-budget-exceeded'].includes(code)) return 'ARCHIVE_QUERY_LIMIT';
  if (['owner-mismatch'].includes(code)) return 'OWNER_MISMATCH';
  if (['not-paired', 'login-required', 'login-not-confirmed'].includes(code)) return 'PAIRING_REQUIRED';
  if (code === 'busy') return 'BUSY';
  if (['aborted', 'revoked'].includes(code) || error?.name === 'AbortError') return 'CANCELLED';
  if (['preset-unavailable', 'not-prepared', 'not-owned', 'session-not-ready', 'unsafe-session'].includes(code)) return 'SESSION_NOT_READY';
  if (['persistence-unavailable', 'persistence-failed', 'history-unavailable'].includes(code)) return 'SESSION_PERSIST_FAILED';
  if (code === 'create-failed') return 'SESSION_CREATE_FAILED';
  if (['disposed', 'not-configured', 'unavailable', 'model-unavailable'].includes(code)) return 'UNAVAILABLE';
  if (code === 'disabled') return 'NETWORK_DISABLED';
  return 'ACTION_FAILED';
}
/** Canonical dispatcher identity only; undefined also means outside a remote call. */
export function requireConversationOwner(invocation) {
  if (!invocation || invocation.peer?.principal?.kind !== 'owner') fail('NOT_AUTHORIZED');
}
function checkedSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_REQUEST');
  if (signal?.aborted) fail('CANCELLED');
}
function defaultArchive() {
  return { disposed: false, granted: false, allowWechat: false, allConversations: false, talkers: [], fromTs: null, toTs: null,
    sessionMayContainArchiveData: false, historyKnown: false, shareable: false, activeQueries: 0, lastError: null, format: 'fixed-sql-plaintext' };
}
function defaultChannel() {
  return { enabled: false, phase: 'unpaired', hasStoredLogin: false, pendingRecovery: false, messagingVerified: false,
    messagingEnabled: false, automaticPolling: false, requestAccepted: 0, failures: 0, lastError: null };
}
function pause(signal, milliseconds) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let timer;
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Test dependencies are trusted code capabilities, never read from config or RPC. */
export function createConversationRuntime(ctx, config = {}, dependencies = {}) {
  const sourceRoot = typeof config.sourceRoot === 'string' && config.sourceRoot ? config.sourceRoot : ORIGINAL_SOURCE;
  const maxRows = Number.isSafeInteger(config.maxRows) && config.maxRows > 0 ? Math.min(200, config.maxRows) : 100;
  const channels = new Map(), busy = new Set(), activeActions = new Map(), knownSessions = new Set(), knownTasks = new Map();
  const autoConnections = new Map(), autoOperations = new Set(), autoSetupLocks = new Set();
  const bindingSpec = Object.freeze({ name: 'wechat_task_bindings_v1', version: 1, layout: 'per-record', tables: {
    contexts: { valueSchema: z.strictObject({ root: z.string().min(1).max(4096), sessionId: z.string().refine(isTaskSessionId), ready: z.boolean() }) },
  } });
  let bindingDomain, bindings, bindingOpening;
  let domain, history, opening, archive, bridge, taskData, taskBridge, disposed = false, disposal, lastError = null, creationReservations = 0;
  const alive = signal => { checkedSignal(signal); if (disposed) fail('UNAVAILABLE'); };
  const knownHistory = id => {
    if (!history) return 'unknown';
    const record = history.get(id);
    return record && typeof record.mayContainArchiveData === 'boolean' ? record.mayContainArchiveData : 'unknown';
  };
  const markHistory = async id => {
    if (!history || !history.get(id)) fail('SHARED_CONTEXT_DENIED');
    await history.update(id, value => ({ ...value, mayContainArchiveData: true }));
  };
  // Both capability constructors are specified/tested as no-I/O. A missing
  // optional native subsystem cannot take the existing archive namespace down.
  let initializationError;
  try {
    archive = (dependencies.createArchiveAccess || createArchiveAccess)({ sourceRoot, maxRows,
      hasArchiveHistory: knownHistory, markArchiveHistory: markHistory });
    bridge = (dependencies.createSessionBridge || createSessionBridge)(ctx, { archive });
  } catch (error) { initializationError = errorCode(error); }
  let taskInitializationError, localHistory, dailyCards;
  try {
    taskData = (dependencies.createTaskAccess || createTaskAccess)(ctx, { sourceRoot,
      beforeArchiveQuery: (id, signal, turn) => localHistory?.beforeQuery(id, signal, turn),
      archiveFreshness: id => { const value = localHistory?.state(id); return value?.enabled ? value : undefined; } });
    taskBridge = (dependencies.createTaskSessionBridge || createTaskSessionBridge)(ctx, { data: taskData });
    localHistory = createLocalHistory({ data: taskData, intervalMs: config.historyUpdateIntervalMs ?? 60000,
      ...(dependencies.runLocalHistory ? { run: dependencies.runLocalHistory } : {}),
      isIdle: id => !busy.has(id) && !channels.get(id)?.nativeActive && dailyCards?.state(id).phase !== 'summarizing'
        && !(ctx.get ? ctx.get('agents') : ctx.agents)?.get?.(id)?.status?.includes('running'),
      onTick: id => dailyCards?.update(id) });
    dailyCards = createDailyCards({ storage: dependencies.storageDomain || (ctx.get ? ctx.get('storageDomain') : ctx.storageDomain),
      query: (...args) => taskData.query(...args), source: id => localHistory.state(id),
      isIdle: id => !busy.has(id) && !channels.get(id)?.nativeActive && taskBridge.isPrepared(id)
        && taskData.canShare(id) && nativeModelConfigured(id) && service('agents')?.get?.(id)?.status === 'idle',
      summarize: (...args) => taskBridge.reply(...args) });
  } catch (error) { taskInitializationError = errorCode(error); }
  const service = name => ctx.get ? ctx.get(name) : ctx[name];
  const taskAvailable = () => {
    try { return Boolean(taskData && taskBridge && !taskInitializationError && ['agents', 'sessions', 'agentPresets', 'sandboxPolicy', 'workspaceRegistry', 'fs'].every(name => service(name))); }
    catch { return false; }
  };
  const ready = () => { if (!archive || !bridge || initializationError) fail('UNAVAILABLE'); };
  const taskReady = () => { if (!taskAvailable()) fail('UNAVAILABLE'); };
  async function openHistory(signal) {
    alive(signal); ready();
    if (!opening) opening = (async () => {
      const provider = dependencies.storageDomain || ctx.storageDomain;
      if (!provider || typeof provider.open !== 'function') fail('UNAVAILABLE');
      const handle = await provider.open(HISTORY_SPEC);
      domain = handle;
      if (disposed) { await handle.close(); fail('UNAVAILABLE'); }
      const table = handle.table('sessions');
      if (table.size > 256) fail('UNAVAILABLE');
      history = table;
    })();
    await opening;
    alive(signal);
  }
  function channelState(id) {
    const record = id ? channels.get(id) : undefined;
    return record ? { ...record.status, phase: record.loop && !record.loop.controller.signal.aborted ? record.loop.textOnly ? 'polling' : 'running' : record.status.phase,
      messagingEnabled: Boolean(record.loop && !record.loop.controller.signal.aborted),
      automaticPolling: Boolean(record.loop && !record.loop.controller.signal.aborted && !record.loop.textOnly), requestAccepted: record.requestAccepted,
      failures: record.failures, lastError: record.lastError } : defaultChannel();
  }
  function taskWorkspaces() {
    let values;
    try { values = service('workspaceRegistry')?.list(); } catch { return []; }
    if (!Array.isArray(values)) return [];
    return values.slice(0, 256).flatMap(value => {
      try {
        validateTaskDirectory(value.path, [sourceRoot]);
        const id = value.id, title = value.title?.trim().slice(0, 160);
        if (typeof id !== 'string' || !id || id.length > 256 || !title || /[\u0000-\u001f\u007f]/u.test(id + title)) return [];
        return [{ id, root: value.path, title }];
      } catch { return []; }
    });
  }
  function contextDirectory(id) {
    try {
      const session = service('sessions')?.get(id);
      if (!session || session.header?.id !== id) return null;
      const projected = service('sessionProjections')?.stateOf?.(session, 'workingDirectory');
      const root = typeof projected === 'string' ? projected : session.header.cwd;
      if (typeof root !== 'string') return null;
      validateTaskDirectory(root, [sourceRoot]);
      const workspace = service('workspaceRegistry')?.list().find(value => value.path === root);
      const title = typeof workspace?.title === 'string' && workspace.title.trim() ? workspace.title.trim().slice(0, 160) : 'WeChat conversation';
      return { root, title };
    } catch { return null; }
  }
  function nativeModelConfigured(id) {
    try {
      const agent = service('agents')?.get(id);
      if (!agent || agent.session?.header?.id !== id) return false;
      const pending = service('sessionProjections')?.stateOf?.(agent.session, 'modelSelection')?.pending;
      const selected = pending || agent.options;
      return typeof selected?.provider === 'string' && Boolean(selected.provider.trim())
        && typeof selected?.model === 'string' && Boolean(selected.model.trim());
    } catch { return false; }
  }
  function automaticScopeCurrent(connection, requireSharing = true) {
    try {
      const state = taskData.getState(connection.sessionId);
      return !disposed && !connection.controller.signal.aborted
        && contextDirectory(connection.sessionId)?.root === connection.root
        && contextDirectory(connection.origin)?.root === connection.root
        && state.workspace?.id === connection.workspaceId && state.workspace.root === connection.root
        && taskBridge.isPrepared(connection.sessionId)
        && (!requireSharing || !connection.contextSignal.aborted && taskData.canShare(connection.sessionId));
    } catch { return false; }
  }
  function setupState(id) {
    const directory = contextDirectory(id);
    const target = isTaskSessionId(id) ? id : bindings?.get(id)?.sessionId ?? null;
    const connection = target ? autoConnections.get(target) : null;
    return { root: directory?.root ?? null, title: directory?.title ?? null, sessionId: target,
      phase: connection?.phase ?? (directory ? 'ready' : 'directory-required'),
      modelConfigured: target ? nativeModelConfigured(target) : false,
      error: connection?.error ?? null, qr: connection?.phase === 'pairing' ? connection.qr : null };
  }
  async function openBindings(signal) {
    alive(signal);
    if (!bindingOpening) bindingOpening = (async () => {
      const provider = dependencies.storageDomain || service('storageDomain');
      if (typeof provider?.open !== 'function') fail('SESSION_PERSIST_FAILED');
      bindingDomain = await provider.open(bindingSpec);
      if (disposed) { await bindingDomain.close(); fail('UNAVAILABLE'); }
      bindings = bindingDomain.table('contexts');
      if (bindings.size > 128) fail('SESSION_PERSIST_FAILED');
    })();
    await bindingOpening;
    alive(signal);
  }
  function watchAutomaticConnection(connection, record, paired) {
    const signal = AbortSignal.any([connection.controller.signal, AbortSignal.timeout(10 * 60 * 1000)]);
    const work = (async () => {
      while (!paired) {
        if (!automaticScopeCurrent(connection, false) || signal.aborted) fail('CANCELLED');
        const result = await record.channel.pollLoginForOwner(undefined, signal);
        if (result?.status === 'expired') { connection.phase = 'expired'; connection.qr = null; return; }
        if (result?.status === 'confirmed') {
          if (typeof result.expectedOwnerId !== 'string' || !result.expectedOwnerId) fail('OWNER_MISMATCH');
          if (!automaticScopeCurrent(connection, false)) fail('CANCELLED');
          // The one business confirmation authorizes saving only the account
          // actually confirmed by this QR flow; the Channel checks that identity.
          await record.channel.confirmPairingForOwner(result.expectedOwnerId, signal);
          paired = true; connection.qr = null;
          await updateStatus(record, signal);
          break;
        }
        await pause(signal, 1000);
      }
      while (!taskData.canShare(connection.sessionId)) {
        if (!automaticScopeCurrent(connection, false) || signal.aborted) fail('CANCELLED');
        connection.phase = 'history-required';
        await pause(signal, 1000);
      }
      if (!automaticScopeCurrent(connection, false) || signal.aborted) fail('CANCELLED');
      connection.contextSignal = taskData.contextSignal(connection.sessionId);
      connection.phase = 'model-required';
      while (!nativeModelConfigured(connection.sessionId)) {
        if (!automaticScopeCurrent(connection) || signal.aborted) fail('CANCELLED');
        await pause(signal, 1000);
      }
      if (!automaticScopeCurrent(connection) || signal.aborted) fail('CANCELLED');
      await updateStatus(record, signal);
      if (record.status.pendingRecovery || record.status.recoveryStatusUnknown) fail('SHARED_CONTEXT_DENIED');
      // The ten-minute deadline belongs to pairing/history/model setup.
      // Automatic replies live until Stop, source revocation or Host disposal.
      await start(connection.sessionId, connection.controller.signal, true, false, undefined, undefined, connection);
      if (!automaticScopeCurrent(connection)) fail('CANCELLED');
      connection.phase = 'running';
    })().catch(error => {
      if (connection.controller.signal.aborted || disposed) return;
      connection.phase = 'blocked'; connection.qr = null; connection.error = errorCode(error);
      record.lastError = connection.error; record.failures++;
    }).finally(() => autoOperations.delete(work));
    connection.promise = work;
    autoOperations.add(work);
  }
  async function connectConversation(request, signal, actionSessionId) {
    taskReady();
    const origin = request.contextSessionId, directory = contextDirectory(origin);
    if (!directory || directory.root !== request.expectedDirectory) fail('SESSION_NOT_READY');
    if (autoSetupLocks.has(directory.root)) fail('BUSY');
    if (!['findWorkspaceTasks', 'authorizeAutoWorkspace', 'readHistoricalState', 'readFirstTextState', 'contextSignal', 'getWorkspace']
      .every(name => typeof taskData[name] === 'function')) fail('UNAVAILABLE');
    autoSetupLocks.add(directory.root);
    const targetControl = new AbortController();
    signal = signal ? AbortSignal.any([signal, targetControl.signal]) : targetControl.signal;
    let target, lockedTarget = false;
    const releaseTarget = () => {
      if (lockedTarget) { busy.delete(target); if (activeActions.get(target) === targetControl) activeActions.delete(target); }
    };
    const lockTarget = id => {
      target = id;
      // Import holds its target action lock through this internal reconnect.
      if (id !== origin && id !== actionSessionId) {
        if (busy.has(id)) fail('BUSY');
        busy.add(id); activeActions.set(id, targetControl); lockedTarget = true;
      }
    };
    try {
      await openBindings(signal);
      const binding = bindings.get(origin);
      if (binding && binding.root !== directory.root) fail('SESSION_NOT_READY');
      const current = binding?.sessionId ?? (isTaskSessionId(origin) ? origin : null);
      const prior = current ? autoConnections.get(current) : null;
      if (prior && ['pairing', 'history-required', 'model-required', 'running'].includes(prior.phase)
        && automaticScopeCurrent(prior, prior.phase === 'running' || prior.phase === 'model-required')) {
        return { sessionId: current, qr: prior.qr ?? undefined };
      }
      // Directory verification plus bounded metadata lookup; no source contents,
      // credential reads, native history opening or model requests here.
      const stored = await taskData.findWorkspaceTasks(directory.root, signal);
      const indexed = service('workspaceRegistry').list().filter(value => value.path === directory.root)
        .flatMap(value => Array.isArray(value.sessionIds) ? value.sessionIds.filter(isTaskSessionId) : []);
      const candidates = [...new Set([...stored.map(value => value.sessionId), ...indexed])];
      if (!current && candidates.length > 1) fail('SESSION_NOT_READY');
      const existing = current ?? candidates[0];
      const workspace = { ...directory, allowWechat: true, confirmation: 'read-and-write-task-workspace' };
      const reserve = async id => {
        lockTarget(id);
        if (!bindings.get(origin) && bindings.size >= 128) fail('BUSY');
        await bindings.put(origin, { root: directory.root, sessionId: id, ready: false });
        alive(signal);
        if (contextDirectory(origin)?.root !== directory.root) fail('CANCELLED');
      };
      if (existing) {
        if (channels.get(existing)?.loop) fail('BUSY');
        await reserve(existing);
        await ensurePrepared(existing, signal, true);
      } else {
        const created = await taskBridge.createConversation(origin, workspace, signal, reserve);
        if (created !== target || !isTaskSessionId(created)) fail('SESSION_CREATE_FAILED');
        knownTasks.set(target, directory.title);
      }
      alive(signal);
      if (!taskBridge.isPrepared(target) || contextDirectory(origin)?.root !== directory.root) fail('SESSION_NOT_READY');
      // Only initialization is persisted. Authority and automatic intent are
      // process-local and are never resurrected by GET, reconnect or Host restart.
      await bindings.update(origin, value => ({ ...value, ready: true }));
      const historyState = await taskData.readHistoricalState(target, signal);
      const firstState = await taskData.readFirstTextState(target, signal);
      const priorUnknown = [...historyState.receipts, ...firstState.receipts].filter(value => value.operation === 'terminal' && value.runOutcome === 'unknown');
      const unusedFirstTest = priorUnknown.length === 1 && firstState.receipts.includes(priorUnknown[0])
        && priorUnknown[0].auditOutcome === 'committed' && priorUnknown[0].modelRequestsReserved === 0 && priorUnknown[0].requestAccepted === 0;
      if ([historyState, firstState].some(value => value.reason === 'audit-unresolved'
        || value.reason === 'run-unresolved' && !unusedFirstTest || ['reserved', 'running'].includes(value.phase))) fail('SHARED_CONTEXT_DENIED');
      await stop(target);
      // Managed import already has an explicit whole-task grant. Reconnection
      // reuses that current authority without reauthorizing or dropping sources.
      if (localHistory?.state(target).enabled && !taskData.canShare(target)) taskData.setSharing(target, { allowWechat: true, confirmation: 'share-whole-task-context' });
      if (!(localHistory?.state(target).enabled && taskData.canShare(target))) {
        try {
          await taskData.authorizeAutoWorkspace(target, workspace, signal);
          taskData.setSharing(target, { allowWechat: true, confirmation: 'share-whole-task-context' });
        } catch (error) {
          const state = taskData.getState(target);
          // Known retained sources can block replies without blocking pairing.
          // Unknown audit/run outcomes and other authorization errors stay closed.
          if (error?.code !== 'share-forbidden' || !state.historyKnown || !state.contextBlocked
            || !state.sessionMayContainData || state.workspace?.root !== directory.root) throw error;
        }
      }
      alive(signal);
      if (contextDirectory(origin)?.root !== directory.root) fail('SESSION_NOT_READY');
      const record = await channelFor(target, signal, true);
      await updateStatus(record, signal);
      if (record.status.pendingRecovery || record.status.recoveryStatusUnknown) fail('SHARED_CONTEXT_DENIED');
      const connection = { sessionId: target, origin, root: directory.root, workspaceId: taskData.getWorkspace(target)?.id,
        controller: new AbortController(), contextSignal: taskData.contextSignal(target), phase: 'pairing', qr: null, error: null, promise: null };
      let qr;
      if (!record.status.hasStoredLogin) {
        const render = await (dependencies.prepareQr || prepareLocalQrRenderer)();
        alive(signal);
        await record.channel.cancelLogin(signal);
        const login = await record.channel.beginLogin(signal);
        qr = render(login.qrContent);
        connection.qr = qr;
        await updateStatus(record, signal);
      }
      alive(signal);
      if (!automaticScopeCurrent(connection, false)) {
        connection.controller.abort(); connection.qr = null;
        await record.channel.cancelLogin(signal);
        fail('CANCELLED');
      }
      autoConnections.set(target, connection);
      watchAutomaticConnection(connection, record, record.status.hasStoredLogin);
      return { sessionId: target, qr };
    } finally { releaseTarget(); autoSetupLocks.delete(directory.root); }
  }
  const removeDirectoryListener = typeof ctx.on === 'function' ? ctx.on('session/event', (session, event) => {
    if (event.type !== 'working-directory/change') return;
    for (const connection of autoConnections.values()) {
      if ((session.id === connection.sessionId || session.id === connection.origin) && event.data.cwd !== connection.root) {
        connection.error = 'SESSION_NOT_READY';
        void stop(connection.sessionId).catch(() => { connection.error = 'UNAVAILABLE'; });
      }
    }
  }) : null;
  function getState(raw = {}, signal) {
    alive(signal);
    const parsed = conversationRequestSchemaFor('getConversationState').safeParse(raw);
    if (!parsed.success) fail('INVALID_REQUEST');
    const id = parsed.data.sessionId ?? null;
    if (parsed.data.kind === 'task') {
      let task = null, prepared = false;
      if (id && knownTasks.has(id) && taskData && taskBridge) {
        task = taskData.getState(id);
        prepared = taskBridge.isPrepared(id);
      }
      const tasks = [...knownTasks].map(([sessionId, title]) => ({ sessionId, title, prepared: taskBridge?.isPrepared(sessionId) === true }));
      const setup = setupState(id);
      return TASK_WIRE.stateSchema.parse({ kind: 'task', version: '0.2.0-task-v1', sessionId: id, available: taskAvailable(), prepared,
        task, channel: { ...channelState(setup.sessionId ?? id), setup, ...(localHistory ? { localHistory: localHistory.state(id) } : {}),
          ...(dailyCards ? { dailyCards: dailyCards.state(id) } : {}) }, tasks, workspaces: taskWorkspaces(), lastError });
    }
    if (isTaskSessionId(id)) fail('SESSION_NOT_READY');
    let prepared = false;
    if (id && bridge) { try { prepared = bridge.isPrepared(id); } catch { /* absent runtime, no fallback */ } }
    const a = id && archive && (prepared || knownSessions.has(id)) ? archive.getState(id) : defaultArchive();
    return stateSchema.parse({ version: CONVERSATION_VERSION, sessionId: id, prepared, archive: a, channel: channelState(id), lastError });
  }
  async function ensurePrepared(id, signal, task = false) {
    alive(signal);
    if (task) {
      taskReady();
      if (!isTaskSessionId(id)) fail('SESSION_NOT_READY');
      await taskBridge.ensure(id, signal);
      alive(signal);
      if (!taskBridge.isPrepared(id)) fail('SESSION_NOT_READY');
      const state = taskData.getState(id);
      knownTasks.set(id, state.workspace?.title || 'WeChat task');
      return;
    }
    ready();
    // Ordinary data-only contexts never acquire Bridge history or channel capabilities.
    if (!isSessionBridgeId(id)) fail('SESSION_NOT_READY');
    await openHistory(signal);
    await bridge.ensure(id, signal);
    alive(signal);
    if (!bridge.isPrepared(id)) fail('SESSION_NOT_READY');
    knownSessions.add(id);
  }
  // Data-only access uses live in-memory Session metadata, never an Agent resume or log read.
  function requireLiveDataContext(id, signal) {
    alive(signal);
    const session = ctx.sessions?.get(id);
    if (!session || session.header?.id !== id) fail('SESSION_NOT_READY');
    return session;
  }
  function isBridgeContext(id) {
    return isSessionBridgeId(id) || bridge.isPrepared(id);
  }
  async function ensureDataContext(id, signal, granting = false) {
    alive(signal); ready();
    if (isBridgeContext(id)) {
      await ensurePrepared(id, signal);
      return true;
    }
    requireLiveDataContext(id, signal);
    if (!granting && (!knownSessions.has(id) || !history?.get(id))) fail('SNAPSHOT_REQUIRED');
    await openHistory(signal);
    requireLiveDataContext(id, signal);
    if (granting) {
      const record = history.get(id);
      if (!record) {
        if (history.size + creationReservations >= 256) fail('BUSY');
        creationReservations++;
        try {
          // Past ordinary-session history is deliberately not read and cannot be called clean.
          await history.put(id, { createdAt: Date.now(), mayContainArchiveData: true });
        } finally { creationReservations--; }
      } else if (record.mayContainArchiveData !== true) {
        await markHistory(id);
      }
      requireLiveDataContext(id, signal);
      knownSessions.add(id);
    }
    return false;
  }
  function requireHistoricalTask(id, signal) {
    alive(signal); taskReady();
    if (!isTaskSessionId(id) || !knownTasks.has(id) || !taskBridge.isPrepared(id)) fail('SESSION_NOT_READY');
    if (!['getHistoricalState', 'reviewHistoricalContext', 'authorizeHistoricalContext', 'shareHistoricalContext', 'revokeHistoricalContext', 'reserveHistoricalText', 'verifyHistoricalText', 'finishHistoricalText']
      .every(name => typeof taskData[name] === 'function') || typeof taskBridge.replyHistorical !== 'function') fail('UNAVAILABLE');
  }
  function shareAllowed(id, task, permit) {
    const data = task ? taskData : archive;
    if (permit === undefined) return data.canShare(id) === true;
    const verify = permit?.purpose === 'first-text-once' ? data.verifyFirstText : data.verifyHistoricalText;
    if (!task || permit.sessionId !== id || typeof verify !== 'function') return false;
    try { return verify(permit) === true; } catch { return false; }
  }
  async function channelFor(id, signal, task = false) {
    alive(signal);
    if (task) taskReady(); else ready();
    const sessionBridge = task ? taskBridge : bridge;
    let record = channels.get(id);
    if (record) return record;
    if (channels.size >= 128) fail('BUSY');
    const credentials = dependencies.credentials || ctx.credentials;
    const fetcher = dependencies.fetcher || globalThis.fetch;
    if (!credentials || typeof fetcher !== 'function') fail('UNAVAILABLE');
    const store = (dependencies.createStateStore || (task ? createWeixinTaskCredentialStore : createWeixinSessionCredentialStore))(credentials, id);
    const api = (dependencies.createApi || createWeixinApi)({ fetcher });
    const mediaApi = task ? (dependencies.createMediaApi || createWeixinMediaApi)({ fetcher }) : null;
    record = { channel: null, status: defaultChannel(), loop: null, requestAccepted: 0, failures: 0, lastError: null };
    const channel = (dependencies.createChannel || createWeixinChannel)({ enabled: true, sessionId: id, api, store,
      onTextAccepted: () => {
        record.requestAccepted++;
        const loop = record.loop;
        if (loop?.textOnly || loop?.automaticConnection) {
          loop.requestAccepted++;
          if (loop.progress) loop.progress.requestAccepted = loop.requestAccepted;
        }
      },
      reply: async (text, metadata, replySignal) => {
        if (record.loop?.automaticConnection && !automaticScopeCurrent(record.loop.automaticConnection)) fail('SHARED_CONTEXT_DENIED');
        const permit = record.loop?.historyPermit;
        if (permit === undefined) {
          if (!task) return sessionBridge.reply(id, text, metadata, replySignal);
          record.nativeActive = true;
          try {
            const cardWork = dailyCards?.wait(id); if (cardWork) await cardWork;
            await localHistory?.beforeQuery(id, replySignal);
            return await sessionBridge.reply(id, text, metadata, replySignal);
          } finally { record.nativeActive = false; }
        }
        if (!shareAllowed(id, task, permit)) fail('SHARED_CONTEXT_DENIED');
        const loop = record.loop;
        const work = permit.purpose === 'first-text-once' ? taskBridge.replyFirstText(id, text, metadata, replySignal, permit)
          : taskBridge.replyHistorical(id, text, metadata, replySignal, permit);
        loop.nativeReplies.add(work);
        try { return (await work).text; }
        finally { loop.nativeReplies.delete(work); }
      },
      ...(task ? { resumeReply: async (text, metadata, replySignal) => {
        if (!record.loop?.resumeOnce || !shareAllowed(id, true) || typeof taskBridge.continueReply !== 'function') fail('SHARED_CONTEXT_DENIED');
        record.nativeActive = true;
        const cardWork = dailyCards?.wait(id); if (cardWork) await cardWork;
        const work = taskBridge.continueReply(id, text, metadata, replySignal);
        record.loop.nativeReplies.add(work);
        try { return await work; }
        finally { record.loop?.nativeReplies.delete(work); record.nativeActive = false; }
      } } : {}),
      ...(task ? { media: {
        reply: async (text, metadata, replySignal) => {
          if (record.loop?.historyPermit !== undefined) fail('SHARED_CONTEXT_DENIED');
          record.nativeActive = true;
          try { const cardWork = dailyCards?.wait(id); if (cardWork) await cardWork; return await taskBridge.replyWithDeliverables(id, text, metadata, replySignal); }
          finally { record.nativeActive = false; }
        },
        release: references => taskData.releaseDeliveries(id, references),
        async send(auth, message, sendSignal, authorize) {
          if (record.loop?.historyPermit !== undefined) fail('SHARED_CONTEXT_DENIED');
          const { reference, turn, fileName, kind, bytes, sha256 } = message;
          const prepared = await taskData.prepareDelivery(id, { reference, turn, fileName, kind, bytes, sha256 }, sendSignal);
          try {
            return await mediaApi.sendMedia(auth, { toUserId: message.toUserId, contextToken: message.contextToken, clientId: message.clientId,
              fileName, kind, sha256, data: prepared.data }, prepared.signal, { verify: prepared.verify, authorize: () => authorize() && prepared.authorize() });
          } finally { prepared.data.fill(0); taskData.releaseDeliveries(id, [reference]); }
        },
      } } : {}),
      beforeSend: () => !disposed && Boolean(record.loop) && !record.loop.controller.signal.aborted
        && POLLER_OWNERS.get(record.loop.accountKey) === record.loop.token && shareAllowed(id, task, record.loop.historyPermit) && sessionBridge.isPrepared(id)
        && (!record.loop.automaticConnection || automaticScopeCurrent(record.loop.automaticConnection)),
    });
    record.channel = channel;
    channels.set(id, record);
    return record;
  }
  async function updateStatus(record, signal) {
    const value = await record.channel.getStatus(signal);
    record.status = { enabled: Boolean(value.enabled), phase: value.phase, hasStoredLogin: Boolean(value.hasStoredLogin),
      pendingRecovery: Boolean(value.pendingRecovery), resumeAvailable: value.resumeAvailable === true, messagingVerified: false };
    if (Object.hasOwn(value, 'delivery')) {
      const delivery = value.delivery;
      record.status.delivery = delivery && Number.isSafeInteger(delivery.accepted) && Number.isSafeInteger(delivery.total)
        && delivery.accepted >= 0 && delivery.accepted < delivery.total && delivery.total <= 9 && ['ready', 'sending'].includes(delivery.phase)
        ? { accepted: delivery.accepted, total: delivery.total, phase: delivery.phase } : null;
    }
  }
  async function stop(id) {
    const connection = autoConnections.get(id);
    if (connection) { connection.phase = 'stopped'; connection.qr = null; connection.controller.abort(); }
    const loop = channels.get(id)?.loop;
    loop?.controller.abort();
    // Abort both jobs before awaiting either; pairing and model waiting cannot
    // outlive Stop or restart the driver after its account lock was released.
    await connection?.promise?.catch(() => {});
    await loop?.promise?.catch(() => {});
  }
  async function start(id, signal, task = false, textOnly = false, historyPermit, progress, automaticConnection, resumeOnce = false) {
    if (historyPermit === undefined) await ensurePrepared(id, signal, task);
    else { requireHistoricalTask(id, signal); if (!task || !textOnly) fail('SHARED_CONTEXT_DENIED'); }
    if (!shareAllowed(id, task, historyPermit) || automaticConnection && !automaticScopeCurrent(automaticConnection)) fail('SHARED_CONTEXT_DENIED');
    const record = await channelFor(id, signal, task);
    if (record.loop) fail('BUSY');
    const plainText = textOnly || Boolean(automaticConnection);
    if (typeof record.channel.getPairingIdentity !== 'function' || plainText && typeof record.channel.pollTextOnce !== 'function') fail('UNAVAILABLE');
    // Check local pairing first. No login or updates request is issued here.
    if (plainText) await updateStatus(record, signal);
    if (resumeOnce && (!task || !textOnly || record.status.resumeAvailable !== true || typeof record.channel.resumeTextOnce !== 'function')) fail('SHARED_CONTEXT_DENIED');
    if (automaticConnection && (record.status.pendingRecovery || record.status.recoveryStatusUnknown)) fail('SHARED_CONTEXT_DENIED');
    const identity = await record.channel.getPairingIdentity(signal);
    if (!identity || typeof identity.botId !== 'string' || typeof identity.userId !== 'string') fail('PAIRING_REQUIRED');
    if (!plainText) await updateStatus(record, signal);
    const accountKey = JSON.stringify([identity.botId, identity.userId]);
    if (POLLER_OWNERS.has(accountKey) || POLLER_OWNERS.size >= 128) fail('BUSY');
    alive(signal);
    const loop = { controller: new AbortController(), accountKey, token: Symbol('wechat-poller'), textOnly, historyPermit, progress, automaticConnection, resumeOnce,
      requestAccepted: 0, nativeReplies: new Set(), promise: null };
    const runSignal = AbortSignal.any([loop.controller.signal, ...(textOnly && signal ? [signal] : []), ...(historyPermit ? [historyPermit.signal] : []),
      ...(automaticConnection ? [automaticConnection.controller.signal, automaticConnection.contextSignal] : [])]);
    POLLER_OWNERS.set(accountKey, loop.token);
    record.loop = loop;
    record.lastError = null;
    // Single requests stop after one poll. Automatic mode repeatedly consumes
    // one owner text, without media, splitting, or uncertain-result retries.
    loop.promise = Promise.resolve().then(async () => {
      while (!disposed && !runSignal.aborted) {
        if (!shareAllowed(id, task, historyPermit) || automaticConnection && !automaticScopeCurrent(automaticConnection)) fail('SHARED_CONTEXT_DENIED');
        const current = await record.channel.getPairingIdentity(runSignal);
        if (!current || JSON.stringify([current.botId, current.userId]) !== accountKey) fail('OWNER_MISMATCH');
        if (progress) progress.polled = true;
        const acceptedBefore = loop.requestAccepted;
        const stats = await (resumeOnce ? record.channel.resumeTextOnce('continue-unanswered-message', runSignal)
          : plainText ? record.channel.pollTextOnce(runSignal) : record.channel.pollOnce(runSignal));
        if (!plainText) record.requestAccepted += stats.replied;
        else if (stats.replied > loop.requestAccepted - acceptedBefore) {
          const missing = stats.replied - (loop.requestAccepted - acceptedBefore);
          record.requestAccepted += missing; loop.requestAccepted += missing;
        }
        if (progress) { progress.stats = stats; progress.requestAccepted = loop.requestAccepted; }
        await updateStatus(record, runSignal);
        if (textOnly) return stats;
        await pause(runSignal, 1000);
      }
      if (textOnly) fail('CANCELLED');
    }).catch(async error => {
      if (!runSignal.aborted && !disposed) {
        record.lastError = errorCode(error); record.failures++; lastError = record.lastError;
        if (automaticConnection) { automaticConnection.phase = 'blocked'; automaticConnection.error = record.lastError; }
      }
      if (!disposed && (textOnly || !runSignal.aborted)) {
        try { await updateStatus(record, AbortSignal.timeout(1000)); }
        catch { record.status = { ...record.status, recoveryStatusUnknown: true }; }
      }
      if (textOnly) throw error;
    }).finally(async () => {
      loop.controller.abort();
      if (automaticConnection?.phase === 'running') automaticConnection.phase = 'stopped';
      if (historyPermit !== undefined || resumeOnce) await Promise.allSettled([...loop.nativeReplies]);
      if (POLLER_OWNERS.get(accountKey) === loop.token) POLLER_OWNERS.delete(accountKey);
      if (record.loop === loop) record.loop = null;
    });
    return textOnly ? loop.promise : record;
  }
  async function startHistorical(id, request, signal) {
    const first = request.firstTextConsentId !== undefined;
    const reserve = first ? taskData?.reserveFirstText : taskData?.reserveHistoricalText;
    const finish = first ? taskData?.finishFirstText : taskData?.finishHistoricalText;
    const schema = first ? TASK_WIRE.firstTextResultSchema : TASK_WIRE.historicalResultSchema;
    if (typeof reserve !== 'function' || typeof finish !== 'function') fail('UNAVAILABLE');
    const permit = await reserve(id, { [first ? 'firstTextConsentId' : 'historyConsentId']: first ? request.firstTextConsentId : request.historyConsentId, confirmation: request.confirmation }, signal);
    const progress = { polled: false };
    let stats, failure, settled;
    try {
      requireHistoricalTask(id, signal);
      stats = await start(id, signal, true, true, permit, progress);
      if (![0, 1].includes(stats?.replied)) fail('ACTION_FAILED');
    } catch (error) { failure = error; }
    finally {
      // Retire even before a loop exists. Native drain and logical request
      // accounting finish before this barrier. Unknown outcomes never refund it.
      const completed = stats ?? progress.stats;
      // In one-text polling, api-failed occurs only at getUpdates, before any
      // inbox commit or native reply. Send, store and cancellation stay unknown.
      const updatesFailed = failure instanceof WeixinChannelError && failure.code === 'api-failed' && failure.deliveryUnknown === false;
      settled = schema.parse(await finish(permit, {
        outcome: completed ? completed.replied === 1 ? 'replied' : 'empty' : progress.polled && !updatesFailed ? 'unknown' : 'blocked',
        requestAccepted: progress.requestAccepted ?? completed?.replied ?? 0,
      }));
    }
    if (failure) throw failure;
    return { ...stats, ...settled };
  }
  async function perform(raw, signal) {
    alive(signal);
    const parsed = conversationRequestSchemaFor('conversationAction').safeParse(raw);
    if (!parsed.success) fail('INVALID_REQUEST');
    const request = parsed.data, task = request.kind === 'task';
    // Reject source locations before opening state or resuming a native Session.
    if (request.action === 'grantSnapshot' || request.action === 'prepareSnapshot') validateArchiveRoot(request.root, [sourceRoot]);
    if (task && (request.action === 'createConversation' || request.action === 'grantWorkspace')) validateTaskDirectory(request.workspace.root, [sourceRoot]);
    if (task && request.action === 'grantDirectory') validateTaskDirectory(request.root, [sourceRoot]);
    if (task && request.action === 'connectConversation') validateTaskDirectory(request.expectedDirectory, [sourceRoot]);
    if (!task && isTaskSessionId(request.sessionId)) fail('SESSION_NOT_READY');
    const id = request.sessionId ?? request.contextSessionId;
    const emergency = request.action === 'stopChannel' || request.action === 'revokeSnapshot' || request.action === 'revokeSource' || request.action === 'revokeHistoricalContext' || request.action === 'revokeFirstTextContext'
      || request.action === 'stopLocalHistory' || task && request.action === 'setSharing' && !request.allowWechat;
    if (!emergency && request.action !== 'connectConversation' && ['pairing', 'model-required'].includes(autoConnections.get(id)?.phase)) fail('BUSY');
    if (busy.has(id) && !emergency) fail('BUSY');
    let control;
    if (emergency) {
      activeActions.get(id)?.abort();
    } else {
      control = new AbortController();
      activeActions.set(id, control);
      busy.add(id);
      signal = signal ? AbortSignal.any([signal, control.signal]) : control.signal;
    }
    try {
      let result, qr, target = id;
      switch (request.action) {
        case 'importLocalHistory': {
          await ensurePrepared(id, signal, true);
          if (service('agents')?.get?.(id)?.status === 'running') fail('BUSY');
          const priorLoop = channels.get(id)?.loop;
          const priorConnection = autoConnections.get(id);
          const reconnect = priorLoop && !priorLoop.textOnly && !priorLoop.historyPermit
            || priorConnection?.phase === 'history-required' && !priorConnection.controller.signal.aborted;
          const origin = priorLoop?.automaticConnection?.origin ?? priorConnection?.origin ?? id;
          await stop(id);
          const workspace = taskData.getState(id).sources.find(source => source.sourceId === 'workspace');
          if (!workspace || request.allowWechat && !workspace.allowWechat) {
            const directory = contextDirectory(id);
            if (!directory) fail('SESSION_NOT_READY');
            await taskData.grantWorkspace(id, { ...directory, allowWechat: request.allowWechat, confirmation: 'read-and-write-task-workspace' }, signal);
          }
          result = await localHistory.importHistory(id, request, signal);
          alive(signal);
          if (request.allowWechat) taskData.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
          if (reconnect && request.allowWechat) await connectConversation({ contextSessionId: origin,
            expectedDirectory: taskData.getWorkspace(id).root, confirmation: 'connect-own-wechat-auto-reply' }, signal, id);
          break;
        }
        case 'refreshLocalHistory':
          if (service('agents')?.get?.(id)?.status === 'running') fail('BUSY');
          await localHistory.refresh(id, signal); result = localHistory.state(id); break;
        case 'stopLocalHistory': dailyCards?.stop(id); result = localHistory.stop(id); break;
        case 'setDailyCardTime': result = await dailyCards.settings(id, request.time); break;
        case 'refreshDailyCards': {
          // Release the UI action lock while the coordinated card job runs.
          busy.delete(id);
          await dailyCards.update(id, true); result = dailyCards.state(id); break;
        }
        case 'connectConversation': {
          const connected = await connectConversation(request, signal);
          target = connected.sessionId; qr = connected.qr;
          result = { sessionId: target, automaticTextRequested: true };
          break;
        }
        case 'createConversation': {
          if (task) {
            taskReady();
            target = await taskBridge.createConversation(request.contextSessionId, request.workspace, signal);
            alive(signal);
            if (!isTaskSessionId(target)) fail('SESSION_CREATE_FAILED');
            knownTasks.set(target, request.workspace.title);
            if (!taskBridge.isPrepared(target)) fail('SESSION_NOT_READY');
            result = { sessionId: target };
            break;
          }
          let stage = 'HISTORY_OPEN_FAILED';
          try {
            await openHistory(signal);
            if (history.size + creationReservations >= 256) fail('BUSY');
            creationReservations++;
            try {
              stage = 'SESSION_CREATE_FAILED';
              target = await bridge.createConversation(request.contextSessionId, signal);
              alive(signal);
              stage = 'HISTORY_WRITE_FAILED';
              if (history.get(target)) fail('SESSION_NOT_READY');
              await history.put(target, { createdAt: Date.now(), mayContainArchiveData: false });
              knownSessions.add(target);
              result = { sessionId: target };
            } finally { creationReservations--; }
          } catch (error) {
            let code = errorCode(error);
            if (code === 'ACTION_FAILED') {
              code = stage === 'HISTORY_OPEN_FAILED' && error?.code === 'already-open' ? 'HISTORY_ALREADY_OPEN'
                : stage === 'HISTORY_OPEN_FAILED' && ['invalid-record', 'version-mismatch', 'malformed-medium'].includes(error?.code) ? 'HISTORY_INVALID'
                  : stage;
            }
            fail(code);
          }
          break;
        }
        case 'resumeConversation': {
          await ensurePrepared(id, signal, task);
          result = { sessionId: id, sameSession: true };
          break;
        }
        case 'grantWorkspace':
        case 'grantDirectory':
        case 'grantSession': {
          await ensurePrepared(id, signal, true);
          await stop(id);
          alive(signal);
          if (request.action === 'grantWorkspace') result = await taskData.grantWorkspace(id, request.workspace, signal);
          else if (request.action === 'grantDirectory') {
            const { root, title, sourceId, allowWechat, confirmation } = request;
            result = await taskData.grantDirectory(id, { root, title, ...(sourceId !== undefined ? { sourceId } : {}), allowWechat, confirmation }, signal);
          } else result = taskData.grantSession(id, { sessionId: request.sourceSessionId, title: request.title, allowWechat: request.allowWechat, confirmation: request.confirmation });
          break;
        }
        case 'grantSnapshot': {
          const { root, allConversations, talkers, fromTs, toTs, allowWechat, confirmation } = request;
          if (task) {
            await ensurePrepared(id, signal, true);
            await stop(id);
            dailyCards?.stop(id); localHistory?.stop(id);
            result = await taskData.grantSnapshot(id, { root, allConversations, talkers, fromTs, toTs, allowWechat, confirmation }, signal);
          } else {
            ready();
            if (!isBridgeContext(id) && allowWechat) fail('SHARED_CONTEXT_DENIED');
            const bridgeContext = await ensureDataContext(id, signal, true);
            await stop(id);
            result = await archive.grant(id, { root, allConversations, talkers, fromTs, toTs, allowWechat, confirmation }, signal);
            if (!bridgeContext) requireLiveDataContext(id, signal);
          }
          break;
        }
        case 'revokeSnapshot': {
          ready();
          const stopping = stop(id);
          result = archive.revoke(id);
          await stopping;
          break;
        }
        case 'revokeSource': {
          if (request.sourceId === 'archive' || request.sourceId === '*') { dailyCards?.stop(id); localHistory?.stop(id); }
          taskReady();
          const stopping = stop(id);
          result = request.sourceId === '*' ? taskData.revokeAll(id) : taskData.revoke(id, request.sourceId);
          await stopping;
          break;
        }
        case 'selectFirstTextModel': {
          requireHistoricalTask(id, signal);
          if (channels.get(id)?.loop) fail('BUSY');
          if (typeof taskBridge.selectFirstTextModel !== 'function') fail('UNAVAILABLE');
          const { provider, model, reasoningEffort, temperature, maxTokens, confirmation, preparationConfirmation, selectionRevision } = request;
          result = await taskBridge.selectFirstTextModel(id, { provider, model, confirmation,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(temperature === undefined ? {} : { temperature }),
            ...(maxTokens === undefined ? {} : { maxTokens }), ...(preparationConfirmation === undefined ? {} : { preparationConfirmation, selectionRevision }) }, signal);
          result = { firstTextContext: TASK_WIRE.firstTextContextSchema.parse(result.firstTextContext) };
          break;
        }
        case 'reviewFirstTextContext': {
          requireHistoricalTask(id, signal);
          if (channels.get(id)?.loop) fail('BUSY');
          if (typeof taskData.reviewFirstTextContext !== 'function') fail('UNAVAILABLE');
          const { reviewId, expiresAt, ...firstTextContext } = await taskData.reviewFirstTextContext(id, signal);
          result = TASK_WIRE.firstTextReviewResultSchema.parse({ firstTextContext, reviewId, expiresAt });
          break;
        }
        case 'authorizeFirstTextContext': {
          requireHistoricalTask(id, signal);
          if (channels.get(id)?.loop) fail('BUSY');
          if (typeof taskData.authorizeFirstTextContext !== 'function') fail('UNAVAILABLE');
          result = TASK_WIRE.firstTextResultSchema.parse(await taskData.authorizeFirstTextContext(id, { reviewId: request.reviewId, confirmation: request.confirmation }, signal));
          break;
        }
        case 'revokeFirstTextContext': {
          if (!taskData || typeof taskData.revokeFirstTextContext !== 'function') fail('UNAVAILABLE');
          const stopping = stop(id);
          result = TASK_WIRE.firstTextResultSchema.parse(await taskData.revokeFirstTextContext(id, { revokeId: request.revokeId }));
          await stopping;
          break;
        }
        case 'allowNewFirstText': {
          requireHistoricalTask(id, signal);
          if (channels.get(id)?.loop) fail('BUSY');
          if (typeof taskData.allowNewFirstText !== 'function') fail('UNAVAILABLE');
          result = TASK_WIRE.firstTextResultSchema.parse(await taskData.allowNewFirstText(id,
            { priorRunId: request.priorRunId, priorConsentId: request.priorConsentId, confirmation: request.confirmation }, signal));
          break;
        }
        case 'reviewHistoricalContext': {
          requireHistoricalTask(id, signal);
          if (channels.get(id)?.loop) fail('BUSY');
          const { reviewId, expiresAt, ...historicalContext } = await taskData.reviewHistoricalContext(id, signal);
          result = TASK_WIRE.historicalReviewResultSchema.parse({ historicalContext, reviewId, expiresAt });
          break;
        }
        case 'authorizeHistoricalContext': {
          requireHistoricalTask(id, signal);
          if (channels.get(id)?.loop) fail('BUSY');
          result = TASK_WIRE.historicalResultSchema.parse(await taskData.authorizeHistoricalContext(id, { reviewId: request.reviewId, confirmation: request.confirmation }, signal));
          break;
        }
        case 'revokeHistoricalContext': {
          if (!taskData || typeof taskData.revokeHistoricalContext !== 'function') fail('UNAVAILABLE');
          const stopping = stop(id);
          result = TASK_WIRE.historicalResultSchema.parse(await taskData.revokeHistoricalContext(id, { revokeId: request.revokeId }));
          await stopping;
          break;
        }
        case 'setSharing': {
          if (request.firstTextConsentId !== undefined) {
            requireHistoricalTask(id, signal);
            if (channels.get(id)?.loop) fail('BUSY');
            if (typeof taskData.shareFirstTextContext !== 'function') fail('UNAVAILABLE');
            result = TASK_WIRE.firstTextResultSchema.parse(await taskData.shareFirstTextContext(id, { firstTextConsentId: request.firstTextConsentId, confirmation: request.confirmation }, signal));
          } else if (request.historyConsentId !== undefined) {
            requireHistoricalTask(id, signal);
            if (channels.get(id)?.loop) fail('BUSY');
            result = TASK_WIRE.historicalResultSchema.parse(await taskData.shareHistoricalContext(id, { historyConsentId: request.historyConsentId, confirmation: request.confirmation }, signal));
          } else {
            if (request.allowWechat) await ensurePrepared(id, signal, true); else taskReady();
            const stopping = stop(id);
            alive(signal);
            result = taskData.setSharing(id, { allowWechat: request.allowWechat, confirmation: request.confirmation });
            await stopping;
          }
          break;
        }
        case 'querySource':
        case 'queryFiles': {
          await ensurePrepared(id, signal, true);
          result = request.action === 'querySource' ? await taskData.query(id, request.query, signal, 'local') : await taskData.file(id, request.query, signal, 'local');
          if (request.action === 'querySource' && request.query.action === 'status' && typeof taskData.getHistoricalState === 'function') {
            const historyState = typeof taskData.readHistoricalState === 'function' ? await taskData.readHistoricalState(id, signal) : taskData.getHistoricalState(id);
            result = { ...result, historicalContext: TASK_WIRE.historicalContextSchema.parse(historyState),
              ...(typeof taskData.getFirstTextState === 'function' ? { firstTextContext: TASK_WIRE.firstTextContextSchema.parse(taskData.getFirstTextState(id)) } : {}) };
          }
          break;
        }
        case 'prepareSnapshot': {
          requireLiveDataContext(id, signal);
          if (typeof archive?.browseRoster !== 'function') fail('UNAVAILABLE');
          result = await archive.browseRoster(request.root, { confirmation: request.confirmation,
            ...(request.query !== undefined ? { query: request.query } : {}), ...(request.limit !== undefined ? { limit: request.limit } : {}),
            ...(request.offset !== undefined ? { offset: request.offset } : {}) }, signal);
          requireLiveDataContext(id, signal);
          break;
        }
        case 'queryArchive': {
          const bridgeContext = await ensureDataContext(id, signal);
          result = await archive.query(id, request.query, signal, 'local');
          if (!bridgeContext) requireLiveDataContext(id, signal);
          break;
        }
        case 'beginLogin': {
          await ensurePrepared(id, signal, task); await stop(id);
          const render = await (dependencies.prepareQr || prepareLocalQrRenderer)();
          alive(signal);
          const record = await channelFor(id, signal, task);
          await record.channel.cancelLogin(signal); // Explicit replacement button cancels only transient local QR state.
          let login;
          try { login = await record.channel.beginLogin(signal); }
          catch (error) {
            if (error instanceof WeixinChannelError && error.code === 'already-paired') await updateStatus(record, signal);
            throw error;
          }
          qr = render(login.qrContent);
          await updateStatus(record, signal);
          break;
        }
        case 'pollLogin': {
          await ensurePrepared(id, signal, task);
          const record = await channelFor(id, signal, task);
          if (typeof record.channel.pollLoginForOwner !== 'function') fail('UNAVAILABLE');
          result = await record.channel.pollLoginForOwner(request.verifyCode, signal);
          await updateStatus(record, signal);
          break;
        }
        case 'confirmPairing': {
          await ensurePrepared(id, signal, task);
          const record = await channelFor(id, signal, task);
          result = await record.channel.confirmPairingForOwner(request.expectedOwnerId, signal);
          await updateStatus(record, signal);
          break;
        }
        case 'startChannel': { await start(id, signal, task); break; }
        case 'pollTextOnce': { result = request.historyConsentId === undefined && request.firstTextConsentId === undefined ? await start(id, signal, true, true) : await startHistorical(id, request, signal); break; }
        case 'resumeTextOnce': {
          await stop(id);
          result = await start(id, signal, true, true, undefined, undefined, undefined, true);
          break;
        }
        case 'diagnoseUpdatesOnce': {
          await ensurePrepared(id, signal, true);
          const record = await channelFor(id, signal, true);
          if (record.loop) fail('BUSY');
          if (typeof record.channel.diagnoseUpdatesOnce !== 'function' || typeof record.channel.getPairingIdentity !== 'function') fail('UNAVAILABLE');
          const identity = await record.channel.getPairingIdentity(signal);
          if (!identity || typeof identity.botId !== 'string' || typeof identity.userId !== 'string') fail('PAIRING_REQUIRED');
          const accountKey = JSON.stringify([identity.botId, identity.userId]);
          if (POLLER_OWNERS.has(accountKey) || POLLER_OWNERS.size >= 128) fail('BUSY');
          alive(signal);
          const token = Symbol('wechat-update-diagnostic');
          POLLER_OWNERS.set(accountKey, token);
          try {
            result = TASK_WIRE.updatesDiagnosticResultSchema.parse({ diagnostic: await record.channel.diagnoseUpdatesOnce(signal) });
            await updateStatus(record, signal);
          } finally {
            if (POLLER_OWNERS.get(accountKey) === token) POLLER_OWNERS.delete(accountKey);
          }
          break;
        }
        case 'stopChannel': {
          const stopping = stop(id);
          if (task && typeof taskData?.stopTextContexts === 'function') result = await taskData.stopTextContexts(id);
          await stopping;
          break;
        }
        case 'forgetPairing': {
          await ensurePrepared(id, signal, task); await stop(id);
          const record = await channelFor(id, signal, task);
          await record.channel.forget('forget-local-credentials', signal);
          await updateStatus(record, signal);
          break;
        }
        case 'discardPending': {
          await ensurePrepared(id, signal, task); await stop(id);
          const record = await channelFor(id, signal, task);
          await record.channel.discardPending('discard-without-retry', signal);
          await updateStatus(record, signal);
          break;
        }
        default: fail('INVALID_REQUEST');
      }
      alive(signal);
      lastError = null;
      const response = { ok: true, state: getState({ ...(task ? { kind: 'task' } : {}), sessionId: target }) };
      if (result !== undefined) response.result = result;
      if (qr !== undefined) response.qr = qr;
      return (task ? TASK_WIRE.actionResultSchema : actionResultSchema).parse(response);
    } finally {
      if (!emergency) {
        busy.delete(id);
        if (activeActions.get(id) === control) activeActions.delete(id);
      }
      if (['importLocalHistory', 'refreshLocalHistory', 'connectConversation'].includes(request.action)) void dailyCards?.update(isTaskSessionId(id) ? id : bindings?.get(id)?.sessionId ?? id);
    }
  }
  async function action(raw, signal) {
    try { return await perform(raw, signal); }
    catch (error) { lastError = errorCode(error); return { ok: false, error: { code: lastError } }; }
  }
  async function dispose() {
    if (disposal) return disposal;
    disposed = true;
    const historyDisposal = localHistory?.dispose();
    const cardsDisposal = dailyCards?.dispose();
    if (typeof removeDirectoryListener === 'function') removeDirectoryListener();
    for (const control of activeActions.values()) control.abort();
    for (const connection of autoConnections.values()) connection.controller.abort();
    for (const record of channels.values()) record.loop?.controller.abort();
    disposal = (async () => {
      await Promise.allSettled([historyDisposal, cardsDisposal, ...autoOperations, ...[...channels.values()].map(record => record.loop?.promise).filter(Boolean)]);
      for (const record of channels.values()) record.channel.dispose();
      const results = await Promise.allSettled([bridge, taskBridge, archive, taskData].filter(Boolean).map(value => Promise.resolve().then(() => value.dispose())));
      if (opening) await opening.catch(() => {});
      if (bindingOpening) await bindingOpening.catch(() => {});
      if (domain) await domain.close();
      if (bindingDomain) await bindingDomain.close();
      if (results.some(result => result.status === 'rejected')) fail('UNAVAILABLE');
    })();
    return disposal;
  }
  return Object.freeze({ getState, action, dispose });
}

export class WechatConversationService extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, CONVERSATION_NAMESPACE);
    this.runtime = createConversationRuntime(ctx, config);
    ctx.effect(() => () => this.runtime.dispose());
  }
  getConversationState(request, signal) {
    requireConversationOwner(this.ctx.invocation);
    return this.runtime.getState(request || {}, signal);
  }
  conversationAction(request, signal) {
    try { requireConversationOwner(this.ctx.invocation); }
    catch { return Promise.resolve({ ok: false, error: { code: 'NOT_AUTHORIZED' } }); }
    return this.runtime.action(request, signal);
  }
}
Object.defineProperty(WechatConversationService.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
  configurable: true,
  value: Object.freeze({ version: 1, methods: Object.freeze(CONVERSATION_METHOD_NAMES.map(method =>
    Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))) }),
});
export default WechatConversationService;
