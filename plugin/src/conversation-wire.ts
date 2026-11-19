// Declaration authoring source; runtime is lib/conversation-wire.js.
import type { z } from 'zod';
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';
import type { JsonObject } from './wire.js';
import type { TaskAccessState, TaskWorkspace, TaskWorkspaceGrant, TaskDirectoryGrant, TaskSourceQuery, TaskFileRequest, TaskHistoricalState, TaskHistoricalResult, TaskHistoryReceipt, TaskFirstTextState, TaskFirstTextResult, TaskFirstTextReceipt, TaskFirstTextModelRequest } from './task-access.js';
import type { SealedFirstTextModelSelection, SealedFirstTextModelSummary } from '@deepseek-ai/dsh-agent';
import type { WeixinUpdatesDiagnostic } from './weixin-api.js';

export type ConversationErrorCode =
  | 'INVALID_REQUEST' | 'NOT_AUTHORIZED' | 'SESSION_NOT_READY' | 'SNAPSHOT_REQUIRED'
  | 'SNAPSHOT_DENIED' | 'NETWORK_DISABLED' | 'QR_UNAVAILABLE' | 'PAIRING_REQUIRED'
  | 'PAIRING_ALREADY_STORED' | 'PAIRING_STORAGE_FAILED' | 'PAIRING_STATE_INVALID'
  | 'OWNER_MISMATCH' | 'SHARED_CONTEXT_DENIED' | 'BUSY' | 'CANCELLED' | 'UNAVAILABLE' | 'ACTION_FAILED'
  | 'LOCAL_HISTORY_CLIENT_REQUIRED' | 'LOCAL_HISTORY_FAILED'
  | 'ARCHIVE_QUERY_LIMIT'
  | 'HISTORY_OPEN_FAILED' | 'HISTORY_ALREADY_OPEN' | 'HISTORY_INVALID' | 'SESSION_CREATE_FAILED' | 'SESSION_PERSIST_FAILED' | 'HISTORY_WRITE_FAILED'
  | 'WECHAT_NETWORK_FAILED' | 'WECHAT_REQUEST_TIMEOUT' | 'WECHAT_HTTP_REJECTED' | 'WECHAT_REQUEST_REJECTED'
  | 'WECHAT_RESPONSE_TYPE_INVALID' | 'WECHAT_RESPONSE_JSON_INVALID' | 'WECHAT_RESPONSE_TOO_LARGE' | 'WECHAT_RESPONSE_INVALID'
  | 'WECHAT_ORIGIN_REJECTED' | 'WECHAT_REDIRECT_REJECTED';
export interface ConversationState {
  readonly version: string;
  readonly sessionId: string | null;
  readonly prepared: boolean;
  readonly archive: JsonObject;
  readonly channel: JsonObject;
  readonly lastError: ConversationErrorCode | null;
}
export interface QrMatrix { readonly rows: readonly string[]; readonly payloadKind: 'ilink-login'; }
export interface GetConversationStateRequest { readonly sessionId?: string; }
export interface ArchiveQuery {
  readonly action: 'status' | 'contacts' | 'sessions' | 'messages' | 'search' | 'stats' | 'digest';
  readonly talker?: string; readonly query?: string; readonly limit?: number;
  readonly offset?: number; readonly fromTs?: number; readonly toTs?: number;
}
export type ConversationAction =
  | { readonly action: 'createConversation'; readonly contextSessionId: string; readonly confirmation: 'create-readonly-conversation' }
  | { readonly action: 'resumeConversation'; readonly sessionId: string; readonly confirmation: 'resume-readonly-conversation' }
  | {
    readonly action: 'grantSnapshot'; readonly sessionId: string; readonly root: string;
    readonly allConversations: boolean; readonly talkers: readonly string[];
    readonly fromTs: number | null; readonly toTs: number | null; readonly allowWechat: boolean;
    readonly confirmation: 'read-decrypted-snapshot';
  }
  | { readonly action: 'revokeSnapshot'; readonly sessionId: string; readonly confirmation: 'revoke-snapshot' }
  | { readonly action: 'queryArchive'; readonly sessionId: string; readonly query: ArchiveQuery }
  | { readonly action: 'beginLogin'; readonly sessionId: string; readonly confirmation: 'network-login' }
  | { readonly action: 'pollLogin'; readonly sessionId: string; readonly verifyCode?: string }
  | { readonly action: 'confirmPairing'; readonly sessionId: string; readonly expectedOwnerId: string; readonly confirmation: 'persist-pairing' }
  | { readonly action: 'startChannel'; readonly sessionId: string; readonly allowSharedContext: true; readonly confirmation: 'poll-and-reply' }
  | { readonly action: 'stopChannel'; readonly sessionId: string; readonly confirmation: 'stop-channel' }
  | { readonly action: 'forgetPairing'; readonly sessionId: string; readonly confirmation: 'forget-local-credentials' }
  | { readonly action: 'discardPending'; readonly sessionId: string; readonly confirmation: 'discard-without-retry' };
export type ConversationActionResult =
  | { readonly ok: true; readonly state: ConversationState; readonly result?: JsonObject; readonly qr?: QrMatrix }
  | { readonly ok: false; readonly error: { readonly code: ConversationErrorCode } };
export interface GetTaskConversationStateRequest { readonly kind: 'task'; readonly sessionId?: string; }
/** Memory-only directory/model state and transient QR; neither readiness nor a saved binding grants authority. */
export interface TaskConnectionSetup {
  readonly root: string | null; readonly title: string | null; readonly sessionId: string | null;
  readonly phase: 'directory-required' | 'ready' | 'pairing' | 'history-required' | 'model-required' | 'running' | 'stopped' | 'expired' | 'blocked';
  readonly modelConfigured: boolean; readonly error: ConversationErrorCode | null;
  /** Owner-only transient rendered matrix; never a credential, URL or persisted login token. */
  readonly qr?: QrMatrix | null;
}
export interface TaskConversationState {
  readonly kind: 'task'; readonly version: '0.2.0-task-v1'; readonly sessionId: string | null;
  readonly available: boolean; readonly prepared: boolean; readonly task: TaskAccessState | null;
  readonly channel: JsonObject; readonly tasks: readonly { readonly sessionId: string; readonly title: string; readonly prepared: boolean }[];
  readonly workspaces: readonly TaskWorkspace[]; readonly lastError: ConversationErrorCode | null;
}
export type TaskConversationAction = { readonly kind: 'task' } & (
  | { readonly action: 'setDailyCardTime'; readonly sessionId: string; readonly time: string }
  | { readonly action: 'refreshDailyCards'; readonly sessionId: string }
  | { readonly action: 'importLocalHistory'; readonly sessionId: string; readonly autoUpdate: boolean; readonly allowWechat: boolean; readonly confirmation: 'import-own-wechat-history' }
  | { readonly action: 'refreshLocalHistory'; readonly sessionId: string; readonly confirmation: 'refresh-own-wechat-history' }
  | { readonly action: 'stopLocalHistory'; readonly sessionId: string; readonly confirmation: 'stop-local-history-updates' }
  | { readonly action: 'connectConversation'; readonly contextSessionId: string; readonly expectedDirectory: string; readonly confirmation: 'connect-own-wechat-auto-reply' }
  | { readonly action: 'createConversation'; readonly contextSessionId: string; readonly workspace: TaskWorkspaceGrant }
  | { readonly action: 'prepareSnapshot'; readonly contextSessionId: string; readonly root: string; readonly query?: string; readonly limit?: number; readonly offset?: number; readonly confirmation: 'browse-snapshot-roster' }
  | { readonly action: 'resumeConversation'; readonly sessionId: string; readonly confirmation: 'resume-task-conversation' }
  | { readonly action: 'grantWorkspace'; readonly sessionId: string; readonly workspace: TaskWorkspaceGrant }
  | ({ readonly action: 'grantDirectory'; readonly sessionId: string } & TaskDirectoryGrant)
  | { readonly action: 'grantSession'; readonly sessionId: string; readonly sourceSessionId: string; readonly title: string; readonly allowWechat: boolean; readonly confirmation: 'read-task-session' }
  | Extract<ConversationAction, { readonly action: 'grantSnapshot' | 'beginLogin' | 'pollLogin' | 'confirmPairing' | 'startChannel' | 'stopChannel' | 'forgetPairing' | 'discardPending' }>
  | { readonly action: 'pollTextOnce'; readonly sessionId: string; readonly allowSharedContext: true; readonly confirmation: 'poll-one-text-reply' }
  | { readonly action: 'resumeTextOnce'; readonly sessionId: string; readonly allowSharedContext: true; readonly confirmation: 'continue-unanswered-message' }
  | { readonly action: 'diagnoseUpdatesOnce'; readonly sessionId: string; readonly confirmation: 'read-one-wechat-update-diagnostic' }
  | { readonly action: 'revokeSource'; readonly sessionId: string; readonly sourceId: string; readonly confirmation: 'revoke-task-source' }
  | { readonly action: 'setSharing'; readonly sessionId: string; readonly allowWechat: boolean; readonly confirmation: 'share-whole-task-context' }
  | { readonly action: 'pollTextOnce'; readonly sessionId: string; readonly allowSharedContext: true; readonly historyConsentId: string; readonly confirmation: 'poll-one-text-reply-with-reviewed-history' }
  | { readonly action: 'reviewHistoricalContext'; readonly sessionId: string }
  | { readonly action: 'authorizeHistoricalContext'; readonly sessionId: string; readonly reviewId: string; readonly confirmation: 'authorize-reviewed-task-history-text' }
  | { readonly action: 'revokeHistoricalContext'; readonly sessionId: string; readonly revokeId: string; readonly confirmation: 'revoke-task-history-context' }
  | { readonly action: 'setSharing'; readonly sessionId: string; readonly allowWechat: true; readonly historyConsentId: string; readonly confirmation: 'share-reviewed-task-history-context' }
  | ({ readonly action: 'selectFirstTextModel'; readonly sessionId: string } & TaskFirstTextModelRequest)
  | { readonly action: 'reviewFirstTextContext'; readonly sessionId: string }
  | { readonly action: 'authorizeFirstTextContext'; readonly sessionId: string; readonly reviewId: string; readonly confirmation: 'authorize-reviewed-first-task-text' }
  | { readonly action: 'revokeFirstTextContext'; readonly sessionId: string; readonly revokeId: string; readonly confirmation: 'revoke-first-task-text' }
  | { readonly action: 'allowNewFirstText'; readonly sessionId: string; readonly priorRunId: string; readonly priorConsentId: string; readonly confirmation: 'allow-new-first-text-after-unknown' }
  | { readonly action: 'setSharing'; readonly sessionId: string; readonly allowWechat: true; readonly firstTextConsentId: string; readonly confirmation: 'share-reviewed-first-task-text' }
  | { readonly action: 'pollTextOnce'; readonly sessionId: string; readonly allowSharedContext: true; readonly firstTextConsentId: string; readonly confirmation: 'poll-one-text-reply-with-first-task-text' }
  | { readonly action: 'querySource'; readonly sessionId: string; readonly query: TaskSourceQuery }
  | { readonly action: 'queryFiles'; readonly sessionId: string; readonly query: Extract<TaskFileRequest, { readonly action: 'list' | 'read' }> }
);
export type TaskConversationActionResult =
  | { readonly ok: true; readonly state: TaskConversationState; readonly result?: JsonObject; readonly qr?: QrMatrix }
  | { readonly ok: false; readonly error: { readonly code: ConversationErrorCode } };
export interface TaskConversationWire {
  readonly TASK_ACTION_NAMES: readonly TaskConversationAction['action'][];
  readonly getStateRequestSchema: z.ZodType<GetTaskConversationStateRequest>;
  readonly stateSchema: z.ZodType<TaskConversationState>;
  readonly actionSchema: z.ZodType<TaskConversationAction>;
  readonly actionResultSchema: z.ZodType<TaskConversationActionResult>;
  readonly updatesDiagnosticSchema: z.ZodType<WeixinUpdatesDiagnostic>;
  readonly updatesDiagnosticResultSchema: z.ZodType<{ readonly diagnostic: WeixinUpdatesDiagnostic }>;
  readonly connectionSetupSchema: z.ZodType<TaskConnectionSetup>;
  readonly historicalContextSchema: z.ZodType<TaskHistoricalState>;
  readonly historicalReviewResultSchema: z.ZodType<{ readonly historicalContext: TaskHistoricalState; readonly reviewId: string; readonly expiresAt: number }>;
  readonly historicalResultSchema: z.ZodType<TaskHistoricalResult>;
  readonly historyReceiptSchema: z.ZodType<TaskHistoryReceipt>;
  readonly firstTextContextSchema: z.ZodType<TaskFirstTextState>;
  readonly firstTextReviewResultSchema: z.ZodType<{ readonly firstTextContext: TaskFirstTextState; readonly reviewId: string; readonly expiresAt: number }>;
  readonly firstTextResultSchema: z.ZodType<TaskFirstTextResult>;
  readonly firstTextReceiptSchema: z.ZodType<TaskFirstTextReceipt>;
  readonly firstTextModelSchema: z.ZodType<SealedFirstTextModelSummary>;
  readonly firstTextSelectionSchema: z.ZodType<SealedFirstTextModelSelection>;
  readonly firstTextModelRequestSchema: z.ZodType<TaskFirstTextModelRequest>;
  readonly sourceQuerySchema: z.ZodType<TaskSourceQuery>;
  readonly fileQuerySchema: z.ZodType<Extract<TaskFileRequest, { readonly action: 'list' | 'read' }>>;
}
export type ConversationMethod = 'getConversationState' | 'conversationAction';
export interface ConversationMethodSpec { readonly method: ConversationMethod; readonly description: string; }
export interface ConversationContribution { readonly package: 'dsh-wechat-ro'; readonly descriptors: readonly InvocationDescriptor[]; }
export interface ConversationWire {
  readonly CONVERSATION_NAMESPACE: 'wechatConversation';
  readonly CONVERSATION_ERROR_CODES: readonly ConversationErrorCode[];
  readonly CONVERSATION_ACTION_NAMES: readonly ConversationAction['action'][];
  readonly CONVERSATION_METHOD_SPECS: readonly ConversationMethodSpec[];
  readonly CONVERSATION_METHOD_NAMES: readonly ConversationMethod[];
  readonly CONVERSATION_CONTRIBUTION: ConversationContribution;
  readonly conversationRequestSchemaFor: typeof conversationRequestSchemaFor;
  readonly conversationResultSchemaFor: typeof conversationResultSchemaFor;
  readonly conversationDescriptorFor: typeof conversationDescriptorFor;
  readonly getStateRequestSchema: z.ZodType<GetConversationStateRequest>;
  readonly archiveQuerySchema: z.ZodType<ArchiveQuery>;
  readonly actionSchema: z.ZodType<ConversationAction>;
  readonly stateSchema: z.ZodType<ConversationState>;
  readonly qrSchema: z.ZodType<QrMatrix>;
  readonly actionResultSchema: z.ZodType<ConversationActionResult>;
  readonly taskWire: TaskConversationWire;
}
export declare function createConversationWire(zod: typeof z): ConversationWire;
export declare const CONVERSATION_NAMESPACE: 'wechatConversation';
export declare const CONVERSATION_ERROR_CODES: readonly ConversationErrorCode[];
export declare const CONVERSATION_ACTION_NAMES: readonly ConversationAction['action'][];
export declare const CONVERSATION_METHOD_SPECS: readonly ConversationMethodSpec[];
export declare const CONVERSATION_METHOD_NAMES: readonly ConversationMethod[];
export declare const CONVERSATION_CONTRIBUTION: ConversationContribution;
export declare function conversationRequestSchemaFor(method: ConversationMethod | ConversationMethodSpec): z.ZodType;
export declare function conversationResultSchemaFor(method: ConversationMethod | ConversationMethodSpec): z.ZodType;
export declare function conversationDescriptorFor(method: ConversationMethod | ConversationMethodSpec): InvocationDescriptor;
export declare const getStateRequestSchema: z.ZodType<GetConversationStateRequest>;
export declare const archiveQuerySchema: z.ZodType<ArchiveQuery>;
export declare const actionSchema: z.ZodType<ConversationAction>;
export declare const stateSchema: z.ZodType<ConversationState>;
export declare const qrSchema: z.ZodType<QrMatrix>;
export declare const actionResultSchema: z.ZodType<ConversationActionResult>;
export declare const TASK_WIRE: TaskConversationWire;
