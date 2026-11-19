import type { TaskAccess } from './task-access.js';
export interface LocalHistoryResult { readonly account_ref: string; readonly snapshot_directory: string; readonly captured_at: string; readonly snapshot_id: string; readonly changed: boolean; readonly database_count: number; }
export declare function runLocalHistory(command: 'import' | 'refresh', signal?: AbortSignal, onProgress?: (phase: 'authenticating' | 'updating') => void, lease?: { readonly consumer: string; readonly pinnedSnapshotId: string | null }): Promise<LocalHistoryResult>;
export interface LocalHistoryState { readonly version: 1; readonly enabled: boolean; readonly phase: string; readonly autoUpdate: boolean; readonly capturedAt: string | null; readonly accountRef: string | null; readonly lastCheckedAt: number | null; readonly databaseCount: number; readonly error: string | null; }
export declare function createLocalHistory(options: { data: TaskAccess; isIdle: (id: string) => boolean; intervalMs?: number; onTick?: (id: string) => void | Promise<void>; run?: typeof runLocalHistory }): {
  importHistory(id: string, options: { autoUpdate: boolean; allowWechat: boolean }, signal?: AbortSignal): Promise<LocalHistoryState>;
  beforeQuery(id: string, signal?: AbortSignal, turn?: number | null): Promise<void>;
  refresh(id: string, signal?: AbortSignal, initial?: boolean): Promise<void>;
  state(id: string): LocalHistoryState;
  stop(id: string): LocalHistoryState;
  dispose(): Promise<void>;
};
