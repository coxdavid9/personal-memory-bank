const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
function setup(api=async()=>({approvals:[],decided:[]})) {
  const elements={approvals:{innerHTML:''}};
  const state=html.match(/let approvalStateLoaded=[^\n]+\nlet approvalLoadVersion=[^\n]+/)[0];
  const functions=html.slice(html.indexOf('function actionHtml('),html.indexOf('function icsEscape'));
  const context=vm.createContext({api,document:{getElementById:id=>elements[id]},renderMessages:()=>{},calendarActionHtml:()=>'',esc:String,Date,console});
  vm.runInContext(state+'\n'+functions,context);
  return {context,elements,run:source=>vm.runInContext(source,context)};
}
const action={type:'tool.approval',skill:'record_interview',approvalId:11,expiresAt:new Date(Date.now()+60000).toISOString()};
test('unknown approval status never claims a decision or presents unverified buttons',()=>{
  const s=setup();
  s.run('approvalStateLoaded=true');
  s.context.action=action;
  const result=s.run('actionHtml(action)');
  assert.match(result,/Approval status unavailable/);assert.match(result,/Refresh approval status/);
  assert.doesNotMatch(result,/Already decided|>Approve</);
});
test('confirmed pending approval renders buttons; confirmed outcomes have exact labels',async()=>{
  const s=setup(async()=>({approvals:[{id:11,skill:'record_interview',expiresAt:action.expiresAt}],decided:[]}));
  s.context.action=action;
  await s.run('loadApprovals()');
  assert.match(s.run('actionHtml(action)'),/>Approve</);
  for(const [status,label] of [['approved','Approved'],['denied','Denied'],['expired','Expired — no decision made']]) {
    s.context.api=async()=>({approvals:[],decided:[{id:11,status}]});
    await s.run('loadApprovals()');assert.ok(s.run('actionHtml(action)').includes(label));
  }
});
test('a refresh failure disables actions without inventing a decision and recovers',async()=>{
  const s=setup(async()=>({approvals:[{id:11,skill:'record_interview',expiresAt:action.expiresAt}],decided:[]}));
  s.context.action=action;
  await s.run('loadApprovals()');
  s.context.api=async()=>{throw new Error('Offline');};
  await s.run('loadApprovals()');
  assert.match(s.run('actionHtml(action)'),/Unable to verify approval status/);
  assert.doesNotMatch(s.run('actionHtml(action)'),/>Approve</);
  s.context.api=async()=>({approvals:[{id:11,skill:'record_interview',expiresAt:action.expiresAt}],decided:[]});
  await s.run('loadApprovals()');assert.match(s.run('actionHtml(action)'),/>Approve</);
});
test('a malformed or redirected response is unavailable rather than a decision',async()=>{
  const s=setup(async()=>({}));s.context.action=action;
  await s.run('loadApprovals()');
  assert.match(s.run('actionHtml(action)'),/Unable to verify approval status/);
  assert.doesNotMatch(s.run('actionHtml(action)'),/Already decided|>Approve</);
});
test('slower stale response cannot overwrite a newer approval refresh',async()=>{
  const requests=[];
  const s=setup(()=>new Promise(resolve=>requests.push(resolve)));s.context.action=action;
  const first=s.run('loadApprovals()'),second=s.run('loadApprovals()');
  requests[1]({approvals:[{id:11,skill:'record_interview',expiresAt:action.expiresAt}],decided:[]});await second;
  requests[0]({approvals:[],decided:[]});await first;
  assert.match(s.run('actionHtml(action)'),/>Approve</);
});
test('slower failed response cannot erase a newer successful refresh',async()=>{
  const requests=[];
  const s=setup(()=>new Promise((resolve,reject)=>requests.push({resolve,reject})));s.context.action=action;
  const first=s.run('loadApprovals()'),second=s.run('loadApprovals()');
  requests[1].resolve({approvals:[{id:11,skill:'record_interview',expiresAt:action.expiresAt}],decided:[]});await second;
  requests[0].reject(new Error('Old request failed'));await first;
  assert.match(s.run('actionHtml(action)'),/>Approve</);
});
test('expired pending cache renders expiration without buttons',async()=>{
  const old={...action,expiresAt:new Date(Date.now()-1000).toISOString()};
  const s=setup(async()=>({approvals:[{id:11,skill:'record_interview',expiresAt:old.expiresAt}],decided:[]}));s.context.action=old;
  await s.run('loadApprovals()');
  assert.match(s.run('actionHtml(action)'),/Expired — no decision made/);
  assert.doesNotMatch(s.run('actionHtml(action)'),/>Approve</);
});
