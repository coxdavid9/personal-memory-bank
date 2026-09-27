const crypto = require('crypto');

const decode = s => String(s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const tag = (xml, name) => {
  const m = String(xml).match(new RegExp('<[^>]*:?'+name+'\\b[^>]*>([\\s\\S]*?)<\\/[^>]*:?'+name+'>','i'));
  return m ? decode(m[1].trim()) : null;
};
const responses = xml => String(xml).match(/<[^>]*:?response\\b[^>]*>[\\s\\S]*?<\\/[^>]*:?response>/gi) || [];
const urlFor = (base, href) => new URL(decode(href), base).toString();
const esc = v => String(v || '').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\\r?\\n/g,'\\n');
const date = value => {
  const d = new Date(value); if (Number.isNaN(d.getTime())) throw new Error('Invalid calendar date.');
  const p=n=>String(n).padStart(2,'0');
  return d.getUTCFullYear()+p(d.getUTCMonth()+1)+p(d.getUTCDate())+'T'+p(d.getUTCHours())+p(d.getUTCMinutes())+p(d.getUTCSeconds())+'Z';
};
const day = value => {
  const d = new Date(value); if (Number.isNaN(d.getTime())) throw new Error('Invalid all-day calendar date.');
  const p=n=>String(n).padStart(2,'0');
  return d.getUTCFullYear()+p(d.getUTCMonth()+1)+p(d.getUTCDate());
};

function buildVEvent({title,start,end,notes,location,allDay,uid}) {
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//David Personal Agent//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','BEGIN:VEVENT',`UID:${uid}`,`DTSTAMP:${date(new Date())}`];
  if(allDay) lines.push(`DTSTART;VALUE=DATE:${day(start)}`,`DTEND;VALUE=DATE:${day(end)}`);
  else lines.push(`DTSTART:${date(start)}`,`DTEND:${date(end)}`);
  lines.push(`SUMMARY:${esc(title)}`);
  if(notes) lines.push(`DESCRIPTION:${esc(notes)}`);
  if(location) lines.push(`LOCATION:${esc(location)}`);
  return lines.concat(['END:VEVENT','END:VCALENDAR']).join('\\r\\n')+'\\r\\n';
}

class CalDAVClient {
  constructor({baseUrl,username,password,calendarName='Agent',calendarUrl='',fetchImpl=fetch}={}) {
    this.baseUrl=baseUrl?new URL(baseUrl).toString():'';
    this.username=username||''; this.password=password||'';
    this.calendarName=calendarName||'Agent';
    this.calendarUrl=calendarUrl?new URL(calendarUrl).toString():'';
    this.fetch=fetchImpl; this.discoveryPromise=null;
  }
  isConfigured(){return Boolean(this.baseUrl&&this.username&&this.password);}
  async request(url,options={}) {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),10000);
    try {
      return await this.fetch(url,{...options,signal:controller.signal,headers:{Authorization:'Basic '+Buffer.from(this.username+':'+this.password).toString('base64'),...(options.headers||{})}});
    } finally { clearTimeout(timer); }
  }
  async propfind(url,depth,body) {
    const r=await this.request(url,{method:'PROPFIND',headers:{Depth:String(depth),'Content-Type':'application/xml; charset=utf-8'},body});
    if(!r.ok&&r.status!==207) throw new Error(`CalDAV PROPFIND failed (${r.status}).`);
    return {xml:await r.text(),url:r.url||url};
  }
  async discover() {
    if(!this.isConfigured()) return null;
    if(this.calendarUrl) return this.calendarUrl;
    if(this.discoveryPromise) return this.discoveryPromise;
    this.discoveryPromise=(async()=>{
      try {
        const p=await this.propfind(this.baseUrl,0,'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>');
        const ph=tag(p.xml,'href'); if(!ph) throw new Error('CalDAV discovery did not return current-user-principal.');
        const principal=urlFor(p.url,ph);
        const h=await this.propfind(principal,0,'<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>');
        const hh=tag(h.xml,'href'); if(!hh) throw new Error('CalDAV discovery did not return calendar-home-set.');
        const home=urlFor(h.url,hh);
        const list=await this.propfind(home,1,'<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>');
        const candidates=responses(list.xml).map(x=>({href:tag(x,'href'),name:tag(x,'displayname'),calendar:/<[^>]*:?calendar\\b/i.test(x)})).filter(x=>x.href&&x.name&&x.calendar);
        const found=candidates.find(x=>x.name===this.calendarName);
        if(!found) throw new Error(`CalDAV calendar "${this.calendarName}" was not found.`);
        this.calendarUrl=urlFor(list.url||home,found.href); if(!this.calendarUrl.endsWith('/')) this.calendarUrl+='/';
        console.log(`CalDAV calendar discovered: ${found.name}`);
        return this.calendarUrl;
      } catch(err) { console.error(`CalDAV unavailable: ${err.message}`); this.calendarUrl=''; return null; }
    })();
    return this.discoveryPromise;
  }
  async createCalDAVEvent(event) {
    const calendar=await this.discover(); if(!calendar) throw new Error('CalDAV calendar is unavailable.');
    const uid=crypto.randomUUID()+'@personal-agent';
    const body=buildVEvent({...event,uid});
    const r=await this.request(new URL(encodeURIComponent(uid)+'.ics',calendar).toString(),{method:'PUT',headers:{'Content-Type':'text/calendar; charset=utf-8','If-None-Match':'*'},body});
    if(!r.ok) throw new Error(`CalDAV event write failed (${r.status}).`);
    return {uid,calendarName:this.calendarName};
  }
}
function buildCalDAVClientFromEnv(fetchImpl=fetch){
  const c=new CalDAVClient({baseUrl:process.env.CALDAV_BASE_URL,username:process.env.CALDAV_USERNAME,password:process.env.CALDAV_PASSWORD,calendarName:process.env.CALDAV_CALENDAR_NAME||'Agent',calendarUrl:process.env.CALDAV_CALENDAR_URL,fetchImpl});
  return c.isConfigured()?c:null;
}
module.exports={CalDAVClient,buildCalDAVClientFromEnv,buildVEvent};
