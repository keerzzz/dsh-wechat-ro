#!/usr/bin/env node
// Public-runner gates: one plugin package, one gate at a time, no DSH checkout.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runner = fileURLToPath(new URL('./run-tests.mjs', import.meta.url));
const gates = ['check-quality', 'test-weixin-api', 'test-weixin-channel', 'test-weixin-updates-diagnostic',
  'test-local-history', 'test-daily-cards', 'test-summary-model', 'test-summary-budget',
  'test-content-sources', 'test-content-analysis', 'test-archive-access', 'test-qr-renderer', 'test-package'];

for (const gate of gates) {
  const result = spawnSync(process.execPath, [runner, '--only', gate], {
    cwd: root, stdio: 'inherit', timeout: 150000,
  });
  if (result.error) process.stderr.write(result.error.message + '\n');
  if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
