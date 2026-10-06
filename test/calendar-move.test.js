const test=require('node:test'),assert=require('node:assert/strict');
const {CalDAVClient,buildVEvent}=require('../caldav');
const {executeAgentTool,inferJob,buildAgentTools}=require('../agent-tools');
const {classifySkill}=require('../policy');
const args={title:'Jarvis reminder test',current_start:'2026-10-06T12:07:00-05:00',start:'2026-10-06T12:50:00-05:00',end:'2026-10-06T12:51:00-05:00'};
const event={title:args.title,start:args.current_start,end:'2026-10-06T12:08:00-05:00',uid:'old@personal-agent',notes:'Join https://teams.microsoft.com/meet/123'};
const xml=(ics,href='/cal/old.ics',etag='"v1"')=>'<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'+(ics?'<d:response><d:href>'+href+'</d:href><d:propstat><d:prop><d:getetag>'+etag.replace(/"/g,'&quot;')+'</d:getetag><c:calendar-data>'+ics.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</c:calendar-data></d:prop></d:propstat></d:response>':'')+'</d:multistatus>';
function setup({ics=buildVEvent(event),href='/cal/old.ics',etag='"v1"',status=204,duplicate=false}={}){
 const calls=[];let reports=0;
 const client=new CalDAVClient({baseUrl:'https://cal.example/',username:'u',password:'p',calendarUrl:'https://cal.example/cal/',fetchImpl:async(url,o)=>{
  calls.push({url,...o});if(o.method==='REPORT'){reports++;return new Response(xml(reports===1||duplicate?ics:'',href,etag),{status:207});}
  return new Response(null,{status});
 }});
 return {client,calls};
}
test('delete-and-recreate followup exposes approved rescheduling and live calendar reads',()=>{
 for(const text of ['can you delete the 12:07 event and create a new one for 12:50?','Move the event to 12:50','Reschedule the calendar event','Check my Yahoo calendar and move the event to 12:50']){
  const job=inferJob(text);assert.equal(job,'calendar');
  const names=buildAgentTools({job,enabledCapabilities:['calendar']}).map(t=>t.name);
  assert.ok(names.includes('reschedule_calendar_event'));assert.ok(names.includes('get_calendar_events'));
 }
 assert.equal(inferJob('Check my Yahoo calendar. Do not move the event.'),'calendar_read');
 assert.equal(inferJob('Move it to 12:50',false,[{role:'assistant',content:'The calendar event is at 12:07.'}]),'calendar');
 assert.ok(!buildAgentTools({job:'calendar',enabledCapabilities:[]}).some(t=>t.name==='reschedule_calendar_event'));
 assert.equal(classifySkill('reschedule_calendar_event',args).tier,'ask');
});
test('rescheduling requires approval before writing and reports a moved existing event',async()=>{
 let writes=0;
 const deps={pool:{query:async sql=>({rows:sql.includes('INSERT INTO tool_approvals')?[{id:1,expiresAt:new Date(Date.now()+120000)}]:[]})},caldav:{isConfigured:()=>true,rescheduleCalDAVEvent:async()=>{writes++;return {title:args.title,start:args.start,end:args.end,rescheduled:true};}}};
 const pending=await executeAgentTool('reschedule_calendar_event',args,deps);
 assert.equal(pending.approvalRequired,true);assert.equal(writes,0);
 const actions=[];const result=await executeAgentTool('reschedule_calendar_event',args,{...deps,skipPolicy:true,onAction:a=>actions.push(a)});
 assert.equal(writes,1);assert.equal(result.rescheduled,true);assert.equal(actions[0].rescheduled,true);
});
test('moves the same resource and preserves UID, notes, creation time and alarm',async()=>{
 const ics=buildVEvent(event).replace('END:VEVENT','BEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT');
 const s=setup({ics});const result=await s.client.rescheduleCalDAVEvent(args);
 assert.equal(result.uid,event.uid);assert.equal(result.rescheduled,true);
 const puts=s.calls.filter(c=>c.method==='PUT');assert.equal(puts.length,1);
 assert.equal(puts[0].url,'https://cal.example/cal/old.ics');assert.equal(puts[0].headers['If-Match'],'"v1"');
 assert.match(puts[0].body,/DTSTART:20261006T175000Z/);assert.match(puts[0].body,/DTEND:20261006T175100Z/);
 for(const line of ics.split('\r\n').filter(l=>/^(UID|CREATED|DESCRIPTION|TRIGGER|ACTION):/.test(l)))assert.ok(puts[0].body.includes(line),line);
 assert.equal(s.calls.filter(c=>c.method==='DELETE').length,0);
});
test('missing, ambiguous, recurring and non-Jarvis events cannot be moved',async()=>{
 for(const ics of ['',buildVEvent({...event,uid:'someone-else'}),buildVEvent(event).replace('END:VEVENT','RRULE:FREQ=DAILY\r\nEND:VEVENT'),buildVEvent(event).replace('END:VEVENT','END:VEVENT\r\nBEGIN:VEVENT\r\nUID:second@personal-agent\r\nSUMMARY:Jarvis reminder test\r\nDTSTART:20261006T170700Z\r\nEND:VEVENT')]){
  const s=setup({ics});await assert.rejects(s.client.rescheduleCalDAVEvent(args));assert.equal(s.calls.filter(c=>c.method==='PUT').length,0);
 }
});
test('version checks and calendar boundaries prevent overwriting changed or unrelated events',async()=>{
 for(const options of [{etag:''},{href:'https://evil.example/stolen.ics'},{href:'/other/event.ics'}]){
  const s=setup(options);await assert.rejects(s.client.rescheduleCalDAVEvent(args));assert.equal(s.calls.filter(c=>c.method==='PUT').length,0);
 }
 const s=setup({status:412});await assert.rejects(s.client.rescheduleCalDAVEvent(args),/changed before/);
});
test('duplicate destination and failed writes produce no success action',async()=>{
 const collision=buildVEvent({...event,uid:'other@personal-agent',start:args.start,end:args.end});
 const s=setup({ics:collision,duplicate:true});
 // Supply the original event for the first read and the collision for the next.
 let n=0;s.client.listEvents=async()=>++n===1?[{...event,source:{href:'/cal/old.ics',etag:'"v1"',ics:buildVEvent(event)}}]:[{uid:'other@personal-agent',title:args.title,start:args.start}];
 await assert.rejects(s.client.rescheduleCalDAVEvent(args),/already exists/);assert.equal(s.calls.length,0);
 const actions=[];const failed=await executeAgentTool('reschedule_calendar_event',args,{skipPolicy:true,onAction:a=>actions.push(a),caldav:{isConfigured:()=>true,rescheduleCalDAVEvent:async()=>{throw new Error('The event changed');}}});
 assert.equal(failed.ok,false);assert.equal(actions.length,0);
});
