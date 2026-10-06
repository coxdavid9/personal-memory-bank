(function(){
  const panel=document.getElementById('pushSettings');
  const message=document.getElementById('pushStatus');
  const enable=document.getElementById('pushEnable');
  const test=document.getElementById('pushTest');
  const disable=document.getElementById('pushDisable');
  let config,registration,subscription,busy=false;
  const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const installed=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone;
  function show(text){message.textContent=text;}
  async function request(path,body){
    const r=await fetch('/api/push/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    const data=await r.json();if(!r.ok)throw new Error(data.error||'Notifications are unavailable.');return data;
  }
  function buttons(){enable.hidden=Boolean(subscription);test.hidden=disable.hidden=!subscription;}
  function keyBytes(key){return Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
  async function refresh(){
    if(ios&&!installed){show('On iPhone, add Jarvis to your Home Screen using Share → Add to Home Screen. Open that icon to enable notifications.');enable.hidden=true;return;}
    if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window)){show('This browser does not support Jarvis notifications.');enable.hidden=true;return;}
    try{
      config=await request('config');
      if(!config.available){show('Notification setup is unavailable.');enable.hidden=true;return;}
      registration=await navigator.serviceWorker.register('/sw.js');
      registration=await navigator.serviceWorker.ready;
      subscription=await registration.pushManager.getSubscription();
      buttons();
      show(Notification.permission==='denied'?'Notifications are blocked. Allow Jarvis notifications in your device settings.':
        subscription?'Enabled on this device. '+config.timing:'Enable reminders directly from Jarvis. No second app needed.');
    }catch(e){show(e.message);}
  }
  async function action(fn){if(busy)return;busy=true;enable.disabled=test.disabled=disable.disabled=true;
    try{await fn();}catch(e){show(e.message);}finally{busy=false;enable.disabled=test.disabled=disable.disabled=false;buttons();}}
  enable.onclick=()=>action(async()=>{
    // Call permission directly from the user's tap before awaiting network requests.
    const permission=await Notification.requestPermission();
    if(permission!=='granted')throw new Error('Notifications were not enabled. You can change permission in device settings.');
    if(!registration||!config)throw new Error('Wait for notification setup to finish, then try again.');
    subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(config.publicKey)});
    try{await request('subscribe',{subscription:subscription.toJSON()});}
    catch(e){await subscription.unsubscribe();subscription=null;throw e;}
    show('Enabled. Tap Send test, then lock your phone. '+config.timing);
  });
  test.onclick=()=>action(async()=>{await request('test',{subscription:subscription.toJSON()});show('Test accepted by the push service. Check your notifications to confirm it arrived.');});
  disable.onclick=()=>action(async()=>{await request('unsubscribe',{subscription:subscription.toJSON()});await subscription.unsubscribe();subscription=null;show('Notifications disabled on this device.');});
  // Load only when Settings is opened, rather than querying on a polling timer.
  new MutationObserver(()=>{if(!panel.closest('.drawer-view').classList.contains('hidden'))refresh();}).observe(panel.closest('.drawer-view'),{attributes:true,attributeFilter:['class']});
})();
