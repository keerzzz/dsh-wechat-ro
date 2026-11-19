// Typed contract for the wire surface shared by every half of the plugin.
//
// The runtime lives in lib/wire.js; this file is the typed authoring source for
// lib/types/wire.d.ts (tsc --emitDeclarationOnly). Shapes here must match the
// values there: scripts/check-structure.mjs compares the method list.

import type { z } from 'zod';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue; }

/** Package name: bundle id and plugin-config card key. */
export declare const PACKAGE_NAME: 'dsh-wechat-ro';

/** Remote namespace: Host service key and client-side ctx.remote.<namespace>. */
export declare const NAMESPACE: 'wechatRo';

/** MCP server name from cordis.patch.yml; wire names are mcp__<server>__<tool>. */
export declare const MCP_SERVER_NAME: 'wechat';

/** Prefix DSH puts in front of every MCP tool name. */
export declare const MCP_PREFIX: 'mcp__wechat__';

/** The eight read-only MCP tools served by wechat_ro_mcp (Python, stdio). */
export declare const MCP_TOOLS: readonly string[];

/** The Host tool this package registers itself. */
export declare const EXPORT_TOOL: 'wechat_export';

/** Every wire tool name that receives a custom result card. */
export declare const WIRE_TOOL_NAMES: readonly string[];

/** One request field: its name and its JSON value kind. */
export interface FieldSpec {
  readonly [field: string]: 'string' | 'number';
}

/** One Remote method as the panel, manifest and command layer see it. */
export interface MethodSpec {
  readonly method: string;
  readonly fields: FieldSpec;
  readonly summary: string;
  readonly description: string;
}

/** The nine Remote methods, in panel order. */
export declare const METHOD_SPECS: readonly MethodSpec[];

/** Method names in wire order. */
export declare const METHOD_NAMES: readonly string[];

/** Wire name of the single request parameter every method accepts. */
export declare const REQUEST_WIRE: 'request';

/** Name of the optional cancellation parameter (always the last parameter). */
export declare const SIGNAL_WIRE: 'signal';

/** A strict typert codec factory, as the client contribution needs it. */
export interface StrictCodec {
  readonly mode: 'strict';
  readonly typeSymbol: string;
  readonly create: () => z.ZodType;
}

/** One client-side invocation descriptor. */
export interface InvocationDescriptor {
  readonly id: string;
  readonly service: string;
  readonly namespace: string;
  readonly method: string;
  readonly description?: string;
  readonly invocation: { readonly kind: 'direct' };
  readonly parameters: readonly {
    readonly name: string;
    readonly wire: string;
    readonly source: 'json';
    readonly acceptsUndefined: true;
    readonly description: string;
    readonly codec: StrictCodec;
  }[];
  readonly cancellation: { readonly parameter: 'signal' };
  readonly result: StrictCodec;
}

/** Build one client-side invocation descriptor for a method spec. */
export declare function descriptorFor(spec: MethodSpec): InvocationDescriptor;
export declare function requestSchemaFor(spec: MethodSpec): z.ZodType;
export declare function resultSchemaFor(spec: MethodSpec): z.ZodType;

/** Normalized plugin configuration. */
export interface PluginConfig {
  readonly snapshotDir: string;
  readonly snapshotEnabled: boolean;
  /** Informational only: never a path to read or a fallback snapshot. */
  readonly sourceRoot: string;
  readonly maxRows: number;
}

/** Normalize shared settings; false disables explicit and fallback snapshot paths. */
export declare function normalizeConfig(config?: unknown, fallbackSnapshotDir?: string): PluginConfig;
