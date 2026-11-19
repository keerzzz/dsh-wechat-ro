import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTaskHistoryAuthority, TASK_HISTORY_AUDIT_SPEC, TASK_FIRST_TEXT_AUDIT_SPEC } from '../lib/task-history.js';

const previousFetch = globalThis.fetch;
let network = 0;
globalThis.fetch = () => { network++; throw new Error('OFFLINE_HISTORY_TEST'); };
after(() => { globalThis.fetch = previousFetch; assert.equal(network, 0); });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fail = code => { throw Object.assign(new Error('Synthetic history refusal'), { code }); };
function fixture(sharedRows = new Map()) {
  const id = `wechat-task-${randomUUID()}`, owner = {}, consumed = [{ sourceId: 'workspace', kind: 'directory', generation: randomUUID() }];
  const value = { prepared: true, historyKnown: true, workspace: { id: randomUUID(), root: '/synthetic/workspace', title: 'Synthetic' },
    cwd: '/synthetic/workspace', consumed, revision: 1, shareContext: false, sdkAvailable: true, sdkReady: true, sdkOwner: owner, sdkSequence: 1 };
  const meter = { opens: 0, writes: 0, closed: 0, sharingCloses: 0, hold: null, openHold: null, rejectWrites: false };
  const firstRows = new Map(), rowsBySpec = new Map([[TASK_HISTORY_AUDIT_SPEC, sharedRows], [TASK_FIRST_TEXT_AUDIT_SPEC, firstRows]]);
  const tableFor = (rows, spec) => ({
    get size() { return rows.size; }, get: key => rows.get(key),
    async put(key, record) { meter.writes++; if (meter.rejectWrites) throw new Error('Synthetic private error'); rows.set(key, spec.tables.tasks.valueSchema.parse(structuredClone(record))); },
    async update(key, update) {
      meter.writes++;
      if (meter.hold) { const hold = meter.hold; meter.hold = null; hold.entered.resolve(); await hold.release.promise; }
      if (meter.rejectWrites) throw new Error('Synthetic private error');
      rows.set(key, spec.tables.tasks.valueSchema.parse(structuredClone(update(rows.get(key)))));
    },
  });
  const table = tableFor(sharedRows, TASK_HISTORY_AUDIT_SPEC), firstTable = tableFor(firstRows, TASK_FIRST_TEXT_AUDIT_SPEC);
  const tables = new Map([[TASK_HISTORY_AUDIT_SPEC, table], [TASK_FIRST_TEXT_AUDIT_SPEC, firstTable]]);
  const options = { snapshot: () => value, storage: () => ({ async open(spec) { meter.opens++; if (meter.openHold) { const hold = meter.openHold; meter.openHold = null; hold.entered.resolve(); await hold.release.promise; } assert.ok(rowsBySpec.has(spec)); return { table: name => { assert.equal(name, 'tasks'); return tables.get(spec); }, async close() { meter.closed++; } }; } }),
    closeSharing() { value.shareContext = false; meter.sharingCloses++; }, openSharing() { value.shareContext = true; }, fail };
  const history = createTaskHistoryAuthority(options);
  return { id, value, meter, sharedRows, firstRows, table, firstTable, options, history };
}
const reject = (work, code) => assert.rejects(Promise.resolve().then(work), error => error.code === code);
async function authorize(f) {
  const reviewed = await f.history.review(f.id);
  const granted = await f.history.authorize(f.id, { reviewId: reviewed.reviewId, confirmation: 'authorize-reviewed-task-history-text' });
  return granted.receipt.consentId;
}
async function share(f, id) { return f.history.share(f.id, { historyConsentId: id, confirmation: 'share-reviewed-task-history-context' }); }
async function reserve(f, id, signal) { return f.history.reserve(f.id, { historyConsentId: id, confirmation: 'poll-one-text-reply-with-reviewed-history' }, signal); }

test('constructor and metadata status do not open storage or use the network', async () => {
  const f = fixture();
  try { assert.equal(f.meter.opens, 0); assert.equal(f.history.status(f.id).required, true); assert.equal(f.meter.opens, 0); }
  finally { await f.history.dispose(); }
});
for (const [name, change, reason] of [
  ['unprepared', value => { value.prepared = false; }, 'history-unavailable'],
  ['unknown proof', value => { value.historyKnown = false; }, 'history-unavailable'],
  ['SDK absent', value => { value.sdkAvailable = false; }, 'sdk-not-ready'],
  ['other source', value => { value.consumed.push({ sourceId: 'other', kind: 'session', generation: randomUUID() }); }, 'unsupported-sources'],
  ['changed workspace', value => { value.cwd = '/synthetic/other'; }, 'history-unavailable'],
]) test('unsupported history refuses before storage: ' + name, async () => {
  const f = fixture(); change(f.value);
  try { assert.equal(f.history.status(f.id).reason, reason); await reject(() => f.history.review(f.id), 'share-forbidden'); assert.equal(f.meter.opens, 0); }
  finally { await f.history.dispose(); }
});

test('historical approval closes an inherited sharing boolean but does not enable sharing', async () => {
  const f = fixture(); f.value.shareContext = true;
  try {
    const id = await authorize(f);
    assert.equal(f.value.shareContext, false); assert.equal(f.history.status(f.id).phase, 'approved');
    f.value.shareContext = true;
    await reject(() => reserve(f, id), 'share-forbidden');
    assert.equal(f.value.shareContext, false); assert.equal(f.history.status(f.id).consentId, null);
    const next = await authorize(f);
    await share(f, next); assert.equal(f.history.status(f.id).sharingConfirmed, true);
  } finally { await f.history.dispose(); }
});

test('a retained SDK lease needs capability identity, not idle acquisition readiness', async () => {
  const f = fixture();
  try {
    const id = await authorize(f); await share(f, id); const permit = await reserve(f, id);
    f.value.sdkReady = false;
    assert.equal(f.history.verify(permit), true);
    f.history.bindInput(permit, 'native-input', 1); f.history.bindInput(permit, 'native-input', 1);
    assert.throws(() => f.history.bindInput(permit, 'other-input', 1), error => error.code === 'share-forbidden');
    f.history.recordModelRequests(permit, 1); f.history.completeModel(permit);
    const done = await f.history.finish(permit, { outcome: 'replied', requestAccepted: 1 });
    assert.equal(done.receipt.modelRequestsReserved, 1); assert.equal(done.receipt.runOutcome, 'replied');
    assert.equal(done.receipt.sharingClosed, true); assert.equal(f.value.shareContext, false);
    assert.throws(() => f.history.verify(permit), error => error.code === 'aborted');
    f.value.sdkReady = true;
    await reject(() => reserve(f, id), 'share-forbidden');
  } finally { await f.history.dispose(); }
});

for (const outcome of ['empty', 'blocked', 'unknown']) test('every terminal path closes sharing and consumes the permit: ' + outcome, async () => {
  const f = fixture();
  try {
    const id = await authorize(f); await share(f, id); const permit = await reserve(f, id);
    const done = await f.history.finish(permit, { outcome, requestAccepted: 0 });
    assert.equal(done.receipt.permissionRevoked, true); assert.equal(done.receipt.sharingClosed, true);
    assert.equal(f.value.shareContext, false); assert.equal(f.history.status(f.id).consentId, null);
    await reject(() => reserve(f, id), 'share-forbidden');
    if (outcome === 'unknown') await reject(() => f.history.review(f.id), 'share-forbidden');
  } finally { await f.history.dispose(); }
});

test('SDK owner replacement and source revision change invalidate retained permissions', async () => {
  const f = fixture();
  try {
    const id = await authorize(f); await share(f, id);
    f.value.sdkOwner = {};
    assert.equal(f.history.status(f.id).consentId, null); assert.equal(f.value.shareContext, false);
    const next = await authorize(f); await share(f, next); const permit = await reserve(f, next);
    f.value.revision++;
    assert.throws(() => f.history.verify(permit), error => error.code === 'revoked');
    await f.history.finish(permit, { outcome: 'blocked', requestAccepted: 0 });
  } finally { await f.history.dispose(); }
});

test('an emergency revoke prevents late authorization from reinstalling a permit', async () => {
  const f = fixture();
  try {
    const reviewed = await f.history.review(f.id), hold = { entered: deferred(), release: deferred() };
    f.meter.hold = hold;
    const pending = f.history.authorize(f.id, { reviewId: reviewed.reviewId, confirmation: 'authorize-reviewed-task-history-text' });
    await hold.entered.promise;
    const revoked = f.history.revoke(f.id);
    hold.release.resolve();
    await reject(() => pending, 'revoked'); await revoked;
    assert.equal(f.history.status(f.id).consentId, null); assert.equal(f.value.shareContext, false);
  } finally { await f.history.dispose(); }
});

test('audit refusal cannot activate permission and does not prevent immediate revoke', async () => {
  const f = fixture();
  try {
    const id = await authorize(f); await share(f, id);
    f.meter.rejectWrites = true;
    const revoked = await f.history.revoke(f.id);
    assert.equal(revoked.receipt.permissionRevoked, true); assert.equal(revoked.receipt.auditOutcome, 'unknown');
    assert.equal(f.value.shareContext, false); assert.equal(f.history.status(f.id).executable, false);
  } finally { await f.history.dispose(); }
});

test('cold audit restoration never recreates consent and preserves unresolved run outcomes', async () => {
  const f = fixture();
  let restored;
  try {
    const id = await authorize(f); await share(f, id); await reserve(f, id);
    await f.history.dispose();
    restored = createTaskHistoryAuthority(f.options);
    assert.equal(restored.status(f.id).consentId, null);
    await reject(() => restored.review(f.id), 'share-forbidden');
    assert.equal(restored.status(f.id).reason, 'run-unresolved');
    assert.equal(restored.status(f.id).receipts[0].permissionRevoked, true);
  } finally { await restored?.dispose(); await f.history.dispose(); }
});

test('old literals and forged extra grant fields never form historical authority', async () => {
  const f = fixture();
  try {
    const reviewed = await f.history.review(f.id);
    await reject(() => f.history.authorize(f.id, { reviewId: reviewed.reviewId, confirmation: 'authorize-reviewed-task-history-text', allowWechat: true }), 'invalid-request');
    await reject(() => f.history.authorize(f.id, { reviewId: randomUUID(), confirmation: 'authorize-reviewed-task-history-text' }), 'share-forbidden');
    assert.equal(f.meter.writes, 0);
  } finally { await f.history.dispose(); }
});

test('a native context change invalidates review and an unanchored reserved run', async () => {
  const f = fixture();
  try {
    const reviewed = await f.history.review(f.id); f.value.sdkSequence++;
    await reject(() => f.history.authorize(f.id, { reviewId: reviewed.reviewId, confirmation: 'authorize-reviewed-task-history-text' }), 'share-forbidden');
    const id = await authorize(f); await share(f, id); const permit = await reserve(f, id);
    f.value.sdkSequence++;
    assert.throws(() => f.history.bindInput(permit, 'new-native-input'), error => error.code === 'revoked');
    const done = await f.history.finish(permit, { outcome: 'blocked' });
    assert.equal(done.receipt.modelRequestsReserved, 0); assert.equal(done.receipt.sharingClosed, true);
  } finally { await f.history.dispose(); }
});

test('the exact anchored native input can advance its own Session sequence', async () => {
  const f = fixture();
  try {
    const id = await authorize(f); await share(f, id); const permit = await reserve(f, id);
    f.history.bindInput(permit, 'native-input'); f.value.sdkSequence += 20;
    f.history.bindInput(permit, 'native-input', 1);
    assert.equal(f.history.verify(permit), true);
    f.history.recordModelRequests(permit, 1); f.history.completeModel(permit);
    await f.history.finish(permit, { outcome: 'replied', requestAccepted: 1 });
  } finally { await f.history.dispose(); }
});

test('receipt rotation and repeated revocation never forget an unknown run', async () => {
  const f = fixture();
  try {
    const id = await authorize(f); await share(f, id); const permit = await reserve(f, id);
    await f.history.finish(permit, { outcome: 'unknown' });
    for (let index = 0; index < 18; index++) await f.history.revoke(f.id);
    assert.equal(f.history.status(f.id).reason, 'run-unresolved');
    assert.equal(f.history.status(f.id).receipts.length, 16);
    await reject(() => f.history.review(f.id), 'share-forbidden');
  } finally { await f.history.dispose(); }
});

test('cold receipt inspection restores only audit facts and matching terminal outcomes', async () => {
  const f = fixture(); let restored;
  try {
    const reviewed = await f.history.review(f.id);
    const granted = await f.history.authorize(f.id, { reviewId: reviewed.reviewId, confirmation: 'authorize-reviewed-task-history-text' });
    const id = granted.receipt.consentId; await share(f, id); const permit = await reserve(f, id);
    await f.history.finish(permit, { outcome: 'empty', requestAccepted: 0 });
    const revokeId = randomUUID(); await f.history.revoke(f.id, { revokeId });
    await f.history.dispose(); restored = createTaskHistoryAuthority(f.options);
    const inspected = await restored.inspect(f.id);
    assert.equal(inspected.consentId, null); assert.equal(inspected.sharingConfirmed, false); assert.equal(inspected.executable, false);
    assert.ok(inspected.receipts.some(value => value.operation === 'audit' && value.reviewId === reviewed.reviewId && value.permissionRevoked));
    assert.ok(inspected.receipts.some(value => value.operation === 'audit' && value.revokeId === revokeId));
    assert.ok(inspected.receipts.some(value => value.operation === 'terminal' && value.runId === permit.runId && value.runOutcome === 'empty' && value.modelRequestsReserved === 0));
  } finally { await restored?.dispose(); await f.history.dispose(); }
});

test('late committed audit can settle its audit fact but never reinstall cancelled authority', async () => {
  const f = fixture();
  try {
    const reviewed = await f.history.review(f.id), hold = { entered: deferred(), release: deferred() }, controller = new AbortController();
    f.meter.hold = hold;
    const pending = f.history.authorize(f.id, { reviewId: reviewed.reviewId, confirmation: 'authorize-reviewed-task-history-text' }, controller.signal);
    await hold.entered.promise; controller.abort();
    await reject(() => pending, 'aborted');
    assert.equal(f.history.status(f.id).reason, 'audit-unresolved');
    hold.release.resolve(); await new Promise(resolve => setImmediate(resolve));
    const inspected = await f.history.inspect(f.id);
    assert.equal(inspected.consentId, null); assert.equal(inspected.sharingConfirmed, false);
    assert.notEqual(inspected.reason, 'audit-unresolved');
    assert.ok(inspected.receipts.some(value => value.operation === 'audit' && value.reviewId === reviewed.reviewId && value.auditOutcome === 'committed'));
  } finally { await f.history.dispose(); }
});

test('a valid Consent rejected before SDK acquisition is spent and sharing is closed', async () => {
  const f = fixture();
  try {
    const id = await authorize(f); await share(f, id); f.value.sdkReady = false;
    await reject(() => reserve(f, id), 'share-forbidden');
    const state = f.history.status(f.id), terminal = state.receipts.find(value => value.operation === 'terminal');
    assert.equal(f.value.shareContext, false); assert.equal(state.consentId, null);
    assert.equal(terminal.runOutcome, 'blocked'); assert.equal(terminal.modelRequestsReserved, 0); assert.equal(terminal.auditOutcome, 'committed');
    f.value.sdkReady = true; await reject(() => reserve(f, id), 'share-forbidden');
    const next = await authorize(f); await share(f, next);
    await reject(() => reserve(f, randomUUID()), 'share-forbidden');
    assert.equal(f.history.status(f.id).consentId, next); assert.equal(f.value.shareContext, true);
  } finally { await f.history.dispose(); }
});

test('review expiry during an authorization audit cannot install permission', async () => {
  const previousNow = Date.now, f = fixture(); let clock = previousNow();
  Date.now = () => clock;
  try {
    const reviewed = await f.history.review(f.id), hold = { entered: deferred(), release: deferred() };
    clock = reviewed.expiresAt - 1; f.meter.hold = hold;
    const pending = f.history.authorize(f.id, { reviewId: reviewed.reviewId, confirmation: 'authorize-reviewed-task-history-text' });
    await hold.entered.promise; clock = reviewed.expiresAt + 1; hold.release.resolve();
    await reject(() => pending, 'revoked');
    assert.equal(f.history.status(f.id).consentId, null); assert.equal(f.value.shareContext, false);
  } finally { Date.now = previousNow; await f.history.dispose(); }
});

test('cancelling the first audit-open waiter does not poison the shared handle', async () => {
  const f = fixture(), hold = { entered: deferred(), release: deferred() }, control = new AbortController();
  try {
    f.meter.openHold = hold;
    const pending = f.history.review(f.id, control.signal);
    await hold.entered.promise; control.abort(); await reject(() => pending, 'aborted');
    hold.release.resolve();
    const inspected = await f.history.inspect(f.id);
    assert.equal(inspected.consentId, null); assert.equal(inspected.supported, true);
    assert.ok((await f.history.review(f.id)).reviewId); assert.equal(f.meter.opens, 2);
  } finally { hold.release.resolve(); await f.history.dispose(); assert.equal(f.meter.closed, 2); }
});

function prefillAudit(f, count) {
  const runtimeId = randomUUID();
  f.sharedRows.set(f.id, { events: Array.from({ length: count }, () => ({ decisionId: randomUUID(), runtimeId, at: 0, operation: 'revoke',
    consentId: null, runId: null, reviewId: null, revokeId: randomUUID(), scope: null, outcome: 'revoked', requestAccepted: null, modelRequestsReserved: null })) });
}
for (const count of [60, 61, 62, 63]) test('audit capacity refuses a new approval before losing its terminal slot: ' + count, async () => {
  const f = fixture();
  try {
    prefillAudit(f, count); const reviewed = await f.history.review(f.id);
    await reject(() => f.history.authorize(f.id, { reviewId: reviewed.reviewId, confirmation: 'authorize-reviewed-task-history-text' }), 'history-unavailable');
    assert.equal(f.history.status(f.id).consentId, null); assert.equal(f.value.shareContext, false); assert.equal(f.sharedRows.get(f.id).events.length, count);
  } finally { await f.history.dispose(); }
});

test('the final reserved audit slot remains available through emergency revocation', async () => {
  const f = fixture();
  try {
    prefillAudit(f, 59);
    const id = await authorize(f); await share(f, id); const permit = await reserve(f, id);
    await f.history.revoke(f.id);
    const done = await f.history.finish(permit, { outcome: 'blocked', requestAccepted: 0 });
    assert.equal(done.receipt.auditOutcome, 'committed'); assert.equal(f.sharedRows.get(f.id).events.length, 64);
    assert.equal(f.sharedRows.get(f.id).events.at(-1).operation, 'terminal'); assert.equal(f.value.shareContext, false);
  } finally { await f.history.dispose(); }
});

function firstFixture() {
  const f = fixture();
  f.value.firstText = { available: true, ready: true, valid: true, owner: f.value.sdkOwner, reason: null,
    observation: Object.freeze({}), modelObservation: Object.freeze({}), preparation: null,
    model: { version: 1, provider: 'offline', model: 'first-text', selectionRevision: 1, configurationDigest: '0'.repeat(64),
      configuration: { stopSequenceCount: 0 }, defaults: { stopSequenceCount: 0 }, adapterDefaults: {},
      versions: { metadata: 1, configuration: 1, connection: 1, authenticationIdentity: 1 } } };
  return f;
}
async function firstAuthorize(f) {
  const reviewed = await f.history.firstText.review(f.id);
  const approved = await f.history.firstText.authorize(f.id, { reviewId: reviewed.reviewId, confirmation: 'authorize-reviewed-first-task-text' });
  return approved.receipt.consentId;
}
async function firstShare(f, id) { return f.history.firstText.share(f.id, { firstTextConsentId: id, confirmation: 'share-reviewed-first-task-text' }); }
async function firstReserve(f, id, signal) { return f.history.firstText.reserve(f.id, { firstTextConsentId: id, confirmation: 'poll-one-text-reply-with-first-task-text' }, signal); }

test('first-text terminal retains its reserved audit slot through queued revocations', async () => {
  const f = firstFixture(), hold = { entered: deferred(), release: deferred() }, queuedB = deferred();
  const update = f.firstTable.update.bind(f.firstTable);
  let tail = Promise.resolve(), nextQueued = null, revokeA, revokeB, terminal;
  // Match KvTable.update: capture at the queue slot, then await the backend write.
  f.firstTable.update = (key, transform) => {
    const work = tail.then(async () => {
      const next = transform(f.firstRows.get(key));
      await update(key, () => next);
      return f.firstRows.get(key);
    });
    tail = work.then(() => {}, () => {});
    nextQueued?.resolve(); nextQueued = null;
    return work;
  };
  try {
    prefillAudit(f, 59);
    const prior = f.sharedRows.get(f.id);
    f.firstRows.set(f.id, TASK_FIRST_TEXT_AUDIT_SPEC.tables.tasks.valueSchema.parse({
      events: prior.events.map(event => ({ ...event, purpose: 'first-text-once' })),
    }));
    f.sharedRows.delete(f.id);
    const consentId = await firstAuthorize(f);
    await firstShare(f, consentId);
    const permit = await firstReserve(f, consentId);
    assert.equal(f.firstRows.get(f.id).events.length, 62);

    const revokeAId = randomUUID(), revokeBId = randomUUID();
    f.meter.hold = hold;
    revokeA = f.history.firstText.revoke(f.id, { revokeId: revokeAId });
    await hold.entered.promise;
    nextQueued = queuedB;
    revokeB = f.history.firstText.revoke(f.id, { revokeId: revokeBId });
    await Promise.race([queuedB.promise, revokeB]);
    terminal = f.history.firstText.finish(permit, { outcome: 'blocked', requestAccepted: 0 });
    hold.release.resolve();
    const [revokedA, revokedB, done] = await Promise.all([revokeA, revokeB, terminal]);

    assert.equal(done.receipt.auditOutcome, 'committed');
    assert.equal(done.receipt.runOutcome, 'blocked');
    assert.equal(done.receipt.requestAccepted, 0);
    assert.equal(done.receipt.modelRequestsReserved, 0);
    assert.equal(done.receipt.permissionRevoked, true);
    assert.equal(done.receipt.sharingClosed, true);
    const events = f.firstRows.get(f.id).events;
    assert.equal(events.length, 64);
    const persisted = events.find(event => event.operation === 'terminal' && event.runId === permit.runId);
    assert.ok(persisted);
    assert.equal(persisted.outcome, 'blocked');
    assert.equal(persisted.requestAccepted, 0);
    assert.equal(persisted.modelRequestsReserved, 0);
    assert.equal(revokedA.receipt.revokeId, revokeAId);
    assert.equal(revokedA.receipt.auditOutcome, 'committed');
    assert.equal(revokedB.receipt.revokeId, revokeBId);
    assert.equal(revokedB.receipt.auditOutcome, 'unknown');
    for (const revoked of [revokedA, revokedB]) {
      assert.equal(revoked.receipt.permissionRevoked, true);
      assert.equal(revoked.receipt.sharingClosed, true);
      assert.equal(revoked.receipt.runOutcome, 'pending');
    }
    assert.equal(events.some(event => event.operation === 'revoke' && event.revokeId === revokeBId), false);
    assert.equal(f.value.shareContext, false);
    assert.equal(f.history.firstText.status(f.id).consentId, null);
  } finally {
    hold.release.resolve();
    await Promise.allSettled([revokeA, revokeB, terminal].filter(Boolean));
    await f.history.dispose();
  }
});

test('first-text metadata and an unselected model never open an audit or restore ordinary sharing', async () => {
  const f = firstFixture(); f.value.firstText.ready = false; f.value.firstText.valid = false; f.value.firstText.reason = 'model-not-selected';
  try {
    assert.equal(f.history.firstText.status(f.id).reason, 'model-not-selected');
    await reject(() => f.history.firstText.review(f.id), 'share-forbidden');
    assert.equal(f.meter.opens, 0); assert.equal(f.value.shareContext, false);
  } finally { await f.history.dispose(); }
});

test('first-text uses separate strict audit records and accepts a genuinely empty consumption ledger', async () => {
  const f = firstFixture(); f.value.consumed = [];
  try {
    assert.equal(f.history.status(f.id).reason, 'not-required');
    const id = await firstAuthorize(f); await firstShare(f, id); const permit = await firstReserve(f, id);
    const completed = await f.history.firstText.finish(permit, { outcome: 'empty', requestAccepted: 0 });
    assert.equal(completed.receipt.purpose, 'first-text-once'); assert.equal(completed.firstTextContext.consentId, null);
    assert.equal(f.sharedRows.has(f.id), false); assert.equal(f.firstRows.get(f.id).events.length, 4);
    const event = f.firstRows.get(f.id).events[0];
    assert.equal(event.scope.consumedCount, 0); assert.equal(event.scope.model.selectionRevision, 1);
    assert.equal(TASK_HISTORY_AUDIT_SPEC.tables.tasks.valueSchema.safeParse({ events: [event] }).success, false);
    assert.equal(f.meter.opens, 2);
  } finally { await f.history.dispose(); }
});

test('one Task review slot cannot authorize one purpose with the other purpose review', async () => {
  const f = firstFixture();
  try {
    const historical = await f.history.review(f.id), first = await f.history.firstText.review(f.id);
    await reject(() => f.history.authorize(f.id, { reviewId: historical.reviewId, confirmation: 'authorize-reviewed-task-history-text' }), 'share-forbidden');
    await reject(() => f.history.authorize(f.id, { reviewId: first.reviewId, confirmation: 'authorize-reviewed-task-history-text' }), 'share-forbidden');
    const granted = await f.history.firstText.authorize(f.id, { reviewId: first.reviewId, confirmation: 'authorize-reviewed-first-task-text' });
    assert.equal(granted.receipt.purpose, 'first-text-once'); assert.equal(f.history.status(f.id).consentId, null);
  } finally { await f.history.dispose(); }
});

test('new first-text review closes a historical consent instead of adding a parallel permit', async () => {
  const f = firstFixture();
  try {
    const historical = await authorize(f); await share(f, historical);
    const first = await f.history.firstText.review(f.id);
    assert.equal(f.value.shareContext, false); assert.equal(f.history.status(f.id).consentId, null);
    await reject(() => reserve(f, historical), 'share-forbidden');
    assert.equal(f.history.firstText.status(f.id).phase, 'reviewed'); assert.ok(first.reviewId);
  } finally { await f.history.dispose(); }
});

test('cross-purpose IDs and permit handles cannot borrow a first-text approval or close it', async () => {
  const f = firstFixture();
  try {
    const id = await firstAuthorize(f); await firstShare(f, id);
    await reject(() => reserve(f, id), 'share-forbidden');
    assert.equal(f.history.firstText.status(f.id).consentId, id); assert.equal(f.value.shareContext, true);
    const permit = await firstReserve(f, id);
    assert.throws(() => f.history.verify(permit), error => error.code === 'share-forbidden');
    await reject(() => f.history.review(f.id), 'busy');
    assert.equal(f.history.firstText.verify(permit), true);
    await f.history.firstText.finish(permit, { outcome: 'empty' });
  } finally { await f.history.dispose(); }
});

for (const [name, change] of [
  ['SDK native observation', value => { value.firstText.observation = {}; }],
  ['SDK model observation', value => { value.firstText.modelObservation = {}; }],
  ['model configuration', value => { value.firstText.model = { ...value.firstText.model, configurationDigest: '1'.repeat(64) }; }],
  ['model selection revision', value => { value.firstText.model = { ...value.firstText.model, selectionRevision: 2 }; }],
  ['source control revision', value => { value.revision++; }],
]) test('first-text captured proof invalidates on ' + name, async () => {
  const f = firstFixture();
  try {
    const id = await firstAuthorize(f); await firstShare(f, id); change(f.value);
    assert.equal(f.history.firstText.status(f.id).consentId, null); assert.equal(f.value.shareContext, false);
    await reject(() => firstReserve(f, id), 'share-forbidden');
  } finally { await f.history.dispose(); }
});

test('first-text own native sequence advances while SDK validation still rejects unrelated events', async () => {
  const f = firstFixture();
  try {
    const id = await firstAuthorize(f); await firstShare(f, id); const permit = await firstReserve(f, id);
    f.history.firstText.bindInput(permit, 'first-input'); f.value.sdkSequence += 10; f.value.firstText.ready = false;
    assert.equal(f.history.firstText.verify(permit), true);
    f.value.firstText.valid = false;
    assert.throws(() => f.history.firstText.verify(permit), error => error.code === 'revoked');
    await f.history.firstText.finish(permit, { outcome: 'blocked' });
  } finally { await f.history.dispose(); }
});

test('first-text lease stays held until native drain and terminal audit, then releases exactly once', async () => {
  const f = firstFixture(); let released = 0;
  try {
    const id = await firstAuthorize(f); await firstShare(f, id); const permit = await firstReserve(f, id);
    f.history.firstText.retainLease(permit, { verify: () => true, release() { released++; } });
    f.history.firstText.completeModel(permit);
    const terminal = f.history.firstText.finish(permit, { outcome: 'replied', requestAccepted: 1 });
    await Promise.resolve(); assert.equal(released, 0); assert.equal(f.value.shareContext, false);
    f.history.firstText.recordModelRequests(permit, 1); f.history.firstText.drainLease(permit);
    const done = await terminal;
    assert.equal(done.receipt.modelRequestsReserved, 1); assert.equal(done.receipt.runOutcome, 'replied'); assert.equal(released, 1);
    assert.equal(f.history.firstText.finish(permit, { outcome: 'blocked' }), terminal);
    assert.equal(released, 1);
  } finally { await f.history.dispose(); }
});

for (const first of [true, false]) test('unknown run blocks both text purposes through cold restoration: ' + (first ? 'first' : 'history'), async () => {
  const f = firstFixture(); let restored;
  try {
    const id = first ? await firstAuthorize(f) : await authorize(f);
    if (first) { await firstShare(f, id); await firstReserve(f, id); }
    else { await share(f, id); await reserve(f, id); }
    await f.history.dispose(); restored = createTaskHistoryAuthority(f.options);
    await reject(() => first ? restored.review(f.id) : restored.firstText.review(f.id), 'share-forbidden');
    assert.equal(restored.status(f.id).reason, 'run-unresolved'); assert.equal(restored.firstText.status(f.id).reason, 'run-unresolved');
    await restored.revoke(f.id); await restored.firstText.revoke(f.id);
    assert.equal(restored.status(f.id).reason, 'run-unresolved'); assert.equal(restored.firstText.status(f.id).reason, 'run-unresolved');
    assert.equal(restored.firstText.status(f.id).consentId, null);
  } finally { await restored?.dispose(); await f.history.dispose(); }
});

test('a failed first-text audit blocks historical approval without widening either domain schema', async () => {
  const f = firstFixture();
  try {
    const review = await f.history.firstText.review(f.id); f.meter.rejectWrites = true;
    await reject(() => f.history.firstText.authorize(f.id, { reviewId: review.reviewId, confirmation: 'authorize-reviewed-first-task-text' }), 'history-unavailable');
    assert.equal(f.history.status(f.id).reason, 'audit-unresolved'); assert.equal(f.history.firstText.status(f.id).reason, 'audit-unresolved');
    f.meter.rejectWrites = false;
    await reject(() => f.history.review(f.id), 'share-forbidden'); assert.equal(f.value.shareContext, false);
    assert.equal(f.sharedRows.has(f.id), false);
  } finally { await f.history.dispose(); }
});

async function priorUnknownFirst(f, modelRequestsReserved = 0, requestAccepted = 0) {
  const consentId = await firstAuthorize(f); await firstShare(f, consentId);
  const permit = await firstReserve(f, consentId);
  f.history.firstText.recordModelRequests(permit, modelRequestsReserved);
  const completed = await f.history.firstText.finish(permit, { outcome: 'unknown', requestAccepted });
  return { receipt: structuredClone(completed.receipt), request: { priorRunId: permit.runId, priorConsentId: consentId,
    confirmation: 'allow-new-first-text-after-unknown' }, events: structuredClone(f.firstRows.get(f.id).events) };
}

test('a new first-text decision preserves the old unknown and admits exactly one separate permit', async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f);
    const allowed = await f.history.firstText.allowNewInput(f.id, prior.request);
    assert.deepEqual(allowed.receipt, { purpose: 'first-text-once', operation: 'new-input', priorRunId: prior.request.priorRunId,
      priorConsentId: prior.request.priorConsentId, decisionId: allowed.receipt.decisionId, newInputAllowed: true, auditCommitted: true });
    assert.equal(allowed.firstTextContext.newInputAllowed, true); assert.equal(allowed.firstTextContext.consentId, null);
    assert.equal(f.history.status(f.id).reason, 'run-unresolved');
    await reject(() => f.history.review(f.id), 'share-forbidden');
    const review = await f.history.firstText.review(f.id);
    const repeatedReview = await f.history.firstText.review(f.id);
    await reject(() => f.history.firstText.authorize(f.id, { reviewId: review.reviewId, confirmation: 'authorize-reviewed-first-task-text' }), 'share-forbidden');
    const approved = await f.history.firstText.authorize(f.id, { reviewId: repeatedReview.reviewId, confirmation: 'authorize-reviewed-first-task-text' });
    const consentId = approved.receipt.consentId;
    assert.notEqual(consentId, prior.request.priorConsentId); assert.equal(approved.firstTextContext.newInputAllowed, true);
    await firstShare(f, consentId);
    await reject(() => firstReserve(f, prior.request.priorConsentId), 'share-forbidden');
    const permit = await firstReserve(f, consentId);
    assert.notEqual(permit.runId, prior.request.priorRunId); assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
    assert.equal(f.history.firstText.verify(permit), true);
    f.history.firstText.bindInput(permit, 'new-independent-input'); f.value.sdkSequence += 2;
    f.history.firstText.recordModelRequests(permit, 1); f.history.firstText.completeModel(permit);
    const done = await f.history.firstText.finish(permit, { outcome: 'replied', requestAccepted: 1 });
    assert.equal(done.receipt.runOutcome, 'replied'); assert.equal(done.firstTextContext.newInputAllowed, false);
    assert.equal(done.firstTextContext.reason, 'run-unresolved');
    assert.deepEqual(done.firstTextContext.receipts.find(value => value.operation === 'terminal' && value.runId === prior.request.priorRunId), prior.receipt);
    assert.deepEqual(f.firstRows.get(f.id).events.slice(0, prior.events.length), prior.events);
    assert.equal(f.firstRows.get(f.id).events.find(value => value.operation === 'new-input').outcome, 'accepted');
    await reject(() => firstReserve(f, consentId), 'share-forbidden');
    await reject(() => f.history.firstText.review(f.id), 'share-forbidden');
    await reject(() => f.history.firstText.allowNewInput(f.id, prior.request), 'share-forbidden');
  } finally { await f.history.dispose(); }
});

for (const field of ['priorRunId', 'priorConsentId']) test('a new first-text decision requires the exact previous ' + field, async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f), writes = f.meter.writes;
    await reject(() => f.history.firstText.allowNewInput(f.id, { ...prior.request, [field]: randomUUID() }), 'share-forbidden');
    assert.equal(f.meter.writes, writes); assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
  } finally { await f.history.dispose(); }
});

for (const change of [request => ({ ...request, confirmation: 'retry-unknown-run' }), request => ({ ...request, allowWechat: true }),
  request => ({ ...request, priorRunId: 'not-a-run-id' })]) test('new first-text decisions reject malformed or broader authorization', async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f), writes = f.meter.writes;
    await reject(() => f.history.firstText.allowNewInput(f.id, change(prior.request)), 'invalid-request');
    assert.equal(f.meter.writes, writes); assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
  } finally { await f.history.dispose(); }
});

for (const [model, accepted] of [[1, 0], [0, 1], [1, 1]]) test('new first-text decisions refuse previous nonzero counters ' + model + '/' + accepted, async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f, model, accepted), writes = f.meter.writes;
    await reject(() => f.history.firstText.allowNewInput(f.id, prior.request), 'share-forbidden');
    assert.equal(f.meter.writes, writes); assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
  } finally { await f.history.dispose(); }
});

test('a historical unknown cannot borrow the first-text new-input decision', async () => {
  const f = firstFixture();
  try {
    const consentId = await authorize(f); await share(f, consentId); const permit = await reserve(f, consentId);
    await f.history.finish(permit, { outcome: 'unknown', requestAccepted: 0 });
    await reject(() => f.history.firstText.allowNewInput(f.id, { priorRunId: permit.runId, priorConsentId: consentId,
      confirmation: 'allow-new-first-text-after-unknown' }), 'share-forbidden');
    assert.equal(f.firstRows.has(f.id), false); assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
  } finally { await f.history.dispose(); }
});

test('new first-text decisions reject an unfinished old reserve without a committed terminal', async () => {
  const f = firstFixture(); let restored;
  try {
    const consentId = await firstAuthorize(f); await firstShare(f, consentId); const permit = await firstReserve(f, consentId);
    await f.history.dispose(); restored = createTaskHistoryAuthority(f.options);
    await reject(() => restored.firstText.allowNewInput(f.id, { priorRunId: permit.runId, priorConsentId: consentId,
      confirmation: 'allow-new-first-text-after-unknown' }), 'share-forbidden');
    assert.equal(restored.firstText.status(f.id).reason, 'run-unresolved'); assert.equal(restored.firstText.status(f.id).newInputAllowed, false);
  } finally { await restored?.dispose(); await f.history.dispose(); }
});

test('a committed new-input decision cannot be repeated while waiting for the new permit', async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f); await f.history.firstText.allowNewInput(f.id, prior.request);
    const writes = f.meter.writes;
    await reject(() => f.history.firstText.allowNewInput(f.id, prior.request), 'busy');
    assert.equal(f.meter.writes, writes); assert.equal(f.history.firstText.status(f.id).newInputAllowed, true);
    assert.equal(f.value.shareContext, false);
  } finally { await f.history.dispose(); }
});

test('a failed new-input audit never installs permission or changes the old terminal', async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f); f.meter.rejectWrites = true;
    await reject(() => f.history.firstText.allowNewInput(f.id, prior.request), 'history-unavailable');
    assert.equal(f.history.firstText.status(f.id).newInputAllowed, false); assert.equal(f.history.firstText.status(f.id).reason, 'audit-unresolved');
    assert.deepEqual(f.firstRows.get(f.id).events, prior.events); assert.equal(f.value.shareContext, false);
  } finally { await f.history.dispose(); }
});

test('a cancelled new-input audit may restore facts later but never restores permission', async () => {
  const f = firstFixture(), control = new AbortController(), hold = { entered: deferred(), release: deferred() };
  try {
    const prior = await priorUnknownFirst(f); f.meter.hold = hold;
    const pending = f.history.firstText.allowNewInput(f.id, prior.request, control.signal);
    await hold.entered.promise; control.abort(); await reject(() => pending, 'aborted');
    assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
    hold.release.resolve(); await new Promise(resolve => setImmediate(resolve));
    const status = await f.history.firstText.inspect(f.id);
    assert.equal(status.newInputAllowed, false); assert.equal(status.reason, 'run-unresolved');
    assert.ok(status.receipts.some(value => value.operation === 'audit' && value.auditedOperation === 'new-input'));
    await reject(() => f.history.firstText.allowNewInput(f.id, prior.request), 'share-forbidden');
    assert.deepEqual(f.firstRows.get(f.id).events.slice(0, prior.events.length), prior.events);
  } finally { hold.release.resolve(); await f.history.dispose(); }
});

test('a pre-aborted new-input decision has no audit write', async () => {
  const f = firstFixture(), control = new AbortController();
  try {
    const prior = await priorUnknownFirst(f), writes = f.meter.writes; control.abort();
    await reject(() => f.history.firstText.allowNewInput(f.id, prior.request, control.signal), 'aborted');
    assert.equal(f.meter.writes, writes); assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
  } finally { await f.history.dispose(); }
});

for (const purpose of ['history', 'firstText']) test('external ' + purpose + ' revocation clears a new-input permission', async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f); await f.history.firstText.allowNewInput(f.id, prior.request);
    await (purpose === 'firstText' ? f.history.firstText : f.history).revoke(f.id);
    assert.equal(f.history.firstText.status(f.id).newInputAllowed, false); assert.equal(f.history.firstText.status(f.id).reason, 'run-unresolved');
    await reject(() => f.history.firstText.review(f.id), 'share-forbidden');
    await reject(() => f.history.firstText.allowNewInput(f.id, prior.request), 'share-forbidden');
  } finally { await f.history.dispose(); }
});

test('external revocation wins over a late committed new-input decision', async () => {
  const f = firstFixture(), hold = { entered: deferred(), release: deferred() };
  try {
    const prior = await priorUnknownFirst(f); f.meter.hold = hold;
    const pending = f.history.firstText.allowNewInput(f.id, prior.request);
    await hold.entered.promise; const revoked = f.history.firstText.revoke(f.id);
    hold.release.resolve(); await reject(() => pending, 'revoked'); await revoked;
    assert.equal(f.history.firstText.status(f.id).newInputAllowed, false); assert.equal(f.value.shareContext, false);
  } finally { hold.release.resolve(); await f.history.dispose(); }
});

for (const [name, change] of [
  ['source revision', f => { f.value.revision++; }],
  ['model observation', f => { f.value.firstText.modelObservation = {}; }],
  ['native observation', f => { f.value.firstText.observation = {}; }],
  ['SDK owner', f => { f.value.firstText.owner = {}; }],
  ['external invalidation', f => { f.history.invalidate(f.id, 'source-changed'); }],
]) test('a new-input permission cannot survive ' + name, async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f); await f.history.firstText.allowNewInput(f.id, prior.request); change(f);
    assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
    await reject(() => f.history.firstText.review(f.id), 'share-forbidden'); assert.equal(f.value.shareContext, false);
  } finally { await f.history.dispose(); }
});

test('new-input permission expires without extending its bound consent deadline', async () => {
  const f = firstFixture(), previousNow = Date.now; let clock = previousNow();
  Date.now = () => clock;
  try {
    const prior = await priorUnknownFirst(f); await f.history.firstText.allowNewInput(f.id, prior.request);
    clock += 590000; const consentId = await firstAuthorize(f); await firstShare(f, consentId);
    clock += 10001;
    assert.equal(f.history.firstText.status(f.id).newInputAllowed, false); assert.equal(f.history.firstText.status(f.id).consentId, null);
    await reject(() => firstReserve(f, consentId), 'share-forbidden');
  } finally { Date.now = previousNow; await f.history.dispose(); }
});

test('cold restoration of a new-input audit never restores permission or allows repeating the decision', async () => {
  const f = firstFixture(); let restored;
  try {
    const prior = await priorUnknownFirst(f); await f.history.firstText.allowNewInput(f.id, prior.request);
    await f.history.dispose(); restored = createTaskHistoryAuthority(f.options);
    const status = await restored.firstText.inspect(f.id);
    assert.equal(status.newInputAllowed, false); assert.equal(status.reason, 'run-unresolved'); assert.equal(status.consentId, null);
    assert.ok(status.receipts.some(value => value.operation === 'audit' && value.auditedOperation === 'new-input'));
    await reject(() => restored.firstText.allowNewInput(f.id, prior.request), 'share-forbidden');
    assert.deepEqual(f.firstRows.get(f.id).events.slice(0, prior.events.length), prior.events);
  } finally { await restored?.dispose(); await f.history.dispose(); }
});

test('an unsuccessful new run consumes its new-input decision and retains both unknown terminals', async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f); await f.history.firstText.allowNewInput(f.id, prior.request);
    const consentId = await firstAuthorize(f); await firstShare(f, consentId); const permit = await firstReserve(f, consentId);
    const done = await f.history.firstText.finish(permit, { outcome: 'unknown', requestAccepted: 0 });
    assert.equal(done.firstTextContext.newInputAllowed, false);
    assert.equal(done.firstTextContext.receipts.filter(value => value.operation === 'terminal' && value.runOutcome === 'unknown').length, 2);
    await reject(() => f.history.firstText.allowNewInput(f.id, prior.request), 'share-forbidden');
    await reject(() => f.history.firstText.allowNewInput(f.id, { priorRunId: permit.runId, priorConsentId: consentId,
      confirmation: 'allow-new-first-text-after-unknown' }), 'share-forbidden');
    await reject(() => f.history.firstText.review(f.id), 'share-forbidden');
  } finally { await f.history.dispose(); }
});

test('observing a changed boundary permanently clears an unused new-input permission', async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f); await f.history.firstText.allowNewInput(f.id, prior.request);
    const observation = f.value.firstText.observation;
    f.value.firstText.observation = {};
    assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
    f.value.firstText.observation = observation;
    assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
    await reject(() => f.history.firstText.review(f.id), 'share-forbidden');
  } finally { await f.history.dispose(); }
});

test('a bound new run remains valid during its own native lease and is consumed on cancellation', async () => {
  const f = firstFixture(), control = new AbortController();
  try {
    const prior = await priorUnknownFirst(f); await f.history.firstText.allowNewInput(f.id, prior.request);
    const consentId = await firstAuthorize(f); await firstShare(f, consentId); const permit = await firstReserve(f, consentId, control.signal);
    f.value.firstText.ready = false;
    assert.equal(f.history.firstText.verify(permit), true);
    control.abort(); assert.throws(() => f.history.firstText.verify(permit), error => error.code === 'aborted');
    await f.history.firstText.finish(permit, { outcome: 'blocked', requestAccepted: 0 });
    f.value.firstText.ready = true;
    assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
    await reject(() => f.history.firstText.review(f.id), 'share-forbidden');
    await reject(() => f.history.firstText.allowNewInput(f.id, prior.request), 'share-forbidden');
  } finally { await f.history.dispose(); }
});

test('a changed bound proof aborts the new run and cannot be restored by returning to the old proof', async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f); await f.history.firstText.allowNewInput(f.id, prior.request);
    const consentId = await firstAuthorize(f); await firstShare(f, consentId); const permit = await firstReserve(f, consentId);
    const observation = f.value.firstText.observation;
    f.value.firstText.observation = {};
    assert.throws(() => f.history.firstText.verify(permit), error => error.code === 'revoked');
    assert.equal(permit.signal.aborted, true);
    f.value.firstText.observation = observation;
    assert.throws(() => f.history.firstText.verify(permit), error => error.code === 'aborted');
    await f.history.firstText.finish(permit, { outcome: 'blocked', requestAccepted: 0 });
    assert.equal(f.history.firstText.status(f.id).newInputAllowed, false); assert.equal(f.value.shareContext, false);
  } finally { await f.history.dispose(); }
});

test('an invalid new reserve consumes its decision while preserving the original terminal', async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f); await f.history.firstText.allowNewInput(f.id, prior.request);
    const consentId = await firstAuthorize(f); await firstShare(f, consentId); f.value.firstText.ready = false;
    await reject(() => firstReserve(f, consentId), 'share-forbidden');
    f.value.firstText.ready = true;
    assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
    assert.deepEqual(f.history.firstText.status(f.id).receipts.find(value => value.operation === 'terminal' && value.runId === prior.request.priorRunId), prior.receipt);
    await reject(() => f.history.firstText.review(f.id), 'share-forbidden');
  } finally { await f.history.dispose(); }
});

test('new-input audit capacity reserves the complete following one-text lifecycle', async () => {
  const f = firstFixture();
  try {
    const prior = await priorUnknownFirst(f);
    const template = f.firstRows.get(f.id).events[0];
    f.firstRows.set(f.id, TASK_FIRST_TEXT_AUDIT_SPEC.tables.tasks.valueSchema.parse({ events: [...prior.events,
      ...Array.from({ length: 56 }, () => ({ ...template, operation: 'revoke', decisionId: randomUUID(), runId: null,
        consentId: null, reviewId: null, revokeId: randomUUID(), scope: null, outcome: 'revoked' }))] }));
    await reject(() => f.history.firstText.allowNewInput(f.id, prior.request), 'history-unavailable');
    assert.equal(f.firstRows.get(f.id).events.length, 60); assert.equal(f.history.firstText.status(f.id).newInputAllowed, false);
  } finally { await f.history.dispose(); }
});

test('new-input expiry during the new consent audit cannot install authority', async () => {
  const f = firstFixture(), previousNow = Date.now, hold = { entered: deferred(), release: deferred() }; let clock = previousNow();
  Date.now = () => clock;
  try {
    const prior = await priorUnknownFirst(f); await f.history.firstText.allowNewInput(f.id, prior.request);
    clock += 590000; const reviewed = await f.history.firstText.review(f.id); f.meter.hold = hold;
    const pending = f.history.firstText.authorize(f.id, { reviewId: reviewed.reviewId, confirmation: 'authorize-reviewed-first-task-text' });
    await hold.entered.promise; clock += 10001; hold.release.resolve(); await reject(() => pending, 'revoked');
    assert.equal(f.history.firstText.status(f.id).newInputAllowed, false); assert.equal(f.history.firstText.status(f.id).consentId, null);
    assert.equal(f.value.shareContext, false);
  } finally { hold.release.resolve(); Date.now = previousNow; await f.history.dispose(); }
});
