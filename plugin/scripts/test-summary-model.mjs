// Summary call classification: a truncated, rejected, empty or revoked summary
// must not be reported as one generic "not completed".
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWithModel, summaryRoutes } from '../lib/summary-model.js';

function llmOf(script) {
  const requests = [];
  return { requests, resolveModelInfo: async () => ({ maxTokens: 126000 }), stream(options) {
    requests.push(options);
    const step = script[requests.length - 1];
    if (!step) throw new Error('unscripted call ' + requests.length);
    return (async function* () {
      for (const chunk of step.chunks ?? []) yield chunk;
      yield { type: 'finish', reason: step.reason };
    })();
  } };
}
const delta = text => ({ type: 'text-delta', index: 0, text });
const ok = text => ({ chunks: [delta(text)], reason: { kind: 'stop' } });
const truncated = text => ({ chunks: [delta(text)], reason: { kind: 'max-tokens' } });
const rejected = code => ({ chunks: [], reason: { kind: 'error', failure: { code } } });
const signal = () => new AbortController().signal;

test('routes keep the selected route first and dedupe the deployment default', () => {
  const selected = { provider: 'synthetic', model: 'task-model', reasoningEffort: 'high' };
  assert.deepEqual(summaryRoutes(selected, { provider: 'synthetic', model: 'task-model' }), [selected]);
  assert.deepEqual(summaryRoutes(selected, { provider: 'synthetic', model: 'default-model' }).map(r => r.model), ['task-model', 'default-model']);
  assert.deepEqual(summaryRoutes(undefined, { provider: 'synthetic', model: 'default-model' }), [{ provider: 'synthetic', model: 'default-model' }]);
  assert.deepEqual(summaryRoutes({ provider: '', model: 'x' }, undefined), []);
});

test('a complete answer returns without a second call', async () => {
  const llm = llmOf([ok('{"highlights":[],"todos":[]}')]);
  const text = await summarizeWithModel({ llm, routes: [{ provider: 'synthetic', model: 'm' }], prompt: 'p', signal: signal() });
  assert.equal(text, '{"highlights":[],"todos":[]}');
  assert.equal(llm.requests.length, 1);
  assert.deepEqual(llm.requests[0].tools, []);
});

test('truncation is reported as truncation and retried once without reasoning effort', async () => {
  const llm = llmOf([truncated('{"highlights":['), ok('{"highlights":[],"todos":[]}')]);
  const text = await summarizeWithModel({ llm, routes: [{ provider: 'synthetic', model: 'm', reasoningEffort: 'high' }], prompt: 'p', signal: signal() });
  assert.equal(text, '{"highlights":[],"todos":[]}');
  assert.equal(llm.requests.length, 2);
  assert.equal(llm.requests[0].reasoningEffort, 'high');
  assert.equal(llm.requests[1].reasoningEffort, undefined);
  assert.ok(llm.requests[1].maxTokens >= llm.requests[0].maxTokens);
});

test('persistent truncation surfaces SUMMARY_TRUNCATED, never "not completed"', async () => {
  const llm = llmOf([truncated('{"highlights":['), truncated('{"highlights":[')]);
  await assert.rejects(summarizeWithModel({ llm, routes: [{ provider: 'synthetic', model: 'm', reasoningEffort: 'high' }], prompt: 'p', signal: signal() }),
    error => error.code === 'SUMMARY_TRUNCATED');
  assert.equal(llm.requests.length, 2);
});

test('a rejected route falls back once and keeps the provider code as the cause', async () => {
  const llm = llmOf([rejected('AUTH'), ok('{"highlights":[],"todos":[]}')]);
  const text = await summarizeWithModel({ llm,
    routes: [{ provider: 'synthetic', model: 'broken' }, { provider: 'synthetic', model: 'healthy' }], prompt: 'p', signal: signal() });
  assert.equal(text, '{"highlights":[],"todos":[]}');
  assert.equal(llm.requests.length, 2);
  assert.equal(llm.requests[1].model, 'healthy');
});

test('every route failing surfaces SUMMARY_MODEL_FAILED with the provider code attached', async () => {
  const llm = llmOf([rejected('AUTH'), rejected('RATE_LIMIT')]);
  await assert.rejects(summarizeWithModel({ llm,
    routes: [{ provider: 'synthetic', model: 'a' }, { provider: 'synthetic', model: 'b' }], prompt: 'p', signal: signal() }),
    error => error.code === 'SUMMARY_MODEL_FAILED' && error.cause === 'RATE_LIMIT');
});

test('a non-retryable failure stops at the first route', async () => {
  const llm = llmOf([rejected('INVALID_REQUEST')]);
  await assert.rejects(summarizeWithModel({ llm,
    routes: [{ provider: 'synthetic', model: 'a' }, { provider: 'synthetic', model: 'b' }], prompt: 'p', signal: signal() }),
    error => error.code === 'SUMMARY_MODEL_FAILED' && error.cause === 'INVALID_REQUEST');
  assert.equal(llm.requests.length, 1);
});

test('an empty answer is its own failure and is not retried', async () => {
  const llm = llmOf([ok('   ')]);
  await assert.rejects(summarizeWithModel({ llm, routes: [{ provider: 'synthetic', model: 'm' }], prompt: 'p', signal: signal() }),
    error => error.code === 'SUMMARY_EMPTY');
  assert.equal(llm.requests.length, 1);
});

test('a revoked context aborts instead of reporting a model failure', async () => {
  const control = new AbortController();
  const llm = { resolveModelInfo: async () => ({ maxTokens: 126000 }), stream() {
    return (async function* () { control.abort(); yield { type: 'text-delta', index: 0, text: '{' }; })();
  } };
  await assert.rejects(summarizeWithModel({ llm, routes: [{ provider: 'synthetic', model: 'm' }], prompt: 'p', signal: control.signal }),
    error => error.name === 'AbortError' || error.code === 'SUMMARY_MODEL_FAILED');
});

test('no route and no service are reported as unavailable, not as a failed model', async () => {
  await assert.rejects(summarizeWithModel({ llm: undefined, routes: [{ provider: 'synthetic', model: 'm' }], prompt: 'p', signal: signal() }),
    error => error.code === 'SUMMARY_MODEL_UNAVAILABLE');
  await assert.rejects(summarizeWithModel({ llm: llmOf([]), routes: [], prompt: 'p', signal: signal() }),
    error => error.code === 'SUMMARY_MODEL_UNAVAILABLE');
});
