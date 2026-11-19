import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setImmediate as turn } from 'node:timers/promises'

// Wholly synthetic component/property tests. No live Credentials, native Session,
// model loop, QR scanner, WeChat file, profile, browser, server or business HTTP.
const originalFetch = globalThis.fetch
let forbiddenFetches = 0
const unhandled = []
const onUnhandled = error => unhandled.push(error)
globalThis.fetch = () => { forbiddenFetches++; throw new Error('Offline test forbids global fetch.') }
process.on('unhandledRejection', onUnhandled)
after(() => {
  globalThis.fetch = originalFetch
  process.off('unhandledRejection', onUnhandled)
  assert.equal(forbiddenFetches, 0)
  assert.deepEqual(unhandled, [])
})
const { createWeixinChannel, validateWeixinState } = await import('../lib/weixin-channel.js')
const { createWeixinCredentialStore, createWeixinSessionCredentialStore } = await import('../lib/weixin-dsh.js')
const SECRET = 'SYNTHETIC_PRIVATE_CANARY'
const SID = 'wechat-native-ro-11111111-1111-4111-8111-111111111111'
const OTHER_SID = 'wechat-native-ro-22222222-2222-4222-8222-222222222222'
const CREDS = Object.freeze({ botToken: SECRET, botId: 'bot-fixture', userId: 'scanner-owner', baseUrl: 'https://ilinkai.weixin.qq.com' })
const OFFICIAL = ['wait', 'scaned', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect']
const clone = value => value === undefined ? undefined : structuredClone(value)
const message = (id = 'message-a', change = {}) => ({ messageId: id, fromUserId: CREDS.userId,
  toUserId: CREDS.botId, contextToken: `context-${id}`, text: `完整原文 /reset\n${id}`, ...change })
const queued = (messages, change = {}) => ({ messages, received: messages.length, replied: 0, ignored: 0, duplicates: 0, ...change })
const paired = (change = {}) => ({ version: 2, revision: 10, sessionId: SID, credentials: { ...CREDS },
  cursor: 'cursor-old', seenMessageIds: [], pending: null, queuedBatch: null, ...change })
function withPending(phase, messages = [message()]) {
  return paired({ cursor: 'cursor-next', queuedBatch: queued(messages), pending: {
    messageId: messages[0].messageId, clientId: 'client-stable', phase,
    replyText: phase === 'replying' ? null : '已持久化完整回复',
  } })
}
const errorCode = code => error => {
  assert.equal(error.code, code)
  // Existing ChannelError protects structured fields, not the entire Error/stack.
  assert.equal(Object.getOwnPropertyDescriptor(error, 'code').writable, false)
  assert.ok(!error.message.includes(SECRET))
  assert.equal(Object.hasOwn(error, 'cause'), false)
  return true
}
const phaseOf = state => state.pending?.phase ?? (state.queuedBatch ? 'inbox' : 'complete')
function memory(initial, events = []) {
  let value = clone(initial)
  const mem = { reads: 0, mutations: [], hooks: {}, snapshot: () => clone(value) }
  mem.store = {
    async read() { mem.reads++; return clone(value) },
    async commit(expected, next) {
      if (mem.hooks.before) await mem.hooks.before(expected, next)
      if ((value?.revision ?? null) !== expected) throw new Error(SECRET)
      value = clone(next)
      mem.mutations.push(clone(next))
      events.push(`commit:${phaseOf(next)}`)
      if (mem.hooks.after) await mem.hooks.after(expected, next)
    },
  }
  return mem
}
function fixture(options = {}) {
  const events = []
  const mem = options.mem ?? memory(Object.hasOwn(options, 'initial') ? options.initial : paired(), events)
  const sid = Object.hasOwn(options, 'sessionId') ? options.sessionId : SID
  const permission = { allowed: true }
  const calls = { qr: 0, login: 0, poll: 0, reply: 0, send: 0, guard: 0 }
  const f = { events, mem, sid, permission, calls, native: [], sent: [], pollCursors: [] }
  const api = {
    async requestQrCode() { calls.qr++; return { qrcode: SECRET, qrContent: `https://example.invalid/${SECRET}` } },
    async getQrStatus() {
      calls.login++
      const status = options.status ?? 'confirmed'
      return status === 'confirmed' ? { status, credentials: { ...CREDS } } : { status }
    },
    async getUpdates(credentials, cursor) {
      calls.poll++
      f.pollCursors.push(cursor)
      assert.deepEqual(credentials, CREDS)
      return options.batch ?? { cursor: 'cursor-next', messages: [], ignored: 0 }
    },
    async sendText(credentials, request, signal) {
      calls.send++
      assert.deepEqual(credentials, CREDS)
      assert.equal(request.toUserId, CREDS.userId)
      const stored = mem.snapshot()
      if (stored.version === 2) {
        assert.equal(stored.pending.phase, 'sending')
        assert.equal(request.clientId, stored.pending.clientId)
        assert.equal(request.text, stored.pending.replyText)
        assert.equal(request.contextToken, stored.queuedBatch.messages[0].contextToken)
      }
      f.sent.push(clone(request))
      events.push(`send:${stored.pending.messageId}`)
      if (options.onSend) return options.onSend(request, signal)
      return { accepted: true } // Request acceptance ONLY; not a delivery receipt.
    },
  }
  const reply = async (text, metadata, signal) => {
    calls.reply++
    assert.ok(Object.isFrozen(metadata))
    assert.deepEqual(Object.keys(metadata), ['messageId'])
    const stored = mem.snapshot()
    assert.equal(stored.pending.messageId, metadata.messageId)
    if (stored.version === 2) assert.equal(stored.pending.phase, 'replying')
    f.native.push({ sessionId: sid, text, messageId: metadata.messageId })
    // Stand-ins for Root's input/output flush barriers, NOT actual native I/O.
    events.push('native-input-flush-stand-in')
    const output = options.onReply ? await options.onReply(text, metadata, signal) : `回复:${metadata.messageId}\n完整内容`
    events.push('native-output-flush-stand-in')
    return output
  }
  const beforeSend = () => {
    calls.guard++
    events.push(`guard:${mem.snapshot()?.pending?.phase}`)
    return options.guard ? options.guard(mem, permission, calls) : permission.allowed
  }
  f.api = api
  f.reply = reply
  f.beforeSend = beforeSend
  f.channel = createWeixinChannel({ enabled: true, sessionId: sid, api, store: mem.store, reply, beforeSend })
  return f
}

// Required literal protocol changes: scanner owner, not first inbound peer;
// no typing-ticket fallback. Existing API/TLS/projection tests are kept intact.
test('owner projections are explicit, frozen and credential-free for every QR status; v1 output stays compatible', async () => {
  for (const sessionId of [undefined, SID]) for (const status of OFFICIAL) {
    const f = fixture({ initial: undefined, sessionId, status })
    assert.deepEqual(f.calls, { qr: 0, login: 0, poll: 0, reply: 0, send: 0, guard: 0 })
    await f.channel.beginLogin()
    const legacy = await f.channel.pollLogin()
    const projected = await f.channel.pollLoginForOwner()
    const owner = { status: 'confirmed', expectedOwnerId: CREDS.userId, botId: CREDS.botId }
    assert.deepEqual(legacy, sessionId && status === 'confirmed' ? owner : { status })
    assert.deepEqual(projected, status === 'confirmed' ? owner : { status })
    assert.ok(Object.isFrozen(projected))
    assert.ok(!JSON.stringify(projected).includes(SECRET))
    assert.equal(memCount(f), 0)
    const summary = await f.channel.getStatus()
    assert.equal(summary.hasStoredLogin, false)
    assert.equal(Object.hasOwn(summary, 'expectedOwnerId'), false)
    assert.equal(Object.hasOwn(summary, 'botId'), false)
  }
})
function memCount(f) { return f.mem.mutations.length }

test('scanner confirmation rejects mismatch/invalid owner before storage; v2 refuses legacy confirmation bypass', async () => {
  const f = fixture({ initial: undefined })
  await f.channel.beginLogin()
  const owner = await f.channel.pollLoginForOwner()
  const reads = f.mem.reads
  for (const id of ['first-contact', CREDS.userId.toUpperCase()]) {
    await assert.rejects(f.channel.confirmPairingForOwner(id), errorCode('owner-mismatch'))
  }
  for (const id of [undefined, '', 'bad\nowner', { toString() { throw new Error(SECRET) } }]) {
    await assert.rejects(f.channel.confirmPairingForOwner(id), errorCode('invalid-input'))
  }
  await assert.rejects(f.channel.confirmPairing(), errorCode('invalid-input'))
  assert.equal(f.mem.reads, reads)
  assert.equal(memCount(f), 0)
  assert.deepEqual(await f.channel.confirmPairingForOwner(owner.expectedOwnerId), { paired: true })
  assert.equal(f.mem.snapshot().version, 2)
  assert.equal(f.mem.snapshot().sessionId, SID)
  assert.deepEqual(f.mem.snapshot().credentials, CREDS)
  assert.deepEqual(await f.channel.getPairingIdentity(), { botId: CREDS.botId, userId: CREDS.userId })
})

test('default disabled and invalid session options never consult dependencies or authorization predicate', async () => {
  let touches = 0
  const trap = new Proxy({}, { get() { touches++; throw new Error(SECRET) } })
  const channel = createWeixinChannel({ sessionId: SID, api: trap, store: trap,
    reply: () => { touches++; throw new Error(SECRET) }, beforeSend: () => { touches++; return true } })
  assert.deepEqual(await channel.getStatus({}), { enabled: false, phase: 'disabled', hasStoredLogin: false,
    pendingRecovery: false, messagingVerified: false })
  await assert.rejects(channel.getPairingIdentity({}), errorCode('disabled'))
  await assert.rejects(channel.pollLoginForOwner(), errorCode('disabled'))
  await assert.rejects(channel.confirmPairingForOwner(CREDS.userId), errorCode('disabled'))
  await assert.rejects(channel.pollOnce(), errorCode('disabled'))
  for (const sessionId of ['', 'bad:session', 'bad/session', '\ud800', 's'.repeat(513)]) {
    assert.throws(() => createWeixinChannel({ sessionId, api: trap, store: trap }), errorCode('invalid-options'))
  }
  assert.throws(() => createWeixinChannel({ beforeSend: true }), errorCode('invalid-options'))
  assert.equal(touches, 0)
})

test('private pairing identity is exactly bot/owner only; unpaired/disposed/aborted queries stay fail-closed', async () => {
  const f = fixture()
  const identity = await f.channel.getPairingIdentity()
  assert.deepEqual(Object.keys(identity).sort(), ['botId', 'userId'])
  assert.ok(Object.isFrozen(identity))
  assert.ok(!JSON.stringify(identity).includes(SECRET))
  const empty = fixture({ initial: undefined })
  await assert.rejects(empty.channel.getPairingIdentity(), errorCode('not-paired'))
  const controller = new AbortController()
  controller.abort(SECRET)
  const reads = f.mem.reads
  await assert.rejects(f.channel.getPairingIdentity(controller.signal), errorCode('aborted'))
  assert.equal(f.mem.reads, reads)
  f.channel.dispose()
  await assert.rejects(f.channel.getPairingIdentity(), errorCode('disposed'))
  assert.equal(f.calls.poll + f.calls.send + f.calls.reply, 0)
})

test('owner inbox and cursor share the first CAS, before reply; original context/client_id survive all transitions', async () => {
  const a = message('message-a'), b = message('message-b')
  const f = fixture({ initial: paired({ seenMessageIds: ['seen-message'] }), batch: { cursor: 'cursor-next', ignored: 2,
    messages: [message('first-contact', { fromUserId: 'foreign-peer' }), message('wrong-bot', { toUserId: 'foreign-bot' }),
      message('blank', { text: ' \n ' }), a, a, b, message('seen-message')] } })
  const result = await f.channel.pollOnce()
  assert.deepEqual(result, { received: 9, replied: 2, ignored: 5, duplicates: 2 })
  const inbox = f.mem.mutations[0]
  assert.equal(inbox.cursor, 'cursor-next')
  assert.equal(inbox.pending, null)
  assert.deepEqual(inbox.queuedBatch.messages, [a, b])
  assert.deepEqual(inbox.credentials, CREDS)
  assert.deepEqual(f.mem.mutations.map(phaseOf), ['inbox', 'replying', 'ready', 'sending', 'inbox', 'replying', 'ready', 'sending', 'complete'])
  assert.deepEqual(f.native.map(x => [x.sessionId, x.messageId, x.text]), [[SID, a.messageId, a.text], [SID, b.messageId, b.text]])
  for (const id of [a.messageId, b.messageId]) {
    const states = f.mem.mutations.filter(x => x.pending?.messageId === id)
    assert.deepEqual(states.map(x => x.pending.phase), ['replying', 'ready', 'sending'])
    assert.equal(new Set(states.map(x => x.pending.clientId)).size, 1)
  }
  assert.deepEqual(f.sent.map(x => x.contextToken), [a.contextToken, b.contextToken])
  assert.equal(f.mem.snapshot().queuedBatch, null)
  assert.equal(f.mem.snapshot().pending, null)
  assert.deepEqual(f.mem.snapshot().seenMessageIds, ['seen-message', 'message-a', 'message-b'])
  assert.equal((await f.channel.getStatus()).messagingVerified, false)
})

test('persisted ready resumes send-only, then remaining owner inbox, without polling or rerunning first AI', async () => {
  const input = withPending('ready', [message('message-a'), message('message-b')])
  const f = fixture({ initial: input })
  assert.equal((await f.channel.getStatus()).pendingRecovery, false)
  assert.deepEqual(await f.channel.pollOnce(), { received: 2, replied: 2, ignored: 0, duplicates: 0 })
  assert.equal(f.calls.poll, 0)
  assert.deepEqual(f.native.map(x => x.messageId), ['message-b'])
  assert.equal(f.sent[0].clientId, 'client-stable')
  assert.equal(f.sent[0].text, input.pending.replyText)
  assert.equal(f.sent[0].contextToken, input.queuedBatch.messages[0].contextToken)
  assert.equal(f.mem.snapshot().cursor, 'cursor-next')
})

for (const phase of ['replying', 'sending']) test(`durable ${phase} never automatically retries; exact discard releases only that queue item`, async () => {
  const input = withPending(phase, [message('message-a'), message('message-b')])
  const f = fixture({ initial: input })
  assert.equal((await f.channel.getStatus()).pendingRecovery, true)
  await assert.rejects(f.channel.pollOnce(), errorCode('recovery-required'))
  await assert.rejects(f.channel.discardPending('retry'), errorCode('invalid-input'))
  assert.equal(f.calls.reply + f.calls.send + f.calls.poll, 0)
  await f.channel.discardPending('discard-without-retry')
  assert.deepEqual(f.mem.snapshot().queuedBatch.messages.map(x => x.messageId), ['message-b'])
  assert.deepEqual(f.mem.snapshot().seenMessageIds, ['message-a'])
  assert.equal(f.mem.snapshot().cursor, input.cursor)
  assert.deepEqual(await f.channel.pollOnce(), { received: 2, replied: 1, ignored: 1, duplicates: 0 })
  assert.deepEqual(f.native.map(x => x.messageId), ['message-b'])
  assert.equal(f.calls.poll, 0)
})

test('gate revoked during sending CAS await yields zero API calls and durable sending recovery', async () => {
  const f = fixture({ batch: { cursor: 'cursor-next', messages: [message()], ignored: 0 } })
  f.mem.hooks.after = async (_expected, next) => {
    if (next.pending?.phase === 'sending') { await turn(); f.permission.allowed = false }
  }
  await assert.rejects(f.channel.pollOnce(), error => { errorCode('send-blocked')(error); assert.equal(error.deliveryUnknown, false); return true })
  assert.equal(f.calls.send, 0)
  assert.equal(f.calls.reply, 1)
  assert.equal(f.mem.snapshot().pending.phase, 'sending')
  assert.ok(f.mem.snapshot().pending.replyText)
  assert.equal((await f.channel.getStatus()).pendingRecovery, true)
  await assert.rejects(f.channel.pollOnce(), errorCode('recovery-required'))
  assert.equal(f.calls.send, 0)
})

test('gate rechecked at actual invocation: true after CAS then false before API still sends nothing', async () => {
  const f = fixture({ initial: withPending('ready'), guard: (_mem, _permission, calls) => calls.guard === 1 })
  await assert.rejects(f.channel.pollOnce(), error => { errorCode('send-blocked')(error); assert.equal(error.deliveryUnknown, false); return true })
  assert.equal(f.calls.guard, 2)
  assert.equal(f.calls.send + f.calls.reply + f.calls.poll, 0)
  assert.equal(f.mem.snapshot().pending.phase, 'sending')
})

test('nonboolean/async/throwing guards fail closed with static errors and consume native late rejection', async () => {
  let thenReads = 0
  const predicates = [() => false, () => undefined, () => 1, () => Promise.resolve(true),
    () => Promise.reject(new Error(SECRET)), () => { throw new Error(SECRET) },
    () => ({ get then() { thenReads++; throw new Error(SECRET) } })]
  for (const guard of predicates) {
    const f = fixture({ initial: withPending('ready'), guard })
    await assert.rejects(f.channel.pollOnce(), errorCode('send-blocked'))
    assert.equal(f.calls.send + f.calls.reply + f.calls.poll, 0)
    assert.equal(f.mem.snapshot().pending.phase, 'sending')
  }
  await turn()
  assert.equal(thenReads, 0)
  assert.deepEqual(unhandled, [])
})

test('stop abort during an applied sending CAS does not call API or inspect abort reason', async () => {
  const controller = new AbortController()
  const f = fixture({ initial: withPending('ready') })
  f.mem.hooks.after = (_expected, next) => {
    if (next.pending?.phase === 'sending') controller.abort({ get secret() { throw new Error(SECRET) } })
  }
  await assert.rejects(f.channel.pollOnce(controller.signal), error => {
    assert.ok(['aborted', 'store-outcome-unknown'].includes(error.code))
    assert.ok(!error.message.includes(SECRET))
    return true
  })
  assert.equal(f.calls.send + f.calls.reply + f.calls.poll, 0)
  assert.equal(f.mem.snapshot().pending.phase, 'sending')
})

test('applied-but-unknown ready commit restores durable answer without AI replay', async () => {
  const f = fixture({ batch: { cursor: 'cursor-next', messages: [message()], ignored: 0 } })
  f.mem.hooks.after = (_expected, next) => { if (next.pending?.phase === 'ready') throw new Error(SECRET) }
  await assert.rejects(f.channel.pollOnce(), errorCode('store-outcome-unknown'))
  assert.equal(f.mem.snapshot().pending.phase, 'ready')
  const answer = f.mem.snapshot().pending.replyText
  const clientId = f.mem.snapshot().pending.clientId
  assert.equal(f.calls.reply, 1)
  assert.equal(f.calls.send, 0)
  f.mem.hooks.after = undefined
  const restarted = fixture({ mem: f.mem })
  await restarted.channel.pollOnce()
  assert.equal(restarted.calls.reply + restarted.calls.poll, 0)
  assert.equal(restarted.sent[0].text, answer)
  assert.equal(restarted.sent[0].clientId, clientId)
})

test('inbox CAS failure BEFORE persistence leaves old cursor and no effects; unknown AFTER persistence preserves owner work', async () => {
  const batch = { cursor: 'cursor-next', messages: [message()], ignored: 0 }
  const before = fixture({ batch })
  before.mem.hooks.before = () => { throw new Error(SECRET) }
  await assert.rejects(before.channel.pollOnce(), errorCode('store-outcome-unknown'))
  assert.equal(before.mem.snapshot().cursor, 'cursor-old')
  assert.equal(before.mem.snapshot().queuedBatch, null)
  assert.equal(before.calls.reply + before.calls.send, 0)
  const after = fixture({ batch })
  after.mem.hooks.after = (_expected, next) => { if (phaseOf(next) === 'inbox') throw new Error(SECRET) }
  await assert.rejects(after.channel.pollOnce(), errorCode('store-outcome-unknown'))
  assert.equal(after.mem.snapshot().cursor, 'cursor-next')
  assert.deepEqual(after.mem.snapshot().queuedBatch.messages, batch.messages)
  assert.equal(after.calls.reply + after.calls.send, 0)
  after.mem.hooks.after = undefined
  const restarted = fixture({ mem: after.mem })
  await restarted.channel.pollOnce()
  assert.equal(restarted.calls.poll, 0)
  assert.equal(restarted.calls.reply, 1)
})

test('send failure or accepted response with uncertain completion remains manual recovery, never retry by client_id', async () => {
  for (const afterSend of [false, true]) {
    const f = fixture({ initial: withPending('ready'), onSend: () => {
      if (!afterSend) throw new Error(SECRET)
      return { accepted: true }
    } })
    if (afterSend) f.mem.hooks.before = (_expected, next) => { if (next.pending === null) throw new Error(SECRET) }
    await assert.rejects(f.channel.pollOnce(), errorCode(afterSend ? 'store-outcome-unknown' : 'send-failed'))
    assert.equal(f.calls.send, 1)
    assert.equal(f.mem.snapshot().pending.phase, 'sending')
    await assert.rejects(f.channel.pollOnce(), errorCode('recovery-required'))
    assert.equal(f.calls.send, 1)
  }
})

test('concurrent same-key ready restorations have one dispatch CAS winner (not a cross-process/poller guarantee)', async () => {
  const mem = memory(withPending('ready'))
  const a = fixture({ mem }), b = fixture({ mem })
  const results = await Promise.allSettled([a.channel.pollOnce(), b.channel.pollOnce()])
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(a.calls.send + b.calls.send, 1)
  assert.equal(a.calls.reply + b.calls.reply + a.calls.poll + b.calls.poll, 0)
  assert.deepEqual(mem.snapshot().seenMessageIds, ['message-a'])
})

test('same credentials do NOT authorize a new-session restoration, including legacy/session mode mismatch', async () => {
  const mem = memory(withPending('ready'))
  const f = fixture({ mem, sessionId: OTHER_SID })
  await assert.rejects(f.channel.pollOnce(), errorCode('session-mismatch'))
  await assert.rejects(f.channel.getPairingIdentity(), errorCode('session-mismatch'))
  const legacy = fixture({ mem, sessionId: undefined })
  await assert.rejects(legacy.channel.pollOnce(), errorCode('session-mismatch'))
  const v1 = memory({ version: 1, revision: 10, credentials: { ...CREDS }, cursor: 'cursor-old', seenMessageIds: [], pending: null })
  const newMode = fixture({ mem: v1 })
  await assert.rejects(newMode.channel.pollOnce(), errorCode('session-mismatch'))
  assert.equal(f.calls.reply + f.calls.send + f.calls.poll + legacy.calls.reply + legacy.calls.send, 0)
})

test('fixed credential helper isolates session keys and validates v2 binding on read/commit/CAS without probing account', async () => {
  const records = new Map()
  const keys = []
  const credentials = {
    async readRecord(key) { keys.push(key); return clone(records.get(key)) },
    async modifyRecord(key, mutate) { keys.push(key); const next = await mutate(clone(records.get(key))); if (next !== undefined) records.set(key, clone(next)); return clone(records.get(key)) },
  }
  const key = sid => `wechat-ro-weixin/session-${createHash('sha256').update(sid).digest('hex')}`
  const a = createWeixinSessionCredentialStore(credentials, SID)
  const b = createWeixinSessionCredentialStore(credentials, OTHER_SID)
  const legacy = createWeixinCredentialStore(credentials)
  assert.deepEqual(keys, [])
  const stored = withPending('ready'); stored.revision = 1
  await a.commit(null, stored)
  assert.deepEqual(await a.read(), validateWeixinState(stored))
  assert.equal(await b.read(), undefined)
  assert.deepEqual(keys, [key(SID), key(SID), key(OTHER_SID)])
  const wrong = clone(stored); wrong.sessionId = OTHER_SID; wrong.revision = 2
  const count = keys.length
  await assert.rejects(a.commit(1, wrong), errorCode('invalid-state'))
  assert.equal(keys.length, count)
  records.set(key(SID), { kind: 'grant', payload: { ...stored, sessionId: OTHER_SID } })
  await assert.rejects(a.read(), errorCode('invalid-state'))
  await assert.rejects(a.commit(1, { ...stored, revision: 2 }), errorCode('invalid-state'))
  assert.equal(keys.includes('wechat-ro-weixin/account'), false)
  assert.equal(await legacy.read(), undefined)
  assert.equal(keys.at(-1), 'wechat-ro-weixin/account')
})

test('v2 tombstone retains binding/revision, erases only owned queued data and forbids forgetting ambiguous pending', async () => {
  const f = fixture({ initial: withPending('sending') })
  await assert.rejects(f.channel.forget('forget-local-credentials'), errorCode('recovery-required'))
  await f.channel.discardPending('discard-without-retry')
  const revision = f.mem.snapshot().revision
  await f.channel.forget('forget-local-credentials')
  assert.deepEqual(f.mem.snapshot(), { version: 2, revision: revision + 1, sessionId: SID, credentials: null,
    cursor: '', seenMessageIds: [], pending: null, queuedBatch: null })
  await assert.rejects(f.channel.getPairingIdentity(), errorCode('not-paired'))
  assert.equal(f.calls.reply + f.calls.send + f.calls.poll, 0)
})

test('revision exhaustion is checked before AI/dispatch and leaves safe durable owner inbox/outbox', async () => {
  const inbox = paired({ revision: Number.MAX_SAFE_INTEGER - 3, queuedBatch: queued([message()]) })
  const f = fixture({ initial: inbox })
  await assert.rejects(f.channel.pollOnce(), errorCode('revision-exhausted'))
  assert.equal(f.calls.reply + f.calls.send + f.calls.poll, 0)
  const ready = withPending('ready'); ready.revision = Number.MAX_SAFE_INTEGER - 1
  const g = fixture({ initial: ready })
  await assert.rejects(g.channel.pollOnce(), errorCode('revision-exhausted'))
  assert.equal(g.calls.reply + g.calls.send + g.calls.poll, 0)
  assert.equal(g.mem.snapshot().pending.phase, 'ready')
})

test('malformed/mixed-source owner batch is rejected before inbox/cursor persistence or any native/send effect', async () => {
  for (const change of [{ contextToken: undefined }, { contextToken: '' }, { typingTicket: SECRET }, { text: 'x'.repeat(4001) }]) {
    const f = fixture({ batch: { cursor: 'cursor-next', messages: [message(), message('bad', change)], ignored: 0 } })
    await assert.rejects(f.channel.pollOnce(), errorCode('invalid-response'))
    assert.equal(f.mem.snapshot().cursor, 'cursor-old')
    assert.equal(f.mem.snapshot().queuedBatch, null)
    assert.equal(f.calls.reply + f.calls.send, 0)
  }
})

test('v2 validation is JSON-roundtrip/idempotent, deeply detached and frozen across constrained size/phase generators', () => {
  for (const n of [1, 2, 16, 256]) for (const length of [1, 64, 512]) for (const phase of [null, 'replying', 'ready', 'sending']) {
    const messages = Array.from({ length: n }, (_, i) => message(`message-${i}`))
    const input = phase ? withPending(phase, messages) : paired({ queuedBatch: queued(messages) })
    input.sessionId = 's'.repeat(length)
    const originalText = messages[0].text
    const snapshot = validateWeixinState(input)
    assert.deepEqual(validateWeixinState(snapshot), snapshot)
    assert.deepEqual(validateWeixinState(JSON.parse(JSON.stringify(snapshot))), snapshot)
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.credentials))
    assert.ok(Object.isFrozen(snapshot.queuedBatch) && Object.isFrozen(snapshot.queuedBatch.messages))
    assert.ok(snapshot.queuedBatch.messages.every(Object.isFrozen))
    if (snapshot.pending) assert.ok(Object.isFrozen(snapshot.pending))
    input.credentials.botToken = 'SYNTHETIC_CHANGED'
    input.queuedBatch.messages[0].text = 'changed'
    assert.equal(snapshot.credentials.botToken, CREDS.botToken)
    assert.equal(snapshot.queuedBatch.messages[0].text, originalText)
    assert.equal(snapshot.sessionId, 's'.repeat(length))
  }
})

test('v2 mutation domain rejects ownership, binding, counter, pending, token, byte-size, getter and prototype violations', () => {
  let getterReads = 0
  const mutations = [x => { x.sessionId = '' }, x => { x.sessionId = 's'.repeat(513) }, x => { delete x.sessionId },
    x => { x.version = 3 }, x => { x.credentials.baseUrl = 'https://example.invalid' },
    x => { x.credentials.botToken += '\n' }, x => { x.queuedBatch.messages[0].fromUserId = 'foreign-peer' },
    x => { x.queuedBatch.messages[0].toUserId = 'foreign-bot' }, x => { x.queuedBatch.messages[0].contextToken = '' },
    x => { x.queuedBatch.messages[0].text = ' \n ' }, x => { x.queuedBatch.messages[0].text = 'x'.repeat(4001) },
    x => { x.queuedBatch.messages[0].typingTicket = SECRET }, x => { x.queuedBatch.messages.push(clone(x.queuedBatch.messages[0])); x.queuedBatch.received++ },
    x => { x.seenMessageIds = [x.queuedBatch.messages[0].messageId] }, x => { x.queuedBatch.received++ },
    x => { x.queuedBatch.ignored = -1 }, x => { x.queuedBatch.replied = Infinity }, x => { x.queuedBatch.duplicates = '0' },
    x => { x.queuedBatch.messages = [] }, x => { delete x.queuedBatch.messages[0] },
    x => { x.pending.messageId = 'wrong-id' }, x => { x.pending.clientId = '' }, x => { x.pending.phase = 'queued' },
    x => { x.pending.replyText = null }, x => { x.pending.phase = 'replying' }, x => { x.queuedBatch = null },
    x => { x.pending.retry = true }, x => { x.toJSON = () => { getterReads++; throw new Error(SECRET) } },
    x => { Object.defineProperty(x.queuedBatch.messages[0], 'contextToken', { enumerable: true, get() { getterReads++; throw new Error(SECRET) } }) },
    x => { Object.setPrototypeOf(x.queuedBatch, { injected: true }) }]
  for (const mutate of mutations) {
    const input = withPending('ready')
    mutate(input)
    assert.throws(() => validateWeixinState(input), errorCode('invalid-state'))
  }
  assert.equal(getterReads, 0)
  const large = paired({ queuedBatch: queued(Array.from({ length: 129 }, (_, i) => message(`message-${i}`, { contextToken: 'c'.repeat(8192) }))) })
  assert.throws(() => validateWeixinState(large), errorCode('invalid-state'))
})

test('per-field byte/count bounds accept exact limits and reject excess, with owner identity preserved', () => {
  const input = withPending('ready')
  input.cursor = 'c'.repeat(65536)
  input.credentials.botToken = 't'.repeat(8192)
  input.queuedBatch.messages[0].text = 'x'.repeat(4000)
  input.queuedBatch.messages[0].contextToken = 'c'.repeat(8192)
  input.pending.replyText = 'r'.repeat(4000)
  input.seenMessageIds = Array.from({ length: 4096 }, (_, i) => `seen-${i}`)
  assert.equal(validateWeixinState(input).credentials.userId, CREDS.userId)
  for (const mutate of [x => { x.cursor += 'c' }, x => { x.credentials.botToken += 't' },
    x => { x.queuedBatch.messages[0].text += 'x' }, x => { x.queuedBatch.messages[0].contextToken += 'c' },
    x => { x.pending.replyText += 'r' }, x => { x.seenMessageIds.push('too-many') }]) {
    const excess = clone(input); mutate(excess)
    assert.throws(() => validateWeixinState(excess), errorCode('invalid-state'))
  }
})
