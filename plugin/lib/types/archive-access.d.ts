import type { JsonObject } from './wire.js';
/** Hard ceilings; options may lower them, never enlarge them. */
export declare const ARCHIVE_ACCESS_LIMITS: {
    readonly maxRows: 200;
    readonly maxBytes: 131072;
    readonly queryTimeoutMs: 15000;
    readonly maxOffset: 1000;
    readonly maxTalkers: 128;
    readonly maxEntries: 256;
    readonly maxDirectories: 16;
    readonly maxFiles: 32;
    readonly maxDepth: 4;
    readonly maxDbBytes: 134217728;
    readonly maxTotalDbBytes: 805306368;
    readonly maxReadRows: 5000;
    readonly maxTables: 128;
};
export type ArchiveAccessErrorCode = 'invalid-options' | 'invalid-request' | 'invalid-session' | 'forbidden-root' | 'not-granted' | 'scope-forbidden' | 'share-forbidden' | 'busy' | 'disposed' | 'aborted' | 'revoked' | 'timeout' | 'unsupported-platform' | 'unsupported-layout' | 'unsupported-schema' | 'unsupported-content' | 'unsupported-scope' | 'snapshot-changed' | 'path-rejected' | 'file-budget-exceeded' | 'row-budget-exceeded' | 'byte-budget-exceeded' | 'worker-failed' | 'history-persistence-failed';
export declare const ARCHIVE_ACCESS_ERROR_CODES: readonly ArchiveAccessErrorCode[];
/** Fixed code/message only; no raw exception, SQL, root or archive content. */
export declare class ArchiveAccessError extends Error {
    readonly name: 'ArchiveAccessError';
    readonly code: ArchiveAccessErrorCode;
    constructor(code: ArchiveAccessErrorCode);
}
/** Path validation only, no filesystem reads. Not a model-facing path parameter. */
export declare function validateArchiveRoot(root: string, forbiddenRoots?: readonly string[]): string;
export interface ArchiveAccessOptions {
    /** Forbidden source location, metadata only. The actual original source is always forbidden too. Never an environment fallback. */
    readonly sourceRoot?: string;
    /** Integer 1..200; default 100. Requested page limits are clamped to this ceiling. */
    readonly maxRows?: number;
    /** Entire UTF-8 page JSON, integer 512..131072; default 65536. */
    readonly maxBytes?: number;
    /** Fixed Node child wall deadline including startup, integer 1..15000; default 10000. */
    readonly queryTimeoutMs?: number;
    /** Integer 0..1000; default 1000. */
    readonly maxOffset?: number;
    /** Trusted synchronous MEMORY projection, no filesystem/network I/O. Missing/unknown history blocks sharing. Supply together with markArchiveHistory. */
    readonly hasArchiveHistory?: (sessionId: string) => boolean | 'unknown';
    /** Trusted durable monotone true barrier, awaited before any archive page reaches the native session/model. Required for query results; supply with hasArchiveHistory. Its completion is not covered by the child wall deadline. */
    readonly markArchiveHistory?: (sessionId: string) => void | Promise<void>;
}
export type ArchiveGrantRequest = {
    readonly root: string;
    readonly fromTs: number | null;
    readonly toTs: number | null;
    /** Explicit consent to sharing this native session's ENTIRE previous and future contents, including archive results. UI owner authorization is the caller's responsibility. */
    readonly allowWechat: boolean;
    readonly confirmation: 'read-decrypted-snapshot';
} & ({
    readonly allConversations: true;
    readonly talkers: readonly [];
} | {
    readonly allConversations: false;
    readonly talkers: readonly string[];
});
export interface ArchivePaging {
    readonly limit?: number;
    readonly offset?: number;
}
export interface ArchiveTimeRange {
    /** Inclusive Unix seconds; cannot broaden the grant. */ readonly fromTs?: number;
    /** Inclusive Unix seconds; cannot broaden the grant. */ readonly toTs?: number;
}
export type ArchiveQuery = {
    readonly action: 'status';
} | ({
    readonly action: 'contacts';
    readonly talker?: string;
    readonly query?: string;
} & ArchivePaging) | ({
    readonly action: 'sessions';
    readonly talker?: string;
    readonly query?: string;
} & ArchivePaging & ArchiveTimeRange) | ({
    readonly action: 'messages';
    readonly talker: string;
} & ArchivePaging & ArchiveTimeRange) | ({
    readonly action: 'stats' | 'digest';
    readonly talker?: string;
} & ArchivePaging & ArchiveTimeRange) | ({
    readonly action: 'search';
    readonly talker?: string;
    readonly query: string;
    readonly sourceKind?: 'messages' | 'moments' | 'favorites' | 'miniprogram' | 'voice' | 'image' | 'video';
} & ArchivePaging & ArchiveTimeRange) | ({
    readonly action: 'media';
    readonly talker?: string;
    readonly sourceKind?: 'voice' | 'messages';
} & ArchivePaging & ArchiveTimeRange) | ({
    readonly action: 'content' | 'contentStats';
    readonly talker?: string;
    readonly query?: string;
    readonly sourceKind?: 'moments' | 'favorites' | 'miniprogram' | 'voice' | 'image' | 'video';
} & ArchivePaging & ArchiveTimeRange);
export interface ArchiveAccessState {
    readonly disposed: boolean;
    readonly granted: boolean;
    readonly allowWechat: boolean;
    readonly allConversations: boolean;
    readonly talkers: readonly string[];
    readonly fromTs: number | null;
    readonly toTs: number | null;
    /** Sticky across revoke; ORs trusted persistent native-history flag with this runtime's conservative exposure flag. */
    readonly sessionMayContainArchiveData: boolean;
    readonly historyKnown: boolean;
    readonly shareable: boolean;
    readonly activeQueries: number;
    readonly lastError: ArchiveAccessErrorCode | null;
    /** Supported reader format, not a detected schema for the entire granted snapshot. */
    readonly format: 'fixed-sql-plaintext';
    readonly formatVerified: false;
}
export interface ArchivePage {
    readonly action: ArchiveQuery['action'];
    readonly rows: readonly JsonObject[];
    readonly limit: number;
    readonly offset: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly truncated: boolean;
    readonly bytes: number;
    /** Message and search rows include localTime with this explicit UTC offset. */
    readonly timezone?: 'Asia/Shanghai';
    readonly scopeApplied: 'sql-before-rows' | 'grant-metadata';
    readonly source: {
        readonly kind: 'decrypted-wechat-archive';
        readonly snapshotRef: string;
    };
    readonly untrusted: true;
}
export interface ArchiveAccess {
    grant(sessionId: string, request: ArchiveGrantRequest, signal?: AbortSignal): Promise<ArchiveAccessState>;
    /** Replace a verified snapshot while retaining its exact scope and sharing grant. */
    refresh(sessionId: string, root: string, signal?: AbortSignal): Promise<ArchiveAccessState>;
    /** Immediate in-memory revocation plus SIGKILL cancellation of the owned query child; history is not erased. */
    revoke(sessionId: string): ArchiveAccessState;
    /** Memory-only; never probes a root or discovers a default snapshot. */
    getState(sessionId: string): ArchiveAccessState;
    query(sessionId: string, query: ArchiveQuery, signal?: AbortSignal, destination?: 'local' | 'wechat'): Promise<ArchivePage>;
    /** One ephemeral Owner roster read; no model grant, message query or history-clean claim. */
    browseRoster(root: string, request: {
        readonly confirmation: 'browse-snapshot-roster';
        readonly query?: string;
        readonly limit?: number;
        readonly offset?: number;
    }, signal?: AbortSignal): Promise<ArchivePage & {
        readonly metadataOnly: true;
    }>;
    /** Memory-only, based on last validated grant; unknown native history fails closed. */
    canShare(sessionId: string): boolean;
    dispose(): Promise<void>;
}
/** Independent snapshots only. Linux fixed-layout plaintext tables; message tables must expose intrinsic rowid. Ambiguous schemas/views/BLOB/WAL and unsupported scopes fail closed. No auth/UI/tool registration or constructor data I/O. */
export declare function createArchiveAccess(options?: ArchiveAccessOptions): ArchiveAccess;
