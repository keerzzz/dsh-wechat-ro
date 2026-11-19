// Author tests only: synthetic Requests, in-memory credentials and injected transports.
// No physical HTTP carrier, browser authentication, real Weixin, database, or DSH agent is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import plugin, { apply, Config, createWeixinAdminHandler, inject, name,
  WEIXIN_ADMIN_ERROR_CODES, WEIXIN_ADMIN_INFO, WEIXIN_ADMIN_ROUTES } from '../lib/weixin-admin.js';
import { WeixinChannelError } from '../lib/weixin-channel.js';

const BASE = '/api/wechat-ro-weixin';
const ORIGIN = 'https://synthetic.invalid';
const PRIVATE = 'SYNTHETIC_PRIVATE_MUST_NOT_ESCAPE';
const QR = 'opaque:' + PRIVATE + '<script>not executable</script>';
const encoder = new TextEncoder();
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const status = (more = {}) => ({ enabled: true, phase: 'unpaired', hasStoredLogin: false,
  pendingRecovery: false, messagingVerified: false, ...more });
const begin = { action: 'beginLogin', confirmation: 'request-qr' };
const confirm = { action: 'confirmPairing', confirmation: 'persist-pairing' };
const forget = { action: 'forget', confirmation: 'forget-local-credentials' };
function raw(body, headers = {}, signal) {
  return new Request(ORIGIN + BASE + '/action', { method: 'POST', body, duplex: 'half', signal,
    headers: { 'content-type': 'application/json', 'x-wechat-management': '1', ...headers } });
}
const action = (payload, headers, signal) => raw(JSON.stringify(payload), headers, signal);
const get = (path = '/status', more) => new Request(ORIGIN + BASE + path, more);
function security(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/u);
  assert.match(csp, /script-src 'self'/u);
  assert.match(csp, /frame-ancestors 'none'/u);
  assert.match(csp, /img-src data: blob:/u);
  assert.doesNotMatch(csp, /unsafe-|https?:|\*/u);
  assert.equal(response.headers.has('access-control-allow-origin'), false);
}
async function ok(response) {
  security(response); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  const value = await response.json(); assert.equal(value.ok, true); return value.value;
}
async function error(response, code, outcomeUnknown = false, httpStatus) {
  security(response);
  if (httpStatus !== undefined) assert.equal(response.status, httpStatus);
  assert.ok(response.status >= 400);
  const text = await response.text(); assert.equal(text.includes(PRIVATE), false);
  const body = JSON.parse(text);
  assert.deepEqual(body, { ok: false, error: { code, outcomeUnknown } });
  assert.ok(WEIXIN_ADMIN_ERROR_CODES.includes(body.error.code));
}
function channelFixture(overrides = {}) {
  const calls = [], forbidden = [];
  const defaults = { getStatus: async () => status(), beginLogin: async () => ({ qrContent: QR }),
    pollLogin: async () => ({ status: 'wait' }), confirmPairing: async () => ({ paired: true }),
    cancelLogin: async () => {}, forget: async () => {}, dispose() {} };
  const channel = {};
  for (const [method, implementation] of Object.entries(defaults)) channel[method] = (...args) => {
    calls.push({ method, args }); return (Object.hasOwn(overrides, method) ? overrides[method] : implementation)(...args);
  };
  for (const method of ['pollOnce', 'send', 'discardPending', 'reply']) Object.defineProperty(channel, method, {
    get() { forbidden.push(method); throw new Error(PRIVATE); },
  });
  return { channel, calls, forbidden };
}
function fixture(t, overrides = {}, options = {}) {
  const f = channelFixture(overrides);
  const handler = createWeixinAdminHandler({ enabled: true, channel: f.channel, ...options });
  t.after(() => handler.dispose());
  return { ...f, handler };
}
function memoryCredentials(initial) {
  let record = initial;
  const calls = [];
  return { calls, peek: () => structuredClone(record), service: {
    async readRecord(key) { calls.push(['read', key]); return structuredClone(record); },
    async modifyRecord(key, change) { calls.push(['modify', key]); const next = await change(structuredClone(record));
      if (next !== undefined) record = structuredClone(next); return structuredClone(record); },
    deleteRecord() { throw new Error('No credential deletion allowed'); },
  } };
}
function hostFixture(options = {}) {
  const routes = new Map(), effects = new Set(), registrations = [];
  const memory = memoryCredentials(options.initial);
  let attempt = 0, credentialsAccess = 0;
  const ctx = {
    effect(setup, label) {
      const close = setup(); let closed = false;
      const dispose = async () => { if (closed) return; closed = true; effects.delete(dispose); await close(); };
      effects.add(dispose); return dispose;
    },
    connection: { fetch: { register(route) {
      if (++attempt === options.failAt) throw new Error(PRIVATE);
      registrations.push(route);
      return ctx.effect(() => {
        if (routes.has(route.path)) throw new Error(PRIVATE);
        routes.set(route.path, route); return () => { routes.delete(route.path); };
      }, 'synthetic route owner');
    } } },
    get credentials() { credentialsAccess++; return options.noCredentials ? undefined : memory.service; },
  };
  for (const key of ['agents', 'fs', 'workingDirectory', 'sandboxPolicy', 'tools']) Object.defineProperty(ctx, key, {
    get() { throw new Error('Forbidden host service: ' + key); },
  });
  return { ctx, routes, effects, registrations, memory, credentialsAccess: () => credentialsAccess,
    async dispose() { for (const close of [...effects].reverse()) await close(); } };
}

test('exports and schema are default-disabled and contain no transport/test configuration hooks', () => {
  assert.equal(name, 'wechat-ro-weixin-admin');
  assert.deepEqual(inject, ['connection', 'credentials']);
  assert.equal(plugin.apply, apply); assert.equal(plugin.Config, Config);
  assert.deepEqual(Object.keys(plugin).sort(), ['Config', 'apply', 'inject', 'name']);
  assert.ok(Config['~standard']);
  assert.deepEqual(Config.parse(undefined), { enabled: false, apiTimeoutMs: 40000, maxResponseBytes: 1048576, requestTimeoutMs: 40000 });
  assert.equal(WEIXIN_ADMIN_INFO.maxRequestBytes, 4096);
  for (const key of ['channel', 'fetcher', 'workspace', 'reply', 'credentials', 'agents']) assert.equal(Config.safeParse({ [key]: {} }).success, false);
  for (const key of ['apiTimeoutMs', 'requestTimeoutMs', 'maxResponseBytes']) {
    const max = key === 'maxResponseBytes' ? 1048576 : 120000;
    for (const value of [0, -1, max + 1, 0.5, NaN, Infinity, '1', null]) assert.equal(Config.safeParse({ [key]: value }).success, false);
    for (const value of [1, max]) assert.equal(Config.safeParse({ [key]: value }).success, true);
  }
});
test('disabled handler ignores channel getters and performs zero dependency I/O', async () => {
  const channel = new Proxy({}, { get() { throw new Error(PRIVATE); } });
  const handler = createWeixinAdminHandler({ channel });
  assert.deepEqual(Object.keys(handler), ['fetch', 'dispose']); assert.ok(Object.isFrozen(handler));
  assert.deepEqual(await ok(await handler.fetch(get())), { enabled: false, phase: 'disabled', hasStoredLogin: false,
    pendingRecovery: false, messagingVerified: false, messagingEnabled: false, automaticPolling: false });
  await error(await handler.fetch(action(begin)), 'disabled', false, 403);
  await handler.dispose(); await handler.dispose();
  await error(await handler.fetch(get()), 'disposed', false, 410);
});
test('factory rejects malformed options without executing accessors', () => {
  let read = 0;
  const accessor = Object.defineProperty({}, 'enabled', { enumerable: true, get() { read++; return true; } });
  const bad = [null, [], 1, 'x', new Date(), { unknown: true }, { enabled: 1 }, { requestTimeoutMs: 0 },
    { requestTimeoutMs: 120001 }, { requestTimeoutMs: Infinity }, { requestTimeoutMs: 1.5 }, accessor,
    { [Symbol('private')]: true }, { enabled: true }, { enabled: true, channel: {} }];
  for (const input of bad) assert.throws(() => createWeixinAdminHandler(input), exception => {
    assert.match(exception.message, /Weixin administration failed/u); assert.equal(exception.message.includes(PRIVATE), false); return true;
  });
  assert.equal(read, 0);
  const hostile = { enabled: true, channel: new Proxy({}, { get() { throw new Error(PRIVATE); } }) };
  assert.throws(() => createWeixinAdminHandler(hostile), /Weixin administration failed/u);
});
test('default apply uses six owner effects and never reads credentials/static resources or global fetch', async t => {
  const host = hostFixture(); t.after(() => host.dispose());
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Unexpected transport'); });
  t.mock.method(fs, 'readFile', () => { assert.fail('Unexpected static I/O'); });
  await apply(host.ctx);
  assert.equal(host.credentialsAccess(), 0); assert.deepEqual(host.memory.calls, []);
  assert.equal(host.effects.size, 6); assert.equal(host.routes.size, 5);
  assert.deepEqual(host.registrations.map(({ path, methods, requestBody }) => ({ path, methods, requestBody })), WEIXIN_ADMIN_ROUTES);
  assert.equal(host.routes.get(BASE + '/action').requestBody, 'streaming');
  await host.dispose(); assert.equal(host.effects.size, 0); assert.equal(host.routes.size, 0);
});
test('apply validates options before services, and missing credentials cannot install enabled routes', async () => {
  for (const config of [null, [], { enabled: 'true' }, { requestTimeoutMs: 0 }, { apiTimeoutMs: 120001 }, { maxResponseBytes: 1048577 },
    { channel: {} }, Object.defineProperty({}, 'enabled', { enumerable: true, get() { throw new Error(PRIVATE); } })]) {
    const host = hostFixture(); await assert.rejects(apply(host.ctx, config), exception => exception.code === 'invalid-options');
    assert.equal(host.routes.size, 0); assert.equal(host.credentialsAccess(), 0);
  }
  const host = hostFixture({ noCredentials: true });
  await assert.rejects(apply(host.ctx, { enabled: true }), exception => exception.code === 'not-configured');
  assert.equal(host.effects.size, 0);
});
for (const failAt of [1, 3, 5]) test('registration failure ' + failAt + ' reclaims only its own effects and permits reload', async () => {
  const host = hostFixture({ failAt });
  await assert.rejects(apply(host.ctx), exception => exception.code === 'registration-failed' && !exception.message.includes(PRIVATE));
  assert.equal(host.routes.size, 0); assert.equal(host.effects.size, 0);
  await apply(host.ctx); assert.equal(host.routes.size, 5); await host.dispose(); assert.equal(host.effects.size, 0);
});
test('a duplicate load cannot remove the first load, while unload/reload remains supported', async () => {
  const host = hostFixture(); await apply(host.ctx);
  const first = host.routes.get(BASE + '/status');
  await assert.rejects(apply(host.ctx), exception => exception.code === 'registration-failed');
  assert.equal(host.routes.size, 5); assert.equal(host.effects.size, 6); assert.equal(host.routes.get(BASE + '/status'), first);
  await host.dispose(); await apply(host.ctx); assert.equal(host.routes.size, 5); await host.dispose();
});
test('runtime effect acquisition failure leaves the created handler disposed', async () => {
  const host = hostFixture(); host.ctx.effect = () => { throw new Error(PRIVATE); };
  await assert.rejects(apply(host.ctx), exception => exception.code === 'registration-failed');
  assert.equal(host.routes.size, 0);
});
test('static GET/HEAD reads only three fixed local assets; JavaScript is returned, never executed', async t => {
  const handler = createWeixinAdminHandler(); t.after(() => handler.dispose());
  const files = [];
  t.mock.method(fs, 'readFile', async (file, options) => {
    files.push(file.href); assert.ok(options.signal instanceof AbortSignal);
    return Buffer.from('globalThis.__syntheticUiExecuted = true;');
  });
  delete globalThis.__syntheticUiExecuted;
  for (const path of ['/admin', '/admin.js', '/admin.css']) for (const method of ['GET', 'HEAD']) {
    const response = await handler.fetch(get(path, { method })); security(response); assert.equal(response.status, 200);
    assert.equal(await response.text(), method === 'HEAD' ? '' : 'globalThis.__syntheticUiExecuted = true;');
  }
  assert.equal(globalThis.__syntheticUiExecuted, undefined);
  assert.equal(files.length, 6); assert.equal(new Set(files).size, 3);
  for (const file of files) assert.match(file, /\/plugin\/lib\/weixin-admin-ui\/admin\.(?:html|js|css)$/u);
});
test('static I/O errors are fixed and HEAD errors have no body', async t => {
  const handler = createWeixinAdminHandler(); t.after(() => handler.dispose());
  t.mock.method(fs, 'readFile', async () => { throw new Error(PRIVATE); });
  await error(await handler.fetch(get('/admin')), 'asset-unavailable', false, 503);
  const response = await handler.fetch(get('/admin.css', { method: 'HEAD' })); security(response);
  assert.equal(response.status, 503); assert.equal(await response.text(), '');
});
test('all routes reject queries, fragments, inexact paths, and unsupported methods without dispatch', async t => {
  const f = fixture(t);
  for (const suffix of ['/status?q=' + PRIVATE, '/action?', '/admin.js#' + PRIVATE]) await error(await f.handler.fetch(get(suffix)), 'invalid-request', false, 400);
  for (const suffix of ['/status/', '/pollOnce', '/send', '/discardPending', '/%61ction', '/admin/other']) await error(await f.handler.fetch(get(suffix)), 'not-found', false, 404);
  for (const [path, method, allow] of [['/status', 'POST', 'GET'], ['/action', 'GET', 'POST'], ['/admin', 'POST', 'GET, HEAD']]) {
    const response = await f.handler.fetch(get(path, { method })); assert.equal(response.headers.get('allow'), allow);
    await error(response, 'method-not-allowed', false, 405);
  }
  const head = await f.handler.fetch(get('/status', { method: 'HEAD' })); security(head); assert.equal(head.status, 405); assert.equal(await head.text(), '');
  assert.deepEqual(f.calls, []);
});
test('successful status and actions project only their allowed data and never access message methods', async t => {
  const f = fixture(t, { getStatus: async () => status({ botToken: PRIVATE, qrContent: QR, toJSON() { throw new Error(PRIVATE); } }),
    pollLogin: async () => ({ status: 'confirmed', credentials: { botToken: PRIVATE } }),
    confirmPairing: async () => ({ paired: true, botToken: PRIVATE }) });
  assert.deepEqual(await ok(await f.handler.fetch(get())), { ...status(), messagingEnabled: false, automaticPolling: false });
  assert.deepEqual(await ok(await f.handler.fetch(action(begin))), { qrContent: QR });
  assert.deepEqual(await ok(await f.handler.fetch(action({ action: 'pollLogin', verifyCode: '合成验证码' }))), { status: 'confirmed' });
  assert.deepEqual(await ok(await f.handler.fetch(action(confirm))), { paired: true });
  assert.equal(await ok(await f.handler.fetch(action({ action: 'cancelLogin' }))), null);
  assert.equal(await ok(await f.handler.fetch(action(forget))), null);
  const polled = f.calls.find(call => call.method === 'pollLogin'); assert.equal(polled.args[0], '合成验证码');
  assert.ok(polled.args[1] instanceof AbortSignal);
  const forgot = f.calls.find(call => call.method === 'forget'); assert.equal(forgot.args[0], 'forget-local-credentials');
  assert.deepEqual(f.forbidden, []);
});
const malformedActions = [null, [], {}, 'cancelLogin', { action: null }, { action: {} }, { action: { toString: null } },
  { action: 'pollOnce' }, { action: 'send' }, { action: 'discardPending' }, { action: '__proto__' },
  { action: 'beginLogin' }, { ...begin, confirmation: 'true' }, { ...begin, extra: true },
  { action: 'confirmPairing' }, { action: 'forget' }, { ...forget, confirmation: 'delete' },
  { action: 'cancelLogin', confirmation: 'cancel' }, { action: 'pollLogin', confirmation: 'persist-pairing' },
  { action: 'pollLogin', verifyCode: '' }, { action: 'pollLogin', verifyCode: null }, { action: 'pollLogin', verifyCode: 1 },
  { action: 'pollLogin', verifyCode: 'x'.repeat(65) }, { action: 'pollLogin', verifyCode: '字'.repeat(22) },
  { action: 'pollLogin', verifyCode: '\ud800' }, { action: 'pollLogin', verifyCode: 'a b' }, { action: 'pollLogin', verifyCode: 'x\u007f' }];
test('strict action union rejects malformed fields, missing confirmations and verify-code budget violations', async t => {
  const f = fixture(t);
  for (const payload of malformedActions) await error(await f.handler.fetch(action(payload)), 'invalid-request', false, 400);
  for (const body of ['{"action":"send","action":"cancelLogin"}', '{"action":null,"action":"cancelLogin"}',
    '{"action":"pollLogin","verifyCode":"x","verifyCode":"y"}', '{"act\\u0069on":"send","action":"cancelLogin"}',
    '{"action":"cancelLogin","__proto__":{}}']) await error(await f.handler.fetch(raw(body)), 'invalid-request');
  assert.deepEqual(f.calls, []);
});
test('verify-code UTF-8 boundary and valid JSON escapes are preserved exactly', async t => {
  const f = fixture(t);
  for (const verifyCode of ['x'.repeat(64), '字'.repeat(21) + 'x', 'quote"slash\\', '\u2000']) {
    await ok(await f.handler.fetch(action({ action: 'pollLogin', verifyCode })));
    assert.equal(f.calls.at(-1).args[0], verifyCode);
  }
  await ok(await f.handler.fetch(action({ action: 'pollLogin' })));
  assert.equal(f.calls.at(-1).args[0], undefined);
});
test('JSON MIME and explicit management header are mandatory; no browser data is accepted in URL', async t => {
  const f = fixture(t);
  for (const value of ['', '0', 'true', '1, 1']) await error(await f.handler.fetch(action(begin, { 'x-wechat-management': value })), 'invalid-request');
  for (const value of ['', 'text/plain', 'application/json;charset=utf-16', 'application/json; charset=utf-8;foo=x', 'application/json,application/json']) {
    await error(await f.handler.fetch(action(begin, { 'content-type': value })), 'unsupported-media-type', false, 415);
  }
  await error(await f.handler.fetch(action(begin, { 'content-encoding': 'gzip' })), 'unsupported-media-type', false, 415);
  for (const value of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON; CHARSET="UTF-8"']) {
    await ok(await f.handler.fetch(action(begin, { 'content-type': value, 'content-encoding': 'identity' })));
  }
});
test('strict UTF-8 and JSON reject BOM, invalid bytes, truncated characters and trailing syntax', async t => {
  const f = fixture(t);
  for (const body of [null, '', '{', '{"action":"cancelLogin",}', '{"action":"cancelLogin"} true', '\ufeff{"action":"cancelLogin"}',
    Uint8Array.from([0xc3, 0x28]), Uint8Array.from([0xe2, 0x82])]) await error(await f.handler.fetch(raw(body)), 'invalid-json');
  assert.deepEqual(f.calls, []);
});
test('request stream enforces the 4096 byte inclusive cap independent of advertised length', async t => {
  const f = fixture(t);
  const body = JSON.stringify({ action: 'cancelLogin' });
  await ok(await f.handler.fetch(raw(body + ' '.repeat(4096 - Buffer.byteLength(body)))));
  await error(await f.handler.fetch(raw(body + ' '.repeat(4097 - Buffer.byteLength(body)), { 'content-length': '1' })), 'body-too-large', false, 413);
  for (const length of ['4097', '-1', 'not-a-number', '999999999999999999999']) await error(await f.handler.fetch(raw(body, { 'content-length': length })), 'body-too-large', false, 413);
  let cancelled = 0;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4096)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled++; } });
  await error(await f.handler.fetch(raw(stream)), 'body-too-large', false, 413); assert.equal(cancelled, 1);
});
test('valid multibyte JSON may cross stream chunk boundaries without corruption', async t => {
  const f = fixture(t), bytes = encoder.encode(JSON.stringify({ action: 'pollLogin', verifyCode: '中文' }));
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  await ok(await f.handler.fetch(raw(stream))); assert.equal(f.calls[0].args[0], '中文');
});
test('non-byte or throwing request streams fail redacted and never reach the channel', async t => {
  const f = fixture(t);
  const invalid = new ReadableStream({ start(controller) { controller.enqueue('not bytes'); controller.close(); } });
  await error(await f.handler.fetch(raw(invalid)), 'invalid-request');
  const broken = new ReadableStream({ pull() { throw new Error(PRIVATE); } });
  await error(await f.handler.fetch(raw(broken)), 'operation-failed');
  assert.deepEqual(f.calls, []);
});
for (const qrStatus of ['wait', 'scaned', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect']) {
  test('official login status is projected without claiming paired: ' + qrStatus, async t => {
    const f = fixture(t, { pollLogin: async () => ({ status: qrStatus, botToken: PRIVATE }) });
    assert.deepEqual(await ok(await f.handler.fetch(action({ action: 'pollLogin' }))), { status: qrStatus });
    assert.deepEqual(f.calls.map(call => call.method), qrStatus === 'expired' ? ['pollLogin', 'cancelLogin'] : ['pollLogin']);
  });
}
test('status/action dependency contract failures cannot leak injected fields', async t => {
  for (const value of [null, {}, status({ enabled: false }), status({ phase: PRIVATE }), status({ phase: 'disabled' }),
    status({ hasStoredLogin: PRIVATE }), status({ pendingRecovery: null }), status({ messagingVerified: true })]) {
    const f = fixture(t, { getStatus: async () => value }); await error(await f.handler.fetch(get()), 'invalid-response', false, 502);
  }
  for (const [method, payload, value, unknown] of [
    ['beginLogin', begin, {}, true], ['beginLogin', begin, { qrContent: '' }, true],
    ['beginLogin', begin, { qrContent: 'x'.repeat(8193) }, true], ['beginLogin', begin, { qrContent: '\ud800' }, true],
    ['pollLogin', { action: 'pollLogin' }, { status: PRIVATE }, true], ['confirmPairing', confirm, { paired: false }, true],
    ['cancelLogin', { action: 'cancelLogin' }, { botToken: PRIVATE }, false], ['forget', forget, null, true],
  ]) {
    const f = fixture(t, { [method]: async () => value }); await error(await f.handler.fetch(action(payload)), 'invalid-response', unknown, 502);
  }
  let getter = 0;
  const f = fixture(t, { beginLogin: async () => Object.defineProperty({}, 'qrContent', { get() { getter++; return PRIVATE; } }) });
  await error(await f.handler.fetch(action(begin)), 'invalid-response', true); assert.equal(getter, 0);
});
test('core error allowlist preserves known failures and flags uncertain external/store outcomes', async t => {
  for (const code of ['busy', 'disabled', 'not-configured', 'invalid-state', 'store-failed', 'already-paired', 'login-active',
    'login-required', 'login-not-confirmed', 'not-paired', 'recovery-required', 'revision-exhausted', 'invalid-input']) {
    const f = fixture(t, { beginLogin: async () => { throw new WeixinChannelError(code); } });
    await error(await f.handler.fetch(action(begin)), code, false);
  }
  for (const code of ['api-failed', 'store-outcome-unknown', 'aborted', 'disposed', 'invalid-response']) {
    const f = fixture(t, { beginLogin: async () => { throw new WeixinChannelError(code); } });
    await error(await f.handler.fetch(action(begin)), code, true);
  }
  for (const cause of [new Error(PRIVATE), { code: PRIVATE, message: PRIVATE }, new WeixinChannelError('reply-failed')]) {
    const f = fixture(t, { beginLogin: async () => { throw cause; } });
    await error(await f.handler.fetch(action(begin)), 'operation-failed', true, 500);
  }
});
test('malformed dependency exceptions cannot escape the fixed error envelope or execute error getters', async t => {
  let reads = 0;
  const getter = Object.create(WeixinChannelError.prototype);
  Object.defineProperty(getter, 'code', { get() { reads++; throw new Error(PRIVATE); } });
  const coercion = Object.create(WeixinChannelError.prototype);
  Object.defineProperty(coercion, 'code', { value: { toString() { reads++; throw new Error(PRIVATE); } } });
  const unknown = Object.create(WeixinChannelError.prototype);
  Object.defineProperty(unknown, 'code', { value: PRIVATE });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error(PRIVATE); } });
  for (const cause of [getter, coercion, unknown, revoked.proxy, hostile, null, undefined, Symbol(PRIVATE)]) {
    const f = fixture(t, { beginLogin: async () => { throw cause; } });
    await error(await f.handler.fetch(action(begin)), 'operation-failed', true, 500);
  }
  assert.equal(reads, 0);
});
test('pre-aborted requests never dispatch and discard caller-controlled abort reasons', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort(PRIVATE);
  await error(await f.handler.fetch(action(begin, {}, controller.signal)), 'aborted', false, 408);
  assert.deepEqual(f.calls, []); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('request-body cancellation returns promptly even when stream cancellation never settles', async t => {
  const f = fixture(t), controller = new AbortController(); let cancelled = 0;
  const stream = new ReadableStream({ cancel(reason) { cancelled++; assert.equal(reason, undefined); return new Promise(() => {}); } });
  const pending = f.handler.fetch(raw(stream, {}, controller.signal)); await tick(); controller.abort(PRIVATE);
  await error(await pending, 'aborted', false, 408); assert.equal(cancelled, 1); assert.deepEqual(f.calls, []);
});
test('body timeout is bounded even if stream cancellation rejects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, {}, { requestTimeoutMs: 1000 }); let cancelled = 0;
  const stream = new ReadableStream({ cancel() { cancelled++; return Promise.reject(new Error(PRIVATE)); } });
  const pending = f.handler.fetch(raw(stream)); await tick(); t.mock.timers.tick(1000);
  await error(await pending, 'timeout', false, 408); assert.equal(cancelled, 1); assert.deepEqual(f.calls, []);
});
test('API timeout propagates abort, serializes unfinished dependencies and suppresses late results', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred(), gate = deferred();
  const f = fixture(t, { beginLogin: signal => { started.resolve(signal); return gate.promise; } }, { requestTimeoutMs: 1000 });
  const pending = f.handler.fetch(action(begin)); const signal = await started.promise;
  const concurrent = await f.handler.fetch(get()); await error(concurrent, 'busy', false, 409);
  t.mock.timers.tick(1000); await error(await pending, 'timeout', true, 408); assert.equal(signal.aborted, true); assert.notEqual(signal.reason, PRIVATE);
  await error(await f.handler.fetch(action(begin)), 'busy', false, 409);
  gate.resolve({ qrContent: QR }); await tick();
  await ok(await f.handler.fetch(get())); assert.equal(f.calls.filter(call => call.method === 'beginLogin').length, 1);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});
test('request abort reaches an active dependency without exposing its reason or late rejection', async t => {
  const started = deferred(), gate = deferred(), controller = new AbortController();
  const f = fixture(t, { pollLogin: (_code, signal) => { started.resolve(signal); return gate.promise; } });
  const pending = f.handler.fetch(action({ action: 'pollLogin' }, {}, controller.signal)); const signal = await started.promise;
  controller.abort(PRIVATE); await error(await pending, 'aborted', true, 408);
  assert.equal(signal.aborted, true); assert.notEqual(signal.reason, PRIVATE);
  gate.reject(new Error(PRIVATE)); await tick(); await ok(await f.handler.fetch(get()));
});
test('plugin disposal aborts requests once and cannot emit late QR output', async () => {
  const started = deferred(), gate = deferred(), f = channelFixture({ beginLogin: signal => { started.resolve(signal); return gate.promise; } });
  const handler = createWeixinAdminHandler({ enabled: true, channel: f.channel });
  const pending = handler.fetch(action(begin)); const signal = await started.promise;
  const closed = handler.dispose(); assert.equal(closed, handler.dispose()); await closed;
  await error(await pending, 'disposed', true, 410); assert.equal(signal.aborted, true);
  gate.resolve({ qrContent: QR }); await tick(); await error(await handler.fetch(get()), 'disposed', false, 410);
  assert.equal(f.calls.filter(call => call.method === 'dispose').length, 1);
});
test('static file read is bounded and aborted on the same request deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred(), gate = deferred();
  t.mock.method(fs, 'readFile', (_file, options) => { started.resolve(options.signal); return gate.promise; });
  const handler = createWeixinAdminHandler({ requestTimeoutMs: 1000 }); t.after(() => handler.dispose());
  const pending = handler.fetch(get('/admin')); const signal = await started.promise; t.mock.timers.tick(1000);
  await error(await pending, 'timeout', false, 408); assert.equal(signal.aborted, true); gate.resolve(Buffer.from(PRIVATE)); await tick();
});
test('disposer errors are redacted and repeat disposal reuses the same failed promise', async () => {
  const f = channelFixture({ dispose() { throw new Error(PRIVATE); } });
  const handler = createWeixinAdminHandler({ enabled: true, channel: f.channel });
  const disposed = handler.dispose(); assert.equal(disposed, handler.dispose());
  await assert.rejects(disposed, exception => exception.code === 'operation-failed' && !exception.message.includes(PRIVATE));
  await error(await handler.fetch(get()), 'disposed', false, 410);
});
test('real core API/store/channel composition remains pairing-only with synthetic transports and records', async t => {
  const host = hostFixture(); t.after(() => host.dispose()); const transport = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url); transport.push({ path: url.pathname, init });
    assert.equal(url.origin, 'https://ilinkai.weixin.qq.com');
    let value;
    if (url.pathname === '/ilink/bot/get_bot_qrcode') value = { qrcode: 'synthetic-qr-token', qrcode_img_content: QR };
    else if (url.pathname === '/ilink/bot/get_qrcode_status') value = { status: 'confirmed', bot_token: 'synthetic-token',
      ilink_bot_id: 'synthetic-bot', ilink_user_id: 'synthetic-user', baseurl: 'https://ilinkai.weixin.qq.com' };
    else assert.fail('Messaging is forbidden in administration');
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  });
  await apply(host.ctx, { enabled: true }); assert.equal(transport.length, 0); assert.deepEqual(host.memory.calls, []);
  const dispatch = request => host.routes.get(new URL(request.url).pathname).fetch(request);
  assert.equal((await ok(await dispatch(get()))).phase, 'unpaired');
  await error(await dispatch(action({ action: 'beginLogin' })), 'invalid-request'); assert.equal(transport.length, 0);
  assert.deepEqual(await ok(await dispatch(action(begin))), { qrContent: QR }); assert.equal(host.memory.peek(), undefined);
  await error(await dispatch(action(confirm)), 'login-not-confirmed');
  assert.deepEqual(await ok(await dispatch(action({ action: 'pollLogin' }))), { status: 'confirmed' });
  assert.equal((await ok(await dispatch(get()))).phase, 'awaiting-confirmation'); assert.equal(host.memory.peek(), undefined);
  assert.deepEqual(await ok(await dispatch(action(confirm))), { paired: true });
  const paired = await ok(await dispatch(get())); assert.equal(paired.phase, 'paired'); assert.equal(paired.messagingEnabled, false); assert.equal(paired.messagingVerified, false);
  assert.equal(host.memory.peek().payload.revision, 1);
  await error(await dispatch(action(begin)), 'already-paired');
  await ok(await dispatch(action(forget))); assert.equal(host.memory.peek().payload.credentials, null); assert.equal(host.memory.peek().payload.revision, 2);
  assert.equal((await ok(await dispatch(get()))).phase, 'unpaired');
  assert.equal(transport.length, 2); assert.equal(host.memory.calls.filter(call => call[0] === 'modify').length, 2);
  for (const { init } of transport) { assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.ok(init.signal instanceof AbortSignal); }
});
test('core cancellation clears transient pairing and expiration cleanup permits an explicit new begin', async t => {
  const host = hostFixture(); t.after(() => host.dispose()); let calls = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    calls++; const expired = new URL(input).pathname.endsWith('get_qrcode_status');
    return new Response(JSON.stringify(expired ? { status: 'expired' } : { qrcode: 'synthetic-qr', qrcode_img_content: QR }), { headers: { 'content-type': 'application/json' } });
  });
  await apply(host.ctx, { enabled: true }); const dispatch = request => host.routes.get(new URL(request.url).pathname).fetch(request);
  await ok(await dispatch(action(begin))); await ok(await dispatch(action({ action: 'cancelLogin' })));
  assert.equal((await ok(await dispatch(get()))).phase, 'unpaired');
  await error(await dispatch(action({ action: 'pollLogin' })), 'login-required');
  await ok(await dispatch(action(begin))); assert.deepEqual(await ok(await dispatch(action({ action: 'pollLogin' }))), { status: 'expired' });
  assert.equal((await ok(await dispatch(get()))).phase, 'unpaired');
  await ok(await dispatch(action(begin))); assert.equal(calls, 4); assert.equal(host.memory.peek(), undefined);
});


// Registered requests borrow the carrier's stream. These tests model the host's
// separate teardown explicitly; the direct factory still owns/cancels its body.
test('direct factory still cancels a standard stream on early header rejection', async t => {
  const { handler, calls } = fixture(t); let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 });
  const request = raw(body, { 'x-wechat-management': '0' });
  await error(await handler.fetch(request), 'invalid-request', false, 400);
  assert.equal(cancelled, 1); assert.equal(body.locked, false); assert.equal(calls.length, 0);
});
test('registered early rejections release but never cancel the carrier-owned body', async t => {
  const host = hostFixture(); t.after(() => host.dispose());
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Unexpected upstream I/O'); });
  await apply(host.ctx, { enabled: true });
  for (const [headers, code, status] of [[{ 'x-wechat-management': '0' }, 'invalid-request', 400],
    [{ 'content-type': 'text/plain' }, 'unsupported-media-type', 415], [{ 'content-length': '4097' }, 'body-too-large', 413]]) {
    let cancelled = 0;
    const body = new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 });
    await error(await host.routes.get(BASE + '/action').fetch(raw(body, headers)), code, false, status);
    await tick(); assert.equal(cancelled, 0); assert.equal(body.locked, false);
    await body.cancel(); assert.equal(cancelled, 1); // The host, not the handler, owns teardown.
  }
  assert.deepEqual(host.memory.calls, []);
});
test('borrowed streaming body retains the actual 4096-byte cap without trusting length', async t => {
  const host = hostFixture(); t.after(() => host.dispose());
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Unexpected upstream I/O'); });
  await apply(host.ctx, { enabled: true });
  const source = JSON.stringify({ action: 'cancelLogin' });
  assert.equal(await ok(await host.routes.get(BASE + '/action').fetch(raw(source + ' '.repeat(4096 - source.length)))), null);
  let sent = false, cancelled = 0;
  const body = new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(encoder.encode(source + ' '.repeat(4097 - source.length))); } },
    cancel() { cancelled++; } }, { highWaterMark: 0 });
  await error(await host.routes.get(BASE + '/action').fetch(raw(body, { 'content-length': '1' })), 'body-too-large', false, 413);
  await tick(); assert.equal(cancelled, 0); assert.equal(body.locked, false);
  await body.cancel(); assert.equal(cancelled, 1); assert.deepEqual(host.memory.calls, []);
});
test('borrowed request body forwards abort and releases its carrier reader', async t => {
  const host = hostFixture(); t.after(() => host.dispose());
  await apply(host.ctx, { enabled: true });
  const controller = new AbortController(), entered = deferred(); let cancelled = 0;
  const body = new ReadableStream({ pull() { entered.resolve(); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const work = host.routes.get(BASE + '/action').fetch(raw(body, {}, controller.signal));
  await entered.promise; controller.abort(new Error(PRIVATE));
  await error(await work, 'aborted', false, 408); await tick();
  assert.equal(cancelled, 0); assert.equal(body.locked, false); assert.deepEqual(host.memory.calls, []);
  await body.cancel(); assert.equal(cancelled, 1);
});
test('borrowed request timeout does not wait for carrier cancellation', async t => {
  const host = hostFixture(); t.after(() => host.dispose());
  await apply(host.ctx, { enabled: true, requestTimeoutMs: 20 }); let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const started = performance.now();
  await error(await host.routes.get(BASE + '/action').fetch(raw(body)), 'timeout', false, 408); await tick();
  assert.ok(performance.now() - started < 1000); assert.equal(cancelled, 0); assert.equal(body.locked, false);
  void body.cancel(); assert.equal(cancelled, 1); assert.deepEqual(host.memory.calls, []);
});
test('owner disposal releases borrowed pending body and poisons captured callbacks', async t => {
  const host = hostFixture(); t.after(() => host.dispose());
  await apply(host.ctx, { enabled: true });
  const dispatch = host.routes.get(BASE + '/action').fetch, entered = deferred(); let cancelled = 0;
  const body = new ReadableStream({ pull() { entered.resolve(); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const work = dispatch(raw(body)); await entered.promise; await host.dispose();
  await error(await work, 'disposed', false, 410); await tick();
  assert.equal(cancelled, 0); assert.equal(body.locked, false); assert.equal(host.effects.size, 0); assert.equal(host.routes.size, 0);
  await error(await dispatch(action({ action: 'cancelLogin' })), 'disposed', false, 410);
  await body.cancel(); assert.equal(cancelled, 1); assert.deepEqual(host.memory.calls, []);
});
test('registered source errors and already-locked bodies remain fixed redacted failures', async t => {
  const host = hostFixture(); t.after(() => host.dispose()); await apply(host.ctx, { enabled: true });
  const dispatch = host.routes.get(BASE + '/action').fetch;
  const broken = new ReadableStream({ pull(c) { c.error(new Error(PRIVATE)); } }, { highWaterMark: 0 });
  await error(await dispatch(raw(broken)), 'operation-failed', false, 500); await tick(); assert.equal(broken.locked, false);
  const locked = raw(new ReadableStream({}, { highWaterMark: 0 })), reader = locked.body.getReader();
  try { await error(await dispatch(locked), 'operation-failed', false, 500); }
  finally { reader.releaseLock(); await locked.body.cancel(); }
  assert.deepEqual(host.memory.calls, []);
});
