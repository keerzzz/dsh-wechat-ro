import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createDecipheriv, randomUUID } from 'node:crypto';
import { createWeixinMediaApi, describeWeixinMedia, WEIXIN_MEDIA_LIMITS } from '../lib/weixin-media.js';
import { WeixinApiError } from '../lib/weixin-api.js';
import { createWeixinChannel, validateWeixinState, WeixinChannelError } from '../lib/weixin-channel.js';
import { createWeixinTaskCredentialStore, createWeixinSessionCredentialStore } from '../lib/weixin-dsh.js';

const AUTH = { baseUrl: 'https://ilinkai.weixin.qq.com', botId: 'synthetic-bot', userId: 'synthetic-owner', botToken: 'SYNTHETIC_TOKEN' };
const SID = 'wechat-task-00000000-0000-4000-8000-000000000001';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yXQAAAAASUVORK5CYII=', 'base64');
const FILE = Buffer.from('# Synthetic task document\n你好\n');
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const previousFetch = globalThis.fetch;
let ambient = 0;
globalThis.fetch = () => { ambient++; throw new Error('SYNTHETIC_FORBIDDEN_NETWORK'); };
after(() => { globalThis.fetch = previousFetch; assert.equal(ambient, 0); });
const safeError = code => error => {
  assert.ok(error instanceof WeixinApiError);
  assert.equal(error.code, code);
  assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_TOKEN|PRIVATE_ERROR|upload-ticket|download-ticket/);
  return true;
};
function mediaMessage(fileName = 'report.md', data = FILE) {
  const description = describeWeixinMedia(fileName, data);
  return { toUserId: AUTH.userId, clientId: 'synthetic-dispatch', contextToken: 'synthetic-context', fileName, kind: description.kind, sha256: description.sha256, data };
}
function transport(respond, options = {}) {
  const calls = [], guards = { authorize: () => true, verify: async () => {} };
  const client = createWeixinMediaApi({ ...options, fetcher: async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : Buffer.from(init.body);
    calls.push({ url, headers: { ...init.headers }, body });
    if (respond) return respond(calls.length, url, init, body);
    return calls.length === 1 ? json({ upload_param: 'upload-ticket' })
      : calls.length === 2 ? new Response(null, { headers: { 'x-encrypted-param': 'download-ticket' } }) : json({ ret: 0 });
  } });
  return { client, calls, guards };
}

test('media construction is inert and missing transport never uses ambient fetch', async () => {
  const api = createWeixinMediaApi();
  assert.deepEqual(Object.keys(api), ['sendMedia']);
  assert.ok(Object.isFrozen(api));
  await assert.rejects(api.sendMedia(AUTH, mediaMessage(), undefined, { authorize: () => true, verify: async () => {} }), safeError('not-configured'));
  assert.equal(ambient, 0);
});
for (const [fileName, data, kind] of [['report.md', FILE, 'file'], ['pixel.png', PNG, 'image']]) test('pinned protocol sends exact verified ' + kind + ' bytes with native crypto and no CDN credentials', async () => {
  const f = transport(), input = mediaMessage(fileName, data);
  assert.deepEqual(await f.client.sendMedia(AUTH, input, undefined, f.guards), { accepted: true });
  assert.equal(f.calls.length, 3);
  const [grant, upload, sent] = f.calls;
  assert.equal(grant.url, 'https://ilinkai.weixin.qq.com/ilink/bot/getuploadurl');
  assert.equal(grant.body.media_type, kind === 'image' ? 1 : 3);
  assert.equal(grant.body.rawsize, data.length);
  assert.equal(grant.body.rawfilemd5, createHash('md5').update(data).digest('hex'));
  assert.equal(grant.body.no_need_thumb, true);
  assert.equal(grant.body.filesize, Math.ceil((data.length + 1) / 16) * 16);
  assert.match(grant.body.filekey, /^[0-9a-f]{32}$/u);
  assert.match(upload.url, /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/upload\?/u);
  assert.deepEqual(upload.headers, { 'Content-Type': 'application/octet-stream' });
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(grant.body.aeskey, 'hex'), null);
  assert.deepEqual(Buffer.concat([decipher.update(upload.body), decipher.final()]), data);
  const msg = sent.body.msg, item = msg.item_list[0], body = kind === 'image' ? item.image_item : item.file_item;
  assert.equal(sent.url, 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
  assert.equal(msg.to_user_id, AUTH.userId); assert.equal(msg.client_id, input.clientId); assert.equal(msg.context_token, input.contextToken);
  assert.equal(msg.item_list.length, 1); assert.equal(item.type, kind === 'image' ? 2 : 4);
  assert.equal(body.media.encrypt_query_param, 'download-ticket');
  assert.equal(Buffer.from(body.media.aes_key, 'base64').toString('ascii'), grant.body.aeskey);
  assert.equal(body.media.encrypt_type, 1);
  if (kind === 'image') assert.equal(body.mid_size, upload.body.length);
  else { assert.equal(body.file_name, fileName); assert.equal(body.len, String(data.length)); }
  assert.deepEqual(data, kind === 'image' ? PNG : FILE);
});

test('untrusted filenames, content types, oversized bytes and caller metadata fail before network', async () => {
  for (const [name, data] of [['../report.md', FILE], ['C:report.md', FILE], ['bad\nname.txt', FILE], ['report.exe', FILE], ['reversed' + String.fromCodePoint(0x202e) + 'name.txt', FILE],
    ['fake.png', FILE], ['fake.pdf', FILE], ['fake.docx', FILE], ['report.txt', Buffer.from([0xff])], ['report.txt', Buffer.from([0])],
    ['big.txt', Buffer.alloc(WEIXIN_MEDIA_LIMITS.maxBytes + 1)], ['shared.txt', new Uint8Array(new SharedArrayBuffer(1))]]) {
    assert.throws(() => describeWeixinMedia(name, data), safeError('invalid-input'));
  }
  const f = transport();
  for (const input of [{ ...mediaMessage(), toUserId: 'another-owner' }, { ...mediaMessage(), kind: 'image' },
    { ...mediaMessage(), sha256: '0'.repeat(64) }, { ...mediaMessage(), extra: true }, { ...mediaMessage(), get data() { throw new Error('PRIVATE_ERROR'); } }]) {
    await assert.rejects(f.client.sendMedia(AUTH, input, undefined, f.guards), safeError('invalid-input'));
  }
  const signal = Object.defineProperty({}, 'aborted', { get() { throw new Error('PRIVATE_ERROR'); } });
  await assert.rejects(f.client.sendMedia(AUTH, mediaMessage(), signal, f.guards), safeError('invalid-input'));
  assert.equal(f.calls.length, 0);
});

for (const url of ['http://novac2c.cdn.weixin.qq.com/c2c/upload', 'https://evil.invalid/c2c/upload',
  'https://novac2c.cdn.weixin.qq.com.evil.invalid/c2c/upload', 'https://owner@novac2c.cdn.weixin.qq.com/c2c/upload',
  'https://novac2c.cdn.weixin.qq.com/c2c/upload#fragment', 'https://novac2c.cdn.weixin.qq.com/other',
  'https://novac2c.cdn.weixin.qq.com:8443/c2c/upload', 'https://127.0.0.1/c2c/upload']) test('server upload URL cannot change transport boundary: ' + url, async () => {
  const f = transport(() => json({ upload_full_url: url, upload_param: 'upload-ticket' }));
  await assert.rejects(f.client.sendMedia(AUTH, mediaMessage(), undefined, f.guards), safeError('unsupported-origin'));
  assert.equal(f.calls.length, 1);
});
test('verified full upload URL takes precedence without interpreting untrusted parameters', async () => {
  const full = 'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=server-ticket';
  const f = transport(n => n === 1 ? json({ upload_full_url: full, upload_param: 'ignored' })
    : n === 2 ? new Response(null, { headers: { 'x-encrypted-param': 'download-ticket' } }) : json({ ret: 0 }));
  await f.client.sendMedia(AUTH, mediaMessage(), undefined, f.guards);
  assert.equal(f.calls[1].url, full);
});
for (const stage of [1, 2]) test('revocation after phase ' + stage + ' stops subsequent upload/send and never retries', async () => {
  let allowed = true;
  const f = transport(n => {
    if (n === stage) allowed = false;
    return n === 1 ? json({ upload_param: 'upload-ticket' }) : new Response(null, { headers: { 'x-encrypted-param': 'download-ticket' } });
  });
  f.guards.authorize = () => allowed;
  await assert.rejects(f.client.sendMedia(AUTH, mediaMessage(), undefined, f.guards), error => { safeError('aborted')(error); assert.equal(error.deliveryUnknown, stage === 2); return true; });
  assert.equal(f.calls.length, stage);
});
test('file revalidation runs before every boundary and refuses a changed file after upload', async () => {
  const f = transport(); let verified = 0;
  f.guards.verify = async () => { if (++verified === 3) throw new Error('PRIVATE_ERROR'); };
  await assert.rejects(f.client.sendMedia(AUTH, mediaMessage(), undefined, f.guards), error => { safeError('invalid-input')(error); assert.equal(error.deliveryUnknown, true); return true; });
  assert.equal(verified, 3); assert.equal(f.calls.length, 2);
});
test('mutable caller bytes cannot alter the upload after its fingerprint was fixed', async () => {
  const data = Buffer.from(FILE), f = transport(n => {
    if (n === 1) { data.fill(0); return json({ upload_param: 'upload-ticket' }); }
    return n === 2 ? new Response(null, { headers: { 'x-encrypted-param': 'download-ticket' } }) : json({ ret: 0 });
  });
  await f.client.sendMedia(AUTH, mediaMessage('report.md', data), undefined, f.guards);
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(f.calls[0].body.aeskey, 'hex'), null);
  assert.deepEqual(Buffer.concat([decipher.update(f.calls[1].body), decipher.final()]), FILE);
});
test('explicit business failure, missing CDN receipt and HTTP errors are redacted without retry', async () => {
  for (const [responses, code, count] of [
    [[json({ ret: -14, errmsg: 'PRIVATE_ERROR' })], 'business-error', 1],
    [[json({ upload_param: 'upload-ticket' }), new Response('PRIVATE_ERROR', { status: 503 })], 'http-error', 2],
    [[json({ upload_param: 'upload-ticket' }), new Response(null)], 'invalid-response', 2],
    [[json({ upload_param: 'upload-ticket' }), new Response(null, { headers: { 'x-encrypted-param': 'download-ticket' } }), json({ errcode: -14, errmsg: 'PRIVATE_ERROR' })], 'business-error', 3],
  ]) {
    const f = transport(n => responses[n - 1]);
    await assert.rejects(f.client.sendMedia(AUTH, mediaMessage(), undefined, f.guards), safeError(code));
    assert.equal(f.calls.length, count);
  }
});
for (const [fileName, data] of [['report.md', FILE], ['pixel.png', PNG]]) test('media sendmessage acknowledges optional zero codes for ' + fileName + ' without retransmitting', async () => {
  for (const ack of [{}, { errcode: 0 }, { data: {} }, { ret: 0 }, { ret: 0, data: {} }]) {
    const f = transport(n => n === 1 ? json({ upload_param: 'upload-ticket' })
      : n === 2 ? new Response(null, { headers: { 'x-encrypted-param': 'download-ticket' } }) : json(ack));
    const accepted = await f.client.sendMedia(AUTH, mediaMessage(fileName, data), undefined, f.guards);
    assert.deepEqual(accepted, { accepted: true });
    assert.ok(Object.isFrozen(accepted));
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls.filter(call => call.url === AUTH.baseUrl + '/ilink/bot/sendmessage').length, 1);
  }
});
test('media timeout/cancellation handles late transport and never dispatches another phase', async () => {
  let rejectLate;
  const f = transport(() => new Promise((_, reject) => { rejectLate = reject; }), { timeoutMs: 8 });
  await assert.rejects(f.client.sendMedia(AUTH, mediaMessage(), undefined, f.guards), safeError('timeout'));
  rejectLate(new Error('PRIVATE_ERROR'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
});

function descriptor(name = 'report.md', data = FILE) { return { reference: randomUUID(), turn: 0, ...describeWeixinMedia(name, data) }; }
const inbound = { messageId: 'message-1', fromUserId: AUTH.userId, toUserId: AUTH.botId, contextToken: 'synthetic-context', text: 'Create the requested synthetic files' };
const state = changes => validateWeixinState({ version: 3, revision: 1, sessionId: SID, credentials: AUTH, cursor: '', seenMessageIds: [], pending: null, queuedBatch: null, ...changes });
function channelFixture(replyValue = { text: 'Done', deliverables: [descriptor()] }, initial = state(), { textReply, resumeReply, onTextAccepted, media = true } = {}) {
  let stored = initial, allowed = true, onCommit, onSend, onUpdates;
  const calls = { reply: 0, textReply: 0, reads: 0, updates: 0, inputs: [], updateInputs: [], sendInputs: [], parts: [], commits: [], released: [] };
  const store = { async read() { calls.reads++; return stored; }, async commit(expected, next) {
    assert.equal(expected, stored?.revision ?? null); stored = validateWeixinState(next); calls.commits.push(stored); await onCommit?.(stored);
  } };
  const send = async part => {
    assert.equal(stored.pending.phase, 'sending');
    assert.equal(stored.version === 3 ? stored.pending.parts[stored.pending.next].clientId : stored.pending.clientId, part.clientId);
    calls.parts.push(part); const result = await onSend?.(part); return result === undefined ? { accepted: true } : result;
  };
  const options = { enabled: true, sessionId: SID, store, beforeSend: () => allowed, async reply(text, metadata, signal) {
    assert.equal(stored.pending.phase, 'replying'); calls.textReply++; calls.inputs.push({ text, metadata, signal });
    if (textReply) return textReply(text, metadata, signal);
    throw new Error('Legacy reply called');
  },
    api: { requestQrCode: async () => ({ qrcode: 'qr', qrContent: 'synthetic' }), getQrStatus: async () => ({ status: 'confirmed', credentials: AUTH }),
      async getUpdates(auth, cursor, signal) {
        calls.updates++; calls.updateInputs.push({ auth, cursor, signal });
        return onUpdates ? onUpdates(auth, cursor, signal) : { cursor: 'new-cursor', messages: [inbound], ignored: 0 };
      },
      async sendText(auth, value, signal) { calls.sendInputs.push({ auth, value, signal }); return send({ kind: 'text', ...value }); } },
    media: { async reply() { assert.equal(stored.pending.phase, 'replying'); calls.reply++; return replyValue; },
      async send(_auth, part, _signal, authorize) { assert.equal(authorize(), true); return send(part); }, release(refs) { calls.released.push(...refs); } } };
  if (!media) delete options.media;
  if (resumeReply) options.resumeReply = resumeReply;
  if (onTextAccepted) options.onTextAccepted = onTextAccepted;
  const channel = createWeixinChannel(options);
  return { channel, options, calls, peek: () => stored, revoke: () => { allowed = false; }, commitHook: hook => { onCommit = hook; },
    sendHook: hook => { onSend = hook; }, updatesHook: hook => { onUpdates = hook; } };
}
for (const version of [2, 3]) test(`v${version} explicit resume sends one text from retained replying without reading updates or admitting the original`, async () => {
  const next = { ...inbound, messageId: 'message-2', text: 'Next retained input' };
  const pending = version === 3 ? { messageId: inbound.messageId, phase: 'replying', parts: null, next: 0 }
    : { messageId: inbound.messageId, phase: 'replying', clientId: 'original-dispatch-id', replyText: null };
  const initial = state({ version, cursor: 'retained-cursor', seenMessageIds: ['old-seen'], pending,
    queuedBatch: { messages: [inbound, next], received: 2, replied: 0, ignored: 0, duplicates: 0 } });
  const resumed = []; let accepted = 0;
  const f = channelFixture(undefined, initial, { media: version === 3, async resumeReply(text, metadata, signal) {
    resumed.push({ text, metadata, signal }); return 'Continued once';
  }, onTextAccepted() { accepted++; } });
  assert.equal((await f.channel.getStatus()).resumeAvailable, true);
  const result = await f.channel.resumeTextOnce('continue-unanswered-message');
  assert.deepEqual(result, { received: 2, replied: 1, ignored: 0, duplicates: 0, remaining: 1 });
  assert.equal(resumed.length, 1); assert.equal(resumed[0].text, inbound.text); assert.deepEqual(resumed[0].metadata, { messageId: inbound.messageId });
  assert.ok(resumed[0].signal instanceof AbortSignal); assert.equal(accepted, 1);
  assert.equal(f.calls.updates, 0); assert.equal(f.calls.reply, 0); assert.equal(f.calls.textReply, 0); assert.equal(f.calls.parts.length, 1);
  assert.equal(f.calls.sendInputs[0].value.text, 'Continued once'); assert.equal(f.calls.sendInputs[0].value.contextToken, inbound.contextToken);
  assert.equal(f.peek().cursor, 'retained-cursor'); assert.deepEqual(f.peek().credentials, AUTH);
  assert.deepEqual(f.peek().seenMessageIds, ['old-seen', inbound.messageId]); assert.deepEqual(f.peek().queuedBatch.messages, [next]);
  assert.equal(f.peek().pending, null); assert.equal(f.calls.commits.length, 4);
  if (version === 2) assert.equal(f.calls.parts[0].clientId, 'original-dispatch-id');
  assert.equal((await f.channel.getStatus()).resumeAvailable, false);
});

test('resume refuses missing callback, wrong confirmation, no pending and every ready/sending accepted prefix', async () => {
  let resumed = 0;
  const resumeReply = async () => { resumed++; return 'Unreachable'; };
  const queue = { messages: [inbound], received: 1, replied: 0, ignored: 0, duplicates: 0 };
  const replying = state({ pending: { messageId: inbound.messageId, phase: 'replying', parts: null, next: 0 }, queuedBatch: queue });
  const wrong = channelFixture(undefined, replying, { resumeReply });
  await assert.rejects(wrong.channel.resumeTextOnce('wrong'), error => error.code === 'invalid-input'); assert.equal(wrong.calls.reads, 0);
  const missing = channelFixture(undefined, replying);
  await assert.rejects(missing.channel.resumeTextOnce('continue-unanswered-message'), error => error.code === 'not-configured'); assert.equal(missing.calls.reads, 0);
  const empty = channelFixture(undefined, state(), { resumeReply });
  await assert.rejects(empty.channel.resumeTextOnce('continue-unanswered-message'), error => error.code === 'no-pending');
  assert.equal(empty.calls.commits.length, 0);
  for (const phase of ['ready', 'sending']) for (const next of [0, 1]) {
    const pending = { messageId: inbound.messageId, phase, next, parts: [
      { kind: 'text', clientId: 'first-dispatch-id', text: 'Prepared final text' },
      { ...descriptor(), clientId: 'second-dispatch-id' },
    ] };
    const f = channelFixture(undefined, state({ pending, queuedBatch: queue }), { resumeReply });
    assert.equal((await f.channel.getStatus()).resumeAvailable, false);
    await assert.rejects(f.channel.resumeTextOnce('continue-unanswered-message'), error => error.code === 'recovery-required');
    assert.equal(f.calls.commits.length, 0); assert.equal(f.calls.parts.length, 0); assert.equal(f.calls.updates, 0);
  }
  assert.equal(resumed, 0);
});

test('failed or invalid continuation retains original replying and never retries or sends', async () => {
  const initial = state({ pending: { messageId: inbound.messageId, phase: 'replying', parts: null, next: 0 },
    queuedBatch: { messages: [inbound], received: 1, replied: 0, ignored: 0, duplicates: 0 } });
  for (const [run, code] of [[() => { throw new Error('PRIVATE_ERROR'); }, 'reply-failed'], [() => '', 'invalid-reply'], [() => 'x'.repeat(4001), 'invalid-reply']]) {
    let resumed = 0;
    const f = channelFixture(undefined, initial, { async resumeReply() { resumed++; return run(); } });
    await assert.rejects(f.channel.resumeTextOnce('continue-unanswered-message'), error => error.code === code && !JSON.stringify(error).includes('PRIVATE_ERROR'));
    assert.equal(resumed, 1); assert.equal(f.calls.parts.length, 0); assert.equal(f.calls.updates, 0);
    assert.deepEqual(f.peek().pending, initial.pending); assert.deepEqual(f.peek().queuedBatch, initial.queuedBatch); assert.equal(f.calls.commits.length, 1);
    await assert.rejects(f.channel.pollTextOnce(), error => error.code === 'recovery-required');
    await assert.rejects(f.channel.pollOnce(), error => error.code === 'recovery-required'); assert.equal(resumed, 1);
  }
});

test('resume keeps native success and acceptance evidence when transport or completion CAS fails', async () => {
  const initial = state({ pending: { messageId: inbound.messageId, phase: 'replying', parts: null, next: 0 },
    queuedBatch: { messages: [inbound], received: 1, replied: 0, ignored: 0, duplicates: 0 } });
  for (const stage of ['ready-cas', 'send', 'completion-cas']) {
    let resumed = 0, accepted = 0;
    const f = channelFixture(undefined, initial, { async resumeReply() { resumed++; return 'Prepared resumed reply'; }, onTextAccepted() { accepted++; } });
    if (stage === 'send') f.sendHook(() => { throw new WeixinApiError('network-error', { deliveryUnknown: true }); });
    else f.commitHook(value => { if (stage === 'ready-cas' ? value.pending?.phase === 'ready' : value.pending === null) throw new Error('PRIVATE_ERROR'); });
    await assert.rejects(f.channel.resumeTextOnce('continue-unanswered-message'), error => error.code === (stage === 'send' ? 'send-failed' : 'store-outcome-unknown'));
    assert.equal(resumed, 1); assert.equal(f.calls.updates, 0); assert.equal(f.calls.parts.length, stage === 'ready-cas' ? 0 : 1);
    assert.equal(accepted, stage === 'completion-cas' ? 1 : 0);
    await assert.rejects(f.channel.resumeTextOnce('continue-unanswered-message'), error => ['recovery-required', 'no-pending'].includes(error.code));
    assert.equal(resumed, 1);
  }
});

test('resume CAS has one winner across channel instances and abort leaves the retained input pending', async () => {
  const initial = state({ pending: { messageId: inbound.messageId, phase: 'replying', parts: null, next: 0 },
    queuedBatch: { messages: [inbound], received: 1, replied: 0, ignored: 0, duplicates: 0 } });
  let resumed = 0;
  const f = channelFixture(undefined, initial, { async resumeReply() { resumed++; return 'CAS winner reply'; } });
  const competing = createWeixinChannel(f.options);
  const results = await Promise.allSettled([f.channel.resumeTextOnce('continue-unanswered-message'), competing.resumeTextOnce('continue-unanswered-message')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(resumed, 1); assert.equal(f.calls.parts.length, 1); assert.equal(f.calls.updates, 0); competing.dispose();
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const aborted = channelFixture(undefined, initial, { async resumeReply() { entered(); await held; return 'Late reply'; } });
  const control = new AbortController();
  const pending = aborted.channel.resumeTextOnce('continue-unanswered-message', control.signal);
  const rejected = assert.rejects(pending, error => error.code === 'aborted');
  await ready; await assert.rejects(aborted.channel.resumeTextOnce('continue-unanswered-message'), error => error.code === 'busy');
  control.abort(); await rejected; release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted.peek().pending.phase, 'replying'); assert.equal(aborted.calls.parts.length, 0); assert.equal(aborted.calls.updates, 0);
});

test('v3 persists each text/media claim and accepted prefix without another poller or native replay', async () => {
  const text = '你好🙂'.repeat(800), files = [descriptor(), descriptor('pixel.png', PNG)], f = channelFixture({ text, deliverables: files });
  const result = await f.channel.pollOnce();
  assert.deepEqual(result, { received: 1, replied: 1, ignored: 0, duplicates: 0 });
  assert.equal(f.calls.reply, 1); assert.equal(f.calls.updates, 1);
  assert.equal(f.calls.parts.filter(part => part.kind === 'text').map(part => part.text).join(''), text);
  assert.ok(f.calls.parts.filter(part => part.kind === 'text').every(part => Buffer.byteLength(part.text) <= 4000));
  assert.deepEqual(f.calls.parts.filter(part => part.kind !== 'text').map(part => part.reference), files.map(file => file.reference));
  assert.equal(new Set(f.calls.parts.map(part => part.clientId)).size, f.calls.parts.length);
  assert.equal(f.peek().pending, null); assert.equal(f.peek().cursor, 'new-cursor'); assert.deepEqual(f.peek().seenMessageIds, ['message-1']);
  assert.equal(f.calls.commits[0].queuedBatch.messages.length, 1);
  assert.deepEqual(f.calls.released, files.map(file => file.reference));
});
test('v3 partial dispatch failure retains accepted prefix, stops replay, and discards remaining refs explicitly', async () => {
  const file = descriptor(), f = channelFixture({ text: 'Done', deliverables: [file] });
  f.sendHook(part => { if (part.kind === 'file') throw new WeixinApiError('network-error', { deliveryUnknown: true }); });
  await assert.rejects(f.channel.pollOnce(), error => error.code === 'send-failed' && error.deliveryUnknown);
  assert.equal(f.peek().pending.next, 1); assert.equal(f.peek().pending.phase, 'sending');
  assert.deepEqual((await f.channel.getStatus()).delivery, { accepted: 1, total: 2, phase: 'sending' });
  await assert.rejects(f.channel.pollOnce(), error => error.code === 'recovery-required');
  assert.equal(f.calls.parts.length, 2); assert.equal(f.calls.reply, 1);
  await f.channel.discardPending('discard-without-retry');
  assert.equal(f.peek().pending, null); assert.deepEqual(f.calls.released, [file.reference]);
});
test('v3 rechecks authorization after every CAS and does not send a later attachment after revocation', async () => {
  const f = channelFixture();
  f.commitHook(value => { if (value.pending?.next === 1) f.revoke(); });
  await assert.rejects(f.channel.pollOnce(), error => error.code === 'send-blocked');
  assert.equal(f.calls.parts.length, 1); assert.equal(f.peek().pending.next, 1);
});
test('v3 ready restoration resumes only the never-dispatched suffix without regenerating or resending text', async () => {
  const file = descriptor(), pending = { messageId: inbound.messageId, phase: 'ready', next: 1,
    parts: [{ kind: 'text', clientId: 'accepted-text', text: 'Already accepted' }, { ...file, clientId: 'next-file' }] };
  const initial = state({ pending, queuedBatch: { messages: [inbound], received: 1, replied: 0, ignored: 0, duplicates: 0 } });
  const f = channelFixture(undefined, initial);
  await f.channel.pollOnce();
  assert.equal(f.calls.reply, 0); assert.equal(f.calls.updates, 0); assert.equal(f.calls.parts.length, 1);
  assert.equal(f.calls.parts[0].clientId, 'next-file');
});
test('v3 malformed reply/state and v2 binding never acquire media effects', async () => {
  for (const reply of [{ text: '', deliverables: [] }, { text: 'x', deliverables: [descriptor(), descriptor(), descriptor(), descriptor(), descriptor()] },
    { text: 'x', deliverables: [{ ...descriptor(), reference: '../escape' }] }, { text: 'x'.repeat(16385), deliverables: [] }]) {
    const f = channelFixture(reply);
    await assert.rejects(f.channel.pollOnce(), error => error.code === 'invalid-reply');
    assert.equal(f.calls.parts.length, 0); assert.equal(f.peek().pending.phase, 'replying');
  }
  const f = channelFixture(undefined, state({ version: 2 }));
  await assert.rejects(f.channel.pollOnce(), error => error.code === 'session-mismatch');
  assert.equal(f.calls.updates, 0);
  for (const changes of [{ next: -1 }, { next: 1 }, { parts: [] }, { phase: 'sent' }, { extra: true }]) {
    assert.throws(() => state({ pending: { messageId: inbound.messageId, phase: 'ready', next: 0,
      parts: [{ kind: 'text', clientId: 'one', text: 'x' }], ...changes },
      queuedBatch: { messages: [inbound], received: 1, replied: 0, ignored: 0, duplicates: 0 } }), error => error.code === 'invalid-state');
  }
});
test('v3 credentials have a separate exact-Task key without legacy pairing migration or revision reset', async () => {
  const records = new Map(), touched = [];
  const credentials = { async readRecord(key) { touched.push(String(key)); return records.get(String(key)); },
    async modifyRecord(key, callback) { const next = await callback(records.get(String(key))); if (next !== undefined) records.set(String(key), next); } };
  const v2 = createWeixinSessionCredentialStore(credentials, SID), v3 = createWeixinTaskCredentialStore(credentials, SID);
  await v2.commit(null, state({ version: 2 }));
  assert.equal(await v3.read(), undefined);
  await v3.commit(null, state());
  assert.equal((await v2.read()).version, 2); assert.equal((await v3.read()).version, 3);
  assert.equal(records.size, 2);
  await assert.rejects(v3.commit(1, state({ revision: 2, version: 2 })), error => error.code === 'invalid-state');
  await assert.rejects(v3.commit(1, state({ revision: 2, sessionId: SID.replace(/1$/u, '2') })), error => error.code === 'invalid-state');
});

const following = { ...inbound, messageId: 'message-2', contextToken: 'following-context', text: 'Next explicitly requested owner text' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function textFixture(version, replyValue = '  One synthetic reply🙂\n', initial = state({ version })) {
  return channelFixture(undefined, initial, { media: version === 3,
    textReply: typeof replyValue === 'function' ? replyValue : async () => replyValue });
}
function queuedState(version, messages = [inbound, following], changes = {}) {
  return state({ version, cursor: 'durable-cursor', queuedBatch: { messages, received: messages.length, replied: 0, ignored: 0, duplicates: 0 }, ...changes });
}
function effects(f) {
  return { reads: f.calls.reads, updates: f.calls.updates, model: f.calls.textReply,
    text: f.calls.parts.filter(part => part.kind === 'text').length, mediaReply: f.calls.reply,
    mediaSend: f.calls.parts.filter(part => part.kind !== 'text').length, released: f.calls.released.length, commits: f.calls.commits.length };
}
function assertTextEffects(f, before, expected = {}) {
  const actual = Object.fromEntries(Object.entries(effects(f)).map(([key, value]) => [key, value - before[key]]));
  assert.deepEqual(actual, { reads: 1, updates: 0, model: 0, text: 0, mediaReply: 0, mediaSend: 0, released: 0, commits: 0, ...expected });
}
function assertTextResult(result, expected) {
  assert.deepEqual(result, expected); assert.ok(Object.isFrozen(result));
  assert.equal(result.received, result.replied + result.ignored + result.duplicates + result.remaining);
}
const channelError = (code, deliveryUnknown = false, apiErrorCode) => error => {
  assert.ok(error instanceof WeixinChannelError); assert.equal(error.code, code);
  assert.equal(error.deliveryUnknown, deliveryUnknown); assert.equal(error.apiErrorCode, apiErrorCode);
  assert.deepEqual(Object.keys(error).sort(), ['name', 'code', 'deliveryUnknown', ...(apiErrorCode === undefined ? [] : ['apiErrorCode'])].sort());
  assert.equal('cause' in error, false);
  assert.doesNotMatch(String(error) + JSON.stringify(error), /SYNTHETIC_TOKEN|PRIVATE_ERROR|synthetic-context|Create the requested synthetic files/u);
  return true;
};
function restart(f) { f.channel.dispose(); f.channel = createWeixinChannel(f.options); }
async function assertNoBackground(f) {
  const before = effects(f), stored = f.peek(); await tick(); await tick();
  assert.deepEqual(effects(f), before); assert.equal(f.peek(), stored); assert.equal(ambient, 0);
}
function commitPhase(next) { return next.pending?.phase ?? (next.seenMessageIds.includes(inbound.messageId) ? 'completed' : 'inbox'); }

for (const version of [2, 3]) {
  test(`v${version} pollTextOnce is inert until requested and retains a filtered batch across explicit calls/restart`, async () => {
    const first = { ...inbound, messageId: 'owner-first', contextToken: 'first-context', text: '  First owner input🙂\n' };
    const second = { ...following, messageId: 'owner-second' }, third = { ...following, messageId: 'owner-third', contextToken: 'third-context' };
    const messages = [{ ...first, fromUserId: 'nonowner' }, { ...first, toUserId: 'another-bot' },
      { ...inbound, messageId: 'blank', text: ' \n\t ' }, { ...inbound, messageId: 'seen-before' }, first,
      { ...first, text: 'Duplicate must not reach the model' }, second, third];
    const reply = '  Bounded synthetic reply🙂\n', f = textFixture(version, reply, state({ version, seenMessageIds: ['seen-before'] }));
    assert.deepEqual(effects(f), { reads: 0, updates: 0, model: 0, text: 0, mediaReply: 0, mediaSend: 0, released: 0, commits: 0 });
    await assertNoBackground(f);
    f.updatesHook(() => ({ cursor: 'batch-cursor', messages, ignored: 2 }));
    let before = effects(f);
    assertTextResult(await f.channel.pollTextOnce(), { received: 10, replied: 1, ignored: 5, duplicates: 2, remaining: 2 });
    assertTextEffects(f, before, { updates: 1, model: 1, text: 1, commits: 5 });
    assert.deepEqual(f.calls.commits.map(value => value.revision), [2, 3, 4, 5, 6]);
    assert.deepEqual(f.calls.commits.map(value => value.pending?.phase ?? null), [null, 'replying', 'ready', 'sending', null]);
    assert.deepEqual(f.calls.commits[0].queuedBatch.messages, [first, second, third]);
    assert.deepEqual(f.peek().queuedBatch, { messages: [second, third], received: 10, replied: 1, ignored: 5, duplicates: 2 });
    assert.equal(f.peek().cursor, 'batch-cursor'); assert.equal(f.peek().pending, null);
    assert.deepEqual(f.peek().seenMessageIds, ['seen-before', first.messageId]);
    assert.deepEqual(f.calls.updateInputs[0].auth, AUTH); assert.equal(f.calls.updateInputs[0].cursor, '');
    await assertNoBackground(f);
    before = effects(f); restart(f); await assertNoBackground(f); assert.deepEqual(effects(f), before);
    for (const [message, received, remaining] of [[second, 2, 1], [third, 1, 0]]) {
      before = effects(f);
      assertTextResult(await f.channel.pollTextOnce(), { received, replied: 1, ignored: 0, duplicates: 0, remaining });
      assertTextEffects(f, before, { model: 1, text: 1, commits: 4 });
      const input = f.calls.inputs.at(-1), sent = f.calls.parts.at(-1);
      assert.equal(input.text, message.text); assert.deepEqual(input.metadata, { messageId: message.messageId });
      assert.ok(Object.isFrozen(input.metadata)); assert.ok(input.signal instanceof AbortSignal); assert.equal(input.signal.aborted, false);
      assert.equal(sent.toUserId, AUTH.userId); assert.equal(sent.contextToken, message.contextToken); assert.equal(sent.text, reply);
      if (remaining) assert.equal(f.peek().queuedBatch.replied, 2);
      await assertNoBackground(f);
    }
    assert.equal(f.calls.inputs[0].text, first.text); assert.deepEqual(f.calls.inputs[0].metadata, { messageId: first.messageId });
    assert.equal(f.calls.parts[0].contextToken, first.contextToken); assert.equal(f.calls.parts[0].text, reply);
    assert.equal(new Set(f.calls.parts.map(part => part.clientId)).size, 3);
    assert.deepEqual(f.peek().seenMessageIds, ['seen-before', first.messageId, second.messageId, third.messageId]);
    assert.equal(f.peek().queuedBatch, null); assert.equal(f.calls.updates, 1);
    f.updatesHook(() => ({ cursor: 'batch-cursor', messages: [], ignored: 0 })); before = effects(f);
    assertTextResult(await f.channel.pollTextOnce(), { received: 0, replied: 0, ignored: 0, duplicates: 0, remaining: 0 });
    assertTextEffects(f, before, { updates: 1 }); await assertNoBackground(f);
  });

  for (const [name, messages, ignored, cursor, expected, commits] of [
    ['empty unchanged cursor', [], 0, 'old-cursor', { received: 0, replied: 0, ignored: 0, duplicates: 0, remaining: 0 }, 0],
    ['API-ignored only', [], 3, 'new-cursor', { received: 3, replied: 0, ignored: 3, duplicates: 0, remaining: 0 }, 1],
    ['filtered only', [{ ...inbound, fromUserId: 'nonowner' }, { ...following, text: ' \t\n' }, inbound], 1, 'new-cursor',
      { received: 4, replied: 0, ignored: 3, duplicates: 1, remaining: 0 }, 1],
  ]) test(`v${version} pollTextOnce no-message result: ${name}`, async () => {
    const f = textFixture(version, undefined, state({ version, cursor: 'old-cursor', seenMessageIds: [inbound.messageId] }));
    f.updatesHook(() => ({ cursor, messages, ignored })); const before = effects(f);
    assertTextResult(await f.channel.pollTextOnce(), expected); assertTextEffects(f, before, { updates: 1, commits });
    assert.equal(f.peek().cursor, cursor); assert.equal(f.peek().queuedBatch, null); assert.equal(f.peek().pending, null);
    assert.deepEqual(f.peek().seenMessageIds, [inbound.messageId]); await assertNoBackground(f);
  });

  for (const [name, reply] of [['ASCII', 'x'.repeat(4000)], ['UTF-8', '🙂'.repeat(999) + '尾 ']]) {
    test(`v${version} pollTextOnce sends one exact 4000-byte ${name} reply without chunking`, async () => {
      assert.equal(Buffer.byteLength(reply), 4000);
      const f = textFixture(version, reply), before = effects(f);
      assertTextResult(await f.channel.pollTextOnce(), { received: 1, replied: 1, ignored: 0, duplicates: 0, remaining: 0 });
      assertTextEffects(f, before, { updates: 1, model: 1, text: 1, commits: 5 }); assert.equal(f.calls.parts[0].text, reply);
      const ready = f.calls.commits.find(value => value.pending?.phase === 'ready').pending;
      if (version === 3) assert.deepEqual(ready.parts, [{ kind: 'text', clientId: f.calls.parts[0].clientId, text: reply }]);
      else assert.equal(ready.replyText, reply);
      await assertNoBackground(f);
    });
  }
  for (const [name, reply] of [
    ['long ASCII', () => 'x'.repeat(4001)], ['long UTF-8', () => '🙂'.repeat(1001)],
    ['empty', () => ''], ['blank', () => ' \t\n '], ['undefined', () => undefined], ['null', () => null],
    ['number', () => 42], ['boolean', () => false], ['boxed string', () => new String('not primitive')], ['array', () => ['not text']],
    ['multipart object', () => ({ text: 'Must not be coerced', deliverables: [] })],
    ['attachment-only object', () => ({ text: '', deliverables: [descriptor()] })],
  ]) test(`v${version} pollTextOnce rejects ${name} text adapter output without media/chunking/retry`, async () => {
    const f = textFixture(version, reply), before = effects(f);
    await assert.rejects(f.channel.pollTextOnce(), channelError('invalid-reply'));
    assertTextEffects(f, before, { updates: 1, model: 1, commits: 2 });
    assert.equal(f.peek().pending.phase, 'replying'); assert.equal(f.peek().cursor, 'new-cursor');
    assert.deepEqual(f.peek().queuedBatch.messages, [inbound]); assert.deepEqual(f.peek().seenMessageIds, []);
    if (version === 3) assert.equal(f.peek().pending.parts, null); else assert.equal(f.peek().pending.replyText, null);
    restart(f); const retry = effects(f);
    await assert.rejects(f.channel.pollTextOnce(), channelError('recovery-required')); assertTextEffects(f, retry);
    await assertNoBackground(f);
  });

  const pendingCases = version === 2 ? [
    ['replying', () => ({ messageId: inbound.messageId, clientId: 'pending-text', phase: 'replying', replyText: null })],
    ...['ready', 'sending'].map(phase => [phase + ' text', () => ({ messageId: inbound.messageId, clientId: 'pending-text', phase, replyText: 'Pre-existing reply' })]),
  ] : [
    ['replying', () => ({ messageId: inbound.messageId, phase: 'replying', parts: null, next: 0 })],
    ...['ready', 'sending'].map(phase => [phase + ' text', () => ({ messageId: inbound.messageId, phase,
      parts: [{ kind: 'text', clientId: 'pending-text', text: 'Pre-existing reply' }], next: 0 })]),
    ...['ready', 'sending'].flatMap(phase => [0, 1].map(next => [`${phase} multipart accepted-prefix ${next}`, () => ({ messageId: inbound.messageId, phase,
      parts: [{ kind: 'text', clientId: 'accepted-text', text: 'Pre-existing text' }, { ...descriptor(), clientId: 'pending-file' }], next })])),
  ];
  for (const [name, pending] of pendingCases) test(`v${version} pollTextOnce refuses pre-existing ${name} without model/send/release`, async () => {
    const initial = queuedState(version, undefined, { pending: pending() }), f = textFixture(version, undefined, initial);
    let before = effects(f);
    await assert.rejects(f.channel.pollTextOnce(), channelError('recovery-required')); assertTextEffects(f, before);
    assert.equal(f.peek(), initial); restart(f); before = effects(f);
    await assert.rejects(f.channel.pollTextOnce(), channelError('recovery-required')); assertTextEffects(f, before);
    assert.equal(f.peek(), initial); await assertNoBackground(f);
  });
}

test('v3 pollTextOnce explicit multipart discard releases refs only in recovery and preserves the next owner message', async () => {
  const file = descriptor(), initial = queuedState(3, undefined, { pending: { messageId: inbound.messageId, phase: 'ready', next: 1,
    parts: [{ kind: 'text', clientId: 'accepted-text', text: 'Previously accepted' }, { ...file, clientId: 'pending-file' }] } });
  const f = textFixture(3, undefined, initial); let before = effects(f);
  await assert.rejects(f.channel.pollTextOnce(), channelError('recovery-required')); assertTextEffects(f, before);
  before = effects(f); await f.channel.discardPending('discard-without-retry');
  assertTextEffects(f, before, { commits: 1, released: 1 }); assert.deepEqual(f.calls.released, [file.reference]);
  assert.equal(f.peek().cursor, initial.cursor); assert.deepEqual(f.peek().seenMessageIds, [inbound.messageId]);
  assert.equal(f.peek().queuedBatch.ignored, 1); assert.deepEqual(f.peek().queuedBatch.messages, [following]);
  restart(f); before = effects(f);
  assertTextResult(await f.channel.pollTextOnce(), { received: 1, replied: 1, ignored: 0, duplicates: 0, remaining: 0 });
  assertTextEffects(f, before, { model: 1, text: 1, commits: 4 }); assert.equal(f.calls.inputs[0].text, following.text);
  await assertNoBackground(f);
});

test('v3 pollTextOnce does not change continuous pollOnce media/chunking or accepted-prefix processing', async () => {
  const longText = '你好🙂'.repeat(800), file = descriptor(), f = channelFixture({ text: longText, deliverables: [file] }, state(), { textReply: async () => 'One text only' });
  f.updatesHook(() => ({ cursor: 'new-cursor', messages: [inbound, following], ignored: 0 })); let before = effects(f);
  assertTextResult(await f.channel.pollTextOnce(), { received: 2, replied: 1, ignored: 0, duplicates: 0, remaining: 1 });
  assertTextEffects(f, before, { updates: 1, model: 1, text: 1, commits: 5 }); await assertNoBackground(f);
  const prefix = f.calls.parts.length; before = effects(f);
  assert.deepEqual(await f.channel.pollOnce(), { received: 2, replied: 2, ignored: 0, duplicates: 0 });
  assertTextEffects(f, before, { text: 2, mediaReply: 1, mediaSend: 1, released: 1, commits: 8 });
  const suffix = f.calls.parts.slice(prefix);
  assert.equal(suffix.filter(part => part.kind === 'text').map(part => part.text).join(''), longText);
  assert.ok(suffix.filter(part => part.kind === 'text').every(part => Buffer.byteLength(part.text) <= 4000));
  assert.equal(suffix.at(-1).reference, file.reference); assert.deepEqual(f.calls.released, [file.reference]);
  assert.equal(f.peek().pending, null); assert.equal(f.peek().queuedBatch, null); assert.deepEqual(f.peek().seenMessageIds, [inbound.messageId, following.messageId]);
  before = effects(f);
  assertTextResult(await f.channel.pollTextOnce(), { received: 2, replied: 0, ignored: 0, duplicates: 2, remaining: 0 });
  assertTextEffects(f, before, { updates: 1 }); await assertNoBackground(f);
});

for (const version of [2, 3]) {
  for (const [name, code, initial, change] of [
    ['legacy mode', 'invalid-input', state({ version }), f => { delete f.options.sessionId; delete f.options.media; }],
    ['missing record', 'not-paired', state({ version }), f => { f.options.store.read = async () => { f.calls.reads++; return undefined; }; }],
    ['unpaired tombstone', 'not-paired', state({ version, revision: 9, credentials: null }), () => {}],
    ['other durable version', 'session-mismatch', state({ version: version === 2 ? 3 : 2 }), () => {}],
    ['other session', 'session-mismatch', state({ version, sessionId: SID.replace(/1$/u, '2') }), () => {}],
    ['invalid stored state', 'invalid-state', state({ version }), f => { const read = f.options.store.read; f.options.store.read = async () => ({ ...await read(), cursor: 7 }); }],
    ['disabled', 'disabled', state({ version }), f => { f.options.enabled = false; }],
  ]) test(`v${version} pollTextOnce rejects ${name} before updates/model/send`, async () => {
    const f = textFixture(version, undefined, initial); change(f); restart(f); const before = effects(f);
    await assert.rejects(f.channel.pollTextOnce(), channelError(code));
    assertTextEffects(f, before, { reads: ['legacy mode', 'disabled'].includes(name) ? 0 : 1 });
    assert.equal(f.peek(), initial); await assertNoBackground(f);
  });
  test(`v${version} pollTextOnce rejects invalid/pre-aborted signals and disposal before any I/O`, async () => {
    const f = textFixture(version); let accessed = 0;
    const invalidSignal = Object.defineProperty({}, 'aborted', { get() { accessed++; throw new Error('PRIVATE_ERROR'); } });
    let before = effects(f);
    await assert.rejects(f.channel.pollTextOnce(invalidSignal), channelError('invalid-input')); assertTextEffects(f, before, { reads: 0 });
    assert.equal(accessed, 0);
    const caller = new AbortController(); caller.abort(new Error('PRIVATE_ERROR SYNTHETIC_TOKEN')); before = effects(f);
    await assert.rejects(f.channel.pollTextOnce(caller.signal), channelError('aborted')); assertTextEffects(f, before, { reads: 0 });
    f.channel.dispose(); before = effects(f);
    await assert.rejects(f.channel.pollTextOnce(), channelError('disposed')); assertTextEffects(f, before, { reads: 0 });
    await assertNoBackground(f);
  });

  const failures = [
    { name: 'store read exception', code: 'store-failed', inject(f) {
      f.options.store.read = async () => { f.calls.reads++; throw new Error('PRIVATE_ERROR SYNTHETIC_TOKEN'); };
    } },
    { name: 'updates exception', code: 'api-failed', apiErrorCode: 'network-error', extra: { updates: 1 }, inject(f) {
      f.updatesHook(() => { throw new WeixinApiError('network-error', { httpStatus: 503 }); });
    } },
    { name: 'malformed updates', code: 'invalid-response', extra: { updates: 1 }, inject(f) {
      f.updatesHook(() => ({ cursor: 'new-cursor', messages: [inbound], ignored: 0, private: 'PRIVATE_ERROR' }));
    } },
    { name: 'model exception', code: 'reply-failed', phase: 'replying', extra: { updates: 1, model: 1, commits: 2 }, inject(f) {
      const reply = f.options.reply; f.options.reply = async (...args) => { await reply(...args); throw new Error('PRIVATE_ERROR SYNTHETIC_TOKEN'); };
    } },
    { name: 'unknown send exception', code: 'send-failed', unknown: true, phase: 'sending', extra: { updates: 1, model: 1, text: 1, commits: 4 }, inject(f) {
      f.sendHook(() => { throw new Error('PRIVATE_ERROR SYNTHETIC_TOKEN'); });
    } },
    { name: 'explicit API rejection', code: 'send-failed', apiErrorCode: 'business-error', phase: 'sending', extra: { updates: 1, model: 1, text: 1, commits: 4 }, inject(f) {
      f.sendHook(() => { throw new WeixinApiError('business-error', { deliveryUnknown: false, businessCode: -14, httpStatus: 503 }); });
    } },
    { name: 'false acceptance', code: 'invalid-response', unknown: true, phase: 'sending', extra: { updates: 1, model: 1, text: 1, commits: 4 }, inject(f) {
      f.sendHook(() => ({ accepted: false }));
    } },
    { name: 'untrusted acceptance fields', code: 'invalid-response', unknown: true, phase: 'sending', extra: { updates: 1, model: 1, text: 1, commits: 4 }, inject(f) {
      f.sendHook(() => ({ accepted: true, private: 'PRIVATE_ERROR' }));
    } },
    { name: 'missing acceptance', code: 'invalid-response', unknown: true, phase: 'sending', extra: { updates: 1, model: 1, text: 1, commits: 4 }, inject(f) {
      const send = f.options.api.sendText; f.options.api.sendText = async (...args) => { await send(...args); };
    } },
  ];
  for (const failure of failures) test(`v${version} pollTextOnce redacts ${failure.name} without automatic effects/retry`, async () => {
    const f = textFixture(version); failure.inject(f); restart(f); const before = effects(f);
    await assert.rejects(f.channel.pollTextOnce(), channelError(failure.code, failure.unknown ?? false, failure.apiErrorCode));
    assertTextEffects(f, before, failure.extra); assert.equal(f.peek().pending?.phase ?? null, failure.phase ?? null);
    await assertNoBackground(f);
    if (failure.phase) {
      assert.equal(f.peek().cursor, 'new-cursor'); assert.deepEqual(f.peek().queuedBatch.messages, [inbound]); assert.deepEqual(f.peek().seenMessageIds, []);
      restart(f); const retry = effects(f);
      await assert.rejects(f.channel.pollTextOnce(), channelError('recovery-required')); assertTextEffects(f, retry);
    }
  });

  for (const [index, phase] of ['inbox', 'replying', 'ready', 'sending', 'completed'].entries()) {
    for (const outcome of ['before', 'after']) test(`v${version} pollTextOnce ${outcome}-apply ${phase} CAS failure preserves restart/discard invariants`, async () => {
      const f = textFixture(version); f.updatesHook(() => ({ cursor: 'new-cursor', messages: [inbound, following], ignored: 0 }));
      const commit = f.options.store.commit; let attempts = 0;
      f.options.store.commit = async (expected, next) => {
        attempts++; const failHere = commitPhase(next) === phase;
        if (failHere && outcome === 'before') throw new Error('PRIVATE_ERROR SYNTHETIC_TOKEN');
        await commit(expected, next);
        if (failHere && outcome === 'after') throw new Error('PRIVATE_ERROR SYNTHETIC_TOKEN');
      };
      let before = effects(f);
      await assert.rejects(f.channel.pollTextOnce(), channelError('store-outcome-unknown', phase === 'completed'));
      const applied = index + (outcome === 'after' ? 1 : 0);
      assertTextEffects(f, before, { updates: 1, model: index >= 2 ? 1 : 0, text: index === 4 ? 1 : 0, commits: applied });
      assert.equal(attempts, index + 1); assert.equal(f.peek().revision, 1 + applied);
      assert.equal(f.peek().cursor, applied ? 'new-cursor' : '');
      if (applied) assert.deepEqual(f.peek().queuedBatch.messages, phase === 'completed' && outcome === 'after' ? [following] : [inbound, following]);
      await assertNoBackground(f);
      f.options.store.commit = commit; restart(f);
      if (f.peek().pending !== null) {
        const pending = f.peek().pending; before = effects(f);
        await assert.rejects(f.channel.pollTextOnce(), channelError('recovery-required')); assertTextEffects(f, before);
        assert.equal(f.peek().pending, pending); before = effects(f);
        await f.channel.discardPending('discard-without-retry'); assertTextEffects(f, before, { commits: 1 });
        assert.deepEqual(f.peek().queuedBatch.messages, [following]); assert.equal(f.peek().queuedBatch.ignored, 1);
      }
      const readUpdates = f.peek().queuedBatch === null, received = f.peek().queuedBatch?.messages.length ?? 2; before = effects(f);
      assertTextResult(await f.channel.pollTextOnce(), { received, replied: 1, ignored: 0, duplicates: 0, remaining: received - 1 });
      assertTextEffects(f, before, { updates: readUpdates ? 1 : 0, model: 1, text: 1, commits: readUpdates ? 5 : 4 });
      if (f.peek().queuedBatch !== null) {
        before = effects(f);
        assertTextResult(await f.channel.pollTextOnce(), { received: 1, replied: 1, ignored: 0, duplicates: 0, remaining: 0 });
        assertTextEffects(f, before, { model: 1, text: 1, commits: 4 });
      }
      assert.deepEqual(f.peek().seenMessageIds, [inbound.messageId, following.messageId]);
      assert.equal(f.peek().pending, null); assert.equal(f.peek().queuedBatch, null); assert.equal(f.peek().revision, f.calls.commits.length + 1);
      assert.equal(new Set(f.calls.inputs.map(input => input.metadata.messageId)).size, f.calls.inputs.length);
      assert.equal(new Set(f.calls.parts.map(part => part.clientId)).size, f.calls.parts.length);
      await assertNoBackground(f);
    });
  }

  for (const [name, predicate, checks] of [
    ['false', () => false, 1], ['truthy nonboolean', () => 1, 1], ['throwing', () => { throw new Error('PRIVATE_ERROR'); }, 1],
    ['async true', () => Promise.resolve(true), 1], ['async rejection', () => Promise.reject(new Error('PRIVATE_ERROR')), 1],
    ['revoked at invocation', count => count === 1, 2],
  ]) test(`v${version} pollTextOnce denied beforeSend (${name}) never invokes text/media send`, async () => {
    const f = textFixture(version); let checked = 0;
    f.options.beforeSend = () => { assert.equal(f.peek().pending.phase, 'sending'); return predicate(++checked); }; restart(f);
    const before = effects(f);
    await assert.rejects(f.channel.pollTextOnce(), channelError('send-blocked'));
    assertTextEffects(f, before, { updates: 1, model: 1, commits: 4 }); assert.equal(checked, checks);
    assert.equal(f.peek().pending.phase, 'sending'); const retry = effects(f);
    await assert.rejects(f.channel.pollTextOnce(), channelError('recovery-required')); assertTextEffects(f, retry);
    await assertNoBackground(f);
  });
  for (const phase of ['ready', 'sending']) test(`v${version} pollTextOnce rechecks authorization after ${phase} CAS`, async () => {
    const f = textFixture(version); f.commitHook(next => { if (next.pending?.phase === phase) f.revoke(); }); const before = effects(f);
    await assert.rejects(f.channel.pollTextOnce(), channelError('send-blocked'));
    assertTextEffects(f, before, { updates: 1, model: 1, commits: 4 }); assert.equal(f.peek().pending.phase, 'sending');
    await assertNoBackground(f);
  });
}

for (const version of [2, 3]) {
  const cancellations = [
    { name: 'read', code: 'aborted', extra: {} },
    { name: 'updates', code: 'aborted', extra: { updates: 1 } },
    { name: 'reply', code: 'aborted', extra: { updates: 1, model: 1, commits: 2 } },
    { name: 'send', code: 'aborted', unknown: true, extra: { updates: 1, model: 1, text: 1, commits: 4 } },
    { name: 'inbox commit', phase: 'inbox', code: 'store-outcome-unknown', extra: { updates: 1, commits: 1 } },
    { name: 'replying commit', phase: 'replying', code: 'store-outcome-unknown', extra: { updates: 1, commits: 2 } },
    { name: 'ready commit', phase: 'ready', code: 'store-outcome-unknown', extra: { updates: 1, model: 1, commits: 3 } },
    { name: 'sending commit', phase: 'sending', code: 'store-outcome-unknown', extra: { updates: 1, model: 1, commits: 4 } },
    { name: 'completed commit', phase: 'completed', code: 'store-outcome-unknown', unknown: true, extra: { updates: 1, model: 1, text: 1, commits: 5 } },
  ];
  for (const cancellation of cancellations) {
    for (const settlement of ['reply', 'send'].includes(cancellation.name) ? ['resolve', 'reject'] : ['reject']) {
      test(`v${version} pollTextOnce cancellation during ${cancellation.name} consumes late ${settlement} without follow-on effects`, { timeout: 2000 }, async () => {
        const entered = deferred(), late = deferred(), batch = { cursor: 'new-cursor', messages: [inbound, following], ignored: 0 };
        const f = textFixture(version, () => {
          if (cancellation.name === 'reply') { entered.resolve(); return late.promise; }
          return 'One bounded reply';
        });
        f.updatesHook(() => {
          if (cancellation.name === 'updates') { entered.resolve(); return late.promise; }
          return batch;
        });
        if (cancellation.name === 'read') {
          const read = f.options.store.read;
          f.options.store.read = async () => { await read(); entered.resolve(); return late.promise; };
        }
        if (cancellation.name === 'send') f.sendHook(() => { entered.resolve(); return late.promise; });
        if (cancellation.phase) f.commitHook(next => { if (commitPhase(next) === cancellation.phase) { entered.resolve(); return late.promise; } });
        const caller = new AbortController(), before = effects(f), active = f.channel.pollTextOnce(caller.signal);
        await entered.promise; caller.abort(new Error('PRIVATE_ERROR SYNTHETIC_TOKEN'));
        await assert.rejects(active, channelError(cancellation.code, cancellation.unknown ?? false));
        assertTextEffects(f, before, cancellation.extra);
        for (const input of [...f.calls.updateInputs, ...f.calls.inputs, ...f.calls.sendInputs]) {
          assert.ok(input.signal instanceof AbortSignal); assert.notEqual(input.signal, caller.signal); assert.equal(input.signal.aborted, true);
        }
        const stopped = effects(f), stored = f.peek();
        if (settlement === 'reject') late.reject(new Error('PRIVATE_ERROR SYNTHETIC_TOKEN'));
        else late.resolve(cancellation.name === 'reply' ? 'Late valid text must not send' : { accepted: true });
        await assertNoBackground(f); assert.deepEqual(effects(f), stopped); assert.equal(f.peek(), stored);
        if (stored.pending !== null) {
          restart(f); const retry = effects(f);
          await assert.rejects(f.channel.pollTextOnce(), channelError('recovery-required')); assertTextEffects(f, retry);
        }
      });
    }
  }

  test(`v${version} pollTextOnce refuses busy calls instead of queuing or starting a media poller`, { timeout: 2000 }, async () => {
    const entered = deferred(), late = deferred(), f = textFixture(version, () => { entered.resolve(); return late.promise; });
    f.updatesHook(() => ({ cursor: 'new-cursor', messages: [inbound, following], ignored: 0 }));
    const first = effects(f), active = f.channel.pollTextOnce(); await entered.promise;
    for (const operation of [() => f.channel.pollTextOnce(), () => f.channel.pollOnce(), () => f.channel.getStatus()]) {
      const before = effects(f); await assert.rejects(operation(), channelError('busy')); assertTextEffects(f, before, { reads: 0 });
    }
    late.resolve('Only the explicit call replies');
    assertTextResult(await active, { received: 2, replied: 1, ignored: 0, duplicates: 0, remaining: 1 });
    assertTextEffects(f, first, { updates: 1, model: 1, text: 1, commits: 5 }); await assertNoBackground(f);
    const next = effects(f);
    assertTextResult(await f.channel.pollTextOnce(), { received: 1, replied: 1, ignored: 0, duplicates: 0, remaining: 0 });
    assertTextEffects(f, next, { model: 1, text: 1, commits: 4 }); await assertNoBackground(f);
  });

  test(`v${version} pollTextOnce disposal cancels an in-flight model wait without deleting/replaying the durable inbox`, { timeout: 2000 }, async () => {
    const entered = deferred(), late = deferred(), f = textFixture(version, () => { entered.resolve(); return late.promise; });
    f.updatesHook(() => ({ cursor: 'new-cursor', messages: [inbound, following], ignored: 0 }));
    let before = effects(f); const active = f.channel.pollTextOnce(); await entered.promise; f.channel.dispose();
    await assert.rejects(active, channelError('aborted')); assertTextEffects(f, before, { updates: 1, model: 1, commits: 2 });
    assert.equal(f.calls.inputs[0].signal.aborted, true); assert.equal(f.peek().pending.phase, 'replying');
    assert.deepEqual(f.peek().queuedBatch.messages, [inbound, following]); const stored = f.peek();
    late.reject(new Error('PRIVATE_ERROR')); await assertNoBackground(f); assert.equal(f.peek(), stored);
    before = effects(f); await assert.rejects(f.channel.pollTextOnce(), channelError('disposed')); assertTextEffects(f, before, { reads: 0 });
    restart(f); before = effects(f);
    await assert.rejects(f.channel.pollTextOnce(), channelError('recovery-required')); assertTextEffects(f, before);
  });

  test(`v${version} pollTextOnce competing instances allow only the durable CAS winner one model input/send`, { timeout: 2000 }, async () => {
    const initial = queuedState(version), f = textFixture(version, undefined, initial), gate = deferred();
    const read = f.options.store.read; let readers = 0;
    f.options.store.read = async () => { const snapshot = await read(); if (++readers === 2) gate.resolve(); await gate.promise; return snapshot; };
    const other = createWeixinChannel(f.options), before = effects(f);
    const outcomes = await Promise.allSettled([f.channel.pollTextOnce(), other.pollTextOnce()]);
    const winner = outcomes.filter(result => result.status === 'fulfilled'), loser = outcomes.filter(result => result.status === 'rejected');
    assert.equal(winner.length, 1); assert.equal(loser.length, 1); channelError('store-outcome-unknown')(loser[0].reason);
    assertTextResult(winner[0].value, { received: 2, replied: 1, ignored: 0, duplicates: 0, remaining: 1 });
    assertTextEffects(f, before, { reads: 2, model: 1, text: 1, commits: 4 });
    assert.deepEqual(f.peek().seenMessageIds, [inbound.messageId]); assert.deepEqual(f.peek().queuedBatch.messages, [following]);
    await assertNoBackground(f); other.dispose(); f.options.store.read = read; restart(f); const next = effects(f);
    assertTextResult(await f.channel.pollTextOnce(), { received: 1, replied: 1, ignored: 0, duplicates: 0, remaining: 0 });
    assertTextEffects(f, next, { model: 1, text: 1, commits: 4 });
    assert.deepEqual(f.calls.inputs.map(input => input.metadata.messageId), [inbound.messageId, following.messageId]);
    assert.deepEqual(f.calls.commits.map(value => value.revision), [2, 3, 4, 5, 6, 7, 8, 9]); await assertNoBackground(f);
  });

  for (const [name, queued, budget, success] of [
    ['insufficient queued budget', true, 3, false], ['exact queued budget', true, 4, true],
    ['insufficient new inbox budget', false, 4, false], ['exact new inbox budget', false, 5, true],
  ]) test(`v${version} pollTextOnce reserves revisions before effects: ${name}`, async () => {
    const revision = Number.MAX_SAFE_INTEGER - budget;
    const initial = queued ? queuedState(version, undefined, { revision }) : state({ version, revision });
    const f = textFixture(version, undefined, initial); f.updatesHook(() => ({ cursor: 'new-cursor', messages: [inbound, following], ignored: 0 }));
    let before = effects(f);
    if (!success) {
      await assert.rejects(f.channel.pollTextOnce(), channelError('revision-exhausted'));
      assertTextEffects(f, before, { updates: queued ? 0 : 1, commits: queued ? 0 : 1 });
      assert.equal(f.peek().pending, null); assert.deepEqual(f.peek().queuedBatch.messages, [inbound, following]);
    } else {
      assertTextResult(await f.channel.pollTextOnce(), { received: 2, replied: 1, ignored: 0, duplicates: 0, remaining: 1 });
      assertTextEffects(f, before, { updates: queued ? 0 : 1, model: 1, text: 1, commits: budget });
      assert.equal(f.peek().revision, Number.MAX_SAFE_INTEGER); assert.deepEqual(f.peek().queuedBatch.messages, [following]);
      const stored = f.peek(); restart(f); before = effects(f);
      await assert.rejects(f.channel.pollTextOnce(), channelError('revision-exhausted')); assertTextEffects(f, before); assert.equal(f.peek(), stored);
    }
    await assertNoBackground(f);
  });
}

test('pollTextOnce never schedules timers or a delayed/background polling loop', async () => {
  const timeout = globalThis.setTimeout, interval = globalThis.setInterval; let scheduled = 0;
  const forbidden = () => { scheduled++; throw new Error('SYNTHETIC_FORBIDDEN_TIMER'); };
  globalThis.setTimeout = forbidden; globalThis.setInterval = forbidden;
  try {
    for (const version of [2, 3]) {
      const f = textFixture(version); f.updatesHook(() => ({ cursor: 'new-cursor', messages: [inbound, following], ignored: 0 }));
      await assertNoBackground(f); const before = effects(f);
      assertTextResult(await f.channel.pollTextOnce(), { received: 2, replied: 1, ignored: 0, duplicates: 0, remaining: 1 });
      assertTextEffects(f, before, { updates: 1, model: 1, text: 1, commits: 5 }); await assertNoBackground(f); f.channel.dispose();
    }
  } finally { globalThis.setTimeout = timeout; globalThis.setInterval = interval; }
  assert.equal(scheduled, 0);
});
