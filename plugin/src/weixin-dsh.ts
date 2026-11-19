// Typed authoring contract for the server-only DSH adapter.
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { WeixinApiFetcher } from './weixin-api.js';
import type { WeixinChannel, WeixinStateStore } from './weixin-channel.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'wechat-ro-weixin': { readonly kind: 'wechat-ro-weixin'; readonly messageId: string };
  }
}

export declare const WEIXIN_DSH_INFO: {
  readonly credentialScope: 'wechat-ro-weixin';
  readonly credentialId: 'account';
  readonly messageSource: 'wechat-ro-weixin';
  readonly sandboxMode: 'read-only';
  readonly defaultReplyTimeoutMs: 120000;
  readonly maxReplyTimeoutMs: 300000;
};
export type WeixinDshErrorCode =
  | 'invalid-options' | 'not-configured' | 'invalid-input' | 'disposed' | 'busy'
  | 'aborted' | 'timeout' | 'invalid-state' | 'state-conflict' | 'storage-failed'
  | 'invalid-workspace' | 'dsh-failed' | 'turn-unattributed' | 'turn-incomplete'
  | 'invalid-reply' | 'cleanup-failed';
/** Fixed codes/messages only; never retains a raw error, token or message. */
export declare class WeixinDshError extends Error {
  readonly name: 'WeixinDshError';
  readonly code: WeixinDshErrorCode;
  constructor(code: WeixinDshErrorCode);
}

/**
 * Only the owning grant key is used. Calls the real serialized modifyRecord API;
 * requires monotone tombstone revisions, never deleteRecord or undefined deletion.
 * The deployment must supply one trusted, durable CAS credential provider/writer.
 * A thrown write may have committed; callers must inspect state, not retry it.
 */
export declare function createWeixinCredentialStore(
  credentials: Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>,
): WeixinStateStore;

/**
 * Inert fixed-session grant adapter: same owning scope, id is `session-` followed
 * by the SHA-256 of the exact sessionId. The legacy `account` key is never read.
 * sessionId must be 1..512 ASCII alphanumeric/underscore/hyphen characters,
 * starting alphanumeric. v2 payloads must match this exact id on read/commit/CAS.
 * This is addressing/binding, NOT Session authorization; Root must
 * bind a separately prepared native Session and an immutable same-id reply closure.
 */
export declare function createWeixinSessionCredentialStore(
  credentials: Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>,
  sessionId: string,
): WeixinStateStore;

/** Separate v3 Task key; never reads or migrates a legacy pairing. */
export declare function createWeixinTaskCredentialStore(
  credentials: Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>,
  sessionId: string,
): WeixinStateStore;

export interface DshWeixinReplyOptions {
  /** Explicit absolute path in the DSH filesystem execution world. Never defaults to cwd. */
  readonly workspace?: string;
  /** Integer 1..300000, default 120000. Includes creation, reply and normal cleanup. */
  readonly timeoutMs?: number;
}
export interface DshWeixinReply {
  /** One fresh session per input; only the uniquely attributed completed turn's text. */
  reply(text: string, metadata: { readonly messageId: string }, signal?: AbortSignal): Promise<string>;
  /** Cancels the current local operation and drains the owned work/disposer. Idempotent. */
  dispose(): Promise<void>;
}
/**
 * No constructor I/O. The caller must inject agents/fs/workingDirectory/
 * sandboxPolicy. Only tools and event listeners are acquired on the factory-created
 * agent scope; cwd/policy services receive the explicit agent/session.
 * No existing session is resumed.
 * restrict(allow:[]) plus a monotonic guard deny tools before body execution.
 * The host's trusted plugins and prompt assembly are not isolated by this policy.
 * Cancellation returns promptly, but ignored host I/O/cleanup keeps the bridge busy
 * until it settles. dispose() waits for it; there is no remote/OS force-kill promise.
 * Only a visible handle.dispose rejection maps to cleanup-failed. Native Cordis
 * may catch/log effect errors and still resolve; those cannot suppress output here.
 */
export declare function createDshWeixinReply(ctx: Context, options?: DshWeixinReplyOptions): DshWeixinReply;

export interface DshWeixinOptions {
  readonly enabled?: boolean;
  readonly workspace?: string;
  readonly fetcher?: WeixinApiFetcher;
  readonly apiTimeoutMs?: number;
  readonly replyTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}
export interface DshWeixinRuntime {
  readonly channel: WeixinChannel;
  /** Close this runtime only; never revoke tokens or delete stored grants. */
  dispose(): Promise<void>;
}
/**
 * Explicit optional composition. Default disabled, with no global fetch, route,
 * timer, login or polling at construction. Enabling requires explicit transport,
 * workspace and credentials service; pairing/polling still require method calls.
 * The default plugin, wechatRo Remote and MCP surfaces are unchanged.
 */
export declare function createDshWeixinChannel(ctx: Context, options?: DshWeixinOptions): DshWeixinRuntime;
