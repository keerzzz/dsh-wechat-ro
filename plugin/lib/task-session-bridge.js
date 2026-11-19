import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createNativeSessionBridge } from './native-session-bridge.js';
import { SessionBridgeError } from './session-bridge-agent.js';
import { TASK_PRESET_ID, isTaskSessionId } from './task-access.js';
import { bindTaskSessionData, assertTaskSessionHistory, installTaskSessionPolicy, hasTaskSessionPolicy, inspectTaskSessionHistory } from './task-session-agent.js';
import { WEIXIN_LIMITS } from './weixin-http.js';
import { TASK_WIRE } from './conversation-wire.js';

export const TASK_SESSION_INFO = Object.freeze({ agentPreset: TASK_PRESET_ID, sandboxMode: 'workspace-write', messageSource: 'wechat-task-weixin',
  defaultTimeoutMs: 120000, maxTimeoutMs: 300000, maxInputBytes: 16384, maxReplyBytes: 16384 });
const fail = code => { throw new SessionBridgeError(code); };
export function createTaskSessionBridge(ctx, options = {}) {
  if (!ctx || !options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['data', 'timeoutMs'].includes(key))) fail('invalid-options');
  const data = options.data, timeoutMs = options.timeoutMs ?? TASK_SESSION_INFO.defaultTimeoutMs;
  if (!data || !['grantWorkspace', 'getWorkspace', 'revokeAll', 'prepare', 'query', 'file', 'canShare', 'getState', 'captureDeliverables', 'prepareDelivery', 'releaseDeliveries'].every(name => typeof data[name] === 'function')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TASK_SESSION_INFO.maxTimeoutMs) fail('invalid-options');
  const cores = new Map(), dataClaims = new Map(), historyBindings = new Map(), firstBindings = new Map(), controllers = new Set(), operations = new Set();
  let disposed = false, disposal;
  const check = signal => { if (disposed) fail('disposed'); if (signal?.aborted) fail('aborted'); };
  const service = name => ctx.get ? ctx.get(name) : ctx[name];
  const historyCapable = ['bindHistorySupport', 'verifyHistoricalText', 'bindHistoricalInput', 'noteHistoricalModelRequest', 'completeHistoricalModel']
    .every(name => typeof data[name] === 'function');
  function releaseHistoryBinding(id) {
    const binding = historyBindings.get(id);
    if (!binding) return;
    historyBindings.delete(id); binding.release();
  }
  function bindHistoryAgent(id, agent, core) {
    if (!historyCapable) return;
    const capability = agent.sealedHistory, previous = historyBindings.get(id);
    if (previous?.agent === agent && previous.capability === capability) return;
    releaseHistoryBinding(id);
    const release = data.bindHistorySupport(id, () => {
      if (disposed || service('agents')?.get(SessionId(id)) !== agent || !core.isPrepared(id)) return { available: false, ready: false, owner: null };
      const available = capability?.version === 1 && typeof capability.probe === 'function' && typeof capability.acquire === 'function';
      let ready = false;
      try { ready = available && capability.probe().supported === true; } catch { /* unavailable acquisition stays closed */ }
      return { available, ready, owner: agent, sequence: agent.session.seq };
    });
    historyBindings.set(id, { agent, capability, release });
  }
  const firstCapable = ['bindFirstTextSupport', 'invalidateTextModel', 'verifyFirstText', 'bindFirstTextInput', 'noteFirstTextModelRequest', 'completeFirstTextModel', 'firstTextObservation', 'retainFirstTextLease', 'drainFirstTextLease']
    .every(name => typeof data[name] === 'function');
  function releaseFirstBinding(id) {
    const binding = firstBindings.get(id);
    if (!binding) return;
    firstBindings.delete(id); binding.release();
  }
  function bindFirstAgent(id, agent, core) {
    if (!firstCapable) return;
    const capability = agent.sealedFirstText, previous = firstBindings.get(id);
    if (previous?.agent === agent && previous.capability === capability) return;
    releaseFirstBinding(id);
    const binding = { agent, capability, observation: null, modelObservation: null, selection: null, release: null };
    binding.release = data.bindFirstTextSupport(id, () => {
      const unavailable = { available: false, ready: false, valid: false, owner: null, sequence: agent.session.seq,
        reason: 'sdk-not-ready', observation: null, modelObservation: null, model: null, native: null, preparation: null };
      if (disposed || service('agents')?.get(SessionId(id)) !== agent || !core.isPrepared(id)) return unavailable;
      const available = capability?.version === 1 && ['probe', 'selectModel', 'prepareModel', 'observeModel', 'verifyModel', 'observe', 'summary', 'verify', 'acquire'].every(name => typeof capability[name] === 'function');
      if (!available) return unavailable;
      const model = capability.observeModel(), support = capability.probe();
      const value = { ...unavailable, available: true, owner: agent, preparation: model.selection ?? binding.selection };
      if (!model.supported) {
        binding.observation = null; binding.modelObservation = null;
        const nativeRefusal = support.supported === false && ['not-live', 'not-ready', 'busy', 'leased', 'seeded-session', 'not-empty', 'unprovable-projection'].includes(support.reason);
        return { ...value, reason: nativeRefusal ? support.reason : model.reason };
      }
      const safeModel = TASK_WIRE.firstTextModelSchema.parse(model.summary);
      if (binding.selection?.selectionRevision !== safeModel.selectionRevision) binding.selection = null;
      value.preparation = binding.selection;
      value.model = safeModel;
      if (!capability.verifyModel(model.observation)) return { ...value, reason: 'model-stale' };
      if (binding.modelObservation !== model.observation || !binding.observation || !capability.verify(binding.observation)) {
        binding.observation = null; binding.modelObservation = model.observation;
        const observed = capability.observe(model.observation);
        if (!observed.supported) return { ...value, reason: observed.reason };
        binding.observation = observed.observation;
      }
      const native = capability.summary(binding.observation);
      const valid = Boolean(native && native.sessionId === id && native.agentId === id && capability.verify(binding.observation) && capability.verifyModel(model.observation));
      return { ...value, ready: valid && support.supported === true, valid, reason: valid ? support.supported ? null : support.reason : 'observation-stale',
        observation: binding.observation, modelObservation: model.observation, native: native ?? null };
    });
    firstBindings.set(id, binding);
  }
  async function finishTextReply({ session, turn, text, afterSeq, historyPermit }) {
    let currentTurn = null;
    for (const event of session.snapshotEvents()) {
      if (event.seq <= afterSeq) continue;
      if (event.type === 'turn/start') currentTurn = event.data.turn;
      if (currentTurn !== turn) continue;
      if (['tool/call', 'tool/result', 'deliverables/presented'].includes(event.type)
        || event.type === 'assistant/message' && event.data.message?.content?.some(block => block.type === 'tool-call')) fail('not-completed');
      if (event.type === 'turn/end' && event.data.turn === turn) currentTurn = null;
    }
    if (!text) fail('no-reply');
    if (historyPermit.purpose === 'first-text-once') data.completeFirstTextModel(historyPermit);
    else data.completeHistoricalModel(historyPermit);
    return Object.freeze({ text, deliverables: [] });
  }
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
          return () => { if (dataClaims.get(args[0]) === claim) { dataClaims.delete(args[0]); releaseHistoryBinding(args[0]); releaseFirstBinding(args[0]); } release(); };
        },
        assertHistory: assertTaskSessionHistory, install: installTaskSessionPolicy,
        hasPolicy: hasTaskSessionPolicy, inspectHistory: inspectTaskSessionHistory,
        historical: historyCapable ? Object.freeze({
          verify: permit => data.verifyHistoricalText(permit),
          bindInput: (permit, inputId, turn) => data.bindHistoricalInput(permit, inputId, turn),
          recordRequests: (permit, count) => data.noteHistoricalModelRequest(permit, count),
          finishReply: finishTextReply,
        }) : undefined,
        firstText: firstCapable ? Object.freeze({
          verify: permit => data.verifyFirstText(permit), bindInput: (permit, inputId, turn) => data.bindFirstTextInput(permit, inputId, turn),
          recordRequests: (permit, count) => data.noteFirstTextModelRequest(permit, count), observation: permit => data.firstTextObservation(permit),
          retainLease: (permit, lease) => data.retainFirstTextLease(permit, lease), drainLease: permit => data.drainFirstTextLease(permit),
          maxOutputBytes: WEIXIN_LIMITS.maxTextBytes, finishReply: finishTextReply,
        }) : undefined,
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
      bindHistoryAgent(sessionId, agent, core);
      bindFirstAgent(sessionId, agent, core);
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
  function selectFirstTextModel(sessionId, raw, outerSignal) {
    check(outerSignal);
    const request = TASK_WIRE.firstTextModelRequestSchema.parse(raw), binding = firstBindings.get(sessionId);
    if (!firstCapable || !isPrepared(sessionId) || !binding || binding.capability?.version !== 1
      || typeof binding.capability.selectModel !== 'function' || typeof binding.capability.prepareModel !== 'function') fail('not-prepared');
    if (binding.preparing) fail('busy');
    const config = { provider: request.provider, model: request.model,
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }) };
    if (request.preparationConfirmation !== undefined && (!binding.selection || binding.selection.selectionRevision !== request.selectionRevision
      || !binding.requestConfig || Object.keys(config).length !== Object.keys(binding.requestConfig).length
      || Object.keys(config).some(key => config[key] !== binding.requestConfig[key]) || binding.selection.preparation.supported !== true)) fail('invalid-input');
    const control = new AbortController(); controllers.add(control);
    const signal = AbortSignal.any([control.signal, AbortSignal.timeout(timeoutMs), ...(outerSignal ? [outerSignal] : [])]);
    binding.preparing = true;
    return track((async () => {
      try {
        data.invalidateTextModel(sessionId); binding.observation = null; binding.modelObservation = null;
        if (request.preparationConfirmation === undefined) {
          binding.selection = TASK_WIRE.firstTextSelectionSchema.parse(binding.capability.selectModel(config));
          binding.requestConfig = Object.freeze(config);
        } else await binding.capability.prepareModel({ selectionRevision: request.selectionRevision, signal });
        check(signal);
        if (!isPrepared(sessionId) || firstBindings.get(sessionId) !== binding) fail('not-prepared');
        return { firstTextContext: TASK_WIRE.firstTextContextSchema.parse(data.getFirstTextState(sessionId)) };
      } catch (error) { throw error instanceof SessionBridgeError ? error : new SessionBridgeError(signal.aborted ? 'aborted' : 'archive-denied'); }
      finally { binding.preparing = false; controllers.delete(control); }
    })());
  }
  function replyFirstText(sessionId, text, metadata, signal, permit) {
    check(signal);
    if (!firstCapable || !isPrepared(sessionId) || permit?.sessionId !== sessionId || data.verifyFirstText(permit) !== true) fail('archive-denied');
    return cores.get(sessionId).reply(sessionId, text, metadata, signal, permit);
  }
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
  function replyHistorical(sessionId, text, metadata, signal, permit) {
    check(signal);
    if (!historyCapable || !isPrepared(sessionId) || permit?.sessionId !== sessionId || data.verifyHistoricalText(permit) !== true) fail('archive-denied');
    // Never resume, refresh sources, or capture deliveries for a historical run.
    return cores.get(sessionId).reply(sessionId, text, metadata, signal, permit);
  }
  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    for (const control of controllers) control.abort();
    for (const id of historyBindings.keys()) releaseHistoryBinding(id);
    for (const id of firstBindings.keys()) releaseFirstBinding(id);
    for (const id of dataClaims.keys()) data.revokeAll(id);
    dataClaims.clear();
    disposal = (async () => { await Promise.allSettled([...cores.values()].map(core => core.dispose())); await Promise.allSettled([...operations]); })();
    return disposal;
  }
  return Object.freeze({ createConversation, ensure, isPrepared, reply, replyWithDeliverables, continueReply, continueReplyWithDeliverables,
    replyHistorical, selectFirstTextModel, replyFirstText, hasDataHistory: id => cores.get(id)?.hasDataHistory(id) ?? 'unknown', dispose });
}
