import type { WeixinApiOptions, WeixinCredentials } from './weixin-api.js';
export declare const WEIXIN_MEDIA_LIMITS: Readonly<{ maxBytes: 10485760; maxFiles: 4; maxReplyBytes: 16384; maxParts: 9 }>;
export interface WeixinMediaDescription { readonly fileName: string; readonly kind: 'image' | 'file'; readonly bytes: number; readonly sha256: string; }
export interface WeixinDeliveryDescriptor extends WeixinMediaDescription { readonly reference: string; readonly turn: number; }
export interface WeixinTaskReply { readonly text: string; readonly deliverables: readonly WeixinDeliveryDescriptor[]; }
export interface WeixinSendMedia {
  readonly toUserId: string; readonly contextToken: string; readonly clientId: string;
  readonly fileName: string; readonly kind: 'image' | 'file'; readonly data: Uint8Array; readonly sha256: string;
}
export interface WeixinMediaGuards {
  /** Synchronous current account, task and source generation check at every network dispatch. */
  authorize(): boolean;
  /** Revalidate the original file/version/bytes before upload authorization, upload and send. */
  verify(): Promise<void>;
}
export interface WeixinMediaApi {
  /** At most three fixed-origin requests, no retry. Upload is not rolled back on cancellation. */
  sendMedia(auth: WeixinCredentials, message: WeixinSendMedia, signal: AbortSignal | undefined, guards: WeixinMediaGuards): Promise<{ readonly accepted: true }>;
}
/** Bounded content signature/type checks, not a full document parser or malware scan. */
export declare function describeWeixinMedia(fileName: string, data: Uint8Array): WeixinMediaDescription;
export declare function createWeixinMediaApi(options?: WeixinApiOptions): WeixinMediaApi;
