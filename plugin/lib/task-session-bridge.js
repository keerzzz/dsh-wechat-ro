import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createNativeSessionBridge } from './native-session-bridge.js';
import { SessionBridgeError } from './session-bridge-agent.js';
import { TASK_PRESET_ID, isTaskSessionId } from './task-access.js';
import { bindTaskSessionData, assertTaskSessionHistory, installTaskSessionPolicy, hasTaskSessionPolicy, inspectTaskSessionHistory } from './task-session-agent.js';

export const TASK_SESSION_INFO = Object.freeze({ agentPreset: TASK_PRESET_ID, sandboxMode: 'workspace-write', messageSource: 'wechat-task-weixin',
  defaultTimeoutMs: 120000, maxTimeoutMs: 300000, maxInputBytes: 16384, maxReplyBytes: 16384 });
const fail = code => { throw new SessionBridgeError(code); };
export function createTaskSessionBridge(ctx, options = {}) {
  if (!ctx || !options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['data', 'timeoutMs'].includes(key))) fail('invalid-options');
  const data = options.data, timeoutMs = options.timeoutMs ?? TASK_SESSION_INFO.defaultTimeoutMs;
  if (!data || !['grantWorkspace', 'getWorkspace', 'revokeAll', 'prepare', 'query', 'file', 'canShare', 'getState', 'captureDeliverables', 'prepareDelivery', 'releaseDeliveries'].every(name => typeof data[name] === 'function')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TASK_SESSION_INFO.maxTimeoutMs) fail('invalid-options');
  const cores = new Map(), dataClaims = new Map(), controllers = new Set(), operations = new Set();
  let disposed = false, disposal;
  const check = signal => { if (disposed) fail('disposed'); if (signal?.aborted) fail('aborted'); };
  const service = name => ctx.get ? ctx.get(name) : ctx[name];

  function coreFor(sessionId) {
    let core = cores.get(sessionId);
    if (!core) {
      if (cores.size >= 128) fail('busy');
      core = createNativeSessionBridge(ctx, data, timeoutMs, Object.freeze({
        info: TASK_SESSION_INFO, isSessionId: isTaskSessionId, createSessionId: () => sessionId,
        requireData(value) { if (value !== data) fail('archive-unavailable'); },
        bindData(...args) {
          check();
          const release = bindTaskSessionData(...args), claim = Symbol('task-data-lease');
          dataClaims.set(args[0], claim);
          return () => { if (dataClaims.get(args[0]) === claim) { dataClaims.delete(args[0]); } release(); };
        },
        assertHistory: assertTaskSessionHistory, install: installTaskSessionPolicy,
        hasPolicy: hasTaskSessionPolicy, inspectHistory: inspectTaskSessionHistory,
        async finishReply({ session, turn, text, afterSeq }, signal) {
          let currentTurn = null;
          const calls = new Set(), succeeded = new Set(), declarations = [];
          for (const event of session.snapshotEvents()) {
            if (event.seq <= afterSeq) continue;
            if (event.type === 'turn/start') currentTurn = event.data.turn;
            if (currentTurn !== turn) continue;
            if (event.type === 'tool/call' && event.data.name === 'present') calls.add(event.data.callId);
            else if (event.type === 'tool/result' && event.data.error === undefined && event.data.message?.isError !== true) succeeded.add(event.data.message?.toolCallId);
            else if (event.type === 'deliverables/presented' && event.data.turn === turn) declarations.push(event.data);
            else if (event.type === 'turn/end' && event.data.turn === turn) currentTurn = null;
          }
          if (declarations.some(value => !calls.has(value.callId) || !succeeded.has(value.callId))) fail('not-completed');
          const deliverables = await data.captureDeliverables(sessionId, declarations, signal, turn);
          if (!text && deliverables.length === 0) fail('no-reply');
          return Object.freeze({ text, deliverables });
        },
      }));
      cores.set(sessionId, core);
    }
    return core;
  }
  function track(promise) { operations.add(promise); promise.then(() => operations.delete(promise), () => operations.delete(promise)); return promise; }
  function createConversation(contextSessionId, workspaceRequest, outerSignal, onAllocated) {
    check(outerSignal);
    if (typeof contextSessionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/u.test(contextSessionId)) fail('invalid-input');
    const sessions = service('sessions'), context = sessions?.get(SessionId(contextSessionId));
    if (!context || context.header?.id !== contextSessionId || onAllocated !== undefined && typeof onAllocated !== 'function') fail('invalid-input');
    const id = `wechat-task-${randomUUID()}`, core = coreFor(id), control = new AbortController();
    dataClaims.set(id, Symbol('task-creation'));
    controllers.add(control);
    const signal = outerSignal ? AbortSignal.any([outerSignal, control.signal]) : control.signal;
    return track((async () => {
      try {
        // Reservation durability precedes every workspace or native-session effect.
        if (onAllocated) await onAllocated(id);
        check(signal);
        await data.grantWorkspace(id, workspaceRequest, signal);
        check(signal);
        const workspace = data.getWorkspace(id);
        if (!workspace) fail('unsafe-session');
        const created = await core.createConversation(contextSessionId, signal, workspace.root);
        check(signal);
        if (created !== id) fail('unsafe-session');
        const entity = service('workspaceRegistry')?.get(workspace.id);
        if (!entity || entity.path !== workspace.root || typeof entity.attachSession !== 'function') fail('unsafe-session');
        await entity.attachSession(SessionId(id));
        check(signal);
        return id;
      } catch (error) {
        data.revokeAll(id);
        dataClaims.delete(id);
        await core.dispose();
        cores.delete(id);
        throw error instanceof SessionBridgeError ? error : new SessionBridgeError(signal.aborted ? 'aborted' : 'create-failed');
      } finally { controllers.delete(control); }
    })());
  }
  async function ensure(sessionId, signal) {
    check(signal);
    if (!isTaskSessionId(sessionId)) fail('invalid-input');
    const core = coreFor(sessionId);
    try {
      await core.ensure(sessionId, signal);
      check(signal);
      const agent = service('agents')?.get(SessionId(sessionId));
      if (!agent || !core.isPrepared(sessionId)) fail('not-prepared');
      await data.prepare(sessionId, agent.session, signal);
      check(signal);
      // Runtime authority keeps the Task's original workspace identity. The
      // sidebar registry may have rebuilt its ID, so restore display membership
      // through its existing entity at the same verified directory.
      const workspace = data.getWorkspace(sessionId), registry = service('workspaceRegistry');
      const entity = workspace?.root === agent.session.header.cwd && typeof registry?.list === 'function'
        ? registry.list().find(value => value.path === workspace.root) : undefined;
      if (entity && typeof entity.attachSession === 'function' && !entity.sessionIds.includes(SessionId(sessionId))) {
        await entity.attachSession(SessionId(sessionId));
        check(signal);
      }
    } catch (error) {
      if (!dataClaims.has(sessionId) && cores.get(sessionId) === core) { cores.delete(sessionId); await core.dispose(); }
      throw error;
    }
  }
  function isPrepared(sessionId) {
    if (disposed || !isTaskSessionId(sessionId)) return false;
    const state = data.getState(sessionId);
    return cores.get(sessionId)?.isPrepared(sessionId) === true && state.prepared && state.historyKnown;
  }
  async function selectFirstTextModel(_sessionId, _request, signal) { check(signal); fail('not-prepared'); }
  function replyFirstText(_sessionId, _text, _metadata, signal, _permit) { check(signal); fail('archive-denied'); }
  async function replyWithDeliverables(sessionId, text, metadata, signal) {
    await ensure(sessionId, signal);
    return cores.get(sessionId).reply(sessionId, text, metadata, signal);
  }
  async function reply(sessionId, text, metadata, signal) {
    const result = await replyWithDeliverables(sessionId, text, metadata, signal);
    data.releaseDeliveries(sessionId, result.deliverables.map(file => file.reference));
    return result.text;
  }
  async function continueReplyWithDeliverables(sessionId, text, metadata, signal) {
    await ensure(sessionId, signal);
    return cores.get(sessionId).continueReply(sessionId, text, metadata, signal);
  }
  async function continueReply(sessionId, text, metadata, signal) {
    const result = await continueReplyWithDeliverables(sessionId, text, metadata, signal);
    data.releaseDeliveries(sessionId, result.deliverables.map(file => file.reference));
    return result.text;
  }
  function replyHistorical(_sessionId, _text, _metadata, signal, _permit) { check(signal); fail('archive-denied'); }
  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    for (const control of controllers) control.abort();
    for (const id of dataClaims.keys()) data.revokeAll(id);
    dataClaims.clear();
    disposal = (async () => { await Promise.allSettled([...cores.values()].map(core => core.dispose())); await Promise.allSettled([...operations]); })();
    return disposal;
  }
  return Object.freeze({ createConversation, ensure, isPrepared, reply, replyWithDeliverables, continueReply, continueReplyWithDeliverables,
    replyHistorical, selectFirstTextModel, replyFirstText, hasDataHistory: id => cores.get(id)?.hasDataHistory(id) ?? 'unknown', dispose });
}
