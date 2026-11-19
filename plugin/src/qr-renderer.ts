// Declaration-only author contract; local runtime is in lib/qr-renderer.js.
export declare const QR_MAX_PAYLOAD_BYTES: 2048;
export interface LocalQrMatrix { readonly payloadKind: 'ilink-login'; readonly rows: readonly string[]; }
export declare class QrRenderError extends Error {
  readonly name: 'QrRenderError'; readonly code: 'QR_UNAVAILABLE'; constructor();
}
/** Loads a local encoder first. No image endpoint, credential or upstream QR request. */
export declare function prepareLocalQrRenderer(loadFactory?: () => Promise<unknown>): Promise<(payload: string) => LocalQrMatrix>;
