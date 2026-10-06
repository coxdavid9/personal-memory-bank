const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {CalDAVClient,buildVEvent}=require('../caldav');
const {executeAgentTool}=require('../agent-tools');
const event={title:'Robert Half Interview — David Cox',start:'2026-10-06T14:00:00-05:00',end:'2026-10-06T14:30:00-05:00',allDay:false,notes:null};
const xml=events=>'<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'+events.map(e=>'<d:response><d:propstat><d:prop><c:calendar-data>'+e.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>').join('')+'</d:multistatus>';
function setup(events=[]){
 const writes=[]; const reports=[]; const saved=[...events];
 const client=new CalDAVClient({baseUrl:'https://cal.example/',username:'u',password:'p',calendarName:'David Cox',calendarUrl:'https://cal.example/cal/',fetchImpl:async(url,options)=>{
  if(options.method==='REPORT'){reports.push(options.body);return new Response(xml(saved),{status:207});}
  writes.push({url,body:options.body,headers:options.headers});
  saved.push(options.body);return new Response(null,{status:201});
 }});
 return {client,writes,reports};
}
test('existing legacy event is preserved, including its meeting link',async()=>{
 const s=setup([buildVEvent({...event,title:' Robert Half Interview - David Cox ',uid:'legacy@personal-agent',notes:'Join meeting: https://teams.microsoft.com/meet/123'})]);
 const result=await s.client.createCalDAVEvent(event);
 assert.equal(result.alreadyExists,true);assert.equal(result.uid,'legacy@personal-agent');assert.equal(s.writes.length,0);
 assert.match(s.reports[0],/start="20261006T185959Z"/);
});
test('repeated requests write once, while different start times or titles remain distinct',async()=>{
 const s=setup();
 assert.equal((await s.client.createCalDAVEvent(event)).alreadyExists,false);
 assert.equal((await s.client.createCalDAVEvent({...event,start:'2026-10-06T19:00:00Z'})).alreadyExists,true);
 await s.client.createCalDAVEvent({...event,start:'2026-10-06T15:00:00-05:00',end:'2026-10-06T15:30:00-05:00'});
 await s.client.createCalDAVEvent({...event,title:'Different interview'});
 assert.equal(s.writes.length,3);
 assert.equal(s.writes[0].headers['If-None-Match'],'*');
});
test('escaped titles and timezone-qualified starts match the same event',async()=>{
 const s=setup(['BEGIN:VEVENT\nUID:legacy\nSUMMARY:Review\\, budget\nDTSTART;TZID=America/Chicago:20261006T140000\nEND:VEVENT']);
 assert.equal((await s.client.createCalDAVEvent({...event,title:'Review, budget'})).alreadyExists,true);
 assert.equal(s.writes.length,0);
});
test('all-day events match only the same all-day date',async()=>{
 const s=setup();
 const allDay={...event,title:'Holiday',start:'2026-12-25T00:00:00Z',end:'2026-12-26T00:00:00Z',allDay:true};
 await s.client.createCalDAVEvent(allDay);
 assert.equal((await s.client.createCalDAVEvent(allDay)).alreadyExists,true);
 await s.client.createCalDAVEvent({...allDay,end:'2026-12-25T00:01:00Z',allDay:false});
 assert.equal(s.writes.length,2);
});
test('conditional writes resolve concurrent callers to one stored event',async()=>{
 const saved=[];const urls=[];let reports=0;
 const client=new CalDAVClient({baseUrl:'https://cal.example/',username:'u',password:'p',calendarUrl:'https://cal.example/cal/',fetchImpl:async(url,o)=>{
  if(o.method==='REPORT'){reports++;return new Response(xml(reports<=2?[]:saved),{status:207});}
  urls.push(url);if(saved.length)return new Response(null,{status:412});saved.push(o.body);return new Response(null,{status:201});
 }});
 const results=await Promise.all([client.createCalDAVEvent(event),client.createCalDAVEvent(event)]);
 assert.equal(saved.length,1);assert.equal(urls[0],urls[1]);assert.equal(results.filter(r=>r.alreadyExists).length,1);
});
test('failed or malformed duplicate reads never attempt a write',async()=>{
 for(const response of [()=>new Response('failed',{status:503}),()=>new Response('not XML',{status:207})]){
  let puts=0;
  const client=new CalDAVClient({baseUrl:'https://cal.example/',username:'u',password:'p',calendarUrl:'https://cal.example/cal/',fetchImpl:async(_u,o)=>{if(o.method==='PUT')puts++;return response();}});
  await assert.rejects(client.createCalDAVEvent(event));assert.equal(puts,0);
 }
});
test('unverifiable conflicts and uncertain saves do not offer duplicate-prone fallback actions',async()=>{
 let actions=0;
 const result=await executeAgentTool('create_calendar_event',event,{skipPolicy:true,onAction:()=>actions++,caldav:{isConfigured:()=>true,createCalDAVEvent:async()=>{throw new Error('timeout after write');}}});
 assert.equal(result.ok,false);assert.equal(actions,0);assert.match(result.error,/before retrying/);
 const client=new CalDAVClient({baseUrl:'https://cal.example/',username:'u',password:'p',calendarUrl:'https://cal.example/cal/',fetchImpl:async(_u,o)=>new Response(o.method==='REPORT'?xml([]):null,{status:o.method==='REPORT'?207:412})});
 await assert.rejects(client.createCalDAVEvent(event),/could not be verified/);
});
test('already-existing result is visible without claiming another creation',async()=>{
 const actions=[];
 const result=await executeAgentTool('create_calendar_event',event,{skipPolicy:true,onAction:a=>actions.push(a),caldav:{isConfigured:()=>true,createCalDAVEvent:async()=>({alreadyExists:true,uid:'legacy',calendarName:'David Cox'})}});
 assert.equal(result.alreadyExists,true);assert.equal(actions[0].alreadyExists,true);
 const html=fs.readFileSync(require('node:path').join(__dirname,'../public/index.html'),'utf8');
 const fn=html.match(/function approvalResultMessage\([^\n]+/)[0];
 const sandbox={};vm.runInNewContext(fn,sandbox);
 assert.match(sandbox.approvalResultMessage('approve',result),/No duplicate/);
 assert.match(sandbox.approvalResultMessage('approve',{ok:false,error:'Uncertain'}),/failed: Uncertain/);
 assert.match(html,/Already on calendar — no duplicate created/);
});
