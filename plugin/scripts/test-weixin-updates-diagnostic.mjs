// Offline: actual transport/parser/Channel with synthetic Request/Response and stores.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { getEventListeners } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { createWeixinApi, WEIXIN_UPDATE_DIAGNOSTIC } from '../lib/weixin-api.js'
import { createWeixinChannel, WeixinChannelError } from '../lib/weixin-channel.js'
import { TASK_WIRE } from '../lib/conversation-wire.js'

const originalFetch = globalThis.fetch
let ambientCalls = 0
globalThis.fetch = () => { ambientCalls++; throw new Error('Offline diagnostic forbids ambient fetch.') }
after(() => { globalThis.fetch = originalFetch; assert.equal(ambientCalls, 0) })

const SECRET = Object.freeze({ text: 'synthetic-private-message-诊断', token: 'synthetic-private-bot-token',
  context: 'synthetic-private-context-token', cursor: 'synthetic-private-old-cursor', nextCursor: 'synthetic-private-next-cursor',
  bot: 'synthetic-private-bot@im.bot', owner: 'synthetic-private-owner@im.wechat', reply: 'synthetic-private-pending-reply',
  client: 'synthetic-private-client', error: 'synthetic-private-upstream-exception', file: 'synthetic-private-pending-document.txt',
  id: '18446744073709551615', session: 'wechat-task-11111111-1111-4111-8111-111111111111' })
const AUTH = Object.freeze({ botToken: SECRET.token, botId: SECRET.bot, userId: SECRET.owner, baseUrl: 'https://ilinkai.weixin.qq.com' })
const KEYS = ['version', 'outcome', 'errorCode', 'validationField', 'msgsShape', 'cursorShape',
  'messageCount', 'textCount', 'ignoredCount', 'httpStatus', 'businessCode']
const check = (name, body) => test(name, { timeout: 3000 }, body)
const facts = (change = {}) => ({ version: 1, outcome: 'valid', errorCode: null, validationField: null,
  msgsShape: 'array', cursorShape: 'string', messageCount: 1, textCount: 1, ignoredCount: 0,
  httpStatus: 200, businessCode: null, ...change })
const unread = (change = {}) => facts({ outcome: 'failed', errorCode: 'network-error',
  msgsShape: null, cursorShape: null, messageCount: null, textCount: null, ignoredCount: null, httpStatus: null, ...change })
const invalid = (field, change = {}) => facts({ outcome: 'invalid', errorCode: 'invalid-response',
  validationField: field, textCount: null, ignoredCount: null, ...change })
const wireMessage = (change = {}) => ({ message_type: 1, message_state: 2, message_id: SECRET.id,
  from_user_id: AUTH.userId, to_user_id: AUTH.botId, context_token: SECRET.context,
  item_list: [{ type: 1, text_item: { text: SECRET.text } }], ...change })
const page = (change = {}) => ({ ret: 0, msgs: [wireMessage()], get_updates_buf: SECRET.nextCursor, ...change })
const response = (payload, options = {}) => new Response(JSON.stringify(payload), { status: 200,
  headers: { 'Content-Type': 'application/json' }, ...options })

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function noSecrets(value) {
  const text = JSON.stringify(value) + inspect(value, { showHidden: true, depth: 8 })
  for (const secret of Object.values(SECRET)) assert.equal(text.includes(secret), false)
}
function assertFacts(result, expected) {
  assert.deepEqual(Object.keys(result).sort(), [...KEYS].sort())
  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.ok(Object.isFrozen(result))
  assert.deepEqual(result, expected)
  assert.equal(TASK_WIRE.updatesDiagnosticSchema.safeParse(result).success, true)
  noSecrets(result)
}
function apiFixture(payload = page(), options = {}) {
  const calls = [], started = deferred()
  const client = createWeixinApi({ ...options, fetcher: async (url, init) => {
    calls.push({ url, init }); started.resolve()
    return typeof payload === 'function' ? payload(url, init) : response(payload)
  } })
  return { client, calls, started }
}
function requestOnly(f) {
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, AUTH.baseUrl + '/ilink/bot/getupdates')
  assert.equal(f.calls[0].init.method, 'POST')
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer ' + SECRET.token)
  assert.equal(JSON.parse(f.calls[0].init.body).get_updates_buf, SECRET.cursor)
  assert.equal(f.calls[0].init.redirect, 'error')
  assert.equal(getEventListeners(f.calls[0].init.signal, 'abort').length, 0)
}

check('diagnostic has one fixed getupdates request and eleven redacted immutable facts', async () => {
  const f = apiFixture()
  assertFacts(await f.client.diagnoseUpdatesOnce(AUTH, SECRET.cursor), facts())
  requestOnly(f)
  for (const value of Object.values(WEIXIN_UPDATE_DIAGNOSTIC)) if (Array.isArray(value)) assert.ok(Object.isFrozen(value))
})

for (const [name, payload, expected] of [
  ['omitted fields', {}, facts({ msgsShape: 'omitted', cursorShape: 'omitted', messageCount: 0, textCount: 0 })],
  ['null messages', { msgs: null }, facts({ msgsShape: 'null', cursorShape: 'omitted', messageCount: 0, textCount: 0 })],
  ['empty fields', { msgs: [], get_updates_buf: '' }, facts({ cursorShape: 'empty', messageCount: 0, textCount: 0 })],
  ['ignored message kinds', page({ msgs: [wireMessage(), wireMessage({ message_type: 2 }), wireMessage({ group_id: 'group-fixture' }),
    wireMessage({ item_list: [{ type: 2 }] })] }), facts({ messageCount: 4, ignoredCount: 3 })],
  ['exact message limit', page({ msgs: Array.from({ length: 256 }, () => wireMessage()) }), facts({ messageCount: 256, textCount: 256 })],
]) check('same parser compatibility: ' + name, async () => {
  const f = apiFixture(payload)
  assertFacts(await f.client.diagnoseUpdatesOnce(AUTH, SECRET.cursor), expected)
  requestOnly(f)
})

check('diagnostic uses the lossless uint64 JSON decoder and accepts bounded JSON without a MIME gate', async () => {
  const body = JSON.stringify(page()).replace('"message_id":"' + SECRET.id + '"', '"message_id":' + SECRET.id)
  const f = apiFixture(() => new Response(body, { headers: { 'Content-Type': 'text/plain' } }))
  assertFacts(await f.client.diagnoseUpdatesOnce(AUTH, SECRET.cursor), facts())
  requestOnly(f)
})

const malformed = [
  ['root', null, { msgsShape: null, cursorShape: null, messageCount: null }],
  ['ret', page({ ret: '0' })], ['errcode', page({ errcode: false })],
  ['msgs', page({ msgs: SECRET.error }), { msgsShape: 'other', messageCount: null }],
  ['get_updates_buf', page({ get_updates_buf: null }), { cursorShape: 'other' }],
  ['message', page({ msgs: [null] })],
  ['message_type', page({ msgs: [wireMessage({ message_type: '1' })] })],
  ['message_state', page({ msgs: [wireMessage({ message_state: '2' })] })],
  ['group_id', page({ msgs: [wireMessage({ group_id: [] })] })],
  ['item_list', page({ msgs: [wireMessage({ item_list: [] })] })],
  ['item', page({ msgs: [wireMessage({ item_list: [null] })] })],
  ['item_type', page({ msgs: [wireMessage({ item_list: [{ type: '1' }] })] })],
  ['ref_msg', page({ msgs: [wireMessage({ item_list: [{ type: 1, ref_msg: false }] })] })],
  ['text_item', page({ msgs: [wireMessage({ item_list: [{ type: 1, text_item: null }] })] })],
  ['text', page({ msgs: [wireMessage({ item_list: [{ type: 1, text_item: { text: '' } }] })] })],
  ['message_id', page({ msgs: [wireMessage({ message_id: '00' })] })],
  ['from_user_id', page({ msgs: [wireMessage({ from_user_id: SECRET.text })] })],
  ['to_user_id', page({ msgs: [wireMessage({ to_user_id: 12 })] })],
  ['context_token', page({ msgs: [wireMessage({ context_token: SECRET.text + ' ' })] })],
]
for (const [field, payload, observation] of malformed) check('actual validation boundary: ' + field, async () => {
  const f = apiFixture(payload)
  assertFacts(await f.client.diagnoseUpdatesOnce(AUTH, SECRET.cursor), invalid(field, observation))
  requestOnly(f)
  // Ordinary failures keep the exact previous public shape; field facts belong to diagnostics only.
  const ordinary = apiFixture(payload)
  await assert.rejects(ordinary.client.getUpdates(AUTH, SECRET.cursor), error => {
    assert.equal(error.code, 'invalid-response')
    assert.deepEqual(Object.keys(error).sort(), ['code', 'deliveryUnknown', 'httpStatus', 'name'])
    noSecrets(error)
    return true
  })
  requestOnly(ordinary)
})

for (const [name, payload, expected] of [
  ['oversized array', page({ msgs: Array.from({ length: 257 }, () => wireMessage()) }), invalid('msgs', { messageCount: null })],
  ['oversized cursor', page({ get_updates_buf: 'x'.repeat(65537) }), invalid('get_updates_buf')],
  ['oversized text', page({ msgs: [wireMessage({ item_list: [{ type: 1, text_item: { text: 'x'.repeat(4001) } }] })] }), invalid('text')],
  ['joined text limit', page({ msgs: [wireMessage({ item_list: [{ type: 1, text_item: { text: 'x'.repeat(2000) } },
    { type: 1, text_item: { text: 'x'.repeat(2000) } }] })] }), invalid('text')],
  ['uint64 overflow', page({ msgs: [wireMessage({ message_id: '18446744073709551616' })] }), invalid('message_id')],
  ['unpaired UTF16', page({ msgs: [wireMessage({ item_list: [{ type: 1, text_item: { text: '\ud800' } }] })] }), invalid('text')],
]) check('bounded parser failure: ' + name, async () => {
  const f = apiFixture(payload)
  assertFacts(await f.client.diagnoseUpdatesOnce(AUTH, SECRET.cursor), expected)
  requestOnly(f)
})

check('noncanonical numeric wire IDs fail the actual JSON source spelling validator', async () => {
  for (const spelling of ['1.0', '1e3']) {
    const body = JSON.stringify(page()).replace('"message_id":"' + SECRET.id + '"', '"message_id":' + spelling)
    const f = apiFixture(() => new Response(body))
    assertFacts(await f.client.diagnoseUpdatesOnce(AUTH, SECRET.cursor), invalid('message_id'))
    requestOnly(f)
  }
})

for (const [name, payload, expected, options] of [
  ['invalid transport response', () => ({ private: SECRET.error }), unread({ outcome: 'invalid', errorCode: 'invalid-response', validationField: 'http-response' })],
  ['nonobject root', () => new Response('[]'), invalid('root', { msgsShape: null, cursorShape: null, messageCount: null })],
  ['invalid JSON', () => new Response('{"private":'), unread({ outcome: 'invalid', errorCode: 'invalid-json', validationField: 'response-body', httpStatus: 200 })],
  ['invalid UTF8', () => new Response(new Uint8Array([0xff])), unread({ outcome: 'invalid', errorCode: 'invalid-json', validationField: 'response-body', httpStatus: 200 })],
  ['body byte limit', () => new Response('x'.repeat(65)), unread({ outcome: 'invalid', errorCode: 'response-too-large', validationField: 'response-body', httpStatus: 200 }), { maxResponseBytes: 64 }],
  ['HTTP rejection', () => response({ errmsg: SECRET.error }, { status: 503 }), unread({ errorCode: 'http-error', httpStatus: 503 })],
  ['business rejection', page({ ret: -14, errmsg: SECRET.error }), unread({ errorCode: 'business-error', httpStatus: 200,
    businessCode: -14, msgsShape: 'array', cursorShape: 'string', messageCount: 1 })],
  ['errcode rejection', page({ errcode: 42, errmsg: SECRET.error }), unread({ errorCode: 'business-error', httpStatus: 200,
    businessCode: 42, msgsShape: 'array', cursorShape: 'string', messageCount: 1 })],
  ['network failure', () => { throw new Error(SECRET.error) }, unread()],
]) check('single attempt with redacted failure: ' + name, async () => {
  const f = apiFixture(payload, options)
  assertFacts(await f.client.diagnoseUpdatesOnce(AUTH, SECRET.cursor), expected)
  requestOnly(f)
})

check('missing transport, invalid input and already cancelled input make zero requests', async () => {
  assertFacts(await createWeixinApi().diagnoseUpdatesOnce(AUTH, SECRET.cursor), unread({ errorCode: 'not-configured' }))
  const f = apiFixture()
  assertFacts(await f.client.diagnoseUpdatesOnce({ ...AUTH, baseUrl: 'https://example.invalid' }, SECRET.cursor), unread({ errorCode: 'unsupported-origin' }))
  assertFacts(await f.client.diagnoseUpdatesOnce(AUTH, 0), unread({ errorCode: 'invalid-input' }))
  const stop = new AbortController(); stop.abort(SECRET.error)
  assertFacts(await f.client.diagnoseUpdatesOnce(AUTH, SECRET.cursor, stop.signal), unread({ errorCode: 'aborted' }))
  assert.equal(f.calls.length, 0)
})

check('transport deadline ends once without a second request or leaked exception', async () => {
  const f = apiFixture(() => new Promise(() => {}), { timeoutMs: 25 })
  assertFacts(await f.client.diagnoseUpdatesOnce(AUTH, SECRET.cursor), unread({ errorCode: 'timeout' }))
  requestOnly(f)
})

check('transport cancellation handles late work and cleans listeners without retry', async () => {
  const late = deferred(), cancelled = deferred(), stop = new AbortController()
  const f = apiFixture(() => late.promise)
  const pending = f.client.diagnoseUpdatesOnce(AUTH, SECRET.cursor, stop.signal)
  await f.started.promise; stop.abort(SECRET.error)
  assertFacts(await pending, unread({ errorCode: 'aborted' }))
  assert.equal(getEventListeners(stop.signal, 'abort').length, 0)
  late.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve() } })))
  await cancelled.promise
  requestOnly(f)
})

const projectedMessage = () => ({ messageId: '42', fromUserId: AUTH.userId, toUserId: AUTH.botId,
  contextToken: SECRET.context, text: SECRET.text })
function stored(version = 2, phase, queued = phase !== undefined) {
  const common = { version, revision: 17, credentials: { ...AUTH }, cursor: SECRET.cursor, seenMessageIds: ['seen-previous'], pending: null }
  if (version === 1) return { ...common, ...(phase ? { pending: { messageId: '42', clientId: SECRET.client } } : {}) }
  const queue = queued ? { messages: [projectedMessage()], received: 1, replied: 0, ignored: 0, duplicates: 0 } : null
  const pending = phase === undefined ? null : version === 2
    ? { messageId: '42', clientId: SECRET.client, phase, replyText: phase === 'replying' ? null : SECRET.reply }
    : { messageId: '42', phase, parts: phase === 'replying' ? null : [
      { kind: 'text', clientId: SECRET.client, text: SECRET.reply },
      { kind: 'file', clientId: 'synthetic-media-client', reference: '76bc0fbf-0391-4998-81d8-5e2a8d4fd753',
        turn: 0, fileName: SECRET.file, bytes: 12, sha256: '0'.repeat(64) },
    ], next: phase === 'sending' ? 1 : 0 }
  return { ...common, sessionId: SECRET.session, queuedBatch: queue, pending }
}
function channelFixture({ initial = stored(), paired = true, payload = page(), diagnose, sessionId = SECRET.session, mode = initial?.version ?? 2 } = {}) {
  const originalBytes = !paired || initial === undefined ? undefined : JSON.stringify(initial, null, 2)
  let bytes = originalBytes
  const calls = { read: 0, commit: 0, diagnostic: 0, normal: 0, login: 0, reply: 0, send: 0, media: 0, observer: 0, authorize: 0 }
  const network = apiFixture(payload)
  const api = { requestQrCode() { calls.login++; throw new Error(SECRET.error) }, getQrStatus() { calls.login++; throw new Error(SECRET.error) },
    getUpdates() { calls.normal++; throw new Error(SECRET.error) }, sendText() { calls.send++; throw new Error(SECRET.error) },
    diagnoseUpdatesOnce(...args) { calls.diagnostic++; return diagnose ? diagnose(...args) : network.client.diagnoseUpdatesOnce(...args) } }
  const store = { async read() { calls.read++; return bytes === undefined ? undefined : JSON.parse(bytes) },
    async commit() { calls.commit++; bytes = SECRET.error; throw new Error(SECRET.error) } }
  const channel = createWeixinChannel({ enabled: true, api, store,
    reply() { calls.reply++; throw new Error(SECRET.error) },
    beforeSend() { calls.authorize++; return false }, onTextAccepted() { calls.observer++ },
    ...(mode === 1 ? {} : { sessionId }),
    ...(mode === 3 ? { media: { reply() { calls.media++; throw new Error(SECRET.error) },
      send() { calls.media++; throw new Error(SECRET.error) }, release() { calls.media++ } } } : {}) })
  return { channel, calls, api, store, network, unchanged() { assert.equal(bytes, originalBytes) } }
}
function noChannelEffects(f) {
  for (const name of ['commit', 'normal', 'login', 'reply', 'send', 'media', 'observer', 'authorize']) assert.equal(f.calls[name], 0, name)
  f.unchanged()
}
function channelRejects(promise, code) {
  return assert.rejects(promise, error => {
    assert.ok(error instanceof WeixinChannelError)
    assert.equal(error.code, code)
    assert.equal(error.deliveryUnknown, false)
    noSecrets(error)
    return true
  })
}

for (const [name, initial] of [
  ['legacy v1 pending', stored(1, 'pending')], ['v2 idle', stored(2)], ['v2 inbox', stored(2, undefined, true)],
  ['v2 replying', stored(2, 'replying')], ['v2 ready', stored(2, 'ready')], ['v2 sending', stored(2, 'sending')],
  ['v3 inbox', stored(3, undefined, true)], ['v3 replying', stored(3, 'replying')],
  ['v3 ready media', stored(3, 'ready')], ['v3 partly sent media', stored(3, 'sending')],
]) check('Channel keeps exact stored bytes and performs no settlement: ' + name, async () => {
  const f = channelFixture({ initial })
  assertFacts(await f.channel.diagnoseUpdatesOnce(), facts())
  assert.equal(f.calls.read, 1); assert.equal(f.calls.diagnostic, 1)
  requestOnly(f.network); noChannelEffects(f); f.channel.dispose()
})

check('Channel retains pending on actual parser and business failures', async () => {
  for (const [payload, expected] of [[page({ msgs: [wireMessage({ message_state: false })] }), invalid('message_state')],
    [page({ ret: -14 }), unread({ errorCode: 'business-error', httpStatus: 200, businessCode: -14,
      msgsShape: 'array', cursorShape: 'string', messageCount: 1 })]]) {
    const f = channelFixture({ initial: stored(3, 'sending'), payload })
    assertFacts(await f.channel.diagnoseUpdatesOnce(), expected)
    requestOnly(f.network); noChannelEffects(f); f.channel.dispose()
  }
})

check('Channel enforces missing pairing, exact session and mode before the diagnostic request', async () => {
  for (const [options, code] of [
    [{ paired: false }, 'not-paired'], [{ initial: { ...stored(), credentials: null, cursor: '', seenMessageIds: [] } }, 'not-paired'],
    [{ initial: stored(), sessionId: 'wechat-task-other' }, 'session-mismatch'], [{ initial: stored(3), mode: 2 }, 'session-mismatch'],
  ]) {
    const f = channelFixture(options)
    await channelRejects(f.channel.diagnoseUpdatesOnce(), code)
    assert.equal(f.calls.diagnostic, 0); assert.equal(f.network.calls.length, 0)
    noChannelEffects(f); f.channel.dispose()
  }
})

check('Channel checks diagnostic capability only for diagnostic actions', async () => {
  const f = channelFixture(); delete f.api.diagnoseUpdatesOnce
  assert.equal((await f.channel.getStatus()).phase, 'paired')
  const reads = f.calls.read
  await channelRejects(f.channel.diagnoseUpdatesOnce(), 'invalid-options')
  assert.equal(f.calls.read, reads); assert.equal(f.network.calls.length, 0)
  noChannelEffects(f); f.channel.dispose()
})

check('disabled and disposed diagnostic calls reject before dependency access', async () => {
  let touches = 0
  const poison = new Proxy({}, { get() { touches++; throw new Error(SECRET.error) } })
  const disabled = createWeixinChannel({ api: poison, store: poison })
  await channelRejects(disabled.diagnoseUpdatesOnce({}), 'disabled')
  disabled.dispose()
  await channelRejects(disabled.diagnoseUpdatesOnce({}), 'disposed')
  assert.equal(touches, 0)
})

check('Channel rejects noncontract facts without exposing private dependency data', async () => {
  for (const change of [
    { text: SECRET.text }, { errorCode: SECRET.error }, { validationField: SECRET.context },
    { msgsShape: 'other' }, { cursorShape: 'other' }, { messageCount: 257 }, { textCount: -1 },
    { ignoredCount: 0.5 }, { httpStatus: 600 }, { businessCode: Number.MAX_SAFE_INTEGER + 1 },
    { msgsShape: 'omitted' }, { msgsShape: 'null' },
    { outcome: 'invalid', errorCode: 'invalid-response', validationField: 'msgs', msgsShape: 'other', textCount: null, ignoredCount: null },
    { messageCount: 2 }, { outcome: 'invalid', errorCode: 'business-error', textCount: null, ignoredCount: null },
    { outcome: 'failed', errorCode: 'network-error', validationField: 'text', textCount: null, ignoredCount: null },
    { version: undefined }, { outcome: 'unknown' },
  ]) {
    const f = channelFixture({ diagnose: async () => facts(change) })
    await channelRejects(f.channel.diagnoseUpdatesOnce(), 'invalid-response')
    assert.equal(f.calls.diagnostic, 1); assert.equal(f.network.calls.length, 0)
    noChannelEffects(f); f.channel.dispose()
  }
  let touches = 0
  const hostile = facts()
  Object.defineProperty(hostile, 'validationField', { enumerable: true, get() { touches++; throw new Error(SECRET.error) } })
  const f = channelFixture({ diagnose: async () => hostile })
  await channelRejects(f.channel.diagnoseUpdatesOnce(), 'invalid-response')
  assert.equal(touches, 0); noChannelEffects(f); f.channel.dispose()
})

check('Channel serializes diagnostic with polling and status, then aborts without retry', async () => {
  const gate = deferred(), stop = new AbortController()
  const f = channelFixture({ initial: stored(3, 'sending'), payload: async () => { await gate.promise; return response(page()) } })
  const pending = f.channel.diagnoseUpdatesOnce(stop.signal)
  await f.network.started.promise
  await channelRejects(f.channel.diagnoseUpdatesOnce(), 'busy')
  await channelRejects(f.channel.pollOnce(), 'busy')
  await channelRejects(f.channel.getStatus(), 'busy')
  stop.abort(SECRET.error)
  await channelRejects(pending, 'aborted')
  gate.resolve(); await nextTurn()
  assert.equal(getEventListeners(stop.signal, 'abort').length, 0)
  assert.equal(f.calls.diagnostic, 1); requestOnly(f.network)
  noChannelEffects(f); f.channel.dispose()
})

check('Channel disposal supervises a pending diagnostic and consumes late rejection', async () => {
  const gate = deferred()
  const f = channelFixture({ payload: () => gate.promise })
  const pending = f.channel.diagnoseUpdatesOnce()
  await f.network.started.promise; f.channel.dispose()
  await channelRejects(pending, 'aborted')
  gate.reject(new Error(SECRET.error)); await nextTurn()
  await channelRejects(f.channel.diagnoseUpdatesOnce(), 'disposed')
  requestOnly(f.network); noChannelEffects(f)
})

check('Channel initial cancellation starts no store or transport work', async () => {
  const f = channelFixture(), stop = new AbortController(); stop.abort(SECRET.error)
  await channelRejects(f.channel.diagnoseUpdatesOnce(stop.signal), 'aborted')
  assert.equal(f.calls.read, 0); assert.equal(f.calls.diagnostic, 0); assert.equal(f.network.calls.length, 0)
  noChannelEffects(f); f.channel.dispose()
})
