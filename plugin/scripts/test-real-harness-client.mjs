// Technical regression only: actual Cordis + SlotRegistry/SlotCore + renderer
// + LocaleRuntime in an in-memory DOM. No profile, browser, snapshot, WeChat,
// build or installation is opened. No manual t prop or translator is supplied.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(scriptDir, '..')
const runtimeRoot = process.env.WECHAT_UI_TEST_RUNTIME || '/REPLACE_WITH_DSH_CHECKOUT'
const clientFile = join(pluginDir, 'lib/client.js')
// Keep current authorized input bytes in memory before SDK setup. This is not
// an archived 0.1.1 baseline: the Lead may already have updated the symlink source.
const baselineSource = readFileSync(clientFile, 'utf8')
const mutated = process.env.WECHAT_TEST_NESTED_REGISTRATION_MUTANT === '1'
const expectedClientVersion = '0.2.0'
const namespaceKey = 'remote.wechatRo'
const correctNamespaceDeclaration = "ctx.inject(['remote.' + NAMESPACE], function registerWechatUi(ctx) {"
const genericNamespaceDeclaration = "ctx.inject(['remote'], function registerWechatUi(ctx) {"
function mutateNamespaceDeclaration(source) {
  assert.equal(source.split(correctNamespaceDeclaration).length, 2, 'DI control requires exactly one actual leaf declaration')
  return source.replace(correctNamespaceDeclaration, genericNamespaceDeclaration)
}
const flatRegistration = 'ctx.locale.register(NS, { zh: flattenLocale(zh), en: flattenLocale(en) })'
if (mutated) assert.equal(baselineSource.split(flatRegistration).length, 2, 'controlled mutation requires exactly one flat registration')
const inputSource = mutated ? baselineSource.replace(flatRegistration, 'ctx.locale.register(NS, { zh, en })') : baselineSource
console.log('SOURCE_INPUT', JSON.stringify({ file: clientFile, variant: mutated ? 'controlled nested-registration mutation; NOT archived 0.1.1 bytes' : 'current workspace source; NOT live GUI verification' }))
const registryFile = join(runtimeRoot, 'packages/client/ui-renderer/lib/types/client/registry.js')
let registryCoreUrl
const runtimeRequire = createRequire(join(runtimeRoot, 'package.json'))
const sdkRequire = createRequire(join(runtimeRoot, 'packages/client/ui-renderer/package.json'))
const pluginRequire = createRequire(join(pluginDir, 'package.json'))
const savedGlobals = new Map()
const consoleErrors = []
const originalConsoleError = console.error
let networkAttempts = 0
const denyNetwork = () => {
  networkAttempts += 1
  throw new Error('Network is forbidden in the real-Harness offline regression')
}
function installGlobal(key, value) {
  savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
}
// Resolving CSS must short-circuit as well as loading it: some generated SDK
// relative CSS assets do not exist as Node-resolvable files. No styling is tested.
const cssHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\.css(?:[?#].*)?$/.test(specifier)) {
      return { url: 'offline-css:' + encodeURIComponent(specifier), format: 'module', shortCircuit: true }
    }
    if (/^https?:/.test(specifier)) return denyNetwork()
    const resolved = nextResolve(specifier, context)
    if (specifier === '@deepseek-ai/dsh-client-ui-slots' && context.parentURL === pathToFileURL(registryFile).href) registryCoreUrl = resolved.url
    return resolved
  },
  load(url, context, nextLoad) {
    if (url.startsWith('offline-css:') || /\.css(?:[?#].*)?$/.test(url)) {
      return { format: 'module', source: 'export default Object.freeze({});', shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
console.error = (...args) => {
  consoleErrors.push(args)
  originalConsoleError(...args)
}

let dom
let cleanup
const importSdk = (relative) => import(pathToFileURL(join(runtimeRoot, relative)).href)
const methods = ['status', 'contacts', 'sessions', 'messages', 'searchMessages', 'timeline', 'chatroomMembers', 'sql', 'buildExport']
const conversationMethods = ['getConversationState', 'conversationAction']
const labels = {
  en: { panel: 'WeChat', launcher: 'Open WeChat sidebar' },
  zh: { panel: '微信', launcher: '打开微信侧栏' },
}
function assertNoRemoteCalls(test, message = 'lazy launchers must not invoke any Remote method') {
  assert.deepEqual(test.remoteRequests, [], message)
  for (const [method, count] of Object.entries(test.calls)) assert.equal(count, 0, message + ': ' + method)
  assert.equal(networkAttempts, 0, 'offline UI must not attempt network access')
}

try {
  const { JSDOM } = runtimeRequire('jsdom')
  dom = new JSDOM('<!doctype html>')
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true, fetch: denyNetwork,
  })) installGlobal(key, value)
  dom.window.fetch = denyNetwork
  dom.window.XMLHttpRequest = class { constructor() { denyNetwork() } }
  dom.window.WebSocket = class { constructor() { denyNetwork() } }
  const React = sdkRequire('react')
  const testing = runtimeRequire('@testing-library/react')
  const { render, fireEvent, act } = testing
  cleanup = testing.cleanup
  const { Context, Service } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/cordis')).href)
  const gatewayFile = createRequire(join(runtimeRoot, 'packages/api/gateway/package.json')).resolve('@deepseek-ai/dsh-api-gateway/client')
  const gatewayModule = await import(pathToFileURL(gatewayFile).href)
  assert.deepEqual(Array.from(gatewayModule.inject), ['typert', 'connection'])
  console.log('REAL_GATEWAY_SDK', JSON.stringify({ file: gatewayFile, cordis: sdkRequire.resolve('@deepseek-ai/cordis') }))
  const { SlotCore } = await importSdk('packages/client/ui-slots/lib/types/index.js')
  const { SlotRegistry } = await import(pathToFileURL(registryFile).href)
  assert.equal(typeof registryCoreUrl, 'string', 'record the public SlotCore import used by SlotRegistry')
  const { SlotCore: RegistrySlotCore } = await import(registryCoreUrl)
  console.log('SDK_PATHS', JSON.stringify({ registry: registryFile, registryCore: registryCoreUrl, requireResolvedCore: sdkRequire.resolve('@deepseek-ai/dsh-client-ui-slots'), react: sdkRequire.resolve('react') }))
  const { createSlotRenderer } = await importSdk('packages/client/ui-renderer/lib/types/client/scoped-slots.js')
  const { LocaleRuntime } = await importSdk('packages/client/locale/lib/types/client/index.js')
  const { ClientCordisInspectRegistry, provideClientCordisInspect } = await importSdk('packages/extensions/cordis-client-runner/lib/types/client/inspect-registry.js')
  function loadClient(source = inputSource) {
    let factory
    vm.runInNewContext(source, {
      window: { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } },
      document: dom.window.document, navigator: dom.window.navigator,
      AbortController, setTimeout, clearTimeout, console, Blob, URL, fetch: denyNetwork,
    }, { filename: clientFile })
    assert.equal(typeof factory, 'function')
    const loaded = factory((name) => {
      if (name === 'react') return React
      if (name === 'zod') return pluginRequire('zod')
      throw new Error('Unexpected browser module: ' + name)
    })
    assert.deepEqual(Array.from(loaded.METHOD_NAMES), methods)
    assert.equal(loaded.CONTRIBUTION.descriptors.length, 11)
    assert.deepEqual(Array.from(loaded.CONTRIBUTION.descriptors.filter(d => d.namespace === 'wechatRo'), d => d.method), methods)
    assert.deepEqual(Array.from(loaded.CONTRIBUTION.descriptors.filter(d => d.namespace === 'wechatConversation'), d => d.method), conversationMethods)
    return loaded
  }
  const client = loadClient()
  mutateNamespaceDeclaration(inputSource)

  async function mount(localeId, slotKey = 'main', withInspect = false, clientModule = client) {
    const ctx = new Context()
    const inspectManifests = []
    const inspectResults = []
    const inspectRegistry = withInspect ? new ClientCordisInspectRegistry({
      sync: async (providers) => { inspectManifests.push(JSON.parse(JSON.stringify(providers))) },
      resolve: async (agentId, requestId, resolution) => { inspectResults.push({ agentId, requestId, resolution: JSON.parse(JSON.stringify(resolution)) }) },
    }) : null
    if (inspectRegistry) {
      if (withInspect === 'collision') ctx.effect(() => inspectRegistry.register({
        manifest: { id: 'WechatRoClient', description: 'Controlled duplicate-ID regression only', methods: [{ name: 'getState', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object' } }] },
        query: async () => ({ controlledCollision: true }),
      }))
      provideClientCordisInspect(ctx, inspectRegistry)
    }
    const slots = new SlotRegistry(ctx)
    const core = slots._core
    // Identity is checked against the exact public import resolved for this
    // Registry, not the separately compiled lib/types SlotCore constructor.
    assert.equal(core instanceof RegistrySlotCore, true)
    assert.deepEqual(core.spec('root'), new SlotCore().spec('root'))
    const locale = new LocaleRuntime(ctx)
    ctx.reflect.provide('locale', locale)
    locale.setLocale(localeId)
    slots.install(createSlotRenderer())
    slots.installLocale(locale)
    const absent = Object.freeze({ key: undefined, hooks: {}, keyedHooks: {}, props: {} })
    const source = { getSnapshot: () => absent, subscribe: () => () => {} }
    slots.installScope('session', { current: source, bindingSource: () => source })
    const calls = Object.fromEntries(methods.concat(conversationMethods).map((method) => [method, 0]))
    const remoteRequests = []
    const fibers = []
    let publishUiFiber
    const uiPublished = new Promise(resolve => { publishUiFiber = resolve })
    const namespaceSequence = []
    let mounts = 0
    let metadataActive = false
    let metadataDisposals = 0
    ctx.on('internal/plugin', fiber => {
      fibers.push(fiber)
      if (fiber.runtime?.name === 'registerWechatUi') publishUiFiber(fiber)
      if (fiber.runtime?.name === namespaceKey) {
        assert.equal(metadataActive, true, 'real namespace provider must be created after contribution metadata')
        namespaceSequence.push('namespace-provider-created')
      }
    })
    // These are the only Gateway mocks: metadata registration plus an in-process
    // carrier that records and rejects every RPC. The Gateway's Service,
    // descriptors, tracing/getters, independent namespace provider Fiber and
    // withdrawal are actual SDK. A launcher never needs a status/data response.
    ctx.reflect.provide('typert', {
      remotes: {
        register: contribution => {
          assert.equal(contribution, clientModule.CONTRIBUTION)
          assert.equal(metadataActive, false)
          metadataActive = true
          mounts += 1
          namespaceSequence.push('metadata-mounted')
          return () => {
            metadataActive = false
            metadataDisposals += 1
            namespaceSequence.push('metadata-withdrawn')
          }
        },
      },
      contexts: { getClient: () => undefined },
    })
    ctx.reflect.provide('connection', {
      interactions: 'none', isLoopback: true,
      generation: source,
      start: denyNetwork,
      openWebSocket: denyNetwork,
      rpc: {
        open: denyNetwork,
        call: async (route, endpoint, payload, signal) => {
          remoteRequests.push({ route, endpoint })
          assert.equal(route, '/api')
          const descriptor = clientModule.CONTRIBUTION.descriptors.find(value => endpoint === value.namespace + '/' + value.method)
          assert.ok(descriptor, 'only contributed Remote methods are known to the offline carrier')
          calls[descriptor.method] += 1
          assert.equal(signal instanceof AbortSignal, true)
          assert.equal(typeof payload.args, 'object')
          assert.fail('lazy launcher must not invoke Remote: ' + endpoint)
        },
      },
    })
    const gatewayFiber = ctx.plugin(gatewayModule)
    await gatewayFiber
    assert.equal(ctx.get('remote') instanceof Service, true)
    assert.equal(ctx.get(namespaceKey), undefined, 'no leaf service may be provided before $mount metadata')
    const selected = []
    ctx.reflect.provide('layout', { selectPanel: (key) => { selected.push(key) } })
    const entryErrors = []
    const unlisten = core.onEntryError((key, entry, error, info) => {
      entryErrors.push({ key, entry, error, info })
      originalConsoleError('core.onEntryError', { key, options: entry.options, info }, error)
    })
    const entryKey = slotKey === 'main' ? 'wechat-ro' : 'dsh-wechat-ro'
    const disposeRoot = slots.register({
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        'sidebar.panellist': { kind: 'list', scope: 'root' },
        'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
        'tool.call.toolview': { kind: 'keyed', scope: 'root' },
      },
    }, (props) => props.renderSlot(slotKey, slotKey === 'main' ? {} : { view: 'summary' }, { entryKey }))
    const consumerFiber = ctx.plugin(clientModule)
    await consumerFiber
    assert.notEqual(consumerFiber.runtime, null, 'root apply would bypass Cordis injection guards')
    let uiWatchdog
    let uiFiber
    try {
      uiFiber = await Promise.race([
        uiPublished,
        new Promise((_, reject) => { uiWatchdog = setTimeout(() => reject(new Error('actual registerWechatUi Fiber was not published')), 3000) }),
      ])
    } finally { clearTimeout(uiWatchdog) }
    assert.equal(uiFiber.parent.fiber.uid, consumerFiber.uid)
    const namespaceFiber = fibers.find(fiber => fiber.runtime?.name === namespaceKey)
    console.log('FIBER_SETUP', JSON.stringify({ consumerUid: consumerFiber.uid, mounts, metadataActive, sequence: namespaceSequence, fibers: fibers.map(fiber => ({ uid: fiber.uid, name: fiber.runtime?.name, parentUid: fiber.parent.fiber.uid, state: fiber.state, inject: Object.keys(fiber.inject) })) }))
    assert.ok(uiFiber && namespaceFiber, 'actual consumer child and Gateway namespace provider must exist')
    // Parent loading is already settled. Awaiting its child here is safe;
    // production must not await that child from inside its own parent apply.
    await uiFiber.await()
    assert.equal(namespaceFiber.parent.fiber, gatewayFiber.ctx.fiber, 'Gateway owns the independent namespace branch')
    assert.equal(ctx.get(namespaceKey) instanceof Service, true)
    assert.equal(ctx.get(namespaceKey).constructor.name, 'RemoteNamespaceService')
    let ancestor = consumerFiber.ctx.fiber
    while (true) {
      assert.notEqual(namespaceFiber, ancestor, 'leaf must not be provided by any consumer ancestor')
      assert.equal(Object.hasOwn(ancestor.store ?? {}, namespaceKey), false, 'ancestor store would wrongly bypass the guard')
      if (!ancestor.runtime) break
      ancestor = ancestor.parent.fiber
    }
    const leafDeclared = Object.hasOwn(uiFiber.inject, namespaceKey)
    if (leafDeclared) assert.equal(uiFiber.store[namespaceKey].fiber, namespaceFiber)
    assert.equal(mounts, 1)
    assert.equal(metadataActive, true)
    assert.deepEqual(namespaceSequence, ['metadata-mounted', 'namespace-provider-created'])
    console.log('REAL_NAMESPACE_DI', JSON.stringify({ consumerUid: consumerFiber.uid, uiUid: uiFiber.uid, namespaceUid: namespaceFiber.uid, namespaceParentUid: namespaceFiber.parent.fiber.uid, leafDeclared, uiInject: Object.keys(uiFiber.inject), independent: true, sequence: namespaceSequence }))
    assert.equal(core.spec('main').kind, 'keyed')
    assert.equal(core.spec('main').scope, 'root')
    let view
    await act(async () => { view = render(slots.renderSlot('root', {})) })
    await act(async () => {})
    const ledger = core.snapshot(slotKey)
    console.log('REAL_HARNESS_PROBE', JSON.stringify({ locale: localeId, slot: slotKey, ledger, entryErrors: entryErrors.length, consoleSlotErrors: consoleErrors.filter(args => String(args[0]).startsWith('slot entry crashed')).length, calls, text: view.container.textContent }))
    let unmounted = false
    const unmount = () => { if (!unmounted) { view.unmount(); unmounted = true } }
    let requestNumber = 0
    const queryInspect = async (method = 'getState') => {
      assert.notEqual(inspectRegistry, null)
      const requestId = 'offline-inspect-' + (++requestNumber)
      const before = { ...calls }
      const beforeRequests = remoteRequests.length
      await inspectRegistry.query({ agentId: 'offline-test-agent', requestId, provider: 'WechatRoClient', method, input: {} })
      assert.deepEqual(calls, before, 'read-only inspect queries must not add any Remote calls')
      assert.equal(remoteRequests.length, beforeRequests, 'inspect must not attempt even an unknown Remote endpoint')
      const result = inspectResults.at(-1)
      assert.equal(result.agentId, 'offline-test-agent')
      assert.equal(result.requestId, requestId)
      return result.resolution
    }
    let consumerDisposed = false
    const disposeConsumer = async () => {
      if (consumerDisposed) return
      unmount()
      await consumerFiber.dispose()
      consumerDisposed = true
      assert.equal(metadataActive, false)
      assert.equal(metadataDisposals, 1)
      assert.equal(ctx.get(namespaceKey), undefined, 'actual Gateway namespace must be withdrawn with the consumer contribution')
      assert.equal(uiFiber.uid, null)
      assert.equal(namespaceFiber.uid, null)
      assert.equal(core.entries('main').some(entry => entry.options.key === 'wechat-ro'), false)
      assert.equal(core.entries('sidebar.panellist').some(entry => entry.options.id === 'wechat-ro'), false)
      assert.equal(core.entries('plugins.bundle.config').some(entry => entry.options.key === 'dsh-wechat-ro'), false)
    }
    return {
      ctx, consumerFiber, uiFiber, namespaceFiber, namespaceSequence, disposeConsumer,
      core, slots, locale, view, calls, remoteRequests, selected, entryErrors,
      inspectRegistry, inspectManifests, queryInspect, unmount,
      dispose: async () => {
        await disposeConsumer()
        unlisten()
        disposeRoot()
        await ctx.fiber.dispose()
      },
    }
  }

  function assertLauncher(test, localeId, slotKey) {
    assert.equal(test.entryErrors.length, 0, 'raw entry exceptions must not be suppressed')
    assert.equal(test.view.container.querySelector('[data-slot-error]'), null, 'entry abdication must fail the regression')
    assert.equal(test.core.snapshot(slotKey)[0].occupants[0].active, true)
    assert.deepEqual(test.core.entries('main').map(entry => entry.options.key), ['wechat-ro'], 'one main entry; no retired archive or Task management page')
    const panels = test.core.entries('sidebar.panellist')
    assert.deepEqual(panels.map(entry => entry.options.id), ['wechat-ro'], 'one WeChat navigation entry, not ordinary/Task modes')
    assert.equal(panels[0].options.label(), labels[localeId].panel, 'panel registration uses the SDK locale binding')
    assert.deepEqual(test.core.entries('plugins.bundle.config').map(entry => entry.options.key), ['dsh-wechat-ro'])
    const buttons = test.view.getAllByRole('button')
    assert.equal(buttons.length, 1, 'the surface contains only the shared native-sidebar launcher')
    const launcher = test.view.getByRole('button', { name: labels[localeId].launcher })
    assert.equal(launcher, buttons[0])
    assert.equal(launcher.disabled, true, 'no native capability means the launcher is disabled')
    assert.equal(test.view.container.querySelector('nav,[role="tablist"],[role="tab"],[role="switch"],form,input,textarea,select,table,#wechat-ro-view'), null, 'no retired dashboard, visible mode selector, data controls or second chat input')
    if (slotKey === 'main') {
      assert.equal(test.view.getByRole('heading', { name: labels[localeId].panel }).textContent, labels[localeId].panel)
      assert.equal(test.view.container.querySelectorAll('[data-panel="wechat-ro"]').length, 1)
      assert.equal(test.view.container.querySelector('[data-panel="wechat-ro"]').getAttribute('data-client-version'), expectedClientVersion)
    } else {
      assert.equal(test.view.getByText(client.__i18n[localeId].meta.description).textContent, client.__i18n[localeId].meta.description, 'configuration summary uses real SDK flattened meta.description')
      assert.equal(test.view.container.querySelector('[data-panel="wechat-ro"]'), null, 'configuration card does not embed a second management page')
      assert.equal(test.view.container.textContent.includes('meta.description'), false, 'nested display metadata must not leak untranslated locale keys')
    }
    assertNoRemoteCalls(test)
    assert.deepEqual(test.selected, [], 'mounting and disabled navigation never select the native center')
    return launcher
  }
  for (const localeId of ['en', 'zh']) {
    for (const slotKey of ['main', 'plugins.bundle.config']) {
      const test = await mount(localeId, slotKey)
      try {
        const launcher = assertLauncher(test, localeId, slotKey)
        await act(async () => { fireEvent.click(launcher) })
        assertLauncher(test, localeId, slotKey)
        const nextLocale = localeId === 'en' ? 'zh' : 'en'
        await act(async () => { test.locale.setLocale(nextLocale) })
        assertLauncher(test, nextLocale, slotKey)
        await act(async () => { fireEvent.click(test.view.getByRole('button', { name: labels[nextLocale].launcher })) })
        assertLauncher(test, nextLocale, slotKey)
      } finally { await test.dispose() }
      assertNoRemoteCalls(test, 'launcher disposal must not invoke Remote methods')
      console.log('PASS real Harness single-entry lazy launcher, locale switch, disabled native navigation and zero Remote calls:', localeId, slotKey)
    }
  }
  const observed = await mount('zh', 'main', true)
  let observedDisposed = false
  let disposeOther
  try {
    const manifests = observed.inspectManifests.at(-1)
    assertLauncher(observed, 'zh', 'main')
    assert.equal(manifests.length, 2)
    assert.deepEqual(manifests.map(manifest => manifest.id).sort(), ['WechatConversationClient', 'WechatRoClient'])
    for (const manifest of manifests) {
      assert.deepEqual(manifest.methods.map(method => method.name), ['getState'])
      assert.deepEqual(manifest.methods[0].inputSchema, { type: 'object', properties: {}, additionalProperties: false })
    }
    const initial = await observed.queryInspect()
    assert.equal(initial.ok, true)
    const state = initial.data
    assert.equal(state.clientVersion, '0.2.0')
    assert.equal(state.panel, 'wechat-ro')
    assert.equal(state.domConnected, true)
    assert.equal(state.domVersion, '0.2.0')
    assert.equal(observed.view.container.querySelector('[data-panel="wechat-ro"]').getAttribute('data-client-version'), state.domVersion)
    assert.deepEqual(state.tabs, [], 'retired dashboard navigation is not part of the launcher DOM')
    assert.deepEqual(state.rect, { x: 0, y: 0, width: 0, height: 0 })
    assert.equal(state.positiveVisibleBox, false, 'JSDOM has no layout: never certify this as visually visible')
    assert.equal(state.tab, 'overview')
    assert.equal(state.status, 'idle', 'lazy launcher has not requested archive status')
    assert.equal(state.snapshotEnabled, null, 'unread snapshot state is unknown, not an inferred permission')
    assert.equal(state.configured, null, 'unread configuration is unknown, not a status response')
    assert.equal(state.queriesEnabled, false)
    assert.equal(state.lastError, null)
    assert.equal(state.inspectError, null)
    assert.equal(state.openRequested, false)
    assert.deepEqual(observed.selected, [])
    assert.equal((await observed.queryInspect('not-a-method')).reason, 'method-missing')

    // Controlled metadata-only events through the actual SDK core. No fake
    // StoredEntry or replacement registry is used, and no entry is abdicated.
    const own = observed.core.entries('main').find(entry => entry.options.key === 'wechat-ro')
    const otherSlot = observed.core.entries('plugins.bundle.config')[0]
    await act(async () => { disposeOther = observed.slots.register({ name: 'main', key: 'offline-other-panel' }, () => null) })
    const other = observed.core.entries('main').find(entry => entry.options.key === 'offline-other-panel')
    assert.ok(own && other && otherSlot)
    console.log('CONTROLLED_CORE_ERROR_FILTER_PROBE: other slot and panel must be ignored; own main must be recorded without abdication')
    observed.core.reportEntryError('plugins.bundle.config', otherSlot, new Error('CONTROLLED_OTHER_SLOT_IGNORE'), { abdicate: false })
    assert.equal((await observed.queryInspect()).data.lastError, null)
    observed.core.reportEntryError('main', other, new Error('CONTROLLED_OTHER_PANEL_IGNORE'), { abdicate: false })
    assert.equal((await observed.queryInspect()).data.lastError, null)
    const ownError = new Error('CONTROLLED_NATIVE_UI_ERROR_ONLY_'.repeat(30))
    ownError.name = 'CONTROLLED_NAME_'.repeat(15)
    ownError.stack = ownError.message + '\n' + 'Controlled offline frame\n'.repeat(30)
    observed.core.reportEntryError('main', own, ownError, { abdicate: false })
    const recorded = (await observed.queryInspect()).data.lastError
    assert.equal(recorded.name, ownError.name.slice(0, 120))
    assert.equal(recorded.message, ownError.message.slice(0, 800))
    assert.equal(recorded.abdicated, false)
    assert.equal(recorded.stack.includes(ownError.message), true)
    assert.equal(recorded.message.length <= 800 && recorded.stack.length <= 1800, true)
    assert.equal(observed.core.entriesOfSlot('main').includes(own), true)
    assert.equal(observed.entryErrors.length, 3, 'all three controlled raw SDK events must be observable')
    await act(async () => { disposeOther() })
    disposeOther = null
    await act(async () => { observed.unmount() })
    const disconnected = (await observed.queryInspect()).data
    assert.equal(disconnected.domConnected, false)
    assert.equal(disconnected.domVersion, null)
    assert.equal(disconnected.rect, null)
    assert.equal(disconnected.positiveVisibleBox, false)
    assert.deepEqual(disconnected.tabs, [])
    await observed.dispose()
    observedDisposed = true
    assert.equal((await observed.queryInspect()).reason, 'provider-missing')
    assert.deepEqual(observed.inspectManifests.at(-1), [])
    assertNoRemoteCalls(observed, 'read-only inspect and its disposal must not invoke Remote methods')
    assert.deepEqual(observed.selected, [])
    console.log('PASS actual ClientCordisInspectRegistry registration/dispatcher, scoped owned-error filter, and provider disposal; no query adds Remote calls')
  } finally {
    if (disposeOther) await act(async () => { disposeOther() })
    if (!observedDisposed) await observed.dispose()
  }
  const collision = await mount('zh', 'main', 'collision')
  try {
    assertLauncher(collision, 'zh', 'main')
    assert.deepEqual((await collision.queryInspect()).data, { controlledCollision: true })
    assertNoRemoteCalls(collision, 'duplicate-provider handling must not invoke Remote methods')
    assert.deepEqual(collision.selected, [])
  } finally { await collision.dispose() }
  console.log('PASS actual SDK duplicate-provider registration does not abort required UI')
  assert.equal(consoleErrors.filter(args => String(args[0]).startsWith('slot entry crashed')).length, 0, 'the six positive cases must have no SDK slot crash')
  const guardMessage = 'cannot get property "remote.wechatRo" without inject'
  for (const slotKey of ['main', 'plugins.bundle.config']) {
    console.log('CONTROLLED_NAMESPACE_DI_MUTATION', JSON.stringify({ slot: slotKey, from: correctNamespaceDeclaration, to: genericNamespaceDeclaration, archivedBaseline: false }))
    const broken = await mount('zh', slotKey, true, loadClient(mutateNamespaceDeclaration(inputSource)))
    try {
      assert.deepEqual(Object.keys(broken.uiFiber.inject), ['remote'])
      assert.equal(Object.hasOwn(broken.uiFiber.store, namespaceKey), false)
      assert.equal(broken.entryErrors.length, 1)
      const failure = broken.entryErrors[0]
      assert.equal(failure.key, slotKey)
      assert.equal(failure.error.name, 'Error')
      assert.equal(failure.error.message, guardMessage, 'must come from the actual Cordis Reflect guard, not a handmade throw')
      assert.equal(failure.info.abdicated, true)
      assert.equal(broken.core.snapshot(slotKey)[0].occupants[0].active, false)
      assert.equal(broken.view.container.querySelector('[data-panel="wechat-ro"]'), null)
      assertNoRemoteCalls(broken, 'a guard failure precedes every status, data and conversation call')
      const state = (await broken.queryInspect()).data
      assert.equal(state.clientVersion, expectedClientVersion)
      assert.equal(state.domConnected, false)
      assert.equal(state.status, 'idle')
      assert.equal(state.queriesEnabled, false)
      if (slotKey === 'main') {
        assert.equal(state.lastError.message, guardMessage)
        assert.equal(state.lastError.abdicated, true)
      } else assert.equal(state.lastError, null, 'own-main diagnostics must not adopt a config-slot error')
      console.log('PASS controlled actual namespace guard:', JSON.stringify({ slot: slotKey, error: failure.error.message, abdicated: failure.info.abdicated, calls: broken.calls, independentProviderUid: broken.namespaceFiber.uid }))
    } finally { await broken.dispose() }
  }
  const namespaceSlotCrashes = consoleErrors.filter(args => String(args[0]).startsWith('slot entry crashed'))
  assert.equal(namespaceSlotCrashes.length, 2, 'only the two declared namespace counterfactuals may abdicate')
  for (const args of namespaceSlotCrashes) assert.equal(args[1].message, guardMessage)
  assert.equal(networkAttempts, 0)
  console.log('PASS actual SDK technical regression. No network/profile/snapshot IO. CSS is stubbed; this is not live GUI or visual verification.')
} finally {
  cleanup?.()
  dom?.window.close()
  cssHooks.deregister()
  console.error = originalConsoleError
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
}
