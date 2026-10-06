const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('service worker displays pushes with a stable tag and opens only Jarvis',async()=>{
 const handlers={},notifications=[],opened=[];
 const self={location:{origin:'https://jarvis.example'},registration:{showNotification:async(...args)=>notifications.push(args)},
  clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url),claim:async()=>{}},skipWaiting:()=>{},
  addEventListener:(name,handler)=>handlers[name]=handler};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/sw.js'),'utf8'),{self,URL,fetch});
 let waiting;handlers.push({data:{json:()=>({title:'Reminder',body:'Call David',tag:'stable',url:'https://evil.example'})},waitUntil:p=>waiting=p});await waiting;
 assert.equal(notifications[0][1].tag,'stable');assert.equal(notifications[0][1].data.url,'/');
 handlers.notificationclick({notification:{close:()=>{}},waitUntil:p=>waiting=p});await waiting;assert.deepEqual(opened,['/']);
 handlers.push({data:{json:()=>{throw new Error('Malformed');}},waitUntil:p=>waiting=p});await waiting;
 assert.equal(notifications[1][0],'Jarvis');
});
test('iPhone permission is requested from the tap and failed registration unsubscribes',async()=>{
 const nodes=Object.fromEntries(['pushSettings','pushStatus','pushEnable','pushTest','pushDisable'].map(id=>[id,{hidden:false,disabled:false}]));
 const section={classList:{contains:()=>false}};nodes.pushSettings.closest=()=>section;
 let observer,permissionRequested=false,unsubscribed=false;
 const sub={toJSON:()=>({endpoint:'device'}),unsubscribe:async()=>{unsubscribed=true;}};
 const registration={pushManager:{getSubscription:async()=>null,subscribe:async()=>sub}};
 const context={document:{getElementById:id=>nodes[id]},window:{matchMedia:()=>({matches:true}),PushManager:function(){}},
  navigator:{userAgent:'iPhone',standalone:true,serviceWorker:{register:async()=>registration,ready:Promise.resolve(registration)}},
  Notification:{permission:'default',requestPermission:()=>{permissionRequested=true;return Promise.resolve('granted');}},
  MutationObserver:class{constructor(fn){observer=fn;}observe(){}},
  atob:s=>Buffer.from(s,'base64').toString('binary'),Uint8Array,
  fetch:async url=>({ok:!url.endsWith('/subscribe'),json:async()=>url.endsWith('/config')?{available:true,publicKey:Buffer.alloc(65).toString('base64url')}:{error:'Rejected'}})};
 context.window.Notification=context.Notification;
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/push-ui.js'),'utf8'),context);
 observer();await new Promise(r=>setImmediate(r));
 const action=nodes.pushEnable.onclick();assert.equal(permissionRequested,true);await action;
 assert.equal(unsubscribed,true);assert.equal(nodes.pushStatus.textContent,'Rejected');
 assert.equal(nodes.pushEnable.hidden,false);
});
