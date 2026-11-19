import { isAbsolute, relative, resolve } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SessionBridgeError } from './session-bridge-agent.js';

const PROTECTED_SOURCE_ROOT = '/home/keer/Documents/xwechat_files';
const fail = code => { throw new SessionBridgeError(code); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fixedError = (error, fallback) => error instanceof SessionBridgeError ? error : new SessionBridgeError(fallback);

function validContextId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\0\r\n/\\]/u.test(value);
}
function validCwd(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) return false;
  const rel = relative(resolve(PROTECTED_SOURCE_ROOT), resolve(value));
  // Lexical only: never stat, realpath, or inspect the protected account source.
  return rel !== '' && (rel === '..' || rel.startsWith('../') || isAbsolute(rel));
}

export function createNativeSessionBridge(ctx, data, timeoutMs, policy) {
  const info = policy.info;
  const SOURCE = info.messageSource;
  const CONTINUATION = `${SOURCE}-continuation`;
  const isOwnInput = message => message?.role === 'user' && message.source?.kind === SOURCE;
  const isContinuationInput = message => message?.role === 'user' && message.source?.kind === CONTINUATION;
  const continuationText = (inputId, turn) => `继续完成本会话中原生输入 ${inputId} 尚未完成的微信任务。上次执行轮次为 ${turn}。沿用已有会话内容、工具结果与工作区成果，处理失败步骤后生成原请求的最终回复。原微信输入已经保存在会话中，本指令只继续该任务。`;
  const owned = new Map();
  const operations = new Set();
  const factoryControllers = new Set();
  let disposed = false, disposePromise;
  const check = signal => {
    if (disposed) fail('disposed');
    if (signal?.aborted) fail('aborted');
  };
  const services = () => {
    const agents = ctx.get ? ctx.get('agents') : ctx.agents;
    const sessions = ctx.get ? ctx.get('sessions') : ctx.sessions;
    const agentPresets = ctx.get ? ctx.get('agentPresets') : ctx.agentPresets;
    const sandboxPolicy = ctx.get ? ctx.get('sandboxPolicy') : ctx.sandboxPolicy;
    if (!agents || typeof agents.create !== 'function' || typeof agents.resume !== 'function'
      || typeof agents.get !== 'function' || !sessions || typeof sessions.get !== 'function'
      || typeof sessions.flush !== 'function') fail('persistence-unavailable');
    if (!agentPresets || typeof agentPresets.resolve !== 'function' || typeof agentPresets.mount !== 'function'
      || typeof agentPresets.composedPreset !== 'function') fail('preset-unavailable');
    if (!sandboxPolicy || typeof sandboxPolicy.resolve !== 'function') fail('unsafe-session');
    policy.requireData(data);
    return { agents, sessions, agentPresets, sandboxPolicy, data };
  };
  function configureModel(agent, initialSelection) {
    try {
      const service = name => ctx.get ? ctx.get(name) : ctx[name];
      const projections = service('sessionProjections');
      const projected = projections?.stateOf?.(agent.session, 'modelSelection');
      if (projected === undefined && agent.session.snapshotEvents().some(event => event.type === 'model/selection')) fail('model-unavailable');
      const header = agent.session.requestHeader?.();
      let selected;
      if (initialSelection !== undefined) selected = initialSelection;
      else if (projected?.pending) selected = projected.pending;
      else if (header) {
        const config = header.config;
        selected = { provider: config?.provider, model: config?.model,
          ...(header.adapterDefaults?.reasoningEffort === true || config?.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) };
      } else if (agent.options?.provider || agent.options?.model) {
        selected = agent.options;
      } else {
        const defaults = service('agentDefaultModel');
        if (defaults === undefined) return;
        selected = defaults.currentSelection();
      }
      if (!selected || typeof selected.provider !== 'string' || !selected.provider.trim()
        || typeof selected.model !== 'string' || !selected.model.trim()
        || selected.reasoningEffort !== undefined && (typeof selected.reasoningEffort !== 'string' || !selected.reasoningEffort.trim())
        || !agent.options || typeof agent.options !== 'object') fail('model-unavailable');
      const selection = { provider: selected.provider, model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) };
      agent.options.provider = selection.provider;
      agent.options.model = selection.model;
      if (selection.reasoningEffort === undefined) delete agent.options.reasoningEffort;
      else agent.options.reasoningEffort = selection.reasoningEffort;
      return selection;
    } catch { fail('model-unavailable'); }
  }
  const track = promise => {
    operations.add(promise);
    promise.then(() => operations.delete(promise), () => operations.delete(promise));
    return promise;
  };
  function inputSeen(session, messageId) {
    for (const event of session.snapshotEvents()) {
      const messages = event.type === 'user/message' ? [event.data]
        : event.type === 'agent/inbox/spliced' ? event.data?.inserted ?? [] : [];
      if (messages.some(message => isOwnInput(message) && message.source.messageId === messageId)) return true;
    }
    return false;
  }
  async function flush(session, service) {
    try {
      if (await service.flush(session) !== true) fail('persistence-unavailable');
    } catch (error) { throw fixedError(error, 'persistence-failed'); }
  }
  async function safePreset(service) {
    try {
      const preset = await service.resolve(info.agentPreset);
      if (!preset || preset.id !== info.agentPreset || preset.broken !== undefined) fail('preset-unavailable');
    } catch (error) { throw fixedError(error, 'preset-unavailable'); }
  }
  function waitFor(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new SessionBridgeError('aborted'));
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new SessionBridgeError('aborted')); };
      const cleanup = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }

  function makeRecord(sessionId) {
    return { sessionId, handle: null, agent: null, borrowed: false, unsubscribe: null,
      prepare: null, pending: null, attempt: null, currentTurn: null, release: null,
      controller: null, usedIds: new Set() };
  }
  function attachRecord(record, agent) {
    record.agent = agent;
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'turn/start') record.currentTurn = event.data.turn;
      else if (event.type === 'turn/end' && event.data.turn === record.currentTurn) record.currentTurn = null;
    }
    record.unsubscribe = agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return;
      if (event.type === 'turn/start') record.currentTurn = event.data.turn;
      else if (event.type === 'turn/end' && event.data.turn === record.currentTurn) record.currentTurn = null;
    });
  }
  async function prepare(record, fresh, cwd, signal, initialSelection) {
    const controller = new AbortController();
    record.controller = controller;
    factoryControllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const runtime = services();
      await safePreset(runtime.agentPresets);
      check(signal);
      if (runtime.agents.get(SessionId(record.sessionId))) fail('not-owned');
      record.release = policy.bindData(record.sessionId, runtime.data, () =>
        record.attempt?.turn !== null && record.attempt?.turn !== undefined
          && record.attempt.turn === record.currentTurn ? 'wechat' : 'local');
      const setup = async (agentCtx, agent) => {
        check(controller.signal);
        if (agent.session.id !== record.sessionId || !validCwd(agent.session.header.cwd)) fail('unsafe-session');
        policy.assertHistory(agent.session, { fresh });
        // Always an explicit persistent identity. No composeFrom or parent grants/history.
        try {
          await runtime.agentPresets.mount(agentCtx, info.agentPreset);
          if (runtime.agentPresets.composedPreset(agentCtx) !== info.agentPreset) fail('preset-unavailable');
        } catch (error) { throw fixedError(error, 'preset-unavailable'); }
        check(controller.signal);
        await policy.install(agentCtx, agent, runtime.sandboxPolicy);
        check(controller.signal);
        const selected = configureModel(agent, initialSelection);
        // Match the native selector's durable event; fresh setup owns this input.
        if (fresh && initialSelection !== undefined) agent.session.append('model/selection', selected);
        policy.assertHistory(agent.session);
        if (!agent.inbox || typeof agent.inbox.remove !== 'function') fail('unsafe-session');
        // Uncertain WeChat work left in a native inbox is NOT replayed on resume.
        // The channel's durable state requires a separate explicit discard/recovery.
        if (!fresh) {
          for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
            if (isOwnInput(message) || isContinuationInput(message)) agent.inbox.remove(message.id);
          }
        }
        attachRecord(record, agent);
      };
      const factoryOptions = fresh
        ? { sessionId: SessionId(record.sessionId), meta: { cwd, agentPreset: info.agentPreset }, setup, signal: controller.signal }
        : { resumeSessionId: SessionId(record.sessionId), setup, signal: controller.signal };
      const handle = fresh ? await runtime.agents.create(factoryOptions) : await runtime.agents.resume(factoryOptions);
      // Only the actual factory return is the teardown capability, never agents.get().
      record.handle = handle;
      if (!handle || typeof handle.dispose !== 'function' || handle.agent?.session?.id !== record.sessionId
        || !policy.hasPolicy(handle.agent)) fail('unsafe-session');
      check(controller.signal);
      await flush(handle.agent.session, runtime.sessions);
      check(controller.signal);
      return record;
    } catch (error) {
      if (record.handle && typeof record.handle.dispose === 'function') await record.handle.dispose().catch(() => {});
      record.release?.();
      record.unsubscribe?.();
      if (owned.get(record.sessionId) === record) owned.delete(record.sessionId);
      throw controller.signal.aborted ? new SessionBridgeError(disposed ? 'disposed' : 'aborted')
        : fixedError(error, fresh ? 'create-failed' : 'resume-failed');
    } finally {
      signal?.removeEventListener('abort', abort);
      factoryControllers.delete(controller);
      record.controller = null;
    }
  }

  async function createConversation(contextSessionId, signal, selectedCwd) {
    check(signal);
    if (!validContextId(contextSessionId)) fail('invalid-input');
    const runtime = services();
    const context = runtime.sessions.get(SessionId(contextSessionId)); // memory only, no auto-resume
    if (!context || context.header?.id !== contextSessionId || !validCwd(context.header?.cwd)) fail('invalid-input');
    const cwd = selectedCwd === undefined ? context.header.cwd : selectedCwd;
    if (selectedCwd !== undefined && !validCwd(cwd)) fail('invalid-input');
    const projections = ctx.get ? ctx.get('sessionProjections') : ctx.sessionProjections;
    const pending = projections?.stateOf?.(context, 'modelSelection')?.pending;
    const initialSelection = pending == null ? undefined : { provider: pending.provider, model: pending.model,
      ...(pending.reasoningEffort === undefined ? {} : { reasoningEffort: pending.reasoningEffort }) };
    const sessionId = policy.createSessionId();
    const record = makeRecord(sessionId);
    owned.set(sessionId, record);
    record.prepare = track(prepare(record, true, cwd, signal, initialSelection));
    await record.prepare;
    return sessionId;
  }
  function isPrepared(sessionId) {
    if (disposed || !policy.isSessionId(sessionId)) return false;
    const record = owned.get(sessionId);
    if (!record?.agent) return false;
    try {
      const runtime = services();
      return runtime.agents.get(SessionId(sessionId)) === record.agent
        && runtime.sessions.get(SessionId(sessionId)) === record.agent.session
        && runtime.agentPresets.composedPreset(record.agent.ctx) === info.agentPreset
        && policy.hasPolicy(record.agent)
        && policy.assertHistory(record.agent.session) === true;
    } catch { return false; }
  }
  async function borrow(record, agent, signal) {
    try {
      const runtime = services();
      await safePreset(runtime.agentPresets);
      check(signal);
      if (runtime.agents.get(SessionId(record.sessionId)) !== agent
        || runtime.sessions.get(SessionId(record.sessionId)) !== agent.session
        || runtime.agentPresets.composedPreset(agent.ctx) !== info.agentPreset
        || !validCwd(agent.session.header.cwd) || !policy.hasPolicy(agent)
        || policy.assertHistory(agent.session) !== true
        || !agent.inbox || typeof agent.inbox.remove !== 'function') fail('not-prepared');
      record.borrowed = true;
      attachRecord(record, agent);
      record.release = policy.bindData(record.sessionId, runtime.data, () =>
        record.attempt?.turn !== null && record.attempt?.turn !== undefined
          && record.attempt.turn === record.currentTurn ? 'wechat' : 'local', agent);
      await flush(agent.session, runtime.sessions);
      check(signal);
      if (!isPrepared(record.sessionId)) fail('not-prepared');
      return record;
    } catch (error) {
      record.release?.();
      record.unsubscribe?.();
      if (owned.get(record.sessionId) === record) owned.delete(record.sessionId);
      throw fixedError(error, 'not-prepared');
    }
  }
  async function ensure(sessionId, signal) {
    check(signal);
    if (!policy.isSessionId(sessionId)) fail('invalid-input');
    let record = owned.get(sessionId);
    if (record?.prepare) {
      await waitFor(record.prepare, signal);
      check(signal);
      if (!isPrepared(sessionId)) fail('not-prepared');
      return;
    }
    if (record?.agent) {
      if (!isPrepared(sessionId)) fail('not-prepared');
      return;
    }
    const runtime = services();
    const live = runtime.agents.get(SessionId(sessionId));
    record = makeRecord(sessionId);
    owned.set(sessionId, record);
    // A registry value is not a handle; borrow data and observers, not GUI teardown.
    record.prepare = track(live ? borrow(record, live, signal) : prepare(record, false, undefined, signal));
    await waitFor(record.prepare, signal);
    check(signal);
  }

  function hasDataHistory(sessionId) {
    const session = owned.get(sessionId)?.agent?.session;
    if (!session) return 'unknown';
    return policy.inspectHistory(session);
  }

  function failedInput(record, text, messageId) {
    const agent = record.agent;
    if (agent.status !== 'idle' || record.currentTurn !== null || agent.inbox.hasPending
      || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) fail('busy');
    const turns = new Map(), inputs = [], inserted = new Set();
    let currentTurn = null, lastTurn = null;
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'agent/inbox/spliced') {
        for (const message of event.data.inserted ?? []) inserted.add(message.id);
      } else if (event.type === 'turn/start') {
        currentTurn = event.data.turn; lastTurn = currentTurn;
        turns.set(currentTurn, { reason: null, finalOutput: false });
      } else if (event.type === 'user/message') {
        const generated = !inserted.has(event.data.id) && (event.data.source?.kind === 'runtime-context'
          || event.data.source?.kind === 'model-selection' && event.data.source.form === 'notice');
        if (!generated) inputs.push({ message: event.data, turn: currentTurn });
      } else if (event.type === 'assistant/message') {
        const turn = turns.get(event.data.turn), content = event.data.message?.content;
        const finished = event.data.stream?.some(item => item?.type === 'chunk'
          && item.chunk?.type === 'finish' && item.chunk.reason?.kind === 'stop');
        if (turn && !event.data.interrupted && event.data.message?.source?.kind === 'model' && finished
          && Array.isArray(content) && !content.some(block => block?.type === 'tool-call')
          && content.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())) turn.finalOutput = true;
      } else if (event.type === 'deliverables/presented') {
        const turn = turns.get(event.data.turn);
        if (turn) turn.finalOutput = true;
      } else if (event.type === 'turn/end') {
        const turn = turns.get(event.data.turn);
        if (turn) turn.reason = event.data.reason?.kind;
        if (currentTurn === event.data.turn) currentTurn = null;
      }
    }
    const originals = inputs.filter(input => isOwnInput(input.message) && input.message.source.messageId === messageId);
    if (originals.length !== 1) fail(originals.length ? 'already-processed' : 'invalid-input');
    const original = originals[0], content = original.message.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' || content[0].text !== text) fail('invalid-input');
    let previous = original;
    const failed = input => {
      const turn = turns.get(input.turn);
      if (!turn || !['error', 'aborted'].includes(turn.reason)) fail('not-completed');
      if (turn.finalOutput) fail('already-processed');
    };
    failed(previous);
    for (const input of inputs.slice(inputs.indexOf(original) + 1)) {
      const source = input.message.source, content = input.message.content;
      if (!isContinuationInput(input.message) || source.messageId !== messageId || source.inputId !== original.message.id
        || source.previousInputId !== previous.message.id || source.previousTurn !== previous.turn
        || input.turn <= previous.turn || inputs.some(other => other !== input && other.turn === input.turn)
        || !Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text'
        || content[0].text !== continuationText(original.message.id, previous.turn)) fail('already-processed');
      failed(input); previous = input;
    }
    if (inputs.some(input => input !== original && input.turn === original.turn) || lastTurn !== previous.turn) fail('not-completed');
    return createUserMessage({ content: [{ type: 'text', text: continuationText(original.message.id, previous.turn) }], source: {
      kind: CONTINUATION, messageId, inputId: original.message.id, previousInputId: previous.message.id, previousTurn: previous.turn,
    } });
  }

  function observeAttempt(record, message, attempt) {
    const agent = record.agent;
    const claims = new Map();
    const removers = [];
    const markClaim = ({ agent: forAgent, message: claimed, turn }) => {
      if (forAgent !== agent || attempt.ended) return;
      let ids = claims.get(turn);
      if (!ids) { ids = new Set(); claims.set(turn, ids); }
      ids.add(claimed.id);
      if (claims.size > 4096) attempt.invalid = true;
      if (claimed.id === message.id) {
        if (attempt.turn !== null) attempt.invalid = true;
        attempt.turn = turn;
        if (ids.size !== 1) attempt.mixed = true;
      } else if (attempt.turn === turn) attempt.mixed = true;
    };
    removers.push(agent.ctx.on('agent/inbox/claimed', markClaim));
    removers.push(agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || attempt.ended) return;
      const data = event.data;
      if (event.type === 'user/message') {
        if (data.id === message.id) {
          if (attempt.admitted || attempt.turn === null || record.currentTurn !== attempt.turn
            || !(isOwnInput(data) || isContinuationInput(data)) || data.source.kind !== message.source.kind
            || data.source.messageId !== message.source.messageId
            || isContinuationInput(message) && (data.source.inputId !== message.source.inputId
              || data.source.previousInputId !== message.source.previousInputId || data.source.previousTurn !== message.source.previousTurn)) attempt.invalid = true;
          attempt.admitted = true;
        } else if (record.currentTurn === attempt.turn) {
          // SDK context snapshots and model notices are not claimed inbox input.
          const generatedRuntime = data.source?.kind === 'runtime-context'
            && !claims.get(attempt.turn)?.has(data.id);
          const generatedSelection = attempt.modelSelectionNotices && data.source?.kind === 'model-selection' && data.source.form === 'notice'
            && !claims.get(attempt.turn)?.has(data.id);
          if (!generatedRuntime && !generatedSelection) attempt.mixed = true;
        }
      } else if (event.type === 'assistant/message' && data.turn === attempt.turn) {
        const route = agent.session.requestContext();
        const nativeStream = Array.isArray(data.stream) && data.stream.some(record =>
          record?.type === 'chunk' && record.chunk?.type === 'finish');
        if (!attempt.admitted || data.interrupted || data.message?.role !== 'assistant'
          || data.message.source?.kind !== 'model' || !route || !nativeStream
          || data.message.source.provider !== route.provider
          || data.message.source.model !== route.model) { attempt.invalid = true; return; }
        // Last admitted assistant text only; reasoning, files and foreign turns are excluded.
        const content = data.message.content;
        attempt.text = Array.isArray(content) ? content.filter(block => block?.type === 'text'
          && typeof block.text === 'string').map(block => block.text).join('\n').trim() : '';
      } else if (event.type === 'turn/end' && data.turn === attempt.turn) {
        attempt.ended = true;
        attempt.completed = data.reason?.kind === 'completed';
        attempt.terminal.resolve();
      }
    }));
    return () => { for (const remove of removers.splice(0).reverse()) remove(); };
  }

  function reply(sessionId, text, metadata, signal, historyPermit, continuation = false) {
    if (historyPermit !== undefined) fail('archive-denied');
    check(signal);
    if (!policy.isSessionId(sessionId) || typeof text !== 'string' || text.trim().length === 0
      || text.includes('\0') || Buffer.byteLength(text, 'utf8') > info.maxInputBytes
      || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || Object.keys(metadata).some(key => key !== 'messageId')
      || typeof metadata.messageId !== 'string' || metadata.messageId.length === 0
      || metadata.messageId.length > 256 || /[\0\r\n]/u.test(metadata.messageId)) fail('invalid-input');
    const existing = owned.get(sessionId);
    if (existing?.pending) fail('busy');
    const controller = new AbortController();
    const cancelled = deferred();
    let record, attempt, message, cancelError;
    const replyAllowed = runtime => {
      return runtime.data.canShare(sessionId) === true;
    };
    const cancelOwn = () => {
      if (!record?.agent || !message) return;
      const agent = record.agent;
      try { agent.inbox.remove(message.id); } catch { /* teardown still drains the owned handle */ }
      if (attempt?.turn !== null && attempt?.turn !== undefined && !attempt.ended
        && !attempt.mixed && record.currentTurn === attempt.turn) {
        try { agent.cancel({ kind: 'hook', reason: 'WeChat reply cancelled' }, { keepInbox: true }); } catch { /* fixed public error */ }
      }
    };
    const cancel = code => {
      if (cancelError) return;
      cancelError = new SessionBridgeError(code);
      controller.abort();
      cancelOwn();
      cancelled.resolve(cancelError);
    };
    const abort = () => cancel(disposed ? 'disposed' : 'aborted');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => cancel('timeout'), timeoutMs);
    timer.unref?.();
    const work = track((async () => {
      let unobserve;
      try {
        await ensure(sessionId, controller.signal);
        check(controller.signal);
        record = owned.get(sessionId);
        if (!record?.agent || !isPrepared(sessionId)) fail('not-prepared');
        if (record.attempt) fail('busy');
        const runtime = services();
        if (!replyAllowed(runtime)) fail('archive-denied');
        if (continuation) {
          if (record.agent.status !== 'idle' || record.currentTurn !== null || record.agent.inbox.hasPending) fail('busy');
          await waitFor(record.agent.whenIdle(), controller.signal);
          check(controller.signal);
          if (!isPrepared(sessionId) || !replyAllowed(runtime)) fail('archive-denied');
          message = failedInput(record, text, metadata.messageId);
        } else {
          if (record.usedIds.has(metadata.messageId) || inputSeen(record.agent.session, metadata.messageId)) fail('already-processed');
          message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: SOURCE, messageId: metadata.messageId } });
        }
        attempt = { turn: null, admitted: false, mixed: false, invalid: false, ended: false, modelSelectionNotices: historyPermit === undefined,
          completed: false, text: '', afterSeq: record.agent.session.seq, terminal: deferred(), cancel };
        record.attempt = attempt;

        record.usedIds.add(metadata.messageId);
        unobserve = observeAttempt(record, message, attempt);
        check(controller.signal);
        record.agent.followup(message); // exact immutable native input; no mirror append
        await flush(record.agent.session, runtime.sessions); // native inbox/user input barrier
        await Promise.race([attempt.terminal.promise, cancelled.promise]);
        if (cancelError) {
          cancelOwn();
          if (attempt.turn !== null && !attempt.ended) await attempt.terminal.promise; // retain busy until own work drains
          await flush(record.agent.session, runtime.sessions); // durable cancellation, never replay
          throw cancelError;
        }
        if (!attempt.completed || !attempt.admitted || attempt.mixed || attempt.invalid) fail('not-completed');
        const finishReply = policy.finishReply;
        if ((!attempt.text && !finishReply) || Buffer.byteLength(attempt.text, 'utf8') > info.maxReplyBytes) fail('no-reply');
        if (!isPrepared(sessionId) || !replyAllowed(runtime)) fail('archive-denied');
        await flush(record.agent.session, runtime.sessions); // completed output barrier BEFORE transport
        check(controller.signal);
        if (!replyAllowed(runtime)) fail('archive-denied');
        if (finishReply) {
          const result = await finishReply({ session: record.agent.session, turn: attempt.turn, text: attempt.text, afterSeq: attempt.afterSeq,
            ...(historyPermit === undefined ? {} : { historyPermit }) }, controller.signal);
          check(controller.signal);
          if (!isPrepared(sessionId) || !replyAllowed(runtime)) fail('archive-denied');
          return result;
        }
        return attempt.text;
      } catch (error) {
        const publicError = fixedError(error, 'not-completed');
        if (record?.agent && message) {
          if (!cancelError && attempt && !attempt.ended) cancel(publicError.code);
          cancelOwn();
          if (attempt?.turn !== null && attempt?.turn !== undefined && !attempt.ended) await attempt.terminal.promise;
          try { await flush(record.agent.session, services().sessions); } catch { /* caller receives only a fixed error */ }
        }
        throw cancelError ?? publicError;
      } finally {
        try {

        } finally {
          unobserve?.();
          if (record && record.attempt === attempt) record.attempt = null;
          const pendingRecord = record ?? owned.get(sessionId) ?? existing;
          if (pendingRecord?.pending === work) pendingRecord.pending = null;
          signal?.removeEventListener('abort', abort);
          clearTimeout(timer);
        }
      }
    })());
    // Reserve before ensure yields, so two inputs cannot both pass the pending check.
    if (existing) existing.pending = work;
    else {
      const preparing = owned.get(sessionId);
      if (preparing) preparing.pending = work;
    }
    work.catch(() => {}); // the caller may already have received a bounded abort
    return historyPermit === undefined && !continuation ? Promise.race([work, cancelled.promise.then(error => { throw error; })]) : work;
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    for (const controller of factoryControllers) controller.abort();
    for (const record of owned.values()) {
      record.release?.(); // revoke private query capability immediately
      record.attempt?.cancel('disposed');
    }
    disposePromise = (async () => {
      const failures = [];
      await Promise.all([...owned.values()].map(async record => {
        try {
          if (!record.handle && record.prepare) await record.prepare.catch(() => {});
          if (record.handle) await record.handle.dispose(); // REAL teardown capability, once, not per message
        } catch { failures.push(true); }
        record.release?.();
      }));
      await Promise.allSettled([...operations]);
      for (const record of owned.values()) record.unsubscribe?.();
      owned.clear();
      if (failures.length) fail('persistence-failed');
    })();
    return disposePromise;
  }
  return Object.freeze({ createConversation, isPrepared, ensure, reply,
    continueReply: (sessionId, text, metadata, signal) => reply(sessionId, text, metadata, signal, undefined, true),
    hasDataHistory, dispose });
}
