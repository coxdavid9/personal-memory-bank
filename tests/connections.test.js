const test=require('node:test');
const assert=require('node:assert/strict');
const {CalDAVClient}=require('../caldav');
const {EmailClient}=require('../email');
const {executeAgentTool,buildAgentTools}=require('../agent-tools');
const {classifySkill}=require('../policy');
test('iCloud rejects bad credentials without treating them as an empty calendar',async()=>{
 const c=new CalDAVClient({baseUrl:'https://cal.example.test/',username:'u',password:'secret-value',fetchImpl:async()=>new Response('',{status:401})});
 assert.equal((await c.testConnection()).status,'authentication_failed');
 await assert.rejects(c.listUpcomingEvents(),/discovery failed/);
 assert.ok(!JSON.stringify(await c.testConnection()).includes('secret-value'));
});
test('explicit calendar URL still verifies authentication using REPORT',async()=>{
 let method;
 const c=new CalDAVClient({baseUrl:'https://cal.example.test/',username:'u',password:'p',calendarUrl:'https://cal.example.test/cal/',fetchImpl:async(_url,options)=>{method=options.method;return new Response('',{status:403});}});
 assert.equal((await c.testConnection()).connected,false);
 assert.equal(method,'REPORT');
});
test('empty reachable calendar is a successful connection',async()=>{
 const c=new CalDAVClient({baseUrl:'https://cal.example.test/',username:'u',password:'p',calendarUrl:'https://cal.example.test/cal/',fetchImpl:async()=>new Response('<multistatus/>',{status:207})});
 assert.equal((await c.testConnection()).status,'connected');
});
test('Yahoo authentication failure is sanitized and closes failed connection',async()=>{
 let closed=false;
 const c=new EmailClient({user:'u',pass:'secret-value',createClient:()=>({connect:async()=>{throw Object.assign(new Error('secret-value'),{authenticationFailed:true});},logout:async()=>{throw new Error('offline');},close:()=>{closed=true;}})});
 const result=await c.testConnection();
 assert.equal(result.status,'authentication_failed');
 assert.equal(closed,true);
 assert.ok(!JSON.stringify(result).includes('secret-value'));
});
test('Yahoo connection test opens INBOX without reading messages and releases it',async()=>{
 let released=false,logout=false;
 const c=new EmailClient({user:'u',pass:'p',createClient:()=>({connect:async()=>{},getMailboxLock:async name=>{assert.equal(name,'INBOX');return{release:()=>{released=true;}};},logout:async()=>{logout=true;}})});
 assert.equal((await c.testConnection()).connected,true);
 assert.ok(released&&logout);
});
test('mailbox lock failure still logs out',async()=>{
 let logout=false;
 const c=new EmailClient({user:'u',pass:'p',createClient:()=>({connect:async()=>{},getMailboxLock:async()=>{throw new Error('unavailable');},logout:async()=>{logout=true;}})});
 assert.equal((await c.testConnection()).status,'connection_failed');
 assert.ok(logout);
});
test('diagnostics run through policy and report both missing connections',async()=>{
 assert.equal(classifySkill('test_connections',{}).tier,'safe');
 const result=await executeAgentTool('test_connections',{}, {});
 assert.equal(result.yahoo.status,'not_configured');
 assert.equal(result.calendar.status,'not_configured');
 for(const job of ['general','email','calendar','calendar_read','communications']) assert.ok(buildAgentTools({job}).some(t=>t.name==='test_connections'));
 assert.ok(!buildAgentTools({job:'calendar_read',enabledCapabilities:[]}).some(t=>t.name==='get_calendar_events'));
});
