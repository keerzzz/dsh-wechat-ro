// Package the existing reviewed helper; the copies are generated artifacts.
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const destination = new URL('../runtime/', import.meta.url);
mkdirSync(destination, { recursive: true });
for (const [directory, name] of [['scripts', 'prepare_local_history.py'], ['scripts', 'build_content_index.py'], ['scripts', 'analyze_content.py'], ['vendor', 'wcdb_key_tool.py'], ['vendor', 'wcdb_runtime_keys.py'], ['vendor', 'wcdb_live_snapshot.py']]) {
  copyFileSync(fileURLToPath(new URL('../../' + directory + '/' + name, import.meta.url)), fileURLToPath(new URL(name, destination)));
}
