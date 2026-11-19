// Fixed local helper; no process or source I/O before an authenticated import.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createHash } from 'node:crypto';

const helper = fileURLToPath(new URL('../runtime/prepare_local_history.py', import.meta.url));
const prepared = z.object({ account_ref: z.string().regex(/^[a-f0-9]{12}$/), snapshot_directory: z.string().startsWith('/'),
  captured_at: z.string(), snapshot_id: z.string().regex(/^[a-f0-9]{32}$/), changed: z.boolean(), database_count: z.number().int().min(3).max(31) });

export function runLocalHistory(command, signal, onProgress = () => {}, lease) {
  if (!['import', 'refresh'].includes(command) || signal?.aborted) return Promise.reject(new Error('CANCELLED'));
  return new Promise((resolve, reject) => {
    const args = [helper, '--managed', command];
    if (lease) {
      if (!z.string().uuid().safeParse(lease.consumer).success || lease.pinnedSnapshotId != null && !/^[a-f0-9]{32}$/.test(lease.pinnedSnapshotId)) { reject(new Error('INVALID_REQUEST')); return; }
      args.push('--consumer', lease.consumer);
      if (lease.pinnedSnapshotId) args.push('--pinned-snapshot', lease.pinnedSnapshotId);
    }
    const child = spawn('/usr/bin/python3', args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    let pending = '', result, failed = false, failureCode = 'LOCAL_HISTORY_FAILED', bytes = 0;
    const kill = () => { failed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timeout = setTimeout(kill, 300000);
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', chunk => {
      bytes += chunk.length; if (bytes > 65536) { kill(); return; }
      pending += chunk.toString('utf8');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.phase === 'ready') result = prepared.parse(event.result);
          else if (['authenticating', 'updating'].includes(event.phase)) onProgress(event.phase);
          else if (event.status === 'PREPARATION_FAILED') {
            failed = true;
            if (event.error_code === 'LOCAL_HISTORY_CLIENT_REQUIRED') failureCode = event.error_code;
          }
        } catch { failed = true; }
      }
    });
    child.stderr.on('data', () => {}); // Helper diagnostics can contain private paths.
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timeout); signal?.removeEventListener('abort', kill);
      if (signal?.aborted) reject(new Error('CANCELLED'));
      else if (failed || code !== 0 || !result) reject(Object.assign(new Error(failureCode), { code: failureCode }));
      else resolve(result);
    });
  });
}

export function createLocalHistory({ data, isIdle, intervalMs = 60000, run = runLocalHistory, onTick }) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) throw new Error('INVALID_REQUEST');
  const entries = new Map();
  let disposed = false;
  function state(id) {
    const value = entries.get(id);
    return { version: 1, enabled: value?.enabled === true, phase: value?.phase ?? 'not-imported',
      autoUpdate: value?.autoUpdate === true, capturedAt: value?.record?.captured_at ?? null,
      accountRef: value?.record?.account_ref ?? null,
      lastCheckedAt: value?.checked ?? null, databaseCount: value?.record?.database_count ?? 0, error: value?.error ?? null };
  }
  async function check(id, signal, initial = false, background = false) {
    const value = entries.get(id);
    if (!value?.enabled || disposed) return;
    if (value.pending) {
      if (!signal) return value.pending;
      signal.throwIfAborted();
      let cancelled;
      try { return await Promise.race([value.pending, new Promise((_, reject) => {
        cancelled = () => reject(new Error('CANCELLED')); signal.addEventListener('abort', cancelled, { once: true });
      })]); } finally { signal.removeEventListener('abort', cancelled); }
    }
    const control = value.control;
    const operationSignal = AbortSignal.any([control.signal, ...(signal ? [signal] : [])]);
    value.pending = (async () => {
      try {
        value.phase = 'checking'; value.error = null;
        const next = await run(initial ? 'import' : 'refresh', operationSignal, phase => { value.phase = phase; },
          { consumer: value.consumer, pinnedSnapshotId: value.record?.snapshot_id ?? null });
        operationSignal.throwIfAborted();
        if (value.record && value.record.account_ref !== next.account_ref) throw new Error('LOCAL_HISTORY_ACCOUNT_CHANGED');
        // A native turn may have started while the background copy was built.
        // Its first archive query will install the prepared copy before reading.
        if (background && !isIdle(id)) { value.phase = 'ready'; return; }
        if (initial) await data.grantSnapshot(id, { root: next.snapshot_directory, allConversations: true, talkers: [], fromTs: null, toTs: null,
          allowWechat: value.allowWechat, confirmation: 'read-decrypted-snapshot' }, operationSignal);
        else if (value.record?.snapshot_directory !== next.snapshot_directory) await data.refreshSnapshot(id, next.snapshot_directory, operationSignal);
        value.record = next; value.checked = Date.now(); value.phase = 'ready';
      } catch (error) {
        if (!value.enabled) return;
        value.error = operationSignal.aborted ? 'CANCELLED' : error?.code === 'LOCAL_HISTORY_CLIENT_REQUIRED' ? error.code : 'LOCAL_HISTORY_FAILED'; value.phase = 'failed';
        if (initial) { value.enabled = false; throw error; }
      } finally { value.pending = null; }
    })();
    return value.pending;
  }
  function schedule(id, value) {
    clearTimeout(value.timer);
    if (disposed || !value.enabled || !value.autoUpdate) return;
    value.timer = setTimeout(async () => {
      if (isIdle(id)) await check(id, undefined, false, true);
      if (isIdle(id) && value.enabled) await onTick?.(id);
      schedule(id, value);
    }, intervalMs);
    value.timer.unref?.();
  }
  async function importHistory(id, { autoUpdate, allowWechat }, signal) {
    const prior = entries.get(id);
    if (prior?.pending) throw new Error('BUSY');
    prior?.control.abort(); clearTimeout(prior?.timer);
    // A reload of this task in the same Host replaces its old cache lease.
    const leaseHash = createHash('sha256').update(process.pid + ':' + id).digest('hex');
    const consumer = [leaseHash.slice(0,8),leaseHash.slice(8,12),'4'+leaseHash.slice(13,16),'8'+leaseHash.slice(17,20),leaseHash.slice(20,32)].join('-');
    const value = { enabled: true, autoUpdate, allowWechat, phase: 'checking', record: prior?.record ?? null,
      consumer, control: new AbortController(), timer: null, pending: null, checked: null, error: null, turns: new Map() };
    entries.set(id, value);
    await check(id, signal, true); schedule(id, value);
    return state(id);
  }
  async function beforeQuery(id, signal, turn) {
    const value = entries.get(id);
    if (!value?.enabled || !value.autoUpdate) return;
    if (turn != null && value.turns.has(turn)) return;
    await check(id, signal);
    if (signal?.aborted) signal.throwIfAborted();
    if (turn != null) { value.turns.clear(); value.turns.set(turn, true); }
  }
  function stop(id) { const value = entries.get(id); if (value) { value.control.abort(); clearTimeout(value.timer); value.enabled = false; value.autoUpdate = false; value.phase = 'stopped'; } return state(id); }
  async function dispose() { disposed = true; for (const id of entries.keys()) stop(id); await Promise.allSettled([...entries.values()].map(value => value.pending).filter(Boolean)); }
  return Object.freeze({ importHistory, beforeQuery, refresh: check, state, stop, dispose });
}
