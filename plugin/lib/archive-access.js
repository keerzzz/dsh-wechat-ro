import { homedir as desktopHome } from 'node:os';
import { resolve as desktopPath } from 'node:path';
// Independent, default-closed archive access. No constructor filesystem or data-worker I/O.
import { fork } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGINAL_SOURCE = desktopPath(desktopHome(), 'Documents/xwechat_files'); // Metadata only; never probe this path.
const WORKER = fileURLToPath(new URL('./archive-query-worker.js', import.meta.url));
export const ARCHIVE_ACCESS_LIMITS = Object.freeze({ maxRows: 200, maxBytes: 131072, queryTimeoutMs: 15000,
  maxOffset: 1000, maxTalkers: 128, maxEntries: 256, maxDirectories: 16, maxFiles: 32,
  maxDepth: 4, maxDbBytes: 134217728, maxTotalDbBytes: 805306368, maxReadRows: 5000, maxTables: 128 });
export const ARCHIVE_ACCESS_ERROR_CODES = Object.freeze(['invalid-options', 'invalid-request', 'invalid-session',
  'forbidden-root', 'not-granted', 'scope-forbidden', 'share-forbidden', 'busy', 'disposed', 'aborted', 'revoked',
  'timeout', 'unsupported-platform', 'unsupported-layout', 'unsupported-schema', 'unsupported-content',
  'unsupported-scope', 'snapshot-changed', 'path-rejected', 'file-budget-exceeded', 'row-budget-exceeded',
  'byte-budget-exceeded', 'worker-failed', 'history-persistence-failed']);
const CODES = new Set(ARCHIVE_ACCESS_ERROR_CODES);
export class ArchiveAccessError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'worker-failed';
    super('Archive access: ' + safe); this.name = 'ArchiveAccessError'; this.code = safe;
  }
}
const fail = code => { throw new ArchiveAccessError(code); };
const MAX_TS = 253402300799;
function validation(fn, code = 'invalid-request') {
  try { return fn(); } catch (error) { if (error instanceof ArchiveAccessError) throw error; fail(code); }
}
function record(value, allowed, required = [], code = 'invalid-request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !('value' in descriptors[key])) || required.some(key => !keys.includes(key))) fail(code);
  return value;
}
function integer(value, lo, hi, code = 'invalid-request') {
  if (!Number.isSafeInteger(value) || value < lo || value > hi) fail(code); return value;
}
function sessionId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) fail('invalid-session');
  return value;
}
function talker(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value || Buffer.byteLength(value) > 256 || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid-request');
  return value;
}
const time = value => integer(value, 0, MAX_TS);
function signalCheck(signal) {
  validation(() => {
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('invalid-request');
    if (signal?.aborted) fail('aborted');
  });
}
const overlaps = (a, b) => {
  const r = relative(a, b);
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
};
export function validateArchiveRoot(root, forbiddenRoots = []) {
  if (typeof root !== 'string' || !root || Buffer.byteLength(root) > 4096 || root.includes('\0') || root.includes('\\') || !isAbsolute(root) || resolve(root) !== root) fail('forbidden-root');
  for (const source of [ORIGINAL_SOURCE, ...forbiddenRoots]) if (overlaps(root, source) || overlaps(source, root)) fail('forbidden-root');
  return root;
}
function grantRequest(raw, sources) {
  record(raw, ['root', 'allConversations', 'talkers', 'fromTs', 'toTs', 'allowWechat', 'confirmation'],
    ['root', 'allConversations', 'talkers', 'fromTs', 'toTs', 'allowWechat', 'confirmation']);
  if (raw.confirmation !== 'read-decrypted-snapshot' || typeof raw.allConversations !== 'boolean' || typeof raw.allowWechat !== 'boolean') fail('invalid-request');
  const root = validateArchiveRoot(raw.root, sources);
  if (!Array.isArray(raw.talkers) || Object.getPrototypeOf(raw.talkers) !== Array.prototype || raw.talkers.length > ARCHIVE_ACCESS_LIMITS.maxTalkers) fail('invalid-request');
  const descriptors = Object.getOwnPropertyDescriptors(raw.talkers);
  if (Reflect.ownKeys(raw.talkers).some(k => typeof k !== 'string' || (k !== 'length' && (!/^\d+$/.test(k) || !('value' in descriptors[k]))))) fail('invalid-request');
  for (let i = 0; i < raw.talkers.length; i++) if (!descriptors[i] || !('value' in descriptors[i])) fail('invalid-request');
  const talkers = raw.talkers.map(talker);
  if (new Set(talkers).size !== talkers.length || (raw.allConversations ? talkers.length !== 0 : talkers.length === 0)) fail('invalid-request');
  const fromTs = raw.fromTs === null ? null : time(raw.fromTs), toTs = raw.toTs === null ? null : time(raw.toTs);
  if (fromTs !== null && toTs !== null && fromTs > toTs) fail('invalid-request');
  return { root, allConversations: raw.allConversations, talkers, fromTs, toTs, allowWechat: raw.allowWechat };
}
function archiveQuery(raw, scope, limits) {
  record(raw, ['action', 'talker', 'query', 'limit', 'offset', 'fromTs', 'toTs', 'sourceKind'], ['action']);
  if (!['status', 'contacts', 'sessions', 'messages', 'search', 'stats', 'digest', 'content', 'contentStats', 'media'].includes(raw.action)) fail('invalid-request');
  const q = { action: raw.action, limit: raw.limit === undefined ? Math.min(100, limits.maxRows) : Math.min(integer(raw.limit, 1, ARCHIVE_ACCESS_LIMITS.maxRows), limits.maxRows),
    offset: raw.offset === undefined ? 0 : integer(raw.offset, 0, limits.maxOffset), fromTs: scope.fromTs, toTs: scope.toTs };
  if (raw.talker !== undefined) {
    q.talker = talker(raw.talker); if (!scope.allConversations && !scope.talkers.includes(q.talker)) fail('scope-forbidden');
  }
  if (raw.sourceKind !== undefined) {
    if (!['messages', 'moments', 'favorites', 'miniprogram', 'voice', 'image', 'video'].includes(raw.sourceKind)
      || !['content', 'search', 'contentStats', 'media'].includes(q.action)) fail('invalid-request');
    q.sourceKind = raw.sourceKind;
  }
  if (raw.fromTs !== undefined) { q.fromTs = time(raw.fromTs); if (scope.fromTs !== null && q.fromTs < scope.fromTs) fail('scope-forbidden'); }
  if (raw.toTs !== undefined) { q.toTs = time(raw.toTs); if (scope.toTs !== null && q.toTs > scope.toTs) fail('scope-forbidden'); }
  if (q.fromTs !== null && q.toTs !== null && q.fromTs > q.toTs) fail('invalid-request');
  if (raw.query !== undefined) {
    if (typeof raw.query !== 'string' || !raw.query.trim() || Buffer.byteLength(raw.query) > 512 || raw.query.includes('\0')) fail('invalid-request'); q.query = raw.query;
  }
  if (q.action === 'messages' && q.talker === undefined) fail('invalid-request');
  if (q.action === 'search' && q.query === undefined) fail('invalid-request');
  if (['status', 'messages'].includes(q.action) && q.query !== undefined) fail('invalid-request');
  if (q.action === 'status' && Reflect.ownKeys(raw).some(k => k !== 'action')) fail('invalid-request');
  // Contact directory rows have no conversation-message timestamp. Never claim a temporal contact ACL.
  if (q.action === 'contacts' && (q.fromTs !== null || q.toTs !== null)) fail('unsupported-scope');
  if (['stats', 'digest'].includes(q.action) && (q.fromTs === null || q.toTs === null
    || q.toTs - q.fromTs >= (q.action === 'stats' ? 7 : 1) * 86400 || q.query !== undefined)) fail('invalid-request');
  return q;
}
function optionsFor(raw = {}) {
  record(raw, ['sourceRoot', 'maxRows', 'maxBytes', 'queryTimeoutMs', 'maxOffset', 'hasArchiveHistory', 'markArchiveHistory'], [], 'invalid-options');
  const limits = { ...ARCHIVE_ACCESS_LIMITS, maxRows: 100, maxBytes: 65536, queryTimeoutMs: 10000 };
  for (const key of ['maxRows', 'maxBytes', 'queryTimeoutMs', 'maxOffset']) if (raw[key] !== undefined)
    limits[key] = integer(raw[key], key === 'maxOffset' ? 0 : key === 'maxBytes' ? 512 : 1, ARCHIVE_ACCESS_LIMITS[key], 'invalid-options');
  const sources = [];
  if (raw.sourceRoot !== undefined && raw.sourceRoot !== '') {
    if (typeof raw.sourceRoot !== 'string' || !isAbsolute(raw.sourceRoot) || resolve(raw.sourceRoot) !== raw.sourceRoot || Buffer.byteLength(raw.sourceRoot) > 4096 || raw.sourceRoot.includes('\0')) fail('invalid-options');
    sources.push(raw.sourceRoot);
  }
  for (const key of ['hasArchiveHistory', 'markArchiveHistory']) if (raw[key] !== undefined && typeof raw[key] !== 'function') fail('invalid-options');
  if ((raw.hasArchiveHistory === undefined) !== (raw.markArchiveHistory === undefined)) fail('invalid-options');
  return { limits, sources, hasArchiveHistory: raw.hasArchiveHistory, markArchiveHistory: raw.markArchiveHistory };
}
export function createArchiveAccess(options = {}) {
  const config = validation(() => optionsFor(options), 'invalid-options');
  const entries = new Map(), operations = new Set(); let disposed = false;
  function entryFor(id) {
    sessionId(id); let e = entries.get(id);
    if (!e) {
      if (entries.size >= 256) fail('busy');
      e = { id, grant: null, sticky: false, historyKnown: false, lastError: null, generation: 0, pending: null }; entries.set(id, e);
    }
    try { const known = config.hasArchiveHistory?.(id); e.historyKnown = typeof known === 'boolean'; if (known === true) e.sticky = true; }
    catch { e.historyKnown = false; }
    return e;
  }
  const share = e => !disposed && e.historyKnown && (!e.sticky || Boolean(e.grant?.scope.allowWechat));
  function state(e) {
    const g = !disposed && e.grant?.scope;
    return { disposed, granted: Boolean(g), allowWechat: Boolean(g?.allowWechat), allConversations: Boolean(g?.allConversations), talkers: g ? [...g.talkers] : [],
      fromTs: g?.fromTs ?? null, toTs: g?.toTs ?? null, sessionMayContainArchiveData: e.sticky, historyKnown: e.historyKnown,
      shareable: share(e), activeQueries: e.pending?.kind === 'query' ? 1 : 0, lastError: e.lastError, format: 'fixed-sql-plaintext', formatVerified: false };
  }
  const check = op => { if (disposed) fail('disposed'); if (op.controller.signal.aborted) fail(op.cancelCode || 'aborted'); };
  function cancel(op, code) { if (op && !op.controller.signal.aborted) { op.cancelCode = code; op.controller.abort(); } }
  function begin(e, kind, outerSignal, work, previous = null) {
    if (disposed) fail('disposed'); signalCheck(outerSignal);
    const op = { kind, controller: new AbortController(), cancelCode: null, promise: null };
    const abort = () => cancel(op, 'aborted'); outerSignal?.addEventListener('abort', abort, { once: true });
    e.pending = op; operations.add(op);
    op.promise = Promise.resolve().then(async () => { if (previous) await previous.promise.catch(() => {}); check(op); return work(op); })
      .catch(error => {
        const safe = error instanceof ArchiveAccessError ? error : new ArchiveAccessError('worker-failed');
        if (e.pending === op) e.lastError = safe.code; throw safe;
      })
      .finally(() => { outerSignal?.removeEventListener('abort', abort); if (e.pending === op) e.pending = null; operations.delete(op); });
    return op.promise;
  }
  function worker(payload, op) {
    check(op); if (operations.size > 4) fail('busy');
    return new Promise((done, reject) => {
      let child, value, failure = null, closed = false;
      const stop = code => { failure ||= code; if (child && !closed) child.kill('SIGKILL'); };
      try {
        child = fork(WORKER, [], { execPath: process.execPath, execArgv: ['--max-old-space-size=64', '--disable-proto=throw', '--no-warnings'],
          env: { LANG: 'C', TZ: 'UTC' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json', windowsHide: true });
      } catch { reject(new ArchiveAccessError('worker-failed')); return; }
      const abort = () => stop(op.cancelCode || 'aborted'); op.controller.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop('timeout'), config.limits.queryTimeoutMs);
      child.on('message', message => {
        if (message?.kind === 'query-ready') return;
        if (value !== undefined || failure) { stop('worker-failed'); return; }
        if (!message || typeof message !== 'object' || typeof message.ok !== 'boolean') { stop('worker-failed'); return; }
        if (!message.ok) { stop(CODES.has(message.code) ? message.code : 'worker-failed'); return; }
        try {
          if (Buffer.byteLength(JSON.stringify(message.value)) > (payload.kind === 'query' ? config.limits.maxBytes : 65536)) { stop('byte-budget-exceeded'); return; }
        } catch { stop('worker-failed'); return; }
        value = message.value;
      });
      child.once('error', () => stop('worker-failed'));
      child.once('close', code => {
        closed = true; clearTimeout(timer); op.controller.signal.removeEventListener('abort', abort);
        if (failure || code !== 0 || value === undefined) reject(new ArchiveAccessError(failure || 'worker-failed')); else done(value);
      });
      if (op.controller.signal.aborted) abort(); else child.send(payload, error => { if (error) stop('worker-failed'); });
    });
  }
  function revoke(id) {
    const e = entryFor(id); e.grant = null; e.generation++; cancel(e.pending, 'revoked'); e.lastError = 'revoked'; return state(e);
  }
  async function grant(id, raw, signal) {
    signalCheck(signal); const scope = validation(() => grantRequest(raw, config.sources)); const e = entryFor(id);
    if (disposed) fail('disposed'); if (e.pending?.kind === 'grant') fail('busy'); const previous = e.pending;
    e.grant = null; const generation = ++e.generation; cancel(previous, 'revoked');
    return begin(e, 'grant', signal, async op => {
      const metadata = await worker({ kind: 'inspect', root: scope.root, forbiddenRoots: config.sources, limits: config.limits }, op);
      check(op); if (e.generation !== generation) fail('revoked');
      if (!metadata || metadata.version !== 1 || !/^[0-9a-f]{64}$/.test(metadata.fingerprint)) fail('worker-failed');
      e.grant = { scope, metadata }; e.lastError = null; return state(e);
    }, previous);
  }
  async function refresh(id, root, signal) {
    signalCheck(signal); const e = entryFor(id), current = e.grant;
    if (!current) fail('not-granted'); if (e.pending) fail('busy');
    const scope = validation(() => grantRequest({ ...current.scope, root, confirmation: 'read-decrypted-snapshot' }, config.sources));
    return begin(e, 'grant', signal, async op => {
      const metadata = await worker({ kind: 'inspect', root: scope.root, forbiddenRoots: config.sources, limits: config.limits }, op);
      check(op); if (e.grant !== current) fail('revoked');
      if (!metadata || metadata.version !== 1 || !/^[0-9a-f]{64}$/.test(metadata.fingerprint)) fail('worker-failed');
      e.grant = { scope, metadata }; e.generation++; e.lastError = null; return state(e);
    });
  }
  async function query(id, raw, signal, destination = 'local') {
    signalCheck(signal); const e = entryFor(id); if (disposed) fail('disposed'); if (!e.grant) fail('not-granted'); if (e.pending) fail('busy');
    if (destination !== 'local' && destination !== 'wechat') fail('invalid-request');
    const g = e.grant, q = validation(() => archiveQuery(raw, g.scope, config.limits));
    if (destination === 'wechat' && (!g.scope.allowWechat || !share(e))) fail('share-forbidden');
    if (!config.markArchiveHistory) fail('history-persistence-failed'); const generation = e.generation;
    return begin(e, 'query', signal, async op => {
      e.sticky = true; // Conservative even for canceled/failed requests; never clear on revoke.
      try {
        const value = await worker({ kind: 'query', root: g.scope.root, forbiddenRoots: config.sources, expected: g.metadata,
          scope: { allConversations: g.scope.allConversations, talkers: g.scope.talkers, fromTs: g.scope.fromTs, toTs: g.scope.toTs }, query: q, limits: config.limits }, op);
        check(op); if (e.generation !== generation || e.grant !== g) fail('revoked');
        if (!value || !Array.isArray(value.rows) || value.rows.length > q.limit || value.action !== q.action || value.untrusted !== true) fail('worker-failed');
        if (config.markArchiveHistory) {
          try { await config.markArchiveHistory(id); } catch { fail('history-persistence-failed'); }
        }
        check(op); if (e.generation !== generation || e.grant !== g) fail('revoked'); e.lastError = null; return value;
      } catch (error) {
        if (['snapshot-changed', 'path-rejected', 'unsupported-layout', 'file-budget-exceeded'].includes(error?.code) && e.grant === g) { e.grant = null; e.generation++; }
        throw error;
      }
    });
  }
  async function browseRoster(root, raw, signal) {
    signalCheck(signal);
    const { scope, query } = validation(() => {
      record(raw, ['confirmation', 'query', 'limit', 'offset'], ['confirmation']);
      if (raw.confirmation !== 'browse-snapshot-roster') fail('invalid-request');
      const scope = grantRequest({ root, allConversations: true, talkers: [], fromTs: null, toTs: null, allowWechat: false, confirmation: 'read-decrypted-snapshot' }, config.sources);
      const limit = integer(raw.limit ?? Math.min(50, config.limits.maxRows), 1, Math.min(100, config.limits.maxRows));
      return { scope, query: archiveQuery({ action: 'contacts', limit, offset: raw.offset ?? 0, ...(raw.query !== undefined ? { query: raw.query } : {}) }, scope, config.limits) };
    });
    const e = { pending: null, lastError: null };
    return begin(e, 'roster', signal, async op => {
      const metadata = await worker({ kind: 'inspect', root: scope.root, forbiddenRoots: config.sources, limits: config.limits }, op);
      check(op);
      if (!metadata || metadata.version !== 1 || !/^[0-9a-f]{64}$/.test(metadata.fingerprint)) fail('worker-failed');
      const value = await worker({ kind: 'query', root: scope.root, forbiddenRoots: config.sources, expected: metadata,
        scope: { allConversations: true, talkers: [], fromTs: null, toTs: null }, query, limits: config.limits }, op);
      check(op);
      if (!value || value.action !== 'contacts' || !Array.isArray(value.rows) || value.rows.length > query.limit || value.untrusted !== true) fail('worker-failed');
      const result = { ...value, metadataOnly: true };
      for (let i = 0; i < 4; i++) result.bytes = Buffer.byteLength(JSON.stringify(result));
      if (result.bytes > config.limits.maxBytes) fail('byte-budget-exceeded');
      return result;
    });
  }
  let disposal;
  function dispose() {
    if (disposal) return disposal; disposed = true; for (const e of entries.values()) { e.grant = null; e.generation++; }
    for (const op of operations) cancel(op, 'disposed');
    disposal = Promise.allSettled([...operations].map(op => op.promise)).then(() => {}); return disposal;
  }
  return Object.freeze({ grant, refresh, revoke, getState: id => state(entryFor(id)), query, browseRoster, canShare: id => share(entryFor(id)), dispose });
}
