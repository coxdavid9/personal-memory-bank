const test=require('node:test'),assert=require('node:assert/strict');
const {JarvisPush,validateSubscription}=require('../push-notifications');
const {verifySignedSchedulerToken}=require('../push-scheduler-auth');
const subscription={endpoint:'https://web.push.apple.com/test',keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16,5).toString('base64url')}};
test('only supported HTTPS push providers and valid subscription keys are accepted',()=>{
 assert.deepEqual(validateSubscription(subscription),subscription);
 for(const endpoint of ['http://web.push.apple.com/x','https://127.0.0.1/x','https://web.push.apple.com.evil.test/x','https://user:password@web.push.apple.com/x','https://web.push.apple.com:8443/x'])
  assert.throws(()=>validateSubscription({...subscription,endpoint}));
 assert.throws(()=>validateSubscription({...subscription,keys:{p256dh:'bad',auth:'bad'}}));
});
test('scheduler verifies signatures, expiration, audience and exact trusted workflow',async()=>{
 const {generateKeyPair,SignJWT}=await import('jose');
 const {publicKey,privateKey}=await generateKeyPair('RS256');
 const claims={repository:'coxdavid9/personal-memory-bank',repository_id:'1349628989',repository_owner_id:'311132298',ref:'refs/heads/main',workflow_ref:'coxdavid9/personal-memory-bank/.github/workflows/reminders.yml@refs/heads/main',event_name:'schedule'};
 const sign=(changes={},aud='jarvis-reminders',expiry='5m')=>new SignJWT({...claims,...changes}).setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com').setAudience(aud).setSubject(changes.subject || 'repo:coxdavid9@311132298/personal-memory-bank@1349628989:ref:refs/heads/main').setIssuedAt().setExpirationTime(expiry).sign(privateKey);
 assert.equal(await verifySignedSchedulerToken(await sign(),publicKey),true);
 assert.equal(await verifySignedSchedulerToken(await sign({event_name:'workflow_dispatch'}),publicKey),true);
 for(const changes of [{repository_id:'999'},{repository_owner_id:'999'},{repository_id:undefined},{repository_owner_id:undefined},{subject:'repo:coxdavid9/personal-memory-bank:ref:refs/heads/main'},{subject:'repo:coxdavid9@999/personal-memory-bank@1349628989:ref:refs/heads/main'},{subject:'repo:coxdavid9@311132298/personal-memory-bank@999:ref:refs/heads/main'},{repository:'other/repo'},{ref:'refs/heads/feature'},{event_name:'pull_request'},{workflow_ref:'coxdavid9/personal-memory-bank/.github/workflows/ci.yml@refs/heads/main'}])
  assert.equal(await verifySignedSchedulerToken(await sign(changes),publicKey),false);
 assert.equal(await verifySignedSchedulerToken(await sign({},'other'),publicKey),false);
 assert.equal(await verifySignedSchedulerToken(await sign({},'jarvis-reminders',-1),publicKey),false);
 const token=await sign();assert.equal(await verifySignedSchedulerToken(token.slice(0,-20)+'tampered',publicKey),false);
});
test('push payload uses encrypted web-push transport and does not claim device receipt',async()=>{
 let call;
 const service=new JarvisPush({pool:{query:async()=>({rows:[{id:'device'}]})},send:async(...args)=>{call=args;return {statusCode:201};}});
 service.keys={publicKey:'public',privateKey:'private'};
 const result=await service.test(subscription);
 assert.deepEqual(result,{ok:true,accepted:true});
 assert.equal(call[2].TTL,3600);
 assert.equal(call[2].vapidDetails.subject,'mailto:david_cox33@yahoo.com');
 assert.equal(JSON.parse(call[1]).tag,'jarvis-test');
});

const database=process.env.TEST_WORKFLOW_DATABASE_URL;
test('durable delivery: one send, retries, cancellation, expired subscription, no stale opt-in backlog',{skip:!database},async()=>{
 const {Pool}=require('pg');
 const admin=new Pool({connectionString:database});
 const schema='push_test_'+process.pid+'_'+Date.now();
 await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:database,options:'-c search_path='+schema});
 let sends=0,status=201;
 const service=new JarvisPush({pool,encrypt:s=>'sealed:'+s,decrypt:s=>s.slice(7),send:async()=>{
  sends++;if(status!==201)throw Object.assign(new Error('private provider response'),{statusCode:status});
 }});
 try {
  await pool.query('CREATE TABLE memories(id BIGSERIAL PRIMARY KEY,text TEXT,done BOOLEAN DEFAULT FALSE,due_at TIMESTAMPTZ)');
  await service.init();
  const originalKeys={...service.keys};await service.init();assert.deepEqual(service.keys,originalKeys);
  await service.subscribe(subscription);
  const stored=await pool.query('SELECT encrypted_subscription FROM jarvis_push_subscriptions');
  assert.ok(stored.rows[0].encrypted_subscription.startsWith('sealed:'));
  await pool.query("UPDATE jarvis_push_subscriptions SET created_at=NOW()-INTERVAL '1 hour'");
  const add=async(done=false)=>{const {rows}=await pool.query("INSERT INTO memories(text,done,due_at) VALUES('Test reminder',$1,NOW()-INTERVAL '1 minute') RETURNING id",[done]);return rows[0].id;};
  await add();
  assert.equal((await service.processDue()).processed,1);assert.equal(sends,1);
  assert.equal((await service.processDue()).processed,0);assert.equal(sends,1);
  await add(true);await service.processDue();assert.equal(sends,1);
  status=503;const retry=await add();assert.equal((await service.processDue()).failed,1);
  await service.processDue();assert.equal(sends,2);
  await pool.query('UPDATE jarvis_push_deliveries SET next_attempt_at=NOW() WHERE memory_id=$1',[retry]);
  status=201;assert.equal((await service.processDue()).processed,1);
  status=410;await add();await service.processDue();
  assert.equal((await service.status()).devices,0);
  status=201;await service.subscribe(subscription);
  const before=sends;await service.processDue();assert.equal(sends,before);
  assert.ok((await service.status()).lastTick);
 }finally{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
});
