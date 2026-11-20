// Daily-card summary call: one bounded, tool-free model request per route.
// Finish reasons are classified instead of collapsed into "not completed", so a
// truncated output, a provider rejection and a context revocation stay distinct.
const RETRYABLE_CODES = new Set(['AUTH', 'RATE_LIMIT', 'QUOTA_EXCEEDED', 'SERVER', 'TIMEOUT', 'TRANSPORT',
  'EMPTY_RESPONSE', 'PI_AI_ERROR', 'SUMMARY_MODEL_FAILED', 'SUMMARY_TRUNCATED']);
const DEFAULT_MAX_TOKENS = 16000, MAX_MAX_TOKENS = 64000;

function failed(code, cause) {
  const error = Object.assign(new Error(code), { code });
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause, enumerable: false });
  return error;
}
const routeKey = route => route.provider + '\u0000' + route.model;

// Selected route first, then the deployment default once. A route that cannot
// answer must not consume the only attempt, and an identical route is not retried.
export function summaryRoutes(selected, fallback) {
  const routes = [];
  for (const route of [selected, fallback]) {
    if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') continue;
    if (!route.provider.trim() || !route.model.trim()) continue;
    if (routes.some(entry => routeKey(entry) === routeKey(route))) continue;
    routes.push({ provider: route.provider, model: route.model,
      ...(typeof route.reasoningEffort === 'string' && route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) });
  }
  return routes;
}

async function modelLimit(llm, route) {
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model);
    const limit = info?.maxTokens;
    return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_MAX_TOKENS) : MAX_MAX_TOKENS;
  } catch { return MAX_MAX_TOKENS; }
}

async function attempt(llm, route, prompt, signal, maxTokens, byteLimit) {
  let text = '', finish;
  for await (const chunk of llm.stream({ provider: route.provider, model: route.model,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [], maxTokens, signal })) {
    signal.throwIfAborted();
    if (chunk.type === 'text-delta') text += chunk.text;
    if (Buffer.byteLength(text) > byteLimit) throw failed('SUMMARY_BYTE_BUDGET');
    if (chunk.type === 'finish') finish = chunk.reason;
  }
  if (!finish) throw failed('SUMMARY_MODEL_FAILED');
  if (finish.kind === 'aborted') throw failed('SUMMARY_MODEL_FAILED', 'ABORTED');
  if (finish.kind === 'error') throw failed('SUMMARY_MODEL_FAILED', finish.failure?.code ?? 'UNKNOWN');
  if (finish.kind === 'max-tokens') throw failed('SUMMARY_TRUNCATED');
  if (finish.kind !== 'stop') throw failed('SUMMARY_MODEL_FAILED', finish.kind);
  if (!text.trim()) throw failed('SUMMARY_EMPTY');
  return text;
}

// One summary, at most one truncation retry per route and one fallback route.
export async function summarizeWithModel({ llm, routes, prompt, signal, maxTokens = DEFAULT_MAX_TOKENS, byteLimit = 65536 }) {
  if (!llm || typeof llm.stream !== 'function') throw failed('SUMMARY_MODEL_UNAVAILABLE');
  const list = Array.isArray(routes) ? routes : [];
  if (!list.length) throw failed('SUMMARY_MODEL_UNAVAILABLE');
  let last;
  for (const route of list) {
    const ceiling = await modelLimit(llm, route);
    // The retry drops the reasoning effort: thinking tokens share the output
    // budget, so spending them again would truncate the same way.
    const ladder = [route];
    if (ceiling > maxTokens) { const plain = { ...route }; delete plain.reasoningEffort; ladder.push(plain); }
    const budgets = [Math.min(maxTokens, ceiling), ceiling];
    for (let index = 0; index < ladder.length; index++) {
      try {
        return await attempt(llm, ladder[index], prompt, signal, budgets[index], byteLimit);
      } catch (error) {
        last = error;
        const code = error?.code;
        if (code === 'SUMMARY_BYTE_BUDGET' || code === 'SUMMARY_EMPTY') throw error;
        if (code === 'SUMMARY_TRUNCATED' && index + 1 < ladder.length) continue;
        // The provider's own code rides along as the cause; retryability is a
        // property of that code, not of the wrapper this call reports.
        const reason = typeof error?.cause === 'string' ? error.cause : code;
        if (!RETRYABLE_CODES.has(reason)) throw error;
        break;
      }
    }
  }
  throw last ?? failed('SUMMARY_MODEL_FAILED');
}
