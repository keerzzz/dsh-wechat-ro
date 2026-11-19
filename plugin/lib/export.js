// Export a decrypted snapshot as a file an agent (or a human) can read.
//
// Four formats x four scopes. Everything is generated locally from the same
// read-only queries the tools use - no network, no WeChat process, no writes
// outside the workspace file the caller asks for.
//
// The Markdown and AGENTS.md variants are shaped for an LLM: YAML front matter,
// a ## Index with absolute line references, a field dictionary, and an explicit
// read-boundary section so the reader cannot mistake the snapshot for live data.

import { MAX_TEXT, truncate } from './snapshot.js';
import * as methods from './methods.js';

export const FORMATS = [
  { id: 'md', label: 'Markdown', ext: 'md', mime: 'text/markdown;charset=utf-8' },
  { id: 'json', label: 'JSON', ext: 'json', mime: 'application/json;charset=utf-8' },
  { id: 'txt', label: '纯文本', ext: 'txt', mime: 'text/plain;charset=utf-8' },
  { id: 'agents', label: 'AGENTS.md', ext: 'md', mime: 'text/markdown;charset=utf-8' },
];

export const SCOPES = [
  { id: 'library', label: '全库摘要' },
  { id: 'sessions', label: '会话列表' },
  { id: 'timeline', label: '时间线' },
  { id: 'contacts', label: '联系人' },
];

const FIELD_DICT = [
  ['snapshot_time / read_at', '本次读取时刻，不是采集时刻（Asia/Shanghai，+08:00）'],
  ['captured_at / snapshot_id', '已验收 manifest 的采集时刻与代次；旧快照为 null，不猜测'],
  ['query_quality', '各查询的返回数、截断、扫描完整性与总数精确性'],
  ['db_count', '解密库数量'],
  ['message_table_count', '消息表数量'],
  ['contact_rows', '联系人行数'],
  ['session_rows', '会话行数'],
  ['username', '会话或联系人标识；以 @chatroom 结尾为群聊'],
  ['display_name', '显示名 / 群名 / 公众号名'],
  ['local_id', '消息本地序号'],
  ['create_time', '归一到 Asia/Shanghai 的消息时间'],
  ['sender / sender_name', '发送者标识与显示名'],
  ['content', '消息正文；图片与文件为占位描述'],
  ['source', '来源库与表名，如 message_0.db / Msg_4f2a'],
  ['is_chatroom / unread', '是否群聊 / 未读条数'],
  ['SCAN_CAP', '每个消息表最多扫描的行数（超出部分不计入）'],
];

const READ_ONLY_BOUNDARY = [
  '本地离线静态解密快照，不连接微信服务器',
  '数据库以 readOnly 打开，并且只执行 SELECT / PRAGMA 查询',
  'wechat_sql 经 guardSelect 仅允许 SELECT / WITH',
  '不读取 key_info.dat，不发消息，不实时接收，不改动任何微信原文件',
  'Host 导出只在调用方当前 workspace 新建文件，不覆盖已有文件、不写回快照目录',
  'SQLite 逻辑只读不等于目录零写：legacy WAL 库可能创建辅助文件；不能据此忽略活跃 WAL',
];

function num(n) {
  return n === null || n === undefined ? '未知' : Number(n).toLocaleString('en-US');
}

// Escape data before composing Markdown. Only our generated <br> is markup;
// user-controlled pipes, headings, HTML and line breaks remain cell content.
function md(value) {
  return String(value ?? '')
    .replace(/[&<>"'\\\x60*_{}\[\]()!#|]/g, (c) => '&#' + c.codePointAt(0) + ';')
    .replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, '<br>');
}

// JSON quoted scalars are valid YAML 1.2 too. Escape YAML-only line separators.
function scalar(value) {
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function includeQuery(data, name, result) {
  data.notes.push(...result.notes.map((note) => name + ': ' + note));
  const quality = { returned: result.returned ?? result.rows.length };
  for (const key of ['total', 'offset', 'total_is_exact', 'has_more', 'truncated', 'scan_complete', 'scanned_tables']) {
    if (result[key] !== undefined) quality[key] = result[key];
  }
  data.query_quality[name] = quality;
  if (result.truncated || result.scan_complete === false || result.total_is_exact === false) {
    data.notes.push(name + ': 导出不代表全量；查询状态 ' + JSON.stringify(quality));
  }
}

function fmtOf(id) {
  const format = FORMATS.find((f) => f.id === (id ?? 'md'));
  if (!format) throw new TypeError('Unknown export format: ' + id);
  return format;
}

function scopeOf(id) {
  const scope = SCOPES.find((s) => s.id === (id ?? 'library'));
  if (!scope) throw new TypeError('Unknown export scope: ' + id);
  return scope;
}

// Collect exactly the data the requested scope needs.
function collect(ctx, scope, limit) {
  const st = methods.status(ctx);
  const data = {
    snapshot_time: st.snapshot_time,
    read_at: st.read_at ?? st.snapshot_time,
    captured_at: st.captured_at ?? null,
    snapshot_id: st.snapshot_id ?? null,
    capture_complete: st.capture_complete ?? null,
    capture_consistency: st.capture_consistency ?? null,
    time_zone: 'Asia/Shanghai (+08:00)',
    root: st.root,
    ok: st.ok,
    db_count: st.db_count,
    message_table_count: st.message_table_count,
    contact_rows: st.contact_rows,
    session_rows: st.session_rows,
    scan_cap: 3000,
    notes: [...st.notes],
    query_quality: {},
  };
  if (scope === 'sessions') {
    const res = methods.sessions(ctx, { limit });
    data.sessions = res.rows;
    data.total_sessions = res.total;
    includeQuery(data, 'sessions', res);
  } else if (scope === 'contacts') {
    const res = methods.contacts(ctx, { limit });
    data.contacts = res.rows;
    data.total_contacts = res.total;
    includeQuery(data, 'contacts', res);
  } else if (scope === 'timeline') {
    data.timeline = methods.timeline(ctx, { days: 30 });
    includeQuery(data, 'timeline', data.timeline);
  } else {
    const sess = methods.sessions(ctx, { limit: Math.min(limit, 12) });
    includeQuery(data, 'sessions', sess);
    data.top_sessions = sess.rows;
    data.total_sessions = sess.total;
    data.timeline = methods.timeline(ctx, { days: 30 });
    includeQuery(data, 'timeline', data.timeline);
  }
  return data;
}

// ---------------------------------------------------------------- markdown

function mdFrontMatter(d, scope, format) {
  const meta = {
    title: 'WeChat RO · ' + scopeOf(scope).label,
    generator: 'dsh-wechat-ro（只读快照导出）',
    snapshot_time: d.snapshot_time, read_at: d.read_at,
    captured_at: d.captured_at, snapshot_id: d.snapshot_id,
    capture_complete: d.capture_complete, capture_consistency: d.capture_consistency,
    time_zone: d.time_zone, scope, format: fmtOf(format).label, read_only: true,
    db_count: d.db_count, message_table_count: d.message_table_count,
    contact_rows: d.contact_rows, session_rows: d.session_rows,
    query_quality: d.query_quality,
  };
  return ['---', ...Object.entries(meta).map(([key, value]) => key + ': ' + scalar(value)), '---'];
}

function mdBody(d, scope) {
  const L = ['', '# ' + scopeOf(scope).label, ''];
  L.push('读取于 ' + md(d.read_at) + '；采集于 ' + md(d.captured_at ?? '未知（无有效 manifest）') + '；快照目录 ' + md(d.root) + '。');
  L.push('');
  L.push('## 快照信息');
  L.push('');
  L.push('| 字段 | 值 |');
  L.push('| :--- | :--- |');
  L.push('| snapshot_time / read_at | ' + md(d.read_at) + ' |');
  L.push('| captured_at | ' + md(d.captured_at ?? '未知') + ' |');
  L.push('| snapshot_id | ' + md(d.snapshot_id ?? '未知') + ' |');
  L.push('| db_count | ' + d.db_count + ' |');
  L.push('| message_table_count | ' + d.message_table_count + ' |');
  L.push('| contact_rows | ' + num(d.contact_rows) + ' |');
  L.push('| session_rows | ' + num(d.session_rows) + ' |');
  L.push('| scan_cap | ' + num(d.scan_cap) + ' 行/表 |');
  L.push('| ok | ' + (d.ok ? 'true' : 'false') + ' |');
  L.push('');
  // Notes explain why a snapshot came back empty (missing decrypt, permissions,
  // stale directory). They belong at the top: a reader who sees zero rows must
  // know whether the archive is genuinely empty or simply not decrypted yet.
  if (d.notes && d.notes.length > 0) {
    L.push('## 读取提示');
    L.push('');
    for (const note of d.notes) L.push('- ' + md(note));
    L.push('');
  }
  if (scope === 'sessions') {
    L.push('## ' + scopeOf(scope).label);
    L.push('');
    L.push('| 会话 | 类型 | 未读 | 最后消息 | 最近消息 |');
    L.push('| :--- | :--- | --: | :--- | :--- |');
    for (const r of d.sessions) {
      L.push(
        '| ' + md(r.display_name) + ' | ' + (r.is_chatroom ? '群聊' : '单聊') + ' | ' +
        md(r.unread ?? '未知') + ' | ' +
        md(r.last_time || '') + ' | ' + md(truncate(r.summary || '', 60)) + ' |',
      );
    }
    L.push('', '共 ' + num(d.total_sessions) + ' 个会话。');
  } else if (scope === 'contacts') {
    L.push('## ' + scopeOf(scope).label);
    L.push('');
    L.push('| 显示名 | username | 备注 | 别名 |');
    L.push('| :--- | :--- | :--- | :--- |');
    for (const r of d.contacts) {
      L.push('| ' + md(r.display_name) + ' | ' + md(r.username) + ' | ' + md(r.remark || '') + ' | ' + md(r.alias || '') + ' |');
    }
    L.push('', '共 ' + num(d.total_contacts) + ' 位联系人。');
  } else if (scope === 'timeline') {
    const tl = d.timeline;
    L.push('## 近 ' + tl.days + ' 天时间线');
    L.push('');
    L.push('| 日期 | 消息数 |');
    L.push('| :--- | --: |');
    for (const r of tl.rows) L.push('| ' + md(r.date) + ' | ' + r.messages + ' |');
    L.push('', '合计 ' + num(tl.total_messages) + ' 条。');
    L.push('');
    L.push('## 最忙的时段');
    L.push('');
    L.push('| 时段 | 消息数 |');
    L.push('| :--- | --: |');
    for (const r of tl.busiest_hours) L.push('| ' + r.hour + ' | ' + r.messages + ' |');
  } else {
    L.push('## 最近活跃的会话（按最近消息时间）');
    L.push('');
    L.push('| 会话 | 类型 | 未读 | 最后消息 |');
    L.push('| :--- | :--- | --: | :--- |');
    for (const r of d.top_sessions) {
      L.push('| ' + md(r.display_name) + ' | ' + (r.is_chatroom ? '群聊' : '单聊') + ' | ' + md(r.unread ?? '未知') + ' | ' + md(r.last_time || '') + ' |');
    }
    L.push('', '共 ' + num(d.total_sessions) + ' 个会话。');
    L.push('');
    L.push('## 近 ' + d.timeline.days + ' 天时间线');
    L.push('');
    L.push('| 日期 | 消息数 |');
    L.push('| :--- | --: |');
    for (const r of d.timeline.rows) L.push('| ' + md(r.date) + ' | ' + r.messages + ' |');
    L.push('', '合计 ' + num(d.timeline.total_messages) + ' 条。');
  }
  return L;
}

function dictionaryLines(markdown) {
  const L = ['', '## 字段字典', ''];
  if (markdown) {
    L.push('| 字段 | 含义 |', '| :--- | :--- |');
    for (const [k, v] of FIELD_DICT) L.push('| ' + k + ' | ' + v + ' |');
  } else {
    for (const [k, v] of FIELD_DICT) L.push('  ' + k + '  ' + v);
  }
  return L;
}

function boundaryLines(markdown) {
  const L = ['', '## 读取边界', ''];
  for (const n of READ_ONLY_BOUNDARY) L.push((markdown ? '- ' : '  ') + n);
  return L;
}

// The index is built before splicing, so every heading after the insertion
// point must be shifted by the number of lines the index itself adds.
function withIndex(lines) {
  lines = lines.join('\n').replace(/\r\n?/g, '\n').split('\n');
  const idxAt = lines.indexOf('## 快照信息');
  if (idxAt < 0) return lines;
  const heads = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{2,3}) (.+)$/.exec(lines[i]);
    if (!m || m[2] === 'Index') continue;
    heads.push({ level: m[1].length - 2, text: m[2], at: i });
  }
  const index = ['## Index', ''];
  // '## Index' + blank + one line per heading + trailing blank.
  const shift = heads.length + 3;
  for (const h of heads) {
    const finalLine = (h.at >= idxAt ? h.at + shift : h.at) + 1;
    index.push((h.level > 0 ? '  '.repeat(h.level) + '- ' : '- ') + h.text + ' · L' + finalLine);
  }
  index.push('');
  return lines.slice(0, idxAt).concat(index, lines.slice(idxAt));
}

function buildMarkdown(ctx, scope, format, limit) {
  const d = collect(ctx, scope, limit);
  const head = mdFrontMatter(d, scope, format);
  let body = mdBody(d, scope);
  if (format === 'agents') {
    body = body.concat([
      '',
      '## 给智能体的读取说明',
      '',
      '- 这是静态快照；snapshot_time/read_at 仅是读取时刻。captured_at 未知时不要推测采集时刻，也不要假设实时性。',
      '- 需要逐条消息时用工具 mcp__wechat__wechat_messages（按会话）或 mcp__wechat__wechat_search_messages（全库关键词）。',
      '- 需要任意只读 SQL 时用 mcp__wechat__wechat_sql，只接受单条 SELECT / WITH。',
      '- 会话标识以 @chatroom 结尾即群聊；正文超过 ' + num(MAX_TEXT) + ' 字符会被截断。',
    ]);
  }
  let lines = head.concat(body).concat(dictionaryLines(true), boundaryLines(true));
  lines = withIndex(lines);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- text

function buildText(ctx, scope, limit) {
  const d = collect(ctx, scope, limit);
  const L = [];
  L.push('WeChat RO · ' + scopeOf(scope).label);
  L.push('读取于 ' + scalar(d.read_at) + '；采集于 ' + scalar(d.captured_at) + '；' + d.time_zone);
  L.push('snapshot_id ' + scalar(d.snapshot_id));
  L.push('query_quality ' + scalar(d.query_quality));
  L.push('');
  L.push('快照信息');
  L.push('  db_count              ' + d.db_count);
  L.push('  message_table_count   ' + d.message_table_count);
  L.push('  contact_rows          ' + num(d.contact_rows));
  L.push('  session_rows          ' + num(d.session_rows));
  L.push('  ok                    ' + (d.ok ? 'true' : 'false'));
  L.push('');
  if (d.notes && d.notes.length > 0) {
    L.push('读取提示');
    for (const note of d.notes) L.push('  - ' + scalar(note));
    L.push('');
  }
  if (scope === 'sessions') {
    for (const r of d.sessions) {
      L.push('  ' + scalar(r.display_name) + '  ' + (r.is_chatroom ? '群聊' : '单聊') + '  未读 ' + scalar(r.unread ?? null) + '  ' + (r.last_time || '') + '  ' + scalar(truncate(r.summary || '', 60)));
    }
    L.push('', '共 ' + num(d.total_sessions) + ' 个会话。');
  } else if (scope === 'contacts') {
    for (const r of d.contacts) L.push('  ' + scalar(r.display_name) + '  ' + scalar(r.username) + '  ' + scalar(r.remark || '') + '  ' + scalar(r.alias || ''));
    L.push('', '共 ' + num(d.total_contacts) + ' 位联系人。');
  } else if (scope === 'timeline') {
    for (const r of d.timeline.rows) L.push('  ' + r.date + '  ' + r.messages + ' 条');
    L.push('', '近 ' + d.timeline.days + ' 天合计 ' + num(d.timeline.total_messages) + ' 条。');
  } else {
    for (const r of d.top_sessions) L.push('  ' + scalar(r.display_name) + '  ' + (r.is_chatroom ? '群聊' : '单聊') + '  ' + scalar(r.unread ?? null) + '  ' + (r.last_time || ''));
    L.push('', '近 ' + d.timeline.days + ' 天合计 ' + num(d.timeline.total_messages) + ' 条。');
  }
  return L.concat(dictionaryLines(false), boundaryLines(false)).join('\n') + '\n';
}

// ---------------------------------------------------------------- json

function buildJson(ctx, scope, limit) {
  const d = collect(ctx, scope, limit);
  const payload = {
    generator: 'dsh-wechat-ro',
    read_only: true,
    scope,
    scope_label: scopeOf(scope).label,
    snapshot: {
      snapshot_time: d.snapshot_time,
      read_at: d.read_at, captured_at: d.captured_at, snapshot_id: d.snapshot_id,
      capture_complete: d.capture_complete, capture_consistency: d.capture_consistency,
      time_zone: d.time_zone,
      root: d.root,
      ok: d.ok,
      db_count: d.db_count,
      message_table_count: d.message_table_count,
      contact_rows: d.contact_rows,
      session_rows: d.session_rows,
      scan_cap: d.scan_cap,
      notes: d.notes,
    },
    query_quality: d.query_quality,
    field_dictionary: Object.fromEntries(FIELD_DICT),
    read_only_boundary: READ_ONLY_BOUNDARY,
  };
  if (scope === 'sessions') {
    payload.total_sessions = d.total_sessions;
    payload.sessions = d.sessions;
  } else if (scope === 'contacts') {
    payload.total_contacts = d.total_contacts;
    payload.contacts = d.contacts;
  } else if (scope === 'timeline') {
    payload.timeline = d.timeline;
  } else {
    payload.total_sessions = d.total_sessions;
    payload.top_sessions = d.top_sessions;
    payload.timeline = d.timeline;
  }
  return JSON.stringify(payload, null, 2) + '\n';
}

// ---------------------------------------------------------------- entry

export function buildExport(ctx, options) {
  const o = options || {};
  const format = fmtOf(o.format);
  const scope = scopeOf(o.scope);
  const limit = o.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('Export limit must be an integer from 1 to 500');
  let content;
  if (format.id === 'json') content = buildJson(ctx, scope.id, limit);
  else if (format.id === 'txt') content = buildText(ctx, scope.id, limit);
  else content = buildMarkdown(ctx, scope.id, format.id, limit);
  const stamp = new Date(Date.now() + 480 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  return {
    content,
    format: format.id,
    format_label: format.label,
    scope: scope.id,
    scope_label: scope.label,
    filename: 'wechat-ro-' + scope.id + '-' + format.id + '-' + stamp + '.' + format.ext,
    mime: format.mime,
    bytes: Buffer.byteLength(content, 'utf8'),
    read_only: true,
  };
}
