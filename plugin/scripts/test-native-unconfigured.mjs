// Pure offline launcher regression: real React effects in an in-memory DOM.
// The deleted six-view dashboard is not a supported UI. Native query/connection
// safety belongs to test-conversation-client.mjs; these launchers must do no IO.
// No page, browser, snapshot, profile, WeChat endpoint or QR renderer is used.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(scriptDir, '..')
const localRequire = createRequire(join(pluginDir, 'package.json'))
const runtimeRoot = process.env.WECHAT_UI_TEST_RUNTIME || '/REPLACE_WITH_DSH_CHECKOUT'
let runtimeRequire
let reactRequire
try {
  runtimeRequire = createRequire(join(runtimeRoot, 'package.json'))
  reactRequire = createRequire(runtimeRequire.resolve('@testing-library/react'))
  runtimeRequire.resolve('jsdom')
} catch (error) {
  throw new Error('Offline native UI regression needs existing Harness dev dependencies. Set WECHAT_UI_TEST_RUNTIME to its checkout; no dependencies will be installed.', { cause: error })
}
const { JSDOM } = runtimeRequire('jsdom')
const dom = new JSDOM()
const savedGlobals = new Map()
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
  savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
}
const React = reactRequire('react')
const { render, fireEvent, act, cleanup } = runtimeRequire('@testing-library/react')
let networkCalls = 0
const denyNetwork = () => { networkCalls += 1; throw new Error('Network is forbidden in this offline regression') }
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: denyNetwork })
dom.window.fetch = denyNetwork
dom.window.XMLHttpRequest = class { constructor() { denyNetwork() } }
dom.window.WebSocket = class { constructor() { denyNetwork() } }
const code = readFileSync(join(pluginDir, 'lib/client.js'), 'utf8')
let factory
vm.runInNewContext(code, {
  window: { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } },
  document: dom.window.document, navigator: dom.window.navigator,
  AbortController, setTimeout, clearTimeout, console, Blob, URL, fetch: denyNetwork,
}, { filename: 'offline-native-client.js' })
const client = factory((name) => {
  if (name === 'react') return React
  if (name === 'zod') return localRequire('zod')
  throw new Error('Unexpected browser import: ' + name)
})
const en = JSON.parse(readFileSync(join(pluginDir, 'locale/en.json'), 'utf8'))
const zh = JSON.parse(readFileSync(join(pluginDir, 'locale/zh.json'), 'utf8'))
const methods = ['status', 'contacts', 'sessions', 'messages', 'searchMessages', 'timeline', 'chatroomMembers', 'sql', 'buildExport']
assert.deepEqual(Array.from(client.METHOD_NAMES), methods)
assert.deepEqual(Array.from(client.inject), ['remote', 'slots', 'locale', 'layout'])
assert.equal(client.CONTRIBUTION.descriptors.length, 11)
assert.deepEqual(Array.from(client.CONTRIBUTION.descriptors.filter(d => d.namespace === 'wechatRo'), d => d.method), methods)
assert.deepEqual(Array.from(client.CONTRIBUTION.descriptors.filter(d => d.namespace === 'wechatConversation'), d => d.method), ['getConversationState', 'conversationAction'])
assert.deepEqual(JSON.parse(JSON.stringify(client.__i18n)), { zh, en })
assert.equal(client.CONVERSATION_TAB_ID, 'dsh-wechat-ro/conversation')
assert.equal(client.CONVERSATION_TAB_KIND, 'wechat-ro-conversation')
for (const key of ['TASK_PANEL', 'TASK_TAB_ID', 'TASK_TAB_KIND']) assert.equal(Object.hasOwn(client, key), false, key + ' must not restore a second UI entry')

const translate = (dict) => (key, params = {}) => {
  const value = Object.hasOwn(dict, key) ? dict[key] : key.split('.').reduce((current, part) => current && current[part], dict)
  assert.equal(typeof value, 'string', 'Missing locale key: ' + key)
  return value.replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? ''))
}
const envelope = (value) => ({ ok: true, value })
const fixture = (extra = {}) => ({
  ok: false, configured: false, snapshot_enabled: false,
  source_root: '/offline-metadata-only/' + 'long-source-name-'.repeat(20),
  root: '', snapshot_time: '', read_at: '', capture: null,
  captured_at: null, snapshot_id: null, capture_complete: null, capture_consistency: null,
  db_count: 0, dbs: [], contact_table: null, session_table: null,
  contact_rows: null, session_rows: null, message_db_count: null,
  message_table_count: null, indexed_message_table_count: null,
  message_table_count_is_exact: false, scan_complete: false,
  notes: ['Offline metadata only; no source was read or counted.'], ...extra,
})
function remote(status) {
  const calls = Object.fromEntries(methods.map((key) => [key, 0]))
  const api = {}
  for (const key of methods) api[key] = (request, signal) => {
    calls[key] += 1
    assert.equal(signal instanceof AbortSignal, true, key + ' needs cancellation')
    if (key === 'status') return typeof status === 'function' ? status(request, signal) : Promise.resolve(envelope(status))
    throw new Error('Launcher must not read data: ' + key)
  }
  return { api, calls }
}
// Isolated behavioral owner only. Actual Cordis namespace guards and native
// lifecycle/launcher authorization use the separate real-SDK regression suites.
async function register(api, dict) {
  const slots = []
  const selected = []
  const localeResources = new Map()
  const language = dict === en ? 'en' : 'zh'
  let mounts = 0
  await client.apply({
    inject(dependencies, applyScope) {
      const names = Array.from(dependencies)
      if (names[0] === 'remote.wechatConversation') {
        assert.deepEqual(names, ['remote.wechatConversation', 'connection', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace', 'sessions', 'uiSession', 'modelDirectories', 'layout'])
        return undefined // Missing native services must leave the launcher disabled.
      }
      assert.deepEqual(names, ['remote.wechatRo'])
      return applyScope(this)
    },
    remote: { wechatRo: api, $mount: (contribution) => { assert.equal(contribution, client.CONTRIBUTION); mounts += 1 } },
    effect: (effect) => effect(),
    locale: {
      register: (namespace, dictionaries) => { localeResources.set(namespace, dictionaries[language]); return () => localeResources.delete(namespace) },
      bind: namespace => translate(localeResources.get(namespace)),
    },
    layout: { selectPanel: (key) => { selected.push(key) } },
    slots: { inject: (_, registerSlot) => registerSlot(), register: (props, Component) => { slots.push({ props, Component }); return () => {} } },
  })
  assert.equal(mounts, 1)
  const panels = slots.filter((slot) => slot.props.name === 'main')
  const cards = slots.filter((slot) => slot.props.name === 'plugins.bundle.config')
  const left = slots.filter((slot) => slot.props.name === 'sidebar.panellist')
  assert.equal(panels.length, 1); assert.equal(cards.length, 1); assert.equal(left.length, 1)
  assert.equal(panels[0].props.key, 'wechat-ro')
  assert.equal(cards[0].props.key, 'dsh-wechat-ro')
  assert.equal(left[0].props.id, 'wechat-ro')
  assert.equal(left[0].props.label(), dict.panel)
  return { panel: panels[0], card: cards[0], selected }
}
const element = (slot, t, revision = 1) => React.createElement(slot.Component, { ...slot.props.inject(), t, revision })
const assertNoIO = (stub, registered) => {
  assert.deepEqual(stub.calls, Object.fromEntries(methods.map(method => [method, 0])), 'A launcher must not even read legacy status metadata')
  assert.deepEqual(registered.selected, [], 'Unavailable native services must not select a panel or create/select a Session')
  assert.equal(networkCalls, 0)
}
const assertSimpleLauncher = (view, metadata) => {
  assert.equal(view.container.querySelector('nav,[role="tablist"],[role="tab"]'), null, 'No legacy six-tab dashboard or data/assistant mode selector')
  assert.equal(view.container.querySelector('input,textarea,select,form,[data-snapshot-facts],[data-pairing-disabled]'), null)
  assert.equal(view.container.querySelector('[data-wechat-task-panel],[data-optional-bridge-session-id]'), null)
  assert.equal(view.container.querySelectorAll('button').length, 1, 'Only the explicit native-sidebar launch button is visible')
  const button = view.getByRole('button')
  assert.equal(button.disabled, true, 'Native services are absent; no fallback launcher authority is fabricated')
  for (const privateValue of [metadata.source_root, '777', '888', '999']) assert.equal(view.container.textContent.includes(privateValue), false)
  return button
}
let cases = 0

try {
  // Modern configured:false dominates even misleading successful/large-count
  // carriers. The launcher does not consume either response, let alone data.
  for (const dict of [en, zh]) for (const statusOk of [false, true]) {
    const metadata = fixture({ ok: statusOk, contact_rows: 777, session_rows: 888, message_table_count: 999 })
    const stub = remote(metadata), registered = await register(stub.api, dict), t = translate(dict)
    for (const slot of [registered.panel, registered.card]) {
      const view = render(element(slot, t))
      const button = assertSimpleLauncher(view, metadata)
      assert.equal(button.textContent, client.__conversationI18n[dict === en ? 'en' : 'zh'].launcher)
      if (slot === registered.panel) assert.equal(view.getByRole('heading', { level: 1 }).textContent, dict.panel)
      else assert.equal(view.container.textContent.includes(dict.meta.description), true)
      await act(async () => fireEvent.click(button))
      view.rerender(element(slot, t, 2))
      assertSimpleLauncher(view, metadata)
      view.unmount()
      assertNoIO(stub, registered)
      cases += 1
    }
  }

  // Neither a rejected nor indefinitely pending legacy status is ever started.
  // No stale status completion can revive the removed dashboard after unmount.
  for (const status of [() => Promise.reject(new Error('offline status failure')), () => new Promise(() => {})]) {
    const stub = remote(status), registered = await register(stub.api, en)
    const view = render(element(registered.panel, translate(en)))
    assertSimpleLauncher(view, fixture())
    view.unmount()
    await act(async () => {})
    assertNoIO(stub, registered)
    cases += 1
  }
  console.log(`PASS native launcher UI: ${cases} offline cases; one left entry, inert panel/config launchers, no mode/dashboard, zero status/data/model/channel IO, locale/9-method parity. Network calls: 0. Not live or visual verification.`)
} finally {
  cleanup()
  dom.window.close()
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch)
  else Reflect.deleteProperty(globalThis, 'fetch')
}
