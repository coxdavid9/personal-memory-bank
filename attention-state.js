const crypto = require('crypto');
const INVALIDATES = ['exact candidate text', 'memory:<id>'];
function identifyCandidate(item) {
  const identity = item.identity || item.domain + ':' + item.text;
  const revision = item.revision || item.text;
  return {...item, id: crypto.createHash('sha256').update(identity + '\n' + revision).digest('hex')};
}
function isVisible(state, now=new Date()) {
  return !state || state.status==='active' || (state.status==='snoozed' && new Date(state.snoozed_until).getTime()<=now.getTime());
}
async function initAttentionDb(db) {
  if(!db)return;
  await db.query(`CREATE TABLE IF NOT EXISTS attention_items (
    id TEXT PRIMARY KEY, payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    snoozed_until TIMESTAMPTZ, retired_memory_ids BIGINT[] NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}
async function prepareAttention(db, candidates) {
  const items=candidates.map(identifyCandidate);
  if(!db)return items;
  for(const item of items)await db.query(`INSERT INTO attention_items(id,payload) VALUES($1,$2)
    ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`,[item.id,JSON.stringify(item)]);
  const {rows}=await db.query('SELECT id,status,snoozed_until FROM attention_items WHERE id=ANY($1::text[])',[items.map(x=>x.id)]);
  const states=new Map(rows.map(x=>[x.id,x]));
  return items.filter(x=>isVisible(states.get(x.id)));
}
async function decideAttention(db,id,status,hours=24) {
  if(!/^[a-f0-9]{64}$/.test(id)||!['handled','snoozed','active'].includes(status))throw new Error('Invalid attention decision.');
  if(status==='snoozed'&&(!Number.isFinite(hours)||hours<1||hours>168))throw new Error('Snooze must be between 1 and 168 hours.');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const {rows}=await client.query('SELECT payload,status,retired_memory_ids FROM attention_items WHERE id=$1 FOR UPDATE',[id]);
    if(!rows[0])throw new Error('Attention item not found. Refresh the view.');
    const item=rows[0].payload;
    await client.query(`UPDATE attention_items SET status=$2,snoozed_until=CASE WHEN $2='snoozed' THEN NOW()+($3*INTERVAL '1 hour') ELSE NULL END,updated_at=NOW() WHERE id=$1`,[id,status,hours]);
    if(status==='handled') {
      // Only retire exact matching guidance and the memory represented by this card.
      const retired=await client.query(`UPDATE memories SET done=TRUE WHERE done=FALSE AND (text=$1 OR id=$2) RETURNING id`,[item.text,item.memoryId||null]);
      if(rows[0].status!=='handled')await client.query('UPDATE attention_items SET retired_memory_ids=$2 WHERE id=$1',[id,retired.rows.map(x=>x.id)]);
    }
    if(status==='active'&&rows[0].status==='handled'){
      await client.query('UPDATE memories SET done=FALSE WHERE id=ANY($1::bigint[])',[rows[0].retired_memory_ids||[]]);
      await client.query("UPDATE attention_items SET retired_memory_ids='{}' WHERE id=$1",[id]);
    }
    await client.query('COMMIT');
    return {id,status,invalidates:status==='handled'?INVALIDATES:[],snoozedUntil:status==='snoozed'?new Date(Date.now()+hours*3600000).toISOString():null};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
module.exports={identifyCandidate,isVisible,initAttentionDb,prepareAttention,decideAttention};
