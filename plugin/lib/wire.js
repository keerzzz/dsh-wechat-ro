// Single source of truth for the wire contract shared by every half of the
// plugin: the Host Remote service (controller.js), the Host command and tool
// (index.js), the Host-face typert manifest (typert.host.js) and the client
// contribution (typert.remote-client.js).
//
// The browser bundle (lib/client.js) is a standalone lazy-CJS artifact and
// cannot import this module, so it carries its own copy of the descriptor list.
// scripts/check-structure.mjs compares the two lists so they cannot drift.

import { z } from 'zod';

/** Package name: the id the browser bundle registers under and the key of the plugin config card. */
export const PACKAGE_NAME = 'dsh-wechat-ro';

/** Remote namespace: the Host service key and the client-side ctx.remote.<namespace>. */
export const NAMESPACE = 'wechatRo';

/** MCP server name configured in cordis.patch.yml; wire tool names are mcp__<server>__<tool>. */
export const MCP_SERVER_NAME = 'wechat';

/** Prefix DSH puts in front of every MCP tool name. */
export const MCP_PREFIX = 'mcp__' + MCP_SERVER_NAME + '__';

/** The eight read-only MCP tools served by wechat_ro_mcp (Python, stdio). */
export const MCP_TOOLS = [
  'wechat_status',
  'wechat_contacts',
  'wechat_sessions',
  'wechat_messages',
  'wechat_search_messages',
  'wechat_timeline',
  'wechat_chatroom_members',
  'wechat_sql',
];

/** The Host tool this package registers itself (it writes the exported file into the workspace). */
export const EXPORT_TOOL = 'wechat_export';

/** Every wire tool name that gets a custom result card in the conversation. */
export const WIRE_TOOL_NAMES = MCP_TOOLS.map((tool) => MCP_PREFIX + tool).concat([EXPORT_TOOL]);

/** Request fields per Remote method, used for the generated types and the manifest. */
const FIELDS = {
  status: {},
  contacts: { query: 'string', limit: 'number' },
  sessions: { query: 'string', limit: 'number' },
  messages: { session: 'string', limit: 'number', offset: 'number', contains: 'string', before: 'string', after: 'string' },
  searchMessages: { query: 'string', session: 'string', limit: 'number' },
  timeline: { days: 'number', session: 'string' },
  chatroomMembers: { room: 'string', limit: 'number' },
  sql: { database: 'string', query: 'string', limit: 'number' },
  buildExport: { format: 'string', scope: 'string', limit: 'number' },
};

/**
 * The nine Remote methods, in the order the panel and the manifest present them.
 * `request` is always optional: every method accepts an empty object.
 */
export const METHOD_SPECS = [
  {
    method: 'status',
    fields: FIELDS.status,
    summary: '快照概况：库数量、表数量、行数与读取提示',
    description: 'Report the decrypted snapshot root, database/table/row counts and the snapshot read time.',
  },
  {
    method: 'contacts',
    fields: FIELDS.contacts,
    summary: '联系人列表，可按名字过滤',
    description: 'List contacts with display name, alias, remark and type, filtered by a free-text query.',
  },
  {
    method: 'sessions',
    fields: FIELDS.sessions,
    summary: '会话列表，按最近消息时间倒序',
    description: 'List sessions with last message time, unread count and chatroom flag, newest first.',
  },
  {
    method: 'messages',
    fields: FIELDS.messages,
    summary: '某个会话的消息，支持时间与关键字过滤',
    description: 'Page through one session history with contains/before/after filters.',
  },
  {
    method: 'searchMessages',
    fields: FIELDS.searchMessages,
    summary: '全库或单会话内搜索消息正文',
    description: 'Search message bodies across every message table, optionally limited to one session.',
  },
  {
    method: 'timeline',
    fields: FIELDS.timeline,
    summary: '近 N 天消息量、忙时分布与会话排行',
    description: 'Aggregate message counts per day, busiest hours and top sessions over the last N days.',
  },
  {
    method: 'chatroomMembers',
    fields: FIELDS.chatroomMembers,
    summary: '群成员列表',
    description: 'List the members of a chatroom from the contact database.',
  },
  {
    method: 'sql',
    fields: FIELDS.sql,
    summary: '对单个库执行一条只读 SELECT',
    description: 'Run exactly one read-only SELECT or WITH statement against one snapshot database.',
  },
  {
    method: 'buildExport',
    fields: FIELDS.buildExport,
    summary: '生成给智能体阅读的导出文本（不写盘）',
    description: 'Build the Markdown/JSON/plain-text/AGENTS.md export in memory and return it with its file name.',
  },
];

/** Method names in wire order. */
export const METHOD_NAMES = METHOD_SPECS.map((spec) => spec.method);

/** Wire name of the single request parameter every method accepts. */
export const REQUEST_WIRE = 'request';

/** Name of the optional cancellation parameter (must be the last Host method parameter). */
export const SIGNAL_WIRE = 'signal';

// JSON is recursive, but not arbitrary JavaScript (no bigint, functions,
// undefined, NaN or Infinity). This works with the installed Zod 3/4 API.
const JSON_VALUE = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(JSON_VALUE), z.record(z.string(), JSON_VALUE),
]));
const JSON_OBJECT = z.record(z.string(), JSON_VALUE);
const COUNT = z.number().int().nonnegative();

/** Validate the external request once at the RPC boundary, without coercion. */
export function requestSchemaFor(spec) {
  const fields = {};
  for (const [name, kind] of Object.entries(spec.fields)) {
    let schema = kind === 'number' ? z.number().int() : z.string();
    if (name === 'limit') schema = schema.min(1).max(500);
    if (name === 'offset') schema = schema.min(0).max(Number.MAX_SAFE_INTEGER);
    if (name === 'days') schema = schema.min(1).max(3650);
    if (spec.method === 'buildExport' && name === 'format') schema = z.enum(['md', 'json', 'txt', 'agents']);
    if (spec.method === 'buildExport' && name === 'scope') schema = z.enum(['library', 'sessions', 'timeline', 'contacts']);
    fields[name] = schema.optional();
  }
  return z.strictObject(fields);
}

/** Validate each public result's required shape, retaining additive JSON fields. */
export function resultSchemaFor(spec) {
  const notes = z.array(z.string());
  if (spec.method === 'status') {
    return z.object({
      ok: z.boolean(), root: z.string(), snapshot_time: z.string(), read_at: z.string(),
      captured_at: z.string().nullable(), snapshot_id: z.string().nullable(),
      capture_complete: z.boolean().nullable(), capture_consistency: z.string().nullable(),
      db_count: COUNT, message_table_count: COUNT.nullable(),
      contact_rows: COUNT.nullable(), session_rows: COUNT.nullable(), notes,
    }).catchall(JSON_VALUE);
  }
  if (spec.method === 'timeline') {
    return z.object({
      days: COUNT.min(1), total_messages: COUNT, rows: z.array(JSON_OBJECT),
      busiest_hours: z.array(JSON_OBJECT), top_sessions: z.array(JSON_OBJECT), notes,
      scan_complete: z.boolean(), total_is_exact: z.boolean(),
    }).catchall(JSON_VALUE);
  }
  if (spec.method === 'buildExport') {
    return z.object({
      content: z.string(), filename: z.string().min(1), mime: z.string(), bytes: COUNT,
      format: z.enum(['md', 'json', 'txt', 'agents']), format_label: z.string(),
      scope: z.enum(['library', 'sessions', 'timeline', 'contacts']), scope_label: z.string(),
      read_only: z.literal(true),
    }).catchall(JSON_VALUE);
  }
  return z.object({
    total: COUNT, returned: COUNT, offset: COUNT, truncated: z.boolean(),
    rows: z.array(JSON_OBJECT), notes,
    total_is_exact: z.boolean(), has_more: z.boolean(), scan_complete: z.boolean(),
  }).catchall(JSON_VALUE);
}

/** Build the same concrete codec descriptors used by Host and client manifests. */
export function descriptorFor(spec) {
  const codec = { mode: 'strict', typeSymbol: PACKAGE_NAME + '#' + spec.method + 'Request', create: () => requestSchemaFor(spec) };
  return {
    id: PACKAGE_NAME + '#' + NAMESPACE + '/' + spec.method,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method: spec.method,
    description: spec.description,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: REQUEST_WIRE,
        wire: REQUEST_WIRE,
        source: 'json',
        acceptsUndefined: true,
        description: 'Optional request object.',
        codec,
      },
    ],
    cancellation: { parameter: SIGNAL_WIRE },
    result: { mode: 'strict', typeSymbol: PACKAGE_NAME + '#' + spec.method + 'Result', create: () => resultSchemaFor(spec) },
  };
}

/** Normalize the shared settings; explicit disablement overrides every snapshot path. */
export function normalizeConfig(config, fallbackSnapshotDir) {
  if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) {
    throw new TypeError('wechat-ro config must be an object');
  }
  const raw = config || {};
  if (raw.snapshotDir !== undefined && (typeof raw.snapshotDir !== 'string' || raw.snapshotDir.trim() === '')) {
    throw new TypeError('snapshotDir must be a non-empty path');
  }
  if (raw.snapshotEnabled !== undefined && typeof raw.snapshotEnabled !== 'boolean') {
    throw new TypeError('snapshotEnabled must be a boolean');
  }
  if (raw.sourceRoot !== undefined && typeof raw.sourceRoot !== 'string') {
    throw new TypeError('sourceRoot must be a string');
  }
  if (raw.maxRows !== undefined && (!Number.isSafeInteger(raw.maxRows) || raw.maxRows < 1 || raw.maxRows > 500)) {
    throw new RangeError('maxRows must be an integer from 1 to 500');
  }
  const snapshotEnabled = raw.snapshotEnabled ?? true;
  return {
    snapshotDir: snapshotEnabled ? raw.snapshotDir ?? fallbackSnapshotDir ?? '' : '',
    snapshotEnabled,
    sourceRoot: raw.sourceRoot ?? '',
    maxRows: raw.maxRows ?? 500,
  };
}
