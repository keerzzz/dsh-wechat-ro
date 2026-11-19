import type { ZodType } from 'zod';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { WeixinChannel, WeixinChannelStatus } from './weixin-channel.js';
export declare const name: 'wechat-ro-weixin-admin';
export declare const inject: readonly ['connection', 'credentials'];
export declare const WEIXIN_ADMIN_INFO: {
    readonly basePath: '/api/wechat-ro-weixin';
    readonly maxRequestBytes: 4096;
    readonly defaultRequestTimeoutMs: 40000;
    readonly maxRequestTimeoutMs: 120000;
};
export interface WeixinAdminConfig {
    /** Default false. Enables only explicit pairing administration, never messaging. */
    readonly enabled?: boolean;
    /** Integer 1..120000; defaults to the core API's 40000ms. */
    readonly apiTimeoutMs?: number;
    /** Integer 1..1048576; may lower but not raise the core 1 MiB hard limit. */
    readonly maxResponseBytes?: number;
    /** Integer 1..120000, default 40000; includes request body, static I/O and channel waits. */
    readonly requestTimeoutMs?: number;
}
export type Config = WeixinAdminConfig;
/** Existing Zod Standard Schema consumed by Cordis; no dependency/test hooks in configuration. */
export declare const Config: ZodType<Required<WeixinAdminConfig>>;
export interface WeixinAdminRoute {
    readonly path: string;
    readonly methods: readonly ('GET' | 'HEAD' | 'POST')[];
    readonly requestBody: 'buffered' | 'streaming';
}
export declare const WEIXIN_ADMIN_ROUTES: readonly WeixinAdminRoute[];
export type WeixinAdminErrorCode = 'invalid-options' | 'invalid-request' | 'invalid-json' | 'invalid-input' | 'unsupported-media-type' | 'body-too-large' | 'not-found' | 'method-not-allowed' | 'disabled' | 'disposed' | 'aborted' | 'timeout' | 'busy' | 'not-configured' | 'asset-unavailable' | 'registration-failed' | 'invalid-state' | 'invalid-response' | 'store-failed' | 'store-outcome-unknown' | 'api-failed' | 'already-paired' | 'login-active' | 'login-required' | 'login-not-confirmed' | 'not-paired' | 'recovery-required' | 'revision-exhausted' | 'operation-failed';
export declare const WEIXIN_ADMIN_ERROR_CODES: readonly WeixinAdminErrorCode[];
export type WeixinAdminAction = {
    readonly action: 'beginLogin';
    readonly confirmation: 'request-qr';
} | {
    readonly action: 'pollLogin';
    readonly verifyCode?: string;
} | {
    readonly action: 'confirmPairing';
    readonly confirmation: 'persist-pairing';
} | {
    readonly action: 'cancelLogin';
} | {
    readonly action: 'forget';
    readonly confirmation: 'forget-local-credentials';
};
export interface WeixinAdminStatus extends WeixinChannelStatus {
    readonly messagingEnabled: false;
    readonly automaticPolling: false;
}
export type WeixinAdminResult<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: {
        readonly code: WeixinAdminErrorCode;
        readonly outcomeUnknown: boolean;
    };
};
/** Only pairing methods are read; the handler cannot access message/agent methods. */
export type WeixinAdminChannel = Pick<WeixinChannel, 'getStatus' | 'beginLogin' | 'pollLogin' | 'confirmPairing' | 'cancelLogin' | 'forget' | 'dispose'>;
export interface WeixinAdminHandlerOptions {
    readonly enabled?: boolean;
    readonly requestTimeoutMs?: number;
    /** Trusted, owned, same-process dependency. Not plugin/browser configuration. Untouched while disabled. */
    readonly channel?: WeixinAdminChannel;
}
export interface WeixinAdminHandler {
    /** Only call behind authenticated owner authorization. Direct factory calls own/cancel their Request body. */
    fetch(request: Request): Promise<Response>;
    /** Idempotent. Abort local requests and dispose the owned channel; no remote/CAS rollback promise. */
    dispose(): Promise<void>;
}
/** No I/O/timer at construction. Five exact routes; static files are read, never imported/executed. */
export declare function createWeixinAdminHandler(options?: WeixinAdminHandlerOptions): WeixinAdminHandler;
export interface WeixinAdminFetchRoute extends WeixinAdminRoute {
    readonly fetch: (request: Request) => Promise<Response>;
}
/** Structural subset of the real HostConnectionFetch/Cordis contract, not a replacement service. */
export interface WeixinAdminContext {
    readonly connection: {
        readonly fetch: {
            register(route: WeixinAdminFetchRoute): () => Promise<void>;
        };
    };
    readonly credentials: Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>;
    effect(setup: () => (() => void | Promise<void>), label?: string): () => Promise<void>;
}
/**
 * The host registrar owns its effects; only the channel lifecycle gets an additional effect.
 * Streaming callbacks borrow the carrier body without propagating cancellation to it;
 * HostConnection's HTTP bridge owns underlying request teardown after the response.
 */
export declare function apply(ctx: WeixinAdminContext, config?: WeixinAdminConfig): Promise<void>;
declare const plugin: {
    readonly name: typeof name;
    readonly inject: typeof inject;
    readonly Config: typeof Config;
    readonly apply: typeof apply;
};
export default plugin;
