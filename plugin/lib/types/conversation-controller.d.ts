import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { createArchiveAccess } from './archive-access.js';
import type { createSessionBridge } from './session-bridge.js';
import type { createTaskAccess } from './task-access.js';
import type { createTaskSessionBridge } from './task-session-bridge.js';
import type { createWeixinSessionCredentialStore } from './weixin-dsh.js';
import type { createWeixinApi, WeixinApiFetcher } from './weixin-api.js';
import type { createWeixinMediaApi } from './weixin-media.js';
import type { createWeixinChannel } from './weixin-channel.js';
import type { prepareLocalQrRenderer } from './qr-renderer.js';
import type { Config as PluginConfig } from './index.js';
import type { runLocalHistory } from './local-history.js';
import type { GetConversationStateRequest as ConversationStateRequest, ConversationState, ConversationAction as ConversationActionRequest, ConversationActionResult, GetTaskConversationStateRequest, TaskConversationState, TaskConversationAction, TaskConversationActionResult } from './conversation-wire.js';
export declare const CONVERSATION_VERSION: '0.2.0';
export declare class ConversationError extends Error {
    readonly name: 'ConversationError';
    readonly code: string;
    constructor(code: string);
}
/** Requires an actual canonical owner RemoteInvocation; outside-call is not owner. */
export declare function requireConversationOwner(invocation: unknown): void;
/** Owner-only archive and controlled Task actions; neither branch adds tools to an ordinary Session. */
export interface ConversationRuntime {
    /** Memory-only: selecting a Session never prepares/resumes it or opens storage. */
    getState(request: GetTaskConversationStateRequest, signal?: AbortSignal): TaskConversationState;
    getState(request?: ConversationStateRequest, signal?: AbortSignal): ConversationState;
    /** Explicit resumeConversation returns the same sessionId and sameSession: true, without restoring grants/bindings. */
    action(request: TaskConversationAction, signal?: AbortSignal): Promise<TaskConversationActionResult>;
    action(request: ConversationActionRequest, signal?: AbortSignal): Promise<ConversationActionResult>;
    dispose(): Promise<void>;
}
/** Trusted testing seams only; never accepted in profile config or a user RPC. */
export interface ConversationRuntimeDependencies {
    readonly createArchiveAccess?: typeof createArchiveAccess;
    readonly createSessionBridge?: typeof createSessionBridge;
    readonly createTaskAccess?: typeof createTaskAccess;
    readonly createTaskSessionBridge?: typeof createTaskSessionBridge;
    readonly storageDomain?: unknown;
    readonly credentials?: Parameters<typeof createWeixinSessionCredentialStore>[0];
    readonly fetcher?: WeixinApiFetcher;
    readonly createStateStore?: typeof createWeixinSessionCredentialStore;
    readonly createApi?: typeof createWeixinApi;
    readonly createMediaApi?: typeof createWeixinMediaApi;
    readonly createChannel?: typeof createWeixinChannel;
    readonly prepareQr?: typeof prepareLocalQrRenderer;
    readonly runLocalHistory?: typeof runLocalHistory;
}
export declare function createConversationRuntime(ctx: Context, config?: PluginConfig, dependencies?: ConversationRuntimeDependencies): ConversationRuntime;
/** Both methods are authenticated user UI operations, not model tools. */
export declare class WechatConversationService extends TypertRemoteService {
    constructor(ctx: Context, config?: PluginConfig);
    readonly runtime: ConversationRuntime;
    getConversationState(request: GetTaskConversationStateRequest, signal?: AbortSignal): TaskConversationState;
    getConversationState(request?: ConversationStateRequest, signal?: AbortSignal): ConversationState;
    conversationAction(request: TaskConversationAction, signal?: AbortSignal): Promise<TaskConversationActionResult>;
    conversationAction(request: ConversationActionRequest, signal?: AbortSignal): Promise<ConversationActionResult>;
}
export default WechatConversationService;
