// Declaration-only author contract; runtime is the audited ESM module in lib/.
import type { Context } from '@deepseek-ai/cordis';
export { SESSION_BRIDGE_PRESET_ID, SessionBridgeError, isSessionBridgeId } from './session-bridge-agent.js';

export interface SessionBridgeArchive {
  getState(sessionId: string): {
    readonly granted: boolean;
    readonly allowWechat: boolean;
    readonly historyKnown: boolean;
    readonly sessionMayContainArchiveData: boolean;
  };
  canShare(sessionId: string): boolean;
  query(sessionId: string, query: {
    action: 'status' | 'contacts' | 'sessions' | 'messages' | 'search';
    talker?: string; query?: string; limit?: number; offset?: number; fromTs?: number; toTs?: number;
  }, signal?: AbortSignal, destination?: 'local' | 'wechat'): Promise<unknown>;
}
export interface SessionBridgeOptions {
  /** Revocable object capability; the tool never receives a grant/root/session id. */
  archive?: SessionBridgeArchive;
  /** 1–300000ms. Cancellation returns promptly while ownership remains held until drain. */
  timeoutMs?: number;
}
export interface SessionBridge {
  /** Create a distinct safe log at the context cwd; model routing comes from the native default service, not copied context history. */
  createConversation(contextSessionId: string, signal?: AbortSignal): Promise<string>;
  isPrepared(sessionId: string): boolean;
  /** Restore a safe native log or bind a live GUI agent with the exact installed policy; no foreign handle ownership is claimed. */
  ensure(sessionId: string, signal?: AbortSignal): Promise<void>;
  reply(sessionId: string, text: string, metadata: { messageId: string }, signal?: AbortSignal): Promise<string>;
  /** Memory-only conservative archive-result projection, not a persistence barrier. */
  hasArchiveHistory(sessionId: string): boolean | 'unknown';
  dispose(): Promise<void>;
}
export declare const SESSION_BRIDGE_INFO: Readonly<{
  agentPreset: 'dsh-wechat-native-ro-v1'; sandboxMode: 'read-only'; messageSource: 'wechat-ro-weixin';
  defaultTimeoutMs: 120000; maxTimeoutMs: 300000; maxInputBytes: 16384; maxReplyBytes: 16384;
}>;
export declare function createSessionBridge(ctx: Context, options?: SessionBridgeOptions): SessionBridge;
