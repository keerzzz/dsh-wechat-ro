import type { TaskAccess } from './task-access.js';
import type { LocalHistoryState } from './local-history.js';
import type { JsonObject } from './wire.js';
import type { z } from 'zod';
export declare const DAILY_CARDS_SPEC: {
    readonly name: 'wechat_daily_cards_v1';
    readonly version: 1;
    readonly layout: 'per-record';
    readonly tables: {
        readonly tasks: {
            readonly valueSchema: z.ZodType;
        };
    };
};
export interface DailyCardsState {
    readonly version: 1;
    readonly phase: string;
    readonly error: string | null;
    readonly errorDetail: string | null;
    readonly progress: {
        readonly day: string;
        readonly stage: string;
        readonly totalTexts: number;
        readonly completedChunks: number;
        readonly totalChunks: number;
    } | null;
    readonly time: string;
    readonly nextRunAt: number;
    readonly capturedAt: string | null;
    readonly stats: readonly JsonObject[];
    readonly reports: readonly JsonObject[];
    readonly trackedTodos: readonly JsonObject[];
    readonly pendingDays: number;
}
export declare function dailyCardClock(now: number, time?: string): {
    today: string;
    dueDay: string;
    nextRunAt: number;
};
export declare function parseDailySummary(text: string, records: readonly JsonObject[]): JsonObject;
export declare function createDailyCards(options: {
    storage: {
        open(spec: unknown): Promise<{
            table(name: string): {
                get(key: string): any;
                put(key: string, value: any): Promise<void>;
            };
            close(): Promise<void>;
        }>;
    };
    query: TaskAccess['query'];
    summarize: (id: string, prompt: string, metadata: {
        messageId: string;
    }, signal: AbortSignal) => Promise<string>;
    isIdle: (id: string) => boolean;
    source: (id: string) => LocalHistoryState;
    now?: () => number;
}): {
    state(id: string): DailyCardsState;
    load(id: string): Promise<void>;
    manageTodo(id: string, request: {
        action: 'confirmDailyTodo';
        day: string;
        todoId: string;
        assignee: string;
    } | {
        action: 'setDailyTodoState';
        todoId: string;
        completed: boolean;
    }): Promise<DailyCardsState>;
    settings(id: string, time: string): Promise<DailyCardsState>;
    update(id: string, force?: boolean): Promise<void>;
    wait(id: string): Promise<void> | undefined;
    stop(id: string): void;
    dispose(): Promise<void>;
};
