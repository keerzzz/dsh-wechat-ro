// Derive the materialized ResultValue/projection shape from the installed SDK.
import type { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
export type TypertRemoteInfo = ReturnType<typeof createTypertRemoteInfo>;
export declare const TYPERT_REMOTE: TypertRemoteInfo;
export default TYPERT_REMOTE;
