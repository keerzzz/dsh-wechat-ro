// Standalone, opt-in adapter for the reviewed same-origin login-management API.
// This module neither installs the provider nor proves messaging readiness.

export const WECHAT_CHANNEL_PROVIDER = Object.freeze({
  package: 'dsh-channel-wechat',
  reviewedVersion: '0.2.8',
})

export const WECHAT_CHANNEL_ENDPOINTS = Object.freeze({
  status: '/api/channel-wechat/status',
  begin: '/api/channel-wechat/begin',
  verifyCode: '/api/channel-wechat/verify-code',
  logout: '/api/channel-wechat/logout',
  qrImage: '/api/channel-wechat/qr.svg',
  // Opening this page starts an upstream login attempt. Never open it implicitly.
  login: '/api/channel-wechat/login',
})

export const CHANNEL_LOGIN_PHASES = Object.freeze([
  'idle', 'waiting', 'scanned', 'need-verifycode',
  'connected', 'already-connected', 'failed',
])

const ERROR_MESSAGES = Object.freeze({
  'not-configured': 'WeChat channel transport is not configured.',
  'invalid-code': 'A non-empty verification code is required.',
  aborted: 'This request was cancelled; the upstream login attempt may still be running.',
  unauthorized: 'WeChat channel authentication is required.',
  forbidden: 'WeChat channel access is forbidden.',
  'not-found': 'WeChat channel endpoint is unavailable.',
  'http-error': 'WeChat channel request failed.',
  'network-error': 'WeChat channel transport failed.',
  'invalid-json': 'WeChat channel returned invalid JSON.',
  'invalid-mime': 'WeChat channel returned an unexpected media type.',
  'invalid-response': 'WeChat channel returned an invalid response.',
})

/** Only a fixed code/message and an optional numeric HTTP status escape. */
export class WechatChannelError extends Error {
  constructor(code, status) {
    const safeCode = typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)
      ? code : 'invalid-response'
    super(ERROR_MESSAGES[safeCode])
    this.name = 'WechatChannelError'
    this.code = safeCode
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status
  }
}

function checkAborted(signal) {
  // Never propagate AbortSignal.reason: it may contain caller or transport data.
  if (signal?.aborted) throw new WechatChannelError('aborted')
}

/** Also stop this wait when an injected transport ignores cancellation. */
async function waitForIo(start, signal, status) {
  checkAborted(signal)
  let onAbort
  try {
    // The deferred call lets a cancellation before I/O prevent that I/O entirely.
    const work = Promise.resolve().then(() => {
      checkAborted(signal)
      return start()
    })
    const result = signal === undefined ? await work : await Promise.race([
      work,
      new Promise((_, reject) => {
        onAbort = () => reject(new WechatChannelError('aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
    ])
    checkAborted(signal)
    return result
  } catch {
    checkAborted(signal)
    throw new WechatChannelError('network-error', status)
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

function readHttpStatus(response) {
  try {
    const status = response.status
    if (Number.isInteger(status) && (status === 0 || (status >= 100 && status <= 599))) {
      return status
    }
  } catch { /* A broken injected transport must not expose its exception. */ }
  throw new WechatChannelError('invalid-response')
}

function requireMime(response, expected, status) {
  try {
    const value = response.headers.get('content-type')
    if (typeof value === 'string' && value.split(';', 1)[0].trim().toLowerCase() === expected) return
  } catch { /* Do not retain header values or transport errors. */ }
  throw new WechatChannelError('invalid-mime', status)
}

const STATUS_FIELDS = Object.freeze(['phase', 'qrcodeUrl', 'message', 'accountId', 'storedAccountId'])
const POST_FIELDS = Object.freeze(['phase'])

function validateLoginJson(value, fields, status) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !Object.hasOwn(value, 'phase')
      || Object.keys(value).some(key => !fields.includes(key) || typeof value[key] !== 'string')
      || !CHANNEL_LOGIN_PHASES.includes(value.phase)) {
    throw new WechatChannelError('invalid-response', status)
  }
  return value
}

/**
 * No transport is selected implicitly. Importing/constructing does no I/O and
 * starts no timer. A supplied fetcher must honor the fixed RequestInit policy.
 * Cancellation ends only the local wait: it is not an upstream login rollback.
 */
export function createWechatChannelClient(fetcher) {
  async function request(path, method, signal, code) {
    if (typeof fetcher !== 'function') throw new WechatChannelError('not-configured')
    checkAborted(signal)
    const init = {
      method,
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    }
    if (path === WECHAT_CHANNEL_ENDPOINTS.verifyCode) {
      if (typeof code !== 'string' || code.trim() === '') throw new WechatChannelError('invalid-code')
      init.headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
      init.body = new URLSearchParams({ code: code.trim() })
    }
    const response = await waitForIo(() => fetcher(path, init), signal)
    checkAborted(signal)
    const status = readHttpStatus(response)
    if (status === 0) throw new WechatChannelError('network-error')
    if (status === 401) throw new WechatChannelError('unauthorized', status)
    if (status === 403) throw new WechatChannelError('forbidden', status)
    if (status === 404 && path !== WECHAT_CHANNEL_ENDPOINTS.qrImage) {
      throw new WechatChannelError('not-found', status)
    }
    if ((status < 200 || status >= 300) && !(status === 404 && path === WECHAT_CHANNEL_ENDPOINTS.qrImage)) {
      throw new WechatChannelError('http-error', status)
    }
    return { response, status }
  }

  async function loginJson(path, method, signal, code) {
    const { response, status } = await request(path, method, signal, code)
    checkAborted(signal)
    requireMime(response, 'application/json', status)
    const text = await waitForIo(() => response.text(), signal, status)
    checkAborted(signal)
    let parsed
    try { parsed = JSON.parse(text) }
    catch { throw new WechatChannelError('invalid-json', status) }
    const isStatus = path === WECHAT_CHANNEL_ENDPOINTS.status
    const value = validateLoginJson(parsed, isStatus ? STATUS_FIELDS : POST_FIELDS, status)
    if (!isStatus) return Object.freeze({ loginPhase: value.phase })
    const qrAvailable = Boolean(value.qrcodeUrl)
    return Object.freeze({
      loginPhase: value.phase,
      hasStoredLogin: Boolean(value.storedAccountId),
      qrAvailable,
      qrImagePath: qrAvailable ? WECHAT_CHANNEL_ENDPOINTS.qrImage : null,
      // connected precedes credential persistence/startup; stored IDs can be stale.
      messagingVerified: false,
    })
  }

  return Object.freeze({
    async getStatus(signal) {
      return loginJson(WECHAT_CHANNEL_ENDPOINTS.status, 'GET', signal)
    },
    async beginLogin(signal) {
      return loginJson(WECHAT_CHANNEL_ENDPOINTS.begin, 'POST', signal)
    },
    async submitVerifyCode(code, signal) {
      return loginJson(WECHAT_CHANNEL_ENDPOINTS.verifyCode, 'POST', signal, code)
    },
    async logout(signal) {
      // The upstream response does not reset phase. Return it without inventing one.
      return loginJson(WECHAT_CHANNEL_ENDPOINTS.logout, 'POST', signal)
    },
    async readQrImage(signal) {
      const { response, status } = await request(WECHAT_CHANNEL_ENDPOINTS.qrImage, 'GET', signal)
      checkAborted(signal)
      if (status === 404) return null
      requireMime(response, 'image/svg+xml', status)
      const blob = await waitForIo(() => response.blob(), signal, status)
      checkAborted(signal)
      // Intended for an img Blob URL, never inline SVG/HTML. The caller owns URLs.
      return blob
    },
  })
}
