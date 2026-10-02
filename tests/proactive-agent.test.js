const test=require('node:test');const assert=require('node:assert/strict');const {collectProactiveSignals,runProactiveCheck}=require('../proactive-agent');

test('proactive signals stay silent for routine context',()=>{assert.deepEqual(collectProactiveSignals({priorityContext:{approvals:[],market:{material:[]},email:{yahoo:[],gmail:[]}}}),[])});

test('proactive signals elevate security email',()=>{const s=collectProactiveSignals({priorityContext:{approvals:[],market:{material:[]},email:{yahoo:[{subject:'Urgent: confirm this purchase attempt'}],gmail:[]}}});assert.equal(s[0].kind,'email');});

test('proactive check deduplicates an already notified state',async()=>{const queries=[];const pool={query:async(sql,args)=>{queries.push([sql,args]);if(sql.startsWith('SELECT'))return{rows:[{attention_key:require('../proactive-agent').signalKey([{kind:'email',priority:95,title:'Security alert',detail:'A recent message appears to require prompt verification or action.'}]),notification_sent:true}]};return{rows:[]}}};const context={priorityContext:{approvals:[],market:{material:[]},email:{yahoo:[{subject:'Security alert'}],gmail:[]}}};let sent=0;const r=await runProactiveCheck({pool,getContext:async()=>context,notify:async()=>{sent++}});assert.equal(r.notify,false);assert.equal(sent,0);});
