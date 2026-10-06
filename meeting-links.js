// Only copy URLs actually present in the invitation; no network requests or generated links.
function meetingJoinLinks(body='') {
 const links=[];
 for(const match of String(body||'').matchAll(/https:\/\/[^\s<>"']+/gi)) {
  const value=match[0].replace(/&amp;/gi,'&').replace(/[.,;]+$/,'');
  let url;try{url=new URL(value);}catch{continue;}
  if(url.username||url.password)continue;
  const host=url.hostname.toLowerCase(),path=url.pathname;
  const join=(['teams.microsoft.com','teams.live.com','teams.cloud.microsoft'].includes(host)&&/^\/(?:l\/meetup-join\/|meet\/)/i.test(path)) ||
   ((host==='zoom.us'||host.endsWith('.zoom.us'))&&/^\/(?:j|my)\//i.test(path)) ||
   (host==='meet.google.com'&&/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(path));
  if(join&&!links.includes(value))links.push(value);
 }
 return links;
}
module.exports={meetingJoinLinks};
