// WeChat local DAT containers: validated lengths, AES/PKCS7 head and XOR tail.
import { createDecipheriv, createHash } from 'node:crypto';
export function deriveDatKey(code, account) {
  if (!Number.isSafeInteger(code) || code < 1 || code > 0xffffffff || typeof account !== 'string' || !account) throw new Error('DAT_KEY_INPUT');
  return { key: Buffer.from(createHash('md5').update(String(code) + account).digest('hex').slice(0, 16), 'ascii'), xor: code & 255 };
}
export function imageFormat(data) {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'jpg';
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) return 'gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (data.subarray(0, 4).toString() === 'wxgf') return 'wxgf';
  return null;
}
export function decodeDat(input, mediaKey, xorKey) {
  const data = Buffer.from(input);
  if (data.length < 16 || data.length > 67108864) throw new Error('DAT_SIZE');
  const signature = data.subarray(0, 6).toString('hex');
  if (!['070856310807', '070856320807'].includes(signature)) {
    if (imageFormat(data)) return { data, format: imageFormat(data), version: 'plain' };
    for (const first of [0x89, 0xff, 0x47, 0x52]) {
      const plain = Buffer.from(data.map(byte => byte ^ (data[0] ^ first)));
      if (imageFormat(plain)) return { data: plain, format: imageFormat(plain), version: 'xor' };
    }
    throw new Error('DAT_FORMAT');
  }
  const aesBytes = data.readUInt32LE(6), xorBytes = data.readUInt32LE(10);
  const encryptedBytes = aesBytes ? aesBytes + 16 - aesBytes % 16 : 0;
  if (!encryptedBytes || 15 + encryptedBytes + xorBytes > data.length) throw new Error('DAT_LENGTHS');
  const key = signature === '070856310807' ? Buffer.from('cfcd208495d565ef') : mediaKey;
  if (!Buffer.isBuffer(key) || key.length !== 16) throw new Error('LOCAL_MEDIA_KEY_REQUIRED');
  const cipher = createDecipheriv('aes-128-ecb', key, null);
  const head = Buffer.concat([cipher.update(data.subarray(15, 15 + encryptedBytes)), cipher.final()]);
  if (head.length !== aesBytes) throw new Error('DAT_PADDING');
  const format = imageFormat(head);
  if (!format) throw new Error('DAT_FORMAT');
  const middle = data.subarray(15 + encryptedBytes, data.length - xorBytes);
  const tail = data.subarray(data.length - xorBytes);
  const endings = { jpg: Buffer.from('ffd9', 'hex'), png: Buffer.from('0000000049454e44ae426082', 'hex'), gif: Buffer.from([0x3b]) };
  if (xorBytes && !endings[format] && (!Number.isInteger(xorKey) || xorKey < 0 || xorKey > 255)) throw new Error('DAT_XOR_KEY_UNAVAILABLE');
  const ending = endings[format], xor = xorBytes ? xorKey ?? tail.at(-1) ^ ending.at(-1) : 0;
  const decodedTail = Buffer.from(tail.map(byte => byte ^ xor));
  if (xorKey === undefined && xorBytes && ending && xorBytes >= ending.length && !decodedTail.subarray(-ending.length).equals(ending)) throw new Error('DAT_TAIL');
  return { data: Buffer.concat([head, middle, decodedTail]), format, version: signature === '070856310807' ? 'v1' : 'v2' };
}
