// Technical regression: real Cordis, Gateway, Slots/renderer, locale, tab
// registry/controller/domain and store engine. Only transport and workspace/
// Session endpoints are in-memory carriers. No live profile, business data,
// browser, server, credential store, snapshot directory or network is opened.
import strictAssert from 'node:assert/strict'
// React attaches cyclic Fiber graphs to DOM nodes. Never expand those graphs
// into assertion diagnostics: identity failures must stay bounded.
const assert = { ...strictAssert, equal(actual, expected, message) {
  if (actual?.nodeType || expected?.nodeType) return strictAssert.equal(actual === expected, true, message || 'DOM node identity differs');
  return strictAssert.equal(actual, expected, message);
} };
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import ts from 'typescript'
import { EventEmitter } from 'node:events'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import * as hostWire from '../lib/conversation-wire.js'
import { createTaskHistoryAuthority, TASK_HISTORY_AUDIT_SPEC, TASK_FIRST_TEXT_AUDIT_SPEC } from '../lib/task-history.js'
import { randomUUID } from 'node:crypto'

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = realpathSync(process.env.WECHAT_UI_TEST_RUNTIME || dirname(dirname(dirname(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))))))
const runtimeRequire = createRequire(join(runtimeRoot, 'package.json'))
const sdkRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-client-ui-renderer/package.json'))
const pluginRequire = createRequire(join(pluginDir, 'package.json'))
const source = readFileSync(join(pluginDir, 'lib/client.js'), 'utf8')
const protocolSource = readFileSync(join(pluginDir, 'lib/conversation-wire.js'), 'utf8')
const factorySource = protocolSource.slice(protocolSource.indexOf('export function createConversationWire'), protocolSource.indexOf('\nconst wire = createConversationWire(z);')).replace(/^export /, '').trim()
const embeddedFactory = source.slice(source.indexOf('function createConversationWire(z) {'), source.indexOf('    // END CONVERSATION WIRE')).trim()
assert.equal(embeddedFactory, factorySource, 'Browser and Host protocol factories must be byte-identical')
assert.equal(source.match(/ctx\.remote\.\$mount\(/g)?.length, 1, 'One parent mount only')
assert.equal(source.includes("ctx.inject(['remote.' + NAMESPACE], function registerWechatUi(ctx) {"), true, 'Legacy namespace leaf guard must remain')
assert.equal(source.includes("key: 'rightbar.session'"), false)

// Reuse the real archive validator and worker page packer, replacing only IPC.
// Neither an archive directory nor a subprocess is opened by these fixtures.
const archiveAccessUrl = pathToFileURL(join(pluginDir, 'lib/archive-access.js')).href + '?controlled-react-regression'
const archiveWorkerSource = readFileSync(join(pluginDir, 'lib/archive-query-worker.js'), 'utf8')
const pageStart = archiveWorkerSource.indexOf('function page(catalog, q, rawRows) {')
const pageEnd = archiveWorkerSource.indexOf('\nfunction effectiveQuery(', pageStart)
assert.ok(pageStart >= 0 && pageEnd > pageStart, 'Real worker page packer must be available')
const archivePage = vm.runInNewContext('(' + archiveWorkerSource.slice(pageStart, pageEnd) + ')', { Buffer, fail: code => { throw Object.assign(new Error(code), { code }) } })
const archiveMetadata = { version: 1, fingerprint: 'a'.repeat(64) }
const archiveWorkerCalls = []
let archiveFixtureRows = []
const syntheticArchiveFork = () => {
  const child = new EventEmitter()
  let closed = false
  const close = code => { if (!closed) { closed = true; queueMicrotask(() => child.emit('close', code)) } }
  child.kill = () => { close(1); return true }
  child.send = (payload, callback) => {
    archiveWorkerCalls.push(payload); callback?.(null)
    queueMicrotask(() => {
      if (closed) return
      try {
        assert.ok(['inspect', 'query'].includes(payload.kind))
        const rows = payload.query?.action === 'status' ? [{ readOnly: true, metadataOnly: true }] : archiveFixtureRows.slice(payload.query?.offset || 0)
        const value = payload.kind === 'inspect' ? archiveMetadata : archivePage({ metadata: archiveMetadata, limits: payload.limits }, payload.query, rows)
        child.emit('message', { ok: true, value: JSON.parse(JSON.stringify(value)) }); close(0)
      } catch (error) { child.emit('message', { ok: false, code: error.code || 'worker-failed' }); close(1) }
    })
  }
  return child
}

let networkAttempts = 0
const denyNetwork = () => { networkAttempts++; throw new Error('Network forbidden in controlled conversation regression') }
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:child_process' && context.parentURL === archiveAccessUrl) return { url: 'offline-archive-ipc:', format: 'module', shortCircuit: true }
    if (/\.css(?:[?#].*)?$/.test(specifier)) return { url: 'offline-css:' + encodeURIComponent(specifier), format: 'module', shortCircuit: true }
    if (/^https?:/.test(specifier)) return denyNetwork()
    if (specifier === 'picomatch/posix') return nextResolve('picomatch/posix.js', context)
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (/\.tsx?$/.test(url) && url.startsWith(pathToFileURL(join(runtimeRoot, 'node_modules/@deepseek-ai/')).href)) {
      const source = readFileSync(fileURLToPath(url), 'utf8')
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, useDefineForClassFields: true } }).outputText }
    }
    if (url === 'offline-archive-ipc:') return { format: 'module', source: 'export const fork = globalThis.__wechatSyntheticArchiveFork', shortCircuit: true }
    if (url.startsWith('offline-css:')) return { format: 'module', source: 'export default Object.freeze({})', shortCircuit: true }
    return nextLoad(url, context)
  },
})
const globals = new Map()
const install = (key, value) => { globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
const importSdk = specifier => import(specifier)
let dom, cleanup, ctx, view, consumer, gateway, right, releaseRoot
const releases = []

try {
  install('__wechatSyntheticArchiveFork', syntheticArchiveFork)
  const { createArchiveAccess } = await import(archiveAccessUrl)
  const { JSDOM } = runtimeRequire('jsdom')
  dom = new JSDOM('<!doctype html>')
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true, fetch: denyNetwork })) install(key, value)
  dom.window.fetch = denyNetwork
  dom.window.XMLHttpRequest = class { constructor() { denyNetwork() } }
  dom.window.WebSocket = class { constructor() { denyNetwork() } }
  const React = sdkRequire('react')
  const { render, fireEvent, act, within, cleanup: cleanupReact } = runtimeRequire('@testing-library/react')
  cleanup = cleanupReact
  const { Context, Service } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/cordis')).href)
  const gatewayModule = await import(pathToFileURL(createRequire(join(runtimeRoot, 'packages/api/gateway/package.json')).resolve('@deepseek-ai/dsh-api-gateway/client')).href)
  const { SlotRegistry } = await importSdk('@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts')
  const { createSlotRenderer } = await importSdk('@deepseek-ai/dsh-client-ui-renderer/src/client/scoped-slots.tsx')
  const { observableHook } = await importSdk('@deepseek-ai/dsh-client-ui-renderer/src/client/bindings.tsx')
  const { LocaleRuntime } = await importSdk('@deepseek-ai/dsh-client-locale/src/client/index.ts')
  const { SidebarRightTabRegistry } = await importSdk('@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts')
  const { createSidebarRightController } = await importSdk('@deepseek-ai/dsh-client-ui-sidebar-right/src/client/service.ts')
  const { createSidebarRightStore } = await importSdk('@deepseek-ai/dsh-client-ui-sidebar-right/src/client/stores.ts')
  const { activeDockPaneId, getPane } = await importSdk('@deepseek-ai/dsh-client-ui-dockkit')
  const { tabInfoFactory } = await importSdk('@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-info.ts')
  const { pageAddress } = await importSdk('@deepseek-ai/dsh-client-ui-sidebar-right/src/client/contract/seed.ts')
  const { createSnapshotStore } = await importSdk('@deepseek-ai/dsh-client-store')
  const { LayoutController } = await importSdk('@deepseek-ai/dsh-client-ui-layout/src/client/service.ts')
  const { createLayoutStore } = await importSdk('@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts')
  const { UiSession } = await importSdk('@deepseek-ai/dsh-client-ui-session/src/client/index.ts')
  const nativeModelPlugin = await importSdk('@deepseek-ai/dsh-client-ui-model-selection/src/client/index.ts')
  const { UiWorkspaceService } = await importSdk('@deepseek-ai/dsh-client-ui-workspace/src/client/navigation.ts')
  const { ClientCordisInspectRegistry, provideClientCordisInspect } = await importSdk('@deepseek-ai/dsh-cordis-client-runner/src/client/inspect-registry.ts')
  // Local-download observation belongs only to this isolated JSDOM/VM carrier.
  // No browser URL, filesystem export, or real anchor navigation is performed.
  const downloads = [], downloadUrls = new Map(), revokedDownloadUrls = []
  let failDownload = false, downloadSerial = 0
  class QueryBlob {
    constructor(parts, options) { this.content = parts.join(''); this.type = options.type }
  }
  const queryDownloadUrl = {
    createObjectURL(blob) {
      if (failDownload) throw new Error('Synthetic local download unavailable')
      const url = 'blob:synthetic-query-' + ++downloadSerial
      downloadUrls.set(url, blob)
      return url
    },
    revokeObjectURL(url) { revokedDownloadUrls.push(url); downloadUrls.delete(url) },
  }
  dom.window.HTMLAnchorElement.prototype.click = function () {
    assert.equal(dom.window.document.body.contains(this), true)
    const blob = downloadUrls.get(this.href)
    assert.ok(blob, 'Only an isolated synthetic download URL may be clicked')
    downloads.push({ filename: this.download, mime: blob.type, content: blob.content })
  }
  let factory
  vm.runInNewContext(source, { window: { crypto: dom.window.crypto, __ModuleLoader__: { load: entry => { factory = entry.factory } } }, document: dom.window.document, navigator: dom.window.navigator, AbortController, AbortSignal, setTimeout, clearTimeout, console, Blob: QueryBlob, URL: queryDownloadUrl, fetch: denyNetwork }, { filename: join(pluginDir, 'lib/client.js') })
  const client = factory(name => {
    if (name === 'react') return React
    if (name === 'zod') return pluginRequire('zod')
    throw new Error('Unexpected browser module: ' + name)
  })
  assert.equal(client.CONTRIBUTION.descriptors.length, 11)
  assert.equal(client.CONVERSATION_CONTRIBUTION.descriptors.length, 2)
  assert.deepEqual(Array.from(client.CONVERSATION_METHOD_NAMES), ['getConversationState', 'conversationAction'])
  assert.deepEqual(Object.keys(client.__conversationI18n.zh).sort(), Object.keys(client.__conversationI18n.en).sort())
  for (const dictionary of Object.values(client.__conversationI18n)) {
    assert.equal(Object.values(dictionary).every(value => typeof value === 'string'), true)
    for (const code of hostWire.CONVERSATION_ERROR_CODES) assert.equal(typeof dictionary[code], 'string', 'Localized error: ' + code)
  }
  for (const code of hostWire.CONVERSATION_ERROR_CODES) {
    const failure = { ok: false, error: { code } }
    for (const schema of [hostWire.actionResultSchema, hostWire.TASK_WIRE.actionResultSchema,
      client.__conversationWire.actionResultSchema, client.__conversationWire.taskWire.actionResultSchema]) {
      assert.equal(schema.safeParse(failure).success, true, code)
      assert.equal(schema.safeParse({ ok: false, error: { code, cause: 'synthetic-private-cause' } }).success, false)
    }
  }
  for (const key of ['TASK_PANEL', 'TASK_TAB_ID', 'TASK_TAB_KIND']) assert.equal(Object.hasOwn(client, key), false, 'Retired Task UI is not exported')
  assert.equal(source.match(/ctx\.sidebarRightTabs\.register\(/g)?.length, 1, 'One registered WeChat tab type')
  assert.deepEqual(Object.keys(client.__taskI18n.zh).sort(), Object.keys(client.__taskI18n.en).sort())
  for (const language of ['zh', 'en']) assert.deepEqual(canonicalTaskDictionary(client.__taskI18n[language]), canonicalTaskDictionary(client.__i18n[language].task))
  function canonicalTaskDictionary(value) { return JSON.parse(JSON.stringify(value)) }
  for (const language of ['zh', 'en']) assert.deepEqual(JSON.parse(JSON.stringify(client.__i18n[language])), JSON.parse(readFileSync(join(pluginDir, 'locale', language + '.json'), 'utf8')), 'Embedded legacy dictionary must match its shipped locale')
  const canonical = descriptor => JSON.parse(JSON.stringify(descriptor))
  assert.deepEqual(Array.from(client.CONVERSATION_CONTRIBUTION.descriptors, canonical), hostWire.CONVERSATION_CONTRIBUTION.descriptors.map(canonical))

  const sessionId = 'controlled-origin'
  const createdId = 'controlled-readonly'
  const secondBotId = 'controlled-readonly-b'
  const grantRoot = '/synthetic-unopened/grant-only'
  const botRoots = new Map([[createdId, '/synthetic-unopened/bot-a'], [secondBotId, '/synthetic-unopened/bot-b']])
  let nextCreatedId = createdId
  let syntheticLoginStatus = 'confirmed'
  const ownerId = 'controlled-private-owner'
  const privateBody = '<script>controlled-private-archive</script>'
  const privateTemporaryReference = { handle: 'synthetic-private-temporary-reference', privatePath: '/synthetic-unopened/temporary-handle' }
  const qr = { payloadKind: 'ilink-login', rows: Array.from({ length: 21 }, () => '1'.repeat(21)) }
  const fixtureGrant = { root: grantRoot, allConversations: false, talkers: ['controlled-talker'], fromTs: null, toTs: null, allowWechat: false, confirmation: 'read-decrypted-snapshot' }
  const createArchiveFixture = async (rows, options = {}) => {
    const access = createArchiveAccess({ ...options, hasArchiveHistory: () => false, markArchiveHistory: () => {} })
    releases.push(() => access.dispose())
    await access.grant(sessionId, fixtureGrant)
    return { rows, access, lastResult: null }
  }
  const positives = [
    { action: 'createConversation', contextSessionId: sessionId, confirmation: 'create-readonly-conversation' },
    { action: 'grantSnapshot', sessionId, root: grantRoot, allConversations: false, talkers: ['controlled-talker'], fromTs: null, toTs: null, allowWechat: false, confirmation: 'read-decrypted-snapshot' },
    { action: 'revokeSnapshot', sessionId, confirmation: 'revoke-snapshot' },
    { action: 'queryArchive', sessionId, query: { action: 'messages', talker: 'controlled-talker', limit: 50, offset: 0 } },
    { action: 'beginLogin', sessionId, confirmation: 'network-login' },
    { action: 'pollLogin', sessionId },
    { action: 'confirmPairing', sessionId, expectedOwnerId: ownerId, confirmation: 'persist-pairing' },
    { action: 'startChannel', sessionId, allowSharedContext: true, confirmation: 'poll-and-reply' },
    { action: 'stopChannel', sessionId, confirmation: 'stop-channel' },
    { action: 'forgetPairing', sessionId, confirmation: 'forget-local-credentials' },
    { action: 'discardPending', sessionId, confirmation: 'discard-without-retry' },
    { action: 'resumeConversation', sessionId, confirmation: 'resume-readonly-conversation' },
  ]
  const negatives = [undefined, {}, { ...positives[0], confirmation: 'yes' }, { ...positives[0], actor: 'user' }, { ...positives[1], allConversations: true }, { ...positives[1], talkers: [] }, { ...positives[1], talkers: ['x', 'x'] }, { ...positives[1], allowWechat: 1 }, { ...positives[1], fromTs: 2, toTs: 1 }, { ...positives[1], extra: 'private' }, { ...positives[3], query: { action: 'sql', query: 'select *' } }, { ...positives[3], query: { action: 'messages', root: grantRoot } }, { ...positives[3], query: { action: 'search', query: 'x', limit: 501 } }, { ...positives[3], query: { action: 'status', offset: -1 } }, { ...positives[7], allowSharedContext: false }, { ...positives[10], confirmation: 'retry' }]
  assert.equal(positives.length, 12)
  for (const wire of [hostWire, client.__conversationWire]) {
    assert.equal(wire.CONVERSATION_ACTION_NAMES.length, 12, 'Ordinary Owner action count must remain twelve')
    assert.deepEqual(Array.from(wire.CONVERSATION_ACTION_NAMES), hostWire.CONVERSATION_ACTION_NAMES)
  }
  for (const request of positives) {
    assert.equal(hostWire.actionSchema.safeParse(request).success, true, request.action)
    assert.equal(client.__conversationWire.actionSchema.safeParse(request).success, true, request.action)
  }
  for (const request of negatives) {
    assert.equal(hostWire.actionSchema.safeParse(request).success, false)
    assert.equal(client.__conversationWire.actionSchema.safeParse(request).success, false)
  }
  for (const matrix of [qr, { ...qr, rows: Array.from({ length: 25 }, () => '0'.repeat(25)) }]) assert.equal(hostWire.qrSchema.safeParse(matrix).success, true)
  for (const matrix of [{ ...qr, rows: qr.rows.slice(0, 20) }, { ...qr, url: 'https://never-open.invalid' }, { ...qr, rows: Array.from({ length: 22 }, () => '0'.repeat(22)) }, { ...qr, rows: Array.from({ length: 21 }, () => '<script>'.repeat(3)) }]) assert.equal(hostWire.qrSchema.safeParse(matrix).success, false)
  assert.equal(hostWire.actionResultSchema.safeParse({ ok: false, error: { code: 'ACTION_FAILED', message: 'private' } }).success, false)
  assert.equal(hostWire.getStateRequestSchema.safeParse({ actor: 'user' }).success, false)
  assert.equal(hostWire.CONVERSATION_CONTRIBUTION.descriptors[0].parameters[0].acceptsUndefined, true)
  assert.equal(hostWire.CONVERSATION_CONTRIBUTION.descriptors[1].parameters[0].acceptsUndefined, false)

  ctx = new Context()
  const slots = new SlotRegistry(ctx)
  const locale = new LocaleRuntime(ctx)
  ctx.reflect.provide('locale', locale); locale.setLocale('en')
  slots.install(createSlotRenderer()); slots.installLocale(locale)
  const layoutStore = createLayoutStore().create()
  const panelInfo = { getSnapshot: () => layoutStore.getSnapshot().panelInfo, subscribe: listener => layoutStore.subscribe(listener) }
  const layout = new LayoutController(layoutStore.actions, id => slots.entries('main').some(entry => entry.options.key === id), panelInfo)
  ctx.reflect.provide('layout', layout)
  releases.push(() => layout.dispose())
  slots.provideRoot({ hooks: { panelInfo } })
  const tabs = new SidebarRightTabRegistry(ctx)
  const trace = []
  right = createSidebarRightController(tabs, () => {}, { autoFullscreen: () => false, openWithFocus: (_id, open) => { open() }, closeWithFocus: (_id, _pane, close) => { close() } })
  const actualOpenTab = right.controller.openTab.bind(right.controller)
  right.controller.openTab = (...args) => { trace.push(['openTab', right.controller.mounted.getSnapshot()]); return actualOpenTab(...args) }
  ctx.reflect.provide('sidebarRightTabs', tabs); ctx.reflect.provide('sidebarRight', right.controller)
  const stores = new Map(), states = new Map(), bindings = new Map(), retains = new Map(), nativeStreams = new Map(), nativeSelections = new Map()
  const defaultState = (id, prepared = false) => ({ version: '0.2.0', sessionId: id, prepared, archive: { granted: false, allowWechat: false, allConversations: false, talkers: [], fromTs: null, toTs: null, sessionMayContainArchiveData: false, historyKnown: false, shareable: false, activeQueries: 0, lastError: null, format: 'fixed-sql-plaintext' }, channel: { enabled: false, phase: 'unpaired', hasStoredLogin: false, pendingRecovery: false, messagingVerified: false }, lastError: null })
  const TASK1 = 'wechat-task-11111111-1111-4111-8111-111111111111'
  const TASK2 = 'wechat-task-22222222-2222-4222-8222-222222222222'
  const TASK3 = 'wechat-task-33333333-3333-4333-8333-333333333333'
  const AUTOTASK = 'wechat-task-69042b73-5bf5-45f5-925c-4af7c88d5011'
  let loseAutoConnectResponse = false, rejectAutoConnect = false, rejectLocalHistoryImport = null
  const taskWorkspace = { id: 'synthetic-task-workspace', root: '/synthetic-unopened/task-workspace', title: 'Synthetic task workspace' }
  const taskExtraRoot = '/synthetic-unopened/task-extra'
  const taskArchiveRoot = '/synthetic-unopened/task-archive'
  const taskPrivateText = '<script>synthetic-task-source</script>'
  const taskContacts = [{ talker: 'synthetic-person-a', displayName: 'Synthetic Alice' }, { talker: 'synthetic-person-b', displayName: 'Synthetic Bob' }, { talker: 'synthetic-person-c', displayName: 'Synthetic Chen' }]
  const taskRecords = new Map(), knownTaskIds = new Set(), taskTitles = new Map([[TASK1, 'Synthetic first task'], [TASK2, 'Synthetic second task'], [TASK3, 'Synthetic late task']])
  let taskGeneration = 0, taskDirectorySerial = 0, nextTaskCreateId = TASK1, nextTaskMutation = null, deferredTaskMutation = null, nextTaskRead = null, deferredTaskRead = null, nextTaskQuery = null, deferredTaskQuery = null, nextTaskPicker = null, deferredTaskPicker = null, pickerCalls = 0
  let taskLoginFailure = null
  const taskRecord = id => {
    if (!taskRecords.has(id)) taskRecords.set(id, { prepared: false, historyKnown: false, workspace: null, sources: new Map(), consumed: new Map(), allowWechat: false, channel: { ...defaultState(id).channel, messagingEnabled: false, automaticPolling: false } })
    const record = taskRecords.get(id)
    record.firstText ??= { available: true, ready: false, valid: false, owner: record, reason: 'model-not-selected', model: null, native: null, preparation: null, observation: null, modelObservation: null }
    return record
  }
  const taskSource = (record, sourceId, value) => record.sources.set(sourceId, { ...value, sourceId, generation: ++taskGeneration })
  const taskCanShare = record => record.prepared && record.historyKnown && record.allowWechat && record.sources.has('workspace')
    && [...record.consumed.values()].every(value => record.sources.get(value.sourceId)?.generation === value.generation && record.sources.get(value.sourceId)?.allowWechat === true)
  const taskState = id => {
    const record = knownTaskIds.has(id) ? taskRecords.get(id) : null
    return { kind: 'task', version: '0.2.0-task-v1', sessionId: id ?? null, available: true, prepared: record?.prepared === true,
      task: record ? { version: 1, sessionId: id, disposed: false, prepared: record.prepared, historyKnown: record.historyKnown, workspace: record.workspace,
        allowWechat: record.allowWechat, shareable: taskCanShare(record), sessionMayContainData: record.consumed.size > 0,
        contextBlocked: !record.historyKnown || [...record.consumed.values()].some(value => record.sources.get(value.sourceId)?.generation !== value.generation),
        sources: [...record.sources.values()].map(({ generation, ...value }) => value), lastError: null } : null,
      channel: record?.channel || { ...defaultState(id).channel, messagingEnabled: false, automaticPolling: false },
      tasks: [...knownTaskIds].map(sessionId => ({ sessionId, title: taskTitles.get(sessionId), prepared: taskRecords.get(sessionId)?.prepared === true })), workspaces: [taskWorkspace], lastError: null }
  }
  const historyAuthorities = new Map(), historyAuditRows = new Map(), firstAuditRows = new Map()
  let nextHistoryPoll = null
  let nextUpdatesDiagnostic = null, deferredUpdatesDiagnostic = null
  const validUpdatesDiagnostic = { version: 1, outcome: 'valid', errorCode: null, validationField: null,
    msgsShape: 'array', cursorShape: 'string', messageCount: 3, textCount: 1, ignoredCount: 2, httpStatus: 200, businessCode: 0 }
  const historyFor = id => {
    if (historyAuthorities.has(id)) return historyAuthorities.get(id)
    const record = taskRecord(id)
    const tableFor = (rows, spec) => ({ get size() { return rows.size }, get: key => rows.get(key),
      async put(key, value) { rows.set(key, spec.tables.tasks.valueSchema.parse(structuredClone(value))) },
      async update(key, update) { rows.set(key, spec.tables.tasks.valueSchema.parse(structuredClone(update(rows.get(key))))) } })
    const tables = new Map([[TASK_HISTORY_AUDIT_SPEC, tableFor(historyAuditRows, TASK_HISTORY_AUDIT_SPEC)], [TASK_FIRST_TEXT_AUDIT_SPEC, tableFor(firstAuditRows, TASK_FIRST_TEXT_AUDIT_SPEC)]])
    const authority = createTaskHistoryAuthority({
      snapshot: () => ({ prepared: record.prepared, historyKnown: record.historyKnown, workspace: record.workspace, cwd: record.workspace?.root,
        consumed: [...record.consumed.values()].map(value => ({ ...value, kind: value.kind || (value.sourceId === 'workspace' ? 'directory' : 'archive') })),
        revision: record.historyRevision || 0, shareContext: record.allowWechat, sdkAvailable: true, sdkReady: record.historySdkReady !== false,
        sdkOwner: record, sdkSequence: record.historySequence || 1, firstText: record.firstText }),
      storage: () => ({ async open(spec) { assert.ok(tables.has(spec)); return { table: () => tables.get(spec), async close() {} } } }),
      closeSharing: () => { record.allowWechat = false }, openSharing: () => { record.allowWechat = true },
      fail: code => { throw Object.assign(new Error('Synthetic historical refusal'), { code }) },
    })
    historyAuthorities.set(id, authority); releases.push(() => authority.dispose()); return authority
  }
  const otherId = 'controlled-other'
  const generationContexts = []
  const prompts = [], selected = []
  const sessionList = createSnapshotStore({ phase: 'ready', ids: [], byId: {}, projectionsBySession: {} })
  const publishList = () => sessionList.set({ phase: 'ready', ids: [...states.keys()], byId: Object.fromEntries([...states.keys()].map(id => [id, { id, displayTitle: taskTitles.get(id) || 'Synthetic ' + id, title: id, blank: false, running: id === sessionId, retainedBy: retains.get(id).getSnapshot().retainedBy }])), projectionsBySession: {} })
  const addNativeSession = (id, prepared = false) => {
    states.set(id, defaultState(id, prepared))
    const generation = new Context(); generationContexts.push(generation)
    const stream = createSnapshotStore({ header: { id }, running: id === sessionId, streamingText: 'SSE · token 1' }); nativeStreams.set(id, stream)
    const selection = createSnapshotStore({ lastUsed: null, next: null }); nativeSelections.set(id, selection)
    const face = { sessionId: id, getSnapshot: stream.getSnapshot, subscribe: stream.subscribe, projections: { faceOf: key => key === 'modelSelection' ? selection : undefined }, prompt: async (content, mode, signal) => { assert.equal(mode, 'queue'); assert.equal(signal instanceof AbortSignal, true); prompts.push({ id, content, mode }); return { ok: true, value: { accepted: true } } } }
    bindings.set(id, { sessionId: id, ctx: generation, session: face })
    retains.set(id, createSnapshotStore({ retainedBy: {} }))
  }
  for (const id of [sessionId, createdId, secondBotId, otherId]) addNativeSession(id, id === createdId)
  addNativeSession(TASK2)
  taskRecord(TASK2).workspace = { ...taskWorkspace }
  releases.push(async () => { for (const generation of generationContexts) await generation.fiber.dispose() })
  publishList()
  const sessions = { list: sessionList, binding: id => bindings.get(id), scope: id => bindings.get(id)?.ctx, retainInfo: id => retains.get(id),
    retain(target, options) {
      assert.equal(typeof target, 'string'); assert.equal(bindings.has(target), true)
      const source = retains.get(target)
      const update = delta => { const retainedBy = { ...source.getSnapshot().retainedBy }; retainedBy[options.source] = (retainedBy[options.source] || 0) + delta; source.set({ retainedBy }); publishList() }
      update(1)
      let active = true
      return { sessionId: target, binding: bindings.get(target), ready: Promise.resolve(), release: () => { if (active) { active = false; update(-1) } } }
    }, subagentAddress: () => undefined, create: denyNetwork, resume: denyNetwork, fork: denyNetwork,
  }
  ctx.reflect.provide('sessions', sessions)
  const workspaceList = createSnapshotStore({ phase: 'pending', items: [], archivedSessionIds: [], pinnedSessionIds: [] })
  // Pending workspace metadata prevents the SDK startup-restoration heuristic;
  // all initial/mainView selection below is an explicit controlled test action.
  const workspaces = { list: workspaceList, initializeDefault: denyNetwork, createSession: denyNetwork }
  const connectionGeneration = createSnapshotStore({ id: 1, host: { home: '/synthetic-unopened/home' } })
  let current, workspace
  const inspectResults = []
  const inspectRegistry = new ClientCordisInspectRegistry({ sync: async () => {}, resolve: async (_agentId, _requestId, result) => { inspectResults.push(result) } })
  provideClientCordisInspect(ctx, inspectRegistry)
  let mounts = 0, withdrawals = 0
  const fibers = []
  let publishOld, publishNew
  const oldPublished = new Promise(resolve => { publishOld = resolve })
  const newPublished = new Promise(resolve => { publishNew = resolve })
  ctx.on('internal/plugin', fiber => {
    fibers.push(fiber)
    if (fiber.runtime?.name === 'registerWechatUi') publishOld(fiber)
    if (fiber.runtime?.name === 'registerWechatConversation') publishNew(fiber)
  })
  ctx.reflect.provide('typert', { remotes: { register: contribution => { assert.equal(contribution, client.CONTRIBUTION); mounts++; return () => { withdrawals++ } } }, contexts: { getClient: () => undefined } })
  const calls = []
  let largeQuery = false, manyRows = false, missingSource = false
  let archiveFixture = null
  // Synthetic UI reload seam only: retained catalogue SID, lost preparation memory.
  // This is not a real Host restart; resume changes prepared only, never grants.
  const explicitlyCreatedBridgeIds = new Set()
  let deferQuery = false
  let deferredQuery = null
  let nextMutation = null
  let deferredMutation = null
  let nextStateRead = null
  let nextTextOnce = null
  let deferredTextOnce = null
  let historySourcesMode = 'failed'
  const taskRpc = async (endpoint, request, signal) => {
    if (endpoint.endsWith('/getConversationState')) {
      hostWire.TASK_WIRE.getStateRequestSchema.parse(request)
      const value = canonical(taskState(request.sessionId))
      if (nextTaskRead && request.sessionId === nextTaskRead.sessionId) {
        const scenario = nextTaskRead; nextTaskRead = null
        if (scenario.mode === 'wrong-sid') return { ok: true, value: { ...value, sessionId: otherId, task: null } }
        if (scenario.mode === 'wrong-role') return { ok: true, value: defaultState(request.sessionId, true) }
        if (scenario.mode === 'malformed') return { ok: true, value: { kind: 'task', sessionId: request.sessionId } }
        assert.equal(scenario.mode, 'deferred')
        return await new Promise(resolve => { deferredTaskRead = { signal, sessionId: request.sessionId, value, resolve: () => resolve({ ok: true, value }) } })
      }
      return { ok: true, value: hostWire.TASK_WIRE.stateSchema.parse(value) }
    }
    hostWire.TASK_WIRE.actionSchema.parse(request)
    const id = request.sessionId ?? request.contextSessionId
    const success = (target = id, result, extra = {}) => ({ ok: true, value: hostWire.TASK_WIRE.actionResultSchema.parse({ ok: true, state: taskState(target), ...(result !== undefined ? { result } : {}), ...extra }) })
    if (['confirmDailyTodo', 'setDailyTodoState'].includes(request.action)) {
      const cards = taskRecord(id).channel.dailyCards;
      cards.trackedTodos ??= [];
      if (request.action === 'confirmDailyTodo') {
        const report = cards.reports.find(row => row.day === request.day), item = report.todos.find(row => row.id === request.todoId);
        const tracked = { ...item, assignee: request.assignee, day: report.day, completedAt: null };
        cards.trackedTodos.push(tracked); item.tracked = tracked;
      } else {
        const tracked = cards.trackedTodos.find(row => row.id === request.todoId); tracked.completedAt = request.completed ? 1000 : null;
      }
      return success(id, cards);
    }
    if (['setDailyCardTime', 'refreshDailyCards'].includes(request.action)) {
      const record = taskRecord(id);
      if (request.action === 'setDailyCardTime') record.channel.dailyCards.time = request.time;
      return success(id, record.channel.dailyCards);
    }
    if (['importLocalHistory', 'refreshLocalHistory', 'stopLocalHistory'].includes(request.action)) {
      const record = taskRecord(id);
      if (request.action === 'importLocalHistory' && rejectLocalHistoryImport) {
        const code = rejectLocalHistoryImport; rejectLocalHistoryImport = null;
        record.channel.localHistory = { version: 1, enabled: false, phase: 'failed', autoUpdate: true,
          capturedAt: null, lastCheckedAt: null, databaseCount: 0, error: code };
        return { ok: true, value: hostWire.TASK_WIRE.actionResultSchema.parse({ ok: false, error: { code } }) };
      }
      record.channel.localHistory = { version: 1, enabled: request.action !== 'stopLocalHistory', phase: request.action === 'stopLocalHistory' ? 'stopped' : 'ready',
        autoUpdate: request.autoUpdate ?? true, capturedAt: '2026-11-18T22:00:00+08:00', lastCheckedAt: 1, databaseCount: 3, error: null };
      record.channel.dailyCards ??= { version: 1, phase: 'ready', error: null, time: '08:00', nextRunAt: Date.parse('2026-11-19T08:00:00+08:00'), capturedAt: '2026-11-18T22:00:00+08:00', pendingDays: 0,
        stats: [{day:'2026-11-17',messageCount:10,textCount:5,activeContacts:1,activeGroups:1,conversations:[{talker:'alice',displayName:'Alice',messageCount:6,textCount:3},{talker:'group@chatroom',displayName:'A group',messageCount:4,textCount:2}]},{day:'2026-11-18',messageCount:15,textCount:12,activeContacts:2,activeGroups:1,conversations:[]}],
        reports: [{day:'2026-11-16',includedTexts:0,totalTexts:0,partial:false,generatedAt:1,highlights:[],todos:[]},
          {day:'2026-11-17',includedTexts:8,totalTexts:12,partial:true,generatedAt:1,highlights:[{text:'Daily evidence',refs:['b'.repeat(32)],citations:[{talker:'alice',localTime:'2026-11-17T18:00:00+08:00',content:'Original daily evidence',snapshotRef:'a'.repeat(24),recordRef:'b'.repeat(32)}]}],todos:[]}] };
      const cards = record.channel.dailyCards, daily = cards.reports.at(-1);
      if (daily.highlights.length === 1) {
        const cited = (talker, text, ref) => ({ talker, localTime:'2026-11-17T18:00:00+08:00',content:text,snapshotRef:'a'.repeat(24),recordRef:ref.repeat(32) });
        const evidence = (text, citations) => ({text,refs:citations.map(citation=>citation.recordRef),citations});
        daily.highlights.push(...['c','d','e','f'].map((ref,index)=>evidence('Group highlight '+index,[cited('group@chatroom','Group original '+index,ref)])),
          evidence('Public account highlight',[cited('gh_public','Public original','1')]),
          evidence('Service account highlight',[cited('bankservice','Service original','2')]),
          evidence('Two groups discussed the same topic',[cited('group@chatroom','Group original 0','c'),cited('second@chatroom','Second group original','3')]));
        daily.todos.push({...evidence('Group task',[cited('group@chatroom','Group original 0','c')]),assignee:null},
          {...evidence('Personal task',[cited('alice','Original daily evidence','b')]),assignee:'Alice'},
          {...evidence('Compare group and personal requests',[cited('group@chatroom','Group original 0','c'),cited('alice','Original daily evidence','b')]),assignee:null});
        cards.stats[0].sources=[{talker:'alice',displayName:'Alice',sourceKind:'personal'},{talker:'group@chatroom',displayName:'A group',sourceKind:'group'},
          {talker:'second@chatroom',displayName:'Second group',sourceKind:'group'},{talker:'gh_public',displayName:'Public account',sourceKind:'official'},
          {talker:'bankservice',displayName:'Service account',sourceKind:'service'}];
      }
      for (const [i, todo] of daily.todos.entries()) { todo.id ??= (i+1).toString(16).padStart(64,'0'); todo.tracked ??= null; }
      return success(id, record.channel.localHistory);
    }
    if (request.action === 'connectConversation') {
      assert.equal(id, AUTOTASK); assert.equal(request.expectedDirectory, taskWorkspace.root)
      const record = taskRecord(id)
      assert.equal(record.consumed.size, 0); assert.equal(record.prepared, true)
      if (rejectAutoConnect) {
        rejectAutoConnect = false
        record.channel = { ...record.channel, setup: { ...record.channel.setup, phase: 'blocked', error: 'SHARED_CONTEXT_DENIED' } }
        return { ok: true, value: hostWire.TASK_WIRE.actionResultSchema.parse({ ok: false, error: { code: 'SHARED_CONTEXT_DENIED' } }) }
      }
      record.allowWechat = true
      record.channel = { ...record.channel, enabled: true, phase: 'qr-ready', hasStoredLogin: false, pendingRecovery: false,
        setup: { root: taskWorkspace.root, title: taskWorkspace.title, sessionId: id, phase: 'pairing', modelConfigured: true, error: null, qr } }
      const result = success(id, { sessionId: id, automaticTextRequested: true }, { qr })
      assert.equal(client.__conversationWire.taskWire.actionResultSchema.safeParse(result.value).success, true)
      if (loseAutoConnectResponse) { loseAutoConnectResponse = false; throw new Error('Synthetic committed connection response lost') }
      return result
    }
    if (request.action === 'prepareSnapshot') {
      assert.equal(id, sessionId); assert.equal(request.root, taskArchiveRoot); assert.equal(request.confirmation, 'browse-snapshot-roster')
      const offset = request.offset || 0, needle = request.query?.toLowerCase(), rows = taskContacts.filter(row => !needle || row.displayName.toLowerCase().includes(needle)).slice(offset, offset + 2)
      return success(id, { action: 'contacts', rows, returned: rows.length, offset, limit: request.limit, hasMore: offset + rows.length < taskContacts.filter(row => !needle || row.displayName.toLowerCase().includes(needle)).length,
        source: { kind: 'decrypted-wechat-archive', snapshotRef: 'c'.repeat(24) }, untrusted: true, metadataOnly: true, truncated: false })
    }
    const historicalAction = ['allowNewFirstText', 'reviewHistoricalContext', 'authorizeHistoricalContext', 'revokeHistoricalContext', 'selectFirstTextModel', 'reviewFirstTextContext', 'authorizeFirstTextContext', 'revokeFirstTextContext'].includes(request.action)
      || (request.historyConsentId !== undefined || request.firstTextConsentId !== undefined) && ['setSharing', 'pollTextOnce'].includes(request.action)
    if (historicalAction) {
      assert.equal(knownTaskIds.has(id), true)
      const record = taskRecord(id), history = historyFor(id)
      const apply = async () => {
        const first = request.firstTextConsentId !== undefined || ['allowNewFirstText', 'selectFirstTextModel', 'reviewFirstTextContext', 'authorizeFirstTextContext', 'revokeFirstTextContext'].includes(request.action)
        const authority = first ? history.firstText : history, contextName = first ? 'firstTextContext' : 'historicalContext'
        if (request.action === 'allowNewFirstText') return success(id, await authority.allowNewInput(id,
          { priorRunId: request.priorRunId, priorConsentId: request.priorConsentId, confirmation: request.confirmation }, signal))
        if (request.action === 'selectFirstTextModel') {
          history.invalidate(id, 'sdk-changed'); record.historyRevision = (record.historyRevision || 0) + 1; record.allowWechat = false
          if (request.preparationConfirmation === undefined) {
            const configuration = { stopSequenceCount: 0, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
              ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }) }
            record.firstText = { ...record.firstText, ready: false, valid: false, reason: 'model-unprepared', model: null, native: null,
              observation: null, modelObservation: null, preparation: { provider: request.provider, model: request.model, selectionRevision: (record.firstText.preparation?.selectionRevision || 0) + 1, configuration,
                preparation: { supported: true, preparationEffects: { filesystem: false, credentials: false, network: false, cache: true } } } }
          } else {
            const selection = record.firstText.preparation
            assert.equal(selection.selectionRevision, request.selectionRevision); assert.equal(selection.provider, request.provider); assert.equal(selection.model, request.model)
            const model = { version: 1, provider: selection.provider, model: selection.model, selectionRevision: selection.selectionRevision, configurationDigest: 'a'.repeat(64),
              configuration: selection.configuration, defaults: { stopSequenceCount: 0 }, adapterDefaults: {}, contextWindow: 8000,
              versions: { metadata: 1, configuration: 1, connection: 1, authenticationIdentity: 1 } }
            record.firstText = { ...record.firstText, ready: true, valid: true, reason: null, model, observation: {}, modelObservation: {},
              native: { version: 1, purpose: 'first-text-once', agentId: id, sessionId: id, sequence: record.historySequence || 1, surfaceContentGeneration: 0, fixedSystemVersion: 1,
                scope: { fixedSystem: true, soleHumanText: true, priorMessages: false, sources: false, tools: false }, model } }
          }
          return success(id, { firstTextContext: history.firstText.status(id) })
        }
        if (request.action === 'reviewHistoricalContext' || request.action === 'reviewFirstTextContext') {
          const { reviewId, expiresAt, ...context } = await authority.review(id, signal)
          return success(id, { reviewId, expiresAt, [contextName]: context })
        }
        if (request.action === 'authorizeHistoricalContext' || request.action === 'authorizeFirstTextContext') return success(id, await authority.authorize(id, { reviewId: request.reviewId, confirmation: request.confirmation }, signal))
        if (request.action === 'revokeHistoricalContext' || request.action === 'revokeFirstTextContext') return success(id, await authority.revoke(id, { revokeId: request.revokeId }))
        const consentField = first ? 'firstTextConsentId' : 'historyConsentId'
        if (request.action === 'setSharing') return success(id, await authority.share(id, { [consentField]: request[consentField], confirmation: request.confirmation }, signal))
        const scenario = nextHistoryPoll; nextHistoryPoll = null
        const permit = await authority.reserve(id, { [consentField]: request[consentField], confirmation: request.confirmation }, signal)
        if (!first || scenario?.outcome !== 'empty') { authority.bindInput(permit, 'synthetic-ui-input-' + randomUUID(), 1); authority.recordModelRequests(permit, 1) }
        record.channel = { ...record.channel, phase: 'polling', messagingEnabled: true, automaticPolling: false }
        if (scenario?.mode === 'deferred') await new Promise(resolve => { deferredTextOnce = { signal, request: canonical(request), resolve } })
        const outcome = signal.aborted || scenario?.outcome === 'unknown' ? 'unknown' : scenario?.outcome === 'empty' ? 'empty' : 'replied'
        if (outcome === 'replied') authority.completeModel(permit)
        if (first && outcome !== 'empty') record.firstText = { ...record.firstText, ready: false, valid: false, reason: 'not-empty' }
        const result = await authority.finish(permit, { outcome, requestAccepted: outcome === 'replied' ? 1 : 0 })
        record.channel = { ...record.channel, phase: 'paired', messagingEnabled: false, automaticPolling: false }
        if (scenario?.mode === 'committed-response-lost') throw new Error('Synthetic text run response lost')
        return success(id, { received: 1, replied: outcome === 'replied' ? 1 : 0, ignored: 0, duplicates: 0, remaining: 0, ...result })
      }
      if (nextTaskMutation && request.action === nextTaskMutation.action && id === nextTaskMutation.sessionId) {
        const scenario = nextTaskMutation; nextTaskMutation = null
        const value = await apply()
        if (scenario.mode === 'committed-response-lost') throw new Error('Synthetic historical permission response lost')
        assert.equal(scenario.mode, 'deferred')
        return await new Promise(resolve => { deferredTaskMutation = { signal, request: canonical(request), resolve: () => resolve(value) } })
      }
      return apply()
    }
    const mutating = ['createConversation', 'grantWorkspace', 'grantDirectory', 'grantSession', 'grantSnapshot', 'revokeSource', 'setSharing'].includes(request.action)
    if (mutating) {
      const apply = () => {
        if (request.action === 'createConversation') {
          assert.equal(id, sessionId)
          const target = nextTaskCreateId
          assert.equal(knownTaskIds.has(target), false)
          if (!states.has(target)) addNativeSession(target)
          const record = taskRecord(target)
          record.prepared = true; record.historyKnown = true; record.workspace = { ...taskWorkspace, root: request.workspace.root, title: request.workspace.title }
          taskSource(record, 'workspace', { kind: 'directory', root: request.workspace.root, title: request.workspace.title, write: true, allowWechat: request.workspace.allowWechat })
          knownTaskIds.add(target); publishList()
          return success(target, { sessionId: target })
        }
        assert.equal(knownTaskIds.has(id), true)
        const record = taskRecord(id)
        record.channel = { ...record.channel, phase: record.channel.hasStoredLogin ? 'paired' : 'unpaired', automaticPolling: false, messagingEnabled: false }
        if (request.action === 'grantWorkspace') {
          assert.equal(request.workspace.root, record.workspace.root)
          record.workspace = { ...record.workspace, title: request.workspace.title }
          taskSource(record, 'workspace', { kind: 'directory', root: request.workspace.root, title: request.workspace.title, write: true, allowWechat: request.workspace.allowWechat })
        } else if (request.action === 'grantDirectory') {
          assert.equal(request.root, taskExtraRoot)
          taskSource(record, request.sourceId || 'synthetic-task-directory-' + ++taskDirectorySerial, { kind: 'directory', root: request.root, title: request.title, write: false, allowWechat: request.allowWechat })
        } else if (request.action === 'grantSession') {
          assert.equal(request.sourceSessionId, otherId)
          taskSource(record, 'synthetic-task-session', { kind: 'session', sessionId: request.sourceSessionId, title: request.title, allowWechat: request.allowWechat })
        } else if (request.action === 'grantSnapshot') {
          assert.equal(request.root, taskArchiveRoot)
          taskSource(record, 'archive', { kind: 'archive', title: 'WeChat archive', allowWechat: request.allowWechat,
            archive: { granted: true, allConversations: request.allConversations, talkers: request.talkers, fromTs: request.fromTs, toTs: request.toTs, allowWechat: request.allowWechat } })
        } else if (request.action === 'revokeSource') {
          if (request.sourceId === '*') { record.sources.clear(); record.allowWechat = false }
          else record.sources.delete(request.sourceId)
          record.historyRevision = (record.historyRevision || 0) + 1; historyAuthorities.get(id)?.invalidate(id, 'source-changed')
        } else { historyAuthorities.get(id)?.invalidate(id, 'sharing-changed'); record.allowWechat = request.allowWechat }
        return success(id)
      }
      if (nextTaskMutation && request.action === nextTaskMutation.action && id === nextTaskMutation.sessionId) {
        const scenario = nextTaskMutation; nextTaskMutation = null
        if (scenario.mode === 'committed-response-lost') { apply(); throw new Error('Synthetic task mutation response lost') }
        assert.equal(scenario.mode, 'deferred')
        let value = scenario.committed ? apply() : null
        return await new Promise(resolve => { deferredTaskMutation = { signal, request: canonical(request), commit: () => { assert.equal(value, null); value = apply() }, resolve: () => { assert.notEqual(value, null); resolve(value) } } })
      }
      return apply()
    }
    if (request.action === 'resumeConversation' && !taskRecords.has(id)) return { ok: true, value: { ok: false, error: { code: 'SESSION_NOT_READY' } } }
    const record = taskRecord(id)
    if (request.action === 'resumeConversation') {
      record.prepared = true; record.historyKnown = true; knownTaskIds.add(id)
      return success(id, { sessionId: id, sameSession: true })
    }
    assert.equal(record.prepared, true)
    if (request.action === 'diagnoseUpdatesOnce') {
      const scenario = nextUpdatesDiagnostic; nextUpdatesDiagnostic = null
      const result = scenario?.result || { diagnostic: validUpdatesDiagnostic }
      if (scenario?.mode === 'deferred') return await new Promise(resolve => {
        deferredUpdatesDiagnostic = { signal, request: canonical(request), resolve: () => resolve(success(id, result)) }
      })
      if (scenario?.mode === 'raw') return { ok: true, value: { ok: true, state: taskState(id), result } }
      return success(id, result)
    }
    if (request.action === 'queryFiles' || request.action === 'querySource') {
        const value = request.query
      if (request.action === 'querySource' && value.action === 'archive' && (['content', 'contentStats', 'media'].includes(value.query.action) || value.query.action === 'contacts' && historySourcesMode === 'ready')) {
        if (historySourcesMode === 'failed') return { ok: true, value: { ok: false, error: { code: 'SNAPSHOT_DENIED' } } };
        const rows = value.query.action === 'contentStats' ? [{ sourceKind: 'moments', total: 1 }, { sourceKind: 'media', total: 1 }]
          : historySourcesMode === 'empty' ? [] : value.query.action === 'contacts' ? [{ talker: 'alice', displayName: 'Synthetic contact' }] : [{ sourceKind: value.query.action === 'media' ? 'image' : 'moments', talker: 'alice', id: '12', ts: 1700000000, title: 'Synthetic source', content: 'Synthetic source content', localTime: '2023-11-15T06:13:20+08:00', citation: { snapshotRef: 'a'.repeat(24), recordRef: 'b'.repeat(32) } }];
        return success(id, { action: value.query.action, rows, returned: rows.length, offset: 0, hasMore: false });
      }
      if (request.action === 'querySource' && value.action === 'status') {
        const history = historyFor(id)
        return success(id, { action: 'status', untrusted: true, historicalContext: await history.inspect(id, signal), firstTextContext: history.firstText.status(id) })
      }
      const sourceId = request.action === 'queryFiles' ? value.sourceId || 'workspace' : value.action === 'archive' ? 'archive' : value.sourceId
      const source = record.sources.get(sourceId)
      assert.ok(source)
      if (request.action === 'queryFiles' && (value.path?.startsWith('/') || value.path?.split('/').includes('..') || value.path?.includes('.env'))) return { ok: true, value: { ok: false, error: { code: 'SNAPSHOT_DENIED' } } }
      record.consumed.set(sourceId + ':' + source.generation, { sourceId, generation: source.generation })
      const result = request.action === 'queryFiles' ? value.action === 'read' ? { action: 'read', sourceId, path: value.path, text: taskPrivateText, bytes: taskPrivateText.length, untrusted: true, truncated: false }
        : { action: 'list', sourceId, path: value.path || '', rows: [{ name: 'synthetic-document.md', type: 'file' }], limit: 20, truncated: false, untrusted: true }
        : value.action === 'archive' && value.query.action === 'sessions'
          ? { action: 'archive', rows: taskContacts.filter(row => source.archive.allConversations || source.archive.talkers.includes(row.talker)), offset: value.query.offset, hasMore: false, untrusted: true }
          : { action: value.action, rows: [{ talker: value.action === 'archive' ? value.query.talker : undefined, text: taskPrivateText, role: 'user' }, { text: 'Synthetic Task second row', role: 'assistant' }].map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))), returned: 2, offset: value.action === 'archive' ? value.query.offset : value.offset, hasMore: false, untrusted: true }
      result.reference = privateTemporaryReference
      if (nextTaskQuery) {
        nextTaskQuery = null
        return await new Promise(resolve => { deferredTaskQuery = { signal, sessionId: id, request: canonical(request), resolve: () => resolve(success(id, result)) } })
      }
      return success(id, result)
    }
    if (request.action === 'beginLogin') {
      if (taskLoginFailure) {
        const code = taskLoginFailure; taskLoginFailure = null
        return { ok: true, value: { ok: false, error: { code } } }
      }
      record.channel = { ...record.channel, enabled: true, phase: 'qr-ready' }; return success(id, undefined, { qr })
    }
    if (request.action === 'pollLogin') {
      if (syntheticLoginStatus !== 'confirmed') return success(id, { status: syntheticLoginStatus })
      record.channel = { ...record.channel, phase: 'awaiting-confirmation' }; return success(id, { status: 'confirmed', expectedOwnerId: ownerId, botId: 'synthetic-task-bot' })
    }
    if (request.action === 'confirmPairing') { assert.equal(request.expectedOwnerId, ownerId); record.channel = { ...record.channel, phase: 'paired', hasStoredLogin: true }; return success(id) }
    if (request.action === 'pollTextOnce') {
      assert.equal(taskCanShare(record), true)
      const scenario = nextTextOnce; nextTextOnce = null
      if (scenario?.mode === 'missing-pairing') {
        record.channel = { ...record.channel, enabled: true, phase: 'unpaired', hasStoredLogin: false, messagingEnabled: false, automaticPolling: false }
        return { ok: true, value: { ok: false, error: { code: 'PAIRING_REQUIRED' } } }
      }
      assert.equal(record.channel.hasStoredLogin, true)
      const finish = () => {
        record.channel = { ...record.channel, phase: 'paired', messagingEnabled: false, automaticPolling: false }
        return success(id, scenario?.counts || { received: 3, replied: 1, ignored: 0, duplicates: 0, remaining: 2 })
      }
      if (scenario?.mode === 'deferred') {
        record.channel = { ...record.channel, phase: 'polling', messagingEnabled: true, automaticPolling: false }
        return await new Promise(resolve => { deferredTextOnce = { signal, request: canonical(request), resolve: () => resolve(finish()) } })
      }
      if (scenario?.mode === 'failed') return { ok: true, value: { ok: false, error: { code: 'ACTION_FAILED' } } }
      return finish()
    }
    if (request.action === 'startChannel') { assert.equal(taskCanShare(record), true); record.channel = { ...record.channel, phase: 'running', messagingEnabled: true, automaticPolling: true }; return success(id) }
    if (request.action === 'stopChannel') {
      record.channel = record.channel.setup ? { ...record.channel, phase: 'paired', pendingRecovery: false, automaticPolling: false, messagingEnabled: false, setup: { ...record.channel.setup, phase: 'stopped' } }
        : { ...record.channel, phase: 'recovery-required', pendingRecovery: true, automaticPolling: false, messagingEnabled: false }
      return success(id)
    }
    if (request.action === 'resumeTextOnce') {
      assert.equal(request.confirmation, 'continue-unanswered-message'); assert.equal(record.channel.resumeAvailable, true); assert.equal(taskCanShare(record), true)
      record.channel = { ...record.channel, phase: 'paired', pendingRecovery: false, resumeAvailable: false, automaticPolling: false, messagingEnabled: false }
      return success(id, { received: 1, replied: 1, ignored: 0, duplicates: 0, remaining: 0 })
    }
    if (request.action === 'discardPending') { record.channel = { ...record.channel, phase: 'paired', pendingRecovery: false }; return success(id) }
    if (request.action === 'forgetPairing') { record.channel = { ...record.channel, phase: 'unpaired', hasStoredLogin: false }; return success(id) }
    throw new Error('Unexpected synthetic Task action')
  }
  const legacyStatus = { ok: false, configured: false, snapshot_enabled: false, root: '', snapshot_time: '', read_at: '', captured_at: null, snapshot_id: null, capture_complete: null, capture_consistency: null, db_count: 0, message_table_count: null, contact_rows: null, session_rows: null, notes: ['Controlled memory status; no archive read.'] }
  ctx.reflect.provide('connection', { interactions: 'answer', isLoopback: true, registerGenerationSource: () => () => {}, generation: connectionGeneration, start: () => ({ stop() {} }), openWebSocket: denyNetwork, rpc: { open: denyNetwork, call: async (route, endpoint, payload, signal) => {
    assert.equal(route, '/api')
    assert.equal(signal instanceof AbortSignal, true)
    assert.equal(Object.hasOwn(payload.args, 'request'), true, 'Actual Gateway encodes the parameter by its wire key')
    const request = payload.args.request
    calls.push({ endpoint, request, signal })
    if (endpoint === 'wechatRo/status') return { ok: true, value: legacyStatus }
    assert.equal(endpoint.startsWith('wechatConversation/'), true)
    if (request.kind === 'task') return taskRpc(endpoint, request, signal)
    if (endpoint.endsWith('/getConversationState')) {
      if (nextStateRead && request.sessionId === nextStateRead.sessionId) {
        const scenario = nextStateRead; nextStateRead = null
        if (scenario.mode === 'failed') throw new Error('Synthetic state response unavailable')
        if (scenario.mode === 'wrong-sid') return { ok: true, value: states.get(otherId) }
        if (scenario.mode === 'wrong-role') return { ok: true, value: taskState(request.sessionId) }
        if (scenario.mode === 'malformed') return { ok: true, value: { sessionId: request.sessionId } }
        throw new Error('Unsupported synthetic ordinary state mode')
      }
      return { ok: true, value: states.get(request.sessionId) }
    }
    hostWire.actionSchema.parse(request)
    const id = request.action === 'createConversation' ? request.contextSessionId : request.sessionId
    const state = states.get(id)
    const success = (result, extra = {}) => ({ ok: true, value: { ok: true, state: states.get(id), ...(result ? { result } : {}), ...extra } })
    if (request.action === 'createConversation') {
      const target = nextCreatedId
      assert.equal(botRoots.has(target), true); assert.equal(explicitlyCreatedBridgeIds.has(target), false)
      explicitlyCreatedBridgeIds.add(target)
      const fresh = states.get(target)
      states.set(target, { ...fresh, prepared: true, archive: { ...fresh.archive, historyKnown: true, shareable: true } })
      return { ok: true, value: { ok: true, state: states.get(target), result: { sessionId: target } } }
    }
    if (request.action === 'grantSnapshot' || request.action === 'revokeSnapshot') {
      const bot = id !== sessionId
      if (bot) { assert.equal(explicitlyCreatedBridgeIds.has(id), true); assert.equal(state.prepared, true) }
      if (request.action === 'grantSnapshot') {
        if (bot) { assert.equal(request.allowWechat, true); assert.equal(request.root, botRoots.get(id)) }
        else { assert.equal(id, sessionId); assert.equal(request.allowWechat, false); assert.equal(request.root, grantRoot); if (archiveFixture) await archiveFixture.access.grant(id, fixtureGrant, signal) }
      } else if (!bot && archiveFixture) archiveFixture.access.revoke(id)
      if (bot && state.channel.phase === 'running') states.set(id, { ...state, channel: { ...state.channel, phase: state.channel.hasStoredLogin ? 'paired' : 'unpaired', messagingEnabled: false, automaticPolling: false } })
      const apply = () => {
        const current = states.get(id)
        const archive = request.action === 'grantSnapshot'
          ? { ...current.archive, granted: true, historyKnown: true, allConversations: request.allConversations, talkers: request.talkers, fromTs: request.fromTs, toTs: request.toTs, allowWechat: request.allowWechat, shareable: bot }
          : { ...current.archive, granted: false, allowWechat: false, allConversations: false, talkers: [], fromTs: null, toTs: null, sessionMayContainArchiveData: bot ? current.archive.sessionMayContainArchiveData : true, shareable: bot && current.archive.historyKnown === true && current.archive.sessionMayContainArchiveData !== true }
        states.set(id, { ...current, archive })
        return canonical(success())
      }
      const scenario = nextMutation; nextMutation = null
      if (!scenario) { apply(); return success() }
      assert.equal(scenario.sessionId, id); assert.equal(scenario.action, request.action)
      if (scenario.mode === 'failed-after-stop') return { ok: true, value: { ok: false, error: { code: 'ACTION_FAILED' } } }
      if (scenario.mode === 'committed-response-lost') { apply(); throw new Error('Synthetic committed mutation response lost') }
      assert.equal(scenario.mode, 'deferred')
      let value = scenario.committed ? apply() : null
      return await new Promise(resolve => { deferredMutation = { signal, sessionId: id, request: canonical(request), commit: () => { assert.equal(value, null); value = apply() }, resolve: () => { assert.notEqual(value, null); resolve(value) } } })
    }
    if (request.action === 'queryArchive') {
      assert.equal(state.archive.granted, true)
      assert.equal(id, sessionId); assert.equal(state.prepared, false)
      let result
      if (archiveFixture) {
        archiveFixtureRows = archiveFixture.rows
        result = await archiveFixture.access.query(id, canonical(request.query), signal)
        archiveFixture.lastResult = result
      } else result = { rows: largeQuery ? [{ content: '合成'.repeat(7000) }] : manyRows ? Array.from({ length: 9 }, (_, index) => ({ talker: 'controlled-talker', content: 'Synthetic row ' + index, citation: { snapshotRef: 'a'.repeat(24), recordRef: String(index).padStart(32, '0') } })) : [{ talker: 'controlled-talker', content: privateBody, citation: { snapshotRef: 'a'.repeat(24), recordRef: 'b'.repeat(32) } }, { content: 'Synthetic second row' }], source: missingSource ? null : { kind: 'decrypted-wechat-archive', snapshotRef: 'a'.repeat(24), root: grantRoot, privateHint: ownerId }, untrusted: true, hasMore: false, returned: largeQuery ? 1 : 2 }
      result.reference = privateTemporaryReference
      if (deferQuery) return await new Promise(resolve => { deferredQuery = { signal, resolve: () => resolve(success(result)) } })
      states.set(id, { ...state, archive: { ...state.archive, sessionMayContainArchiveData: true } })
      return success(result)
    }
    assert.equal(explicitlyCreatedBridgeIds.has(id), true, 'Bridge requests must target an explicitly created restricted Session')
    assert.equal(botRoots.has(id), true)
    if (request.action === 'resumeConversation') {
      assert.equal(explicitlyCreatedBridgeIds.has(id), true, 'Only the SID returned by an earlier explicit create can be synthetically resumed')
      assert.equal(request.confirmation, 'resume-readonly-conversation')
      const response = () => { states.set(id, { ...states.get(id), prepared: true }); return success({ sessionId: id, resumed: true }) }
      return response()
    }
    if (request.action === 'beginLogin') {
      const response = () => { states.set(id, { ...states.get(id), channel: { ...state.channel, enabled: true, phase: 'qr-ready' } }); return success(null, { qr }) }
      return response()
    }
    if (request.action === 'pollLogin') {
      if (syntheticLoginStatus !== 'confirmed') return success({ status: syntheticLoginStatus })
      states.set(id, { ...state, channel: { ...state.channel, phase: 'awaiting-confirmation' } }); return success({ status: 'confirmed', expectedOwnerId: ownerId, botId: 'controlled-private-bot' })
    }
    if (request.action === 'confirmPairing') { assert.equal(request.expectedOwnerId, ownerId); states.set(id, { ...state, channel: { ...state.channel, phase: 'paired', hasStoredLogin: true } }); return success() }
    if (request.action === 'startChannel') { assert.equal(state.archive.shareable, true); assert.ok(state.channel.phase === 'paired' || state.channel.hasStoredLogin === true); states.set(id, { ...state, channel: { ...state.channel, phase: 'running', messagingEnabled: true, automaticPolling: true } }); return success() }
    if (request.action === 'stopChannel') { states.set(id, { ...state, channel: { ...state.channel, phase: 'recovery-required', pendingRecovery: true } }); return success() }
    if (request.action === 'discardPending') { states.set(id, { ...state, channel: { ...state.channel, phase: 'paired', pendingRecovery: false } }); return success() }
    if (request.action === 'forgetPairing') { states.set(id, { ...state, channel: { ...state.channel, phase: 'unpaired', hasStoredLogin: false } }); return success() }
    throw new Error('Unexpected controlled action')
  } } })
  gateway = ctx.plugin(gatewayModule)
  await gateway
  const nativeModelCalls = [], nativeCatalogGroups = [{ id: 'mock', name: 'Synthetic provider', models: [
    { id: 'mock', name: 'Synthetic native model', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } },
    { id: 'alternative', name: 'Synthetic alternate model', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } },
  ] }]
  const nativeModelRemote = {
    modelCatalog: async () => ({ ok: true, value: { default: { provider: 'mock', model: 'mock', reasoningEffort: 'high' }, groups: nativeCatalogGroups, failures: [], routableProviders: ['mock'] } }),
    selectModel: async request => {
      nativeModelCalls.push(canonical(request))
      assert.ok(nativeSelections.has(request.sessionId))
      const { sessionId, ...selection } = request
      nativeSelections.get(sessionId).set({ lastUsed: null, next: selection })
      return { ok: true, value: undefined }
    },
  }
  ctx.reflect.provide('remote.session', nativeModelRemote)
  Object.defineProperty(ctx.get('remote'), 'session', { configurable: true, value: nativeModelRemote })
  let modelCommand
  ctx.reflect.provide('commandUi', { register: command => { modelCommand = command; return () => { modelCommand = null } } })
  const nativeModelFiber = ctx.plugin({ inject: nativeModelPlugin.inject, apply: nativeModelPlugin.apply }); await nativeModelFiber
  releases.push(() => nativeModelFiber.dispose())
  assert.equal(ctx.get('remote') instanceof Service, true)
  assert.equal(ctx.get('remote.wechatConversation'), undefined)
  const uiSession = new UiSession(ctx, sessions)
  slots.installScope('session', uiSession.adapter)
  workspace = new UiWorkspaceService(ctx, {}, workspaces, sessions, { pinSessionOrder: denyNetwork }, denyNetwork)
  const actualOpenSession = workspace.openSession.bind(workspace)
  workspace.openSession = id => { selected.push(id); actualOpenSession(id) }
  workspace.pickDirectory = async () => {
    pickerCalls++
    if (nextTaskPicker) { const path = nextTaskPicker; nextTaskPicker = null; return await new Promise(resolve => { deferredTaskPicker = { resolve: () => resolve(path) } }) }
    return taskExtraRoot
  }
  current = uiSession.adapter.current
  const syncMounted = () => right.show(panelInfo.getSnapshot().activePanelId === null ? current.getSnapshot().key : undefined)
  releases.push(current.subscribe(syncMounted), panelInfo.subscribe(syncMounted)); syncMounted()
  const entryErrors = []
  releases.push(slots._core.onEntryError((_key, _entry, error) => { entryErrors.push(error) }))
  const tabInject = Object.freeze({ hooks: { tabInfo: tabInfoFactory } })
  const nativeStore = createSidebarRightStore(() => ({ kind: 'guide', title: 'Controlled guide' }))
  const seatedStore = { ...nativeStore, create: scopeKey => {
    const id = String(scopeKey)
    if (stores.has(id)) return stores.get(id)
    const store = nativeStore.create() // No persistence adapter or browser storage.
    store.actions.open(id); stores.set(id, store); trace.push(['store-mint', id]); releases.push(right.adopt(id, store)); return store
  } }
  function NativeSurface(props) {
    const id = props.sessionId
    const store = stores.get(id)
    const snapshot = props.useStore(value => value)
    const surface = snapshot.bySession[id]
    const activeTabId = surface ? getPane(surface.layout, activeDockPaneId(surface.layout)).activeTabId : undefined
    const tab = surface?.layout.tabs[activeTabId]
    const entryKey = tabs.get(tab?.kind)?.id ?? tab?.kind
    const context = React.useMemo(() => {
      if (!tab || tab.kind !== client.CONVERSATION_TAB_KIND) return null
      const occurrence = right.controller.tabDomain.occurrence(id, tab)
      return { shortcuts: [], tabId: tab.id, title: false, fullscreen: false, active: true, signal: occurrence.signal, actions: occurrence.tabActions, useStore: observableHook(store), useTabNavigation: tabId => observableHook(right.controller.tabDomain.occurrence(id, { id: tabId }).navigation)(value => value) }
    }, [id, store, tab?.id])
    if (!surface?.layout.expanded || !context) return null
    return React.createElement('aside', { 'data-native-rightbar': id }, props.renderSlot('sidebar.right.pane.tab.title', {}, { entryKey, hookContext: context }), props.renderSlot('sidebar.right.pane.tab', {}, { entryKey, hookContext: context }))
  }
  const NativeCenter = props => React.createElement(React.Fragment, null,
    React.createElement('div', { 'data-native-sse': props.sessionId }, props.useSession(value => value.streamingText)),
    React.createElement('div', { 'data-native-model-picker': props.sessionId }, props.renderSlot('conversation.input.model', { locked: false })))
  function TestOwner(props) {
    const id = props.useNativeCurrent(value => value.key)
    const panel = props.usePanelInfo(value => value.activePanelId)
    return React.createElement(React.Fragment, null,
      panel === null && id !== undefined ? props.renderSlot('conversation.session') : props.renderSlot('main', {}, { entryKey: panel || 'conversation' }),
      panel === null && id !== undefined ? props.renderSlot('rightbar.session') : null,
      props.renderSlot('shell.overlay'))
  }
  releaseRoot = slots.register({ name: 'root', inject: () => ({ hooks: { nativeCurrent: current } }), children: { main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' }, 'plugins.bundle.config': { kind: 'keyed', scope: 'root' }, 'tool.call.toolview': { kind: 'keyed', scope: 'root' }, 'conversation.session': { kind: 'single', scope: 'session' }, 'conversation.session.header.corner': { kind: 'single', scope: 'session' }, 'rightbar.session': { kind: 'single', scope: 'session' }, 'shell.overlay': { kind: 'list', scope: 'root' } } }, TestOwner)
  releases.push(slots.register({ name: 'conversation.session', children: { 'conversation.input.model': { kind: 'single', scope: 'session' } } }, NativeCenter))
  releases.push(slots.register({ name: 'rightbar.session', store: seatedStore, children: { 'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: tabInject }, 'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session', inject: tabInject } } }, NativeSurface))
  releases.push(slots.register({ name: 'conversation.session.header.corner' }, () => null))
  const nativeBefore = ['rightbar.session', 'conversation.session.header.corner'].map(name => slots._core.entries(name)[0])
  workspace.openSession(sessionId); selected.length = 0
  consumer = ctx.plugin(client); await consumer
  const [oldLeaf, newLeaf] = await Promise.all([oldPublished, newPublished]); await oldLeaf.await(); await newLeaf.await()
  assert.equal(Object.hasOwn(newLeaf.inject, 'uiSession'), true); assert.equal(Object.hasOwn(newLeaf.inject, 'layout'), true)
  assert.equal(mounts, 1); assert.equal(calls.length, 0)
  assert.equal(right.controller.tabsIn(sessionId).length, 0)
  assert.deepEqual(nativeBefore, ['rightbar.session', 'conversation.session.header.corner'].map(name => slots._core.entries(name)[0]))
  layout.selectPanel('wechat-ro')
  assert.equal(current.getSnapshot().key, sessionId); assert.equal(right.controller.mounted.getSnapshot(), undefined); assert.equal(stores.size, 0, 'No pre-adopted store/mounted stub')
  await act(async () => { view = render(slots.renderSlot('root', {})) })
  const actionCalls = () => calls.filter(call => call.endpoint.endsWith('/conversationAction'))
  const getCount = id => calls.filter(call => call.endpoint.endsWith('/getConversationState') && call.request.sessionId === id).length
  const en = client.__conversationI18n.en
  const findAction = action => actionCalls().filter(call => call.request.action === action)
  const data = () => view.container.querySelector('[data-wechat-conversation]')
  // State snapshots may inspect retained hidden panels. Interactions below must
  // first select a visible view/settings group and open every owning detail.
  const dataButton = key => Array.from(data()?.querySelectorAll('button') || []).find(button => button.textContent === en[key])
  const indexCases = [], exportCases = []
  const frameOf = root => root?.matches('[data-sidebar-ui-revision]') ? root : root?.querySelector('[data-sidebar-ui-revision]')
  const frameDictionary = root => {
    const label = frameOf(root)?.querySelector('[role="tab"]')?.textContent
    const dictionary = Object.values(client.__conversationI18n).find(value => value.indexOverview === label)
    assert.ok(dictionary, 'The active frame must use a real shipped navigation dictionary')
    return dictionary
  }
  const shownByPanel = node => {
    for (let value = node; value; value = value.parentElement) {
      if (value.hidden) return false
      const style = dom.window.getComputedStyle(value)
      if (style.display === 'none' || style.visibility === 'hidden') return false
    }
    return true
  }
  const visible = node => {
    if (!node?.isConnected || !shownByPanel(node)) return false
    for (let value = node; value; value = value.parentElement) {
      if (value.tagName === 'DETAILS' && !value.open) {
        const summary = value.querySelector(':scope > summary')
        if (!summary?.contains(node)) return false
      }
    }
    return true
  }
  const navigationActivity = () => ({ actions: actionCalls().length, workerCalls: archiveWorkerCalls.length, pickerCalls,
    prompts: prompts.length, selected: selected.length, sessionId: current.getSnapshot().key,
    center: view.container.querySelector('[data-native-sse]'), centerText: view.container.querySelector('[data-native-sse]')?.textContent })
  const assertNavigationQuiet = before => {
    const { center, ...afterFacts } = navigationActivity(), { center: priorCenter, ...beforeFacts } = before;
    assert.ok(center === priorCenter, 'Navigation must retain the native SSE DOM');
    assert.deepEqual(afterFacts, beforeFacts, 'Navigation must not perform business actions or alter the native SSE');
  }
  const showIndexView = async (root, target) => {
    const frame = frameOf(root), dictionary = frameDictionary(root), before = navigationActivity()
    assert.ok(frame)
    const advanced = frame.closest('details[data-wechat-advanced]')
    if (advanced && !advanced.open) await openDetails(advanced)
    if (target === 'settings') {
      const button = within(frame.querySelector('.wi-header')).getByRole('button', { name: dictionary.indexSettings, exact: true })
      if (button.getAttribute('aria-expanded') !== 'true') await act(async () => fireEvent.click(button))
      assert.equal(button.getAttribute('aria-expanded'), 'true')
      assert.ok(within(frame).getByRole('region', { name: dictionary.indexSettings, exact: true }))
    } else {
      const tab = within(frame.querySelector('[role="tablist"]')).getByRole('tab', { name: dictionary[{ overview: 'indexOverview', records: 'indexRecords', export: 'indexExport' }[target]], exact: true })
      if (tab.getAttribute('aria-selected') !== 'true') await act(async () => fireEvent.click(tab))
      assert.equal(tab.getAttribute('aria-selected'), 'true')
      assert.ok(within(frame).getByRole('tabpanel', { name: tab.textContent, exact: true }))
    }
    assert.equal(frame.querySelector('.wi-title').textContent, dictionary[{ overview: 'indexOverview', records: 'indexRecords', export: 'indexExport', settings: 'indexSettings' }[target]])
    assert.equal(frameOf(root), frame, 'Navigation must retain the same frame/controller lifetime')
    assertNavigationQuiet(before)
    return frame
  }
  const showSettings = async (root, group) => {
    const frame = await showIndexView(root, 'settings'), dictionary = frameDictionary(root)
    const region = frame.querySelector('[data-wechat-settings]')
    assert.equal(visible(region), true, 'Settings must be explicitly visible')
    const nav = region.querySelector('.wi-settings-nav')
    if (nav) {
      const button = within(nav).getByRole('button', { name: dictionary[{ sources: 'indexSourceSettings', connection: 'indexConnectionSettings', task: 'indexConnectionSettings' }[group]], exact: true })
      const before = navigationActivity()
      if (button.getAttribute('aria-pressed') !== 'true') await act(async () => fireEvent.click(button))
      assert.equal(button.getAttribute('aria-pressed'), 'true')
      assertNavigationQuiet(before)
    } else assert.equal(group, 'task', 'An unselected Task exposes only explicit task selection in Settings')
    return region
  }
  const openDetails = async details => {
    assert.ok(details, 'The requested settings detail must exist')
    const summary = details.querySelector(':scope > summary')
    assert.equal(visible(summary), true, 'Never open a detail in a hidden view')
    const before = navigationActivity()
    if (!details.open) await act(async () => fireEvent.click(summary))
    assert.equal(details.open, true, 'A visible summary must open its own detail')
    assertNavigationQuiet(before)
    return details
  }
  const rawControl = (root, role, label, includeHidden = false) => {
    assert.ok(root, 'The intended UI owner must exist')
    const matches = role === 'button' ? Array.from(root.querySelectorAll('button')).filter(value => value.textContent === label)
      : role === 'checkbox' ? Array.from(root.querySelectorAll('label')).filter(value => value.textContent === label).map(value => value.querySelector('input[type="checkbox"]')).filter(Boolean)
        : within(root).queryAllByLabelText(label, { exact: true })
    const candidates = includeHidden ? matches : matches.filter(shownByPanel)
    assert.equal(candidates.length, 1, 'One scoped ' + role + ' control: ' + label)
    return candidates[0]
  }
  const revealControl = async (root, role, label) => {
    const control = rawControl(root, role, label)
    const details = []
    for (let value = control.parentElement; value; value = value.parentElement) if (value.tagName === 'DETAILS') details.unshift(value)
    for (const detail of details) await openDetails(detail)
    assert.equal(visible(control), true, 'Never interact with a hidden control: ' + label)
    return control
  }
  const ordinaryRecords = new Set(['queryAction', 'talker', 'query', 'limit', 'runQuery', 'previous', 'next', 'indexOpenMessages'])
  const ordinaryGrants = new Set(['root', 'scope', 'talkers', 'fromTs', 'toTs', 'grantConsent', 'grant', 'revoke', 'refresh'])
  const ordinaryConnection = new Set(['indexConnectionSettings'])
  const prepareOrdinaryControl = async label => {
    const root = data()
    if (!root) return view.container
    const dictionary = frameDictionary(root)
    const key = Object.keys(dictionary).find(key => dictionary[key] === label)
    if (ordinaryRecords.has(key)) await showIndexView(root, 'records')
    else if (ordinaryGrants.has(key)) await showSettings(root, 'sources')
    else if (ordinaryConnection.has(key)) await showSettings(root, 'connection')
    else if (['reference', 'indexDownloadJson', 'indexDownloadText'].includes(key) || /^Select data row \d+$/.test(label) || /^选中资料 \d+$/.test(label)) await showIndexView(root, 'export')
    return root
  }
  const click = async label => { const root = await prepareOrdinaryControl(label), control = await revealControl(root, 'button', label); await act(async () => fireEvent.click(control)) }
  const check = async label => { const root = await prepareOrdinaryControl(label), control = await revealControl(root, 'checkbox', label); await act(async () => fireEvent.click(control)) }
  const change = async (label, value) => { const root = await prepareOrdinaryControl(label), control = await revealControl(root, 'field', label); await act(async () => fireEvent.change(control, { target: { value } })) }
  const recordValues = root => Array.from(root?.querySelectorAll('article.wi-record') || [], article => JSON.parse(article.querySelector(':scope > details > pre').textContent))
  const assertRecordDisplay = (root, rows) => {
    const articles = Array.from(root.querySelectorAll('article.wi-record'))
    assert.deepEqual(recordValues(root), rows, 'Every technical row must remain available in its own details, in order')
    assert.equal(articles.length, rows.length)
    articles.forEach((article, index) => {
      const details = article.querySelector(':scope > details'), body = article.querySelector('.wi-record-body')
      const row = rows[index], text = typeof row.text === 'string' ? row.text : typeof row.content === 'string' ? row.content : typeof row.summary === 'string' ? row.summary : ''
      assert.equal(details.open, false, 'Raw JSON is technical detail, not the primary row display')
      assert.equal(visible(details.querySelector('pre')), false)
      assert.equal(article.querySelector(':scope > pre'), null)
      assert.equal(body?.textContent || '', text)
      if (text) assert.equal(visible(body), true, 'Queried text must be visible as escaped primary content')
      assert.equal(article.querySelector('script'), null)
    })
  }
  const exercisePageDownload = async (root, expectedSid, expectedQuery, expectedPage, surface) => {
    const dictionary = frameDictionary(root), before = navigationActivity(), rpcBefore = calls.length, count = downloads.length
    await showIndexView(root, 'export')
    for (const key of ['indexDownloadJson', 'indexDownloadText']) {
      const button = await revealControl(root, 'button', dictionary[key])
      assert.equal(button.disabled, false)
      await act(async () => fireEvent.click(button))
      assert.equal(within(root).getByText(dictionary.indexDownloadStarted, { exact: true }) !== null, true)
    }
    assert.equal(downloads.length, count + 2)
    const expected = { kind: 'wechat-query-export', untrusted: true, dataContextSessionId: expectedSid, query: expectedQuery, ...expectedPage }
    const [json, text] = downloads.slice(count)
    assert.equal(json.filename, 'wechat-query.json'); assert.equal(json.mime, 'application/json;charset=utf-8')
    assert.equal(text.filename, 'wechat-query.txt'); assert.equal(text.mime, 'text/plain;charset=utf-8')
    assert.deepEqual(JSON.parse(json.content), expected, 'JSON export must contain only the already-queried current page')
    assert.equal(text.content, dictionary.indexExportHint + '\n' + json.content)
    for (const file of [json, text]) {
      const exported = JSON.parse(file === json ? file.content : file.content.slice(dictionary.indexExportHint.length + 1))
      assert.equal(Object.hasOwn(exported, 'reference'), false, 'Temporary result.reference must never leave through a local export')
      for (const privateValue of [privateTemporaryReference.handle, privateTemporaryReference.privatePath, grantRoot, ownerId]) assert.equal(file.content.includes(privateValue), false)
    }
    assert.equal(dom.window.document.querySelector('a[download]'), null, 'The synthetic download anchor must be removed')
    failDownload = true
    try { await act(async () => fireEvent.click(within(root).getByRole('button', { name: dictionary.indexDownloadJson, exact: true }))) }
    finally { failDownload = false }
    assert.equal(downloads.length, count + 2, 'A local download failure must not retry or navigate')
    assert.ok(within(root).getByText(dictionary.indexDownloadFailed, { exact: true }))
    assert.equal(calls.length, rpcBefore, 'Exports and local failure handling must not perform even a metadata reread')
    assertNavigationQuiet(before)
    exportCases.push(surface)
    console.log('PASS local page export: ' + surface + ' saves queried JSON/text only; no repeat read/model/channel; no temporary handle/private source fields; local failure is closed')
  }
  const assertDefaultOverview = root => {
    const frame = frameOf(root), dictionary = frameDictionary(root), nav = within(frame.querySelector('[role="tablist"]'))
    assert.equal(frame.getAttribute('data-sidebar-ui-revision'), 'index-single-sidebar-v1')
    assert.equal(nav.getAllByRole('tab').length, 3)
    assert.equal(nav.getByRole('tab', { name: dictionary.indexOverview, exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(nav.getByRole('tab', { name: dictionary.indexRecords, exact: true }).getAttribute('aria-selected'), 'false')
    assert.equal(nav.getByRole('tab', { name: dictionary.indexExport, exact: true }).getAttribute('aria-selected'), 'false')
    assert.equal(within(frame.querySelector('.wi-header')).getByRole('button', { name: dictionary.indexSettings, exact: true }).getAttribute('aria-expanded'), 'false')
    assert.equal(visible(frame.querySelector('[data-wechat-settings]')), false)
    assert.equal(within(frame).queryByRole('region', { name: dictionary.indexSettings, exact: true }), null)
    assert.equal(within(frame).queryByRole('textbox'), null, 'Default overview must hide every configuration/query input')
    assert.equal(within(frame).queryByRole('combobox'), null, 'Default overview must not expose selection or configuration dropdowns')
    assert.equal(within(frame).queryByRole('checkbox'), null, 'Default overview must hide every consent and row-selection control')
    assert.ok(within(frame).getByRole('tabpanel', { name: dictionary.indexOverview, exact: true }))
  }
  const exerciseIndexNavigation = async (root, surface) => {
    const before = navigationActivity(), frame = frameOf(root), dictionary = frameDictionary(root)
    assertDefaultOverview(root)
    const tablist = frame.querySelector('[role="tablist"]'), tabs = within(tablist).getAllByRole('tab')
    assert.deepEqual(tabs.map(tab => tab.tabIndex), [0, -1, -1])
    await act(async () => tabs[0].focus())
    for (const [key, index] of [['ArrowRight', 1], ['ArrowRight', 2], ['ArrowRight', 0], ['ArrowLeft', 2], ['Home', 0], ['End', 2], ['ArrowLeft', 1]]) {
      await act(async () => fireEvent.keyDown(dom.window.document.activeElement, { key }))
      assert.equal(dom.window.document.activeElement, tabs[index], 'Keyboard tab navigation must move focus')
      assert.equal(tabs[index].getAttribute('aria-selected'), 'true')
      assert.deepEqual(tabs.map(tab => tab.tabIndex), tabs.map((_tab, value) => value === index ? 0 : -1))
      assert.ok(within(frame).getByRole('tabpanel', { name: tabs[index].textContent, exact: true }))
    }
    await showIndexView(root, 'settings')
    assert.deepEqual(tabs.map(tab => tab.getAttribute('aria-selected')), ['false', 'false', 'false'])
    assert.deepEqual(tabs.map(tab => tab.tabIndex), [0, -1, -1])
    await act(async () => fireEvent.click(within(frame).getByRole('button', { name: dictionary.indexBack, exact: true })))
    assertDefaultOverview(root)
    for (const target of ['records', 'export', 'overview']) await showIndexView(root, target)
    assertNavigationQuiet(before)
    indexCases.push(surface)
    console.log('PASS Index navigation: ' + surface + ' defaults to overview; configuration hidden; keyboard focus/roving tabs/settings/back are action-free')
  }
  // Supersede restoration in the SAME batched navigation before React commits.
  await act(async () => { fireEvent.click(view.getByRole('button', { name: en.launcher, exact: true })); layout.selectPanel('wechat-ro') })
  assert.equal(trace.some(([kind]) => kind === 'openTab'), false); assert.equal(stores.size, 0)
  // A concurrent explicit native selection must cancel the old pending opener.
  await act(async () => { fireEvent.click(view.getByRole('button', { name: en.launcher, exact: true })); workspace.openSession(otherId); layout.selectPanel('wechat-ro') })
  assert.equal(current.getSnapshot().key, otherId); assert.equal(stores.size, 0); assert.equal(trace.some(([kind]) => kind === 'openTab'), false)
  await act(async () => { workspace.openSession(sessionId); layout.selectPanel('wechat-ro') }); selected.length = 0
  await click(en.launcher)
  assert.equal(current.getSnapshot().key, sessionId); assert.equal(selected.length, 0)
  assert.equal(layout.panelInfo.getSnapshot().activePanelId, null)
  assert.equal(view.container.querySelector('[data-native-sse]').textContent, 'SSE · token 1')
  assert.equal(data().getAttribute('data-session-id'), sessionId)
  assert.equal(data().getAttribute('data-data-sidebar-revision'), 'current-sse-data-v1')
  assertDefaultOverview(data())
  await exerciseIndexNavigation(data(), 'ordinary Session / en')
  await act(async () => locale.setLocale('zh'))
  await exerciseIndexNavigation(data(), 'ordinary Session / zh')
  await act(async () => locale.setLocale('en'))
  const beforeTaskPicker = navigationActivity()
  await showSettings(data(), 'connection')
  assert.equal(data().getAttribute('data-task-session-id'),null)
  assert.equal(within(data()).getByLabelText(client.__taskI18n.en.existingTask).value,'')
  assert.equal(view.container.querySelector('[data-optional-bridge-session-id],[data-wechat-task-panel]'),null)
  await showIndexView(data(),'overview'); assertNavigationQuiet(beforeTaskPicker)
  assert.equal(trace.findIndex(([kind]) => kind === 'openTab') > trace.findIndex(([kind]) => kind === 'store-mint'), true)
  assert.equal(trace.filter(([kind]) => kind === 'openTab').length, 1)
  assert.equal(findAction('createConversation').length, 0); assert.equal(prompts.length, 0)
  assert.equal(entryErrors.length, 0)
  console.log('PASS global archive → same native SSE; actual layout/navigation/mount/store commit; concurrent cancellation; open once')
  assert.equal(data().getAttribute('data-header-revision'), 'compact-native-v1')
  const header = data().querySelector('[data-wechat-conversation-header]')
  const contextDetails = data().querySelector('[data-wechat-context-details]')
  assert.equal(header.querySelectorAll('h1,h2').length, 1, 'One view-specific heading, not a repeated native tab title')
  assert.equal(header.querySelector('h2').textContent, en.indexOverview)
  assert.equal(header.textContent.includes(en.title), false)
  assert.equal(header.textContent.includes(sessionId), false, 'Technical Session identity must stay out of the primary header')
  assert.equal(view.container.querySelectorAll('[data-wechat-conversation-title]').length, 1)
  assert.equal(frameOf(data()).querySelector('[role="status"]').textContent, en.indexNoSources)
  assert.equal(contextDetails.tagName, 'DETAILS'); assert.equal(contextDetails.open, false)
  assert.equal(contextDetails.querySelector('summary').textContent, en.indexAdvanced)
  assert.equal(contextDetails.textContent.includes(sessionId), true)
  assert.equal(contextDetails.textContent.includes(en.nativeHint), true)
  assert.equal(contextDetails.textContent.includes(en.unprepared), true)
  const beforeContextToggle = { calls: calls.length, selected: selected.length, prompts: prompts.length }
  await showSettings(data(), 'sources')
  await openDetails(contextDetails)
  assert.equal(contextDetails.open, true)
  await act(async () => fireEvent.click(contextDetails.querySelector(':scope > summary')))
  assert.equal(contextDetails.open, false)
  await showIndexView(data(), 'overview')
  assert.deepEqual({ calls: calls.length, selected: selected.length, prompts: prompts.length }, beforeContextToggle)
  assert.equal(current.getSnapshot().key, sessionId)
  console.log('PASS view-specific header; one native tab title; technical IDs/access explanation in closed Settings/Advanced; explanation navigation has no action or prompt')

  for (const mode of ['wrong-sid', 'wrong-role', 'malformed']) {
    const before = navigationActivity()
    nextStateRead = { sessionId, mode }
    await click(en.refresh)
    await showIndexView(data(), 'records')
    assert.equal(dataButton('runQuery').disabled, true, mode + ' metadata must not enable an ordinary read')
    await showIndexView(data(), 'export')
    assert.equal(within(data()).queryByRole('button', { name: en.indexDownloadJson, exact: true }), null)
    assertNavigationQuiet(before)
    await click(en.refresh)
    assert.equal(states.get(sessionId).archive.granted, false)
  }
  await showIndexView(data(), 'overview')
  assertDefaultOverview(data())
  console.log('PASS ordinary controller rejects malformed, other-SID and Task-role state carriers without source/model/channel actions')

  assert.equal(dataButton('runQuery').disabled, true)
  await change(en.root, grantRoot); await change(en.talkers, 'controlled-talker'); await check(en.grantConsent); await click(en.grant)
  assert.equal(states.get(sessionId).prepared, false); assert.equal(states.get(sessionId).archive.granted, true)
  assert.equal(findAction('grantSnapshot')[0].request.allowWechat, false); assert.equal(findAction('grantSnapshot')[0].request.sessionId, sessionId)
  await act(async () => nativeStreams.get(sessionId).set({ ...nativeStreams.get(sessionId).getSnapshot(), streamingText: 'SSE · token 2' }))
  await click(en.runQuery)
  assert.equal(view.container.textContent.includes(privateBody), true); assert.equal(view.container.querySelector('script'), null)
  assert.equal(prompts.length, 0); assert.equal(selected.length, 0)
  assert.equal(view.container.querySelector('[data-native-sse]').textContent, 'SSE · token 2')
  assert.equal(dataButton('reference').disabled, true)
  assert.equal(within(data()).queryByRole('checkbox', { name: en.selectRow.replace('{index}', '1'), exact: true }), null, 'Ordinary citation selection belongs to Export, not Records')
  const ordinaryPage = [{ talker: 'controlled-talker', content: privateBody, citation: { snapshotRef: 'a'.repeat(24), recordRef: 'b'.repeat(32) } }, { content: 'Synthetic second row' }]
  assertRecordDisplay(data().querySelector('[data-index-records]'), ordinaryPage)
  await exercisePageDownload(data(), sessionId, canonical(findAction('queryArchive').at(-1).request.query), { source: { kind: 'decrypted-wechat-archive', snapshotRef: 'a'.repeat(24) }, records: ordinaryPage }, 'ordinary two-row page')
  await check(en.selectRow.replace('{index}', '1'))
  const beforeSelectedNavigation = navigationActivity()
  for (const target of ['overview', 'records', 'export']) await showIndexView(data(), target)
  assert.equal(view.getByRole('checkbox', { name: en.selectRow.replace('{index}', '1'), exact: true }).checked, true, 'Navigation must retain the explicitly selected current-page citation')
  assertNavigationQuiet(beforeSelectedNavigation)
  await click(en.reference)
  assert.equal(prompts.length, 1); assert.equal(prompts[0].id, sessionId); assert.equal(prompts[0].mode, 'queue')
  const text = prompts[0].content[0].text
  assert.equal(text.startsWith(en.referenceInstruction), true); assert.equal(text.length <= 12288, true)
  const quoted = JSON.parse(text.slice(en.referenceInstruction.length + 1))
  assert.equal(quoted.untrusted, true); assert.equal(quoted.dataContextSessionId, sessionId); assert.equal(quoted.records.length, 1)
  assert.equal(quoted.records[0].citation.recordRef, 'b'.repeat(32)); assert.equal(quoted.source.snapshotRef, 'a'.repeat(24))
  assert.equal(text.includes(grantRoot), false); assert.equal(text.includes(ownerId), false)
  assert.equal(text.includes(privateTemporaryReference.handle), false); assert.equal(text.includes(privateTemporaryReference.privatePath), false)
  assert.equal(view.container.textContent.includes(en.referenceHint), true)
  manyRows = true; await click(en.runQuery)
  for (let index = 1; index <= 8; index++) await check(en.selectRow.replace('{index}', String(index)))
  assert.equal(view.getByRole('checkbox', { name: en.selectRow.replace('{index}', '9'), exact: true }).disabled, true); assert.equal(dataButton('reference').disabled, false)
  manyRows = false; missingSource = true; await click(en.runQuery); await check(en.selectRow.replace('{index}', '1'))
  assert.equal(dataButton('reference').disabled, true); assert.equal(view.container.textContent.includes(en.referenceUnavailable), true); assert.equal(prompts.length, 1)
  missingSource = false
  console.log('PASS eight-row selection cap; no-source references blocked; source allowlist omits directory/private metadata; model/history consent visible')
  largeQuery = true; await click(en.runQuery); await check(en.selectRow.replace('{index}', '1'))
  assert.equal(dataButton('reference').disabled, true); assert.equal(view.container.textContent.includes(en.referenceTooLarge), true); assert.equal(prompts.length, 1)
  largeQuery = false
  console.log('PASS prepared=false ordinary-Session owner data grant/query; escaped rows; explicit selected citations/queue; untrusted marker; 12Ki budget')

  const beforeInspect = calls.length
  await inspectRegistry.query({ agentId: 'controlled-agent', requestId: 'controlled-inspect', provider: 'WechatConversationClient', method: 'getState', input: {} })
  const diagnostic = JSON.stringify(inspectResults.at(-1))
  for (const secret of [grantRoot, ownerId, privateBody, qr.rows[0], 'controlled-private-bot']) assert.equal(diagnostic.includes(secret), false)
  assert.equal(calls.length, beforeInspect); assert.equal(diagnostic.includes('dataContextSessionId'), true); assert.equal(diagnostic.includes('taskSessionId'), true); assert.equal(diagnostic.includes('current-sse-data-v1'), true)
  console.log('PASS safe data/bridge/revision diagnostics; no private rows, roots, QR, credentials or business I/O')

  // 150 synthetic rows exercise the mounted native React data sidebar.
  const fixtureRows = Array.from({ length: 150 }, (_, index) => ({ id: String(index).padStart(3, '0'), talker: 'controlled-talker', content: 'Synthetic archive row ' + String(index).padStart(3, '0'), citation: { snapshotRef: 'a'.repeat(24), recordRef: String(index).padStart(32, '0') } }))
  const rowCheckboxes = () => Array.from(data()?.querySelector('[data-index-reference]')?.querySelectorAll('input[type="checkbox"]') || [])
  const promptsBeforePagination = prompts.length
  let paginationReferences = 0
  const renderedRows = () => recordValues(data()?.querySelector('[data-index-records]'))
  const assertRenderedRows = expected => {
    assert.deepEqual(renderedRows(), expected, 'Every returned page row must be rendered, in order')
    assert.deepEqual(recordValues(data()?.querySelector('[data-index-reference]')), expected, 'Export must retain exactly the same current-page citation rows')
    assert.equal(rowCheckboxes().length, expected.length)
  }
  const lastQuery = () => canonical(findAction('queryArchive').at(-1).request.query)
  const citeRow = async (index, expectedRow) => {
    const before = prompts.length
    await check(en.selectRow.replace('{index}', String(index))); assert.equal(dataButton('reference').disabled, false); await click(en.reference)
    assert.equal(prompts.length, before + 1); assert.equal(prompts.at(-1).id, sessionId); assert.equal(prompts.at(-1).mode, 'queue'); paginationReferences++
    const quoted = JSON.parse(prompts.at(-1).content[0].text.slice(en.referenceInstruction.length + 1))
    assert.equal(quoted.untrusted, true); assert.equal(quoted.dataContextSessionId, sessionId); assert.equal(quoted.records.length, 1)
    assert.deepEqual(quoted.records[0].record, expectedRow); assert.deepEqual(quoted.records[0].citation, expectedRow.citation)
    assert.equal(quoted.records[0].queryRow, (lastQuery().offset || 0) + index - 1)
    assert.deepEqual(quoted.query, lastQuery()); assert.equal(prompts.at(-1).content[0].text.includes(grantRoot), false)
  }
  const beforePagination = { selected: selected.length, created: findAction('createConversation').length }
  archiveFixture = await createArchiveFixture(fixtureRows)
  await assert.rejects(archiveFixture.access.query(sessionId, { action: 'status', limit: 100, offset: 0 }), { code: 'invalid-request' })
  await change(en.queryAction, 'messages'); await change(en.talker, 'controlled-talker'); await change(en.limit, '100'); await click(en.runQuery)
  assert.deepEqual(lastQuery(), { action: 'messages', talker: 'controlled-talker', limit: 100, offset: 0 })
  assert.equal(archiveFixture.lastResult.returned, 100); assert.equal(rowCheckboxes().length, 100); assertRenderedRows(fixtureRows.slice(0, 100))
  assert.equal(dataButton('previous').disabled, true); assert.equal(dataButton('next').disabled, false)
  await citeRow(51, fixtureRows[50])
  await click(en.next); assert.equal(lastQuery().offset, 100); assertRenderedRows(fixtureRows.slice(100, 150))
  assertRecordDisplay(data().querySelector('[data-index-records]'), fixtureRows.slice(100, 150))
  await exercisePageDownload(data(), sessionId, lastQuery(), { source: { kind: 'decrypted-wechat-archive', snapshotRef: 'a'.repeat(24) }, records: fixtureRows.slice(100, 150), truncated: archiveFixture.lastResult.truncated }, 'ordinary final 50 of 150 rows')
  assert.equal(rowCheckboxes().some(box => box.checked), false); assert.equal(dataButton('reference').disabled, true); assert.equal(dataButton('next').disabled, true)
  await click(en.previous); assert.equal(lastQuery().offset, 0); assertRenderedRows(fixtureRows.slice(0, 100))
  await click(en.next); assert.equal(lastQuery().offset, 100); assertRenderedRows(fixtureRows.slice(100, 150))
  console.log('PASS 150-row real React fixture: all 100 first-page rows; cite row 51; next 100..149; previous/next and selection reset')

  // Action-specific fields reach the actual archive-access strict validator.
  await change(en.queryAction, 'status'); await click(en.runQuery)
  assert.deepEqual(lastQuery(), { action: 'status' }); assert.equal(archiveFixture.lastResult.action, 'status')
  assert.equal(dataButton('previous'), undefined); assert.equal(dataButton('next'), undefined); assert.equal(view.queryByLabelText(en.limit), null)
  await change(en.queryAction, 'search'); await change(en.query, ' controlled terms '); await click(en.runQuery)
  assert.deepEqual(lastQuery(), { action: 'search', talker: 'controlled-talker', query: 'controlled terms', limit: 100, offset: 0 })
  for (const action of ['contacts', 'sessions']) {
    await change(en.queryAction, action); await click(en.runQuery)
    assert.deepEqual(lastQuery(), { action, limit: 100, offset: 0 }, 'Hidden talker/search fields must not leak across action changes')
    assert.equal(dataButton('previous').disabled, true, 'A new query resets visited offsets')
  }
  console.log('PASS validator-backed status is exactly {action}; only paginated actions carry limit/offset; hidden talker/search fields omitted')

  const byteRows = fixtureRows.map(row => ({ ...row, content: row.content + ' ' + 'x'.repeat(400) }))
  const byteBudget = archivePage({ metadata: archiveMetadata, limits: { maxBytes: 131072 } }, { action: 'messages', limit: 15, offset: 0 }, byteRows).bytes + 64
  for (const scenario of [{ label: 'maxRows', rows: fixtureRows, options: { maxRows: 15 } }, { label: 'maxBytes', rows: byteRows, options: { maxBytes: byteBudget } }]) {
    archiveFixture = await createArchiveFixture(scenario.rows, scenario.options)
    await change(en.queryAction, 'messages'); await change(en.limit, '50'); await click(en.runQuery)
    assert.equal(lastQuery().limit, 50); assert.equal(lastQuery().offset, 0); assert.equal(archiveFixture.lastResult.returned, 15)
    assert.equal(archiveFixture.lastResult.limit, scenario.label === 'maxRows' ? 15 : 50); assert.equal(archiveFixture.lastResult.hasMore, true)
    if (scenario.label === 'maxBytes') { assert.equal(archiveFixture.lastResult.truncated, true); assert.ok(archiveFixture.lastResult.bytes <= byteBudget) }
    assertRenderedRows(scenario.rows.slice(0, 15)); assert.equal(dataButton('previous').disabled, true)
    await click(en.next); assert.equal(lastQuery().offset, 15); assert.equal(lastQuery().limit, 50); assertRenderedRows(scenario.rows.slice(15, 30))
    await citeRow(15, scenario.rows[29])
    await click(en.next); assert.equal(lastQuery().offset, 30); assertRenderedRows(scenario.rows.slice(30, 45)); await citeRow(15, scenario.rows[44])
    await click(en.previous); assert.equal(lastQuery().offset, 15); assertRenderedRows(scenario.rows.slice(15, 30))
    await click(en.previous); assert.equal(lastQuery().offset, 0); assertRenderedRows(scenario.rows.slice(0, 15))
    assert.equal(rowCheckboxes().some(box => box.checked), false); assert.equal(dataButton('reference').disabled, true)
    await click(en.next); assert.equal(lastQuery().offset, 15); assertRenderedRows(scenario.rows.slice(15, 30)); await citeRow(1, scenario.rows[15])
    console.log('PASS ' + scenario.label + ' truncates requested 50 to 15: 0→15→30→15→0→15; full returned rows remain selectable/citable')
  }
  await change(en.root, grantRoot); await change(en.talkers, 'controlled-talker'); await check(en.grantConsent); await click(en.grant)
  assert.equal(rowCheckboxes().length, 0); assert.equal(dataButton('previous'), undefined)
  await click(en.runQuery); assert.equal(lastQuery().offset, 0); assert.equal(dataButton('previous').disabled, true)
  await click(en.next); assert.equal(lastQuery().offset, 15)
  await click(en.revoke); assert.equal(rowCheckboxes().length, 0); assert.equal(dataButton('previous'), undefined)
  archiveFixture = null
  await change(en.root, grantRoot); await change(en.talkers, 'controlled-talker'); await check(en.grantConsent); await click(en.grant); await change(en.queryAction, 'sessions')
  assert.deepEqual({ selected: selected.length, created: findAction('createConversation').length }, beforePagination)
  assert.equal(prompts.length, promptsBeforePagination + paginationReferences, 'Queries/pages/grant/revoke must never submit automatic references')
  assert.equal(view.container.querySelector('[data-native-sse]').textContent, 'SSE · token 2'); assert.equal(current.getSnapshot().key, sessionId)
  assert.ok(archiveWorkerCalls.length > 0); assert.equal(networkAttempts, 0)
  console.log('PASS new query/grant/revoke clear pagination history; IPC is in-memory; no automatic prompt, Session navigation, bridge creation or network')

  deferQuery = true; await click(en.runQuery); assert.ok(deferredQuery)
  await click(en.cancel); assert.equal(deferredQuery.signal.aborted, true)
  await click(en.revoke); await act(async () => deferredQuery.resolve())
  assert.equal(view.container.textContent.includes(privateBody), false); assert.equal(states.get(sessionId).archive.granted, false); deferQuery = false
  console.log('PASS late ordinary rows after cancel/revoke are withheld; removed readonly bridge has no UI entry')

  await act(async () => workspaceList.set({ ...workspaceList.getSnapshot(), archivedSessionIds: [sessionId] }))
  assert.equal(current.getSnapshot().key, undefined)
  await act(async () => { workspaceList.set({ ...workspaceList.getSnapshot(), archivedSessionIds: [] }); layout.selectPanel('wechat-ro') })
  const beforeMissing = { selected: selected.length, creates: findAction('createConversation').length, prompts: prompts.length }
  await click(en.launcher)
  assert.equal(current.getSnapshot().key, undefined); assert.equal(view.getByLabelText(en.chooseSession).value, ''); assert.equal(view.getByRole('button', { name: en.restoreSession, exact: true }).disabled, true)
  assert.equal(selected.length, beforeMissing.selected); assert.equal(findAction('createConversation').length, beforeMissing.creates); assert.equal(prompts.length, beforeMissing.prompts)
  await change(en.chooseSession, sessionId); await click(en.restoreSession)
  assert.equal(current.getSnapshot().key, sessionId); assert.deepEqual(selected, [sessionId]); assert.equal(prompts.length, beforeMissing.prompts)
  console.log('PASS actual UiSession no-selection; no first/last/blank creation; only explicit picker restores an existing native Session')

  archiveFixture = await createArchiveFixture(fixtureRows, { maxRows: 15 })
  await change(en.root, grantRoot); await change(en.talkers, 'controlled-talker'); await check(en.grantConsent); await click(en.grant)
  await change(en.queryAction, 'messages'); await change(en.talker, 'controlled-talker'); await change(en.limit, '50'); await click(en.runQuery)
  await click(en.next); await click(en.next); assert.equal(lastQuery().offset, 30)
  const beforeExplicitSwitch = { calls: actionCalls().length, selected: selected.length, prompts: prompts.length }
  await act(async () => workspace.openSession(otherId)); assert.equal(data(), null)
  await act(async () => workspace.openSession(sessionId)); assert.equal(rowCheckboxes().length, 0); assert.equal(dataButton('previous'), undefined)
  assert.deepEqual(selected.slice(beforeExplicitSwitch.selected), [otherId, sessionId]); assert.equal(prompts.length, beforeExplicitSwitch.prompts)
  assert.equal(actionCalls().length, beforeExplicitSwitch.calls); assert.equal(view.container.querySelector('[data-native-sse]').textContent, 'SSE · token 2')
  await click(en.runQuery); assert.equal(lastQuery().offset, 0); assert.equal(dataButton('previous').disabled, true); assertRenderedRows(fixtureRows.slice(0, 15))
  archiveFixture = null
  console.log('PASS actual UiSession switch/remount clears rows and offset history without action/automatic prompt; a fresh query restarts at zero')

  const loginExpiryCases = []
  const exerciseExpiredLogin = async (root, expectedId, getActions, dictionary) => {
    await showSettings(data(), 'connection')
    const scope = () => within(root())
    const clickControl = async key => { const control = await revealControl(root(), 'button', dictionary[key]); await act(async () => fireEvent.click(control)) }
    const checkControl = async key => { const control = await revealControl(root(), 'checkbox', dictionary[key]); await act(async () => fireEvent.click(control)) }
    const before = { actions: getActions().length, prompts: prompts.length, selected: selected.length, center: view.container.querySelector('[data-native-sse]') }
    assert.equal(scope().getByRole('checkbox', { name: dictionary.loginConsent, exact: true }).checked, false)
    await checkControl('loginConsent'); await clickControl('beginLogin')
    assert.ok(scope().getByRole('img', { name: dictionary.qrLabel, exact: true }))
    assert.equal(root().textContent.includes(dictionary.phaseQr), true)
    const verification = await revealControl(root(), 'field', dictionary.verifyCode)
    await act(async () => fireEvent.change(verification, { target: { value: 'synthetic-expired-verify' } }))
    await checkControl('loginConsent')
    syntheticLoginStatus = 'expired'
    try { await clickControl('pollLogin') } finally { syntheticLoginStatus = 'confirmed' }
    assert.ok(scope().getByText(dictionary.pollExpired, { exact: true }))
    assert.equal(root().textContent.includes(dictionary.phaseQr), false)
    assert.equal(root().textContent.includes(dictionary.phaseUnpaired), true)
    assert.equal(scope().queryByRole('img', { name: dictionary.qrLabel, exact: true }), null)
    assert.equal(scope().queryByRole('button', { name: dictionary.pollLogin, exact: true }), null)
    assert.equal(scope().queryByLabelText(dictionary.verifyCode), null)
    assert.equal(scope().queryByRole('checkbox', { name: dictionary.ownerConsent, exact: true }), null)
    assert.equal(scope().getByRole('checkbox', { name: dictionary.loginConsent, exact: true }).checked, false)
    assert.equal(scope().getByRole('button', { name: dictionary.beginLogin, exact: true }).disabled, true)
    assert.equal(scope().getByRole('button', { name: dictionary.start, exact: true }).disabled, true)
    assert.equal(getActions().length, before.actions + 2, 'Expiration must not request a replacement, retry, pair or start')
    await checkControl('loginConsent'); await clickControl('beginLogin')
    assert.ok(scope().getByRole('img', { name: dictionary.qrLabel, exact: true }))
    assert.equal(scope().queryByText(dictionary.pollExpired, { exact: true }), null)
    assert.equal(scope().getByLabelText(dictionary.verifyCode).value, '')
    assert.equal(scope().getByRole('checkbox', { name: dictionary.loginConsent, exact: true }).checked, false)
    const dispatched = getActions().slice(before.actions)
    assert.deepEqual(dispatched.map(call => call.request.action), ['beginLogin', 'pollLogin', 'beginLogin'])
    assert.ok(dispatched.every(call => call.request.sessionId === expectedId))
    assert.equal(prompts.length, before.prompts); assert.equal(selected.length, before.selected)
    assert.equal(view.container.querySelector('[data-native-sse]'), before.center)
  }
  // The removed readonly bridge is covered by runtime compatibility suites,
  // not by retaining an unreachable production UI in this test.
  await click(en.revoke)

  const ordinaryQueriesBeforeUncertainty = findAction('queryArchive').length
  const ordinaryPromptsBeforeUncertainty = prompts.length
  await change(en.root, grantRoot); await change(en.talkers, 'controlled-talker'); await check(en.grantConsent)
  nextMutation = { sessionId, action: 'grantSnapshot', mode: 'committed-response-lost' }
  await click(en.grant)
  assert.equal(states.get(sessionId).archive.granted, true)
  assert.equal(data().textContent.includes(en.grantUncertain), true)
  assert.equal(dataButton('runQuery').disabled, true)
  await click(en.refresh)
  assert.equal(data().textContent.includes(en.grantUncertain), true, 'A metadata GET cannot settle a lost ordinary grant receipt')
  nextMutation = { sessionId, action: 'revokeSnapshot', mode: 'deferred', committed: true }
  await click(en.revoke)
  const cancelledOrdinaryRevoke = deferredMutation
  await click(en.cancel)
  assert.equal(cancelledOrdinaryRevoke.signal.aborted, true)
  assert.equal(states.get(sessionId).archive.granted, false)
  await act(async () => cancelledOrdinaryRevoke.resolve())
  assert.equal(data().textContent.includes(en.grantUncertain), true, 'Cancellation and a late success cannot settle the new UI occurrence')
  assert.equal(dataButton('runQuery').disabled, true)
  await click(en.revoke)
  assert.equal(data().textContent.includes(en.grantUncertain), false)
  assert.equal(states.get(sessionId).archive.allowWechat, false)
  assert.equal(findAction('queryArchive').length, ordinaryQueriesBeforeUncertainty)
  assert.equal(prompts.length, ordinaryPromptsBeforeUncertainty)
  console.log('PASS ordinary lost grant and cancelled committed revoke stay uncertain through GET/late success; explicit revoke settles without reads, model input or sharing')

  const taskCases = [], te = client.__taskI18n.en
  const taskCalls = () => actionCalls().filter(call => call.request.kind === 'task')
  const taskActions = name => taskCalls().filter(call => call.request.action === name)
  const taskAside = data
  const taskDetail = () => data()?.hasAttribute('data-task-session-id') ? data() : null
  const taskConnection = () => taskDetail()?.querySelector('[data-task-connection]')
  const taskChooseSourceKind = async kind => {
    await showSettings(taskAside(), 'sources')
    const dictionary = frameDictionary(taskAside()), control = await revealControl(taskDetail(), 'field', dictionary.indexSourceType)
    const before = navigationActivity()
    if (control.value !== kind) {
      assert.equal(control.disabled, false, 'A source type can only change through an enabled visible chooser')
      await act(async () => fireEvent.change(control, { target: { value: kind } }))
    }
    assert.equal(control.value, kind)
    assertNavigationQuiet(before)
  }
  const taskOpenDetails = async (key, root = taskAside()) => {
    if (key === 'previewSources') {
      await showIndexView(taskAside(), 'records')
      const query = taskDetail()?.querySelector('[data-index-records]')
      assert.equal(visible(query), true)
      return query
    }
    const kind = { workspaceAccess: 'workspace', addDirectory: 'directory', addSession: 'session', addArchive: 'archive' }[key]
    if (kind) {
      await taskChooseSourceKind(kind)
      root = taskDetail()
      if (kind === 'workspace') return within(root).getByRole('form', { name: te.grantWorkspace, exact: true })
    } else if (['knownIdTitle', 'newTask'].includes(key)) {
      await showSettings(taskAside(), 'task')
      root = taskAside()
    }
    const details = Array.from(root.querySelectorAll('details')).find(value => value.querySelector(':scope > summary')?.textContent === te[key] && shownByPanel(value))
    assert.ok(details, key)
    for (let ancestor = details.parentElement; ancestor; ancestor = ancestor.parentElement) if (ancestor.tagName === 'DETAILS' && !ancestor.open) await openDetails(ancestor)
    return openDetails(details)
  }
  const taskSelectionKeys = new Set(['existingTask', 'selectTask', 'clearTask', 'knownTaskId', 'selectKnownId', 'createTask'])
  const taskQueryKeys = new Set(['querySource', 'fileAction', 'relativePath', 'queryContact', 'queryText', 'querySources', 'queryAction'])
  const taskConnectionKeys = new Set(['resumeTask', 'openNative', 'refresh', 'cancel', 'wholeContextConsent', 'allowSharing', 'denySharing', 'loginConsent', 'beginLogin', 'pollLogin',
    'verifyCode', 'ownerConsent', 'confirmPairing', 'textOnceConsent', 'textOnce', 'updatesDiagnosticConsent', 'updatesDiagnosticAction', 'startConsent', 'start', 'stop', 'discardConsent', 'discard', 'forgetConsent', 'forget'])
  const prepareTaskControl = async (key, root) => {
    if (taskSelectionKeys.has(key)) await showSettings(taskAside(), 'task')
    else if (taskQueryKeys.has(key) || root?.matches('[data-index-records]')) await showIndexView(taskAside(), 'records')
    else if (taskConnectionKeys.has(key) && taskDetail()) await showSettings(taskAside(), 'connection')
    else if (key === 'revokeAll') { await showSettings(taskAside(),'sources'); await openDetails(taskAside().querySelector('[data-index-advanced]')) }
    else if (key === 'revokeSource') await showSettings(taskAside(),'sources')
    else {
      const form = root?.matches('form') ? root : root?.querySelector('form')
      if (form?.getAttribute('aria-label') === te.createTask) await showSettings(taskAside(), 'task')
      else if ([te.grantWorkspace, te.addDirectory, te.addSession, te.browseRoster, te.grantArchive].includes(form?.getAttribute('aria-label'))) await showSettings(taskAside(), 'sources')
    }
  }
  const taskClick = async (key, root = taskAside(), dictionary = te) => {
    await prepareTaskControl(key, root)
    const previousId = taskDetail()?.getAttribute('data-task-session-id'), label = key === 'querySources' ? en.runQuery : dictionary[key], control = await revealControl(root, 'button', label)
    await act(async () => fireEvent.click(control))
    const selectedId = taskDetail()?.getAttribute('data-task-session-id')
    if (['selectTask', 'selectKnownId', 'createTask'].includes(key) && selectedId && selectedId !== previousId) {
      assertDefaultOverview(taskDetail())
      await showSettings(taskAside(), 'connection')
    }
  }
  const taskCheck = async (key, root = taskAside(), dictionary = te) => {
    await prepareTaskControl(key, root)
    const control = await revealControl(root, 'checkbox', dictionary[key])
    await act(async () => fireEvent.click(control))
  }
  const taskChange = async (key, value, root = taskAside(), dictionary = te) => {
    await prepareTaskControl(key, root)
    const control = await revealControl(root, 'field', dictionary[key])
    if(key==='querySource') value='task:'+taskDetail().getAttribute('data-task-session-id')+':'+value
    await act(async () => fireEvent.change(control, { target: { value } }))
  }
  const taskSelect = async id => {
    const progress = process.env.WECHAT_TEST_PROGRESS === '1';
    if (progress) console.log('SELECT draft ' + id);
    await taskChange('existingTask', id);
    if (progress) console.log('SELECT submit ' + id);
    await taskClick('selectTask');
    if (progress) console.log('SELECT ready ' + id);
  }
  const passTask = name => { taskCases.push(name); console.log('PASS Task: ' + name) }
  const oldTaskEntryState = canonical(states.get(sessionId)), oldTaskBotState = canonical(states.get(createdId)), beforeTaskPrompts = prompts.length
  const assertTaskCenterUnchanged = () => { assert.equal(current.getSnapshot().key, sessionId); assert.equal(view.container.querySelectorAll('[data-native-sse]').length, 1); assert.equal(view.container.querySelector('[data-native-sse]').textContent, nativeStreams.get(sessionId).getSnapshot().streamingText); assert.equal(prompts.length, beforeTaskPrompts); assert.deepEqual(canonical(states.get(sessionId)), oldTaskEntryState); assert.deepEqual(canonical(states.get(createdId)), oldTaskBotState) }
  const sampleTaskAction = { kind: 'task', action: 'createConversation', contextSessionId: sessionId, workspace: { root: taskWorkspace.root, title: taskWorkspace.title, allowWechat: false, confirmation: 'read-and-write-task-workspace' } }
  for (const wire of [hostWire.TASK_WIRE, client.__conversationWire.taskWire]) {
    assert.equal(wire.actionSchema.safeParse(sampleTaskAction).success, true)
    assert.equal(wire.actionSchema.safeParse({ ...sampleTaskAction, workspace: { root: taskWorkspace.root, title: taskWorkspace.title, allowWechat: false } }).success, false)
    assert.equal(wire.actionSchema.safeParse({ kind: 'task', action: 'queryFiles', sessionId: TASK1, query: { action: 'create', path: 'file.md', content: 'No UI writer' } }).success, false)
    assert.equal(wire.actionSchema.safeParse({ kind: 'task', action: 'resumeConversation', sessionId, confirmation: 'resume-task-conversation' }).success, false)
    assert.equal(wire.TASK_ACTION_NAMES.length, 37)
    assert.deepEqual(Array.from(wire.TASK_ACTION_NAMES.slice(22, 30)), ['reviewHistoricalContext', 'authorizeHistoricalContext', 'revokeHistoricalContext',
      'selectFirstTextModel', 'reviewFirstTextContext', 'authorizeFirstTextContext', 'revokeFirstTextContext', 'allowNewFirstText'])
    const textOnce = { kind: 'task', action: 'pollTextOnce', sessionId: TASK1, allowSharedContext: true, confirmation: 'poll-one-text-reply' }
    assert.equal(wire.actionSchema.safeParse(textOnce).success, true)
    const continuation = { ...textOnce, action: 'resumeTextOnce', confirmation: 'continue-unanswered-message' }
    assert.equal(wire.actionSchema.safeParse(continuation).success, true)
    for (const invalid of [{ ...continuation, allowSharedContext: false }, { ...continuation, confirmation: 'poll-one-text-reply' }, { ...continuation, text: 'override' }]) assert.equal(wire.actionSchema.safeParse(invalid).success, false)
    for (const invalid of [{ ...textOnce, allowSharedContext: false }, { ...textOnce, confirmation: 'poll-and-reply' },
      { ...textOnce, maxMessages: 2 }, { ...textOnce, attachments: true }, { ...textOnce, kind: undefined }]) {
      assert.equal(wire.actionSchema.safeParse(invalid).success, false)
    }
    const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', target = { kind: 'task', sessionId: TASK1 }
    const historicalPoll = { ...target, action: 'pollTextOnce', historyConsentId: uuid, allowSharedContext: true, confirmation: 'poll-one-text-reply-with-reviewed-history' }
    const historicalShare = { ...target, action: 'setSharing', historyConsentId: uuid, allowWechat: true, confirmation: 'share-reviewed-task-history-context' }
    for (const request of [historicalPoll, historicalShare, { ...target, action: 'reviewHistoricalContext' },
      { ...target, action: 'authorizeHistoricalContext', reviewId: uuid, confirmation: 'authorize-reviewed-task-history-text' },
      { ...target, action: 'revokeHistoricalContext', revokeId: uuid, confirmation: 'revoke-task-history-context' }]) assert.equal(wire.actionSchema.safeParse(request).success, true)
    for (const invalid of [{ ...textOnce, historyConsentId: uuid }, { ...historicalPoll, historyConsentId: undefined }, { ...historicalPoll, attachments: true },
      { ...historicalShare, historyConsentId: undefined }, { ...historicalShare, allowWechat: false }, { ...historicalShare, confirmation: 'share-whole-task-context' },
      { ...target, action: 'startChannel', historyConsentId: uuid, allowSharedContext: true, confirmation: 'poll-and-reply' }]) assert.equal(wire.actionSchema.safeParse(invalid).success, false)
    const diagnostic = { ...target, action: 'diagnoseUpdatesOnce', confirmation: 'read-one-wechat-update-diagnostic' }
    assert.equal(wire.actionSchema.safeParse(diagnostic).success, true)
    for (const invalid of [{ ...diagnostic, confirmation: 'poll-one-text-reply' }, { ...diagnostic, historyConsentId: uuid },
      { ...diagnostic, firstTextConsentId: uuid }, { ...diagnostic, allowSharedContext: true }, { ...diagnostic, kind: undefined }]) {
      assert.equal(wire.actionSchema.safeParse(invalid).success, false)
    }
    assert.equal(wire.updatesDiagnosticSchema.safeParse(validUpdatesDiagnostic).success, true)
    assert.equal(wire.updatesDiagnosticResultSchema.safeParse({ diagnostic: validUpdatesDiagnostic }).success, true)
    for (const invalid of [{ ...validUpdatesDiagnostic, raw: 'SYNTHETIC_DIAGNOSTIC_SECRET' }, { ...validUpdatesDiagnostic, messageCount: 257 },
      { ...validUpdatesDiagnostic, textCount: 4 }, { ...validUpdatesDiagnostic, cursorShape: 'SYNTHETIC_DIAGNOSTIC_SECRET' },
      { ...validUpdatesDiagnostic, errorCode: 'SYNTHETIC_DIAGNOSTIC_SECRET' }, { ...validUpdatesDiagnostic, version: 2 }]) {
      assert.equal(wire.updatesDiagnosticSchema.safeParse(invalid).success, false)
    }
    assert.equal(wire.updatesDiagnosticResultSchema.safeParse({ diagnostic: validUpdatesDiagnostic, credentials: 'SYNTHETIC_DIAGNOSTIC_SECRET' }).success, false)
  }
  assert.equal(hostWire.actionSchema.safeParse(sampleTaskAction).success, false)
  passTask('strict kind branch, exact Task SID, separate consent and no Owner file-write API; old 12 actions unchanged')

  const existingTab=right.controller.tabsIn(sessionId).find(tab=>tab.kind===client.CONVERSATION_TAB_KIND)
  assert.ok(existingTab); assert.equal(taskDetail(),null)
  assert.equal(slots._core.entries('sidebar.panellist').filter(entry=>entry.options.id==='wechat-ro').length,1)
  assert.equal(slots._core.entries('main').some(entry=>entry.options.key==='wechat-task'),false)
  await showIndexView(taskAside(), 'overview')
  assertDefaultOverview(taskAside())
  await exerciseIndexNavigation(taskAside(),'unified without task / en')
  await act(async()=>locale.setLocale('zh')); await exerciseIndexNavigation(taskAside(),'unified without task / zh'); await act(async()=>locale.setLocale('en'))
  const beforeTaskSettings=navigationActivity(); await showSettings(taskAside(),'connection')
  assert.equal(within(taskAside()).getByLabelText(te.existingTask).value,'')
  assert.equal(within(taskAside()).getByRole('button',{name:te.selectTask,exact:true}).disabled,true)
  assertNavigationQuiet(beforeTaskSettings)
  assert.equal(right.controller.tabsIn(sessionId).filter(tab=>tab.kind===client.CONVERSATION_TAB_KIND).length,1)
  assert.equal(right.controller.tabsIn(sessionId).find(tab=>tab.kind===client.CONVERSATION_TAB_KIND).id,existingTab.id)
  assertTaskCenterUnchanged(); passTask('one existing sidebar and frame, no second entry/mode; task setup uses metadata only')

  const coldTaskId = 'wechat-task-44444444-4444-4444-8444-444444444444'
  const missingTaskId = 'wechat-task-55555555-5555-4555-8555-555555555555'
  taskTitles.set(coldTaskId, 'Synthetic stored-only task')
  taskRecord(coldTaskId).workspace = { ...taskWorkspace }
  assert.equal(knownTaskIds.has(coldTaskId), false)
  assert.equal(states.has(coldTaskId), false)
  assert.equal(within(taskAside()).getByLabelText(te.existingTask).querySelector('option[value="' + coldTaskId + '"]'), null)
  const knownIdForm = () => taskAside().querySelector('[data-task-known-id]')
  assert.equal(knownIdForm().open, false)
  await taskOpenDetails('knownIdTitle')
  const beforeKnownIdActions = taskCalls().length, beforeKnownIdRequests = calls.length
  for (const invalid of [sessionId, createdId, '/synthetic/task', 'wechat-task-invalid',
    'wechat-task-44444444-4444-1444-8444-444444444444', coldTaskId + ' ', coldTaskId.toUpperCase()]) {
    await taskChange('knownTaskId', invalid, knownIdForm())
    assert.equal(within(knownIdForm()).getByRole('button', { name: te.selectKnownId, exact: true }).disabled, true)
    assert.equal(knownIdForm().textContent.includes(te.knownIdInvalid), true)
    await taskClick('selectKnownId', knownIdForm())
    assert.equal(taskDetail(), null)
  }
  await taskChange('knownTaskId', coldTaskId, knownIdForm())
  assert.equal(within(knownIdForm()).getByRole('button', { name: te.selectKnownId, exact: true }).disabled, false)
  assert.equal(taskCalls().length, beforeKnownIdActions); assert.equal(calls.length, beforeKnownIdRequests)
  await taskClick('selectKnownId', knownIdForm())
  assert.equal(taskDetail().getAttribute('data-task-session-id'), coldTaskId)
  assert.equal(within(knownIdForm()).getByLabelText(te.knownTaskId).value, '')
  assert.equal(taskCalls().length, beforeKnownIdActions)
  assert.ok(within(taskConnection()).getByRole('button', { name: te.resumeTask, exact: true }))
  assert.equal(taskRecords.get(coldTaskId).prepared, false)
  assert.equal(taskConnection().querySelector('[data-wechat-updates-diagnostic]'), null, 'An unprepared Task has no diagnostic action')
  assertTaskCenterUnchanged()
  await taskClick('resumeTask', taskConnection())
  assert.deepEqual(taskActions('resumeConversation').at(-1).request, { kind: 'task', action: 'resumeConversation', sessionId: coldTaskId, confirmation: 'resume-task-conversation' })
  assert.equal(taskRecords.get(coldTaskId).prepared, true)
  assert.equal(taskRecords.get(coldTaskId).sources.size, 0); assert.equal(taskRecords.get(coldTaskId).allowWechat, false)
  assert.equal(taskState(coldTaskId).channel.messagingEnabled, false); assert.equal(taskState(coldTaskId).channel.automaticPolling, false)
  assert.equal(taskActions('createConversation').length, 0); assert.equal(taskActions('beginLogin').length, 0)
  assert.equal(taskActions('startChannel').length, 0); assert.equal(taskActions('pollTextOnce').length, 0)
  assertTaskCenterUnchanged()
  passTask('known-ID selection rejects ordinary/path/invalid IDs without calls; a stored-only Task resumes the exact SID once with no create, pairing, source/share restoration or center change')

  await taskChange('knownTaskId', missingTaskId, knownIdForm()); await taskClick('selectKnownId', knownIdForm())
  const beforeMissingResume = taskActions('resumeConversation').length
  await taskClick('resumeTask', taskConnection())
  assert.equal(taskActions('resumeConversation').length, beforeMissingResume + 1)
  assert.equal(taskConnection().textContent.includes(en.SESSION_NOT_READY), true)
  assert.equal(taskRecords.has(missingTaskId), false)
  assert.equal(taskActions('createConversation').length, 0)
  assertTaskCenterUnchanged()
  await taskChange('knownTaskId', coldTaskId, knownIdForm())
  await taskClick('clearTask')
  assert.equal(taskDetail(), null); assert.equal(within(knownIdForm()).getByLabelText(te.knownTaskId).value, '')
  passTask('missing known-ID recovery fails closed without a replacement Task; clearing selection removes the recovery draft')

  const createForm = await taskOpenDetails('newTask')
  await taskChange('existingWorkspace', taskWorkspace.id, createForm)
  const createActionCount = taskActions('createConversation').length
  assert.equal(within(createForm).getByRole('button', { name: te.createTask, exact: true }).disabled, true)
  await taskCheck('sourceSharing', createForm); await taskCheck('workspaceConsent', createForm); await taskClick('createTask', createForm)
  assert.equal(taskActions('createConversation').length, createActionCount + 1)
  assert.deepEqual(taskActions('createConversation').at(-1).request.workspace, { root: taskWorkspace.root, title: taskWorkspace.title, allowWechat: true, confirmation: 'read-and-write-task-workspace' })
  assert.equal(taskDetail().getAttribute('data-task-session-id'), TASK1)
  assert.equal(taskRecords.get(TASK1).sources.get('workspace').write, true)
  assert.equal(taskRecords.get(TASK1).allowWechat, false)
  assert.equal(taskState(TASK1).channel.automaticPolling, false)
  assertTaskCenterUnchanged()
  passTask('explicit workspace and write/read consent create one controlled Task without sharing or navigating the center')

  await showIndexView(taskAside(), 'overview')
  assertDefaultOverview(taskDetail())
  const taskHeader = taskDetail().querySelector('[data-wechat-conversation-header]')
  assert.equal(taskHeader.querySelectorAll('h1,h2').length, 1)
  assert.equal(taskHeader.querySelector('h2').textContent, en.indexOverview)
  assert.equal(taskHeader.querySelector('.wi-note'),null,'No second task-mode header')
  assert.equal(taskHeader.textContent.includes(te.title), false, 'The selected Task header must not duplicate its generic native tab title')
  assert.equal(taskHeader.textContent.includes(TASK1), false)
  await exerciseIndexNavigation(taskDetail(), 'TaskDetails with sole authorized workspace / en')
  await act(async () => locale.setLocale('zh'))
  await exerciseIndexNavigation(taskDetail(), 'TaskDetails with sole authorized workspace / zh')
  await act(async () => locale.setLocale('en'))
  const beforeKindNavigation = navigationActivity()
  for (const kind of ['directory', 'session', 'archive', 'workspace']) {
    await taskChooseSourceKind(kind)
    const selector = within(taskDetail()).getByLabelText(en.indexSourceType)
    assert.deepEqual(Array.from(selector.options, option => option.value), ['archive', 'workspace', 'directory', 'session'])
    for (const [editorKind, name] of [['workspace', te.grantWorkspace], ['directory', te.addDirectory], ['session', te.addSession], ['archive', te.grantArchive]]) {
      assert.equal(within(taskDetail()).queryByRole('form', { name, exact: true }) !== null, editorKind === kind, 'Only the chosen Task source-kind editor may be visible')
    }
  }
  assertNavigationQuiet(beforeKindNavigation)
  assertTaskCenterUnchanged()
  passTask('selected Task shares the default/keyboard/settings frame; source-type navigation shows only its chosen editor and performs no grant/read/model/channel action')

  const refreshingWorkspace = await taskOpenDetails('workspaceAccess', taskDetail())
  await taskChange('workspaceName', 'Synthetic retained workspace draft', refreshingWorkspace)
  await taskCheck('sourceSharing', refreshingWorkspace); await taskCheck('workspaceConsent', refreshingWorkspace)
  const workspaceGrantsBeforeRefresh = taskActions('grantWorkspace').length
  nextTaskRead = { sessionId: TASK1, mode: 'deferred' }
  await taskClick('refresh', taskConnection(), en)
  await showSettings(taskAside(), 'sources')
  assert.equal(refreshingWorkspace.isConnected, true)
  assert.equal(within(refreshingWorkspace).getByLabelText(te.workspaceName).value, 'Synthetic retained workspace draft')
  for (const key of ['workspaceConsent', 'sourceSharing']) {
    const control = within(refreshingWorkspace).getByRole('checkbox', { name: te[key], exact: true })
    assert.equal(control.checked, true); assert.equal(control.disabled, true)
  }
  await act(async () => fireEvent.submit(refreshingWorkspace))
  assert.equal(taskActions('grantWorkspace').length, workspaceGrantsBeforeRefresh)
  await act(async () => deferredTaskRead.resolve())
  const refreshedWorkspace = await taskOpenDetails('workspaceAccess', taskDetail())
  assert.equal(refreshedWorkspace, refreshingWorkspace)
  assert.equal(within(refreshedWorkspace).getByLabelText(te.workspaceName).value, 'Synthetic retained workspace draft')
  for (const key of ['workspaceConsent', 'sourceSharing']) {
    const control = within(refreshedWorkspace).getByRole('checkbox', { name: te[key], exact: true })
    assert.equal(control.checked, true); assert.equal(control.disabled, false)
  }
  await taskSelect(TASK2); await taskSelect(TASK1)
  const switchedWorkspace = await taskOpenDetails('workspaceAccess', taskDetail())
  assert.equal(refreshingWorkspace.isConnected, false)
  assert.equal(within(switchedWorkspace).getByLabelText(te.workspaceName).value, taskWorkspace.title)
  for (const key of ['workspaceConsent', 'sourceSharing']) assert.equal(within(switchedWorkspace).getByRole('checkbox', { name: te[key], exact: true }).checked, false)
  assert.equal(taskActions('grantWorkspace').length, workspaceGrantsBeforeRefresh)
  assertTaskCenterUnchanged()
  passTask('same Task refresh preserves the workspace name and confirmations while disabling submission; a Task switch clears the draft and performs no grant')

  let soleQuery = await taskOpenDetails('previewSources', taskDetail())
  assert.equal(within(soleQuery).queryByLabelText(te.querySource), null, 'A sole already-authorized source needs no selection dropdown')
  assert.ok(within(soleQuery).getByText(taskWorkspace.title, { exact: true }))
  assert.equal(within(soleQuery).getByRole('button', { name: en.runQuery, exact: true }).disabled, false)
  await taskClick('querySources', soleQuery)
  assert.deepEqual(taskActions('queryFiles').at(-1).request, { kind: 'task', action: 'queryFiles', sessionId: TASK1, query: { action: 'list', sourceId: 'workspace', limit: 20 } })
  assertRecordDisplay(soleQuery.querySelector('[data-task-query-result]'), [{ name: 'synthetic-document.md', type: 'file' }])
  await taskClick('indexOpenFile', soleQuery, en)
  assert.deepEqual(taskActions('queryFiles').at(-1).request, { kind: 'task', action: 'queryFiles', sessionId: TASK1, query: { action: 'read', sourceId: 'workspace', path: 'synthetic-document.md' } })
  assert.equal(soleQuery.querySelector('[data-task-query-result]').textContent.includes(taskPrivateText), true)
  assert.equal(soleQuery.querySelector('script'), null)
  await exercisePageDownload(taskDetail(), TASK1, canonical(taskActions('queryFiles').at(-1).request), { sourceId: 'workspace', path: 'synthetic-document.md', text: taskPrivateText, truncated: false }, 'Task sole-workspace text read')
  assertTaskCenterUnchanged()
  passTask('sole workspace is displayed without a chooser; explicit file-row opening keeps exact Task/source/path authority and exports only the queried text without its temporary reference')

  let extraForm = await taskOpenDetails('addDirectory', taskDetail())
  const pickerBefore = pickerCalls, extraBefore = taskActions('grantDirectory').length
  await taskClick('pickDirectory', extraForm)
  assert.equal(pickerCalls, pickerBefore + 1); assert.equal(taskActions('grantDirectory').length, extraBefore)
  await taskCheck('sourceSharing', extraForm); await taskCheck('directoryConsent', extraForm); await taskClick('grantDirectory', extraForm)
  assert.equal(taskActions('grantDirectory').at(-1).request.sessionId, TASK1)
  assert.equal(taskActions('grantDirectory').at(-1).request.root, taskExtraRoot)
  assert.equal([...taskRecords.get(TASK1).sources.values()].find(source => source.root === taskExtraRoot).write, false)
  const multiQuery = await taskOpenDetails('previewSources', taskDetail()), beforeMultipleSelection = taskCalls().length
  assert.equal(within(multiQuery).getByLabelText(te.querySource).value, '', 'Adding a second source must not silently choose one')
  assert.equal(within(multiQuery).getByRole('button', { name: en.runQuery, exact: true }).disabled, true)
  await taskClick('querySources', multiQuery)
  assert.equal(taskCalls().length, beforeMultipleSelection)
  const extraSourceId = [...taskRecords.get(TASK1).sources.values()].find(source => source.root === taskExtraRoot).sourceId
  await taskChange('querySource', extraSourceId, multiQuery)
  assert.equal(within(multiQuery).getByLabelText(te.querySource).value, 'task:'+TASK1+':'+extraSourceId)
  assert.equal(taskCalls().length, beforeMultipleSelection, 'Explicit source selection itself must not query or grant')
  assertTaskCenterUnchanged()
  passTask('multiple authorized sources keep an empty explicit chooser; a disabled submit and source selection cannot perform an automatic read')
  const sessionForm = await taskOpenDetails('addSession', taskDetail())
  await taskChange('sourceSession', otherId, sessionForm); await taskCheck('sourceSharing', sessionForm); await taskCheck('sessionConsent', sessionForm); await taskClick('grantSession', sessionForm)
  assert.equal(taskActions('grantSession').at(-1).request.sourceSessionId, otherId)
  assert.equal(taskActions('grantSession').at(-1).request.sessionId, TASK1)
  assert.equal(taskRecords.get(TASK1).sources.get('synthetic-task-session').sessionId, otherId)
  assertTaskCenterUnchanged()
  passTask('native directory picker has no grant side effect; explicit directory and exact source-SID grants remain Task-bound')

  let archiveForm = await taskOpenDetails('addArchive', taskDetail())
  nextTaskPicker = taskArchiveRoot
  await taskClick('pickDirectory', archiveForm); assert.ok(deferredTaskPicker)
  await act(async () => deferredTaskPicker.resolve())
  assert.equal(archiveForm.querySelector('[data-task-archive-path]').open, false)
  const preparedPathForm = await taskOpenDetails('archivePathAdvanced', archiveForm)
  const preparedPathPickerCalls = pickerCalls, preparedPathReads = taskActions('prepareSnapshot').length
  const preparedPathGrants = taskActions('grantSnapshot').length
  await taskCheck('rosterConsent', archiveForm); await taskCheck('archiveConsent', archiveForm); await taskCheck('sourceSharing', archiveForm)
  await taskChange('archivePreparedPath', '  ' + taskArchiveRoot + '  ', preparedPathForm)
  for (const key of ['rosterConsent', 'archiveConsent', 'sourceSharing']) assert.equal(within(archiveForm).getByRole('checkbox', { name: te[key], exact: true }).checked, false)
  await taskClick('archivePathApply', preparedPathForm)
  assert.equal(within(preparedPathForm).getByLabelText(te.archivePreparedPath).value, '')
  assert.ok(archiveForm.textContent.includes(taskArchiveRoot))
  assert.equal(pickerCalls, preparedPathPickerCalls)
  assert.equal(taskActions('prepareSnapshot').length, preparedPathReads)
  assert.equal(taskActions('grantSnapshot').length, preparedPathGrants)
  assertTaskCenterUnchanged()
  passTask('prepared archive path is a collapsed directory draft; choosing it clears old consent without native picker, read or grant')
  await taskChange('archiveScope', 'all', archiveForm)
  await taskChange('fromDate', '2026-11-10', archiveForm); await taskChange('toDate', '2026-11-11', archiveForm)
  await taskCheck('sourceSharing', archiveForm); await taskCheck('archiveConsent', archiveForm)
  const refreshingArchive = archiveForm, refreshingGrantCount = taskActions('grantSnapshot').length
  nextTaskRead = { sessionId: TASK1, mode: 'deferred' }
  await taskClick('refresh', taskConnection(), en)
  assert.ok(deferredTaskRead)
  await showSettings(taskAside(), 'sources')
  assert.equal(refreshingArchive.isConnected, true, 'One Task/generation refresh must keep the existing editor mounted')
  assert.equal(within(refreshingArchive).getByRole('button', { name: te.grantArchive, exact: true }).disabled, true)
  assert.equal(within(refreshingArchive).getByRole('checkbox', { name: te.archiveConsent, exact: true }).checked, true)
  await act(async () => fireEvent.submit(within(refreshingArchive).getByRole('form', { name: te.grantArchive, exact: true, hidden: true })))
  assert.equal(taskActions('grantSnapshot').length, refreshingGrantCount, 'Pending refresh cannot authorize a retained draft')
  await act(async () => deferredTaskRead.resolve())
  archiveForm = await taskOpenDetails('addArchive', taskDetail())
  assert.equal(archiveForm, refreshingArchive)
  assert.ok(archiveForm.textContent.includes(taskArchiveRoot))
  assert.equal(within(archiveForm).getByLabelText(te.archiveScope).value, 'all')
  assert.equal(within(archiveForm).getByLabelText(te.fromDate).value, '2026-11-10')
  assert.equal(within(archiveForm).getByLabelText(te.toDate).value, '2026-11-11')
  assert.equal(within(archiveForm).getByRole('checkbox', { name: te.archiveConsent, exact: true }).checked, true)
  assert.equal(within(archiveForm).getByRole('checkbox', { name: te.sourceSharing, exact: true }).checked, true)
  assert.equal(within(archiveForm).getByRole('button', { name: te.grantArchive, exact: true }).disabled, false)
  await taskSelect(TASK2); await taskSelect(TASK1)
  archiveForm = await taskOpenDetails('addArchive', taskDetail())
  assert.equal(refreshingArchive.isConnected, false)
  assert.ok(archiveForm.textContent.includes(te.noDirectory))
  assert.equal(within(archiveForm).getByLabelText(te.archiveScope).value, 'selected')
  assert.equal(within(archiveForm).getByLabelText(te.fromDate).value, '')
  assert.equal(within(archiveForm).getByRole('checkbox', { name: te.archiveConsent, exact: true }).checked, false)
  assert.equal(within(archiveForm).getByRole('checkbox', { name: te.sourceSharing, exact: true }).checked, false)
  const resumedPathDraft = await taskOpenDetails('archivePathAdvanced', archiveForm)
  assert.equal(within(resumedPathDraft).getByLabelText(te.archivePreparedPath).value, '')
  await taskChange('archivePreparedPath', taskArchiveRoot, resumedPathDraft); await taskClick('archivePathApply', resumedPathDraft)
  assertTaskCenterUnchanged()
  passTask('same Task refresh keeps archive directory, range and confirmations mounted but disabled; changing the actual Task clears the draft')
  const archiveGrantCount = taskActions('grantSnapshot').length
  await taskCheck('rosterConsent', archiveForm); await taskClick('browseRoster', archiveForm)
  assert.equal(taskActions('grantSnapshot').length, archiveGrantCount)
  assert.equal(taskRecords.get(TASK1).sources.has('archive'), false)
  assert.equal(taskActions('prepareSnapshot').at(-1).request.contextSessionId, sessionId)
  assert.equal(taskActions('prepareSnapshot').at(-1).request.confirmation, 'browse-snapshot-roster')
  assert.equal(within(archiveForm).getByRole('checkbox', { name: 'Synthetic Alice', exact: true }).checked, false)
  assert.ok(within(archiveForm).getByRole('checkbox', { name: 'Synthetic Bob', exact: true }))
  const aliceChoice = await revealControl(archiveForm, 'checkbox', 'Synthetic Alice')
  await act(async () => fireEvent.click(aliceChoice))
  await taskClick('next', archiveForm)
  assert.equal(taskActions('prepareSnapshot').at(-1).request.offset, 2)
  assert.ok(within(archiveForm).getByRole('checkbox', { name: 'Synthetic Chen', exact: true }))
  await taskClick('previous', archiveForm)
  assert.equal(taskActions('prepareSnapshot').at(-1).request.offset, 0)
  await taskChange('fromDate', '2026-11-10', archiveForm); await taskChange('toDate', '2026-11-11', archiveForm)
  await taskCheck('sourceSharing', archiveForm); await taskCheck('archiveConsent', archiveForm)
  await taskChange('toDate', '2026-11-12', archiveForm)
  assert.equal(within(archiveForm).getByRole('checkbox', { name: te.archiveConsent, exact: true }).checked, false)
  await taskChange('toDate', '2026-11-11', archiveForm); await taskCheck('sourceSharing', archiveForm); await taskCheck('archiveConsent', archiveForm); await taskClick('grantArchive', archiveForm)
  const archiveRequest = taskActions('grantSnapshot').at(-1).request
  assert.deepEqual(archiveRequest.talkers, ['synthetic-person-a'])
  assert.equal(archiveRequest.fromTs, Math.floor(new Date('2026-11-10T00:00:00').getTime() / 1000))
  assert.equal(archiveRequest.toTs, Math.floor(new Date('2026-11-11T23:59:59').getTime() / 1000))
  assert.equal(archiveRequest.allowWechat, true)
  assertTaskCenterUnchanged()
  passTask('contact-only authorization shows names, pages 2+1 by actual rows, and separately confirms exact contacts and inclusive local dates')

  let queryForm = await taskOpenDetails('previewSources', taskDetail())
  await taskChange('querySource', 'workspace', queryForm); await taskChange('fileAction', 'read', queryForm); await taskChange('relativePath', 'synthetic-document.md', queryForm); await taskClick('querySources', queryForm)
  assert.equal(queryForm.querySelector('[data-task-query-result]').textContent.includes(taskPrivateText), true)
  assert.equal(queryForm.querySelector('script'), null)
  await taskChange('relativePath', '../.env', queryForm); await taskClick('querySources', queryForm)
  assert.equal(queryForm.querySelector('[data-task-query-result]'), null)
  await taskChange('querySource', 'synthetic-task-session', queryForm)
  await taskChange('queryText', ' synthetic session terms ', queryForm); await taskClick('querySources', queryForm)
  const taskSessionRows = [{ text: taskPrivateText, role: 'user' }, { text: 'Synthetic Task second row', role: 'assistant' }]
  assert.deepEqual(taskActions('querySource').at(-1).request, { kind: 'task', action: 'querySource', sessionId: TASK1, query: { action: 'session', sourceId: 'synthetic-task-session', query: 'synthetic session terms', limit: 20, offset: 0 } })
  assertRecordDisplay(queryForm.querySelector('[data-task-query-result]'), taskSessionRows)
  assert.deepEqual(Array.from(queryForm.querySelectorAll('.wi-record-title'), title => title.textContent), [te.userMessage, te.assistantMessage])
  await exercisePageDownload(taskDetail(), TASK1, canonical(taskActions('querySource').at(-1).request), { records: taskSessionRows }, 'Task authorized Session rows')
  await taskChange('querySource', 'archive', queryForm)
  assert.equal(within(queryForm).getByLabelText(en.queryAction).value, 'sessions', 'Task archive queries default to sessions')
  assert.deepEqual(Array.from(within(queryForm).getByLabelText(en.queryAction).options, option => option.value), ['status', 'contacts', 'sessions', 'messages', 'search'])
  assert.equal(within(queryForm).queryByLabelText(te.queryContact), null)
  assert.equal(within(queryForm).queryByLabelText(te.queryText), null)
  await taskClick('querySources', queryForm)
  assert.deepEqual(taskActions('querySource').at(-1).request, { kind: 'task', action: 'querySource', sessionId: TASK1, query: { action: 'archive', query: { action: 'sessions', limit: 20, offset: 0 } } })
  assertRecordDisplay(queryForm.querySelector('[data-task-query-result]'), [taskContacts[0]])
  await taskClick('indexOpenMessages', queryForm.querySelector('article.wi-record'), en)
  assert.deepEqual(taskActions('querySource').at(-1).request, { kind: 'task', action: 'querySource', sessionId: TASK1, query: { action: 'archive', query: { action: 'messages', talker: 'synthetic-person-a', limit: 20, offset: 0 } } })
  assert.equal(within(queryForm).getByLabelText(en.queryAction).value, 'messages')
  assert.equal(within(queryForm).getByLabelText(te.queryContact).value, 'synthetic-person-a')
  assert.equal(queryForm.querySelector('[data-task-query-result]').textContent.includes(taskPrivateText), true)
  assert.equal(queryForm.querySelector('script'), null)
  await taskChange('queryAction', 'search', queryForm, en)
  const beforeEmptySearch = taskCalls().length
  assert.equal(within(queryForm).getByRole('button', { name: en.runQuery, exact: true }).disabled, true)
  await taskClick('querySources', queryForm)
  assert.equal(taskCalls().length, beforeEmptySearch)
  await taskChange('queryText', ' synthetic archive terms ', queryForm); await taskClick('querySources', queryForm)
  assert.deepEqual(taskActions('querySource').at(-1).request, { kind: 'task', action: 'querySource', sessionId: TASK1, query: { action: 'archive', query: { action: 'search', talker: 'synthetic-person-a', query: 'synthetic archive terms', limit: 20, offset: 0 } } })
  const taskArchiveRows = [{ talker: 'synthetic-person-a', text: taskPrivateText, role: 'user' }, { text: 'Synthetic Task second row', role: 'assistant' }]
  assertRecordDisplay(queryForm.querySelector('[data-task-query-result]'), taskArchiveRows)
  await exercisePageDownload(taskDetail(), TASK1, canonical(taskActions('querySource').at(-1).request), { records: taskArchiveRows }, 'Task archive search page')
  await taskChange('queryAction', 'sessions', queryForm, en); await taskClick('querySources', queryForm)
  assert.deepEqual(taskActions('querySource').at(-1).request.query, { action: 'archive', query: { action: 'sessions', limit: 20, offset: 0 } }, 'Hidden contact/search fields must not leak into sessions')
  assert.equal(within(queryForm).queryByLabelText(te.queryContact), null); assert.equal(within(queryForm).queryByLabelText(te.queryText), null)
  await taskChange('queryAction', 'messages', queryForm, en); await taskChange('queryContact', 'synthetic-person-a', queryForm); await taskClick('querySources', queryForm)
  assert.equal(taskActions('querySource').at(-1).request.sessionId, TASK1)
  assertTaskCenterUnchanged()
  passTask('explicit authorized file/Session/archive previews are escaped; sessions/messages/search use exact Task/source/contact/query authority; hidden fields are omitted and no preview submits native model input')

  const mixedTaskSources = canonical([...taskRecords.get(TASK1).sources])
  const mixedPrompts = prompts.length
  const addOrdinarySource = async () => {
    await taskClick('clearTask')
    await change(en.root, grantRoot); await change(en.talkers, 'controlled-talker'); await check(en.grantConsent); await click(en.grant)
    assert.equal(findAction('grantSnapshot').at(-1).request.kind, undefined)
    assert.equal(findAction('grantSnapshot').at(-1).request.sessionId, sessionId)
    assert.equal(findAction('grantSnapshot').at(-1).request.allowWechat, false)
    await taskSelect(TASK1)
  }
  await addOrdinarySource()
  queryForm = await taskOpenDetails('previewSources', taskDetail())
  await taskChange('querySource', 'workspace', queryForm); await taskChange('fileAction', 'read', queryForm)
  await taskChange('relativePath', 'synthetic-document.md', queryForm); await taskClick('querySources', queryForm)
  const mixedTaskResult = queryForm.querySelector('[data-task-query-result]')
  assert.ok(mixedTaskResult); assert.equal(mixedTaskResult.textContent.includes(taskPrivateText), true)
  const mixedTaskQuery = canonical(taskActions('queryFiles').at(-1).request)
  await click(en.revoke)
  await showIndexView(data(), 'records')
  assert.equal(queryForm.querySelector('[data-task-query-result]'), mixedTaskResult, 'An ordinary revoke must not clear an explicitly selected Task result')
  assert.deepEqual(canonical(taskActions('queryFiles').at(-1).request), mixedTaskQuery)
  assert.deepEqual(canonical([...taskRecords.get(TASK1).sources]), mixedTaskSources)
  assertTaskCenterUnchanged()
  passTask('mixed-source ordinary revoke preserves the selected Task page, exact SID/source/path and every Task grant')

  await addOrdinarySource()
  queryForm = await taskOpenDetails('previewSources', taskDetail())
  await change(te.querySource, 'data:' + sessionId)
  await change(en.queryAction, 'sessions'); await click(en.runQuery)
  const mixedDataResult = queryForm.querySelector('.wi-view')
  const mixedDataRows = recordValues(queryForm)
  assert.ok(mixedDataRows.length)
  assert.equal(findAction('queryArchive').at(-1).request.sessionId, sessionId)
  await taskClick('denySharing', taskDetail())
  await showIndexView(data(), 'records')
  assert.equal(queryForm.querySelector('.wi-view'), mixedDataResult, 'A Task sharing action must not clear an explicitly selected ordinary page')
  assert.deepEqual(recordValues(queryForm), mixedDataRows)
  assert.equal(taskActions('setSharing').at(-1).request.sessionId, TASK1)
  assert.equal(taskRecords.get(TASK1).allowWechat, false)
  assert.equal(states.get(sessionId).archive.allowWechat, false)
  assert.deepEqual(canonical([...taskRecords.get(TASK1).sources]), mixedTaskSources)
  await click(en.revoke)
  assert.equal(prompts.length, mixedPrompts)
  assertTaskCenterUnchanged()
  passTask('mixed-source Task sharing revocation preserves the ordinary page and never transfers grants, enables sharing or submits model input')

  const blockedShareRecord = taskRecord(TASK1), blockedShareKey = 'synthetic-missing-source:old'
  const blockedShareModelCalls = prompts.length, blockedShareStarts = taskActions('startChannel').length
  const blockedShareTextCalls = taskActions('pollTextOnce').length + taskActions('resumeTextOnce').length
  for (const language of ['en', 'zh']) {
    await act(async () => locale.setLocale(language))
    const dictionary = client.__taskI18n[language], connectionDictionary = client.__conversationI18n[language]
    blockedShareRecord.consumed.set(blockedShareKey, { sourceId: 'synthetic-missing-source', generation: -1 })
    await taskClick('refresh', taskConnection(), connectionDictionary)
    assert.equal(taskState(TASK1).task.contextBlocked, true)
    assert.equal(taskState(TASK1).task.shareable, false)
    await showSettings(taskAside(), 'connection')
    const consent = within(taskDetail()).getByRole('checkbox', { name: dictionary.wholeContextConsent, exact: true })
    assert.equal(consent.checked, false); assert.equal(consent.disabled, false)
    const beforeShare = taskActions('setSharing').length
    await taskClick('allowSharing', taskDetail(), dictionary)
    assert.equal(taskActions('setSharing').length, beforeShare, 'A blocked context does not replace explicit sharing consent')
    await taskCheck('wholeContextConsent', taskDetail(), dictionary)
    assert.equal(within(taskDetail()).getByRole('button', { name: dictionary.allowSharing, exact: true }).disabled, false)
    await taskClick('allowSharing', taskDetail(), dictionary)
    assert.equal(taskActions('setSharing').length, beforeShare + 1)
    assert.deepEqual(taskActions('setSharing').at(-1).request, { kind: 'task', action: 'setSharing', sessionId: TASK1, allowWechat: true, confirmation: 'share-whole-task-context' })
    assert.equal(taskState(TASK1).task.contextBlocked, true)
    assert.equal(taskState(TASK1).task.shareable, false, 'The server state remains authoritative when a current source is missing')
    assert.equal(taskDetail().querySelector('[data-task-sharing-settings] [role="status"]').textContent, dictionary.sharingDenied)
    assert.equal(rawControl(taskConnection(), 'button', connectionDictionary.start, true).disabled, true)
    assert.equal(within(taskDetail()).getByRole('checkbox', { name: dictionary.wholeContextConsent, exact: true }).checked, false)
    await taskClick('denySharing', taskDetail(), dictionary)
    blockedShareRecord.consumed.delete(blockedShareKey)
    await taskClick('refresh', taskConnection(), connectionDictionary)
  }
  await act(async () => locale.setLocale('en'))
  assert.equal(prompts.length, blockedShareModelCalls); assert.equal(taskActions('startChannel').length, blockedShareStarts)
  assert.equal(taskActions('pollTextOnce').length + taskActions('resumeTextOnce').length, blockedShareTextCalls)
  assertTaskCenterUnchanged()
  passTask('blocked context keeps explicit whole-task sharing reachable in both locales; missing-source server refusal keeps messaging disabled and never reports sharing success')

  await taskCheck('wholeContextConsent', taskDetail()); await taskClick('allowSharing', taskDetail())
  assert.equal(taskRecords.get(TASK1).allowWechat, true)
  assert.equal(taskActions('startChannel').length, 0)
  const taskPairingDetails = taskConnection().querySelector('[data-channel-pairing]'), taskAutomaticDetails = taskConnection().querySelector('[data-channel-automatic]')
  assert.equal(taskPairingDetails.tagName, 'DETAILS'); assert.equal(taskAutomaticDetails.tagName, 'DETAILS')
  assert.equal(taskPairingDetails.open, true)
  assert.equal(taskAutomaticDetails.open, false, 'Continuous replies remain a closed, explicit settings detail')
  const beforeTaskDetailToggle = navigationActivity()
  await openDetails(taskAutomaticDetails)
  await act(async () => fireEvent.click(taskAutomaticDetails.querySelector(':scope > summary')))
  assert.equal(taskAutomaticDetails.open, false)
  assertNavigationQuiet(beforeTaskDetailToggle)
  const beforeColdPairing = { ...taskRecords.get(TASK1).channel }
  const beforePairingLoginCalls = taskActions('beginLogin').length
  for (const language of ['en', 'zh']) {
    await act(async () => locale.setLocale(language))
    const dictionary = client.__conversationI18n[language]
    taskRecords.get(TASK1).channel = { ...beforeColdPairing, enabled: false, phase: 'unpaired', hasStoredLogin: false }
    await taskClick('refresh', taskConnection(), dictionary)
    assert.equal(taskConnection().textContent.includes(dictionary.phaseStoredUnchecked), true)
    await taskCheck('textOnceConsent', taskConnection(), dictionary)
    assert.equal(within(taskConnection()).getByRole('button', { name: dictionary.textOnce, exact: true }).disabled, false)
    assert.equal(rawControl(taskConnection(), 'button', dictionary.start, true).disabled, true)
    nextTextOnce = { mode: 'missing-pairing' }
    await taskClick('textOnce', taskConnection(), dictionary)
    assert.equal(taskConnection().textContent.includes(dictionary.PAIRING_REQUIRED), true)
    assert.equal(taskConnection().textContent.includes(dictionary.phaseStoredUnchecked), false)
    await taskCheck('textOnceConsent', taskConnection(), dictionary)
    assert.equal(within(taskConnection()).getByRole('button', { name: dictionary.textOnce, exact: true }).disabled, true)
    await taskCheck('textOnceConsent', taskConnection(), dictionary)
    assert.equal(taskActions('beginLogin').length, beforePairingLoginCalls)
    assertTaskCenterUnchanged()
  }
  taskRecords.get(TASK1).channel = beforeColdPairing
  await act(async () => locale.setLocale('en')); await taskClick('refresh', taskConnection(), en)
  passTask('cold pairing is unknown, not lost; one-text consent permits local preflight, absent pairing reconciles to a blocked state without login or continuous start')
  await taskCheck('loginConsent', taskConnection(), en); await taskClick('beginLogin', taskConnection(), en)
  assert.ok(within(taskConnection()).getByRole('img', { name: en.qrLabel, exact: true }))
  await taskClick('pollLogin', taskConnection(), en); await taskCheck('ownerConsent', taskConnection(), en); await taskClick('confirmPairing', taskConnection(), en)
  const diagnosticPanel = () => taskConnection()?.querySelector('[data-wechat-updates-diagnostic]')
  const diagnosticResult = () => diagnosticPanel()?.querySelector('[data-wechat-updates-diagnostic-result]')
  const openDiagnostic = async () => {
    await showSettings(taskAside(), 'connection'); const panel = diagnosticPanel(); assert.ok(panel); return openDetails(panel)
  }
  const stateBeforeDiagnostic = canonical(taskState(TASK1))
  taskRecord(TASK1).allowWechat = false; await taskClick('refresh', taskConnection(), en)
  const unsharedDiagnosticState = canonical(taskState(TASK1)), beforeDiagnosticNavigation = navigationActivity()
  assert.equal(diagnosticPanel().open, false, 'Update diagnostics are collapsed by default')
  assert.equal(taskActions('diagnoseUpdatesOnce').length, 0)
  let dp = await openDiagnostic()
  assert.equal(within(dp).getByRole('checkbox', { name: te.updatesDiagnosticConsent, exact: true }).checked, false)
  assert.equal(within(dp).getByRole('button', { name: te.updatesDiagnosticAction, exact: true }).disabled, true)
  await taskClick('updatesDiagnosticAction', dp)
  assert.equal(taskActions('diagnoseUpdatesOnce').length, 0)
  assertNavigationQuiet(beforeDiagnosticNavigation)
  for (const language of ['en', 'zh']) {
    await act(async () => locale.setLocale(language)); const dictionary = client.__taskI18n[language]; dp = await openDiagnostic()
    const before = taskActions('diagnoseUpdatesOnce').length
    await taskCheck('updatesDiagnosticConsent', dp, dictionary)
    assert.equal(within(dp).getByRole('button', { name: dictionary.updatesDiagnosticAction, exact: true }).disabled, false, 'Sharing is not a diagnostic prerequisite')
    await taskClick('updatesDiagnosticAction', dp, dictionary)
    assert.equal(taskActions('diagnoseUpdatesOnce').length, before + 1)
    assert.deepEqual(taskActions('diagnoseUpdatesOnce').at(-1).request, { kind: 'task', sessionId: TASK1, action: 'diagnoseUpdatesOnce', confirmation: 'read-one-wechat-update-diagnostic' })
    assert.ok(diagnosticResult().textContent.includes(dictionary.updatesDiagnosticValid))
    assert.ok(diagnosticResult().textContent.includes(dictionary.updatesDiagnosticArray)); assert.ok(diagnosticResult().textContent.includes(dictionary.updatesDiagnosticString))
    assert.equal(within(dp).getByRole('checkbox', { name: dictionary.updatesDiagnosticConsent, exact: true }).checked, false)
    assert.equal(within(dp).getByRole('button', { name: dictionary.updatesDiagnosticAction, exact: true }).disabled, true)
    assert.deepEqual(canonical(taskState(TASK1)), unsharedDiagnosticState); assertTaskCenterUnchanged()
  }
  passTask('updates diagnostic: default collapsed and unchecked, navigation and disabled clicks are action-free, and one explicit click uses the exact Task and confirmation in both locales without sharing')
  const invalidDiagnostic = { version: 1, outcome: 'invalid', errorCode: 'invalid-response', validationField: 'msgs',
    msgsShape: 'other', cursorShape: 'omitted', messageCount: null, textCount: null, ignoredCount: null, httpStatus: 200, businessCode: 0 }
  const failedDiagnostic = { version: 1, outcome: 'failed', errorCode: 'network-error', validationField: null,
    msgsShape: null, cursorShape: null, messageCount: null, textCount: null, ignoredCount: null, httpStatus: null, businessCode: null }
  for (const language of ['en', 'zh']) {
    await act(async () => locale.setLocale(language)); const dictionary = client.__taskI18n[language]
    for (const diagnostic of [invalidDiagnostic, failedDiagnostic]) {
      nextUpdatesDiagnostic = { result: { diagnostic } }; dp = await openDiagnostic()
      await taskCheck('updatesDiagnosticConsent', dp, dictionary); await taskClick('updatesDiagnosticAction', dp, dictionary)
      assert.ok(diagnosticResult().textContent.includes(dictionary[diagnostic.outcome === 'invalid' ? 'updatesDiagnosticInvalid' : 'updatesDiagnosticFailed']))
      assert.ok(diagnosticResult().textContent.includes(diagnostic.errorCode)); assert.ok(diagnosticResult().textContent.includes(dictionary.updatesDiagnosticUnobserved))
      assert.equal(within(dp).getByRole('checkbox', { name: dictionary.updatesDiagnosticConsent, exact: true }).checked, false)
      assert.deepEqual(canonical(taskState(TASK1)), unsharedDiagnosticState); assertTaskCenterUnchanged()
    }
  }
  passTask('updates diagnostic: valid, invalid and failed closed outcomes render localized shapes and observed counts; null observations stay distinct from zero')
  await act(async () => locale.setLocale('en'))
  for (const result of [{ diagnostic: { ...validUpdatesDiagnostic, botToken: 'SYNTHETIC_DIAGNOSTIC_SECRET' } },
    { diagnostic: validUpdatesDiagnostic, raw: 'SYNTHETIC_DIAGNOSTIC_SECRET' }, { raw: 'SYNTHETIC_DIAGNOSTIC_SECRET' },
    { diagnostic: { ...validUpdatesDiagnostic, cursorShape: 'SYNTHETIC_DIAGNOSTIC_SECRET' } },
    { diagnostic: { ...validUpdatesDiagnostic, textCount: 4 } }, { diagnostic: null }]) {
    nextUpdatesDiagnostic = { mode: 'raw', result }; dp = await openDiagnostic()
    await taskCheck('updatesDiagnosticConsent', dp); await taskClick('updatesDiagnosticAction', dp)
    assert.equal(diagnosticResult(), null); assert.ok(taskConnection().textContent.includes(en.UNAVAILABLE))
    assert.equal(taskAside().textContent.includes('SYNTHETIC_DIAGNOSTIC_SECRET'), false)
    assert.equal(within(dp).getByRole('checkbox', { name: te.updatesDiagnosticConsent, exact: true }).checked, false)
    assert.deepEqual(canonical(taskState(TASK1)), unsharedDiagnosticState); assertTaskCenterUnchanged()
  }
  passTask('updates diagnostic: malformed and secret-bearing response projections are rejected with a fixed localized error and no result or automatic retry')
  nextUpdatesDiagnostic = { mode: 'deferred' }; dp = await openDiagnostic()
  await taskCheck('updatesDiagnosticConsent', dp); await taskClick('updatesDiagnosticAction', dp)
  const cancelledDiagnostic = deferredUpdatesDiagnostic, diagnosticRequestsBeforeCancel = taskActions('diagnoseUpdatesOnce').length
  assert.ok(cancelledDiagnostic); assert.equal(cancelledDiagnostic.signal.aborted, false)
  assert.equal(within(dp).getByRole('checkbox', { name: te.updatesDiagnosticConsent, exact: true }).checked, false)
  assert.equal(within(dp).getByRole('button', { name: te.updatesDiagnosticAction, exact: true }).disabled, true)
  assert.ok(dp.textContent.includes(te.updatesDiagnosticPending)); assert.equal(diagnosticResult(), null)
  await taskClick('cancel', taskConnection(), en); assert.equal(cancelledDiagnostic.signal.aborted, true)
  await taskSelect(TASK2); await taskSelect(TASK1); await act(async () => cancelledDiagnostic.resolve())
  assert.equal(diagnosticPanel().open, false); dp = await openDiagnostic()
  assert.equal(diagnosticResult(), null); assert.equal(taskActions('diagnoseUpdatesOnce').length, diagnosticRequestsBeforeCancel)
  assert.equal(within(dp).getByRole('checkbox', { name: te.updatesDiagnosticConsent, exact: true }).checked, false)
  await taskCheck('updatesDiagnosticConsent', dp); await taskClick('updatesDiagnosticAction', dp)
  assert.ok(diagnosticResult()); await taskCheck('updatesDiagnosticConsent', dp)
  await taskSelect(TASK2); await taskSelect(TASK1)
  assert.equal(diagnosticPanel().open, false); dp = await openDiagnostic()
  assert.equal(diagnosticResult(), null); assert.equal(within(dp).getByRole('checkbox', { name: te.updatesDiagnosticConsent, exact: true }).checked, false)
  taskRecord(TASK1).allowWechat = stateBeforeDiagnostic.task.allowWechat; await taskClick('refresh', taskConnection(), en)
  assert.deepEqual(canonical(taskState(TASK1)), stateBeforeDiagnostic); assertTaskCenterUnchanged()
  passTask('updates diagnostic: consent clears immediately on submission, busy controls reject another read, and cancellation plus Task switches discard late results and old consent')
  const textOnceBlock = () => taskConnection().querySelector('[data-wechat-text-once]')
  const assertTextOnceClosed = () => {
    assert.equal(taskState(TASK1).channel.messagingEnabled, false)
    assert.equal(taskState(TASK1).channel.automaticPolling, false)
    assert.equal(within(textOnceBlock()).getByRole('checkbox', { name: en.textOnceConsent, exact: true }).checked, false)
    assert.equal(within(textOnceBlock()).getByRole('button', { name: en.textOnce, exact: true }).disabled, true)
    assertTaskCenterUnchanged()
  }
  assert.equal(within(textOnceBlock()).getByRole('button', { name: en.textOnce, exact: true }).disabled, true)
  const beforeTextOnce = taskActions('pollTextOnce').length, beforeContinuousStart = taskActions('startChannel').length
  for (const language of ['en', 'zh']) {
    await act(async () => locale.setLocale(language))
    const dictionary = client.__conversationI18n[language]
    await taskCheck('textOnceConsent', textOnceBlock(), dictionary)
    assert.equal(rawControl(taskConnection(), 'checkbox', dictionary.startConsent, true).checked, false)
    await taskClick('textOnce', textOnceBlock(), dictionary)
    assert.equal(textOnceBlock().textContent.includes(dictionary.textOnceAccepted), true)
    assert.equal(textOnceBlock().textContent.includes(dictionary.textOnceRemaining.replace('{remaining}', '2')), true)
    assert.equal(within(textOnceBlock()).getByRole('checkbox', { name: dictionary.textOnceConsent, exact: true }).checked, false)
    assert.equal(within(textOnceBlock()).getByRole('button', { name: dictionary.textOnce, exact: true }).disabled, true)
    assert.equal(taskState(TASK1).channel.automaticPolling, false)
    assertTaskCenterUnchanged()
  }
  await act(async () => locale.setLocale('en'))
  assert.equal(taskActions('pollTextOnce').length, beforeTextOnce + 2)
  assert.equal(taskActions('startChannel').length, beforeContinuousStart)
  assert.deepEqual(taskActions('pollTextOnce').at(-1).request, { kind: 'task', action: 'pollTextOnce', sessionId: TASK1, allowSharedContext: true, confirmation: 'poll-one-text-reply' })
  assertTextOnceClosed()
  passTask('one-text consent is separate, consumed once, localized, Task/SID-bound, and reports acceptance plus retained queue without starting polling')

  nextTextOnce = { counts: { received: 0, replied: 0, ignored: 0, duplicates: 0, remaining: 0 } }
  await taskCheck('textOnceConsent', textOnceBlock(), en); await taskClick('textOnce', textOnceBlock(), en)
  assert.equal(textOnceBlock().textContent.includes(en.textOnceEmpty), true)
  assert.equal(textOnceBlock().textContent.includes(en.textOnceAccepted), false)
  assertTextOnceClosed()
  nextTextOnce = { mode: 'failed' }
  await taskCheck('textOnceConsent', textOnceBlock(), en); await taskClick('textOnce', textOnceBlock(), en)
  assert.equal(taskConnection().textContent.includes(en.ACTION_FAILED), true)
  assert.equal(textOnceBlock().textContent.includes(en.textOnceAccepted), false)
  assertTextOnceClosed()
  passTask('empty and failed single-text actions stop without a success claim, reused consent, or a continuous start')

  nextTextOnce = { mode: 'deferred' }
  await taskCheck('textOnceConsent', textOnceBlock(), en); await taskClick('textOnce', textOnceBlock(), en)
  const pendingTextOnce = deferredTextOnce, pendingTextCalls = taskActions('pollTextOnce').length
  assert.ok(pendingTextOnce)
  assert.equal(textOnceBlock().textContent.includes(en.phaseTextOnce), true)
  await taskClick('textOnce', textOnceBlock(), en)
  assert.equal(taskActions('pollTextOnce').length, pendingTextCalls)
  await taskClick('cancel', taskConnection(), en)
  assert.equal(pendingTextOnce.signal.aborted, true)
  await act(async () => pendingTextOnce.resolve())
  assert.equal(textOnceBlock().textContent.includes(en.textOnceAccepted), false)
  assert.equal(taskConnection().textContent.includes(en.CANCELLED), true)
  assertTextOnceClosed()
  assert.equal(taskActions('startChannel').length, beforeContinuousStart)
  passTask('one-text busy state blocks a second call; cancellation aborts the Owner request and ignores its late response without retrying')

  nextTextOnce = { mode: 'deferred' }
  await taskCheck('textOnceConsent', textOnceBlock(), en); await taskClick('textOnce', textOnceBlock(), en)
  const emergencyTextOnce = deferredTextOnce, beforeEmergencyStop = taskCalls().length
  assert.notEqual(emergencyTextOnce, pendingTextOnce, 'The emergency case must start a fresh explicit one-text request')
  assert.equal(emergencyTextOnce.signal.aborted, false)
  assert.equal(taskCalls().at(-1).request.action, 'pollTextOnce')
  await showIndexView(taskAside(), 'overview')
  assertDefaultOverview(taskDetail())
  assert.ok(Array.from(taskConnection().querySelectorAll('button')).some(button => button.textContent === en.stop && visible(button)),
    'Client defect: Overview must expose an emergency Stop while pollTextOnce is pending, even before cached paired channel flags change')
  const compactTaskStop = await revealControl(taskConnection(), 'button', en.stop)
  assert.equal(compactTaskStop.disabled, false, 'A pending one-text action must retain an emergency Stop outside hidden Settings')
  await act(async () => fireEvent.click(compactTaskStop))
  assert.equal(emergencyTextOnce.signal.aborted, true)
  assert.equal(taskCalls().length, beforeEmergencyStop + 1)
  assert.equal(taskActions('stopChannel').at(-1).request.sessionId, TASK1)
  await showSettings(taskAside(), 'connection')
  const emergencyRecovery = taskConnection().querySelector('[data-channel-recovery]')
  assert.equal(emergencyRecovery.tagName, 'DETAILS'); assert.equal(emergencyRecovery.open, false)
  assert.equal(taskConnection().textContent.includes(en.phaseRecovery), true, 'The explicit emergency Stop must establish the authoritative recovery state')
  const beforeEmergencyLateReads = getCount(TASK1)
  await act(async () => emergencyTextOnce.resolve())
  console.log('OBSERVE emergency-stop late one-text ' + JSON.stringify({ signalAborted: emergencyTextOnce.signal.aborted, readsBefore: beforeEmergencyLateReads, readsAfter: getCount(TASK1), recoveryPhaseRetained: taskConnection().textContent.includes(en.phaseRecovery), acceptedVisible: textOnceBlock().textContent.includes(en.textOnceAccepted) }))
  assert.equal(getCount(TASK1), beforeEmergencyLateReads, 'A superseded one-text completion must not issue a reconciliation GET after the explicit emergency Stop')
  assert.equal(textOnceBlock().textContent.includes(en.textOnceAccepted), false)
  assert.equal(taskConnection().textContent.includes(en.phaseRecovery), true, 'Late one-text success must not replace the authoritative emergency-stop state')
  assert.equal(taskActions('startChannel').length, beforeContinuousStart)
  await taskCheck('discardConsent', taskConnection(), en); await taskClick('discard', taskConnection(), en)
  assertTextOnceClosed()
  passTask('compact emergency Stop remains enabled while one-text is pending; it aborts the old request, ignores late success, and requires explicit closed-detail recovery without polling restart')

  await taskCheck('startConsent', taskConnection(), en); await taskClick('start', taskConnection(), en)
  assert.equal(taskState(TASK1).channel.automaticPolling, true)
  await taskClick('stop', taskConnection(), en)
  await taskCheck('discardConsent', taskConnection(), en); await taskClick('discard', taskConnection(), en)
  const forgetDetails = Array.from(taskConnection().querySelectorAll('details')).find(details => details.querySelector(':scope > summary')?.textContent === en.forgetTitle)
  assert.ok(forgetDetails); await openDetails(forgetDetails)
  await taskCheck('forgetConsent', taskConnection(), en); await taskClick('forget', taskConnection(), en)
  for (const action of ['beginLogin', 'pollLogin', 'confirmPairing', 'startChannel', 'stopChannel', 'discardPending', 'forgetPairing']) assert.equal(taskActions(action).at(-1).request.sessionId, TASK1)
  assertTaskCenterUnchanged()
  passTask('whole-context sharing is separate from starting; seven explicit connection actions use the exact Task kind/SID and no second loop')

  const channelBeforeExpiryCases = { ...taskRecords.get(TASK1).channel }
  for (const language of ['en', 'zh']) {
    await act(async () => locale.setLocale(language))
    await exerciseExpiredLogin(taskConnection, TASK1, () => taskCalls().filter(call => call.endpoint.endsWith('/conversationAction')), client.__conversationI18n[language])
    assert.equal(taskState(TASK1).channel.automaticPolling, false)
    assert.equal(taskState(TASK1).channel.hasStoredLogin, false)
    assertTaskCenterUnchanged()
    loginExpiryCases.push({ surface: 'task', language })
  }
  await act(async () => locale.setLocale('en'))
  // Restore the synthetic carrier before the independent request-failure cases.
  taskRecords.get(TASK1).channel = channelBeforeExpiryCases
  await taskClick('refresh', taskConnection(), en)
  passTask('expired QR removes old controls in both locales without pairing, polling, automatic replacement or a center switch')

  const apiErrorCases = hostWire.CONVERSATION_ERROR_CODES.filter(code => code.startsWith('WECHAT_')).map(code => ['en', code])
  apiErrorCases.push(['zh', 'WECHAT_RESPONSE_TYPE_INVALID'])
  for (const [language, code] of apiErrorCases) {
    await act(async () => locale.setLocale(language))
    const dictionary = client.__conversationI18n[language]
    const consent = within(taskConnection()).getByRole('checkbox', { name: dictionary.loginConsent, exact: true })
    if (!consent.checked) await taskCheck('loginConsent', taskConnection(), dictionary)
    const before = taskActions('beginLogin').length
    taskLoginFailure = code
    await taskClick('beginLogin', taskConnection(), dictionary)
    assert.equal(taskDetail().textContent.includes(dictionary[code]), true, code)
    assert.equal(within(taskConnection()).queryByRole('img', { name: dictionary.qrLabel, exact: true }), null)
    assert.equal(taskActions('beginLogin').length, before + 1)
    assert.equal(taskRecords.get(TASK1).channel.phase, 'unpaired')
    assert.equal(taskRecords.get(TASK1).channel.automaticPolling, false)
    assertTaskCenterUnchanged()
  }
  await act(async () => locale.setLocale('en'))
  passTask('closed API errors render localized Task failures without QR display, automatic retry, pairing or a center switch')

  const beforeDeliveryProjection = taskCalls().length, priorTaskChannel = { ...taskRecords.get(TASK1).channel }
  taskRecords.get(TASK1).channel.delivery = { accepted: 1, total: 3, phase: 'sending' }
  await taskClick('refresh', taskConnection(), en)
  assert.equal(taskConnection().textContent.includes(te.deliveryProgress.replace('{accepted}', '1').replace('{total}', '3')), true)
  assert.equal(taskConnection().textContent.includes(te.deliveryUncertain), true)
  assert.equal(te.wholeContextConsent.includes('WeChat CDN'), true)
  assert.equal(taskCalls().length, beforeDeliveryProjection)
  assertTaskCenterUnchanged()
  taskRecords.get(TASK1).channel = priorTaskChannel
  await taskClick('refresh', taskConnection(), en)
  assert.equal(taskConnection().textContent.includes(te.deliveryUncertain), false)
  passTask('pending media progress reflects only server acceptance and uncertainty, never phone receipt or an automatic retry')

  const beforeTaskResume = taskCalls().length
  await taskSelect(TASK2)
  assert.equal(taskCalls().length, beforeTaskResume)
  assert.equal(taskDetail().getAttribute('data-task-session-id'), TASK2)
  assert.ok(within(taskConnection()).getByRole('button', { name: te.resumeTask, exact: true }))
  await taskClick('resumeTask', taskConnection())
  assert.deepEqual(taskActions('resumeConversation').at(-1).request, { kind: 'task', action: 'resumeConversation', sessionId: TASK2, confirmation: 'resume-task-conversation' })
  assert.equal(taskRecords.get(TASK2).sources.size, 0); assert.equal(taskRecords.get(TASK2).allowWechat, false)
  assertTaskCenterUnchanged()
  passTask('select and GET do not resume; explicit preparation restores the same Task SID without source/share/channel grants')

  let workspaceForm = await taskOpenDetails('workspaceAccess', taskDetail())
  await taskCheck('sourceSharing', workspaceForm); await taskCheck('workspaceConsent', workspaceForm); await taskClick('grantWorkspace', workspaceForm)
  extraForm = await taskOpenDetails('addDirectory', taskDetail()); await taskClick('pickDirectory', extraForm)
  await taskCheck('sourceSharing', extraForm); await taskCheck('directoryConsent', extraForm)
  nextTaskMutation = { action: 'grantDirectory', sessionId: TASK2, mode: 'committed-response-lost' }
  await taskClick('grantDirectory', extraForm)
  assert.equal(taskDetail().textContent.includes(en.grantUncertain), true)
  await taskClick('refresh', taskConnection(), en)
  assert.equal(taskDetail().textContent.includes(en.grantUncertain), true)
  workspaceForm = await taskOpenDetails('workspaceAccess', taskDetail())
  await taskCheck('sourceSharing', workspaceForm); await taskCheck('workspaceConsent', workspaceForm); await taskClick('grantWorkspace', workspaceForm)
  assert.equal(taskDetail().textContent.includes(en.grantUncertain), true, 'An unrelated workspace grant cannot resolve a lost new-directory grant')
  assert.equal(rawControl(taskDetail(), 'button', te.allowSharing, true).disabled, true)
  await taskClick('revokeAll', taskDetail())
  assert.equal(taskDetail().textContent.includes(en.grantUncertain), false)
  assert.equal(taskRecords.get(TASK2).sources.size, 0); assert.equal(taskRecords.get(TASK2).allowWechat, false)
  assertTaskCenterUnchanged()
  passTask('lost new-directory receipt stays uncertain across GET and unrelated grant; explicit revoke-all alone settles all source outcomes')

  workspaceForm = await taskOpenDetails('workspaceAccess', taskDetail())
  await taskCheck('sourceSharing', workspaceForm); await taskCheck('workspaceConsent', workspaceForm); await taskClick('grantWorkspace', workspaceForm)
  await taskCheck('wholeContextConsent', taskDetail())
  nextTaskMutation = { action: 'setSharing', sessionId: TASK2, mode: 'committed-response-lost' }
  await taskClick('allowSharing', taskDetail())
  assert.equal(taskRecords.get(TASK2).allowWechat, true)
  await taskClick('refresh', taskConnection(), en)
  assert.equal(taskDetail().textContent.includes(en.grantUncertain), true)
  await taskClick('denySharing', taskDetail())
  assert.equal(taskDetail().textContent.includes(en.grantUncertain), false); assert.equal(taskRecords.get(TASK2).allowWechat, false)
  assertTaskCenterUnchanged()
  passTask('a committed sharing response loss is not success after GET; explicit sharing revocation settles only that sharing outcome')

  await taskSelect(TASK1)
  queryForm = await taskOpenDetails('previewSources', taskDetail())
  await taskChange('querySource', 'workspace', queryForm); await taskChange('fileAction', 'read', queryForm); await taskChange('relativePath', 'synthetic-document.md', queryForm)
  nextTaskQuery = { mode: 'deferred' }; await taskClick('querySources', queryForm)
  const lateTaskQuery = deferredTaskQuery
  await taskSelect(TASK2); await taskSelect(TASK1)
  assert.equal(lateTaskQuery.signal.aborted, true)
  await act(async () => lateTaskQuery.resolve())
  assert.equal(taskAside().querySelector('[data-task-query-result]'), null)
  assert.equal(taskAside().textContent.includes(taskPrivateText), false)
  extraForm = await taskOpenDetails('addDirectory', taskDetail())
  nextTaskPicker = taskExtraRoot; await taskClick('pickDirectory', extraForm)
  const lateTaskPicker = deferredTaskPicker, beforeLatePickerGrant = taskActions('grantDirectory').length
  await taskSelect(TASK2); await taskSelect(TASK1); await act(async () => lateTaskPicker.resolve())
  extraForm = await taskOpenDetails('addDirectory', taskDetail())
  assert.equal(extraForm.textContent.includes(taskExtraRoot), false)
  assert.equal(within(extraForm).getByRole('checkbox', { name: te.directoryConsent, exact: true }).checked, false)
  assert.equal(taskActions('grantDirectory').length, beforeLatePickerGrant)
  assertTaskCenterUnchanged()
  passTask('A→B→A drops old read and directory-picker results without source grant, consent restoration, or center navigation')

  nextTaskRead = { sessionId: TASK1, mode: 'wrong-sid' }; await taskClick('refresh', taskConnection(), en)
  assert.equal(within(taskConnection()).queryByRole('button', { name: en.openNative, exact: true }), null)
  nextTaskRead = { sessionId: TASK1, mode: 'wrong-role' }; await taskClick('refresh', taskConnection(), en)
  assert.equal(within(taskConnection()).queryByRole('button', { name: en.openNative, exact: true }), null, 'An ordinary-role state carrier cannot authorize Task navigation')
  nextTaskRead = { sessionId: TASK1, mode: 'malformed' }; await taskClick('refresh', taskConnection(), en)
  assert.equal(within(taskConnection()).queryByRole('button', { name: en.openNative, exact: true }), null)
  await taskClick('refresh', taskConnection(), en)
  nextTaskRead = { sessionId: TASK1, mode: 'deferred' }; await taskClick('openNative', taskConnection(), en)
  const lateTaskNavigation = deferredTaskRead, beforeLateTaskSelection = selected.length
  await taskSelect(TASK2); await taskSelect(TASK1)
  assert.equal(lateTaskNavigation.signal.aborted, true); await act(async () => lateTaskNavigation.resolve())
  assert.equal(selected.length, beforeLateTaskSelection)
  assertTaskCenterUnchanged()
  passTask('malformed/wrong-SID/wrong-role state hides native open and an old-occurrence navigation check cannot navigate A after A→B→A')

  const pendingTaskQueryForm = await taskOpenDetails('previewSources', taskDetail())
  await taskChange('querySource', 'workspace', pendingTaskQueryForm); await taskChange('fileAction', 'read', pendingTaskQueryForm); await taskChange('relativePath', 'synthetic-document.md', pendingTaskQueryForm)
  nextTaskQuery = { mode: 'deferred' }; await taskClick('querySources', pendingTaskQueryForm)
  const revokedTaskQuery = deferredTaskQuery
  await taskClick('revokeAll', taskDetail())
  assert.equal(revokedTaskQuery.signal.aborted, true); await act(async () => revokedTaskQuery.resolve())
  assert.equal(taskRecords.get(TASK1).sources.size, 0); assert.equal(taskState(TASK1).channel.automaticPolling, false)
  assert.equal(taskAside().querySelector('[data-task-query-result]'), null)
  assertTaskCenterUnchanged()
  passTask('revoke-all supersedes a pending source read, aborts its signal, drains authorization and withholds the late result')

  const lateCreateForm = await taskOpenDetails('newTask')
  await taskChange('existingWorkspace', taskWorkspace.id, lateCreateForm); await taskCheck('workspaceConsent', lateCreateForm)
  nextTaskCreateId = TASK3; nextTaskMutation = { action: 'createConversation', sessionId, mode: 'deferred', committed: false }
  await taskClick('createTask', lateCreateForm)
  const lateTaskCreate = deferredTaskMutation
  assert.equal(taskActions('createConversation').at(-1).request.contextSessionId, sessionId)
  await act(async () => workspace.openSession(otherId))
  assert.equal(current.getSnapshot().key, otherId)
  await act(async () => workspace.openSession(sessionId))
  assert.equal(lateTaskCreate.signal.aborted, true)
  await act(async () => { lateTaskCreate.commit(); lateTaskCreate.resolve() })
  assert.equal(taskDetail(), null, 'A late creation receipt cannot choose a target in a new origin occurrence')
  assert.equal(knownTaskIds.has(TASK3), true)
  assertTaskCenterUnchanged()
  passTask('late Task creation can be durable but cannot select or navigate the new A→B→A origin occurrence')

  await taskSelect(TASK2)
  extraForm = await taskOpenDetails('addDirectory', taskDetail()); await taskClick('pickDirectory', extraForm)
  await taskCheck('sourceSharing', extraForm); await taskCheck('directoryConsent', extraForm)
  nextTaskMutation = { action: 'grantDirectory', sessionId: TASK2, mode: 'deferred', committed: true }
  await taskClick('grantDirectory', extraForm)
  const reconnectingGrant = deferredTaskMutation
  assert.equal(reconnectingGrant.signal.aborted, false)
  await act(async () => connectionGeneration.set(undefined))
  assert.equal(reconnectingGrant.signal.aborted, true)
  await act(async () => connectionGeneration.set({ id: 201, host: { home: '/synthetic-unopened/task-reconnect' } }))
  await taskSelect(TASK2)
  assert.equal(taskDetail().textContent.includes(en.grantUncertain), true, 'Connection replacement and explicit target selection must not wash a lost Task source outcome')
  await act(async () => reconnectingGrant.resolve())
  assert.equal(taskDetail().textContent.includes(en.grantUncertain), true)
  assert.equal(rawControl(taskDetail(), 'button', te.allowSharing, true).disabled, true)
  assertTaskCenterUnchanged()
  passTask('connection loss/replacement clears local confirmations but preserves unknown source outcomes through late success')

  const sidebarStore = stores.get(sessionId)
  const restoreSidebarTab = (store, id, kind, title, paneId) => store.actions.openContent(id, { kind, contentId: pageAddress(kind), title, ...(paneId ? { paneId } : {}) }, () => {})
  const foreignKind = 'synthetic-other-plugin'
  const retiredKind = 'wechat-task-assistant'
  releases.push(tabs.register({ id: 'synthetic-other-plugin-tab', kind: foreignKind, title: () => 'Synthetic other plugin' }))
  const navigationEntry = slots._core.entries('shell.overlay').find(entry => entry.options.id === 'dsh-wechat-ro/data-sidebar-navigation')
  const navigationCapability = navigationEntry.inject()
  const originalUnifiedTab = right.controller.tabsIn(sessionId).find(tab => tab.kind === client.CONVERSATION_TAB_KIND)
  const originalUnifiedOccurrence = right.controller.tabDomain.occurrence(sessionId, originalUnifiedTab)
  let foreignPane
  await act(async () => { foreignPane = right.controller.split() })
  assert.ok(foreignPane, 'The real SDK must create a second pane for the reuse regression')
  await act(async () => right.controller.openTab(foreignKind, { paneId: foreignPane }))
  const foreignTab = right.controller.tabsIn(sessionId).find(tab => tab.kind === foreignKind)
  const foreignOccurrence = right.controller.tabDomain.occurrence(sessionId, foreignTab)
  const beforeCrossPaneOpen = navigationActivity()
  const opensBeforeCrossPane = trace.filter(([kind]) => kind === 'openTab').length
  for (let index = 0; index < 3; index++) await act(async () => navigationCapability.open())
  await act(async () => right.controller.toggleExpanded())
  assert.equal(right.controller.isExpanded(), false)
  await act(async () => navigationCapability.open())
  assert.equal(right.controller.isExpanded(), true)
  assert.equal(right.controller.active().id, originalUnifiedTab.id)
  assert.equal(right.controller.tabsIn(sessionId).filter(tab => tab.kind === client.CONVERSATION_TAB_KIND).length, 1)
  assert.equal(right.controller.tabDomain.occurrence(sessionId, originalUnifiedTab), originalUnifiedOccurrence)
  assert.equal(originalUnifiedOccurrence.signal.aborted, false)
  assert.equal(trace.filter(([kind]) => kind === 'openTab').length, opensBeforeCrossPane, 'Cross-pane/repeated/collapsed opens focus the owned tab, not a new SDK pane-local page')
  assertNavigationQuiet(beforeCrossPaneOpen)

  let duplicateOccurrence
  await act(async () => {
    restoreSidebarTab(sidebarStore, sessionId, client.CONVERSATION_TAB_KIND, 'Synthetic restored duplicate', foreignPane)
    const duplicate = right.controller.tabsIn(sessionId).find(tab => tab.kind === client.CONVERSATION_TAB_KIND && tab.id !== originalUnifiedTab.id)
    assert.ok(duplicate, 'The real SDK fixture must contain a duplicate before the owned cleanup effect')
    duplicateOccurrence = right.controller.tabDomain.occurrence(sessionId, duplicate)
    right.controller.focus(originalUnifiedTab.id)
  })
  assert.equal(duplicateOccurrence.signal.aborted, true)
  assert.equal(right.controller.tabsIn(sessionId).filter(tab => tab.kind === client.CONVERSATION_TAB_KIND).length, 1)
  assert.equal(right.controller.active().id, originalUnifiedTab.id)
  let retiredOccurrence
  await act(async () => {
    restoreSidebarTab(sidebarStore, sessionId, retiredKind, 'Synthetic retired Task tab', foreignPane)
    const retired = right.controller.tabsIn(sessionId).find(tab => tab.kind === retiredKind)
    assert.ok(retired)
    retiredOccurrence = right.controller.tabDomain.occurrence(sessionId, retired)
    right.controller.focus(foreignTab.id)
  })
  assert.equal(retiredOccurrence.signal.aborted, true)
  assert.equal(right.controller.tabsIn(sessionId).some(tab => tab.kind === retiredKind), false)
  assert.equal(right.controller.tabsIn(sessionId).some(tab => tab.id === foreignTab.id), true)
  assert.equal(foreignOccurrence.signal.aborted, false)

  await act(async () => right.controller.close(originalUnifiedTab.id))
  await act(async () => {
    restoreSidebarTab(sidebarStore, sessionId, retiredKind, 'Synthetic sole retired WeChat tab')
    const retired = right.controller.tabsIn(sessionId).find(tab => tab.kind === retiredKind)
    assert.ok(retired)
    retiredOccurrence = right.controller.tabDomain.occurrence(sessionId, retired)
  })
  assert.equal(retiredOccurrence.signal.aborted, true)
  assert.equal(right.controller.tabsIn(sessionId).some(tab => tab.kind === retiredKind), false)
  assert.equal(right.controller.tabsIn(sessionId).filter(tab => tab.kind === client.CONVERSATION_TAB_KIND).length, 1)
  assert.equal(right.controller.active().kind, client.CONVERSATION_TAB_KIND)
  assert.equal(foreignOccurrence.signal.aborted, false)
  const offscreenStore = stores.get(otherId)
  await act(async () => restoreSidebarTab(offscreenStore, otherId, retiredKind, 'Synthetic offscreen retired tab'))
  const offscreenTab = right.controller.tabsIn(otherId).find(tab => tab.kind === retiredKind)
  assert.ok(offscreenTab)
  await act(async () => navigationCapability.cleanup())
  assert.equal(right.controller.tabsIn(otherId).some(tab => tab.id === offscreenTab.id), true, 'Owned cleanup must not navigate or close an offscreen Session')
  assert.equal(right.controller.tabsIn(sessionId).some(tab => tab.id === foreignTab.id), true)
  await act(async () => right.controller.closeIn(otherId, offscreenTab.id))
  assertTaskCenterUnchanged()
  passTask('one tab is reused across panes/repeated/collapsed opens; restored duplicate and retired owned tabs close without changing foreign tabs or offscreen Sessions')

  await taskSelect(TASK1)
  assert.equal(taskConnection().querySelector('[data-task-history]'), null, 'Retired sealed execution controls are absent on the official Host')
  assert.equal(taskActions('reviewHistoricalContext').length, 0)
  assert.equal(taskActions('selectFirstTextModel').length, 0)
  assert.equal(taskConnection().querySelector('[data-task-native-model]'), null, 'Model selection remains in the official conversation composer')
  passTask('official composer owns model selection; retired sealed execution controls cannot start a request from the sidebar')

  const taskCapRegistration=slots._core.entries('sidebar.right.pane.tab').find(entry=>entry.options.key===client.CONVERSATION_TAB_ID)
  const taskCap=taskCapRegistration.inject()
  const taskTab=right.controller.tabsIn(sessionId).find(tab=>tab.kind===client.CONVERSATION_TAB_KIND)
  assert.ok(taskTab)
  if (process.env.WECHAT_TEST_PROGRESS === '1') console.log('AUTO fixture start');
  // Normal scan flow uses one submitted business action, not the advanced
  // Task/SID/model/consent controls above. The phone transition is synthetic.
  await act(async () => {
    addNativeSession(AUTOTASK); taskTitles.set(AUTOTASK, 'Synthetic automatic conversation')
    const record = taskRecord(AUTOTASK); record.prepared = true; record.historyKnown = true; record.workspace = { ...taskWorkspace }
    taskSource(record, 'workspace', { kind: 'directory', root: taskWorkspace.root, title: taskWorkspace.title, write: true, allowWechat: true })
    record.channel.setup = { root: taskWorkspace.root, title: taskWorkspace.title, sessionId: AUTOTASK, phase: 'ready', modelConfigured: true, error: null }
    knownTaskIds.add(AUTOTASK); publishList(); workspace.openSession(AUTOTASK); layout.selectPanel('wechat-ro')
  })
  if (process.env.WECHAT_TEST_PROGRESS === '1') console.log('AUTO launcher start');
  await act(async () => fireEvent.click(view.getByRole('button', { name: en.launcher, exact: true })))
  if (process.env.WECHAT_TEST_PROGRESS === '1') console.log('AUTO model start');
  const autoSidebar = () => view.container.querySelector('[data-wechat-conversation][data-session-id="' + AUTOTASK + '"]')
  const autoMain = () => autoSidebar().querySelector('[data-wechat-connect-main]')
  assert.equal(autoSidebar().querySelector('[data-wechat-advanced]').open, false)
  assert.equal(autoMain().querySelectorAll('input,textarea,select').length, 0)
  assert.equal(autoMain().textContent.includes(AUTOTASK), false)
  const autoBefore = taskCalls().length, autoCenter = view.container.querySelector('[data-native-sse]')
  const mainModelPicker = view.container.querySelector('[data-native-model-picker="' + AUTOTASK + '"]')
  assert.ok(within(mainModelPicker).getByRole('button', { name: /^Select model, current/ }))
  await act(async () => fireEvent.click(within(mainModelPicker).getByRole('button', { name: /^Select model, current/ })))
  await act(async () => fireEvent.click(within(dom.window.document.body).getByRole('menuitem', { name: /^Model/ })))
  await act(async () => fireEvent.click(within(dom.window.document.body).getByRole('menuitemradio', { name: 'Synthetic alternate model', exact: true })))
  assert.deepEqual(nativeModelCalls.at(-1), { sessionId: AUTOTASK, provider: 'mock', model: 'alternative' })
  let popupRows
  await act(async () => { popupRows = await modelCommand.ui.options({ sessionId: AUTOTASK }) })
  assert.equal(popupRows.find(row => row.label === 'Synthetic alternate model').active, true, 'Native model command and composer share the same selection')
  const centerModelPicker = view.container.querySelector('[data-native-model-picker="' + AUTOTASK + '"]')
  assert.ok(centerModelPicker.textContent.includes('Synthetic alternate model'), 'Native model selection updates the composer')
  await act(async () => fireEvent.click(within(centerModelPicker).getByRole('button', { name: /^Select model, current/ })))
  await act(async () => fireEvent.click(within(dom.window.document.body).getByRole('menuitem', { name: /^Model/ })))
  await act(async () => fireEvent.click(within(dom.window.document.body).getByRole('menuitemradio', { name: 'Synthetic native model', exact: true })))
  assert.ok(mainModelPicker.textContent.includes('Synthetic native model'), 'Native selection remains in the composer')
  assert.equal(taskCalls().length, autoBefore, 'Native model selection performs no Task connection, preparation or sharing action')
  assert.ok(view.container.querySelector('[data-native-sse]') === autoCenter, 'Native model selection must retain the SSE DOM')
  if (process.env.WECHAT_TEST_PROGRESS === '1') console.log('AUTO connection start');
  await act(async () => fireEvent.click(within(autoMain()).getByRole('button', { name: en.autoConnect, exact: true })))
  assert.equal(taskCalls().length, autoBefore + 1)
  assert.deepEqual(taskCalls().at(-1).request, { kind: 'task', action: 'connectConversation', contextSessionId: AUTOTASK, expectedDirectory: taskWorkspace.root, confirmation: 'connect-own-wechat-auto-reply' })
  assert.ok(within(autoMain()).getByRole('img', { name: en.qrLabel, exact: true }))
  assert.equal(autoSidebar().querySelector('[data-wechat-advanced]').open, false)
  assert.ok(view.container.querySelector('[data-native-sse]') === autoCenter, 'Connecting must retain the SSE DOM')
  const pairingPath = within(autoMain()).getByRole('img', { name: en.qrLabel, exact: true }).querySelector('path').getAttribute('d')
  const beforeScanRemount = taskCalls().length, readsBeforeScanRemount = calls.length
  const pairingTab = right.controller.tabsIn(AUTOTASK).find(tab => tab.kind === client.CONVERSATION_TAB_KIND)
  assert.ok(pairingTab)
  await act(async () => right.controller.close(pairingTab.id))
  assert.equal(autoSidebar(), null)
  await act(async () => layout.selectPanel('wechat-ro'))
  await act(async () => fireEvent.click(view.getByRole('button', { name: en.launcher, exact: true })))
  assert.ok(autoMain())
  assert.equal(within(autoMain()).getByRole('img', { name: en.qrLabel, exact: true }).querySelector('path').getAttribute('d'), pairingPath)
  assert.equal(taskCalls().length, beforeScanRemount, 'Remount only reads memory; it never reconnects, regrants, requests a new QR or starts a channel')
  assert.ok(calls.length > readsBeforeScanRemount)
  assert.equal(autoSidebar().querySelector('[data-wechat-advanced]').open, false)
  // The user explicitly visited the global launcher to reopen the tab; its
  // native DOM remount is allowed, but the exact Session and stream stay intact.
  assert.equal(current.getSnapshot().key, AUTOTASK)
  assert.equal(view.container.querySelector('[data-native-sse]').textContent, nativeStreams.get(AUTOTASK).getSnapshot().streamingText)
  assert.equal(view.container.querySelectorAll('[data-native-sse]').length, 1)
  assert.equal(prompts.length, beforeTaskPrompts)
  await act(async () => {
    const record = taskRecord(AUTOTASK)
    record.allowWechat = false
    record.channel = { ...record.channel, phase: 'paired', hasStoredLogin: true, messagingEnabled: false, automaticPolling: false,
      setup: { ...record.channel.setup, phase: 'history-required', qr: null } }
    await new Promise(resolve => setTimeout(resolve, 1150))
  })
  assert.ok(autoMain().textContent.includes(en.autoHistoryNeeded))
  assert.ok(autoMain().textContent.includes(en.autoHistoryHint))
  assert.equal(within(autoMain()).queryByRole('img', { name: en.qrLabel, exact: true }), null)
  assert.equal(within(autoMain()).queryByRole('button', { name: en.autoConnectPaired, exact: true }), null)
  assert.equal(within(autoMain()).getByRole('button', { name: en.autoDisconnect, exact: true }).disabled, false)
  const waitingHistory = autoSidebar().querySelector('[data-local-history]')
  assert.equal(visible(waitingHistory), true)
  const beforeHistoryImport = taskActions('importLocalHistory').length
  rejectLocalHistoryImport = 'LOCAL_HISTORY_CLIENT_REQUIRED'
  await act(async () => fireEvent.click(within(waitingHistory).getByRole('checkbox', { name: te.localHistoryConsent, exact: true })))
  assert.equal(within(waitingHistory).getByRole('button', { name: te.localHistoryImport, exact: true }).disabled, false)
  await act(async () => fireEvent.click(within(waitingHistory).getByRole('button', { name: te.localHistoryImport, exact: true })))
  assert.equal(taskActions('importLocalHistory').length, beforeHistoryImport + 1)
  assert.ok(autoMain().textContent.includes(en.LOCAL_HISTORY_CLIENT_REQUIRED))
  assert.equal(autoMain().textContent.includes(en.autoUnknown), false)
  assert.ok(waitingHistory.textContent.includes(te.localHistoryClientRequired))
  await act(async () => fireEvent.click(within(waitingHistory).getByRole('checkbox', { name: te.localHistoryConsent, exact: true })))
  await act(async () => fireEvent.click(within(waitingHistory).getByRole('button', { name: te.localHistoryImport, exact: true })))
  assert.equal(taskActions('importLocalHistory').length, beforeHistoryImport + 2)
  assert.equal(taskActions('connectConversation').length, 1)
  await act(async () => locale.setLocale('zh'))
  const historyDictionary = frameDictionary(autoSidebar())
  assert.ok(autoMain().textContent.includes(historyDictionary.autoHistoryNeeded))
  assert.ok(autoMain().textContent.includes(historyDictionary.autoHistoryHint))
  await act(async () => locale.setLocale('en'))
  passTask('paired history wait exposes import and Stop in both locales without a duplicate connection action')
  await act(async () => {
    const record = taskRecord(AUTOTASK)
    record.allowWechat = true
    record.channel = { ...record.channel, phase: 'running', hasStoredLogin: true, messagingEnabled: true, automaticPolling: true, setup: { ...record.channel.setup, phase: 'running', qr: null } }
    await new Promise(resolve => setTimeout(resolve, 1650))
  })
  assert.equal(autoMain().textContent.includes(en.autoConnected), true)
  assert.equal(within(autoMain()).queryByRole('img', { name: en.qrLabel, exact: true }), null)
  const autoActionsBeforeOpen = taskCalls().length
  await act(async () => fireEvent.click(within(autoMain()).getByRole('button', { name: en.autoNative, exact: true })))
  assert.equal(current.getSnapshot().key, AUTOTASK); assert.equal(selected.at(-1), AUTOTASK)
  assert.equal(taskCalls().length, autoActionsBeforeOpen)
  assert.equal(view.container.querySelectorAll('[data-native-sse]').length, 1)
  await act(async () => {
    taskSource(taskRecord(AUTOTASK), 'archive', { kind: 'archive', title: 'Synthetic auto archive', allowWechat: true,
      archive: { ...defaultState(AUTOTASK).archive, allConversations: true, talkers: [] } })
    await new Promise(resolve => setTimeout(resolve, 1650))
  })
  await showIndexView(autoSidebar(), 'records')
  const automaticQuery = autoSidebar().querySelector('[data-index-records] form')
  await act(async () => fireEvent.change(within(automaticQuery).getByLabelText(te.querySource), { target: { value: 'task:' + AUTOTASK + ':archive' } }))
  await act(async () => fireEvent.change(within(automaticQuery).getByLabelText(en.queryAction), { target: { value: 'search' } }))
  await act(async () => fireEvent.change(within(automaticQuery).getByLabelText(te.queryText), { target: { value: 'Synthetic update acceptance' } }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 3250)) })
  assert.equal(within(automaticQuery).getByLabelText(te.queryText).value, 'Synthetic update acceptance')
  assert.equal(within(automaticQuery).getByLabelText(en.queryAction).value, 'search')
  await act(async () => fireEvent.click(within(automaticQuery).getByRole('button', { name: en.runQuery, exact: true })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1650)) })
  assert.ok(autoSidebar().querySelector('[data-task-query-result]').textContent.includes(taskPrivateText))
  assert.equal(within(automaticQuery).getByLabelText(te.queryText).value, 'Synthetic update acceptance')
  taskRecord(AUTOTASK).sources.delete('archive'); taskRecord(AUTOTASK).consumed.clear()
  await showIndexView(autoSidebar(), 'overview')
  await act(async () => { autoSidebar().querySelector('[data-wechat-advanced]').open = false })
  passTask('automatic status polls preserve the selected archive, search draft and result in the same Task')
  await act(async () => fireEvent.click(within(autoMain()).getByRole('button', { name: en.autoDisconnect, exact: true })))
  assert.equal(taskRecord(AUTOTASK).channel.automaticPolling, false)
  rejectAutoConnect = true
  const beforeClosedRejection = taskCalls().length
  await act(async () => fireEvent.click(within(autoMain()).getByRole('button', { name: en.autoConnectPaired, exact: true })))
  assert.equal(taskCalls().length, beforeClosedRejection + 1)
  assert.ok(autoMain().textContent.includes(en.SHARED_CONTEXT_DENIED))
  assert.equal(autoMain().textContent.includes(en.autoUnknown), false, 'A typed, closed connection refusal is a known error')
  assert.equal(autoSidebar().textContent.includes(en.creationUnknown), false, 'A typed connection refusal cannot become an unknown creation')
  assert.equal(within(autoMain()).getByRole('button', { name: en.autoConnectPaired, exact: true }).disabled, false)
  const beforeRecoveryChannel = taskRecord(AUTOTASK).channel
  for (const recovery of [{ phase: 'paired', pendingRecovery: true }, { phase: 'recovery-required', pendingRecovery: false }]) {
    taskRecord(AUTOTASK).channel = { ...beforeRecoveryChannel, ...recovery, delivery: { phase: 'sending', accepted: 0, total: 1 },
      setup: { ...beforeRecoveryChannel.setup, phase: 'ready', error: 'SHARED_CONTEXT_DENIED' } }
    const beforeRecoveryCheck = taskCalls().length
    await act(async () => fireEvent.click(within(autoMain()).getByRole('button', { name: en.autoCheck, exact: true })))
    assert.equal(taskCalls().length, beforeRecoveryCheck + 1)
    assert.deepEqual(taskCalls().at(-1).request, { kind: 'task', action: 'querySource', sessionId: AUTOTASK, query: { action: 'status' } })
    assert.ok(autoMain().textContent.includes(en.phaseRecovery))
    assert.ok(autoMain().textContent.includes(en.recoveryHint))
    assert.equal(autoMain().textContent.includes(en.autoLegacyBlocked), false)
    assert.equal(autoMain().textContent.includes(en.SHARED_CONTEXT_DENIED), false)
    assert.equal(within(autoMain()).getByRole('button', { name: en.autoConnectPaired, exact: true }).disabled, true)
    assert.equal(autoSidebar().querySelector('[data-wechat-advanced]').open, false)
  }
  await act(async () => locale.setLocale('zh'))
  const recoveryDictionary = frameDictionary(autoSidebar())
  assert.notEqual(recoveryDictionary.phaseRecovery, en.phaseRecovery)
  assert.ok(autoMain().textContent.includes(recoveryDictionary.phaseRecovery))
  assert.ok(autoMain().textContent.includes(recoveryDictionary.recoveryHint))
  assert.ok(within(autoMain()).getByRole('button', { name: recoveryDictionary.indexRecovery, exact: true }))
  await act(async () => locale.setLocale('en'))
  const beforeRecoveryNavigation = navigationActivity()
  await act(async () => fireEvent.click(within(autoMain()).getByRole('button', { name: en.indexRecovery, exact: true })))
  assertNavigationQuiet(beforeRecoveryNavigation)
  assert.equal(autoSidebar().querySelector('[data-wechat-advanced]').open, true)
  assert.equal(visible(autoSidebar().querySelector('[data-wechat-settings]')), true)
  const recoveryPanel = autoSidebar().querySelector('[data-channel-recovery]')
  assert.equal(visible(recoveryPanel.querySelector('summary')), true)
  await openDetails(recoveryPanel)
  assert.equal(within(recoveryPanel).getByRole('checkbox', { name: en.discardConsent, exact: true }).checked, false)
  assert.equal(within(recoveryPanel).getByRole('button', { name: en.discard, exact: true }).disabled, true)
  assert.equal(within(recoveryPanel).queryByRole('button', { name: te.resumeUnanswered, exact: true }), null)
  taskRecord(AUTOTASK).channel = { ...taskRecord(AUTOTASK).channel, resumeAvailable: true }
  await act(async () => fireEvent.click(within(autoMain()).getByRole('button', { name: en.autoCheck, exact: true })))
  const continuation = within(autoSidebar().querySelector('[data-channel-recovery]')).getByRole('button', { name: te.resumeUnanswered, exact: true })
  assert.equal(continuation.disabled, false)
  const beforeContinue = taskActions('resumeTextOnce').length, beforeDiscard = taskActions('discardPending').length
  await act(async () => fireEvent.click(continuation))
  assert.equal(taskActions('resumeTextOnce').length, beforeContinue + 1)
  assert.deepEqual(taskActions('resumeTextOnce').at(-1).request, { kind: 'task', action: 'resumeTextOnce', sessionId: AUTOTASK, allowSharedContext: true, confirmation: 'continue-unanswered-message' })
  assert.equal(taskActions('discardPending').length, beforeDiscard)
  taskRecord(AUTOTASK).channel = beforeRecoveryChannel
  await act(async () => fireEvent.click(within(autoMain()).getByRole('button', { name: en.autoCheck, exact: true })))
  assert.equal(autoMain().textContent.includes(en.phaseRecovery), false)
  assert.equal(autoMain().textContent.includes(en.recoveryHint), false)
  assert.equal(within(autoMain()).queryByRole('button', { name: en.indexRecovery, exact: true }), null)
  assert.equal(within(autoMain()).getByRole('button', { name: en.autoConnectPaired, exact: true }).disabled, false)
  await showIndexView(autoSidebar(), 'overview')
  await act(async () => { autoSidebar().querySelector('[data-wechat-advanced]').open = false })
  passTask('normal recovery shows known pending state in both locales, keeps reconnect disabled, and opens existing recovery settings without a business action or automatic discard')
  loseAutoConnectResponse = true
  await act(async () => fireEvent.click(within(autoMain()).getByRole('button', { name: en.autoConnectPaired, exact: true })))
  assert.equal(autoMain().textContent.includes(en.autoUnknown), true)
  const afterLostConnect = taskCalls().length
  await act(async () => fireEvent.click(within(autoMain()).getByRole('button', { name: en.autoCheck, exact: true })))
  assert.equal(taskCalls().length, afterLostConnect + 1)
  assert.deepEqual(taskCalls().at(-1).request, { kind: 'task', action: 'querySource', sessionId: AUTOTASK, query: { action: 'status' } })
  assert.equal(autoMain().textContent.includes(en.autoUnknown), true)
  assert.equal(autoMain().querySelectorAll('input,textarea,select').length, 0)
  await act(async () => fireEvent.click(within(autoMain()).getByRole('button', { name: en.autoDisconnect, exact: true })))
  passTask('normal main view reuses the native SSE model dropdown in both directions; explicit scan connection, known refusal, one status query, exact native identity, and response loss remains uncertain')
  await act(async () => workspace.openSession(sessionId))
  const occurrence=right.controller.tabDomain.occurrence(sessionId,taskTab)
  await act(async()=>right.controller.close(taskTab.id)); assert.equal(taskAside(),null); assert.equal(occurrence.signal.aborted,true)
  await act(async()=>layout.selectPanel('wechat-ro')); await click(en.launcher); await taskSelect(TASK1)
  assertTaskCenterUnchanged()
  let localHistoryPanel = taskDetail().querySelector('[data-local-history]');
  assert.ok(localHistoryPanel);
  assert.equal(within(localHistoryPanel).getByRole('checkbox', { name: te.localHistoryConsent, exact: true }).checked, false);
  assert.equal(within(localHistoryPanel).getByRole('button', { name: te.localHistoryImport, exact: true }).disabled, true);
  await act(async()=>fireEvent.click(within(localHistoryPanel).getByRole('checkbox', { name: te.localHistoryConsent, exact: true })));
  await act(async()=>fireEvent.click(within(localHistoryPanel).getByRole('button', { name: te.localHistoryImport, exact: true })));
  assert.deepEqual(taskActions('importLocalHistory').at(-1).request, { kind:'task',sessionId:TASK1,action:'importLocalHistory',autoUpdate:true,allowWechat:true,confirmation:'import-own-wechat-history' });
  localHistoryPanel = taskDetail().querySelector('[data-local-history]');
  await act(async()=>fireEvent.click(within(localHistoryPanel).getByRole('button', { name: te.localHistoryRefresh, exact: true })));
  const dailyPanel = taskDetail().querySelector('[data-daily-cards]');
  assert.ok(dailyPanel.querySelector('[data-daily-statistics]')); assert.ok(dailyPanel.querySelector('[data-daily-digest]'));
  assert.equal(dailyPanel.getAttribute('data-visual-cards-revision'),'source-tabs-v1');
  assert.equal(dailyPanel.querySelectorAll('[data-daily-metric]').length,4);
  assert.equal(dailyPanel.querySelectorAll('[data-trend-day]').length,2);
  assert.equal(dailyPanel.querySelector('[data-daily-digest]').hidden,true);
  const actionsBeforeChart = taskCalls().length;
  await act(async()=>fireEvent.click(dailyPanel.querySelector('[data-trend-day="2026-11-17"]')));
  assert.equal(dailyPanel.querySelector('[data-trend-day="2026-11-17"]').getAttribute('aria-pressed'),'true');
  assert.equal(dailyPanel.querySelector('[data-daily-metric="messageCount"] .wd-metric-number').textContent,'10');
  assert.equal(dailyPanel.querySelector('.wd-composition-text').style.width,'50%');
  assert.equal(dailyPanel.querySelectorAll('.wd-rank-fill').length,2);
  assert.equal(taskCalls().length,actionsBeforeChart,'Date selection reuses loaded data without extra source or model calls');
  await act(async()=>fireEvent.click(within(dailyPanel).getByRole('tab',{name:te.dailyInsights,exact:true})));
  assert.equal(dailyPanel.querySelector('[data-daily-statistics]').hidden,true);
  assert.equal(dailyPanel.querySelector('[data-daily-digest]').hidden,false);
  assert.equal(dailyPanel.querySelector('[data-daily-source-panel]').getAttribute('data-daily-source-panel'),'group');
  assert.equal(dailyPanel.querySelectorAll('[data-daily-evidence="highlight"]').length,4);
  assert.equal(dailyPanel.querySelectorAll('[data-daily-conversation]').length,2);
  assert.equal(dailyPanel.querySelector('.wd-source-caption').textContent,te.dailySourceTotals.replace('{conversations}','2').replace('{highlights}','5').replace('{todos}','1'));
  assert.equal(dailyPanel.querySelector('[data-daily-conversation="cross-conversation"]').textContent.includes('Second group'),true);
  assert.equal(dailyPanel.querySelector('[data-daily-coverage] [role="img"]').getAttribute('aria-label').includes('8/12'),true);
  const beforeSources = taskCalls().length;
  const sourceButton = kind => dailyPanel.querySelector('[data-daily-source-tab="'+kind+'"]');
  const sourcePanel = () => dailyPanel.querySelector('[data-daily-source-panel]');
  const groupEvidence = dailyPanel.querySelector('[data-daily-conversation="group@chatroom"] [data-evidence-section="highlights"]');
  await act(async()=>fireEvent.click(groupEvidence.querySelector('button.wd-more')));
  assert.equal(groupEvidence.querySelectorAll('[data-daily-evidence="highlight"]').length,4);
  await act(async()=>fireEvent.click(sourceButton('personal')));
  assert.equal(sourcePanel().textContent.includes('Daily evidence'),true);
  assert.equal(sourcePanel().textContent.includes('Group highlight'),false);
  assert.equal(sourcePanel().textContent.includes('Alice'),true);
  await act(async()=>fireEvent.click(sourceButton('official')));
  assert.equal(sourcePanel().textContent.includes('Public account highlight'),true);
  assert.equal(sourcePanel().textContent.includes('Service account highlight'),false);
  await act(async()=>fireEvent.keyDown(sourceButton('official'),{key:'ArrowRight'}));
  assert.equal(sourceButton('service').getAttribute('aria-selected'),'true');
  assert.equal(dom.window.document.activeElement,sourceButton('service'));
  assert.equal(sourcePanel().textContent.includes('Service account highlight'),true);
  await act(async()=>fireEvent.click(sourceButton('mixed')));
  assert.equal(sourcePanel().textContent.includes('Compare group and personal requests'),true);
  assert.equal(sourcePanel().querySelectorAll('.wd-citation').length,2,'Cross-type summaries retain all original citations in their own tab');
  await act(async()=>fireEvent.click(sourceButton('personal')));

  assert.ok(dailyPanel.textContent.includes('Daily evidence')); assert.ok(dailyPanel.textContent.includes('Original daily evidence'));
  assert.ok(dailyPanel.textContent.includes('8/12')); assert.ok(dailyPanel.textContent.includes(te.dailyPartial));
  await act(async()=>fireEvent.change(within(dailyPanel).getByLabelText(te.dailyDate),{target:{value:'2026-11-16'}}));
  assert.ok(sourcePanel().querySelector('.wd-empty'));
  assert.equal(sourcePanel().textContent.includes(te.dailySourceEmptyHint),true);
  assert.equal(sourcePanel().querySelectorAll('[data-daily-evidence]').length,0);
  await act(async()=>fireEvent.change(within(dailyPanel).getByLabelText(te.dailyDate),{target:{value:'2026-11-17'}}));
  assert.equal(taskCalls().length,beforeSources,'Source filters, expansion and date selection use local data only');
  const timeInput = dailyPanel.querySelector('input[type="time"]');
  await act(async()=>fireEvent.change(timeInput,{target:{value:'18:30'}}));
  await act(async()=>fireEvent.click(within(dailyPanel).getByRole('button',{name:te.dailySaveTime,exact:true,hidden:true})));
  assert.equal(taskActions('setDailyCardTime').at(-1).request.time,'18:30');
  await act(async()=>fireEvent.click(within(dailyPanel).getByRole('button',{name:te.dailyUpdate,exact:true})));
  assert.equal(taskActions('refreshDailyCards').length,1);
  for(const wire of [hostWire.TASK_WIRE,client.__conversationWire.taskWire]) assert.equal(wire.actionSchema.safeParse({kind:'task',sessionId:TASK1,action:'setDailyCardTime',time:'25:00'}).success,false);
  passTask('daily charts, per-conversation source tabs, mixed-source citations, empty states and editable schedule use the exact Task');
  await act(async()=>fireEvent.click(sourceButton('personal')));
  const todoMine = sourcePanel().querySelector('[data-todo-mine]'); assert.ok(todoMine); assert.equal(todoMine.disabled, false);
  await act(async()=>fireEvent.click(todoMine));
  assert.equal(taskActions('confirmDailyTodo').at(-1).request.assignee, te.dailyMe);
  assert.equal(taskActions('confirmDailyTodo').at(-1).request.sessionId, TASK1);
  const trackedSection = dailyPanel.querySelector('[data-tracked-todos]');
  assert.equal(trackedSection.querySelectorAll('[data-tracked-todo]').length,1);
  await act(async()=>fireEvent.click(within(trackedSection).getByRole('button',{name:te.dailyMarkDone,exact:true})));
  assert.equal(taskActions('setDailyTodoState').at(-1).request.completed,true);
  await act(async()=>fireEvent.click(within(trackedSection).getByRole('button',{name:te.dailyReopen,exact:true,hidden:true})));
  assert.equal(taskActions('setDailyTodoState').at(-1).request.completed,false);
  await act(async()=>fireEvent.change(within(dailyPanel).getByLabelText(te.dailyDate),{target:{value:'2026-11-16'}}));
  assert.equal(trackedSection.querySelectorAll('[data-tracked-todo]').length,1);
  passTask('Owner confirms task assignee, completes/reopens and keeps the task while switching report dates');

  await act(async()=>fireEvent.click(within(dailyPanel).getByRole('tab',{name:te.historySources,exact:true})));
  const sourceHistory = dailyPanel.querySelector('[data-history-sources]');
  assert.ok(sourceHistory.querySelector('[role="alert"]'));
  assert.equal(sourceHistory.querySelector('.wd-empty'),null,'Failed reads must not claim zero matching records');
  if (process.env.WECHAT_HISTORY_FAILURE_HTML) writeFileSync(process.env.WECHAT_HISTORY_FAILURE_HTML, '<!doctype html><meta charset="utf-8"><title>History failure state fixture</title><style>body{margin:0;padding:32px;background:#151517;color:#f9fafb;font:14px system-ui;--dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#232324;--dsw-alias-bg-layer-2:#2c2c2e;--dsw-alias-label-primary:#f9fafb;--dsw-alias-label-secondary:#cfd3d6;--dsw-alias-border-l1:#ffffff0f;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-brand-primary:#f9fafb}.wechat-daily-data{max-width:400px;margin:0 auto}.wc-field{display:flex;flex-direction:column;gap:4px}.wi-query{display:flex;flex-direction:column;gap:8px}.wi-note{font-size:12px;color:#cfd3d6}h1{font-size:18px;margin:0 0 24px}</style><h1>Failed-read fixture · synthetic data</h1><section class="wechat-daily-data">'+dailyPanel.querySelector('style').outerHTML+sourceHistory.outerHTML+'</section>');
  historySourcesMode='empty';
  await act(async()=>fireEvent.submit(sourceHistory.querySelector('form')));
  assert.equal(sourceHistory.querySelector('[role="alert"]'),null);
  assert.ok(sourceHistory.querySelector('.wd-empty'));
  historySourcesMode='ready';
  await act(async()=>fireEvent.submit(sourceHistory.querySelector('form')));
  assert.equal(sourceHistory.querySelector('.wd-empty'),null);
  assert.equal(sourceHistory.querySelectorAll('[data-history-record="moments"]').length,1);
  await act(async()=>fireEvent.click(within(sourceHistory).getByRole('tab',{name:te.historyContacts,exact:true})));
  assert.equal(sourceHistory.querySelectorAll('[data-history-record="contacts"]').length,1);
  await act(async()=>fireEvent.click(within(sourceHistory).getByRole('tab',{name:te.historyMedia,exact:true})));
  assert.equal(sourceHistory.querySelectorAll('[data-history-record="media"]').length,1);
  assert.equal(taskActions('querySource').at(-1).request.query.query.sourceKind,'messages');
  passTask('history failed/empty/populated states and image/video tab preserve exact Task source scope');
  await act(async()=>fireEvent.click(within(localHistoryPanel).getByRole('button', { name: te.localHistoryStop, exact: true })));
  assert.equal(taskActions('refreshLocalHistory').length, 1);assert.equal(taskActions('stopLocalHistory').length, 1);
  passTask('one-click history import requires explicit consent and retains exact Task identity; refresh and stop use owner actions');
  const navigationDisposeProbe=process.env.WECHAT_TEST_NAVIGATION_DISPOSE_PROBE==='1'
  const opensBeforeDispose=trace.filter(([kind])=>kind==='openTab').length
  if(navigationDisposeProbe){
    const control=rawControl(taskConnection(),'button',en.openNative,true), before=navigationActivity(), reads=calls.length
    const tab=right.controller.tabsIn(sessionId).find(tab=>tab.kind===client.CONVERSATION_TAB_KIND)
    const activeOccurrence=right.controller.tabDomain.occurrence(sessionId,tab),errors=[]
    const observe=event=>{errors.push(event.message);event.preventDefault()};dom.window.addEventListener('error',observe)
    try { await act(async()=>{await consumer.dispose();consumer=null;assert.equal(control.isConnected,true);assert.equal(activeOccurrence.signal.aborted,false);fireEvent.click(control)}) }
    finally{dom.window.removeEventListener('error',observe)}
    assert.deepEqual(errors,[]);assert.equal(selected.length,before.selected);assert.equal(actionCalls().length,before.actions);assert.equal(calls.length,reads)
    console.log('PASS plugin disposal before DOM removal rejects Task native navigation without getter access or RPC')
  } else {
    await act(async()=>right.controller.close(right.controller.tabsIn(sessionId).find(tab=>tab.kind===client.CONVERSATION_TAB_KIND).id))
    await act(async()=>layout.selectPanel('wechat-ro'))
    await act(async()=>{fireEvent.click(view.getByRole('button',{name:en.launcher,exact:true}));await consumer.dispose()});consumer=null
  }
  assert.equal(trace.filter(([kind]) => kind === 'openTab').length, opensBeforeDispose)
  assert.equal(withdrawals, 1); assert.equal(tabs.get(client.CONVERSATION_TAB_KIND), undefined)
  assert.equal(tabs.get('wechat-task-assistant'), undefined); assert.equal(taskCap.lifecycleSignal.aborted, true)
  const pickerAfterDispose = pickerCalls
  assert.equal(taskCap.canOpenNativeSession(TASK1), false); assert.equal(taskCap.openNativeSession(TASK1), false)
  assert.equal(await taskCap.pickDirectory(), null); assert.equal(pickerCalls, pickerAfterDispose)
  passTask('namespace disposal aborts the owned Task lifecycle and blocks picker/navigation capability reuse without SDK getter access')
  assert.equal(slots._core.entries('sidebar.right.pane.tab').length, 0); assert.equal(slots._core.entries('shell.overlay').length, 0)
  assert.deepEqual(nativeBefore, ['rightbar.session', 'conversation.session.header.corner'].map(name => slots._core.entries(name)[0]))
  assert.equal(entryErrors.length, 0); assert.equal(networkAttempts, 0)
  assert.deepEqual([...new Set(actionCalls().filter(call => call.request.kind !== 'task').map(call => call.request.action))].sort(), ['grantSnapshot','queryArchive','revokeSnapshot'].sort(), 'Only data actions remain in the ordinary UI; legacy 12-action codec compatibility stays tested above')
  const retiredActions = new Set(['allowNewFirstText', 'authorizeFirstTextContext', 'authorizeHistoricalContext', 'reviewFirstTextContext', 'reviewHistoricalContext', 'revokeFirstTextContext', 'revokeHistoricalContext', 'selectFirstTextModel'])
  assert.deepEqual([...new Set(taskCalls().map(call => call.request.action))].sort(), hostWire.TASK_WIRE.TASK_ACTION_NAMES.filter(name => !retiredActions.has(name)).sort(), 'Every supported Task action is exercised; retired sealed controls produce no request')
  assert.equal(indexCases.length, 6); assert.equal(exportCases.length, 5)
  console.log('PASS tab/scope/namespace teardown, late QR/navigation cancellation, native singleton preservation, one parent withdrawal, network attempts=0')
  console.log(JSON.stringify({ok:true,technicalOnly:true,descriptorCount:11,strictActions:positives.length,rejectedRequests:negatives.length,userActions:actionCalls().length,networkAttempts,
    unifiedSidebar:{revision:'index-single-sidebar-v1',oneRegisteredKind:true,oneLeftEntry:true,modeSelector:false,ordinaryUiActions:['grantSnapshot','queryArchive','revokeSnapshot'],legacySchemaActions:12,taskSchemaActions:hostWire.TASK_WIRE.TASK_ACTION_NAMES.length},
    indexUiRegression:{navigationCases:indexCases,exportCases,configurationHidden:true,actionFreeNavigation:true,temporaryReferenceExported:false,repeatExportReads:0},
    loginExpiryRegression:{cases:loginExpiryCases,explicitReplacementOnly:true,technicalOnly:true},taskUiRegression:{cases:taskCases,taskSids:[TASK1,TASK2,TASK3],phoneMessaging:false},
    updatesDiagnosticUiRegression:{cases:taskCases.filter(name => name.startsWith('updates diagnostic:')),defaultCollapsed:true,defaultConsent:false,closedProjection:true,independentOfHistoryPermit:true},
    retiredUiCoverage:'Readonly-bot creation/bridge/dashboard UI removed; legacy runtime/codec tests remain. Existing Task cancellation, unknown authorization, lifecycle and pairing cases are retained.',
    visualVerification:'Not performed by this isolated synthetic SDK carrier.'}))


} finally {
  if (view) view.unmount()
  if (consumer) await consumer.dispose()
  if (cleanup) cleanup()
  for (const release of releases.reverse()) await release()
  if (right) right.controller.tabDomain.dispose()
  if (releaseRoot) releaseRoot()
  if (gateway) await gateway.dispose()
  if (ctx) await ctx.fiber.dispose()
  if (dom) dom.window.close()
  hooks.deregister()
  for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
}
