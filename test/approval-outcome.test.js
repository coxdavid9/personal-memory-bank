const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
function harness(execution){
 const records=[],audit=[],order=[];let handler;
 const approval={id:17,skill:'reschedule_calendar_event',args:{title:'Test'}};
 const sandbox={
  app:{post:(_path,fn)=>{handler=fn;}},
  pool:{query:async(_sql,params)=>{order.push('persist');records.push(params);return {rows:[]};}},
  getApproval:async()=>approval,decideApproval:async()=>({ok:true,approval:{...approval,status:'approved'}}),
  executeAgentTool:async(_name,_args,deps)=>{order.push('execute');if(execution instanceof Error)throw execution;if(execution?.action)deps.onAction(execution.action);return execution;},
  buildToolDeps:({actions})=>({onAction:a=>actions.push(a)}),auditToolCall:async(_pool,entry)=>audit.push(entry),console
 };
 vm.createContext(sandbox);
 vm.runInContext(source.slice(source.indexOf('async function recordApprovalDecision('),source.indexOf("app.post('/api/approvals/:id/decision'")),sandbox);
 vm.runInContext(source.slice(source.indexOf("app.post('/api/approvals/:id/decision'"),source.indexOf('const excelUpload')),sandbox);
 const response={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
 return {records,audit,order,response,run:()=>handler({params:{id:'17'},body:{decision:'approve'}},response)};
}
test('failed calendar execution survives sync and returns an error to older clients',async()=>{
 const h=harness({ok:false,error:'The calendar did not provide a safe version for updating this event.'});
 await h.run();assert.equal(h.response.statusCode,422);assert.equal(h.response.body.ok,false);
 assert.match(h.response.body.error,/safe version/);
 assert.deepEqual(h.order,['execute','persist']);
 assert.match(h.records[0][1],/action failed:.*safe version/);
 assert.deepEqual(JSON.parse(h.records[0][2]),[]);
 assert.equal(h.audit[0].decision,'approved_execute_failed');assert.match(h.audit[0].error,/safe version/);
});
test('unexpected execution exception is recorded as a failed action',async()=>{
 const h=harness(new Error('Calendar unreachable'));await h.run();
 assert.equal(h.response.statusCode,422);assert.match(h.records[0][1],/failed: Calendar unreachable/);
});
test('successful moves retain their actual action card in durable chat history',async()=>{
 const action={type:'calendar.create_event',rescheduled:true,title:'Test',start:'2026-10-06T18:30:00Z'};
 const h=harness({ok:true,rescheduled:true,action});await h.run();
 assert.equal(h.response.statusCode,200);assert.match(h.records[0][1],/existing calendar event was moved/);
 assert.deepEqual(JSON.parse(h.records[0][2]),[action]);
});
