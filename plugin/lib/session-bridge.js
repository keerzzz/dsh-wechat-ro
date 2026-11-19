import { randomUUID } from 'node:crypto';
import {
  SESSION_BRIDGE_PRESET_ID, SessionBridgeError, isSessionBridgeId,
  assertSessionBridgeHistory, bindSessionBridgeArchive, installSessionBridgePolicy,
  hasSessionBridgePolicy,
} from './session-bridge-agent.js';
import { createNativeSessionBridge } from './native-session-bridge.js';

export { SESSION_BRIDGE_PRESET_ID, SessionBridgeError, isSessionBridgeId };
export const SESSION_BRIDGE_INFO = Object.freeze({
  agentPreset: SESSION_BRIDGE_PRESET_ID, sandboxMode: 'read-only', messageSource: 'wechat-ro-weixin',
  defaultTimeoutMs: 120000, maxTimeoutMs: 300000, maxInputBytes: 16384, maxReplyBytes: 16384,
});
const fail = code => { throw new SessionBridgeError(code); };

function inspectReadonlyHistory(session) {
  try {
    assertSessionBridgeHistory(session);
    const calls = new Map();
    for (const event of session.snapshotEvents()) {
      if (event.type === 'tool/call') {
        let action;
        try { action = JSON.parse(event.data.arguments).action; } catch { return 'unknown'; }
        calls.set(event.data.callId, action);
      } else if (event.type === 'tool/result' && event.data.error === undefined && event.data.message?.isError !== true) {
        const action = calls.get(event.data.message?.toolCallId);
        if (action === undefined) return 'unknown';
        if (action !== 'status') return true;
      }
    }
    return false;
  } catch { return 'unknown'; }
}

const READONLY_POLICY = Object.freeze({
  info: SESSION_BRIDGE_INFO,
  isSessionId: isSessionBridgeId,
  createSessionId: () => `wechat-native-ro-${randomUUID()}`,
  requireData(data) {
    if (!data || typeof data.query !== 'function' || typeof data.getState !== 'function'
      || typeof data.canShare !== 'function') fail('archive-unavailable');
  },
  bindData: bindSessionBridgeArchive,
  assertHistory: assertSessionBridgeHistory,
  install: installSessionBridgePolicy,
  hasPolicy: hasSessionBridgePolicy,
  inspectHistory: inspectReadonlyHistory,
});

export function createSessionBridge(ctx, options = {}) {
  if (!ctx || !options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['archive', 'timeoutMs'].includes(key))) fail('invalid-options');
  const timeoutMs = options.timeoutMs ?? SESSION_BRIDGE_INFO.defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SESSION_BRIDGE_INFO.maxTimeoutMs) fail('invalid-options');
  const bridge = createNativeSessionBridge(ctx, options.archive, timeoutMs, READONLY_POLICY);
  return Object.freeze({
    createConversation: (contextSessionId, signal) => bridge.createConversation(contextSessionId, signal),
    isPrepared: bridge.isPrepared,
    ensure: bridge.ensure,
    reply: bridge.reply,
    hasArchiveHistory: bridge.hasDataHistory,
    dispose: bridge.dispose,
  });
}
