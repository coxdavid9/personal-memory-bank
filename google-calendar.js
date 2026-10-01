class GoogleCalendarClient {
 constructor({getAccessToken,fetchFn=global.fetch}={}){this.getAccessToken=getAccessToken;this.fetchFn=fetchFn;}
 isConfigured(){return Boolean(this.getAccessToken);}
 async request(path){const token=await this.getAccessToken();const r=await this.fetchFn('https://www.googleapis.com/calendar/v3'+path,{headers:{Authorization:'Bearer '+token}});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data?.error?.message||('Google Calendar API request failed ('+r.status+').'));return data;}
 async testConnection(){if(!this.isConfigured())return{connected:false,status:'not_configured'};try{await this.request('/users/me/calendarList?maxResults=1');return{connected:true,status:'connected'};}catch(err){return{connected:false,status:'connection_failed',message:err.message};}}
 async listUpcomingEvents({days=2}={}){const n=Math.min(14,Math.max(1,Number(days)||2));const start=new Date(),end=new Date(start.getTime()+n*86400000);const q=new URLSearchParams({timeMin:start.toISOString(),timeMax:end.toISOString(),singleEvents:'true',orderBy:'startTime',maxResults:'50'});const data=await this.request('/calendars/primary/events?'+q);return(data.items||[]).filter(e=>e.status!=='cancelled').map(e=>({id:e.id,title:e.summary||'(No title)',start:e.start?.dateTime||e.start?.date,end:e.end?.dateTime||e.end?.date,location:e.location||null,source:'work Google Calendar'}));}
}
module.exports={GoogleCalendarClient};
