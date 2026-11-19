import type { JsonObject } from './wire.js';
export type ExportFormat = 'md' | 'json' | 'txt' | 'agents';
export type ExportScope = 'library' | 'sessions' | 'timeline' | 'contacts';
export interface ListRequest {
    readonly query?: string;
    readonly limit?: number;
}
export interface MessagesRequest {
    readonly session?: string;
    readonly limit?: number;
    readonly offset?: number;
    readonly contains?: string;
    readonly before?: string;
    readonly after?: string;
}
export interface SearchRequest {
    readonly query?: string;
    readonly session?: string;
    readonly limit?: number;
}
export interface TimelineRequest {
    readonly days?: number;
    readonly session?: string;
}
export interface ChatroomRequest {
    readonly room?: string;
    readonly limit?: number;
}
export interface SqlRequest {
    readonly database?: string;
    readonly query?: string;
    readonly limit?: number;
}
export interface ExportRequest {
    readonly format?: ExportFormat;
    readonly scope?: ExportScope;
    readonly limit?: number;
}
/** total is an observed lower bound when total_is_exact is false. */
export interface PageResult<Row = JsonObject> {
    readonly total: number;
    readonly returned: number;
    readonly offset: number;
    readonly truncated: boolean;
    readonly has_more: boolean;
    readonly scan_complete: boolean;
    readonly total_is_exact: boolean;
    readonly rows: readonly Row[];
    readonly notes: readonly string[];
}
export interface StatusResult extends JsonObject {
    readonly ok: boolean;
    readonly configured: boolean;
    readonly snapshot_enabled: boolean;
    /** Informational only; not a directory that this status inspected. */
    readonly source_root: string;
    readonly root: string;
    readonly snapshot_time: string;
    readonly read_at: string;
    readonly captured_at: string | null;
    readonly snapshot_id: string | null;
    readonly capture_complete: boolean | null;
    readonly capture_consistency: string | null;
    readonly db_count: number;
    readonly message_table_count: number | null;
    readonly contact_rows: number | null;
    readonly session_rows: number | null;
    readonly notes: readonly string[];
}
export interface TimelineResult extends JsonObject {
    readonly days: number;
    readonly total_messages: number;
    readonly rows: readonly JsonObject[];
    readonly busiest_hours: readonly JsonObject[];
    readonly top_sessions: readonly JsonObject[];
    readonly scan_complete: boolean;
    readonly total_is_exact: boolean;
    readonly notes: readonly string[];
}
/** In-memory export: this method does not write a file. */
export interface ExportPayload {
    readonly content: string;
    readonly format: ExportFormat;
    readonly format_label: string;
    readonly scope: ExportScope;
    readonly scope_label: string;
    readonly filename: string;
    readonly mime: string;
    readonly bytes: number;
    readonly read_only: true;
}
export declare class WechatRoService {
    constructor(ctx: unknown, config?: unknown);
    readonly snapshotDir: string;
    readonly snapshotEnabled: boolean;
    readonly sourceRoot: string;
    readonly maxRows: number;
    status(request?: Readonly<Record<string, never>>, signal?: AbortSignal): StatusResult;
    contacts(request?: ListRequest, signal?: AbortSignal): PageResult;
    sessions(request?: ListRequest, signal?: AbortSignal): PageResult;
    messages(request?: MessagesRequest, signal?: AbortSignal): PageResult;
    searchMessages(request?: SearchRequest, signal?: AbortSignal): PageResult;
    timeline(request?: TimelineRequest, signal?: AbortSignal): TimelineResult;
    chatroomMembers(request?: ChatroomRequest, signal?: AbortSignal): PageResult;
    sql(request?: SqlRequest, signal?: AbortSignal): PageResult;
    buildExport(request?: ExportRequest, signal?: AbortSignal): ExportPayload;
}
export declare const REMOTE_METHOD_DESCRIPTOR: '@deepseek-ai/dsh-typert-protocol/remote-methods';
export default WechatRoService;
