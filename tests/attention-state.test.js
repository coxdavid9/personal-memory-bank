const test=require('node:test');const assert=require('node:assert/strict');
const {identifyCandidate,isVisible,prepareAttention,decideAttention}=require('../attention-state');
const {buildAttentionCandidates}=require('../attention-engine');
const {EmailClient}=require('../email');
test('handled incoming message stays suppressed while a new incoming message resurfaces',async()=>{
 const feed=uid=>buildAttentionCandidates({email:{yahoo:[{uid,subject:'Next steps',date:'2026-10-03T10:00:00Z'}]}});
 const first=identifyCandidate(feed(1)[0]);
 const db={query:async sql=>({rows:sql.startsWith('SELECT')?[{id:first.id,status:'handled'}]:[]})};
 assert.equal((await prepareAttention(db,feed(1))).length,0);
 assert.equal((await prepareAttention(db,feed(2))).length,1);
});
test('snooze expires and calendar countdown changes do not reset identity',()=>{
 assert.equal(isVisible({status:'snoozed',snoozed_until:'2026-10-03T10:00:00Z'},new Date('2026-10-03T11:00:00Z')),true);
 assert.equal(isVisible({status:'snoozed',snoozed_until:'2026-10-04T10:00:00Z'},new Date('2026-10-03T11:00:00Z')),false);
 assert.equal(identifyCandidate({domain:'calendar',text:'Prepare',why:'Starts in 2 minutes'}).id,identifyCandidate({domain:'calendar',text:'Prepare',why:'Starts in 1 minute'}).id);
});
test('decision transaction retires exact notes and declared memory only, rolls back unknown items',async()=>{
 const calls=[],item=identifyCandidate({domain:'memory',text:'Do this',memoryId:7});
 const client={query:async(sql,args)=>{calls.push({sql,args});if(sql.startsWith('SELECT'))return{rows:[{payload:item,status:'active'}]};if(sql.startsWith('UPDATE memories'))return{rows:[{id:7}]};return{rows:[]}},release(){}};
 const result=await decideAttention({connect:async()=>client},item.id,'handled');
 assert.equal(result.status,'handled');assert.ok(result.invalidates.length);assert.equal(calls.at(-1).sql,'COMMIT');
 assert.deepEqual(calls.find(c=>c.sql.startsWith('UPDATE memories')).args,['Do this',7]);
 client.query=async(sql)=>{calls.push({sql});return{rows:[]}};
 await assert.rejects(()=>decideAttention({connect:async()=>client},item.id,'active'),/not found/);assert.equal(calls.at(-1).sql,'ROLLBACK');
});
test('invalid snooze fails before opening transaction',async()=>{
 await assert.rejects(()=>decideAttention({},'a'.repeat(64),'snoozed',0),/Snooze/);
});
test('project card links its source without overstating content verification',()=>{
 const [card]=buildAttentionCandidates({github:{projects:[{repository:'d/project',projectState:{nextActions:['Audit launch']},projectDoc:{path:'PROJECT_STATUS.md'},verifiedAt:'2026-10-03'}]}});
 assert.match(card.why,/Recorded/);assert.doesNotMatch(card.why,/Verified/);assert.match(card.url,/PROJECT_STATUS/);
});
test('IMAP discovers provider sent folder instead of assuming Sent',async()=>{
 let locked;
 const client=new EmailClient({user:'u',pass:'p',createClient:()=>({connect:async()=>{},list:async()=>[{path:'Sent Messages',specialUse:'\\Sent'}],getMailboxLock:async path=>{locked=path;return{release(){}}},search:async()=>[],logout:async()=>{}})});
 await client.listSent();assert.equal(locked,'Sent Messages');
});
