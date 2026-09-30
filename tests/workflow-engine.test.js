const test=require('node:test');
const assert=require('node:assert/strict');
const {planSteps,chicagoMorning,timestamp,stepMessage,INVALIDATES}=require('../workflow-engine');
const {inferJob,buildAgentTools,executeAgentTool}=require('../agent-tools');
const {classifySkill,TIERS}=require('../policy');
test('Chicago morning respects summer, winter, and DST transition dates',()=>{
  for(const [start,morning] of [
    ['2026-09-30T14:00:00-05:00','2026-09-30T12:00:00.000Z'],
    ['2026-12-10T14:00:00-06:00','2026-12-10T13:00:00.000Z'],
    ['2027-03-14T14:00:00-05:00','2027-03-14T12:00:00.000Z'],
    ['2026-11-01T14:00:00-06:00','2026-11-01T13:00:00.000Z']
  ]) assert.equal(chicagoMorning(new Date(start)).toISOString(),morning);
});
test('scheduled interview gets prep, morning, 30-minute reminder, and debrief',()=>{
  const steps=planSteps('INTERVIEW_UPDATED',{status:'scheduled',start:'2026-10-01T14:00:00-05:00'},new Date('2026-09-30T18:00:00Z'));
  assert.deepEqual(steps.map(x=>x.kind),['interview_prep','interview_morning','interview_reminder','interview_debrief']);
  assert.equal(steps[2].due_at,'2026-10-01T18:30:00.000Z');
  assert.equal(steps[3].due_at,'2026-10-01T21:00:00.000Z');
});
test('near-term interviews skip already-passed morning and 30-minute reminders',()=>{
  assert.deepEqual(planSteps('INTERVIEW_UPDATED',{status:'scheduled',start:'2026-09-30T14:00:00-05:00'},new Date('2026-09-30T18:50:00Z')).map(x=>x.kind),['interview_prep','interview_debrief']);
  assert.throws(()=>planSteps('INTERVIEW_UPDATED',{status:'scheduled',start:'2026-09-30T14:00:00-05:00'},new Date('2026-09-30T20:00:00Z')),/future/);
});
test('followup uses explicit response promise or 7 days from recorded completion',()=>{
  const now=new Date('2026-09-30T18:00:00Z');
  assert.equal(planSteps('INTERVIEW_UPDATED',{status:'completed'},now)[0].due_at,'2026-10-07T18:00:00.000Z');
  assert.equal(planSteps('INTERVIEW_UPDATED',{status:'completed',expected_response_at:'2026-10-05T09:00:00-05:00'},now)[0].due_at,'2026-10-05T14:00:00.000Z');
  assert.deepEqual(planSteps('INTERVIEW_UPDATED',{status:'cancelled'},now),[]);
  assert.deepEqual(planSteps('INTERVIEW_UPDATED',{status:'response_received'},now),[]);
});
test('timestamps must have an offset; reminders do not claim inbox knowledge',()=>{
  assert.throws(()=>timestamp('2026-10-01T14:00:00','Start'),/explicit timezone/);
  assert.throws(()=>timestamp('garbage','Start'),/ISO/);
  assert.equal(timestamp('2026-10-01T14:00:00-05:00','Start'),'2026-10-01T19:00:00.000Z');
  const text=stepMessage({kind:'interview_followup'},{title:'Controller',company:'Canteen'});
  assert.match(text,/not verified whether a reply/);assert.match(text,/Draft:/);
});
test('interview routing, capability toggles, and policies preserve approvals',()=>{
  assert.equal(inferJob('I have an interview with Nestle Thursday at 2'),'job_search');
  assert.equal(inferJob('Check Yahoo for a response to my interview'),'communications');
  const names=buildAgentTools({job:'job_search'}).map(t=>t.name);
  assert.ok(names.includes('record_interview'));assert.ok(names.includes('get_workflows'));
  assert.ok(!buildAgentTools({job:'job_search',enabledCapabilities:['memory']}).some(t=>t.name==='record_interview'));
  assert.equal(classifySkill('record_interview').tier,TIERS.ASK);
  assert.equal(classifySkill('deliver_workflow_message').tier,TIERS.MONITOR);
  assert.ok(INVALIDATES.INTERVIEW_UPDATED.includes('[Workflow application:<application_id>]'));
});
test('interview write does not execute before approval',async()=>{
  let called=false;
  const pool={query:async sql=>{
    if(/INSERT INTO tool_approvals/.test(sql))return {rows:[{id:123,expiresAt:new Date(Date.now()+120000)}]};
    return {rows:[]};
  }};
  const result=await executeAgentTool('record_interview',{application_id:1,status:'scheduled'},{
    pool,recordInterview:async()=>{called=true;return {ok:true};}
  });
  assert.equal(result.approvalRequired,true);assert.equal(called,false);
});
test('public chat cannot directly deliver scheduler messages',async()=>{
  const result=await executeAgentTool('deliver_workflow_message',{task_id:1},{});
  assert.equal(result.ok,false);assert.match(result.error,/scheduler approval/);
});
