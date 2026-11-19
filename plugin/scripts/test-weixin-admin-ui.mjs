#!/usr/bin/env node
// Author-executed, synthetic-only UI regression. No backend, credential store, or live server is opened.
// Node: node --test --experimental-test-coverage --test-coverage-include='**/weixin-admin-ui/admin.js' plugin/scripts/test-weixin-admin-ui.mjs
// Chrome: node plugin/scripts/test-weixin-admin-ui.mjs --browser --out audit/2026-11-06-integration-layer/frontend/run-01
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative, sep } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createWeixinAdminUi, UI_TEXT } from '../lib/weixin-admin-ui/admin.js';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const FRONTEND = 'audit/2026-11-06-integration-layer/frontend';
const MODULE_URL = 'https://wechat-management.test.invalid/mounted/api/wechat-ro-weixin/admin.js';
const PAGE_URL = new URL('./admin', MODULE_URL).href;
const PREFIX = new URL('./', MODULE_URL).pathname;
const QR = 'SYNTHETIC-OPAQUE-CONTENT-NOT-A-REAL-QR';
const CODE = 'SYNTHETIC-CODE';
const RAW_ERROR = '<img src="https://never.test.invalid/" onerror="throw 1">SYNTHETIC-RAW-ERROR';
const SOURCE_FILES = ['plugin/lib/weixin-admin-ui/admin.html', 'plugin/lib/weixin-admin-ui/admin.js', 'plugin/lib/weixin-admin-ui/admin.css', 'plugin/scripts/test-weixin-admin-ui.mjs'];
const html = await readFile(join(PROJECT, SOURCE_FILES[0]), 'utf8');
const script = await readFile(join(PROJECT, SOURCE_FILES[1]), 'utf8');
const sourceSha256 = Object.fromEntries(await Promise.all(SOURCE_FILES.map(async path => [path, createHash('sha256').update(await readFile(join(PROJECT, path))).digest('hex')])));
const PHASES = ['disabled', 'unpaired', 'qr-ready', 'awaiting-confirmation', 'paired', 'recovery-required'];
const ACTION_IDS = { beginLogin: 'begin', pollLogin: 'poll', confirmPairing: 'pair', cancelLogin: 'cancel-login', forget: 'forget' };
const BACKEND_ERRORS = ['invalid-options', 'invalid-request', 'invalid-json', 'invalid-input', 'unsupported-media-type', 'body-too-large', 'not-found', 'method-not-allowed', 'disabled', 'disposed', 'aborted', 'timeout', 'busy', 'not-configured', 'asset-unavailable', 'registration-failed', 'invalid-state', 'invalid-response', 'store-failed', 'store-outcome-unknown', 'api-failed', 'already-paired', 'login-active', 'login-required', 'login-not-confirmed', 'not-paired', 'recovery-required', 'revision-exhausted', 'operation-failed'];
const snapshot = (phase = 'unpaired', extra = {}) => ({ enabled: phase !== 'disabled', phase, hasStoredLogin: ['paired', 'recovery-required'].includes(phase), pendingRecovery: phase === 'recovery-required', messagingVerified: false, messagingEnabled: false, automaticPolling: false, ...extra });
const success = value => ({ ok: true, value });
const failure = (code, outcomeUnknown = false) => ({ ok: false, error: { code, outcomeUnknown } });
const response = (body, status = 200, contentType = 'application/json; charset=utf-8') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } });
const good = value => response(success(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { await nextTurn(); await nextTurn(); };

class FakeElement extends EventTarget {
  constructor(document, tagName, attrs) {
    super();
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    this.id = this.attributes.get('id') ?? '';
    this.dataset = {};
    if (this.attributes.has('data-i18n')) this.dataset.i18n = this.attributes.get('data-i18n');
    this.hidden = /(?:^|\s)hidden(?:\s|$)/u.test(attrs);
    this.disabled = /(?:^|\s)disabled(?:\s|$)/u.test(attrs);
    this.value = this.id === 'language' ? 'zh' : '';
    this.textContent = '';
    this.open = false;
    this.pixels = false;
    this.width = this.height = 256;
  }
  set width(value) { this._width = value; this.pixels = false; }
  get width() { return this._width; }
  set height(value) { this._height = value; this.pixels = false; }
  get height() { return this._height; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function fakeDom() {
  const doc = { documentElement: { lang: 'zh-CN' }, defaultView: new EventTarget(), title: '', activeElement: null };
  const nodes = [...html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)].map(m => new FakeElement(doc, m[1], m[2]));
  const byId = new Map(nodes.filter(n => n.id).map(n => [n.id, n]));
  doc.getElementById = id => byId.get(id) ?? null;
  const root = byId.get('weixin-admin');
  root.querySelector = selector => byId.get(selector.slice(1));
  root.querySelectorAll = selector => selector === '[data-i18n]' ? nodes.filter(n => n.dataset.i18n) : [];
  return { root, doc, win: doc.defaultView, nodes, el: id => byId.get(id) };
}
async function fixture(t, { phase = 'unpaired', renderer = null, initial = good(snapshot(phase)), dom = fakeDom() } = {}) {
  const queue = [initial], requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, ...init, headers: { ...init.headers }, bodyValue: init.body === undefined ? undefined : JSON.parse(init.body) });
    assert.ok(queue.length, 'An unexpected request is an automatic-action regression.');
    const item = queue.shift();
    return typeof item === 'function' ? item() : item;
  };
  const app = createWeixinAdminUi(dom.root, { fetcher, renderQr: renderer, moduleUrl: MODULE_URL });
  t.after(() => app.dispose());
  await settle();
  return { ...dom, app, queue, requests, fetcher };
}
const syntheticRenderer = (canvas, content) => { assert.equal(content, QR); canvas.pixels = true; };
function clean(f) {
  assert.equal(f.el('qr-canvas').pixels, false);
  assert.equal(f.el('qr-panel').hidden, true);
  assert.equal(f.el('verify-field').hidden, true);
  assert.equal(f.el('verify-code').value, '');
}
function noRawDom(f) {
  const text = f.nodes.map(n => [n.textContent, n.value, ...n.attributes.values()].join(' ')).join('\n');
  for (const raw of [QR, CODE, RAW_ERROR]) assert.equal(text.includes(raw), false, 'Sensitive or untrusted data was rendered.');
}
async function action(f, name, value) {
  f.queue.push(good(value));
  const before = f.requests.length;
  f.el(ACTION_IDS[name]).click();
  if (name !== 'pollLogin') {
    assert.equal(f.el('confirmation-dialog').open, true);
    assert.equal(f.requests.length, before, 'Opening a confirmation must not send a request.');
    f.el('confirmation-accept').click();
  }
  await settle();
  assert.equal(f.requests.length, before + 1);
}
async function readStatus(f, phase, extra = {}) {
  f.queue.push(good(snapshot(phase, extra)));
  f.el('refresh').click();
  await settle();
}
function expectSafeRequest(request) {
  const isAction = request.method === 'POST';
  assert.equal(request.url, new URL(isAction ? './action' : './status', MODULE_URL).href);
  assert.equal(request.credentials, 'same-origin');
  assert.equal(request.mode, 'same-origin');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.redirect, 'error');
  assert.equal(request.referrerPolicy, 'no-referrer');
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(request.headers, isAction ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Wechat-Management': '1' } : { Accept: 'application/json' });
}

if (process.argv.includes('--browser')) {
  await runBrowser();
} else {
  console.log(JSON.stringify({ executor: 'frontend author', syntheticOnly: true, node: process.version, sourceSha256 }));
  test('dictionary parity, static resource paths, and no storage/timer/raw HTML facilities', () => {
    const keys = object => Object.keys(object).sort().map(key => [key, typeof object[key] === 'object' ? keys(object[key]) : 'text']);
    assert.deepEqual(keys(UI_TEXT.zh), keys(UI_TEXT.en));
    for (const language of ['zh', 'en']) {
      assert.ok(Object.isFrozen(UI_TEXT[language]));
      for (const code of BACKEND_ERRORS) assert.equal(typeof UI_TEXT[language].errors[code], 'string');
      for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) assert.equal(typeof UI_TEXT[language][key], 'string');
    }
    assert.match(html, /src="\.\/admin\.js"/u);
    assert.match(html, /href="\.\/admin\.css"/u);
    assert.doesNotMatch(script, /\b(?:localStorage|sessionStorage|indexedDB|setInterval|setTimeout|innerHTML|insertAdjacentHTML)\b/u);
    assert.doesNotMatch(html, /<img\b|https?:|on(?:click|load|error)=/u);
  });

  for (const phase of PHASES) test('one initial read and truthful controls for ' + phase, async t => {
    const f = await fixture(t, { phase });
    assert.equal(f.requests.length, 1);
    expectSafeRequest(f.requests[0]);
    assert.equal(f.el('phase').textContent, UI_TEXT.zh.phases[phase]);
    assert.equal(f.el('begin').disabled, true);
    assert.equal(f.el('poll').disabled, phase !== 'qr-ready');
    assert.equal(f.el('pair').disabled, phase !== 'awaiting-confirmation');
    assert.equal(f.el('cancel-login').disabled, !['qr-ready', 'awaiting-confirmation'].includes(phase));
    assert.equal(f.el('forget').disabled, phase !== 'paired');
    assert.equal(f.el('renderer-notice').hidden, false);
    assert.match(f.el('status-source').textContent, /^状态读取于 /u);
    f.el('language').value = 'en'; f.el('language').dispatchEvent(new Event('change'));
    assert.equal(f.doc.documentElement.lang, 'en');
    assert.equal(f.doc.title, UI_TEXT.en.title);
    assert.equal(f.el('phase').textContent, UI_TEXT.en.phases[phase]);
    await settle(); assert.equal(f.requests.length, 1);
    f.el('language').value = 'not-a-locale'; f.el('language').dispatchEvent(new Event('change'));
    assert.equal(f.doc.documentElement.lang, 'zh-CN');
    clean(f); noRawDom(f);
  });

  test('renderer unavailable cannot be bypassed by enabling or dispatching the browser button', async t => {
    const f = await fixture(t);
    f.el('begin').disabled = false;
    f.el('begin').click();
    f.el('confirmation-accept').dispatchEvent(new Event('click'));
    f.el('poll').dispatchEvent(new Event('click'));
    f.el('stop-waiting').dispatchEvent(new Event('click'));
    assert.equal(f.el('confirmation-dialog').open, false);
    await settle(); assert.equal(f.requests.length, 1);
  });

  test('five exact action bodies, manual polling, confirmation back/Escape, and deterministic source labels', async t => {
    const f = await fixture(t, { renderer: syntheticRenderer });
    f.el('begin').click();
    assert.equal(f.doc.activeElement.id, 'confirmation-back');
    const key = (key, shiftKey) => { const event = new Event('keydown', { cancelable: true }); Object.assign(event, { key, shiftKey }); f.el('confirmation-dialog').dispatchEvent(event); return event; };
    assert.equal(key('Tab', true).defaultPrevented, true);
    assert.equal(f.doc.activeElement.id, 'confirmation-accept');
    assert.equal(key('Tab', false).defaultPrevented, true);
    assert.equal(f.doc.activeElement.id, 'confirmation-back');
    assert.equal(key('Tab', false).defaultPrevented, false);
    assert.equal(key('Escape', false).defaultPrevented, false);
    f.el('confirmation-back').click();
    assert.equal(f.doc.activeElement.id, 'begin');
    f.el('begin').click();
    f.el('language').value = 'en'; f.el('language').dispatchEvent(new Event('change'));
    assert.equal(f.el('confirmation-title').textContent, UI_TEXT.en.beginTitle);
    const escape = new Event('cancel', { cancelable: true });
    f.el('confirmation-dialog').dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(f.requests.length, 1);
    await action(f, 'beginLogin', { qrContent: QR });
    assert.equal(f.el('qr-panel').hidden, false);
    assert.equal(f.el('qr-canvas').pixels, true);
    assert.equal(f.el('status-source').textContent, UI_TEXT.en.actionSource);
    await action(f, 'pollLogin', { status: 'wait' });
    await action(f, 'pollLogin', { status: 'scaned' });
    await action(f, 'pollLogin', { status: 'need_verifycode' });
    assert.equal(f.el('verify-field').hidden, false);
    assert.equal(f.doc.activeElement.id, 'verify-code');
    f.el('verify-code').value = CODE;
    await action(f, 'pollLogin', { status: 'confirmed' });
    clean(f); noRawDom(f);
    assert.equal(f.doc.activeElement.id, 'pair');
    assert.equal(f.el('stored').textContent, UI_TEXT.en.absent);
    await action(f, 'confirmPairing', { paired: true });
    assert.equal(f.el('phase').textContent, UI_TEXT.en.phases.paired);
    assert.equal(f.el('feedback').textContent, UI_TEXT.en.saved);
    await action(f, 'forget', null);
    assert.equal(f.el('feedback').textContent, UI_TEXT.en.forgotten);
    await action(f, 'beginLogin', { qrContent: QR });
    await action(f, 'cancelLogin', null);
    assert.equal(f.el('feedback').textContent, UI_TEXT.en.cancelled);
    assert.deepEqual(f.requests.slice(1).map(r => r.bodyValue), [
      { action: 'beginLogin', confirmation: 'request-qr' }, { action: 'pollLogin' }, { action: 'pollLogin' }, { action: 'pollLogin' },
      { action: 'pollLogin', verifyCode: CODE }, { action: 'confirmPairing', confirmation: 'persist-pairing' },
      { action: 'forget', confirmation: 'forget-local-credentials' }, { action: 'beginLogin', confirmation: 'request-qr' }, { action: 'cancelLogin' },
    ]);
    f.requests.forEach(expectSafeRequest);
    await settle(); assert.equal(f.requests.length, 10, 'No post-action refresh or polling is allowed.');
    clean(f); noRawDom(f);
  });

  test('verification byte bounds reject invalid input without requests and clear immediately on send', async t => {
    const f = await fixture(t, { phase: 'qr-ready' });
    await action(f, 'pollLogin', { status: 'need_verifycode' });
    const before = f.requests.length;
    for (const value of ['', 'white space', '\u007f', '\u0000', '\ud800', 'a'.repeat(65), '汉'.repeat(22)]) {
      f.el('verify-code').value = value;
      f.el('poll').click();
      assert.equal(f.requests.length, before);
      assert.equal(f.el('verify-code').getAttribute('aria-invalid'), 'true');
      assert.equal(f.el('verify-error').textContent, UI_TEXT.zh.verifyInvalid);
      assert.equal(f.doc.activeElement.id, 'verify-code');
    }
    const delayed = deferred(); f.queue.push(() => delayed.promise);
    f.el('verify-code').value = '汉'.repeat(21); f.el('poll').click();
    assert.equal(f.el('verify-code').value, '');
    assert.equal(f.requests.at(-1).bodyValue.verifyCode, '汉'.repeat(21));
    delayed.resolve(good({ status: 'scaned' })); await settle();
    assert.equal(f.el('verify-field').hidden, true);
    assert.equal(f.el('verify-error').hidden, true);
  });

  for (const state of ['confirmed', 'expired', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect']) {
    test('QR and verification cleanup for terminal scan state ' + state, async t => {
      const f = await fixture(t, { renderer: syntheticRenderer });
      await action(f, 'beginLogin', { qrContent: QR });
      await action(f, 'pollLogin', { status: 'need_verifycode' });
      f.el('verify-code').value = CODE;
      await action(f, 'pollLogin', { status: state });
      clean(f); noRawDom(f);
      assert.equal(f.el('pairing-help').textContent, UI_TEXT.zh.qr[state]);
      assert.equal(f.el('stored').textContent, UI_TEXT.zh.absent);
      assert.equal(f.el('pair').disabled, state !== 'confirmed');
      if (['verify_code_blocked', 'scaned_but_redirect', 'binded_redirect'].includes(state)) {
        assert.equal(f.el('poll').disabled, true);
        f.el('poll').dispatchEvent(new Event('click'));
        await action(f, 'cancelLogin', null);
      }
      const count = f.requests.length; await settle(); assert.equal(f.requests.length, count);
    });
  }

  test('manual status snapshots always discard an older QR and code, even if phase is unchanged', async t => {
    const f = await fixture(t, { renderer: syntheticRenderer });
    await action(f, 'beginLogin', { qrContent: QR });
    await action(f, 'pollLogin', { status: 'need_verifycode' });
    f.el('verify-code').value = CODE;
    await readStatus(f, 'qr-ready'); clean(f);
    assert.equal(f.el('pairing-help').textContent, UI_TEXT.zh.qrHelp);
    f.el('language').value = 'en'; f.el('language').dispatchEvent(new Event('change'));
    await readStatus(f, 'paired'); clean(f);
    assert.match(f.el('status-source').textContent, /^Status read at /u);
  });

  for (const code of BACKEND_ERRORS) test('safe allowlisted error translation and no retry: ' + code, async t => {
    const f = await fixture(t, { phase: 'qr-ready' });
    f.el('qr-canvas').pixels = true; f.el('verify-code').value = CODE;
    f.queue.push(response(failure(code, false), code === 'disabled' ? 403 : 503));
    f.el('poll').click(); await settle();
    assert.ok(f.el('feedback').textContent.startsWith(UI_TEXT.zh.errors[code]));
    assert.ok(f.el('feedback').textContent.includes(UI_TEXT.zh.noRetry));
    assert.equal(f.el('feedback').textContent.includes(UI_TEXT.zh.unknownOutcome), code === 'store-outcome-unknown');
    assert.equal(f.el('phase').textContent, UI_TEXT.zh.unknown);
    f.el('language').value = 'en'; f.el('language').dispatchEvent(new Event('change'));
    assert.ok(f.el('feedback').textContent.startsWith(UI_TEXT.en.errors[code]));
    assert.equal(f.requests.length, 2);
    clean(f); noRawDom(f);
  });

  for (const [label, make, error] of [
    ['401 host authentication', () => response(RAW_ERROR, 401, 'text/html'), 'unauthorized'],
    ['403 HTML authorization', () => response(RAW_ERROR, 403, 'text/html'), 'forbidden'],
    ['403 bad JSON authorization', () => response(RAW_ERROR, 403), 'forbidden'],
    ['403 unknown error code', () => response(failure(RAW_ERROR), 403), 'forbidden'],
    ['500 unknown code', () => response(failure(RAW_ERROR), 500), 'http-error'],
    ['non JSON success', () => response(RAW_ERROR, 200, 'text/plain'), 'invalid-response'],
    ['bad JSON success', () => response(RAW_ERROR), 'invalid-response'],
    ['missing content type', () => ({ status: 200, ok: true, headers: new Headers(), json: async () => success(snapshot()) }), 'invalid-response'],
    ['array envelope', () => response([]), 'invalid-response'],
    ['extra envelope key', () => response({ ...success(snapshot()), raw: RAW_ERROR }), 'invalid-response'],
    ['invalid ok discriminant', () => response({ ok: false, value: snapshot() }), 'invalid-response'],
    ['invalid error outcome', () => response({ ok: false, error: { code: 'busy', outcomeUnknown: 'yes' } }), 'invalid-response'],
    ['missing envelope value', () => response({ ok: true }), 'invalid-response'],
    ['null envelope', () => response(null), 'invalid-response'],
  ]) test('sanitize malformed/host response: ' + label, async t => {
    const f = await fixture(t, { initial: make() });
    assert.ok(f.el('feedback').textContent.startsWith(UI_TEXT.zh.errors[error]));
    assert.equal(f.requests.length, 1); clean(f); noRawDom(f);
  });

  for (const [label, value] of [
    ['wrong phase', snapshot('unknown')], ['wrong enabled flag', snapshot('paired', { enabled: false })],
    ['nonboolean enabled', snapshot('unpaired', { enabled: 'yes' })], ['nonboolean stored', snapshot('unpaired', { hasStoredLogin: 1 })],
    ['nonboolean recovery', snapshot('unpaired', { pendingRecovery: 1 })], ['messaging verified', snapshot('unpaired', { messagingVerified: true })],
    ['messaging enabled', snapshot('unpaired', { messagingEnabled: true })], ['automatic polling', snapshot('unpaired', { automaticPolling: true })],
    ['extra field', { ...snapshot(), token: RAW_ERROR }], ['missing value', null],
  ]) test('reject invalid status shape: ' + label, async t => {
    const f = await fixture(t, { initial: good(value) });
    assert.ok(f.el('feedback').textContent.startsWith(UI_TEXT.zh.errors['invalid-response']));
    assert.equal(f.el('begin').disabled, true); noRawDom(f);
  });

  for (const [name, phase, value] of [
    ['beginLogin', 'unpaired', { qrContent: '' }], ['beginLogin', 'unpaired', { qrContent: '\ud800' }],
    ['beginLogin', 'unpaired', { qrContent: 'a'.repeat(8193) }], ['beginLogin', 'unpaired', { qrContent: 123 }],
    ['beginLogin', 'unpaired', { qrContent: QR, extra: RAW_ERROR }], ['pollLogin', 'qr-ready', { status: 'logged-in' }],
    ['pollLogin', 'qr-ready', null], ['confirmPairing', 'awaiting-confirmation', { paired: false }],
    ['cancelLogin', 'qr-ready', {}], ['forget', 'paired', false],
  ]) test('reject invalid ' + name + ' result ' + typeof value?.qrContent, async t => {
    const f = await fixture(t, { phase, renderer: syntheticRenderer });
    await action(f, name, value);
    assert.ok(f.el('feedback').textContent.startsWith(UI_TEXT.zh.errors['invalid-response']));
    assert.ok(f.el('feedback').textContent.includes(UI_TEXT.zh.unknownOutcome));
    assert.equal(f.requests.length, 2); clean(f); noRawDom(f);
  });

  test('network failure and unknown storage outcome require a new explicit refresh', async t => {
    const f = await fixture(t, { initial: () => { throw new Error(RAW_ERROR); } });
    assert.ok(f.el('feedback').textContent.startsWith(UI_TEXT.zh.errors['network-error']));
    assert.equal(f.el('feedback').textContent.includes(UI_TEXT.zh.unknownOutcome), false);
    await readStatus(f, 'paired');
    f.queue.push(() => { throw new Error(RAW_ERROR); });
    f.el('forget').click(); f.el('confirmation-accept').click(); await settle();
    assert.ok(f.el('feedback').textContent.includes(UI_TEXT.zh.unknownOutcome));
    f.el('forget').dispatchEvent(new Event('click'));
    assert.equal(f.el('confirmation-dialog').open, false);
    assert.equal(f.requests.length, 3); clean(f); noRawDom(f);
    await readStatus(f, 'awaiting-confirmation');
    f.queue.push(response(failure('store-outcome-unknown', true), 503));
    f.el('pair').click(); f.el('confirmation-accept').click(); await settle();
    assert.ok(f.el('feedback').textContent.includes(UI_TEXT.zh.unknownOutcome));
    assert.equal(f.requests.length, 5);
  });

  for (const renderer of [() => { throw new Error(RAW_ERROR); }, () => Promise.resolve(), () => true]) {
    test('a failed or non-synchronous renderer clears data and disables subsequent begin requests', async t => {
      const f = await fixture(t, { renderer });
      await action(f, 'beginLogin', { qrContent: QR });
      assert.ok(f.el('feedback').textContent.startsWith(UI_TEXT.zh.errors.rendererUnavailable));
      assert.equal(f.el('renderer-notice').hidden, false); clean(f); noRawDom(f);
      await readStatus(f, 'unpaired');
      f.el('begin').disabled = false; f.el('begin').click();
      assert.equal(f.requests.length, 3);
    });
  }

  test('serializes requests and stop-waiting aborts without a cancellation or automatic retry', async t => {
    const delay = deferred();
    const f = await fixture(t, { initial: () => delay.promise });
    assert.equal(f.el('progress').textContent, UI_TEXT.zh.loading);
    for (const id of ['refresh', 'begin', 'poll', 'pair', 'cancel-login', 'forget']) f.el(id).dispatchEvent(new Event('click'));
    assert.equal(f.requests.length, 1);
    f.el('stop-waiting').click();
    assert.equal(f.requests[0].signal.aborted, true);
    assert.equal(f.el('feedback').textContent, UI_TEXT.zh.stopped);
    await readStatus(f, 'unpaired');
    delay.resolve(good(snapshot('paired'))); await settle();
    assert.equal(f.el('phase').textContent, UI_TEXT.zh.phases.unpaired);
    assert.equal(f.requests.length, 2); clean(f);
  });

  test('generation invalidation also rejects stale asynchronous JSON after manual cancellation', async t => {
    const f = await fixture(t, { renderer: syntheticRenderer });
    const delay = deferred();
    f.queue.push({ status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: () => delay.promise });
    f.el('begin').click(); f.el('confirmation-accept').click(); await settle();
    assert.equal(f.el('progress').textContent, UI_TEXT.zh.working);
    f.el('poll').dispatchEvent(new Event('click'));
    f.el('confirmation-accept').dispatchEvent(new Event('click'));
    assert.equal(f.requests.length, 2);
    f.el('stop-waiting').click(); clean(f);
    await readStatus(f, 'qr-ready');
    await action(f, 'cancelLogin', null);
    delay.resolve(success({ qrContent: QR })); await settle();
    assert.equal(f.el('phase').textContent, UI_TEXT.zh.phases.unpaired);
    assert.equal(f.requests.length, 4); clean(f); noRawDom(f);
  });

  test('late errors after stop are ignored, including after a newer expiry', async t => {
    const f = await fixture(t, { phase: 'qr-ready' });
    const delay = deferred(); f.queue.push(() => delay.promise);
    f.el('poll').click(); f.el('stop-waiting').click();
    await readStatus(f, 'qr-ready'); await action(f, 'pollLogin', { status: 'expired' });
    delay.reject(new Error(RAW_ERROR)); await settle();
    assert.equal(f.el('pairing-help').textContent, UI_TEXT.zh.qr.expired);
    assert.equal(f.el('feedback').hidden, true); clean(f); noRawDom(f);
  });

  test('cancel clears pixels and code before network completion, without touching saved-login claims', async t => {
    const f = await fixture(t, { renderer: syntheticRenderer });
    await action(f, 'beginLogin', { qrContent: QR });
    await action(f, 'pollLogin', { status: 'need_verifycode' });
    f.el('verify-code').value = CODE;
    const delay = deferred(); f.queue.push(() => delay.promise);
    f.el('cancel-login').click(); f.el('confirmation-accept').click(); clean(f);
    assert.equal(f.requests.at(-1).bodyValue.action, 'cancelLogin');
    delay.resolve(good(null)); await settle(); clean(f);
  });

  test('pagehide aborts, clears a displayed QR and typed code, removes handlers, and suppresses late results', async t => {
    const f = await fixture(t, { renderer: syntheticRenderer });
    await action(f, 'beginLogin', { qrContent: QR }); await action(f, 'pollLogin', { status: 'need_verifycode' });
    f.el('verify-code').value = CODE;
    const delay = deferred(); f.queue.push(() => delay.promise);
    f.el('poll').click(); const last = f.requests.at(-1);
    f.win.dispatchEvent(new Event('pagehide')); clean(f);
    assert.equal(last.signal.aborted, true);
    delay.resolve(good({ status: 'confirmed' })); await settle();
    assert.equal(f.el('phase').textContent, UI_TEXT.zh.unknown);
    assert.equal(f.el('pairing-help').textContent, UI_TEXT.zh.disposedHelp);
    const count = f.requests.length;
    f.el('refresh').dispatchEvent(new Event('click')); f.app.dispose(); f.app.dispose();
    assert.equal(f.requests.length, count); noRawDom(f);
  });

  test('dispose closes an open dialog; remount disposes the old instance without extra requests', async t => {
    const f = await fixture(t, { phase: 'paired' });
    f.el('forget').click(); assert.equal(f.el('confirmation-dialog').open, true);
    f.app.dispose(); assert.equal(f.el('confirmation-dialog').open, false);
    const newer = await fixture(t, { dom: f, phase: 'unpaired' });
    const delay = deferred(); newer.queue.push(() => delay.promise); newer.el('refresh').click();
    const latest = await fixture(t, { dom: f, phase: 'disabled' });
    assert.equal(newer.requests.at(-1).signal.aborted, true);
    delay.resolve(good(snapshot('paired'))); await settle();
    assert.equal(latest.el('phase').textContent, UI_TEXT.zh.phases.disabled);
    assert.equal(f.requests.length, 1); assert.equal(latest.requests.length, 1);
  });

  test('pending recovery prevents all writes even with forged UI clicks', async t => {
    const f = await fixture(t, { phase: 'recovery-required', renderer: syntheticRenderer });
    for (const id of Object.values(ACTION_IDS)) f.el(id).dispatchEvent(new Event('click'));
    assert.equal(f.requests.length, 1);
    assert.equal(f.el('confirmation-dialog').open, false);
  });
}

async function runBrowser() {
  const outIndex = process.argv.indexOf('--out');
  const out = resolve(PROJECT, outIndex >= 0 ? process.argv[outIndex + 1] : FRONTEND + '/browser-run');
  const auditRoot = resolve(PROJECT, FRONTEND);
  if (out !== auditRoot && !out.startsWith(auditRoot + sep)) throw new Error('Browser output must stay inside the scoped frontend audit directory.');
  const privateRoot = join(out, 'private-chrome');
  const privateDirs = ['home', 'config', 'cache', 'tmp', 'profile', 'crashes'];
  for (const name of privateDirs) await mkdir(join(privateRoot, name), { recursive: true, mode: 0o700 });
  const browserModule = process.env.WECHAT_BROWSER_MODULE;
  const probeRoot = process.env.WECHAT_DESIGN_PROBE_ROOT;
  if (!browserModule || !probeRoot) throw new Error('Browser mode requires WECHAT_BROWSER_MODULE and WECHAT_DESIGN_PROBE_ROOT.');
  const { chromium } = await import(browserModule);
  const { probe, layout, app: appProbe, frame } = await import(resolve(probeRoot, 'probe.mjs'));
  const { judge, judgeLayout, judgeApp, APP_SKIP } = await import(resolve(probeRoot, 'rules.mjs'));
  const results = [], apiCalls = [], routeRecords = [], violations = [], pageErrors = [], consoleMessages = [], inspections = [];
  const assets = new Map(await Promise.all(SOURCE_FILES.slice(0, 3).map(async (path, i) => [PREFIX + ['admin', 'admin.js', 'admin.css'][i], { body: await readFile(join(PROJECT, path)), contentType: ['text/html; charset=utf-8', 'text/javascript; charset=utf-8', 'text/css; charset=utf-8'][i] }])));
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data: blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
  let statusReply = { status: 200, body: success(snapshot()) };
  const actionReplies = [];
  let context, page, chromeVersion = '', failed = null;
  const originalCwd = process.cwd(), originalTmpdir = process.env.TMPDIR;
  const check = async (name, fn) => {
    try { await fn(); results.push({ name, status: 'pass' }); console.log('PASS ' + name); }
    catch (error) { results.push({ name, status: 'fail', error: error.message }); throw error; }
  };
  const idle = async () => page.waitForFunction(() => document.querySelector('#weixin-admin').getAttribute('aria-busy') === 'false');
  const readPhase = async phase => { statusReply = { status: 200, body: success(snapshot(phase)) }; await page.locator('#refresh').click(); await idle(); };
  const send = async (name, value, { status = 200, body = success(value), verifyCode } = {}) => {
    const before = apiCalls.length;
    const payload = { action: name };
    if (name === 'beginLogin') payload.confirmation = 'request-qr';
    if (name === 'confirmPairing') payload.confirmation = 'persist-pairing';
    if (name === 'forget') payload.confirmation = 'forget-local-credentials';
    if (verifyCode !== undefined) { payload.verifyCode = verifyCode; await page.locator('#verify-code').fill(verifyCode); }
    actionReplies.push({ name, status, body });
    await page.locator('#' + ACTION_IDS[name]).click();
    if (name !== 'pollLogin') {
      assert.equal(apiCalls.length, before, 'A dialog is not authorization to execute yet.');
      await page.locator('#confirmation-accept').click();
    }
    await idle();
    assert.equal(apiCalls.length, before + 1);
    assert.deepEqual(apiCalls.at(-1).body, payload);
  };
  const browserClean = async () => {
    const value = await page.evaluate(() => {
      const canvas = document.querySelector('#qr-canvas');
      return { pixelAlpha: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.filter((_, i) => i % 4 === 3).some(x => x !== 0), qrHidden: document.querySelector('#qr-panel').hidden, verifyHidden: document.querySelector('#verify-field').hidden, code: document.querySelector('#verify-code').value };
    });
    assert.deepEqual(value, { pixelAlpha: false, qrHidden: true, verifyHidden: true, code: '' });
  };
  const contrastCheck = async name => {
    const pairs = await page.evaluate(() => {
      const rgb = color => color.match(/[\d.]+/gu).map(Number);
      const luminance = channels => channels.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
      const root = document.querySelector('dialog[open]') || document.querySelector('#weixin-admin');
      return [...root.querySelectorAll('*')].filter(el => el.checkVisibility() && [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())).map(el => {
        const color = getComputedStyle(el).color;
        let background = 'rgb(255, 255, 255)';
        for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
          const candidate = getComputedStyle(ancestor).backgroundColor, channels = rgb(candidate);
          if ((channels[3] ?? 1) === 1) { background = candidate; break; }
          if (channels[3] !== 0) throw new Error('This contrast fixture needs opaque text surfaces.');
        }
        const a = luminance(rgb(color)), b = luminance(rgb(background));
        return { element: el.id || el.tagName.toLowerCase(), color, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      });
    });
    await writeFile(join(out, 'contrast-' + name + '.json'), JSON.stringify({ threshold: 4.5, minimum: Math.min(...pairs.map(pair => pair.ratio)), pairs }, null, 2) + '\n');
    assert.ok(pairs.length > 0 && pairs.every(pair => pair.ratio >= 4.5), 'Visible text must meet 4.5:1 contrast, including muted and disabled copy.');
  };
  const noBrowserLeaks = async () => {
    const markup = await page.content();
    for (const raw of [QR, CODE, RAW_ERROR]) assert.equal(markup.includes(raw), false, 'Raw fixture data leaked into HTML.');
    const attrs = await page.evaluate(() => [...document.querySelectorAll('[src],[href]')].flatMap(el => [el.getAttribute('src'), el.getAttribute('href')]).filter(Boolean));
    assert.ok(attrs.every(value => value === './admin.js' || value === './admin.css'));
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    assert.deepEqual(await context.cookies(), []);
  };
  const mountRenderer = async (mode = 'pixel') => {
    statusReply = { status: 200, body: success(snapshot()) };
    await page.evaluate(async ({ url, mode, qr }) => {
      const { createWeixinAdminUi } = await import(url);
      window.__syntheticDraws = 0;
      window.__fixtureUi = createWeixinAdminUi(document.querySelector('#weixin-admin'), {
        renderQr(canvas, content) {
          if (mode === 'throws') throw new Error('Synthetic renderer failure.');
          if (content !== qr) throw new Error('Unexpected synthetic fixture.');
          // ONE pixel only: explicitly not a QR encoder, pattern, or scannable code.
          canvas.getContext('2d').fillRect(0, 0, 1, 1);
          window.__syntheticDraws += 1;
        },
      });
    }, { url: MODULE_URL, mode, qr: QR });
    await idle();
  };
  try {
    // Unix-domain socket paths have a 108-byte limit. A relative private TMPDIR
    // keeps Chromium's singleton socket short without writing outside this audit.
    process.chdir(privateRoot);
    process.env.TMPDIR = 'tmp';
    context = await chromium.launchPersistentContext(join(privateRoot, 'profile'), {
      executablePath: '/usr/bin/google-chrome', headless: true, viewport: { width: 1440, height: 900 },
      locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: false,
      env: { PATH: '/usr/bin:/bin', HOME: join(privateRoot, 'home'), XDG_CONFIG_HOME: join(privateRoot, 'config'), XDG_CACHE_HOME: join(privateRoot, 'cache'), TMPDIR: 'tmp', LANG: 'C.UTF-8' },
      args: ['--disable-background-networking', '--disable-component-update', '--disable-breakpad', '--disable-crash-reporter', '--disable-sync', '--disable-extensions', '--disable-default-apps', '--no-first-run', '--no-proxy-server', '--metrics-recording-only', '--host-resolver-rules=MAP * ~NOTFOUND', '--crash-dumps-dir=' + join(privateRoot, 'crashes')],
    });
    chromeVersion = context.browser().version();
    context.setDefaultTimeout(5000);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      routeRecords.push({ method: request.method(), origin: url.origin, path: url.pathname });
      if (url.origin !== new URL(MODULE_URL).origin || url.search) {
        violations.push('Unexpected request origin or query.');
        await route.fulfill({ status: 400, headers, contentType: 'text/plain', body: 'Synthetic route denied.' }); return;
      }
      const asset = assets.get(url.pathname);
      if (asset && request.method() === 'GET') { await route.fulfill({ status: 200, headers, ...asset }); return; }
      if (url.pathname === '/favicon.ico') { await route.fulfill({ status: 204, headers }); return; }
      if (url.pathname === PREFIX + 'status' && request.method() === 'GET') {
        apiCalls.push({ kind: 'status', method: request.method(), url: request.url(), headers: request.headers() });
        await route.fulfill({ ...statusReply, headers, contentType: 'application/json', body: JSON.stringify(statusReply.body) }); return;
      }
      if (url.pathname === PREFIX + 'action' && request.method() === 'POST') {
        const body = request.postDataJSON();
        apiCalls.push({ kind: 'action', method: request.method(), url: request.url(), headers: request.headers(), body });
        const reply = actionReplies.shift();
        if (!reply || reply.name !== body.action) {
          violations.push('Unscheduled action request.');
          await route.fulfill({ status: 500, headers, contentType: 'application/json', body: JSON.stringify(failure('invalid-request')) }); return;
        }
        await route.fulfill({ status: reply.status, headers, contentType: 'application/json', body: JSON.stringify(reply.body) }); return;
      }
      violations.push('Unexpected synthetic route path.');
      await route.fulfill({ status: 404, headers, contentType: 'text/plain', body: 'No synthetic fixture.' });
    });
    page = context.pages()[0] ?? await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text() }));
    await page.goto(PAGE_URL);
    await idle();

    await check('browser default makes one initial status read and zero begin requests, including forged controls', async () => {
      assert.equal(apiCalls.length, 1);
      assert.equal(await page.locator('#begin').isDisabled(), true);
      assert.equal(await page.locator('#renderer-notice').isVisible(), true);
      await page.evaluate(() => {
        window.renderQr = () => {};
        window.QRCode = { toCanvas() {} };
        const begin = document.querySelector('#begin');
        begin.dataset.renderer = 'enabled'; begin.disabled = false; begin.click();
        document.querySelector('#confirmation-accept').click();
        begin.disabled = true;
      });
      await page.waitForTimeout(120);
      assert.equal(apiCalls.length, 1);
      assert.equal(await page.locator('#confirmation-dialog').isVisible(), false);
      await browserClean(); await noBrowserLeaks();
    });

    for (const [width, height, name] of [[1440, 900, 'desktop'], [768, 1024, 'tablet'], [390, 844, 'narrow']]) {
      await check('default Chinese layout, keyboard target sizes, and screenshot at ' + width, async () => {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(out, 'default-zh-' + name + '-' + width + '.png'), fullPage: true, animations: 'disabled' });
        const metrics = await page.evaluate(probe), lay = await page.evaluate(layout), appMetrics = await page.evaluate(appProbe);
        const findings = [...judge(metrics, { width }), ...judgeLayout(lay, { width })].filter(f => !APP_SKIP.has(f.id) && f.id !== 'no-title' && f.id !== 'small-title');
        findings.push(...judgeApp(appMetrics, metrics, { width }));
        const box = await page.evaluate(() => ({
          width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          titleSize: getComputedStyle(document.querySelector('h1')).fontSize,
          controls: [...document.querySelectorAll('button,select,input')].filter(el => el.checkVisibility()).map(el => ({ id: el.id, height: el.getBoundingClientRect().height })),
          sectionStarts: [...document.querySelectorAll('.settings-row')].map(el => el.getBoundingClientRect().top),
        }));
        assert.ok(box.scrollWidth <= width, 'The page overflows horizontally.');
        assert.equal(box.titleSize, '24px');
        assert.ok(box.controls.every(control => control.height >= 44), 'Visible controls must be at least 44px tall.');
        if (width === 1440) assert.ok(box.sectionStarts.every(top => top < height), 'Each task section must start in the first desktop view.');
        inspections.push({ width, height, metrics, layout: lay, app: appMetrics, frame: await page.evaluate(frame), box, findings });
        await writeFile(join(out, 'inspection-' + width + '.json'), JSON.stringify(inspections.at(-1), null, 2) + '\n');
        assert.deepEqual(findings.filter(f => f.level === 'FAIL'), [], 'Installed app inspection found a failure.');
        await contrastCheck('default-zh-' + width);
        assert.equal(apiCalls.length, 1, 'Resizing and rendering must not poll.');
      });
    }

    await check('English narrow layout, keyboard refresh, and visible focus without an automatic language read', async () => {
      await page.locator('#language').selectOption('en');
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
      assert.equal(await page.title(), UI_TEXT.en.title);
      assert.equal(apiCalls.length, 1);
      await page.screenshot({ path: join(out, 'default-en-narrow-390.png'), fullPage: true, animations: 'disabled' });
      await contrastCheck('default-en-390');
      await page.locator('#language').focus(); await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'refresh');
      assert.equal(await page.locator('#refresh').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
      await page.keyboard.press('Enter'); await idle();
      assert.equal(apiCalls.length, 2);
      assert.ok(await page.locator('#status-source').textContent().then(text => text.startsWith('Status read at ')));
    });

    await check('native destructive confirmation traps focus, Escape restores focus, and Enter sends exactly once', async () => {
      await readPhase('paired');
      await page.locator('#forget').focus(); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'confirmation-back');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'confirmation-accept');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'confirmation-back');
      const before = apiCalls.length;
      await contrastCheck('confirm-forget-en-390');
      await page.screenshot({ path: join(out, 'confirm-forget-en-narrow-390.png'), fullPage: false, animations: 'disabled' });
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'forget');
      assert.equal(apiCalls.length, before);
      actionReplies.push({ name: 'forget', status: 200, body: success(null) });
      await page.keyboard.press('Enter');
      assert.equal(apiCalls.length, before);
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Enter'); await idle();
      assert.deepEqual(apiCalls.at(-1).body, { action: 'forget', confirmation: 'forget-local-credentials' });
      await page.waitForTimeout(100);
      assert.equal(apiCalls.length, before + 1);
      assert.equal(await page.locator('#status-source').textContent(), UI_TEXT.en.actionSource);
      assert.equal(await page.locator('#feedback').textContent(), UI_TEXT.en.forgotten);
    });

    await check('separate save works only after a read of awaiting-confirmation and makes no status follow-up', async () => {
      await readPhase('awaiting-confirmation');
      await send('confirmPairing', { paired: true });
      assert.equal(await page.locator('#phase').textContent(), UI_TEXT.en.phases.paired);
      assert.equal(await page.locator('#feedback').textContent(), UI_TEXT.en.saved);
      await browserClean();
    });

    await check('trusted same-process synthetic renderer supports explicit begin; no QR text enters DOM or URL', async () => {
      await mountRenderer();
      assert.equal(await page.locator('#begin').isDisabled(), false);
      const before = apiCalls.length;
      await page.locator('#begin').click(); await page.locator('#confirmation-back').click();
      assert.equal(apiCalls.length, before);
      await send('beginLogin', { qrContent: QR });
      assert.equal(await page.evaluate(() => window.__syntheticDraws), 1);
      assert.equal(await page.locator('#qr-panel').isVisible(), true);
      assert.equal(await page.locator('#phase').textContent(), UI_TEXT.zh.phases['qr-ready']);
      await noBrowserLeaks();
    });

    await check('manual scan checks handle code validation, byte limits, and confirmed cleanup', async () => {
      await send('pollLogin', { status: 'scaned' });
      await send('pollLogin', { status: 'need_verifycode' });
      assert.equal(await page.locator('#verify-field').isVisible(), true);
      assert.equal(await page.locator('#verify-code').getAttribute('type'), 'password');
      const before = apiCalls.length;
      await page.locator('#verify-code').fill('汉'.repeat(22)); await page.locator('#poll').click();
      assert.equal(apiCalls.length, before);
      assert.equal(await page.locator('#verify-code').getAttribute('aria-invalid'), 'true');
      await send('pollLogin', { status: 'confirmed' }, { verifyCode: CODE });
      await browserClean(); await noBrowserLeaks();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'pair');
      assert.equal(await page.locator('#stored').textContent(), UI_TEXT.zh.absent);
      await send('confirmPairing', { paired: true });
      assert.equal(await page.locator('#feedback').textContent(), UI_TEXT.zh.saved);
    });

    for (const state of ['expired', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect']) {
      await check('real canvas/code cleanup and non-success handling for ' + state, async () => {
        await readPhase('unpaired');
        await send('beginLogin', { qrContent: QR });
        await send('pollLogin', { status: 'need_verifycode' });
        await send('pollLogin', { status: state }, { verifyCode: CODE });
        await browserClean(); await noBrowserLeaks();
        assert.equal(await page.locator('#pairing-help').textContent(), UI_TEXT.zh.qr[state]);
        assert.equal(await page.locator('#pair').isDisabled(), true);
        if (state !== 'expired') {
          assert.equal(await page.locator('#poll').isDisabled(), true);
          await send('cancelLogin', null);
        }
        const before = apiCalls.length; await page.waitForTimeout(80); assert.equal(apiCalls.length, before);
      });
    }

    await check('401 response clears sensitive data and does not retry or display the raw error', async () => {
      await readPhase('unpaired'); await send('beginLogin', { qrContent: QR });
      await send('pollLogin', { status: 'need_verifycode' });
      await send('pollLogin', undefined, { status: 401, body: { raw: RAW_ERROR }, verifyCode: CODE });
      await browserClean(); await noBrowserLeaks();
      assert.ok((await page.locator('#feedback').textContent()).startsWith(UI_TEXT.zh.errors.unauthorized));
      const before = apiCalls.length; await page.waitForTimeout(100); assert.equal(apiCalls.length, before);
    });

    await check('unknown storage outcome stays unverified and warns against rollback or automatic retry', async () => {
      await readPhase('awaiting-confirmation');
      await send('confirmPairing', undefined, { status: 503, body: failure('store-outcome-unknown', false) });
      assert.ok((await page.locator('#feedback').textContent()).includes(UI_TEXT.zh.unknownOutcome));
      assert.equal(await page.locator('#phase').textContent(), UI_TEXT.zh.unknown);
      await browserClean();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: join(out, 'unknown-outcome-zh-desktop-1440.png'), fullPage: true, animations: 'disabled' });
      await contrastCheck('unknown-outcome-zh-1440');
    });

    await check('throwing renderer disables future begin and cleans the real canvas', async () => {
      await mountRenderer('throws'); await send('beginLogin', { qrContent: QR });
      assert.ok((await page.locator('#feedback').textContent()).startsWith(UI_TEXT.zh.errors.rendererUnavailable));
      await browserClean(); await noBrowserLeaks();
      await readPhase('unpaired'); assert.equal(await page.locator('#begin').isDisabled(), true);
    });

    await check('AbortController and generation reject a late QR after stop and a newer manual refresh', async () => {
      statusReply = { status: 200, body: success(snapshot()) };
      await page.evaluate(async url => {
        const { createWeixinAdminUi } = await import(url);
        window.__late = { signal: null, release: null, calls: 0, draws: 0 };
        window.__fixtureUi = createWeixinAdminUi(document.querySelector('#weixin-admin'), {
          fetcher(input, init) {
            if (init.method === 'GET') return fetch(input, init);
            window.__late.calls++; window.__late.signal = init.signal;
            return Promise.resolve({ status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: () => new Promise(resolve => { window.__late.release = resolve; }) });
          },
          renderQr(canvas) { window.__late.draws++; canvas.getContext('2d').fillRect(0, 0, 1, 1); },
        });
      }, MODULE_URL); await idle();
      await page.locator('#begin').click(); await page.locator('#confirmation-accept').click();
      await page.waitForFunction(() => typeof window.__late.release === 'function');
      await page.locator('#stop-waiting').click();
      assert.equal(await page.evaluate(() => window.__late.signal.aborted), true);
      await browserClean();
      await readPhase('unpaired');
      await page.evaluate(qr => window.__late.release({ ok: true, value: { qrContent: qr } }), QR);
      await page.waitForTimeout(100);
      assert.deepEqual(await page.evaluate(() => [window.__late.calls, window.__late.draws]), [1, 0]);
      assert.equal(await page.locator('#phase').textContent(), UI_TEXT.zh.phases.unpaired);
      await browserClean(); await noBrowserLeaks();
    });

    await check('pagehide disposal clears typed code and pixels, aborts a pending check, and ignores its late response', async () => {
      statusReply = { status: 200, body: success(snapshot('qr-ready')) };
      await page.evaluate(async url => {
        const { createWeixinAdminUi } = await import(url);
        window.__hidden = { signal: null, release: null, calls: 0 };
        window.__fixtureUi = createWeixinAdminUi(document.querySelector('#weixin-admin'), {
          fetcher(input, init) {
            if (init.method === 'GET') return fetch(input, init);
            window.__hidden.calls++; window.__hidden.signal = init.signal;
            if (window.__hidden.calls === 1) return Promise.resolve(new Response(JSON.stringify({ ok: true, value: { status: 'need_verifycode' } }), { headers: { 'content-type': 'application/json' } }));
            return new Promise(resolve => { window.__hidden.release = resolve; });
          },
        });
      }, MODULE_URL); await idle();
      await page.locator('#poll').click(); await idle();
      await page.locator('#verify-code').fill(CODE);
      await page.evaluate(() => document.querySelector('#qr-canvas').getContext('2d').fillRect(0, 0, 1, 1));
      await page.locator('#poll').click();
      await page.waitForFunction(() => typeof window.__hidden.release === 'function');
      const before = apiCalls.length;
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
      assert.equal(await page.evaluate(() => window.__hidden.signal.aborted), true);
      await browserClean();
      await page.evaluate(() => window.__hidden.release(new Response(JSON.stringify({ ok: true, value: { status: 'confirmed' } }), { headers: { 'content-type': 'application/json' } })));
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#phase').textContent(), UI_TEXT.zh.unknown);
      assert.equal(await page.locator('#refresh').isDisabled(), true);
      assert.equal(apiCalls.length, before, 'Disposal must not issue cancellation or status requests.');
      await noBrowserLeaks();
    });

    await check('all routed traffic was fulfilled on the synthetic mount, actions use strict headers, and no errors leak', async () => {
      for (const call of apiCalls) {
        assert.equal(new URL(call.url).origin, new URL(MODULE_URL).origin);
        assert.equal(call.headers.cookie, undefined);
        assert.equal(call.headers.authorization, undefined);
        if (call.kind === 'action') {
          assert.equal(call.headers['x-wechat-management'], '1');
          assert.equal(call.headers['content-type'], 'application/json');
          assert.equal(new URL(call.url).pathname, PREFIX + 'action');
          const keys = Object.keys(call.body).sort();
          assert.deepEqual(keys, call.body.action === 'pollLogin' ? call.body.verifyCode ? ['action', 'verifyCode'] : ['action'] : call.body.action === 'cancelLogin' ? ['action'] : ['action', 'confirmation']);
        }
      }
      assert.deepEqual(violations, []);
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(actionReplies, []);
      for (const entry of consoleMessages) for (const raw of [QR, CODE, RAW_ERROR]) assert.equal(entry.text.includes(raw), false);
      await noBrowserLeaks();
    });
  } catch (error) {
    failed = { name: error.name, message: error.message, stack: error.stack };
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    process.chdir(originalCwd);
    if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
    const report = {
      executor: 'frontend author (not independent review)', syntheticOnly: true, node: process.version, chrome: chromeVersion,
      playwright: '1.61.1 (preinstalled)', origin: new URL(MODULE_URL).origin, mountedPath: PREFIX,
      isolation: { privateProfile: relative(PROJECT, privateRoot), liveDshAccess: false, realWeChatAccess: false, credentialsOrDatabaseRead: false, installedOrDownloadedDependencies: false, routeMode: 'every route fulfilled; no continue or real transport', resolver: 'MAP * ~NOTFOUND' },
      renderer: { browserDefaultEnabled: false, defaultBeginRequests: 0, testOnly: 'trusted factory; one synthetic pixel, not a QR encoder or code' },
      sourceSha256, results, passed: results.filter(result => result.status === 'pass').length, failed, violations, pageErrors,
      consoleMessages, routeRecords,
      apiCalls: apiCalls.map(call => ({ kind: call.kind, method: call.method, path: new URL(call.url).pathname, action: call.body?.action, bodyKeys: call.body ? Object.keys(call.body).sort() : [], verifyCodeSent: !!call.body?.verifyCode })),
      inspection: { implementation: 'Installed probe/layout/app/frame and judge functions used inside the isolated Playwright page; inspector CLI/server not run.', widths: inspections.map(item => ({ width: item.width, findings: item.findings })) },
    };
    await writeFile(join(out, 'browser-result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, total: results.length, failed, chrome: chromeVersion, sourceSha256, output: relative(PROJECT, out), routes: routeRecords.length, apiCalls: apiCalls.length }, null, 2));
  }
  if (failed) throw new Error('Isolated browser regression failed: ' + failed.message);
}
