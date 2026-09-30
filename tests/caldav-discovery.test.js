const test=require('node:test');
const assert=require('node:assert/strict');
const {CalDAVClient}=require('../caldav');
function discoveryClient(calendarTag,calendarName='David Cox'){
 const replies=[
 '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/wrong-root/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>',
 '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/wrong-principal/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>',
 '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/home/calendar/</d:href><d:propstat><d:prop><d:displayname>David Cox</d:displayname><d:resourcetype><d:collection/>'+calendarTag+'</d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>',
 '<d:multistatus xmlns:d="DAV:"/>'
 ];
 const requests=[];
 const client=new CalDAVClient({baseUrl:'https://caldav.calendar.yahoo.com/',username:'u',password:'p',calendarName,fetchImpl:async(url,opts)=>{requests.push({url,method:opts.method});assert.ok(replies.length);return new Response(replies.shift(),{status:207});}});
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
 assert.equal((await client.testConnection()).status,'calendar_missing');
});
