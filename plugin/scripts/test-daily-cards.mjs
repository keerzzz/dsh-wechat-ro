import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createArchiveAccess } from '../lib/archive-access.js';
import { createDailyCards, dailyCardClock, parseDailySummary } from '../lib/daily-cards.js';
const ts = text => Date.parse(text) / 1000;
const record = () => ({ ts: ts('2026-11-18T23:59:59+08:00'), talker: 'alice', senderTalker: 'alice', localTime: '2026-11-18T23:59:59+08:00', content: '请王明周五交付报告', contentTruncated: false, citation: { snapshotRef: 'a'.repeat(24), recordRef: 'b'.repeat(32) } });
const model = () => JSON.stringify({ highlights: [{ text: '周五交付报告', refs: ['b'.repeat(32)] }], todos: [{ text: '交付报告', assignee: '王明', refs: ['b'.repeat(32)] }] });
test('calendar boundary, custom daily time and next update use Beijing time', () => {
  assert.equal(dailyCardClock(Date.parse('2026-11-19T07:59:59+08:00')).dueDay, '2026-11-17');
  assert.equal(dailyCardClock(Date.parse('2026-11-19T08:00:00+08:00')).dueDay, '2026-11-18');
  const custom = dailyCardClock(Date.parse('2026-11-19T08:00:00+08:00'), '18:30');
  assert.equal(custom.dueDay, '2026-11-17'); assert.equal(custom.nextRunAt, Date.parse('2026-11-19T18:30:00+08:00'));
  assert.equal(dailyCardClock(Date.parse('2027-01-01T00:00:00+08:00'), '00:00').dueDay, '2026-12-31');
});
test('citations must resolve to the selected original messages', () => {
  const summary = parseDailySummary(model(), [record()]);
  assert.equal(summary.todos[0].citations[0].content, record().content);
  const classified=parseDailySummary(model(),[{...record(),sourceKind:'service',displayName:'A service account'}]);
  assert.equal(classified.highlights[0].citations[0].sourceKind,'service');assert.equal(classified.todos[0].citations[0].displayName,'A service account');
  assert.throws(() => parseDailySummary(model().replaceAll('b'.repeat(32), 'c'.repeat(32)), [record()]), /UNKNOWN_CITATION/);
  assert.throws(() => parseDailySummary('{"highlights":[{"text":"invented","refs":[]}],"todos":[]}', []));
});
function fixture(extra = {}) {
  let clock=Date.parse('2026-11-19T09:00:00+08:00'),idle=true,failure=false,revised=0,calls=0,enriched=false;
  const stored=new Map(),queries=[];
  const storage={open:async()=>({table:()=>({get:id=>structuredClone(stored.get(id)),put:async(id,value)=>stored.set(id,structuredClone(value))}),close:async()=>{}})};
  const source=()=>({enabled:true,phase:'ready',accountRef:'account',capturedAt:'2026-11-19T09:00:00+08:00'});
  const query=async(_id,request)=>{
    queries.push(request.query);if(failure)throw new Error('disk failed');const q=request.query;
    if(q.action==='digest')return{rows:[record()],hasMore:false};const rows=[];
    for(let n=q.fromTs;n<=q.toTs;n+=86400){const day=new Date((n+28800)*1000).toISOString().slice(0,10);rows.push({day,messageCount:2+revised,textCount:1,activeContacts:1,activeGroups:0,lastMessageTs:n+1+revised,conversations:[{talker:'alice',displayName:'Alice',messageCount:2,textCount:1}]});}
    if(enriched)for(const row of rows){row.conversations[0].sourceKind='personal';row.sources=[{talker:'alice',displayName:'Alice',sourceKind:'personal'}];}
    return{rows,hasMore:false,historyFreshness:{capturedAt:source().capturedAt}};
  };
  const create=()=>createDailyCards({storage,source,query,summarize:async()=>{calls++;return model();},isIdle:()=>idle,now:()=>clock,...extra});
  return{create,queries,setClock:value=>clock=Date.parse(value),setIdle:value=>idle=value,setFailure:value=>failure=value,revise:()=>revised++,enrich:()=>enriched=true,calls:()=>calls};
}
test('persisted results avoid duplicate model work and catch up missed dates with the chosen time',async()=>{
  const f=fixture();let cards=f.create();await cards.update('task');assert.equal(cards.state('task').reports[0].day,'2026-11-18');assert.equal(f.calls(),1);
  await cards.update('task');assert.equal(f.calls(),1);await cards.settings('task','18:30');await cards.dispose();
  f.setClock('2026-11-22T19:00:00+08:00');cards=f.create();for(let i=0;i<3;i++)await cards.update('task');
  assert.deepEqual(cards.state('task').reports.map(row=>row.day),['2026-11-18','2026-11-19','2026-11-20','2026-11-21']);assert.equal(cards.state('task').time,'18:30');assert.equal(cards.state('task').pendingDays,0);assert.equal(f.calls(),4);
  assert.ok(f.queries.every(q=>q.fromTs!==undefined&&q.toTs!==undefined));await cards.dispose();
});
test('busy turns postpone work; read failures preserve cards; changed recent days regenerate',async()=>{
  const f=fixture(),cards=f.create();f.setIdle(false);await cards.update('task');assert.equal(f.queries.length,0);
  f.setIdle(true);await cards.update('task');const original=structuredClone(cards.state('task').reports);
  f.setFailure(true);await cards.update('task');assert.equal(cards.state('task').phase,'failed');assert.deepEqual(cards.state('task').reports,original);
  f.setFailure(false);f.revise();await cards.update('task');assert.equal(cards.state('task').phase,'ready');assert.equal(f.calls(),2);assert.equal(cards.state('task').reports.length,1);await cards.dispose();
});
test('source metadata updates old cards without triggering another model summary',async()=>{
  const f=fixture(),cards=f.create();await cards.update('task');const previous=structuredClone(cards.state('task').reports);
  f.enrich();await cards.update('task');assert.equal(f.calls(),1);assert.deepEqual(cards.state('task').reports,previous);
  assert.equal(cards.state('task').stats[0].sources[0].sourceKind,'personal');await cards.dispose();
});
test('fixed SQL child counts all rows, merges active conversations, and excludes media from digest',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wechat-card-sql-'));for(const dir of ['contact','session','message'])mkdirSync(join(root,dir));
  let db=new DatabaseSync(join(root,'contact/contact.db'));db.exec('CREATE TABLE contact(username TEXT, remark TEXT)');for(const user of ['alice','group@chatroom'])db.prepare('INSERT INTO contact VALUES(?,?)').run(user,user);db.close();
  for(let file=0;file<2;file++){db=new DatabaseSync(join(root,'message/m'+file+'.db'));for(const user of ['alice','group@chatroom']){const name='Msg_'+createHash('md5').update(user).digest('hex');db.exec('CREATE TABLE '+name+'(local_id INTEGER, create_time INTEGER, message_content TEXT, local_type INTEGER)');db.prepare('INSERT INTO '+name+' VALUES(?,?,?,?)').run(file,ts('2026-11-18T23:59:59+08:00'),'请王明周五交付报告',1);db.prepare('INSERT INTO '+name+' VALUES(?,?,?,?)').run(file+10,ts('2026-11-19T00:00:00+08:00'),Buffer.from([0,1]),3);}db.close();}
  const access=createArchiveAccess({hasArchiveHistory:()=>true,markArchiveHistory:async()=>{}});
  try{await access.grant('cards',{root,allConversations:true,talkers:[],fromTs:null,toTs:null,allowWechat:false,confirmation:'read-decrypted-snapshot'});
    const page=await access.query('cards',{action:'stats',fromTs:ts('2026-11-18T00:00:00+08:00'),toTs:ts('2026-11-19T23:59:59+08:00'),limit:7});assert.deepEqual(page.rows.map(row=>[row.messageCount,row.textCount,row.activeContacts,row.activeGroups]),[[4,4,1,1],[4,0,1,1]]);
    const digest=await access.query('cards',{action:'digest',fromTs:ts('2026-11-19T00:00:00+08:00'),toTs:ts('2026-11-19T23:59:59+08:00')});assert.equal(digest.rows.length,0);
    const text=await access.query('cards',{action:'digest',fromTs:ts('2026-11-18T00:00:00+08:00'),toTs:ts('2026-11-18T23:59:59+08:00'),limit:1});assert.equal(text.rows.length,1);assert.equal(text.hasMore,true);assert.match(text.rows[0].citation.recordRef,/^[a-f0-9]{32}$/);
    await assert.rejects(()=>access.query('cards',{action:'stats'}),error=>error.code==='invalid-request');
  }finally{await access.dispose();rmSync(root,{recursive:true,force:true});}
});
test('SQL source catalog separates account types and retains identities beyond the top ten within the granted scope',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wechat-card-sources-'));for(const dir of ['contact','session','message'])mkdirSync(join(root,dir));
  const users=['group@chatroom','filehelper','gh_public','zz_service','gh_missing','verified_official',...Array.from({length:12},(_,i)=>'person-'+i)];
  let db=new DatabaseSync(join(root,'contact/contact.db'));
  db.exec('CREATE TABLE contact(username TEXT,remark TEXT,verify_flag INTEGER); CREATE TABLE biz_info(username TEXT,type INTEGER)');
  for(const user of users)db.prepare('INSERT INTO contact VALUES(?,?,?)').run(user,user,user==='verified_official'?8:0);
  db.prepare('INSERT INTO biz_info VALUES(?,?)').run('gh_public',0);db.prepare('INSERT INTO biz_info VALUES(?,?)').run('zz_service',1);db.close();
  db=new DatabaseSync(join(root,'message/m0.db'));
  for(const user of users){const name='Msg_'+createHash('md5').update(user).digest('hex');db.exec('CREATE TABLE '+name+'(local_id INTEGER,create_time INTEGER,message_content TEXT,local_type INTEGER)');db.prepare('INSERT INTO '+name+' VALUES(?,?,?,1)').run(1,ts('2026-11-18T18:00:00+08:00'),'text');}db.close();
  const access=createArchiveAccess({hasArchiveHistory:()=>true,markArchiveHistory:async()=>{}}),range={action:'stats',fromTs:ts('2026-11-18T00:00:00+08:00'),toTs:ts('2026-11-18T23:59:59+08:00'),limit:1};
  try{
    await access.grant('sources',{root,allConversations:true,talkers:[],fromTs:null,toTs:null,allowWechat:false,confirmation:'read-decrypted-snapshot'});
    const day=(await access.query('sources',range)).rows[0],kinds=new Map(day.sources.map(source=>[source.talker,source.sourceKind]));
    assert.equal(day.conversations.length,10);assert.equal(day.sources.length,users.length);assert.equal(day.messageCount,users.length);
    assert.equal(day.conversations.some(row=>row.talker==='zz_service'),false);assert.equal(kinds.get('zz_service'),'service');
    assert.equal(kinds.get('gh_public'),'official');assert.equal(kinds.get('gh_missing'),'official');assert.equal(kinds.get('verified_official'),'official');
    assert.equal(kinds.get('person-0'),'personal');assert.equal(kinds.get('group@chatroom'),'group');assert.equal(kinds.get('filehelper'),'system');
    await access.grant('scoped',{root,allConversations:false,talkers:['zz_service'],fromTs:null,toTs:null,allowWechat:false,confirmation:'read-decrypted-snapshot'});
    const scoped=(await access.query('scoped',range)).rows[0];assert.deepEqual(scoped.sources,[{talker:'zz_service',displayName:'zz_service',sourceKind:'service'}]);
  }finally{await access.dispose();rmSync(root,{recursive:true,force:true});}
});

test('content-only edits change the daily signature without changing chat counts', async () => {
  const root=mkdtempSync(join(tmpdir(),'wechat-daily-content-signature-'));
  for(const folder of ['contact','message','content'])mkdirSync(join(root,folder));
  let db=new DatabaseSync(join(root,'contact/contact.db'));db.exec("CREATE TABLE contact(username TEXT,remark TEXT);INSERT INTO contact VALUES('alice','Alice')");db.close();
  db=new DatabaseSync(join(root,'message/message_0.db'));db.exec("CREATE TABLE Name2Id(user_name TEXT);INSERT INTO Name2Id VALUES('alice')");
  const table='Msg_'+createHash('md5').update('alice').digest('hex');db.exec('CREATE TABLE '+table+'(local_id INTEGER,create_time INTEGER,message_content TEXT,local_type INTEGER)');db.prepare('INSERT INTO '+table+' VALUES(1,?,?,1)').run(ts('2026-11-18T12:00:00+08:00'),'Synthetic chat');db.close();
  const edit=text=>{const value=new DatabaseSync(join(root,'content/content.db'));value.prepare('UPDATE records SET content=?').run(text);value.close();};
  db=new DatabaseSync(join(root,'content/content.db'));db.exec('CREATE TABLE records(record_ref TEXT,kind TEXT,talker TEXT,ts INTEGER,title TEXT,content TEXT,url TEXT,metadata TEXT)');db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run('c'.repeat(32),'favorites','alice',ts('2026-11-18T12:30:00+08:00'),'','Content A','','{}');db.close();
  const access=createArchiveAccess({hasArchiveHistory:()=>true,markArchiveHistory:async()=>{}});
  try{
    await access.grant('content-signature',{root,allConversations:true,talkers:[],fromTs:null,toTs:null,allowWechat:false,confirmation:'read-decrypted-snapshot'});
    const query={action:'stats',fromTs:ts('2026-11-18T00:00:00+08:00'),toTs:ts('2026-11-18T23:59:59+08:00'),limit:1};
    const first=(await access.query('content-signature',query)).rows[0];
    edit('Content B');await access.refresh('content-signature',root);
    const second=(await access.query('content-signature',query)).rows[0];
    assert.equal(second.messageCount,first.messageCount);assert.deepEqual(second.contentCounts,{favorites:1});assert.notEqual(first.contentSignature,second.contentSignature);
  }finally{await access.dispose();rmSync(root,{recursive:true,force:true});}
});

test('the whole day crosses the offset cap and reads Unicode message and content tails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wechat-whole-day-'));
  for (const folder of ['contact', 'message', 'content']) mkdirSync(join(root, folder));
  let db = new DatabaseSync(join(root, 'contact/contact.db'));
  db.exec("CREATE TABLE contact(username TEXT,remark TEXT);INSERT INTO contact VALUES('alice','Alice')"); db.close();
  const table = 'Msg_' + createHash('md5').update('alice').digest('hex');
  const original = new Map(), dayStart = ts('2026-11-18T00:00:00+08:00');
  const longText = '😀汉字'.repeat(1600) + '\n尾部任务：请王明交付报告';
  db = new DatabaseSync(join(root, 'message/m0.db'));
  db.exec('CREATE TABLE ' + table + '(local_id INTEGER,create_time INTEGER,message_content TEXT,local_type INTEGER)');
  const insert = db.prepare('INSERT INTO ' + table + ' VALUES(?,?,?,1)');
  for (let n = 1; n <= 1205; n++) {
    const content = n === 1200 ? longText : '消息 ' + n;
    insert.run(n, dayStart + n, content);
    const ref = createHash('sha256').update('message/m0.db/' + table + '/' + n + '/' + (dayStart + n) + '/' + n).digest('hex').slice(0, 32);
    original.set(ref, content);
  }
  db.close();
  db = new DatabaseSync(join(root, 'content/content.db'));
  db.exec('CREATE TABLE records(record_ref TEXT,kind TEXT,talker TEXT,ts INTEGER,title TEXT,content TEXT,url TEXT,metadata TEXT)');
  for (let n = 0; n < 135; n++) {
    const ref = createHash('md5').update('content-' + n).digest('hex');
    const title = n === 134 ? '标题😀'.repeat(800) : '收藏 ' + n;
    const content = n === 134 ? longText : '内容 ' + n;
    db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(ref, 'favorites', 'alice', dayStart + n, title, content, '', '{}');
    original.set(ref, title + '\n' + content);
  }
  db.close();
  const access = createArchiveAccess({ hasArchiveHistory: () => true, markArchiveHistory: async () => {} });
  const stored = new Map(), seen = new Map(); let mergeCalls = 0;
  const storage = { open: async () => ({ table: () => ({ get: id => structuredClone(stored.get(id)), put: async (id, value) => stored.set(id, structuredClone(value)) }), close: async () => {} }) };
  const cards = createDailyCards({ storage,
    query: (_id, request, signal) => access.query('whole', request.query, signal),
    now: () => Date.parse('2026-11-19T09:00:00+08:00'), isIdle: () => true,
    source: () => ({ enabled: true, phase: 'ready', accountRef: 'account', contentSources: ['favorites'] }),
    summarize: async (_id, prompt) => {
      const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      if (data[0]?.kind) {
        mergeCalls++;
        return JSON.stringify({ highlights: [{ text: '全天合并事实', refs: [data[0].refs[0]] }], todos: [] });
      }
      for (const row of data) seen.set(row.citation.recordRef, (seen.get(row.citation.recordRef) ?? '') + row.content);
      return JSON.stringify({ highlights: [{ text: '本批 ' + data[0].content.slice(0, 30), refs: [data[0].citation.recordRef] }], todos: [] });
    },
  });
  try {
    await access.grant('whole', { root, allConversations: true, talkers: [], fromTs: null, toTs: null, allowWechat: false, confirmation: 'read-decrypted-snapshot' });
    await cards.update('task');
    assert.equal(cards.state('task').phase, 'ready');
    const report = cards.state('task').reports[0];
    assert.equal(report.includedTexts, 1340); assert.equal(report.totalTexts, 1340); assert.equal(report.partial, false);
    assert.equal(report.coverageVersion, 2); assert.ok(report.chunkCount > 8); assert.ok(mergeCalls > 0);
    assert.equal(seen.size, original.size);
    for (const [ref, content] of original) assert.equal(seen.get(ref), content, 'full original: ' + ref);
    assert.equal(cards.state('task').progress.stage, 'complete'); assert.equal(stored.get('task').draft, undefined);
    const first = await access.query('whole', { action: 'digest', fromTs: dayStart + 1200, toTs: dayStart + 1200, limit: 1 });
    const tail = await access.query('whole', { action: 'digest', fromTs: dayStart + 1200, toTs: dayStart + 1200, contentOffset: 1024, limit: 1 });
    assert.equal(first.rows[0].citation.recordRef, tail.rows[0].citation.recordRef);
    assert.equal(tail.rows[0].content, [...longText].slice(1024, 2048).join(''));
    await assert.rejects(access.query('whole', { action: 'stats', fromTs: dayStart, toTs: dayStart + 86399, contentOffset: 1 }), error => error.code === 'invalid-request');
    await access.grant('scoped-tail', { root, allConversations: false, talkers: ['bob'], fromTs: dayStart, toTs: dayStart + 86399, allowWechat: false, confirmation: 'read-decrypted-snapshot' });
    await assert.rejects(access.query('scoped-tail', { action: 'digest', talker: 'alice', fromTs: dayStart, toTs: dayStart + 86399, contentOffset: 1024 }), error => error.code === 'scope-forbidden');
  } finally { await cards.dispose(); await access.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('completed chunks survive restart, keep fresh citations, and resume after a failure', async () => {
  const stored = new Map(), completedPrompts = new Set(); let failNext = false, calls = 0, snapshot = 'a'.repeat(24);
  const rows = Array.from({ length: 240 }, (_, n) => ({ ...record(), ts: ts('2026-11-18T23:59:59+08:00') - n,
    content: '独立事项 ' + n + '：' + '请核对报告。'.repeat(30), citation: { snapshotRef: snapshot, recordRef: createHash('md5').update('row-' + n).digest('hex') } }));
  const storage = { open: async () => ({ table: () => ({ get: id => structuredClone(stored.get(id)), put: async (id, value) => stored.set(id, structuredClone(value)) }), close: async () => {} }) };
  const options = { storage, now: () => Date.parse('2026-11-19T09:00:00+08:00'), isIdle: () => true,
    source: () => ({ enabled: true, phase: 'ready', accountRef: 'account' }),
    query: async (_id, request) => {
      const q = request.query;
      if (q.action === 'stats') {
        const stats = [];
        for (let n = q.fromTs; n <= q.toTs; n += 86400) stats.push({ day: new Date((n + 28800) * 1000).toISOString().slice(0, 10), textCount: 240, messageCount: 240, lastMessageTs: rows[0].ts, conversations: [{ talker: 'alice', sourceKind: 'personal' }] });
        return { rows: stats, hasMore: false };
      }
      const filtered = rows.filter(row => row.ts >= q.fromTs && row.ts <= q.toTs).slice(q.offset ?? 0);
      return { rows: filtered.slice(0, q.limit).map(row => ({ ...row, citation: { ...row.citation, snapshotRef: snapshot } })), hasMore: filtered.length > q.limit };
    },
    summarize: async (_id, prompt) => {
      calls++;
      if (failNext || calls === 3) { failNext = false; throw Object.assign(new Error('route failed'), { code: 'SUMMARY_MODEL_FAILED' }); }
      const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      if (data[0]?.kind) return JSON.stringify({ highlights: [{ text: '合并事项', refs: data[0].refs }], todos: [] });
      const key = data[0].citation.recordRef;
      assert.equal(completedPrompts.has(key), false, 'a completed record batch must not repeat'); completedPrompts.add(key);
      return JSON.stringify({ highlights: [{ text: data[0].content.slice(0, 40), refs: [key] }], todos: [] });
    },
  };
  let cards = createDailyCards(options);
  await cards.update('task');
  assert.equal(cards.state('task').phase, 'failed'); assert.equal(cards.state('task').reports.length, 0);
  assert.equal(stored.get('task').draft.completed.length, 2); assert.equal(stored.get('task').nextDay, '2026-11-18');
  await cards.dispose(); snapshot = 'c'.repeat(24); cards = createDailyCards(options);
  await cards.update('task');
  assert.equal(cards.state('task').phase, 'ready'); assert.equal(cards.state('task').reports[0].includedTexts, 240);
  assert.equal(cards.state('task').reports[0].highlights[0].citations[0].snapshotRef, snapshot);
  const before = calls; await cards.update('task'); assert.equal(calls, before);
  // A changed input invalidates the completed work rather than reusing a stale summary.
  rows[0].content += ' 改版'; failNext = true;
  await cards.update('task', true); assert.equal(cards.state('task').phase, 'failed');
  assert.equal(cards.state('task').reports[0].includedTexts, 240); assert.equal(stored.get('task').draft.completed.length, 0);
  await cards.dispose();
});

test('confirmed tasks survive report dates and restart; only explicit actions complete or reopen them', async () => {
  const f = fixture(); let cards = f.create(); await cards.update('task');
  const report = cards.state('task').reports[0], lead = report.todos[0];
  assert.deepEqual(cards.state('task').trackedTodos, []); assert.equal(lead.tracked, null);
  await assert.rejects(cards.manageTodo('task', { action: 'confirmDailyTodo', day: report.day, todoId: 'f'.repeat(64), assignee: 'Me' }), /INVALID_REQUEST/);
  await cards.manageTodo('task', { action: 'confirmDailyTodo', day: report.day, todoId: lead.id, assignee: 'Me' });
  const original = cards.state('task').trackedTodos[0]; assert.equal(original.completedAt, null);
  assert.deepEqual(original.citations, lead.citations);
  f.setClock('2026-11-20T09:00:00+08:00'); await cards.update('task');
  assert.equal(cards.state('task').reports.at(-1).day, '2026-11-19');
  assert.equal(cards.state('task').trackedTodos.length, 1); assert.equal(cards.state('task').trackedTodos[0].day, '2026-11-18');
  await cards.manageTodo('task', { action: 'setDailyTodoState', todoId: lead.id, completed: true });
  const completedAt = cards.state('task').trackedTodos[0].completedAt; assert.equal(typeof completedAt, 'number');
  await cards.dispose(); cards = f.create(); await cards.load('task');
  assert.equal(cards.state('task').trackedTodos[0].completedAt, completedAt);
  await cards.update('task'); assert.equal(cards.state('task').trackedTodos[0].completedAt, completedAt);
  await cards.manageTodo('task', { action: 'setDailyTodoState', todoId: lead.id, completed: false });
  assert.equal(cards.state('task').trackedTodos[0].completedAt, null);
  await cards.load('other-task'); assert.deepEqual(cards.state('other-task').trackedTodos, []);
  await assert.rejects(cards.manageTodo('other-task', { action: 'setDailyTodoState', todoId: lead.id, completed: true }), /INVALID_REQUEST/);
  await cards.dispose();
});
test('a changed account cannot see or update another account confirmed tasks', async () => {
  let account = 'a'; const f = fixture({ source: () => ({ enabled: true, phase: 'ready', accountRef: account }) });
  const cards = f.create(); await cards.update('task'); const lead = cards.state('task').reports[0].todos[0];
  await cards.manageTodo('task', { action: 'confirmDailyTodo', day: '2026-11-18', todoId: lead.id, assignee: 'Me' });
  account = 'b'; await cards.load('task'); assert.deepEqual(cards.state('task').trackedTodos, []);
  await assert.rejects(cards.manageTodo('task', { action: 'setDailyTodoState', todoId: lead.id, completed: true }), /INVALID_REQUEST/);
  await cards.dispose();
});
test('long-text continuation cannot join two different snapshots with the same record identity', async () => {
  let summaries = 0;
  const f = fixture({ summarize: async () => { summaries++; return model(); }, query: async (_id, request) => {
    const q = request.query;
    if (q.action === 'digest') return { rows: [{ ...record(), content: q.contentOffset ? 'tail' : 'x'.repeat(1024), contentTruncated: !q.contentOffset,
      citation: { ...record().citation, snapshotRef: (q.contentOffset ? 'c' : 'a').repeat(24) } }], hasMore: false };
    const rows = []; for (let n = q.fromTs; n <= q.toTs; n += 86400) rows.push({ day: new Date((n+28800)*1000).toISOString().slice(0,10),
      messageCount: 1, textCount: 1, lastMessageTs: n, conversations: [{ talker: 'alice' }] });
    return { rows, hasMore: false };
  } });
  const cards = f.create(); await cards.update('task');
  assert.equal(cards.state('task').phase, 'failed'); assert.equal(summaries, 0); assert.deepEqual(cards.state('task').reports, []); await cards.dispose();
});

test('cancelled Owner task update cannot write after waiting for a summary batch', async () => {
  let release, started, calls = 0;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const f = fixture({ summarize: async () => { if (++calls === 2) { started(); await gate; } return model(); } });
  const cards = f.create(); await cards.update('task'); const lead = cards.state('task').reports[0].todos[0];
  await cards.manageTodo('task', { action: 'confirmDailyTodo', day: '2026-11-18', todoId: lead.id, assignee: 'Me' });
  const running = cards.update('task', true); await entered;
  const control = new AbortController(), pending = cards.manageTodo('task', { action: 'setDailyTodoState', todoId: lead.id, completed: true }, control.signal);
  control.abort(); release(); await running;
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cards.state('task').trackedTodos[0].completedAt, null);
  await cards.dispose();
});
