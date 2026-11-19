import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ZodType } from 'zod';
import type { ArchiveAccessState, ArchiveGrantRequest, ArchiveQuery } from './archive-access.js';
import type { WeixinDeliveryDescriptor, WeixinMediaGuards } from './weixin-media.js';
export declare const TASK_PRESET_ID: 'dsh-wechat-task-v1';
export declare function isTaskSessionId(value: unknown): value is string;
export declare function validateTaskDirectory(root: string, forbiddenRoots?: readonly string[]): string;
export declare const TASK_ACCESS_LIMITS: Readonly<{
    maxTasks: 128;
    maxSources: 32;
    maxBytes: 65536;
    maxRows: 100;
    maxEvents: 20000;
    maxReferences: 128;
    timeoutMs: 15000;
}>;
export type TaskAccessErrorCode = 'invalid-options' | 'invalid-request' | 'not-prepared' | 'not-granted' | 'forbidden-root' | 'path-rejected' | 'unsupported-filesystem' | 'not-directory' | 'not-file' | 'file-changed' | 'byte-budget-exceeded' | 'event-budget-exceeded' | 'history-unavailable' | 'share-forbidden' | 'source-failed' | 'query-budget-exceeded' | 'write-failed' | 'revoked' | 'aborted' | 'disposed' | 'busy' | 'not-produced';
export declare class TaskAccessError extends Error {
    readonly name: 'TaskAccessError';
    readonly code: TaskAccessErrorCode;
    constructor(code: TaskAccessErrorCode);
}
export interface TaskWorkspace {
    readonly id: string;
    readonly root: string;
    readonly title: string;
}
export interface TaskConsumedSource {
    readonly sourceId: string;
    readonly kind: 'directory' | 'session' | 'archive';
    readonly generation: string;
}
export interface TaskContextRecord {
    readonly createdAt: number;
    readonly workspace: TaskWorkspace | null;
    readonly mayContainData: boolean;
    readonly consumed: readonly TaskConsumedSource[];
}
export declare const TASK_CONTEXT_SPEC: Readonly<{
    name: 'wechat_task_contexts_v1';
    version: 1;
    layout: 'per-record';
    tables: {
        tasks: {
            valueSchema: ZodType<TaskContextRecord>;
        };
    };
}>;
export interface TaskWorkspaceGrant {
    readonly root: string;
    readonly title: string;
    readonly allowWechat: boolean;
    readonly confirmation: 'read-and-write-task-workspace';
}
export interface TaskDirectoryGrant {
    readonly root: string;
    readonly title: string;
    readonly allowWechat: boolean;
    readonly confirmation: 'read-task-directory';
    readonly sourceId?: string;
}
export interface TaskSessionGrant {
    readonly sessionId: string;
    readonly title: string;
    readonly allowWechat: boolean;
    readonly confirmation: 'read-task-session';
}
export type TaskSource = {
    readonly sourceId: string;
    readonly title: string;
    readonly allowWechat: boolean;
} & ({
    readonly kind: 'directory';
    readonly root: string;
    readonly write: boolean;
} | {
    readonly kind: 'session';
    readonly sessionId: string;
} | {
    readonly kind: 'archive';
    readonly archive: ArchiveAccessState;
});
export interface TaskAccessState {
    readonly version: 1;
    readonly sessionId: string;
    readonly disposed: boolean;
    readonly prepared: boolean;
    readonly historyKnown: boolean;
    readonly workspace: TaskWorkspace | null;
    readonly allowWechat: boolean;
    readonly shareable: boolean;
    readonly sessionMayContainData: boolean;
    readonly contextBlocked: boolean;
    readonly sources: readonly TaskSource[];
    readonly lastError: TaskAccessErrorCode | null;
}
export type TaskSourceQuery = {
    readonly action: 'status';
} | {
    readonly action: 'archive';
    readonly query: ArchiveQuery;
} | {
    readonly action: 'session';
    readonly sourceId: string;
    readonly query?: string;
    readonly limit?: number;
    readonly offset?: number;
};
export type TaskFileRequest = {
    readonly action: 'list';
    readonly sourceId?: string;
    readonly path?: string;
    readonly limit?: number;
} | {
    readonly action: 'read';
    readonly sourceId?: string;
    readonly path: string;
} | {
    readonly action: 'attach';
    readonly sourceId?: string;
    readonly path: string;
} | {
    readonly action: 'create';
    readonly path: string;
    readonly content: string;
} | {
    readonly action: 'write';
    readonly reference: string;
    readonly content: string;
} | {
    readonly action: 'edit';
    readonly reference: string;
    readonly oldString: string;
    readonly newString: string;
    readonly replaceAll?: boolean;
};
export interface TaskDeliverable {
    readonly path: string;
    readonly description: string;
    readonly turn: number;
    readonly sha256: string;
    readonly bytes: number;
}
export interface TaskHistorySupport {
    readonly available: boolean;
    readonly ready: boolean;
    readonly owner: object | null;
    readonly sequence: number;
}
export type TaskHistoryReason = 'history-unavailable' | 'sdk-not-ready' | 'not-required' | 'unsupported-sources' | 'review-expired' | 'consent-expired' | 'audit-unresolved' | 'run-unresolved' | 'source-changed' | 'history-changed' | 'sdk-changed' | 'sharing-changed' | 'sharing-required' | 'revoked' | 'disposed';
export type TaskHistoryRunOutcome = 'replied' | 'empty' | 'blocked' | 'unknown';
export type TaskHistoryReceipt = {
    readonly operation: 'authorize';
    readonly reviewId: string;
    readonly consentId: string;
    readonly decisionId: string;
    readonly permissionCommitted: true;
    readonly auditCommitted: true;
} | {
    readonly operation: 'share';
    readonly consentId: string;
    readonly decisionId: string;
    readonly sharingCommitted: true;
    readonly auditCommitted: true;
} | {
    readonly operation: 'terminal';
    readonly consentId: string;
    readonly runId: string;
    readonly permissionRevoked: true;
    readonly sharingClosed: true;
    readonly requestAccepted?: 0 | 1;
    readonly modelRequestsReserved?: 0 | 1;
    readonly runOutcome: TaskHistoryRunOutcome;
    readonly auditOutcome: 'pending' | 'committed' | 'unknown';
    readonly decisionId?: string;
} | {
    readonly operation: 'audit';
    readonly auditedOperation: 'authorize' | 'share' | 'reserve' | 'revoke' | 'terminal' | 'new-input';
    readonly decisionId: string;
    readonly reviewId: string | null;
    readonly consentId: string | null;
    readonly runId: string | null;
    readonly revokeId: string | null;
    readonly auditOutcome: 'committed';
    readonly permissionRevoked: boolean;
    readonly outcome: 'accepted' | 'revoked' | TaskHistoryRunOutcome;
} | {
    readonly operation: 'revoke';
    readonly revokeId: string;
    readonly consentId: string | null;
    readonly runId: string | null;
    readonly permissionRevoked: true;
    readonly sharingClosed: true;
    readonly runOutcome: 'pending' | 'unknown' | 'none';
    readonly auditOutcome: 'pending' | 'committed' | 'unknown';
    readonly decisionId?: string;
};
export interface TaskHistoricalState {
    readonly version: 1;
    readonly supported: boolean;
    readonly required: boolean;
    readonly reason: TaskHistoryReason | null;
    readonly phase: 'blocked' | 'reviewed' | 'approved' | 'sharing-confirmed' | 'reserved' | 'running' | 'spent';
    readonly workspace: {
        readonly id: string;
        readonly root: string;
    } | null;
    readonly consumedCount: number;
    readonly purpose: 'history-text-once';
    readonly consentId: string | null;
    readonly sharingConfirmed: boolean;
    readonly executable: boolean;
    readonly receipts: readonly TaskHistoryReceipt[];
}
export interface TaskHistoricalReview extends TaskHistoricalState {
    readonly reviewId: string;
    readonly expiresAt: number;
}
export interface TaskHistoricalResult {
    readonly historicalContext: TaskHistoricalState;
    readonly receipt: TaskHistoryReceipt;
}
declare const historicalTextPermit: unique symbol;
/** Private runtime capability: RPC JSON cannot construct or restore it. */
export interface TaskHistoricalTextPermit {
    readonly [historicalTextPermit]: true;
    readonly sessionId: string;
    readonly consentId: string;
    readonly runId: string;
    readonly signal: AbortSignal;
}
export interface TaskHistoryAuditEvent {
    readonly decisionId: string;
    readonly runtimeId: string;
    readonly at: number;
    readonly operation: 'authorize' | 'share' | 'reserve' | 'revoke' | 'terminal' | 'new-input';
    readonly consentId: string | null;
    readonly runId: string | null;
    readonly reviewId: string | null;
    readonly revokeId: string | null;
    readonly requestAccepted: 0 | 1 | null;
    readonly modelRequestsReserved: 0 | 1 | null;
    readonly scope: {
        readonly workspaceId: string;
        readonly root: string;
        readonly digest: string;
        readonly consumedCount: number;
    } | null;
    readonly outcome: 'accepted' | 'revoked' | TaskHistoryRunOutcome;
}
export declare const TASK_HISTORY_AUDIT_SPEC: Readonly<{
    name: 'wechat_task_history_consents_v1';
    version: 1;
    layout: 'per-record';
    tables: {
        tasks: {
            valueSchema: ZodType<{
                events: readonly TaskHistoryAuditEvent[];
            }>;
        };
    };
}>;
/** Serialized records of the retired single-text workflow; these types grant no execution capability. */
export type TaskFirstTextReason = 'not-live' | 'not-ready' | 'busy' | 'leased' | 'seeded-session' | 'not-empty' | 'unprovable-projection' | 'model-not-selected' | 'adapter-unsupported' | 'model-unprepared' | 'model-stale' | 'observation-stale' | 'preparation-cancelled' | 'preparation-failed';
export interface TaskFirstTextConfiguration {
    readonly reasoningEffort?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly stopSequenceCount: number;
}
export interface TaskFirstTextModelSelection {
    readonly provider: string;
    readonly model: string;
    readonly selectionRevision: number;
    readonly configuration: TaskFirstTextConfiguration;
    readonly preparation: {
        readonly supported: false;
        readonly reason: 'adapter-unsupported';
    } | {
        readonly supported: true;
        readonly preparationEffects: {
            readonly filesystem: boolean;
            readonly credentials: boolean;
            readonly network: boolean;
            readonly cache: boolean;
        };
    };
}
export interface TaskFirstTextModelSummary {
    readonly version: 1;
    readonly provider: string;
    readonly model: string;
    readonly selectionRevision: number;
    readonly configurationDigest: string;
    readonly configuration: TaskFirstTextConfiguration;
    readonly defaults: TaskFirstTextConfiguration;
    readonly adapterDefaults: {
        readonly reasoningEffort?: true;
        readonly maxTokens?: true;
    };
    readonly versions: {
        readonly metadata: number;
        readonly configuration: number;
        readonly connection: number;
        readonly authenticationIdentity: number;
    };
    readonly contextWindow?: number;
}
export interface TaskFirstTextReviewSummary {
    readonly version: 1;
    readonly purpose: 'first-text-once';
    readonly agentId: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly surfaceContentGeneration: number;
    readonly fixedSystemVersion: 1;
    readonly scope: {
        readonly fixedSystem: true;
        readonly soleHumanText: true;
        readonly priorMessages: false;
        readonly sources: false;
        readonly tools: false;
    };
    readonly model: TaskFirstTextModelSummary;
}
/** The official host supplies no legacy execution observations or leases. */
export type TaskFirstTextObservation = never;
export type TaskFirstTextModelObservation = never;
export type TaskFirstTextLease = never;
export interface TaskFirstTextSupport {
    readonly available: boolean;
    readonly ready: boolean;
    readonly valid: boolean;
    readonly owner: object | null;
    readonly sequence: number;
    readonly reason: TaskFirstTextReason | 'sdk-not-ready' | null;
    readonly observation: TaskFirstTextObservation | null;
    readonly modelObservation: TaskFirstTextModelObservation | null;
    readonly model: TaskFirstTextModelSummary | null;
    readonly native: TaskFirstTextReviewSummary | null;
    readonly preparation: TaskFirstTextModelSelection | null;
}
export interface TaskFirstTextState extends Omit<TaskHistoricalState, 'purpose' | 'reason' | 'receipts'> {
    readonly purpose: 'first-text-once';
    readonly reason: TaskHistoryReason | TaskFirstTextReason | null;
    readonly newInputAllowed: boolean;
    readonly model: TaskFirstTextModelSummary | null;
    readonly native: TaskFirstTextReviewSummary | null;
    readonly preparation: TaskFirstTextModelSelection | null;
    readonly receipts: readonly TaskFirstTextReceipt[];
}
export type TaskFirstTextReceipt = (TaskHistoryReceipt & {
    readonly purpose: 'first-text-once';
}) | {
    readonly purpose: 'first-text-once';
    readonly operation: 'new-input';
    readonly priorRunId: string;
    readonly priorConsentId: string;
    readonly decisionId: string;
    readonly newInputAllowed: true;
    readonly auditCommitted: true;
};
export interface TaskFirstTextReview extends TaskFirstTextState {
    readonly reviewId: string;
    readonly expiresAt: number;
}
export interface TaskFirstTextResult {
    readonly firstTextContext: TaskFirstTextState;
    readonly receipt: TaskFirstTextReceipt;
}
declare const firstTextPermit: unique symbol;
/** Private first-text capability, distinct from historical and JSON permissions. */
export interface TaskFirstTextPermit {
    readonly [firstTextPermit]: true;
    readonly purpose: 'first-text-once';
    readonly sessionId: string;
    readonly consentId: string;
    readonly runId: string;
    readonly signal: AbortSignal;
}
export type TaskFirstTextModelRequest = {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly confirmation: 'select-first-task-model';
} & ({
    readonly preparationConfirmation?: never;
    readonly selectionRevision?: never;
} | {
    readonly preparationConfirmation: 'prepare-first-task-model-metadata';
    readonly selectionRevision: number;
});
export interface TaskFirstTextAuditEvent extends Omit<TaskHistoryAuditEvent, 'scope'> {
    readonly purpose: 'first-text-once';
    readonly scope: {
        readonly workspaceId: string;
        readonly root: string;
        readonly digest: string;
        readonly consumedCount: number;
        readonly model: Pick<TaskFirstTextModelSummary, 'provider' | 'model' | 'selectionRevision' | 'configurationDigest'>;
    } | null;
}
export declare const TASK_FIRST_TEXT_AUDIT_SPEC: Readonly<{
    name: 'wechat_task_first_text_consents_v1';
    version: 1;
    layout: 'per-record';
    tables: {
        tasks: {
            valueSchema: ZodType<{
                events: readonly TaskFirstTextAuditEvent[];
            }>;
        };
    };
}>;
export interface TaskAccess {
    bindFirstTextSupport(id: string, probe: () => TaskFirstTextSupport): () => void;
    invalidateTextModel(id: string): void;
    stopTextContexts(id: string, request?: {
        revokeId: string;
    }): Promise<TaskHistoricalResult | TaskFirstTextResult>;
    getFirstTextState(id: string): TaskFirstTextState;
    readFirstTextState(id: string, signal?: AbortSignal): Promise<TaskFirstTextState>;
    allowNewFirstText(id: string, request: {
        priorRunId: string;
        priorConsentId: string;
        confirmation: 'allow-new-first-text-after-unknown';
    }, signal?: AbortSignal): Promise<TaskFirstTextResult>;
    reviewFirstTextContext(id: string, signal?: AbortSignal): Promise<TaskFirstTextReview>;
    authorizeFirstTextContext(id: string, request: {
        reviewId: string;
        confirmation: 'authorize-reviewed-first-task-text';
    }, signal?: AbortSignal): Promise<TaskFirstTextResult>;
    shareFirstTextContext(id: string, request: {
        firstTextConsentId: string;
        confirmation: 'share-reviewed-first-task-text';
    }, signal?: AbortSignal): Promise<TaskFirstTextResult>;
    revokeFirstTextContext(id: string, request?: {
        revokeId: string;
    }): Promise<TaskFirstTextResult>;
    reserveFirstText(id: string, request: {
        firstTextConsentId: string;
        confirmation: 'poll-one-text-reply-with-first-task-text';
    }, signal?: AbortSignal): Promise<TaskFirstTextPermit>;
    verifyFirstText(permit: TaskFirstTextPermit): boolean;
    bindFirstTextInput(permit: TaskFirstTextPermit, inputId: string, turn?: number | null): void;
    noteFirstTextModelRequest(permit: TaskFirstTextPermit, count: 0 | 1): void;
    completeFirstTextModel(permit: TaskFirstTextPermit): void;
    firstTextObservation(permit: TaskFirstTextPermit): {
        readonly observation: TaskFirstTextObservation;
        readonly modelObservation: TaskFirstTextModelObservation;
    };
    retainFirstTextLease(permit: TaskFirstTextPermit, lease: TaskFirstTextLease): void;
    drainFirstTextLease(permit: TaskFirstTextPermit): void;
    finishFirstText(permit: TaskFirstTextPermit, result: {
        outcome: TaskHistoryRunOutcome;
        requestAccepted?: 0 | 1;
        modelUnknown?: boolean;
    }): Promise<TaskFirstTextResult>;
    bindHistorySupport(id: string, probe: () => TaskHistorySupport): () => void;
    getHistoricalState(id: string): TaskHistoricalState;
    reviewHistoricalContext(id: string, signal?: AbortSignal): Promise<TaskHistoricalReview>;
    authorizeHistoricalContext(id: string, request: {
        reviewId: string;
        confirmation: 'authorize-reviewed-task-history-text';
    }, signal?: AbortSignal): Promise<TaskHistoricalResult>;
    shareHistoricalContext(id: string, request: {
        historyConsentId: string;
        confirmation: 'share-reviewed-task-history-context';
    }, signal?: AbortSignal): Promise<TaskHistoricalResult>;
    readHistoricalState(id: string, signal?: AbortSignal): Promise<TaskHistoricalState>;
    revokeHistoricalContext(id: string, request?: {
        revokeId: string;
    }): Promise<TaskHistoricalResult>;
    reserveHistoricalText(id: string, request: {
        historyConsentId: string;
        confirmation: 'poll-one-text-reply-with-reviewed-history';
    }, signal?: AbortSignal): Promise<TaskHistoricalTextPermit>;
    verifyHistoricalText(permit: TaskHistoricalTextPermit): boolean;
    bindHistoricalInput(permit: TaskHistoricalTextPermit, inputId: string, turn?: number | null): void;
    noteHistoricalModelRequest(permit: TaskHistoricalTextPermit, count: 0 | 1): void;
    completeHistoricalModel(permit: TaskHistoricalTextPermit): void;
    finishHistoricalText(permit: TaskHistoricalTextPermit, result: {
        outcome: TaskHistoryRunOutcome;
        requestAccepted?: 0 | 1;
        modelUnknown?: boolean;
    }): Promise<TaskHistoricalResult>;
    /** Connection-only metadata lookup: verifies the directory, without reading contents or granting access. */
    findWorkspaceTasks(root: string, signal?: AbortSignal): Promise<readonly {
        readonly sessionId: string;
        readonly workspace: TaskWorkspace;
    }[]>;
    /** Explicit automatic-reply scope; renews current workspace access and separately covers retained workspace-only replies without changing consumed generations. */
    authorizeAutoWorkspace(id: string, request: TaskWorkspaceGrant, signal?: AbortSignal): Promise<TaskAccessState>;
    grantWorkspace(id: string, request: TaskWorkspaceGrant, signal?: AbortSignal): Promise<TaskAccessState>;
    grantDirectory(id: string, request: TaskDirectoryGrant, signal?: AbortSignal): Promise<TaskAccessState>;
    grantSession(id: string, request: TaskSessionGrant): TaskAccessState;
    grantSnapshot(id: string, request: ArchiveGrantRequest, signal?: AbortSignal): Promise<TaskAccessState>;
    /** Switch managed snapshot data without changing the authorized source identity or scope. */
    refreshSnapshot(id: string, root: string, signal?: AbortSignal): Promise<TaskAccessState>;
    revoke(id: string, sourceId: string): TaskAccessState;
    revokeAll(id: string): TaskAccessState;
    setSharing(id: string, request: {
        allowWechat: boolean;
        confirmation: 'share-whole-task-context';
    }): TaskAccessState;
    getState(id: string): TaskAccessState;
    canShare(id: string): boolean;
    prepare(id: string, session: Session, signal?: AbortSignal): Promise<void>;
    query(id: string, request: TaskSourceQuery, signal?: AbortSignal, destination?: 'local' | 'wechat', turn?: number | null): Promise<Readonly<Record<string, unknown>>>;
    file(id: string, request: TaskFileRequest, signal?: AbortSignal, destination?: 'local' | 'wechat', turn?: number | null): Promise<Readonly<Record<string, unknown>>>;
    inspectDeliverables(id: string, files: readonly {
        path: string;
        description?: string;
    }[], signal: AbortSignal | undefined, turn: number, callId?: string): Promise<readonly TaskDeliverable[]>;
    captureDeliverables(id: string, declarations: readonly {
        callId: string;
        files: readonly {
            path: string;
            description?: string;
        }[];
    }[], signal: AbortSignal | undefined, turn: number): Promise<readonly WeixinDeliveryDescriptor[]>;
    prepareDelivery(id: string, file: WeixinDeliveryDescriptor, signal?: AbortSignal): Promise<WeixinMediaGuards & {
        readonly data: Uint8Array;
        readonly signal: AbortSignal;
    }>;
    releaseDeliveries(id: string, references: readonly string[]): void;
    contextSignal(id: string): AbortSignal;
    getWorkspace(id: string): TaskWorkspace | null;
    dispose(): Promise<void>;
}
export declare function createTaskAccess(ctx: Context, options?: {
    readonly sourceRoot?: string;
    readonly beforeArchiveQuery?: (id: string, signal?: AbortSignal, turn?: number | null) => Promise<void> | undefined;
    readonly archiveFreshness?: (id: string) => import('./local-history.js').LocalHistoryState | undefined;
}): TaskAccess;
export {};
