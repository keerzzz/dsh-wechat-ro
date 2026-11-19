// Offline contract tests only. No GUI, real accounts, provider install or Internet.
import assert from 'node:assert/strict'
import { inspect } from 'node:util'

const SECRET = Object.freeze({
  qr: 'https://example.invalid/qr?token=synthetic-qr-secret',
  account: 'synthetic-account-private',
  stored: 'synthetic-old-stored-account',
  message: 'synthetic-private-upstream-message',
  code: 'synthetic-code-&=+%/验证码',
  token: 'synthetic-private-token',
})
const MESSAGES = {
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
}
let checks = 0
let channel
async function test(label, run) {
  try { await run(); checks += 1 }
  catch (error) { console.error('FAIL: ' + label); throw error }
}
function json(value, status = 200, mime = 'application/json; charset=utf-8') {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': mime } })
}
function svg(value = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>') {
  return new Response(value, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' } })
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() {
  for (let i = 0; i < 16; i += 1) await Promise.resolve()
}
function noSecrets(value) {
  const rendered = typeof value === 'string' ? value : inspect(value, { showHidden: true, depth: 8 })
  for (const secret of Object.values(SECRET)) assert.equal(rendered.includes(secret), false)
}
function checkError(error, code, status) {
  assert.ok(error instanceof channel.WechatChannelError)
  assert.equal(error.name, 'WechatChannelError')
  assert.equal(error.code, code)
  assert.equal(error.message, MESSAGES[code])
  assert.equal(error.status, status)
  assert.equal(Object.hasOwn(error, 'status'), status !== undefined)
  assert.equal('cause' in error, false)
  assert.deepEqual(Object.keys(error).sort(), status === undefined ? ['code', 'name'] : ['code', 'name', 'status'])
  noSecrets(error)
  noSecrets(JSON.stringify(error))
  noSecrets(String(error))
  noSecrets(error.stack)
  return true
}
function rejects(promise, code, status) {
  assert.ok(promise instanceof Promise, 'every operation returns a Promise')
  return assert.rejects(promise, error => checkError(error, code, status))
}

// Warm the native body implementation before probing module import/construction.
await new Response('synthetic warmup').text()
await test('import/construction/unconfigured operations have no global effects or I/O', async () => {
  const names = Reflect.ownKeys(globalThis)
  const trapped = ['fetch', 'setTimeout', 'setInterval', 'setImmediate', 'open']
  const originals = new Map(trapped.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const urlOriginal = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  let touches = 0
  const trap = () => { touches += 1; throw new Error('unexpected global activity') }
  try {
    for (const name of trapped) Object.defineProperty(globalThis, name, { configurable: true, get: trap })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: trap })
    channel = await import('../lib/channel.js')
    let calls = 0
    const configured = channel.createWechatChannelClient(async () => { calls += 1; return json({ phase: 'idle' }) })
    assert.equal(calls, 0)
    assert.ok(Object.isFrozen(configured))
    const aborted = new AbortController()
    aborted.abort(SECRET.token)
    for (const fetcher of [undefined, null, {}, { baseUrl: SECRET.qr, token: SECRET.token }, 1, 'fetch']) {
      const client = channel.createWechatChannelClient(fetcher)
      await rejects(client.getStatus(), 'not-configured')
      await rejects(client.beginLogin(aborted.signal), 'not-configured')
      await rejects(client.submitVerifyCode('', aborted.signal), 'not-configured')
      await rejects(client.logout(), 'not-configured')
      await rejects(client.readQrImage(aborted.signal), 'not-configured')
    }
    assert.equal(touches, 0)
    assert.equal(calls, 0)
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
    if (urlOriginal === undefined) delete URL.createObjectURL
    else Object.defineProperty(URL, 'createObjectURL', urlOriginal)
  }
  assert.deepEqual(Reflect.ownKeys(globalThis), names)
})

const { createWechatChannelClient, WECHAT_CHANNEL_ENDPOINTS: ENDPOINTS, CHANNEL_LOGIN_PHASES: PHASES } = channel
const callsFor = [
  { name: 'getStatus', route: 'status', method: 'GET', call: (client, signal) => client.getStatus(signal) },
  { name: 'beginLogin', route: 'begin', method: 'POST', call: (client, signal) => client.beginLogin(signal) },
  { name: 'submitVerifyCode', route: 'verifyCode', method: 'POST', call: (client, signal) => client.submitVerifyCode('  ' + SECRET.code + '  ', signal) },
  { name: 'logout', route: 'logout', method: 'POST', call: (client, signal) => client.logout(signal) },
  { name: 'readQrImage', route: 'qrImage', method: 'GET', call: (client, signal) => client.readQrImage(signal) },
]
const jsonCalls = callsFor.filter(spec => spec.route !== 'qrImage')
function successful(spec) { return spec.route === 'qrImage' ? svg() : json({ phase: 'idle' }) }

await test('exact independent named exports and immutable provider/routes/phases', async () => {
  assert.deepEqual(Object.keys(channel).sort(), [
    'CHANNEL_LOGIN_PHASES', 'WECHAT_CHANNEL_ENDPOINTS', 'WECHAT_CHANNEL_PROVIDER',
    'WechatChannelError', 'createWechatChannelClient',
  ].sort())
  assert.deepEqual(channel.WECHAT_CHANNEL_PROVIDER, { package: 'dsh-channel-wechat', reviewedVersion: '0.2.8' })
  assert.deepEqual(ENDPOINTS, {
    status: '/api/channel-wechat/status', begin: '/api/channel-wechat/begin',
    verifyCode: '/api/channel-wechat/verify-code', logout: '/api/channel-wechat/logout',
    qrImage: '/api/channel-wechat/qr.svg', login: '/api/channel-wechat/login',
  })
  assert.deepEqual(PHASES, ['idle', 'waiting', 'scanned', 'need-verifycode', 'connected', 'already-connected', 'failed'])
  for (const value of [channel.WECHAT_CHANNEL_PROVIDER, ENDPOINTS, PHASES]) assert.ok(Object.isFrozen(value))
  assert.throws(() => { ENDPOINTS.begin = SECRET.qr }, TypeError)
  assert.throws(() => { PHASES.push('ready') }, TypeError)
  assert.deepEqual(Object.keys(createWechatChannelClient()).sort(), callsFor.map(spec => spec.name).sort())
})

for (const spec of callsFor) {
  for (const withSignal of [false, true]) {
    await test(spec.name + ': fixed route/method/security options/same signal', async () => {
      const signal = withSignal ? new AbortController().signal : undefined
      let calls = 0
      const client = createWechatChannelClient(async (input, init) => {
        calls += 1
        assert.equal(input, ENDPOINTS[spec.route])
        assert.equal(typeof input, 'string')
        assert.notEqual(input, ENDPOINTS.login)
        assert.equal(init.method, spec.method)
        assert.equal(init.mode, 'same-origin')
        assert.equal(init.credentials, 'same-origin')
        assert.equal(init.cache, 'no-store')
        assert.equal(init.redirect, 'error')
        assert.equal(init.signal, signal)
        const keys = ['method', 'mode', 'credentials', 'cache', 'redirect']
        if (withSignal) keys.push('signal')
        if (spec.route === 'verifyCode') {
          keys.push('headers', 'body')
          assert.deepEqual(init.headers, { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' })
          assert.ok(init.body instanceof URLSearchParams)
          assert.deepEqual([...init.body], [['code', SECRET.code]])
          assert.deepEqual([...new URLSearchParams(init.body.toString())], [['code', SECRET.code]])
        }
        assert.deepEqual(Object.keys(init).sort(), keys.sort())
        return successful(spec)
      })
      await spec.call(client, signal)
      await flush()
      assert.equal(calls, 1, 'no implicit polling, retry, logout, or login-page request')
    })
  }
}

for (const phase of PHASES) {
  await test('whitelist projection and conservative messaging for phase ' + phase, async () => {
    for (const stored of [false, true]) {
      const payload = { phase, qrcodeUrl: SECRET.qr, accountId: SECRET.account, message: SECRET.message }
      if (stored) payload.storedAccountId = SECRET.stored
      const result = await createWechatChannelClient(async () => json(payload)).getStatus()
      assert.deepEqual(result, {
        loginPhase: phase, hasStoredLogin: stored, qrAvailable: true,
        qrImagePath: ENDPOINTS.qrImage, messagingVerified: false,
      })
      assert.ok(Object.isFrozen(result))
      noSecrets(result)
      noSecrets(JSON.stringify(result))
      assert.throws(() => { result.messagingVerified = true }, TypeError)
    }
  })
  for (const spec of jsonCalls.filter(item => item.method === 'POST')) {
    await test(spec.name + ': only loginPhase for phase ' + phase, async () => {
      const result = await spec.call(createWechatChannelClient(async () => json({ phase })))
      assert.deepEqual(result, { loginPhase: phase })
      assert.ok(Object.isFrozen(result))
      assert.equal('ready' in result, false)
      assert.equal('messagingVerified' in result, false)
    })
  }
}
await test('absent/empty optional values are not QR or stored-login evidence', async () => {
  for (const optional of [{}, { qrcodeUrl: '', storedAccountId: '', accountId: '', message: '' }, { accountId: SECRET.account }]) {
    const result = await createWechatChannelClient(async () => json({ phase: 'connected', ...optional })).getStatus()
    assert.deepEqual(result, {
      loginPhase: 'connected', hasStoredLogin: false, qrAvailable: false,
      qrImagePath: null, messagingVerified: false,
    })
  }
})
await test('logout preserves upstream phase and does not cache a synthetic logged-out state', async () => {
  const requests = []
  const client = createWechatChannelClient(async path => {
    requests.push(path)
    return json(path === ENDPOINTS.status ? { phase: 'connected', storedAccountId: SECRET.stored } : { phase: 'connected' })
  })
  assert.deepEqual(await client.logout(), { loginPhase: 'connected' })
  const status = await client.getStatus()
  assert.equal(status.loginPhase, 'connected')
  assert.equal(status.hasStoredLogin, true)
  assert.equal(status.messagingVerified, false)
  assert.deepEqual(requests, [ENDPOINTS.logout, ENDPOINTS.status])
})

await test('verification rejects only non-string/empty-trimmed input without a request', async () => {
  let calls = 0
  const client = createWechatChannelClient(async () => { calls += 1; return json({ phase: 'waiting' }) })
  for (const code of [undefined, null, 42, true, {}, [], new String('code'), Symbol('code'), '', ' \t\n\r ']) {
    await rejects(client.submitVerifyCode(code), 'invalid-code')
  }
  assert.equal(calls, 0)
})
await test('verification accepts arbitrary non-empty strings and sends exactly one encoded code', async () => {
  for (const code of ['x', '123456789012345', ' A&B=+%?/#验证码 \n ', ' line1\nline2 ', 'x'.repeat(4096)]) {
    let calls = 0
    const client = createWechatChannelClient(async (path, init) => {
      calls += 1
      assert.equal(path, ENDPOINTS.verifyCode)
      assert.deepEqual([...init.body], [['code', code.trim()]])
      assert.deepEqual([...new URLSearchParams(init.body.toString())], [['code', code.trim()]])
      return json({ phase: 'need-verifycode' })
    })
    assert.deepEqual(await client.submitVerifyCode(code), { loginPhase: 'need-verifycode' })
    assert.equal(calls, 1)
  }
})

for (const spec of callsFor) {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not-found'], [400, 'http-error'], [429, 'http-error'], [500, 'http-error'], [501, 'http-error'], [503, 'http-error'], [302, 'http-error']]) {
    await test(spec.name + ': sanitized HTTP ' + status, async () => {
      let calls = 0
      const response = new Response(JSON.stringify(SECRET), { status, statusText: SECRET.token, headers: { 'Content-Type': 'text/html' } })
      const client = createWechatChannelClient(async () => { calls += 1; return response })
      if (spec.route === 'qrImage' && status === 404) assert.equal(await spec.call(client), null)
      else await rejects(spec.call(client), code, status)
      await flush()
      assert.equal(response.bodyUsed, false, 'error bodies are not read')
      assert.equal(calls, 1, 'POST failure must not retry or compensate with logout')
    })
  }
  await test(spec.name + ': sanitized fetch rejection and synchronous transport exception', async () => {
    for (const thrown of [new Error(SECRET.token), { body: SECRET.qr, code: SECRET.code }, SECRET.account, null]) {
      for (const synchronous of [false, true]) {
        let calls = 0
        const fail = () => { calls += 1; throw thrown }
        const client = createWechatChannelClient(synchronous ? fail : async () => fail())
        await rejects(spec.call(client), 'network-error')
        await flush()
        assert.equal(calls, 1)
      }
    }
    await rejects(spec.call(createWechatChannelClient(async () => Response.error())), 'network-error')
  })
  await test(spec.name + ': sanitized body-read failure', async () => {
    const response = successful(spec)
    const method = spec.route === 'qrImage' ? 'blob' : 'text'
    response[method] = async () => { throw new Error(SECRET.code) }
    await rejects(spec.call(createWechatChannelClient(async () => response)), 'network-error', 200)
  })
}
for (const spec of jsonCalls) {
  for (const mime of ['', 'text/html', 'text/plain', 'application/problem+json', 'image/svg+xml']) {
    await test(spec.name + ': wrong/missing JSON MIME fails before body read', async () => {
      const response = json({ phase: 'idle', token: SECRET.token }, 200, mime)
      if (mime === '') response.headers.delete('Content-Type')
      await rejects(spec.call(createWechatChannelClient(async () => response)), 'invalid-mime', 200)
      assert.equal(response.bodyUsed, false)
    })
  }
  await test(spec.name + ': case-insensitive JSON MIME essence with parameters', async () => {
    await spec.call(createWechatChannelClient(async () => json({ phase: 'idle' }, 200, 'Application/Json; charset=UTF-8')))
  })
  for (const body of ['', '{', '{"phase":', '{"phase":"' + SECRET.code + '"', '\ufeff{"phase":"idle"}']) {
    await test(spec.name + ': invalid JSON is sanitized', async () => {
      const response = new Response(body, { headers: { 'Content-Type': 'application/json' } })
      // Native Response.text decodes/strips an initial UTF-8 BOM, so this one is
      // intentionally tested through the injected body's returned text instead.
      response.text = async () => body
      await rejects(spec.call(createWechatChannelClient(async () => response)), 'invalid-json', 200)
    })
  }
  for (const value of [null, [], 'idle', 0, true, {}, { phase: null }, { phase: 1 }, { phase: [] }, { phase: {} }, { phase: 'ready' }, { phase: 'waiting ' }, { phase: 'Connected' }]) {
    await test(spec.name + ': malformed root/phase is rejected', async () => {
      await rejects(spec.call(createWechatChannelClient(async () => json(value))), 'invalid-response', 200)
    })
  }
  for (const key of ['token', 'accessToken', 'authorization', 'extra', '__proto__', 'constructor', SECRET.token]) {
    await test(spec.name + ': unknown fields fail closed without leaking values or names', async () => {
      await rejects(spec.call(createWechatChannelClient(async () => json({ phase: 'idle', [key]: SECRET.code }))), 'invalid-response', 200)
    })
  }
}
for (const field of ['qrcodeUrl', 'message', 'accountId', 'storedAccountId']) {
  for (const value of [null, 1, false, [], { token: SECRET.token }]) {
    await test('status validates discarded optional field type: ' + field, async () => {
      await rejects(createWechatChannelClient(async () => json({ phase: 'waiting', [field]: value })).getStatus(), 'invalid-response', 200)
    })
  }
  for (const spec of jsonCalls.filter(item => item.method === 'POST')) {
    await test(spec.name + ': rejects even status-only field ' + field, async () => {
      await rejects(spec.call(createWechatChannelClient(async () => json({ phase: 'waiting', [field]: SECRET.account }))), 'invalid-response', 200)
    })
  }
}
await test('public error constructor only exposes fixed messages/codes and valid HTTP statuses', async () => {
  for (const code of Object.keys(MESSAGES)) checkError(new channel.WechatChannelError(code), code)
  checkError(new channel.WechatChannelError('http-error', 500), 'http-error', 500)
  for (const code of [SECRET.code, '__proto__', 'constructor', null, undefined, {}, 401]) {
    checkError(new channel.WechatChannelError(code), 'invalid-response')
  }
  for (const status of [SECRET.token, {}, null, NaN, Infinity, 0, 99, 600, 401.5]) {
    checkError(new channel.WechatChannelError('http-error', status), 'http-error')
  }
})

for (const spec of callsFor) {
  await test(spec.name + ': pre-aborted and immediately-aborted signals prevent I/O', async () => {
    let calls = 0
    const client = createWechatChannelClient(async () => { calls += 1; return successful(spec) })
    const before = new AbortController()
    before.abort(new Error(SECRET.code))
    await rejects(spec.call(client, before.signal), 'aborted')
    const immediate = new AbortController()
    const pending = spec.call(client, immediate.signal)
    immediate.abort(SECRET.token)
    await rejects(pending, 'aborted')
    assert.equal(calls, 0)
  })
  await test(spec.name + ': cancellation during ignored fetch rejects this wait, not upstream', async () => {
    const controller = new AbortController()
    const entered = deferred()
    const response = deferred()
    const paths = []
    const client = createWechatChannelClient((path, init) => {
      paths.push(path)
      assert.equal(init.signal, controller.signal)
      entered.resolve()
      return response.promise
    })
    let settled = false
    const outcome = spec.call(client, controller.signal).then(
      () => { settled = true; return null },
      error => { settled = true; return error },
    )
    await entered.promise
    controller.abort(SECRET.token)
    try {
      await flush()
      assert.equal(settled, true, 'an uncooperative fetcher cannot retain the local wait')
      checkError(await outcome, 'aborted')
      assert.deepEqual(paths, [ENDPOINTS[spec.route]])
    } finally {
      // The losing promise may still reject. Promise.race must already observe it.
      response.reject(new Error(SECRET.message))
      await flush()
    }
  })
  await test(spec.name + ': cancellation after fetch is checked before response/body use', async () => {
    const controller = new AbortController()
    const response = successful(spec)
    const client = createWechatChannelClient(async (_, init) => {
      assert.equal(init.signal, controller.signal)
      controller.abort(SECRET.account)
      return response
    })
    await rejects(spec.call(client, controller.signal), 'aborted')
    assert.equal(response.bodyUsed, false)
  })
  await test(spec.name + ': cancellation during body read ends wait and ignores later rejection', async () => {
    const controller = new AbortController()
    const bodyStarted = deferred()
    const body = deferred()
    const response = successful(spec)
    response[spec.route === 'qrImage' ? 'blob' : 'text'] = () => { bodyStarted.resolve(); return body.promise }
    let settled = false
    const outcome = spec.call(createWechatChannelClient(async (_, init) => {
      assert.equal(init.signal, controller.signal)
      return response
    }), controller.signal).then(
      () => { settled = true; return null },
      error => { settled = true; return error },
    )
    await bodyStarted.promise
    controller.abort(SECRET.code)
    try {
      await flush()
      assert.equal(settled, true)
      checkError(await outcome, 'aborted')
    } finally {
      body.reject(new Error(SECRET.qr))
      await flush()
    }
  })
  await test(spec.name + ': cancellation after body resolution is checked', async () => {
    const controller = new AbortController()
    const response = successful(spec)
    response[spec.route === 'qrImage' ? 'blob' : 'text'] = async () => {
      controller.abort(SECRET.message)
      return spec.route === 'qrImage' ? new Blob(['synthetic'], { type: 'image/svg+xml' }) : '{"phase":"connected"}'
    }
    await rejects(spec.call(createWechatChannelClient(async () => response), controller.signal), 'aborted')
  })
  await test(spec.name + ': later cancellation cannot undo a completed call or trigger cleanup requests', async () => {
    let calls = 0
    const controller = new AbortController()
    const client = createWechatChannelClient(async () => { calls += 1; return successful(spec) })
    const result = await spec.call(client, controller.signal)
    controller.abort(SECRET.token)
    await flush()
    assert.equal(calls, 1)
    if (spec.route === 'status') assert.equal(result.messagingVerified, false)
    await rejects(spec.call(client, controller.signal), 'aborted')
    assert.equal(calls, 1)
    await spec.call(client, new AbortController().signal)
    assert.equal(calls, 2, 'aborting one wait must not poison this client')
  })
}
await test('abort listeners are balanced on success, fetch/body failure, and cancellation', async () => {
  for (const mode of ['success', 'fetch-error', 'body-error', 'abort']) {
    const controller = new AbortController()
    const signal = controller.signal
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    let adds = 0
    let removes = 0
    signal.addEventListener = (...args) => { adds += 1; return add(...args) }
    signal.removeEventListener = (...args) => { removes += 1; return remove(...args) }
    const client = createWechatChannelClient(async () => {
      if (mode === 'fetch-error') throw new Error(SECRET.token)
      if (mode === 'abort') controller.abort(SECRET.token)
      const response = json({ phase: 'idle' })
      if (mode === 'body-error') response.text = async () => { throw new Error(SECRET.code) }
      return response
    })
    if (mode === 'success') await client.getStatus(signal)
    else await rejects(client.getStatus(signal), mode === 'abort' ? 'aborted' : 'network-error', mode === 'body-error' ? 200 : undefined)
    assert.ok(adds > 0)
    assert.equal(adds, removes)
  }
})

await test('QR returns fresh SVG Blobs, not markup, a URL, or a cached body', async () => {
  let calls = 0
  const content = ['<svg xmlns="http://www.w3.org/2000/svg"><text>first</text></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><text>second</text></svg>']
  const client = createWechatChannelClient(async (path, init) => {
    assert.equal(path, ENDPOINTS.qrImage)
    assert.equal(init.cache, 'no-store')
    const result = svg(content[calls])
    calls += 1
    return result
  })
  const first = await client.readQrImage()
  const second = await client.readQrImage()
  assert.ok(first instanceof Blob)
  assert.ok(second instanceof Blob)
  assert.notEqual(first, second)
  assert.equal(first.type.split(';', 1)[0], 'image/svg+xml')
  assert.equal(await first.text(), content[0])
  assert.equal(await second.text(), content[1])
  assert.equal(calls, 2)
})
for (const mime of ['', 'text/html', 'text/plain', 'application/json', 'image/png', 'image/svg']) {
  await test('QR rejects a wrong/missing SVG MIME without reading the body', async () => {
    const response = new Response(SECRET.qr, { headers: { 'Content-Type': mime } })
    if (mime === '') response.headers.delete('Content-Type')
    await rejects(createWechatChannelClient(async () => response).readQrImage(), 'invalid-mime', 200)
    assert.equal(response.bodyUsed, false)
  })
}
await test('QR accepts case-insensitive SVG MIME with parameters', async () => {
  const response = new Response('<svg/>', { headers: { 'Content-Type': 'IMAGE/SVG+XML; charset=UTF-8' } })
  assert.ok(await createWechatChannelClient(async () => response).readQrImage() instanceof Blob)
})
await test('no automatic work, global fetch access, timers, or Blob URL creation during operations', async () => {
  const globals = ['fetch', 'setTimeout', 'setInterval', 'setImmediate', 'open']
  const originals = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const urlOriginal = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  let touches = 0
  const trap = () => { touches += 1; throw new Error('unexpected global activity') }
  try {
    for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, get: trap })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: trap })
    for (const spec of callsFor) {
      let calls = 0
      const client = createWechatChannelClient(async () => { calls += 1; return successful(spec) })
      await spec.call(client)
      await flush()
      assert.equal(calls, 1)
    }
    assert.equal(touches, 0)
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, descriptor)
    }
    if (urlOriginal === undefined) delete URL.createObjectURL
    else Object.defineProperty(URL, 'createObjectURL', urlOriginal)
  }
})
console.log('PASS: ' + checks + ' offline channel contract checks (injected fake fetch; not real E2E).')
