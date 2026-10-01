const crypto = require('crypto');

const decode = s => String(s)
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

const tag = (xml, name) => {
  const re = new RegExp('<(?:[^>]*:)?' + name + '\\b[^>]*>([\\s\\S]*?)</(?:[^>]*:)?' + name + '>', 'i');
  const m = String(xml).match(re);
  return m ? decode(m[1].trim()) : null;
};

// Match the element's qualified name, never colons inside xmlns attributes.
const responses = xml => {
  const text = String(xml);
  const out = [];
  const open = /<((?:[A-Za-z_][\w.-]*:)?response)\b[^>]*>/gi;
  let match;
  while ((match = open.exec(text))) {
    const close = '</' + match[1] + '>';
    const end = text.toLowerCase().indexOf(close.toLowerCase(), open.lastIndex);
    if (end < 0) break;
    out.push(text.slice(match.index, end + close.length));
    open.lastIndex = end + close.length;
  }
  return out;
};

const urlFor = (base, href) => new URL(decode(href), base).toString();

const esc = v => String(v || '')
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

const date = value => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid calendar date.');
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
};

const day = value => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid all-day calendar date.');
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
};

function buildVEvent({ title, start, end, notes, location, allDay, uid }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//David Personal Agent//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${date(new Date())}`
  ];

  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${day(start)}`, `DTEND;VALUE=DATE:${day(end)}`);
  } else {
    lines.push(`DTSTART:${date(start)}`, `DTEND:${date(end)}`);
  }

  lines.push(`SUMMARY:${esc(title)}`);
  if (notes) lines.push(`DESCRIPTION:${esc(notes)}`);
  if (location) lines.push(`LOCATION:${esc(location)}`);

  return lines.concat(['END:VEVENT', 'END:VCALENDAR']).join('\r\n') + '\r\n';
}

class CalDAVClient {
  constructor({ baseUrl, username, password, calendarName = 'Agent', calendarUrl = '', fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl ? new URL(baseUrl).toString() : '';
    this.username = username || '';
    this.password = password || '';
    this.calendarName = calendarName || 'Agent';
    this.calendarUrl = calendarUrl ? new URL(calendarUrl).toString() : '';
    this.fetch = fetchImpl;
    this.discoveryPromise = null;
    this.discoveryError = null;
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.username && this.password);
  }

  async request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      return await this.fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: 'Basic ' + Buffer.from(this.username + ':' + this.password).toString('base64'),
          ...(options.headers || {})
        }
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async propfind(url, depth, body) {
    const r = await this.request(url, {
      method: 'PROPFIND',
      headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
      body
    });
    if (!r.ok && r.status !== 207) throw Object.assign(new Error('CalDAV discovery failed.'), { status: r.status });
    return { xml: await r.text(), url: r.url || url };
  }

  async discover() {
    if (!this.isConfigured()) return null;
    if (this.calendarUrl) return this.calendarUrl;
    if (this.discoveryPromise) return this.discoveryPromise;

    this.discoveryPromise = (async () => {
      try {
        const principalBody = '<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
        const discoveryUrls = [this.baseUrl];
        if (this.providerName() === 'iCloud Calendar') {
          const wellKnown = new URL('/.well-known/caldav', this.baseUrl).toString();
          if (!discoveryUrls.includes(wellKnown)) discoveryUrls.push(wellKnown);
        }

        let p = null;
        let discoveryFailure = null;
        for (const discoveryUrl of discoveryUrls) {
          try {
            p = await this.propfind(discoveryUrl, 0, principalBody);
            const candidatePrincipal = tag(tag(p.xml, 'current-user-principal') || '', 'href');
            if (candidatePrincipal) break;
            discoveryFailure = new Error('CalDAV discovery did not return current-user-principal.');
            p = null;
          } catch (err) {
            discoveryFailure = err;
            p = null;
          }
        }
        if (!p) throw discoveryFailure || new Error('CalDAV discovery failed.');
        const ph = tag(tag(p.xml, 'current-user-principal') || '', 'href');
        if (!ph) throw new Error('CalDAV discovery did not return current-user-principal.');

        const principal = urlFor(p.url, ph);
        const h = await this.propfind(
          principal,
          0,
          '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>'
        );
        const hh = tag(tag(h.xml, 'calendar-home-set') || '', 'href');
        if (!hh) throw new Error('CalDAV discovery did not return calendar-home-set.');

        const home = urlFor(h.url, hh);
        const list = await this.propfind(
          home,
          1,
          '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>'
        );

        const candidates = responses(list.xml)
          .map(x => ({
            href: tag(x, 'href'),
            name: tag(x, 'displayname'),
            calendar: /<(?:[^>]*:)?calendar(?:\s|\/?>)/i.test(x)
          }))
          .filter(x => x.href && x.name && x.calendar);

        if (!candidates.length) throw Object.assign(new Error('CalDAV returned no discoverable calendars.'), {
          code:'discovery_empty',
          diagnostics:{responseCount:responses(list.xml).length, namedResponseCount:responses(list.xml).filter(x=>tag(x,'displayname')).length}
        });
        const found = candidates.find(x => x.name === this.calendarName);
        if (!found) throw Object.assign(new Error(`CalDAV calendar "${this.calendarName}" was not found.`), { availableCalendars:candidates.map(x=>x.name) });

        this.discoveryError = null;
        this.calendarUrl = urlFor(list.url || home, found.href);
        if (!this.calendarUrl.endsWith('/')) this.calendarUrl += '/';
        console.log(`CalDAV calendar discovered: ${found.name}`);
        return this.calendarUrl;
      } catch (err) {
        this.discoveryError = err;
        console.error('CalDAV discovery failed.');
        this.calendarUrl = '';
        this.discoveryPromise = null;
        return null;
      }
    })();

    return this.discoveryPromise;
  }

  async listUpcomingEvents({ days = 2 } = {}) {
    const calendar = await this.discover(); if (!calendar) throw this.discoveryError || new Error('CalDAV is not configured.');
    const safeDays = Math.min(14, Math.max(1, Number(days) || 2)); const start = new Date(); const end = new Date(start.getTime() + safeDays * 24 * 60 * 60 * 1000);
    const toCalDavUtc = value => { const d = new Date(value); const p=n=>String(n).padStart(2,'0'); return d.getUTCFullYear()+p(d.getUTCMonth()+1)+p(d.getUTCDate())+'T'+p(d.getUTCHours())+p(d.getUTCMinutes())+p(d.getUTCSeconds())+'Z'; };
    const body = '<?xml version="1.0" encoding="UTF-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="'+toCalDavUtc(start)+'" end="'+toCalDavUtc(end)+'"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
    const r=await this.request(calendar,{method:'REPORT',headers:{Depth:'1','Content-Type':'application/xml; charset=utf-8'},body}); if(!r.ok&&r.status!==207) throw Object.assign(new Error('CalDAV read failed.'), { status:r.status });
    const xml=await r.text();
    const parseDateValue=(raw,tzid=null)=>{const value=String(raw||'').trim();if(!value)return null;if(/^\d{8}$/.test(value))return value.slice(0,4)+'-'+value.slice(4,6)+'-'+value.slice(6,8);const m=value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);if(!m)return value;const iso=m[1]+'-'+m[2]+'-'+m[3]+'T'+m[4]+':'+m[5]+':'+m[6];return m[7]?iso+'Z':iso+(tzid?'['+tzid+']':'');};
    const unfold=text=>String(text||'').replace(/\r?\n[ \t]/g,''); const events=[];
    for(const response of responses(xml)){const calendarData=tag(response,'calendar-data');if(!calendarData)continue;const data=unfold(calendarData);const matches=data.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi)||[];
      for(const block of matches){const line=name=>{const re=new RegExp('(?:^|\\n)'+name+'(?:;([^:]*))?:([^\\n]*)','i');const m=block.match(re);return m?{value:m[2].trim(),params:m[1]||''}:null;};const getTz=e=>e&&e.params.match(/(?:^|;)TZID=([^;:]+)/i)?.[1]||null;const summary=line('SUMMARY'),dtstart=line('DTSTART'),dtend=line('DTEND'),location=line('LOCATION'),uid=line('UID');if(!dtstart)continue;events.push({uid:uid?.value||null,title:summary?.value||'(Untitled event)',start:parseDateValue(dtstart.value,getTz(dtstart)),end:dtend?parseDateValue(dtend.value,getTz(dtend)):null,location:location?.value||null,timezone:getTz(dtstart)});}
    } return events.sort((a,b)=>String(a.start).localeCompare(String(b.start)));
  }

  providerName() {
    const host = this.baseUrl ? new URL(this.baseUrl).hostname : '';
    return host === 'caldav.calendar.yahoo.com' ? 'Yahoo Calendar' :
      host === 'caldav.icloud.com' || host.endsWith('.icloud.com') ? 'iCloud Calendar' : 'CalDAV Calendar';
  }

  async testConnection() {
    const provider = this.providerName();
    if (!this.isConfigured()) return { connected:false, status:'not_configured', provider };
    try {
      await this.listUpcomingEvents({days:1});
      return { connected:true, status:'connected', provider, calendarName:this.calendarName, scope:'Reads and writes the configured calendar only.' };
    } catch (err) {
      const status = [401,403].includes(err.status) ? 'authentication_failed' :
        err.code === 'discovery_empty' ? 'discovery_empty' :
        /was not found/.test(err.message || '') ? 'calendar_missing' : 'connection_failed';
      return { connected:false, status, provider, calendarName:this.calendarName,
        ...(status === 'calendar_missing' ? {availableCalendars:err.availableCalendars || []} : {}),
        ...(status === 'discovery_empty' ? {diagnostics:err.diagnostics} : {}),
        message:status === 'authentication_failed' ? 'Check the calendar account username and provider-generated app password in Render.' :
          status === 'discovery_empty' ? 'No calendar collections could be discovered. This does not establish that the configured name is wrong. Keep the calendar name unchanged and check discovery diagnostics.' :
          status === 'calendar_missing' ? 'Set CALDAV_CALENDAR_NAME to an exact name from availableCalendars. Do not change providers or create another calendar unless requested.' :
            'The configured calendar service could not be reached or read. Check the CalDAV URL and try again.' };
    }
  }

  async createCalDAVEvent(event) {
    const calendar = await this.discover();
    if (!calendar) throw new Error('CalDAV calendar is unavailable.');

    const uid = crypto.randomUUID() + '@personal-agent';
    const body = buildVEvent({ ...event, uid });
    const r = await this.request(
      new URL(encodeURIComponent(uid) + '.ics', calendar).toString(),
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'If-None-Match': '*'
        },
        body
      }
    );

    if (!r.ok) throw new Error(`CalDAV event write failed (${r.status}).`);
    return { uid, calendarName: this.calendarName };
  }
}

function buildCalDAVClientFromEnv(fetchImpl = fetch) {
  const c = new CalDAVClient({
    baseUrl: process.env.CALDAV_BASE_URL,
    username: process.env.CALDAV_USERNAME,
    password: process.env.CALDAV_PASSWORD,
    calendarName: process.env.CALDAV_CALENDAR_NAME || 'Agent',
    calendarUrl: process.env.CALDAV_CALENDAR_URL,
    fetchImpl
  });
  return c.isConfigured() ? c : null;
}

module.exports = { CalDAVClient, buildCalDAVClientFromEnv, buildVEvent };
