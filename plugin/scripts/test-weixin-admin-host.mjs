/** Native DSH carrier integration, never the running GUI/profile.
 * Requires an explicitly selected, already-built DSH checkout. No install/skip.
 * Binds only a fresh 127.0.0.1:0 listener; all Weixin transport/storage is synthetic.
 * BrowserAuth is real, with a new root and an in-memory credential provider.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import admin, { WEIXIN_ADMIN_INFO, WEIXIN_ADMIN_ROUTES } from '../lib/weixin-admin.js';

const dsh = process.env.WECHAT_DSH_CHECKOUT;
if (!dsh || !path.isAbsolute(dsh)) throw new Error('Set WECHAT_DSH_CHECKOUT to an existing absolute DSH checkout; this gate never installs or silently skips.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const entries = {
  cordis: 'vendor/cordis/lib/index.js',
  credentials: 'packages/credentials/credentials/lib/index.js',
  connection: 'packages/client/connection/lib/index.js',
  webserver: 'packages/host/webserver/lib/index.js',
};
const sourcePaths = [...Object.values(entries).map(p => path.join(dsh, p)),
  ...['vendor/cordis/src/fiber.ts', 'packages/client/connection/src/index.ts',
    'packages/client/connection/src/rpc-host.ts', 'packages/client/connection/src/rpc.ts',
    'packages/client/connection/src/browser-auth.ts', 'packages/client/connection/src/http-bridge.ts',
    'packages/client/connection/src/api-request-trust.ts', 'packages/host/webserver/src/index.ts',
    'packages/credentials/credentials/src/index.ts'].map(p => path.join(dsh, p)),
  ...['plugin/lib/weixin-admin.js', 'plugin/src/weixin-admin.ts', 'plugin/lib/types/weixin-admin.d.ts',
    'plugin/lib/weixin-api.js', 'plugin/lib/weixin-channel.js', 'plugin/lib/weixin-dsh.js',
    'plugin/lib/weixin-admin-ui/admin.html', 'plugin/lib/weixin-admin-ui/admin.js',
    'plugin/lib/weixin-admin-ui/admin.css', 'plugin/scripts/test-weixin-admin-host.mjs'].map(p => path.join(root, p))];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fingerprints() {
  return Promise.all(sourcePaths.map(async file => {
    const bytes = await readFile(file); return { path: file, bytes: bytes.length, sha256: sha(bytes) };
  }));
}
const before = await fingerprints();
const loaded = Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([name, file]) =>
  [name, await import(pathToFileURL(path.join(dsh, file)).href)])));
const { Context } = loaded.cordis;
const { CredentialProvider } = loaded.credentials;
const { WebServer } = loaded.webserver;
const BASE = WEIXIN_ADMIN_INFO.basePath;
const syntheticQr = 'NATIVE_SYNTHETIC_QR_NOT_SCANNABLE';
const credentialKey = 'wechat-ro-weixin/account';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise, label, ms = 4000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native probe timeout: ' + label)), ms); })]); }
  finally { clearTimeout(timer); }
}
class MemoryCredentials extends CredentialProvider {
  constructor(ctx) { super(ctx); this.records = new Map(); this.calls = []; this.tail = Promise.resolve(); }
  async readRecord(key) { this.calls.push({ op: 'read', key }); return structuredClone(this.records.get(key)); }
  async modifyRecord(key, mutate) {
    const work = this.tail.then(async () => {
      this.calls.push({ op: 'modify', key });
      const next = await mutate(structuredClone(this.records.get(key)));
      if (next !== undefined) this.records.set(key, structuredClone(next));
      return structuredClone(this.records.get(key));
    });
    this.tail = work.catch(() => {}); return work;
  }
  async deleteRecord() { throw new Error('No deletion or real credential backend is allowed in this test.'); }
}
const rows = [];
await test('native isolated DSH authenticated management carrier', { timeout: 45000 }, async t => {
  const ctx = new Context();
  const realFetch = globalThis.fetch;
  const upstream = [];
  let origin, cookie, owner, disposed = false;
  let stallNextQr = false;
  const qrEntered = deferred(), qrAborted = deferred();
  const countWrites = () => ctx.credentials.calls.filter(c => c.key === credentialKey && c.op === 'modify').length;
  const countWechat = () => ctx.credentials.calls.filter(c => c.key === credentialKey).length;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (origin && url.origin === origin) return realFetch(input, init);
    assert.equal(url.origin, 'https://ilinkai.weixin.qq.com', 'unexpected outbound origin blocked');
    assert.ok(['/ilink/bot/get_bot_qrcode', '/ilink/bot/get_qrcode_status'].includes(url.pathname), 'message or unknown endpoint blocked');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    upstream.push({ path: url.pathname, method: init.method });
    if (stallNextQr && url.pathname.endsWith('/get_bot_qrcode')) {
      stallNextQr = false; qrEntered.resolve();
      return new Promise((_, reject) => {
        const stop = () => { qrAborted.resolve(); reject(new DOMException('Synthetic request cancelled', 'AbortError')); };
        if (init.signal.aborted) stop(); else init.signal.addEventListener('abort', stop, { once: true });
      });
    }
    const body = url.pathname.endsWith('/get_bot_qrcode')
      ? { qrcode: 'NATIVE_SYNTHETIC_QR_ID', qrcode_img_content: syntheticQr }
      : { status: 'confirmed', bot_token: 'NATIVE_SYNTHETIC_TOKEN', ilink_bot_id: 'native-synthetic-bot', ilink_user_id: 'native-synthetic-user', baseurl: url.origin };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const get = async (suffix, options = {}) => {
    const response = await bounded(fetch(origin + BASE + suffix, { redirect: 'manual', ...options,
      headers: { ...(cookie ? { cookie } : {}), ...options.headers } }), 'HTTP response');
    const text = await response.text(); let value;
    try { value = JSON.parse(text); } catch { /* static page or carrier error */ }
    return { response, text, value };
  };
  const post = (payload, options = {}) => get('/action', { method: 'POST', body: JSON.stringify(payload), ...options,
    headers: { 'content-type': 'application/json', 'x-wechat-management': '1', origin, ...options.headers } });
  const check = async (id, fn) => t.test(id, async () => {
    try { await fn(); rows.push({ id, passed: true }); }
    catch (error) { rows.push({ id, passed: false, name: error.name, message: error.message }); throw error; }
  });
  try {
    await bounded(ctx.plugin(MemoryCredentials), 'memory credentials');
    await bounded(ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' }), 'isolated listener');
    origin = ctx.webServer.getOrigin();
    assert.equal(new URL(origin).hostname, '127.0.0.1'); assert.notEqual(new URL(origin).port, '3080');
    await bounded(ctx.plugin(loaded.connection), 'real Connection');
    // Only the index content is synthetic. Authorization/exchange stays native.
    await bounded(ctx.plugin({ name: 'isolated-native-auth-index', inject: ['connection', 'webServer'], apply(scope) {
      scope.effect(() => scope.webServer.register({ kind: 'exact', path: '/', handler(req, res) {
        if (!scope.connection.authorizeIndex(req, res)) return;
        res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/plain' }); res.end('Synthetic index, not the running GUI');
      } }), 'isolated index');
    } }), 'synthetic index owner');
    owner = await bounded(ctx.plugin(admin), 'default management plugin');
    await check('N01 default config and activation cause zero Weixin IO', async () => {
      assert.equal(owner.config.enabled, false);
      assert.equal(countWechat(), 0); assert.equal(upstream.length, 0);
      assert.ok(ctx.credentials.calls.some(c => c.key === 'client-connection/browser-session'), 'fresh auth record is separate from Weixin');
      assert.ok(ctx.credentials.calls.every(c => ['client-connection/browser-session', credentialKey].includes(c.key)));
    });
    await check('N02 every exact route rejects unauthenticated HTTP', async () => {
      for (const route of WEIXIN_ADMIN_ROUTES) {
        const method = route.methods[0];
        const r = await get(route.path.slice(BASE.length), { method, ...(method === 'POST' ? { body: '{}' } : {}) });
        assert.equal(r.response.status, 401); assert.ok(!r.text.includes(syntheticQr));
      }
      assert.equal(countWechat(), 0); assert.equal(upstream.length, 0);
    });
    await check('N03 normal native launch-token exchange mints an owner cookie', async () => {
      const r = await realFetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
      assert.equal(r.status, 303); assert.equal(r.headers.get('location'), './');
      const value = r.headers.get('set-cookie'); assert.ok(value && value.includes('HttpOnly'));
      cookie = value.split(';', 1)[0]; await r.arrayBuffer();
      const s = await get('/status'); assert.equal(s.response.status, 200);
      assert.equal(s.value.value.phase, 'disabled'); assert.equal(s.value.value.messagingEnabled, false);
      assert.equal(countWechat(), 0); assert.equal(upstream.length, 0);
    });
    await check('N04 authenticated static assets and HEAD carry security headers', async () => {
      for (const [suffix, type] of [['/admin', 'text/html'], ['/admin.js', 'text/javascript'], ['/admin.css', 'text/css']]) {
        const r = await get(suffix); assert.equal(r.response.status, 200); assert.ok(r.text.length > 0);
        assert.ok(r.response.headers.get('content-type').startsWith(type));
        assert.equal(r.response.headers.get('cache-control'), 'no-store');
        assert.equal(r.response.headers.get('referrer-policy'), 'no-referrer');
        assert.equal(r.response.headers.get('x-content-type-options'), 'nosniff');
        assert.ok(r.response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
        const h = await get(suffix, { method: 'HEAD' }); assert.equal(h.response.status, 200); assert.equal(h.text, '');
      }
      assert.equal(countWechat(), 0); assert.equal(upstream.length, 0);
    });
    await check('N05 Host Origin and malformed cookies fail before the plugin', async () => {
      for (const [headers, status] of [[{ origin: 'https://cross-origin.invalid' }, 403], [{ cookie: 'invalid=not-a-session' }, 401]]) {
        const r = await get('/status', { headers }); assert.equal(r.response.status, status, Object.keys(headers)[0] + ' rejection');
      }
      // Node 24 fetch rewrites Host to the URL authority. Use node:http so this
      // negative control actually sends the untrusted Host over the same socket.
      const hostStatus = await bounded(new Promise((resolve, reject) => {
        const request = httpGet(origin + BASE + '/status', { headers: { cookie, host: 'untrusted.invalid' }, agent: false }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode)); response.on('error', reject);
        });
        request.setTimeout(4000, () => request.destroy(new Error('Native Host probe timeout')));
        request.on('error', reject);
      }), 'raw Host negative control');
      assert.equal(hostStatus, 403, 'wire-level Host rejection');
      assert.equal(countWechat(), 0); assert.equal(upstream.length, 0);
    });
    await check('N06 real registry denies a synthetic non-owner peer', async () => {
      const peer = ctx.connection.createPeer({ principal: { kind: 'native-probe-non-owner' } });
      try {
        const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request(origin + BASE + '/status'), peer);
        assert.equal(response.status, 403); await response.arrayBuffer();
      } finally { await peer.dispose(); }
      assert.equal(countWechat(), 0);
    });
    await check('N07 exact paths and verbs expose no message routes', async () => {
      for (const suffix of ['/pollOnce', '/send', '/discardPending', '/status/extra']) assert.equal((await get(suffix)).response.status, 404);
      for (const [suffix, method] of [['/status', 'POST'], ['/action', 'GET'], ['/admin', 'OPTIONS']]) assert.equal((await get(suffix, { method })).response.status, 404);
      assert.equal(countWechat(), 0); assert.equal(upstream.length, 0);
    });
    await check('N08 enabled reload is idle and status reads only the synthetic grant', async () => {
      await bounded(owner.dispose(), 'disabled owner unload');
      assert.equal((await get('/status')).response.status, 404);
      owner = await bounded(ctx.plugin(admin, { enabled: true }), 'enabled owner');
      assert.equal(countWechat(), 0); assert.equal(upstream.length, 0);
      const r = await get('/status'); assert.equal(r.response.status, 200); assert.equal(r.value.value.phase, 'unpaired');
      assert.equal(countWechat(), 1); assert.equal(countWrites(), 0); assert.equal(upstream.length, 0);
    });
    await check('N09 management header and content type are enforced after authentication', async () => {
      const first = countWechat();
      const missing = await post({ action: 'beginLogin', confirmation: 'request-qr' }, { headers: { 'x-wechat-management': '' } });
      assert.equal(missing.response.status, 400); assert.equal(missing.value.error.code, 'invalid-request');
      const form = await post({ action: 'cancelLogin' }, { headers: { 'content-type': 'text/plain' } });
      assert.equal(form.response.status, 415); assert.equal(countWechat(), first); assert.equal(upstream.length, 0);
    });
    await check('N10 real streaming carrier rejects a body larger than 4096 bytes', async () => {
      const bytes = new TextEncoder().encode(' '.repeat(4097));
      const body = new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 2048)); controller.enqueue(bytes.subarray(2048)); controller.close(); } });
      const r = await get('/action', { method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/json', 'x-wechat-management': '1', origin } });
      assert.equal(r.response.status, 413); assert.equal(r.value.error.code, 'body-too-large'); assert.equal(upstream.length, 0);
    });
    await check('N11 explicit QR and one status poll project no credentials', async () => {
      const b = await post({ action: 'beginLogin', confirmation: 'request-qr' });
      assert.equal(b.response.status, 200); assert.deepEqual(b.value, { ok: true, value: { qrContent: syntheticQr } });
      const p = await post({ action: 'pollLogin' });
      assert.equal(p.response.status, 200); assert.deepEqual(p.value, { ok: true, value: { status: 'confirmed' } });
      assert.equal(countWrites(), 0); assert.equal(upstream.length, 2);
      const s = await get('/status'); assert.equal(s.value.value.phase, 'awaiting-confirmation');
      assert.ok(!s.text.includes('NATIVE_SYNTHETIC_TOKEN')); assert.ok(!s.text.includes(syntheticQr));
    });
    await check('N12 explicit persistence and local forget never start messaging', async () => {
      const missing = await post({ action: 'confirmPairing' }); assert.equal(missing.response.status, 400); assert.equal(countWrites(), 0);
      const saved = await post({ action: 'confirmPairing', confirmation: 'persist-pairing' });
      assert.equal(saved.response.status, 200); assert.deepEqual(saved.value.value, { paired: true }); assert.equal(countWrites(), 1);
      const s = await get('/status'); assert.equal(s.value.value.phase, 'paired'); assert.equal(s.value.value.hasStoredLogin, true);
      assert.equal(s.value.value.messagingVerified, false); assert.equal(s.value.value.messagingEnabled, false); assert.equal(s.value.value.automaticPolling, false);
      const f = await post({ action: 'forget', confirmation: 'forget-local-credentials' }); assert.equal(f.response.status, 200);
      assert.equal(countWrites(), 2); assert.equal((await get('/status')).value.value.phase, 'unpaired'); assert.equal(upstream.length, 2);
    });
    await check('N13 real client disconnect reaches the upstream abort signal', async () => {
      stallNextQr = true; const controller = new AbortController();
      const work = post({ action: 'beginLogin', confirmation: 'request-qr' }, { signal: controller.signal }).then(() => false, () => true);
      await bounded(qrEntered.promise, 'QR transport entry'); controller.abort();
      assert.equal(await bounded(work, 'aborted client response'), true);
      await bounded(qrAborted.promise, 'native carrier abort propagation');
      assert.equal(upstream.length, 3); assert.equal(countWrites(), 2);
      // Cancellation is not a promise that the real remote QR request was undone.
    });
    await check('N14 owner unload removes all exact routes and permits a clean reload', async () => {
      await bounded(owner.dispose(), 'owner unload');
      for (const route of WEIXIN_ADMIN_ROUTES) assert.equal((await get(route.path.slice(BASE.length), { method: route.methods[0] })).response.status, 404);
      const reads = countWechat(); owner = await bounded(ctx.plugin(admin), 'fresh disabled owner');
      assert.equal((await get('/status')).value.value.phase, 'disabled'); assert.equal(countWechat(), reads); assert.equal(upstream.length, 3);
      await bounded(owner.dispose(), 'final owner unload');
    });
    await check('N15 root disposal closes the isolated listener', async () => {
      await bounded(ctx.fiber.dispose(), 'root disposal'); disposed = true;
      await assert.rejects(realFetch(origin + BASE + '/status'));
    });
  } finally {
    globalThis.fetch = realFetch;
    if (!disposed) await bounded(ctx.fiber.dispose(), 'cleanup root');
    const after = await fingerprints();
    assert.deepEqual(after, before, 'source changed during native integration');
    console.log('NATIVE_ADMIN_RESULT ' + JSON.stringify({ schemaVersion: 1, node: process.version,
      executor: 'Lead-authored native integration test', passed: rows.filter(r => r.passed).length,
      failed: rows.filter(r => !r.passed).length, rows, sourceBefore: before, sourceAfter: after,
      upstreamRequests: upstream, realComponents: ['Cordis', 'CredentialProvider base', 'Connection', 'BrowserAuth', 'HTTP bridge', 'WebServer'],
      replacements: ['in-memory credentials', 'synthetic index contents', 'synthetic Weixin fetch'],
      liveGuiAccessed: false, liveCredentialBackendAccessed: false, messagingEnabled: false,
      limits: ['not a deployed GUI test', 'no real login/QR scanning/messages/LLM', 'non-owner check uses a synthetic in-process peer', 'no durable or cross-process credential backend'] }));
  }
});
