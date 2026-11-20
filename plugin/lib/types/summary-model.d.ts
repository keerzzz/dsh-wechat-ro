export interface SummaryRoute {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
export interface SummaryLlm {
    stream(options: {
        provider: string;
        model: string;
        reasoningEffort?: string;
        messages: readonly unknown[];
        tools: readonly never[];
        maxTokens: number;
        signal: AbortSignal;
    }): AsyncIterable<{
        type: string;
        text?: string;
        reason?: {
            kind: string;
            failure?: {
                code?: string;
            };
        };
    }>;
    resolveModelInfo(provider: string, model: string): Promise<{
        maxTokens?: number;
    }>;
}
export declare function summaryRoutes(selected: SummaryRoute | undefined, fallback: SummaryRoute | undefined): readonly SummaryRoute[];
export declare function summarizeWithModel(options: {
    llm: SummaryLlm | undefined;
    routes: readonly SummaryRoute[];
    prompt: string;
    signal: AbortSignal;
    maxTokens?: number;
    byteLimit?: number;
}): Promise<string>;
