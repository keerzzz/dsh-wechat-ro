import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { extname } from 'node:path';
import { WeixinApiError, WEIXIN_CDN_ORIGIN, createWeixinRequest, credentials, identifier, token, string, field, record, fail, baseInfo } from './weixin-http.js';

export const WEIXIN_MEDIA_LIMITS = Object.freeze({ maxBytes: 10485760, maxFiles: 4, maxReplyBytes: 16384, maxParts: 9 });
const invalid = () => { throw new WeixinApiError('invalid-input'); };
export function describeWeixinMedia(fileName, data) {
  if (typeof fileName !== 'string' || !fileName.isWellFormed() || !fileName || Buffer.byteLength(fileName) > 255
    || /[\x00-\x1f\x7f/\\:*?"<>|]/u.test(fileName) || Array.from(fileName, char => char.codePointAt(0)).some(code => code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069) || /[. ]$/u.test(fileName)
    || !(data instanceof Uint8Array) || !(data.buffer instanceof ArrayBuffer) || data.byteLength > WEIXIN_MEDIA_LIMITS.maxBytes) invalid();
  const bytes = Buffer.from(data), extension = extname(fileName).toLowerCase();
  const starts = value => bytes.subarray(0, value.length).equals(value);
  let kind = 'file';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) {
    const valid = extension === '.png' ? bytes.length >= 24 && starts(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR'
      : ['.jpg', '.jpeg'].includes(extension) ? bytes.length >= 4 && starts(Buffer.from('ffd8ff', 'hex'))
      : extension === '.gif' ? bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
      : bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) invalid();
    kind = 'image';
  } else if (['.txt', '.md', '.csv', '.json', '.log'].includes(extension)) {
    try { if (new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0')) invalid(); } catch { invalid(); }
  } else if (extension === '.pdf') {
    if (!starts(Buffer.from('%PDF-'))) invalid();
  } else if (['.docx', '.xlsx', '.pptx'].includes(extension)) {
    if (!starts(Buffer.from('504b0304', 'hex'))) invalid();
  } else invalid();
  return Object.freeze({ fileName, kind, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
}
function uploadUrl(value, filekey) {
  let full;
  if (Object.hasOwn(value, 'upload_full_url')) {
    full = string(value.upload_full_url, 8192, 'invalid-response', true);
    if (full && /[\x00-\x20\x7f]/u.test(full)) fail('unsupported-origin');
  }
  if (full) {
    let url;
    try { url = new URL(full); } catch { fail('unsupported-origin'); }
    if (url.origin !== WEIXIN_CDN_ORIGIN || url.pathname !== '/c2c/upload' || url.username || url.password || url.hash) fail('unsupported-origin');
    return url.href;
  }
  const param = token(value.upload_param, 'invalid-response');
  return `${WEIXIN_CDN_ORIGIN}/c2c/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}`;
}

// The protocol requires AES-128-ECB and base64 of the hexadecimal key's text, not raw key bytes.
export function createWeixinMediaApi(options) {
  const request = createWeixinRequest(options);
  return Object.freeze({
    async sendMedia(auth, message, signal, guards) {
      let uploaded = false, uploading = false, data, ciphertext, aeskey;
      try {
        if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
        if (signal?.aborted) throw new WeixinApiError('aborted');
        record(message, 'invalid-input');
        if (Reflect.ownKeys(message).length !== 7) invalid();
        const checked = credentials(auth, 'invalid-input');
        const toUserId = identifier(field(message, 'toUserId', 'invalid-input'), 'invalid-input');
        if (toUserId !== checked.userId) invalid();
        const clientId = identifier(field(message, 'clientId', 'invalid-input'), 'invalid-input');
        const contextToken = token(field(message, 'contextToken', 'invalid-input'), 'invalid-input');
        const input = field(message, 'data', 'invalid-input');
        const description = describeWeixinMedia(field(message, 'fileName', 'invalid-input'), input);
        if (field(message, 'kind', 'invalid-input') !== description.kind || field(message, 'sha256', 'invalid-input') !== description.sha256) invalid();
        if (!guards || typeof guards.verify !== 'function' || typeof guards.authorize !== 'function') invalid();
        data = Buffer.from(input);
        const authorize = () => {
          const result = guards.authorize();
          if (result !== true) { try { Promise.prototype.then.call(result, undefined, () => {}) } catch {} return false; }
          return !signal?.aborted;
        };
        const verify = async () => {
          if (!authorize()) throw new WeixinApiError('aborted');
          await guards.verify();
          if (!authorize()) throw new WeixinApiError('aborted');
        };
        await verify();
        aeskey = randomBytes(16);
        const filekey = randomBytes(16).toString('hex'), cipher = createCipheriv('aes-128-ecb', aeskey, null);
        ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
        const full = await request(() => ({ method: 'POST', path: '/ilink/bot/getuploadurl', botToken: checked.botToken,
          body: { filekey, media_type: description.kind === 'image' ? 1 : 3, to_user_id: toUserId, rawsize: data.length,
            rawfilemd5: createHash('md5').update(data).digest('hex'), filesize: ciphertext.length, no_need_thumb: true,
            aeskey: aeskey.toString('hex'), base_info: baseInfo() } }), value => uploadUrl(value, filekey), false, false, signal, authorize);
        await verify();
        const downloadParam = await request(() => ({ method: 'POST', cdn: full, body: ciphertext }), headers => token(headers.get('x-encrypted-param'), 'invalid-response'),
          false, true, signal, () => { if (!authorize()) return false; uploading = true; return true; });
        uploaded = true;
        await verify();
        const media = { encrypt_query_param: downloadParam, aes_key: Buffer.from(aeskey.toString('hex'), 'ascii').toString('base64'), encrypt_type: 1 };
        const item = description.kind === 'image' ? { type: 2, image_item: { media, mid_size: ciphertext.length } }
          : { type: 4, file_item: { media, file_name: description.fileName, len: String(data.length) } };
        return await request(() => ({ method: 'POST', path: '/ilink/bot/sendmessage', botToken: checked.botToken,
          body: { msg: { from_user_id: '', to_user_id: toUserId, client_id: clientId, message_type: 2, message_state: 2,
            context_token: contextToken, item_list: [item] }, base_info: baseInfo() } }), () => Object.freeze({ accepted: true }), false, true, signal, authorize);
      } catch (error) {
        throw new WeixinApiError(error instanceof WeixinApiError ? error.code : signal instanceof AbortSignal && signal.aborted ? 'aborted' : 'invalid-input', {
          ...(error instanceof WeixinApiError ? { httpStatus: error.httpStatus, businessCode: error.businessCode } : {}),
          deliveryUnknown: uploaded || uploading || (error instanceof WeixinApiError && error.deliveryUnknown),
        });
      } finally { data?.fill(0); aeskey?.fill(0); ciphertext?.fill(0); }
    },
  });
}
