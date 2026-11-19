import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createLocalHistory } from '../lib/local-history.js';

const row = index => ({ account_ref: 'a'.repeat(12), snapshot_directory: '/tmp/synthetic-history-' + index,
  captured_at: '2026-11-18T22:00:00+08:00', snapshot_id: 'a'.repeat(32), changed: true, database_count: 3 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(run, extra = {}) {
  const grants = [], updates = [];
  const manager = createLocalHistory({ data: { grantSnapshot: async (...args) => grants.push(args), refreshSnapshot: async (...args) => updates.push(args) },
    isIdle: () => true, run, ...extra });
  return { manager, grants, updates };
}
test('construction and stopped state perform no helper or data IO', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return row(1); });
  assert.equal(f.manager.state('task').enabled, false); await f.manager.beforeQuery('task');
  await f.manager.dispose(); assert.equal(calls, 0); assert.equal(f.grants.length, 0);
});
test('import grants once; changed refresh preserves authority and one snapshot per turn', async () => {
  let calls = 0; const leases=[]; const f = fixture(async (_command,_signal,_progress,lease) => {leases.push(lease);return row(++calls);});
  await f.manager.importHistory('task', { autoUpdate: true, allowWechat: true });
  await f.manager.beforeQuery('task', undefined, 1); await f.manager.beforeQuery('task', undefined, 1);
  assert.equal(calls, 2); assert.equal(f.grants.length, 1); assert.equal(f.updates.length, 1);
  assert.equal(leases[0].consumer,leases[1].consumer);assert.equal(leases[0].pinnedSnapshotId,null);assert.equal(leases[1].pinnedSnapshotId,row(1).snapshot_id);
  await f.manager.beforeQuery('task', undefined, 2); assert.equal(calls, 3);
  f.manager.stop('task'); await f.manager.beforeQuery('task'); assert.equal(calls, 3); await f.manager.dispose();
});
test('unchanged source skips data replacement; failed update retains last snapshot', async () => {
  let calls = 0; const f = fixture(async () => { calls++; if(calls===3)throw new Error('failure'); return row(1); });
  await f.manager.importHistory('task', { autoUpdate: true, allowWechat: false });
  await f.manager.refresh('task'); assert.equal(f.updates.length, 0);
  await f.manager.refresh('task'); assert.equal(f.manager.state('task').phase, 'failed');
  assert.equal(f.manager.state('task').capturedAt, row(1).captured_at); assert.equal(f.updates.length, 0); await f.manager.dispose();
});
test('concurrent checks share one helper and cancellation prevents data switch', async () => {
  const hold = deferred(); let calls = 0;
  const f = fixture(async () => { calls++; if(calls===2)await hold.promise; return row(calls); });
  await f.manager.importHistory('task', { autoUpdate: true, allowWechat: false });
  const first=f.manager.refresh('task'), second=f.manager.refresh('task');
  f.manager.stop('task'); hold.resolve(); await Promise.all([first,second]);
  assert.equal(calls,2);assert.equal(f.updates.length,0);await f.manager.dispose();
});
test('background interval checks idle tasks and stops on dispose', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls=0,idle=false; const f=fixture(async()=>row(++calls),{isIdle:()=>idle,intervalMs:1000});
  await f.manager.importHistory('task',{autoUpdate:true,allowWechat:false});
  t.mock.timers.tick(1000);await Promise.resolve();assert.equal(calls,1);
  idle=true;t.mock.timers.tick(1000);await Promise.resolve();await Promise.resolve();assert.equal(calls,2);
  await f.manager.dispose();t.mock.timers.tick(10000);assert.equal(calls,2);
});
test('background copy cannot switch after a native turn starts; the query installs it first', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hold=deferred(); let calls=0,idle=true;
  const f=fixture(async()=>{calls++;if(calls===2)await hold.promise;return row(calls);},{isIdle:()=>idle,intervalMs:1000});
  await f.manager.importHistory('task',{autoUpdate:true,allowWechat:false});
  t.mock.timers.tick(1000);idle=false;hold.resolve();
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  assert.equal(f.updates.length,0);
  await f.manager.beforeQuery('task',undefined,7);assert.equal(f.updates.length,1);
  await f.manager.beforeQuery('task',undefined,7);assert.equal(f.updates.length,1);
  await f.manager.dispose();
});
test('a waiting caller can cancel independently and stopping stays stopped',async()=>{
  const hold=deferred();let calls=0;
  const f=fixture(async()=>{calls++;if(calls===2)await hold.promise;return row(calls);});
  await f.manager.importHistory('task',{autoUpdate:true,allowWechat:false});
  const background=f.manager.refresh('task'),control=new AbortController();
  const query=f.manager.beforeQuery('task',control.signal,1);control.abort();
  await assert.rejects(query,/CANCELLED/);assert.equal(f.updates.length,0);
  f.manager.stop('task');hold.resolve();await background;
  assert.equal(f.manager.state('task').phase,'stopped');assert.equal(f.updates.length,0);await f.manager.dispose();
});
test('a missing local client has a fixed error and cannot grant or update archive data', async () => {
  const failure = Object.assign(new Error('Synthetic client unavailable'), { code: 'LOCAL_HISTORY_CLIENT_REQUIRED' });
  const f = fixture(async () => { throw failure; });
  await assert.rejects(f.manager.importHistory('task', { autoUpdate: true, allowWechat: true }), error => error === failure);
  assert.equal(f.manager.state('task').error, 'LOCAL_HISTORY_CLIENT_REQUIRED');
  assert.equal(f.manager.state('task').enabled, false);
  assert.equal(f.grants.length + f.updates.length, 0);
  await f.manager.dispose();
});
for (const code of ['LOCAL_HISTORY_CLIENT_REQUIRED', 'SYNTHETIC_PRIVATE_FAILURE']) test(`helper failure ${code} is typed before any source grant`, async () => {
  const url = 'synthetic:wechat-history-child-' + code;
  const output = JSON.stringify({ status: 'PREPARATION_FAILED', error_code: code }) + '\n';
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier === 'node:child_process' ? { url, shortCircuit: true } : next(specifier, context); },
    load(specifier, context, next) {
      if (specifier !== url) return next(specifier, context);
      return { format: 'module', shortCircuit: true, source: `import { EventEmitter } from 'node:events';
        export function spawn() { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          queueMicrotask(() => { child.stdout.emit('data', Buffer.from(${JSON.stringify(output)})); child.emit('close', 1); }); return child; }` };
    },
  });
  try {
    const { runLocalHistory } = await import('../lib/local-history.js?synthetic-helper-' + code);
    const expected = code === 'LOCAL_HISTORY_CLIENT_REQUIRED' ? code : 'LOCAL_HISTORY_FAILED';
    await assert.rejects(runLocalHistory('import'), error => error.code === expected && error.message === expected);
  } finally { hooks.deregister(); }
});
