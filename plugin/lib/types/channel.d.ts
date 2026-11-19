/** Review target only: not evidence that this provider is installed or running. */
export declare const WECHAT_CHANNEL_PROVIDER: {
    readonly package: 'dsh-channel-wechat';
    readonly reviewedVersion: '0.2.8';
};
/** Fixed same-origin paths. Opening login automatically begins an upstream attempt. */
export declare const WECHAT_CHANNEL_ENDPOINTS: {
    readonly status: '/api/channel-wechat/status';
    readonly begin: '/api/channel-wechat/begin';
    readonly verifyCode: '/api/channel-wechat/verify-code';
    readonly logout: '/api/channel-wechat/logout';
    readonly qrImage: '/api/channel-wechat/qr.svg';
    readonly login: '/api/channel-wechat/login';
};
export declare const CHANNEL_LOGIN_PHASES: readonly [
    'idle',
    'waiting',
    'scanned',
    'need-verifycode',
    'connected',
    'already-connected',
    'failed'
];
export type ChannelLoginPhase = typeof CHANNEL_LOGIN_PHASES[number];
export type WechatChannelErrorCode = 'not-configured' | 'invalid-code' | 'aborted' | 'unauthorized' | 'forbidden' | 'not-found' | 'http-error' | 'network-error' | 'invalid-json' | 'invalid-mime' | 'invalid-response';
/** Fixed, redacted messages; never carries a raw response, input, body or cause. */
export declare class WechatChannelError extends Error {
    readonly name: 'WechatChannelError';
    readonly code: WechatChannelErrorCode;
    readonly status?: number;
    constructor(code: WechatChannelErrorCode, status?: number);
}
/** Explicit transport injection; the client never falls back to global fetch. */
export type WechatChannelFetcher = (input: string, init: RequestInit) => Promise<Response>;
/** Only this whitelisted projection is returned by getStatus. */
export interface WechatChannelStatus {
    readonly loginPhase: ChannelLoginPhase;
    /** A non-empty storedAccountId was reported; not proof that it is usable/current. */
    readonly hasStoredLogin: boolean;
    /** A non-empty QR URL was reported, not proof that its image is still available. */
    readonly qrAvailable: boolean;
    readonly qrImagePath: typeof WECHAT_CHANNEL_ENDPOINTS.qrImage | null;
    /** Login phase/stored credentials cannot verify the actual messaging channel. */
    readonly messagingVerified: false;
}
/** POST responses report only the upstream attempt phase, never messaging readiness. */
export interface WechatChannelLoginResult {
    readonly loginPhase: ChannelLoginPhase;
}
/**
 * Each method performs at most one request; no polling, retry or compensating logout.
 * AbortSignal cancels only this wait, not the upstream QR/login attempt or its effects.
 */
export interface WechatChannelClient {
    getStatus(signal?: AbortSignal): Promise<WechatChannelStatus>;
    beginLogin(signal?: AbortSignal): Promise<WechatChannelLoginResult>;
    /** Accepts any trimmed non-empty string, submitted as the sole form field code. */
    submitVerifyCode(code: string, signal?: AbortSignal): Promise<WechatChannelLoginResult>;
    /** Does not reset phase locally or treat a successful response as an idle state. */
    logout(signal?: AbortSignal): Promise<WechatChannelLoginResult>;
    /**
     * 404 means no QR (null). Only image/svg+xml is accepted. Use the Blob with img,
     * not inline SVG/HTML; the consumer must create/revoke its own Blob URLs.
     */
    readQrImage(signal?: AbortSignal): Promise<Blob | null>;
}
/**
 * Import/construction have no I/O, timers, login-page opening or global side effects.
 * Omitted/non-callable fetcher leaves every operation not-configured, even if aborted.
 * The supplied transport must honor same-origin/no-store/redirect:error RequestInit.
 */
export declare function createWechatChannelClient(fetcher?: WechatChannelFetcher): WechatChannelClient;
