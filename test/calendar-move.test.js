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
 const deps={pool:{query:async sql=>({rows:sql.includes('INSERT INTO tool_approvals')?[{id:1,expiresAt:new Date(Date.now()+120000)}]:[]})},caldav:{isConfigured:()=>true,previewReschedule:async()=>({ok:true}),rescheduleCalDAVEvent:async()=>{writes++;return {title:args.title,start:args.start,end:args.end,rescheduled:true};}}};
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

test('named reminder retiming wins over competing title keywords',()=>{
 for(const request of [
  'Move today’s “Jarvis reminder test” from 12:07 PM to 30 minutes from now. Keep its one-minute duration.',
  'Move today\'s "Jarvis reminder test" from 12:07 PM to 30 minutes from now.',
  'Reschedule my interview reminder for tomorrow at 2 PM',
  'Move my reminder to 1:19 PM'
 ]){
  const job=inferJob(request);
  assert.equal(job,'calendar',request);
  const tools=buildAgentTools({job,enabledCapabilities:['calendar']}).map(t=>t.name);
  assert.ok(tools.includes('get_calendar_events'));
  assert.ok(tools.includes('reschedule_calendar_event'));
 }
 assert.equal(inferJob('Test my repository'),'engineering');
 assert.equal(inferJob('Move my workbook reminder to 2 PM',true),'excel_analysis');
 assert.equal(inferJob('Check my Yahoo calendar. Do not move my reminder to 2 PM.'),'calendar_read');
});

test('read-only preflight exposes the exact blocker before an impossible approval',async()=>{
 let approvals=0,puts=0;
 const client=setup({etag:''}).client;
 client.fetch=async(_u,o)=>{if(o.method==='PUT')puts++;return new Response(xml(buildVEvent(event),'/cal/old.ics',''),{status:207});};
 const result=await executeAgentTool('reschedule_calendar_event',args,{pool:{query:async sql=>{if(sql.includes('INSERT INTO tool_approvals'))approvals++;return {rows:[]};}},caldav:client});
 assert.equal(result.ok,false);assert.match(result.error,/safe version/);assert.equal(approvals,0);assert.equal(puts,0);
});
test('successful preflight does not perform any PUT or disclose raw calendar content',async()=>{
 const s=setup();const preview=await s.client.previewReschedule(args);
 assert.equal(preview.ok,true);assert.equal(preview.start,'2026-10-06T17:50:00.000Z');
 assert.equal(s.calls.filter(c=>c.method==='PUT').length,0);
 assert.ok(!JSON.stringify(preview).includes('BEGIN:VCALENDAR'));
});

test('reschedule restores final CRLF and folds UTF-8 lines without losing notes',async()=>{
 const notes='Join https://teams.microsoft.com/meet/123 '+ 'é📅'.repeat(80);
 const s=setup({ics:buildVEvent({...event,notes})});
 await s.client.rescheduleCalDAVEvent(args);
 const body=s.calls.find(c=>c.method==='PUT').body;
 assert.ok(body.endsWith('END:VCALENDAR\r\n'));
 assert.ok(body.split('\r\n').every(line=>Buffer.byteLength(line,'utf8')<=75));
 const unfolded=body.replace(/\r\n[ \t]/g,'');
 assert.ok(unfolded.includes('DESCRIPTION:'+notes+'\r\n'));
 assert.ok(unfolded.includes('UID:'+event.uid+'\r\n'));
});

test('rejected PUT reports status and an allowlisted condition without private response text',async()=>{
 const s=setup(); const fetch=s.client.fetch;
 const secret='private-calendar-title account-password';
 s.client.fetch=async(u,o)=>o.method==='PUT'?new Response('<d:error xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><c:valid-calendar-data/><d:responsedescription>'+secret+'</d:responsedescription></d:error>',{status:403}):fetch(u,o);
 const logs=[]; const original=console.error;console.error=(...values)=>logs.push(values);
 try {
  await assert.rejects(s.client.rescheduleCalDAVEvent(args),error=>{
   assert.match(error.message,/HTTP 403; valid-calendar-data/);
   assert.ok(!error.message.includes(secret));return true;
  });
 } finally {console.error=original;}
 assert.deepEqual(logs,[['CalDAV reschedule PUT rejected',{status:403,condition:'valid-calendar-data'}]]);
 assert.equal(s.calls.filter(c=>c.method==='DELETE').length,0);
});
