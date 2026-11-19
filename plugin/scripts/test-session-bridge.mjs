// Controlled real public-SDK tests. Each native log is in a fresh synthetic tmp
// directory. No profile, WeChat source, account, browser, credential or network is used.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutorPlugin from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { createSessionBridge, SessionBridgeError, SESSION_BRIDGE_PRESET_ID, SESSION_BRIDGE_INFO } from 'dsh-wechat-ro/session-bridge';
import { createNativeSessionBridge } from '../lib/native-session-bridge.js';
import * as NativePolicy from 'dsh-wechat-ro/session-bridge-agent';
import { createArchiveAccess } from 'dsh-wechat-ro/archive-access';
import { createWeixinChannel } from 'dsh-wechat-ro/weixin-channel';
import { createConversationRuntime } from 'dsh-wechat-ro/conversation-controller';

// The development plugin links most public SDK packages. Registry/presentation
// are host dependencies, so use their public built entrypoints, not private src.
const { default: AgentPresets } = await import('@deepseek-ai/dsh-agent-preset-registry');
const { Storage, UNIT_NAME_RE } = await import('@deepseek-ai/dsh-storage');
const JsonStorage = await import('@deepseek-ai/dsh-storage-json');
const StorageDomain = await import('@deepseek-ai/dsh-storage-domain');
const { load: parseYaml } = createRequire(import.meta.resolve('@deepseek-ai/cordis-plugin-loader'))('js-yaml');
const syntheticRoots = new Set(), liveContexts = new Set();
after(async () => {
  for (const ctx of liveContexts) await ctx.fiber.dispose();
  for (const root of syntheticRoots) {
    assert.equal(resolve(root), root);
    assert.ok(root.startsWith(join(tmpdir(), 'wechat-session-bridge-')));
    await rm(root, { recursive: true, force: true });
  }
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const code = expected => error => {
  assert.ok(error instanceof SessionBridgeError);
  assert.equal(error.code, expected);
  assert.equal(Object.isFrozen(error), true);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.equal(error.message.includes('SYNTHETIC_PRIVATE'), false);
  return true;
};
function* textChunks(text, reasoning) {
  let index = 0;
  for (const block of [...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []), { type: 'text', text }]) {
    yield { type: 'block-start', index, blockType: block.type };
    yield { type: block.type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text: block.text };
    yield { type: 'block-end', index: index++, block };
  }
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } };
  yield { type: 'finish', reason: 'stop' };
}
function* toolChunks(name, args, id = 'synthetic-call') {
  const block = { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block };
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } };
  yield { type: 'finish', reason: 'tool-calls' };
}
let nativeFirstRequestMetric;
class ScriptedAdapter extends LlmAdapter {
  constructor(script) { super(); this.script = [...script]; this.requests = []; }
  providerInfo(provider) { return { id: provider, name: 'Synthetic offline provider' }; }
  async resolveModel(provider, model) { return { provider, id: model, name: 'Synthetic offline model' }; }
  async generate() { throw new Error('Non-streaming generation is not used by this fixture.'); }
  async *stream(request) {
    this.requests.push(request);
    if (!nativeFirstRequestMetric && request.tools?.some(tool => tool.name === 'wechat_archive')) {
      const prompt = request.messages.filter(message => message.role === 'system' || message.role === 'developer');
      nativeFirstRequestMetric = {
        source: 'actual-public-adapter-request-in-synthetic-native-SDK-test',
        privateTools: request.tools.length,
        toolSchemaJsonUtf8Bytes: Buffer.byteLength(JSON.stringify(request.tools), 'utf8'),
        systemAndDeveloperJsonUtf8Bytes: Buffer.byteLength(JSON.stringify(prompt), 'utf8'),
        completeToolsAndMessagesJsonUtf8Bytes: Buffer.byteLength(JSON.stringify({ tools: request.tools, messages: request.messages }), 'utf8'),
        baselinePrivateTools: 0,
        baselineEmptyToolsJsonUtf8Bytes: 2,
        baselineSource: 'old stateless allow[] mask source; not a captured old prompt',
        providerTokensMeasured: false,
      };
      console.log('NATIVE_FIRST_REQUEST_METRIC ' + JSON.stringify(nativeFirstRequestMetric));
    }
    const next = this.script.shift();
    if (next === undefined) throw new Error('Synthetic fixture response exhausted.');
    if (typeof next === 'function') yield* next(request);
    else yield* textChunks(next);
  }
}
function archiveAccess() {
  const calls = [], state = { share: true, tainted: false, granted: true };
  return {
    calls, state,
    getState() { return { granted: state.granted, allowWechat: state.share, historyKnown: true, sessionMayContainArchiveData: state.tainted }; },
    canShare() { return state.share || !state.tainted; },
    async query(sessionId, args, signal, destination) {
      assert.ok(signal instanceof AbortSignal);
      calls.push({ sessionId, args: structuredClone(args), destination });
      if (!state.granted) throw new Error('SYNTHETIC_PRIVATE grant denied');
      state.tainted = true;
      return { action: args.action, rows: [{ text: 'synthetic archive row' }], limit: args.limit, offset: args.offset ?? 0,
        returned: 1, hasMore: false, truncated: false, bytes: 50, scopeApplied: 'sql-before-rows' };
    },
  };
}
async function fixture(script = [], existingRoot) {
  const ownRoot = existingRoot === undefined;
  if (!ownRoot) assert.ok(syntheticRoots.has(existingRoot), 'reuse only a directory minted by this fixture');
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'wechat-session-bridge-'));
  syntheticRoots.add(root);
  assert.equal(resolve(root), root);
  assert.ok(root.startsWith(join(tmpdir(), 'wechat-session-bridge-')));
  if (ownRoot) {
    const modules = join(root, 'node_modules');
    assert.equal(resolve(modules), join(root, 'node_modules'));
    await mkdir(join(modules, '@deepseek-ai'), { recursive: true });
    await symlink(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-preset/package.json')), join(modules, '@deepseek-ai/dsh-agent-preset'), 'dir');
    await symlink(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-tool-presentation/package.json')), join(modules, '@deepseek-ai/dsh-agent-tool-presentation'), 'dir');
    await symlink(fileURLToPath(new URL('../', import.meta.url)), join(modules, 'dsh-wechat-ro'), 'dir');
  }
  const ctx = new Context();
  liveContexts.add(ctx);
  const diagnostics = [];
  ctx.logger.exporter({ export(message) { diagnostics.push(message.args.map(String).join(' ')); } });
  // This synthetic installation links the ACTUAL public packages; no entry,
  // config, tool, preset resolver or ownership handle is substituted.
  ctx.baseUrl = pathToFileURL(`${root}/`).href;
  await ctx.plugin(Loader);
  ctx.loader.builtins.group = Group;
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjections);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime); await ctx.plugin(NativeToolExecutorPlugin);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: root });
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(AgentPresets, { default: 'standard' });
  const adapter = new ScriptedAdapter(script);
  ctx.llm.registerAdapter(['synthetic'], adapter);
  const globalCalls = [];
  ctx.tools.register({ name: 'synthetic_global', description: 'Synthetic forbidden global capability.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: String(value) }]; } },
    async execute() { globalCalls.push(true); return 'SYNTHETIC_PRIVATE global capability'; } });
  ctx.systemPrompt.section({ name: 'synthetic-global-instructions', order: 1, text: 'SYNTHETIC_BROAD_ROOT_PROMPT' });
  const patch = parseYaml(await readFile(new URL('../presets/native-conversation.patch.yml', import.meta.url), 'utf8'));
  assert.equal(Array.isArray(patch), true);
  assert.equal(patch.length, 1);
  assert.equal(Array.isArray(patch[0].insert), true);
  const rows = patch[0].insert;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '@deepseek-ai/dsh-agent-preset');
  assert.equal(rows[0].config.id, SESSION_BRIDGE_PRESET_ID);
  assert.equal(rows[0].config.plugins.at(-1).name, 'dsh-wechat-ro/session-bridge-agent');
  await ctx.loader.root.update(rows);
  const unregister = () => ctx.loader.root.update([]);
  const resolvedPreset = await ctx.agentPresets.resolve(SESSION_BRIDGE_PRESET_ID);
  assert.equal(resolvedPreset.broken, undefined, `${resolvedPreset.broken}\n${diagnostics.join('\n')}`);
  const context = ctx.sessions.create(SessionId('synthetic-context'), { meta: { cwd: root } });
  const archive = archiveAccess();
  const bridges = [], externalHandles = [];
  function bridge(options = {}) { const instance = createSessionBridge(ctx, { archive, timeoutMs: 2000, ...options }); bridges.push(instance); return instance; }
  function route(sessionId) {
    const agent = ctx.agents.get(SessionId(sessionId));
    assert.ok(agent);
    agent.options.provider = 'synthetic';
    agent.options.model = 'synthetic';
    return agent;
  }
  async function guiResume(sessionId) {
    const handle = await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: { provider: 'synthetic', model: 'synthetic' },
      async setup(agentCtx) { await ctx.agentPresets.mount(agentCtx, SESSION_BRIDGE_PRESET_ID); } });
    externalHandles.push(handle);
    return handle;
  }
  async function stored(sessionId) {
    const handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'read');
    assert.ok(handle);
    try { return { header: handle.header, ...await handle.read() }; } finally { await handle.close(); }
  }
  async function dispose({ keepRoot = false } = {}) {
    for (const instance of bridges) await instance.dispose().catch(() => {});
    for (const handle of externalHandles) await handle.dispose();
    await unregister();
    await ctx.fiber.dispose();
    liveContexts.delete(ctx);
    if (ownRoot && !keepRoot) {
      // Delete only this test's verified, freshly minted synthetic directory.
      assert.equal(resolve(root), root);
      assert.ok(root.startsWith(join(tmpdir(), 'wechat-session-bridge-')));
      await rm(root, { recursive: true, force: true });
      syntheticRoots.delete(root);
    }
  }
  return { ctx, root, archive, adapter, globalCalls, context, rows, bridges, externalHandles,
    bridge, route, guiResume, stored, unregister, dispose };
}
const textOf = messages => messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');

test('readonly bridge uses the real configured default model without the test route helper', async () => {
  const f = await fixture(['Configured readonly model reached.']);
  try {
    await f.ctx.plugin(AgentDefaultModelConfig, { provider: 'synthetic', model: 'configured-readonly-model' });
    const bridge = f.bridge(), id = await bridge.createConversation(f.context.id);
    const agent = f.ctx.agents.get(SessionId(id));
    assert.equal(agent.options.provider, 'synthetic'); assert.equal(agent.options.model, 'configured-readonly-model');
    assert.equal(await bridge.reply(id, 'Synthetic default route.', { messageId: 'default-model-input' }), 'Configured readonly model reached.');
    assert.equal(f.adapter.requests.length, 1);
    assert.equal(agent.session.requestHeader().config.model, 'configured-readonly-model');
    assert.equal(f.globalCalls.length, 0);
  } finally { await f.dispose(); }
});

test('real SDK JSON history domain rejects invalid names before I/O and keeps one durable native SID', { timeout: 10000 }, async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0, runtime;
  globalThis.fetch = () => { networkAttempts++; throw new Error('SYNTHETIC_FORBIDDEN_NETWORK'); };
  try {
    const invalidName = 'wechat-native-ro-history-v1', domainName = 'wechat_native_ro_history_v1';
    assert.equal(UNIT_NAME_RE.test(invalidName), false);
    assert.equal(UNIT_NAME_RE.test(domainName), true);
    const rejectedRoot = join(f.root, 'invalid-history-root');
    const rejectedBackend = new JsonStorage.JsonStorageBackend(rejectedRoot);
    await assert.rejects(rejectedBackend.kv.open({ name: invalidName, version: 1, tables: ['sessions'], hasGlobal: false, layout: 'per-record' }), error => error.code === 'malformed-medium');
    await assert.rejects(stat(rejectedRoot), error => error.code === 'ENOENT');
    await rejectedBackend.close();
    await f.ctx.plugin(Storage);
    await f.ctx.plugin(JsonStorage, { root: join(f.root, 'history-store') });
    await f.ctx.plugin(StorageDomain, { backend: 'json' });
    runtime = createConversationRuntime(f.ctx);
    const created = await runtime.action({ action: 'createConversation', contextSessionId: f.context.id, confirmation: 'create-readonly-conversation' });
    assert.equal(created.ok, true);
    const sessionId = created.result.sessionId;
    assert.ok(NativePolicy.isSessionBridgeId(sessionId));
    assert.equal(created.state.sessionId, sessionId);
    assert.equal(created.state.prepared, true);
    assert.equal(created.state.archive.historyKnown, true);
    assert.equal(created.state.archive.shareable, true);
    assert.equal(created.state.archive.granted, false);
    assert.equal(created.state.archive.allowWechat, false);
    assert.equal(f.ctx.storageDomain.get(domainName).table('sessions').get(sessionId).mayContainArchiveData, false);
    await runtime.dispose();
    assert.equal(f.ctx.agents.get(SessionId(sessionId)), undefined);
    assert.equal((await f.stored(sessionId)).header.agentPreset, SESSION_BRIDGE_PRESET_ID);
    runtime = createConversationRuntime(f.ctx);
    const resumed = await runtime.action({ action: 'resumeConversation', sessionId, confirmation: 'resume-readonly-conversation' });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.result.sessionId, sessionId);
    assert.equal(resumed.result.sameSession, true);
    assert.equal(resumed.state.archive.historyKnown, true);
    assert.equal(resumed.state.archive.granted, false);
    assert.equal(resumed.state.archive.allowWechat, false);
    assert.equal(resumed.state.channel.messagingEnabled, false);
    assert.equal(f.adapter.requests.length, 0);
    assert.equal(f.globalCalls.length, 0);
  } finally {
    try { await runtime?.dispose(); }
    finally {
      try { await f.dispose(); }
      finally { globalThis.fetch = originalFetch; assert.equal(networkAttempts, 0); }
    }
  }
});

test('construction has no I/O and missing metadata fails closed', { timeout: 1000 }, async () => {
  const bridge = createSessionBridge({});
  assert.equal(bridge.isPrepared('arbitrary'), false);
  assert.equal(bridge.hasArchiveHistory('arbitrary'), 'unknown');
  await assert.rejects(bridge.ensure('arbitrary'), code('invalid-input'));
  await bridge.dispose();
  assert.throws(() => bridge.reply('arbitrary', 'synthetic', { messageId: '1' }), code('disposed'));
});

const readonlyCorePolicy = Object.freeze({
  info: SESSION_BRIDGE_INFO,
  isSessionId: NativePolicy.isSessionBridgeId,
  createSessionId: () => `wechat-native-ro-${randomUUID()}`,
  requireData(data) {
    if (!data || typeof data.query !== 'function' || typeof data.getState !== 'function'
      || typeof data.canShare !== 'function') throw new SessionBridgeError('archive-unavailable');
  },
  bindData: NativePolicy.bindSessionBridgeArchive,
  assertHistory: NativePolicy.assertSessionBridgeHistory,
  install: NativePolicy.installSessionBridgePolicy,
  hasPolicy: NativePolicy.hasSessionBridgePolicy,
  inspectHistory(session) {
    try {
      NativePolicy.assertSessionBridgeHistory(session);
      return session.snapshotEvents().some(event => event.type === 'tool/call') ? 'unknown' : false;
    } catch { return 'unknown'; }
  },
});

test('real SDK: public readonly wrapper keeps six methods and cannot forward a third cwd argument', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const selectedCwd = join(f.root, 'public-override-probe');
    await mkdir(selectedCwd, { mode: 0o700 });
    const bridge = f.bridge();
    assert.deepEqual(Object.keys(bridge), ['createConversation', 'isPrepared', 'ensure', 'reply', 'hasArchiveHistory', 'dispose']);
    assert.equal(Object.isFrozen(bridge), true);
    assert.deepEqual(SESSION_BRIDGE_INFO, {
      agentPreset: SESSION_BRIDGE_PRESET_ID, sandboxMode: 'read-only', messageSource: 'wechat-ro-weixin',
      defaultTimeoutMs: 120000, maxTimeoutMs: 300000, maxInputBytes: 16384, maxReplyBytes: 16384,
    });
    for (const extra of [{ selectedCwd }, { policy: readonlyCorePolicy }, { sandboxMode: 'workspace-write' },
      { timeoutMs: SESSION_BRIDGE_INFO.maxTimeoutMs + 1 }]) {
      assert.throws(() => createSessionBridge(f.ctx, { archive: f.archive, ...extra }), code('invalid-options'));
    }
    const sessionId = await bridge.createConversation(f.context.id, undefined, selectedCwd);
    const agent = f.ctx.agents.get(SessionId(sessionId));
    assert.ok(agent);
    assert.equal(agent.session.header.cwd, f.root);
    assert.equal((await f.stored(sessionId)).header.cwd, f.root);
    assert.equal(f.context.header.cwd, f.root);
    assert.equal(f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only');
    assert.equal(bridge.hasArchiveHistory(sessionId), false);
    assert.equal(f.adapter.requests.length, 0);
    assert.equal(f.archive.calls.length, 0);
    assert.equal(f.globalCalls.length, 0);
  } finally { await f.dispose(); }
});

test('real SDK: internal selected cwd persists and restores without relaxing readonly policy or probing the source', { timeout: 10000 }, async () => {
  const f = await fixture();
  const mintedIds = [];
  try {
    const selectedCwd = join(f.root, 'internal-selected-workspace');
    await mkdir(selectedCwd, { mode: 0o700 });
    const core = createNativeSessionBridge(f.ctx, f.archive, 2000, {
      ...readonlyCorePolicy,
      createSessionId() { const id = readonlyCorePolicy.createSessionId(); mintedIds.push(id); return id; },
    });
    f.bridges.push(core);
    const sessionId = await core.createConversation(f.context.id, undefined, selectedCwd);
    const agent = f.ctx.agents.get(SessionId(sessionId));
    assert.ok(agent);
    assert.equal(core.isPrepared(sessionId), true);
    assert.deepEqual(mintedIds, [sessionId]);
    assert.equal(agent.session.header.cwd, selectedCwd);
    assert.equal(f.context.header.cwd, f.root);
    const createdLog = await f.stored(sessionId);
    assert.equal(createdLog.header.id, sessionId);
    assert.equal(createdLog.header.cwd, selectedCwd);
    assert.equal(createdLog.header.agentPreset, SESSION_BRIDGE_PRESET_ID);
    assert.equal(createdLog.header.isSeeded, false);
    assert.equal(createdLog.header.parentSession, undefined);
    assert.equal(core.hasDataHistory(sessionId), false);
    for (const rejected of ['/home/keer/Documents/xwechat_files', '/home/keer/Documents/xwechat_files/unopened-synthetic']) {
      await assert.rejects(core.createConversation(f.context.id, undefined, rejected), code('invalid-input'));
    }
    assert.deepEqual(mintedIds, [sessionId]);
    await core.dispose();
    assert.equal(f.ctx.agents.get(SessionId(sessionId)), undefined);
    assert.equal(f.ctx.sessions.get(SessionId(sessionId)), undefined);
    const resumed = createNativeSessionBridge(f.ctx, f.archive, 2000, readonlyCorePolicy);
    f.bridges.push(resumed);
    await resumed.ensure(sessionId);
    const restoredAgent = f.ctx.agents.get(SessionId(sessionId));
    assert.ok(restoredAgent);
    assert.equal(resumed.isPrepared(sessionId), true);
    assert.equal(restoredAgent.session.header.cwd, selectedCwd);
    assert.equal((await f.stored(sessionId)).header.cwd, selectedCwd);
    assert.equal(f.ctx.sandboxPolicy.resolve({ session: restoredAgent.session }).mode, 'read-only');
    assert.deepEqual(f.ctx.tools.schemas(scopeOf(restoredAgent.ctx)).map(schema => schema.name), ['wechat_archive']);
    assert.equal(f.adapter.requests.length, 0);
    assert.equal(f.archive.calls.length, 0);
    assert.equal(f.globalCalls.length, 0);
  } finally { await f.dispose(); }
});

test('real SDK: cancel during awaited policy installation drains the owned factory context and releases its data lease', { timeout: 10000 }, async () => {
  const f = await fixture();
  const entered = deferred(), release = deferred();
  const controller = new AbortController();
  let bound = 0, released = 0, contextDisposed = 0, announced = 0;
  const core = createNativeSessionBridge(f.ctx, f.archive, 2000, {
    ...readonlyCorePolicy,
    bindData(...args) {
      const unbind = NativePolicy.bindSessionBridgeArchive(...args);
      bound++;
      return () => { released++; unbind(); };
    },
    async install(agentCtx, agent, sandboxPolicy) {
      agentCtx.effect(() => () => { contextDisposed++; });
      entered.resolve(agent);
      await release.promise;
      NativePolicy.installSessionBridgePolicy(agentCtx, agent, sandboxPolicy);
    },
  });
  f.bridges.push(core);
  f.ctx.on('agent/created', () => { announced++; });
  const creation = core.createConversation(f.context.id, controller.signal);
  const rejected = assert.rejects(creation, code('aborted'));
  try {
    const agent = await entered.promise;
    const sessionId = agent.session.id;
    assert.equal(bound, 1);
    assert.equal(released, 0);
    assert.equal(core.isPrepared(sessionId), false);
    assert.equal(announced, 0);
    controller.abort();
    await tick();
    assert.equal(core.isPrepared(sessionId), false);
    assert.equal(announced, 0);
    release.resolve();
    await rejected;
    await core.dispose();
    assert.equal(contextDisposed, 1);
    assert.equal(released, 1);
    assert.equal(core.isPrepared(sessionId), false);
    assert.equal(f.ctx.agents.get(SessionId(sessionId)), undefined);
    assert.equal(f.ctx.sessions.get(SessionId(sessionId)), undefined);
    assert.equal(NativePolicy.hasSessionBridgePolicy(agent), false);
    const unbind = NativePolicy.bindSessionBridgeArchive(sessionId, f.archive, () => 'local');
    unbind();
    assert.equal(announced, 0);
    assert.equal(f.adapter.requests.length, 0);
    assert.equal(f.archive.calls.length, 0);
    assert.equal(f.globalCalls.length, 0);
  } finally {
    release.resolve();
    await rejected;
    await f.dispose();
  }
});

test('real SDK: one owned native log, sequential continuity, global denial and durable output', { timeout: 10000 }, async () => {
  const f = await fixture(['first synthetic reply', 'second synthetic reply']);
  try {
    const bridge = f.bridge();
    const sessionId = await bridge.createConversation(f.context.id);
    assert.ok(NativePolicy.isSessionBridgeId(sessionId));
    const agent = f.route(sessionId);
    assert.equal(bridge.isPrepared(sessionId), true);
    assert.equal(await bridge.reply(sessionId, 'first exact input', { messageId: 'm-1' }), 'first synthetic reply');
    assert.equal(f.ctx.agents.get(SessionId(sessionId)), agent);
    assert.equal(await bridge.reply(sessionId, 'second exact input', { messageId: 'm-2' }), 'second synthetic reply');
    assert.equal(f.ctx.agents.get(SessionId(sessionId)), agent);
    const durable = await f.stored(sessionId);
    assert.equal(durable.header.id, sessionId);
    assert.equal(durable.header.cwd, f.root);
    assert.equal(durable.header.agentPreset, SESSION_BRIDGE_PRESET_ID);
    assert.equal(durable.header.isSeeded, false);
    assert.equal(durable.header.parentSession, undefined);
    assert.equal(durable.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'wechat-ro-weixin').length, 2);
    assert.equal(durable.events.filter(event => event.type === 'assistant/message').length, 2);
    assert.ok(textOf(f.adapter.requests[1].messages).includes('first exact input'));
    assert.ok(textOf(f.adapter.requests[1].messages).includes('first synthetic reply'));
    assert.ok(f.adapter.requests.every(request => request.tools.map(tool => tool.name).join(',') === 'wechat_archive'));
    assert.ok(f.adapter.requests.every(request => !textOf(request.messages.filter(message => message.role === 'system')).includes('SYNTHETIC_BROAD_ROOT_PROMPT')));
    assert.equal(f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only');
    const denied = await executeNativeTool(f.ctx, { name: 'synthetic_global', arguments: {}, callId: ToolCallId('global-probe'), agent, signal: new AbortController().signal });
    assert.equal(f.globalCalls.length, 0);
    assert.ok(JSON.stringify(denied).includes('error') || JSON.stringify(denied).includes('denied'));
    await assert.rejects(bridge.reply(sessionId, 'duplicate', { messageId: 'm-1' }), code('already-processed'));
    const disposal = bridge.dispose();
    assert.equal(bridge.dispose(), disposal);
    await disposal;
    assert.equal(f.ctx.agents.get(SessionId(sessionId)), undefined);
    assert.equal(f.ctx.sessions.get(SessionId(sessionId)), undefined);
  } finally { await f.dispose(); }
});

test('real SDK: GUI owns resume, Root safely borrows and never disposes the GUI handle', { timeout: 10000 }, async () => {
  const f = await fixture(['initial native reply', 'GUI synthetic reply', 'borrowed WeChat reply']);
  try {
    const initial = f.bridge();
    const sessionId = await initial.createConversation(f.context.id);
    f.route(sessionId);
    await initial.reply(sessionId, 'initial', { messageId: 'm-initial' });
    await initial.dispose();
    const gui = await f.guiResume(sessionId);
    assert.equal(NativePolicy.hasSessionBridgePolicy(gui.agent), true);
    gui.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'GUI input' }], source: { kind: 'user' } }));
    await gui.agent.whenIdle();
    const borrowed = f.bridge();
    await borrowed.ensure(sessionId);
    assert.equal(borrowed.isPrepared(sessionId), true);
    assert.equal(await borrowed.reply(sessionId, 'WeChat same log', { messageId: 'm-borrowed' }), 'borrowed WeChat reply');
    await borrowed.dispose();
    assert.equal(f.ctx.agents.get(SessionId(sessionId)), gui.agent);
    assert.equal(f.ctx.sessions.get(SessionId(sessionId)), gui.agent.session);
    assert.equal(NativePolicy.hasSessionBridgePolicy(gui.agent), true);
    assert.equal(f.ctx.sandboxPolicy.resolve({ session: gui.agent.session }).mode, 'read-only');
    const log = await f.stored(sessionId);
    assert.ok(textOf(log.events.filter(event => event.type === 'user/message').map(event => event.data)).includes('GUI input'));
    assert.ok(textOf(log.events.filter(event => event.type === 'user/message').map(event => event.data)).includes('WeChat same log'));
    const rebound = f.bridge();
    await rebound.ensure(sessionId);
    assert.equal(rebound.isPrepared(sessionId), true);
  } finally { await f.dispose(); }
});

async function executeNativeTool(ctx, { agent, signal, callId, name, arguments: args }) {
  const batch = await ctx.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }] });
  return batch.results[0].result;
}
const execute = (f, agent, args, name = 'wechat_archive') => executeNativeTool(f.ctx, {
  name, arguments: args, callId: ToolCallId(`probe-${randomUUID()}`), agent, signal: new AbortController().signal,
});
const held = (started, release, text) => async function*(request) {
  started.resolve(request);
  await release.promise; // deliberately ignore cancellation: the bridge must drain, not replay
  yield* textChunks(text);
};

test('real Loader: pre-publication private policy, scoped extras and cross-session dispatch stay denied', { timeout: 10000 }, async () => {
  const f = await fixture(['Scoped readonly model response.']);
  try {
    let announced = 0, announceError;
    f.ctx.on('agent/created', async ({ agent }) => {
      try {
        assert.equal(NativePolicy.hasSessionBridgePolicy(agent), true);
        assert.deepEqual(f.ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name), ['wechat_archive']);
        assert.equal(f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only');
        assert.ok(JSON.stringify(await execute(f, agent, {}, 'synthetic_global')).includes('error'));
        announced++;
      } catch (error) { announceError = error; throw error; }
    });
    const bridge = f.bridge();
    const sessionId = await bridge.createConversation(f.context.id).catch(error => { throw announceError ?? error; });
    const agent = f.route(sessionId);
    let extraCalls = 0;
    const remove = agent.ctx.get('tools').register({ name: 'synthetic_scoped_extra', description: 'Synthetic forbidden scoped capability.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }]; } },
      async execute() { extraCalls++; return 'SYNTHETIC_PRIVATE extra'; } });
    const removeIdentity = agent.ctx.get('systemPrompt').context({ name: 'team:identity', order: 600, required: true,
      text: 'You are the Team Lead named "lead". Use list_agents({}) and send_message to contact teammates.' });
    const removeSafety = agent.ctx.get('systemPrompt').context({ name: 'synthetic:safety', order: 100, text: 'SYNTHETIC_SAFETY_CONTEXT' });
    try {
      assert.ok(f.ctx.tools.schemas(scopeOf(agent.ctx)).some(schema => schema.name === 'synthetic_scoped_extra'));
      assert.equal(f.ctx.tools.schemas().some(schema => schema.name === 'synthetic_scoped_extra'), false);
      assert.ok(JSON.stringify(await execute(f, agent, {}, 'synthetic_scoped_extra')).includes('error'));
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Synthetic scoped readonly presentation check.' }], source: { kind: 'user' } }));
      await agent.whenIdle(); await f.ctx.sessions.flush(agent.session);
      assert.equal(f.adapter.requests.length, 1);
      assert.deepEqual(f.adapter.requests[0].tools.map(tool => tool.name), ['wechat_archive']);
      assert.deepEqual(agent.session.requestHeader().tools.map(tool => tool.name), ['wechat_archive']);
      assert.match(textOf(f.adapter.requests[0].messages.filter(message => message.role === 'system')), /Native Team identity is host status, not permission to delegate or message agents/);
      assert.match(textOf(f.adapter.requests[0].messages), /SYNTHETIC_SAFETY_CONTEXT/);
      NativePolicy.assertSessionBridgeHistory(agent.session);
    } finally { removeIdentity(); removeSafety(); remove(); }
    assert.equal(extraCalls, 0);
    assert.equal(f.globalCalls.length, 0);
    assert.equal(announced, 1);
    assert.equal(f.archive.calls.length, 0);
    assert.deepEqual(Object.keys(f.ctx.tools.get('wechat_archive', scopeOf(agent.ctx)).parameters.properties).sort(),
      ['action', 'fromTs', 'limit', 'offset', 'query', 'talker', 'toTs']);
    assert.equal(f.ctx.tools.get('wechat_archive', scopeOf(agent.ctx)).parameters.additionalProperties, false);
    const secondId = await bridge.createConversation(f.context.id);
    const secondAgent = f.route(secondId);
    await assert.rejects(f.ctx.tools.get('wechat_archive', scopeOf(agent.ctx)).execute({ action: 'search' }, {
      agent: secondAgent, name: 'wechat_archive', callId: ToolCallId('cross-session-probe'), signal: new AbortController().signal,
    }), code('archive-denied'));
    assert.equal(f.archive.calls.length, 0);
    assert.equal(announced, 2);
  } finally { await f.dispose(); }
});

test('real SDK: private archive closes over one native id, rejects path/SQL/grant/network and uses bounded defaults', { timeout: 10000 }, async () => {
  const f = await fixture([() => toolChunks('wechat_archive', { action: 'search', query: 'synthetic needle' }), 'archive-derived reply']);
  try {
    const bridge = f.bridge();
    const sessionId = await bridge.createConversation(f.context.id);
    const agent = f.route(sessionId);
    const bad = [
      { action: 'grant' }, { action: 'search', sql: 'SELECT SYNTHETIC_PRIVATE' }, { action: 'search', root: '/synthetic' },
      { action: 'search', path: '/synthetic' }, { action: 'search', network: true }, { action: 'search', sessionId: 'other' },
      { action: 'search', limit: 1000 }, { action: 'search', offset: -1 }, { action: 'search', fromTs: 10, toTs: 9 },
    ];
    for (const args of bad) {
      const result = JSON.stringify(await execute(f, agent, args));
      assert.ok(result.includes('error'));
      assert.equal(result.includes('SYNTHETIC_PRIVATE'), false);
    }
    await execute(f, agent, { action: 'status' });
    assert.equal(f.archive.calls.length, 0);
    assert.equal(await bridge.reply(sessionId, 'query existing grant', { messageId: 'archive-1' }), 'archive-derived reply');
    assert.deepEqual(f.archive.calls.map(call => [call.sessionId, call.args.limit, call.destination]), [[sessionId, 20, 'wechat']]);
    assert.equal(bridge.hasArchiveHistory(sessionId), true);
    const log = await f.stored(sessionId);
    assert.ok(log.events.some(event => event.type === 'tool/call' && event.data.name === 'wechat_archive'));
    f.archive.state.share = false;
    f.archive.state.granted = false;
    const requestCount = f.adapter.requests.length;
    await assert.rejects(bridge.reply(sessionId, 'tainted after revoke', { messageId: 'archive-2' }), code('archive-denied'));
    assert.equal(f.adapter.requests.length, requestCount);
    assert.equal(bridge.hasArchiveHistory(sessionId), true);
  } finally { await f.dispose(); }
});

test('real SDK/ArchiveAccess/channel: explicit scoped grant reaches one native private tool and an offline owner reply', { timeout: 15000 }, async () => {
  const f = await fixture([() => toolChunks('wechat_archive', { action: 'messages', talker: 'alpha' }), 'Synthetic scoped alpha reply']);
  const history = new Map();
  const archive = createArchiveAccess({ maxRows: 2, hasArchiveHistory: id => history.get(id) ?? 'unknown', markArchiveHistory: id => { history.set(id, true); } });
  const originalFetch = globalThis.fetch;
  let channel, forbiddenNetwork = 0, updates = 0, qrRequests = 0;
  const sent = [];
  globalThis.fetch = () => { forbiddenNetwork++; throw new Error('Synthetic native association forbids network'); };
  try {
    const root = join(f.root, 'association-snapshot'), baseTs = 1700000000;
    await mkdir(root, { mode: 0o700 });
    for (const directory of ['contact', 'session', 'message']) await mkdir(join(root, directory), { mode: 0o700 });
    const tables = new Map(['alpha', 'beta'].map(talker => [talker, 'Msg_' + createHash('md5').update(talker).digest('hex')]));
    const contact = new DatabaseSync(join(root, 'contact/contact.db'));
    try {
      contact.exec('PRAGMA journal_mode=DELETE; CREATE TABLE contact(username TEXT, remark TEXT, nick_name TEXT, alias TEXT)');
      for (const talker of tables.keys()) contact.prepare('INSERT INTO contact VALUES(?,?,?,?)').run(talker, talker, '', '');
    } finally { contact.close(); }
    const sessions = new DatabaseSync(join(root, 'session/session.db'));
    try {
      sessions.exec('PRAGMA journal_mode=DELETE; CREATE TABLE SessionTable(username TEXT, last_timestamp INTEGER, summary TEXT)');
      for (const talker of tables.keys()) sessions.prepare('INSERT INTO SessionTable VALUES(?,?,?)').run(talker, baseTs + 5, 'Synthetic ' + talker);
    } finally { sessions.close(); }
    const messages = new DatabaseSync(join(root, 'message/message0.db'));
    try {
      messages.exec('PRAGMA journal_mode=DELETE');
      for (const table of tables.values()) messages.exec('CREATE TABLE "' + table + '"(local_id INTEGER, create_time INTEGER, message_content TEXT, local_type INTEGER)');
      const alpha = messages.prepare('INSERT INTO "' + tables.get('alpha') + '" VALUES(?,?,?,1)');
      for (const [id, offset, body] of [[1, -1, 'UNAUTHORIZED-before'], [2, 0, 'Synthetic alpha lower'], [3, 5, 'Synthetic alpha middle'], [4, 10, 'Synthetic alpha upper'], [5, 11, 'UNAUTHORIZED-after']]) alpha.run(id, baseTs + offset, body);
      messages.prepare('INSERT INTO "' + tables.get('beta') + '" VALUES(?,?,?,1)').run(6, baseTs + 5, 'UNAUTHORIZED-beta');
    } finally { messages.close(); }
    const bridge = f.bridge({ archive }), sessionId = await bridge.createConversation(f.context.id), agent = f.route(sessionId);
    history.set(sessionId, false);
    assert.equal(archive.getState(sessionId).granted, false);
    assert.ok(JSON.stringify(await execute(f, agent, { action: 'messages', talker: 'alpha' })).includes('error'));
    assert.equal(f.adapter.requests.length, 0);
    const grant = { root, allConversations: false, talkers: ['alpha'], fromTs: baseTs, toTs: baseTs + 10, allowWechat: false, confirmation: 'read-decrypted-snapshot' };
    await archive.grant(sessionId, grant);
    const local = await archive.query(sessionId, { action: 'messages', talker: 'alpha' });
    assert.deepEqual(local.rows.map(row => row.ts), [baseTs + 10, baseTs + 5]);
    assert.equal(local.limit, 2); assert.equal(local.hasMore, true); assert.equal(local.scopeApplied, 'sql-before-rows');
    assert.equal(history.get(sessionId), true); assert.equal(archive.canShare(sessionId), false);
    await assert.rejects(bridge.reply(sessionId, 'not shared', { messageId: 'association-not-shared' }), code('archive-denied'));
    assert.equal(f.adapter.requests.length, 0);
    const shared = await archive.grant(sessionId, { ...grant, allowWechat: true });
    assert.equal(shared.allowWechat, true); assert.equal(shared.formatVerified, false);
    const credentials = { botToken: 'synthetic-association-token', botId: 'synthetic-association-bot', userId: 'synthetic-association-owner', baseUrl: 'https://ilinkai.weixin.qq.com' };
    let state = { version: 2, revision: 1, sessionId, credentials, cursor: '', seenMessageIds: [], pending: null, queuedBatch: null };
    channel = createWeixinChannel({ enabled: true, sessionId,
      store: { async read() { return structuredClone(state); }, async commit(expected, next) { assert.equal(state.revision, expected); state = structuredClone(next); } },
      api: {
        async requestQrCode() { qrRequests++; throw new Error('Synthetic association must not request a QR'); },
        async getQrStatus() { qrRequests++; throw new Error('Synthetic association must not poll login'); },
        async getUpdates(_credentials, _cursor, signal) {
          assert.ok(signal instanceof AbortSignal); updates++;
          return { cursor: 'synthetic-cursor-' + updates, messages: [{ messageId: 'association-message-' + updates, fromUserId: credentials.userId, toUserId: credentials.botId, contextToken: 'synthetic-association-context', text: 'Query the authorized alpha scope' }], ignored: 0 };
        },
        async sendText(actualCredentials, request, signal) { assert.ok(signal instanceof AbortSignal); sent.push({ credentials: structuredClone(actualCredentials), request: structuredClone(request) }); return { accepted: true }; },
      },
      reply: (text, metadata, signal) => bridge.reply(sessionId, text, metadata, signal),
      beforeSend: () => archive.canShare(sessionId) && bridge.isPrepared(sessionId),
    });
    assert.deepEqual(await channel.pollOnce(), { received: 1, replied: 1, ignored: 0, duplicates: 0 });
    assert.equal(f.adapter.requests.length, 2);
    const modelContext = textOf(f.adapter.requests[1].messages);
    for (const body of ['Synthetic alpha upper', 'Synthetic alpha middle']) assert.ok(modelContext.includes(body));
    for (const body of ['UNAUTHORIZED-before', 'UNAUTHORIZED-after', 'UNAUTHORIZED-beta', root]) assert.equal(modelContext.includes(body), false);
    assert.equal(sent.length, 1); assert.deepEqual(sent[0].credentials, credentials);
    assert.equal(sent[0].request.toUserId, credentials.userId); assert.equal(sent[0].request.contextToken, 'synthetic-association-context'); assert.equal(sent[0].request.text, 'Synthetic scoped alpha reply');
    const log = await f.stored(sessionId);
    assert.equal(log.header.id, sessionId); assert.equal(log.header.agentPreset, SESSION_BRIDGE_PRESET_ID);
    assert.equal(log.events.filter(event => event.type === 'tool/call' && event.data.name === 'wechat_archive').length, 1);
    assert.equal(state.pending, null); assert.equal(state.queuedBatch, null); assert.deepEqual(state.seenMessageIds, ['association-message-1']);
    const revoked = archive.revoke(sessionId);
    assert.equal(revoked.granted, false); assert.equal(revoked.shareable, false); assert.equal(revoked.sessionMayContainArchiveData, true);
    await assert.rejects(channel.pollOnce(), error => error.code === 'reply-failed');
    assert.equal(f.adapter.requests.length, 2); assert.equal(sent.length, 1); assert.equal(state.pending.phase, 'replying');
    await assert.rejects(channel.pollOnce(), error => error.code === 'recovery-required');
    assert.equal(updates, 2); assert.equal(qrRequests, 0); assert.equal(forbiddenNetwork, 0);
  } finally {
    try { channel?.dispose(); await archive.dispose(); await f.dispose(); }
    finally { globalThis.fetch = originalFetch; assert.equal(forbiddenNetwork, 0); }
  }
});

test('real SDK: GUI-first private query is unavailable until a verified Root binding; revoked in-flight leases disclose no rows', { timeout: 10000 }, async () => {
  const f = await fixture();
  const started = deferred(), release = deferred();
  try {
    const first = f.bridge();
    const sessionId = await first.createConversation(f.context.id);
    await first.dispose();
    const gui = await f.guiResume(sessionId);
    const unbound = JSON.stringify(await execute(f, gui.agent, { action: 'search', query: 'synthetic' }));
    assert.ok(unbound.includes('unavailable'));
    assert.equal(f.archive.calls.length, 0);
    const borrowed = f.bridge();
    await borrowed.ensure(sessionId);
    f.archive.query = async () => { started.resolve(); await release.promise; return { rows: [{ text: 'SYNTHETIC_PRIVATE stale row' }] }; };
    const result = execute(f, gui.agent, { action: 'search', query: 'synthetic' });
    await started.promise;
    await borrowed.dispose();
    assert.equal(f.ctx.agents.get(SessionId(sessionId)), gui.agent);
    release.resolve();
    const afterRevoke = JSON.stringify(await result);
    assert.ok(afterRevoke.includes('unavailable'));
    assert.equal(afterRevoke.includes('SYNTHETIC_PRIVATE'), false);
    assert.equal(NativePolicy.hasSessionBridgePolicy(gui.agent), true);
    await f.unregister(); // a live agent retains its old restrictive generation
    assert.equal(NativePolicy.hasSessionBridgePolicy(gui.agent), true);
    assert.deepEqual(f.ctx.tools.schemas(scopeOf(gui.agent.ctx)).map(schema => schema.name), ['wechat_archive']);
    assert.ok(JSON.stringify(await execute(f, gui.agent, {}, 'synthetic_global')).includes('error'));
    assert.ok(JSON.stringify(await execute(f, gui.agent, { action: 'search' })).includes('unavailable'));
    assert.equal(f.globalCalls.length, 0);
  } finally { release.resolve(); await f.dispose(); }
});

test('real SDK: concurrently queued Web turns are not the WeChat reply; native reasoning never leaves', { timeout: 10000 }, async () => {
  const webStarted = deferred(), releaseWeb = deferred();
  const f = await fixture([held(webStarted, releaseWeb, 'WEB ONLY OUTPUT'), () => textChunks('WECHAT OWN OUTPUT', 'SYNTHETIC_PRIVATE REASONING')]);
  try {
    const bridge = f.bridge();
    const sessionId = await bridge.createConversation(f.context.id);
    const agent = f.route(sessionId);
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Web input' }], source: { kind: 'user' } }));
    await webStarted.promise;
    const ownReply = bridge.reply(sessionId, 'WeChat input', { messageId: 'correlated-own' });
    releaseWeb.resolve();
    assert.equal(await ownReply, 'WECHAT OWN OUTPUT');
    assert.equal(f.adapter.requests.length, 2);
    const log = await f.stored(sessionId);
    assert.equal(log.events.filter(event => event.type === 'turn/end').length, 2);
    assert.ok(log.events.some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'reasoning')));
  } finally { releaseWeb.resolve(); await f.dispose(); }
});

for (const source of [
  { kind: 'user' },
  { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'synthetic-spoof', text: 'EXTERNAL SPOOF' }] },
]) test(`real SDK: an externally claimed ${source.kind} input in the own turn is never exempted`, { timeout: 10000 }, async () => {
  const f = await fixture(['MIXED PRIVATE OUTPUT']);
  try {
    const bridge = f.bridge();
    const sessionId = await bridge.createConversation(f.context.id);
    const agent = f.route(sessionId);
    const foreign = createUserMessage({ content: [{ type: 'text', text: 'EXTERNAL PRIVATE INPUT' }], source });
    let externallyClaimed = false;
    agent.ctx.on('agent/inbox/claimed', payload => { if (payload.agent === agent && payload.message.id === foreign.id) externallyClaimed = true; });
    agent.send(foreign, 'next-step', false); // controlled external input, claimed with our next-turn input
    await assert.rejects(bridge.reply(sessionId, 'own input', { messageId: `mixed-${source.kind}` }), code('not-completed'));
    const log = await f.stored(sessionId);
    assert.equal(externallyClaimed, true);
    assert.ok(log.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === foreign.id)));
    assert.equal(f.adapter.requests.length, 1);
  } finally { await f.dispose(); }
});

for (const mode of ['aborted', 'timeout']) test(`real SDK: ${mode} retains busy until non-cooperative work drains, then canceled id is never replayed`, { timeout: 10000 }, async () => {
  const started = deferred(), release = deferred();
  const f = await fixture([held(started, release, 'CANCELED OUTPUT'), 'fresh after cancellation']);
  try {
    const bridge = f.bridge(mode === 'timeout' ? { timeoutMs: 30 } : {});
    const sessionId = await bridge.createConversation(f.context.id);
    const agent = f.route(sessionId);
    const controller = new AbortController();
    const result = bridge.reply(sessionId, 'cancel this exact input', { messageId: `cancel-${mode}` }, controller.signal);
    await started.promise;
    if (mode === 'aborted') controller.abort();
    await assert.rejects(result, code(mode));
    assert.throws(() => bridge.reply(sessionId, 'must remain busy', { messageId: 'not-enqueued' }), code('busy'));
    release.resolve();
    await agent.whenIdle();
    await bridge.dispose();
    const restored = f.bridge();
    await restored.ensure(sessionId);
    f.route(sessionId);
    const requestsBefore = f.adapter.requests.length;
    await assert.rejects(restored.reply(sessionId, 'no replay', { messageId: `cancel-${mode}` }), code('already-processed'));
    assert.equal(f.adapter.requests.length, requestsBefore);
    assert.equal(await restored.reply(sessionId, 'fresh input', { messageId: `fresh-${mode}` }), 'fresh after cancellation');
  } finally { release.resolve(); await f.dispose(); }
});

test('real SDK: abort queued behind a Web turn removes only the exact WeChat input and never cancels Web', { timeout: 10000 }, async () => {
  const started = deferred(), release = deferred();
  const f = await fixture([held(started, release, 'PRESERVED WEB OUTPUT')]);
  try {
    const bridge = f.bridge();
    const sessionId = await bridge.createConversation(f.context.id);
    const agent = f.route(sessionId);
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'preserved Web input' }], source: { kind: 'user' } }));
    await started.promise;
    const controller = new AbortController();
    const result = bridge.reply(sessionId, 'queued WeChat input', { messageId: 'queued-canceled' }, controller.signal);
    await tick();
    controller.abort();
    await assert.rejects(result, code('aborted'));
    assert.ok(agent.status.type !== 'idle');
    release.resolve();
    await agent.whenIdle();
    await f.ctx.sessions.flush(agent.session); // whenIdle is deliberately NOT a persistence barrier
    const log = await f.stored(sessionId);
    const ends = log.events.filter(event => event.type === 'turn/end');
    assert.deepEqual(ends.map(event => event.data.reason.kind), ['completed']);
    assert.equal(f.adapter.requests.length, 1);
    assert.equal(agent.inbox.nextTurn.length, 0);
    assert.ok(log.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'wechat-ro-weixin' && message.source.messageId === 'queued-canceled')));
  } finally { release.resolve(); await f.dispose(); }
});

test('real sessions.flush: durability listener holds reply publication even after native turn completes', { timeout: 10000 }, async () => {
  const f = await fixture(['durable only']);
  const release = deferred(), reached = deferred();
  try {
    const bridge = f.bridge();
    const sessionId = await bridge.createConversation(f.context.id);
    const agent = f.route(sessionId);
    const remove = agent.ctx.on('session/flush', async session => {
      if (session !== agent.session) return;
      reached.resolve();
      await release.promise;
    });
    try {
      let delivered = false;
      const reply = bridge.reply(sessionId, 'barrier input', { messageId: 'barrier' }).then(text => { delivered = true; return text; });
      await reached.promise;
      await agent.whenIdle();
      assert.equal(delivered, false);
      release.resolve();
      assert.equal(await reply, 'durable only');
      const log = await f.stored(sessionId);
      assert.ok(log.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'));
      assert.ok(log.events.some(event => event.type === 'assistant/message'));
    } finally { release.resolve(); remove(); }
  } finally { release.resolve(); await f.dispose(); }
});

test('real Loader: disabling the unique declaration makes both bridge restore and GUI cold resume fail closed', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = f.bridge();
    const sessionId = await first.createConversation(f.context.id);
    await first.dispose();
    await f.unregister();
    const resumed = f.bridge();
    await assert.rejects(resumed.ensure(sessionId), code('preset-unavailable'));
    await assert.rejects(f.guiResume(sessionId), error => {
      assert.match(error.message, /Unknown agent preset/);
      return true;
    });
    assert.equal(f.ctx.agents.get(SessionId(sessionId)), undefined);
    assert.equal(f.ctx.sessions.get(SessionId(sessionId)), undefined);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.dispose(); }
});

test('real SDK: a bare live native-looking agent is not a capability and is never taken or disposed', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const sessionId = `wechat-native-ro-${randomUUID()}`;
    const foreign = await f.ctx.agents.create({ sessionId: SessionId(sessionId), meta: { cwd: f.root, agentPreset: SESSION_BRIDGE_PRESET_ID } });
    f.externalHandles.push(foreign);
    const bridge = f.bridge();
    await assert.rejects(bridge.ensure(sessionId), code('not-prepared'));
    await bridge.dispose();
    assert.equal(f.ctx.agents.get(SessionId(sessionId)), foreign.agent);
    assert.equal(NativePolicy.hasSessionBridgePolicy(foreign.agent), false);
    assert.equal(f.archive.calls.length, 0);
  } finally { await f.dispose(); }
});

test('real SDK: fresh Root/registry cold-restores the same durable log without replacing the id or old input', { timeout: 10000 }, async () => {
  const before = await fixture(['before cold restart']);
  let afterRestart;
  try {
    const initial = before.bridge();
    const sessionId = await initial.createConversation(before.context.id);
    before.route(sessionId);
    await initial.reply(sessionId, 'first cold input', { messageId: 'cold-1' });
    await before.dispose({ keepRoot: true });
    afterRestart = await fixture(['after cold restart'], before.root);
    const resumed = afterRestart.bridge();
    await resumed.ensure(sessionId);
    afterRestart.route(sessionId);
    assert.equal(resumed.isPrepared(sessionId), true);
    await assert.rejects(resumed.reply(sessionId, 'old input cannot replay', { messageId: 'cold-1' }), code('already-processed'));
    assert.equal(await resumed.reply(sessionId, 'second cold input', { messageId: 'cold-2' }), 'after cold restart');
    const log = await afterRestart.stored(sessionId);
    assert.equal(log.header.id, sessionId);
    assert.equal(log.header.agentPreset, SESSION_BRIDGE_PRESET_ID);
    assert.equal(log.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'wechat-ro-weixin').length, 2);
    assert.ok(textOf(afterRestart.adapter.requests[0].messages).includes('first cold input'));
    assert.ok(textOf(afterRestart.adapter.requests[0].messages).includes('before cold restart'));
  } finally {
    if (afterRestart) await afterRestart.dispose();
    else await before.dispose();
  }
});
