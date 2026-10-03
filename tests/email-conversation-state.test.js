const test=require('node:test');const assert=require('node:assert/strict');const {annotateConversationState,normalizeSubject}=require('../email');
test('subject normalization joins reply threads',()=>assert.equal(normalizeSubject('Re: Fwd: Colson Next Steps'),'colson next steps'));
test('later sent reply marks incoming email waiting on them',()=>{const incoming=[{subject:'Colson Next Steps',date:'2026-10-02T10:00:00Z'}],sent=[{subject:'Re: Colson Next Steps',date:'2026-10-02T11:00:00Z'}];const r=annotateConversationState(incoming,sent);assert.equal(r[0].conversationState,'waiting_on_them');assert.equal(r[0].repliedAt,'2026-10-02T11:00:00Z');});
test('incoming without later reply remains waiting on David',()=>{const r=annotateConversationState([{subject:'Question',date:'2026-10-02T10:00:00Z'}],[{subject:'Re: Question',date:'2026-10-02T09:00:00Z'}]);assert.equal(r[0].conversationState,'waiting_on_you');});

test('matching subject sent to somebody else does not suppress an incoming message',()=>{
 const result=annotateConversationState([{subject:'Interview',senderAddress:'maria@example.com',date:'2026-10-02T10:00:00Z'}],[{subject:'Re: Interview',recipients:['other@example.com'],date:'2026-10-02T11:00:00Z'}]);assert.equal(result[0].conversationState,'waiting_on_you');
});
test('a new incoming message after a reply becomes actionable again',()=>{
 const result=annotateConversationState([{subject:'Interview',senderAddress:'maria@example.com',date:'2026-10-02T12:00:00Z'}],[{subject:'Re: Interview',recipients:['maria@example.com'],date:'2026-10-02T11:00:00Z'}]);assert.equal(result[0].conversationState,'waiting_on_you');
});
test('failed sent scan is unknown, not proof that no reply was sent',()=>assert.equal(annotateConversationState([{subject:'Question'}],[],{sentVerified:false})[0].conversationState,'unknown'));
test('reply headers can match a changed subject',()=>assert.equal(annotateConversationState([{messageId:'<original>',subject:'Interview',date:'2026-10-02T10:00:00Z'}],[{inReplyTo:'<original>',subject:'Updated next step',date:'2026-10-02T11:00:00Z'}])[0].conversationState,'waiting_on_them'));
