import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import { createTaskAccess, TASK_CONTEXT_SPEC, TASK_PRESET_ID, TaskAccessError } from '../lib/task-access.js';

const checkout = process.env.WECHAT_UI_TEST_RUNTIME ?? '/REPLACE_WITH_DSH_CHECKOUT';
const sdk = value => pathToFileURL(join(checkout, value)).href;
const { default: FsLocal } = await import(sdk('packages/fs/fs-local/lib/index.js'));
const { default: WorkspaceRegistry } = await import(sdk('packages/workspace/workspace/lib/index.js'));
const { Storage } = await import(sdk('packages/storage/storage/lib/index.js'));
const JsonStorage = await import(sdk('packages/storage/storage-json/lib/index.js'));
const StorageDomain = await import(sdk('packages/storage/storage-domain/lib/index.js'));
const JsonlPersistence = await import(sdk('packages/session/session-persistence-jsonl/lib/index.js'));

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class MeteredFileSystem extends FsLocal {
  reads = [];
  resolved = [];
  hold = null;
  async resolve(path, options) {
    this.resolved.push(path);
    const value = await super.resolve(path, options);
    if (this.hold) {
      const hold = this.hold; this.hold = null;
      hold.entered.resolve(); await hold.release.promise;
    }
    return value;
  }
  async readBytes(target, signal, limit) {
    this.reads.push(this.processPath(target));
    return super.readBytes(target, signal, limit);
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wechat-auto-share-'));
  const workspace = join(root, 'workspace'), extra = join(root, 'extra'), forbidden = join(root, 'forbidden');
  const ctx = new Context(), accesses = [];
  let access;
  try {
    for (const path of [workspace, extra, forbidden]) await mkdir(path, { mode: 0o700 });
    await writeFile(join(workspace, 'history.txt'), 'Synthetic workspace history.');
    await writeFile(join(extra, 'extra.txt'), 'Synthetic separate directory.');
    await ctx.plugin(SessionStore);
    await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' });
    await ctx.plugin(Storage);
    await ctx.plugin(JsonStorage, { root: join(root, 'domains') });
    await ctx.plugin(StorageDomain, { backend: 'json' });
    await ctx.plugin(MeteredFileSystem, { cwd: root });
    await ctx.plugin(WorkspaceRegistry);
    const id = `wechat-task-${randomUUID()}`;
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: workspace, agentPreset: TASK_PRESET_ID } });
    const request = { root: workspace, title: 'Synthetic current workspace', allowWechat: true, confirmation: 'read-and-write-task-workspace' };
    const record = () => ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks').get(id);
    const create = () => { access = createTaskAccess(ctx, { sourceRoot: forbidden }); accesses.push(access); return access; };
    create();
    await access.grantWorkspace(id, { ...request, allowWechat: false });
    await access.prepare(id, session);
    await access.file(id, { action: 'read', path: 'history.txt' });
    const oldRecord = structuredClone(record());
    const cold = async () => { await access.dispose(); create(); await access.prepare(id, session); };
    const dispose = async () => {
      await Promise.allSettled(accesses.map(value => value.dispose()));
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    };
    return { ctx, root, workspace, extra, id, session, request, record, oldRecord, cold, dispose, get access() { return access; } };
  } catch (error) {
    await Promise.allSettled(accesses.map(value => value.dispose()));
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); throw error;
  }
}
const denied = (operation, code) => assert.rejects(Promise.resolve().then(operation), error => error instanceof TaskAccessError && error.code === code);
const share = f => f.access.setSharing(f.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
const restoredShare = async f => { await f.access.authorizeAutoWorkspace(f.id, f.request); share(f); };

test('automatic consent keeps a current source generation and does not perform a second source read', async () => {
  const f = await fixture();
  try {
    const reads = f.ctx.fs.reads.length;
    const value = await f.access.authorizeAutoWorkspace(f.id, f.request);
    assert.equal(value.contextBlocked, false); assert.equal(value.shareable, false);
    assert.equal(value.sources[0].allowWechat, true);
    assert.equal(f.ctx.fs.reads.length, reads);
    assert.deepEqual(f.record(), f.oldRecord);
    share(f); assert.equal(f.access.canShare(f.id), true);
    await f.access.file(f.id, { action: 'read', path: 'history.txt' });
    assert.deepEqual(f.record(), f.oldRecord, 'A current consumed generation stays current');
  } finally { await f.dispose(); }
});

test('cold missing workspace access gets a new generation and a separate old-history sharing decision', async () => {
  const f = await fixture();
  try {
    await f.cold();
    assert.deepEqual(f.access.getState(f.id).sources, []);
    assert.equal(f.access.getState(f.id).contextBlocked, true);
    const reads = f.ctx.fs.reads.length;
    const value = await f.access.authorizeAutoWorkspace(f.id, f.request);
    assert.equal(value.workspace.id, f.oldRecord.workspace.id);
    assert.equal(value.workspace.root, f.workspace);
    assert.equal(value.sources.length, 1); assert.equal(value.sources[0].write, true);
    assert.equal(value.contextBlocked, false); assert.equal(value.shareable, false);
    assert.equal(f.ctx.fs.reads.length, reads, 'Setup verifies identity without opening source content');
    assert.deepEqual(f.record(), f.oldRecord, 'Authorizing retained replies does not rewrite the consumed ledger');
    share(f); assert.equal(f.access.canShare(f.id), true);
    await f.access.file(f.id, { action: 'read', path: 'history.txt' }, undefined, 'wechat');
    const generations = f.record().consumed.filter(value => value.sourceId === 'workspace').map(value => value.generation);
    assert.equal(generations.length, 2); assert.notEqual(generations[0], generations[1]);
    assert.deepEqual(f.record().consumed[0], f.oldRecord.consumed[0]);
    assert.equal(f.access.getState(f.id).contextBlocked, false);
    assert.equal(f.access.canShare(f.id), true, 'A current-generation read does not invalidate the separately shared history');
  } finally { await f.dispose(); }
});

test('a directory regrant alone does not share old history; whole-task confirmation covers retained replies separately', async () => {
  const f = await fixture();
  try {
    await f.cold();
    await f.access.grantWorkspace(f.id, f.request);
    assert.equal(f.access.canShare(f.id), false);
    assert.equal(f.access.getState(f.id).contextBlocked, true);
    share(f);
    assert.equal(f.access.canShare(f.id), true);
    assert.deepEqual(f.record(), f.oldRecord);
  } finally { await f.dispose(); }
});

test('closing sharing clears the old-history decision and a fresh whole-task confirmation restores retained replies', async () => {
  const f = await fixture();
  try {
    await f.cold(); await restoredShare(f);
    f.access.setSharing(f.id, { allowWechat: false, confirmation: 'share-whole-task-context' });
    assert.equal(f.access.canShare(f.id), false); assert.equal(f.access.getState(f.id).contextBlocked, true);
    share(f); assert.equal(f.access.canShare(f.id), true);
    assert.deepEqual(f.record(), f.oldRecord);
  } finally { await f.dispose(); }
});

test('sharing false does not label a matching current source generation as context blocked', async () => {
  const f = await fixture();
  try {
    share(f); assert.equal(f.access.canShare(f.id), false, 'The source itself still rejects WeChat');
    f.access.setSharing(f.id, { allowWechat: false, confirmation: 'share-whole-task-context' });
    assert.equal(f.access.getState(f.id).contextBlocked, false);
    assert.equal(f.access.getState(f.id).shareable, false);
  } finally { await f.dispose(); }
});

test('source revocation keeps the ledger and requires a new explicit automatic scope decision', async () => {
  const f = await fixture();
  try {
    await f.cold(); await restoredShare(f);
    f.access.revoke(f.id, 'workspace');
    assert.equal(f.access.canShare(f.id), false); assert.equal(f.access.getState(f.id).contextBlocked, true);
    assert.deepEqual(f.record(), f.oldRecord);
    await restoredShare(f); assert.equal(f.access.canShare(f.id), true);
    assert.equal(f.access.getState(f.id).sources.length, 1);
    assert.deepEqual(f.record(), f.oldRecord);
    f.access.revokeAll(f.id);
    assert.equal(f.access.canShare(f.id), false); assert.deepEqual(f.access.getState(f.id).sources, []);
  } finally { await f.dispose(); }
});

test('another source grant invalidates the old-workspace sharing decision and mixed consumed sources are rejected', async () => {
  const f = await fixture();
  try {
    await f.cold(); await restoredShare(f);
    const extra = await f.access.grantDirectory(f.id, { root: f.extra, title: 'Synthetic extra', allowWechat: false, confirmation: 'read-task-directory' });
    assert.equal(f.access.canShare(f.id), false); assert.equal(f.access.getState(f.id).contextBlocked, true);
    const extraSource = extra.sources.find(value => value.sourceId !== 'workspace');
    await restoredShare(f); assert.equal(f.access.canShare(f.id), true);
    await f.access.file(f.id, { action: 'read', sourceId: extraSource.sourceId, path: 'extra.txt' });
    assert.equal(f.access.canShare(f.id), false);
    const before = structuredClone(f.record()), resolves = f.ctx.fs.resolved.length;
    await denied(() => f.access.authorizeAutoWorkspace(f.id, f.request), 'share-forbidden');
    assert.deepEqual(f.record(), before); assert.equal(f.ctx.fs.resolved.length, resolves);
  } finally { await f.dispose(); }
});

for (const kind of ['session', 'archive']) test(`a recorded ${kind} source cannot be covered by automatic workspace consent`, async () => {
  const f = await fixture();
  try {
    const table = f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks');
    await table.update(f.id, value => ({ ...value, consumed: [...value.consumed, { sourceId: 'synthetic-other-source', kind, generation: randomUUID() }] }));
    await f.cold();
    const before = structuredClone(f.record()), resolves = f.ctx.fs.resolved.length;
    await denied(() => f.access.authorizeAutoWorkspace(f.id, f.request), 'share-forbidden');
    assert.deepEqual(f.record(), before); assert.equal(f.ctx.fs.resolved.length, resolves);
    assert.equal(f.access.canShare(f.id), false); assert.deepEqual(f.access.getState(f.id).sources, []);
  } finally { await f.dispose(); }
});

test('a changed stored context cannot be treated as the previously prepared history', async () => {
  const f = await fixture();
  try {
    await f.cold();
    const table = f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks');
    await table.update(f.id, value => ({ ...value, consumed: [...value.consumed, { sourceId: 'workspace', kind: 'directory', generation: randomUUID() }] }));
    const before = structuredClone(f.record()), resolves = f.ctx.fs.resolved.length;
    await denied(() => f.access.authorizeAutoWorkspace(f.id, f.request), 'share-forbidden');
    assert.deepEqual(f.record(), before); assert.equal(f.ctx.fs.resolved.length, resolves);
    assert.deepEqual(f.access.getState(f.id).sources, []);
    assert.equal(f.access.canShare(f.id), false);
  } finally { await f.dispose(); }
});

test('SDK support replacement, withdrawal and model invalidation each clear the process-local decision', async () => {
  const f = await fixture();
  try {
    await f.cold(); await restoredShare(f);
    const release = f.access.bindHistorySupport(f.id, () => ({ available: false, ready: false, owner: null, sequence: 0 }));
    assert.equal(f.access.canShare(f.id), false);
    await restoredShare(f); release(); assert.equal(f.access.canShare(f.id), false);
    await restoredShare(f); f.access.invalidateTextModel(f.id); assert.equal(f.access.canShare(f.id), false);
    assert.equal(f.access.getState(f.id).contextBlocked, true);
    assert.deepEqual(f.record(), f.oldRecord);
  } finally { await f.dispose(); }
});

test('cold reconstruction retains facts and never restores the new sharing permission', async () => {
  const f = await fixture();
  try {
    await f.cold(); await restoredShare(f); assert.equal(f.access.canShare(f.id), true);
    await f.cold();
    assert.deepEqual(f.record(), f.oldRecord);
    assert.deepEqual(f.access.getState(f.id).sources, []);
    assert.equal(f.access.getState(f.id).allowWechat, false);
    assert.equal(f.access.getState(f.id).contextBlocked, true);
    share(f); assert.equal(f.access.canShare(f.id), false);
  } finally { await f.dispose(); }
});

test('two Tasks on the same root do not share the retained-history decision', async () => {
  const f = await fixture();
  try {
    await f.cold();
    const otherId = `wechat-task-${randomUUID()}`;
    const other = f.ctx.sessions.create(SessionId(otherId), { meta: { cwd: f.workspace, agentPreset: TASK_PRESET_ID } });
    await f.access.grantWorkspace(otherId, { ...f.request, allowWechat: false });
    await f.access.prepare(otherId, other);
    await f.access.file(otherId, { action: 'read', path: 'history.txt' });
    f.access.revoke(otherId, 'workspace');
    await restoredShare(f);
    assert.equal(f.access.canShare(f.id), true);
    f.access.setSharing(otherId, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(f.access.canShare(otherId), false);
    assert.equal(f.access.getState(otherId).contextBlocked, true);
    assert.deepEqual(f.access.getState(otherId).sources, []);
    assert.deepEqual(f.record(), f.oldRecord);
  } finally { await f.dispose(); }
});

test('a replaced physical directory is rejected before reading and clears its history-sharing decision', async () => {
  const f = await fixture();
  try {
    await f.cold(); await restoredShare(f);
    await rename(f.workspace, join(f.root, 'old-workspace'));
    await mkdir(f.workspace); await writeFile(join(f.workspace, 'history.txt'), 'Synthetic replacement content.');
    const reads = f.ctx.fs.reads.length;
    await denied(() => f.access.file(f.id, { action: 'read', path: 'history.txt' }, undefined, 'wechat'), 'path-rejected');
    assert.equal(f.ctx.fs.reads.length, reads, 'The replacement content never crosses the read boundary');
    assert.equal(f.access.canShare(f.id), false);
    assert.equal(f.access.getState(f.id).contextBlocked, true);
    assert.deepEqual(f.record().workspace, f.oldRecord.workspace);
    assert.deepEqual(f.record().consumed[0], f.oldRecord.consumed[0]);
    assert.equal(f.record().consumed.length, 2, 'The existing read path records the attempted current source before checking its file boundary');
  } finally { await f.dispose(); }
});

for (const action of ['abort', 'revoke']) test(`${action} while directory verification is pending cannot create a late sharing decision`, async () => {
  const f = await fixture();
  try {
    await f.cold();
    const hold = { entered: deferred(), release: deferred() }, controller = new AbortController();
    f.ctx.fs.hold = hold;
    const operation = f.access.authorizeAutoWorkspace(f.id, f.request, controller.signal);
    const rejected = assert.rejects(operation, error => error instanceof TaskAccessError && ['aborted', 'revoked'].includes(error.code));
    await hold.entered.promise;
    if (action === 'abort') controller.abort();
    if (action === 'revoke') f.access.revokeAll(f.id);
    hold.release.resolve(); await rejected;
    assert.equal(f.access.canShare(f.id), false);
    assert.equal(f.access.getState(f.id).contextBlocked, true);
    assert.deepEqual(f.access.getState(f.id).sources, []);
    assert.deepEqual(f.record(), f.oldRecord);
  } finally { await f.dispose(); }
});

test('workspace consent rejects another root and false WeChat authority before granting current access', async () => {
  const f = await fixture();
  try {
    await f.cold();
    const resolves = f.ctx.fs.resolved.length;
    await denied(() => f.access.authorizeAutoWorkspace(f.id, { ...f.request, root: f.extra }), 'share-forbidden');
    await denied(() => f.access.authorizeAutoWorkspace(f.id, { ...f.request, allowWechat: false }), 'share-forbidden');
    assert.equal(f.ctx.fs.resolved.length, resolves);
    assert.deepEqual(f.access.getState(f.id).sources, []);
    assert.deepEqual(f.record(), f.oldRecord);
  } finally { await f.dispose(); }
});
