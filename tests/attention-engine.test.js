const test=require('node:test');const assert=require('node:assert/strict');const {buildAttentionCandidates}=require('../attention-engine');
const empty={memories:[],jobs:[],github:{items:[]},email:{yahoo:[],gmail:[]},calendar:{personal:[],work:[]},market:{material:[]},approvals:[]};
const invitation={subject:'Robert Half Interview - David Cox',date:'2026-10-06T14:00:00Z',conversationState:'waiting_on_you'};
const interview={uid:'test@personal-agent',title:'Robert Half Interview — David Cox',start:'2026-10-06T19:00:00Z',end:'2026-10-06T19:30:00Z',recordedAt:'2026-10-06T15:41:00Z'};
function invitationFeed(email=invitation,event=interview){return buildAttentionCandidates({...empty,email:{yahoo:[email]},calendar:{personal:[event]}},new Date('2026-10-06T18:00:00Z'));}
test('calendared Robert Half invitation needs no reply review but meeting preparation remains',()=>{
 const items=invitationFeed();assert.ok(!items.some(x=>x.domain==='email'));assert.ok(items.some(x=>x.domain==='calendar'));
});
test('explicit reply requests and later messages still surface for calendared meetings',()=>{
 for(const email of [{...invitation,snippet:'Please confirm your attendance'},{...invitation,snippet:'Action required: complete forms'},{...invitation,date:'2026-10-06T16:00:00Z'},{...invitation,subject:'Nestlé Interview - Availability Request'},{...invitation,subject:'Updated Robert Half Interview - David Cox'}])assert.ok(invitationFeed(email).some(x=>x.domain==='email'));
});
test('missing timestamps and unrelated or external events never suppress an invitation',()=>{
 for(const event of [{...interview,recordedAt:null},{...interview,uid:'external-event'},{...interview,title:'Other interview'},{...interview,recordedAt:'invalid'}])assert.ok(invitationFeed(invitation,event).some(x=>x.domain==='email'));
 assert.ok(invitationFeed({...invitation,date:null}).some(x=>x.domain==='email'));
 const items=buildAttentionCandidates({...empty,email:{yahoo:[invitation]},calendar:{work:[interview]}},new Date('2026-10-06T18:00:00Z'));assert.ok(items.some(x=>x.domain==='email'));
});
test('saved job alone is not an attention candidate',()=>{const c=buildAttentionCandidates({...empty,jobs:[{title:'CAS Accounting Manager',company:'Adams Brown',status:'saved'}]},new Date('2026-10-02T19:00:00Z'));assert.deepEqual(c,[]);});
test('unanswered email competes across domains',()=>{const c=buildAttentionCandidates({...empty,email:{yahoo:[{subject:'Need your answer',date:'2026-10-02T18:00:00Z',conversationState:'waiting_on_you'}],gmail:[]}},new Date('2026-10-02T19:00:00Z'));assert.equal(c[0].domain,'email');});
test('handled email is excluded',()=>{const c=buildAttentionCandidates({...empty,email:{yahoo:[{subject:'Need your answer',conversationState:'waiting_on_them'}],gmail:[]}},new Date('2026-10-02T19:00:00Z'));assert.deepEqual(c,[]);});
test('calendar soon outranks routine email and Busy is ignored',()=>{const c=buildAttentionCandidates({...empty,email:{yahoo:[{subject:'Hello',conversationState:'waiting_on_you'}],gmail:[]},calendar:{personal:[],work:[{title:'Interview',start:'2026-10-02T19:30:00Z',end:'2026-10-02T20:00:00Z'},{title:'Busy',start:'2026-10-02T19:30:00Z',end:'2026-10-02T20:00:00Z'}]}},new Date('2026-10-02T19:00:00Z'));assert.equal(c[0].domain,'calendar');assert.ok(!c.some(x=>/Busy/.test(x.text)));});


test('verified PROJECT_STATUS next milestone becomes a productive attention candidate',()=>{const ctx={github:{projects:[{repository:'coxdavid9/CMA-Agent',projectDoc:{path:'PROJECT_STATUS.md',content:'# CMA Coach Project Status\n\n## Next milestone\n**Build reviewed questions for Corporate Finance and Professional Ethics without duplicating active tasks.**\n'}}]}};const items=buildAttentionCandidates(ctx,new Date('2026-10-02T15:00:00Z'));const item=items.find(x=>x.domain==='project');assert.ok(item);assert.match(item.text,/Corporate Finance and Professional Ethics/);assert.match(item.why,/CMA-Agent/);});

test('urgent live attention outranks productive project work',()=>{const ctx={approvals:[{skill:'calendar.create',expiresAt:'2026-10-02T16:00:00Z'}],github:{projects:[{repository:'coxdavid9/CMA-Agent',projectDoc:{path:'PROJECT_STATUS.md',content:'## Next milestone\n**Improve CMA coverage.**'}}]}};const items=buildAttentionCandidates(ctx,new Date('2026-10-02T15:00:00Z'));assert.equal(items[0].domain,'approval');assert.equal(items.find(x=>x.domain==='project').score,55);});


test('structured living project state is preferred over markdown fallback',()=>{const items=buildAttentionCandidates({github:{projects:[{repository:'coxdavid9/clearcfo',projectState:{nextActions:['Audit live launch readiness and record blockers.']},projectDoc:{path:'PROJECT_STATUS.md',content:'## Next milestone\n**Old fallback.**'}}]}},new Date('2026-10-03T15:00:00Z'));assert.equal(items.find(x=>x.domain==='project').text,'Audit live launch readiness and record blockers.');});
