import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutorPlugin from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { createTaskAccess, TaskAccessError, TASK_PRESET_ID, TASK_CONTEXT_SPEC } from 'dsh-wechat-ro/task-access';
import { createTaskSessionBridge } from 'dsh-wechat-ro/task-session-bridge';
import { createConversationRuntime } from 'dsh-wechat-ro/conversation-controller';
import { hasTaskSessionPolicy, assertTaskSessionHistory } from 'dsh-wechat-ro/task-session-agent';
import { createWeixinApi } from 'dsh-wechat-ro/weixin-api';
import { createWeixinMediaApi } from 'dsh-wechat-ro/weixin-media';
import { createWeixinChannel, validateWeixinState } from 'dsh-wechat-ro/weixin-channel';

const { default: FsLocal } = await import('@deepseek-ai/dsh-fs-local');
const { default: WorkspaceRegistry } = await import('@deepseek-ai/dsh-workspace');
const { default: WorkingDirectory } = await import('@deepseek-ai/dsh-working-directory');
const { default: SessionQuery } = await import('@deepseek-ai/dsh-session-query-sqlite');
const { default: AgentPresets } = await import('@deepseek-ai/dsh-agent-preset-registry');
const { Storage } = await import('@deepseek-ai/dsh-storage');
const JsonStorage = await import('@deepseek-ai/dsh-storage-json');
const StorageDomain = await import('@deepseek-ai/dsh-storage-domain');
const { load: parseYaml } = createRequire(import.meta.resolve('@deepseek-ai/cordis-plugin-loader'))('js-yaml');
const roots = new Set(), contexts = new Set();
const previousFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = () => { networkAttempts++; throw new Error('SYNTHETIC_FORBIDDEN_NETWORK'); };
after(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose();
  for (const root of roots) { assert.ok(root.startsWith(join(tmpdir(), 'wechat-task-sdk-'))); await rm(root, { recursive: true, force: true }); }
  globalThis.fetch = previousFetch;
  assert.equal(networkAttempts, 0);
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class MeteredFileSystem extends FsLocal {
  reads = []; writes = []; resolved = []; holdRead = null;
  async resolve(path, options) { this.resolved.push(path); return super.resolve(path, options); }
  async readBytes(target, signal, limit) {
    this.reads.push(this.processPath(target));
    const bytes = await super.readBytes(target, signal, limit);
    if (this.holdRead) { const hold = this.holdRead; this.holdRead = null; hold.entered.resolve(); await hold.release.promise; }
    return bytes;
  }
  async writeText(...args) { this.writes.push(args[0]); return super.writeText(...args); }
  async editText(...args) { this.writes.push(args[0]); return super.editText(...args); }
}
class MeteredSessionQuery extends SessionQuery {
  exactReads = [];
  async observeSession(id, options) { this.exactReads.push(id); return super.observeSession(id, options); }
}
function* chunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
function* call(name, args, id) {
  const block = { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block };
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
class OfflineAdapter extends LlmAdapter {
  requests = [];
  constructor(script) { super(); this.script = [...script]; }
  providerInfo(provider) { return { id: provider, name: 'Synthetic offline provider' }; }
  async resolveModel(provider, model) { return { provider, id: model, name: 'Synthetic offline model' }; }
  async generate() { throw new Error('Fixture uses only native streaming.'); }
  async *stream(request) {
    this.requests.push(request);
    const next = this.script.shift();
    assert.notEqual(next, undefined, 'Synthetic adapter response exhausted');
    yield* typeof next === 'function' ? next(request) : chunks(next);
  }
}
class NativeSelectionOfflineAdapter extends OfflineAdapter {
  async resolveModel(provider, model) {
    return { ...await super.resolveModel(provider, model), reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } };
  }
}

async function fixture(script = [], Adapter = OfflineAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-task-sdk-'));
  roots.add(root);
  const workspace = join(root, 'workspace'), extra = join(root, 'extra'), forbidden = join(root, 'forbidden');
  for (const path of [workspace, extra, forbidden, join(root, 'node_modules', '@deepseek-ai')]) await mkdir(path, { recursive: true, mode: 0o700 });
  for (const name of ['dsh-agent-preset', 'dsh-agent-tool-presentation', 'dsh-tool-present']) {
    await symlink(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/' + name + '/package.json')), join(root, 'node_modules', '@deepseek-ai', name), 'dir');
  }
  await symlink(fileURLToPath(new URL('../', import.meta.url)), join(root, 'node_modules', 'dsh-wechat-ro'), 'dir');
  const ctx = new Context(); contexts.add(ctx); ctx.baseUrl = pathToFileURL(`${root}/`).href;
  await ctx.plugin(Loader); ctx.loader.builtins.group = Group;
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections); await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime); await ctx.plugin(NativeToolExecutorPlugin); await ctx.plugin(AgentRegistry); await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: root });
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' });
  await ctx.plugin(Storage); await ctx.plugin(JsonStorage, { root: join(root, 'domains') }); await ctx.plugin(StorageDomain, { backend: 'json' });
  await ctx.plugin(MeteredFileSystem, { cwd: root }); await ctx.plugin(WorkingDirectory, { defaultDirectory: root });
  await ctx.plugin(MeteredSessionQuery, { path: ':memory:', openAt: 'never' }); await ctx.plugin(WorkspaceRegistry);
  await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(AgentPresets, { default: 'standard' });
  const adapter = new Adapter(script); ctx.llm.registerAdapter(['synthetic'], adapter);
  const context = ctx.sessions.create(SessionId('synthetic-task-context'), { meta: { cwd: root } });
  const access = createTaskAccess(ctx, { sourceRoot: forbidden });
  const bridges = [], runtimes = [];
  function manualTask() {
    const id = `wechat-task-${randomUUID()}`;
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: workspace, agentPreset: TASK_PRESET_ID } });
    setSandboxMode(session, 'workspace-write');
    return session;
  }
  function grant(id, allowWechat = true) { return access.grantWorkspace(id, { root: workspace, title: 'Synthetic task workspace', allowWechat, confirmation: 'read-and-write-task-workspace' }); }
  async function dispose() {
    for (const runtime of runtimes) await runtime.dispose();
    for (const bridge of bridges) await bridge.dispose();
    await access.dispose(); await ctx.loader.root.update([]); await ctx.fiber.dispose(); contexts.delete(ctx);
    assert.ok(root.startsWith(join(tmpdir(), 'wechat-task-sdk-'))); await rm(root, { recursive: true, force: true }); roots.delete(root);
  }
  return { ctx, root, workspace, extra, forbidden, access, adapter, context, manualTask, grant, bridges, runtimes, dispose };
}
async function executeNativeTool(ctx, { agent, callId, name, arguments: args, signal }) {
  const batch = await ctx.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }] });
  return batch.results[0].result;
}
const rejects = (operation, code) => assert.rejects(Promise.resolve().then(operation), error => { assert.ok(error instanceof TaskAccessError); assert.equal(error.code, code); assert.equal(Object.hasOwn(error, 'cause'), false); return true; });

test('native task starts on the real configured default without manually assigning Agent options', async () => {
  const f = await fixture(['Configured task model reached.']);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'configured-task-model' });
    const task = await nativeTask(f);
    assert.equal(task.agent.options.provider, 'synthetic');
    assert.equal(task.agent.options.model, 'configured-task-model');
    assert.equal(f.access.canShare(task.id), false);
    task.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic native default-route check.' }] }));
    await task.agent.whenIdle(); await f.ctx.sessions.flush(task.agent.session);
    const terminal = task.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason;
    assert.equal(terminal?.kind, 'completed', JSON.stringify(terminal));
    assert.equal(f.adapter.requests.length, 1);
    assert.equal(task.agent.session.requestHeader().config.model, 'configured-task-model');
    assert.ok(task.agent.session.snapshotEvents().some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'Configured task model reached.')));
    assert.equal(task.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed');
    assert.equal(f.access.canShare(task.id), false);
  } finally { await f.dispose(); }
});

test('fresh WeChat task inherits the origin native model choice without changing deployment defaults', async () => {
  const f = await fixture(['Inherited native model reached.'], NativeSelectionOfflineAdapter);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'deployment-default', reasoningEffort: 'max' });
    const model = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() });
    f.ctx.sessionProjections.register({ key: 'modelSelection', stateVersion: 2,
      stateSchema: z.object({ lastUsed: model.nullable(), pending: model.nullable() }),
      init: () => ({ lastUsed: null, pending: null }),
      apply: (state, event) => event.type === 'model/selection' ? { ...state, pending: event.data } : state });
    const selected = { provider: 'synthetic', model: 'origin-native-choice', reasoningEffort: 'high' };
    f.context.append('model/selection', selected);
    const originSequence = f.context.seq;
    const task = await nativeTask(f);
    assert.equal(f.context.seq, originSequence);
    assert.equal(task.agent.options.model, selected.model); assert.equal(task.agent.options.reasoningEffort, selected.reasoningEffort);
    assert.deepEqual(f.ctx.sessionProjections.stateOf(task.agent.session, 'modelSelection').pending, selected);
    assert.deepEqual(task.agent.session.snapshotEvents().filter(event => event.type === 'model/selection').map(event => event.data), [selected]);
    assert.deepEqual(f.ctx.agentDefaultModel.currentSelection(), { provider: 'synthetic', model: 'deployment-default', reasoningEffort: 'max' });
    f.context.append('model/selection', { provider: 'synthetic', model: 'later-origin-choice' });
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(await task.bridge.reply(task.id, 'Synthetic phone input.', { messageId: 'inherited-native-choice-message' }), 'Inherited native model reached.');
    assert.equal(f.adapter.requests.length, 1);
    assert.equal(f.adapter.requests[0].provider, selected.provider); assert.equal(f.adapter.requests[0].model, selected.model);
    assert.equal(f.adapter.requests[0].reasoningEffort, selected.reasoningEffort);
    assert.deepEqual(f.ctx.agentDefaultModel.currentSelection(), { provider: 'synthetic', model: 'deployment-default', reasoningEffort: 'max' });
  } finally { await f.dispose(); }
});

test('native target model changes apply to later WeChat replies after the inherited first choice', async () => {
  const f = await fixture(['First selected model.', 'Next native model.', 'Same model, new effort.'], NativeSelectionOfflineAdapter);
  let releaseSelection;
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'deployment-default' });
    const model = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() });
    f.ctx.sessionProjections.register({ key: 'modelSelection', stateVersion: 2,
      stateSchema: z.object({ lastUsed: model.nullable(), pending: model.nullable() }),
      init: () => ({ lastUsed: null, pending: null }),
      apply: (state, event) => event.type === 'model/selection' ? { ...state, pending: event.data } : state });
    const initial = { provider: 'synthetic', model: 'inherited-native-choice', reasoningEffort: 'high' };
    f.context.append('model/selection', initial);
    f.ctx.llm.registerAdapter(['synthetic-alternate'], f.adapter);
    const task = await nativeTask(f);
    const selection = { current: initial, assembled: undefined };
    releaseSelection = installModelSelection(task.agent.ctx, selection);
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(await task.bridge.reply(task.id, 'First phone input.', { messageId: 'native-first-choice-message' }), 'First selected model.');
    const next = { provider: 'synthetic-alternate', model: 'target-native-choice' };
    task.agent.session.append('model/selection', next); selection.current = next;
    assert.equal(await task.bridge.reply(task.id, 'Second phone input.', { messageId: 'native-next-choice-message' }), 'Next native model.');
    assert.deepEqual(f.adapter.requests.map(request => request.model), [initial.model, next.model]);
    assert.deepEqual(f.adapter.requests.map(request => request.provider), [initial.provider, next.provider]);
    assert.equal(f.adapter.requests[1].reasoningEffort, undefined);
    assert.deepEqual(task.agent.model.current(), next);
    assert.equal(f.ctx.sessionProjections.stateOf(task.agent.session, 'modelSelection').pending, null);
    const effortOnly = { ...next, reasoningEffort: 'high' };
    task.agent.session.append('model/selection', effortOnly); selection.current = effortOnly;
    assert.equal(await task.bridge.reply(task.id, 'Third phone input.', { messageId: 'native-effort-choice-message' }), 'Same model, new effort.');
    assert.equal(f.adapter.requests[2].reasoningEffort, 'high');
    assert.equal(task.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'model-selection').length, 1);
    assert.deepEqual(f.ctx.agentDefaultModel.currentSelection(), { provider: 'synthetic', model: 'deployment-default' });
  } finally { releaseSelection?.(); await f.dispose(); }
});

test('fresh task captures the latest origin model after background allocation and directory setup', async () => {
  const f = await fixture(['Prepared-time native choice reached.']);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'deployment-default' });
    const model = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() });
    f.ctx.sessionProjections.register({ key: 'modelSelection', stateVersion: 2,
      stateSchema: z.object({ lastUsed: model.nullable(), pending: model.nullable() }),
      init: () => ({ lastUsed: null, pending: null }),
      apply: (state, event) => event.type === 'model/selection' ? { ...state, pending: event.data } : state });
    f.context.append('model/selection', { provider: 'synthetic', model: 'origin-before-preparation' });
    const next = { provider: 'synthetic', model: 'origin-at-native-creation' };
    let allocated = 0;
    const task = await nativeTask(f, async id => {
      assert.match(id, /^wechat-task-/u); allocated++;
      assert.equal(f.adapter.requests.length, 0);
      f.context.append('model/selection', next);
    });
    assert.equal(allocated, 1); assert.equal(f.ctx.fs.reads.length, 0);
    assert.deepEqual(task.agent.model.current(), next);
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(await task.bridge.reply(task.id, 'Synthetic new input.', { messageId: 'prepared-model-choice-message' }), 'Prepared-time native choice reached.');
    assert.equal(f.adapter.requests[0].model, next.model);
    assert.deepEqual(f.ctx.agentDefaultModel.currentSelection(), { provider: 'synthetic', model: 'deployment-default' });
  } finally { await f.dispose(); }
});

for (const source of [
  { kind: 'user' },
  { kind: 'wechat-task-weixin', messageId: 'synthetic-foreign-phone-message' },
  { kind: 'model-selection', form: 'notice', summary: 'Synthetic claimed model notice' },
]) test(`ordinary WeChat reply rejects a claimed ${source.kind} message in its own turn`, async () => {
  const f = await fixture(['Synthetic mixed output.']);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'ordinary-offline-model' });
    const task = await nativeTask(f);
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    const foreign = createUserMessage({ source, content: [{ type: 'text', text: 'Synthetic foreign input.' }] });
    let claimed = false;
    task.agent.ctx.on('agent/inbox/claimed', payload => { if (payload.agent === task.agent && payload.message.id === foreign.id) claimed = true; });
    task.agent.send(foreign, 'next-step', false);
    await assert.rejects(task.bridge.reply(task.id, 'Synthetic owner input.', { messageId: 'ordinary-mixed-' + source.kind }), error => error.code === 'not-completed');
    assert.equal(claimed, true); assert.equal(f.adapter.requests.length, 1);
  } finally { await f.dispose(); }
});

test('task cold resume restores its actual recorded model instead of a changed deployment default', async () => {
  const f = await fixture(['First model turn.', 'Resumed model turn.']);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'recorded-task-model' });
    const first = await nativeTask(f);
    first.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic first turn.' }] }));
    await first.agent.whenIdle(); await f.ctx.sessions.flush(first.agent.session);
    assert.equal(first.agent.session.requestHeader().config.model, 'recorded-task-model');
    await first.bridge.dispose();
    f.ctx.get('agentDefaultModel').currentSelection = () => { throw new Error('SYNTHETIC_PRIVATE_DEFAULT_MUST_NOT_BE_READ'); };
    const restored = createTaskSessionBridge(f.ctx, { data: f.access }); f.bridges.push(restored);
    await restored.ensure(first.id);
    const agent = f.ctx.agents.get(SessionId(first.id));
    assert.equal(agent.options.provider, 'synthetic'); assert.equal(agent.options.model, 'recorded-task-model');
    assert.deepEqual(f.access.getState(first.id).sources, []);
    await f.grant(first.id, false);
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic resumed turn.' }] }));
    await agent.whenIdle(); await f.ctx.sessions.flush(agent.session);
    assert.equal(f.adapter.requests.length, 2);
    assert.equal(agent.session.requestHeader().config.model, 'recorded-task-model');
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed');
  } finally { await f.dispose(); }
});

test('task creation copies only the native route and explicit effort, never arbitrary default fields', async () => {
  const f = await fixture();
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'metadata-only-model', reasoningEffort: 'high' });
    const defaults = f.ctx.get('agentDefaultModel'), current = defaults.currentSelection.bind(defaults);
    defaults.currentSelection = () => ({ ...current(), maxTokens: 999999, unsafePermission: true, parentSession: 'foreign' });
    const task = await nativeTask(f);
    assert.equal(task.agent.options.model, 'metadata-only-model'); assert.equal(task.agent.options.reasoningEffort, 'high');
    assert.notEqual(task.agent.options.maxTokens, 999999); assert.equal(task.agent.options.unsafePermission, undefined);
    assert.equal(task.agent.session.header.parentSession, undefined); assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

test('invalid or failing default model selection is redacted before publishing a usable task', async () => {
  for (const choose of [() => ({ provider: 'synthetic', model: '' }), () => ({ provider: '', model: 'model' }),
    () => ({ provider: 'synthetic', model: 'model', reasoningEffort: null }), () => { throw new Error('SYNTHETIC_PRIVATE_MODEL_CONFIG'); }]) {
    const f = await fixture();
    try {
      await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'unused-model' });
      f.ctx.get('agentDefaultModel').currentSelection = choose;
      await assert.rejects(nativeTask(f), error => error.code === 'model-unavailable' && !String(error).includes('SYNTHETIC_PRIVATE'));
      assert.equal(f.adapter.requests.length, 0);
    } finally { await f.dispose(); }
  }
});

test('controlled native pending selection is restored ahead of deployment defaults', async () => {
  const f = await fixture();
  try {
    const model = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() });
    f.ctx.sessionProjections.register({ key: 'modelSelection', stateVersion: 2,
      stateSchema: z.object({ lastUsed: model.nullable(), pending: model.nullable() }),
      init: () => ({ lastUsed: null, pending: null }),
      apply: (state, event) => event.type === 'model/selection' ? { ...state, pending: event.data } : state });
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'creation-choice', reasoningEffort: 'high' });
    const task = await nativeTask(f);
    assert.equal(f.ctx.sessionProjections.stateOf(task.agent.session, 'modelSelection').pending, null);
    assert.equal(task.agent.options.model, 'creation-choice'); assert.equal(task.agent.options.reasoningEffort, 'high');
    assert.equal(f.access.getState(task.id).sessionMayContainData, false);
    task.agent.session.append('model/selection', { provider: 'synthetic', model: 'explicit-next-choice' });
    f.context.append('model/selection', { provider: 'synthetic', model: 'later-origin-choice', reasoningEffort: 'high' });
    await f.ctx.sessions.flush(task.agent.session); await task.bridge.dispose();
    f.ctx.get('agentDefaultModel').currentSelection = () => { throw new Error('SYNTHETIC_PRIVATE_DEFAULT_MUST_NOT_BE_READ'); };
    const restored = createTaskSessionBridge(f.ctx, { data: f.access }); f.bridges.push(restored);
    await restored.ensure(task.id);
    const agent = f.ctx.agents.get(SessionId(task.id));
    assert.equal(agent.options.model, 'explicit-next-choice'); assert.equal(agent.options.reasoningEffort, undefined);
    assert.deepEqual(f.access.getState(task.id).sources, []); assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

test('official host restores persisted model selection without a manually registered projection', async () => {
  const f = await fixture();
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'default-choice' });
    const task = await nativeTask(f);
    task.agent.session.append('model/selection', { provider: 'synthetic', model: 'pending-choice' });
    await f.ctx.sessions.flush(task.agent.session); await task.bridge.dispose();
    const restored = createTaskSessionBridge(f.ctx, { data: f.access }); f.bridges.push(restored);
    await restored.ensure(task.id);
    assert.deepEqual(f.ctx.agents.get(SessionId(task.id)).model.current(), { provider: 'synthetic', model: 'pending-choice' });
    assert.equal(f.adapter.requests.length, 0); assert.equal(f.access.canShare(task.id), false);
  } finally { await f.dispose(); }
});

test('real task constructor accepts managed-history callbacks and rejects invalid freshness configuration', async () => {
  const ctx = new Context();
  const access = createTaskAccess(ctx, { beforeArchiveQuery: async () => {}, archiveFreshness: () => undefined });
  assert.throws(() => createTaskAccess(ctx, { archiveFreshness: true }), error => error.code === 'invalid-options');
  await access.dispose();await ctx.fiber.dispose();
  const f = await fixture();
  try {
    const runtime = createConversationRuntime(f.ctx, { sourceRoot: f.forbidden });f.runtimes.push(runtime);
    assert.equal(runtime.getState({ kind: 'task', sessionId: f.manualTask().id }).available, true, 'Real runtime constructors must initialize the managed-history task subsystem');
  } finally { await f.dispose(); }
});
test('task data constructor/status stay no-I/O; invalid source paths fail before native resolution', async () => {
  const f = await fixture();
  try {
    const before = f.ctx.fs.resolved.length, id = `wechat-task-${randomUUID()}`;
    assert.equal(f.access.getState(id).historyKnown, false);
    assert.equal(f.access.canShare(id), false);
    assert.equal(f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name), undefined);
    assert.equal(f.ctx.fs.resolved.length, before);
    for (const root of [f.forbidden, f.root, '/home/keer/Documents/xwechat_files', join(f.workspace, '.ssh')]) {
      await rejects(() => f.access.grantWorkspace(id, { root, title: 'Denied', allowWechat: true, confirmation: 'read-and-write-task-workspace' }), 'forbidden-root');
    }
    assert.equal(f.ctx.fs.resolved.length, before);
    assert.equal(f.ctx.fs.reads.length, 0);
  } finally { await f.dispose(); }
});

test('task files use real local SDK versions, workspace membership and explicit sharing', async () => {
  const f = await fixture();
  try {
    const session = f.manualTask(), id = session.id;
    await f.grant(id); await f.access.prepare(id, session);
    assert.equal(f.access.canShare(id), false);
    const workspace = f.access.getWorkspace(id);
    await f.ctx.sessions.flush(session);
    await f.ctx.workspaceRegistry.get(workspace.id).attachSession(SessionId(id));
    assert.equal(f.ctx.workspaceRegistry.get(workspace.id).sessionIds.includes(SessionId(id)), true);
    await f.access.file(id, { action: 'create', path: 'report.md', content: 'first synthetic report\r\n' }, undefined, 'local', 0);
    const read = await f.access.file(id, { action: 'read', path: 'report.md' });
    assert.equal(read.text, 'first synthetic report\r\n');
    assert.equal(read.untrusted, true);
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(f.access.canShare(id), true);
    const current = await f.access.file(id, { action: 'read', path: 'report.md' });
    await f.access.file(id, { action: 'edit', reference: current.reference, oldString: 'first', newString: 'second' }, undefined, 'local', 1);
    assert.equal(await readFile(join(f.workspace, 'report.md'), 'utf8'), 'second synthetic report\r\n');
    const delivered = await f.access.inspectDeliverables(id, [{ path: 'report.md' }], undefined, 1);
    assert.equal(delivered[0].bytes, Buffer.byteLength('second synthetic report\r\n'));
    assert.match(delivered[0].sha256, /^[0-9a-f]{64}$/);
    await rejects(() => f.access.inspectDeliverables(id, [{ path: 'report.md' }], undefined, 0), 'not-produced');
    await writeFile(join(f.workspace, 'report.md'), 'externally changed');
    await rejects(() => f.access.inspectDeliverables(id, [{ path: 'report.md' }], undefined, 1), 'file-changed');
  } finally { await f.dispose(); }
});

test('automatic workspace consent preserves the consumed current generation instead of regranting it', async () => {
  const f = await fixture();
  try {
    const session = f.manualTask(), id = session.id;
    await f.grant(id, false); await f.access.prepare(id, session);
    await writeFile(join(f.workspace, 'scope-note.md'), 'Synthetic current-generation text.');
    await f.access.file(id, { action: 'read', path: 'scope-note.md' }, undefined, 'local');
    const table = f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks');
    const before = structuredClone(table.get(id)), reads = f.ctx.fs.reads.length, writes = f.ctx.fs.writes.length;
    const result = await f.access.authorizeAutoWorkspace(id, { root: f.workspace, title: 'Synthetic automatic scope', allowWechat: true, confirmation: 'read-and-write-task-workspace' });
    assert.equal(result.contextBlocked, false); assert.equal(result.sources[0].allowWechat, true);
    assert.deepEqual(table.get(id), before); assert.equal(f.ctx.fs.reads.length, reads); assert.equal(f.ctx.fs.writes.length, writes);
    assert.equal(f.access.canShare(id), false);
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' }); assert.equal(f.access.canShare(id), true);
    f.access.revokeAll(id);
    const restored = await f.access.authorizeAutoWorkspace(id, { root: f.workspace, title: 'Synthetic automatic scope', allowWechat: true, confirmation: 'read-and-write-task-workspace' });
    assert.deepEqual(table.get(id), before); assert.equal(restored.sources.length, 1);
    assert.equal(restored.contextBlocked, false); assert.equal(restored.shareable, false);
    assert.equal(f.access.canShare(id), false);
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(f.access.canShare(id), true);
    assert.deepEqual(table.get(id), before);
  } finally { await f.dispose(); }
});

test('automatic setup lookup verifies directory identity and returns stored exact SIDs without source contents', async () => {
  const f = await fixture();
  try {
    const session = f.manualTask(); await f.grant(session.id); await f.access.prepare(session.id, session);
    const workspace = f.access.getWorkspace(session.id), reads = f.ctx.fs.reads.length, queries = f.ctx.sessionQuery.exactReads.length;
    const candidates = await f.access.findWorkspaceTasks(f.workspace);
    assert.deepEqual(candidates, [{ sessionId: session.id, workspace }]);
    assert.equal(f.ctx.fs.reads.length, reads); assert.equal(f.ctx.sessionQuery.exactReads.length, queries);
    await rejects(() => f.access.findWorkspaceTasks(f.forbidden), 'forbidden-root');
    assert.equal(f.ctx.fs.reads.length, reads);
  } finally { await f.dispose(); }
});

test('task files reject traversal, credential/database paths, symlinks and hardlinks before reading bytes', async () => {
  const f = await fixture();
  try {
    const session = f.manualTask(), id = session.id; await f.grant(id); await f.access.prepare(id, session);
    await writeFile(join(f.forbidden, 'secret.txt'), 'SYNTHETIC_PRIVATE_SOURCE');
    await symlink(join(f.forbidden, 'secret.txt'), join(f.workspace, 'linked.txt'));
    await symlink(f.forbidden, join(f.workspace, 'linked-directory'), 'dir');
    await link(join(f.forbidden, 'secret.txt'), join(f.workspace, 'hardlink.txt'));
    const before = f.ctx.fs.reads.length;
    for (const path of ['../forbidden/secret.txt', '/absolute.txt', 'C:secret.txt', 'linked.txt', 'linked-directory/secret.txt', '.env', 'keys.json', 'messages.db']) {
      await rejects(() => f.access.file(id, { action: 'read', path }), path.startsWith('../') || path.startsWith('/') || path.startsWith('C:') ? 'invalid-request' : 'path-rejected');
    }
    await rejects(() => f.access.file(id, { action: 'read', path: 'hardlink.txt' }), 'not-file');
    assert.equal(f.ctx.fs.reads.length, before);
    assert.equal(f.ctx.fs.resolved.some(path => path.startsWith(f.forbidden)), false);
    const listed = await f.access.file(id, { action: 'list' });
    assert.equal(listed.rows.some(row => row.name.startsWith('linked')), false);
  } finally { await f.dispose(); }
});

test('stale references and output-byte expansion cannot overwrite a changed or oversized file', async () => {
  const f = await fixture();
  try {
    const session = f.manualTask(), id = session.id; await f.grant(id); await f.access.prepare(id, session);
    await writeFile(join(f.workspace, 'small.txt'), 'aa');
    const first = await f.access.file(id, { action: 'read', path: 'small.txt' });
    const writes = f.ctx.fs.writes.length;
    await rejects(() => f.access.file(id, { action: 'edit', reference: first.reference, oldString: 'a', newString: 'x'.repeat(40000), replaceAll: true }, undefined, 'local', 0), 'byte-budget-exceeded');
    assert.equal(f.ctx.fs.writes.length, writes);
    assert.equal(await readFile(join(f.workspace, 'small.txt'), 'utf8'), 'aa');
    await writeFile(join(f.workspace, 'small.txt'), 'changed after read');
    await rejects(() => f.access.file(id, { action: 'write', reference: first.reference, content: 'must not overwrite' }, undefined, 'local', 0), 'file-changed');
    assert.equal(await readFile(join(f.workspace, 'small.txt'), 'utf8'), 'changed after read');
    await writeFile(join(f.workspace, 'large.txt'), 'x'.repeat(65537));
    await rejects(() => f.access.file(id, { action: 'read', path: 'large.txt' }), 'byte-budget-exceeded');
  } finally { await f.dispose(); }
});

test('read-only extra directories remain read-only and revoked generations block all old context sharing', async () => {
  const f = await fixture();
  try {
    const session = f.manualTask(), id = session.id; await f.grant(id); await f.access.prepare(id, session);
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    await writeFile(join(f.extra, 'note.txt'), 'authorized extra data');
    const grant = await f.access.grantDirectory(id, { root: f.extra, title: 'Read-only notes', allowWechat: false, confirmation: 'read-task-directory' });
    const sourceId = grant.sources.find(source => source.root === f.extra).sourceId;
    const read = await f.access.file(id, { action: 'read', sourceId, path: 'note.txt' });
    assert.equal(read.text, 'authorized extra data');
    assert.equal(f.access.canShare(id), false);
    await rejects(() => f.access.file(id, { action: 'write', reference: read.reference, content: 'not allowed' }, undefined, 'local', 0), 'not-granted');
    f.access.revoke(id, sourceId);
    await f.access.grantDirectory(id, { root: f.extra, title: 'New authorized generation', allowWechat: true, confirmation: 'read-task-directory' });
    assert.equal(f.access.getState(id).contextBlocked, true);
    assert.equal(f.access.canShare(id), false);
    assert.equal(f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks').get(id).mayContainData, true);
  } finally { await f.dispose(); }
});

test('revoking an in-flight real SDK read discards its late result and cancels its source signal', async () => {
  const f = await fixture();
  try {
    const session = f.manualTask(), id = session.id; await f.grant(id); await f.access.prepare(id, session);
    await writeFile(join(f.workspace, 'late.txt'), 'late authorized data');
    const entered = deferred(), release = deferred(); f.ctx.fs.holdRead = { entered, release };
    const signal = f.access.contextSignal(id);
    const pending = f.access.file(id, { action: 'read', path: 'late.txt' });
    const rejected = assert.rejects(pending, error => error instanceof TaskAccessError && ['aborted', 'revoked', 'path-rejected'].includes(error.code));
    await entered.promise; f.access.revoke(id, 'workspace'); assert.equal(signal.aborted, true); release.resolve(); await rejected;
    assert.equal(f.access.getState(id).sessionMayContainData, true);
    assert.equal(f.access.canShare(id), false);
  } finally { await f.dispose(); }
});

test('exact native source SID whitelist excludes corpus reads, hidden messages and ungranted sources', async () => {
  const f = await fixture();
  try {
    const session = f.manualTask(), id = session.id; await f.grant(id); await f.access.prepare(id, session);
    const allowed = f.ctx.sessions.create(SessionId('synthetic-approved-source'), { meta: { cwd: f.root } });
    const denied = f.ctx.sessions.create(SessionId('synthetic-ungranted-source'), { meta: { cwd: f.root } });
    allowed.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'approved ordinary source text' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    allowed.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'SYNTHETIC_PRIVATE_RUNTIME' }], source: { kind: 'runtime-context' } }), { surfaceOp: 'append' });
    denied.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'SYNTHETIC_PRIVATE_UNGRANTED' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    const state = f.access.grantSession(id, { sessionId: allowed.id, title: 'Approved source', allowWechat: true, confirmation: 'read-task-session' });
    const sourceId = state.sources.find(source => source.kind === 'session').sourceId;
    const before = f.ctx.sessionQuery.exactReads.length;
    const result = await f.access.query(id, { action: 'session', sourceId });
    assert.equal(result.untrusted, true); assert.equal(result.sourceReadByteBounded, false);
    assert.deepEqual(result.rows.map(row => row.text), ['approved ordinary source text']);
    assert.deepEqual(f.ctx.sessionQuery.exactReads.slice(before), [allowed.id]);
    await rejects(() => f.access.query(id, { action: 'session', sourceId: 'session-' + '0'.repeat(24) }), 'not-granted');
    assert.deepEqual(f.ctx.sessionQuery.exactReads.slice(before), [allowed.id]);
    const status = await f.access.query(id, { action: 'status' });
    assert.equal(JSON.stringify(status).includes(f.workspace), false);
    assert.equal(JSON.stringify(status).includes(allowed.id), false);
  } finally { await f.dispose(); }
});

test('durable task context restores proof but never restores source grants or sharing consent', async () => {
  const f = await fixture();
  let restored;
  try {
    const session = f.manualTask(), id = session.id; await f.grant(id); await f.access.prepare(id, session);
    await writeFile(join(f.workspace, 'history.txt'), 'durable source mark');
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    await f.access.file(id, { action: 'read', path: 'history.txt' });
    assert.equal(f.access.canShare(id), true);
    await f.access.dispose();
    restored = createTaskAccess(f.ctx, { sourceRoot: f.forbidden });
    assert.equal(restored.getState(id).historyKnown, false);
    await restored.prepare(id, session);
    const state = restored.getState(id);
    assert.equal(state.historyKnown, true); assert.equal(state.sessionMayContainData, true);
    assert.deepEqual(state.sources, []); assert.equal(state.allowWechat, false); assert.equal(state.shareable, false); assert.equal(state.contextBlocked, true);
  } finally { await restored?.dispose(); await f.dispose(); }
});

test('cold workspace registry IDs preserve the original Task identity without restoring grants', async () => {
  const f = await fixture();
  let restored, again;
  try {
    const session = f.manualTask(), id = session.id;
    await f.grant(id); await f.access.prepare(id, session);
    const original = f.access.getWorkspace(id);
    const recorded = structuredClone(f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks').get(id));
    await f.access.dispose();
    restored = createTaskAccess(f.ctx, { sourceRoot: f.forbidden });
    await restored.prepare(id, session);
    assert.deepEqual(restored.getState(id).sources, []);
    assert.equal(restored.canShare(id), false);
    const create = f.ctx.workspaceRegistry.create.bind(f.ctx.workspaceRegistry), rebuiltId = randomUUID();
    f.ctx.workspaceRegistry.create = async (...args) => {
      const value = await create(...args);
      return { id: rebuiltId, path: value.path, attachSession: value.attachSession.bind(value) };
    };
    assert.notEqual(rebuiltId, original.id);
    await restored.grantWorkspace(id, { root: f.workspace, title: 'Explicit synthetic regrant', allowWechat: true, confirmation: 'read-and-write-task-workspace' });
    await restored.prepare(id, session);
    const state = restored.getState(id);
    assert.equal(state.workspace.id, original.id);
    assert.equal(state.workspace.root, f.workspace);
    assert.equal(state.historyKnown, true); assert.equal(state.contextBlocked, false);
    assert.equal(state.sources.length, 1); assert.equal(state.sources[0].allowWechat, true);
    assert.equal(state.allowWechat, false); assert.equal(state.shareable, false);
    assert.deepEqual(f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks').get(id), recorded);
    restored.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(restored.canShare(id), true);
    await restored.dispose();
    again = createTaskAccess(f.ctx, { sourceRoot: f.forbidden });
    await again.prepare(id, session);
    assert.equal(again.getWorkspace(id).id, original.id);
    assert.deepEqual(again.getState(id).sources, []);
    assert.equal(again.getState(id).allowWechat, false); assert.equal(again.canShare(id), false);
    assert.equal(f.ctx.fs.reads.length, 0); assert.equal(f.adapter.requests.length, 0);
  } finally { await again?.dispose(); await restored?.dispose(); await f.dispose(); }
});

test('workspace identity reuse preserves consumed generations and fresh whole-context sharing authorizes retained replies', async () => {
  const f = await fixture();
  try {
    const session = f.manualTask(), id = session.id;
    await f.grant(id); await f.access.prepare(id, session);
    const originalId = f.access.getWorkspace(id).id;
    await writeFile(join(f.workspace, 'generation.txt'), 'synthetic consumed generation');
    await f.access.file(id, { action: 'read', path: 'generation.txt' });
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(f.access.canShare(id), true);
    const table = f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks'), recorded = structuredClone(table.get(id));
    const create = f.ctx.workspaceRegistry.create.bind(f.ctx.workspaceRegistry), rebuiltId = randomUUID();
    f.ctx.workspaceRegistry.create = async (...args) => {
      const value = await create(...args);
      return { id: rebuiltId, path: value.path, attachSession: value.attachSession.bind(value) };
    };
    await f.grant(id); await f.access.prepare(id, session);
    assert.equal(f.access.getWorkspace(id).id, originalId);
    assert.equal(f.access.getState(id).contextBlocked, true);
    assert.equal(f.access.canShare(id), false);
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(f.access.canShare(id), true);
    assert.deepEqual(table.get(id), recorded);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

test('workspace identity normalization still rejects another root and conflicting persisted identity', async () => {
  const f = await fixture();
  try {
    const session = f.manualTask(), id = session.id;
    await f.grant(id); await f.access.prepare(id, session);
    const original = f.access.getWorkspace(id), resolved = f.ctx.fs.resolved.length;
    await rejects(() => f.access.grantWorkspace(id, { root: f.extra, title: 'Different root', allowWechat: true, confirmation: 'read-and-write-task-workspace' }), 'path-rejected');
    assert.equal(f.ctx.fs.resolved.length, resolved);
    assert.deepEqual(f.access.getWorkspace(id), original);
    const table = f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks');
    await table.update(id, record => ({ ...record, workspace: { ...record.workspace, id: randomUUID() } }));
    await rejects(() => f.access.prepare(id, session), 'history-unavailable');
    assert.equal(f.access.canShare(id), false);
    assert.equal(f.ctx.fs.reads.length, 0); assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

async function nativeTask(f, onAllocated) {
  const rows = parseYaml(await readFile(new URL('../presets/wechat-task.patch.yml', import.meta.url), 'utf8'))[0].insert;
  await f.ctx.loader.root.update(rows);
  const bridge = createTaskSessionBridge(f.ctx, { data: f.access, timeoutMs: 5000 }); f.bridges.push(bridge);
  const id = await bridge.createConversation(f.context.id, { root: f.workspace, title: 'Synthetic native task', allowWechat: true, confirmation: 'read-and-write-task-workspace' }, undefined, onAllocated);
  return { bridge, id, agent: f.ctx.agents.get(SessionId(id)) };
}

test('existing Task restore reattaches its directory after sidebar registry identity changes', async () => {
  const f = await fixture();
  try {
    const { id, agent, bridge } = await nativeTask(f), original = f.access.getWorkspace(id);
    const registry = f.ctx.workspaceRegistry, entity = registry.get(original.id);
    await entity.detachSession(SessionId(id));
    assert.equal(entity.sessionIds.includes(SessionId(id)), false);
    const list = registry.list.bind(registry), rebuiltId = randomUUID(); let attaches = 0;
    registry.list = () => list().map(value => value.path === original.root ? {
      id: rebuiltId, path: value.path, sessionIds: value.sessionIds,
      async attachSession(sid) { attaches++; await value.attachSession(sid); },
    } : value);
    const state = f.access.getState(id), record = structuredClone(f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks').get(id));
    await bridge.ensure(id);
    assert.equal(attaches, 1); assert.equal(entity.sessionIds.includes(SessionId(id)), true);
    assert.equal(f.ctx.agents.get(SessionId(id)), agent); assert.deepEqual(f.access.getWorkspace(id), original);
    assert.deepEqual(f.access.getState(id).sources, state.sources);
    assert.equal(f.access.canShare(id), state.shareable);
    assert.deepEqual(f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks').get(id), record);
    await bridge.ensure(id); assert.equal(attaches, 1);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

test('explicit continuation keeps one failed native WeChat input and completes one new turn in the same Session', async () => {
  const f = await fixture([function* () { throw new Error('SYNTHETIC_INITIAL_FAILURE'); }, 'Synthetic continued final reply.']);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'failed-run-model' });
    const task = await nativeTask(f), metadata = { messageId: 'synthetic-failed-original' }, text = 'Synthetic original WeChat request.';
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    await assert.rejects(task.bridge.reply(task.id, text, metadata), error => error.code === 'not-completed');
    await task.agent.whenIdle();
    const before = task.agent.session.snapshotEvents(), original = before.find(event => event.type === 'user/message' && event.data.source?.messageId === metadata.messageId);
    assert.ok(original); assert.equal(before.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'error');
    assert.equal(await task.bridge.continueReply(task.id, text, metadata), 'Synthetic continued final reply.');
    await task.agent.whenIdle();
    const after = task.agent.session.snapshotEvents(), inputs = after.filter(event => event.type === 'user/message');
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(inputs.filter(event => event.data.source?.kind === 'wechat-task-weixin' && event.data.source.messageId === metadata.messageId).length, 1);
    const continuation = inputs.filter(event => event.data.source?.kind === 'wechat-task-weixin-continuation');
    assert.equal(continuation.length, 1); assert.equal(continuation[0].data.source.inputId, original.data.id);
    assert.equal(continuation[0].data.source.previousInputId, original.data.id);
    assert.equal(continuation[0].data.source.messageId, metadata.messageId);
    assert.equal(continuation[0].data.content.some(block => block.type === 'text' && block.text.includes(text)), false);
    assert.equal(task.agent.session.id, task.id); assert.equal(f.adapter.requests.length, 2);
    assert.equal(after.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed');
    assert.equal(await f.ctx.sessions.flush(task.agent.session), true);
    await assert.rejects(task.bridge.continueReply(task.id, text, metadata), error => ['not-completed', 'already-processed'].includes(error.code));
    assert.equal(f.adapter.requests.length, 2);
  } finally { await f.dispose(); }
});

test('explicit continuation rejects mismatched, busy, foreign and successful native histories before a model request', async () => {
  const f = await fixture([function* () { throw new Error('SYNTHETIC_INITIAL_FAILURE'); }, 'Synthetic unrelated local result.']);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'failed-run-model' });
    const task = await nativeTask(f), metadata = { messageId: 'synthetic-guard-original' }, text = 'Synthetic original input.';
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    await assert.rejects(task.bridge.continueReply(task.id, text, metadata), error => error.code === 'invalid-input');
    assert.equal(f.adapter.requests.length, 0);
    await assert.rejects(task.bridge.reply(task.id, text, metadata), error => error.code === 'not-completed');
    await task.agent.whenIdle();
    await assert.rejects(task.bridge.continueReply(task.id, 'Changed original input.', metadata), error => error.code === 'invalid-input');
    await assert.rejects(task.bridge.continueReply(task.id, text, { messageId: 'different-original' }), error => error.code === 'invalid-input');
    const foreign = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic local command.' }] });
    task.agent.send(foreign, 'next-turn', false);
    await assert.rejects(task.bridge.continueReply(task.id, text, metadata), error => error.code === 'busy');
    assert.equal(f.adapter.requests.length, 1);
    task.agent.inbox.remove(foreign.id); task.agent.followup(foreign); await task.agent.whenIdle();
    await assert.rejects(task.bridge.continueReply(task.id, text, metadata), error => error.code === 'already-processed');
    assert.equal(f.adapter.requests.length, 2);
  } finally { await f.dispose(); }
  const completed = await fixture(['Synthetic already finished.']);
  try {
    await completed.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'completed-run-model' });
    const task = await nativeTask(completed), metadata = { messageId: 'synthetic-completed-original' };
    completed.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(await task.bridge.reply(task.id, 'Original successful input.', metadata), 'Synthetic already finished.');
    await task.agent.whenIdle();
    await assert.rejects(task.bridge.continueReply(task.id, 'Original successful input.', metadata), error => error.code === 'not-completed');
    assert.equal(completed.adapter.requests.length, 1);
  } finally { await completed.dispose(); }
});

test('cancelled continuation drains its own turn and only another explicit continuation may proceed', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture([function* () { throw new Error('SYNTHETIC_INITIAL_FAILURE'); },
    async function* () { entered.resolve(); await release.promise; yield* chunks('SYNTHETIC_CANCELLED_REPLY'); }, 'Synthetic later explicit reply.']);
  let pending;
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'cancelled-run-model' });
    const task = await nativeTask(f), metadata = { messageId: 'synthetic-cancel-original' }, text = 'Original cancelled retry input.';
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    await assert.rejects(task.bridge.reply(task.id, text, metadata), error => error.code === 'not-completed'); await task.agent.whenIdle();
    const control = new AbortController(); pending = task.bridge.continueReply(task.id, text, metadata, control.signal);
    const rejected = assert.rejects(pending, error => error.code === 'aborted');
    await entered.promise; control.abort();
    await assert.rejects(task.bridge.continueReply(task.id, text, metadata), error => error.code === 'busy');
    release.resolve(); await rejected; await task.agent.whenIdle();
    const before = task.agent.session.snapshotEvents();
    assert.equal(before.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'aborted');
    assert.equal(f.adapter.requests.length, 2);
    assert.equal(await task.bridge.continueReply(task.id, text, metadata), 'Synthetic later explicit reply.');
    const inputs = task.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.messageId === metadata.messageId);
    assert.equal(inputs.filter(event => event.data.source.kind === 'wechat-task-weixin').length, 1);
    assert.equal(inputs.filter(event => event.data.source.kind === 'wechat-task-weixin-continuation').length, 2);
    assert.equal(inputs[2].data.source.previousInputId, inputs[1].data.id);
    assert.equal(f.adapter.requests.length, 3);
  } finally { release.resolve(); await pending?.catch(() => {}); await f.dispose(); }
});

test('continuation may retain completed tool results but never restarts a turn with final assistant output', async () => {
  const f = await fixture([
    () => call('wechat_task_files', { action: 'create', path: 'retained.txt', content: 'Synthetic retained original work.' }, 'synthetic-retained-work'),
    function* () { throw new Error('SYNTHETIC_AFTER_TOOL_FAILURE'); }, 'Synthetic reused original tool result.',
  ]);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'retained-work-model' });
    const task = await nativeTask(f), metadata = { messageId: 'synthetic-tool-original' }, text = 'Create and summarize synthetic work.';
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    await assert.rejects(task.bridge.reply(task.id, text, metadata), error => error.code === 'not-completed'); await task.agent.whenIdle();
    assert.equal(await readFile(join(f.workspace, 'retained.txt'), 'utf8'), 'Synthetic retained original work.');
    assert.equal(await task.bridge.continueReply(task.id, text, metadata), 'Synthetic reused original tool result.');
    assert.equal(task.agent.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data.callId === 'synthetic-retained-work').length, 1);
  } finally { await f.dispose(); }
  const finished = await fixture(['Synthetic final response before local cancellation.']);
  try {
    await finished.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'final-output-model' });
    const task = await nativeTask(finished), metadata = { messageId: 'synthetic-final-aborted' }, text = 'Original final output input.';
    finished.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    task.agent.ctx.on('agent/turn-stopping', () => task.agent.cancel({ kind: 'hook', reason: 'Synthetic cancelled after final output' }, { keepInbox: true }));
    await assert.rejects(task.bridge.reply(task.id, text, metadata), error => error.code === 'not-completed'); await task.agent.whenIdle();
    assert.equal(task.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'aborted');
    await assert.rejects(task.bridge.continueReply(task.id, text, metadata), error => error.code === 'already-processed');
    assert.equal(finished.adapter.requests.length, 1);
  } finally { await finished.dispose(); }
});

test('real SDK channel continuation consumes only the original replying outbox and sends once to its retained WeChat context', async () => {
  const f = await fixture([function* () { throw new Error('SYNTHETIC_INITIAL_FAILURE'); }, 'Synthetic resumed WeChat reply.']);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'channel-resume-model' });
    const task = await nativeTask(f);
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    const auth = { botId: 'synthetic-resume-bot', userId: 'synthetic-resume-owner', botToken: 'SYNTHETIC_NOT_A_CREDENTIAL', baseUrl: 'https://ilinkai.weixin.qq.com' };
    const original = { messageId: 'synthetic-channel-original', fromUserId: auth.userId, toUserId: auth.botId, contextToken: 'synthetic-retained-wechat-context', text: 'Original synthetic phone input.' };
    const remaining = { ...original, messageId: 'synthetic-next-queue', text: 'Next retained input.' };
    let stored = validateWeixinState({ version: 3, revision: 1, sessionId: task.id, credentials: auth, cursor: 'synthetic-retained-cursor', seenMessageIds: [], pending: null,
      queuedBatch: { messages: [original, remaining], received: 2, replied: 0, ignored: 0, duplicates: 0 } });
    const calls = { updates: 0, original: 0, continued: 0, sends: [], accepted: 0 };
    const channel = createWeixinChannel({ enabled: true, sessionId: task.id, beforeSend: () => f.access.canShare(task.id),
      store: { async read() { return stored; }, async commit(expected, next) { assert.equal(expected, stored.revision); stored = validateWeixinState(next); } },
      api: { async requestQrCode() { throw new Error('No login'); }, async getQrStatus() { throw new Error('No login'); },
        async getUpdates() { calls.updates++; throw new Error('No update read'); },
        async sendText(credentials, value) { assert.equal(stored.pending.phase, 'sending'); calls.sends.push({ credentials, value }); return { accepted: true }; } },
      async reply(text, metadata, signal) { calls.original++; return task.bridge.reply(task.id, text, metadata, signal); },
      async resumeReply(text, metadata, signal) { calls.continued++; return task.bridge.continueReply(task.id, text, metadata, signal); },
      onTextAccepted() { calls.accepted++; },
      media: { reply: () => { throw new Error('No media'); }, send: () => { throw new Error('No media'); }, release() {} },
    });
    try {
      await assert.rejects(channel.pollTextOnce(), error => error.code === 'reply-failed'); await task.agent.whenIdle();
      assert.equal(stored.pending.phase, 'replying'); assert.equal((await channel.getStatus()).resumeAvailable, true);
      const result = await channel.resumeTextOnce('continue-unanswered-message');
      assert.deepEqual(result, { received: 2, replied: 1, ignored: 0, duplicates: 0, remaining: 1 });
      assert.equal(calls.original, 1); assert.equal(calls.continued, 1); assert.equal(calls.updates, 0);
      assert.equal(calls.sends.length, 1); assert.equal(calls.accepted, 1);
      assert.equal(calls.sends[0].value.contextToken, original.contextToken); assert.equal(calls.sends[0].value.toUserId, auth.userId);
      assert.equal(calls.sends[0].value.text, 'Synthetic resumed WeChat reply.');
      assert.deepEqual(stored.credentials, auth); assert.equal(stored.cursor, 'synthetic-retained-cursor');
      assert.deepEqual(stored.seenMessageIds, [original.messageId]); assert.deepEqual(stored.queuedBatch.messages, [remaining]); assert.equal(stored.pending, null);
      assert.equal(task.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'wechat-task-weixin').length, 1);
      assert.equal(f.adapter.requests.length, 2);
    } finally { channel.dispose(); }
  } finally { await f.dispose(); }
});

test('cold-restored failed Task preserves native identity and requires current grants before explicit continuation', async () => {
  const f = await fixture([function* () { throw new Error('SYNTHETIC_INITIAL_FAILURE'); }, 'Synthetic cold-restored continuation.']);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'cold-continuation-model' });
    const task = await nativeTask(f), metadata = { messageId: 'synthetic-cold-original' }, text = 'Synthetic cold original input.';
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    await assert.rejects(task.bridge.reply(task.id, text, metadata), error => error.code === 'not-completed'); await task.agent.whenIdle();
    const before = task.agent.session.snapshotEvents();
    await task.bridge.dispose(); assert.equal(f.ctx.agents.get(SessionId(task.id)), undefined);
    const restored = createTaskSessionBridge(f.ctx, { data: f.access, timeoutMs: 5000 }); f.bridges.push(restored);
    await restored.ensure(task.id); assert.equal(f.access.canShare(task.id), false); assert.equal(f.adapter.requests.length, 1);
    await assert.rejects(restored.continueReply(task.id, text, metadata), error => error.code === 'archive-denied');
    assert.equal(f.adapter.requests.length, 1);
    await f.grant(task.id); f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(await restored.continueReply(task.id, text, metadata), 'Synthetic cold-restored continuation.');
    const agent = f.ctx.agents.get(SessionId(task.id)), events = agent.session.snapshotEvents();
    assert.equal(agent.session.id, task.id); assert.equal(agent.session.header.cwd, f.workspace);
    assert.deepEqual(events.slice(0, before.length), before);
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'wechat-task-weixin' && event.data.source.messageId === metadata.messageId).length, 1);
    assert.equal(f.adapter.requests.length, 2);
  } finally { await f.dispose(); }
});

test('continuation captures deliverables only from its completed new turn', async () => {
  const f = await fixture([function* () { throw new Error('SYNTHETIC_INITIAL_FAILURE'); },
    () => call('wechat_task_files', { action: 'create', path: 'continued-report.md', content: 'Synthetic continued document\n' }, 'synthetic-continued-create'),
    () => call('present', { files: [{ path: 'continued-report.md', description: 'Continued synthetic document' }] }, 'synthetic-continued-present'),
    'Synthetic continued document is ready.',
  ]);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'continuation-deliverables-model' });
    const task = await nativeTask(f), metadata = { messageId: 'synthetic-continued-file' }, text = 'Create a synthetic document.';
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    await assert.rejects(task.bridge.reply(task.id, text, metadata), error => error.code === 'not-completed'); await task.agent.whenIdle();
    const result = await task.bridge.continueReplyWithDeliverables(task.id, text, metadata);
    assert.equal(result.text, 'Synthetic continued document is ready.'); assert.equal(result.deliverables.length, 1);
    const completed = task.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1);
    assert.equal(result.deliverables[0].turn, completed.data.turn); assert.equal(completed.data.reason.kind, 'completed');
    assert.equal(result.deliverables[0].fileName, 'continued-report.md');
    assert.equal(await readFile(join(f.workspace, 'continued-report.md'), 'utf8'), 'Synthetic continued document\n');
    f.access.releaseDeliveries(task.id, result.deliverables.map(file => file.reference));
    assert.equal(f.adapter.requests.length, 4);
  } finally { await f.dispose(); }
});

test('automatic connection uses the real SDK native Task, durable text queue and exact workspace identity', { timeout: 15000 }, async () => {
  const f = await fixture(['Synthetic automatic native reply.']);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'automatic-offline-model' });
    const rows = parseYaml(await readFile(new URL('../presets/wechat-task.patch.yml', import.meta.url), 'utf8'))[0].insert;
    await f.ctx.loader.root.update(rows);
    const origin = f.ctx.sessions.create(SessionId('synthetic-automatic-origin'), { meta: { cwd: f.workspace } });
    const bridge = createTaskSessionBridge(f.ctx, { data: f.access, timeoutMs: 5000 }); f.bridges.push(bridge);
    const done = deferred(), botId = 'synthetic-auto-bot-' + randomUUID(), userId = 'synthetic-auto-owner';
    const meter = { qr: 0, scans: 0, sends: 0, updates: 0, completedBeforeSend: false };
    let saved, target;
    const api = {
      async requestQrCode() { meter.qr++; return { qrcode: 'synthetic-auto-qr-token', qrContent: 'SYNTHETIC_AUTO_NOT_REAL_LOGIN' }; },
      async getQrStatus() { meter.scans++; return { status: 'confirmed', credentials: { botId, userId, botToken: 'SYNTHETIC_NOT_A_CREDENTIAL', baseUrl: 'https://ilinkai.weixin.qq.com' } }; },
      async getUpdates(_auth, _cursor, signal) {
        meter.updates++;
        if (meter.updates > 1) await new Promise((_, reject) => {
          const cancel = () => reject(Object.assign(new Error('Synthetic cancelled poll'), { code: 'aborted' }));
          if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
        });
        return { cursor: 'synthetic-auto-cursor', ignored: 0, messages: [{ messageId: 'synthetic-auto-message', fromUserId: userId, toUserId: botId, contextToken: 'synthetic-auto-context', text: 'Synthetic automatic owner text.' }] };
      },
      async sendText(_auth, request) {
        meter.sends++; assert.equal(request.text, 'Synthetic automatic native reply.');
        const agent = f.ctx.agents.get(SessionId(target));
        const events = agent.session.snapshotEvents();
        meter.completedBeforeSend = events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')
          && events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text === request.text));
        assert.equal(meter.completedBeforeSend, true);
        const log = await f.ctx.get('sessionPersistence').resolveCurrentLog(SessionId(target));
        assert.equal(typeof log, 'string');
        const disk = await readFile(log, 'utf8');
        assert.ok(disk.includes('Synthetic automatic native reply.')); return { accepted: true };
      },
    };
    const runtime = createConversationRuntime(f.ctx, { sourceRoot: f.forbidden }, {
      createArchiveAccess: () => ({ async dispose() {} }), createSessionBridge: () => ({ isPrepared: () => false, async dispose() {} }),
      createTaskAccess: () => f.access, createTaskSessionBridge: () => bridge, credentials: {}, fetcher: globalThis.fetch,
      createApi: () => api, createMediaApi: () => ({ async sendMedia() { assert.fail('Automatic text connection cannot upload media'); } }),
      createStateStore(_credentials, id) {
        target = id;
        return { async read() { return saved === undefined ? undefined : structuredClone(saved); }, async commit(expected, next) {
          assert.equal(expected, saved?.revision ?? null); saved = structuredClone(next);
          if (next.seenMessageIds.includes('synthetic-auto-message') && next.pending === null) done.resolve();
        } };
      },
    }); f.runtimes.push(runtime);
    const beforeBodies = [f.ctx.fs.reads.length, f.ctx.fs.writes.length, f.ctx.sessionQuery.exactReads.length];
    assert.equal(runtime.getState({ kind: 'task', sessionId: origin.id }).channel.setup.root, f.workspace);
    assert.equal(f.adapter.requests.length, 0); assert.equal(meter.qr, 0);
    const connected = await runtime.action({ kind: 'task', action: 'connectConversation', contextSessionId: origin.id, expectedDirectory: f.workspace, confirmation: 'connect-own-wechat-auto-reply' });
    assert.equal(connected.ok, true, JSON.stringify(connected)); assert.equal(connected.state.sessionId, target);
    let deadline;
    try {
      await Promise.race([done.promise, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(JSON.stringify({
        meter, modelRequests: f.adapter.requests.length, state: runtime.getState({ kind: 'task', sessionId: target }).channel,
        eventTypes: f.ctx.agents.get(SessionId(target))?.session.snapshotEvents().map(event => event.type),
      }))), 2500); })]);
    } finally { clearTimeout(deadline); }
    const state = runtime.getState({ kind: 'task', sessionId: target });
    assert.equal(state.channel.automaticPolling, true); assert.equal(state.channel.requestAccepted, 1); assert.equal(state.channel.messagingVerified, false);
    assert.equal(f.adapter.requests.length, 1); assert.equal(meter.qr, 1); assert.equal(meter.scans, 1); assert.equal(meter.sends, 1);
    const agent = f.ctx.agents.get(SessionId(target)); assert.equal(agent.session.header.cwd, f.workspace);
    assert.ok(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source?.messageId === 'synthetic-auto-message'));
    const binding = f.ctx.storageDomain.get('wechat_task_bindings_v1').table('contexts').get(origin.id);
    assert.deepEqual(binding, { root: f.workspace, sessionId: target, ready: true });
    const workspace = f.access.getWorkspace(target); assert.equal(workspace.root, f.workspace);
    const again = await runtime.action({ kind: 'task', action: 'connectConversation', contextSessionId: origin.id, expectedDirectory: f.workspace, confirmation: 'connect-own-wechat-auto-reply' });
    assert.equal(again.ok, true); assert.equal(again.state.sessionId, target); assert.equal(f.adapter.requests.length, 1); assert.equal(meter.qr, 1);
    assert.deepEqual(f.access.getWorkspace(target), workspace);
    assert.deepEqual([f.ctx.fs.reads.length, f.ctx.fs.writes.length, f.ctx.sessionQuery.exactReads.length], beforeBodies);
    const stopped = await runtime.action({ kind: 'task', action: 'stopChannel', sessionId: target, confirmation: 'stop-channel' });
    assert.equal(stopped.ok, true); assert.equal(stopped.state.channel.automaticPolling, false); assert.equal(meter.sends, 1);
  } finally { await f.dispose(); }
});

test('metadata-only status exposes capability aliases, not unmarked Owner source names or archive scopes', async () => {
  const f = await fixture();
  try {
    const { id, agent } = await nativeTask(f);
    f.access.grantSession(id, { sessionId: 'synthetic-private-source', title: 'SYNTHETIC_PRIVATE_SOURCE_NAME', allowWechat: false, confirmation: 'read-task-session' });
    const before = { files: f.ctx.fs.reads.length, sessions: f.ctx.sessionQuery.exactReads.length };
    const started = Math.floor(Date.now() / 1000);
    const result = await executeNativeTool(f.ctx, { agent, callId: ToolCallId('synthetic-status-private-scope'), name: 'wechat_task_sources', arguments: { action: 'status' }, signal: new AbortController().signal });
    assert.equal(result.isError, false);
    const clock = JSON.parse(result.content.find(block => block.type === 'text').text).clock;
    assert.ok(clock.nowTs >= started && clock.nowTs <= Math.floor(Date.now() / 1000));
    assert.equal(Date.parse(clock.nowIso), clock.nowTs * 1000);
    assert.equal(clock.timezone, 'Asia/Shanghai'); assert.equal(clock.utcOffsetMinutes, 480);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_SOURCE_NAME'), false);
    assert.equal(JSON.stringify(result).includes('synthetic-private-source'), false);
    assert.equal(f.access.getState(id).sessionMayContainData, false);
    assert.equal(f.ctx.fs.reads.length, before.files); assert.equal(f.ctx.sessionQuery.exactReads.length, before.sessions);
    const status = await f.access.query(id, { action: 'status' });
    assert.ok(status.sources.every(source => Object.keys(source).every(key => ['sourceId', 'kind', 'allowWechat', 'write'].includes(key))));
    assert.equal(f.access.getState(id).sources.find(source => source.kind === 'session').title, 'SYNTHETIC_PRIVATE_SOURCE_NAME');
  } finally { await f.dispose(); }
});

test('scripted phone history request uses current clock, resolved talker and paginated archive citations', async () => {
  const alpha = 'synthetic-gaowei-id', beta = 'synthetic-other-id', base = Math.floor(Date.now() / 1000);
  const toolValue = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content.find(block => block.type === 'text').text);
  let clock, talker, firstPage;
  const f = await fixture([
    () => call('wechat_task_sources', { action: 'status' }, 'history-status'),
    request => {
      clock = toolValue(request).clock;
      assert.equal(clock.timezone, 'Asia/Shanghai');
      assert.ok(Number.isSafeInteger(clock.nowTs));
      return call('wechat_task_sources', { action: 'archive', query: { action: 'contacts', query: '高伟', limit: 10, offset: 0 } }, 'history-contact');
    },
    request => {
      const value = toolValue(request);
      assert.equal(value.rows.length, 1); assert.equal(value.hasMore, false);
      assert.equal(value.rows[0].displayName, '高伟'); talker = value.rows[0].talker;
      assert.equal(talker, alpha);
      return call('wechat_task_sources', { action: 'archive', query: { action: 'messages', talker, fromTs: clock.nowTs - 7 * 86400, toTs: clock.nowTs, limit: 2, offset: 0 } }, 'history-first-page');
    },
    request => {
      firstPage = toolValue(request);
      assert.equal(firstPage.returned, 2); assert.equal(firstPage.hasMore, true);
      return call('wechat_task_sources', { action: 'archive', query: { action: 'messages', talker, fromTs: clock.nowTs - 7 * 86400, toTs: clock.nowTs, limit: 2, offset: firstPage.offset + firstPage.returned } }, 'history-next-page');
    },
    request => {
      const page = toolValue(request), rows = [...firstPage.rows, ...page.rows];
      assert.equal(page.returned, 1); assert.equal(page.hasMore, false);
      assert.deepEqual(rows.map(row => row.content), ['合成测试：周五确认交付', '合成测试：需求已经确认', '合成测试：排期待确认']);
      assert.ok(rows.every(row => row.talker === alpha && row.ts >= clock.nowTs - 7 * 86400 && row.ts <= clock.nowTs));
      assert.equal(page.timezone, 'Asia/Shanghai');
      assert.equal(page.bytes, Buffer.byteLength(JSON.stringify(page), 'utf8'));
      assert.ok(rows.every(row => Date.parse(row.localTime) === row.ts * 1000 && row.localTime.endsWith('+08:00')));
      assert.ok(rows.every(row => /^[0-9a-f]{24}$/.test(row.citation.snapshotRef) && /^[0-9a-f]{32}$/.test(row.citation.recordRef)));
      assert.equal(new Set(rows.map(row => row.citation.recordRef)).size, 3);
      return chunks(rows.map(row => row.content + ' [' + row.citation.snapshotRef + ':' + row.citation.recordRef + ']').join('\n'));
    },
  ]);
  try {
    const root = join(f.root, 'archive');
    for (const name of ['contact', 'message']) await mkdir(join(root, name), { recursive: true, mode: 0o700 });
    let db = new DatabaseSync(join(root, 'contact', 'contact.db'));
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE contact(username TEXT, remark TEXT)');
    db.prepare('INSERT INTO contact VALUES(?,?)').run(alpha, '高伟'); db.prepare('INSERT INTO contact VALUES(?,?)').run(beta, '其他联系人'); db.close();
    db = new DatabaseSync(join(root, 'message', 'message0.db')); db.exec('PRAGMA journal_mode=DELETE');
    for (const [id, rows] of [[alpha, [[1, base - 7 * 86400 - 10, 'SYNTHETIC_OUTSIDE_LAST_SEVEN_DAYS'], [2, base - 300, '合成测试：排期待确认'], [3, base - 200, '合成测试：需求已经确认'], [4, base - 100, '合成测试：周五确认交付'], [5, base + 86400, 'SYNTHETIC_FUTURE_MESSAGE']]], [beta, [[6, base - 100, 'SYNTHETIC_OTHER_CONTACT_BODY']]]]) {
      const table = 'Msg_' + createHash('md5').update(id).digest('hex');
      db.exec('CREATE TABLE "' + table + '"(local_id INTEGER, create_time INTEGER, message_content TEXT, local_type INTEGER)');
      for (const row of rows) db.prepare('INSERT INTO "' + table + '" VALUES(?,?,?,1)').run(...row);
    }
    db.close();
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'history-query-model' });
    const { id, agent, bridge } = await nativeTask(f);
    await f.access.grantSnapshot(id, { root, allConversations: false, talkers: [alpha], fromTs: null, toTs: null, allowWechat: true, confirmation: 'read-decrypted-snapshot' });
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    const reply = await bridge.reply(id, '高伟近7天的内容整理一下', { messageId: 'synthetic-history-phone-input' });
    const events = agent.session.snapshotEvents(), results = events.filter(event => event.type === 'tool/result');
    assert.equal(results.length, 4); assert.equal(f.adapter.requests.length, 5);
    assert.ok(results.every(event => event.data.message.isError === false));
    assert.deepEqual(events.filter(event => event.type === 'tool/call').map(event => { const args = JSON.parse(event.data.arguments); return args.query?.action ?? args.action; }), ['status', 'contacts', 'messages', 'messages']);
    assert.ok(reply.includes('合成测试：周五确认交付'));
    const serialized = JSON.stringify(results);
    for (const marker of ['SYNTHETIC_OUTSIDE_LAST_SEVEN_DAYS', 'SYNTHETIC_FUTURE_MESSAGE', 'SYNTHETIC_OTHER_CONTACT_BODY', root]) assert.equal(serialized.includes(marker), false);
    for (const row of firstPage.rows) assert.ok(reply.includes(row.citation.snapshotRef + ':' + row.citation.recordRef));
    assert.equal(f.access.getState(id).sessionMayContainData, true);
    assertTaskSessionHistory(agent.session);
  } finally { await f.dispose(); }
});

test('managed snapshot refresh keeps granted scope, source generation and sharing after a verified switch', async () => {
  const f = await fixture();
  try {
    const { id } = await nativeTask(f);
    const roots = [join(f.root, 'managed-first'), join(f.root, 'managed-next')];
    for (const [index, root] of roots.entries()) {
      await mkdir(join(root, 'contact'), { recursive: true }); await mkdir(join(root, 'message'), { recursive: true });
      let db = new DatabaseSync(join(root, 'contact/contact.db'));
      db.exec('CREATE TABLE contact(username TEXT, remark TEXT)');db.prepare('INSERT INTO contact VALUES(?,?)').run('managed-contact', 'Managed');db.close();
      db = new DatabaseSync(join(root, 'message/message.db'));
      const table='Msg_'+createHash('md5').update('managed-contact').digest('hex');
      db.exec('CREATE TABLE "'+table+'"(local_id INTEGER,create_time INTEGER,message_content TEXT,local_type INTEGER)');
      db.prepare('INSERT INTO "'+table+'" VALUES(?,?,?,1)').run(1,100,index?'updated':'original');db.close();
    }
    await f.access.grantSnapshot(id,{root:roots[0],allConversations:false,talkers:['managed-contact'],fromTs:90,toTs:110,allowWechat:true,confirmation:'read-decrypted-snapshot'});
    f.access.setSharing(id,{allowWechat:true,confirmation:'share-whole-task-context'});
    const before=f.access.getState(id);await f.access.query(id,{action:'archive',query:{action:'messages',talker:'managed-contact'}});
    await f.access.refreshSnapshot(id,roots[1]);
    assert.equal(f.access.canShare(id),true);
    assert.deepEqual(f.access.getState(id).sources.find(s=>s.kind==='archive').archive.talkers,['managed-contact']);
    const page=await f.access.query(id,{action:'archive',query:{action:'messages',talker:'managed-contact'}},undefined,'wechat');
    assert.equal(page.rows[0].content,'updated');
    assert.equal(f.access.getState(id).sources.length,before.sources.length);
    await assert.rejects(()=>f.access.refreshSnapshot(id,join(f.root,'missing')));
    assert.equal((await f.access.query(id,{action:'archive',query:{action:'messages',talker:'managed-contact'}})).rows[0].content,'updated');
  } finally { await f.dispose(); }
});

async function archiveQueryBudgetFixture(f) {
  const root = join(f.root, 'archive-query-budget'), alpha = 'synthetic-budget-alpha';
  await mkdir(join(root, 'contact'), { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'message'), { recursive: true, mode: 0o700 });
  const contacts = new DatabaseSync(join(root, 'contact/contact.db'));
  contacts.exec('PRAGMA journal_mode=DELETE; CREATE TABLE contact(username TEXT, remark TEXT)');
  contacts.exec('BEGIN');
  const insert = contacts.prepare('INSERT INTO contact VALUES(?,?)');
  for (let index = 0; index < 5001; index++) insert.run(index === 0 ? alpha : 'synthetic-budget-unrelated-' + index,
    index === 0 ? '高伟' : 'Synthetic unrelated ' + index);
  contacts.exec('COMMIT');
  contacts.close();
  const messages = new DatabaseSync(join(root, 'message/message0.db'));
  const table = 'Msg_' + createHash('md5').update(alpha).digest('hex');
  messages.exec('PRAGMA journal_mode=DELETE; CREATE TABLE "' + table + '"(local_id INTEGER, create_time INTEGER, message_content TEXT, local_type INTEGER)');
  messages.prepare('INSERT INTO "' + table + '" VALUES(?,?,?,1)').run(1, 1700000000, 'SYNTHETIC_SCOPED_ARCHIVE_MESSAGE');
  messages.close();
  return { root, alpha, grant: { root, allConversations: true, talkers: [], fromTs: null, toTs: null, allowWechat: true, confirmation: 'read-decrypted-snapshot' } };
}

test('native archive budget errors remain resource errors and allow a scoped retry', async () => {
  const f = await fixture();
  try {
    const { id, agent } = await nativeTask(f), archive = await archiveQueryBudgetFixture(f);
    await f.access.grantSnapshot(id, archive.grant);
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    const execute = (callId, query) => executeNativeTool(f.ctx, { agent, callId: ToolCallId(callId), name: 'wechat_task_sources',
      arguments: { action: 'archive', query }, signal: new AbortController().signal });
    const failed = await execute('synthetic-budget-native', { action: 'search', query: 'SYNTHETIC_SCOPED_ARCHIVE_MESSAGE' });
    assert.equal(failed.isError, true);
    const errorText = failed.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert.ok(errorText.includes('read budget'));
    assert.equal(errorText.includes('not explicitly authorized'), false);
    assert.equal(errorText.includes(archive.root), false);
    assert.equal(f.access.canShare(id), true);
    const retry = await execute('synthetic-budget-scoped', { action: 'search', talker: archive.alpha,
      query: 'SYNTHETIC_SCOPED_ARCHIVE_MESSAGE', fromTs: 1699999999, toTs: 1700000001 });
    assert.equal(retry.isError, false);
    const value = JSON.parse(retry.content.find(block => block.type === 'text').text);
    assert.equal(value.returned, 1); assert.equal(value.rows[0].content, 'SYNTHETIC_SCOPED_ARCHIVE_MESSAGE');
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

test('archive queries preserve cold workspace sharing on failure and mark only successful returned data', async () => {
  const f = await fixture();
  const restored = createTaskAccess(f.ctx, { sourceRoot: f.forbidden });
  try {
    const session = f.manualTask(), id = session.id, archive = await archiveQueryBudgetFixture(f);
    await f.grant(id, true); await f.access.prepare(id, session);
    await writeFile(join(f.workspace, 'consumed-archive-history.md'), 'SYNTHETIC_OLD_WORKSPACE_HISTORY');
    await f.access.file(id, { action: 'read', path: 'consumed-archive-history.md' });
    const oldRecord = structuredClone(f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks').get(id));
    await f.access.dispose(); await restored.prepare(id, session);
    await restored.grantSnapshot(id, archive.grant);
    await restored.authorizeAutoWorkspace(id, { root: f.workspace, title: 'Synthetic restored workspace', allowWechat: true, confirmation: 'read-and-write-task-workspace' });
    restored.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(restored.canShare(id), true);
    const table = f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks'), before = structuredClone(table.get(id));
    const signal = restored.contextSignal(id);
    await rejects(() => restored.query(id, { action: 'archive', query: { action: 'search', query: '高伟' } }, undefined, 'wechat'), 'query-budget-exceeded');
    assert.deepEqual(table.get(id), before, 'A failed worker never returns archive content to the Task');
    assert.equal(restored.canShare(id), true); assert.equal(signal.aborted, false);
    const page = await restored.query(id, { action: 'archive', query: { action: 'messages', talker: archive.alpha } }, undefined, 'wechat');
    assert.equal(page.rows[0].content, 'SYNTHETIC_SCOPED_ARCHIVE_MESSAGE');
    assert.deepEqual(table.get(id).consumed[0], oldRecord.consumed[0]);
    assert.equal(table.get(id).consumed.filter(item => item.kind === 'archive').length, 1);
    assert.equal(restored.canShare(id), true); assert.equal(signal.aborted, false);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await restored.dispose(); await f.dispose(); }
});



test('fresh whole-task sharing covers retained archive replies after cold restore without changing consumed generations', async () => {
  const f = await fixture(), restored = createTaskAccess(f.ctx, { sourceRoot: f.forbidden });
  try {
    const session = f.manualTask(), id = session.id, archive = await archiveQueryBudgetFixture(f);
    await f.grant(id, true); await f.access.prepare(id, session); await f.access.grantSnapshot(id, archive.grant);
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    await f.access.query(id, { action: 'archive', query: { action: 'messages', talker: archive.alpha } }, undefined, 'wechat');
    const before = structuredClone(f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks').get(id));
    const archiveGeneration = before.consumed.find(item => item.kind === 'archive').generation;
    await f.access.dispose(); await restored.prepare(id, session);
    const table = f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks');
    assert.equal(restored.canShare(id), false); assert.deepEqual(restored.getState(id).sources, []);
    await restored.grantWorkspace(id, { root: f.workspace, title: 'Explicit restored workspace', allowWechat: true, confirmation: 'read-and-write-task-workspace' });
    await restored.grantSnapshot(id, { ...archive.grant, allowWechat: false });
    restored.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(restored.canShare(id), false, 'A current source that rejects WeChat cannot authorize old derived replies');
    await restored.grantSnapshot(id, archive.grant);
    assert.equal(restored.canShare(id), false, 'Regrant does not replace the whole-context confirmation');
    restored.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(restored.canShare(id), true); assert.equal(restored.getState(id).contextBlocked, false);
    assert.deepEqual(table.get(id), before);
    restored.setSharing(id, { allowWechat: false, confirmation: 'share-whole-task-context' });
    assert.equal(restored.canShare(id), false); assert.equal(restored.getState(id).contextBlocked, true);
    restored.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(restored.canShare(id), true);
    const page = await restored.query(id, { action: 'archive', query: { action: 'messages', talker: archive.alpha } }, undefined, 'wechat');
    assert.equal(page.rows[0].content, 'SYNTHETIC_SCOPED_ARCHIVE_MESSAGE');
    assert.equal(restored.canShare(id), true);
    assert.equal(table.get(id).consumed.find(item => item.kind === 'archive').generation, archiveGeneration);
    assert.equal(table.get(id).consumed.filter(item => item.kind === 'archive').length, 2);
    const beforeScopeChange = structuredClone(table.get(id));
    const sourceSignal = restored.contextSignal(id);
    await restored.grantSnapshot(id, { ...archive.grant, allConversations: false, talkers: [archive.alpha], fromTs: 1700000000, toTs: 1700000000 });
    assert.equal(sourceSignal.aborted, true);
    assert.equal(restored.canShare(id), false, 'A new source object does not inherit the older whole-context decision');
    assert.deepEqual(table.get(id), beforeScopeChange);
    restored.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(restored.canShare(id), true);
    await rejects(() => restored.query(id, { action: 'archive', query: { action: 'messages', talker: 'synthetic-budget-unrelated-1' } }, undefined, 'wechat'), 'source-failed');
    assert.deepEqual(table.get(id), beforeScopeChange, 'Whole-context sharing does not enlarge current archive read scope');
    restored.revoke(id, 'archive');
    assert.equal(restored.canShare(id), false); assert.equal(restored.getState(id).contextBlocked, true);
    restored.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(restored.canShare(id), false, 'Missing current source is not restored by whole-context sharing');
    assert.equal(f.adapter.requests.length, 0);
  } finally { await restored.dispose(); await f.dispose(); }
});

test('native Task archive wrapper enforces contact/time scope and records consumption before tool results', async () => {
  const f = await fixture();
  try {
    const root = join(f.root, 'archive'), alpha = 'synthetic-archive-alpha', beta = 'synthetic-archive-beta', base = 1700000000;
    for (const name of ['contact', 'session', 'message']) await mkdir(join(root, name), { recursive: true, mode: 0o700 });
    let db = new DatabaseSync(join(root, 'contact', 'contact.db'));
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE contact(username TEXT, remark TEXT, nick_name TEXT, alias TEXT)');
    db.prepare('INSERT INTO contact VALUES(?,?,?,?)').run(alpha, 'SYNTHETIC_PRIVATE_ARCHIVE_NAME', '', '');
    db.prepare('INSERT INTO contact VALUES(?,?,?,?)').run(beta, 'Synthetic other contact', '', ''); db.close();
    db = new DatabaseSync(join(root, 'session', 'session.db'));
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE SessionTable(username TEXT, last_timestamp INTEGER, summary TEXT)');
    db.prepare('INSERT INTO SessionTable VALUES(?,?,?)').run(alpha, base + 5, 'Synthetic summary'); db.close();
    db = new DatabaseSync(join(root, 'message', 'message0.db')); db.exec('PRAGMA journal_mode=DELETE');
    for (const [talker, messages] of [[alpha, [[1, base - 1, 'SYNTHETIC_OUTSIDE_DATE'], [2, base + 5, 'SYNTHETIC_TASK_ARCHIVE_ALLOWED'], [3, base + 11, 'SYNTHETIC_AFTER_DATE']]], [beta, [[4, base + 5, 'SYNTHETIC_OTHER_CONTACT']]]]) {
      const table = 'Msg_' + createHash('md5').update(talker).digest('hex');
      db.exec('CREATE TABLE "' + table + '"(local_id INTEGER, create_time INTEGER, message_content TEXT, local_type INTEGER)');
      const insert = db.prepare('INSERT INTO "' + table + '" VALUES(?,?,?,1)');
      for (const row of messages) insert.run(...row);
    }
    db.close();
    const { id, agent } = await nativeTask(f);
    await f.access.grantSnapshot(id, { root, allConversations: false, talkers: [alpha], fromTs: base, toTs: base + 10, allowWechat: false, confirmation: 'read-decrypted-snapshot' });
    const status = await f.access.query(id, { action: 'status' });
    assert.equal(JSON.stringify(status).includes(alpha), false);
    assert.equal(f.access.getState(id).sessionMayContainData, false);
    const outcome = await executeNativeTool(f.ctx, { agent, callId: ToolCallId('synthetic-native-task-archive'), name: 'wechat_task_sources',
      arguments: { action: 'archive', sourceId: 'workspace', limit: 50, offset: 0, query: { action: 'messages', talker: alpha, limit: 2, offset: 0 } }, signal: new AbortController().signal });
    assert.equal(outcome.isError, false);
    const serialized = JSON.stringify(outcome);
    assert.ok(serialized.includes('SYNTHETIC_TASK_ARCHIVE_ALLOWED'));
    for (const secret of ['SYNTHETIC_OTHER_CONTACT', 'SYNTHETIC_OUTSIDE_DATE', 'SYNTHETIC_AFTER_DATE', root]) assert.equal(serialized.includes(secret), false);
    assert.equal(f.access.getState(id).sessionMayContainData, true);
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(f.access.canShare(id), false);
    await rejects(() => f.access.query(id, { action: 'archive', query: { action: 'messages', talker: alpha } }, undefined, 'wechat'), 'share-forbidden');
    f.access.revoke(id, 'archive');
    assert.equal(f.access.getState(id).contextBlocked, true);
    await f.access.grantSnapshot(id, { root, allConversations: false, talkers: [alpha], fromTs: base, toTs: base + 10, allowWechat: true, confirmation: 'read-decrypted-snapshot' });
    assert.equal(f.access.canShare(id), false); assert.equal(f.access.getState(id).contextBlocked, true);
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(f.access.canShare(id), true);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

test('native task final guard rejects scoped foreign tools and data references from another task', async () => {
  const f = await fixture();
  try {
    const first = await nativeTask(f), second = await nativeTask(f);
    let executed = 0;
    const release = first.agent.ctx.get('tools').register({ name: 'synthetic_foreign_task_tool', description: 'Synthetic forbidden scoped tool',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute() { executed++; return 'must not execute'; } });
    try {
      const result = await executeNativeTool(f.ctx, { agent: first.agent, callId: ToolCallId('synthetic-foreign-task-call'), name: 'synthetic_foreign_task_tool', arguments: {}, signal: new AbortController().signal });
      assert.equal(result.isError, true); assert.equal(executed, 0);
    } finally { release(); }
    await writeFile(join(f.workspace, 'cross-task.txt'), 'first task source');
    const reference = await f.access.file(first.id, { action: 'read', path: 'cross-task.txt' });
    const writes = f.ctx.fs.writes.length;
    await rejects(() => f.access.file(second.id, { action: 'write', reference: reference.reference, content: 'must not write' }, undefined, 'local', 0), 'file-changed');
    assert.equal(f.ctx.fs.writes.length, writes);
    f.access.setSharing(second.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    assert.equal(f.access.canShare(second.id), true);
    f.access.revoke(second.id, 'workspace');
    assert.equal(f.access.canShare(second.id), false);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

test('native executor excludes late scoped tools without filtering ordinary agents', async () => {
  const f = await fixture(['Ordinary before.', 'Controlled task.', 'Ordinary after.']);
  let ordinary;
  const releases = [];
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'scoped-model' });
    const definition = name => ({ name, description: 'Synthetic scoped capability', parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute() { throw new Error('Must not execute'); } });
    releases.push(f.ctx.tools.register(definition('synthetic_shared_tool')));
    const { agent } = await nativeTask(f);
    ordinary = await f.ctx.agents.create({ sessionId: SessionId('synthetic-ordinary-model'), meta: { cwd: f.root }, agentOptions: { provider: 'synthetic', model: 'ordinary-model' } });
    const extras = ['interrupt_agent', 'list_agents', 'send_message', 'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'wait_agent'];
    for (const name of extras) releases.push(agent.ctx.get('tools').register(definition(name)));
    releases.push(agent.ctx.get('systemPrompt').context({ name: 'team:identity', order: 600, required: true,
      text: 'You are the Team Lead named "lead". Use list_agents({}) and send_message to contact teammates.' }));
    releases.push(agent.ctx.get('systemPrompt').context({ name: 'synthetic:safety', order: 100, text: 'SYNTHETIC_SAFETY_CONTEXT' }));
    assert.ok(extras.every(name => f.ctx.tools.schemas(scopeOf(agent.ctx)).some(tool => tool.name === name)));
    for (const target of [ordinary.agent, agent, ordinary.agent]) {
      target.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic scoped presentation check.' }] }));
      await target.whenIdle(); await f.ctx.sessions.flush(target.session);
    }
    assert.equal(f.adapter.requests.length, 3);
    assert.deepEqual(f.adapter.requests[1].tools.map(tool => tool.name), ['present', 'wechat_task_files', 'wechat_task_sources']);
    assert.deepEqual(agent.session.requestHeader().tools.map(tool => tool.name), ['present', 'wechat_task_files', 'wechat_task_sources']);
    const system = JSON.stringify(f.adapter.requests[1].messages.filter(message => message.role === 'system'));
    assert.match(system, /Only wechat_task_sources, wechat_task_files and present are permitted/);
    assert.match(system, /Native Team identity is host status, not permission to delegate or message agents/);
    assert.match(JSON.stringify(f.adapter.requests[1].messages), /SYNTHETIC_SAFETY_CONTEXT/);
    assertTaskSessionHistory(agent.session);
    for (const index of [0, 2]) assert.deepEqual(f.adapter.requests[index].tools.map(tool => tool.name), ['synthetic_shared_tool']);
    assert.equal(f.ctx.fs.reads.length, 0);
  } finally { for (const release of releases.reverse()) release(); await ordinary?.dispose(); await f.dispose(); }
});

test('native model all-action fields support read create and present without weakening the strict data API', async () => {
  const filled = { action: 'read', content: '', limit: 100, newString: '', oldString: '', path: 'input.json', reference: '', replaceAll: false, sourceId: 'workspace' };
  const content = '# Synthetic action contract\n\nSYNTHETIC_ACTION_INPUT\n';
  const reference = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content.find(block => block.type === 'text').text).reference;
  const f = await fixture([
    () => call('wechat_task_files', filled, 'filled-read'),
    () => call('wechat_task_files', { ...filled, action: 'create', path: 'result.md', content }, 'filled-create'),
    () => call('wechat_task_files', { ...filled, path: 'result.md' }, 'filled-read-created'),
    request => call('wechat_task_files', { ...filled, action: 'write', reference: reference(request), content: content.replace('Synthetic action contract', 'Draft action contract') }, 'filled-write'),
    () => call('wechat_task_files', { ...filled, path: 'result.md' }, 'filled-read-written'),
    request => call('wechat_task_files', { ...filled, action: 'edit', reference: reference(request), oldString: 'Draft action contract', newString: 'Synthetic action contract' }, 'filled-edit'),
    () => call('wechat_task_files', { ...filled, action: 'list', path: undefined }, 'filled-list'),
    () => call('wechat_task_files', { ...filled, action: 'attach', path: 'result.md' }, 'filled-attach'),
    () => call('present', { files: [{ path: 'result.md', description: 'Synthetic action contract document' }] }, 'filled-present'),
    'Synthetic document ready.',
  ]);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'filled-arguments-model' });
    const { id, agent } = await nativeTask(f);
    const input = '{"marker":"SYNTHETIC_ACTION_INPUT"}\n';
    await writeFile(join(f.workspace, 'input.json'), input);
    const schema = f.ctx.tools.get('wechat_task_files', scopeOf(agent.ctx)).parameters;
    assert.deepEqual(Object.keys(filled).sort(), Object.keys(schema.properties).sort());
    await rejects(() => f.access.file(id, filled), 'invalid-request');
    const reads = f.ctx.fs.reads.length;
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the synthetic input, create result.md and present it.' }] }));
    await agent.whenIdle(); await f.ctx.sessions.flush(agent.session);
    const events = agent.session.snapshotEvents(), results = events.filter(event => event.type === 'tool/result');
    assert.equal(results.length, 9);
    const actions = events.filter(event => event.type === 'tool/call' && event.data.name === 'wechat_task_files').map(event => JSON.parse(event.data.arguments).action);
    assert.deepEqual([...new Set(actions)].sort(), schema.properties.action.enum.filter(action => action !== 'analyze').sort());
    for (const result of results) assert.equal(result.data.message.isError, false, JSON.stringify(result.data.message.content));
    assert.ok(JSON.stringify(results[0]).includes('SYNTHETIC_ACTION_INPUT'));
    assert.ok(f.ctx.fs.reads.length > reads);
    assert.equal(await readFile(join(f.workspace, 'input.json'), 'utf8'), input);
    assert.equal(await readFile(join(f.workspace, 'result.md'), 'utf8'), content);
    const declarations = events.filter(event => event.type === 'deliverables/presented');
    assert.equal(declarations.length, 1); assert.equal(declarations[0].data.files.length, 1);
    assert.equal(declarations[0].data.files[0].path, join(f.workspace, 'result.md'));
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed');
    assert.equal(f.adapter.requests.length, 10); assert.equal(f.access.canShare(id), false);
    assertTaskSessionHistory(agent.session);
  } finally { await f.dispose(); }
});

test('native action normalization rejects unknown or invalid relevant fields as input errors before data I/O', async () => {
  const f = await fixture();
  try {
    const { id, agent } = await nativeTask(f);
    const filled = { action: 'status', sourceId: 'workspace', query: 'unused source search', limit: 20, offset: 0, talker: '', localId: '', ts: 0 };
    const schema = f.ctx.tools.get('wechat_task_sources', scopeOf(agent.ctx)).parameters;
    assert.deepEqual(Object.keys(filled).sort(), Object.keys(schema.properties).sort());
    await rejects(() => f.access.query(id, filled), 'invalid-request');
    const before = { reads: f.ctx.fs.reads.length, writes: f.ctx.fs.writes.length, resolved: f.ctx.fs.resolved.length, sessions: f.ctx.sessionQuery.exactReads.length };
    const execute = (name, args) => executeNativeTool(f.ctx, { agent, callId: ToolCallId(`input-contract-${randomUUID()}`), name, arguments: args, signal: new AbortController().signal });
    const status = await execute('wechat_task_sources', filled);
    assert.equal(status.isError, false);
    for (const [name, args] of [
      ['wechat_task_files', { action: 'read', path: 'input.json', sessionId: 'foreign-session' }],
      ['wechat_task_files', { action: 'read', path: '../outside.txt' }],
      ['wechat_task_files', { action: 'read', path: 42 }],
      ['wechat_task_files', { action: 'write', reference: 'not-a-read-reference', content: 'test' }],
      ['wechat_task_files', { action: 'create', path: 'output.md', content: {} }],
      ['wechat_task_files', { action: 'delete', path: 'output.md' }],
      ['wechat_task_sources', { action: 'status', root: 'ungranted' }],
      ['wechat_task_sources', { action: 'session', sourceId: 'workspace', limit: 0 }],
      ['wechat_task_sources', { action: 'archive', query: { action: 'search', sql: 'not accepted' } }],
    ]) {
      const result = await execute(name, args);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /The task data request is invalid/);
      assert.doesNotMatch(JSON.stringify(result.content), /Archive access or sharing/);
    }
    assert.deepEqual({ reads: f.ctx.fs.reads.length, writes: f.ctx.fs.writes.length, resolved: f.ctx.fs.resolved.length, sessions: f.ctx.sessionQuery.exactReads.length }, before);
    assert.equal(f.access.getState(id).sessionMayContainData, false);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

test('native environment changes close the task before any forbidden cwd resolution', async () => {
  const f = await fixture();
  try {
    const cwdTask = await nativeTask(f), modeTask = await nativeTask(f);
    const before = f.ctx.fs.resolved.length;
    cwdTask.agent.session.append('working-directory/change', { cwd: '/home/keer/Documents/xwechat_files' });
    assert.throws(() => assertTaskSessionHistory(cwdTask.agent.session), error => error.code === 'unsafe-session');
    assert.equal(cwdTask.bridge.isPrepared(cwdTask.id), false);
    assert.equal(f.access.getState(cwdTask.id).sources.length, 0);
    const result = await executeNativeTool(f.ctx, { agent: cwdTask.agent, callId: ToolCallId('synthetic-bad-cwd-call'), name: 'wechat_task_files', arguments: { action: 'read', path: 'source.txt' }, signal: new AbortController().signal });
    assert.equal(result.isError, true);
    assert.equal(f.ctx.fs.resolved.length, before);
    setSandboxMode(modeTask.agent.session, 'danger-full-access');
    assert.equal(modeTask.bridge.isPrepared(modeTask.id), false);
    assert.equal(f.access.getState(modeTask.id).sources.length, 0);
    assert.equal(hasTaskSessionPolicy(modeTask.agent), false);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

test('native task restore and GUI borrow retain policy without restoring grants or owning the GUI handle', async () => {
  const f = await fixture();
  let guiHandle;
  try {
    const first = await nativeTask(f), id = first.id;
    await first.bridge.dispose();
    assert.equal(f.ctx.agents.get(SessionId(id)), undefined);
    const restored = createTaskSessionBridge(f.ctx, { data: f.access }); f.bridges.push(restored);
    await restored.ensure(id);
    assert.equal(restored.isPrepared(id), true);
    assert.deepEqual(f.access.getState(id).sources, []);
    assert.equal(f.access.getState(id).allowWechat, false);
    assert.equal(f.access.canShare(id), false);
    await restored.dispose();
    guiHandle = await f.ctx.agents.resume({ resumeSessionId: SessionId(id), setup: async agentCtx => { await f.ctx.agentPresets.mount(agentCtx, TASK_PRESET_ID); } });
    assert.equal(hasTaskSessionPolicy(guiHandle.agent), true);
    const borrowed = createTaskSessionBridge(f.ctx, { data: f.access }); f.bridges.push(borrowed);
    await borrowed.ensure(id); assert.equal(borrowed.isPrepared(id), true);
    await borrowed.dispose();
    assert.equal(f.ctx.agents.get(SessionId(id)), guiHandle.agent);
    assert.equal(hasTaskSessionPolicy(guiHandle.agent), true);
    assert.deepEqual(f.access.getState(id).sources, []);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await guiHandle?.dispose(); await f.dispose(); }
});

test('a global present definition cannot substitute for the task preset native declaration', async () => {
  const f = await fixture();
  try {
    const nativePresent = await import('@deepseek-ai/dsh-tool-present');
    await f.ctx.plugin(nativePresent, { maxFiles: 4 });
    assert.ok(f.ctx.tools.get('present'));
    const rows = parseYaml(await readFile(new URL('../presets/wechat-task.patch.yml', import.meta.url), 'utf8'))[0].insert;
    rows[0].config.plugins = rows[0].config.plugins.filter(row => row.name !== '@deepseek-ai/dsh-tool-present');
    await f.ctx.loader.root.update(rows);
    const bridge = createTaskSessionBridge(f.ctx, { data: f.access }); f.bridges.push(bridge);
    await assert.rejects(bridge.createConversation(f.context.id, { root: f.workspace, title: 'Missing declaration', allowWechat: true, confirmation: 'read-and-write-task-workspace' }), error => error.code === 'unsafe-session');
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

test('a failed second task bridge cannot revoke the first bridge data capability on disposal', async () => {
  const f = await fixture();
  try {
    const first = await nativeTask(f), competing = createTaskSessionBridge(f.ctx, { data: f.access }); f.bridges.push(competing);
    const before = f.access.getState(first.id).sources;
    await assert.rejects(competing.ensure(first.id), error => error.code === 'not-owned');
    await competing.dispose();
    assert.deepEqual(f.access.getState(first.id).sources, before);
    assert.equal(first.bridge.isPrepared(first.id), true);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

test('revocation during delegated post-execute gates cannot commit old task source content', async () => {
  for (const prepend of [false, true]) {
    const f = await fixture();
    const entered = deferred(), release = deferred(); let pending;
    try {
      const task = await nativeTask(f);
      await writeFile(join(f.workspace, 'post-source.txt'), 'SYNTHETIC_POST_REVOCATION_SOURCE');
      const dispose = task.agent.ctx.on('tools/post-execute', async (exec, _result, next) => {
        if (exec.callId !== 'synthetic-delayed-post') return next();
        if (prepend) { const accepted = await next(); entered.resolve(); await release.promise; return accepted; }
        entered.resolve(); await release.promise; return next();
      }, { prepend });
      pending = executeNativeTool(f.ctx, { agent: task.agent, callId: ToolCallId('synthetic-delayed-post'), name: 'wechat_task_files', arguments: { action: 'read', path: 'post-source.txt' }, signal: new AbortController().signal });
      await entered.promise; f.access.revoke(task.id, 'workspace'); release.resolve();
      const result = await pending;
      assert.equal(JSON.stringify(result.content).includes('SYNTHETIC_POST_REVOCATION_SOURCE'), false, `post-execute gate prepend=${prepend} must not emit old content`);
      assert.equal(f.access.getState(task.id).sessionMayContainData, true);
      dispose();
    } finally { release.resolve(); await pending?.catch(() => {}); await f.dispose(); }
  }
});

test('source revocation cancels the actual native model turn after an authorized data read', { timeout: 10000 }, async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture([
    () => call('wechat_task_files', { action: 'read', path: 'turn-source.txt' }, 'synthetic-turn-source'),
    async function* () { entered.resolve(); await release.promise; yield* chunks('MUST_NOT_BE_DELIVERED_AFTER_REVOCATION'); },
  ]);
  let pending;
  try {
    const task = await nativeTask(f);
    await writeFile(join(f.workspace, 'turn-source.txt'), 'authorized current-turn source');
    task.agent.options.provider = 'synthetic'; task.agent.options.model = 'synthetic';
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    pending = task.bridge.reply(task.id, 'Read the synthetic source', { messageId: 'synthetic-revoked-turn' });
    const rejected = assert.rejects(pending, error => ['not-completed', 'archive-denied', 'aborted'].includes(error.code));
    await entered.promise;
    f.access.revoke(task.id, 'workspace'); release.resolve();
    await rejected;
    const ended = task.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1);
    assert.ok(ended); assert.notEqual(ended.data.reason.kind, 'completed');
    assert.equal(f.access.canShare(task.id), false);
    assert.equal(f.adapter.requests.length, 2);
  } finally { release.resolve(); await pending?.catch(() => {}); await f.dispose(); }
});

test('actual native task preset creates one workspace-bound log and declares only its own current-turn document', { timeout: 15000 }, async () => {
  const f = await fixture([
    () => call('wechat_task_files', { action: 'create', path: 'native-report.md', content: 'Native synthetic document\n' }, 'synthetic-task-file'),
    () => call('present', { files: [{ path: 'native-report.md', description: 'Synthetic final document' }] }, 'synthetic-task-present'),
    'Synthetic task document is ready.',
  ]);
  try {
    const rows = parseYaml(await readFile(new URL('../presets/wechat-task.patch.yml', import.meta.url), 'utf8'))[0].insert;
    await f.ctx.loader.root.update(rows);
    const resolved = await f.ctx.agentPresets.resolve(TASK_PRESET_ID);
    assert.equal(resolved.broken, undefined);
    const bridge = createTaskSessionBridge(f.ctx, { data: f.access, timeoutMs: 5000 }); f.bridges.push(bridge);
    const id = await bridge.createConversation(f.context.id, { root: f.workspace, title: 'Synthetic native workspace', allowWechat: true, confirmation: 'read-and-write-task-workspace' });
    const agent = f.ctx.agents.get(SessionId(id)); assert.ok(agent);
    assert.equal(agent.session.header.cwd, f.workspace); assert.equal(agent.session.header.agentPreset, TASK_PRESET_ID);
    assert.equal(agent.session.header.parentSession, undefined); assert.equal(f.context.header.cwd, f.root);
    assert.equal(bridge.isPrepared(id), true); assert.equal(hasTaskSessionPolicy(agent), true); assertTaskSessionHistory(agent.session);
    assert.deepEqual(f.ctx.tools.schemas(scopeOf(agent.ctx)).map(tool => tool.name).sort(), ['present', 'wechat_task_files', 'wechat_task_sources']);
    assert.equal(f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'workspace-write');
    const workspace = f.access.getWorkspace(id);
    assert.equal(f.ctx.workspaceRegistry.get(workspace.id).sessionIds.includes(SessionId(id)), true);
    agent.options.provider = 'synthetic'; agent.options.model = 'synthetic';
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    const answer = await bridge.reply(id, 'Create the synthetic document', { messageId: 'synthetic-native-task-input' });
    assert.equal(answer, 'Synthetic task document is ready.');
    assert.equal(await readFile(join(f.workspace, 'native-report.md'), 'utf8'), 'Native synthetic document\n');
    const declarations = agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented');
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].data.files.length, 1);
    assert.equal(declarations[0].data.files[0].path, join(f.workspace, 'native-report.md'));
    const callEvent = agent.session.snapshotEvents().find(event => event.type === 'tool/call' && event.data.name === 'present');
    assert.equal(declarations[0].data.turn, callEvent.data.turn);
    assert.equal(f.adapter.requests.length, 3);
    assert.equal(networkAttempts, 0);
  } finally { await f.dispose(); }
});

const MEDIA_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yXQAAAAASUVORK5CYII=', 'base64');
const mediaJson = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
test('actual native task turn delivers only its declared document and attached image through the v3 queue and offline protocol', { timeout: 15000 }, async () => {
  let sourceId, imagePath;
  const document = '# Native offline media document\n', requests = [];
  const f = await fixture([
    () => call('wechat_task_files', { action: 'create', path: 'delivery.md', content: document }, 'media-create'),
    () => call('wechat_task_files', { action: 'attach', sourceId, path: 'pixel.png' }, 'media-attach'),
    () => call('present', { files: [{ path: 'delivery.md' }, { path: imagePath }] }, 'media-present'),
    'The requested document and image are ready.',
  ]);
  let channel;
  try {
    const task = await nativeTask(f);
    imagePath = join(f.extra, 'pixel.png'); await writeFile(imagePath, MEDIA_PNG);
    await f.access.grantDirectory(task.id, { root: f.extra, title: 'Synthetic image source', allowWechat: true, confirmation: 'read-task-directory' });
    sourceId = f.access.getState(task.id).sources.find(source => source.root === f.extra).sourceId;
    task.agent.options.provider = 'synthetic'; task.agent.options.model = 'synthetic';
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    const auth = { baseUrl: 'https://ilinkai.weixin.qq.com', botId: 'synthetic-bot', userId: 'synthetic-owner', botToken: 'SYNTHETIC_TOKEN' };
    const fetcher = async (url, init) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : Buffer.from(init.body);
      requests.push({ url, body });
      if (url.endsWith('/getupdates')) return mediaJson({ ret: 0, get_updates_buf: 'synthetic-cursor', msgs: [{ message_id: 1,
        from_user_id: auth.userId, to_user_id: auth.botId, message_type: 1, message_state: 2, context_token: 'synthetic-context',
        item_list: [{ type: 1, text_item: { text: 'Create the document and return the selected image' } }] }] });
      if (url.endsWith('/getuploadurl')) return mediaJson({ upload_param: 'synthetic-upload' });
      if (url.startsWith('https://novac2c.cdn.weixin.qq.com/')) return new Response(null, { headers: { 'x-encrypted-param': 'synthetic-download' } });
      assert.ok(url.endsWith('/sendmessage')); return mediaJson({ ret: 0 });
    };
    const api = createWeixinApi({ fetcher }), mediaApi = createWeixinMediaApi({ fetcher });
    let stored = validateWeixinState({ version: 3, revision: 1, sessionId: task.id, credentials: auth, cursor: '', seenMessageIds: [], queuedBatch: null, pending: null });
    let nativeResult;
    channel = createWeixinChannel({ enabled: true, sessionId: task.id, api,
      store: { read: async () => stored, async commit(expected, next) { assert.equal(expected, stored.revision); stored = validateWeixinState(next); } },
      beforeSend: () => f.access.canShare(task.id), reply: () => { throw new Error('Must use the task delivery result'); },
      media: {
        async reply(text, metadata, signal) { nativeResult = await task.bridge.replyWithDeliverables(task.id, text, metadata, signal); return nativeResult; },
        release: refs => f.access.releaseDeliveries(task.id, refs),
        async send(credentials, message, signal, authorize) {
          const prepared = await f.access.prepareDelivery(task.id, message, signal);
          return mediaApi.sendMedia(credentials, { toUserId: message.toUserId, contextToken: message.contextToken, clientId: message.clientId,
            fileName: message.fileName, kind: message.kind, sha256: message.sha256, data: prepared.data }, prepared.signal,
          { authorize: () => authorize() && prepared.authorize(), verify: prepared.verify });
        },
      },
    });
    assert.deepEqual(await channel.pollOnce(), { received: 1, replied: 1, ignored: 0, duplicates: 0 });
    assert.equal(nativeResult.deliverables.length, 2);
    assert.deepEqual(nativeResult.deliverables.map(file => file.kind), ['file', 'image']);
    assert.equal(nativeResult.deliverables[0].sha256, createHash('sha256').update(document).digest('hex'));
    assert.equal(nativeResult.deliverables[1].sha256, createHash('sha256').update(MEDIA_PNG).digest('hex'));
    assert.equal(requests.length, 8);
    assert.deepEqual(requests.filter(request => request.url.endsWith('/sendmessage')).map(request => request.body.msg.item_list[0].type), [1, 4, 2]);
    assert.equal(requests.filter(request => request.url.includes('/getupdates')).length, 1);
    assert.equal(stored.pending, null); assert.equal(stored.seenMessageIds.length, 1);
    assert.equal(f.adapter.requests.length, 4);
    assert.equal(task.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'wechat-task-weixin').length, 1);
    assert.equal(f.context.snapshotEvents().some(event => event.type === 'tool/call' || event.type === 'user/message'), false);
    assert.deepEqual(await readFile(imagePath), MEDIA_PNG);
    assert.equal(f.access.getState(task.id).sessionMayContainData, true);
    assert.equal(JSON.stringify(f.adapter.requests).includes(MEDIA_PNG.toString('base64')), false);
    await rejects(() => f.access.prepareDelivery(task.id, nativeResult.deliverables[0]), 'not-produced');
  } finally { channel?.dispose(); await f.dispose(); }
});

test('a document changed after native present cannot be substituted into the completed task delivery', { timeout: 10000 }, async () => {
  let path;
  const f = await fixture([
    () => call('wechat_task_files', { action: 'create', path: 'changed.md', content: 'original bytes' }, 'changed-create'),
    () => call('present', { files: [{ path: 'changed.md' }] }, 'changed-present'),
    async function* () { await writeFile(path, 'bytes changed after presentation'); yield* chunks('Completed'); },
  ]);
  try {
    const task = await nativeTask(f); path = join(f.workspace, 'changed.md');
    task.agent.options.provider = 'synthetic'; task.agent.options.model = 'synthetic';
    f.access.setSharing(task.id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    await assert.rejects(task.bridge.replyWithDeliverables(task.id, 'Create a document', { messageId: 'changed-input' }), error => error.code === 'not-completed');
    assert.equal(f.adapter.requests.length, 3);
    assert.equal(networkAttempts, 0);
  } finally { await f.dispose(); }
});

test('captured delivery keeps exact bytes, rejects another Task or source generation, and revalidates the original', async () => {
  const f = await fixture();
  try {
    const session = f.manualTask(), id = session.id; await f.grant(id); await f.access.prepare(id, session);
    f.access.setSharing(id, { allowWechat: true, confirmation: 'share-whole-task-context' });
    await f.access.file(id, { action: 'create', path: 'file.md', content: 'frozen original' }, undefined, 'local', 0);
    const files = await f.access.inspectDeliverables(id, [{ path: 'file.md' }], undefined, 0, 'synthetic-present');
    const declared = [{ callId: 'synthetic-present', files: files.map(file => ({ path: file.path })) }];
    const [descriptor] = await f.access.captureDeliverables(id, declared, undefined, 0);
    const prepared = await f.access.prepareDelivery(id, descriptor);
    assert.equal(Buffer.from(prepared.data).toString(), 'frozen original');
    await prepared.verify();
    await rejects(() => f.access.prepareDelivery(`wechat-task-${randomUUID()}`, descriptor), 'not-produced');
    await writeFile(join(f.workspace, 'file.md'), 'different bytes');
    await rejects(() => prepared.verify(), 'file-changed');
    assert.equal(Buffer.from(prepared.data).toString(), 'frozen original');
    f.access.revoke(id, 'workspace');
    assert.equal(prepared.signal.aborted, true); assert.equal(prepared.authorize(), false);
    await rejects(() => f.access.prepareDelivery(id, descriptor), 'not-produced');
    await f.grant(id);
    assert.equal(prepared.authorize(), false);
    await rejects(() => f.access.prepareDelivery(id, descriptor), 'not-produced');
  } finally { await f.dispose(); }
});

test('attach reads only an explicitly authorized ordinary file and cannot bypass link, byte or type boundaries', async () => {
  const f = await fixture();
  try {
    const session = f.manualTask(), id = session.id; await f.grant(id); await f.access.prepare(id, session);
    await writeFile(join(f.extra, 'pixel.png'), MEDIA_PNG);
    await symlink(join(f.extra, 'pixel.png'), join(f.workspace, 'symlink.png'));
    await link(join(f.extra, 'pixel.png'), join(f.workspace, 'hardlink.png'));
    for (const [path, code] of [['symlink.png', 'path-rejected'], ['hardlink.png', 'not-file'], ['../extra/pixel.png', 'invalid-request'], ['keys.json', 'path-rejected']]) {
      await rejects(() => f.access.file(id, { action: 'attach', path }, undefined, 'local', 0), code);
    }
    await writeFile(join(f.workspace, 'oversize.txt'), Buffer.alloc(10485761));
    await rejects(() => f.access.file(id, { action: 'attach', path: 'oversize.txt' }, undefined, 'local', 0), 'byte-budget-exceeded');
    await writeFile(join(f.workspace, 'false.png'), 'not an image');
    await rejects(() => f.access.file(id, { action: 'attach', path: 'false.png' }, undefined, 'local', 0), 'source-failed');
    assert.equal(f.ctx.fs.reads.some(path => path.startsWith(f.extra)), false);
    assert.equal(networkAttempts, 0);
  } finally { await f.dispose(); }
});

test('Task history validates every canonical tool catalog and cannot wash foreign tools with a later empty header', () => {
  const id = `wechat-task-${randomUUID()}`, header = { id, cwd: '/synthetic/never-read/workspace', agentPreset: TASK_PRESET_ID, isSeeded: false };
  const config = { provider: 'synthetic', model: 'synthetic-model' };
  const mode = { seq: 0, type: 'sandbox/mode', data: { mode: 'workspace-write' } };
  const request = tools => ({ seq: 1, type: 'request/header', data: { reason: 'initial', header: { config, ...(tools === undefined ? {} : { tools }) } } });
  const empty = { seq: 2, type: 'request/header', data: { reason: 'change', header: { config } } };
  const session = events => ({ id, header, seq: events.length, snapshotEvents: () => events });
  assert.equal(assertTaskSessionHistory(session([mode, request([{ name: 'wechat_task_files' }]), empty])), true);
  for (const invalid of [[mode, request([{ name: 'run_code' }]), empty], [mode, request(null)], [mode, request({ length: 0 })],
    [mode, { ...empty, data: { reason: 'change', header: { tools: [] } } }]]) {
    assert.throws(() => assertTaskSessionHistory(session(invalid)), error => error.code === 'unsafe-session');
  }
});

test('official native host rejects retired single-text execution without changing its Session or invoking a model', async () => {
  const f = await fixture();
  try {
    const task = await nativeTask(f);
    const sequence = task.agent.session.seq;
    assert.equal(Object.hasOwn(task.agent, 'sealedHistory'), false);
    assert.equal(Object.hasOwn(task.agent, 'sealedFirstText'), false);
    assert.throws(() => task.bridge.replyHistorical(task.id, 'Synthetic old text', { messageId: 'retired-history' }, undefined, {}), error => error.code === 'archive-denied');
    assert.throws(() => task.bridge.replyFirstText(task.id, 'Synthetic old text', { messageId: 'retired-first' }, undefined, {}), error => error.code === 'archive-denied');
    await assert.rejects(task.bridge.selectFirstTextModel(task.id, { provider: 'synthetic', model: 'old-model' }), error => error.code === 'not-prepared');
    assert.equal(task.agent.session.seq, sequence);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});


test('foreign prompt-tool schemas stop only the affected Task before model dispatch', async () => {
  const f = await fixture(['Synthetic ordinary reply.']);
  let ordinary, release;
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'task-model' });
    const { agent } = await nativeTask(f);
    release = agent.ctx.get('systemPrompt').tools(() => ({ schemas: [{ name: 'synthetic_ungranted_tool', description: 'Synthetic conflicting provider', parameters: { type: 'object', properties: {} } }] }));
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic Task input.' }] }));
    await agent.whenIdle();
    assert.equal(f.adapter.requests.length, 0);
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'error');
    ordinary = await f.ctx.agents.create({ sessionId: SessionId('synthetic-ordinary-after-conflict'), meta: { cwd: f.root }, agentOptions: { provider: 'synthetic', model: 'ordinary-model' } });
    ordinary.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic ordinary input.' }] }));
    await ordinary.agent.whenIdle();
    assert.equal(f.adapter.requests.length, 1);
    assert.equal(f.adapter.requests[0].model, 'ordinary-model');
  } finally { release?.(); await ordinary?.dispose(); await f.dispose(); }
});

test('selected images use native DSH attachments only after the Owner vision setting', async () => {
  const { default: LocalAttachments } = await import('@deepseek-ai/dsh-attachment-local');
  const { homedir } = await import('node:os');
  const png = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGP8//8/AwwwMSAB3BwAlm4DBfIlvvkAAAAASUVORK5CYII=', 'base64'), Buffer.from(randomUUID())]);
  const sha = createHash('sha256').update(png).digest('hex');
  const key = createHash('sha256').update('4/' + sha + '/.png').digest('hex');
  const cache = join(homedir(), '.local/share/dsh-wechat-ro/content-cache', key + '.json');
  await mkdir(dirname(cache), { recursive: true, mode: 0o700 });
  await writeFile(cache, JSON.stringify({ text: 'SYNTHETIC_OCR_FIXTURE', sha256: sha, engine: 'synthetic-cache-fixture' }), { flag: 'wx', mode: 0o600 });
  const previous = process.env.WECHAT_CONTENT_PYTHON; process.env.WECHAT_CONTENT_PYTHON = '/usr/bin/python3';
  const f = await fixture([
    () => call('wechat_task_files', { action: 'analyze', path: 'selected.png' }, 'ocr-only'), 'Local extraction ready.',
    () => call('wechat_task_files', { action: 'analyze', path: 'selected.png' }, 'native-image'), 'Selected image received.',
  ]);
  try {
    await f.ctx.plugin(LocalAttachments, { dshHome: join(f.root, 'attachments') });
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'selected-image-model' });
    const { id, agent } = await nativeTask(f);
    await writeFile(join(f.workspace, 'selected.png'), png);
    assert.equal(f.access.getState(id).modelVision, false);
    const local = await f.access.file(id, { action: 'analyze', path: 'selected.png' });
    assert.equal(local.text, 'SYNTHETIC_OCR_FIXTURE');
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Analyze the selected synthetic image.' }] }));
    await agent.whenIdle(); await f.ctx.sessions.flush(agent.session);
    const images = request => request.messages.filter(m => m.role === 'tool').flatMap(m => m.content.filter(b => b.type === 'image'));
    assert.equal(images(f.adapter.requests[1]).length, 0);
    await f.access.setModelVision(id, true);
    assert.equal(f.access.getState(id).modelVision, true);
    const visual = await f.access.file(id, { action: 'analyze', path: 'selected.png' });
    assert.equal(visual.images.length, 1);
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Analyze selected.png with vision.' }] }));
    await agent.whenIdle(); await f.ctx.sessions.flush(agent.session);
    const received = images(f.adapter.requests[3]);
    assert.equal(received.length, 1, JSON.stringify(f.adapter.requests[3].messages.filter(m => m.role === 'tool')));
    assert.equal(received[0].attachment.mediaType, 'image/png');
    const stored = await f.ctx.attachments.readImage(received[0].attachment);
    assert.ok(stored.data.byteLength > 0);
    assert.equal(f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks').get(id).modelVision, true);
    f.access.revoke(id, 'workspace');
    await rejects(() => f.access.file(id, { action: 'analyze', path: 'selected.png' }), 'not-granted');
  } finally {
    if (previous === undefined) delete process.env.WECHAT_CONTENT_PYTHON; else process.env.WECHAT_CONTENT_PYTHON = previous;
    await rm(cache, { force: true }); await f.dispose();
  }
});

test('idle indexing resumes tied timestamps, enforces archive scope and never calls the model', async () => {
  const { homedir } = await import('node:os');
  const f = await fixture();
  const account = randomUUID().replaceAll('-', '').slice(0,12);
  const historyCache = join(homedir(), '.local/share/dsh-wechat-ro/content-history', account);
  const caches = [], previous = process.env.WECHAT_CONTENT_PYTHON;
  process.env.WECHAT_CONTENT_PYTHON = '/usr/bin/python3';
  try {
    const root=join(f.root,'index-archive');
    for(const folder of ['contact','message'])await mkdir(join(root,folder),{recursive:true});
    await writeFile(join(root,'.wechat-ro-manifest.json'),JSON.stringify({account_ref:account,snapshot_id:'a'.repeat(32)}));
    let db=new DatabaseSync(join(root,'contact/contact.db'));
    db.exec("CREATE TABLE contact(username TEXT,remark TEXT); INSERT INTO contact VALUES('alpha','A'),('beta','B')");db.close();
    db=new DatabaseSync(join(root,'message/message.db'));
    db.exec('CREATE TABLE "Msg_'+createHash('md5').update('alpha').digest('hex')+'"(local_id INTEGER,create_time INTEGER,message_content TEXT,local_type INTEGER)');db.close();
    db=new DatabaseSync(join(root,'message/message_resource.db'));
    db.exec('CREATE TABLE ChatName2Id(user_name TEXT); CREATE TABLE MessageResourceInfo(message_id INTEGER,chat_id INTEGER,message_local_id INTEGER,message_create_time INTEGER,message_local_type INTEGER,packed_info BLOB)');db.close();
    db=new DatabaseSync(join(root,'message/media_0.db'));
    db.exec("CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('alpha'),('beta'); CREATE TABLE VoiceInfo(chat_name_id INTEGER,local_id INTEGER,create_time INTEGER,voice_data BLOB)");
    for(const id of [1,2,3]){
      const bytes=Buffer.from('synthetic-voice-'+randomUUID()),sha=createHash('sha256').update(bytes).digest('hex');
      db.prepare('INSERT INTO VoiceInfo VALUES(?,?,1700000000,?)').run(id===3?2:1,id,bytes);
      const cache=join(homedir(),'.local/share/dsh-wechat-ro/content-cache',createHash('sha256').update('4/'+sha+'/.silk').digest('hex')+'.json');
      await mkdir(dirname(cache),{recursive:true});await writeFile(cache,JSON.stringify({text:'SYNTHETIC_TRANSCRIPT_'+id,sha256:sha,version:4,engine:'synthetic-transcript'}),{flag:'wx',mode:0o600});caches.push(cache);
    }
    db.close();
    const {id}=await nativeTask(f);
    await f.access.grantSnapshot(id,{root,allConversations:false,talkers:['alpha'],fromTs:1700000000,toTs:1700000001,allowWechat:false,confirmation:'read-decrypted-snapshot'});
    await f.access.setModelVision(id,true);
    assert.equal((await f.access.indexContent(id)).processed,1);
    assert.equal((await f.access.indexContent(id)).processed,2);
    const state=f.ctx.storageDomain.get(TASK_CONTEXT_SPEC.name).table('tasks').get(id).contentProgress;
    assert.equal(state.cursors[0].toTs,1700000000);assert.equal(state.cursors[0].offset,2);
    const files=await (await import('node:fs/promises')).readdir(historyCache);
    assert.equal(files.length,2);
    const texts=await Promise.all(files.map(name=>readFile(join(historyCache,name),'utf8').then(JSON.parse)));
    assert.ok(texts.every(row=>row.talker==='alpha'));assert.deepEqual(texts.map(row=>row.text).sort(),['SYNTHETIC_TRANSCRIPT_1','SYNTHETIC_TRANSCRIPT_2']);
    assert.equal(f.adapter.requests.length,0);
    f.access.revoke(id,'archive');await rejects(()=>f.access.indexContent(id),'not-granted');
  } finally {
    if(previous===undefined)delete process.env.WECHAT_CONTENT_PYTHON;else process.env.WECHAT_CONTENT_PYTHON=previous;
    for(const path of caches)await rm(path,{force:true});await rm(historyCache,{recursive:true,force:true});await f.dispose();
  }
});
