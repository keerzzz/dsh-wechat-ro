// Static browser-bundle smoke test using real installed React / react-dom/server.
// Explicit WECHAT_CLIENT_REQUIRE_FROM selects an existing dependency package;
// no active DSH profile, database, network, install or browser is accessed.
// SSR does not execute effects: asynchronous behavior and native Slot contracts
// are tested in test-conversation-client.mjs and test-real-harness-client.mjs.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const requireClient = createRequire(process.env.WECHAT_CLIENT_REQUIRE_FROM || join(ROOT, 'package.json'))
const React = requireClient('react')
const { renderToStaticMarkup } = requireClient('react-dom/server')
const wire = await import(join(ROOT, 'lib', 'wire.js'))

let failures = 0
let checks = 0
function check(label, ok, detail) {
  checks += 1
  if (ok) { console.log('  ok    ' + label); return }
  failures += 1
  console.log('  FAIL  ' + label + (detail === undefined ? '' : '\n        ' + String(detail)))
}
function section(title) { console.log('\n' + title) }

// ------------------------------------------------------------------ load bundle

section('bundle load')
const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
let factory = null
new Function('window', source)({ __ModuleLoader__: { load: (spec) => { factory = spec.factory } } })
check('factory registered', typeof factory === 'function')
const bundleRequire = (name) => {
  if (name === 'react') return React
  if (name === 'zod') return createRequire(join(ROOT, 'package.json'))('zod')
  throw new Error('bundle required ' + name + ', which is outside the client module table')
}
const client = factory(bundleRequire)
check('exports isPlugin', client.isPlugin === true)
check('non-sensitive current-data UI revision exported', client.DATA_SIDEBAR_REVISION === 'current-sse-data-v1')

// ------------------------------------------------------------------ fake context

section('apply() wiring')
const registrations = []
const effects = []
const dictionaries = []
const mounted = []
const namespaceDependencies = []
const remoteCalls = []
const bind = ns => (key, params = {}) => {
  const value = dictionaries.find(entry => entry.ns === ns)?.dicts.zh[key]
  return typeof value === 'string' ? value.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? '{' + name + '}')) : key
}
const fakeRemoteNamespace = {}
for (const method of wire.METHOD_NAMES) {
  fakeRemoteNamespace[method] = async () => { remoteCalls.push(method); return { ok: true, value: {} } }
}
const ctx = {
  inject: (dependencies, applyScope) => {
    const names = Array.from(dependencies)
    namespaceDependencies.push(names)
    // This legacy SSR carrier intentionally does not provide native Session/tab services.
    if (names[0] === 'remote.wechatConversation') return undefined
    return applyScope(ctx)
  },
  remote: {
    $mount: async (contribution) => {
      mounted.push(contribution)
      return async () => {}
    },
  },
  slots: {
    inject: (slot, callback) => { callback() },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
  locale: { register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} }, bind },
  effect: (fn, label) => { effects.push(label); const dispose = fn(); return dispose },
}
ctx.remote[wire.NAMESPACE] = fakeRemoteNamespace
const dispose = await client.apply(ctx)
check('apply resolves void; registration lifetime belongs to Owner', dispose === undefined)
check('mounts exactly one Remote contribution', mounted.length === 1)
check('UI enters exact old and new namespace-specific scopes', JSON.stringify(namespaceDependencies) === JSON.stringify([['remote.wechatConversation', 'connection', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace', 'sessions', 'uiSession', 'modelDirectories', 'layout'], ['remote.wechatRo']]))
check('contribution preserves all nine archive descriptors', mounted[0] && mounted[0].descriptors.filter(d => d.namespace === wire.NAMESPACE).length === wire.METHOD_NAMES.length)
check('one contribution contains eleven descriptors and exactly two owner actions', mounted[0] && mounted[0].descriptors.length === 11 && JSON.stringify(mounted[0].descriptors.filter(d => d.namespace === 'wechatConversation').map(d => d.method)) === JSON.stringify(['getConversationState', 'conversationAction']))
check('contribution package matches', mounted[0] && mounted[0].package === wire.PACKAGE_NAME)
check('registers each owned dictionary namespace exactly once', dictionaries.length === 3 && JSON.stringify(dictionaries.map(({ ns }) => ns)) === JSON.stringify(['wechat-ro', 'wechat-ro-conversation', 'wechat-task-assistant']))
const bySlot = (name) => registrations.filter((entry) => entry.options.name === name)
check('one sidebar entry', bySlot('sidebar.panellist').length === 1)
check('sidebar entry id is the panel key', bySlot('sidebar.panellist')[0].options.id === 'wechat-ro')
check('one main panel', bySlot('main').length === 1)
check('main panel key is the panel id', bySlot('main')[0].options.key === 'wechat-ro')
check('one plugin config card', bySlot('plugins.bundle.config').length === 1)
check('plugin config card key is the package name', bySlot('plugins.bundle.config')[0].options.key === wire.PACKAGE_NAME)
const toolviews = bySlot('tool.call.toolview')
check('nine tool result cards', toolviews.length === wire.WIRE_TOOL_NAMES.length, String(toolviews.length))
check('tool cards keyed by wire tool name', JSON.stringify(toolviews.map((entry) => entry.options.key).sort()) === JSON.stringify([...wire.WIRE_TOOL_NAMES].sort()))

// ------------------------------------------------------------------ rendering

section('static render')

// Match LocaleRuntime's literal-key lookup and use the registered namespace
// injections. The actual SlotCore/renderer contract is exercised separately.
const t = ctx.locale.bind('wechat-ro')
const conversationText = ctx.locale.bind('wechat-ro-conversation')
check('runtime dictionaries contain only flat string entries', dictionaries.every(({ dicts }) => Object.values(dicts).every((dict) => Object.values(dict).every((value) => typeof value === 'string'))))
check('runtime locale resolves dotted tab keys', t('tabs.overview') === '概览')

function useDisclosure() {
  const [expanded, setExpanded] = React.useState(false)
  return { expanded, setExpanded, toggle: () => setExpanded((open) => !open) }
}

function render(label, Component, props) {
  try {
    const html = renderToStaticMarkup(React.createElement(Component, { useDisclosure, ...props }))
    check(label + ' renders markup', html.length > 40, html.slice(0, 120))
    return html
  } catch (error) {
    check(label + ' renders markup', false, error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error))
    return ''
  }
}

const panelEntry = bySlot('main')[0]
const panelHtml = render('main panel', panelEntry.component, { t, locale: 'zh', ...panelEntry.options.inject() })
check('main panel uses the unified WeChat title', panelHtml.includes('>' + t('panel') + '</h1>'))
check('main panel contains one disabled native-sidebar launcher', panelHtml.includes(conversationText('launcher')) && (panelHtml.match(/<button\b/g) || []).length === 1 && panelHtml.includes('disabled=""'))
check('main panel has no duplicate navigation or permission forms', !/<(?:nav|form|select)\b|type="checkbox"|data-snapshot-facts/.test(panelHtml))
check('panel has no unresolved template output', ['NaN', 'undefined', '[object Object]'].every((token) => panelHtml.indexOf(token) === -1))

const Icon = bySlot('sidebar.panellist')[0].component
render('sidebar icon', Icon, { size: 20, active: false })

const configEntry = bySlot('plugins.bundle.config')[0]
const configHtml = render('plugin config card', configEntry.component, { t, view: 'page', ...configEntry.options.inject() })
check('config card reuses the same native-sidebar launcher', configHtml.includes(t('meta.description')) && configHtml.includes(conversationText('launcher')) && (configHtml.match(/<button\b/g) || []).length === 1 && configHtml.includes('disabled=""'))
check('config card has no duplicate data or permission controls', !/<(?:nav|form|select)\b|type="checkbox"|data-snapshot-facts/.test(configHtml))
check('config card never pretends a placeholder is a configured snapshot', !configHtml.includes('/REPLACE_WITH_PRIVATE_WECHAT_STATE/snapshot/decrypted') && !configHtml.includes('&lt;profile&gt;/wechat-ro/.snapshot/decrypted'))
check('launcher rendering performs no remote queries', remoteCalls.length === 0)

const ToolCard = toolviews[0].component
const runningHtml = render('tool card (running)', ToolCard, { t, phase: 'start', block: { argsRaw: '{"limit":5}' }, toolName: wire.WIRE_TOOL_NAMES[0] })
check('running tool card shows its state', runningHtml.indexOf('读取中') !== -1)
const settledHtml = render('tool card (result)', ToolCard, {
  t,
  phase: 'result',
  block: {
    kind: 'tool-result',
    isError: false,
    call: { name: wire.WIRE_TOOL_NAMES[0], argsRaw: '{}' },
    content: [{ type: 'text', text: '{"ok":true,"db_count":3,"contact_rows":5,"session_rows":4}' }],
  },
  toolName: wire.WIRE_TOOL_NAMES[0],
})
check('result tool card summarises the payload', settledHtml.indexOf('3') !== -1)
const failedHtml = render('tool card (error)', ToolCard, {
  t,
  phase: 'result',
  block: { kind: 'tool-result', isError: true, error: { name: 'ToolError', code: 'tool/failed' }, call: { name: wire.WIRE_TOOL_NAMES[0], argsRaw: '{}' }, content: [] },
  toolName: wire.WIRE_TOOL_NAMES[0],
})
check('failed tool card surfaces the error', failedHtml.indexOf('tool/failed') !== -1 || failedHtml.indexOf('失败') !== -1)

console.log('\nsummary')
console.log('  checks: ' + checks + ', failures: ' + failures)
if (failures > 0) { console.log('SMOKE_CLIENT_FAILED'); process.exit(1) }
console.log('SMOKE_CLIENT_OK')
