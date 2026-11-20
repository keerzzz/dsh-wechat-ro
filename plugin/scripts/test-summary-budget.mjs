// A budget the adapter cannot report must never be guessed upward: an
// over-budget request is rejected outright and would turn a recoverable
// truncation into a non-retryable failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWithModel } from '../lib/summary-model.js';

const ANSWER = '{"highlights":[],"todos":[]}';
function route({ maxTokens, thinking = 6000 }) {
  const requests = [];
  return { requests, resolveModelInfo: async () => {
    if (maxTokens === undefined) throw new Error('no catalog entry');
    return { maxTokens };
  }, stream(options) {
    requests.push(options);
    return (async function* () {
      const spent = options.reasoningEffort ? Math.min(thinking, options.maxTokens) : 0;
      if (spent) yield { type: 'reasoning-delta', index: 0, text: 'x'.repeat(spent) };
      const room = Math.max(0, options.maxTokens - spent);
      const text = ANSWER.slice(0, Math.min(ANSWER.length, room));
      if (text) yield { type: 'text-delta', index: 1, text };
      yield { type: 'finish', reason: text.length === ANSWER.length ? { kind: 'stop' } : { kind: 'max-tokens' } };
    })();
  } };
}

test('a model with a small cap is never asked for more than that cap', async () => {
  const llm = route({ maxTokens: 32000, thinking: 6000 });
  const text = await summarizeWithModel({ llm, routes: [{ provider: 'synthetic', model: 'small', reasoningEffort: 'high' }],
    prompt: 'p', signal: new AbortController().signal, maxTokens: 16000 });
  assert.equal(text, ANSWER);
  for (const request of llm.requests) assert.ok(request.maxTokens <= 32000, 'asked for ' + request.maxTokens);
});

test('an unknown cap escalates to a bounded budget, not an arbitrary ceiling', async () => {
  const llm = route({ maxTokens: undefined, thinking: 20000 });
  const text = await summarizeWithModel({ llm, routes: [{ provider: 'synthetic', model: 'unknown', reasoningEffort: 'high' }],
    prompt: 'p', signal: new AbortController().signal, maxTokens: 16000 });
  assert.equal(text, ANSWER);
  assert.ok(llm.requests.every(request => request.maxTokens <= 32000), JSON.stringify(llm.requests.map(r => r.maxTokens)));
  assert.equal(llm.requests.length, 2);
});

test('a cap equal to the first budget does not add a pointless second attempt', async () => {
  const llm = route({ maxTokens: 16000, thinking: 0 });
  await summarizeWithModel({ llm, routes: [{ provider: 'synthetic', model: 'exact' }], prompt: 'p', signal: new AbortController().signal, maxTokens: 16000 });
  assert.equal(llm.requests.length, 1);
});
