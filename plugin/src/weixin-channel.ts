// Typed authoring contract for the server-only lib/weixin-channel.js.
// Emit only this file's declaration; never use a project-wide declaration build.
import type { WeixinApi, WeixinApiErrorCode, WeixinCredentials, WeixinUpdatesDiagnostic } from './weixin-api.js';
import type { WeixinDeliveryDescriptor, WeixinTaskReply } from './weixin-media.js';
export type { WeixinCredentials } from './weixin-api.js';

export type WeixinChannelErrorCode =
  | 'invalid-options' | 'disabled' | 'not-configured' | 'disposed' | 'busy'
  | 'invalid-input' | 'aborted' | 'invalid-state' | 'invalid-response'
  | 'store-failed' | 'store-outcome-unknown' | 'api-failed' | 'reply-failed'
  | 'invalid-reply' | 'send-failed' | 'already-paired' | 'login-active'
  | 'login-required' | 'login-not-confirmed' | 'not-paired'
  | 'recovery-required' | 'no-pending' | 'revision-exhausted'
  | 'owner-mismatch' | 'session-mismatch' | 'send-blocked';

/** Fixed messages/codes only: no original exception, cause, body, token or text. */
export declare class WeixinChannelError extends Error {
  readonly name: 'WeixinChannelError';
  readonly code: WeixinChannelErrorCode;
  /** True when an attempted send cannot safely be assumed not to have happened. */
  readonly deliveryUnknown: boolean;
  /** Closed API code only, on api-failed/send-failed; never raw response metadata. */
  readonly apiErrorCode?: WeixinApiErrorCode;
  constructor(code: WeixinChannelErrorCode, deliveryUnknown?: boolean, apiErrorCode?: WeixinApiErrorCode);
}

export interface WeixinLegacyChannelState {
  readonly version: 1;
  readonly revision: number;
  /** Null is a durable unpaired tombstone; cursor/seen/pending must then be empty. */
  readonly credentials: Readonly<WeixinCredentials> | null;
  readonly cursor: string;
  readonly seenMessageIds: readonly string[];
  readonly pending: Readonly<{ messageId: string; clientId: string }> | null;
}

export type WeixinQueuedMessage = Awaited<ReturnType<WeixinApi['getUpdates']>>['messages'][number];
export interface WeixinQueuedBatch {
  /** Only this scanner owner's complete private, nonblank, unseen text is stored. */
  readonly messages: readonly WeixinQueuedMessage[];
  readonly received: number;
  readonly replied: number;
  readonly ignored: number;
  readonly duplicates: number;
}
export type WeixinSessionOutbox =
  | { readonly messageId: string; readonly clientId: string; readonly phase: 'replying'; readonly replyText: null }
  | { readonly messageId: string; readonly clientId: string; readonly phase: 'ready' | 'sending'; readonly replyText: string };
export interface WeixinSessionChannelState {
  readonly version: 2;
  readonly revision: number;
  /** Exact binding is validated before any effects; never migrate to another id. */
  readonly sessionId: string;
  readonly credentials: Readonly<WeixinCredentials> | null;
  readonly cursor: string;
  readonly seenMessageIds: readonly string[];
  /** Persisted in the SAME atomic CAS as cursor, before any reply or send. */
  readonly queuedBatch: WeixinQueuedBatch | null;
  readonly pending: WeixinSessionOutbox | null;
}
export type WeixinDeliveryPart = { readonly kind: 'text'; readonly clientId: string; readonly text: string }
  | (WeixinDeliveryDescriptor & { readonly clientId: string });
export interface WeixinTaskOutbox {
  readonly messageId: string; readonly phase: 'replying' | 'ready' | 'sending';
  readonly parts: readonly WeixinDeliveryPart[] | null;
  /** Durably accepted prefix; never a phone delivery receipt. */
  readonly next: number;
}
export interface WeixinTaskChannelState extends Omit<WeixinSessionChannelState, 'version' | 'pending'> {
  readonly version: 3;
  readonly pending: WeixinTaskOutbox | null;
}
export type WeixinChannelState = WeixinLegacyChannelState | WeixinSessionChannelState | WeixinTaskChannelState;

/**
 * Trusted same-process persistence boundary. read returns a pure JSON snapshot.
 * commit MUST be atomic CAS: null expects no record; otherwise the exact revision.
 * Initial revision is 1; each write adds 1, including null-credential tombstones.
 * Never delete/reset revisions: the tombstone prevents forget/re-pair ABA.
 * A rejected/aborted commit may already have applied; never retry/compensate it.
 * Manual recovery must quiesce all workers; CAS cannot revoke issued effects.
 * v1 remains ID-only. Opt-in v2 persists bounded owner text/context/outbox in
 * the fixed-session owned Credentials scope; never persist QR or expose state
 * through Inspect/log/model. ret=0 is request acceptance, never delivery proof.
 */
export interface WeixinStateStore {
  read(): Promise<WeixinChannelState | undefined>;
  commit(expectedRevision: number | null, next: WeixinChannelState): Promise<void>;
}

/**
 * Strict pure-JSON shape/budget validation; returns a detached, deep-frozen copy.
 * IDs follow the API ASCII policy; botToken is printable nonspace ASCII. Other
 * opaque tokens exclude ASCII whitespace/control. baseUrl must be the exact
 * https://ilinkai.weixin.qq.com origin (no trailing slash or other URL components).
 */
export declare function validateWeixinState(value: unknown): WeixinChannelState;

export interface WeixinChannelStatus {
  readonly enabled: boolean;
  readonly phase: 'disabled' | 'unpaired' | 'qr-ready' | 'awaiting-confirmation'
    | 'paired' | 'recovery-required';
  readonly hasStoredLogin: boolean;
  readonly pendingRecovery: boolean;
  /** Durable v2/v3 retained replying outbox has a configured continuation callback. */
  readonly resumeAvailable?: boolean;
  readonly messagingVerified: false;
  readonly delivery?: { readonly accepted: number; readonly total: number; readonly phase: 'ready' | 'sending' } | null;
}

export type WeixinChannelQrStatus = Awaited<ReturnType<WeixinApi['getQrStatus']>>['status'];
/** Explicit owner-only action projection; never include it in Inspect/model/status. */
export type WeixinPairingOwnerStatus =
  | { readonly status: 'confirmed'; readonly expectedOwnerId: string; readonly botId: string }
  | { readonly status: Exclude<WeixinChannelQrStatus, 'confirmed'> };

export interface WeixinChannel {
  /** One diagnostic request using current validated pairing and version/session
   * binding. Serializes with other actions. Existing pending/inbox/outbox is
   * retained without commits; no login, cursor persistence, model, reply or send. */
  diagnoseUpdatesOnce(signal?: AbortSignal): Promise<WeixinUpdatesDiagnostic>;
  /** No IDs, credentials, QR content or cursor. Phase is not messaging readiness. */
  getStatus(signal?: AbortSignal): Promise<WeixinChannelStatus>;
  /** Private composition only, NOT Remote/Inspect/model. Paired bot/owner IDs for
   * Root's same-process account+peer poller lock; throws not-paired otherwise. */
  getPairingIdentity(signal?: AbortSignal): Promise<{ readonly botId: string; readonly userId: string }>;
  /** Sensitive output only for a controlled QR display. No implicit replacement. */
  beginLogin(signal?: AbortSignal): Promise<{ readonly qrContent: string }>;
  /** Official statuses only; confirmed credentials remain in memory until confirmed. */
  pollLogin(verifyCode?: string, signal?: AbortSignal): Promise<{
    readonly status: WeixinChannelQrStatus; readonly expectedOwnerId?: string; readonly botId?: string;
  }>;
  /** IDs only on confirmed, for an explicit authenticated owner action result. */
  pollLoginForOwner(verifyCode?: string, signal?: AbortSignal): Promise<WeixinPairingOwnerStatus>;
  confirmPairing(signal?: AbortSignal): Promise<{ readonly paired: true }>;
  /** Exact expected scanner ID is checked before any credential persistence. */
  confirmPairingForOwner(expectedOwnerId: string, signal?: AbortSignal): Promise<{ readonly paired: true }>;
  /** Clears only local transient data; does not revoke an upstream login attempt. */
  cancelLogin(signal?: AbortSignal): Promise<void>;
  /**
   * received = replied + ignored + duplicates on a successful complete batch.
   * v1 moves cursor only after all processing. v2 atomically persists owner inbox
   * with cursor before effects, then replying/ready/sending claims surround reply
   * and send. Only ready may resume send without AI; ambiguous phases need discard.
   * Nonblank text is untrimmed. ret=0 is request acceptance, never delivery proof.
   */
  pollOnce(signal?: AbortSignal): Promise<{
    readonly received: number; readonly replied: number;
    readonly ignored: number; readonly duplicates: number;
  }>;
  /** Durable v2/v3 only: one read at most, one owner text input and one text send
   * at most; never media or text chunking. Rejects all pre-existing outboxes.
   * Retains remaining inbox messages. Counts are for this call, not prior replies.
   * received = replied + ignored + duplicates + remaining on success.
   * Request acceptance is not a phone receipt; failures never retry automatically. */
  pollTextOnce(signal?: AbortSignal): Promise<{
    readonly received: number; readonly replied: 0 | 1;
    readonly ignored: number; readonly duplicates: number; readonly remaining: number;
  }>;
  /** Explicitly continues only a retained replying input. One linked native
   * continuation and one text send at most; retains pairing, cursor and remaining
   * queue. No update read or original-input admission; ready/sending are rejected. */
  resumeTextOnce(confirmation: 'continue-unanswered-message', signal?: AbortSignal): Promise<{
    readonly received: number; readonly replied: 0 | 1;
    readonly ignored: number; readonly duplicates: number; readonly remaining: number;
  }>;
  /** Skip the claimed message without retrying DSH or send; leaves cursor unchanged. */
  discardPending(confirmation: 'discard-without-retry', signal?: AbortSignal): Promise<void>;
  /** CAS-write an unpaired monotone tombstone, not token revocation. Pending is rejected. */
  forget(confirmation: 'forget-local-credentials', signal?: AbortSignal): Promise<void>;
  /** Cancel local waits and clear transient QR/credentials; never delete stored state. */
  dispose(): void;
}

export interface WeixinChannelOptions {
  enabled?: boolean;
  /** Explicit fixed binding selects durable v2; absent retains exact legacy v1. */
  sessionId?: string;
  /** Synchronous true only. Root must check current grant/run generation/taint and
   * also abort on stop/revocation. Checked after sending CAS and at invocation. */
  beforeSend?: () => boolean;
  /** Private synchronous fact observer for a checked pollTextOnce API acceptance,
   * before the completion CAS. No grant, reply body or phone-delivery evidence. */
  onTextAccepted?: () => void;
  api?: WeixinApi;
  store?: WeixinStateStore;
  reply?: (text: string, metadata: { messageId: string }, signal: AbortSignal) => Promise<string>;
  /** Uses the retained original text/id only to prove its failed native input;
   * must append a linked continuation, never admit that WeChat input again. */
  resumeReply?: (text: string, metadata: { messageId: string }, signal: AbortSignal) => Promise<string>;
  /** Explicit fixed-Task opt-in selects v3, not an in-place v2 state migration. */
  media?: {
    reply(text: string, metadata: { messageId: string }, signal: AbortSignal): Promise<WeixinTaskReply>;
    send(auth: WeixinCredentials, message: WeixinDeliveryDescriptor & { toUserId: string; contextToken: string; clientId: string }, signal: AbortSignal, authorize: () => boolean): Promise<{ readonly accepted: true }>;
    release(references: readonly string[]): void;
  };
}

/**
 * Server-only, no constructor/import I/O, timer, global fetch, background polling or
 * automatic retry. Only enabled:true allows operations; complete dependencies are
 * required before any I/O. Options are checked without reading dependency methods.
 * One operation per instance; a concurrent operation fails busy, never queues.
 * Cancellation ends the local wait promptly even if a trusted dependency ignores it.
 * This cannot isolate malicious same-process dependencies, stop already-issued
 * effects, or enforce their time budgets. No exactly-once guarantee: pending claims
 * deliberately trade automatic retry for explicit potentially-lossy recovery.
 */
export declare function createWeixinChannel(options?: WeixinChannelOptions): WeixinChannel;
