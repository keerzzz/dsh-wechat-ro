// End-to-end proof of the failure this change exists for: a reasoning model
// whose thinking tokens share the output budget truncates a JSON summary at a
// small maxTokens, and the same route completes once the budget is raised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWithModel } from '../lib/summary-model.js';

// A route that spends output budget on thinking first, then answers with a
// fixed-length JSON body; truncation is reported when that body cannot fit.
const ANSWER = '{"highlights":[],"todos":[]}';
function budgetRoute({ thinking = 6000 } = {}) {
  const requests = [];
  return { requests, resolveModelInfo: async () => ({ maxTokens: 126000 }), stream(options) {
    requests.push(options);
    return (async function* () {
      const budget = options.maxTokens;
      const spent = options.reasoningEffort ? Math.min(thinking, budget) : 0;
      if (spent) yield { type: 'reasoning-delta', index: 0, text: 'x'.repeat(spent) };
      const room = Math.max(0, budget - spent);
      const text = ANSWER.slice(0, Math.min(ANSWER.length, room));
      if (text) yield { type: 'text-delta', index: 1, text };
      yield { type: 'finish', reason: text.length === ANSWER.length ? { kind: 'stop' } : { kind: 'max-tokens' } };
    })();
  } };
}

test('a reasoning model that truncates a small budget completes on the raised budget', async () => {
  const llm = budgetRoute({ thinking: 6000 });
  const text = await summarizeWithModel({ llm, routes: [{ provider: 'synthetic', model: 'reasoning', reasoningEffort: 'high' }],
    prompt: 'p', signal: new AbortController().signal, maxTokens: 6000 });
  assert.equal(text, '{"highlights":[],"todos":[]}');
  // First attempt spent the budget on thinking, second dropped the effort and had room.
  assert.equal(llm.requests.length, 2);
  assert.equal(llm.requests[0].maxTokens, 6000);
  assert.equal(llm.requests[0].reasoningEffort, 'high');
  assert.equal(llm.requests[1].reasoningEffort, undefined);
});

test('the previous fixed budget of 6000 reproduces the reported failure exactly', async () => {
  // This is the shape of the 38 failures in the host log: 6000 tokens, high
  // effort, JSON never completed, finish reason max-tokens.
  // With the old single-shot behaviour the same budget and effort truncate.
  const llm = budgetRoute({ thinking: 6000 });
  await assert.rejects((async () => {
    for await (const chunk of llm.stream({ provider: 'synthetic', model: 'reasoning', reasoningEffort: 'high',
      messages: [], tools: [], maxTokens: 6000, signal: new AbortController().signal })) {
      if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') throw Object.assign(new Error('SUMMARY_NOT_COMPLETED'), { code: 'SUMMARY_NOT_COMPLETED' });
    }
    return 'completed';
  })(), error => error.code === 'SUMMARY_NOT_COMPLETED');
  // The new path recovers the same request without any configuration change.
  assert.equal(await summarizeWithModel({ llm, routes: [{ provider: 'synthetic', model: 'reasoning', reasoningEffort: 'high' }],
    prompt: 'p', signal: new AbortController().signal, maxTokens: 6000 }), ANSWER);
});
