// Check the actual distribution, without a sibling checkout or install scripts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'wechat-package-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
    cwd: root, encoding: 'utf8', timeout: 60000,
  }))[0];
  execFileSync('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary]);
  const directory = join(temporary, 'package');
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-wechat-ro');
  assert.equal(manifest.version, packed.version);
  assert.ok(existsSync(resolve(directory, manifest.dsh.bundle.patch)), 'bundle patch must ship');
  assert.ok(existsSync(resolve(directory, manifest.main)), 'runtime entry must ship');
  assert.ok(existsSync(resolve(directory, manifest.types)), 'declarations must ship');
  // Tarball installation loads prebuilt files; it must not depend on prepare/build.
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(manifest.scripts?.[name], undefined);
  const targets = Object.values(manifest.exports);
  while (targets.length) {
    const target = targets.pop();
    if (typeof target === 'object') targets.push(...Object.values(target));
    else if (!target.includes('*')) assert.ok(existsSync(resolve(directory, target)), 'missing exported file: ' + target);
  }
  for (const entry of packed.files) {
    const filename = entry.path;
    assert.ok(!/(?:^|\/)(?:node_modules|audit|decrypted|\.snapshot|\.venv)(?:\/|$)|\.(?:db|sqlite|log)$/.test(filename), 'private or development file: ' + filename);
    assert.deepEqual(readFileSync(join(directory, filename)), readFileSync(join(root, filename)), 'packed bytes differ: ' + filename);
    if (!filename.endsWith('.js')) continue;
    const source = readFileSync(join(directory, filename), 'utf8');
    const references = [
      ...source.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g),
      ...source.matchAll(/new URL\s*\((['"])(\.[^'"]+)\1,\s*import\.meta\.url\)/g),
    ];
    for (const reference of references) {
      assert.ok(existsSync(resolve(directory, dirname(filename), reference[2])), filename + ' needs ' + reference[2]);
    }
  }
  for (const name of ['prepare_local_history.py', 'build_content_index.py', 'analyze_content.py', 'wcdb_key_tool.py', 'wcdb_runtime_keys.py', 'wcdb_live_snapshot.py']) {
    const source = join(root, '..', name.startsWith('wcdb_') ? 'vendor' : 'scripts', name);
    assert.deepEqual(readFileSync(join(directory, 'runtime', name)), readFileSync(source), 'stale runtime: ' + name);
  }
  assert.ok(readdirSync(join(directory, 'locale')).includes('zh.json'), 'client locale must ship');
  console.log(JSON.stringify({ passed: true, package: manifest.name + '@' + manifest.version, files: packed.files.length }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
