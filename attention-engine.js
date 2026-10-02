function genericCalendarTitle(title){return /^(busy|focus|hold|office)$/i.test(String(title||'').trim());}
function buildAttentionCandidates(priorityContext={},now=new Date()){
 const out=[],nowMs=now.getTime();
 for(const a of priorityContext.approvals||[]){const exp=new Date(a.expiresAt).getTime();if(exp>nowMs)out.push({domain:'approval',score:100,text:`Approve or deny ${a.skill} before it expires`,why:'A live Jarvis approval is waiting on you.'});}
 const calendars=priorityContext.calendar||{},events=[...(calendars.personal||[]),...(calendars.work||[])].filter(e=>e.start&&String(e.start).includes('T')).map(e=>({...e,_s:new Date(String(e.start).replace(/\[.*\]$/,'')).getTime(),_e:new Date(String(e.end||e.start).replace(/\[.*\]$/,'')).getTime()})).filter(e=>Number.isFinite(e._s));
 for(let i=0;i<events.length;i++)for(let j=i+1;j<events.length;j++){const a=events[i],b=events[j];if(genericCalendarTitle(a.title)||genericCalendarTitle(b.title))continue;if(a._s<b._e&&b._s<a._e&&Math.max(a._s,b._s)>nowMs)out.push({domain:'calendar',score:95,text:`Resolve calendar overlap: ${a.title} / ${b.title}`,why:'Two different upcoming commitments overlap.'});}
 for(const e of events){const mins=(e._s-nowMs)/60000;if(mins>=0&&mins<=120&&!genericCalendarTitle(e.title))out.push({domain:'calendar',score:85,text:`Prepare for ${e.title}`,why:`It starts in about ${Math.max(1,Math.round(mins))} minutes.`});}
 for(const source of ['yahoo','gmail'])for(const e of priorityContext.email?.[source]||[]){if(e.conversationState==='waiting_on_them')continue;const txt=`${e.subject||''} ${e.snippet||''}`;const urgent=/fraud|unauthori[sz]ed|security alert|payment failed|account locked|action required|urgent/i.test(txt);out.push({domain:'email',score:urgent?92:72,text:`Review ${e.subject||'recent email'}`,why:urgent?'The message appears to require prompt action.':'You have not sent a later reply in this conversation.'});}
 for(const x of priorityContext.github?.items||[])out.push({domain:'github',score:/failing/i.test(x.text||'')?88:68,text:x.text,why:'Live GitHub radar surfaced this work.'});
 for(const x of priorityContext.market?.material||[])out.push({domain:'market',score:70,text:`Review material Market change for ${x.ticker||'watchlist'}`,why:x.summary||x.driver||'Market Sentinel marked the change material.'});
 for(const m of priorityContext.memories||[]){if(m.due&&new Date(m.due).getTime()<=nowMs+24*3600000)out.push({domain:'memory',score:m.priority==='High'?82:65,text:m.text,why:'A saved action is due within 24 hours.'});}
 // Saved job leads are reference state, not automatically urgent work. Only explicit due/workflow state should promote them.
 const seen=new Set();return out.sort((a,b)=>b.score-a.score).filter(x=>{const k=x.domain+'|'+x.text.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;}).slice(0,8);
}
module.exports={buildAttentionCandidates,genericCalendarTitle};
