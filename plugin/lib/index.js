// Host half: the /wechat-export command and the wechat_export tool.
//
// Both build the same export text from the read-only snapshot and write it into
// the session workspace. Nothing here decrypts, spawns a process or talks to
// WeChat: the snapshot directory is read with node:sqlite in readOnly mode.
//
// Registered as a plain Cordis plugin (export apply + inject). Tools are handed
// to ctx.tools.register as raw JSON Schema definitions, so this package needs no
// @deepseek-ai tooling import beyond the runtime services it injects.

import { randomUUID } from 'node:crypto';
import { FsError } from '@deepseek-ai/dsh-fs';
import { FORMATS, SCOPES, buildExport } from './export.js';
import * as methods from './methods.js';
import { EXPORT_TOOL, normalizeConfig } from './wire.js';

/** Cordis plugin name. */
export const name = 'wechat-ro';

/** Services this plugin needs before apply() runs. */
export const inject = ['commands', 'tools', 'fs', 'workingDirectory'];

const FORMAT_IDS = FORMATS.map((f) => f.id);
const SCOPE_IDS = SCOPES.map((s) => s.id);

function storeOf(config) {
  const cfg = normalizeConfig(config, process.env.WECHAT_SNAPSHOT_DIR);
  return methods.createContext(cfg);
}

/** Split "/wechat-export md sessions" into { format, scope, limit }. */
function parseArgs(raw) {
  const tokens = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const out = { format: 'md', scope: 'library', limit: 200 };
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (FORMAT_IDS.includes(lower)) out.format = lower;
    else if (SCOPE_IDS.includes(lower)) out.scope = lower;
    else if (/^\d+$/.test(lower) && Number.isSafeInteger(Number(lower)) && Number(lower) >= 1 && Number(lower) <= 500) out.limit = Number(lower);
    else throw new TypeError('未知格式、范围或条数：' + token + '；条数必须是 1–500 的整数。');
  }
  return out;
}

function usage() {
  return [
    '用法：/wechat-export [格式] [范围] [条数]',
    '格式：' + FORMATS.map((f) => f.id + '（' + f.label + '）').join(' / '),
    '范围：' + SCOPES.map((s) => s.id + '（' + s.label + '）').join(' / '),
    '示例：/wechat-export md sessions 100',
  ].join('\n');
}

/** Create one new export in this invocation's workspace, never in the snapshot. */
async function writeExport(ctx, store, options, execution) {
  if (execution?.agent === undefined) throw new Error('wechat-export requires an agent Session');
  const { agent, signal } = execution;
  signal.throwIfAborted();
  store.requireConfigured();
  const cwd = await ctx.workingDirectory.ensure(agent, signal);
  const policyService = ctx.get('sandboxPolicy');
  const policy = policyService?.resolve({ session: agent.session });
  if (ctx.fs.sandboxMode !== undefined && policy === undefined) {
    throw new Error('wechat-export requires sandboxPolicy with a sandboxing filesystem');
  }
  const resolveOptions = { cwd, signal };
  const workspace = await ctx.fs.resolve('.', resolveOptions);
  const snapshotPath = ctx.fs.processPathFromHostPath(store.snap().root);
  if (snapshotPath === undefined) throw new Error('wechat-export requires a filesystem with an explicit host-path mapping');
  const snapshot = await ctx.fs.resolve(snapshotPath, { signal });
  const built = buildExport(store, options);
  signal.throwIfAborted();
  const filename = built.filename.replace(/([.][^.]+)$/, '-' + randomUUID() + '$1');
  const target = await ctx.fs.resolve(filename, resolveOptions);
  if (!ctx.fs.contains(workspace, target) || ctx.fs.contains(snapshot, target)) {
    throw new FsError('导出只能新建在当前 workspace，且不得位于快照目录内。', 'FS_PERMISSION_DENIED');
  }
  // A bare provider advertises no sandbox enforcement. Honor a mounted policy
  // here in that composition; a sandboxing provider owns the normal check.
  if (policy !== undefined && ctx.fs.sandboxMode === undefined) {
    const denied = policy.mode === 'read-only' || (policy.mode === 'workspace-write'
      && !ctx.fs.contains(await ctx.fs.resolve(policy.workspaceRoot, { signal }), target));
    if (denied) throw new FsError('当前会话文件策略不允许此导出。', 'FS_SANDBOX_DENIED');
  }
  await ctx.fs.writeText(target, built.content, { kind: 'createIfAbsent' }, signal, policy);
  return { ...built, filename, path: ctx.fs.processPath(target) };
}

/** Raw JSON Schema for the tool parameters. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    format: { type: 'string', enum: FORMAT_IDS, description: '导出格式，默认 md（Markdown）' },
    scope: { type: 'string', enum: SCOPE_IDS, description: '导出范围，默认 library（全库摘要）' },
    limit: { type: 'integer', minimum: 1, maximum: 500, description: '每个列表最多导出的行数，默认 200，上限 500' },
  },
};

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'filename', 'format', 'scope', 'bytes'],
  properties: {
    path: { type: 'string', description: '写入 workspace 的绝对路径' },
    filename: { type: 'string' },
    format: { type: 'string' },
    format_label: { type: 'string' },
    scope: { type: 'string' },
    scope_label: { type: 'string' },
    bytes: { type: 'number' },
    read_only: { type: 'boolean' },
  },
};

function textOf(value) {
  const lines = [
    '已导出 ' + value.format_label + ' · ' + value.scope_label + ' → ' + value.path,
    '大小 ' + Number(value.bytes).toLocaleString('en-US') + ' 字节；只读快照，未改动任何微信文件。',
  ];
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Register the command and the tool.
 * @param ctx - Cordis context with commands/tools/fs/workingDirectory.
 * @param config - the plugin row config: { snapshotDir, snapshotEnabled, sourceRoot, maxRows }.
 */
export function apply(ctx, config) {
  const store = storeOf(config);

  ctx.effect(
    () => ctx.commands.register({
      definitionId: 'dsh-wechat-ro/wechat-export',
      name: 'wechat-export',
      description: '把只读微信快照导出成智能体能读的文件（Markdown / JSON / 纯文本 / AGENTS.md）',
      input: { hint: '[md|json|txt|agents] [library|sessions|timeline|contacts] [条数]' },
      recordInput: false,
      handler: async (invocation) => {
        const raw = String(invocation.rawInput || '').trim();
        if (raw === 'help' || raw === '?') return { kind: 'success', text: usage() };
        try {
          const written = await writeExport(ctx, store, parseArgs(raw), invocation);
          return { kind: 'success', text: '已导出 ' + written.format_label + ' · ' + written.scope_label + ' → ' + written.path + '（' + Number(written.bytes).toLocaleString('en-US') + ' 字节）' };
        } catch (error) {
          return { kind: 'error', text: '导出失败：' + (error && error.message ? error.message : String(error)) };
        }
      },
    }),
    'wechat-ro: command',
  );

  ctx.tools.register({
    name: EXPORT_TOOL,
    description: '把本地只读微信快照导出成给智能体阅读的文件（Markdown / JSON / 纯文本 / AGENTS.md），写入当前 workspace。不连接微信服务器，不修改任何微信文件。',
    parameters: PARAMETERS,
    timeoutMs: 120000,
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => textOf(value) },
    async execute(args, execution) {
      const request = args || {};
      const written = await writeExport(ctx, store, {
        format: request.format,
        scope: request.scope,
        limit: request.limit,
      }, execution);
      return {
        path: written.path,
        filename: written.filename,
        format: written.format,
        format_label: written.format_label,
        scope: written.scope,
        scope_label: written.scope_label,
        bytes: written.bytes,
        read_only: true,
      };
    },
  });
}

export default { name, inject, apply };
