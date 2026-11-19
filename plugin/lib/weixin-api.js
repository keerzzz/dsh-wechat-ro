// Server-only, independently authored iLink JSON client. Never import from a UI bundle.
// Wire reference: Tencent/openclaw-weixin 2.4.10, pin 874637a0dbc24050f72d1385add4fc6170a2d726.
// That client-derived reference is not a complete server contract or DSH integration.
import { WEIXIN_API_INFO, WEIXIN_LIMITS, WEIXIN_UPDATE_DIAGNOSTIC, WeixinApiError, createWeixinRequest,
  fail, record, field, string, identifier, token, credentials, baseInfo } from './weixin-http.js'
export { WEIXIN_API_INFO, WEIXIN_LIMITS, WEIXIN_UPDATE_DIAGNOSTIC, WeixinApiError }

function qrCodeResult(value) {
  return Object.freeze({
    qrcode: string(value.qrcode, WEIXIN_LIMITS.maxQrCodeBytes, 'invalid-response'),
    qrContent: string(value.qrcode_img_content, WEIXIN_LIMITS.maxQrCodeBytes, 'invalid-response'),
  })
}
function qrStatusResult(value) {
  const { status } = value
  if (status === 'confirmed') {
    return Object.freeze({ status, credentials: credentials({
      botToken: value.bot_token, botId: value.ilink_bot_id,
      userId: value.ilink_user_id, baseUrl: value.baseurl,
    }, 'invalid-response') })
  }
  if (status === 'scaned_but_redirect') {
    if (!Object.hasOwn(value, 'redirect_host')) return Object.freeze({ status })
    const host = value.redirect_host
    string(host, WEIXIN_LIMITS.maxIdentifierBytes, 'invalid-response')
    if (host !== 'ilinkai.weixin.qq.com' && host !== WEIXIN_API_INFO.origin && host !== WEIXIN_API_INFO.origin + '/') fail('unsupported-redirect')
    return Object.freeze({ status, redirectHost: WEIXIN_API_INFO.origin })
  }
  if (['wait', 'scaned', 'expired', 'need_verifycode', 'verify_code_blocked', 'binded_redirect'].includes(status)) {
    return Object.freeze({ status })
  }
  fail('invalid-response')
}
const NON_TEXT_FIELDS = Object.freeze([
  'image_item', 'voice_item', 'file_item', 'video_item',
  'tool_call_start_item', 'tool_call_result_item', 'media', 'thumb_media',
])
function hasMedia(value) {
  return NON_TEXT_FIELDS.some(key => Object.hasOwn(value, key) && value[key] !== null)
}
function textMessage(value) {
  record(value, 'invalid-response', 'message')
  if (!Number.isSafeInteger(value.message_type)) fail('invalid-response', undefined, 'message_type')
  if (value.message_type !== 1) return null
  if (!Number.isSafeInteger(value.message_state)) fail('invalid-response', undefined, 'message_state')
  if (value.message_state !== 2) return null
  if (Object.hasOwn(value, 'group_id') && typeof value.group_id !== 'string') fail('invalid-response', undefined, 'group_id')
  if (value.group_id || hasMedia(value)) return null
  if (!Array.isArray(value.item_list) || value.item_list.length === 0) fail('invalid-response', undefined, 'item_list')
  for (const item of value.item_list) {
    record(item, 'invalid-response', 'item')
    if (!Number.isSafeInteger(item.type)) fail('invalid-response', undefined, 'item_type')
  }
  if (value.item_list.some(item => item.type !== 1 || hasMedia(item)
      || (item.ref_msg !== undefined && item.ref_msg !== null && hasMedia(record(item.ref_msg, 'invalid-response', 'ref_msg'))))) return null
  const texts = []
  let bytes = 0
  for (const item of value.item_list) {
    record(item.text_item, 'invalid-response', 'text_item')
    const text = string(item.text_item.text, WEIXIN_LIMITS.maxTextBytes, 'invalid-response', true, 'text')
    bytes += Buffer.byteLength(text, 'utf8') + (texts.length === 0 ? 0 : 1)
    if (bytes > WEIXIN_LIMITS.maxTextBytes) fail('invalid-response', undefined, 'text')
    texts.push(text)
  }
  const messageId = value.message_id
  if (bytes === 0) fail('invalid-response', undefined, 'text')
  if (typeof messageId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(messageId)
      || BigInt(messageId) > 18446744073709551615n) fail('invalid-response', undefined, 'message_id')
  return Object.freeze({
    messageId,
    fromUserId: identifier(value.from_user_id, 'invalid-response', 'from_user_id'),
    toUserId: identifier(value.to_user_id, 'invalid-response', 'to_user_id'),
    contextToken: token(value.context_token, 'invalid-response', false, 'context_token'),
    text: texts.join('\n'),
  })
}
function updatesResult(value, previousCursor) {
  const items = value.msgs ?? []
  if (!Array.isArray(items) || items.length > WEIXIN_LIMITS.maxMessages) fail('invalid-response', undefined, 'msgs')
  const cursor = value.get_updates_buf === undefined || value.get_updates_buf === '' ? previousCursor
    : string(value.get_updates_buf, WEIXIN_LIMITS.maxCursorBytes, 'invalid-response', false, 'get_updates_buf')
  const messages = []
  let ignored = 0
  for (const candidate of items) {
    const message = textMessage(candidate)
    if (message === null) ignored += 1
    else messages.push(message)
  }
  return Object.freeze({ cursor, messages: Object.freeze(messages), ignored })
}

function updatesRequest(auth, cursor) {
  const checked = credentials(auth, 'invalid-input')
  string(cursor, WEIXIN_LIMITS.maxCursorBytes, 'invalid-input', true)
  return { method: 'POST', path: '/ilink/bot/getupdates', botToken: checked.botToken,
    body: { get_updates_buf: cursor, base_info: baseInfo() } }
}

/** Explicit fetch injection; no import/construction I/O, polling or retries. */
export function createWeixinApi(options) {
  const request = createWeixinRequest(options)
  return Object.freeze({
    async requestQrCode(signal) {
      return request(() => ({ method: 'POST', path: '/ilink/bot/get_bot_qrcode?bot_type=3', body: { local_token_list: [] } }), qrCodeResult, false, false, signal)
    },
    async getQrStatus(qrcode, verifyCode, signal) {
      return request(() => {
        string(qrcode, WEIXIN_LIMITS.maxQrCodeBytes, 'invalid-input')
        const query = new URLSearchParams({ qrcode })
        if (verifyCode !== undefined) query.set('verify_code', string(verifyCode, WEIXIN_LIMITS.maxVerifyCodeBytes, 'invalid-input'))
        return { method: 'GET', path: '/ilink/bot/get_qrcode_status?' + query.toString() }
      }, qrStatusResult, false, false, signal)
    },
    async getUpdates(auth, cursor, signal) {
      return request(() => updatesRequest(auth, cursor), value => updatesResult(value, cursor), false, false, signal)
    },
    async diagnoseUpdatesOnce(auth, cursor, signal) {
      const diagnostic = { version: 1, outcome: 'valid', errorCode: null, validationField: null,
        msgsShape: null, cursorShape: null, messageCount: null, textCount: null, ignoredCount: null,
        httpStatus: null, businessCode: null }
      try {
        const batch = await request(() => updatesRequest(auth, cursor), value => updatesResult(value, cursor),
          false, false, signal, undefined, diagnostic)
        return Object.freeze({ ...diagnostic, textCount: batch.messages.length, ignoredCount: batch.ignored })
      } catch (error) {
        const checked = error instanceof WeixinApiError ? error : new WeixinApiError('invalid-response')
        const invalid = WEIXIN_UPDATE_DIAGNOSTIC.invalidErrorCodes.includes(checked.code)
        return Object.freeze({ ...diagnostic, outcome: invalid ? 'invalid' : 'failed', errorCode: checked.code,
          validationField: invalid ? diagnostic.validationField : null,
          httpStatus: checked.httpStatus ?? diagnostic.httpStatus, businessCode: checked.businessCode ?? null })
      }
    },
    async sendText(auth, message, signal) {
      // SendMessageResp may omit zero-valued ret; present business codes are checked.
      return request(() => {
        const checked = credentials(auth, 'invalid-input')
        record(message, 'invalid-input')
        const msg = {
          from_user_id: '',
          to_user_id: identifier(field(message, 'toUserId', 'invalid-input'), 'invalid-input'),
          client_id: identifier(field(message, 'clientId', 'invalid-input'), 'invalid-input'),
          message_type: 2, message_state: 2,
          context_token: token(field(message, 'contextToken', 'invalid-input'), 'invalid-input'),
          item_list: [{ type: 1, text_item: { text: string(field(message, 'text', 'invalid-input'), WEIXIN_LIMITS.maxTextBytes, 'invalid-input') } }],
        }
        return { method: 'POST', path: '/ilink/bot/sendmessage', botToken: checked.botToken,
          body: { msg, base_info: baseInfo() } }
      }, () => Object.freeze({ accepted: true }), false, true, signal)
    },
  })
}
