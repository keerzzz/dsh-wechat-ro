// Analyze only bytes supplied by the task's existing file permission boundary.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, access, readFile, mkdir, rename, lstat, open, readdir } from 'node:fs/promises';
import { constants as F } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, extname, dirname, isAbsolute, resolve, parse, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { decodeDat, deriveDatKey } from './image-decode.js';
export const CONTENT_ANALYSIS_LIMITS = Object.freeze({ maxBytes: 67108864, timeoutMs: 300000, maxOutputBytes: 131072 });
const home = join(homedir(), '.local/share/dsh-wechat-ro');
const script = fileURLToPath(new URL('../runtime/analyze_content.py', import.meta.url));
const formats = new Set(['.dat', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.silk', '.wav', '.mp3', '.m4a', '.ogg', '.aac', '.flac', '.mp4', '.mov', '.mkv', '.webm', '.pdf', '.docx', '.pptx', '.xlsx', '.txt', '.md', '.csv', '.json', '.log']);
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export function mediaCandidates(base, record) {
  if (!['image', 'video'].includes(record.sourceKind) || !/^[a-f0-9]{32}$/.test(record.mediaHash) || !Number.isSafeInteger(record.ts)) throw new Error('INVALID_MEDIA_RECORD');
  const month = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date(record.ts * 1000));
  const conversation = createHash('md5').update(record.talker).digest('hex'), hash = record.mediaHash;
  return record.sourceKind === 'image'
    ? ['_h', '_hd', '', '_t'].map(suffix => ({ path: join(base, 'attach', conversation, month, 'Img', hash + suffix + '.dat'), quality: suffix === '_t' ? 'thumbnail' : 'original' }))
    : [join(base, 'video', month, hash + '.mp4'), join(base, 'attach', conversation, month, 'Video', hash + '.mp4')].map(path => ({ path, quality: 'original' }));
}
export async function readLocalMedia(root, record, signal) {
  const registry = join(homedir(), '.wechat-ro-local-history/source.json');
  const [manifest, source] = await Promise.all([readFile(join(root, '.wechat-ro-manifest.json'), 'utf8').then(JSON.parse), readFile(registry, 'utf8').then(JSON.parse)]);
  if (!/^[a-f0-9]{12}$/.test(manifest.account_ref) || manifest.account_ref !== source.account_ref || !isAbsolute(source.source) || resolve(source.source) !== source.source) throw new Error('MEDIA_ACCOUNT_MISMATCH');
  const candidates = mediaCandidates(join(dirname(source.source), 'msg'), record);
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    let current = parse(candidate.path).root, info;
    try {
      for (const part of relative(current, candidate.path).split(sep)) {
        current = join(current, part); info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error('MEDIA_PATH_REJECTED');
      }
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.size > CONTENT_ANALYSIS_LIMITS.maxBytes) throw new Error('MEDIA_FILE_OR_SIZE');
    const handle = await open(candidate.path, F.O_RDONLY | F.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size) throw new Error('MEDIA_CHANGED');
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        signal?.throwIfAborted();
        const value = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!value.bytesRead) throw new Error('MEDIA_CHANGED');
        offset += value.bytesRead;
      }
      const after = await handle.stat(), sourceAfter = JSON.parse(await readFile(registry, 'utf8'));
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || sourceAfter.source !== source.source || sourceAfter.account_ref !== source.account_ref) throw new Error('MEDIA_CHANGED');
      const identity = await handle.stat({ bigint: true });
      return { bytes, name: record.mediaHash + extname(candidate.path), quality: candidate.quality,
        sourceFile: relative(join(dirname(source.source), 'msg'), candidate.path),
        sourceIdentity: [identity.dev, identity.ino, identity.size, identity.mtimeNs].join(':') };
    } finally { await handle.close(); }
  }
  throw new Error('LOCAL_MEDIA_NOT_DOWNLOADED');
}
export async function decodeLocalDat(bytes) {
  if (Buffer.from(bytes).subarray(0, 6).toString('hex') !== '070856320807') return decodeDat(bytes);
  const source = JSON.parse(await readFile(join(homedir(), '.wechat-ro-local-history/source.json'), 'utf8'));
  if (!/^[a-f0-9]{12}$/.test(source.account_ref) || !isAbsolute(source.source) || resolve(source.source) !== source.source) throw new Error('LOCAL_MEDIA_KEY_REQUIRED');
  const keyFile = join(home, 'media-keys.json');
  let prior;
  try { prior = JSON.parse(await readFile(keyFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (prior?.account_ref === source.account_ref && /^[a-f0-9]{32}$/.test(prior.aes_key)) {
    try { return decodeDat(bytes, Buffer.from(prior.aes_key, 'hex'), prior.xor_key); } catch { /* A rotated key is verified again from the current local cache. */ }
  }
  const account = dirname(source.source).split(sep).at(-1);
  const names = [...new Set([account, account.replace(/_[0-9a-f]{4}$/iu, '')])];
  const roots = [join(homedir(), '.xwechat/net/kvcomm'), join(dirname(dirname(source.source)), '.xwechat/net/kvcomm'), join(dirname(dirname(source.source)), 'app_data/net/kvcomm')];
  const matches = new Map();
  for (const root of roots) {
    const files = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const file of files) {
      const value = /^key_(\d+)_.*\.statistic$/u.exec(file); if (!value) continue;
      const code = Number(value[1]); if (!Number.isSafeInteger(code) || code < 1 || code > 0xffffffff) continue;
      for (const name of names) {
        const { key, xor } = deriveDatKey(code, name);
        try { matches.set(key.toString('hex'), { decoded: decodeDat(bytes, key, xor), xor }); } catch { /* Candidate did not decrypt this selected image. */ }
      }
    }
  }
  if (matches.size !== 1) throw new Error('LOCAL_MEDIA_KEY_REQUIRED');
  const [key, value] = [...matches][0];
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = keyFile + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify({ aes_key: key, xor_key: value.xor, account_ref: source.account_ref, source: 'local-kvcomm-derived' }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, keyFile);
  return value.decoded;
}
export async function modelImages(name, bytes, result, attachments) {
  const inputs = [];
  if (imageTypes[extname(name).toLowerCase()]) inputs.push({ data: bytes, mediaType: imageTypes[extname(name).toLowerCase()], name: name.split('/').at(-1) });
  for (const frame of result.imageFiles || []) {
    if (!/^[a-f0-9]{64}-(?:frame-[0-9]{2}\.png|image\.(?:png|jpg|gif|webp))$/.test(frame.name) || !frame.name.startsWith(result.sha256)) throw new Error('INVALID_ANALYSIS_FRAME');
    const data = await readFile(join(home, 'content-cache/assets', frame.name));
    inputs.push({ data, mediaType: imageTypes[extname(frame.name)], name: frame.seconds !== undefined ? 'video-' + frame.seconds + 's.png' : frame.frame !== undefined ? 'wxgf-frame-' + (frame.frame + 1) + '.png' : 'selected-image' + extname(frame.name) });
  }
  if (!inputs.length) return [];
  if (typeof attachments?.saveImages !== 'function') throw new Error('MODEL_IMAGE_SERVICE_REQUIRED');
  return attachments.saveImages(inputs);
}
export async function analyzeContent(name, bytes, signal) {
  signal?.throwIfAborted();
  let suffix = extname(name).toLowerCase();
  if (!formats.has(suffix) || !(bytes instanceof Uint8Array) || bytes.byteLength > CONTENT_ANALYSIS_LIMITS.maxBytes) throw new Error('ANALYSIS_FORMAT_OR_SIZE');
  const dat = suffix === '.dat';
  if (dat) {
    const decoded = await decodeLocalDat(bytes); bytes = decoded.data; suffix = '.' + decoded.format;
  }
  const python = process.env.WECHAT_CONTENT_PYTHON || join(home, 'content-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await access(python).catch(() => { throw new Error('LOCAL_CONTENT_RUNTIME_REQUIRED'); });
  const temporary = await mkdtemp(join(home, 'analysis-input-'));
  try {
    const input = join(temporary, 'input' + suffix);
    await writeFile(input, bytes, { mode: 0o600, flag: 'wx' });
    signal?.throwIfAborted();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(python, [script, '--input', input, '--cache', join(home, 'content-cache'), '--model', join(home, 'models/whisper-small')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', OMP_NUM_THREADS: '2' } });
      const chunks = []; let size = 0;
      const kill = () => child.kill('SIGKILL');
      const timer = setTimeout(kill, CONTENT_ANALYSIS_LIMITS.timeoutMs);
      signal?.addEventListener('abort', kill, { once: true });
      if (signal?.aborted) kill();
      child.stdout.on('data', chunk => { size += chunk.length; if (size > CONTENT_ANALYSIS_LIMITS.maxOutputBytes) kill(); else chunks.push(chunk); });
      child.stderr.on('data', () => {});
      child.once('error', reject);
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', kill);
        if (signal?.aborted) { reject(new Error('CANCELLED')); return; }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (code !== 0 || !value.ok || typeof value.result?.text !== 'string') throw new Error(value.error || 'LOCAL_ANALYSIS_FAILED');
          resolve(value.result);
        } catch (error) { reject(error); }
      });
    });
    if (dat && suffix !== '.wxgf') {
      const assets = join(home, 'content-cache/assets'); await mkdir(assets, { recursive: true, mode: 0o700 });
      const image = result.sha256 + '-image' + suffix;
      await writeFile(join(assets, image), bytes, { mode: 0o600 });
      result.imageFiles = [{ name: image }];
      result.decodedFormat = suffix.slice(1);
    }
    return result;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
export async function cacheHistoryAnalysis(root, request, result, media) {
  const manifest = JSON.parse(await readFile(join(root, '.wechat-ro-manifest.json'), 'utf8'));
  if (!/^[a-f0-9]{12}$/.test(manifest.account_ref)) return;
  const ident = request.talker + '/' + request.localId + '/' + request.ts;
  const recordRef = media ? request.citation.recordRef : createHash('sha256').update('message/media_0.db/VoiceInfo/' + ident + '/voice').digest('hex').slice(0, 32);
  const directory = join(home, 'content-history', manifest.account_ref);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const temporary = join(directory, recordRef + '.' + randomUUID() + '.tmp');
  const row = { recordRef, talker: request.talker, localId: request.localId, ts: request.ts, text: result.text,
    sha256: result.sha256, engine: result.engine, segments: result.segments, generatedAt: Date.now(), version: result.version,
    ...(media ? { sourceKind: request.sourceKind, mediaHash: request.mediaHash, quality: media.quality,
      sourceFile: media.sourceFile, sourceIdentity: media.sourceIdentity, sourceSha256: createHash('sha256').update(media.bytes).digest('hex') } : {}) };
  await writeFile(temporary, JSON.stringify(row), { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(directory, recordRef + '.json'));
  return { snapshotRef: manifest.snapshot_id, recordRef };
}
