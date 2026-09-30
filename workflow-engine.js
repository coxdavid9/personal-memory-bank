const crypto = require('node:crypto');
const { executeSkill, getApproval } = require('./policy');
const { saveJobApplication } = require('./job-search');
const DAY = 86400000;
const INVALIDATES = Object.freeze({
  APPLICATION_UPDATED: ['[Workflow application:<id>]'],
  INTERVIEW_UPDATED: ['[Workflow interview:<application_id>]', '[Workflow application:<application_id>]']
});
async function initWorkflowDb(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_events (
    id BIGSERIAL PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    entity TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_workflows (
    entity TEXT PRIMARY KEY, event_id BIGINT NOT NULL REFERENCES agent_events(id),
    state TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_workflow_steps (
    id BIGSERIAL PRIMARY KEY, entity TEXT NOT NULL REFERENCES agent_workflows(entity),
    event_id BIGINT NOT NULL REFERENCES agent_events(id), kind TEXT NOT NULL,
    due_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
      ('pending','waiting_approval','delivered','cancelled','expired','denied','blocked','failed')),
    approval_id BIGINT, delivered_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, next_attempt_at TIMESTAMPTZ, UNIQUE(event_id,kind))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS agent_workflow_steps_due_idx ON agent_workflow_steps(status,due_at)`);
}
async function transaction(pool, fn) {
  if (!pool) return { ok:false,error:'Persistent storage is not configured.' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}
function timestamp(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(value||'')) ||
      !Number.isFinite(Date.parse(value))) throw new Error(label+' must be an ISO timestamp with an explicit timezone offset.');
  return new Date(value).toISOString();
}
function chicagoMorning(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x=>[x.type,x.value]));
  const wall = Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),7);
  let instant = wall;
  for (let i=0;i<3;i++) {
    const x=Object.fromEntries(fmt.formatToParts(new Date(instant)).map(y=>[y.type,y.value]));
    const local=Date.UTC(Number(x.year),Number(x.month)-1,Number(x.day),Number(x.hour),Number(x.minute),Number(x.second));
    instant += wall-local;
  }
  return new Date(instant);
}
function planSteps(kind,payload,now=new Date()) {
  const current=new Date(now).getTime(),steps=[];
  const add=(name,due,expires=null)=>steps.push({
    kind:name,due_at:new Date(due).toISOString(),expires_at:expires==null?null:new Date(expires).toISOString()
  });
  if (kind==='APPLICATION_UPDATED') {
    if (payload.status==='applied') add('application_followup',current+7*DAY);
  } else if (payload.status==='completed') {
    add('interview_followup',payload.expected_response_at?Date.parse(payload.expected_response_at):current+7*DAY);
  } else if (payload.status==='scheduled') {
    const start=Date.parse(payload.start);
    if (start<=current) throw new Error('A scheduled interview must be in the future; record a completed interview separately.');
    add('interview_prep',current,start);
    const morning=chicagoMorning(new Date(start)).getTime();
    if (morning>current && morning<start) add('interview_morning',morning,start);
    if (start-30*60000>current) add('interview_reminder',start-30*60000,start);
    add('interview_debrief',start+2*3600000,start+DAY);
  }
  return steps;
}
function stepMessage(step,payload) {
  const role=payload.title+' at '+payload.company;
  const when=payload.start?new Intl.DateTimeFormat('en-US',{
    timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'
  }).format(new Date(payload.start))+' (Chicago time)':null;
  if (step.kind==='interview_prep'||step.kind==='interview_morning') return [
    'Interview preparation: '+role+' — '+when+'.',
    payload.format?'Format: '+payload.format+'.':'',
    payload.notes?'Your notes: '+payload.notes:'',
    'Have a short career introduction and two concrete examples ready: a variance you explained and an improvement you made. Explain the issue, your action, and the result.',
    'Ask what success looks like in the first 90 days and what the next interview step will be.',
    'This checklist uses your tracked details. Ask me for company research and a tailored brief when you want them.'
  ].filter(Boolean).join('\n\n');
  if (step.kind==='interview_reminder') return 'Your interview for '+role+' is at '+when+'. Review your introduction, two examples, and questions.';
  if (step.kind==='interview_debrief') return 'How did the interview for '+role+' go? Tell me the next steps and when you expect to hear back so I can update the follow-up.';
  return 'Follow-up due: '+role+'. The tracked date has arrived; I have not verified whether a reply came in. If you have heard back, tell me and I will update this.\n\nDraft:\nHi [contact name],\n\n'+
    (step.kind==='interview_followup'?'Thank you again for speaking with me about the ':'I wanted to follow up on my application for the ')+
    payload.title+' position. I remain interested and wanted to check on the next steps in the process. Please let me know if you need anything else from me.\n\nThank you,\nDavid';
}
async function retireNotes(client,entity) {
  const prefix='[Workflow '+entity+']';
  await client.query('UPDATE memories SET done=true WHERE LEFT(text,$1)=$2 AND done=false',[prefix.length,prefix]);
}
async function cancelEntity(client,entity) {
  await client.query(`UPDATE agent_workflow_steps SET status='cancelled' WHERE entity=$1 AND status IN ('pending','waiting_approval')`,[entity]);
  await client.query("UPDATE agent_workflows SET state='cancelled',updated_at=NOW() WHERE entity=$1",[entity]);
  await retireNotes(client,entity);
}
function canonical(value) {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value&&typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
// Caller holds the application lock in the source-write transaction.
async function publishEvent(client,{key,kind,entity,payload,now=new Date()}) {
  if (!INVALIDATES[kind]) throw new Error('Unsupported workflow event.');
  const prior=(await client.query(`SELECT e.payload,w.state FROM agent_workflows w JOIN agent_events e ON e.id=w.event_id WHERE w.entity=$1`,[entity])).rows[0];
  if (prior && prior.state!=='cancelled' && canonical(prior.payload)===canonical(payload)) return {duplicate:true};
  const steps=planSteps(kind,payload,now);
  const inserted=await client.query(`INSERT INTO agent_events(event_key,kind,entity,payload) VALUES($1,$2,$3,$4)
    ON CONFLICT(event_key) DO NOTHING RETURNING id`,[key+':'+entity+':'+crypto.createHash('sha256').update(canonical(payload)).digest('hex'),kind,entity,JSON.stringify(payload)]);
  if (!inserted.rows[0]) return {duplicate:true};
  const eventId=inserted.rows[0].id,state=steps.length?'active':'closed';
  await cancelEntity(client,entity);
  await client.query(`INSERT INTO agent_workflows(entity,event_id,state) VALUES($1,$2,$3)
    ON CONFLICT(entity) DO UPDATE SET event_id=EXCLUDED.event_id,state=EXCLUDED.state,updated_at=NOW()`,[entity,eventId,state]);
  for (const step of steps) await client.query(`INSERT INTO agent_workflow_steps(entity,event_id,kind,due_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`,[entity,eventId,step.kind,step.due_at,step.expires_at]);
  if (state==='active') await client.query(`INSERT INTO memories(text,type,priority) VALUES($1,'Follow-up','Normal')`,[
    '[Workflow '+entity+'] '+payload.title+' at '+payload.company+': '+payload.status+
    (payload.start?', interview '+payload.start:'')+'. Live workflow state is authoritative.'
  ]);
  return {eventId,state,steps:steps.length,invalidates:INVALIDATES[kind]};
}
async function saveApplicationWithWorkflow(pool,args,runId) {
  return transaction(pool,async client=>{
    const identity=[String(args.company||'').trim().slice(0,200).toLowerCase(),String(args.title||'').trim().slice(0,300).toLowerCase()];
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['job:'+JSON.stringify(identity)]);
    // Lock the existing application before its UPDATE; workers use this same ordering.
    const existing=(await client.query(`SELECT id FROM job_applications WHERE LOWER(title)=LOWER($1)
      AND LOWER(company)=LOWER($2) ORDER BY updated_at DESC LIMIT 1`,[identity[1],identity[0]])).rows[0];
    if (existing) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['application:'+existing.id]);
    const result=await saveJobApplication(client,args);
    if (!result.ok) return result;
    const job=result.application;
    if (!existing) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['application:'+job.id]);
    const interview=(await client.query('SELECT state FROM agent_workflows WHERE entity=$1',['interview:'+job.id])).rows[0];
    if (job.status!=='applied'||!interview||interview.state==='cancelled') result.workflow=await publishEvent(client,{
      key:(runId||crypto.randomUUID())+':application',kind:'APPLICATION_UPDATED',entity:'application:'+job.id,
      payload:{application_id:job.id,title:job.title,company:job.company,status:job.status}
    });
    if (['saved','rejected','ignore'].includes(job.status)) await cancelEntity(client,'interview:'+job.id);
    return result;
  });
}
async function recordInterview(pool,args,runId) {
  return transaction(pool,async client=>{
    const id=String(args.application_id||'');
    if (!/^[1-9]\d*$/.test(id)) throw new Error('A valid tracked application id is required.');
    if (!['scheduled','completed','cancelled','response_received'].includes(args.status)) throw new Error('Invalid interview status.');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['application:'+id]);
    const job=(await client.query('SELECT * FROM job_applications WHERE id=$1',[id])).rows[0];
    if (!job||['rejected','ignore'].includes(job.status)) throw new Error('The application is missing or closed. Update its status before recording an interview.');
    const entity='interview:'+id;
    const previous=(await client.query(`SELECT e.payload FROM agent_workflows w JOIN agent_events e ON e.id=w.event_id WHERE w.entity=$1`,[entity])).rows[0]?.payload||{};
    const start=args.start?timestamp(args.start,'Interview start'):previous.start||null;
    if (args.status==='scheduled'&&!start) throw new Error('Interview start is required.');
    const expected=args.expected_response_at?timestamp(args.expected_response_at,'Expected response'):null;
    const payload={
      application_id:job.id,title:job.title,company:job.company,status:args.status,start,
      format:args.format==null?previous.format||null:String(args.format).slice(0,200),
      notes:args.notes==null?previous.notes||null:String(args.notes).slice(0,4000),
      expected_response_at:args.status==='completed'?expected||previous.expected_response_at||null:expected
    };
    const workflow=await publishEvent(client,{key:(runId||crypto.randomUUID())+':interview',kind:'INTERVIEW_UPDATED',entity,payload});
    await cancelEntity(client,'application:'+id);
    return {ok:true,interview:payload,workflow,delivery:'Jarvis chat; no calendar event created'};
  });
}
async function getWorkflows(pool) {
  if (!pool) return {ok:true,workflows:[]};
  const {rows}=await pool.query(`SELECT w.entity,w.state,w.updated_at,e.kind,e.payload,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'due_at',s.due_at,'status',s.status,'attempts',s.attempts,'last_error',s.last_error)
      ORDER BY s.due_at) FROM agent_workflow_steps s WHERE s.entity=w.entity AND s.event_id=w.event_id),'[]'::jsonb) AS steps
    FROM agent_workflows w JOIN agent_events e ON e.id=w.event_id ORDER BY w.updated_at DESC LIMIT 100`);
  return {ok:true,workflows:rows};
}
async function deliverWorkflowMessage(pool,taskId,{approved=false}={}) {
  return transaction(pool,async client=>{
    const result=await deliverLocked(client,taskId,approved);
    const finished=await client.query(`UPDATE agent_workflows w SET state='complete',updated_at=NOW()
      WHERE w.state='active' AND w.entity=(SELECT entity FROM agent_workflow_steps WHERE id=$1)
      AND NOT EXISTS (SELECT 1 FROM agent_workflow_steps s WHERE s.entity=w.entity
        AND s.event_id=w.event_id AND s.status IN ('pending','waiting_approval'))
      RETURNING entity`,[taskId]);
    for (const row of finished.rows) await retireNotes(client,row.entity);
    return result;
  });
}
async function deliverLocked(client,taskId,approved=false) {
  const reference=(await client.query('SELECT entity FROM agent_workflow_steps WHERE id=$1',[taskId])).rows[0];
  if (!reference) return {ok:false,error:'Workflow step not found.'};
  const applicationId=reference.entity.split(':')[1];
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['application:'+applicationId]);
  const step=(await client.query(`SELECT s.*,e.payload,w.state,w.event_id AS current_event_id
    FROM agent_workflow_steps s JOIN agent_workflows w ON w.entity=s.entity
    JOIN agent_events e ON e.id=s.event_id WHERE s.id=$1 FOR UPDATE OF s`,[taskId])).rows[0];
  if (!step||!['pending','waiting_approval'].includes(step.status)) return {ok:true,skipped:true};
  const job=(await client.query('SELECT status FROM job_applications WHERE id=$1',[applicationId])).rows[0];
  const enabled=(await client.query("SELECT enabled FROM agent_capabilities WHERE key='job-search'")).rows[0];
  if (enabled?.enabled===false) return {ok:true,skipped:true};
  if (!job||['rejected','ignore'].includes(job.status)||step.state!=='active'||String(step.event_id)!==String(step.current_event_id)) {
    await client.query("UPDATE agent_workflow_steps SET status='cancelled' WHERE id=$1",[taskId]);return {ok:true,skipped:true};
  }
  if (new Date(step.due_at).getTime()>Date.now()) return {ok:true,skipped:true};
  if (step.expires_at&&new Date(step.expires_at).getTime()<=Date.now()) {
    await client.query("UPDATE agent_workflow_steps SET status='expired' WHERE id=$1",[taskId]);return {ok:true,skipped:true};
  }
  if (step.status==='waiting_approval') {
    const approval=await getApproval(client,step.approval_id);
    if (!approval||['denied','expired'].includes(approval.status)) {
      await client.query("UPDATE agent_workflow_steps SET status=$1 WHERE id=$2",[approval?.status==='denied'?'denied':'expired',taskId]);
      return {ok:true,skipped:true};
    }
    if (approval.status!=='approved') return {ok:true,skipped:true};
    if (approval.skill!=='deliver_workflow_message'||String(approval.args?.task_id)!==String(taskId)) {
      await client.query("UPDATE agent_workflow_steps SET status='blocked' WHERE id=$1",[taskId]);
      return {ok:false,error:'Approval does not match this workflow step.'};
    }
    approved=true;
  } else if (approved) return {ok:false,error:'This step has no pending approval.'};
  const deliver=async()=>{
    await client.query('INSERT INTO agent_messages(role,content,actions) VALUES($1,$2,$3)',['assistant',stepMessage(step,step.payload),JSON.stringify([])]);
    await client.query("UPDATE agent_workflow_steps SET status='delivered',delivered_at=NOW() WHERE id=$1",[taskId]);
    return {ok:true,delivered:true,taskId};
  };
  if (approved) return deliver();
  const result=await executeSkill('deliver_workflow_message',{task_id:Number(taskId)},{
    pool:client,runId:'workflow_step_'+taskId,execute:deliver
  });
  if (result?.approvalRequired) {
    await client.query("UPDATE agent_workflow_steps SET status='waiting_approval',approval_id=$1 WHERE id=$2",[result.approval.approvalId,taskId]);
    await client.query('INSERT INTO agent_messages(role,content,actions) VALUES($1,$2,$3)',[
      'assistant','Approve delivery of this workflow reminder?',JSON.stringify([{
        type:'tool.approval',skill:'deliver_workflow_message',args:{task_id:Number(taskId)},
        approvalId:result.approval.approvalId,expiresAt:result.approval.expiresAt
      }])
    ]);
  } else if (result?.blocked||result?.ok===false) await client.query("UPDATE agent_workflow_steps SET status='blocked' WHERE id=$1",[taskId]);
  return result;
}
async function processDueWorkflows(pool,limit=25) {
  if (!pool) return {processed:0};
  const {rows}=await pool.query(`SELECT s.id FROM agent_workflow_steps s LEFT JOIN tool_approvals a ON a.id=s.approval_id
    WHERE NOT EXISTS (SELECT 1 FROM agent_capabilities WHERE key='job-search' AND enabled=false)
    AND (s.next_attempt_at IS NULL OR s.next_attempt_at<=NOW())
    AND ((s.status='pending' AND s.due_at<=NOW()) OR
    (s.status='waiting_approval' AND (a.status<>'pending' OR a.expires_at<=NOW())))
    ORDER BY s.due_at LIMIT $1`,[Math.max(1,Math.min(100,Number(limit)||25))]);
  let delivered=0;
  for (const row of rows) {
    try {
      const result=await deliverWorkflowMessage(pool,row.id);
      if (result?.delivered) delivered++;
    } catch {
      // The delivery transaction rolled back; retain a bounded retry without leaking DB error details.
      await pool.query(`UPDATE agent_workflow_steps SET attempts=attempts+1,
        last_error='Workflow delivery failed; retry pending.',
        status=CASE WHEN attempts>=4 THEN 'failed' ELSE status END,
        next_attempt_at=NOW()+INTERVAL '1 minute' WHERE id=$1 AND status IN ('pending','waiting_approval')`,[row.id]);
    }
  }
  return {processed:rows.length,delivered};
}
module.exports={INVALIDATES,initWorkflowDb,transaction,timestamp,chicagoMorning,planSteps,stepMessage,
  publishEvent,saveApplicationWithWorkflow,recordInterview,getWorkflows,deliverWorkflowMessage,processDueWorkflows};
