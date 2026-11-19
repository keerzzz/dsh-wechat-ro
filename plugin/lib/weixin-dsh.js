// Server-only DSH adapter. Import/construction never creates a session or reads a grant.
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { createWeixinApi, WEIXIN_LIMITS } from './weixin-api.js';
import { createWeixinChannel, validateWeixinState } from './weixin-channel.js';

export const WEIXIN_DSH_INFO = Object.freeze({
  credentialScope: 'wechat-ro-weixin', credentialId: 'account',
  messageSource: 'wechat-ro-weixin', sandboxMode: 'read-only',
  defaultReplyTimeoutMs: 120000, maxReplyTimeoutMs: 300000,
});
const KEY = credentialKey(WEIXIN_DSH_INFO.credentialScope, WEIXIN_DSH_INFO.credentialId);
const ERRORS = Object.freeze({
  'invalid-options': 'Invalid DSH bridge options.',
  'not-configured': 'The DSH bridge is not configured.',
  'invalid-input': 'Invalid DSH bridge input.',
  disposed: 'The DSH bridge is disposed.', busy: 'The DSH bridge is busy.',
  aborted: 'The DSH bridge wait was cancelled.', timeout: 'The DSH bridge timed out.',
  'invalid-state': 'The stored Weixin state is invalid.',
  'state-conflict': 'The stored Weixin state changed.',
  'storage-failed': 'The credential store operation failed.',
  'invalid-workspace': 'The configured workspace is unavailable or changed.',
  'dsh-failed': 'The DSH operation failed.',
  'turn-unattributed': 'The DSH response could not be attributed to this message.',
  'turn-incomplete': 'The DSH turn did not complete successfully.',
  'invalid-reply': 'The DSH reply is not supported by this text channel.',
  'cleanup-failed': 'The owned DSH session could not be closed.',
});
export class WeixinDshError extends Error {
  constructor(code) {
    const safe = typeof code === 'string' && Object.hasOwn(ERRORS, code) ? code : 'invalid-input';
    super(ERRORS[safe]);
    this.name = 'WeixinDshError';
    this.code = safe;
    Object.freeze(this);
  }
}
const fail = code => { throw new WeixinDshError(code); };
function optionsRecord(value, keys) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid-options');
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !field || !('value' in field)) fail('invalid-options');
  }
  return value;
}
function signalInput(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('invalid-input');
}
function inputText(value) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()
      || Buffer.byteLength(value, 'utf8') > WEIXIN_LIMITS.maxTextBytes) fail('invalid-input');
}
function replyTimeout(value) {
  if (value === undefined) return WEIXIN_DSH_INFO.defaultReplyTimeoutMs;
  if (!Number.isSafeInteger(value) || value < 1 || value > WEIXIN_DSH_INFO.maxReplyTimeoutMs) fail('invalid-options');
  return value;
}
function workspaceOption(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f]/u.test(value)
      || !value.isWellFormed() || Buffer.byteLength(value) > 4096) fail('invalid-options');
  return value;
}
function storedState(record) {
  if (record === undefined) return undefined;
  if (!record || record.kind !== 'grant' || !Object.hasOwn(record, 'payload')) fail('invalid-state');
  try { return validateWeixinState(record.payload); }
  catch { fail('invalid-state'); }
}
function safeState(value) {
  try { return validateWeixinState(value); }
  catch { fail('invalid-state'); }
}

/** Own fixed grant only. Monotone tombstones avoid delete/recreate revision ABA. */
export function createWeixinCredentialStore(credentials) {
  return createOwnedCredentialStore(credentials, KEY);
}

/** Fixed address + v2 record binding; native Session authorization is Root-owned. */
export function createWeixinSessionCredentialStore(credentials, sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/u.test(sessionId)) {
    fail('invalid-input');
  }
  const id = `session-${createHash('sha256').update(sessionId, 'utf8').digest('hex')}`;
  return createOwnedCredentialStore(credentials, credentialKey(WEIXIN_DSH_INFO.credentialScope, id), sessionId);
}

export function createWeixinTaskCredentialStore(credentials, sessionId) {
  if (typeof sessionId !== 'string' || !/^wechat-task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sessionId)) fail('invalid-input');
  const id = `task-v3-${createHash('sha256').update(sessionId, 'utf8').digest('hex')}`;
  return createOwnedCredentialStore(credentials, credentialKey(WEIXIN_DSH_INFO.credentialScope, id), sessionId, 3);
}
function createOwnedCredentialStore(credentials, key, sessionId, version) {
  if (!credentials || typeof credentials.readRecord !== 'function'
      || typeof credentials.modifyRecord !== 'function') fail('not-configured');
  function checkBinding(state) {
    if (sessionId !== undefined && (state?.version === 2 || state?.version === 3) && state.sessionId !== sessionId) fail('invalid-state');
    if (state && version === 3 && state.version !== 3) fail('invalid-state');
    return state;
  }
  return Object.freeze({
    async read() {
      let record;
      try { record = await credentials.readRecord(key); }
      catch { fail('storage-failed'); }
      return checkBinding(storedState(record));
    },
    async commit(expectedRevision, next) {
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) fail('invalid-input');
      // Credentials.modifyRecord(undefined) means no change, NOT deletion.
      const snapshot = checkBinding(safeState(next));
      if (expectedRevision === Number.MAX_SAFE_INTEGER
          || snapshot.revision !== (expectedRevision === null ? 1 : expectedRevision + 1)) fail('state-conflict');
      try {
        await credentials.modifyRecord(key, async current => {
          const previous = checkBinding(storedState(current));
          if ((previous?.revision ?? null) !== expectedRevision) fail('state-conflict');
          return { kind: 'grant', payload: snapshot };
        });
      } catch (error) {
        if (error instanceof WeixinDshError) throw error;
        fail('storage-failed');
      }
    },
  });
}

function waitForWork(work, signal, cancelled) {
  if (signal.aborted) return Promise.reject(new WeixinDshError(cancelled()));
  return new Promise((resolve, reject) => {
    const clean = () => signal.removeEventListener('abort', abort);
    const abort = () => { clean(); reject(new WeixinDshError(cancelled())); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
    if (signal.aborted) abort();
  });
}

/** One fresh, owned, tool-denied DSH session per inbound message; no history resume. */
export function createDshWeixinReply(ctx, options) {
  const config = optionsRecord(options, ['workspace', 'timeoutMs']);
  const workspace = workspaceOption(config.workspace);
  const timeoutMs = replyTimeout(config.timeoutMs);
  let disposed = false;
  let pending;
  let active;

  async function reply(text, metadata, signal) {
    if (disposed) fail('disposed');
    if (pending) fail('busy');
    signalInput(signal);
    inputText(text);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(metadata))
        || Reflect.ownKeys(metadata).length !== 1) fail('invalid-input');
    const field = Object.getOwnPropertyDescriptor(metadata, 'messageId');
    const messageId = field && 'value' in field ? field.value : undefined;
    if (typeof messageId !== 'string' || !/^[1-9][0-9]{0,15}$/u.test(messageId)
        || !Number.isSafeInteger(Number(messageId))) fail('invalid-input');
    if (!workspace || !ctx?.agents || typeof ctx.agents.create !== 'function'
        || !ctx.fs || typeof ctx.fs.resolve !== 'function' || typeof ctx.fs.stat !== 'function'
        || typeof ctx.fs.processPath !== 'function'
        || !ctx.workingDirectory || typeof ctx.workingDirectory.ensure !== 'function'
        || !ctx.sandboxPolicy || typeof ctx.sandboxPolicy.resolve !== 'function') fail('not-configured');
    if (signal?.aborted) fail('aborted');

    const controller = new AbortController();
    let cancellation = 'aborted';
    const cancel = code => {
      if (controller.signal.aborted) return;
      cancellation = code;
      controller.abort();
    };
    active = cancel;
    const abort = () => cancel('aborted');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => cancel('timeout'), timeoutMs);
    const check = () => { if (controller.signal.aborted) fail(cancellation); };
    // Construct before publication so the listener can bind only this stable ID.
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: WEIXIN_DSH_INFO.messageSource, messageId },
    });
    const sessionId = SessionId(randomUUID());
    const observed = { current: null, matched: null, starts: 0, matches: 0, ends: 0,
      completed: false, invalid: false, text: undefined };
    let preparedSession;
    let handle;
    const work = Promise.resolve().then(async () => {
      try {
        check();
        const target = await ctx.fs.resolve(workspace, { signal: controller.signal });
        check();
        const info = await ctx.fs.stat(target, controller.signal);
        check();
        const cwd = ctx.fs.processPath(target);
        if (info?.type !== 'directory' || typeof cwd !== 'string' || !isAbsolute(cwd)) fail('invalid-workspace');
        handle = await ctx.agents.create({
          sessionId, meta: { cwd }, signal: controller.signal,
          setup: async (agentCtx, agent) => {
            check();
            if (!agentCtx.tools || typeof agentCtx.tools.restrict !== 'function'
                || typeof agentCtx.tools.guard !== 'function' || typeof agentCtx.on !== 'function') fail('not-configured');
            preparedSession = agent.session;
            // Both effects belong to the unpublished agent scope, never the root.
            agentCtx.tools.restrict({ allow: [] });
            agentCtx.tools.guard(() => 'Tool execution is disabled for the Weixin text bridge.');
            setSandboxMode(agent.session, 'read-only');
            // These caller-owned services take the explicit agent/session. Factory
            // scope only owns tools/listeners; it need not inherit caller injections.
            const resolved = await ctx.workingDirectory.ensure(agent, controller.signal);
            check();
            if (resolved !== cwd) fail('invalid-workspace');
            const policy = ctx.sandboxPolicy.resolve({ session: agent.session });
            if (policy.mode !== 'read-only') fail('not-configured');
            agentCtx.on('session/event', (session, event) => {
              if (session !== preparedSession) return;
              try {
                const data = event.data;
                if (event.type === 'turn/start') {
                  observed.starts++;
                  observed.current = Number.isSafeInteger(data.turn) && data.turn >= 0 ? data.turn : null;
                } else if (event.type === 'user/message') {
                  if (data.id === message.id) {
                    observed.matches++;
                    observed.matched = observed.current;
                  } else if (data.source?.kind === 'user' || data.source?.kind === WEIXIN_DSH_INFO.messageSource) {
                    observed.invalid = true;
                  }
                } else if (observed.matched !== null && data.turn === observed.matched) {
                  if (event.type === 'tool/call') observed.invalid = true;
                  if (event.type === 'assistant/message') {
                    if (data.interrupted || data.message?.role !== 'assistant' || !Array.isArray(data.message.content)) {
                      observed.invalid = true;
                      return;
                    }
                    const blocks = data.message.content;
                    if (blocks.some(block => !block || !['text', 'reasoning'].includes(block.type))) observed.invalid = true;
                    // Bound the aggregate before copying; never include reasoning.
                    let size = 0;
                    observed.text = '';
                    for (const block of blocks) {
                      if (block.type !== 'text') continue;
                      if (typeof block.text !== 'string') { observed.invalid = true; break; }
                      size += Buffer.byteLength(block.text);
                      if (size > WEIXIN_LIMITS.maxTextBytes) {
                        observed.text = undefined;
                        observed.invalid = true;
                        break;
                      }
                      observed.text += block.text;
                    }
                  } else if (event.type === 'turn/end') {
                    observed.ends++;
                    observed.completed = data.reason?.kind === 'completed';
                  }
                }
              } catch { observed.invalid = true; }
            });
            return { commit: check };
          },
        });
        check();
        if (!handle || typeof handle.dispose !== 'function' || !handle.agent
            || handle.agent.session !== preparedSession || handle.agent.status !== 'idle'
            || typeof handle.agent.followup !== 'function' || typeof handle.agent.whenIdle !== 'function'
            || typeof handle.agent.cancel !== 'function') fail('dsh-failed');
        handle.agent.followup(message);
        await handle.agent.whenIdle();
        check();
        if (observed.invalid || observed.starts !== 1 || observed.matches !== 1 || observed.matched === null) fail('turn-unattributed');
        if (observed.ends !== 1 || !observed.completed) fail('turn-incomplete');
        if (typeof observed.text !== 'string' || !observed.text.trim() || !observed.text.isWellFormed()) fail('invalid-reply');
        return observed.text;
      } finally {
        // Even a factory resolving after cancellation must surrender its owned handle.
        // Only handle.dispose rejections are observable here: Cordis may internally
        // catch/log individual effect errors without rejecting the native handle.
        if (handle && typeof handle.dispose === 'function') {
          try { await handle.dispose(); }
          catch { fail('cleanup-failed'); }
        }
      }
    }).catch(error => {
      if (error instanceof WeixinDshError) throw error;
      throw new WeixinDshError('dsh-failed');
    });
    pending = work;
    const stopAgent = () => {
      if (handle?.agent && typeof handle.agent.cancel === 'function') {
        try { handle.agent.cancel({ kind: 'hook', reason: 'Weixin bridge operation cancelled.' }); }
        catch { /* The owned disposer remains responsible for teardown. */ }
      }
    };
    controller.signal.addEventListener('abort', stopAgent, { once: true });
    work.finally(() => {
      if (pending === work) pending = undefined;
      if (active === cancel) active = undefined;
      controller.signal.removeEventListener('abort', stopAgent);
    }).catch(() => {});
    try { return await waitForWork(work, controller.signal, () => cancellation); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // A late/ignored cancellation keeps the bridge busy until work + cleanup settle.
    }
  }
  return Object.freeze({
    reply,
    async dispose() {
      disposed = true;
      active?.('disposed');
      if (pending) await pending.catch(() => {});
    },
  });
}

/** Explicit assembly only: no Cordis auto-apply, routes, scheduler or global fetch. */
export function createDshWeixinChannel(ctx, options) {
  const config = optionsRecord(options, ['enabled', 'workspace', 'fetcher', 'apiTimeoutMs', 'replyTimeoutMs', 'maxResponseBytes']);
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') fail('invalid-options');
  workspaceOption(config.workspace);
  replyTimeout(config.replyTimeoutMs);
  const api = createWeixinApi({
    ...(config.fetcher !== undefined ? { fetcher: config.fetcher } : {}),
    ...(config.apiTimeoutMs !== undefined ? { timeoutMs: config.apiTimeoutMs } : {}),
    ...(config.maxResponseBytes !== undefined ? { maxResponseBytes: config.maxResponseBytes } : {}),
  });
  if (config.enabled !== true) {
    const channel = createWeixinChannel();
    return Object.freeze({ channel, async dispose() { channel.dispose(); } });
  }
  if (!config.workspace || typeof config.fetcher !== 'function' || !ctx?.credentials) fail('not-configured');
  const store = createWeixinCredentialStore(ctx.credentials);
  const bridge = createDshWeixinReply(ctx, {
    workspace: config.workspace,
    ...(config.replyTimeoutMs !== undefined ? { timeoutMs: config.replyTimeoutMs } : {}),
  });
  const channel = createWeixinChannel({ enabled: true, api, store, reply: bridge.reply });
  return Object.freeze({ channel, async dispose() { channel.dispose(); await bridge.dispose(); } });
}
