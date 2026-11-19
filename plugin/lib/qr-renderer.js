// Local QR matrix projection. Never fetches an image or returns HTML/URLs.
import { Buffer } from 'node:buffer';

export const QR_MAX_PAYLOAD_BYTES = 2048;
export class QrRenderError extends Error {
  constructor() { super('WeChat conversation: QR_UNAVAILABLE'); this.name = 'QrRenderError'; this.code = 'QR_UNAVAILABLE'; }
}
const unavailable = () => { throw new QrRenderError(); };

/** Load before beginLogin; loadFactory is a trusted test dependency, never RPC input. */
export async function prepareLocalQrRenderer(loadFactory) {
  let factory;
  try {
    const module = await (loadFactory ? loadFactory() : import('qrcode-generator'));
    factory = typeof module === 'function' ? module : module?.default;
    if (typeof factory !== 'function' || typeof factory.stringToBytes !== 'function') unavailable();
  } catch { unavailable(); }
  return function renderLocalQr(payload) {
    if (typeof payload !== 'string' || payload.length === 0 || Buffer.byteLength(payload, 'utf8') > QR_MAX_PAYLOAD_BYTES
      || /[\u0000-\u001f\u007f]/u.test(payload)) unavailable();
    // Public QRCodeFactory encoding extension. The entire make is synchronous;
    // restore the shared utility immediately, including when generation fails.
    const previous = factory.stringToBytes;
    try {
      factory.stringToBytes = text => [...Buffer.from(text, 'utf8')];
      const qr = factory(0, 'M');
      qr.addData(payload, 'Byte');
      qr.make();
      const size = qr.getModuleCount();
      if (!Number.isInteger(size) || size < 21 || size > 177 || (size - 21) % 4 !== 0) unavailable();
      const rows = [];
      for (let row = 0; row < size; row++) {
        let bits = '';
        for (let column = 0; column < size; column++) {
          const value = qr.isDark(row, column);
          if (typeof value !== 'boolean') unavailable();
          bits += value ? '1' : '0';
        }
        rows.push(bits);
      }
      return Object.freeze({ payloadKind: 'ilink-login', rows: Object.freeze(rows) });
    } catch { unavailable(); }
    finally { factory.stringToBytes = previous; }
  };
}
