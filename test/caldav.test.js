const test = require('node:test');
test('calendar records expose creation time and fall back to legacy Jarvis DTSTAMP',async()=>{
 const {CalDAVClient,buildVEvent}=require('../caldav');
 const blocks=['CREATED:20261006T154100Z\nDTSTAMP:20261006T160000Z','DTSTAMP:20261006T154100Z',''];
 for(const [i,stamp] of blocks.entries()){
  const xml='<multistatus xmlns="DAV:"><response><propstat><prop><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">BEGIN:VEVENT\nUID:test@personal-agent\nDTSTART:20261006T190000Z\nSUMMARY:Interview\n'+stamp+'\nEND:VEVENT</calendar-data></prop></propstat></response></multistatus>';
  const c=new CalDAVClient({baseUrl:'https://calendar.example/',username:'u',password:'p',calendarUrl:'https://calendar.example/cal/',fetchImpl:async()=>new Response(xml,{status:207})});
  const events=await c.listUpcomingEvents();assert.equal(events[0].recordedAt,i===2?null:'2026-10-06T15:41:00Z');
 }
 assert.match(buildVEvent({title:'Interview',start:'2026-10-06T19:00:00Z',end:'2026-10-06T19:30:00Z',uid:'test'}),/\r\nCREATED:\d{8}T\d{6}Z\r\n/);
});
const assert = require('node:assert/strict');
const { buildVEvent } = require('../caldav');

test('builds a parseable timed VEVENT with UTC timestamps and escaped text', () => {
  const ics = buildVEvent({
    uid: 'test-uid@personal-agent',
    title: 'Work, on Personal Agent',
    start: '2026-09-28T14:00:00.000Z',
    end: '2026-09-28T15:00:00.000Z',
    notes: 'Line one\nLine two; keep this',
    location: 'Home, office',
    allDay: false,
  });
  assert.match(ics, /UID:test-uid@personal-agent/);
  assert.ok(ics.includes('\r\n'));
  assert.match(ics, /DTSTART:20260928T140000Z/);
  assert.match(ics, /DTEND:20260928T150000Z/);
  assert.ok(ics.includes('SUMMARY:Work\\, on Personal Agent'));
  assert.ok(ics.includes('DESCRIPTION:Line one\\nLine two\\; keep this'));
  assert.ok(ics.includes('LOCATION:Home\\, office'));
});

test('builds an all-day VEVENT with an exclusive DTEND date', () => {
  const ics = buildVEvent({
    uid: 'all-day@personal-agent',
    title: 'Vacation',
    start: '2026-09-28T00:00:00.000Z',
    end: '2026-09-29T00:00:00.000Z',
    notes: null,
    location: null,
    allDay: true,
  });
  assert.match(ics, /DTSTART;VALUE=DATE:20260928/);
  assert.match(ics, /DTEND;VALUE=DATE:20260929/);
  assert.match(ics, /UID:all-day@personal-agent/);
});

test('lists upcoming VEVENTs from a CalDAV REPORT response', async () => {
 const {CalDAVClient}=require('../caldav'); const client=new CalDAVClient({baseUrl:'https://cal.example.test/',username:'u',password:'p',calendarUrl:'https://cal.example.test/cal/',fetchImpl:async()=>new Response('<multistatus xmlns="DAV:"><response><propstat><prop><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:one\nDTSTART:20260930T140000Z\nDTEND:20260930T150000Z\nSUMMARY:Interview\nLOCATION:Jonesboro\nEND:VEVENT\nEND:VCALENDAR</calendar-data></prop></propstat></response></multistatus>',{status:207})});
 const events=await client.listUpcomingEvents({days:2}); assert.equal(events.length,1); assert.equal(events[0].title,'Interview'); assert.equal(events[0].start,'2026-09-30T14:00:00Z'); assert.equal(events[0].location,'Jonesboro');
});


test('iCloud discovery falls back to the well-known CalDAV endpoint when root rejects PROPFIND', async () => {
  const { CalDAVClient } = require('../caldav');
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url:String(url), method:options.method });
    if (String(url) === 'https://caldav.icloud.com/') return new Response('bad request', {status:400});
    if (String(url) === 'https://caldav.icloud.com/.well-known/caldav') {
      return new Response('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>', {status:207});
    }
    if (String(url) === 'https://caldav.icloud.com/123/principal/') {
      return new Response('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop><c:calendar-home-set><d:href>/123/calendars/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>', {status:207});
    }
    if (String(url) === 'https://caldav.icloud.com/123/calendars/') {
      return new Response('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/123/calendars/agent/</d:href><d:propstat><d:prop><d:displayname>Agent</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>', {status:207});
    }
    throw new Error('Unexpected URL: ' + url);
  };
  const client = new CalDAVClient({baseUrl:'https://caldav.icloud.com/',username:'u',password:'p',calendarName:'Agent',fetchImpl});
  const calendar = await client.discover();
  assert.equal(calendar, 'https://caldav.icloud.com/123/calendars/agent/');
  assert.deepEqual(calls.slice(0,2).map(x=>x.url), ['https://caldav.icloud.com/','https://caldav.icloud.com/.well-known/caldav']);
});
