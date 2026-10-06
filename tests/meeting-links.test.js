const test=require('node:test');
const assert=require('node:assert/strict');
const {meetingJoinLinks}=require('../meeting-links');
const {executeAgentTool,buildAgentTools}=require('../agent-tools');
const {buildVEvent}=require('../caldav');
const link='https://teams.microsoft.com/l/meetup-join/19%3ameeting_test/0?context=%7B%22Tid%22%3A%22test%22%7D';
const event={title:'Interview',start:'2026-10-07T14:00:00-05:00',end:'2026-10-07T14:30:00-05:00',notes:'Invitation from recruiter',location:null,allDay:false,source_email_uid:42};
function setup(body){let approved,written,reads=0;const pool={query:async(sql,params)=>{if(sql.includes('INSERT INTO tool_approvals')){approved=JSON.parse(params[2]);return {rows:[{id:1,expiresAt:new Date(Date.now()+120000)}]};}return {rows:[]};}};const deps={pool,emailClients:{yahoo:{isConfigured:()=>true,read:async()=>{reads++;return {body};}}},caldav:{isConfigured:()=>true,createCalDAVEvent:async a=>{written=a;}}};return {deps,get approved(){return approved;},get written(){return written;},get reads(){return reads;}};}
test('copies recognized links exactly, deduplicates, and excludes unrelated or lookalike hosts',()=>{
 assert.deepEqual(meetingJoinLinks('Join '+link+'\n'+link),[link]);
 assert.deepEqual(meetingJoinLinks('https://teams.microsoft.com.evil.example/l/meetup-join/test https://example.com/privacy https://user@teams.microsoft.com/l/meetup-join/test'),[]);
 assert.deepEqual(meetingJoinLinks('https://us02web.zoom.us/j/123?pwd=abc https://meet.google.com/abc-defg-hij'),['https://us02web.zoom.us/j/123?pwd=abc','https://meet.google.com/abc-defg-hij']);
});
test('source link is approved before writing and survives CalDAV and handoff delivery',async()=>{
 const s=setup('Join '+link);const result=await executeAgentTool('create_calendar_event',event,s.deps);
 assert.equal(result.approvalRequired,true);assert.equal(s.written,undefined);assert.ok(s.approved.notes.includes(link));assert.equal(s.approved.source_email_uid,null);
 await executeAgentTool('create_calendar_event',s.approved,{...s.deps,skipPolicy:true});
 assert.equal(s.reads,1);assert.ok(s.written.notes.includes(link));
 assert.ok(buildVEvent({...s.written,uid:'test'}).includes(link));
 const fallback=await executeAgentTool('create_calendar_event',s.approved,{skipPolicy:true});
 assert.ok(fallback.action.notes.includes(link));assert.equal(fallback.delivery,'pwa_ics_or_native_client');
});
test('missing links are disclosed and ambiguous links require clarification',async()=>{
 const absent=setup('A phone interview; no link');await executeAgentTool('create_calendar_event',event,absent.deps);
 assert.match(absent.approved.notes,/No meeting join link found/);
 const ambiguous=setup(link+' https://meet.google.com/abc-defg-hij');const result=await executeAgentTool('create_calendar_event',event,ambiguous.deps);
 assert.equal(result.ok,false);assert.equal(ambiguous.approved,undefined);assert.equal(ambiguous.written,undefined);
});
test('failed invitation read cannot prepare an event and calendar route honors email capability',async()=>{
 const result=await executeAgentTool('create_calendar_event',event,{pool:{query:async()=>({rows:[]})}});
 assert.equal(result.ok,false);
 const names=buildAgentTools({job:'calendar',enabledCapabilities:['calendar','email']}).map(t=>t.name);
 assert.ok(names.includes('email_search'));assert.ok(names.includes('email_read'));
 assert.ok(!buildAgentTools({job:'calendar',enabledCapabilities:['calendar']}).some(t=>t.name==='email_read'));
});
