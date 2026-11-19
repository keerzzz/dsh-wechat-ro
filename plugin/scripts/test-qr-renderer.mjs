#!/usr/bin/env node
// Offline QR algorithm tests only. No account, browser, image service or login.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import qrcodeFactory from 'qrcode-generator';
import jsQrModule from 'jsqr';
import { prepareLocalQrRenderer, QR_MAX_PAYLOAD_BYTES } from '../lib/qr-renderer.js';

const jsQR = typeof jsQrModule === 'function' ? jsQrModule : jsQrModule.default;
const savedFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = () => { networkAttempts++; throw new Error('QR tests forbid network'); };
const fails = fn => assert.throws(fn, error => error?.code === 'QR_UNAVAILABLE');
const matrixShape = matrix => {
  assert.equal(matrix.payloadKind, 'ilink-login');
  const size = matrix.rows.length;
  assert.ok(size >= 21 && size <= 177 && (size - 21) % 4 === 0);
  assert.ok(Object.isFrozen(matrix) && Object.isFrozen(matrix.rows));
  for (const row of matrix.rows) assert.ok(row.length === size && /^[01]+$/u.test(row));
  assert.ok(!JSON.stringify(matrix).includes('https:'));
};
function decode(matrix) {
  // A quiet zone and exact integer pixels, not a screenshot or UI mock.
  const quiet = 4, scale = 6, width = (matrix.rows.length + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let row = 0; row < matrix.rows.length; row++) {
    for (let column = 0; column < matrix.rows.length; column++) {
      if (matrix.rows[row][column] !== '1') continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const index = (((row + quiet) * scale + dy) * width + (column + quiet) * scale + dx) * 4;
        rgba[index] = rgba[index + 1] = rgba[index + 2] = 0;
      }
    }
  }
  const result = jsQR(rgba, width, width, { inversionAttempts: 'dontInvert' });
  assert.ok(result, 'independent jsQR decoder must find the locally generated matrix');
  return result.data;
}
function fakeFactory({ size = 21, dark = false, makeThrows = false } = {}) {
  let calls = 0;
  const factory = () => { calls++; return {
    addData() {}, make() { if (makeThrows) throw new Error('SYNTHETIC_ENCODER_FAILURE'); },
    getModuleCount() { return size; }, isDark() { return dark; },
  }; };
  factory.stringToBytes = value => Array.from(value, character => character.charCodeAt(0));
  return { factory, calls: () => calls };
}

try {
  const render = await prepareLocalQrRenderer();
  await test('real local encoder produces a frozen legal matrix, independently decodable ASCII', () => {
    const payload = 'https://ilinkai.weixin.qq.com/?ticket=SYNTHETIC_OFFLINE_QR_ONLY';
    const matrix = render(payload); matrixShape(matrix); assert.equal(decode(matrix), payload);
  });
  await test('Chinese and emoji survive exact UTF-8 independent QR decoding', () => {
    const payload = 'https://ilinkai.weixin.qq.com/?ticket=合成离线测试-微信-📚';
    const matrix = render(payload); matrixShape(matrix); assert.equal(decode(matrix), payload);
  });
  await test('real shared encoder utility is restored synchronously after every render', () => {
    const before = qrcodeFactory.stringToBytes;
    render('SYNTHETIC_UTF8_中文'); assert.equal(qrcodeFactory.stringToBytes, before);
    render('SYNTHETIC_ASCII'); assert.equal(qrcodeFactory.stringToBytes, before);
  });
  await test('missing or malformed local encoder fails before any QR API could be called', async () => {
    for (const loader of [async () => { throw new Error('missing'); }, async () => ({}), async () => (() => {})]) {
      await assert.rejects(prepareLocalQrRenderer(loader), error => error.code === 'QR_UNAVAILABLE');
    }
    assert.equal(networkAttempts, 0);
  });
  await test('invalid and over-budget payloads fail before encoder work', async () => {
    const fake = fakeFactory(), local = await prepareLocalQrRenderer(async () => fake.factory);
    for (const payload of [null, undefined, 1, {}, '', 'a\n', 'a\u0000b', 'a\u007fb', 'a'.repeat(QR_MAX_PAYLOAD_BYTES + 1), '中'.repeat(683)]) fails(() => local(payload));
    assert.equal(fake.calls(), 0);
  });
  await test('unsupported matrix size and non-boolean pixels fail closed and restore the utility', async () => {
    for (const options of [{ size: 20 }, { size: 22 }, { size: 181 }, { size: NaN }, { dark: '1' }]) {
      const fake = fakeFactory(options), before = fake.factory.stringToBytes;
      const local = await prepareLocalQrRenderer(async () => ({ default: fake.factory }));
      fails(() => local('SYNTHETIC')); assert.equal(fake.factory.stringToBytes, before);
    }
  });
  await test('encoder exception is redacted and shared UTF-8 extension is restored', async () => {
    const fake = fakeFactory({ makeThrows: true }), before = fake.factory.stringToBytes;
    const local = await prepareLocalQrRenderer(async () => fake.factory);
    fails(() => local('SYNTHETIC')); assert.equal(fake.factory.stringToBytes, before);
  });
  await test('exact maximum payload remains a legal local matrix without network', () => {
    matrixShape(render('a'.repeat(QR_MAX_PAYLOAD_BYTES)));
    assert.equal(networkAttempts, 0);
  });
  console.log(JSON.stringify({ encoder: 'qrcode-generator@2.0.4', decoder: 'jsqr@1.4.0', independentAsciiAndUtf8Roundtrip: true, networkAttempts, hardwareOrLiveAccountVerified: false }));
} finally { globalThis.fetch = savedFetch; }
