/** Cordis plugin name. */
export declare const name: 'wechat-ro';
/** Services this plugin needs before apply() runs. */
export declare const inject: readonly ['commands', 'tools', 'fs', 'workingDirectory'];
/** Plugin configuration row. */
export interface Config {
    readonly snapshotDir?: string;
    /** Explicit false blocks snapshot access, including ambient env fallback. */
    readonly snapshotEnabled?: boolean;
    /** Informational only; this directory is never accessed. */
    readonly sourceRoot?: string;
    readonly maxRows?: number;
    /** Managed history checks use this interval; each model turn also checks before its first archive query. */
    readonly historyUpdateIntervalMs?: number;
}
/** Register the command and the tool. */
export declare function apply(ctx: unknown, config?: Config): void;
declare const plugin: {
    readonly name: typeof name;
    readonly inject: typeof inject;
    readonly apply: typeof apply;
};
export default plugin;
