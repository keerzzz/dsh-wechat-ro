// Server-only self-owned coordinator. No import/construction I/O or background work.
// Protocol provenance: docs/adr/0002-self-owned-wechat-channel.md (not vendor code).
import { randomUUID } from 'node:crypto'
import { WEIXIN_MEDIA_LIMITS } from './weixin-media.js'
import { WEIXIN_UPDATE_DIAGNOSTIC, WeixinApiError, isWeixinApiErrorCode } from './weixin-http.js'

const ORIGIN = 'https://ilinkai.weixin.qq.com'
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const addListener = EventTarget.prototype.addEventListener
const removeListener = EventTarget.prototype.removeEventListener
const LIMIT = Object.freeze({ id: 512, token: 8192, cursor: 65536, text: 4000, verify: 64, messages: 256, seen: 4096, batch: 1048576 })
const QR_STATUSES = Object.freeze(['wait', 'scaned', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect'])
const ERRORS = Object.freeze({
  'owner-mismatch': 'The confirmed Weixin owner does not match.',
  'session-mismatch': 'The stored channel is bound to a different mode or session.',
  'send-blocked': 'Sending is no longer authorized; explicit recovery is required.',
  'invalid-options': 'Invalid channel options.',
  disabled: 'The channel is disabled.',
  'not-configured': 'Complete channel dependencies are required.',
  disposed: 'The channel is disposed.',
  busy: 'Another channel operation is active.',
  'invalid-input': 'Invalid channel input.',
  aborted: 'The local channel operation was cancelled.',
  'invalid-state': 'Invalid stored channel state.',
  'invalid-response': 'Invalid API response.',
  'store-failed': 'The state read failed.',
  'store-outcome-unknown': 'The state write outcome is unknown; inspect stored state before recovery.',
  'api-failed': 'The API operation failed.',
  'reply-failed': 'The reply operation failed; explicit recovery is required.',
  'invalid-reply': 'The reply is invalid; explicit recovery is required.',
  'send-failed': 'The send failed; explicit recovery is required.',
  'already-paired': 'Forget the stored login before beginning another login.',
  'login-active': 'Cancel the existing local login attempt first.',
  'login-required': 'Begin a local login attempt first.',
  'login-not-confirmed': 'The login has not been confirmed by the API.',
  'not-paired': 'No stored login is available.',
  'recovery-required': 'A pending message requires explicit discard without retry.',
  'no-pending': 'No pending message is available to discard.',
  'revision-exhausted': 'The state revision cannot be incremented safely.',
})

/** Never attaches a dependency exception, response, input or AbortSignal.reason. */
export class WeixinChannelError extends Error {
  constructor(code, deliveryUnknown = false, apiErrorCode) {
    const safe = typeof code === 'string' && Object.hasOwn(ERRORS, code) ? code : 'invalid-response'
    super(ERRORS[safe])
    Object.defineProperties(this, {
      name: { value: 'WeixinChannelError', enumerable: true },
      code: { value: safe, enumerable: true },
      deliveryUnknown: { value: deliveryUnknown === true, enumerable: true },
      ...(['api-failed', 'send-failed'].includes(safe) && isWeixinApiErrorCode(apiErrorCode)
        ? { apiErrorCode: { value: apiErrorCode, enumerable: true } } : {}),
    })
  }
}

function fail(code) { throw new WeixinChannelError(code) }

function isAborted(signal) { return abortedGetter.call(signal) }
function validateSignal(signal) {
  if (signal === undefined) return
  // Brand-check without invoking caller getters, methods, or abort.reason.
  try { isAborted(signal) } catch { fail('invalid-input') }
}

// Inspect data properties, not toJSON/accessors. Proxies/hostile same-process
// dependencies are outside this boundary; any exception is still redacted.
function record(value, fields, code, optional = false) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail(code)
  const keys = Reflect.ownKeys(value)
  if ((!optional && keys.length !== fields.length) || keys.length > fields.length) fail(code)
  const copy = {}
  for (const key of keys) {
    if (typeof key !== 'string' || !fields.includes(key)) fail(code)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code)
    copy[key] = descriptor.value
  }
  return copy
}

function array(value, max, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) fail(code)
  if (Reflect.ownKeys(value).length !== value.length + 1) fail(code)
  const copy = []
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code)
    copy.push(descriptor.value)
  }
  return copy
}

function string(value, max, code, empty = false, opaque = false) {
  if (typeof value !== 'string' || (!empty && value.length === 0)
      || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > max) fail(code)
  if (opaque && /[\u0000-\u0020\u007f]/u.test(value)) fail(code)
  return value
}

function textValue(value, code) {
  const text = string(value, LIMIT.text, code)
  if (text.trim() === '') fail(code)
  return text
}

function identifier(value, code) {
  const id = string(value, LIMIT.id, code, false, true)
  if (!/^[A-Za-z0-9_][A-Za-z0-9._:@-]*$/u.test(id)) fail(code)
  return id
}

function credentials(value, code) {
  const data = record(value, ['botToken', 'botId', 'userId', 'baseUrl'], code)
  if (data.baseUrl !== ORIGIN) fail(code)
  const botToken = string(data.botToken, LIMIT.token, code, false, true)
  if (/[^\u0021-\u007e]/u.test(botToken)) fail(code)
  return Object.freeze({
    botToken,
    botId: identifier(data.botId, code),
    userId: identifier(data.userId, code),
    baseUrl: ORIGIN,
  })
}

/** Detached pure JSON snapshot, strict shape, bounded data, deep frozen result. */
function sessionBinding(value, code) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/u.test(value)) fail(code)
  return value
}

/** Both versions are detached JSON; default legacy v1 retains its exact shape. */
export function validateWeixinState(value) {
  try {
    const data = record(value, ['version', 'revision', 'credentials', 'cursor', 'seenMessageIds', 'pending', 'sessionId', 'queuedBatch'], 'invalid-state', true)
    if (data.version === 1) return validateLegacyState(data)
    if (data.version !== 2 && data.version !== 3) fail('invalid-state');
    return validateSessionState(data)
  } catch { fail('invalid-state') }
}

function deliveryDescriptor(value, code) {
  const data = record(value, ['reference', 'turn', 'fileName', 'kind', 'bytes', 'sha256'], code)
  if (typeof data.reference !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(data.reference)
    || !Number.isSafeInteger(data.turn) || data.turn < 0 || !['image', 'file'].includes(data.kind)
    || !Number.isSafeInteger(data.bytes) || data.bytes < 0 || data.bytes > WEIXIN_MEDIA_LIMITS.maxBytes
    || typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(data.sha256)) fail(code)
  string(data.fileName, 255, code)
  if (/[\x00-\x1f\x7f/\\:*?"<>|]/u.test(data.fileName) || /[. ]$/u.test(data.fileName)) fail(code)
  return Object.freeze(data)
}
function deliveryParts(value) {
  const reply = record(value, ['text', 'deliverables'], 'invalid-reply')
  const text = string(reply.text, WEIXIN_MEDIA_LIMITS.maxReplyBytes, 'invalid-reply', true)
  const files = array(reply.deliverables, WEIXIN_MEDIA_LIMITS.maxFiles, 'invalid-reply').map(file => deliveryDescriptor(file, 'invalid-reply'))
  if ((!text.trim() && !files.length) || new Set(files.map(file => file.reference)).size !== files.length) fail('invalid-reply')
  const parts = []
  let chunk = '', bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char)
    if (bytes + size > LIMIT.text) { parts.push({ kind: 'text', clientId: randomUUID(), text: chunk }); chunk = ''; bytes = 0 }
    chunk += char; bytes += size
  }
  if (chunk) parts.push({ kind: 'text', clientId: randomUUID(), text: chunk })
  for (const file of files) parts.push({ ...file, clientId: randomUUID() })
  return parts
}
function validateDeliveryPending(value) {
  const data = record(value, ['messageId', 'phase', 'parts', 'next'], 'invalid-state')
  identifier(data.messageId, 'invalid-state')
  if (!['replying', 'ready', 'sending'].includes(data.phase) || !Number.isSafeInteger(data.next) || data.next < 0) fail('invalid-state')
  if (data.phase === 'replying') {
    if (data.parts !== null || data.next !== 0) fail('invalid-state')
    return Object.freeze(data)
  }
  let mediaCount = 0, textBytes = 0
  const parts = array(data.parts, WEIXIN_MEDIA_LIMITS.maxParts, 'invalid-state').map(value => {
    const part = record(value, ['kind', 'clientId', 'text', 'reference', 'turn', 'fileName', 'bytes', 'sha256'], 'invalid-state', true)
    identifier(part.clientId, 'invalid-state')
    if (part.kind === 'text') {
      record(part, ['kind', 'clientId', 'text'], 'invalid-state')
      string(part.text, LIMIT.text, 'invalid-state'); textBytes += Buffer.byteLength(part.text)
      return Object.freeze(part)
    }
    const { clientId, ...description } = part
    mediaCount++
    return Object.freeze({ ...deliveryDescriptor(description, 'invalid-state'), clientId })
  })
  if (mediaCount > WEIXIN_MEDIA_LIMITS.maxFiles || textBytes > WEIXIN_MEDIA_LIMITS.maxReplyBytes || parts.length === 0 || data.next >= parts.length
    || new Set(parts.map(part => part.clientId)).size !== parts.length
    || new Set(parts.filter(part => part.kind !== 'text').map(part => part.reference)).size !== mediaCount) fail('invalid-state')
  return Object.freeze({ ...data, parts: Object.freeze(parts) })
}

function validateSessionState(value) {
  const data = record(value, ['version', 'revision', 'credentials', 'cursor', 'seenMessageIds', 'pending', 'sessionId', 'queuedBatch'], 'invalid-state')
  const common = validateLegacyState({ version: 1, revision: data.revision, credentials: data.credentials,
    cursor: data.cursor, seenMessageIds: data.seenMessageIds, pending: null })
  const sessionId = sessionBinding(data.sessionId, 'invalid-state')
  let queuedBatch = null
  if (data.queuedBatch !== null) {
    if (common.credentials === null) fail('invalid-state')
    const queue = record(data.queuedBatch, ['messages', 'received', 'replied', 'ignored', 'duplicates'], 'invalid-state')
    const batch = updates({ cursor: '', messages: queue.messages, ignored: 0 })
    if (batch.messages.length === 0) fail('invalid-state')
    for (const name of ['received', 'replied', 'ignored', 'duplicates']) {
      if (!Number.isSafeInteger(queue[name]) || queue[name] < 0 || queue[name] > LIMIT.messages) fail('invalid-state')
    }
    if (queue.received !== batch.messages.length + queue.replied + queue.ignored + queue.duplicates) fail('invalid-state')
    const ids = new Set(common.seenMessageIds)
    for (const message of batch.messages) {
      if (message.fromUserId !== common.credentials.userId || message.toUserId !== common.credentials.botId
          || message.text.trim() === '' || ids.has(message.messageId)) fail('invalid-state')
      ids.add(message.messageId)
    }
    queuedBatch = Object.freeze({ messages: Object.freeze(batch.messages), received: queue.received,
      replied: queue.replied, ignored: queue.ignored, duplicates: queue.duplicates })
    if (Buffer.byteLength(JSON.stringify(queuedBatch), 'utf8') > LIMIT.batch) fail('invalid-state')
  }
  let pending = null
  if (data.pending !== null) {
    if (data.version === 3) pending = validateDeliveryPending(data.pending)
    else {
      const item = record(data.pending, ['messageId', 'clientId', 'phase', 'replyText'], 'invalid-state')
      if (!['replying', 'ready', 'sending'].includes(item.phase)) fail('invalid-state')
      if (item.phase === 'replying' && item.replyText !== null) fail('invalid-state')
      pending = Object.freeze({ messageId: identifier(item.messageId, 'invalid-state'),
        clientId: identifier(item.clientId, 'invalid-state'), phase: item.phase,
        replyText: item.phase === 'replying' ? null : textValue(item.replyText, 'invalid-state') })
    }
    if (queuedBatch === null || queuedBatch.messages[0].messageId !== pending.messageId) fail('invalid-state')
  }
  if (common.credentials === null && (queuedBatch !== null || pending !== null)) fail('invalid-state')
  return Object.freeze({ ...common, version: data.version, sessionId, queuedBatch, pending })
}

function validateLegacyState(value) {
  try {
    const data = record(value, ['version', 'revision', 'credentials', 'cursor', 'seenMessageIds', 'pending'], 'invalid-state')
    if (data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 1) fail('invalid-state')
    const seen = array(data.seenMessageIds, LIMIT.seen, 'invalid-state')
      .map(id => identifier(id, 'invalid-state'))
    if (new Set(seen).size !== seen.length) fail('invalid-state')
    let pending = null
    if (data.pending !== null) {
      const item = record(data.pending, ['messageId', 'clientId'], 'invalid-state')
      pending = Object.freeze({
        messageId: identifier(item.messageId, 'invalid-state'),
        clientId: identifier(item.clientId, 'invalid-state'),
      })
      if (seen.includes(pending.messageId)) fail('invalid-state')
    }
    const auth = data.credentials === null ? null : credentials(data.credentials, 'invalid-state')
    const cursor = string(data.cursor, LIMIT.cursor, 'invalid-state', true)
    if (auth === null && (cursor !== '' || seen.length !== 0 || pending !== null)) fail('invalid-state')
    return Object.freeze({
      version: 1, revision: data.revision, credentials: auth, cursor,
      seenMessageIds: Object.freeze(seen), pending,
    })
  } catch { fail('invalid-state') }
}

function validateOptions(value) {
  try {
    const opts = record(value === undefined ? {} : value, ['enabled', 'api', 'store', 'reply', 'resumeReply', 'sessionId', 'beforeSend', 'onTextAccepted', 'media'], 'invalid-options', true)
    if (opts.enabled !== undefined && typeof opts.enabled !== 'boolean') fail('invalid-options')
    for (const name of ['api', 'store']) {
      if (opts[name] !== undefined && (opts[name] === null || typeof opts[name] !== 'object' || Array.isArray(opts[name]))) fail('invalid-options')
    }
    if (opts.reply !== undefined && typeof opts.reply !== 'function') fail('invalid-options')
    if (opts.resumeReply !== undefined && (typeof opts.resumeReply !== 'function' || opts.sessionId === undefined)) fail('invalid-options')
    if (opts.sessionId !== undefined) sessionBinding(opts.sessionId, 'invalid-options')
    if (opts.beforeSend !== undefined && typeof opts.beforeSend !== 'function') fail('invalid-options')
    if (opts.onTextAccepted !== undefined && typeof opts.onTextAccepted !== 'function') fail('invalid-options')
    if (opts.media !== undefined) {
      if (opts.sessionId === undefined) fail('invalid-options')
      const media = record(opts.media, ['reply', 'send', 'release'], 'invalid-options')
      if (Object.values(media).some(method => typeof method !== 'function')) fail('invalid-options')
      opts.media = Object.freeze(media)
    }
    return opts
  } catch { fail('invalid-options') }
}

function loginQr(value) {
  try {
    const data = record(value, ['qrcode', 'qrContent'], 'invalid-response')
    return Object.freeze({
      qrcode: string(data.qrcode, LIMIT.token, 'invalid-response'),
      qrContent: string(data.qrContent, LIMIT.token, 'invalid-response'),
    })
  } catch { fail('invalid-response') }
}

function loginStatus(value) {
  try {
    const data = record(value, ['status', 'credentials', 'redirectHost'], 'invalid-response', true)
    if (!QR_STATUSES.includes(data.status)) fail('invalid-response')
    if (Object.hasOwn(data, 'redirectHost')
        && (data.status !== 'scaned_but_redirect' || data.redirectHost !== ORIGIN)) fail('invalid-response')
    const confirmed = data.status === 'confirmed'
    if (Object.hasOwn(data, 'credentials') !== confirmed) fail('invalid-response')
    return { status: data.status, credentials: confirmed ? credentials(data.credentials, 'invalid-response') : undefined }
  } catch { fail('invalid-response') }
}

function updates(value) {
  try {
    const data = record(value, ['cursor', 'messages', 'ignored'], 'invalid-response')
    const items = array(data.messages, LIMIT.messages, 'invalid-response')
    if (!Number.isSafeInteger(data.ignored) || data.ignored < 0 || data.ignored + items.length > LIMIT.messages) fail('invalid-response')
    const result = {
      cursor: string(data.cursor, LIMIT.cursor, 'invalid-response', true),
      messages: items.map(item => {
        const msg = record(item, ['messageId', 'fromUserId', 'toUserId', 'contextToken', 'text'], 'invalid-response')
        return Object.freeze({
          messageId: identifier(msg.messageId, 'invalid-response'),
          fromUserId: identifier(msg.fromUserId, 'invalid-response'),
          toUserId: identifier(msg.toUserId, 'invalid-response'),
          contextToken: string(msg.contextToken, LIMIT.token, 'invalid-response', false, true),
          text: string(msg.text, LIMIT.text, 'invalid-response'),
        })
      }),
      ignored: data.ignored,
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > LIMIT.batch) fail('invalid-response')
    return result
  } catch { fail('invalid-response') }
}

function updatesDiagnostic(value) {
  const data = record(value, ['version', 'outcome', 'errorCode', 'validationField', 'msgsShape', 'cursorShape',
    'messageCount', 'textCount', 'ignoredCount', 'httpStatus', 'businessCode'], 'invalid-response')
  if (data.version !== 1 || !WEIXIN_UPDATE_DIAGNOSTIC.outcomes.includes(data.outcome)
      || (data.errorCode !== null && !isWeixinApiErrorCode(data.errorCode))
      || (data.validationField !== null && !WEIXIN_UPDATE_DIAGNOSTIC.validationFields.includes(data.validationField))
      || (data.msgsShape !== null && !WEIXIN_UPDATE_DIAGNOSTIC.msgsShapes.includes(data.msgsShape))
      || (data.cursorShape !== null && !WEIXIN_UPDATE_DIAGNOSTIC.cursorShapes.includes(data.cursorShape))) fail('invalid-response')
  for (const name of ['messageCount', 'textCount', 'ignoredCount']) {
    if (data[name] !== null && (!Number.isSafeInteger(data[name]) || data[name] < 0 || data[name] > LIMIT.messages)) fail('invalid-response')
  }
  if ((data.httpStatus !== null && (!Number.isInteger(data.httpStatus) || data.httpStatus < 100 || data.httpStatus > 599))
      || (data.businessCode !== null && !Number.isSafeInteger(data.businessCode))) fail('invalid-response')
  if ((['omitted', 'null'].includes(data.msgsShape) && data.messageCount !== 0)
      || (data.msgsShape === 'other' && data.messageCount !== null)) fail('invalid-response')
  if (data.outcome === 'valid') {
    if (data.errorCode !== null || data.validationField !== null || data.msgsShape === null || data.cursorShape === null
        || data.msgsShape === 'other' || data.cursorShape === 'other'
        || data.messageCount === null || data.textCount === null || data.ignoredCount === null
        || data.messageCount !== data.textCount + data.ignoredCount) fail('invalid-response')
    return Object.freeze(data)
  }
  if (data.errorCode === null || data.textCount !== null || data.ignoredCount !== null
      || WEIXIN_UPDATE_DIAGNOSTIC.invalidErrorCodes.includes(data.errorCode) !== (data.outcome === 'invalid')
      || (data.outcome === 'failed' && data.validationField !== null)) fail('invalid-response')
  return Object.freeze(data)
}

function nextState(state, changes) {
  if (state.revision === Number.MAX_SAFE_INTEGER) fail('revision-exhausted')
  const next = { ...state, ...changes, revision: state.revision + 1 }
  if (next.version === 2 || next.version === 3) return validateWeixinState(next)
  return Object.freeze({
    ...next, credentials: next.credentials === null ? null : Object.freeze({ ...next.credentials }),
    seenMessageIds: Object.freeze([...next.seenMessageIds]),
    pending: next.pending === null ? null : Object.freeze({ ...next.pending }),
  })
}

function seenWith(state, messageId) {
  return [...state.seenMessageIds, messageId].slice(-LIMIT.seen)
}

function requiresRecovery(state) {
  return state?.pending != null && (state.version === 1 || state.pending.phase !== 'ready')
}

function status(enabled, phase, state, resumeReply) {
  return Object.freeze({ enabled, phase, hasStoredLogin: state?.credentials != null,
    pendingRecovery: requiresRecovery(state), messagingVerified: false,
    ...(state?.version === 2 || state?.version === 3 ? { resumeAvailable: typeof resumeReply === 'function' && state.pending?.phase === 'replying' } : {}),
    ...(state?.version === 3 ? { delivery: state.pending?.parts ? Object.freeze({ accepted: state.pending.next, total: state.pending.parts.length, phase: state.pending.phase }) : null } : {}) })
}

/**
 * Explicit actions only; no retries, implicit fetch, polling loop or timer.
 * The store/API/reply are trusted same-process contracts, not a sandbox.
 * Monotone tombstones prevent revision-reuse ABA across forget/re-pair.
 * Manual recovery must still quiesce all workers; CAS cannot revoke issued effects.
 */
export function createWeixinChannel(options) {
  const opts = validateOptions(options)
  const enabled = opts.enabled === true
  const lifecycle = new AbortController()
  let disposed = false
  let busy = false
  let qr
  let confirmed

  function configured(diagnostic) {
    if (opts.api === undefined || opts.store === undefined || opts.reply === undefined) fail('not-configured')
    try {
      const api = {}
      const store = {}
      for (const name of ['requestQrCode', 'getQrStatus', 'getUpdates', 'sendText', ...(diagnostic ? ['diagnoseUpdatesOnce'] : [])]) {
        const method = opts.api[name]
        if (typeof method !== 'function') fail('invalid-options')
        api[name] = method.bind(opts.api)
      }
      for (const name of ['read', 'commit']) {
        const method = opts.store[name]
        if (typeof method !== 'function') fail('invalid-options')
        store[name] = method.bind(opts.store)
      }
      return { api, store, reply: opts.reply, resumeReply: opts.resumeReply, beforeSend: opts.beforeSend, media: opts.media }
    } catch { fail('invalid-options') }
  }

  function check(ctx) {
    if (isAborted(ctx.signal)) throw new WeixinChannelError('aborted', ctx.deliveryUnknown)
  }

  function authorizeSend(ctx) {
    if (ctx.beforeSend === undefined) return
    let allowed = false
    try { const predicate = ctx.beforeSend; allowed = predicate() } catch {}
    if (allowed === true) return
    // An accidentally async predicate is NOT authorization; consume native late
    // rejection without calling arbitrary thenable accessors or exposing errors.
    try { Promise.prototype.then.call(allowed, undefined, () => {}) } catch {}
    ctx.sendBlocked = true
    ctx.deliveryUnknown = false
    throw new WeixinChannelError('send-blocked')
  }

  // Promise.race installs both fulfillment/rejection handlers on late work.
  // A dependency ignoring cancellation may still finish; never compensate it.
  async function io(ctx, start, failure, kind = 'read') {
    check(ctx)
    let listener
    let called = false
    try {
      const work = Promise.resolve().then(() => {
        check(ctx)
        called = true
        if (kind === 'send') ctx.deliveryUnknown = true
        return start()
      })
      const stopped = new Promise((_, reject) => {
        listener = () => reject(new WeixinChannelError('aborted', ctx.deliveryUnknown))
        addListener.call(ctx.signal, 'abort', listener, { once: true })
        if (isAborted(ctx.signal)) listener()
      })
      const result = await Promise.race([work, stopped])
      check(ctx)
      return result
    } catch (error) {
      if (kind === 'commit' && called) throw new WeixinChannelError('store-outcome-unknown', ctx.deliveryUnknown)
      if (isAborted(ctx.signal)) throw new WeixinChannelError('aborted', ctx.deliveryUnknown)
      if (kind === 'send' && called && ctx.sendBlocked) throw new WeixinChannelError('send-blocked')
      if (kind === 'send' && called) {
        // Only an explicit API contract deliveryUnknown:false establishes rejection.
        // Dependency text, response and cause are never retained.
        try { ctx.deliveryUnknown = Object.getOwnPropertyDescriptor(error, 'deliveryUnknown')?.value !== false }
        catch { ctx.deliveryUnknown = true }
      }
      const apiErrorCode = error instanceof WeixinApiError ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
      throw new WeixinChannelError(failure, ctx.deliveryUnknown, apiErrorCode)
    } finally {
      if (listener !== undefined) removeListener.call(ctx.signal, 'abort', listener)
    }
  }

  async function run(signal, operation, diagnostic = false) {
    if (disposed) fail('disposed')
    if (!enabled) fail('disabled')
    if (busy) fail('busy')
    const deps = configured(diagnostic)
    validateSignal(signal)
    busy = true
    const controller = new AbortController()
    const relay = () => controller.abort()
    const ctx = { ...deps, signal: controller.signal, deliveryUnknown: false, sendBlocked: false }
    try {
      addListener.call(lifecycle.signal, 'abort', relay, { once: true })
      if (signal !== undefined) addListener.call(signal, 'abort', relay, { once: true })
      if (isAborted(lifecycle.signal) || (signal !== undefined && isAborted(signal))) relay()
      check(ctx)
      const result = await operation(ctx)
      check(ctx)
      return result
    } catch (error) {
      // Even a user-supplied WeixinChannelError cannot leak additional properties.
      if (error instanceof WeixinChannelError) throw new WeixinChannelError(error.code, error.deliveryUnknown || ctx.deliveryUnknown,
        Object.getOwnPropertyDescriptor(error, 'apiErrorCode')?.value)
      throw new WeixinChannelError(isAborted(ctx.signal) ? 'aborted' : 'invalid-response', ctx.deliveryUnknown)
    } finally {
      removeListener.call(lifecycle.signal, 'abort', relay)
      if (signal !== undefined) removeListener.call(signal, 'abort', relay)
      busy = false
    }
  }

  async function readState(ctx) {
    const value = await io(ctx, () => ctx.store.read(), 'store-failed')
    if (value === undefined) return undefined
    const state = validateWeixinState(value)
    if (state.version !== (opts.sessionId === undefined ? 1 : opts.media ? 3 : 2)
        || (state.version !== 1 && state.sessionId !== opts.sessionId)) fail('session-mismatch')
    return state
  }

  async function commit(ctx, state, next) {
    const result = await io(ctx, () => ctx.store.commit(state?.revision ?? null, next), 'store-outcome-unknown', 'commit')
    if (result !== undefined) throw new WeixinChannelError('store-outcome-unknown', ctx.deliveryUnknown)
  }

  function clearLogin() { qr = undefined; confirmed = undefined }

  function loginProjection(qrStatus, withOwner) {
    return Object.freeze(withOwner && qrStatus === 'confirmed'
      ? { status: qrStatus, expectedOwnerId: confirmed.userId, botId: confirmed.botId }
      : { status: qrStatus })
  }

  function pollLoginAction(verifyCode, signal, withOwner) {
    return run(signal, async ctx => {
      if (verifyCode !== undefined) string(verifyCode, LIMIT.verify, 'invalid-input', false, true)
      if (!qr) fail('login-required')
      if (confirmed) return loginProjection('confirmed', withOwner)
      const result = loginStatus(await io(ctx, () => ctx.api.getQrStatus(qr.qrcode, verifyCode, ctx.signal), 'api-failed'))
      if (result.status === 'confirmed') confirmed = result.credentials
      // Terminal/redirect statuses are not automatic cancel, redirect or retry.
      return loginProjection(result.status, withOwner)
    })
  }

  function confirmPairingAction(expectedOwnerId, signal, requireOwner) {
    return run(signal, async ctx => {
      if (opts.sessionId !== undefined && !requireOwner) fail('invalid-input')
      if (requireOwner) identifier(expectedOwnerId, 'invalid-input')
      if (!confirmed) fail('login-not-confirmed')
      // Exact scanner identity, never a first inbound contact or a typing ticket.
      if (requireOwner && confirmed.userId !== expectedOwnerId) fail('owner-mismatch')
      const current = await readState(ctx)
      if (current?.credentials != null) fail('already-paired')
      const initial = current === undefined
        ? validateWeixinState({ version: opts.sessionId === undefined ? 1 : opts.media ? 3 : 2, revision: 1,
          credentials: { ...confirmed }, cursor: '', seenMessageIds: [], pending: null,
          ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId, queuedBatch: null }) })
        : nextState(current, { credentials: confirmed })
      await commit(ctx, current, initial)
      clearLogin()
      return Object.freeze({ paired: true })
    })
  }

  function batchCounts(batch) {
    return Object.freeze({ received: batch.received, replied: batch.replied,
      ignored: batch.ignored, duplicates: batch.duplicates })
  }

  function classifyBatch(state, batch) {
    const messages = []
    const ids = new Set(state.seenMessageIds)
    const counts = { received: batch.messages.length + batch.ignored, replied: 0, ignored: batch.ignored, duplicates: 0 }
    for (const message of batch.messages) {
      if (message.fromUserId !== state.credentials.userId || message.toUserId !== state.credentials.botId
          || message.text.trim() === '') { counts.ignored++; continue }
      if (ids.has(message.messageId)) { counts.duplicates++; continue }
      ids.add(message.messageId)
      messages.push(message)
    }
    return { counts, queuedBatch: messages.length === 0 ? null : { ...counts, messages } }
  }

  function reserveRevisions(state, count) {
    if (state.revision > Number.MAX_SAFE_INTEGER - count) fail('revision-exhausted')
  }

  function finishQueuedMessage(state, accepted) {
    const queue = state.queuedBatch
    const messageId = queue.messages[0].messageId
    const remaining = { ...queue, messages: queue.messages.slice(1),
      replied: queue.replied + (accepted ? 1 : 0), ignored: queue.ignored + (accepted ? 0 : 1) }
    return { counts: batchCounts(remaining), next: nextState(state, {
      seenMessageIds: seenWith(state, messageId), pending: null,
      queuedBatch: remaining.messages.length === 0 ? null : remaining,
    }) }
  }

  async function pollDurable(ctx, textOnly = false, resume = false) {
    let state = await readState(ctx)
    if (state?.credentials == null) fail('not-paired')
    // A one-text grant cannot resume ANY earlier outbox, including ready media.
    // Ordinary polling may resume only a durably ready, never-dispatched outbox.
    if (resume) {
      if (state.pending === null) fail('no-pending')
      if (state.pending.phase !== 'replying') fail('recovery-required')
      reserveRevisions(state, 4)
      // A new CAS claim wins before continuing the retained native input.
      const claimed = nextState(state, { pending: state.pending })
      await commit(ctx, state, claimed); state = claimed
    } else if (requiresRecovery(state) || textOnly && state.pending !== null) fail('recovery-required')
    let counts
    if (state.queuedBatch === null) {
      const batch = updates(await io(ctx, () => ctx.api.getUpdates(state.credentials, state.cursor, ctx.signal), 'api-failed'))
      const classified = classifyBatch(state, batch)
      counts = Object.freeze(classified.counts)
      if (classified.queuedBatch !== null || state.cursor !== batch.cursor) {
        // OWNER inbox and cursor become durable TOGETHER, before native input.
        const inbox = nextState(state, { cursor: batch.cursor, queuedBatch: classified.queuedBatch })
        await commit(ctx, state, inbox)
        state = inbox
      }
      if (state.queuedBatch === null) return textOnly ? Object.freeze({ ...counts, remaining: 0 }) : counts
    }
    counts = textOnly ? counts || Object.freeze({ received: state.queuedBatch.messages.length, replied: 0, ignored: 0, duplicates: 0 })
      : batchCounts(state.queuedBatch)
    while (state.queuedBatch !== null) {
      check(ctx)
      const message = state.queuedBatch.messages[0]
      if (state.pending === null || resume) {
        if (!resume) {
          reserveRevisions(state, state.version === 3 && !textOnly ? 2 + WEIXIN_MEDIA_LIMITS.maxParts * 2 : 4)
          const pending = state.version === 3 ? { messageId: message.messageId, phase: 'replying', parts: null, next: 0 }
            : { messageId: message.messageId, clientId: randomUUID(), phase: 'replying', replyText: null }
          const claimed = nextState(state, { pending })
          await commit(ctx, state, claimed)
          state = claimed
        }
        const reply = await io(ctx, () => resume ? ctx.resumeReply(message.text, Object.freeze({ messageId: message.messageId }), ctx.signal)
          : state.version === 3 && !textOnly ? ctx.media.reply(message.text, Object.freeze({ messageId: message.messageId }), ctx.signal)
          : ctx.reply(message.text, Object.freeze({ messageId: message.messageId }), ctx.signal), 'reply-failed')
        const ready = nextState(state, { pending: state.version === 3
          ? { ...state.pending, phase: 'ready', parts: textOnly
            ? [{ kind: 'text', clientId: randomUUID(), text: textValue(reply, 'invalid-reply') }]
            : deliveryParts(reply) }
          : { ...state.pending, phase: 'ready', replyText: textValue(reply, 'invalid-reply') } })
        await commit(ctx, state, ready)
        state = ready
      }
      if (state.pending.phase !== 'ready') fail('recovery-required')
      for (;;) {
        reserveRevisions(state, 2)
        const part = state.version === 3 ? state.pending.parts[state.pending.next]
          : { kind: 'text', clientId: state.pending.clientId, text: state.pending.replyText }
        const sending = nextState(state, { pending: { ...state.pending, phase: 'sending' } })
        await commit(ctx, state, sending)
        state = sending
        authorizeSend(ctx)
        check(ctx)
        const sent = await io(ctx, () => {
          authorizeSend(ctx); check(ctx)
          const target = { toUserId: state.credentials.userId, contextToken: message.contextToken, clientId: part.clientId }
          return part.kind === 'text' ? ctx.api.sendText(state.credentials, { ...target, text: part.text }, ctx.signal)
            : ctx.media.send(state.credentials, { ...part, ...target }, ctx.signal, () => { authorizeSend(ctx); check(ctx); return true })
        }, 'send-failed', 'send')
        const accepted = record(sent, ['accepted'], 'invalid-response')
        if (accepted.accepted !== true) fail('invalid-response')
        // Preserve the checked API fact even if the completion CAS fails.
        if (textOnly) opts.onTextAccepted?.()
        if (state.version === 3 && state.pending.next + 1 < state.pending.parts.length) {
          const next = nextState(state, { pending: { ...state.pending, phase: 'ready', next: state.pending.next + 1 } })
          await commit(ctx, state, next); state = next; ctx.deliveryUnknown = false
          continue
        }
        const completed = finishQueuedMessage(state, true)
        const references = state.version === 3 ? state.pending.parts.filter(part => part.kind !== 'text').map(part => part.reference) : []
        await commit(ctx, state, completed.next)
        state = completed.next; counts = textOnly ? Object.freeze({ ...counts, replied: 1 }) : completed.counts; ctx.deliveryUnknown = false
        if (references.length) { try { ctx.media.release(references) } catch {} }
        break
      }
      if (textOnly) break // Keep the rest of the durable inbox; never poll or reply again.
    }
    return textOnly ? Object.freeze({ ...counts, remaining: state.queuedBatch?.messages.length ?? 0 }) : counts
  }

  return Object.freeze({
    async getStatus(signal) {
      if (disposed) fail('disposed')
      // Deliberately before input validation or dependency method access.
      if (!enabled) return status(false, 'disabled', undefined)
      return run(signal, async ctx => {
        const state = await readState(ctx)
        const phase = requiresRecovery(state) ? 'recovery-required' : state?.credentials != null ? 'paired'
          : confirmed ? 'awaiting-confirmation' : qr ? 'qr-ready' : 'unpaired'
        return status(true, phase, state, opts.resumeReply)
      })
    },
    async getPairingIdentity(signal) {
      return run(signal, async ctx => {
        const state = await readState(ctx)
        if (state?.credentials == null) fail('not-paired')
        return Object.freeze({ botId: state.credentials.botId, userId: state.credentials.userId })
      })
    },
    async beginLogin(signal) {
      return run(signal, async ctx => {
        if (qr || confirmed) fail('login-active')
        if ((await readState(ctx))?.credentials != null) fail('already-paired')
        const result = loginQr(await io(ctx, () => ctx.api.requestQrCode(ctx.signal), 'api-failed'))
        qr = result
        return Object.freeze({ qrContent: result.qrContent })
      })
    },
    async pollLogin(verifyCode, signal) {
      return pollLoginAction(verifyCode, signal, opts.sessionId !== undefined)
    },
    async pollLoginForOwner(verifyCode, signal) {
      return pollLoginAction(verifyCode, signal, true)
    },
    async confirmPairing(signal) {
      return confirmPairingAction(undefined, signal, false)
    },
    async confirmPairingForOwner(expectedOwnerId, signal) {
      return confirmPairingAction(expectedOwnerId, signal, true)
    },
    async cancelLogin(signal) {
      return run(signal, async () => { clearLogin() })
    },
    async diagnoseUpdatesOnce(signal) {
      return run(signal, async ctx => {
        const state = await readState(ctx)
        if (state?.credentials == null) fail('not-paired')
        return updatesDiagnostic(await io(ctx,
          () => ctx.api.diagnoseUpdatesOnce(state.credentials, state.cursor, ctx.signal), 'api-failed'))
      }, true)
    },
    async pollTextOnce(signal) {
      return run(signal, async ctx => {
        if (opts.sessionId === undefined) fail('invalid-input')
        return pollDurable(ctx, true)
      })
    },
    async resumeTextOnce(confirmation, signal) {
      return run(signal, async ctx => {
        if (confirmation !== 'continue-unanswered-message' || opts.sessionId === undefined) fail('invalid-input')
        if (ctx.resumeReply === undefined) fail('not-configured')
        return pollDurable(ctx, true, true)
      })
    },
    async pollOnce(signal) {
      return run(signal, async ctx => {
        if (opts.sessionId !== undefined) return pollDurable(ctx)
        let state = await readState(ctx)
        if (state?.credentials == null) fail('not-paired')
        if (state.pending !== null) fail('recovery-required')
        const batch = updates(await io(ctx, () => ctx.api.getUpdates(state.credentials, state.cursor, ctx.signal), 'api-failed'))
        const counts = { received: batch.messages.length + batch.ignored, replied: 0, ignored: batch.ignored, duplicates: 0 }
        for (const message of batch.messages) {
          check(ctx)
          // Blank-only inbound text is counted, never claimed or sent to DSH.
          if (message.fromUserId !== state.credentials.userId || message.toUserId !== state.credentials.botId
              || message.text.trim() === '') {
            counts.ignored++
            continue
          }
          if (state.seenMessageIds.includes(message.messageId)) { counts.duplicates++; continue }
          // Reserve a revision for completion/discard before issuing a new claim.
          if (state.revision >= Number.MAX_SAFE_INTEGER - 1) fail('revision-exhausted')
          // A persisted claim precedes BOTH DSH and send. Only the CAS winner proceeds.
          const claimed = nextState(state, { pending: { messageId: message.messageId, clientId: randomUUID() } })
          await commit(ctx, state, claimed)
          state = claimed
          const text = await io(ctx, () => ctx.reply(message.text, Object.freeze({ messageId: message.messageId }), ctx.signal), 'reply-failed')
          textValue(text, 'invalid-reply')
          authorizeSend(ctx)
          check(ctx)
          const sent = await io(ctx, () => {
            authorizeSend(ctx)
            check(ctx)
            return ctx.api.sendText(state.credentials, {
              toUserId: state.credentials.userId, contextToken: message.contextToken,
              clientId: state.pending.clientId, text,
            }, ctx.signal)
          }, 'send-failed', 'send')
          const accepted = record(sent, ['accepted'], 'invalid-response')
          if (accepted.accepted !== true) fail('invalid-response')
          const completed = nextState(state, { seenMessageIds: seenWith(state, message.messageId), pending: null })
          await commit(ctx, state, completed)
          state = completed
          ctx.deliveryUnknown = false
          counts.replied++
        }
        // All messages, including ignored/duplicates, must finish before cursor moves.
        if (state.cursor !== batch.cursor) await commit(ctx, state, nextState(state, { cursor: batch.cursor }))
        return Object.freeze(counts)
      })
    },
    async discardPending(confirmation, signal) {
      return run(signal, async ctx => {
        if (confirmation !== 'discard-without-retry') fail('invalid-input')
        const state = await readState(ctx)
        if (state?.credentials == null) fail('not-paired')
        if (state.pending === null) fail('no-pending')
        if (state.version !== 1) await commit(ctx, state, finishQueuedMessage(state, false).next)
        else await commit(ctx, state, nextState(state, { seenMessageIds: seenWith(state, state.pending.messageId), pending: null }))
        if (state.version === 3 && state.pending.parts) { try { ctx.media.release(state.pending.parts.filter(part => part.kind !== 'text').map(part => part.reference)) } catch {} }
      })
    },
    async forget(confirmation, signal) {
      return run(signal, async ctx => {
        if (confirmation !== 'forget-local-credentials') fail('invalid-input')
        const state = await readState(ctx)
        if (state?.credentials == null) fail('not-paired')
        if (state.pending !== null) fail('recovery-required')
        await commit(ctx, state, nextState(state, { credentials: null, cursor: '', seenMessageIds: [], pending: null,
          ...(state.version !== 1 ? { queuedBatch: null } : {}) }))
        clearLogin()
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearLogin()
      lifecycle.abort()
    },
  })
}
