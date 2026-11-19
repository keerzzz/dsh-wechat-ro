// Server-only pairing administration. The host authenticates and owner-gates every
// exact route before calling fetch; this is NOT a stand-alone HTTP/auth service.
// Import/apply start no I/O, login, polling, reply, agent session, or background job.
import fs from 'node:fs/promises';
import { z } from 'zod';
import { createWeixinApi, WEIXIN_LIMITS } from './weixin-api.js';
import { createWeixinChannel, WeixinChannelError } from './weixin-channel.js';
import { createWeixinCredentialStore } from './weixin-dsh.js';

export const name = 'wechat-ro-weixin-admin';
export const inject = Object.freeze(['connection', 'credentials']);
export const WEIXIN_ADMIN_INFO = Object.freeze({
  basePath: '/api/wechat-ro-weixin', maxRequestBytes: 4096,
  defaultRequestTimeoutMs: WEIXIN_LIMITS.defaultTimeoutMs, maxRequestTimeoutMs: 120000,
});
const BASE = WEIXIN_ADMIN_INFO.basePath;
const DEFAULTS = Object.freeze({ enabled: false, apiTimeoutMs: WEIXIN_LIMITS.defaultTimeoutMs,
  maxResponseBytes: WEIXIN_LIMITS.maxResponseBytes, requestTimeoutMs: WEIXIN_ADMIN_INFO.defaultRequestTimeoutMs });
/** Zod implements the Standard Schema interface consumed by Cordis. No new runtime dependency. */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  apiTimeoutMs: z.number().int().min(1).max(120000).default(DEFAULTS.apiTimeoutMs),
  maxResponseBytes: z.number().int().min(1).max(WEIXIN_LIMITS.maxResponseBytes).default(DEFAULTS.maxResponseBytes),
  requestTimeoutMs: z.number().int().min(1).max(120000).default(DEFAULTS.requestTimeoutMs),
}).strict().default(DEFAULTS);

export const WEIXIN_ADMIN_ROUTES = Object.freeze([
  { path: BASE + '/admin', methods: Object.freeze(['GET', 'HEAD']), requestBody: 'buffered' },
  { path: BASE + '/admin.js', methods: Object.freeze(['GET', 'HEAD']), requestBody: 'buffered' },
  { path: BASE + '/admin.css', methods: Object.freeze(['GET', 'HEAD']), requestBody: 'buffered' },
  { path: BASE + '/status', methods: Object.freeze(['GET']), requestBody: 'buffered' },
  { path: BASE + '/action', methods: Object.freeze(['POST']), requestBody: 'streaming' },
].map(Object.freeze));
const ASSETS = new Map([
  [BASE + '/admin', { file: new URL('./weixin-admin-ui/admin.html', import.meta.url), type: 'text/html; charset=utf-8' }],
  [BASE + '/admin.js', { file: new URL('./weixin-admin-ui/admin.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  [BASE + '/admin.css', { file: new URL('./weixin-admin-ui/admin.css', import.meta.url), type: 'text/css; charset=utf-8' }],
]);
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data: blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
});
const ERROR_STATUS = Object.freeze({
  'invalid-options': 400, 'invalid-request': 400, 'invalid-json': 400, 'invalid-input': 400,
  'unsupported-media-type': 415, 'body-too-large': 413, 'not-found': 404, 'method-not-allowed': 405,
  disabled: 403, disposed: 410, aborted: 408, timeout: 408, busy: 409,
  'not-configured': 503, 'asset-unavailable': 503, 'registration-failed': 503,
  'invalid-state': 409, 'invalid-response': 502, 'store-failed': 503, 'store-outcome-unknown': 503,
  'api-failed': 502, 'already-paired': 409, 'login-active': 409, 'login-required': 409,
  'login-not-confirmed': 409, 'not-paired': 409, 'recovery-required': 409,
  'revision-exhausted': 409, 'operation-failed': 500,
});
export const WEIXIN_ADMIN_ERROR_CODES = Object.freeze(Object.keys(ERROR_STATUS));
const KNOWN_NO_EFFECT = new Set(['invalid-input', 'disabled', 'busy', 'not-configured', 'invalid-state',
  'store-failed', 'already-paired', 'login-active', 'login-required', 'login-not-confirmed',
  'not-paired', 'recovery-required', 'revision-exhausted']);
const EFFECT_ACTIONS = new Set(['beginLogin', 'pollLogin', 'confirmPairing', 'forget']);
const PHASES = new Set(['disabled', 'unpaired', 'qr-ready', 'awaiting-confirmation', 'paired', 'recovery-required']);
const QR_STATUSES = new Set(['wait', 'scaned', 'confirmed', 'expired', 'need_verifycode',
  'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect']);
const CHANNEL_METHODS = ['getStatus', 'beginLogin', 'pollLogin', 'confirmPairing', 'cancelLogin', 'forget', 'dispose'];
const DISABLED_STATUS = Object.freeze({ enabled: false, phase: 'disabled', hasStoredLogin: false,
  pendingRecovery: false, messagingVerified: false, messagingEnabled: false, automaticPolling: false });
class AdminFailure extends Error {
  constructor(code) { super('Weixin administration failed.'); this.code = code; }
}
function fail(code) { throw new AdminFailure(code); }
function ownRecord(value, allowed, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(code);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!allowed.includes(key) || !field?.enumerable || !Object.hasOwn(field, 'value')) fail(code);
    out[key] = field.value;
  }
  return out;
}
function normalizedConfig(config) {
  try {
    const result = Config.safeParse(ownRecord(config === undefined ? {} : config, Object.keys(DEFAULTS), 'invalid-options'));
    if (!result.success) fail('invalid-options');
    return result.data;
  } catch { fail('invalid-options'); }
}
function data(value, key) { return value == null ? undefined : Object.getOwnPropertyDescriptor(value, key)?.value; }
function boundedString(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.isWellFormed()
    && Buffer.byteLength(value, 'utf8') <= limit;
}
function projectStatus(value) {
  const enabled = data(value, 'enabled'), phase = data(value, 'phase');
  const hasStoredLogin = data(value, 'hasStoredLogin'), pendingRecovery = data(value, 'pendingRecovery');
  if (enabled !== true || !PHASES.has(phase) || phase === 'disabled' || typeof hasStoredLogin !== 'boolean'
      || typeof pendingRecovery !== 'boolean' || data(value, 'messagingVerified') !== false) fail('invalid-response');
  return { enabled, phase, hasStoredLogin, pendingRecovery,
    messagingVerified: false, messagingEnabled: false, automaticPolling: false };
}
function projectAction(action, value) {
  if (action === 'beginLogin') {
    const qrContent = data(value, 'qrContent');
    if (!boundedString(qrContent, WEIXIN_LIMITS.maxQrCodeBytes)) fail('invalid-response');
    return { qrContent }; // Opaque data only: never fetch, parse as a URL, or insert into HTML.
  }
  if (action === 'pollLogin') {
    const status = data(value, 'status');
    if (!QR_STATUSES.has(status)) fail('invalid-response');
    return { status };
  }
  if (action === 'confirmPairing') {
    if (data(value, 'paired') !== true) fail('invalid-response');
    return { paired: true };
  }
  if (value !== undefined) fail('invalid-response');
  return null;
}
function response(request, value, status = 200, type = 'application/json; charset=utf-8', extra = {}) {
  return new Response(request.method === 'HEAD' ? null : value, {
    status, headers: { ...SECURITY_HEADERS, 'content-type': type, ...extra },
  });
}
function json(request, value, status = 200, extra) { return response(request, JSON.stringify(value), status, undefined, extra); }
function safeCode(error) {
  try {
    if (error instanceof AdminFailure || error instanceof WeixinChannelError) {
      const code = data(error, 'code');
      if (typeof code === 'string' && Object.hasOwn(ERROR_STATUS, code)) return code;
    }
  } catch { /* Even malformed same-process dependency errors are never serialized. */ }
  return 'operation-failed';
}
function cancelBody(request) {
  try { const pending = request.body?.cancel(); pending?.catch(() => {}); } catch { /* No raw stream error escapes. */ }
}
function parseAction(source) {
  let value;
  try { value = JSON.parse(source); } catch { fail('invalid-json'); }
  const payload = ownRecord(value, ['action', 'confirmation', 'verifyCode'], 'invalid-request');
  const keys = Object.keys(payload);
  const action = payload.action;
  if (typeof action !== 'string') fail('invalid-request');
  const confirmations = { beginLogin: 'request-qr', confirmPairing: 'persist-pairing', forget: 'forget-local-credentials' };
  if (Object.hasOwn(confirmations, action)) {
    if (keys.length !== 2 || payload.confirmation !== confirmations[action]) fail('invalid-request');
  } else if (action === 'pollLogin') {
    if (keys.some(key => key !== 'action' && key !== 'verifyCode')) fail('invalid-request');
    if (Object.hasOwn(payload, 'verifyCode') && (!boundedString(payload.verifyCode, WEIXIN_LIMITS.maxVerifyCodeBytes)
        || /[\u0000-\u0020\u007f]/u.test(payload.verifyCode))) fail('invalid-request');
  } else if (action !== 'cancelLogin' || keys.length !== 1) fail('invalid-request');
  // Every accepted member has a string key and string value. Additional string
  // tokens reveal overwritten duplicate members (including non-string values).
  // JSON.parse has already checked JSON syntax; no second general JSON parser.
  const strings = source.match(/"(?:[^"\\]|\\[\s\S])*"/gu) ?? [];
  if (strings.length !== keys.length * 2) fail('invalid-request');
  return payload;
}
async function readAction(request, operation) {
  if (request.headers.get('x-wechat-management') !== '1') fail('invalid-request');
  const type = request.headers.get('content-type') ?? '';
  if (!/^\s*application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu.test(type)
      || (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity')) fail('unsupported-media-type');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > WEIXIN_ADMIN_INFO.maxRequestBytes)) fail('body-too-large');
  if (request.body === null) fail('invalid-json');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let source = '', bytes = 0;
  try {
    while (true) {
      const chunk = await operation.wait(() => reader.read());
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) fail('invalid-request');
      bytes += chunk.value.byteLength;
      if (bytes > WEIXIN_ADMIN_INFO.maxRequestBytes) fail('body-too-large');
      try { source += decoder.decode(chunk.value, { stream: true }); } catch { fail('invalid-json'); }
    }
    try { source += decoder.decode(); } catch { fail('invalid-json'); }
    operation.check();
    return parseAction(source);
  } finally {
    // Cancellation can itself stall/reject; it must not extend the request deadline.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Redacted. */ }
    try { reader.releaseLock(); } catch { /* A cancelled read may still be settling. */ }
  }
}
function requestOperation(request, lifecycle, timeoutMs) {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let code, timer;
  const stop = reason => { if (code === undefined) { code = reason; controller.abort(); } };
  const onAbort = () => stop('aborted'), onDispose = () => stop('disposed');
  const check = () => {
    if (code === undefined && performance.now() >= deadline) stop('timeout');
    if (code !== undefined) fail(code);
  };
  request.signal.addEventListener('abort', onAbort, { once: true });
  lifecycle.addEventListener('abort', onDispose, { once: true });
  if (request.signal.aborted) onAbort();
  if (lifecycle.aborted) onDispose();
  timer = setTimeout(() => stop('timeout'), timeoutMs);
  return {
    signal: controller.signal, check, entered: false, action: undefined,
    get stopCode() { return code; },
    async wait(start) {
      check();
      let listener;
      try {
        const work = Promise.resolve().then(() => { check(); return start(); });
        const stopped = new Promise((_, reject) => {
          listener = () => reject(new AdminFailure(code ?? 'aborted'));
          controller.signal.addEventListener('abort', listener, { once: true });
          if (controller.signal.aborted) listener();
        });
        const value = await Promise.race([work, stopped]);
        check();
        return value;
      } finally {
        if (listener) controller.signal.removeEventListener('abort', listener);
      }
    },
    finish() {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      lifecycle.removeEventListener('abort', onDispose);
      cancelBody(request);
    },
  };
}

/**
 * Trusted same-process composition seam, NOT configuration and NOT authentication.
 * Supply only an owned management-channel view. No message method is read/exposed.
 * A dependency ignoring abort may still finish; responses cannot revoke issued I/O.
 */
export function createWeixinAdminHandler(options) {
  let enabled, timeoutMs, channel;
  try {
    const opts = ownRecord(options === undefined ? {} : options, ['enabled', 'requestTimeoutMs', 'channel'], 'invalid-options');
    enabled = opts.enabled === undefined ? false : opts.enabled;
    timeoutMs = opts.requestTimeoutMs === undefined ? DEFAULTS.requestTimeoutMs : opts.requestTimeoutMs;
    if (typeof enabled !== 'boolean' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail('invalid-options');
    if (enabled) {
      if (!opts.channel) fail('not-configured');
      channel = {};
      for (const method of CHANNEL_METHODS) {
        if (typeof opts.channel[method] !== 'function') fail('not-configured');
        channel[method] = opts.channel[method].bind(opts.channel);
      }
    }
  } catch (error) { throw new AdminFailure(error instanceof AdminFailure ? error.code : 'invalid-options'); }
  const lifecycle = new AbortController();
  const requests = new Set();
  let disposed = false, busy = false, disposal;
  async function invoke(operation, payload) {
    return operation.wait(async () => {
      if (busy) fail('busy');
      busy = true;
      try {
        operation.check();
        operation.entered = true;
        const action = payload.action;
        let value;
        if (action === 'pollLogin') value = await channel.pollLogin(payload.verifyCode, operation.signal);
        else if (action === 'forget') value = await channel.forget(payload.confirmation, operation.signal);
        else value = await channel[action](operation.signal);
        operation.check();
        const projected = action === 'getStatus' ? projectStatus(value) : projectAction(action, value);
        // Core deliberately leaves terminal QR state intact. Expiration cleanup is
        // local-only, not a new login, retry, upstream cancellation, or token revoke.
        if (action === 'pollLogin' && projected.status === 'expired') {
          await channel.cancelLogin(operation.signal);
          operation.check();
        }
        return projected;
      } finally { busy = false; }
    });
  }
  async function handle(request) {
    const operation = requestOperation(request, lifecycle.signal, timeoutMs);
    let allow;
    try {
      if (disposed) fail('disposed');
      operation.check();
      const url = new URL(request.url);
      if (request.url.includes('?') || request.url.includes('#') || url.username || url.password) fail('invalid-request');
      const route = WEIXIN_ADMIN_ROUTES.find(candidate => candidate.path === url.pathname);
      if (!route) fail('not-found');
      if (!route.methods.includes(request.method)) { allow = route.methods.join(', '); fail('method-not-allowed'); }
      const asset = ASSETS.get(url.pathname);
      if (asset) {
        let contents;
        try { contents = await operation.wait(() => fs.readFile(asset.file, { signal: operation.signal })); }
        catch { operation.check(); fail('asset-unavailable'); }
        return response(request, contents, 200, asset.type);
      }
      if (!enabled) {
        if (url.pathname === BASE + '/status') return json(request, { ok: true, value: DISABLED_STATUS });
        fail('disabled');
      }
      const payload = url.pathname === BASE + '/status' ? { action: 'getStatus' } : await readAction(request, operation);
      operation.action = payload.action;
      const value = await invoke(operation, payload);
      operation.check();
      return json(request, { ok: true, value });
    } catch (error) {
      const code = operation.stopCode ?? safeCode(error);
      const outcomeUnknown = code === 'store-outcome-unknown' || (operation.entered
        && EFFECT_ACTIONS.has(operation.action) && !KNOWN_NO_EFFECT.has(code));
      return json(request, { ok: false, error: { code, outcomeUnknown } }, ERROR_STATUS[code], allow ? { allow } : undefined);
    } finally { operation.finish(); }
  }
  return Object.freeze({
    fetch(request) {
      const work = handle(request);
      requests.add(work);
      work.then(() => requests.delete(work), () => requests.delete(work));
      return work;
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      lifecycle.abort();
      disposal = (async () => {
        try { if (channel) await channel.dispose(); }
        catch { fail('operation-failed'); }
        finally { await Promise.allSettled([...requests]); }
      })();
      return disposal;
    },
  });
}

/** Optional pairing-only Cordis plugin. The host registry owns route effects. */
export async function apply(ctx, config) {
  const settings = normalizedConfig(config);
  let handler;
  try {
    const channel = settings.enabled ? createWeixinChannel({
      enabled: true,
      api: createWeixinApi({ fetcher: (input, init) => globalThis.fetch(input, init),
        timeoutMs: settings.apiTimeoutMs, maxResponseBytes: settings.maxResponseBytes }),
      store: createWeixinCredentialStore(ctx.credentials),
      reply: async () => { throw new WeixinChannelError('reply-failed'); },
    }) : undefined;
    handler = createWeixinAdminHandler({ enabled: settings.enabled, requestTimeoutMs: settings.requestTimeoutMs, channel });
  } catch { fail('not-configured'); }
  const disposers = [];
  try {
    // Only the runtime needs its own effect. fetch.register already uses owner.effect.
    disposers.push(ctx.effect(() => () => handler.dispose(), name + ': runtime'));
    for (const route of WEIXIN_ADMIN_ROUTES) {
      disposers.push(ctx.connection.fetch.register({ ...route, fetch: request => {
        // The host bridge owns IncomingMessage teardown after writing the response.
        // Cancel our borrowed stream, not its Readable.toWeb adapter: Node can still
        // have a queued data event when cancellation closes the adapter controller.
        if (route.requestBody === 'streaming' && request.body && !request.body.locked) {
          request = new Request(request, {
            body: request.body.pipeThrough(new TransformStream(), { preventCancel: true }), duplex: 'half',
          });
        }
        return handler.fetch(request);
      } }));
    }
  } catch {
    await handler.dispose().catch(() => {});
    await Promise.allSettled(disposers.reverse().map(dispose => Promise.resolve().then(() => dispose())));
    fail('registration-failed');
  }
}
export default Object.freeze({ name, inject, Config, apply });
