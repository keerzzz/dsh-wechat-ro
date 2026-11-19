// Functional smoke test for the Host half (lib/index.js).
//
// Registration uses a small context stub; file writes use the installed real
// LocalFileSystem plus an explicit Session working directory. Only a generated
// synthetic fixture is read; outputs belong to a new private temp directory.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FIXTURE = process.env.WECHAT_FIXTURE_DIR
if (!FIXTURE) throw new Error('Set WECHAT_FIXTURE_DIR to a generated synthetic fixture, or run npm test')
const require = createRequire(join(ROOT, 'package.json'))
const { Context } = require('@deepseek-ai/cordis')
const { default: LocalFileSystem } = await import(require.resolve('@deepseek-ai/dsh-fs-local'))
const wire = await import(join(ROOT, 'lib', 'wire.js'))
const plugin = await import(join(ROOT, 'lib', 'index.js'))

let failures = 0
let checks = 0
function check(label, ok, detail) {
  checks += 1
  if (ok) { console.log('  ok    ' + label); return }
  failures += 1
  console.log('  FAIL  ' + label + (detail === undefined ? '' : '\n        ' + String(detail)))
}
function section(title) { console.log('\n' + title) }

const sandbox = mkdtempSync(join(tmpdir(), 'wechat-ro-host-'))

// ------------------------------------------------------------------ fake ctx

section('plugin shape')
check('exports a plugin name', plugin.name === 'wechat-ro')
check('declares its injected services', JSON.stringify(plugin.inject) === JSON.stringify(['commands', 'tools', 'fs', 'workingDirectory']))
check('exports apply()', typeof plugin.apply === 'function')
check('default export mirrors the named one', plugin.default && plugin.default.apply === plugin.apply)

section('apply() registration')
const commands = []
const tools = []
const effects = []
const agent = { session: { id: 'synthetic-smoke-host' } }
const execution = { agent, signal: new AbortController().signal }
const ctx = {
  commands: { register: (definition) => { commands.push(definition); return () => {} } },
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
  fs: new LocalFileSystem(new Context(), { cwd: sandbox, diffBasisMaxBytes: 10485760 }),
  workingDirectory: { ensure: async (owner, signal) => { if (owner !== agent) throw new Error('Unknown Session'); signal.throwIfAborted(); return sandbox } },
  get: () => undefined,
  effect: (fn, label) => { effects.push(label); const dispose = fn(); return dispose },
}
plugin.apply(ctx, { snapshotDir: FIXTURE, maxRows: 500 })
check('registers exactly one command', commands.length === 1, JSON.stringify(commands.map((c) => c.name)))
check('command is named wechat-export', commands[0] && commands[0].name === 'wechat-export')
check('command records no input', commands[0] && commands[0].recordInput === false)
check('registers exactly one tool', tools.length === 1, JSON.stringify(tools.map((t) => t.name)))
check('tool is named wechat_export', tools[0] && tools[0].name === wire.EXPORT_TOOL)
check('tool takes no required parameter', Array.isArray(tools[0].parameters.required) && tools[0].parameters.required.length === 0)

// ------------------------------------------------------------------ command

section('/wechat-export command')
const run = (rawInput) => commands[0].handler({ commandId: 'c', agent, rawInput, attachments: [], signal: new AbortController().signal })
const help = await run('help')
check('help returns success text', help.kind === 'success' && help.text.indexOf('用法') !== -1)
check('help lists every format', ['md', 'json', 'txt', 'agents'].every((id) => help.text.indexOf(id) !== -1))
check('help lists every scope', ['library', 'sessions', 'timeline', 'contacts'].every((id) => help.text.indexOf(id) !== -1))

const exported = await run('md sessions 20')
check('export returns success', exported.kind === 'success', exported.text)
check('export reports the written path', exported.text.indexOf(sandbox) !== -1, exported.text)
const commandFile = exported.text.split('→ ')[1].split('（')[0].trim()
check('exported file exists', existsSync(commandFile), commandFile)
const commandBody = readFileSync(commandFile, 'utf8')
check('exported markdown carries front matter', commandBody.startsWith('---'))
check('exported markdown names its scope', commandBody.indexOf('会话列表') !== -1)
check('exported markdown states the read-only boundary', commandBody.indexOf('只读') !== -1)
check('exported markdown never leaks credentials', ['/root/.wcdb-key-tool', 'wechat-passphrase.json', 'encrypted_copy'].every((token) => commandBody.indexOf(token) === -1))

const bad = await run('json library 9999')
check('an out-of-range limit fails explicitly', bad.kind === 'error', bad.text)

// ------------------------------------------------------------------ tool

section('wechat_export tool')
const toolResult = await tools[0].execute({ format: 'agents', scope: 'library', limit: 50 }, execution)
check('tool returns the output schema fields', ['path', 'filename', 'format', 'scope', 'bytes'].every((key) => Object.prototype.hasOwnProperty.call(toolResult, key)), JSON.stringify(toolResult))
check('tool reports read_only', toolResult.read_only === true)
check('tool wrote a real file', existsSync(toolResult.path), toolResult.path)
check('tool file size matches the reported bytes', Buffer.byteLength(readFileSync(toolResult.path, 'utf8')) === toolResult.bytes)
const agentsBody = readFileSync(toolResult.path, 'utf8')
check('AGENTS.md export starts with front matter', agentsBody.startsWith('---'))
check('AGENTS.md export carries an index', agentsBody.indexOf('## Index') !== -1)
check('AGENTS.md export carries the field dictionary', agentsBody.indexOf('字段字典') !== -1)
const rendered = tools[0].output.render({}, toolResult)
check('tool render returns one text block', Array.isArray(rendered) && rendered.length === 1 && rendered[0].type === 'text')
check('tool render names the file', rendered[0].text.indexOf(toolResult.path) !== -1)

const defaults = await tools[0].execute({}, execution)
check('tool works with no arguments', defaults.format === 'md' && defaults.scope === 'library', JSON.stringify(defaults))

// ------------------------------------------------------------------ missing snapshot

section('missing snapshot')
const missing = { ...ctx }
const missingTools = []
plugin.apply({ ...missing, tools: { register: (d) => { missingTools.push(d); return () => {} } } }, { snapshotDir: join(sandbox, 'nope') })
const missingResult = await missingTools[0].execute({ format: 'md' }, execution)
check('export still writes a file when the snapshot is absent', existsSync(missingResult.path), missingResult.path)
const missingBody = readFileSync(missingResult.path, 'utf8')
check('missing snapshot is reported in the export notes', missingBody.indexOf('nope') !== -1 && (missingBody.includes('不存在') || missingBody.includes('README')), missingBody.slice(0, 300))
check('missing snapshot keeps ok=false', missingBody.indexOf('| ok | false |') !== -1, missingBody.slice(0, 400))

rmSync(sandbox, { recursive: true, force: true })
console.log('\nsummary')
console.log('  checks: ' + checks + ', failures: ' + failures)
if (failures > 0) { console.log('SMOKE_HOST_FAILED'); process.exit(1) }
console.log('SMOKE_HOST_OK')