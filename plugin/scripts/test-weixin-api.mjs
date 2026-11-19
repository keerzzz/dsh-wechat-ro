// Offline only: injected fakes and native Request/Response/ReadableStream. No real HTTP.
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { getEventListeners } from 'node:events'
import { inspect } from 'node:util'
import { setImmediate as nextTurn } from 'node:timers/promises'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'

const ORIGIN = 'https://ilinkai.weixin.qq.com'
const SECRET = Object.freeze({ token: 'synthetic-private-bot-token', context: 'synthetic-private-context-token',
  qr: 'synthetic-qr-&=+%/二维码', content: 'https://example.invalid/qr?private=synthetic-content',
  verify: 'synthetic-code+&=/%验证码', text: 'synthetic-private-text\n第二行🔒', reason: 'synthetic-private-abort-reason',
  errmsg: 'synthetic-private-server-description', password: 'synthetic-private-password' })
const AUTH = Object.freeze({ botToken: SECRET.token, botId: 'bot_account@im.bot', userId: 'owner_user@im.wechat', baseUrl: ORIGIN })
const OUTBOUND = Object.freeze({ toUserId: AUTH.userId, contextToken: SECRET.context, clientId: 'client-001', text: SECRET.text })
const MESSAGES = Object.freeze({
  'not-configured': 'Weixin API transport is not configured.',
  'invalid-options': 'Weixin API options are invalid.',
  'invalid-input': 'Weixin API input is invalid.',
  'unsupported-origin': 'Weixin API origin is not supported.',
  'unsupported-redirect': 'Weixin API redirect is not supported.',
  'network-error': 'Weixin API transport failed.',
  timeout: 'Weixin API request timed out; remote effects are not rolled back.',
  aborted: 'Weixin API request was cancelled; remote effects are not rolled back.',
  'http-error': 'Weixin API HTTP request was rejected.',
  'business-error': 'Weixin API operation was rejected.',
  'invalid-mime': 'Weixin API returned an unexpected media type.',
  'invalid-json': 'Weixin API returned invalid JSON.',
  'response-too-large': 'Weixin API response exceeded its byte limit.',
  'invalid-response': 'Weixin API returned an invalid response.',
})
let api
let globalFetchTouches = 0
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
after(() => {
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch)
  else delete globalThis.fetch
})
function noSecrets(value) {
  const rendered = typeof value === 'string' ? value : inspect(value, { showHidden: true, depth: 10 })
  for (const secret of Object.values(SECRET)) assert.equal(rendered.includes(secret), false)
}
function checkError(error, code, expected = {}) {
  assert.ok(error instanceof api.WeixinApiError)
  assert.ok(Object.isFrozen(error))
  assert.equal(error.name, 'WeixinApiError')
  assert.equal(error.code, code)
  assert.equal(error.message, MESSAGES[code])
  assert.equal(error.httpStatus, expected.httpStatus)
  assert.equal(error.businessCode, expected.businessCode)
  assert.equal(error.deliveryUnknown, expected.deliveryUnknown ?? false)
  const keys = ['name', 'code', 'deliveryUnknown']
  if (expected.httpStatus !== undefined) keys.push('httpStatus')
  if (expected.businessCode !== undefined) keys.push('businessCode')
  assert.deepEqual(Object.keys(error).sort(), keys.sort())
  for (const key of ['cause', 'url', 'body', 'token', 'response', 'request', 'originalError']) assert.equal(key in error, false)
  for (const rendered of [error, JSON.stringify(error), String(error), error.stack]) noSecrets(rendered)
  return true
}
function rejects(promise, code, expected) {
  assert.ok(promise instanceof Promise)
  return assert.rejects(promise, error => checkError(error, code, expected))
}
function json(value, status = 200, mime = 'application/json; charset=utf-8') {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': mime } })
}
function qrPayload(extra = {}) { return { qrcode: SECRET.qr, qrcode_img_content: SECRET.content, ...extra } }
function confirmed(extra = {}) {
  return { status: 'confirmed', bot_token: AUTH.botToken, ilink_bot_id: AUTH.botId, ilink_user_id: AUTH.userId, baseurl: ORIGIN, ...extra }
}
function inbound(extra = {}) {
  return { message_type: 1, message_state: 2, message_id: 42, from_user_id: AUTH.userId, to_user_id: AUTH.botId,
    context_token: SECRET.context, item_list: [{ type: 1, text_item: { text: SECRET.text } }], ...extra }
}
function updates(extra = {}) { return { ret: 0, get_updates_buf: '', msgs: [], ...extra } }
const OPERATIONS = ['qr', 'status', 'updates', 'send']
function payloadFor(op) { return { qr: qrPayload(), status: { status: 'wait' }, updates: updates(), send: { ret: 0 } }[op] }
function invoke(client, op, signal) {
  if (op === 'qr') return client.requestQrCode(signal)
  if (op === 'status') return client.getQrStatus(SECRET.qr, undefined, signal)
  if (op === 'updates') return client.getUpdates(AUTH, '', signal)
  return client.sendText(AUTH, OUTBOUND, signal)
}
function fixture(reply, options = {}) {
  const calls = []
  const client = api.createWeixinApi({ ...options, fetcher: async (input, init) => {
    calls.push({ input, init })
    return typeof reply === 'function' ? reply(input, init, calls.length) : reply
  } })
  return { client, calls }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function streamed(chunks, options = {}) {
  const state = { pulls: 0, cancelled: 0 }
  const pulled = deferred()
  let position = 0
  const stream = new ReadableStream({
    pull(controller) {
      state.pulls += 1
      pulled.resolve()
      if (position < chunks.length) controller.enqueue(chunks[position++])
      else if (options.failure) controller.error(options.failure)
      else if (options.hang) return new Promise(() => {})
      else controller.close()
    },
    cancel() { state.cancelled += 1; if (options.cancelPromise) return options.cancelPromise },
  }, { highWaterMark: 0 })
  const headers = { 'Content-Type': options.mime ?? 'application/json' }
  if (options.length !== undefined) headers['Content-Length'] = options.length
  return { response: new Response(stream, { status: options.status ?? 200, headers }), stream, state, pulled }
}
function bytes(value) { return new TextEncoder().encode(value) }
function assertClean(call, external) {
  assert.equal(getEventListeners(call.init.signal, 'abort').length, 0)
  if (external) assert.equal(getEventListeners(external, 'abort').length, 0)
}

await new Response('native warmup').text()
await test('import, construction and missing transport do no ambient I/O or timers', async () => {
  const names = ['fetch', 'setTimeout', 'setInterval', 'setImmediate', 'open']
  const originals = new Map(names.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const savedRandom = crypto.randomBytes
  let touches = 0
  const trap = () => { touches += 1; throw new Error(SECRET.password) }
  try {
    for (const key of names) Object.defineProperty(globalThis, key, { configurable: true, get: trap })
    crypto.randomBytes = trap
    syncBuiltinESMExports()
    api = await import('../lib/weixin-api.js')
    let calls = 0
    assert.ok(Object.isFrozen(api.createWeixinApi({ fetcher: async () => { calls += 1; return json(qrPayload()) } })))
    const controller = new AbortController()
    controller.abort(SECRET.reason)
    for (const options of [undefined, {}, { fetcher: undefined }, { timeoutMs: 1 }, Object.create(null)]) {
      for (const op of OPERATIONS) await rejects(invoke(api.createWeixinApi(options), op, controller.signal), 'not-configured')
    }
    assert.equal(calls, 0)
    assert.equal(touches, 0)
  } finally {
    crypto.randomBytes = savedRandom
    syncBuiltinESMExports()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
  Object.defineProperty(globalThis, 'fetch', { configurable: true, get() {
    globalFetchTouches += 1
    throw new Error('Offline test forbids ambient fetch')
  } })
})
await test('runtime export, metadata, limits and frozen method shape match the contract', () => {
  assert.deepEqual(Object.keys(api).sort(), ['WEIXIN_API_INFO', 'WEIXIN_LIMITS', 'WEIXIN_UPDATE_DIAGNOSTIC', 'WeixinApiError', 'createWeixinApi'].sort())
  assert.deepEqual(api.WEIXIN_API_INFO, { origin: ORIGIN, version: '0.1.0', botAgent: 'WechatRo/0.1.0' })
  assert.deepEqual(api.WEIXIN_LIMITS, { maxResponseBytes: 1048576, maxTextBytes: 4000, maxMessages: 256, maxTokenBytes: 8192,
    maxQrCodeBytes: 8192, maxCursorBytes: 65536, maxVerifyCodeBytes: 64, maxIdentifierBytes: 512, defaultTimeoutMs: 40000 })
  assert.ok(Object.isFrozen(api.WEIXIN_API_INFO))
  assert.ok(Object.isFrozen(api.WEIXIN_LIMITS))
  assert.deepEqual(Object.keys(api.createWeixinApi()).sort(), ['requestQrCode', 'getQrStatus', 'getUpdates', 'diagnoseUpdatesOnce', 'sendText'].sort())
})
await test('closed redacted errors reject unsafe codes and unsafe numeric metadata', () => {
  for (const code of Object.keys(MESSAGES)) checkError(new api.WeixinApiError(code), code)
  for (const code of [SECRET.password, '__proto__', 'toString', 0, null, {}, Symbol('private')]) checkError(new api.WeixinApiError(code), 'invalid-response')
  for (const httpStatus of [0, 99, 600, -1, 200.5, '200', NaN, Infinity]) {
    checkError(new api.WeixinApiError('http-error', { httpStatus, businessCode: SECRET.password, deliveryUnknown: SECRET.reason }), 'http-error')
  }
  checkError(new api.WeixinApiError('business-error', { httpStatus: 429, businessCode: -14, deliveryUnknown: true, cause: SECRET.password }),
    'business-error', { httpStatus: 429, businessCode: -14, deliveryUnknown: true })
  checkError(new api.WeixinApiError('business-error', { businessCode: Number.MAX_SAFE_INTEGER + 1 }), 'business-error')
  checkError(new api.WeixinApiError('invalid-input', { get httpStatus() { throw new Error(SECRET.password) } }), 'invalid-input')
})
await test('options allow only own data keys with bounded integer values', () => {
  const bad = [null, [], 3, true, 'options', { baseUrl: ORIGIN }, { token: SECRET.token }, { fetcher: null }, { fetcher: {} },
    Object.create({ fetcher: async () => json(qrPayload()) }), { [Symbol('private')]: SECRET.password },
    { get fetcher() { throw new Error(SECRET.password) } }, new Proxy({}, { ownKeys() { throw new Error(SECRET.password) } })]
  for (const key of ['timeoutMs', 'maxResponseBytes']) {
    for (const value of [undefined, null, 0, -1, 0.5, NaN, Infinity, '10', false, 1048577]) bad.push({ [key]: value })
  }
  bad.push({ timeoutMs: 120001 })
  for (const options of bad) assert.throws(() => api.createWeixinApi(options), error => checkError(error, 'invalid-options'))
  for (const options of [{ timeoutMs: 1 }, { timeoutMs: 120000 }, { maxResponseBytes: 1 }, { maxResponseBytes: 1048576 }]) assert.ok(Object.isFrozen(api.createWeixinApi(options)))
})
for (const op of OPERATIONS) await test('wire headers, native Request, JSON and fixed policy: ' + op, async () => {
  const f = fixture(() => json(payloadFor(op)))
  await invoke(f.client, op)
  assert.equal(f.calls.length, 1)
  const { input, init } = f.calls[0]
  const url = new URL(input)
  const paths = { qr: '/ilink/bot/get_bot_qrcode', status: '/ilink/bot/get_qrcode_status', updates: '/ilink/bot/getupdates', send: '/ilink/bot/sendmessage' }
  assert.equal(url.origin, ORIGIN)
  assert.equal(url.pathname, paths[op])
  assert.equal(init.redirect, 'error')
  assert.equal(init.credentials, 'omit')
  assert.equal(init.cache, 'no-store')
  assert.ok(init.signal instanceof AbortSignal)
  assert.equal(init.method, op === 'status' ? 'GET' : 'POST')
  const native = new Request(input, init) // Construction only; no HTTP is sent.
  assert.equal(native.headers.get('ilink-app-id'), 'bot')
  assert.equal(native.headers.get('ilink-app-clientversion'), '256')
  assert.equal(native.headers.has('skroutetag'), false)
  if (op === 'status') {
    assert.deepEqual([...url.searchParams], [['qrcode', SECRET.qr]])
    assert.equal(init.body, undefined)
    for (const key of ['Authorization', 'AuthorizationType', 'X-WECHAT-UIN', 'Content-Type']) assert.equal(native.headers.has(key), false)
    assert.deepEqual(Object.keys(init.headers).sort(), ['iLink-App-Id', 'iLink-App-ClientVersion'].sort())
  } else {
    assert.equal(native.headers.get('content-type'), 'application/json')
    assert.equal(native.headers.get('authorizationtype'), 'ilink_bot_token')
    const encoded = native.headers.get('x-wechat-uin')
    const decimal = Buffer.from(encoded, 'base64').toString('ascii')
    assert.match(decimal, /^(0|[1-9]\d{0,9})$/)
    assert.ok(Number(decimal) <= 0xffffffff)
    assert.equal(Buffer.from(decimal, 'ascii').toString('base64'), encoded)
    const body = await native.json()
    if (op === 'qr') {
      assert.deepEqual([...url.searchParams], [['bot_type', '3']])
      assert.deepEqual(body, { local_token_list: [] })
      assert.equal(native.headers.has('authorization'), false)
    } else {
      assert.equal(url.search, '')
      assert.equal(native.headers.get('authorization'), 'Bearer ' + AUTH.botToken)
      assert.deepEqual(body.base_info, { channel_version: '0.1.0', bot_agent: 'WechatRo/0.1.0' })
      assert.equal(JSON.stringify(body).includes('OpenClaw'), false)
      if (op === 'updates') assert.deepEqual(body, { get_updates_buf: '', base_info: { channel_version: '0.1.0', bot_agent: 'WechatRo/0.1.0' } })
      else assert.deepEqual(body.msg, { from_user_id: '', to_user_id: OUTBOUND.toUserId, client_id: OUTBOUND.clientId,
        message_type: 2, message_state: 2, context_token: OUTBOUND.contextToken, item_list: [{ type: 1, text_item: { text: OUTBOUND.text } }] })
    }
  }
})
await test('POST UIN is node crypto uint32 decimal then base64, not Math.random', async () => {
  const saved = crypto.randomBytes, savedMath = Math.random
  let randomCalls = 0
  try {
    crypto.randomBytes = count => { assert.equal(count, 4); randomCalls += 1; return Buffer.from([255, 255, 255, 255]) }
    Math.random = () => { throw new Error('Wrong UIN random source') }
    syncBuiltinESMExports()
    for (const op of OPERATIONS) {
      const f = fixture(() => json(payloadFor(op)))
      await invoke(f.client, op)
      assert.equal(f.calls[0].init.headers['X-WECHAT-UIN'], op === 'status' ? undefined : 'NDI5NDk2NzI5NQ==')
    }
    assert.equal(randomCalls, 3)
  } finally { crypto.randomBytes = saved; Math.random = savedMath; syncBuiltinESMExports() }
})
await test('QR query encoding preserves reserved characters and UTF8 verification code', async () => {
  const f = fixture(() => json({ status: 'need_verifycode' }))
  assert.deepEqual(await f.client.getQrStatus(SECRET.qr, SECRET.verify), { status: 'need_verifycode' })
  const url = new URL(f.calls[0].input)
  assert.deepEqual([...url.searchParams], [['qrcode', SECRET.qr], ['verify_code', SECRET.verify]])
  assert.equal(url.hash, '')
})
for (const status of ['wait', 'scaned', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect']) {
  await test('QR phase whitelist and secret projection: ' + status, async () => {
    const f = fixture(() => json({ ...confirmed(), status, errmsg: SECRET.errmsg, unknown: SECRET.password }))
    const result = await f.client.getQrStatus(SECRET.qr)
    assert.ok(Object.isFrozen(result))
    if (status === 'confirmed') { assert.deepEqual(result, { status, credentials: AUTH }); assert.ok(Object.isFrozen(result.credentials)) }
    else { assert.deepEqual(result, { status }); noSecrets(result); assert.equal('credentials' in result, false) }
    assert.equal(f.calls.length, 1)
  })
}
await test('QR same-origin redirects normalize without automatic follow-up', async () => {
  for (const redirect_host of ['ilinkai.weixin.qq.com', ORIGIN, ORIGIN + '/']) {
    const f = fixture(() => json({ status: 'scaned_but_redirect', redirect_host, bot_token: SECRET.token }))
    assert.deepEqual(await f.client.getQrStatus(SECRET.qr), { status: 'scaned_but_redirect', redirectHost: ORIGIN })
    assert.equal(f.calls.length, 1)
  }
})
await test('new QR redirect hosts fail closed without following or authenticating', async () => {
  for (const redirect_host of ['new.weixin.qq.com', 'https://example.invalid', 'http://ilinkai.weixin.qq.com', ORIGIN + '/path', ORIGIN + '?token=x', ORIGIN + '#fragment', 'https://user@ilinkai.weixin.qq.com']) {
    const f = fixture(() => json({ status: 'scaned_but_redirect', redirect_host }))
    await rejects(f.client.getQrStatus(SECRET.qr), 'unsupported-redirect', { httpStatus: 200 })
    assert.equal(f.calls.length, 1)
  }
  for (const redirect_host of ['', null, 1]) await rejects(fixture(json({ status: 'scaned_but_redirect', redirect_host })).client.getQrStatus(SECRET.qr), 'invalid-response', { httpStatus: 200 })
})
await test('invalid QR states and incomplete confirmed credentials fail explicitly', async () => {
  for (const value of [{}, { status: 'connected' }, { status: 1 }, { status: null }]) await rejects(fixture(json(value)).client.getQrStatus(SECRET.qr), 'invalid-response', { httpStatus: 200 })
  for (const key of ['bot_token', 'ilink_bot_id', 'ilink_user_id', 'baseurl']) {
    for (const value of [undefined, null, 1, '', 'x'.repeat(8193)]) await rejects(fixture(json(confirmed({ [key]: value }))).client.getQrStatus(SECRET.qr), 'invalid-response', { httpStatus: 200 })
  }
  await rejects(fixture(json(confirmed({ baseurl: 'https://example.invalid' }))).client.getQrStatus(SECRET.qr), 'unsupported-origin', { httpStatus: 200 })
  assert.deepEqual((await fixture(json(confirmed({ baseurl: ORIGIN + '/' }))).client.getQrStatus(SECRET.qr)).credentials, AUTH)
})
for (const op of OPERATIONS) await test('HTTP rejection never reads body and never retries: ' + op, async () => {
  for (const status of [301, 400, 401, 403, 408, 429, 500, 503, 504]) {
    const s = streamed([bytes(SECRET.errmsg)], { status })
    const f = fixture(s.response)
    const definitive = status >= 400 && status < 500 && status !== 408
    await rejects(invoke(f.client, op), 'http-error', { httpStatus: status, deliveryUnknown: op === 'send' && !definitive })
    assert.equal(s.state.pulls, 0)
    assert.equal(s.state.cancelled, 1)
    assert.equal(f.calls.length, 1)
    assertClean(f.calls[0])
  }
})
for (const op of OPERATIONS) await test('RPC JSON, ret and errcode are validated independently of MIME: ' + op, async () => {
  const unknown = { httpStatus: 200, deliveryUnknown: op === 'send' }
  const expected = { qr: { qrcode: SECRET.qr, qrContent: SECRET.content }, status: { status: 'wait' },
    updates: { cursor: '', messages: [], ignored: 0 }, send: { accepted: true } }[op]
  for (const mime of [null, '', 'text/plain', 'text/html', 'application/problem+json', 'application/octet-stream']) {
    const f = fixture(new Response(bytes(JSON.stringify(payloadFor(op))), { headers: mime === null ? {} : { 'Content-Type': mime } }))
    assert.deepEqual(await invoke(f.client, op), expected)
    assert.equal(f.calls.length, 1)
    assertClean(f.calls[0])
  }
  for (const mime of [null, 'application/json', 'text/plain', 'text/html']) {
    for (const text of ['', '{', SECRET.password, 'null', '[]', '42', 'true']) {
      const code = ['null', '[]', '42', 'true'].includes(text) ? 'invalid-response' : 'invalid-json'
      await rejects(invoke(fixture(new Response(bytes(text), { headers: mime === null ? {} : { 'Content-Type': mime } })).client, op), code, unknown)
    }
  }
  for (const key of ['ret', 'errcode']) {
    for (const value of ['0', null, true, 1.5, Number.MAX_SAFE_INTEGER + 1]) await rejects(invoke(fixture(json({ ...payloadFor(op), [key]: value })).client, op), 'invalid-response', unknown)
    for (const value of [-14, 1, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
      await rejects(invoke(fixture(json({ ...payloadFor(op), [key]: value, errmsg: SECRET.errmsg })).client, op), 'business-error', { httpStatus: 200, businessCode: value })
    }
  }
  await invoke(fixture(json({ ...payloadFor(op), ret: 0, errcode: 0 }, 200, 'Application/JSON ; charset=UTF-8')).client, op)
})
await test('QR accepts bounded JSON with missing or other MIME, without a public bypass option', async () => {
  for (const mime of [null, 'application/octet-stream', 'application/x-synthetic-qr']) {
    const f = fixture(new Response(bytes(JSON.stringify(qrPayload())), { headers: mime === null ? {} : { 'Content-Type': mime } }))
    assert.deepEqual(await f.client.requestQrCode(), { qrcode: SECRET.qr, qrContent: SECRET.content })
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].input, ORIGIN + '/ilink/bot/get_bot_qrcode?bot_type=3')
    assert.equal(f.calls[0].init.method, 'POST')
    assertClean(f.calls[0])
  }
  assert.throws(() => api.createWeixinApi({ ignoreMime: true }), error => checkError(error, 'invalid-options'))
})
await test('non-JSON-labelled QR bodies still enforce JSON, business codes and QR fields', async () => {
  const expected = { httpStatus: 200 }
  for (const mime of ['text/html', 'application/x-synthetic-qr']) {
    for (const text of ['', '<html>' + SECRET.errmsg + '</html>', '{', 'null', '[]']) {
      const f = fixture(new Response(bytes(text), { headers: { 'Content-Type': mime } }))
      await rejects(f.client.requestQrCode(), ['null', '[]'].includes(text) ? 'invalid-response' : 'invalid-json', expected)
      assert.equal(f.calls.length, 1)
    }
    for (const key of ['qrcode', 'qrcode_img_content']) {
      for (const value of [undefined, null, '', 3, 'x'.repeat(8193), '\udfff']) {
        await rejects(fixture(json(qrPayload({ [key]: value }), 200, mime)).client.requestQrCode(), 'invalid-response', expected)
      }
    }
    for (const key of ['ret', 'errcode']) {
      await rejects(fixture(json(qrPayload({ [key]: '0' }), 200, mime)).client.requestQrCode(), 'invalid-response', expected)
      await rejects(fixture(json(qrPayload({ [key]: -14, errmsg: SECRET.errmsg }), 200, mime)).client.requestQrCode(), 'business-error', { ...expected, businessCode: -14 })
    }
  }
})
for (const op of OPERATIONS) await test('RPC MIME compatibility keeps streaming limits, UTF8, origins and redirects: ' + op, async () => {
  const encoded = bytes(JSON.stringify(payloadFor(op))), mime = 'application/x-synthetic-rpc'
  const unknown = { httpStatus: 200, deliveryUnknown: op === 'send' }
  for (const length of [undefined, '0', String(encoded.byteLength)]) {
    const s = streamed([encoded.subarray(0, 9), encoded.subarray(9)], { mime, length })
    const f = fixture(s.response, { maxResponseBytes: encoded.byteLength - 1 })
    await rejects(invoke(f.client, op), 'response-too-large', unknown)
    assert.equal(s.state.cancelled, 1); assert.equal(s.stream.locked, false)
  }
  const invalid = streamed([Uint8Array.of(0xff)], { mime })
  await rejects(invoke(fixture(invalid.response).client, op), 'invalid-json', unknown)
  for (const [key, value, code] of [['url', 'https://example.invalid/private', 'unsupported-origin'], ['redirected', true, 'unsupported-redirect']]) {
    const s = streamed([encoded], { mime })
    Object.defineProperty(s.response, key, { value })
    await rejects(invoke(fixture(s.response).client, op), code, { deliveryUnknown: op === 'send' })
    assert.equal(s.state.pulls, 0); assert.equal(s.state.cancelled, 1)
  }
})
await test('non-JSON-labelled QR streaming still times out or cancels without retry', async () => {
  const mime = 'application/x-synthetic-qr'
  const stalled = streamed([], { mime, hang: true }), f = fixture(stalled.response, { timeoutMs: 50 })
  await rejects(f.client.requestQrCode(), 'timeout', { httpStatus: 200 })
  assert.equal(f.calls.length, 1); assert.equal(stalled.state.cancelled, 1); assertClean(f.calls[0])
  const source = streamed([], { mime, hang: true }), g = fixture(source.response), control = new AbortController()
  const pending = g.client.requestQrCode(control.signal)
  const observed = pending.then(() => null, error => error)
  await nextTurn(); control.abort(SECRET.reason)
  checkError(await observed, 'aborted', { httpStatus: 200 })
  assert.equal(g.calls.length, 1); assert.equal(source.state.cancelled, 1); assertClean(g.calls[0], control.signal)
})
await test('scan status accepts bounded JSON for all eight states with missing or different MIME', async () => {
  for (const mime of [null, 'application/octet-stream', 'text/html']) {
    for (const status of ['wait', 'scaned', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect']) {
      const payload = status === 'confirmed' ? confirmed() : { status }
      const f = fixture(new Response(bytes(JSON.stringify(payload)), { headers: mime === null ? {} : { 'Content-Type': mime } }))
      const value = await f.client.getQrStatus(SECRET.qr)
      assert.deepEqual(value, status === 'confirmed' ? { status, credentials: AUTH } : { status })
      assert.ok(Object.isFrozen(value)); assert.equal(f.calls.length, 1)
      assert.equal(new URL(f.calls[0].input).pathname, '/ilink/bot/get_qrcode_status')
      assert.equal(f.calls[0].init.method, 'GET')
      assert.equal(new Headers(f.calls[0].init.headers).has('authorization'), false)
      assertClean(f.calls[0])
    }
  }
})
await test('scan status MIME compatibility preserves opaque QR and optional verification-code encoding', async () => {
  for (const verifyCode of [undefined, SECRET.verify]) {
    const f = fixture(json({ status: 'need_verifycode' }, 200, 'application/x-synthetic-status'))
    assert.deepEqual(await f.client.getQrStatus(SECRET.qr, verifyCode), { status: 'need_verifycode' })
    const params = new URL(f.calls[0].input).searchParams
    assert.equal(params.get('qrcode'), SECRET.qr)
    assert.equal(params.has('verify_code'), verifyCode !== undefined)
    if (verifyCode !== undefined) assert.equal(params.get('verify_code'), verifyCode)
    assert.equal(f.calls.length, 1)
  }
})
await test('scan status still rejects non-JSON bodies, invalid business codes and malformed states or credentials', async () => {
  const mime = 'application/x-synthetic-status', expected = { httpStatus: 200 }
  for (const text of ['', '<html>' + SECRET.errmsg + '</html>', '{', 'null', '[]', 'true']) {
    await rejects(fixture(new Response(bytes(text), { headers: { 'Content-Type': mime } })).client.getQrStatus(SECRET.qr),
      ['null', '[]', 'true'].includes(text) ? 'invalid-response' : 'invalid-json', expected)
  }
  for (const key of ['ret', 'errcode']) {
    await rejects(fixture(json({ status: 'wait', [key]: '0' }, 200, mime)).client.getQrStatus(SECRET.qr), 'invalid-response', expected)
    await rejects(fixture(json({ status: 'wait', [key]: -14, errmsg: SECRET.errmsg }, 200, mime)).client.getQrStatus(SECRET.qr),
      'business-error', { ...expected, businessCode: -14 })
  }
  for (const [payload, code] of [
    [{ status: 'unknown' }, 'invalid-response'], [{ status: 'confirmed' }, 'invalid-response'],
    [confirmed({ bot_token: '' }), 'invalid-response'], [confirmed({ ilink_user_id: 'bad / user' }), 'invalid-response'],
    [confirmed({ baseurl: 'https://example.invalid' }), 'unsupported-origin'],
    [{ status: 'scaned_but_redirect', redirect_host: 'example.invalid' }, 'unsupported-redirect'],
  ]) await rejects(fixture(json(payload, 200, mime)).client.getQrStatus(SECRET.qr), code, expected)
})
await test('scan status MIME compatibility retains streaming byte, UTF8 and response-origin checks', async () => {
  const encoded = bytes(JSON.stringify({ status: 'wait', padding: SECRET.errmsg })), mime = 'application/x-synthetic-status'
  const large = streamed([encoded], { mime, length: '0' })
  await rejects(fixture(large.response, { maxResponseBytes: encoded.byteLength - 1 }).client.getQrStatus(SECRET.qr), 'response-too-large', { httpStatus: 200 })
  assert.equal(large.state.cancelled, 1); assert.equal(large.stream.locked, false)
  const invalid = streamed([Uint8Array.of(0xff)], { mime })
  await rejects(fixture(invalid.response).client.getQrStatus(SECRET.qr), 'invalid-json', { httpStatus: 200 })
  for (const [key, value, code] of [['url', 'https://example.invalid/private', 'unsupported-origin'], ['redirected', true, 'unsupported-redirect']]) {
    const s = streamed([encoded], { mime })
    Object.defineProperty(s.response, key, { value })
    await rejects(fixture(s.response).client.getQrStatus(SECRET.qr), code)
    assert.equal(s.state.pulls, 0); assert.equal(s.state.cancelled, 1)
  }
})
await test('scan status with other MIME still times out or cancels without retries', async () => {
  const mime = 'application/x-synthetic-status'
  const stalled = streamed([], { mime, hang: true }), f = fixture(stalled.response, { timeoutMs: 50 })
  await rejects(f.client.getQrStatus(SECRET.qr), 'timeout', { httpStatus: 200 })
  assert.equal(f.calls.length, 1); assert.equal(stalled.state.cancelled, 1); assertClean(f.calls[0])
  const body = streamed([], { mime, hang: true }), g = fixture(body.response), control = new AbortController()
  const pending = g.client.getQrStatus(SECRET.qr, undefined, control.signal)
  const observed = pending.then(() => null, error => error)
  await nextTurn(); control.abort(SECRET.reason)
  checkError(await observed, 'aborted', { httpStatus: 200 })
  assert.equal(g.calls.length, 1); assert.equal(body.state.cancelled, 1); assertClean(g.calls[0], control.signal)
})
await test('updates and send accept omitted zero business codes; accepted is projected', async () => {
  const value = payloadFor('updates')
  delete value.ret
  assert.deepEqual(await invoke(fixture(json(value)).client, 'updates'), { cursor: '', messages: [], ignored: 0 })
  for (const ack of [{}, { errcode: 0 }, { data: {} }, { ret: 0 }, { ret: 0, data: {} }]) {
    const f = fixture(json(ack))
    const accepted = await invoke(f.client, 'send')
    assert.deepEqual(accepted, { accepted: true })
    assert.ok(Object.isFrozen(accepted))
    noSecrets(accepted)
    assert.equal(f.calls.length, 1)
    assertClean(f.calls[0])
  }
  await fixture(json(qrPayload())).client.requestQrCode()
  await fixture(json({ status: 'wait' })).client.getQrStatus(SECRET.qr)
  const accepted = await fixture(json({ ret: 0, errmsg: SECRET.errmsg, unknown: SECRET.password })).client.sendText(AUTH, OUTBOUND)
  assert.deepEqual(accepted, { accepted: true })
  assert.ok(Object.isFrozen(accepted))
  noSecrets(accepted)
})
await test('missing and empty update cursors preserve the previous cursor, without sync_buf fallback', async () => {
  for (const cursor of ['', 'next-cursor', '游标+&=']) {
    const f = fixture(json(updates({ get_updates_buf: cursor, sync_buf: SECRET.password, extra: SECRET.errmsg })))
    assert.deepEqual(await f.client.getUpdates(AUTH, 'old-cursor'), { cursor: cursor || 'old-cursor', messages: [], ignored: 0 })
    assert.equal(JSON.parse(f.calls[0].init.body).get_updates_buf, 'old-cursor')
  }
  for (const previous of ['', 'old-cursor', '游标+&=']) {
    assert.deepEqual(await fixture(json({ ret: 0, msgs: [], sync_buf: SECRET.password })).client.getUpdates(AUTH, previous),
      { cursor: previous, messages: [], ignored: 0 })
  }
})
await test('empty update pages accept omitted ret and omitted or null msgs, while checking business errors', async () => {
  for (const value of [{}, { ret: 0 }, { errcode: 0 }, { ret: 0, msgs: null }, { msgs: [] }, { msgs: null, get_updates_buf: '' }]) {
    const f = fixture(json(value))
    assert.deepEqual(await f.client.getUpdates(AUTH, 'previous'), { cursor: 'previous', messages: [], ignored: 0 })
    assert.equal(f.calls.length, 1)
  }
  for (const value of [{ ret: -1 }, { errcode: -14 }, { ret: 0, errcode: -14 }]) {
    await rejects(fixture(json(value)).client.getUpdates(AUTH, 'previous'), 'business-error',
      { httpStatus: 200, businessCode: value.errcode ?? value.ret })
  }
})
await test('complete private text retains every peer for Host checks and joins with newline', async () => {
  const second = inbound({ message_id: Number.MAX_SAFE_INTEGER, from_user_id: 'other_owner@im.wechat',
    item_list: [{ type: 1, text_item: { text: '第一行' } }, { type: 1, text_item: { text: 'second' } }] })
  const value = await fixture(json(updates({ msgs: [inbound({ unknown: SECRET.password }), second] }))).client.getUpdates(AUTH, '')
  assert.deepEqual(value, { cursor: '', messages: [
    { messageId: '42', fromUserId: AUTH.userId, toUserId: AUTH.botId, contextToken: SECRET.context, text: SECRET.text },
    { messageId: String(Number.MAX_SAFE_INTEGER), fromUserId: 'other_owner@im.wechat', toUserId: AUTH.botId, contextToken: SECRET.context, text: '第一行\nsecond' },
  ], ignored: 0 })
  assert.ok(Object.isFrozen(value))
  assert.ok(Object.isFrozen(value.messages))
  for (const message of value.messages) assert.ok(Object.isFrozen(message))
})
await test('bot, generating, group, media, unknown types and mixed items increment ignored', async () => {
  const ignored = [inbound({ message_type: 2 }), { message_type: 99 }, inbound({ message_state: 0 }), inbound({ message_state: 1 }), inbound({ message_state: 99 }),
    inbound({ group_id: 'group-001' }), inbound({ image_item: {} }), ...[2, 3, 4, 5, 11, 12, 999].map(type => inbound({ item_list: [{ type }] })),
    inbound({ item_list: [{ type: 1, text_item: { text: 'caption' } }, { type: 2, image_item: {} }] }),
    inbound({ item_list: [{ type: 1, text_item: { text: 'caption' }, image_item: {} }] }),
    inbound({ item_list: [{ type: 1, text_item: { text: 'quote' }, ref_msg: { type: 2, image_item: {} } }] })]
  const value = await fixture(json(updates({ msgs: [inbound(), ...ignored] }))).client.getUpdates(AUTH, '')
  assert.equal(value.messages.length, 1)
  assert.equal(value.ignored, ignored.length)
})
await test('malformed complete text fails the whole page rather than silently advancing cursor', async () => {
  const damaged = [null, [], {}, inbound({ message_state: undefined }), inbound({ message_type: '1' }), inbound({ group_id: null }),
    inbound({ item_list: undefined }), inbound({ item_list: null }), inbound({ item_list: [] }), inbound({ item_list: [null] }), inbound({ item_list: [{ type: '1' }] }),
    inbound({ item_list: [{ type: 1 }] }), inbound({ item_list: [{ type: 1, text_item: { text: 5 } }] }),
    inbound({ item_list: [{ type: 1, text_item: { text: '' } }] }), inbound({ item_list: [{ type: 1, text_item: { text: '\ud800' } }] })]
  for (const key of ['from_user_id', 'to_user_id', 'context_token']) {
    for (const value of [undefined, null, '', 1, 'bad\nvalue', 'x'.repeat(8193)]) damaged.push(inbound({ [key]: value }))
  }
  for (const value of damaged) {
    const f = fixture(json(updates({ get_updates_buf: 'must-not-advance', msgs: [inbound(), value] })))
    await rejects(f.client.getUpdates(AUTH, 'previous'), 'invalid-response', { httpStatus: 200 })
    assert.equal(f.calls.length, 1)
  }
})
await test('message IDs preserve canonical positive uint64 decimal strings and numeric wire tokens', async () => {
  for (const message_id of ['1', '42', String(Number.MAX_SAFE_INTEGER), '9007199254740992', '9007199254740993', '18446744073709551615']) {
    for (const quoted of [true, false]) {
      const source = JSON.stringify(updates({ msgs: [inbound({ message_id })] }))
      const f = fixture(new Response(quoted ? source : source.replace('"message_id":"' + message_id + '"', '"message_id":' + message_id)))
      assert.equal((await f.client.getUpdates(AUTH, 'previous')).messages[0].messageId, message_id)
      assert.equal(f.calls.length, 1)
    }
  }
  const adjacent = ['9007199254740992', '9007199254740993']
  const source = JSON.stringify(updates({ msgs: adjacent.map(message_id => inbound({ message_id })) }))
    .replace(/"message_id":"(\d+)"/g, '"message_id":$1')
  const value = await fixture(new Response(source)).client.getUpdates(AUTH, 'previous')
  assert.deepEqual(value.messages.map(message => message.messageId), adjacent)
})
await test('uint64 decoding only touches numeric ID fields and works across streamed chunks', async () => {
  const text = 'literal "message_id":18446744073709551615 must remain text'
  const source = JSON.stringify(updates({ msgs: [inbound({ message_id: '18446744073709551615', item_list: [{ type: 1, text_item: { text } }] })] }))
    .replace('"message_id":"18446744073709551615"', '"message_id":18446744073709551615')
  const boundary = source.indexOf('18446744073709551615') + 9
  const s = streamed([bytes(source.slice(0, boundary)), bytes(source.slice(boundary))])
  const value = await fixture(s.response).client.getUpdates(AUTH, 'previous')
  assert.equal(value.messages[0].messageId, '18446744073709551615')
  assert.equal(value.messages[0].text, text)
})
await test('lossless message IDs leave business codes and unrelated numbers unchanged', async () => {
  const { createWeixinRequest } = await import('../lib/weixin-http.js')
  const source = '{"ret":0,"errcode":0,"message_id":18446744073709551615,"nested":{"message_id":9007199254740993,"msg_id":7},"unrelated":9007199254740993}'
  const request = createWeixinRequest({ fetcher: async () => new Response(source) })
  assert.deepEqual(await request(() => ({ method: 'POST', path: '/ilink/bot/getupdates' }), value => value, false, false),
    { ret: 0, errcode: 0, message_id: '18446744073709551615', nested: { message_id: '9007199254740993', msg_id: 7 }, unrelated: 9007199254740992 })
  const failure = source.replace('"errcode":0', '"errcode":-14')
  await rejects(fixture(new Response(failure)).client.getUpdates(AUTH, 'previous'), 'business-error',
    { httpStatus: 200, businessCode: -14 })
})
await test('message IDs reject noncanonical, nonpositive and out-of-range values without item-ID fallback', async () => {
  for (const message_id of [undefined, null, '', '0', '00', '01', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '１',
    '18446744073709551616', '1'.repeat(21), 0, -1, 1.5, 1e30]) {
    await rejects(fixture(json(updates({ msgs: [inbound({ message_id })] }))).client.getUpdates(AUTH, ''), 'invalid-response', { httpStatus: 200 })
  }
  const source = JSON.stringify(updates({ msgs: [inbound({ message_id: '18446744073709551616' })] }))
    .replace('"message_id":"18446744073709551616"', '"message_id":18446744073709551616')
  await rejects(fixture(new Response(source)).client.getUpdates(AUTH, ''), 'invalid-response', { httpStatus: 200 })
  await rejects(fixture(json(updates({ msgs: [inbound({ message_id: undefined, item_list: [{ type: 1, msg_id: '42', text_item: { text: SECRET.text } }] })] })))
    .client.getUpdates(AUTH, ''), 'invalid-response', { httpStatus: 200 })
  for (const from_user_id of ['a/b', '../owner', 'a\\b', 'a b', '中文', 'a\u0000b', 'x'.repeat(513)]) {
    await rejects(fixture(json(updates({ msgs: [inbound({ from_user_id })] }))).client.getUpdates(AUTH, ''), 'invalid-response', { httpStatus: 200 })
  }
})
await test('numeric ID tokens reject fractional and exponent spellings before rounding can create an integer', async () => {
  for (const message_id of ['42.0', '4.2e1', '1e0', '1.0000000000000001', '9007199254740990.9', '9.007199254740991e15', '1e19']) {
    const source = JSON.stringify(updates({ msgs: [inbound()] })).replace('"message_id":42', '"message_id":' + message_id)
    const f = fixture(new Response(source))
    await rejects(f.client.getUpdates(AUTH, 'previous'), 'invalid-response', { httpStatus: 200 })
    assert.equal(f.calls.length, 1)
  }
})
await test('missing native reviver source never admits numeric IDs, even when rounding looks safe', async () => {
  const parse = JSON.parse
  try {
    // Native source is supplied by the engine; stripping it requires this parser-boundary replacement.
    JSON.parse = (text, reviver) => parse(text, typeof reviver === 'function' ? function (key, value) {
      return reviver.call(this, key, value)
    } : reviver)
    for (const message_id of ['42', '18446744073709551615', '1.0000000000000001', '9007199254740990.9']) {
      const source = JSON.stringify(updates({ msgs: [inbound()] })).replace('"message_id":42', '"message_id":' + message_id)
      await rejects(fixture(new Response(source)).client.getUpdates(AUTH, 'previous'), 'invalid-response', { httpStatus: 200 })
    }
    assert.equal((await fixture(json(updates({ msgs: [inbound({ message_id: '42' })] }))).client.getUpdates(AUTH, 'previous')).messages[0].messageId, '42')
  } finally { JSON.parse = parse }
})
await test('nonempty msgs must be an array; cursor and 256-message response bounds remain enforced', async () => {
  for (const bad of [{ msgs: {} }, { msgs: 'messages' }, { msgs: new Array(257).fill(inbound()) },
    { get_updates_buf: null }, { get_updates_buf: 1 }, { get_updates_buf: 'x'.repeat(65537) }, { get_updates_buf: '\ud800' }]) {
    await rejects(fixture(json(updates(bad))).client.getUpdates(AUTH, ''), 'invalid-response', { httpStatus: 200 })
  }
  const value = await fixture(json(updates({ msgs: new Array(256).fill(inbound()), get_updates_buf: 'x'.repeat(65536) }))).client.getUpdates(AUTH, '')
  assert.equal(value.messages.length, 256)
  assert.equal(value.cursor.length, 65536)
})
await test('text UTF8 budget includes joining newlines, with exact 4000-byte acceptance', async () => {
  const text = '🔒'.repeat(1000)
  assert.equal(Buffer.byteLength(text), 4000)
  await fixture(json({ ret: 0 })).client.sendText(AUTH, { ...OUTBOUND, text })
  const value = await fixture(json(updates({ msgs: [inbound({ item_list: [{ type: 1, text_item: { text } }] })] }))).client.getUpdates(AUTH, '')
  assert.equal(value.messages[0].text, text)
  for (const item_list of [[{ type: 1, text_item: { text: text + 'x' } }], [{ type: 1, text_item: { text } }, { type: 1, text_item: { text: '' } }]]) {
    await rejects(fixture(json(updates({ msgs: [inbound({ item_list })] }))).client.getUpdates(AUTH, ''), 'invalid-response', { httpStatus: 200 })
  }
  const joined = [{ type: 1, text_item: { text: 'a'.repeat(1999) } }, { type: 1, text_item: { text: 'b'.repeat(2000) } }]
  assert.equal((await fixture(json(updates({ msgs: [inbound({ item_list: joined })] }))).client.getUpdates(AUTH, '')).messages[0].text.length, 4000)
})
await test('QR fields, token and cursor budgets count UTF8 bytes', async () => {
  const maxQr = '界'.repeat(2730) + 'ab', maxToken = 'x'.repeat(8192)
  assert.equal(Buffer.byteLength(maxQr), 8192)
  assert.equal((await fixture(json(qrPayload({ qrcode: maxQr, qrcode_img_content: maxQr }))).client.requestQrCode()).qrcode, maxQr)
  for (const key of ['qrcode', 'qrcode_img_content']) {
    for (const value of [undefined, null, '', 1, maxQr + 'x', '\udfff']) await rejects(fixture(json(qrPayload({ [key]: value }))).client.requestQrCode(), 'invalid-response', { httpStatus: 200 })
  }
  assert.equal((await fixture(json(confirmed({ bot_token: maxToken }))).client.getQrStatus(SECRET.qr)).credentials.botToken.length, 8192)
  const cursor = '界'.repeat(21845) + 'x'
  assert.equal(Buffer.byteLength(cursor), 65536)
  assert.equal((await fixture(json(updates({ get_updates_buf: cursor }))).client.getUpdates(AUTH, '')).cursor, cursor)
  await rejects(fixture(json(updates({ get_updates_buf: cursor + 'x' }))).client.getUpdates(AUTH, ''), 'invalid-response', { httpStatus: 200 })
})
await test('input types, UTF8, identifiers, tokens and byte budgets fail before timer or fetch', async () => {
  let calls = 0
  const client = api.createWeixinApi({ fetcher: async () => { calls += 1; return json({ ret: 0 }) } })
  const invalid = []
  for (const value of [undefined, null, '', 3, '\ud800', 'q'.repeat(8193), '🔒'.repeat(2049)]) invalid.push(() => client.getQrStatus(value))
  for (const value of [null, '', 1, '\udfff', 'v'.repeat(65), '界'.repeat(22)]) invalid.push(() => client.getQrStatus(SECRET.qr, value))
  for (const value of [undefined, null, 1, '\ud800', 'c'.repeat(65537), '🔒'.repeat(16385)]) invalid.push(() => client.getUpdates(AUTH, value))
  for (const key of ['botToken', 'botId', 'userId']) {
    for (const value of [undefined, null, '', 1, 'bad\r\nheader', 'x'.repeat(8193)]) invalid.push(() => client.getUpdates({ ...AUTH, [key]: value }, ''))
  }
  invalid.push(() => client.getUpdates({ ...AUTH, botToken: '令牌' }, ''))
  for (const key of ['toUserId', 'clientId', 'contextToken', 'text']) {
    for (const value of [undefined, null, '', 1, '\ud800']) invalid.push(() => client.sendText(AUTH, { ...OUTBOUND, [key]: value }))
  }
  for (const key of ['toUserId', 'clientId']) invalid.push(() => client.sendText(AUTH, { ...OUTBOUND, [key]: 'x'.repeat(513) }))
  invalid.push(() => client.sendText(AUTH, { ...OUTBOUND, contextToken: 'x'.repeat(8193) }))
  invalid.push(() => client.sendText(AUTH, { ...OUTBOUND, text: '🔒'.repeat(1001) }))
  invalid.push(() => client.sendText(AUTH, null), () => client.sendText(null, OUTBOUND), () => client.getUpdates(Object.create(AUTH), ''))
  invalid.push(() => client.sendText(AUTH, { ...OUTBOUND, get text() { throw new Error(SECRET.password) } }))
  invalid.push(() => client.getUpdates(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(SECRET.password) } }), ''))
  invalid.push(() => client.requestQrCode({ aborted: false }), () => client.requestQrCode(null))
  const saved = globalThis.setTimeout
  let timers = 0
  globalThis.setTimeout = () => { timers += 1; throw new Error('Invalid input started a timer') }
  try { for (const attempt of invalid) await rejects(attempt(), 'invalid-input') }
  finally { globalThis.setTimeout = saved }
  assert.equal(calls, 0)
  assert.equal(timers, 0)
})
await test('valid maximum input budgets are not silently truncated', async () => {
  const qr = 'q'.repeat(8192), code = 'v'.repeat(64), cursor = 'c'.repeat(65536), id = 'i'.repeat(512), token = 't'.repeat(8192)
  const q = fixture(json({ status: 'wait' }))
  await q.client.getQrStatus(qr, code)
  assert.equal(new URL(q.calls[0].input).searchParams.get('qrcode'), qr)
  assert.equal(new URL(q.calls[0].input).searchParams.get('verify_code'), code)
  const f = fixture(() => json(updates()))
  await f.client.getUpdates({ ...AUTH, botId: id, userId: id, botToken: token }, cursor)
  assert.equal(JSON.parse(f.calls[0].init.body).get_updates_buf, cursor)
  const s = fixture(json({ ret: 0 }))
  await s.client.sendText(AUTH, { toUserId: id, clientId: id, contextToken: token, text: 'a'.repeat(4000) })
  assert.equal(JSON.parse(s.calls[0].init.body).msg.context_token, token)
})
await test('credential URLs outside the exact official root fail before dispatch', async () => {
  const f = fixture(() => json(updates()))
  for (const baseUrl of ['http://ilinkai.weixin.qq.com', 'https://example.invalid', ORIGIN + '.evil.invalid', ORIGIN + ':444', ORIGIN + '/path',
    ORIGIN + '?query', ORIGIN + '#fragment', ORIGIN + '?', ORIGIN + '#', ORIGIN + '/a/..', ORIGIN + '//', 'https://user:password@ilinkai.weixin.qq.com', ' ' + ORIGIN]) {
    await rejects(f.client.getUpdates({ ...AUTH, baseUrl }, ''), 'unsupported-origin')
  }
  assert.equal(f.calls.length, 0)
  await f.client.getUpdates({ ...AUTH, baseUrl: ORIGIN + '/' }, '')
  assert.equal(f.calls.length, 1)
  assert.equal(new URL(f.calls[0].input).origin, ORIGIN)
})
await test('native streaming enforces byte limit without trusting Content-Length', async () => {
  const encoded = bytes(JSON.stringify(qrPayload()))
  for (const length of [undefined, '0', '1', 'nonsense', '-1']) {
    const s = streamed([encoded.subarray(0, 17), encoded.subarray(17)], { length })
    const f = fixture(s.response, { maxResponseBytes: encoded.byteLength - 1 })
    await rejects(f.client.requestQrCode(), 'response-too-large', { httpStatus: 200 })
    assert.equal(s.state.cancelled, 1)
    assert.equal(s.stream.locked, false)
    assertClean(f.calls[0])
  }
  const pre = streamed([encoded], { length: String(encoded.byteLength + 1) })
  await rejects(fixture(pre.response, { maxResponseBytes: encoded.byteLength }).client.requestQrCode(), 'response-too-large', { httpStatus: 200 })
  assert.equal(pre.state.pulls, 0)
  assert.equal(pre.state.cancelled, 1)
  const exact = streamed([encoded.subarray(0, 9), encoded.subarray(9)], { length: '0' })
  assert.deepEqual(await fixture(exact.response, { maxResponseBytes: encoded.byteLength }).client.requestQrCode(), { qrcode: SECRET.qr, qrContent: SECRET.content })
  assert.equal(exact.stream.locked, false)
})
await test('default 1MiB cap accepts exact bytes and rejects a chunk crossing it', async () => {
  const prefix = JSON.stringify(qrPayload()).slice(0, -1) + ',"padding":"'
  const suffix = '"}'
  const paddingLength = api.WEIXIN_LIMITS.maxResponseBytes - Buffer.byteLength(prefix + suffix)
  const exact = bytes(prefix + 'x'.repeat(paddingLength) + suffix)
  assert.equal(exact.byteLength, 1048576)
  await fixture(streamed([exact.subarray(0, 524288), exact.subarray(524288)]).response).client.requestQrCode()
  const large = streamed([exact.subarray(0, 524288), bytes('x'.repeat(524289))])
  await rejects(fixture(large.response).client.requestQrCode(), 'response-too-large', { httpStatus: 200 })
  assert.equal(large.state.cancelled, 1)
})
await test('UTF8 split codepoints, empty chunks and invalid UTF8 are handled incrementally', async () => {
  const source = JSON.stringify(qrPayload({ qrcode: '二维码🔒', qrcode_img_content: '文字🔒' }))
  const encoded = bytes(source)
  const s = streamed([...encoded].flatMap(value => [new Uint8Array(), Uint8Array.of(value)]))
  assert.deepEqual(await fixture(s.response).client.requestQrCode(), { qrcode: '二维码🔒', qrContent: '文字🔒' })
  assert.equal(s.stream.locked, false)
  for (const chunks of [[Uint8Array.of(0xff)], [bytes('{"qrcode":"'), Uint8Array.of(0xf0, 0x9f)], [bytes('{"qrcode":"'), Uint8Array.of(0xed, 0xa0, 0x80)]]) {
    const bad = streamed(chunks)
    await rejects(fixture(bad.response).client.requestQrCode(), 'invalid-json', { httpStatus: 200 })
    assert.equal(bad.stream.locked, false)
  }
  const wrong = streamed(['not Uint8Array'])
  await rejects(fixture(wrong.response).client.requestQrCode(), 'invalid-response', { httpStatus: 200 })
  assert.equal(wrong.state.cancelled, 1)
})
await test('body null, body rejection and consumed or locked response fail closed', async () => {
  await rejects(fixture(new Response(null, { status: 204, headers: { 'Content-Type': 'application/json' } })).client.requestQrCode(), 'invalid-json', { httpStatus: 204 })
  const bad = streamed([bytes('{')], { failure: new Error(SECRET.password) })
  const f = fixture(bad.response)
  await rejects(f.client.requestQrCode(), 'network-error', { httpStatus: 200 })
  assert.equal(bad.stream.locked, false)
  assertClean(f.calls[0])
  const consumed = json(qrPayload())
  await consumed.text()
  await rejects(fixture(consumed).client.requestQrCode(), 'invalid-response', { httpStatus: 200 })
  const locked = json(qrPayload()), lock = locked.body.getReader()
  try { await rejects(fixture(locked).client.requestQrCode(), 'invalid-response', { httpStatus: 200 }) }
  finally { await lock.cancel(); lock.releaseLock() }
})
await test('response URL and redirect flags reject foreign origins before body reading', async () => {
  for (const url of ['https://example.invalid/private', 'http://ilinkai.weixin.qq.com', 'https://user@ilinkai.weixin.qq.com/private']) {
    const s = streamed([bytes(JSON.stringify(qrPayload()))])
    Object.defineProperty(s.response, 'url', { value: url })
    const f = fixture(s.response)
    await rejects(f.client.requestQrCode(), 'unsupported-origin')
    assert.equal(s.state.pulls, 0)
    assert.equal(s.state.cancelled, 1)
    assert.equal(f.calls.length, 1)
  }
  for (const url of ['', ORIGIN + '/ilink/bot/get_bot_qrcode']) {
    const response = json(qrPayload())
    Object.defineProperty(response, 'url', { value: url })
    await fixture(response).client.requestQrCode()
  }
  const redirect = streamed([bytes(JSON.stringify(qrPayload()))])
  Object.defineProperty(redirect.response, 'redirected', { value: true })
  await rejects(fixture(redirect.response).client.requestQrCode(), 'unsupported-redirect')
  assert.equal(redirect.state.pulls, 0)
  assert.equal(redirect.state.cancelled, 1)
  for (const [key, value] of [['url', 'not a url'], ['url', 123], ['redirected', 1], ['status', 99], ['status', 200.5]]) {
    const response = json(qrPayload())
    Object.defineProperty(response, key, { value })
    await rejects(fixture(response).client.requestQrCode(), 'invalid-response')
  }
  await rejects(fixture(Response.error()).client.requestQrCode(), 'network-error')
  await rejects(fixture({ status: 200, json() { throw new Error(SECRET.password) } }).client.requestQrCode(), 'invalid-response')
})
for (const op of OPERATIONS) await test('pre-aborted and immediately cancelled signals never dispatch: ' + op, async () => {
  const before = new AbortController(), after = new AbortController()
  before.abort(new Error(SECRET.reason))
  const f = fixture(() => json(payloadFor(op)))
  await rejects(invoke(f.client, op, before.signal), 'aborted')
  const pending = invoke(f.client, op, after.signal)
  after.abort(SECRET.reason)
  await rejects(pending, 'aborted')
  assert.equal(f.calls.length, 0)
  assert.equal(getEventListeners(before.signal, 'abort').length, 0)
  assert.equal(getEventListeners(after.signal, 'abort').length, 0)
})
for (const op of OPERATIONS) await test('fetch-phase abort ignores secret reason and consumes late rejection: ' + op, async () => {
  const external = new AbortController(), started = deferred(), late = deferred()
  const f = fixture(() => { started.resolve(); return late.promise })
  const pending = invoke(f.client, op, external.signal)
  await started.promise
  external.abort(new Error(SECRET.reason))
  await rejects(pending, 'aborted', { deliveryUnknown: op === 'send' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].init.signal.aborted, true)
  assert.notEqual(f.calls[0].init.signal.reason, external.signal.reason)
  noSecrets(String(f.calls[0].init.signal.reason))
  assertClean(f.calls[0], external.signal)
  late.reject(new Error(SECRET.password))
  await nextTurn()
})
for (const op of OPERATIONS) await test('body-phase cancellation covers stream, listener and reader cleanup: ' + op, async () => {
  const external = new AbortController()
  const cleanupFailure = Promise.reject(new Error(SECRET.password))
  void cleanupFailure.catch(() => {})
  const s = streamed([bytes('{')], { hang: true, cancelPromise: cleanupFailure })
  const f = fixture(s.response)
  const pending = invoke(f.client, op, external.signal)
  await s.pulled.promise
  external.abort(SECRET.reason)
  await rejects(pending, 'aborted', { httpStatus: 200, deliveryUnknown: op === 'send' })
  assert.equal(f.calls.length, 1)
  assert.equal(s.state.cancelled, 1)
  assert.equal(s.stream.locked, false)
  assertClean(f.calls[0], external.signal)
})
await test('late native Response after cancellation is cancelled without being read', async () => {
  const external = new AbortController(), started = deferred(), late = deferred()
  const f = fixture(() => { started.resolve(); return late.promise })
  const pending = f.client.requestQrCode(external.signal)
  await started.promise
  external.abort(SECRET.reason)
  await rejects(pending, 'aborted')
  const s = streamed([bytes(JSON.stringify(qrPayload()))])
  late.resolve(s.response)
  await nextTurn()
  assert.equal(s.state.pulls, 0)
  assert.equal(s.state.cancelled, 1)
  assertClean(f.calls[0], external.signal)
})
for (const op of OPERATIONS) await test('deadline stops an ignoring fetcher and handles its late failure: ' + op, async () => {
  const late = deferred(), external = new AbortController()
  const f = fixture(() => late.promise, { timeoutMs: 12 })
  await rejects(invoke(f.client, op, external.signal), 'timeout', { deliveryUnknown: op === 'send' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].init.signal.aborted, true)
  assertClean(f.calls[0], external.signal)
  late.reject(new Error(SECRET.password))
  await nextTurn()
})
await test('deadline covers body read and bounded cleanup never waits on hostile cancel', async () => {
  for (const cancelPromise of [undefined, new Promise(() => {})]) {
    const s = streamed([bytes('{')], { hang: true, cancelPromise })
    const external = new AbortController(), f = fixture(s.response, { timeoutMs: 12 })
    await rejects(f.client.sendText(AUTH, OUTBOUND, external.signal), 'timeout', { httpStatus: 200, deliveryUnknown: true })
    assert.equal(s.state.cancelled, 1)
    assert.equal(s.stream.locked, false)
    assertClean(f.calls[0], external.signal)
  }
})
await test('one wall-clock deadline spans fetch plus body, not one timeout per phase', async () => {
  const savedNow = Object.getOwnPropertyDescriptor(performance, 'now')
  let clock = 0
  Object.defineProperty(performance, 'now', { configurable: true, value: () => clock })
  try {
    const stream = new ReadableStream({ pull(controller) { clock = 51; controller.enqueue(bytes('{')) } }, { highWaterMark: 0 })
    const f = fixture(() => { clock = 30; return new Response(stream, { headers: { 'Content-Type': 'application/json' } }) }, { timeoutMs: 50 })
    await rejects(f.client.sendText(AUTH, OUTBOUND), 'timeout', { httpStatus: 200, deliveryUnknown: true })
    assert.equal(f.calls.length, 1)
    assert.equal(stream.locked, false)
    assertClean(f.calls[0])
  } finally { if (savedNow) Object.defineProperty(performance, 'now', savedNow); else delete performance.now }
})
await test('every finished request clears its only timer and all API-installed listeners', async () => {
  const savedSet = globalThis.setTimeout, savedClear = globalThis.clearTimeout
  const active = new Set(), delays = []
  globalThis.setTimeout = (callback, ms, ...args) => { const id = savedSet(callback, ms, ...args); active.add(id); delays.push(ms); return id }
  globalThis.clearTimeout = id => { active.delete(id); return savedClear(id) }
  try {
    for (const op of OPERATIONS) {
      for (const outcome of ['success', 'http', 'business', 'json', 'network']) {
        const controller = new AbortController()
        const f = fixture(() => {
          if (outcome === 'network') throw new Error(SECRET.password)
          if (outcome === 'http') return json({}, 403)
          if (outcome === 'business') return json({ ret: -1 })
          if (outcome === 'json') return new Response('{', { headers: { 'Content-Type': 'application/json' } })
          return json(payloadFor(op))
        })
        if (outcome === 'success') await invoke(f.client, op, controller.signal)
        else await assert.rejects(invoke(f.client, op, controller.signal), error => error instanceof api.WeixinApiError)
        assert.equal(active.size, 0)
        assertClean(f.calls[0], controller.signal)
        controller.abort(SECRET.reason)
        assert.equal(f.calls[0].init.signal.aborted, false)
      }
    }
    assert.equal(delays.length, 20)
    assert.ok(delays.every(ms => ms === 40000))
  } finally { globalThis.setTimeout = savedSet; globalThis.clearTimeout = savedClear }
})
await test('synchronous throws, rejected promises and forged API errors are freshly redacted', async () => {
  const arbitrary = new Error(SECRET.password, { cause: SECRET.token })
  arbitrary.url = SECRET.content
  const forged = new api.WeixinApiError('business-error', { httpStatus: 200, businessCode: -14 })
  for (const thrown of [arbitrary, SECRET.password, { message: SECRET.password, cause: SECRET.token }, forged]) {
    for (const fetcher of [() => { throw thrown }, async () => { throw thrown }]) {
      const client = api.createWeixinApi({ fetcher })
      await rejects(client.requestQrCode(), 'network-error')
      await rejects(client.sendText(AUTH, OUTBOUND), 'network-error', { deliveryUnknown: true })
    }
  }
})
await test('send outcome is unknown after every non-definitive response failure; no retry', async () => {
  const cases = [
    [() => new Response('{', { headers: { 'Content-Type': 'application/json' } }), 'invalid-json', 200],
    [() => new Response('<html>' + SECRET.errmsg + '</html>', { headers: { 'Content-Type': 'text/html' } }), 'invalid-json', 200],
    [() => json(null), 'invalid-response', 200],
    [() => json({ ret: '0' }), 'invalid-response', 200],
    [() => json({ ret: 0, padding: 'x'.repeat(1048576) }), 'response-too-large', 200],
    [() => { const r = json({ ret: 0 }); Object.defineProperty(r, 'redirected', { value: true }); return r }, 'unsupported-redirect', undefined],
    [() => { const r = json({ ret: 0 }); Object.defineProperty(r, 'url', { value: 'https://example.invalid' }); return r }, 'unsupported-origin', undefined],
    [() => streamed([bytes('{')], { failure: new Error(SECRET.password) }).response, 'network-error', 200],
  ]
  for (const [reply, code, httpStatus] of cases) {
    const f = fixture(reply)
    await rejects(f.client.sendText(AUTH, OUTBOUND), code, { httpStatus, deliveryUnknown: true })
    assert.equal(f.calls.length, 1)
    assertClean(f.calls[0])
  }
})
await test('body pull failure arriving after cancellation remains handled and redacted', async () => {
  const latePull = deferred(), started = deferred(), external = new AbortController()
  let cancelled = 0
  const stream = new ReadableStream({
    pull() { started.resolve(); return latePull.promise },
    cancel() { cancelled += 1 },
  }, { highWaterMark: 0 })
  const f = fixture(new Response(stream, { headers: { 'Content-Type': 'application/json' } }))
  const pending = f.client.sendText(AUTH, OUTBOUND, external.signal)
  await started.promise
  external.abort(SECRET.reason)
  await rejects(pending, 'aborted', { httpStatus: 200, deliveryUnknown: true })
  latePull.reject(new Error(SECRET.password))
  await nextTurn()
  assert.equal(cancelled, 1)
  assert.equal(stream.locked, false)
  assertClean(f.calls[0], external.signal)
})
await test('HTTP refusal cleanup rejection remains handled without reading the body', async () => {
  const cleanup = Promise.reject(new Error(SECRET.password))
  void cleanup.catch(() => {})
  const s = streamed([bytes(SECRET.errmsg)], { status: 403, cancelPromise: cleanup })
  await rejects(fixture(s.response).client.sendText(AUTH, OUTBOUND), 'http-error', { httpStatus: 403 })
  await nextTurn()
  assert.equal(s.state.cancelled, 1)
  assert.equal(s.state.pulls, 0)
})
await test('all fixtures stayed offline without touching ambient global fetch', () => { assert.equal(globalFetchTouches, 0) })
