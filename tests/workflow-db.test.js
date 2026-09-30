const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {Pool}=require('pg');
const {initPolicyDb,decideApproval}=require('../policy');
const {initJobSearchDb}=require('../job-search');
const {initWorkflowDb,saveApplicationWithWorkflow,recordInterview,getWorkflows,processDueWorkflows,deliverWorkflowMessage}=require('../workflow-engine');

test('workflow persistence and concurrency in real PostgreSQL',{skip:!process.env.TEST_WORKFLOW_DATABASE_URL},async t=>{
  const schema='workflow_test_'+crypto.randomBytes(6).toString('hex');
  const admin=new Pool({connectionString:process.env.TEST_WORKFLOW_DATABASE_URL});
  await admin.query('CREATE SCHEMA '+schema);
  const pool=new Pool({connectionString:process.env.TEST_WORKFLOW_DATABASE_URL,options:'-c search_path='+schema,max:10});
  const args={title:'Controller',company:'Test Co',location:'Jonesboro',url:null,status:'applied',notes:null};
  const future=new Date(Date.now()+2*86400000).toISOString();
  const interview=(id,changes={})=>({application_id:Number(id),status:'scheduled',start:future,format:'Phone',notes:'Recruiter call',expected_response_at:null,...changes});
  const scalar=async sql=>(await pool.query(sql)).rows[0].n;
  const reset=async()=>{await pool.query('TRUNCATE agent_workflow_steps,agent_workflows,agent_events,job_applications,memories,agent_messages,tool_approvals,tool_audit,tool_whitelist RESTART IDENTITY CASCADE');
    await pool.query("UPDATE agent_capabilities SET enabled=true");};
  try {
    await pool.query(`CREATE TABLE memories(id BIGSERIAL PRIMARY KEY,text TEXT NOT NULL,type TEXT,priority TEXT,done BOOLEAN DEFAULT false)`);
    await pool.query(`CREATE TABLE agent_messages(id BIGSERIAL PRIMARY KEY,role TEXT,content TEXT,actions JSONB)`);
    await pool.query(`CREATE TABLE agent_capabilities(key TEXT PRIMARY KEY,enabled BOOLEAN)`);
    await pool.query("INSERT INTO agent_capabilities VALUES('job-search',true)");
    await initJobSearchDb(pool);await initPolicyDb(pool);await initWorkflowDb(pool);
    await t.test('application write creates one event and stable followup on repeated edits',async()=>{
      await reset();
      const a=await saveApplicationWithWorkflow(pool,args,'a');
      await saveApplicationWithWorkflow(pool,{...args,notes:'Updated notes'},'b');
      assert.ok(a.ok);assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_events')),1);
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_workflow_steps')),1);
    });
    await t.test('multiple applications in a single run have separate event keys',async()=>{
      await reset();
      await saveApplicationWithWorkflow(pool,args,'same-run');
      await saveApplicationWithWorkflow(pool,{...args,company:'Other Co'},'same-run');
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_events')),2);
    });
    await t.test('reschedule cancels old tasks and retires only managed notes',async()=>{
      await reset();
      const a=await saveApplicationWithWorkflow(pool,args,'a');
      await recordInterview(pool,interview(a.application.id),'i1');
      await pool.query("INSERT INTO memories(text,done) VALUES('Unrelated follow-up',false)");
      const res=await recordInterview(pool,interview(a.application.id,{start:new Date(Date.now()+3*86400000).toISOString()}),'i2');
      assert.equal(res.workflow.state,'active');
      assert.equal(Number(await scalar("SELECT COUNT(*) AS n FROM agent_workflow_steps WHERE status='pending' AND event_id<>(SELECT event_id FROM agent_workflows WHERE entity='interview:1')")),0);
      assert.equal(Number(await scalar("SELECT COUNT(*) AS n FROM memories WHERE done=false AND text LIKE '[Workflow%'")),1);
      assert.equal(Number(await scalar("SELECT COUNT(*) AS n FROM memories WHERE text='Unrelated follow-up' AND done=false")),1);
    });
    await t.test('overlapping workers deliver exactly once with durable audit',async()=>{
      await reset();
      const a=await saveApplicationWithWorkflow(pool,args,'a');
      await recordInterview(pool,interview(a.application.id),'i1');
      await Promise.all([processDueWorkflows(pool),processDueWorkflows(pool),processDueWorkflows(pool)]);
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),1);
      assert.equal(Number(await scalar("SELECT COUNT(*) AS n FROM agent_workflow_steps WHERE status='delivered'")),1);
      assert.equal(Number(await scalar("SELECT COUNT(*) AS n FROM tool_audit WHERE skill='deliver_workflow_message' AND decision='allow'")),1);
      await processDueWorkflows(pool);
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),1);
    });
    await t.test('completion follows promised date; response stops reminder and notes',async()=>{
      await reset();
      const a=await saveApplicationWithWorkflow(pool,args,'a');
      await recordInterview(pool,interview(a.application.id),'i1');
      const promise=new Date(Date.now()+4*86400000).toISOString();
      await recordInterview(pool,interview(a.application.id,{status:'completed',start:null,expected_response_at:promise}),'i2');
      let workflows=(await getWorkflows(pool)).workflows;
      assert.equal(workflows.find(w=>w.entity==='interview:1').steps[0].kind,'interview_followup');
      await recordInterview(pool,interview(a.application.id,{status:'response_received',start:null}),'i3');
      await processDueWorkflows(pool);
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),0);
      assert.equal(Number(await scalar("SELECT COUNT(*) AS n FROM memories WHERE done=false AND text LIKE '[Workflow%'")),0);
      await saveApplicationWithWorkflow(pool,{...args,notes:'Heard back'},'a2');
      assert.equal(Number(await scalar("SELECT COUNT(*) AS n FROM agent_workflow_steps WHERE status='pending'")),0);
    });
    await t.test('rejection cancels pending interview work; closed applications cannot schedule',async()=>{
      await reset();
      const a=await saveApplicationWithWorkflow(pool,args,'a');
      await recordInterview(pool,interview(a.application.id),'i1');
      await saveApplicationWithWorkflow(pool,{...args,status:'rejected'},'reject');
      await processDueWorkflows(pool);
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),0);
      await assert.rejects(recordInterview(pool,interview(a.application.id),'i2'),/closed/);
    });
    await t.test('expired pre-interview and debrief reminders do not flood on restart',async()=>{
      await reset();
      const a=await saveApplicationWithWorkflow(pool,args,'a');
      await recordInterview(pool,interview(a.application.id),'i1');
      await pool.query("UPDATE agent_workflow_steps SET due_at=NOW()-INTERVAL '2 days',expires_at=NOW()-INTERVAL '1 day' WHERE entity='interview:1'");
      await processDueWorkflows(pool);
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),0);
      assert.ok(Number(await scalar("SELECT COUNT(*) AS n FROM agent_workflow_steps WHERE status='expired'"))>=3);
    });
    await t.test('disabled job-search pauses delivery; enabling recovers due steps',async()=>{
      await reset();
      const a=await saveApplicationWithWorkflow(pool,args,'a');
      await recordInterview(pool,interview(a.application.id),'i1');
      await pool.query("UPDATE agent_capabilities SET enabled=false");
      await processDueWorkflows(pool);
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),0);
      await pool.query("UPDATE agent_capabilities SET enabled=true");
      await processDueWorkflows(pool);
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),1);
    });
    await t.test('bad schedule rolls back every related state change',async()=>{
      await reset();
      const a=await saveApplicationWithWorkflow(pool,args,'a');
      await assert.rejects(recordInterview(pool,interview(a.application.id,{start:'2020-01-01T12:00:00Z'}),'invalid'),/future/);
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_events')),1);
      assert.equal((await getWorkflows(pool)).workflows[0].state,'active');
    });
    await t.test('approval resumes exact task once and cancellation wins over old approval',async()=>{
      await reset();
      const policy=require('../policy');
      const original=policy.DEFAULT_POLICIES.deliver_workflow_message;
      assert.equal(original,'monitor');
      const a=await saveApplicationWithWorkflow(pool,args,'a');
      await recordInterview(pool,interview(a.application.id),'i1');
      const step=(await pool.query("SELECT id FROM agent_workflow_steps WHERE kind='interview_prep'")).rows[0];
      const approval=(await pool.query(`INSERT INTO tool_approvals(run_id,skill,args,expires_at)
        VALUES('workflow','deliver_workflow_message',$1,NOW()+INTERVAL '5 minutes') RETURNING id`,[JSON.stringify({task_id:Number(step.id)})])).rows[0];
      await pool.query("UPDATE agent_workflow_steps SET status='waiting_approval',approval_id=$1 WHERE id=$2",[approval.id,step.id]);
      await decideApproval(pool,approval.id,'approve');
      await Promise.all([deliverWorkflowMessage(pool,step.id,{approved:true}),processDueWorkflows(pool)]);
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),1);
      await recordInterview(pool,interview(a.application.id,{start:new Date(Date.now()+3*86400000).toISOString()}),'i2');
      const next=(await pool.query("SELECT id FROM agent_workflow_steps WHERE kind='interview_prep' AND status='pending'")).rows[0];
      await pool.query("UPDATE agent_workflow_steps SET status='waiting_approval',approval_id=$1 WHERE id=$2",[approval.id,next.id]);
      await recordInterview(pool,interview(a.application.id,{status:'cancelled',start:null}),'i3');
      await deliverWorkflowMessage(pool,next.id,{approved:true});
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),1);
    });
    await t.test('denied and expired approvals stop steps without retrying approval',async()=>{
      await reset();
      const a=await saveApplicationWithWorkflow(pool,args,'a');
      await recordInterview(pool,interview(a.application.id),'i1');
      const step=(await pool.query("SELECT id FROM agent_workflow_steps WHERE kind='interview_prep'")).rows[0];
      const approval=(await pool.query(`INSERT INTO tool_approvals(run_id,skill,args,expires_at)
        VALUES('workflow','deliver_workflow_message','{}',NOW()-INTERVAL '1 minute') RETURNING id`)).rows[0];
      await pool.query("UPDATE agent_workflow_steps SET status='waiting_approval',approval_id=$1 WHERE id=$2",[approval.id,step.id]);
      await processDueWorkflows(pool);
      assert.equal((await pool.query('SELECT status FROM agent_workflow_steps WHERE id=$1',[step.id])).rows[0].status,'expired');
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),0);
      await recordInterview(pool,interview(a.application.id,{start:new Date(Date.now()+3*86400000).toISOString()}),'i2');
      const next=(await pool.query("SELECT id FROM agent_workflow_steps WHERE kind='interview_prep' AND status='pending'")).rows[0];
      const denied=(await pool.query(`INSERT INTO tool_approvals(run_id,skill,args,expires_at)
        VALUES('workflow','deliver_workflow_message',$1,NOW()+INTERVAL '5 minutes') RETURNING id`,[JSON.stringify({task_id:Number(next.id)})])).rows[0];
      await pool.query("UPDATE agent_workflow_steps SET status='waiting_approval',approval_id=$1 WHERE id=$2",[denied.id,next.id]);
      await decideApproval(pool,denied.id,'deny');
      await processDueWorkflows(pool);
      assert.equal((await pool.query('SELECT status FROM agent_workflow_steps WHERE id=$1',[next.id])).rows[0].status,'denied');
    });
    await t.test('final delivered followup retires the managed priority note',async()=>{
      await reset();
      const a=await saveApplicationWithWorkflow(pool,args,'a');
      await pool.query("UPDATE agent_workflow_steps SET due_at=NOW()-INTERVAL '1 second'");
      await processDueWorkflows(pool);
      assert.equal((await getWorkflows(pool)).workflows[0].state,'complete');
      assert.equal(Number(await scalar("SELECT COUNT(*) AS n FROM memories WHERE done=false AND text LIKE '[Workflow%'")),0);
    });
    await t.test('failed delivery rolls back chat, retries durably, and recovers in a fresh worker',async()=>{
      await reset();
      const a=await saveApplicationWithWorkflow(pool,args,'a');
      await recordInterview(pool,interview(a.application.id),'i1');
      await pool.query(`CREATE FUNCTION fail_chat() RETURNS trigger AS $ BEGIN RAISE EXCEPTION 'test write failure'; END $ LANGUAGE plpgsql`);
      await pool.query(`CREATE TRIGGER fail_chat BEFORE INSERT ON agent_messages FOR EACH ROW EXECUTE FUNCTION fail_chat()`);
      await processDueWorkflows(pool);
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),0);
      assert.equal(Number(await scalar("SELECT COUNT(*) AS n FROM agent_workflow_steps WHERE attempts=1")),1);
      await pool.query('DROP TRIGGER fail_chat ON agent_messages');
      await pool.query("UPDATE agent_workflow_steps SET next_attempt_at=NOW()-INTERVAL '1 second'");
      const recovered=new Pool({connectionString:process.env.TEST_WORKFLOW_DATABASE_URL,options:'-c search_path='+schema});
      try { await processDueWorkflows(recovered); } finally { await recovered.end(); }
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),1);
      await processDueWorkflows(pool);
      assert.equal(Number(await scalar('SELECT COUNT(*) AS n FROM agent_messages')),1);
    });
  } finally {
    await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
  }
});
