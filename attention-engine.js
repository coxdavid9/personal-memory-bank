const { isActionableEmail } = require('./email');
function projectNextAction(project){
 const structured=project?.projectState?.nextActions||[]; if(structured.length)return structured[0];
 const doc=project?.projectDoc?.content||'';
 if(!doc)return null;
 const heading=/^##\s+(Next milestone|Open work \/ next milestones|Open work|Next steps)\s*$([\s\S]*?)(?=^##\s+|$(?![\s\S]))/im;
 const m=doc.match(heading);if(!m)return null;
 const body=m[2].trim();
 const bold=body.match(/\*\*([^*]+)\*\*/);if(bold)return bold[1].trim();
 const bullet=body.match(/^[-*]\s+(.+)$/m);if(bullet)return bullet[1].replace(/\*\*/g,'').trim();
 const sentence=body.replace(/\s+/g,' ').split(/(?<=[.!?])\s+/)[0];return sentence?sentence.replace(/\*\*/g,'').trim():null;
}
function genericCalendarTitle(title){return /^(busy|focus|hold|office)$/i.test(String(title||'').trim());}
function calendaredInvitation(email,events){
 const subject=String(email.subject||'');
 if(!/interview|meeting|invitation|appointment/i.test(subject))return false;
 const text=subject+' '+String(email.snippet||'');
 if(/availability|request|please (?:reply|respond|confirm|complete|review)|action required|urgent|cancel|reschedul|updated|changed|required|deadline/i.test(text))return false;
 const title=value=>String(value||'').toLowerCase().replace(/[\u2010-\u2015-]/g,' ').replace(/\s+/g,' ').trim();
 const received=new Date(email.date).getTime();
 if(!email.date||!Number.isFinite(received))return false;
 // Match only an existing Jarvis-created personal event, not a similarly named external meeting.
 return events.some(event=>String(event.uid||'').endsWith('@personal-agent')&&title(event.title)===title(subject)&&event.recordedAt&&Number.isFinite(new Date(event.recordedAt).getTime())&&new Date(event.recordedAt).getTime()>=received);
}
function buildAttentionCandidates(priorityContext={},now=new Date()){
 const out=[],nowMs=now.getTime();
 for(const a of priorityContext.approvals||[]){const exp=new Date(a.expiresAt).getTime();if(exp>nowMs)out.push({domain:'approval',identity:'approval:'+a.id,revision:a.expiresAt,score:100,text:`Approve or deny ${a.skill} before it expires`,why:'A live Jarvis approval is waiting on you.'});}
 const calendars=priorityContext.calendar||{},events=[...(calendars.personal||[]),...(calendars.work||[])].filter(e=>e.start&&String(e.start).includes('T')).map(e=>({...e,_s:new Date(String(e.start).replace(/\[.*\]$/,'')).getTime(),_e:new Date(String(e.end||e.start).replace(/\[.*\]$/,'')).getTime()})).filter(e=>Number.isFinite(e._s));
 for(let i=0;i<events.length;i++)for(let j=i+1;j<events.length;j++){const a=events[i],b=events[j];if(genericCalendarTitle(a.title)||genericCalendarTitle(b.title))continue;if(a._s<b._e&&b._s<a._e&&Math.max(a._s,b._s)>nowMs)out.push({domain:'calendar',identity:'calendar-conflict:'+a.title+':'+a.start+':'+b.title+':'+b.start,revision:a.start+':'+b.start,score:95,text:`Resolve calendar overlap: ${a.title} / ${b.title}`,why:'Two different upcoming commitments overlap.'});}
 for(const e of events){const mins=(e._s-nowMs)/60000;if(mins>=0&&mins<=120&&!genericCalendarTitle(e.title))out.push({domain:'calendar',identity:'calendar:'+e.title+':'+e.start,revision:e.start,score:85,text:`Prepare for ${e.title}`,why:`It starts in about ${Math.max(1,Math.round(mins))} minutes.`});}
 for(const source of ['yahoo','gmail'])for(const e of priorityContext.email?.[source]||[]){if(e.conversationState==='waiting_on_them'||!isActionableEmail(e)||(source==='yahoo'&&calendaredInvitation(e,calendars.personal||[])))continue;const txt=`${e.subject||''} ${e.snippet||''}`;const urgent=/fraud|unauthori[sz]ed|security alert|payment failed|account locked|action required|urgent/i.test(txt);const request=/interview|next steps|please (?:reply|respond|confirm|review)|\b(?:verify|activate|complete|required|deadline)\b/i.test(txt);out.push({domain:'email',identity:'email:'+source+':'+(e.messageId||e.uid),revision:e.messageId||String(e.uid)+':'+e.date,source,uid:e.uid,url:source==='yahoo'?'https://mail.yahoo.com/':'https://mail.google.com/',score:urgent?92:request?72:48,text:`Review ${e.subject||'recent email'}`,why:urgent?'The message appears to require prompt action.':e.conversationState==='unknown'?'Sent-mail status could not be checked. Verify whether this still needs attention.':'Recent correspondence with no matching later sent reply. Its contents still need checking for an actual next step.'});}
 for(const x of priorityContext.github?.items||[])out.push({domain:'github',identity:'github:'+x.repository+':'+x.kind+':'+(x.number||x.check),revision:x.revision||x.text,url:x.repository?'https://github.com/'+x.repository+(x.kind==='pull_request'?'/pull/'+x.number:x.kind==='issue'?'/issues/'+x.number:'/actions'):null,score:/failing/i.test(x.text||'')?88:68,text:x.text,why:'Live GitHub radar surfaced this work.'});
 for(const p of priorityContext.github?.projects||[]){const next=projectNextAction(p);if(next)out.push({domain:'project',identity:'project:'+p.repository+':'+next,revision:next,repository:p.repository,url:'https://github.com/'+p.repository+'/blob/'+encodeURIComponent(p.defaultBranch||'main')+'/'+(p.projectDoc?.path||'PROJECT_STATUS.md'),score:55,text:next,why:'Recorded next step in '+p.repository+' '+(p.projectDoc?.path||'project status')+'. The status document may need validation against the current product.',evidence:'Project plan · read '+(p.verifiedAt||'recently')});}
 for(const x of priorityContext.market?.material||[])out.push({domain:'market',score:70,text:`Review material Market change for ${x.ticker||'watchlist'}`,why:x.summary||x.driver||'Market Sentinel marked the change material.'});
 for(const m of priorityContext.memories||[]){if(m.due&&new Date(m.due).getTime()<=nowMs+24*3600000)out.push({domain:'memory',identity:'memory:'+m.id,revision:m.text+':'+m.due,memoryId:m.id,score:m.priority==='High'?82:65,text:m.text,why:'A saved action is due within 24 hours.'});}
 // Saved job leads are reference state, not automatically urgent work. Only explicit due/workflow state should promote them.
 const seen=new Set();return out.sort((a,b)=>b.score-a.score).filter(x=>{const k=x.domain+'|'+x.text.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;}).slice(0,8);
}
module.exports={buildAttentionCandidates,genericCalendarTitle,projectNextAction};
