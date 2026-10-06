self.addEventListener("install", event => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request));
});
self.addEventListener('push',event=>{
  let data={};try{data=event.data?.json()||{};}catch{}
  event.waitUntil(self.registration.showNotification(String(data.title||'Jarvis').slice(0,80),{
    body:String(data.body||'Open Jarvis to see your reminder.').slice(0,200),
    tag:String(data.tag||'jarvis').slice(0,150),data:{url:'/'}
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const app=windows.find(client=>new URL(client.url).origin===self.location.origin);
    if(app)return app.focus();
    return self.clients.openWindow('/');
  })());
});
