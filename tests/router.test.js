const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inferJob, buildAgentTools } = require('../agent-tools');

test('router sends calendar requests to calendar skills only', () => {
  assert.equal(inferJob('Put a dentist appointment on my calendar'), 'calendar');
  const names = buildAgentTools({ job: 'calendar' }).map(tool => tool.name);
  assert.deepEqual(names, ['test_connections','save_memory','get_personal_context','create_calendar_event']);
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
