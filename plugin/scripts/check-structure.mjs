#!/usr/bin/env node
// Structure and behaviour check for dsh-wechat-ro.
//
// The plugin lives outside the DeepSeek Harness checkout, so it cannot rely on
// the harness build. This script is the substitute: it validates the package
// manifest, the profile patch, the typert manifests, the browser bundle and the
// read-only data path against a synthetic fixture, and it fails loudly if the
// hand-written client bundle drifts away from lib/wire.js.
//
// Run: node scripts/check-structure.mjs
// Needs: already installed DSH development dependencies and an explicitly
// generated synthetic WECHAT_FIXTURE_DIR. This script never changes dependencies.

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const FIXTURE = process.env.WECHAT_FIXTURE_DIR
if (!FIXTURE) throw new Error('Set WECHAT_FIXTURE_DIR to a generated synthetic fixture, or run npm test')

let checks = 0
let failures = 0

function section(title) {
  console.log('')
  console.log(title)
}
function ok(label) {
  checks += 1
  console.log('  ok    ' + label)
}
function fail(label, detail) {
  checks += 1
  failures += 1
  console.log('  FAIL  ' + label)
  if (detail !== undefined) {
    for (const line of String(detail).split('\n')) console.log('        ' + line)
  }
}
function check(label, condition, detail) {
  if (condition) ok(label)
  else fail(label, detail)
}
function eq(label, actual, expected) {
  check(label + ' = ' + JSON.stringify(expected), JSON.stringify(actual) === JSON.stringify(expected), 'actual: ' + JSON.stringify(actual))
}

// ---------------------------------------------------------------- module wiring

section('runtime wiring')
const requireFromPlugin = createRequire(join(ROOT, 'package.json'))
const requireFromDev = createRequire(requireFromPlugin.resolve('@deepseek-ai/dsh-typert-loader'))
ok('existing runtime dependencies resolve without installation or links')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const wire = await import(join(ROOT, 'lib', 'wire.js'))
const methods = await import(join(ROOT, 'lib', 'methods.js'))
const exporter = await import(join(ROOT, 'lib', 'export.js'))
const controllerModule = await import(join(ROOT, 'lib', 'controller.js'))
const hostManifest = await import(join(ROOT, 'lib', 'typert.host.js'))
const remoteManifest = await import(join(ROOT, 'lib', 'typert.remote-client.js'))
const protocol = await import(requireFromPlugin.resolve('@deepseek-ai/dsh-typert-protocol'))
const typertLoader = await import(requireFromPlugin.resolve('@deepseek-ai/dsh-typert-loader'))
ok('lib modules import (wire, methods, export, controller, typert.host, typert.remote-client)')

// ---------------------------------------------------------------- package.json

section('package.json')
eq('name', pkg.name, wire.PACKAGE_NAME)
eq('type', pkg.type, 'module')
eq('main', pkg.main, 'lib/index.js')
check('declares dsh.bundle.patch', pkg.dsh !== undefined && pkg.dsh.bundle !== undefined && pkg.dsh.bundle.patch === './cordis.patch.yml')
check('declares dsh.client.platform = web', pkg.dsh.client !== undefined && pkg.dsh.client.platform === 'web')
check('dsh.client.inject is a string array', Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.every((name) => typeof name === 'string'))
check('engines.dsh is a semver range', typeof pkg.engines.dsh === 'string' && pkg.engines.dsh.length > 0)
check('runtime DSH imports are explicit peer dependencies', ['@deepseek-ai/cordis', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-typert-protocol'].every((name) => typeof pkg.peerDependencies?.[name] === 'string'))

for (const subpath of ['.', './client', './typert', './remote', './wire', './controller', './cordis.patch.yml']) {
  const entry = pkg.exports[subpath]
  const target = typeof entry === 'string' ? entry : (entry && entry.default)
  check('exports ' + subpath + ' -> an existing file', typeof target === 'string' && existsSync(join(ROOT, target)), target)
}
// './locale/*.json' is a wildcard export, not a literal file: check the pattern
// shape and that both dictionaries the wildcard serves are present.
check('exports ./locale/*.json is a wildcard over real files', pkg.exports['./locale/*.json'] === './locale/*.json' && ['zh.json', 'en.json'].every((name) => existsSync(join(ROOT, 'locale', name))))

// Every typed subpath must resolve to an emitted declaration (tsc -p tsconfig.json).
for (const [subpath, entry] of Object.entries(pkg.exports)) {
  if (typeof entry !== 'object' || entry === null || typeof entry.types !== 'string') continue
  check('exports ' + subpath + ' types -> an emitted declaration', existsSync(join(ROOT, entry.types)), entry.types)
}
check('package.json types -> an emitted declaration', typeof pkg.types === 'string' && existsSync(join(ROOT, pkg.types)), pkg.types)

const libFiles = readdirSync(join(ROOT, 'lib'), { recursive: true })
  .map((entry) => String(entry))
  .filter((entry) => entry.endsWith('.js'))
  .map((entry) => 'lib/' + entry.split('\\').join('/'))
const covered = libFiles.filter((file) => pkg.files.includes(file) || (file.startsWith('lib/types/') && pkg.files.includes('lib/types/**/*.d.ts')))
eq('every lib/*.js file is listed in files[]', covered.length, libFiles.length)

// ---------------------------------------------------------------- profile patch

section('cordis.patch.yml')
const yaml = requireFromDev('js-yaml')
const patchText = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
const patch = yaml.load(patchText)
check('parses to a list', Array.isArray(patch))
check('has exactly one insert block', Array.isArray(patch) && patch.length === 1 && Array.isArray(patch[0].insert))
const rows = (patch[0] && patch[0].insert) || []
eq('inserts two safe query rows and one controlled Task preset', rows.length, 3)
eq('row ids', rows.map((row) => row.id), ['wechat-ro-commands', 'wechat-ro-remote', 'preset-dsh-wechat-task-v1'])
eq('row entries', rows.map((row) => row.name), ['dsh-wechat-ro', 'dsh-wechat-ro/controller', '@deepseek-ai/dsh-agent-preset'])
check('first installation never starts MCP', rows.every((row) => row.name !== '@deepseek-ai/dsh-mcp-client'))
for (const row of rows.slice(0, 2)) {
  eq('row ' + row.id + ' explicitly disables snapshot access', row.config?.snapshotEnabled, false)
  eq('row ' + row.id + ' stores only the supplied source metadata', row.config?.sourceRoot, '')
  check('row ' + row.id + ' has no guessed snapshot path', !Object.hasOwn(row.config || {}, 'snapshotDir'))
  const config = wire.normalizeConfig(row.config, '/SYNTHETIC_ENV_MUST_NOT_BE_READ')
  eq('row ' + row.id + ' suppresses environment fallback', config.snapshotDir, '')
}

const standalonePreset = yaml.load(readFileSync(join(ROOT, 'presets/native-conversation.patch.yml'), 'utf8'))
check('standalone preset uses the supported insert-array dialect', Array.isArray(standalonePreset) && standalonePreset.length === 1 && Array.isArray(standalonePreset[0]?.insert))
const compatibilityRows = standalonePreset[0]?.insert || []
eq('standalone compatibility preset has one declaration', compatibilityRows.length, 1)
const readonlyPreset = compatibilityRows.find(row => row.id === 'preset-dsh-wechat-native-ro-v1')
check('readonly compatibility preset is not installed by default', !rows.some(row => row.id === 'preset-dsh-wechat-native-ro-v1'))
eq('readonly compatibility preset stable id', readonlyPreset?.config?.id, 'dsh-wechat-native-ro-v1')
eq('readonly compatibility retains persistent private policy and native presentation only', readonlyPreset?.config?.plugins?.map(row => row.name), ['@deepseek-ai/dsh-agent-tool-presentation', 'dsh-wechat-ro/session-bridge-agent'])

// ---------------------------------------------------------------- optional controlled task preset

section('optional controlled task preset')
for (const subpath of ['./task-access', './task-session-agent', './task-session-bridge']) {
  const entry = pkg.exports[subpath]
  check('task entry is packaged: ' + subpath, typeof entry?.default === 'string' && existsSync(join(ROOT, entry.default)) && pkg.files.includes(entry.default.replace(/^\.\//, '')))
}
const taskPresetPath = 'presets/wechat-task.patch.yml'
check('task preset is exported and packaged', pkg.exports['./' + taskPresetPath] === './' + taskPresetPath && pkg.files.includes(taskPresetPath))
const taskPreset = yaml.load(readFileSync(join(ROOT, taskPresetPath), 'utf8'))
eq('task preset uses a separate persistent id', taskPreset[0]?.insert?.[0]?.config?.id, 'dsh-wechat-task-v1')
eq('task preset is exactly the bundled declaration', taskPreset[0]?.insert, [rows.find(row => row.id === 'preset-dsh-wechat-task-v1')])
eq('task preset reuses native presentation and deliverables', taskPreset[0]?.insert?.[0]?.config?.plugins?.map(row => row.name),
  ['@deepseek-ai/dsh-agent-tool-presentation', '@deepseek-ai/dsh-tool-present', 'dsh-wechat-ro/task-session-agent'])
eq('task preset freezes the native present file ceiling', taskPreset[0]?.insert?.[0]?.config?.plugins?.[1]?.config?.maxFiles, 4)
// These optional peers must stay on the same SDK line as the required ones, so a
// version bump cannot leave the task preset pinned to an SDK the rest left behind.
const sdkLine = pkg.peerDependencies?.['@deepseek-ai/dsh-agent']
check('required SDK peers declare one line', typeof sdkLine === 'string' && /^\^\d+\.\d+\.\d+/.test(sdkLine), sdkLine)
for (const name of ['@deepseek-ai/dsh-working-directory', '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-session-query', '@deepseek-ai/dsh-tool-present']) {
  check('task SDK dependency remains optional: ' + name, pkg.peerDependencies?.[name] === sdkLine && pkg.peerDependenciesMeta?.[name]?.optional === true,
    'declared ' + pkg.peerDependencies?.[name] + ', expected ' + sdkLine)
}
const taskAccess = await import(join(ROOT, 'lib/task-access.js'))
const taskPolicy = await import(join(ROOT, 'lib/task-session-agent.js'))
eq('task history uses its own versioned storage unit', [taskAccess.TASK_CONTEXT_SPEC.name, taskAccess.TASK_CONTEXT_SPEC.version, taskAccess.TASK_CONTEXT_SPEC.layout], ['wechat_task_contexts_v1', 1, 'per-record'])
check('task history rejects token/permission fields', !taskAccess.TASK_CONTEXT_SPEC.tables.tasks.valueSchema.safeParse({ createdAt: 0, workspace: null, mayContainData: false, consumed: [], token: 'synthetic', grant: true }).success)
eq('historical consent audit is independent from consumed-source proof', [taskAccess.TASK_HISTORY_AUDIT_SPEC.name, taskAccess.TASK_HISTORY_AUDIT_SPEC.version, taskAccess.TASK_HISTORY_AUDIT_SPEC.layout], ['wechat_task_history_consents_v1', 1, 'per-record'])
check('historical audit never accepts permission or message fields', !taskAccess.TASK_HISTORY_AUDIT_SPEC.tables.tasks.valueSchema.safeParse({ events: [], permission: true, body: 'synthetic' }).success)
check('historical state and drain regressions are in the unified gate', ['test-task-history', 'test-historical-drain'].every(name => readFileSync(join(ROOT, 'scripts/run-tests.mjs'), 'utf8').includes("'" + name + "'")))
eq('task policy declares its actual required services', taskPolicy.inject, ['tools', 'systemPrompt', 'sandboxPolicy', 'workingDirectory'])

// ---------------------------------------------------------------- optional self-owned administration

section('optional self-owned administration')
const adminEntry = pkg.exports['./weixin-admin']
eq('admin runtime export', adminEntry?.default, './lib/weixin-admin.js')
eq('admin declaration export', adminEntry?.types, './lib/types/weixin-admin.d.ts')
eq('admin example export', pkg.exports['./weixin-admin.cordis.example.yml'], './weixin-admin.cordis.example.yml')
check('Connection is an explicit optional peer', typeof pkg.peerDependencies?.['@deepseek-ai/dsh-client-connection'] === 'string' && pkg.peerDependenciesMeta?.['@deepseek-ai/dsh-client-connection']?.optional === true)
for (const asset of ['lib/weixin-admin.js', 'lib/weixin-admin-ui/admin.html', 'lib/weixin-admin-ui/admin.js', 'lib/weixin-admin-ui/admin.css', 'weixin-admin.cordis.example.yml']) {
  check('admin asset is present and packaged: ' + asset, existsSync(join(ROOT, asset)) && pkg.files.includes(asset))
}
const adminModule = await import(join(ROOT, 'lib/weixin-admin.js'))
eq('admin injects only authentication carrier and credentials', adminModule.inject, ['connection', 'credentials'])
check('admin Config implements the actual Cordis Standard Schema seam', typeof adminModule.Config['~standard']?.validate === 'function')
eq('admin config defaults disabled', adminModule.Config.parse(undefined).enabled, false)
eq('admin exact route count', adminModule.WEIXIN_ADMIN_ROUTES.length, 5)
check('admin has no message or recovery-discard route', adminModule.WEIXIN_ADMIN_ROUTES.every(route => ['/admin', '/admin.js', '/admin.css', '/status', '/action'].some(suffix => route.path === adminModule.WEIXIN_ADMIN_INFO.basePath + suffix)))
const adminRows = yaml.load(readFileSync(join(ROOT, 'weixin-admin.cordis.example.yml'), 'utf8'))
eq('manual admin example is one row', Array.isArray(adminRows) ? adminRows.length : -1, 1)
eq('manual admin example is not auto-enabled', adminRows?.[0]?.config?.enabled, false)
eq('manual admin example uses its own optional export', adminRows?.[0]?.name, 'dsh-wechat-ro/weixin-admin')
check('manual admin example passes real config validation', adminModule.Config.safeParse(adminRows?.[0]?.config).success)
check('historical bundle patch never enables admin', rows.every(row => row.id !== 'wechat-ro-weixin-admin' && !String(row.name).includes('weixin-admin')))

// ---------------------------------------------------------------- typert manifests

section('typert manifests')
// validateTypertManifest returns the narrowed contribution and throws on any
// defect, so a throw here means the hand-written manifest would be rejected by
// the loader at plugin mount time.
let validationError = ''
let contribution = null
try {
  contribution = typertLoader.validateTypertManifest(pkg.name, hostManifest.TYPERT)
} catch (error) {
  validationError = error && error.message ? error.message : String(error)
}
check('typert.host passes validateTypertManifest', validationError === '', validationError)
check('typert.host validation returns the owned contribution', contribution !== null && contribution !== undefined && contribution.package === pkg.name, JSON.stringify(contribution && contribution.package))
const hostInvocations = hostManifest.TYPERT.invocations
eq('host manifest exposes nine archive and two owner invocations', hostInvocations.length, wire.METHOD_SPECS.length + 2)
for (const descriptor of hostInvocations) {
  check('host descriptor ' + descriptor.id + ' is strict on the result', descriptor.result.mode === 'strict' && typeof descriptor.result.create === 'function')
  check('host descriptor ' + descriptor.id + ' is strict on every parameter', descriptor.parameters.every((parameter) => parameter.codec.mode === 'strict'))
}
const remoteDescriptors = remoteManifest.TYPERT_REMOTE.descriptors
eq('remote manifest exposes nine archive and two owner descriptors', remoteDescriptors.length, wire.METHOD_SPECS.length + 2)
check('remote descriptors carry strict codecs only', remoteDescriptors.every((descriptor) => descriptor.parameters.every((parameter) => parameter.codec.mode === 'strict') && descriptor.result.mode === 'strict'))
check('remote descriptors cancel through signal', remoteDescriptors.every((descriptor) => descriptor.cancellation !== undefined && descriptor.cancellation.parameter === 'signal'))

// ---------------------------------------------------------------- controller markers

section('controller remote markers')
const instance = Object.create(controllerModule.default.prototype)
const markers = protocol.remoteMethods(instance)
eq('marker count', markers.length, wire.METHOD_NAMES.length)
eq('marker methods', markers.map((marker) => marker.method), wire.METHOD_NAMES)
const parameterPattern = /^[$A-Z_a-z][$\w]*$/u
for (const marker of markers) {
  const descriptor = Object.getOwnPropertyDescriptor(controllerModule.default.prototype, marker.method)
  const fn = descriptor && descriptor.value
  check('marker ' + marker.method + ' has a prototype function', typeof fn === 'function')
  if (typeof fn !== 'function') continue
  const source = Function.prototype.toString.call(fn)
  const open = source.indexOf('(')
  const close = source.indexOf(')', open)
  const params = source.slice(open + 1, close).split(',').map((part) => part.trim()).filter(Boolean)
  check('marker ' + marker.method + ' uses plain identifier parameters', params.every((param) => parameterPattern.test(param)), source.slice(0, 80))
  check('marker ' + marker.method + ' keeps signal last', params.indexOf('signal') === -1 || params.indexOf('signal') === params.length - 1, JSON.stringify(params))
}

// ---------------------------------------------------------------- client bundle

section('client bundle')
const clientSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
let bundle = null
const fakeWindow = {
  __ModuleLoader__: {
    load(spec) {
      if (spec.id !== wire.PACKAGE_NAME) throw new Error('unexpected bundle id ' + spec.id)
      bundle = spec.factory
    },
  },
}
const fakeReact = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}
const fakeRequire = (name) => {
  if (name === 'react') return fakeReact
  if (name === 'zod') return requireFromPlugin('zod')
  throw new Error('client bundle required a module outside the table: ' + name)
}
const loadBundle = new Function('window', clientSource)
loadBundle(fakeWindow)
check('bundle registers itself on window.__ModuleLoader__', typeof bundle === 'function')
const client = bundle(fakeRequire)
check('bundle exports isPlugin', client.isPlugin === true)
eq('bundle inject list', client.inject, ['remote', 'slots', 'locale', 'layout'])
eq('bundle wire tool names', client.WIRE_TOOL_NAMES, wire.WIRE_TOOL_NAMES)
eq('bundle method names', client.METHOD_NAMES, wire.METHOD_NAMES)
eq('bundle namespace', client.CONTRIBUTION.descriptors[0].namespace, wire.NAMESPACE)
const browserArchive = client.CONTRIBUTION.descriptors.filter(descriptor => descriptor.namespace === wire.NAMESPACE)
eq('bundle archive descriptor ids', browserArchive.map((descriptor) => descriptor.id), wire.METHOD_NAMES.map((method) => wire.PACKAGE_NAME + '#' + wire.NAMESPACE + '/' + method))
eq('bundle owner descriptor ids', client.CONTRIBUTION.descriptors.filter(descriptor => descriptor.namespace === 'wechatConversation').map(descriptor => descriptor.id), ['dsh-wechat-ro#wechatConversation/getConversationState', 'dsh-wechat-ro#wechatConversation/conversationAction'])
eq('bundle has exactly eleven unique descriptors', new Set(client.CONTRIBUTION.descriptors.map(descriptor => descriptor.id)).size, 11)
check('bundle descriptors are strict', client.CONTRIBUTION.descriptors.every((descriptor) => descriptor.result.mode === 'strict' && descriptor.parameters.every((parameter) => parameter.codec.mode === 'strict' && typeof parameter.codec.create === 'function')))
check('bundle descriptors cancel through signal', client.CONTRIBUTION.descriptors.every((descriptor) => descriptor.cancellation !== undefined && descriptor.cancellation.parameter === 'signal'))
check('bundle names no Host tool implementation', clientSource.indexOf('@deepseek-ai/') === -1, 'the browser bundle must not import Host packages')

// ---------------------------------------------------------------- locale parity

section('locale parity')
function flatten(value, prefix, out) {
  for (const key of Object.keys(value)) {
    const next = prefix === '' ? key : prefix + '.' + key
    const item = value[key]
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) flatten(item, next, out)
    else out.push(next)
  }
  return out
}
const zhFile = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'))
const enFile = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8'))
const zhKeys = flatten(zhFile, '', []).sort()
const enKeys = flatten(enFile, '', []).sort()
eq('zh and en dictionaries declare the same keys', zhKeys, enKeys)
if (client.__i18n !== undefined) {
  eq('bundle zh dictionary matches locale/zh.json', flatten(client.__i18n.zh, '', []).sort(), zhKeys)
  eq('bundle en dictionary matches locale/en.json', flatten(client.__i18n.en, '', []).sort(), enKeys)
} else {
  fail('bundle exposes its dictionaries for the parity check', 'add exports.__i18n = { zh, en } at the end of lib/client.js')
}

// ---------------------------------------------------------------- read-only data path

section('read-only data path')
const snapshotSource = readFileSync(join(ROOT, 'lib', 'snapshot.js'), 'utf8')
const methodsSource = readFileSync(join(ROOT, 'lib', 'methods.js'), 'utf8')
check('snapshot declares SQLite readOnly:true', snapshotSource.indexOf('readOnly: true') !== -1)
check('snapshot declares PRAGMA query_only', snapshotSource.indexOf('query_only') !== -1)
check('snapshot source has no direct file-write API tokens; SQLite sidecars remain possible', ['writeFileSync', 'createWriteStream', 'appendFileSync', 'unlinkSync', 'renameSync'].every((token) => snapshotSource.indexOf(token) === -1))
check('methods source has no checked process API tokens', ['child_process', 'spawnSync', 'execSync'].every((token) => methodsSource.indexOf(token) === -1))
for (const file of ['snapshot.js', 'methods.js', 'export.js', 'controller.js']) {
  const source = readFileSync(join(ROOT, 'lib', file), 'utf8')
  check(file + ' has no checked browser-network API tokens', ['XMLHttpRequest', 'new WebSocket', 'sendBeacon'].every((token) => source.indexOf(token) === -1))
}

if (!existsSync(FIXTURE)) {
  fail('synthetic fixture exists', FIXTURE + ' (run: python3 ../tests/make_fixture.py)')
} else {
  const store = methods.createContext({ snapshotDir: FIXTURE, maxRows: 500 })
  const status = methods.status(store)
  check('fixture status is ok', status.ok === true, JSON.stringify(status.notes))
  check('fixture reports three databases', status.db_count === 3, JSON.stringify(status.dbs && status.dbs.map((db) => db.rel)))
  check('fixture reports a snapshot time', typeof status.snapshot_time === 'string' && status.snapshot_time.endsWith('+08:00'))
  const contacts = methods.contacts(store, {})
  check('fixture contacts resolve display names', Array.isArray(contacts.rows) && contacts.rows.length >= 4, JSON.stringify(contacts.rows))
  const sessions = methods.sessions(store, {})
  check('fixture sessions are sorted newest first', Array.isArray(sessions.rows) && sessions.rows.length >= 4 && sessions.rows.every((row, index, all) => index === 0 || (all[index - 1].last_epoch || 0) >= (row.last_epoch || 0)))
  const messages = methods.messages(store, { session: 'wxid_alice', limit: 5 })
  check('fixture messages resolve by username', messages.ok !== false && Array.isArray(messages.rows) && messages.rows.length > 0)
  const byName = methods.messages(store, { session: '爱丽丝', limit: 5 })
  check('fixture messages resolve by display name', byName.ok !== false && byName.rows.length === messages.rows.length)
  const search = methods.searchMessages(store, { query: '会' })
  check('fixture search reports scanned tables', typeof search.scanned_tables === 'number' && search.scanned_tables > 0)
  // Fixture messages have fixed October/November 2026 dates. Anchor this
  // relative-window check so passage of real time cannot age its rows out.
  const realNow = Date.now
  let timeline
  try { Date.now = () => Date.parse('2026-11-05T00:00:00Z'); timeline = methods.timeline(store, { days: 30 }) }
  finally { Date.now = realNow }
  check('fixture timeline sums messages', typeof timeline.total_messages === 'number' && timeline.total_messages > 0)
  check('fixture timeline keeps five busiest hours', Array.isArray(timeline.busiest_hours) && timeline.busiest_hours.length === 5)
  const room = methods.chatroomMembers(store, { room: '12345678@chatroom' })
  check('fixture chatroom members resolve', Array.isArray(room.rows) && room.rows.length >= 3, JSON.stringify(room.rows))
  const select = methods.sql(store, { database: 'contact/contact.db', query: 'SELECT * FROM contact' })
  check('fixture sql accepts a single SELECT', select.ok !== false && Array.isArray(select.rows))
  // A rejected statement is reported as an empty page plus a note, exactly like
  // the Python service: the tool never throws and never surfaces rows.
  const update = methods.sql(store, { database: 'contact/contact.db', query: 'UPDATE contact SET nick_name = 1' })
  const updateNotes = (update.notes || []).join(' ')
  check('fixture sql rejects a write', update.rows.length === 0 && updateNotes.indexOf('只允许 SELECT') !== -1, JSON.stringify(update))
  const multi = methods.sql(store, { database: 'contact/contact.db', query: 'SELECT 1; DROP TABLE contact' })
  const multiNotes = (multi.notes || []).join(' ')
  check('fixture sql rejects a second statement', multi.rows.length === 0 && multiNotes.indexOf('分号') !== -1, JSON.stringify(multi))
  const placeholders = methods.sql(store, { database: 'contact/contact.db', query: 'SELECT * FROM contact WHERE user_name = ?' })
  check('fixture sql rejects placeholders', placeholders.rows.length === 0 && (placeholders.notes || []).join(' ').indexOf('?') !== -1, JSON.stringify(placeholders))
  const unknown = methods.callMethod(store, 'nope', {})
  check('unknown method is a failure, not a throw', unknown.ok === false)
  let exportFailures = 0
  for (const format of exporter.FORMATS) {
    for (const scope of exporter.SCOPES) {
      const built = exporter.buildExport(store, { format: format.id, scope: scope.id, limit: 50 })
      if (typeof built.content !== 'string' || built.content.length === 0 || built.read_only !== true) exportFailures += 1
      if (!built.filename.endsWith('.' + format.ext)) exportFailures += 1
    }
  }
  eq('all sixteen export combinations build', exportFailures, 0)
  const agents = exporter.buildExport(store, { format: 'agents', scope: 'library', limit: 50 })
  check('AGENTS.md export carries front matter and an index', agents.content.indexOf('---') === 0 && agents.content.indexOf('## Index') !== -1)
  // The snapshot directory is disclosed on purpose (it tells the reader which
  // frozen copy a claim came from) but credentials and ciphertext never are.
  check('export discloses the snapshot root as provenance', JSON.parse(exporter.buildExport(store, { format: 'json' }).content).snapshot.root === status.root)
  // Only real credential locations are forbidden. The boundary paragraph may
  // legitimately say it does NOT read key_info.dat, so that phrase stays legal.
  const forbidden = ['/root/.wcdb-key-tool', 'wechat-passphrase.json', 'encrypted_copy', 'WCD_PASS', 'passphrase.json']
  check('export never points at credential material', forbidden.every((token) => agents.content.indexOf(token) === -1))
  check('export states its read-only boundary', agents.content.indexOf('read_only: true') !== -1 || agents.content.indexOf('只读') !== -1)
}

// ---------------------------------------------------------------- summary

section('summary')
console.log('  checks: ' + checks + ', failures: ' + failures)
if (failures > 0) {
  console.log('')
  console.log('CHECK_STRUCTURE_FAILED')
  process.exit(1)
}
console.log('')
console.log('CHECK_STRUCTURE_OK')
