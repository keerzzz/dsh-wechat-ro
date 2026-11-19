import { createHash, randomUUID } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
import { createArchiveAccess, ArchiveAccessError, validateArchiveRoot } from './archive-access.js';
import { describeWeixinMedia, WEIXIN_MEDIA_LIMITS } from './weixin-media.js';
import { createTaskHistoryAuthority } from './task-history.js';
export { TASK_HISTORY_AUDIT_SPEC, TASK_FIRST_TEXT_AUDIT_SPEC } from './task-history.js';

export const TASK_PRESET_ID = 'dsh-wechat-task-v1';
export const isTaskSessionId = value => typeof value === 'string' && /^wechat-task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export const TASK_ACCESS_LIMITS = Object.freeze({ maxTasks: 128, maxSources: 32, maxBytes: 65536, maxRows: 100, maxEvents: 20000, maxReferences: 128, timeoutMs: 15000 });
const MESSAGES = Object.freeze({
  'invalid-options': 'Task access is not configured.', 'invalid-request': 'The task data request is invalid.',
  'not-prepared': 'The exact task context is not prepared.', 'not-granted': 'This source was not authorized.',
  'forbidden-root': 'This directory cannot be a task data source.', 'path-rejected': 'The file is outside the permitted path boundary.',
  'unsupported-filesystem': 'A verified local filesystem mapping is required.', 'not-directory': 'An existing ordinary directory is required.',
  'not-file': 'An ordinary single-link file is required.', 'file-changed': 'The referenced file changed.',
  'byte-budget-exceeded': 'The task data byte budget was exceeded.', 'event-budget-exceeded': 'The source conversation exceeds the event budget.',
  'history-unavailable': 'Task context history cannot be proved or persisted.', 'share-forbidden': 'The whole task context is not authorized for WeChat.',
  'source-failed': 'The authorized source could not be read.', 'write-failed': 'The authorized file could not be written.',
  'query-budget-exceeded': 'The archive query exceeded its read budget. Choose a contact or a smaller date range.',
  'revoked': 'Task source permission changed.', 'aborted': 'Task data access was cancelled.', 'disposed': 'Task data access is closed.',
  'busy': 'Task data access is busy.', 'not-produced': 'This file was not produced by the current task turn.',
});
export class TaskAccessError extends Error {
  constructor(code) { const safe = Object.hasOwn(MESSAGES, code) ? code : 'source-failed'; super(MESSAGES[safe]); this.name = 'TaskAccessError'; this.code = safe; Object.freeze(this); }
}
const fail = code => { throw new TaskAccessError(code); };
const safeError = (error, fallback) => error instanceof TaskAccessError ? error : new TaskAccessError(fallback);
const sourceRecord = z.object({ sourceId: z.string().min(1).max(80), kind: z.enum(['directory', 'session', 'archive']), generation: z.string().uuid() }).strict();
const workspaceRecord = z.object({ id: z.string().min(1).max(256), root: z.string().min(1).max(4096), title: z.string().min(1).max(160) }).strict();
export const TASK_CONTEXT_SPEC = Object.freeze({ name: 'wechat_task_contexts_v1', version: 1, layout: 'per-record', tables: {
  tasks: { valueSchema: z.object({ createdAt: z.number().int().nonnegative(), workspace: workspaceRecord.nullable(), mayContainData: z.boolean(), consumed: z.array(sourceRecord).max(1024) }).strict() },
} });
const titleSchema = z.string().trim().min(1).max(160).refine(value => !/[\0\r\n]/u.test(value));
const directorySchema = z.object({ root: z.string(), title: titleSchema, allowWechat: z.boolean(), confirmation: z.literal('read-task-directory'), sourceId: z.string().uuid().optional() }).strict();
const workspaceSchema = z.object({ root: z.string(), title: titleSchema, allowWechat: z.boolean(), confirmation: z.literal('read-and-write-task-workspace') }).strict();
const sessionSchema = z.object({ sessionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/u), title: titleSchema, allowWechat: z.boolean(), confirmation: z.literal('read-task-session') }).strict();
const filePathSchema = z.string().min(1).max(2048).refine(value => !/[\0\r\n\\:]/u.test(value) && !isAbsolute(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part)));
const sourceIdSchema = z.union([z.literal('workspace'), z.literal('archive'), z.string().uuid(), z.string().regex(/^session-[0-9a-f]{24}$/u)]);
const contentSchema = z.string().refine(value => !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= TASK_ACCESS_LIMITS.maxBytes);
const fileRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), sourceId: sourceIdSchema.default('workspace'), path: filePathSchema.optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  z.object({ action: z.literal('read'), sourceId: sourceIdSchema.default('workspace'), path: filePathSchema }).strict(),
  z.object({ action: z.literal('attach'), sourceId: sourceIdSchema.default('workspace'), path: filePathSchema }).strict(),
  z.object({ action: z.literal('create'), path: filePathSchema, content: contentSchema }).strict(),
  z.object({ action: z.literal('write'), reference: z.string().uuid(), content: contentSchema }).strict(),
  z.object({ action: z.literal('edit'), reference: z.string().uuid(), oldString: z.string().min(1).refine(value => Buffer.byteLength(value) <= 65536), newString: contentSchema, replaceAll: z.boolean().default(false) }).strict(),
]);
const archiveQuerySchema = z.object({ action: z.enum(['status', 'contacts', 'sessions', 'messages', 'search', 'stats', 'digest']), talker: z.string().optional(), query: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(10000).optional(), fromTs: z.number().int().nonnegative().optional(), toTs: z.number().int().nonnegative().optional() }).strict();
const sourceQuerySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('archive'), query: archiveQuerySchema }).strict(),
  z.object({ action: z.literal('session'), sourceId: sourceIdSchema, query: z.string().trim().min(1).max(512).optional(), limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).max(10000).default(0) }).strict(),
]);
const parsed = (schema, value) => { const result = schema.safeParse(value); if (!result.success) fail('invalid-request'); return result.data; };
const digest = value => createHash('sha256').update(value).digest('hex');
const sensitivePart = part => /^(?:\.git|\.ssh|\.aws|\.gnupg|\.kube|\.claude|\.cursor|\.config|\.cache|cache|caches|xwechat_files|wechat files|wechat_files)$/iu.test(part)
  || /^\.env(?:\..*)?$/iu.test(part) || /^(?:\.npmrc|\.pypirc|credentials(?:\.json)?|keys(?:\.json)?|bot-token(?:\.json)?|tokens\.json)$/iu.test(part);
const sensitiveFile = name => sensitivePart(name) || /\.(?:db|db-wal|db-shm|sqlite|sqlite3|key|pem|p12|pfx)$/iu.test(name);
export function validateTaskDirectory(root, forbidden = []) {
  try { validateArchiveRoot(root, forbidden); } catch { fail('forbidden-root'); }
  if (root.split(/[\\/]/u).some(sensitivePart)) fail('forbidden-root');
  return root;
}
function checkedRelative(path = '') {
  if (path && !filePathSchema.safeParse(path).success) fail('path-rejected');
  if (path.split('/').some(sensitivePart) || (path && sensitiveFile(path.split('/').at(-1)))) fail('path-rejected');
  return path;
}
async function inspectHostPath(root, path, signal, missing = false) {
  const target = path ? join(root, ...checkedRelative(path).split('/')) : root;
  const parts = relative(parse(target).root, target).split(sep).filter(Boolean);
  let current = parse(target).root, final;
  for (let index = 0; index <= parts.length; index++) {
    if (signal?.aborted) fail('aborted');
    if (index) current = join(current, parts[index - 1]);
    try { final = await lstat(current, { bigint: true }); }
    catch (error) { if (missing && index === parts.length && error?.code === 'ENOENT') return undefined; throw safeError(error, 'path-rejected'); }
    if (final.isSymbolicLink() || (index !== parts.length && !final.isDirectory())) fail('path-rejected');
  }
  if (final.isFile() && final.nlink !== 1n) fail('not-file');
  return final;
}
const sameIdentity = (left, right) => left && right && left.dev === right.dev && left.ino === right.ino;

export function createTaskAccess(ctx, options = {}) {
  if (!ctx || !options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['sourceRoot', 'beforeArchiveQuery', 'archiveFreshness'].includes(key))) fail('invalid-options');
  if (options.beforeArchiveQuery !== undefined && typeof options.beforeArchiveQuery !== 'function') fail('invalid-options');
  if (options.archiveFreshness !== undefined && typeof options.archiveFreshness !== 'function') fail('invalid-options');
  const forbidden = options.sourceRoot ? [options.sourceRoot] : [];
  if (options.sourceRoot !== undefined) checkedRootOption(options.sourceRoot);
  const entries = new Map(), operations = new Set();
  const lifetime = new AbortController();
  let domain, table, opening, disposed = false, disposal;
  function entry(id) {
    if (!isTaskSessionId(id)) fail('invalid-request');
    let value = entries.get(id);
    if (!value) {
      if (entries.size >= TASK_ACCESS_LIMITS.maxTasks) fail('busy');
      value = { id, sources: new Map(), workspace: null, cwd: null, prepared: false, historyKnown: false, consumed: new Map(), shareContext: false, historyShare: null,
        historyRevision: 0, historySupport: null, firstTextSupport: null, control: new AbortController(), mutation: false, references: new Map(), outputs: new Map(), presentations: new Map(), deliveries: new Map(), lastError: null };
      entries.set(id, value);
    }
    return value;
  }
  function storedHistoryCurrent(e) {
    const record = table?.get(e.id), consumed = [...e.consumed.values()];
    return Boolean(record && e.historyKnown && record.mayContainData === (consumed.length > 0)
      && record.workspace?.id === e.workspace?.id && record.workspace?.root === e.cwd
      && record.consumed.length === consumed.length
      && consumed.every(item => record.consumed.some(value => value.sourceId === item.sourceId && value.kind === item.kind && value.generation === item.generation)));
  }
  const historical = createTaskHistoryAuthority({
    snapshot(id) {
      const e = entry(id);
      const consumed = [...e.consumed.values()];
      const proof = storedHistoryCurrent(e);
      let support, firstText;
      try { support = e.historySupport?.(); } catch { support = null; }
      try { firstText = e.firstTextSupport?.(); } catch { firstText = null; }
      return { prepared: !disposed && e.prepared, historyKnown: Boolean(proof), workspace: e.workspace, cwd: e.cwd,
        consumed, revision: e.historyRevision, shareContext: e.shareContext,
        sdkAvailable: support?.available === true, sdkReady: support?.ready === true, sdkOwner: support?.owner ?? null,
        sdkSequence: support?.sequence ?? firstText?.sequence ?? null, firstText };
    },
    storage: () => ctx.get ? ctx.get('storageDomain') : ctx.storageDomain,
    closeSharing(id) { const e = entry(id); e.shareContext = false; e.historyShare = null; change(e); },
    openSharing(id) { const e = entry(id); e.shareContext = true; change(e); },
    fail, maxTasks: TASK_ACCESS_LIMITS.maxTasks,
  });
  function sourceChange(e) { e.historyShare = null; e.historyRevision++; historical.invalidate(e.id, 'source-changed'); change(e); }
  function bindHistorySupport(id, probe) {
    const e = entry(id); alive();
    if (typeof probe !== 'function') fail('invalid-options');
    e.historyShare = null; e.historyRevision++; historical.invalidate(id, 'sdk-changed'); e.historySupport = probe;
    return () => { if (e.historySupport === probe) { e.historyShare = null; e.historySupport = null; e.historyRevision++; historical.invalidate(id, 'sdk-changed'); } };
  }
  function bindFirstTextSupport(id, probe) {
    const e = entry(id); alive();
    if (typeof probe !== 'function') fail('invalid-options');
    e.historyShare = null; e.historyRevision++; historical.invalidate(id, 'sdk-changed'); e.firstTextSupport = probe;
    return () => { if (e.firstTextSupport === probe) { e.historyShare = null; e.firstTextSupport = null; e.historyRevision++; historical.invalidate(id, 'sdk-changed'); } };
  }
  function invalidateTextModel(id) { const e = entry(id); alive(); e.historyShare = null; e.historyRevision++; historical.invalidate(id, 'sdk-changed'); e.shareContext = false; change(e); }
  function checkedRootOption(value) {
    if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/u.test(value)) fail('invalid-options');
  }
  function alive(signal) { if (disposed) fail('disposed'); if (signal?.aborted) fail('aborted'); }
  function change(e) { e.control.abort(); e.control = new AbortController(); e.references.clear(); e.outputs.clear(); e.presentations.clear(); e.deliveries.clear(); }
  function permission(e, source, destination) {
    alive();
    if (!e.prepared || !e.historyKnown) fail('not-prepared');
    if (!source || e.sources.get(source.sourceId) !== source) fail('not-granted');
    if (destination !== 'local' && destination !== 'wechat') fail('invalid-request');
    if (destination === 'wechat' && (!source.allowWechat || !canShare(e.id))) fail('share-forbidden');
  }
  function run(e, outer, work, fallback = 'source-failed') {
    alive(outer);
    if (operations.size >= 4) fail('busy');
    const control = e.control;
    const signal = AbortSignal.any([lifetime.signal, control.signal, AbortSignal.timeout(TASK_ACCESS_LIMITS.timeoutMs), ...(outer ? [outer] : [])]);
    const promise = Promise.resolve().then(() => { alive(signal); return work(signal); }).then(value => {
      if (e.control !== control || control.signal.aborted) fail('revoked');
      alive(signal); e.lastError = null; return value;
    }).catch(error => {
      if (error?.code === 'path-rejected' && e.historyShare) {
        e.historyShare = null; e.shareContext = false; change(e);
      }
      const code = signal.aborted || error?.code === 'FS_ABORTED' ? 'aborted' : error instanceof ArchiveAccessError
        && ['row-budget-exceeded', 'file-budget-exceeded', 'byte-budget-exceeded', 'timeout'].includes(error.code) ? 'query-budget-exceeded' : error?.code === 'FS_TOO_LARGE' ? 'byte-budget-exceeded'
        : error?.code === 'FS_STALE_VERSION' ? 'file-changed' : fallback;
      const safe = safeError(error, code); e.lastError = safe.code; throw safe;
    }).finally(() => operations.delete(promise));
    operations.add(promise);
    return promise;
  }
  async function openHistory(signal) {
    alive(signal);
    if (!opening) opening = (async () => {
      const provider = ctx.get ? ctx.get('storageDomain') : ctx.storageDomain;
      if (!provider || typeof provider.open !== 'function') fail('history-unavailable');
      try {
        const handle = await provider.open(TASK_CONTEXT_SPEC);
        domain = handle;
        if (disposed) { await handle.close(); fail('disposed'); }
        table = handle.table('tasks');
        if (table.size > TASK_ACCESS_LIMITS.maxTasks) fail('history-unavailable');
      } catch (error) { throw safeError(error, 'history-unavailable'); }
    })();
    await opening; alive(signal);
  }
  // Explicit connection setup may inspect directory identity and stored Task
  // metadata. It never opens source contents or treats a missing record as clean.
  function findWorkspaceTasks(root, outer) {
    validateTaskDirectory(root, forbidden); alive(outer);
    if (operations.size >= 4) fail('busy');
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(TASK_ACCESS_LIMITS.timeoutMs), ...(outer ? [outer] : [])]);
    const promise = (async () => {
      await directory(root, signal);
      await openHistory(signal);
      if (typeof table.entries !== 'function') fail('history-unavailable');
      const result = [];
      for (const [sessionId, record] of table.entries()) {
        if (!isTaskSessionId(sessionId)) fail('history-unavailable');
        if (record.workspace?.root === root) result.push({ sessionId, workspace: { ...record.workspace } });
      }
      alive(signal);
      return result;
    })().finally(() => operations.delete(promise));
    operations.add(promise);
    return promise;
  }
  async function authorizeAutoWorkspace(id, raw, signal) {
    const request = parsed(workspaceSchema, raw), e = entry(id);
    alive(signal);
    if (!request.allowWechat || !e.prepared || !storedHistoryCurrent(e) || e.cwd !== request.root || e.workspace?.root !== request.root) fail('share-forbidden');
    if ([...e.consumed.values()].some(item => item.sourceId !== 'workspace' || item.kind !== 'directory')) fail('share-forbidden');
    if (e.mutation) fail('busy');
    const existing = e.sources.get('workspace');
    let source = existing;
    if (!existing) {
      const grant = grantDirectory(id, request, signal, true), control = e.control;
      await grant;
      alive(signal);
      if (e.control !== control) fail('revoked');
      source = e.sources.get('workspace');
    }
    if (existing) {
      if (source.kind !== 'directory' || source.root !== request.root || !source.write) fail('share-forbidden');
      e.mutation = true;
      try {
        await run(e, signal, async current => {
          const scope = await directory(request.root, current);
          if (!sameIdentity(source.identity, scope.identity) || e.sources.get('workspace') !== source) fail('path-rejected');
        });
        alive(signal);
        if (!source.allowWechat) {
          sourceChange(e);
          source = { ...source, allowWechat: true };
          e.sources.set('workspace', source);
        }
      } finally { e.mutation = false; }
    }
    if (!source || source.kind !== 'directory' || source.root !== e.cwd || e.workspace?.root !== e.cwd
      || !storedHistoryCurrent(e) || [...e.consumed.values()].some(item => item.sourceId !== 'workspace' || item.kind !== 'directory')) fail('share-forbidden');
    const generations = new Set([...e.consumed.values()].filter(item => item.generation !== source.generation).map(item => item.generation));
    // The new decision covers old workspace replies, not old-source access.
    // The consumed records stay intact and the current grant keeps its own generation.
    e.historyShare = generations.size ? { workspaceId: e.workspace.id, root: e.cwd, sources: new Map([[source.sourceId, { source, generations }]]) } : null;
    if (generations.size) change(e);
    return getState(id);
  }
  async function mark(e, source) {
    const key = source.sourceId + ':' + source.generation;
    if (e.consumed.has(key)) return;
    e.historyRevision++; historical.invalidate(e.id, 'history-changed');
    e.consumed.set(key, { sourceId: source.sourceId, kind: source.kind, generation: source.generation });
    if (!table?.get(e.id)) { e.historyKnown = false; fail('history-unavailable'); }
    try {
      await table.update(e.id, record => ({ ...record, mayContainData: true, consumed: [...record.consumed,
        ...(!record.consumed.some(item => item.sourceId === source.sourceId && item.generation === source.generation) ? [e.consumed.get(key)] : [])] }));
    } catch { e.historyShare = null; e.historyKnown = false; fail('history-unavailable'); }
  }
  const archive = createArchiveAccess({ sourceRoot: options.sourceRoot,
    hasArchiveHistory: id => table?.get(id)?.mayContainData === undefined ? 'unknown' : table.get(id).consumed.some(item => item.kind === 'archive'),
    markArchiveHistory: async id => { const e = entry(id), source = e.sources.get('archive'); if (!source) fail('revoked'); await mark(e, source); },
  });
  function filesystem() {
    const fs = ctx.get ? ctx.get('fs') : ctx.fs;
    if (!fs || typeof fs.resolve !== 'function' || typeof fs.contains !== 'function' || typeof fs.readBytes !== 'function'
      || typeof fs.processPathFromHostPath !== 'function') fail('unsupported-filesystem');
    return fs;
  }
  async function directory(root, signal) {
    validateTaskDirectory(root, forbidden);
    const identity = await inspectHostPath(root, '', signal);
    if (!identity?.isDirectory()) fail('not-directory');
    const fs = filesystem(), mapped = fs.processPathFromHostPath(root);
    if (mapped !== root) fail('unsupported-filesystem');
    const target = await fs.resolve(root, { signal });
    const canonical = fs.processPath(target);
    validateTaskDirectory(canonical, forbidden);
    if (canonical !== root || !sameIdentity(identity, await inspectHostPath(root, '', signal))) fail('path-rejected');
    const info = await fs.stat(target, signal);
    if (info?.type !== 'directory') fail('not-directory');
    return { root, identity, target };
  }
  async function boundary(source, path, signal, missing = false) {
    checkedRelative(path);
    const fs = filesystem();
    if (!sameIdentity(source.identity, await inspectHostPath(source.root, '', signal))) fail('path-rejected');
    const identity = await inspectHostPath(source.root, path, signal, missing);
    const fullPath = path ? join(source.root, ...path.split('/')) : source.root;
    if (fs.processPathFromHostPath(fullPath) !== fullPath) fail('unsupported-filesystem');
    const target = await fs.resolve(fullPath, { signal });
    if (!fs.contains(source.target, target) || fs.processPath(target) !== fullPath) fail('path-rejected');
    return { fs, target, identity, fullPath };
  }
  async function grantDirectory(id, raw, signal, workspace = false) {
    const request = parsed(workspace ? workspaceSchema : directorySchema, raw);
    validateTaskDirectory(request.root, forbidden);
    const e = entry(id);
    alive(signal);
    if (e.mutation) fail('busy');
    if (workspace && e.cwd && request.root !== e.cwd) fail('path-rejected');
    if (e.sources.size >= TASK_ACCESS_LIMITS.maxSources && !request.sourceId && !workspace) fail('busy');
    const sourceId = workspace ? 'workspace' : request.sourceId ?? randomUUID();
    if (request.sourceId && e.sources.get(sourceId)?.kind !== 'directory') fail('not-granted');
    sourceChange(e); e.sources.delete(sourceId); e.mutation = true;
    try {
      return await run(e, signal, async current => {
        const scope = await directory(request.root, current);
        if (workspace) {
          const service = ctx.get ? ctx.get('workspaceRegistry') : ctx.workspaceRegistry;
          if (!service || typeof service.create !== 'function') fail('not-prepared');
          const value = await service.create(scope.root, request.title);
          alive(current);
          if (!value || value.path !== scope.root || typeof value.attachSession !== 'function') fail('path-rejected');
          // Registry entries may be rebuilt independently of the persisted Task.
          // Regranting the same verified root must not replace its recorded identity.
          e.workspace = { id: e.workspace?.root === scope.root ? e.workspace.id : value.id, root: scope.root, title: request.title };
        }
        alive(current);
        e.sources.set(sourceId, { ...scope, sourceId, kind: 'directory', generation: randomUUID(), title: request.title, write: workspace, allowWechat: request.allowWechat });
        return getState(id);
      });
    } finally { e.mutation = false; }
  }
  function grantSession(id, raw) {
    const request = parsed(sessionSchema, raw), e = entry(id);
    alive();
    if (request.sessionId === id) fail('invalid-request');
    const sourceId = 'session-' + digest(request.sessionId).slice(0, 24);
    if (!e.sources.has(sourceId) && e.sources.size >= TASK_ACCESS_LIMITS.maxSources) fail('busy');
    sourceChange(e);
    e.sources.set(sourceId, { sourceId, kind: 'session', generation: randomUUID(), sessionId: request.sessionId, title: request.title, allowWechat: request.allowWechat });
    return getState(id);
  }
  async function grantSnapshot(id, raw, signal) {
    try { validateArchiveRoot(raw?.root, forbidden); } catch { fail('forbidden-root'); }
    const e = entry(id);
    alive(signal);
    if (e.mutation) fail('busy');
    sourceChange(e); e.sources.delete('archive'); archive.revoke(id); e.mutation = true;
    try {
      return await run(e, signal, async current => {
        await archive.grant(id, raw, current);
        alive(current);
        e.sources.set('archive', { sourceId: 'archive', kind: 'archive', generation: randomUUID(), title: 'WeChat archive', allowWechat: raw.allowWechat === true });
        return getState(id);
      });
    } finally { e.mutation = false; }
  }
  async function refreshSnapshot(id, root, signal) {
    const e = entry(id), source = e.sources.get('archive'); alive(signal);
    if (!e.prepared || source?.kind !== 'archive') fail('not-granted');
    if (e.mutation || operations.size || archive.getState(id).activeQueries) fail('busy');
    e.mutation = true;
    try {
      await archive.refresh(id, root, signal);
      if (e.sources.get('archive') !== source) fail('revoked');
      return getState(id);
    } finally { e.mutation = false; }
  }
  function revoke(id, sourceId) {
    const e = entry(id);
    if (!sourceIdSchema.safeParse(sourceId).success) fail('invalid-request');
    sourceChange(e); e.sources.delete(sourceId); if (sourceId === 'archive') archive.revoke(id); e.lastError = 'revoked'; return getState(id);
  }
  function revokeAll(id) {
    const e = entry(id); sourceChange(e); e.sources.clear(); e.shareContext = false; archive.revoke(id); return getState(id);
  }
  function setSharing(id, raw) {
    const request = parsed(z.object({ allowWechat: z.boolean(), confirmation: z.literal('share-whole-task-context') }).strict(), raw);
    const e = entry(id); alive(); e.historyShare = null;
    historical.invalidate(id, 'sharing-changed'); change(e); e.shareContext = request.allowWechat;
    if (request.allowWechat && storedHistoryCurrent(e)) {
      // Whole-task confirmation covers retained replies from older generations.
      // Pin current source objects; this does not restore old source reads.
      const sources = new Map();
      for (const item of e.consumed.values()) {
        const source = e.sources.get(item.sourceId);
        if (!source || source.kind !== item.kind || source.allowWechat !== true || source.generation === item.generation) continue;
        if (!sources.has(item.sourceId)) sources.set(item.sourceId, { source, generations: new Set() });
        sources.get(item.sourceId).generations.add(item.generation);
      }
      if (sources.size) e.historyShare = { workspaceId: e.workspace.id, root: e.cwd, sources };
    }
    return getState(id);
  }
  function consumedSourceCurrent(e, item) {
    const current = e.sources.get(item.sourceId);
    if (current?.generation === item.generation) return current;
    const decision = e.historyShare, source = decision?.sources.get(item.sourceId);
    return current?.kind === item.kind && source?.source === current
      && decision.workspaceId === e.workspace?.id && decision.root === e.cwd
      && source.generations.has(item.generation) ? current : undefined;
  }
  function canShare(id) {
    const e = entry(id);
    return !disposed && e.prepared && e.historyKnown && e.shareContext && e.sources.get('workspace')?.root === e.cwd
      && [...e.consumed.values()].every(item => consumedSourceCurrent(e, item)?.allowWechat === true);
  }
  function getState(id) {
    const e = entry(id);
    return { version: 1, sessionId: id, disposed, prepared: !disposed && e.prepared, historyKnown: e.historyKnown,
      workspace: e.workspace ? { ...e.workspace } : null, allowWechat: !disposed && e.shareContext, shareable: canShare(id),
      sessionMayContainData: e.consumed.size > 0, contextBlocked: !e.historyKnown || [...e.consumed.values()].some(item => !consumedSourceCurrent(e, item)),
      sources: disposed ? [] : [...e.sources.values()].map(source => ({ sourceId: source.sourceId, kind: source.kind, title: source.title, allowWechat: source.allowWechat,
        ...(source.kind === 'directory' ? { root: source.root, write: source.write } : source.kind === 'session' ? { sessionId: source.sessionId } : { archive: archive.getState(id) }) })), lastError: e.lastError };
  }
  async function prepare(id, session, signal) {
    const e = entry(id); alive(signal);
    if (session?.id !== id || session.header?.id !== id || session.header.agentPreset !== TASK_PRESET_ID
      || session.header.isSeeded !== false || session.header.parentSession !== undefined || session.header.origin !== undefined) fail('not-prepared');
    if (e.cwd !== session.header.cwd) e.historyShare = null;
    e.cwd = session.header.cwd;
    if (e.workspace && e.workspace.root !== e.cwd) fail('path-rejected');
    await openHistory(signal);
    let record = table.get(id);
    if (!record) {
      if (session.snapshotEvents().some(event => !['session/end-seed', 'sandbox/mode', 'agent-preset/selected'].includes(event.type))) fail('history-unavailable');
      if (table.size >= TASK_ACCESS_LIMITS.maxTasks) fail('busy');
      await table.put(id, { createdAt: Date.now(), workspace: e.workspace, mayContainData: false, consumed: [] });
      record = table.get(id);
    }
    alive(signal);
    if (record.workspace && record.workspace.root !== e.cwd) fail('history-unavailable');
    if (record.mayContainData !== (record.consumed.length > 0)) fail('history-unavailable');
    if ([...e.consumed.values()].some(item => !record.consumed.some(stored => stored.sourceId === item.sourceId && stored.generation === item.generation))) fail('history-unavailable');
    if (e.workspace && record.workspace && e.workspace.id !== record.workspace.id) fail('history-unavailable');
    e.workspace ??= record.workspace;
    if (record.consumed.some(item => !e.consumed.has(item.sourceId + ':' + item.generation))) {
      e.historyShare = null; e.historyRevision++; historical.invalidate(id, 'history-changed');
    }
    for (const item of record.consumed) e.consumed.set(item.sourceId + ':' + item.generation, item);
    e.prepared = true; e.historyKnown = true;
  }
  async function query(id, raw, outer, destination = 'local', turn) {
    const request = parsed(sourceQuerySchema, raw), e = entry(id);
    alive(outer);
    if (request.action === 'status') {
      const state = getState(id);
      return Promise.resolve({ action: 'status', prepared: state.prepared, historyKnown: state.historyKnown, shareable: state.shareable, contextBlocked: state.contextBlocked,
        sources: state.sources.map(source => ({ sourceId: source.sourceId, kind: source.kind, allowWechat: source.allowWechat,
          ...(source.kind === 'directory' ? { write: source.write } : {}) })),
        ...(options.archiveFreshness?.(id) ? { historyFreshness: options.archiveFreshness(id) } : {}) });
    }
    const source = e.sources.get(request.action === 'archive' ? 'archive' : request.sourceId);
    permission(e, source, destination);
    if (request.action === 'session' && source.kind !== 'session') fail('not-granted');
    if (request.action === 'archive' && options.beforeArchiveQuery) {
      await options.beforeArchiveQuery(id, outer, turn);
      permission(e, source, destination);
    }
    return run(e, outer, async signal => {
      if (request.action === 'archive') {
        // Archive owns the durable consumption barrier after successful work,
        // before returning a page. Failed queries have not supplied Task data.
        const value = await archive.query(id, request.query, signal, destination);
        permission(e, source, destination);
        const freshness = options.archiveFreshness?.(id);
        return freshness ? { ...value, historyFreshness: freshness } : value;
      }
      await mark(e, source); alive(signal);
      const service = ctx.get ? ctx.get('sessionQuery') : ctx.sessionQuery;
      if (!service || typeof service.observeSession !== 'function') fail('not-prepared');
      const observation = await service.observeSession(SessionId(source.sessionId), { signal, projectionMode: 'none' });
      try {
        alive(signal);
        if (observation.header?.id !== source.sessionId || observation.events.length > TASK_ACCESS_LIMITS.maxEvents) fail('event-budget-exceeded');
        const candidates = [], needle = request.query?.toLocaleLowerCase();
        for (const event of observation.events) {
          const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data?.message : null;
          if (!message || !((message.role === 'user' && ['user', 'wechat-ro-weixin', 'wechat-task-weixin'].includes(message.source?.kind))
            || (message.role === 'assistant' && message.source?.kind === 'model' && event.data.interrupted !== true
              && event.data.stream?.some(chunk => chunk.type === 'chunk' && chunk.chunk?.type === 'finish')))) continue;
          const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
          if (text && (!needle || text.toLocaleLowerCase().includes(needle))) candidates.push({ seq: event.seq, messageId: message.id, role: message.role, text });
        }
        const page = candidates.slice(request.offset, request.offset + request.limit);
        const rows = []; let bytes = 0, truncated = false;
        for (const row of page) {
          if (bytes + Buffer.byteLength(JSON.stringify(row), 'utf8') > TASK_ACCESS_LIMITS.maxBytes - 2048) {
            if (rows.length === 0) fail('byte-budget-exceeded');
            truncated = true; break;
          }
          rows.push(row); bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
        }
        permission(e, source, destination);
        return { action: 'session', untrusted: true, source: { sourceId: source.sourceId, title: source.title, capturedThroughSeq: observation.cursor },
          rows, returned: rows.length, offset: request.offset, limit: request.limit, hasMore: request.offset + rows.length < candidates.length, truncated,
          omitted: 'system, developer, tools, reasoning, media and unknown user-message producers', sourceReadByteBounded: false, bytes };
      } finally { observation[Symbol.dispose](); }
    });
  }
  function file(id, raw, outer, destination = 'local', turn = null) {
    const request = parsed(fileRequestSchema, raw), e = entry(id);
    let reference, source, path;
    if (request.action === 'write' || request.action === 'edit') {
      reference = e.references.get(request.reference);
      if (!reference) fail('file-changed');
      source = e.sources.get(reference.sourceId); path = reference.path;
      if (reference.generation !== source?.generation) fail('revoked');
    } else { source = e.sources.get(request.sourceId ?? 'workspace'); path = request.path ?? ''; }
    const writing = ['create', 'write', 'edit'].includes(request.action);
    permission(e, source, destination);
    if (source.kind !== 'directory' || (writing && (!source.write || source.sourceId !== 'workspace' || !Number.isSafeInteger(turn) || turn < 0))) fail('not-granted');
    if (request.action === 'attach' && (!Number.isSafeInteger(turn) || turn < 0)) fail('invalid-request');
    checkedRelative(path);
    return run(e, outer, async signal => {
      if (!writing) await mark(e, source);
      alive(signal);
      const current = await boundary(source, path, signal, request.action === 'create');
      if (request.action === 'list') {
        if (!current.identity?.isDirectory()) fail('not-directory');
        const handle = await opendir(current.fullPath, { bufferSize: 8 });
        const rows = []; let truncated = false, bytes = 0, inspected = 0;
        try {
          for (;;) {
            alive(signal);
            if (inspected++ >= TASK_ACCESS_LIMITS.maxRows * 4) { truncated = true; break; }
            const child = await handle.read(); if (!child) break;
            if (child.isSymbolicLink() || sensitiveFile(child.name) || (!child.isDirectory() && !child.isFile())) continue;
            const row = { name: child.name, type: child.isDirectory() ? 'directory' : 'file' };
            if (rows.length >= request.limit || bytes + Buffer.byteLength(JSON.stringify(row)) > TASK_ACCESS_LIMITS.maxBytes - 2048) { truncated = true; break; }
            rows.push(row); bytes += Buffer.byteLength(JSON.stringify(row));
          }
        } finally { await handle.close(); }
        await boundary(source, path, signal); permission(e, source, destination);
        return { action: 'list', untrusted: true, sourceId: source.sourceId, path, rows, truncated, limit: request.limit };
      }
      const before = await current.fs.stat(current.target, signal);
      if (request.action === 'read' || request.action === 'attach') {
        if (!current.identity?.isFile() || before?.type !== 'file') fail('not-file');
        const bytes = await current.fs.readBytes(current.target, signal, request.action === 'attach' ? WEIXIN_MEDIA_LIMITS.maxBytes : TASK_ACCESS_LIMITS.maxBytes);
        const after = await current.fs.stat(current.target, signal);
        const next = await boundary(source, path, signal);
        if (before.version !== after?.version || !sameIdentity(current.identity, next.identity)) fail('file-changed');
        if (request.action === 'attach') {
          const description = describeWeixinMedia(path.split('/').at(-1), bytes);
          if (e.outputs.size >= TASK_ACCESS_LIMITS.maxReferences && !e.outputs.has(current.fullPath)) fail('busy');
          permission(e, source, destination);
          e.outputs.set(current.fullPath, { path, sourceId: source.sourceId, generation: source.generation, version: after.version, turn, sha256: description.sha256, selected: true });
          return { action: 'attach', path: current.fullPath, selected: true, turn, ...description };
        }
        let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('not-file'); }
        if (text.includes('\0')) fail('not-file');
        if (e.references.size >= TASK_ACCESS_LIMITS.maxReferences) fail('busy');
        const id = randomUUID(); e.references.set(id, { sourceId: source.sourceId, generation: source.generation, path, version: after.version, text });
        permission(e, source, destination);
        return { action: 'read', untrusted: true, sourceId: source.sourceId, path, text, bytes: bytes.byteLength, truncated: false, reference: id };
      }
      if (request.action === 'create' ? before !== undefined || current.identity !== undefined : !current.identity?.isFile() || before?.type !== 'file' || before.version !== reference.version) fail('file-changed');
      if (request.action === 'edit') {
        const basis = reference.text.replaceAll('\r\n', '\n'), old = request.oldString.replaceAll('\r\n', '\n'), replacement = request.newString.replaceAll('\r\n', '\n');
        const matches = basis.split(old).length - 1;
        if (!matches || (!request.replaceAll && matches !== 1)) fail('write-failed');
        const restoredLineBytes = reference.text.includes('\r\n')
          ? basis.split('\n').length - 1 + matches * (replacement.split('\n').length - old.split('\n').length) : 0;
        if (Buffer.byteLength(basis) + matches * (Buffer.byteLength(replacement) - Buffer.byteLength(old)) + restoredLineBytes > TASK_ACCESS_LIMITS.maxBytes) fail('byte-budget-exceeded');
      }
      const sandbox = { mode: 'workspace-write', workspaceRoot: source.root, sessionId: id };
      const result = request.action === 'edit'
        ? await current.fs.editText(current.target, { oldString: request.oldString, newString: request.newString, replaceAll: request.replaceAll }, { version: reference.version }, signal, sandbox)
        : await current.fs.writeText(current.target, request.content, request.action === 'create' ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: reference.version }, signal, sandbox);
      alive(signal);
      if (!result?.version || typeof result.after !== 'string' || Buffer.byteLength(result.after) > TASK_ACCESS_LIMITS.maxBytes) fail('write-failed');
      const next = await boundary(source, path, signal);
      const savedBytes = await current.fs.readBytes(current.target, signal, TASK_ACCESS_LIMITS.maxBytes);
      let savedText; try { savedText = new TextDecoder('utf-8', { fatal: true }).decode(savedBytes); } catch { fail('write-failed'); }
      const after = await current.fs.stat(current.target, signal);
      if (!next.identity?.isFile() || after?.version !== result.version || savedText.replaceAll('\r\n', '\n') !== result.after) fail('file-changed');
      await boundary(source, path, signal);
      if (e.outputs.size >= TASK_ACCESS_LIMITS.maxReferences && !e.outputs.has(current.fullPath)) fail('busy');
      e.outputs.set(current.fullPath, { path, sourceId: source.sourceId, generation: source.generation, version: result.version, turn, sha256: digest(savedBytes) });
      if (reference) e.references.delete(request.reference);
      return { action: request.action, path, produced: true, turn, bytes: savedBytes.byteLength };
    }, writing ? 'write-failed' : 'source-failed');
  }
  async function readOutput(e, full, produced, signal, destination = 'local') {
    const source = produced && e.sources.get(produced.sourceId);
    permission(e, source, destination);
    if (!produced || e.outputs.get(full) !== produced || source.generation !== produced.generation) fail('not-produced');
    const current = await boundary(source, produced.path, signal);
    const info = await current.fs.stat(current.target, signal);
    if (!current.identity?.isFile() || info?.version !== produced.version) fail('file-changed');
    const bytes = await current.fs.readBytes(current.target, signal, WEIXIN_MEDIA_LIMITS.maxBytes);
    if (digest(bytes) !== produced.sha256 || (await current.fs.stat(current.target, signal))?.version !== produced.version) fail('file-changed');
    const next = await boundary(source, produced.path, signal);
    if (!sameIdentity(current.identity, next.identity)) fail('file-changed');
    permission(e, source, destination);
    return Buffer.from(bytes);
  }
  function inspectDeliverables(id, files, outer, turn, callId) {
    const e = entry(id);
    if (!Array.isArray(files) || files.length === 0 || files.length > WEIXIN_MEDIA_LIMITS.maxFiles || !Number.isSafeInteger(turn)) fail('invalid-request');
    if (callId !== undefined && (typeof callId !== 'string' || !callId || callId.length > 256 || e.presentations.size >= TASK_ACCESS_LIMITS.maxReferences)) fail('invalid-request');
    return run(e, outer, async signal => {
      const verified = [], outputs = [];
      for (const file of files) {
        const raw = parsed(z.object({ path: z.string().min(1).max(4096), description: z.string().max(512).optional() }).strict(), file);
        const full = isAbsolute(raw.path) ? resolve(raw.path) : resolve(e.cwd, raw.path);
        const produced = e.outputs.get(full);
        if (!produced || produced.turn !== turn) fail('not-produced');
        const bytes = await readOutput(e, full, produced, signal);
        verified.push({ path: full, description: raw.description ?? '', turn, sha256: produced.sha256, bytes: bytes.byteLength });
        outputs.push(produced);
      }
      alive(signal);
      if (callId !== undefined) e.presentations.set(callId, { turn, verified, outputs });
      return verified;
    });
  }
  function captureDeliverables(id, declarations, outer, turn) {
    const e = entry(id);
    if (!Array.isArray(declarations) || declarations.length > TASK_ACCESS_LIMITS.maxReferences) fail('invalid-request');
    return run(e, outer, async signal => {
      if (!canShare(id)) fail('share-forbidden');
      const selected = new Map();
      for (const declaration of declarations) {
        const captured = e.presentations.get(declaration.callId);
        if (!captured || captured.turn !== turn || !Array.isArray(declaration.files) || declaration.files.length !== captured.verified.length) fail('not-produced');
        for (let index = 0; index < captured.verified.length; index++) {
          const file = captured.verified[index], actual = declaration.files[index], produced = captured.outputs[index];
          if (actual?.path !== file.path || (actual.description ?? '') !== file.description) fail('not-produced');
          const bytes = await readOutput(e, file.path, produced, signal, 'wechat');
          const description = describeWeixinMedia(produced.path.split('/').at(-1), bytes);
          if (selected.has(file.path)) {
            if (selected.get(file.path).produced !== produced) fail('file-changed');
            continue;
          }
          if (selected.size >= WEIXIN_MEDIA_LIMITS.maxFiles || e.deliveries.size + selected.size >= TASK_ACCESS_LIMITS.maxReferences) fail('busy');
          selected.set(file.path, { produced, full: file.path, descriptor: Object.freeze({ reference: randomUUID(), turn, ...description }) });
        }
      }
      alive(signal);
      const result = [];
      for (const value of selected.values()) { e.deliveries.set(value.descriptor.reference, value); result.push(value.descriptor); }
      for (const declaration of declarations) e.presentations.delete(declaration.callId);
      return Object.freeze(result);
    });
  }
  function prepareDelivery(id, descriptor, outer) {
    const e = entry(id), control = e.control, value = e.deliveries.get(descriptor?.reference);
    if (!value || ['reference', 'turn', 'fileName', 'kind', 'bytes', 'sha256'].some(key => descriptor[key] !== value.descriptor[key])) fail('not-produced');
    const signal = AbortSignal.any([lifetime.signal, control.signal, ...(outer ? [outer] : [])]);
    const authorize = () => !signal.aborted && e.control === control && e.deliveries.get(descriptor.reference) === value && canShare(id)
      && e.sources.get(value.produced.sourceId)?.generation === value.produced.generation && e.sources.get(value.produced.sourceId)?.allowWechat === true;
    const verify = () => run(e, signal, async current => { if (!authorize()) fail('share-forbidden'); await readOutput(e, value.full, value.produced, current, 'wechat'); });
    return run(e, signal, async current => {
      if (!authorize()) fail('share-forbidden');
      const data = await readOutput(e, value.full, value.produced, current, 'wechat');
      return Object.freeze({ data, signal, authorize, verify });
    });
  }
  function releaseDeliveries(id, references) { const e = entry(id); for (const reference of references) e.deliveries.delete(reference); }
  function contextSignal(id) { return entry(id).control.signal; }
  function getWorkspace(id) { const value = entry(id).workspace; return value ? { ...value } : null; }
  function dispose() {
    if (disposal) return disposal;
    disposed = true; lifetime.abort(); for (const e of entries.values()) { sourceChange(e); e.sources.clear(); e.shareContext = false; }
    disposal = (async () => { await Promise.allSettled([...operations]); await historical.dispose(); await archive.dispose(); if (opening) await opening.catch(() => {}); if (domain) await domain.close(); })();
    return disposal;
  }
  return Object.freeze({ findWorkspaceTasks, authorizeAutoWorkspace, grantWorkspace: (id, raw, signal) => grantDirectory(id, raw, signal, true), grantDirectory, grantSession, grantSnapshot, refreshSnapshot,
    revoke, revokeAll, setSharing, getState, canShare, prepare, query, file, inspectDeliverables, captureDeliverables, prepareDelivery, releaseDeliveries, contextSignal, getWorkspace,
    bindHistorySupport,
    getHistoricalState: id => { entry(id); return historical.status(id); },
    reviewHistoricalContext: (id, signal) => { entry(id); return historical.review(id, signal); },
    authorizeHistoricalContext: (id, request, signal) => { entry(id); return historical.authorize(id, request, signal); },
    shareHistoricalContext: (id, request, signal) => { entry(id); return historical.share(id, request, signal); },
    revokeHistoricalContext: (id, request) => { entry(id); return historical.revoke(id, request); },
    readHistoricalState: (id, signal) => { entry(id); return historical.inspect(id, signal); },
    reserveHistoricalText: (id, request, signal) => { entry(id); return historical.reserve(id, request, signal); },
    verifyHistoricalText: historical.verify, bindHistoricalInput: historical.bindInput,
    noteHistoricalModelRequest: historical.recordModelRequests, completeHistoricalModel: historical.completeModel,
    finishHistoricalText: historical.finish,
    bindFirstTextSupport, invalidateTextModel,
    stopTextContexts: (id, request) => { entry(id); return historical.revokeCurrent(id, request); },
    getFirstTextState: id => { entry(id); return historical.firstText.status(id); },
    readFirstTextState: (id, signal) => { entry(id); return historical.firstText.inspect(id, signal); },
    allowNewFirstText: (id, request, signal) => { entry(id); return historical.firstText.allowNewInput(id, request, signal); },
    reviewFirstTextContext: (id, signal) => { entry(id); return historical.firstText.review(id, signal); },
    authorizeFirstTextContext: (id, request, signal) => { entry(id); return historical.firstText.authorize(id, request, signal); },
    shareFirstTextContext: (id, request, signal) => { entry(id); return historical.firstText.share(id, request, signal); },
    revokeFirstTextContext: (id, request) => { entry(id); return historical.firstText.revoke(id, request); },
    reserveFirstText: (id, request, signal) => { entry(id); return historical.firstText.reserve(id, request, signal); },
    verifyFirstText: historical.firstText.verify, bindFirstTextInput: historical.firstText.bindInput,
    noteFirstTextModelRequest: historical.firstText.recordModelRequests, completeFirstTextModel: historical.firstText.completeModel,
    firstTextObservation: historical.firstText.observation, retainFirstTextLease: historical.firstText.retainLease, drainFirstTextLease: historical.firstText.drainLease,
    finishFirstText: historical.firstText.finish, dispose });
}
