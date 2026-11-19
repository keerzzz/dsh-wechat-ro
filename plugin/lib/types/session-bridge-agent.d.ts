import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionBridgeArchive } from './session-bridge.js';
export declare const SESSION_BRIDGE_PRESET_ID: 'dsh-wechat-native-ro-v1';
export declare const SESSION_BRIDGE_TOOL: 'wechat_archive';
export declare const SESSION_BRIDGE_PROMPT: 'dsh-wechat-ro:native-readonly';
export type SessionBridgeErrorCode = 'invalid-options' | 'invalid-input' | 'disposed' | 'busy' | 'not-owned' | 'not-prepared' | 'unsafe-session' | 'preset-unavailable' | 'model-unavailable' | 'persistence-unavailable' | 'persistence-failed' | 'create-failed' | 'resume-failed' | 'aborted' | 'timeout' | 'already-processed' | 'not-completed' | 'no-reply' | 'archive-unavailable' | 'archive-denied';
export declare class SessionBridgeError extends Error {
    readonly code: SessionBridgeErrorCode;
    constructor(code: SessionBridgeErrorCode);
}
export declare function isSessionBridgeId(value: unknown): value is string;
/** @internal A revocable in-process capability, never a stored archive grant. */
export declare function bindSessionBridgeArchive(sessionId: string, archive: SessionBridgeArchive, destination: () => 'local' | 'wechat', agent?: Agent): () => void;
/** @internal Reject copied/broad/unverifiable native history. */
export declare function assertSessionBridgeHistory(session: Session, options?: {
    fresh?: boolean;
}): true;
/** @internal Factory setup and serial held GUI-resume hook share this exact installer. */
export declare function installSessionBridgePolicy(agentCtx: Context, agent: Agent, sandboxPolicy: Pick<Context['sandboxPolicy'], 'resolve'>): void;
export declare function hasSessionBridgePolicy(agent: Agent): boolean;
export declare const name: 'wechat-native-session-policy';
export declare const inject: readonly ['tools', 'systemPrompt', 'sandboxPolicy'];
export declare function apply(ctx: Context): void;
