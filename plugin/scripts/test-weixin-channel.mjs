import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as turn } from 'node:timers/promises'
import { getEventListeners } from 'node:events'
let createWeixinChannel, validateWeixinState, WeixinChannelError
const originalFetch = globalThis.fetch
let forbiddenFetches = 0
globalThis.fetch = () => { forbiddenFetches++; throw new Error('Offline test forbids global fetch.') }
after(() => { globalThis.fetch = originalFetch; assert.equal(forbiddenFetches, 0) })

// Native, entirely synthetic dependencies. The final integration case uses the real
// API module with fake fetch. No live store/DSH, credentials, database, GUI, process
// discovery, subprocess or network is used.
const SECRET = 'synthetic-private-canary'
const CREDS = Object.freeze({ botToken: 'synthetic-token-canary', botId: 'bot-fixture', userId: 'owner-fixture', baseUrl: 'https://ilinkai.weixin.qq.com' })
const OFFICIAL = ['wait', 'scaned', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect']
const clone = value => value === undefined ? undefined : structuredClone(value)
const state = (change = {}) => ({ version: 1, revision: 1, credentials: { ...CREDS }, cursor: 'cursor-old', seenMessageIds: [], pending: null, ...change })
const message = (change = {}) => ({ messageId: 'message-1', fromUserId: CREDS.userId, toUserId: CREDS.botId, contextToken: 'synthetic-context-canary', text: '完整原文 /reset\n不是命令', ...change })
function deferred() {
  let resolve, reject
  const promise = new Promise((ok, no) => { resolve = ok; reject = no })
  return { promise, resolve, reject }
}
function memory(initial) {
  let value = clone(initial)
  const calls = { read: 0, commit: [] }
  const store = {
    async read() { calls.read++; return clone(value) },
    async commit(expected, next) {
      calls.commit.push({ expected, next })
      // Atomic revision CAS in this fake; there is no await before it.
      // It deliberately allows undefined so regressions catch accidental deletion.
      if ((value?.revision ?? null) !== expected) throw new Error(SECRET)
      value = clone(next)
    },
  }
  return { store, calls, peek: () => clone(value) }
}
function fixture({ paired = true, initial = state(), api: hooks = {}, reply } = {}) {
  const db = memory(paired ? initial : undefined)
  const calls = { qr: [], status: [], updates: [], send: [], reply: [] }
  const api = {
    async requestQrCode(...args) { calls.qr.push(args); return { qrcode: 'synthetic-qr-token', qrContent: 'synthetic-qr-content' } },
    async getQrStatus(...args) { calls.status.push(args); return { status: 'confirmed', credentials: clone(CREDS) } },
    async getUpdates(...args) { calls.updates.push(args); return { cursor: 'cursor-new', messages: [message()], ignored: 0 } },
    async sendText(...args) { calls.send.push(args); return { accepted: true } },
    ...hooks,
  }
  const respond = async (...args) => { calls.reply.push(args); return reply ? reply(...args) : '完整回复-canary' }
  const make = () => createWeixinChannel({ enabled: true, api, store: db.store, reply: respond })
  return { db, calls, api, make, channel: make() }
}
function safe(error, code, unknown) {
  assert.ok(error instanceof WeixinChannelError)
  assert.equal(error.name, 'WeixinChannelError')
  assert.equal(error.code, code)
  if (unknown !== undefined) assert.equal(error.deliveryUnknown, unknown)
  assert.equal(Object.hasOwn(error, 'cause'), false)
  assert.equal(Object.hasOwn(error, 'body'), false)
  assert.equal(Object.hasOwn(error, 'token'), false)
  assert.equal(Object.hasOwn(error, 'text'), false)
  const projected = JSON.stringify(error) + error.message + error.stack
  for (const secret of [SECRET, CREDS.botToken, 'synthetic-context-canary', 'synthetic-qr-content', '完整回复-canary']) assert.equal(projected.includes(secret), false)
  return true
}
async function rejects(promise, code, unknown) {
  await assert.rejects(promise, error => safe(error, code, unknown))
}
const check = (name, fn) => test(name, { timeout: 3000 }, fn)
async function pair(f) {
  await f.channel.beginLogin()
  await f.channel.pollLogin()
  await f.channel.confirmPairing()
}

check('import and construction are inert; there is no implicit global fetch or timer', async () => {
  const original = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval }
  let touched = 0
  const poisoned = () => { touched++; throw new Error(SECRET) }
  try {
    globalThis.fetch = poisoned
    globalThis.setTimeout = poisoned
    globalThis.setInterval = poisoned
    const imported = await import('../lib/weixin-channel.js')
    ;({ createWeixinChannel, validateWeixinState, WeixinChannelError } = imported)
    const inert = imported.createWeixinChannel()
    assert.equal((await inert.getStatus()).phase, 'disabled')
    inert.dispose()
  } finally { Object.assign(globalThis, original) }
  assert.equal(touched, 0)
})

check('disabled rejects all management/IO before reading dependencies or method inputs', async () => {
  let touched = 0
  const poison = new Proxy({}, { get() { touched++; throw new Error(SECRET) } })
  const f = createWeixinChannel({ enabled: false, api: poison, store: poison, reply: () => { touched++; throw new Error(SECRET) } })
  const input = { toString() { touched++; throw new Error(SECRET) } }
  assert.deepEqual(await f.getStatus(input), { enabled: false, phase: 'disabled', hasStoredLogin: false, pendingRecovery: false, messagingVerified: false })
  for (const method of ['beginLogin', 'confirmPairing', 'cancelLogin', 'pollOnce']) await rejects(f[method](input), 'disabled', false)
  for (const method of ['pollLogin', 'discardPending', 'forget']) await rejects(f[method](input, input), 'disabled', false)
  assert.equal(touched, 0)
  f.dispose()
  await rejects(f.getStatus(), 'disposed')
})

for (const [label, options] of [
  ['null', null], ['array', []], ['function', () => {}], ['unknown', { surprise: SECRET }],
  ['wrong enabled', { enabled: 1 }], ['wrong API', { api: false }], ['wrong store', { store: [] }], ['null store', { store: null }],
  ['wrong reply', { reply: 1 }], ['wrong acceptance observer', { onTextAccepted: true }], ['symbol', { [Symbol('extra')]: 1 }],
  ['prototype', Object.create({ enabled: true })], ['hidden field', Object.defineProperty({}, 'enabled', { value: true })],
  ['accessor', Object.defineProperty({}, 'enabled', { enumerable: true, get() { throw new Error(SECRET) } })],
]) check('invalid options: ' + label, () => assert.throws(() => createWeixinChannel(options), error => safe(error, 'invalid-options', false)))

check('enabled but incomplete dependencies fail closed before input or IO', async () => {
  const f = createWeixinChannel({ enabled: true })
  for (const method of ['getStatus', 'beginLogin', 'confirmPairing', 'cancelLogin', 'pollOnce', 'pollLogin', 'discardPending', 'forget']) await rejects(f[method]({}), 'not-configured')
})
check('invalid dependency methods and throwing dependency access are sanitized', async () => {
  const f = fixture()
  delete f.api.getUpdates
  await rejects(f.channel.getStatus(), 'invalid-options')
  Object.defineProperty(f.api, 'getUpdates', { get() { throw new Error(SECRET) } })
  await rejects(f.channel.getStatus(), 'invalid-options')
  assert.equal(f.db.calls.read, 0)
  const g = fixture()
  g.db.store.commit = null
  await rejects(g.channel.getStatus(), 'invalid-options')
})
check('error constructor sanitizes code/type and exposes no raw cause', () => {
  safe(new WeixinChannelError(SECRET, SECRET), 'invalid-response', false)
  safe(new WeixinChannelError('send-failed', true), 'send-failed', true)
})

check('state validation returns a detached deep frozen pure JSON snapshot', () => {
  const input = state({ pending: { messageId: 'pending', clientId: 'client' } })
  const output = validateWeixinState(input)
  assert.deepEqual(output, input)
  for (const object of [output, output.credentials, output.seenMessageIds, output.pending]) assert.ok(Object.isFrozen(object))
  input.credentials.botToken = SECRET
  input.pending.messageId = SECRET
  input.seenMessageIds.push(SECRET)
  assert.equal(output.credentials.botToken, CREDS.botToken)
  assert.equal(output.pending.messageId, 'pending')
  assert.deepEqual(output.seenMessageIds, [])
  assert.throws(() => { output.credentials.botToken = SECRET }, TypeError)
})
check('state exact UTF8 and count limits are accepted', () => {
  const value = state({ revision: Number.MAX_SAFE_INTEGER, cursor: '中'.repeat(21845) + 'x', seenMessageIds: Array.from({ length: 4096 }, (_, i) => 'm-' + i) })
  value.credentials.botToken = 't'.repeat(8192)
  value.credentials.userId = 'u'.repeat(512)
  value.credentials.botId = 'b'.repeat(512)
  assert.equal(validateWeixinState(value).seenMessageIds.length, 4096)
  assert.equal(Buffer.byteLength(value.cursor), 65536)
})

const invalidStates = [
  ['missing', undefined], ['null', null], ['array', []], ['Date', new Date(0)],
  ['version', state({ version: 2 })], ['zero revision', state({ revision: 0 })], ['fraction revision', state({ revision: 1.1 })],
  ['unsafe revision', state({ revision: Number.MAX_SAFE_INTEGER + 1 })], ['nonfinite revision', state({ revision: Infinity })],
  ['unknown state field', state({ text: SECRET })], ['cursor UTF8 budget', state({ cursor: '中'.repeat(21846) })],
  ['cursor malformed Unicode', state({ cursor: '\ud800' })], ['seen duplicate', state({ seenMessageIds: ['x', 'x'] })],
  ['seen empty', state({ seenMessageIds: [''] })], ['seen control', state({ seenMessageIds: ['a\nb'] })],
  ['seen whitespace', state({ seenMessageIds: [' '] })], ['seen overlong', state({ seenMessageIds: ['x'.repeat(513)] })],
  ['seen holes', state({ seenMessageIds: new Array(1) })], ['seen overflow', state({ seenMessageIds: Array.from({ length: 4097 }, (_, i) => String(i)) })],
  ['pending missing', state({ pending: undefined })], ['pending missing client', state({ pending: { messageId: 'p' } })],
  ['pending extra', state({ pending: { messageId: 'p', clientId: 'c', text: SECRET } })],
  ['pending overlaps seen', state({ seenMessageIds: ['p'], pending: { messageId: 'p', clientId: 'c' } })],
  ['credentials extra', state({ credentials: { ...CREDS, token: SECRET } })],
  ['token unicode', state({ credentials: { ...CREDS, botToken: '中文' } })], ['token interior whitespace', state({ credentials: { ...CREDS, botToken: 'a b' } })],
  ['credential identifier policy', state({ credentials: { ...CREDS, userId: '中文' } })],
  ['token empty', state({ credentials: { ...CREDS, botToken: '' } })], ['token control', state({ credentials: { ...CREDS, botToken: 'a\u0000b' } })],
  ['token whitespace', state({ credentials: { ...CREDS, botToken: ' token' } })], ['token overlong', state({ credentials: { ...CREDS, botToken: 't'.repeat(8193) } })],
  ['userId overlong', state({ credentials: { ...CREDS, userId: '中'.repeat(171) } })], ['botId wrong type', state({ credentials: { ...CREDS, botId: 1 } })],
]
for (const origin of ['http://ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/', 'https://ilinkai.weixin.qq.com/path', 'https://ilinkai.weixin.qq.com?x=1', 'https://ilinkai.weixin.qq.com#x', 'https://x@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:443', 'https://other.invalid', 'https://ilinkai.weixin.qq.com.evil.invalid']) invalidStates.push(['noncanonical origin ' + origin, state({ credentials: { ...CREDS, baseUrl: origin } })])
for (const [label, value] of invalidStates) check('invalid state: ' + label, () => assert.throws(() => validateWeixinState(value), error => safe(error, 'invalid-state')))

check('state rejects accessors, symbols, extra array fields and toJSON without invoking them', () => {
  let touched = 0
  const a = state()
  Object.defineProperty(a, 'cursor', { enumerable: true, get() { touched++; return SECRET } })
  const b = state(); b[Symbol('extra')] = SECRET
  const c = state(); c.seenMessageIds.extra = SECRET
  const d = state(); d.toJSON = () => { touched++; return state() }
  const e = state(); Object.defineProperty(e.seenMessageIds, '0', { enumerable: true, get() { touched++; return 'x' } })
  for (const value of [a, b, c, d, e]) assert.throws(() => validateWeixinState(value), error => safe(error, 'invalid-state'))
  assert.equal(touched, 0)
})

check('unpaired methods fail explicitly; cancel is only local and has no IO', async () => {
  const f = fixture({ paired: false })
  assert.equal((await f.channel.getStatus()).phase, 'unpaired')
  await rejects(f.channel.pollLogin(), 'login-required')
  await rejects(f.channel.confirmPairing(), 'login-not-confirmed')
  await rejects(f.channel.pollOnce(), 'not-paired')
  await rejects(f.channel.discardPending('discard-without-retry'), 'not-paired')
  await rejects(f.channel.forget('forget-local-credentials'), 'not-paired')
  const reads = f.db.calls.read
  await f.channel.cancelLogin()
  assert.equal(f.db.calls.read, reads)
  assert.equal(f.calls.qr.length + f.calls.status.length + f.calls.send.length, 0)
})

for (const apiStatus of OFFICIAL) check('official QR status stays projected and unpersisted: ' + apiStatus, async () => {
  const f = fixture({ paired: false, api: { async getQrStatus(qrcode, code, signal) {
    assert.equal(qrcode, 'synthetic-qr-token'); assert.equal(code, 'verify-fixture'); assert.ok(signal instanceof AbortSignal)
    return apiStatus === 'confirmed' ? { status: apiStatus, credentials: clone(CREDS) } : { status: apiStatus }
  } } })
  assert.deepEqual(await f.channel.beginLogin(), { qrContent: 'synthetic-qr-content' })
  assert.equal((await f.channel.getStatus()).phase, 'qr-ready')
  await rejects(f.channel.beginLogin(), 'login-active')
  assert.deepEqual(await f.channel.pollLogin('verify-fixture'), { status: apiStatus })
  assert.equal((await f.channel.getStatus()).phase, apiStatus === 'confirmed' ? 'awaiting-confirmation' : 'qr-ready')
  assert.equal(f.db.peek(), undefined)
  assert.equal(f.db.calls.commit.length, 0)
  if (apiStatus !== 'confirmed') await rejects(f.channel.confirmPairing(), 'login-not-confirmed')
  await f.channel.cancelLogin()
  assert.equal((await f.channel.getStatus()).phase, 'unpaired')
})

check('only explicit confirmation CAS stores revision one; status has no secrets or readiness claim', async () => {
  const f = fixture({ paired: false })
  await f.channel.beginLogin(); await f.channel.pollLogin()
  assert.deepEqual(await f.channel.pollLogin(), { status: 'confirmed' })
  assert.equal(f.calls.status.length, 1)
  assert.deepEqual(await f.channel.confirmPairing(), { paired: true })
  assert.deepEqual(f.db.calls.commit.map(x => x.expected), [null])
  assert.deepEqual(f.db.peek(), state({ cursor: '' }))
  const s = await f.channel.getStatus()
  assert.deepEqual(s, { enabled: true, phase: 'paired', hasStoredLogin: true, pendingRecovery: false, messagingVerified: false })
  assert.equal(Object.isFrozen(s), true)
  await rejects(f.channel.beginLogin(), 'already-paired')
  await rejects(f.channel.pollLogin(), 'login-required')
  await rejects(f.channel.confirmPairing(), 'login-not-confirmed')
  assert.equal(f.calls.qr.length, 1)
})

check('two confirmed instances compete with null CAS: only one pairing succeeds', async () => {
  const f = fixture({ paired: false }); const other = f.make()
  await f.channel.beginLogin(); await other.beginLogin()
  await f.channel.pollLogin(); await other.pollLogin()
  const results = await Promise.allSettled([f.channel.confirmPairing(), other.confirmPairing()])
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(results.filter(x => x.status === 'rejected').length, 1)
  assert.equal(f.db.peek().revision, 1)
})

for (const value of [null, {}, { qrcode: 'q' }, { qrcode: 'q', qrContent: 'c', extra: SECRET }, { qrcode: 'q'.repeat(8193), qrContent: 'c' }, { qrcode: 'q', qrContent: 'c'.repeat(8193) }]) check('QR response rejects malformed shape or budget', async () => {
  const f = fixture({ paired: false, api: { async requestQrCode() { return value } } })
  await rejects(f.channel.beginLogin(), 'invalid-response')
  assert.equal(f.db.calls.commit.length, 0)
  assert.equal((await f.channel.getStatus()).phase, 'unpaired')
})
for (const value of [{}, { status: 'not-official' }, { status: 'wait', credentials: clone(CREDS) }, { status: 'confirmed' }, { status: 'confirmed', credentials: { ...CREDS, baseUrl: 'https://other.invalid' } }, { status: 'wait', extra: SECRET }]) check('QR status rejects unknown fields or malformed credential contract', async () => {
  const f = fixture({ paired: false, api: { async getQrStatus() { return value } } })
  await f.channel.beginLogin()
  await rejects(f.channel.pollLogin(), 'invalid-response')
  assert.equal(f.db.peek(), undefined)
})
check('verify input and signal types are validated without IO', async () => {
  const f = fixture({ paired: false })
  await f.channel.beginLogin()
  for (const input of ['', ' ', 'v'.repeat(65), 1, null, {}, 'x\ny']) await rejects(f.channel.pollLogin(input), 'invalid-input')
  await rejects(f.channel.getStatus({}), 'invalid-input')
  assert.equal(f.calls.status.length, 0)
})
check('QR/API thrown secrets are sanitized without persistence', async () => {
  const f = fixture({ paired: false, api: { requestQrCode() { throw new Error(SECRET) } } })
  await rejects(f.channel.beginLogin(), 'api-failed')
  assert.equal(f.db.peek(), undefined)
})
check('closed API error codes survive channel wrapping without raw diagnostics or retries', async () => {
  const { WeixinApiError } = await import('../lib/weixin-api.js')
  const codes = ['not-configured', 'invalid-options', 'invalid-input', 'unsupported-origin', 'unsupported-redirect',
    'network-error', 'timeout', 'aborted', 'http-error', 'business-error', 'invalid-mime', 'invalid-json', 'response-too-large', 'invalid-response']
  for (const apiErrorCode of codes) {
    let requests = 0
    const f = fixture({ paired: false, api: { requestQrCode() {
      requests++; throw new WeixinApiError(apiErrorCode, { httpStatus: 200, businessCode: -14, cause: SECRET })
    } } })
    await assert.rejects(f.channel.beginLogin(), error => {
      safe(error, 'api-failed', false)
      assert.equal(error.apiErrorCode, apiErrorCode)
      assert.deepEqual(Object.keys(error).sort(), ['apiErrorCode', 'code', 'deliveryUnknown', 'name'])
      return true
    })
    assert.equal(requests, 1)
    assert.equal(f.db.calls.commit.length, 0)
    assert.equal((await f.channel.getStatus()).phase, 'unpaired')
    f.channel.dispose()
  }
})
check('unbranded errors and non-API dependencies cannot inject an API diagnostic', async () => {
  let touched = 0
  for (const problem of [Object.assign(new Error(SECRET), { code: 'invalid-mime' }),
    { get code() { touched++; return SECRET }, get apiErrorCode() { touched++; return 'invalid-mime' } }]) {
    const f = fixture({ paired: false, api: { requestQrCode() { throw problem } } })
    await assert.rejects(f.channel.beginLogin(), error => {
      safe(error, 'api-failed', false); assert.equal(Object.hasOwn(error, 'apiErrorCode'), false); return true
    })
    f.channel.dispose()
  }
  for (const apiErrorCode of [SECRET, '__proto__', undefined, null, {}, Symbol('private')]) {
    const error = new WeixinChannelError('api-failed', false, apiErrorCode)
    safe(error, 'api-failed', false); assert.equal(Object.hasOwn(error, 'apiErrorCode'), false)
  }
  assert.equal(Object.hasOwn(new WeixinChannelError('store-failed', false, 'invalid-mime'), 'apiErrorCode'), false)
  assert.equal(touched, 0)
})
check('send API diagnostics retain delivery uncertainty and pending recovery', async () => {
  const { WeixinApiError } = await import('../lib/weixin-api.js')
  for (const deliveryUnknown of [true, false]) {
    let sends = 0
    const f = fixture({ api: { sendText() { sends++; throw new WeixinApiError('invalid-mime', { deliveryUnknown }) } } })
    await assert.rejects(f.channel.pollOnce(), error => {
      safe(error, 'send-failed', deliveryUnknown); assert.equal(error.apiErrorCode, 'invalid-mime'); return true
    })
    assert.equal(sends, 1)
    assert.equal((await f.channel.getStatus()).pendingRecovery, true)
    f.channel.dispose()
  }
})

check('only bound owner to bound bot reaches reply unchanged; duplicates and ignores are counted', async () => {
  const incoming = message()
  const f = fixture({ api: { async getUpdates() { return { cursor: 'cursor-new', messages: [incoming, message({ messageId: 'foreign', fromUserId: 'other-user' }), message({ messageId: 'other-bot', toUserId: 'another-bot' }), incoming], ignored: 2 } } } })
  assert.deepEqual(await f.channel.pollOnce(), { received: 6, replied: 1, ignored: 4, duplicates: 1 })
  assert.equal(f.calls.reply.length, 1)
  assert.equal(f.calls.reply[0][0], incoming.text)
  assert.deepEqual(f.calls.reply[0][1], { messageId: incoming.messageId })
  assert.ok(f.calls.reply[0][2] instanceof AbortSignal)
  const [creds, sent, signal] = f.calls.send[0]
  assert.deepEqual(creds, CREDS)
  assert.deepEqual(Object.keys(sent).sort(), ['clientId', 'contextToken', 'text', 'toUserId'])
  assert.equal(sent.toUserId, CREDS.userId); assert.equal(sent.contextToken, incoming.contextToken)
  assert.equal(sent.text, '完整回复-canary'); assert.ok(signal instanceof AbortSignal)
  assert.match(sent.clientId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  assert.equal(f.db.calls.commit[0].next.pending.clientId, sent.clientId)
  assert.deepEqual(f.db.calls.commit.map(x => x.expected), [1, 2, 3])
  assert.deepEqual(f.db.calls.commit.map(x => x.next.revision), [2, 3, 4])
  assert.equal(f.db.peek().cursor, 'cursor-new')
  const persisted = JSON.stringify(f.db.calls.commit)
  for (const secret of [incoming.text, incoming.contextToken, sent.text, 'synthetic-qr-content']) assert.equal(persisted.includes(secret), false)
  for (const call of f.db.calls.commit) {
    assert.ok(Object.isFrozen(call.next)); assert.ok(Object.isFrozen(call.next.credentials)); assert.ok(Object.isFrozen(call.next.seenMessageIds))
  }
  assert.notEqual(f.db.calls.commit[0].next, f.db.calls.commit[1].next)
  assert.notEqual(f.db.calls.commit[0].next.credentials, f.db.calls.commit[1].next.credentials)
  assert.equal((await f.channel.getStatus()).messagingVerified, false)
})
check('persisted duplicate is not replied or sent again; identical cursor makes no write', async () => {
  const f = fixture()
  await f.channel.pollOnce()
  const commits = f.db.calls.commit.length
  assert.deepEqual(await f.channel.pollOnce(), { received: 1, replied: 0, ignored: 0, duplicates: 1 })
  assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.send.length, 1)
  assert.equal(f.db.calls.commit.length, commits)
})
check('ignore-only and API-ignored-only successful batches may advance cursor but never call reply', async () => {
  const f = fixture({ api: { async getUpdates() { return { cursor: 'next', messages: [message({ fromUserId: 'foreign' })], ignored: 4 } } } })
  assert.deepEqual(await f.channel.pollOnce(), { received: 5, replied: 0, ignored: 5, duplicates: 0 })
  assert.equal(f.calls.reply.length, 0); assert.equal(f.calls.send.length, 0)
  assert.equal(f.db.peek().revision, 2)
})

const malformedBatches = [
  ['null', null], ['missing', {}], ['extra', { cursor: 'c', messages: [], ignored: 0, body: SECRET }],
  ['negative ignored', { cursor: 'c', messages: [], ignored: -1 }], ['fraction ignored', { cursor: 'c', messages: [], ignored: 0.5 }],
  ['unsafe ignored', { cursor: 'c', messages: [], ignored: Number.MAX_SAFE_INTEGER + 1 }],
  ['combined count', { cursor: 'c', messages: [message()], ignored: 256 }],
  ['message count', { cursor: 'c', messages: Array.from({ length: 257 }, () => message()), ignored: 0 }],
  ['aggregate bytes', { cursor: 'c', messages: Array.from({ length: 128 }, (_, i) => message({ messageId: 'm' + i, contextToken: 't'.repeat(8192) })), ignored: 0 }],
  ['cursor bytes', { cursor: 'c'.repeat(65537), messages: [], ignored: 0 }],
]
for (const [label, patch] of [
  ['id budget', { messageId: 'x'.repeat(513) }], ['blank id', { messageId: '' }], ['text type', { text: 1 }], ['empty text', { text: '' }],
  ['text UTF8 budget', { text: '中'.repeat(1334) }], ['context budget', { contextToken: 't'.repeat(8193) }],
  ['missing context', { contextToken: undefined }], ['extra group field', { groupId: 'group' }], ['extra media field', { image: {} }],
]) malformedBatches.push([label, { cursor: 'c', messages: [message(patch)], ignored: 0 }])
for (const [label, batch] of malformedBatches) check('API batch contract rejects ' + label + ' before claim or reply', async () => {
  const f = fixture({ api: { async getUpdates() { return batch } } })
  await rejects(f.channel.pollOnce(), 'invalid-response', false)
  assert.equal(f.db.calls.commit.length, 0); assert.equal(f.calls.reply.length, 0); assert.equal(f.calls.send.length, 0)
})
// Contract correction: the former blank-text rejection is now explicit accounting.
check('blank-only typed API input is ignored without claim, reply or send', async () => {
  const f = fixture({ api: { async getUpdates() { return { cursor: 'next', messages: [message({ text: '  \n' })], ignored: 0 } } } })
  try {
    assert.deepEqual(await f.channel.pollOnce(), { received: 1, replied: 0, ignored: 1, duplicates: 0 })
    assert.equal(f.calls.reply.length, 0); assert.equal(f.calls.send.length, 0)
    assert.equal(f.db.peek().cursor, 'next'); assert.equal(f.db.peek().pending, null)
  } finally { f.channel.dispose() }
})
check('entire batch is validated before any message, including malformed unauthorized input', async () => {
  const f = fixture({ api: { async getUpdates() { return { cursor: 'c', messages: [message(), message({ fromUserId: 'foreign', extra: SECRET })], ignored: 0 } } } })
  await rejects(f.channel.pollOnce(), 'invalid-response')
  assert.equal(f.calls.reply.length, 0)
})
check('exact message text byte limit succeeds unchanged', async () => {
  const text = '中'.repeat(1333) + 'x'
  const f = fixture({ api: { async getUpdates() { return { cursor: 'c', messages: [message({ text })], ignored: 0 } } }, reply: async value => value })
  assert.equal((await f.channel.pollOnce()).replied, 1)
  assert.equal(f.calls.send[0][1].text, text)
})

check('second message failure preserves its pending claim and old cursor; manual discard does not retry', async () => {
  let replies = 0
  const messages = [message(), message({ messageId: 'message-2' })]
  const f = fixture({ api: { async getUpdates() { f.calls.updates.push([]); return { cursor: 'new', messages, ignored: 0 } } }, reply: async () => { if (++replies === 2) throw new Error(SECRET); return 'first reply' } })
  await rejects(f.channel.pollOnce(), 'reply-failed', false)
  assert.equal(f.db.peek().pending.messageId, 'message-2'); assert.equal(f.db.peek().cursor, 'cursor-old')
  assert.deepEqual(f.db.peek().seenMessageIds, ['message-1']); assert.equal(f.db.peek().revision, 4)
  const projected = await f.channel.getStatus()
  assert.deepEqual(projected, { enabled: true, phase: 'recovery-required', hasStoredLogin: true, pendingRecovery: true, messagingVerified: false })
  await rejects(f.channel.pollOnce(), 'recovery-required'); assert.equal(f.calls.updates.length, 1)
  await rejects(f.channel.forget('forget-local-credentials'), 'recovery-required')
  await f.channel.discardPending('discard-without-retry')
  assert.equal(f.db.peek().cursor, 'cursor-old'); assert.equal(f.db.peek().pending, null)
  assert.deepEqual(f.db.peek().seenMessageIds, ['message-1', 'message-2'])
  assert.deepEqual(await f.channel.pollOnce(), { received: 2, replied: 0, ignored: 0, duplicates: 2 })
  assert.equal(replies, 2); assert.equal(f.calls.send.length, 1); assert.equal(f.db.peek().cursor, 'new')
})
for (const value of ['', '  \n', 1, null, {}, '中'.repeat(1334), '\ud800']) check('invalid reply retains pending without sending', async () => {
  const f = fixture({ reply: async () => value })
  await rejects(f.channel.pollOnce(), 'invalid-reply', false)
  assert.ok(f.db.peek().pending); assert.equal(f.calls.send.length, 0); assert.equal(f.db.peek().cursor, 'cursor-old')
})
for (const [label, hook, code, unknown] of [
  ['explicit rejection', async () => { throw Object.assign(new Error(SECRET), { deliveryUnknown: false }) }, 'send-failed', false],
  ['unknown rejection', async () => { throw new Error(SECRET) }, 'send-failed', true],
  ['API unknown flag', async () => { throw { deliveryUnknown: true, body: SECRET } }, 'send-failed', true],
  ['primitive rejection', async () => { throw SECRET }, 'send-failed', true],
  ['malformed error descriptor', async () => { throw new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(SECRET) } }) }, 'send-failed', true],
  ['accepted false', async () => ({ accepted: false }), 'invalid-response', true],
  ['accepted missing', async () => ({}), 'invalid-response', true],
  ['accepted extra field', async () => ({ accepted: true, body: SECRET }), 'invalid-response', true],
]) check('send ' + label + ' never retries or clears pending', async () => {
  let sends = 0
  const f = fixture({ api: { async sendText(...args) { sends++; return hook(...args) } } })
  await rejects(f.channel.pollOnce(), code, unknown)
  await rejects(f.channel.pollOnce(), 'recovery-required')
  assert.equal(f.db.peek().cursor, 'cursor-old'); assert.ok(f.db.peek().pending)
  assert.equal(sends, 1); assert.equal(f.calls.reply.length, 1)
})

check('manual recovery and forget require exact literals; no coercion or side effects', async () => {
  const f = fixture({ initial: state({ pending: { messageId: 'pending', clientId: 'client' } }) })
  const inputs = [undefined, true, 'discard', 'forget', {}, { toString() { throw new Error(SECRET) } }]
  for (const value of inputs) {
    await rejects(f.channel.discardPending(value), 'invalid-input')
    await rejects(f.channel.forget(value), 'invalid-input')
  }
  assert.equal(f.db.calls.read, 0); assert.equal(f.db.calls.commit.length, 0)
  await rejects(f.channel.forget('forget-local-credentials'), 'recovery-required')
  await f.channel.discardPending('discard-without-retry')
  await rejects(f.channel.discardPending('discard-without-retry'), 'no-pending')
  await f.channel.forget('forget-local-credentials')
  assert.deepEqual(f.db.peek(), state({ revision: 3, credentials: null, cursor: '' }))
  assert.deepEqual(f.db.calls.commit.map(c => c.expected), [1, 2])
  assert.deepEqual(f.db.calls.commit[1].next, f.db.peek())
  assert.equal((await f.channel.getStatus()).phase, 'unpaired')
  assert.equal(f.calls.send.length + f.calls.status.length + f.calls.qr.length, 0)
  await pair(f)
  assert.equal((await f.channel.getStatus()).phase, 'paired')
})
check('manual discard FIFO retains at most 4096 IDs and never advances cursor', async () => {
  const seen = Array.from({ length: 4096 }, (_, i) => 'old-' + i)
  const f = fixture({ initial: state({ seenMessageIds: seen, pending: { messageId: 'pending', clientId: 'client' } }) })
  await f.channel.discardPending('discard-without-retry')
  assert.deepEqual(f.db.peek().seenMessageIds, [...seen.slice(1), 'pending'])
  assert.equal(f.db.peek().cursor, 'cursor-old')
  assert.equal(f.calls.reply.length, 0)
})

check('bad stored state and read exceptions stop before API or reply', async () => {
  const f = fixture()
  f.db.store.read = async () => { throw new Error(SECRET) }
  await rejects(f.channel.pollOnce(), 'store-failed')
  f.db.store.read = async () => state({ credentials: { ...CREDS, botToken: '' } })
  await rejects(f.channel.pollOnce(), 'invalid-state')
  assert.equal(f.calls.updates.length, 0)
})
check('failed claim write never invokes reply or send', async () => {
  const f = fixture(); f.db.store.commit = async () => { throw new Error(SECRET) }
  await rejects(f.channel.pollOnce(), 'store-outcome-unknown', false)
  assert.equal(f.calls.reply.length, 0); assert.equal(f.calls.send.length, 0)
  assert.equal(f.db.peek().revision, 1)
})
check('unexpected commit result is unknown and prevents reply even if the write applied', async () => {
  const f = fixture(); const commit = f.db.store.commit
  f.db.store.commit = async (...args) => { await commit(...args); return SECRET }
  await rejects(f.channel.pollOnce(), 'store-outcome-unknown', false)
  assert.ok(f.db.peek().pending); assert.equal(f.calls.reply.length, 0)
})
check('failure finalizing accepted send retains pending and does not advance cursor', async () => {
  const f = fixture(); const commit = f.db.store.commit
  f.db.store.commit = async (expected, next) => { if (expected === 2) throw new Error(SECRET); return commit(expected, next) }
  await rejects(f.channel.pollOnce(), 'store-outcome-unknown', true)
  assert.ok(f.db.peek().pending); assert.equal(f.db.peek().cursor, 'cursor-old'); assert.equal(f.calls.send.length, 1)
  await rejects(f.channel.pollOnce(), 'recovery-required')
})
check('failed cursor write does not erase seen evidence or repeat successful send', async () => {
  const f = fixture(); const commit = f.db.store.commit
  f.db.store.commit = async (expected, next) => { if (next?.cursor === 'cursor-new') throw new Error(SECRET); return commit(expected, next) }
  await rejects(f.channel.pollOnce(), 'store-outcome-unknown', false)
  assert.deepEqual(f.db.peek().seenMessageIds, ['message-1']); assert.equal(f.db.peek().pending, null)
  f.db.store.commit = commit
  assert.equal((await f.channel.pollOnce()).duplicates, 1)
  assert.equal(f.calls.send.length, 1)
})
for (const revision of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1]) check('revision exhaustion reserves completion space before claim', async () => {
  const f = fixture({ initial: state({ revision }) })
  await rejects(f.channel.pollOnce(), 'revision-exhausted')
  assert.equal(f.db.calls.commit.length, 0); assert.equal(f.calls.reply.length, 0)
})
check('cloned read snapshot and new frozen commits cannot be mutated by subsequent input edits', async () => {
  const original = state()
  const f = fixture({ api: { async getUpdates(creds) {
    assert.ok(Object.isFrozen(creds)); original.credentials.userId = 'foreign'; original.cursor = SECRET
    return { cursor: 'next', messages: [message()], ignored: 0 }
  } } })
  f.db.store.read = async () => original
  await f.channel.pollOnce()
  assert.equal(f.db.peek().credentials.userId, CREDS.userId)
  assert.equal(f.db.calls.commit[0].next.cursor, 'cursor-old')
  assert.equal(original.revision, 1)
})

check('same instance rejects busy without unbounded queue; abort releases the local operation', async () => {
  const gate = deferred(), started = deferred(), controller = new AbortController()
  const f = fixture({ api: { getUpdates() { started.resolve(); return gate.promise } } })
  const running = f.channel.pollOnce(controller.signal)
  await started.promise
  await rejects(f.channel.pollOnce(), 'busy'); await rejects(f.channel.getStatus(), 'busy'); await rejects(f.channel.cancelLogin(), 'busy')
  controller.abort(SECRET)
  await rejects(running, 'aborted', false)
  gate.reject(new Error(SECRET)); await turn()
  assert.equal((await f.channel.getStatus()).phase, 'paired')
  assert.equal(f.calls.reply.length, 0)
})
check('two instances CAS-claim the same message; exactly one reply and send occurs', async () => {
  const gate = deferred(), started = deferred()
  const f = fixture({ reply: async () => { started.resolve(); return gate.promise } }); const other = f.make()
  const first = f.channel.pollOnce(), second = other.pollOnce()
  // Attach rejection handlers immediately, before the losing claim can reject.
  const results = Promise.allSettled([first, second])
  await started.promise
  assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.send.length, 0)
  gate.resolve('one response')
  const settled = await results
  assert.equal(settled.filter(x => x.status === 'fulfilled').length, 1)
  const failure = settled.find(x => x.status === 'rejected')
  safe(failure.reason, 'store-outcome-unknown', false)
  assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.send.length, 1)
})
check('signal validation rejects spoofed brands and does not execute input accessors', async () => {
  const f = fixture()
  const proxy = new Proxy({}, { getPrototypeOf() { throw new Error(SECRET) } })
  const spoof = Object.create(AbortSignal.prototype)
  await rejects(f.channel.getStatus(proxy), 'invalid-input')
  await rejects(f.channel.getStatus(spoof), 'invalid-input')
  const controller = new AbortController()
  Object.defineProperty(controller.signal, 'aborted', { get() { throw new Error(SECRET) } })
  controller.signal.addEventListener = () => { throw new Error(SECRET) }
  controller.signal.removeEventListener = () => { throw new Error(SECRET) }
  assert.equal((await f.channel.getStatus(controller.signal)).phase, 'paired')
  controller.abort(SECRET)
  await rejects(f.channel.getStatus(controller.signal), 'aborted')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
check('pre-aborted calls touch no store or API and never propagate abort reason', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort(new Error(SECRET))
  await rejects(f.channel.pollOnce(controller.signal), 'aborted', false)
  assert.equal(f.db.calls.read, 0); assert.equal(f.calls.updates.length, 0)
})
check('caller abort listeners are removed on success, failure and cancellation', async () => {
  const f = fixture(), controller = new AbortController(), signal = controller.signal
  assert.equal(getEventListeners(signal, 'abort').length, 0)
  await f.channel.getStatus(signal)
  assert.equal(getEventListeners(signal, 'abort').length, 0)
  await rejects(f.channel.beginLogin(signal), 'already-paired')
  assert.equal(getEventListeners(signal, 'abort').length, 0)
  await f.channel.pollOnce(signal)
  for (const args of f.calls.updates) assert.equal(getEventListeners(args[2], 'abort').length, 0)
  controller.abort(SECRET)
  await rejects(f.channel.getStatus(signal), 'aborted')
  assert.equal(getEventListeners(signal, 'abort').length, 0)
})
check('aborted QR request ignores late fulfillment and clears listeners without saving login', async () => {
  const gate = deferred(), started = deferred(), controller = new AbortController()
  const f = fixture({ paired: false, api: { requestQrCode() { started.resolve(); return gate.promise } } })
  const operation = f.channel.beginLogin(controller.signal)
  await started.promise; controller.abort(SECRET)
  await rejects(operation, 'aborted', false)
  gate.resolve({ qrcode: 'late', qrContent: 'late' }); await turn()
  assert.equal((await f.channel.getStatus()).phase, 'unpaired'); assert.equal(f.db.calls.commit.length, 0)
})
check('abort after reply but before send leaves claim and starts no send', async () => {
  const controller = new AbortController()
  const f = fixture({ reply: async () => { controller.abort(SECRET); return 'unused response' } })
  await rejects(f.channel.pollOnce(controller.signal), 'aborted', false)
  assert.equal(f.calls.send.length, 0); assert.ok(f.db.peek().pending)
})
check('send already started then cancelled is delivery-unknown; late rejection is handled and never retried', async () => {
  const gate = deferred(), started = deferred(), controller = new AbortController()
  let sends = 0
  const f = fixture({ api: { sendText() { sends++; started.resolve(); return gate.promise } } })
  const operation = f.channel.pollOnce(controller.signal)
  await started.promise; controller.abort(new Error(SECRET))
  await rejects(operation, 'aborted', true)
  assert.ok(f.db.peek().pending); assert.equal(f.db.peek().cursor, 'cursor-old')
  gate.reject(new Error(SECRET)); await turn()
  await rejects(f.channel.pollOnce(), 'recovery-required')
  assert.equal(sends, 1); assert.equal(f.calls.reply.length, 1)
})
check('late accepted send after cancellation causes no completion write or cursor advance', async () => {
  const gate = deferred(), started = deferred(), controller = new AbortController()
  const f = fixture({ api: { sendText() { started.resolve(); return gate.promise } } })
  const operation = f.channel.pollOnce(controller.signal)
  await started.promise; controller.abort()
  await rejects(operation, 'aborted', true)
  gate.resolve({ accepted: true }); await turn()
  assert.equal(f.db.calls.commit.length, 1); assert.ok(f.db.peek().pending)
  await f.channel.discardPending('discard-without-retry')
  assert.equal((await f.channel.pollOnce()).duplicates, 1)
  assert.equal(f.calls.reply.length, 1)
})
check('aborted in-flight commit may already have applied; report unknown with durable pending and no compensation', async () => {
  const gate = deferred(), started = deferred(), controller = new AbortController()
  const f = fixture(), commit = f.db.store.commit
  f.db.store.commit = async (...args) => { await commit(...args); started.resolve(); return gate.promise }
  const operation = f.channel.pollOnce(controller.signal)
  await started.promise; controller.abort(SECRET)
  await rejects(operation, 'store-outcome-unknown', false)
  assert.ok(f.db.peek().pending); assert.equal(f.db.calls.commit.length, 1); assert.equal(f.calls.reply.length, 0)
  gate.reject(new Error(SECRET)); await turn()
  assert.equal((await f.channel.getStatus()).phase, 'recovery-required')
})
check('aborted in-flight commit can apply later without any later reply or send', async () => {
  const gate = deferred(), started = deferred(), controller = new AbortController()
  const f = fixture(), commit = f.db.store.commit
  f.db.store.commit = async (...args) => { started.resolve(); await gate.promise; return commit(...args) }
  const operation = f.channel.pollOnce(controller.signal)
  await started.promise; controller.abort()
  await rejects(operation, 'store-outcome-unknown', false)
  assert.equal(f.db.peek().pending, null)
  gate.resolve(); await turn()
  assert.ok(f.db.peek().pending); assert.equal(f.calls.reply.length + f.calls.send.length, 0)
})
check('dispose cancels uncooperative local IO, handles late reject, preserves store and rejects every method', async () => {
  const gate = deferred(), started = deferred()
  const f = fixture({ reply: async () => { started.resolve(); return gate.promise } })
  const operation = f.channel.pollOnce()
  await started.promise; f.channel.dispose(); f.channel.dispose()
  await rejects(operation, 'aborted', false)
  gate.reject(new Error(SECRET)); await turn()
  assert.ok(f.db.peek().pending); assert.equal(f.calls.send.length, 0)
  for (const method of ['getStatus', 'beginLogin', 'pollLogin', 'confirmPairing', 'cancelLogin', 'pollOnce', 'discardPending', 'forget']) await rejects(f.channel[method](), 'disposed')
})
check('dispose discards transient confirmed credentials without writing or remote logout', async () => {
  const f = fixture({ paired: false })
  await f.channel.beginLogin(); await f.channel.pollLogin(); f.channel.dispose()
  assert.equal(f.db.peek(), undefined); assert.equal(f.db.calls.commit.length, 0)
  await rejects(f.channel.confirmPairing(), 'disposed')
})

// Lead integration regressions: these initially fail against the frozen author version.
check('empty-credential tombstone is a valid frozen unpaired record', () => {
  const input = state({ revision: 2, credentials: null, cursor: '' })
  const output = validateWeixinState(input)
  assert.deepEqual(output, input)
  assert.equal(output.credentials, null)
  assert.ok(Object.isFrozen(output)); assert.ok(Object.isFrozen(output.seenMessageIds))
})
for (const changes of [{ cursor: 'old' }, { seenMessageIds: ['old'] }, { pending: { messageId: 'old', clientId: 'client' } }]) {
  check('unpaired tombstone rejects retained cursor/seen/pending payload', () => {
    assert.throws(() => validateWeixinState(state({ credentials: null, cursor: '', ...changes })), error => safe(error, 'invalid-state'))
  })
}
check('forget/re-pair preserves monotonically increasing revisions and does not delete', async () => {
  const f = fixture()
  await f.channel.forget('forget-local-credentials')
  assert.deepEqual(f.db.peek(), state({ revision: 2, credentials: null, cursor: '' }))
  assert.deepEqual(await f.channel.getStatus(), { enabled: true, phase: 'unpaired', hasStoredLogin: false, pendingRecovery: false, messagingVerified: false })
  await rejects(f.channel.pollOnce(), 'not-paired')
  await rejects(f.channel.discardPending('discard-without-retry'), 'not-paired')
  await rejects(f.channel.forget('forget-local-credentials'), 'not-paired')
  await pair(f)
  assert.equal(f.db.peek().revision, 3)
  assert.deepEqual(f.db.calls.commit.map(c => c.expected), [1, 2])
  assert.ok(f.db.calls.commit.every(c => c.next !== undefined))
})
check('stale pre-claim poll cannot win CAS after forget/re-pair ABA window', async () => {
  const gate = deferred(), started = deferred()
  const f = fixture({ api: { async getUpdates() { started.resolve(); return gate.promise } } })
  const pending = f.channel.pollOnce().then(value => ({ value }), error => ({ error }))
  await started.promise
  const replacement = f.make()
  await replacement.forget('forget-local-credentials')
  await replacement.beginLogin(); await replacement.pollLogin(); await replacement.confirmPairing()
  gate.resolve({ cursor: 'cursor-new', messages: [message()], ignored: 0 })
  const outcome = await pending
  assert.ok(outcome.error, 'stale worker must not send after the account generation changed')
  safe(outcome.error, 'store-outcome-unknown', false)
  assert.equal(f.db.peek().revision, 3)
  assert.equal(f.db.peek().pending, null)
  assert.equal(f.calls.reply.length + f.calls.send.length, 0)
  replacement.dispose(); f.channel.dispose()
})
check('forget and re-pair reject revision exhaustion rather than resetting it', async () => {
  const f = fixture({ initial: state({ revision: Number.MAX_SAFE_INTEGER }) })
  await rejects(f.channel.forget('forget-local-credentials'), 'revision-exhausted')
  assert.equal(f.db.calls.commit.length, 0)
  const g = fixture({ initial: state({ revision: Number.MAX_SAFE_INTEGER, credentials: null, cursor: '' }) })
  await g.channel.beginLogin(); await g.channel.pollLogin()
  await rejects(g.channel.confirmPairing(), 'revision-exhausted')
  assert.equal(g.db.calls.commit.length, 0)
})
check('real API projection composes through redirect, canonical confirmed and explicit pairing', async () => {
  const { createWeixinApi } = await import('../lib/weixin-api.js')
  const db = memory(undefined), requests = []
  let statusCalls = 0
  const api = createWeixinApi({ fetcher: async (url, init) => {
    requests.push({ url, method: init.method })
    let body
    if (url.includes('/get_bot_qrcode?')) body = { qrcode: 'synthetic-qr-token', qrcode_img_content: 'synthetic-display' }
    else if (url.includes('/get_qrcode_status?')) {
      body = statusCalls++ === 0 ? { status: 'scaned_but_redirect', redirect_host: 'ilinkai.weixin.qq.com' }
        : { status: 'confirmed', bot_token: CREDS.botToken, ilink_bot_id: CREDS.botId, ilink_user_id: CREDS.userId, baseurl: CREDS.baseUrl + '/' }
    } else throw new Error('Unexpected synthetic request')
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  } })
  const channel = createWeixinChannel({ enabled: true, api, store: db.store, reply: async () => { throw new Error('Reply must not run during login') } })
  assert.deepEqual(await channel.beginLogin(), { qrContent: 'synthetic-display' })
  assert.deepEqual(await channel.pollLogin(), { status: 'scaned_but_redirect' })
  assert.equal(db.peek(), undefined)
  assert.deepEqual(await channel.pollLogin(), { status: 'confirmed' })
  assert.equal(db.peek(), undefined)
  await channel.confirmPairing()
  assert.equal(db.peek().credentials.baseUrl, CREDS.baseUrl)
  assert.equal((await channel.getStatus()).messagingVerified, false)
  assert.equal(requests.length, 3)
  channel.dispose()
})
for (const value of [{ status: 'scaned_but_redirect', redirectHost: 'https://other.invalid' }, { status: 'wait', redirectHost: CREDS.baseUrl }]) {
  check('redirect metadata is accepted only on its official status and origin', async () => {
    const f = fixture({ paired: false, api: { async getQrStatus() { return value } } })
    await f.channel.beginLogin(); await rejects(f.channel.pollLogin(), 'invalid-response')
    assert.equal(f.db.peek(), undefined)
  })
}

// Producer/consumer-domain regressions from the non-author core review.
// Real API parser plus synthetic native HTTP objects; never real Weixin traffic.
const wireText = (id, text, contextToken = 'synthetic-context') => ({
  message_id: id, from_user_id: CREDS.userId, to_user_id: CREDS.botId,
  message_type: 1, message_state: 2, context_token: contextToken,
  item_list: [{ type: 1, text_item: { text } }],
})
async function composedFixture(msgs) {
  const { createWeixinApi } = await import('../lib/weixin-api.js')
  const db = memory(state()), sent = [], replied = []
  const api = createWeixinApi({ fetcher: async (input, init) => {
    const request = new Request(input, init)
    let body
    if (new URL(request.url).pathname === '/ilink/bot/getupdates') {
      body = { ret: 0, msgs, get_updates_buf: 'cursor-composed' }
    } else if (new URL(request.url).pathname === '/ilink/bot/sendmessage') {
      assert.notEqual(db.peek().pending, null)
      sent.push(await request.json()); body = { ret: 0 }
    } else throw new Error('Unexpected synthetic request')
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  } })
  const channel = createWeixinChannel({ enabled: true, api, store: db.store,
    reply: async text => { replied.push(text); return 'synthetic-reply' } })
  return { channel, db, sent, replied }
}
for (const [label, qrcode] of [
  ['embedded space', 'synthetic qr token'],
  ['encoded delimiters and control', 'qr=&?#\n\u0000value'],
  ['boundary Unicode whitespace', '\u3000qr-value\ufeff'],
]) check('real API qrcode survives exact query encoding: ' + label, async () => {
  const { createWeixinApi } = await import('../lib/weixin-api.js')
  const db = memory(undefined), observed = []
  const api = createWeixinApi({ fetcher: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    assert.equal(url.origin, CREDS.baseUrl)
    const body = url.pathname === '/ilink/bot/get_bot_qrcode'
      ? { qrcode, qrcode_img_content: 'synthetic-display' }
      : (observed.push(url.searchParams.get('qrcode')), { status: 'wait' })
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  } })
  const channel = createWeixinChannel({ enabled: true, api, store: db.store,
    reply: async () => { throw new Error('No DSH reply during QR polling') } })
  try {
    assert.deepEqual(await channel.beginLogin(), { qrContent: 'synthetic-display' })
    assert.deepEqual(await channel.pollLogin(), { status: 'wait' })
    assert.deepEqual(observed, [qrcode]); assert.equal(db.peek(), undefined)
  } finally { channel.dispose() }
})
for (const [label, token] of [
  ['ideographic trailing', 'context\u3000'], ['NBSP leading', '\u00a0context'],
  ['BOM and line separator', '\ufeffcontext\u2028'], ['Unicode spacing', '\u2000context\u200a'],
]) check('real API context token is opaque JSON, not a trimmed header: ' + label, async () => {
  const f = await composedFixture([wireText(1, 'synthetic input', token)])
  try {
    assert.deepEqual(await f.channel.pollOnce(), { received: 1, replied: 1, ignored: 0, duplicates: 0 })
    assert.equal(f.sent[0].msg.context_token, token)
    assert.equal(f.db.peek().cursor, 'cursor-composed'); assert.equal(f.db.peek().pending, null)
  } finally { f.channel.dispose() }
})
check('context token ASCII whitespace and controls remain invalid at the channel boundary', async () => {
  for (const token of ['context value', '\tcontext', 'context\n', 'context\u007f']) {
    const f = fixture({ api: { async getUpdates() { return { cursor: 'next', messages: [message({ contextToken: token })], ignored: 0 } } } })
    try { await rejects(f.channel.pollOnce(), 'invalid-response'); assert.equal(f.db.calls.commit.length, 0) }
    finally { f.channel.dispose() }
  }
})
check('blank-only real API messages are explicitly ignored with cursor progress, not claimed', async () => {
  const f = await composedFixture([wireText(1, ' \t\n'), wireText(2, '\u3000\ufeff')])
  try {
    assert.deepEqual(await f.channel.pollOnce(), { received: 2, replied: 0, ignored: 2, duplicates: 0 })
    assert.deepEqual(f.replied, []); assert.deepEqual(f.sent, [])
    assert.equal(f.db.peek().cursor, 'cursor-composed'); assert.equal(f.db.peek().pending, null)
    assert.ok(f.db.calls.commit.every(call => call.next.pending === null))
  } finally { f.channel.dispose() }
})
check('a blank item does not block the legitimate text later in the same real API batch', async () => {
  const text = '  useful text preserved exactly\n', f = await composedFixture([wireText(1, '\u3000'), wireText(2, text)])
  try {
    assert.deepEqual(await f.channel.pollOnce(), { received: 2, replied: 1, ignored: 1, duplicates: 0 })
    assert.deepEqual(f.replied, [text]); assert.equal(f.sent.length, 1)
    assert.deepEqual(f.db.peek().seenMessageIds, ['2']); assert.equal(f.db.peek().pending, null)
  } finally { f.channel.dispose() }
})
