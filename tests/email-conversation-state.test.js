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
test('routine account confirmations stay out of action feed, security failures remain',()=>{
 const {isActionableEmail}=require('../email');assert.equal(isActionableEmail({subject:'Your trade confirmation',senderAddress:'service@fidelity.com'}),false);assert.equal(isActionableEmail({subject:'Payment failed — action required',senderAddress:'no-reply@bank.com'}),true);
});
test('welcome and created-account confirmations are not priority actions',()=>{
 const {isActionableEmail}=require('../email');
 for(const subject of ['Welcome To Our Family',"You've successfully created an online account!",'Your online account was created'])assert.equal(isActionableEmail({subject,senderAddress:'service@example.com'}),false,subject);
});
test('routine statement-ready subjects are excluded, security and required actions preserved',()=>{
 const {isActionableEmail}=require('../email');const {buildAttentionCandidates}=require('../attention-engine');
 for(const subject of ['Your latest bank statement is ready','Your statement is now ready','Your statement is available','Your statement ready']){
  assert.equal(isActionableEmail({subject}),false,subject);
  assert.deepEqual(buildAttentionCandidates({email:{yahoo:[{subject}]}}),[]);
 }
 assert.equal(isActionableEmail({subject:'Your latest bank statement is ready — action required'}),true);
 assert.equal(isActionableEmail({subject:'Your latest bank statement is ready',snippet:'Security alert: unauthorized transaction'}),true);
});
test('welcome messages with explicit required steps still surface',()=>{
 const {isActionableEmail}=require('../email');
 assert.equal(isActionableEmail({subject:'Welcome to Example — verify your email',senderAddress:'no-reply@example.com'}),true);
 assert.equal(isActionableEmail({subject:'Welcome To Our Family',snippet:'Please complete the required forms before Monday.'}),true);
 assert.equal(isActionableEmail({subject:"You've created an online account!",snippet:'Activate your account to finish.'}),true);
 assert.equal(isActionableEmail({subject:'Cost Accountant Interview: David Cox',senderAddress:'maria@example.com'}),true);
});
test('routine messages cannot bypass filtering or crowd out project actions',()=>{
 const {buildAttentionCandidates}=require('../attention-engine');
 const feed=buildAttentionCandidates({email:{yahoo:[{subject:'Welcome To Our Family'},{subject:"You've successfully created an online account!"},{subject:'Hello David',conversationState:'unknown'}]},github:{projects:[{repository:'d/project',projectState:{nextActions:['Audit launch readiness']}}]}});
 assert.equal(feed.length,2);assert.equal(feed[0].domain,'project');assert.equal(feed[1].domain,'email');
});
