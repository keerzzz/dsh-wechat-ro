// Corrected-behaviour regressions, using the installed FS component and synthetic data only.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import * as plugin from '../lib/index.js'
import { buildExport } from '../lib/export.js'
import { createContext } from '../lib/methods.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(ROOT, 'package.json'))
const { Context } = require('@deepseek-ai/cordis')
const { default: LocalFileSystem } = await import(require.resolve('@deepseek-ai/dsh-fs-local'))
const fixture = process.env.WECHAT_FIXTURE_DIR
assert.ok(fixture && existsSync(join(fixture, 'contact', 'contact.db')), 'WECHAT_FIXTURE_DIR must point to an explicitly generated synthetic fixture')
const base = mkdtempSync(join(tmpdir(), 'wechat-ro-host-hardening-'))
const workspaceA = join(base, 'workspace-a')
const workspaceB = join(base, 'workspace-b')
const defaultDir = join(base, 'default-fs')
for (const dir of [workspaceA, workspaceB, defaultDir]) mkdirSync(dir)
const native = new LocalFileSystem(new Context(), { cwd: defaultDir, diffBasisMaxBytes: 10485760 })
const agent = { session: { id: 'synthetic-host-regression' } }
const results = []
async function test(id, fn) {
  try { await fn(); results.push({ id, passed: true }); console.log('PASS ' + id) }
  catch (error) { results.push({ id, passed: false, error: String(error.stack || error) }); console.error('FAIL ' + id + '\n' + (error.stack || error)); process.exitCode = 1 }
}
function setup({ cwd = workspaceA, snapshotDir = fixture, policy, fsOverrides = {} } = {}) {
  const calls = []
  const commands = []
  const tools = []
  const fs = new Proxy(native, { get(target, key) {
    if (Object.hasOwn(fsOverrides, key)) return fsOverrides[key]
    if (key === 'writeText') return async (...args) => { calls.push(args); return target.writeText(...args) }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const ctx = {
    fs,
    workingDirectory: { ensure: async (owner, signal) => { assert.equal(owner, agent); signal.throwIfAborted(); return typeof cwd === 'function' ? cwd() : cwd } },
    get: (name) => name === 'sandboxPolicy' && policy !== undefined ? { resolve: ({ session }) => { assert.equal(session, agent.session); return policy } } : undefined,
    commands: { register: (d) => { commands.push(d); return () => {} } },
    tools: { register: (d) => { tools.push(d); return () => {} } },
    effect: (fn) => fn(),
  }
  plugin.apply(ctx, { snapshotDir, maxRows: 500 })
  const execute = (options = {}, signal = new AbortController().signal) => tools[0].execute(options, { agent, signal })
  const command = (rawInput, signal = new AbortController().signal) => commands[0].handler({ rawInput, agent, signal, commandId: 'synthetic', attachments: [] })
  return { execute, command, calls, tools }
}
const isCode = (code) => (error) => error.code === code

await test('H01 mutable Session cwd, not provider default cwd', async () => {
  let cwd = workspaceA
  const h = setup({ cwd: () => cwd })
  const a = await h.execute({ format: 'json', scope: 'contacts' })
  cwd = workspaceB
  const b = await h.execute({ format: 'md', scope: 'sessions' })
  assert.equal(dirname(a.path), workspaceA)
  assert.equal(dirname(b.path), workspaceB)
  assert.deepEqual(readdirSync(defaultDir), [])
  assert.equal(JSON.parse(readFileSync(a.path, 'utf8')).scope, 'contacts')
  assert.deepEqual(h.calls.map((x) => x[2]), [{ kind: 'createIfAbsent' }, { kind: 'createIfAbsent' }])
})
await test('H02 repeated format/scope calls never overwrite', async () => {
  const h = setup()
  const outputs = await Promise.all([h.execute(), h.execute(), h.execute({ format: 'agents' })])
  assert.equal(new Set(outputs.map((o) => o.path)).size, 3)
  for (const out of outputs) assert.equal(Buffer.byteLength(readFileSync(out.path, 'utf8')), out.bytes)
})
await test('H03 collision uses native createIfAbsent guard', async () => {
  const path = join(workspaceA, 'existing-sentinel.md')
  writeFileSync(path, 'SENTINEL', { flag: 'wx' })
  const h = setup({ fsOverrides: { resolve: async (p, opts) => native.resolve(/^wechat-ro-/.test(p) ? path : p, opts) } })
  await assert.rejects(h.execute(), isCode('FS_NOT_OBSERVED'))
  assert.equal(readFileSync(path, 'utf8'), 'SENTINEL')
})
await test('H04 pre-cancelled tool and command write nothing', async () => {
  const h = setup()
  const controller = new AbortController()
  controller.abort(new Error('SYNTHETIC_CANCELLED'))
  await assert.rejects(h.execute({}, controller.signal), /SYNTHETIC_CANCELLED/)
  const command = await h.command('md library', controller.signal)
  assert.equal(command.kind, 'error')
  assert.match(command.text, /SYNTHETIC_CANCELLED/)
  assert.equal(h.calls.length, 0)
})
await test('H05 cancellation reaches native write', async () => {
  const controller = new AbortController()
  const before = readdirSync(workspaceA)
  const h = setup({ fsOverrides: { writeText: async (...args) => { assert.equal(args[3], controller.signal); controller.abort(new Error('CANCEL_BEFORE_WRITE')); return native.writeText(...args) } } })
  await assert.rejects(h.execute({}, controller.signal), { code: 'FS_ABORTED' })
  assert.deepEqual(readdirSync(workspaceA), before)
})
await test('H06 workspace equal to snapshot is rejected', async () => {
  const h = setup({ cwd: fixture })
  await assert.rejects(h.execute(), isCode('FS_PERMISSION_DENIED'))
  assert.equal(h.calls.length, 0)
})
await test('H07 lexical alias cannot bypass snapshot fence', async () => {
  const alias = join(base, 'snapshot-alias')
  symlinkSync(fixture, alias, 'dir')
  await assert.rejects(setup({ cwd: alias }).execute(), isCode('FS_PERMISSION_DENIED'))
})
await test('H08 similar directory prefix is not a false denial', async () => {
  const own = join(base, 'snapshot')
  const adjacent = own + '-exports'
  mkdirSync(adjacent)
  cpSync(fixture, own, { recursive: true })
  const out = await setup({ cwd: adjacent, snapshotDir: own }).execute()
  assert.equal(dirname(out.path), adjacent)
})
await test('H09 mapped path outside Session cwd is denied', async () => {
  const h = setup({ fsOverrides: { resolve: async (p, opts) => native.resolve(/^wechat-ro-/.test(p) ? join(workspaceB, p) : p, opts) } })
  await assert.rejects(h.execute(), isCode('FS_PERMISSION_DENIED'))
})
await test('H10 session policy read-only and standing root are honored', async () => {
  await assert.rejects(setup({ policy: { mode: 'read-only', workspaceRoot: workspaceA } }).execute(), isCode('FS_SANDBOX_DENIED'))
  await assert.rejects(setup({ cwd: workspaceB, policy: { mode: 'workspace-write', workspaceRoot: workspaceA } }).execute(), isCode('FS_SANDBOX_DENIED'))
  const policy = { mode: 'workspace-write', workspaceRoot: workspaceA }
  const h = setup({ policy })
  await h.execute()
  assert.equal(h.calls[0][4], policy)
})
await test('H11 unsupported mapping and missing confinement policy fail closed', async () => {
  await assert.rejects(setup({ fsOverrides: { processPathFromHostPath: () => undefined } }).execute(), /host-path mapping/)
  await assert.rejects(setup({ fsOverrides: { sandboxMode: 'workspace-write' } }).execute(), /sandboxPolicy/)
})
await test('H12 malformed command/config and absent Session fail explicitly', async () => {
  const h = setup()
  assert.equal((await h.command('json library 9999')).kind, 'error')
  assert.equal((await h.command('unknown-format')).kind, 'error')
  await assert.rejects(h.tools[0].execute({}), /Session/)
  assert.throws(() => plugin.apply({}, { maxRows: '500' }), /maxRows/)
})
await test('H13 absent snapshot export remains explicit, and does not overwrite', async () => {
  const h = setup({ snapshotDir: join(base, 'absent') })
  const out = await h.execute({ format: 'json' })
  const body = JSON.parse(readFileSync(out.path, 'utf8'))
  assert.equal(body.snapshot.ok, false)
  assert.ok(body.snapshot.notes.length > 0)
  assert.equal(body.snapshot.captured_at, null)
})

function assertIndex(content) {
  const lines = content.trimEnd().split('\n')
  const at = lines.indexOf('## Index')
  assert.ok(at >= 0)
  let refs = 0
  for (let i = at + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const ref = /^\s*- (.+) · L(\d+)$/.exec(lines[i])
    if (!ref) continue
    refs++
    assert.equal(lines[Number(ref[2]) - 1]?.replace(/^#{2,3} /, ''), ref[1], ref[0])
  }
  assert.ok(refs >= 4)
}
await test('H14 all sixteen formats/scopes have byte-accurate metadata', () => {
  const ctx = createContext({ snapshotDir: fixture })
  for (const scope of ['library', 'sessions', 'timeline', 'contacts']) {
    for (const format of ['md', 'json', 'txt', 'agents']) {
      const out = buildExport(ctx, { format, scope, limit: 1 })
      assert.equal(out.bytes, Buffer.byteLength(out.content))
      assert.ok(out.filename.includes('-' + format + '-'))
      if (format === 'json') {
        const body = JSON.parse(out.content)
        assert.equal(body.snapshot.read_at, body.snapshot.snapshot_time)
        assert.equal(body.snapshot.captured_at, null)
        assert.ok(Object.keys(body.query_quality).length > 0)
        if (scope === 'contacts') assert.equal(body.query_quality.contacts.truncated, true)
      }
      if (format === 'md' || format === 'agents') assertIndex(out.content)
      assert.ok(!out.content.includes('冻结于'))
    }
  }
})
await test('H15 generated hostile cell inputs preserve table and Index boundaries', () => {
  const atoms = ['|', '\n## DATA_HEADING', '\r\n', '<img src=x onerror=alert(1)>', '&copy;', '\x60bold\x60', '[link](javascript:noop)', '🙂', '\u2028', '\u0085', '\\', '"']
  for (let seed = 0; seed < 16; seed++) {
    const own = join(base, 'text-fixture-' + seed)
    cpSync(fixture, own, { recursive: true })
    const value = 'DATA_' + seed + atoms.map((_, i) => atoms[(i * 7 + seed) % atoms.length]).join('')
    assert.ok(value.includes(String.fromCharCode(10)), 'generated input must contain real line breaks')
    const db = new DatabaseSync(join(own, 'contact', 'contact.db'))
    db.prepare('UPDATE contact SET remark = ?').run(value)
    db.close()
    const ctx = createContext({ snapshotDir: own })
    for (const format of ['md', 'agents']) {
      for (const scope of ['contacts', 'sessions', 'library']) {
        const out = buildExport(ctx, { format, scope })
        assertIndex(out.content)
        assert.ok(!out.content.includes('\n## DATA_HEADING'))
        assert.ok(!out.content.includes('<img'))
        const rows = out.content.split('\n').filter((line) => line.startsWith('| '))
        const count = scope === 'sessions' ? 6 : 5
        const dataRows = rows.filter((line) => line.includes('DATA&#95;'))
        assert.ok(dataRows.length > 0)
        for (const row of dataRows) {
          assert.equal(row.split('|').length - 1, count)
          const decoded = row.split('|')[1].trim().replace(/<br>/g, String.fromCharCode(10)).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
          assert.equal(decoded, value.replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, String.fromCharCode(10)))
        }
      }
    }
  }
})
await test('H16 invalid direct export choices are not silently coerced', () => {
  const ctx = createContext({ snapshotDir: fixture })
  for (const options of [{ format: 'unknown' }, { scope: 'unknown' }, { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { limit: '2' }]) assert.throws(() => buildExport(ctx, options))
})
await test('H17 weakly-typed SQLite unread cells remain data in every export', () => {
  const own = join(base, 'unread-fixture')
  cpSync(fixture, own, { recursive: true })
  const value = 'UNREAD_DATA | extra' + String.fromCharCode(10) + '## UNREAD_HEADING'
  const db = new DatabaseSync(join(own, 'session', 'session.db'))
  try { db.prepare('UPDATE SessionTable SET unread_count = ? WHERE username = ?').run(value, 'wxid_alice') }
  finally { db.close() }
  const ctx = createContext({ snapshotDir: own })
  for (const scope of ['sessions', 'library']) {
    for (const format of ['md', 'agents', 'txt']) {
      const out = buildExport(ctx, { format, scope })
      writeFileSync(join(base, 'unread-' + scope + '-' + format + '.txt'), out.content, { flag: 'wx' })
      assert.ok(!out.content.includes(String.fromCharCode(10) + '## UNREAD_HEADING'), format + '/' + scope + ' must not create a data-controlled heading')
      if (format !== 'txt') {
        assertIndex(out.content)
        const row = out.content.split(String.fromCharCode(10)).find((line) => line.startsWith('| ') && line.includes('UNREAD'))
        assert.ok(row)
        assert.equal(row.split('|').length - 1, scope === 'sessions' ? 6 : 5)
      }
    }
    const payload = JSON.parse(buildExport(ctx, { format: 'json', scope }).content)
    assert.equal((payload.sessions || payload.top_sessions).find((row) => row.username === 'wxid_alice').unread, value)
  }
})
const report = { schema: 1, fixture: resolve(fixture), artifact_directory: base, corrected_behaviour_cases: results.length, failures: results.filter((x) => !x.passed).length, results }
writeFileSync(join(base, 'results.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ artifact_directory: base, cases: report.corrected_behaviour_cases, failures: report.failures }))
