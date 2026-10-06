const crypto = require('crypto');
const webpush = require('web-push');

function validateSubscription(value) {
  if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 2048) throw new Error('Invalid notification subscription.');
  const url = new URL(value.endpoint);
  const host = url.hostname;
  const allowed = host === 'web.push.apple.com' || host === 'fcm.googleapis.com' ||
    host === 'updates.push.services.mozilla.com' || host.endsWith('.notify.windows.com');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !allowed) throw new Error('Unsupported notification provider.');
  const keys = value.keys || {};
  if (!/^[A-Za-z0-9_-]+$/.test(keys.p256dh || '') || Buffer.from(keys.p256dh,'base64url').length !== 65 ||
      !/^[A-Za-z0-9_-]+$/.test(keys.auth || '') || Buffer.from(keys.auth,'base64url').length !== 16) throw new Error('Invalid notification keys.');
  return {endpoint:url.toString(),keys:{p256dh:keys.p256dh,auth:keys.auth}};
}
const endpointId = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex');

class JarvisPush {
  constructor({pool,encrypt,decrypt,send=webpush.sendNotification,generateKeys=webpush.generateVAPIDKeys}) {
    Object.assign(this,{pool,encrypt,decrypt,send,generateKeys});
    this.keys=null;
  }
  async init() {
    if (!this.pool) return;
    await this.pool.query(`CREATE TABLE IF NOT EXISTS jarvis_push_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), encrypted_keys TEXT NOT NULL, last_tick TIMESTAMPTZ)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS jarvis_push_subscriptions (
      id TEXT PRIMARY KEY, encrypted_subscription TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS jarvis_push_deliveries (
      memory_id BIGINT REFERENCES memories(id) ON DELETE CASCADE, subscription_id TEXT REFERENCES jarvis_push_subscriptions(id) ON DELETE CASCADE,
      due_at TIMESTAMPTZ NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_status INTEGER,
      PRIMARY KEY(memory_id,subscription_id,due_at))`);
    const keys=this.generateKeys();
    await this.pool.query('INSERT INTO jarvis_push_settings(id,encrypted_keys) VALUES(1,$1) ON CONFLICT(id) DO NOTHING',[this.encrypt(JSON.stringify(keys))]);
    const result=await this.pool.query('SELECT encrypted_keys FROM jarvis_push_settings WHERE id=1');
    this.keys=JSON.parse(this.decrypt(result.rows[0].encrypted_keys));
  }
  async status() {
    if (!this.keys) return {available:false};
    const {rows}=await this.pool.query('SELECT last_tick,(SELECT COUNT(*)::int FROM jarvis_push_subscriptions) AS devices FROM jarvis_push_settings WHERE id=1');
    return {available:true,publicKey:this.keys.publicKey,devices:rows[0].devices,lastTick:rows[0].last_tick,
      timing:'Reminders can arrive late on free hosting. Calendar alerts are better for exact-time events.'};
  }
  async subscribe(value) {
    const subscription=validateSubscription(value),id=endpointId(subscription.endpoint);
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM jarvis_push_settings WHERE id=1 FOR UPDATE');
      const {rows}=await client.query('SELECT COUNT(*)::int AS count FROM jarvis_push_subscriptions WHERE id<>$1',[id]);
      if (rows[0].count>=16) throw new Error('Too many notification devices. Remove an old device first.');
      await client.query('INSERT INTO jarvis_push_subscriptions(id,encrypted_subscription) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET encrypted_subscription=EXCLUDED.encrypted_subscription',[id,this.encrypt(JSON.stringify(subscription))]);
      await client.query('COMMIT');
      return {ok:true};
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
  }
  async unsubscribe(value) {
    const subscription=validateSubscription(value);
    await this.pool.query('DELETE FROM jarvis_push_subscriptions WHERE id=$1',[endpointId(subscription.endpoint)]);
    return {ok:true};
  }
  async sendTo(subscription,payload) {
    return this.send(subscription,JSON.stringify(payload),{
      vapidDetails:{subject:'mailto:david_cox33@yahoo.com',...this.keys},
      TTL:3600,timeout:10000,urgency:'normal'
    });
  }
  async test(value) {
    const subscription=validateSubscription(value);
    const {rows}=await this.pool.query('SELECT id FROM jarvis_push_subscriptions WHERE id=$1',[endpointId(subscription.endpoint)]);
    if (!rows.length) throw new Error('Enable notifications on this device first.');
    await this.sendTo(subscription,{title:'Jarvis',body:'Your Jarvis notification test.',tag:'jarvis-test',url:'/'});
    return {ok:true,accepted:true};
  }
  async processDue() {
    if (!this.keys) return {processed:0};
    const client=await this.pool.connect(); let locked=false,processed=0,failed=0;
    try {
      const lock=await client.query('SELECT pg_try_advisory_lock(72483196) AS locked');
      locked=lock.rows[0].locked;
      if (!locked) return {processed:0,busy:true};
      await client.query('UPDATE jarvis_push_settings SET last_tick=NOW() WHERE id=1');
      // node-postgres Dates retain milliseconds; use that same precision in the delivery key.
      const {rows}=await client.query(`SELECT m.id AS memory_id,s.id AS subscription_id,date_trunc('milliseconds',m.due_at) AS due_at
        FROM memories m CROSS JOIN jarvis_push_subscriptions s
        LEFT JOIN jarvis_push_deliveries d ON d.memory_id=m.id AND d.subscription_id=s.id AND d.due_at=date_trunc('milliseconds',m.due_at)
        WHERE m.done=FALSE AND m.due_at<=NOW() AND m.due_at>NOW()-INTERVAL '24 hours'
          AND m.due_at>=s.created_at AND d.sent_at IS NULL AND COALESCE(d.attempts,0)<5
          AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=NOW())
        ORDER BY m.due_at LIMIT 10`);
      for (const row of rows) {
        // Hold the memory row lock through delivery so completion/deletion cannot race it.
        await client.query('BEGIN');
        try {
          const current=await client.query('SELECT text,done,due_at FROM memories WHERE id=$1 FOR UPDATE',[row.memory_id]);
          const memory=current.rows[0];
          if (!memory || memory.done || new Date(memory.due_at).getTime()!==new Date(row.due_at).getTime()) {await client.query('COMMIT');continue;}
          const device=await client.query('SELECT encrypted_subscription FROM jarvis_push_subscriptions WHERE id=$1 FOR UPDATE',[row.subscription_id]);
          if (!device.rows.length) {await client.query('COMMIT');continue;}
          await client.query(`INSERT INTO jarvis_push_deliveries(memory_id,subscription_id,due_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[row.memory_id,row.subscription_id,row.due_at]);
          try {
            const subscription=JSON.parse(this.decrypt(device.rows[0].encrypted_subscription));
            await this.sendTo(subscription,{title:'Jarvis reminder',body:memory.text.slice(0,200),
              tag:'jarvis-reminder-'+row.memory_id+'-'+new Date(row.due_at).getTime(),url:'/'});
            await client.query('UPDATE jarvis_push_deliveries SET sent_at=NOW(),attempts=attempts+1,last_status=201 WHERE memory_id=$1 AND subscription_id=$2 AND due_at=$3',[row.memory_id,row.subscription_id,row.due_at]);
            processed++;
          } catch(error) {
            const status=Number(error.statusCode)||0;
            if (status===404 || status===410) await client.query('DELETE FROM jarvis_push_subscriptions WHERE id=$1',[row.subscription_id]);
            else await client.query(`UPDATE jarvis_push_deliveries SET attempts=attempts+1,last_status=$4,
              next_attempt_at=NOW()+INTERVAL '5 minutes' * power(2,attempts)
              WHERE memory_id=$1 AND subscription_id=$2 AND due_at=$3`,[row.memory_id,row.subscription_id,row.due_at,status]);
            failed++;
          }
          await client.query('COMMIT');
        } catch(error) {await client.query('ROLLBACK');throw error;}
      }
      return {processed,failed};
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(72483196)').catch(()=>{});
      client.release();
    }
  }
}
module.exports={JarvisPush,validateSubscription};
