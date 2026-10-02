const crypto = require('crypto');

async function initProactiveDb(pool){
  if(!pool)return;
  await pool.query(`CREATE TABLE IF NOT EXISTS proactive_attention_runs(
    id BIGSERIAL PRIMARY KEY,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attention_key TEXT,
    notification_sent BOOLEAN NOT NULL DEFAULT FALSE
  )`);
}

function signalKey(signal){
  return crypto.createHash('sha256').update(JSON.stringify(signal)).digest('hex').slice(0,24);
}

function collectProactiveSignals(context, now=new Date()){
  const signals=[];
  const approvals=context?.priorityContext?.approvals||[];
  for(const a of approvals){
    const expires=new Date(a.expiresAt).getTime();
    if(Number.isFinite(expires) && expires>Date.now() && expires-Date.now()<=30*60*1000)
      signals.push({kind:'approval',priority:100,title:`Approval expiring: ${a.skill}`,detail:'A Jarvis approval is waiting and expires within 30 minutes.'});
  }
  const market=context?.priorityContext?.market||{};
  for(const item of market.material||market.investigations||[]){
    signals.push({kind:'market',priority:70,title:`Market: ${item.ticker||'material event'}`,detail:item.summary||item.driver||'Market Sentinel found a material change.'});
  }
  const emails=[...(context?.priorityContext?.email?.yahoo||[]),...(context?.priorityContext?.email?.gmail||[])];
  for(const e of emails){
    const text=`${e.subject||''} ${e.snippet||''}`;
    if(/fraud|unauthori[sz]ed|confirm this purchase|payment failed|account locked|security alert/i.test(text))
      signals.push({kind:'email',priority:95,title:e.subject||'Important email',detail:'A recent message appears to require prompt verification or action.'});
  }
  return signals.sort((a,b)=>b.priority-a.priority).slice(0,3);
}

async function runProactiveCheck({pool,getContext,notify,now=new Date()}){
  const context=await getContext();
  const signals=collectProactiveSignals(context,now);
  if(!signals.length)return {notify:false,reason:'no_material_change',signals:[]};
  const key=signalKey(signals);
  const prior=await pool.query('SELECT attention_key,notification_sent FROM proactive_attention_runs ORDER BY checked_at DESC LIMIT 1');
  if(prior.rows[0]?.attention_key===key && prior.rows[0]?.notification_sent){
    await pool.query('INSERT INTO proactive_attention_runs(attention_key,notification_sent) VALUES($1,FALSE)',[key]);
    return {notify:false,reason:'already_notified',signals};
  }
  const message=['Jarvis noticed something that may need your attention:',...signals.map(s=>`• ${s.title} — ${s.detail}`)].join('\n');
  await notify(message);
  await pool.query('INSERT INTO proactive_attention_runs(attention_key,notification_sent) VALUES($1,TRUE)',[key]);
  return {notify:true,reason:'new_material_attention',signals};
}
module.exports={initProactiveDb,collectProactiveSignals,runProactiveCheck,signalKey};
