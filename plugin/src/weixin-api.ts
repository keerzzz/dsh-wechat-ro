// Typed authoring contract for the independently implemented server-only lib/weixin-api.js.
// Generate lib/types/weixin-api.d.ts with tsc; this declare module has no runtime implementation.

export declare const WEIXIN_API_INFO: {
  readonly origin: 'https://ilinkai.weixin.qq.com';
  readonly version: '0.1.0';
  readonly botAgent: 'WechatRo/0.1.0';
};
export declare const WEIXIN_LIMITS: {
  readonly maxResponseBytes: 1048576;
  readonly maxTextBytes: 4000;
  readonly maxMessages: 256;
  readonly maxTokenBytes: 8192;
  readonly maxQrCodeBytes: 8192;
  readonly maxCursorBytes: 65536;
  readonly maxVerifyCodeBytes: 64;
  readonly maxIdentifierBytes: 512;
  readonly defaultTimeoutMs: 40000;
};

export type WeixinApiErrorCode =
  | 'not-configured' | 'invalid-options' | 'invalid-input'
  | 'unsupported-origin' | 'unsupported-redirect'
  | 'network-error' | 'timeout' | 'aborted' | 'http-error' | 'business-error'
  | 'invalid-mime' | 'invalid-json' | 'response-too-large' | 'invalid-response';

export interface WeixinApiErrorDetails {
  readonly httpStatus?: number;
  readonly businessCode?: number;
  readonly deliveryUnknown?: boolean;
}
/** Fixed redacted message, closed code and safe numeric metadata only; no raw cause. */
export declare class WeixinApiError extends Error {
  readonly name: 'WeixinApiError';
  readonly code: WeixinApiErrorCode;
  readonly httpStatus?: number;
  readonly businessCode?: number;
  /** Conservative uncertainty, including HTTP 5xx/408/redirect statuses; never a retry or rollback guarantee. */
  readonly deliveryUnknown: boolean;
  constructor(code: WeixinApiErrorCode, details?: WeixinApiErrorDetails);
}

/** Explicit trusted transport. It must honor RequestInit, including redirect:'error'. */
export type WeixinApiFetcher = (input: string, init: RequestInit) => Promise<Response>;
export interface WeixinApiOptions {
  readonly fetcher?: WeixinApiFetcher;
  /** Integer 1..120000; defaults to 40000. Covers fetch and streamed body reading. */
  readonly timeoutMs?: number;
  /** Integer 1..1048576; may lower but not raise the 1 MiB hard limit. */
  readonly maxResponseBytes?: number;
}

export interface WeixinCredentials {
  readonly botToken: string;
  readonly botId: string;
  readonly userId: string;
  /** Only the fixed official origin, optionally ending in '/', is accepted. */
  readonly baseUrl: string;
}
export interface WeixinTextMessage {
  /** Canonical positive uint64 decimal ID; numeric wire IDs are decoded without rounding. */
  readonly messageId: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly contextToken: string;
  readonly text: string;
}
export interface WeixinSendText {
  readonly toUserId: string;
  readonly contextToken: string;
  readonly clientId: string;
  readonly text: string;
}
export interface WeixinQrCode {
  readonly qrcode: string;
  /** Opaque QR content, not fetched or inserted into HTML by this module. */
  readonly qrContent: string;
}
export type WeixinQrStatus =
  | { readonly status: 'wait' }
  | { readonly status: 'scaned' }
  | { readonly status: 'confirmed'; readonly credentials: WeixinCredentials }
  | { readonly status: 'expired' }
  | { readonly status: 'need_verifycode' }
  | { readonly status: 'verify_code_blocked' }
  | { readonly status: 'scaned_but_redirect'; readonly redirectHost?: typeof WEIXIN_API_INFO.origin }
  /** This status is not evidence of authentication in this host. */
  | { readonly status: 'binded_redirect' };
export interface WeixinUpdates {
  /** Nonempty returned cursor, or caller's previous cursor when omitted/empty; no sync_buf fallback. */
  readonly cursor: string;
  readonly messages: readonly WeixinTextMessage[];
  readonly ignored: number;
}

export declare const WEIXIN_UPDATE_DIAGNOSTIC: {
  readonly version: 1;
  readonly outcomes: readonly ['valid', 'invalid', 'failed'];
  readonly invalidErrorCodes: readonly ['invalid-response', 'invalid-json', 'invalid-mime', 'response-too-large'];
  readonly validationFields: readonly ['http-response', 'response-body', 'root', 'ret', 'errcode', 'msgs', 'get_updates_buf',
    'message', 'message_type', 'message_state', 'group_id', 'item_list', 'item', 'item_type', 'ref_msg',
    'text_item', 'text', 'message_id', 'from_user_id', 'to_user_id', 'context_token'];
  readonly msgsShapes: readonly ['omitted', 'null', 'array', 'other'];
  readonly cursorShapes: readonly ['omitted', 'empty', 'string', 'other'];
};

/** Fixed structural facts from one update request. No received values or exceptions. */
export interface WeixinUpdatesDiagnostic {
  readonly version: 1;
  readonly outcome: typeof WEIXIN_UPDATE_DIAGNOSTIC.outcomes[number];
  readonly errorCode: WeixinApiErrorCode | null;
  readonly validationField: typeof WEIXIN_UPDATE_DIAGNOSTIC.validationFields[number] | null;
  readonly msgsShape: typeof WEIXIN_UPDATE_DIAGNOSTIC.msgsShapes[number] | null;
  readonly cursorShape: typeof WEIXIN_UPDATE_DIAGNOSTIC.cursorShapes[number] | null;
  /** 0..256 when observed; oversized/nonarray pages and undecoded roots leave null. */
  readonly messageCount: number | null;
  /** Observed only after full successful page projection. */
  readonly textCount: number | null;
  readonly ignoredCount: number | null;
  readonly httpStatus: number | null;
  readonly businessCode: number | null;
}

/** Frozen, stateless API. Each method performs at most one request, never a retry. */
export interface WeixinApi {
  requestQrCode(signal?: AbortSignal): Promise<WeixinQrCode>;
  getQrStatus(qrcode: string, verifyCode?: string, signal?: AbortSignal): Promise<WeixinQrStatus>;
  getUpdates(credentials: WeixinCredentials, cursor: string, signal?: AbortSignal): Promise<WeixinUpdates>;
  /** At most one getupdates request using the same transport/parser. Returns fixed
   * facts for success or failure; does not persist a cursor, reply, or retry. */
  diagnoseUpdatesOnce(credentials: WeixinCredentials, cursor: string, signal?: AbortSignal): Promise<WeixinUpdatesDiagnostic>;
  sendText(credentials: WeixinCredentials, message: WeixinSendText, signal?: AbortSignal): Promise<{ readonly accepted: true }>;
}

/**
 * Node 22.19+/24 server-only module; never import it in the UI.
 * Import/construction do no I/O and start no timers. Options accept only these keys.
 * Without a fetcher operations fail not-configured; global fetch is never selected.
 * IDs use a conservative ASCII policy: [A-Za-z0-9_][A-Za-z0-9._:@-]*, at most 512 bytes.
 * Tokens are nonempty, bounded and free of ASCII whitespace/control characters;
 * the HTTP botToken additionally requires printable ASCII. No input is trimmed.
 * Only complete private text is projected. Host ownership checks remain the caller's job.
 * Local cancellation is not remote rollback. No full server compatibility is claimed.
 */
export declare function createWeixinApi(options?: WeixinApiOptions): WeixinApi;
