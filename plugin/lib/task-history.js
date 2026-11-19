import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const UUID = z.string().uuid();
const HASH = z.string().regex(/^[a-f0-9]{64}$/u);
const text = max => z.string().min(1).max(max).refine(value => !/[\0\r\n]/u.test(value));
const auditEvent = z.object({
  decisionId: UUID, runtimeId: UUID, at: z.number().int().nonnegative(),
  operation: z.enum(['authorize', 'share', 'reserve', 'revoke', 'terminal']),
  consentId: UUID.nullable(), runId: UUID.nullable(), reviewId: UUID.nullable(), revokeId: UUID.nullable(),
  requestAccepted: z.union([z.literal(0), z.literal(1)]).nullable(), modelRequestsReserved: z.union([z.literal(0), z.literal(1)]).nullable(),
  scope: z.object({ workspaceId: text(256), root: text(4096), digest: HASH, consumedCount: z.number().int().min(1).max(1024) }).strict().nullable(),
  outcome: z.enum(['accepted', 'revoked', 'replied', 'empty', 'blocked', 'unknown']),
}).strict();
export const TASK_HISTORY_AUDIT_SPEC = Object.freeze({ name: 'wechat_task_history_consents_v1', version: 1, layout: 'per-record', tables: {
  tasks: { valueSchema: z.object({ events: z.array(auditEvent).max(64) }).strict() },
} });
const firstAuditEvent = auditEvent.extend({
  purpose: z.literal('first-text-once'),
  operation: z.enum(['authorize', 'share', 'reserve', 'revoke', 'terminal', 'new-input']),
  scope: z.object({ workspaceId: text(256), root: text(4096), digest: HASH, consumedCount: z.number().int().min(0).max(1024),
    model: z.object({ provider: text(256), model: text(256), selectionRevision: z.number().int().nonnegative(), configurationDigest: HASH }).strict() }).strict().nullable(),
}).strict();
export const TASK_FIRST_TEXT_AUDIT_SPEC = Object.freeze({ name: 'wechat_task_first_text_consents_v1', version: 1, layout: 'per-record', tables: {
  tasks: { valueSchema: z.object({ events: z.array(firstAuditEvent).max(64) }).strict() },
} });
const HISTORY = 'history-text-once', FIRST = 'first-text-once';
const AUDITS = Object.freeze({ [HISTORY]: TASK_HISTORY_AUDIT_SPEC, [FIRST]: TASK_FIRST_TEXT_AUDIT_SPEC });
const REVIEW_MS = 300000, CONSENT_MS = 600000, AUDIT_MS = 15000;
const requests = {
  [HISTORY]: {
    authorize: z.object({ reviewId: UUID, confirmation: z.literal('authorize-reviewed-task-history-text') }).strict(),
    share: z.object({ historyConsentId: UUID, confirmation: z.literal('share-reviewed-task-history-context') }).strict(),
    reserve: z.object({ historyConsentId: UUID, confirmation: z.literal('poll-one-text-reply-with-reviewed-history') }).strict(),
  },
  [FIRST]: {
    authorize: z.object({ reviewId: UUID, confirmation: z.literal('authorize-reviewed-first-task-text') }).strict(),
    share: z.object({ firstTextConsentId: UUID, confirmation: z.literal('share-reviewed-first-task-text') }).strict(),
    reserve: z.object({ firstTextConsentId: UUID, confirmation: z.literal('poll-one-text-reply-with-first-task-text') }).strict(),
  },
};
const purposeOf = value => value.purpose ?? HISTORY;
const tagged = (purpose, value) => purpose === FIRST ? { ...value, purpose: FIRST } : value;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Two fixed text purposes share one Task permission slot. Audits never restore authority. */
export function createTaskHistoryAuthority({ snapshot, storage, closeSharing, openSharing, fail, maxTasks = 128 }) {
  const runtimeId = randomUUID(), states = new Map(), permits = new WeakMap(), lifetime = new AbortController();
  let disposed = false, opening;
  const domains = new Map(), tables = new Map(), operations = new Set();
  function state(id) {
    let value = states.get(id);
    if (!value) {
      if (states.size >= maxTasks) fail('busy');
      value = { epoch: 0, review: null, consent: null, sharing: null, run: null, newInput: null, receipts: [], unresolvedRuns: new Set(), auditPending: new Set(), auditUnknown: false, reason: null, mutation: false };
      states.set(id, value);
    }
    return value;
  }
  function alive(signal) { if (disposed) fail('disposed'); if (signal?.aborted) fail('aborted'); }
  function parsed(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('invalid-request'); return result.data; }
  const ready = (id, purpose) => purpose === FIRST ? snapshot(id).firstText?.ready === true : snapshot(id).sdkReady === true;
  const owner = (id, purpose) => purpose === FIRST ? snapshot(id).firstText?.owner : snapshot(id).sdkOwner;
  function scopeFor(id, purpose = HISTORY) {
    const value = snapshot(id), first = value?.firstText;
    if (!value?.prepared || !value.historyKnown || !value.workspace || value.workspace.root !== value.cwd) return { reason: 'history-unavailable' };
    const available = purpose === FIRST ? first?.available === true : value.sdkAvailable;
    if (!available || !Number.isSafeInteger(value.sdkSequence) || value.sdkSequence < 0) return { reason: 'sdk-not-ready' };
    if (purpose === HISTORY && !value.consumed.length) return { reason: 'not-required' };
    if (purpose === HISTORY && value.consumed.some(item => item.sourceId !== 'workspace' || item.kind !== 'directory')) return { reason: 'unsupported-sources' };
    if (purpose === FIRST && (!first?.observation || !first.modelObservation || first.valid !== true || !first.model)) return { reason: first?.reason || 'model-not-selected' };
    const keys = value.consumed.map(item => [item.sourceId, item.kind, item.generation].join(':')).sort();
    if (new Set(keys).size !== keys.length) return { reason: 'history-unavailable' };
    const run = states.get(id)?.run, sequence = run?.consent.purpose === purpose && run.inputId !== null ? run.sequence : value.sdkSequence;
    const model = purpose === FIRST ? { provider: first.model.provider, model: first.model.model, selectionRevision: first.model.selectionRevision, configurationDigest: first.model.configurationDigest } : undefined;
    const parts = [value.workspace.id, value.cwd, value.revision, sequence, keys];
    if (purpose === FIRST) parts.push(FIRST, first.model);
    return { workspaceId: value.workspace.id, root: value.workspace.root, consumedCount: keys.length, digest: digest(parts), ...(model ? { model } : {}) };
  }
  const sameScope = (left, right) => left && right && !left.reason && !right.reason && left.digest === right.digest;
  function receipt(row, value) {
    const purpose = purposeOf(value);
    if (value.operation === 'terminal' && value.runOutcome === 'unknown') row.unresolvedRuns.add(purpose + ':' + value.runId);
    row.receipts.push(Object.freeze(value));
    if (row.receipts.filter(item => purposeOf(item) === purpose).length > 16) row.receipts.splice(row.receipts.findIndex(item => purposeOf(item) === purpose), 1);
  }
  function waitForAudit(work, outer) {
    const signal = AbortSignal.any([lifetime.signal, ...(outer ? [outer] : [])]);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => { try { fail('aborted'); } catch (error) { finish(error); } };
      const timer = setTimeout(() => { try { fail('history-unavailable'); } catch (error) { finish(error); } }, AUDIT_MS);
      timer.unref?.();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      Promise.resolve().then(work).then(value => finish(null, value), error => finish(error));
    });
  }
  async function openAudit(signal) {
    alive(signal);
    if (!opening) {
      // One shared open for both domains, independent of caller cancellation.
      // Unknown facts in either domain must be read before either purpose admits.
      opening = Promise.resolve().then(async () => {
        const provider = storage();
        if (!provider || typeof provider.open !== 'function') fail('history-unavailable');
        for (const purpose of [HISTORY, FIRST]) {
          try {
            const handle = await provider.open(AUDITS[purpose]);
            if (disposed) { await handle.close(); fail('disposed'); }
            domains.set(purpose, handle); tables.set(purpose, handle.table('tasks'));
            if (tables.get(purpose).size > maxTasks) fail('history-unavailable');
          } catch { fail('history-unavailable'); }
        }
      });
      opening.catch(() => {});
    }
    await waitForAudit(() => opening, signal); alive(signal);
  }
  function restoreAuditFacts(id) {
    const row = state(id);
    for (const purpose of [HISTORY, FIRST]) {
      const events = tables.get(purpose)?.get(id)?.events || [];
      for (const event of events) {
        row.auditPending.delete(event.decisionId);
        if (!row.receipts.some(value => purposeOf(value) === purpose && value.operation === 'audit' && value.decisionId === event.decisionId)) receipt(row, tagged(purpose, {
          operation: 'audit', auditedOperation: event.operation, decisionId: event.decisionId, reviewId: event.reviewId,
          consentId: event.consentId, runId: event.runId, revokeId: event.revokeId, auditOutcome: 'committed',
          permissionRevoked: event.runtimeId !== runtimeId, outcome: event.outcome,
        }));
        if (event.operation !== 'reserve' || event.runtimeId === runtimeId) continue;
        const terminal = events.find(value => value.operation === 'terminal' && value.runId === event.runId);
        const key = purpose + ':' + event.runId;
        if (!terminal || terminal.outcome === 'unknown') {
          if (!row.unresolvedRuns.has(key)) receipt(row, tagged(purpose, { operation: 'terminal', consentId: event.consentId,
            runId: event.runId, permissionRevoked: true, sharingClosed: true, runOutcome: 'unknown', auditOutcome: 'committed',
            ...(terminal ? { decisionId: terminal.decisionId, requestAccepted: terminal.requestAccepted, modelRequestsReserved: terminal.modelRequestsReserved } : {}) }));
        } else {
          row.unresolvedRuns.delete(key);
          row.receipts = row.receipts.filter(value => purposeOf(value) !== purpose || value.operation !== 'terminal' || value.runId !== event.runId);
          receipt(row, tagged(purpose, { operation: 'terminal', consentId: event.consentId, runId: event.runId, permissionRevoked: true, sharingClosed: true,
            runOutcome: terminal.outcome, auditOutcome: 'committed', decisionId: terminal.decisionId,
            requestAccepted: terminal.requestAccepted, modelRequestsReserved: terminal.modelRequestsReserved }));
        }
      }
    }
    row.auditUnknown = row.auditPending.size > 0;
  }
  async function audit(id, purpose, operation, scope, consentId, runId, outcome, signal, metadata = {}) {
    const row = state(id);
    const event = tagged(purpose, { decisionId: randomUUID(), runtimeId, at: Date.now(), operation, consentId, runId, scope: scope?.reason ? null : scope, outcome,
      reviewId: metadata.reviewId ?? null, revokeId: metadata.revokeId ?? null,
      requestAccepted: metadata.requestAccepted ?? null, modelRequestsReserved: metadata.modelRequestsReserved ?? null });
    try {
      await openAudit(signal); restoreAuditFacts(id);
      const table = tables.get(purpose);
      if (!table.get(id)) {
        if (table.size >= maxTasks) fail('history-unavailable');
        await waitForAudit(() => table.put(id, { events: [] }), signal);
      }
      alive(signal);
      await waitForAudit(() => table.update(id, value => {
        const needed = operation === 'new-input' ? 6 : operation === 'authorize' ? 5 : operation === 'share' ? 3 : operation === 'reserve' || operation === 'revoke' && row.run ? 2 : 1;
        if (value.events.length + needed > 64) fail('history-unavailable');
        return { events: [...value.events, event] };
      }), signal);
      alive(signal);
      return event.decisionId;
    } catch (error) {
      row.auditPending.add(event.decisionId); row.auditUnknown = true;
      if (error?.code === 'aborted') throw error;
      fail('history-unavailable');
    }
  }
  function track(work) {
    const promise = Promise.resolve().then(work);
    operations.add(promise); promise.then(() => operations.delete(promise), () => operations.delete(promise));
    return promise;
  }
  function newInputCurrent(id, row, permission = row.newInput) {
    const first = snapshot(id).firstText;
    return !disposed && permission && permission.epoch === row.epoch && Date.now() < permission.expiresAt
      && permission.owner === owner(id, FIRST) && sameScope(permission.scope, scopeFor(id, FIRST))
      && first?.observation === permission.observation && first.modelObservation === permission.modelObservation && first.valid === true;
  }
  function unresolved(id, row, purpose = HISTORY) {
    const permission = purpose === FIRST ? row.run?.newInput ?? row.newInput : null;
    const current = newInputCurrent(id, row, permission);
    if (permission && permission === row.newInput && !current) row.newInput = null;
    const priorKey = current ? permission.priorKey : null;
    return [...row.unresolvedRuns].some(key => key !== priorKey);
  }
  function invalidate(id, reason = 'revoked', preserveNewInput = false) {
    const row = states.get(id);
    if (!row) return;
    const permission = preserveNewInput && newInputCurrent(id, row) ? row.newInput : null;
    const hadPermission = Boolean(row.consent || row.sharing || row.run);
    row.epoch++; row.review = null; row.consent = null; row.sharing = null; row.reason = reason;
    row.newInput = permission ? { ...permission, epoch: row.epoch } : null;
    row.run?.controller.abort();
    if (hadPermission) closeSharing(id);
  }
  function consentCurrent(id, row, consent) {
    const first = consent?.purpose === FIRST ? snapshot(id).firstText : undefined;
    return !disposed && consent && row.consent === consent && consent.epoch === row.epoch
      && Date.now() < consent.expiresAt && consent.owner === owner(id, consent.purpose) && sameScope(consent.scope, scopeFor(id, consent.purpose))
      && (consent.purpose !== FIRST || first?.observation === consent.observation && first.modelObservation === consent.modelObservation && first.valid === true);
  }
  function status(id, purpose = HISTORY) {
    const row = state(id), scope = scopeFor(id, purpose), first = snapshot(id).firstText;
    if (row.review && Date.now() >= row.review.expiresAt) { row.review = null; row.reason = 'review-expired'; }
    if (row.consent && !consentCurrent(id, row, row.consent)) invalidate(id, 'consent-expired');
    const approved = Boolean(row.consent?.purpose === purpose && !row.run && !row.auditUnknown && !unresolved(id, row, purpose));
    const shareConfirmed = approved && row.sharing?.consentId === row.consent.id && snapshot(id).shareContext === true;
    const acquisitionReady = Boolean(row.run?.consent.purpose === purpose || ready(id, purpose));
    return { version: 1, supported: (!scope.reason || purpose === HISTORY && scope.reason === 'not-required') && acquisitionReady, required: !scope.reason,
      reason: row.auditUnknown ? 'audit-unresolved' : unresolved(id, row, purpose) ? 'run-unresolved' : scope.reason || !acquisitionReady && 'sdk-not-ready' || row.reason || null,
      phase: row.run?.consent.purpose === purpose ? row.run.phase : approved ? shareConfirmed ? 'sharing-confirmed' : 'approved' : row.review?.purpose === purpose ? 'reviewed' : 'blocked',
      workspace: scope.reason ? null : { id: scope.workspaceId, root: scope.root }, consumedCount: scope.reason ? 0 : scope.consumedCount,
      purpose, consentId: approved ? row.consent.id : null,
      sharingConfirmed: Boolean(shareConfirmed), executable: Boolean(shareConfirmed && ready(id, purpose)), receipts: row.receipts.filter(item => purposeOf(item) === purpose),
      ...(purpose === FIRST ? { model: first?.model ?? null, native: first?.native ?? null, preparation: first?.preparation ?? null,
        newInputAllowed: Boolean(!row.run && !row.auditUnknown && newInputCurrent(id, row) && !unresolved(id, row, FIRST)) } : {}) };
  }
  function review(id, signal, purpose = HISTORY) {
    alive(signal);
    const row = state(id), scope = scopeFor(id, purpose);
    if (scope.reason || !ready(id, purpose) || row.mutation || row.run) fail(scope.reason ? 'share-forbidden' : 'busy');
    if (row.review || row.consent || row.sharing) invalidate(id, 'revoked', purpose === FIRST);
    const epoch = row.epoch; row.mutation = true;
    return track(async () => {
      try {
        await openAudit(signal); restoreAuditFacts(id);
        alive(signal);
        if (epoch !== row.epoch || row.auditUnknown || unresolved(id, row, purpose) || !sameScope(scope, scopeFor(id, purpose)) || !ready(id, purpose)) fail('share-forbidden');
        const first = snapshot(id).firstText;
        row.review = { id: randomUUID(), purpose, scope, epoch: row.epoch, owner: owner(id, purpose), expiresAt: Date.now() + REVIEW_MS,
          ...(purpose === FIRST ? { observation: first.observation, modelObservation: first.modelObservation } : {}) };
        row.reason = null;
        return { ...status(id, purpose), reviewId: row.review.id, expiresAt: row.review.expiresAt };
      } finally { row.mutation = false; }
    });
  }
  function result(id, purpose, value) { return { [purpose === FIRST ? 'firstTextContext' : 'historicalContext']: status(id, purpose), receipt: value }; }
  function authorize(id, raw, signal, purpose = HISTORY) {
    const request = parsed(requests[purpose].authorize, raw), row = state(id);
    alive(signal);
    const reviewed = row.review;
    if (row.mutation || row.run) fail('busy');
    if (!reviewed || reviewed.purpose !== purpose || reviewed.id !== request.reviewId || reviewed.epoch !== row.epoch || Date.now() >= reviewed.expiresAt
      || reviewed.owner !== owner(id, purpose) || !ready(id, purpose) || !sameScope(reviewed.scope, scopeFor(id, purpose)) || row.auditUnknown || unresolved(id, row, purpose)) fail('share-forbidden');
    invalidate(id, 'sharing-required', purpose === FIRST); closeSharing(id);
    const epoch = row.epoch, consentId = randomUUID();
    row.mutation = true;
    return track(async () => {
      try {
        const decisionId = await audit(id, purpose, 'authorize', reviewed.scope, consentId, null, 'accepted', signal, { reviewId: request.reviewId });
        alive(signal);
        if (epoch !== row.epoch || Date.now() >= reviewed.expiresAt || !sameScope(reviewed.scope, scopeFor(id, purpose))
          || reviewed.owner !== owner(id, purpose) || !ready(id, purpose) || unresolved(id, row, purpose)) fail('revoked');
        const first = snapshot(id).firstText;
        if (purpose === FIRST && (first.observation !== reviewed.observation || first.modelObservation !== reviewed.modelObservation)) fail('revoked');
        row.consent = { id: consentId, purpose, scope: reviewed.scope, epoch, owner: reviewed.owner,
          expiresAt: Math.min(Date.now() + CONSENT_MS, row.newInput?.expiresAt ?? Infinity),
          ...(purpose === FIRST ? { observation: reviewed.observation, modelObservation: reviewed.modelObservation } : {}) };
        row.reason = null;
        const value = tagged(purpose, { operation: 'authorize', reviewId: request.reviewId, consentId, decisionId, permissionCommitted: true, auditCommitted: true });
        receipt(row, value); return result(id, purpose, value);
      } catch (error) { row.auditUnknown = row.auditPending.size > 0; throw error; }
      finally { row.mutation = false; }
    });
  }
  function share(id, raw, signal, purpose = HISTORY) {
    const request = parsed(requests[purpose].share, raw), row = state(id), consent = row.consent;
    alive(signal);
    if (row.mutation || row.run || row.sharing) fail('busy');
    const requestedId = purpose === FIRST ? request.firstTextConsentId : request.historyConsentId;
    if (consent?.purpose !== purpose || !consentCurrent(id, row, consent) || consent.id !== requestedId || row.auditUnknown || unresolved(id, row, purpose)) fail('share-forbidden');
    const epoch = row.epoch; row.mutation = true;
    return track(async () => {
      try {
        const decisionId = await audit(id, purpose, 'share', consent.scope, consent.id, null, 'accepted', signal);
        if (epoch !== row.epoch || !consentCurrent(id, row, consent)) fail('revoked');
        row.sharing = { consentId: consent.id, decisionId, epoch };
        openSharing(id);
        const value = tagged(purpose, { operation: 'share', consentId: consent.id, decisionId, sharingCommitted: true, auditCommitted: true });
        receipt(row, value); return result(id, purpose, value);
      } catch (error) { row.sharing = null; closeSharing(id); row.auditUnknown = row.auditPending.size > 0; throw error; }
      finally { row.mutation = false; }
    });
  }
  function reserve(id, raw, signal, purpose = HISTORY) {
    const request = parsed(requests[purpose].reserve, raw), row = state(id), consent = row.consent;
    alive(signal);
    if (row.mutation || row.run) fail('busy');
    const requestedId = purpose === FIRST ? request.firstTextConsentId : request.historyConsentId;
    if (consent?.purpose !== purpose || consent.id !== requestedId) fail('share-forbidden');
    const eligible = consentCurrent(id, row, consent) && ready(id, purpose) && row.sharing?.consentId === consent.id
      && snapshot(id).shareContext === true && !row.auditUnknown && !unresolved(id, row, purpose);
    const controller = new AbortController(), epoch = row.epoch;
    const permit = Object.freeze(tagged(purpose, { sessionId: id, consentId: consent.id, runId: randomUUID(), signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal }));
    const run = { permit, controller, consent, epoch, sequence: snapshot(id).sdkSequence, phase: 'reserved', inputId: null, turn: null,
      newInput: purpose === FIRST && newInputCurrent(id, row) ? row.newInput : null, modelRequestsReserved: 0, completed: false };
    row.newInput = null;
    row.run = run; row.mutation = true; permits.set(permit, run);
    return track(async () => {
      try {
        if (!eligible) fail('share-forbidden');
        await audit(id, purpose, 'reserve', consent.scope, consent.id, permit.runId, 'accepted', permit.signal);
        verify(permit, purpose); return permit;
      } catch (error) {
        row.auditUnknown = row.auditPending.size > 0;
        await finish(permit, { outcome: 'blocked', requestAccepted: 0, modelUnknown: false }, purpose);
        throw error;
      } finally { row.mutation = false; }
    });
  }
  function runFor(permit, purpose) {
    const run = permits.get(permit);
    if (!run || run.consent.purpose !== purpose) fail('share-forbidden');
    return run;
  }
  function verify(permit, purpose = HISTORY) {
    const run = runFor(permit, purpose), id = permit.sessionId, row = state(id);
    alive(permit.signal);
    if (run.newInput && (!newInputCurrent(id, row, run.newInput) || unresolved(id, row, purpose))) {
      invalidate(id); fail('revoked');
    }
    if (row.run !== run || run.epoch !== row.epoch || !consentCurrent(id, row, run.consent)
      || row.sharing?.consentId !== permit.consentId || snapshot(id).shareContext !== true) fail('revoked');
    return true;
  }
  function bindInput(permit, inputId, turn = null, purpose = HISTORY) {
    verify(permit, purpose); const run = runFor(permit, purpose);
    if (run.inputId !== null && run.inputId !== inputId || run.turn !== null && turn !== null && run.turn !== turn) fail('share-forbidden');
    run.inputId = inputId; if (turn !== null) run.turn = turn;
  }
  function recordModelRequests(permit, count, purpose = HISTORY) {
    const run = runFor(permit, purpose);
    if (![0, 1].includes(count)) fail('share-forbidden');
    run.modelRequestsReserved = Math.max(run.modelRequestsReserved, count);
    if (count && run.phase !== 'spent') run.phase = 'running';
  }
  function completeModel(permit, purpose = HISTORY) { verify(permit, purpose); runFor(permit, purpose).completed = true; }
  function retainLease(permit, lease) {
    verify(permit, FIRST); const run = runFor(permit, FIRST);
    if (run.lease || !lease || typeof lease.release !== 'function' || typeof lease.verify !== 'function' || lease.verify() !== true) fail('share-forbidden');
    run.lease = lease;
    run.nativeDrained = new Promise(resolve => { run.drain = resolve; });
  }
  function drainLease(permit) { runFor(permit, FIRST).drain?.(); }
  function observation(permit) {
    verify(permit, FIRST); const { consent } = runFor(permit, FIRST);
    return Object.freeze({ observation: consent.observation, modelObservation: consent.modelObservation });
  }
  function finish(permit, terminal, purpose = HISTORY) {
    const run = runFor(permit, purpose), id = permit.sessionId, row = state(id);
    if (run.terminalPromise) return run.terminalPromise;
    const scope = run.consent.scope;
    run.phase = 'spent'; run.controller.abort();
    if (row.run === run) {
      // The spent run still owns one terminal audit slot until its write settles.
      row.consent = null; row.sharing = null; row.review = null; row.epoch++;
      closeSharing(id);
    }
    run.terminalPromise = track(async () => {
      // Native owns the completion signal, not caller cancellation. Keep its SDK
      // executor guard until native persistence/counting and the channel drain.
      await run.nativeDrained;
      const modelUnknown = terminal.modelUnknown === true || run.modelRequestsReserved > 0 && !run.completed;
      const value = tagged(purpose, { operation: 'terminal', consentId: permit.consentId, runId: permit.runId, permissionRevoked: true,
        sharingClosed: true, requestAccepted: terminal.requestAccepted ?? 0, modelRequestsReserved: run.modelRequestsReserved,
        runOutcome: terminal.outcome === 'unknown' || modelUnknown ? 'unknown' : terminal.outcome, auditOutcome: 'pending' });
      receipt(row, value);
      let settled;
      try {
        const decisionId = await audit(id, purpose, 'terminal', scope, permit.consentId, permit.runId, value.runOutcome, undefined,
          { requestAccepted: value.requestAccepted, modelRequestsReserved: value.modelRequestsReserved });
        settled = tagged(purpose, { ...value, decisionId, auditOutcome: 'committed' });
      } catch {
        row.auditUnknown = true;
        settled = tagged(purpose, { ...value, auditOutcome: 'unknown' });
      } finally {
        if (row.run === run) row.run = null;
        run.lease?.release();
      }
      row.receipts = row.receipts.map(item => purposeOf(item) === purpose && item.runId === permit.runId && item.operation === 'terminal' ? Object.freeze(settled) : item);
      return result(id, purpose, settled);
    });
    return run.terminalPromise;
  }
  function revoke(id, raw, purpose = HISTORY) {
    const revokeId = parsed(z.object({ revokeId: UUID }).strict(), raw ?? { revokeId: randomUUID() }).revokeId;
    const row = state(id), activeScope = row.consent?.scope || row.review?.scope;
    const activePurpose = row.consent?.purpose || row.review?.purpose || purpose;
    const scope = activePurpose === purpose ? activeScope || scopeFor(id, purpose) : scopeFor(id, purpose);
    const consentId = row.consent?.id ?? null, runId = row.run?.permit.runId ?? null;
    const runOutcome = row.run ? 'pending' : unresolved(id, row) ? 'unknown' : 'none';
    invalidate(id, 'revoked'); closeSharing(id);
    const value = tagged(purpose, { operation: 'revoke', revokeId, consentId, runId, permissionRevoked: true, sharingClosed: true, runOutcome, auditOutcome: 'pending' });
    return track(async () => {
      try {
        const decisionId = await audit(id, purpose, 'revoke', scope, consentId, runId, 'revoked', undefined, { revokeId });
        const settled = tagged(purpose, { ...value, decisionId, auditOutcome: 'committed' });
        receipt(row, settled); return result(id, purpose, settled);
      } catch {
        row.auditUnknown = true;
        const unsettled = tagged(purpose, { ...value, auditOutcome: 'unknown' });
        receipt(row, unsettled); return result(id, purpose, unsettled);
      }
    });
  }
  function revokeCurrent(id, raw) {
    const row = state(id), purpose = row.run?.consent.purpose || row.consent?.purpose || row.review?.purpose || HISTORY;
    return revoke(id, raw, purpose);
  }
  function inspect(id, signal, purpose = HISTORY) {
    alive(signal);
    return track(async () => { await openAudit(signal); restoreAuditFacts(id); alive(signal); return status(id, purpose); });
  }
  function allowNewFirstText(id, raw, signal) {
    const request = parsed(z.object({ priorRunId: UUID, priorConsentId: UUID, confirmation: z.literal('allow-new-first-text-after-unknown') }).strict(), raw);
    alive(signal);
    const row = state(id), scope = scopeFor(id, FIRST), first = snapshot(id).firstText;
    if (scope.reason || !ready(id, FIRST)) fail('share-forbidden');
    if (row.mutation || row.run || row.newInput) fail('busy');
    const epoch = row.epoch, priorKey = FIRST + ':' + request.priorRunId;
    row.mutation = true;
    return track(async () => {
      try {
        await openAudit(signal); restoreAuditFacts(id); alive(signal);
        if (epoch !== row.epoch || row.auditUnknown || row.unresolvedRuns.size !== 1 || !row.unresolvedRuns.has(priorKey)
          || !sameScope(scope, scopeFor(id, FIRST)) || !ready(id, FIRST)) fail('share-forbidden');
        const events = tables.get(FIRST).get(id)?.events || [];
        const terminals = events.filter(value => value.operation === 'terminal' && value.runId === request.priorRunId && value.consentId === request.priorConsentId);
        const terminal = terminals[0];
        if (terminals.length !== 1 || terminal.outcome !== 'unknown' || terminal.modelRequestsReserved !== 0 || terminal.requestAccepted !== 0
          || !events.some(value => value.operation === 'reserve' && value.runId === request.priorRunId && value.consentId === request.priorConsentId)
          || events.some(value => value.operation === 'new-input' && value.runId === request.priorRunId)) fail('share-forbidden');
        const decisionId = await audit(id, FIRST, 'new-input', scope, request.priorConsentId, request.priorRunId, 'accepted', signal);
        alive(signal);
        if (epoch !== row.epoch || row.auditUnknown || row.unresolvedRuns.size !== 1 || !row.unresolvedRuns.has(priorKey)
          || !sameScope(scope, scopeFor(id, FIRST)) || !ready(id, FIRST)
          || owner(id, FIRST) !== first.owner || snapshot(id).firstText.observation !== first.observation
          || snapshot(id).firstText.modelObservation !== first.modelObservation) fail('revoked');
        row.newInput = { priorKey, scope, owner: first.owner, observation: first.observation, modelObservation: first.modelObservation,
          epoch, expiresAt: Date.now() + CONSENT_MS };
        row.reason = null;
        const value = tagged(FIRST, { operation: 'new-input', priorRunId: request.priorRunId, priorConsentId: request.priorConsentId,
          decisionId, newInputAllowed: true, auditCommitted: true });
        receipt(row, value); return result(id, FIRST, value);
      } finally { row.mutation = false; }
    });
  }
  async function dispose() {
    if (disposed) return;
    for (const id of states.keys()) invalidate(id, 'disposed');
    disposed = true; lifetime.abort();
    await Promise.allSettled([...operations, ...[...states.values()].map(row => row.run?.nativeDrained)]);
    for (const row of states.values()) row.run?.lease?.release();
    await Promise.allSettled([...domains.values()].map(domain => domain.close()));
  }
  const firstText = Object.freeze({
    allowNewInput: allowNewFirstText,
    status: id => status(id, FIRST), inspect: (id, signal) => inspect(id, signal, FIRST), review: (id, signal) => review(id, signal, FIRST),
    authorize: (id, raw, signal) => authorize(id, raw, signal, FIRST), share: (id, raw, signal) => share(id, raw, signal, FIRST),
    reserve: (id, raw, signal) => reserve(id, raw, signal, FIRST), verify: permit => verify(permit, FIRST),
    bindInput: (permit, inputId, turn) => bindInput(permit, inputId, turn, FIRST), recordModelRequests: (permit, count) => recordModelRequests(permit, count, FIRST),
    completeModel: permit => completeModel(permit, FIRST), finish: (permit, terminal) => finish(permit, terminal, FIRST), revoke: (id, raw) => revoke(id, raw, FIRST),
    observation, retainLease, drainLease,
  });
  return Object.freeze({ status, inspect, review, authorize, share, reserve, verify, bindInput, recordModelRequests, completeModel, finish, revoke, revokeCurrent, invalidate, firstText, dispose });
}
