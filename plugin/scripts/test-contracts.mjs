// Public contract regression: real codecs, real synthetic results, runtime exports and package contents.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as wire from '../lib/wire.js'
import * as methods from '../lib/methods.js'
import * as controller from '../lib/controller.js'
import * as host from '../lib/typert.host.js'
import * as remote from '../lib/typert.remote-client.js'
import * as plugin from '../lib/index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(ROOT, 'package.json'))
const dev = createRequire(require.resolve('@deepseek-ai/dsh-typert-loader'))
const ts = dev('typescript')
const fixture = process.env.WECHAT_FIXTURE_DIR
assert.ok(fixture && existsSync(join(fixture, 'contact', 'contact.db')), 'explicit synthetic WECHAT_FIXTURE_DIR is required')
const base = mkdtempSync(join(tmpdir(), 'wechat-ro-contracts-'))
let factory
new Function('window', readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8'))({ __ModuleLoader__: { load: (spec) => { factory = spec.factory } } })
const client = factory((id) => {
  if (id === 'react') return { createElement: () => null }
  if (id === 'zod') return require('zod')
  throw new Error('Unexpected browser dependency: ' + id)
})
const store = methods.createContext({ snapshotDir: fixture })
const service = Object.assign(Object.create(controller.WechatRoService.prototype), { store })
const results = []
let assertions = 0
function check(condition, label) { assertions++; assert.ok(condition, label) }
function npmTestEnvironment(parent, { home, temporary, userconfig, globalconfig }) {
  // Only PATH is inherited. In particular, never clone case-variant npm/auth,
  // proxy, Node preload/CA, home, cache or configuration variables.
  return {
    PATH: parent.PATH, HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
  }
}
async function test(id, fn) {
  try { await fn(); results.push({ id, passed: true }); console.log('PASS ' + id) }
  catch (error) { results.push({ id, passed: false, error: String(error.stack || error) }); console.error('FAIL ' + id + String.fromCharCode(10) + (error.stack || error)); process.exitCode = 1 }
}
const requests = {
  status: {}, contacts: { limit: 2 }, sessions: { limit: 2 },
  messages: { session: 'wxid_alice', limit: 2, offset: 0 },
  searchMessages: { query: '会', limit: 2 }, timeline: { days: 30 },
  chatroomMembers: { room: '12345678@chatroom', limit: 2 },
  sql: { database: 'contact/contact.db', query: 'SELECT 1 AS answer', limit: 2 },
  buildExport: { format: 'json', scope: 'contacts', limit: 2 },
}
for (const spec of wire.METHOD_SPECS) {
  await test('codec / ' + spec.method, () => {
    const raw = wire.descriptorFor(spec)
    const descriptors = [
      ['wire', raw, raw.result],
      ['host', host.TYPERT.invocations.find((d) => d.method === spec.method), null],
      ['remote', remote.TYPERT_REMOTE.descriptors.find((d) => d.method === spec.method), null],
      ['browser', client.CONTRIBUTION.descriptors.find((d) => d.method === spec.method), null],
    ]
    const value = service[spec.method](requests[spec.method])
    check(value && typeof value.then === 'undefined', spec.method + ' direct method is synchronous')
    for (const [label, descriptor] of descriptors) {
      check(descriptor.id === raw.id && descriptor.cancellation.parameter === 'signal', label + ' identity/cancellation')
      check(descriptor.parameters[0].acceptsUndefined, label + ' omitted request is declared')
      const request = descriptor.parameters[0].codec.create()
      const response = descriptor.result.create()
      check(request.safeParse({}).success, label + ' accepts default object')
      check(request.safeParse(requests[spec.method]).success, label + ' accepts valid request')
      for (const invalid of [null, 42, 'wrong', [], { unexpected: true }]) check(!request.safeParse(invalid).success, label + ' rejects wrong request shape')
      for (const [field, kind] of Object.entries(spec.fields)) {
        const invalids = kind === 'number' ? ['2', NaN, Infinity, 1.5] : [2, null, []]
        if (field === 'limit') invalids.push(0, -1, 501)
        if (field === 'offset') invalids.push(-1, Number.MAX_SAFE_INTEGER + 1)
        if (field === 'days') invalids.push(0, 3651)
        if (field === 'format' || field === 'scope') invalids.push('not-a-choice')
        for (const invalid of invalids) check(!request.safeParse({ [field]: invalid }).success, label + ' rejects invalid ' + field)
      }
      const parsed = response.safeParse(value)
      check(parsed.success, label + ' accepts actual ' + spec.method + ' result: ' + (parsed.success ? '' : parsed.error.message))
      for (const invalid of [undefined, null, 1, 'bad', [], { notes: [] }]) check(!response.safeParse(invalid).success, label + ' rejects wrong result shape')
      check(!response.safeParse({ ...value, opaque: () => 1 }).success, label + ' rejects non-JSON result extras')
      const required = spec.method === 'status' ? ['read_at', 'captured_at', 'snapshot_id', 'capture_complete', 'capture_consistency']
        : spec.method === 'timeline' ? ['scan_complete', 'total_is_exact']
        : spec.method === 'buildExport' ? ['content', 'bytes', 'read_only'] : ['has_more', 'scan_complete', 'total_is_exact']
      for (const key of required) {
        const missing = { ...value }; delete missing[key]
        check(!response.safeParse(missing).success, label + ' rejects missing required ' + key)
      }
      if (spec.method === 'status') check(response.safeParse({ ...value, message_table_count: null, contact_rows: null, session_rows: null }).success, label + ' permits unknown counts')
    }
  })
}
await test('controller cancellation and runtime marker export', () => {
  check(controller.REMOTE_METHOD_DESCRIPTOR === '@deepseek-ai/dsh-typert-protocol/remote-methods', 'descriptor export exists at runtime')
  const abort = new AbortController(); abort.abort(new Error('SYNTHETIC_ABORT'))
  for (const name of wire.METHOD_NAMES) assert.throws(() => service[name](requests[name], abort.signal), /SYNTHETIC_ABORT/)
})
await test('config rejects invalid values without coercion', () => {
  assert.deepEqual(wire.normalizeConfig(undefined, fixture), { snapshotDir: fixture, snapshotEnabled: true, sourceRoot: '', maxRows: 500 })
  assert.deepEqual(wire.normalizeConfig({ snapshotEnabled: false, sourceRoot: 'informational-only' }, fixture), { snapshotDir: '', snapshotEnabled: false, sourceRoot: 'informational-only', maxRows: 500 })
  for (const config of [null, 1, [], { snapshotDir: '' }, { snapshotDir: 1 }, { snapshotEnabled: 'false' }, { snapshotEnabled: null }, { snapshotEnabled: 0 }, { sourceRoot: null }, { sourceRoot: 1 }, { maxRows: '2' }, { maxRows: 0 }, { maxRows: 501 }, { maxRows: 1.5 }, { maxRows: NaN }]) assert.throws(() => wire.normalizeConfig(config, fixture))
})
await test('every declared public runtime value exists', () => {
  const modules = { index: plugin, controller, wire, 'typert.host': host, 'typert.remote-client': remote, client }
  for (const [name, mod] of Object.entries(modules)) {
    const path = join(ROOT, 'lib', 'types', name + '.d.ts')
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    check(source.parseDiagnostics.length === 0, name + ' declarations parse')
    for (const node of source.statements) {
      if (ts.isExportAssignment(node)) { check('default' in mod, name + ' default export exists'); continue }
      if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) if (ts.isIdentifier(decl.name)) check(decl.name.text in mod, name + ' exports ' + decl.name.text)
      } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) check(node.name.text in mod, name + ' exports ' + node.name.text)
    }
  }
})
await test('offline package inventory has no dangling exported subpath', () => {
  const npmHome = mkdtempSync(join(base, 'npm-home-'))
  const npmTmp = mkdtempSync(join(base, 'npm-tmp-'))
  const npmCache = mkdtempSync(join(base, 'npm-cache-'))
  const userconfig = join(base, 'npm-userconfig.empty')
  const globalconfig = join(base, 'npm-globalconfig.empty')
  writeFileSync(userconfig, '', { flag: 'wx', mode: 0o600 })
  writeFileSync(globalconfig, '', { flag: 'wx', mode: 0o600 })
  // All hostile values/files below are generated fixtures, not personal configs.
  const hostileHome = mkdtempSync(join(base, 'npm-hostile-home-'))
  const hostileUser = join(hostileHome, '.npmrc')
  const hostileGlobal = join(hostileHome, 'global.npmrc')
  const hostilePreload = join(hostileHome, 'preload.cjs')
  for (const path of [hostileUser, hostileGlobal]) writeFileSync(path, 'registry=https://must-not-contact.invalid/\n_authToken=fixture-only-not-a-token\n', { flag: 'wx', mode: 0o600 })
  writeFileSync(hostilePreload, 'process.exit(86)\n', { flag: 'wx', mode: 0o600 })
  const hostileParent = {
    PATH: process.env.PATH, HOME: hostileHome, USERPROFILE: hostileHome,
    XDG_CONFIG_HOME: hostileHome, APPDATA: hostileHome,
    TMPDIR: hostileHome, TMP: hostileHome, TEMP: hostileHome,
    NPM_CONFIG_USERCONFIG: hostileUser, npm_config_userconfig: hostileUser,
    NPM_CONFIG_GLOBALCONFIG: hostileGlobal, npm_config_globalconfig: hostileGlobal,
    NPM_CONFIG_CACHE: hostileHome, npm_config_cache: hostileHome,
    NPM_CONFIG_PREFIX: hostileHome, npm_config_prefix: hostileHome,
    NPM_CONFIG_REGISTRY: 'https://must-not-contact.invalid/', npm_config_registry: 'https://must-not-contact.invalid/',
    NPM_TOKEN: 'fixture-only-not-a-token', NODE_AUTH_TOKEN: 'fixture-only-not-a-token', npm_config__authToken: 'fixture-only-not-a-token',
    NODE_OPTIONS: '--require=' + hostilePreload, NODE_EXTRA_CA_CERTS: hostileUser,
    HTTP_PROXY: 'http://must-not-contact.invalid:9', HTTPS_PROXY: 'http://must-not-contact.invalid:9', ALL_PROXY: 'http://must-not-contact.invalid:9',
  }
  // Calibrate the preload canary in Node only; it exits before any npm config load.
  const canary = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { cwd: base, env: hostileParent, encoding: 'utf8', timeout: 5000 })
  check(!canary.error && canary.status === 86 && canary.signal === null, 'hostile inherited Node preload is an effective synthetic canary')
  const npmEnv = npmTestEnvironment(hostileParent, { home: npmHome, temporary: npmTmp, userconfig, globalconfig })
  check(hostileParent.HOME === hostileHome && hostileParent.NODE_OPTIONS === '--require=' + hostilePreload, 'environment construction does not mutate its hostile input')
  const probe = JSON.parse(execFileSync(process.execPath, ['-e', "console.log(JSON.stringify({home:process.env.HOME,userconfig:process.env.npm_config_userconfig,globalconfig:process.env.npm_config_globalconfig,leaked:['NODE_OPTIONS','NODE_EXTRA_CA_CERTS','NPM_TOKEN','NODE_AUTH_TOKEN','npm_config__authToken','NPM_CONFIG_USERCONFIG','NPM_CONFIG_GLOBALCONFIG','NPM_CONFIG_CACHE','NPM_CONFIG_PREFIX','NPM_CONFIG_REGISTRY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'].filter(k=>Object.hasOwn(process.env,k))}))"], { cwd: base, encoding: 'utf8', env: npmEnv, timeout: 5000 }))
  check(probe.home === npmHome && probe.userconfig === userconfig && probe.globalconfig === globalconfig && probe.leaked.length === 0, 'actual child receives only owned HOME/config and no inherited auth/proxy/preload')
  check(Object.keys(npmEnv).sort().join(',') === ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_update_notifier', 'npm_config_audit', 'npm_config_fund'].sort().join(','), 'npm subprocess uses only the explicit environment allowlist')
  check([npmHome, npmTmp, npmCache].every((path) => dirname(path) === base) && new Set([npmHome, npmTmp, npmCache]).size === 3, 'npm HOME/TMP/cache are distinct owned directories')
  check([userconfig, globalconfig].every((path) => dirname(path) === base && readFileSync(path).length === 0), 'npm user/global configs are explicit empty owned files')
  // npm otherwise walks ancestor directories for project config, even with an isolated cwd/HOME.
  const pack = JSON.parse(execFileSync('npm', ['--prefix', base, '--cache', npmCache, '--userconfig', userconfig, '--globalconfig', globalconfig, 'pack', ROOT, '--dry-run', '--ignore-scripts', '--offline', '--json'], { cwd: base, encoding: 'utf8', env: npmEnv }))[0]
  const files = new Set(pack.files.map((f) => f.path))
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    for (const target of typeof entry === 'string' ? [entry] : Object.values(entry)) {
      const targets = target.includes('*') ? ['zh', 'en'].map((name) => target.replace('*', name)) : [target]
      for (const path of targets) check(files.has(path.replace(/^\.\//, '')), subpath + ' target packed: ' + path)
    }
  }
  check(!Object.hasOwn(pkg.exports, './src/*'), 'no non-runtime source subpath')
  check(!existsSync(join(ROOT, 'tsdown.config.ts')), 'unused broken pseudo-build preset removed')
  writeFileSync(join(base, 'package-inventory.json'), JSON.stringify(pack, null, 2) + String.fromCharCode(10), { flag: 'wx' })
})
const report = { schema: 1, artifact_directory: base, assertions, cases: results.length, failures: results.filter((r) => !r.passed).length, results }
writeFileSync(join(base, 'results.json'), JSON.stringify(report, null, 2) + String.fromCharCode(10), { flag: 'wx' })
console.log(JSON.stringify({ artifact_directory: base, cases: report.cases, assertions, failures: report.failures }))
