const test=require('node:test');
const assert=require('node:assert/strict');
const {CalDAVClient}=require('../caldav');
function discoveryClient(calendarTag,calendarName='David Cox',defaultNamespace=false){
 const replies=[
 '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/wrong-root/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>',
 '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/wrong-principal/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>',
 '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/home/calendar/</d:href><d:propstat><d:prop><d:displayname>David Cox</d:displayname><d:resourcetype><d:collection/>'+calendarTag+'</d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>',
 '<d:multistatus xmlns:d="DAV:"/>'
 ];
 const requests=[];
 const client=new CalDAVClient({baseUrl:'https://caldav.calendar.yahoo.com/',username:'u',password:'p',calendarName,fetchImpl:async(url,opts)=>{requests.push({url,method:opts.method});assert.ok(replies.length);let xml=replies.shift();if(defaultNamespace)xml=xml.replace(/<d:response>/g,'<response xmlns="DAV:">').replace(/<\/d:response>/g,'</response>');return new Response(xml,{status:207});}});
 return {client,requests};
}
for(const marker of ['<c:calendar/>','<c:calendar />','<c:calendar></c:calendar>']){
 test('discovery recognizes calendar resource '+marker,async()=>{
 const {client,requests}=discoveryClient(marker);
 const result=await client.testConnection();
 assert.equal(result.status,'connected');
 assert.equal(result.provider,'Yahoo Calendar');
 assert.deepEqual(requests.map(r=>new URL(r.url).pathname),['/','/principal/','/home/','/home/calendar/']);
 });
}
test('missing calendar reports actual provider and existing names',async()=>{
 const {client}=discoveryClient('<c:calendar/>','Yahoo');
 const result=await client.testConnection();
 assert.equal(result.status,'calendar_missing');
 assert.equal(result.provider,'Yahoo Calendar');
 assert.deepEqual(result.availableCalendars,['David Cox']);
 assert.ok(!JSON.stringify(result).includes('iCloud'));
});
test('discovery does not mistake calendar-data for calendar resource',async()=>{
 const {client}=discoveryClient('<c:calendar-data/>');
 assert.equal((await client.testConnection()).status,'discovery_empty');
});

test('discovers responses with per-element default DAV namespace',async()=>{
 const {client}=discoveryClient('<c:calendar/>','David Cox',true);
 assert.equal((await client.testConnection()).status,'connected');
});
test('default namespace response still reports available names on a mismatch',async()=>{
 const {client}=discoveryClient('<c:calendar/>','Other',true);
 assert.deepEqual((await client.testConnection()).availableCalendars,['David Cox']);
});
test('no calendar collections is a discovery failure, not a name mismatch',async()=>{
 const {client}=discoveryClient('<c:calendar-data/>');
 const result=await client.testConnection();
 assert.equal(result.status,'discovery_empty');
 assert.deepEqual(result.diagnostics,{responseCount:1,namedResponseCount:1});
});
test('REPORT parses multiple responses declaring namespaces on each element',async()=>{
 const event=uid=>'<response xmlns="DAV:"><propstat><prop><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:'+uid+'\nDTSTART:20261001T190000Z\nSUMMARY:Interview\nEND:VEVENT\nEND:VCALENDAR</calendar-data></prop></propstat></response>';
 const client=new CalDAVClient({baseUrl:'https://caldav.calendar.yahoo.com/',username:'u',password:'p',calendarUrl:'https://caldav.calendar.yahoo.com/cal/',fetchImpl:async()=>new Response('<multistatus xmlns="DAV:">'+event('one')+event('two')+'</multistatus>',{status:207})});
 assert.deepEqual((await client.listUpcomingEvents()).map(e=>e.uid),['one','two']);
});
