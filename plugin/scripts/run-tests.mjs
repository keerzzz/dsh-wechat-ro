#!/usr/bin/env node
// One repeatable gate. Generates only private synthetic fixtures and temp artifacts.
// It never installs dependencies, rewires a profile, or rewrites checked-in declarations.
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PROJECT = dirname(ROOT)
const require = createRequire(join(ROOT, 'package.json'))
const only = process.argv[2] === '--only' ? process.argv[3] : undefined
if (process.argv.length > 2 && !only) throw new Error('Usage: node scripts/run-tests.mjs [--only <gate>]')
// Standalone gates use only this package's dependencies. SDK type gates keep
// their existing dependency requirement without loading it for unrelated tests.
const compiler = !only || ['declarations', 'consumer-types'].includes(only)
  ? require.resolve('typescript/bin/tsc') : undefined
const python = process.env.WECHAT_TEST_PYTHON || (existsSync(join(PROJECT, '.venv/bin/python')) ? join(PROJECT, '.venv/bin/python') : 'python3')
const base = mkdtempSync(join(tmpdir(), 'wechat-ro-plugin-tests-'))
const temporary = join(base, 'tmp')
mkdirSync(temporary, { mode: 0o700 })
const browserRuntime = process.env.WECHAT_UI_TEST_RUNTIME
const clientRequireFrom = process.env.WECHAT_CLIENT_REQUIRE_FROM || (browserRuntime ? join(browserRuntime, 'packages/client/ui-renderer/package.json') : undefined)
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: PROJECT,
  NODE_OPTIONS: ((process.env.NODE_OPTIONS || '') + ' --max-old-space-size=512').trim(), DEBUG_PRINT_LIMIT: '1000',
  ...(clientRequireFrom ? { WECHAT_CLIENT_REQUIRE_FROM: clientRequireFrom } : {}),
  WECHAT_FIXTURE_DIR: join(base, 'fixture'), WECHAT_SNAPSHOT_DIR: join(base, 'fixture'), TMPDIR: temporary }
const NL = String.fromCharCode(10)
const results = []
function run(label, executable, args, environment = env, cwd = ROOT) {
  if (only && label !== only && label !== 'synthetic-fixture') return
  console.log('RUN ' + label)
  const result = spawnSync(executable, args, { cwd, env: environment, encoding: 'utf8', timeout: 120000, maxBuffer: 6 * 1024 * 1024 })
  const log = (result.stdout || '') + (result.stderr || '') + (result.error ? String(result.error) + NL : '') + '[exit code: ' + result.status + ']' + NL
  const path = join(base, String(results.length + 1).padStart(2, '0') + '-' + label + '.log')
  writeFileSync(path, log, { flag: 'wx' })
  results.push({ label, exit_code: result.status, signal: result.signal, log: path, passed: result.status === 0 })
  if (result.status !== 0) { console.error(log); throw new Error(label + ' failed; subsequent gates were not run') }
  console.log('PASS ' + label)
}
try {
  run('synthetic-fixture', python, [join(PROJECT, 'tests/make_fixture.py')])
  if (!only || only === 'declarations') {
  const generated = join(base, 'generated-types')
  run('declarations', process.execPath, [compiler, '-p', join(ROOT, 'tsconfig.json'), '--outDir', generated])
  const emitted = readdirSync(generated, { recursive: true }).filter((p) => String(p).endsWith('.d.ts')).map(String).sort()
  const checkedIn = readdirSync(join(ROOT, 'lib/types'), { recursive: true }).filter((p) => String(p).endsWith('.d.ts')).map(String).sort()
  if (JSON.stringify(emitted) !== JSON.stringify(checkedIn)) throw new Error('Generated declaration inventory differs; run npm run types explicitly')
  for (const name of emitted) if (!readFileSync(join(generated, name)).equals(readFileSync(join(ROOT, 'lib/types', name)))) throw new Error('Stale declaration: ' + name + '; run npm run types explicitly')
  results.push({ label: 'declaration-parity', passed: true, files: emitted })
  }
  run('consumer-types', process.execPath, [compiler, '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', join(ROOT, 'scripts/test-types.ts')], env, base)
  for (const script of ['check-quality', 'check-structure', 'smoke-host', 'smoke-client', 'test-host-hardening', 'test-contracts', 'test-channel']) run(script, process.execPath, [join(ROOT, 'scripts', script + '.mjs')])
  for (const script of ['test-unconfigured-deployment', 'test-native-unconfigured', 'test-real-harness-client', 'test-weixin-api', 'test-weixin-media', 'test-weixin-channel', 'test-weixin-updates-diagnostic', 'test-weixin-dsh', 'test-weixin-admin', 'test-weixin-admin-ui', 'test-auto-connection', 'test-auto-share-scope', 'test-task-history', 'test-historical-drain', 'test-local-history', 'test-daily-cards']) run(script, process.execPath, ['--unhandled-rejections=strict', '--test', join(ROOT, 'scripts', script + '.mjs')])
  for (const script of ['test-archive-access', 'test-session-bridge', 'test-task-context', 'test-conversation-client', 'test-protocol-boundaries', 'test-conversation-host', 'test-qr-renderer']) run(script, process.execPath, ['--unhandled-rejections=strict', join(ROOT, 'scripts', script + '.mjs')])
  run('test-content-sources', process.execPath, [join(ROOT, 'scripts/test-content-sources.mjs')])
  run('test-content-analysis', process.execPath, [join(ROOT, 'scripts/test-content-analysis.mjs')])
  run('test-conversation-navigation-dispose', process.execPath, ['--unhandled-rejections=strict', join(ROOT, 'scripts/test-conversation-client.mjs')], { ...env, WECHAT_TEST_NAVIGATION_DISPOSE_PROBE: '1' })
  const data = join(base, 'data-evidence')
  mkdirSync(data, { mode: 0o700 })
  run('test-data-hardening', process.execPath, [join(ROOT, 'scripts/test-data-hardening.mjs')], { ...env,
    WECHAT_JS_TEST_EVIDENCE_ROOT: data, WECHAT_FIXTURE_DIR: join(data, 'fixtures'),
    WECHAT_SNAPSHOT_DIR: join(data, 'snapshot'), TMPDIR: join(data, 'tmp'), WECHAT_TEST_RUNTIME_DIR: join(ROOT, 'lib') })
  if (only && !results.some(result => result.label === only)) throw new Error('Unknown gate: ' + only)
} catch (error) {
  process.exitCode = 1
  results.push({ label: 'gate-error', passed: false, error: String(error.stack || error) })
}
const report = { schema: 1, artifact_directory: base, passed: process.exitCode !== 1, results,
  limits: ['Synthetic fixtures only; no live WeChat, credentials, GDB, active DSH profile or GUI was used.', 'Native browser and privileged pipeline regressions have separate isolated gates.'] }
writeFileSync(join(base, 'results.json'), JSON.stringify(report, null, 2) + NL, { flag: 'wx' })
console.log(JSON.stringify({ passed: report.passed, artifact_directory: base, completed_steps: results.length }))
