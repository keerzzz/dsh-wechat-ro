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
function fixture() {
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
  const create=()=>createDailyCards({storage,source,query,summarize:async()=>{calls++;return model();},isIdle:()=>idle,now:()=>clock});
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
