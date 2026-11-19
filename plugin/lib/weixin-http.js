import { randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'

export const WEIXIN_API_INFO = Object.freeze({ origin: 'https://ilinkai.weixin.qq.com', version: '0.1.0', botAgent: 'WechatRo/0.1.0' })
export const WEIXIN_CDN_ORIGIN = 'https://novac2c.cdn.weixin.qq.com'
export const WEIXIN_LIMITS = Object.freeze({ maxResponseBytes: 1048576, maxTextBytes: 4000, maxMessages: 256,
  maxTokenBytes: 8192, maxQrCodeBytes: 8192, maxCursorBytes: 65536, maxVerifyCodeBytes: 64,
  maxIdentifierBytes: 512, defaultTimeoutMs: 40000 })
export const WEIXIN_UPDATE_DIAGNOSTIC = Object.freeze({
  version: 1,
  outcomes: Object.freeze(['valid', 'invalid', 'failed']),
  invalidErrorCodes: Object.freeze(['invalid-response', 'invalid-json', 'invalid-mime', 'response-too-large']),
  validationFields: Object.freeze(['http-response', 'response-body', 'root', 'ret', 'errcode', 'msgs', 'get_updates_buf',
    'message', 'message_type', 'message_state', 'group_id', 'item_list', 'item', 'item_type', 'ref_msg',
    'text_item', 'text', 'message_id', 'from_user_id', 'to_user_id', 'context_token']),
  msgsShapes: Object.freeze(['omitted', 'null', 'array', 'other']),
  cursorShapes: Object.freeze(['omitted', 'empty', 'string', 'other']),
})
const ERROR_MESSAGES = Object.freeze({
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
export function isWeixinApiErrorCode(code) {
  return typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)
}
export class WeixinApiError extends Error {
  constructor(code, details) {
    const safeCode = isWeixinApiErrorCode(code) ? code : 'invalid-response'
    super(ERROR_MESSAGES[safeCode])
    this.name = 'WeixinApiError'; this.code = safeCode; this.deliveryUnknown = false
    try {
      const { httpStatus, businessCode, deliveryUnknown } = details ?? {}
      if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) this.httpStatus = httpStatus
      if (Number.isSafeInteger(businessCode)) this.businessCode = businessCode
      this.deliveryUnknown = deliveryUnknown === true
    } catch { /* Caller-provided details and their exceptions never escape. */ }
    Object.freeze(this)
  }
}
class Failure {
  constructor(code, businessCode, validationField) {
    this.code = code; this.businessCode = businessCode; this.validationField = validationField
  }
}
export function fail(code, businessCode, validationField) { throw new Failure(code, businessCode, validationField) }
function publicError(error, fallback, httpStatus, dispatched = false, isSend = false) {
  const code = error instanceof Failure ? error.code : fallback
  return new WeixinApiError(code, { httpStatus, businessCode: error instanceof Failure ? error.businessCode : undefined,
    deliveryUnknown: isSend && dispatched && code !== 'business-error'
      && !(code === 'http-error' && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) })
}
export function record(value, code, validationField) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code, undefined, validationField)
  return value
}
export function field(value, key, code) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code)
  return descriptor.value
}
export function string(value, maxBytes, code, allowEmpty = false, validationField) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxBytes
    || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > maxBytes) fail(code, undefined, validationField)
  return value
}
export function identifier(value, code, validationField) {
  string(value, WEIXIN_LIMITS.maxIdentifierBytes, code, false, validationField)
  if (!/^[A-Za-z0-9_][A-Za-z0-9._:@-]*$/.test(value)) fail(code, undefined, validationField)
  return value
}
export function token(value, code, header = false, validationField) {
  string(value, WEIXIN_LIMITS.maxTokenBytes, code, false, validationField)
  if (header ? !/^[\x21-\x7e]+$/.test(value) : /[\x00-\x20\x7f]/.test(value)) fail(code, undefined, validationField)
  return value
}
export function credentials(value, code) {
  record(value, code)
  const baseUrl = string(field(value, 'baseUrl', code), WEIXIN_LIMITS.maxIdentifierBytes, code)
  if (baseUrl !== WEIXIN_API_INFO.origin && baseUrl !== WEIXIN_API_INFO.origin + '/') fail('unsupported-origin')
  return Object.freeze({ botToken: token(field(value, 'botToken', code), code, true),
    botId: identifier(field(value, 'botId', code), code), userId: identifier(field(value, 'userId', code), code), baseUrl: WEIXIN_API_INFO.origin })
}
function parseOptions(options = {}) {
  record(options, 'invalid-options')
  const prototype = Object.getPrototypeOf(options)
  if (prototype !== Object.prototype && prototype !== null) fail('invalid-options')
  const values = Object.create(null)
  for (const key of Reflect.ownKeys(options)) {
    if (!['fetcher', 'timeoutMs', 'maxResponseBytes'].includes(key)) fail('invalid-options')
    values[key] = field(options, key, 'invalid-options')
  }
  if (values.fetcher !== undefined && typeof values.fetcher !== 'function') fail('invalid-options')
  const timeoutMs = Object.hasOwn(values, 'timeoutMs') ? values.timeoutMs : WEIXIN_LIMITS.defaultTimeoutMs
  const maxResponseBytes = Object.hasOwn(values, 'maxResponseBytes') ? values.maxResponseBytes : WEIXIN_LIMITS.maxResponseBytes
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isInteger(maxResponseBytes)
    || maxResponseBytes < 1 || maxResponseBytes > WEIXIN_LIMITS.maxResponseBytes) fail('invalid-options')
  return { fetcher: values.fetcher, timeoutMs, maxResponseBytes }
}
export function baseInfo() { return { channel_version: WEIXIN_API_INFO.version, bot_agent: WEIXIN_API_INFO.botAgent } }
function requestHeaders(method, botToken) {
  const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '256' }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json'; headers.AuthorizationType = 'ilink_bot_token'
    headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE()), 'ascii').toString('base64')
    if (botToken !== undefined) headers.Authorization = 'Bearer ' + botToken
  }
  return headers
}
function cancelBody(response) {
  try { if (response instanceof Response && response.body && !response.body.locked) void response.body.cancel().catch(() => {}) } catch {}
}
function cancelReader(reader) {
  try { void reader.cancel().catch(() => {}) } catch {}
  try { reader.releaseLock() } catch {}
}
function checkResponse(response, origin) {
  if (!(response instanceof Response)) fail('invalid-response', undefined, 'http-response')
  const status = response.status
  if (status === 0) fail('network-error')
  if (!Number.isInteger(status) || status < 100 || status > 599) fail('invalid-response', undefined, 'http-response')
  if (response.redirected === true) fail('unsupported-redirect')
  if (response.redirected !== false || typeof response.url !== 'string') fail('invalid-response', undefined, 'http-response')
  if (response.url !== '') {
    let url
    try { url = new URL(response.url) } catch { fail('invalid-response', undefined, 'http-response') }
    if (url.origin !== origin || url.username || url.password) fail('unsupported-origin')
  }
  return status
}
function businessResult(value, requireRet) {
  record(value, 'invalid-response', 'root')
  for (const key of ['ret', 'errcode']) if (Object.hasOwn(value, key) && !Number.isSafeInteger(value[key])) fail('invalid-response', undefined, key)
  for (const key of ['ret', 'errcode']) if (Object.hasOwn(value, key) && value[key] !== 0) fail('business-error', value[key])
  if (requireRet && (!Object.hasOwn(value, 'ret') || value.ret !== 0)) fail('invalid-response', undefined, 'ret')
}

// Internal fixed-origin transport; neither factory is exposed as a model or Owner RPC.
export function createWeixinRequest(options) {
  let configured
  try { configured = parseOptions(options) } catch (error) { throw publicError(error, 'invalid-options') }
  const { fetcher, timeoutMs, maxResponseBytes } = configured
  return async function request(build, project, requireRet, isSend, signal, authorize, diagnostic) {
    if (fetcher === undefined) throw new WeixinApiError('not-configured')
    let input, url, origin
    try {
      if (signal !== undefined && !(signal instanceof AbortSignal)) fail('invalid-input')
      if (signal?.aborted) fail('aborted')
      input = build()
      origin = input.cdn ? WEIXIN_CDN_ORIGIN : WEIXIN_API_INFO.origin
      url = new URL(input.cdn || origin + input.path)
      if (url.origin !== origin || url.username || url.password || url.hash
        || (input.cdn && url.pathname !== '/c2c/upload')) fail('unsupported-origin')
    } catch (error) { throw publicError(error, 'invalid-input') }
    const controller = new AbortController(), deadline = performance.now() + timeoutMs
    let timer, externalListener = false, stopCode, finished = false, dispatched = false, response, reader, httpStatus
    let fallback = 'network-error'
    const stop = code => { if (!finished && stopCode === undefined) { stopCode = code; controller.abort() } }
    const onExternalAbort = () => stop('aborted')
    const checkActive = () => {
      if (stopCode === undefined && performance.now() >= deadline) stop('timeout')
      if (stopCode !== undefined) fail(stopCode)
    }
    const waitForIo = async (start, receive) => {
      checkActive()
      let onAbort
      try {
        const work = Promise.resolve().then(() => { checkActive(); return start() }).then(value => { if (receive) receive(value); return value })
        const interrupted = new Promise((_, reject) => {
          onAbort = () => reject(new Failure(stopCode ?? 'aborted'))
          controller.signal.addEventListener('abort', onAbort, { once: true })
          if (controller.signal.aborted) onAbort()
        })
        const value = await Promise.race([work, interrupted]); checkActive(); return value
      } catch { checkActive(); fail('network-error') }
      finally { if (onAbort) controller.signal.removeEventListener('abort', onAbort) }
    }
    try {
      if (signal !== undefined) { signal.addEventListener('abort', onExternalAbort, { once: true }); externalListener = true; if (signal.aborted) stop('aborted') }
      checkActive(); timer = setTimeout(() => stop('timeout'), timeoutMs)
      const init = { method: input.method, headers: input.cdn ? { 'Content-Type': 'application/octet-stream' } : requestHeaders(input.method, input.botToken),
        redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        ...(input.body === undefined ? {} : { body: input.cdn ? input.body : JSON.stringify(input.body) }) }
      await waitForIo(() => {
        if (authorize) {
          let allowed
          try { allowed = authorize() } catch { stop('aborted') }
          if (allowed !== true) { try { Promise.prototype.then.call(allowed, undefined, () => {}) } catch {} stop('aborted') }
          checkActive()
        }
        dispatched = true; return fetcher(url.href, init)
      }, value => { if (finished || stopCode !== undefined) cancelBody(value); else response = value })
      fallback = 'invalid-response'; httpStatus = checkResponse(response, origin)
      if (diagnostic) diagnostic.httpStatus = httpStatus
      if (httpStatus < 200 || httpStatus >= 300 || (input.cdn && httpStatus !== 200)) fail('http-error')
      if (input.cdn) { const result = project(response.headers); checkActive(); return result }
      // Fixed official RPCs validate bounded JSON bodies, not MIME labels.
      const length = response.headers.get('content-length')
      if (length !== null && /^\d+$/.test(length) && Number(length) > maxResponseBytes) fail('response-too-large', undefined, 'response-body')
      if (response.body === null) fail('invalid-json', undefined, 'response-body')
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true }), chunks = []
      let bytes = 0
      while (true) {
        const chunk = await waitForIo(() => reader.read())
        if (chunk.done) break
        if (!(chunk.value instanceof Uint8Array)) fail('invalid-response', undefined, 'response-body')
        bytes += chunk.value.byteLength
        if (bytes > maxResponseBytes) fail('response-too-large', undefined, 'response-body')
        try { const decoded = decoder.decode(chunk.value, { stream: true }); if (decoded !== '') chunks.push(decoded) } catch { fail('invalid-json', undefined, 'response-body') }
      }
      try { chunks.push(decoder.decode()) } catch { fail('invalid-json', undefined, 'response-body') }
      checkActive()
      let value
      try {
        value = JSON.parse(chunks.join(''), (key, item, context) => {
          // Native source text preserves uint64 before binary64 rounding; never scan JSON strings.
          if (key === 'message_id' && typeof item === 'number' && typeof context?.source === 'string') return context.source
          return item
        })
      } catch { fail('invalid-json', undefined, 'response-body') }
      // Observe only fixed structural facts; never retain a reference to decoded data.
      if (diagnostic && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        diagnostic.msgsShape = !Object.hasOwn(value, 'msgs') ? 'omitted' : value.msgs === null ? 'null'
          : Array.isArray(value.msgs) ? 'array' : 'other'
        diagnostic.cursorShape = !Object.hasOwn(value, 'get_updates_buf') ? 'omitted' : value.get_updates_buf === '' ? 'empty'
          : typeof value.get_updates_buf === 'string' ? 'string' : 'other'
        diagnostic.messageCount = value.msgs == null ? 0
          : Array.isArray(value.msgs) && value.msgs.length <= WEIXIN_LIMITS.maxMessages ? value.msgs.length : null
      }
      businessResult(value, requireRet)
      const result = project(value); checkActive(); return result
    } catch (error) {
      if (diagnostic && error instanceof Failure && WEIXIN_UPDATE_DIAGNOSTIC.validationFields.includes(error.validationField)) {
        diagnostic.validationField = error.validationField
      }
      throw publicError(error, fallback, httpStatus, dispatched, isSend)
    }
    finally {
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      if (externalListener) signal.removeEventListener('abort', onExternalAbort)
      if (reader !== undefined) cancelReader(reader); else cancelBody(response)
    }
  }
}
