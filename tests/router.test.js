const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inferJob, buildAgentTools } = require('../agent-tools');

test('router sends calendar requests to calendar skills only', () => {
  assert.equal(inferJob('Put a dentist appointment on my calendar'), 'calendar');
  const names = buildAgentTools({ job: 'calendar' }).map(tool => tool.name);
  assert.deepEqual(names, ['test_connections','save_memory','get_personal_context','get_calendar_events','email_search','email_read','create_calendar_event','reschedule_calendar_event']);
});


test('router tolerates calendar misspellings and explicit event creation language', () => {
  assert.equal(inferJob('Make a test event on my caleder for 30 minutes at 8pm tonight'), 'calendar');
  assert.equal(inferJob('Create an event for 8pm tonight'), 'calendar');
  const job = inferJob('Make a test event on my caleder for 30 minutes at 8pm tonight');
  assert.ok(buildAgentTools({job,enabledCapabilities:['calendar']}).some(t=>t.name==='create_calendar_event'));
});

test('router sends portfolio requests to portfolio skills', () => {
  assert.equal(inferJob('How is my Fidelity portfolio doing?'), 'portfolio');
  const names = buildAgentTools({ job: 'portfolio' }).map(tool => tool.name);
  assert.deepEqual(names, ['save_memory','get_personal_context','get_portfolio_summary','record_holding','delete_holding']);
});

test('router keeps engineering tools out of normal chat', () => {
  assert.equal(inferJob('What do you know about ClearCFO?'), 'general');
  const names = buildAgentTools({ job: 'general' }).map(tool => tool.name);
  assert.ok(!names.includes('github_repo_status'));
  assert.ok(!names.includes('github_create_pr'));
  assert.ok(names.includes('delegate_to_team'));
});


test('image input validation accepts supported data URLs and rejects unsafe input', () => {
  const { validateImageDataUrl } = require('../agent-tools');
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(validateImageDataUrl(image), image);
  assert.throws(() => validateImageDataUrl('https://example.com/image.png'), /Unsupported image/);
  assert.throws(() => validateImageDataUrl('data:text/plain;base64,SGk='), /Unsupported image/);
});

const calendarHistory=[
 {role:'user',content:'Add a meeting at 9am tomorrow for 30 minutes'},
 {role:'assistant',content:'What should I title the 30-minute meeting at 9:00 AM tomorrow?'}
];
test('interview duration replies retain calendar creation across clarification turns',()=>{
 const history=[
  {role:'user',content:'Add my Robert Half interview to my Yahoo calendar today at 2pm'},
  {role:'assistant',content:'What duration should I use for the interview?'}
 ];
 assert.equal(inferJob(history[0].content),'calendar');
 const job=inferJob('30 minutes',false,history);
 assert.equal(job,'calendar');
 assert.ok(buildAgentTools({job,enabledCapabilities:['calendar']}).some(t=>t.name==='create_calendar_event'));
 const next=[...history,{role:'user',content:'30 minutes'},{role:'assistant',content:'Where is the interview location?'}];
 assert.equal(inferJob('Phone',false,next),'calendar');
 assert.ok(!buildAgentTools({job,enabledCapabilities:[]}).some(t=>t.name==='create_calendar_event'));
 assert.equal(inferJob('Show my unread email',false,next),'email');
 assert.equal(inferJob('Fix the code',false,next),'engineering');
 assert.equal(inferJob('Phone',true,next),'excel_analysis');
});
test('job and email interview clarifications keep their original tools',()=>{
 for(const [request,expected] of [['I have an interview with Robert Half today at 2pm','job_search'],['Check Yahoo for my interview details','communications']]){
  const history=[{role:'user',content:request},{role:'assistant',content:'What duration should I use for the interview?'}];
  const job=inferJob('30 minutes',false,history);
  assert.equal(job,expected);
  assert.ok(buildAgentTools({job,enabledCapabilities:['calendar','job-search','email']}).some(t=>t.name==='create_calendar_event'));
 }
 assert.equal(inferJob('30 minutes',false,[{role:'user',content:'Test my repository'},{role:'assistant',content:'What duration should I use for the interview?'}]),'general');
});
test('short calendar title replies preserve calendar tools through the real policy path',async()=>{
 const {executeAgentTool}=require('../agent-tools');
 for(const reply of ['Test','Budget review','Lunch with Ashley']) {
  const job=inferJob(reply,false,calendarHistory);
  assert.equal(job,'calendar');
  assert.ok(buildAgentTools({job,enabledCapabilities:['calendar']}).some(t=>t.name==='create_calendar_event'));
 }
 let wrote=false;
 const args={title:'Test',start:'2026-10-01T09:00:00-05:00',end:'2026-10-01T09:30:00-05:00',notes:null,location:null,allDay:false};
 const pool={query:async sql=>({rows:sql.includes('INSERT INTO tool_approvals')?[{id:123,expiresAt:new Date(Date.now()+120000)}]:[]})};
 const result=await executeAgentTool('create_calendar_event',args,{pool,caldav:{isConfigured:()=>true,createCalDAVEvent:async()=>{wrote=true;}}});
 assert.equal(result.approvalRequired,true);
 assert.equal(wrote,false);
 assert.ok(!buildAgentTools({job:'calendar',enabledCapabilities:[]}).some(t=>t.name==='create_calendar_event'));
});
test('standalone Test and explicit topic changes do not inherit calendar tools',()=>{
 assert.equal(inferJob('Test'),'engineering');
 assert.equal(inferJob('Test my repository',false,calendarHistory),'engineering');
 assert.equal(inferJob('Show my unread email',false,calendarHistory),'email');
 assert.equal(inferJob('Fix the code',false,calendarHistory),'engineering');
 assert.equal(inferJob('Test',true,calendarHistory),'excel_analysis');
});
test('calendar followup inheritance requires the immediately preceding clarification',()=>{
 assert.equal(inferJob('Test',false,[...calendarHistory,{role:'user',content:'Thanks'},{role:'assistant',content:'You are welcome.'}]),'engineering');
 assert.equal(inferJob('Test',false,[{role:'user',content:'Test my repository'},{role:'assistant',content:'What should the meeting title be?'}]),'engineering');
});
test('server supplies recent chat history to the router',()=>{
 const fs=require('fs'),path=require('path');
 assert.match(fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8'),/inferJob\(message, excelFiles\.length > 0, recent\)/);
});

test('mobile shell prevents horizontal page overflow',()=>{
 const fs=require('fs'),path=require('path');
 const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
 assert.match(html,/overflow-x:hidden/);
 assert.match(html,/overflow-wrap:anywhere/);
 assert.match(html,/\.composer input\{flex:1;min-width:0\}/);
});

test('work calendar questions route to live calendar reads',()=>{assert.equal(inferJob("what's on my work calendar today?",false,[]),'calendar_read');assert.equal(inferJob('whats on my work calendar today?',false,[]),'calendar_read');});


test('mobile composer is viewport-bounded without centered transform drift',()=>{const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');assert.match(html,/@media\(max-width:800px\)\{\.composer\{left:10px;right:10px;transform:none;width:auto/);});


test('priority questions use the full attention route instead of job search',()=>{assert.equal(inferJob('What should I be working on right now?'),'attention');assert.equal(inferJob('What do I need to know today?'),'attention');assert.equal(inferJob('not just jobs, everything'),'attention');const names=buildAgentTools({job:'attention'}).map(x=>x.name);for(const name of ['email_search','gmail_search','get_calendar_events','get_job_application_history','get_portfolio_summary','get_workflows'])assert.ok(names.includes(name),name);});

test('Yahoo event verification uses read tools rather than email or calendar writes',()=>{
 for (const request of [
  'Check my Yahoo calendar for "Jarvis reminder test" today at 12:07 PM CDT. Report whether it actually exists and its calendar name. Do not create another event.',
  "What's on my Yahoo calendar today?",
  'Verify the Robert Half interview exists in my Yahoo calendar',
  'Search my calendar for Jarvis reminder test. Do not create another calendar event.'
 ]) {
  const job=inferJob(request);
  assert.equal(job,'calendar_read',request);
  const tools=buildAgentTools({job,enabledCapabilities:['calendar']}).map(t=>t.name);
  assert.ok(tools.includes('get_calendar_events'));
  assert.ok(!tools.includes('create_calendar_event'));
  assert.ok(!tools.includes('email_search'));
 }
 assert.equal(inferJob('Check Yahoo for my interview details'),'communications');
 assert.equal(inferJob('Check my email and calendar'),'communications');
 assert.equal(inferJob('Add the Robert Half interview to my Yahoo calendar'),'calendar');
 assert.equal(inferJob('Check my Yahoo calendar and add a meeting to my calendar'),'calendar');
 assert.ok(!buildAgentTools({job:'calendar_read',enabledCapabilities:[]}).some(t=>t.name==='get_calendar_events'));
});

test('calendar verification reads recent personal events and reports the calendar name without writes',async()=>{
 const {executeAgentTool}=require('../agent-tools');
 const result=await executeAgentTool('get_calendar_events',{days:1},{skipPolicy:true,caldav:{
  isConfigured:()=>true,calendarName:'David Cox',
  listUpcomingEvents:async options=>{
   assert.deepEqual(options,{days:1,lookbackHours:24});
   return [{title:'Jarvis reminder test',start:'2026-10-06T17:07:00Z'}];
  },
  createCalDAVEvent:()=>{throw new Error('must not write');}
 }});
 assert.equal(result.personalCalendarName,'David Cox');
 assert.equal(result.personalCalendar[0].title,'Jarvis reminder test');
});

