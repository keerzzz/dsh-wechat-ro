import type { Context } from '@deepseek-ai/cordis';
import type { TaskAccess, TaskWorkspaceGrant, TaskHistoricalTextPermit, TaskFirstTextPermit, TaskFirstTextModelRequest, TaskFirstTextState } from './task-access.js';
import type { WeixinTaskReply } from './weixin-media.js';
export declare const TASK_SESSION_INFO: Readonly<{ agentPreset: 'dsh-wechat-task-v1'; sandboxMode: 'workspace-write'; messageSource: 'wechat-task-weixin';
  defaultTimeoutMs: 120000; maxTimeoutMs: 300000; maxInputBytes: 16384; maxReplyBytes: 16384 }>;
export interface TaskSessionBridge {
  /** Trusted allocation observer runs before workspace/native effects, allowing a durable exact-SID reservation. */
  createConversation(contextSessionId: string, workspace: TaskWorkspaceGrant, signal?: AbortSignal, onAllocated?: (sessionId: string) => Promise<void>): Promise<string>;
  ensure(sessionId: string, signal?: AbortSignal): Promise<void>;
  isPrepared(sessionId: string): boolean;
  reply(sessionId: string, text: string, metadata: { messageId: string }, signal?: AbortSignal): Promise<string>;
  replyWithDeliverables(sessionId: string, text: string, metadata: { messageId: string }, signal?: AbortSignal): Promise<WeixinTaskReply>;
  /** Continues one admitted failed input in the same native Session using an explicit linked instruction. */
  continueReply(sessionId: string, text: string, metadata: { messageId: string }, signal?: AbortSignal): Promise<string>;
  continueReplyWithDeliverables(sessionId: string, text: string, metadata: { messageId: string }, signal?: AbortSignal): Promise<WeixinTaskReply>;
  replyHistorical(sessionId: string, text: string, metadata: { messageId: string }, signal: AbortSignal | undefined, permit: TaskHistoricalTextPermit): Promise<WeixinTaskReply>;
  selectFirstTextModel(sessionId: string, request: TaskFirstTextModelRequest, signal?: AbortSignal): Promise<{ readonly firstTextContext: TaskFirstTextState }>;
  replyFirstText(sessionId: string, text: string, metadata: { messageId: string }, signal: AbortSignal | undefined, permit: TaskFirstTextPermit): Promise<WeixinTaskReply>;
  hasDataHistory(sessionId: string): boolean | 'unknown';
  dispose(): Promise<void>;
}
export declare function createTaskSessionBridge(ctx: Context, options: { readonly data: TaskAccess; readonly timeoutMs?: number }): TaskSessionBridge;
