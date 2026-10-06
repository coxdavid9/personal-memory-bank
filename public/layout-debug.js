(function(){
 if(new URLSearchParams(window.location.search).get('layoutdebug')!=='1')return;
 const samples=[];let lastFocused=null;
 const round=value=>Math.round(Number(value||0)*10)/10;
 function capture(reason){
  const viewport=window.visualViewport;
  const rect=selector=>{const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();const css=getComputedStyle(el);return {top:round(r.top),bottom:round(r.bottom),height:round(r.height),position:css.position};};
  const record={reason,ms:round(performance.now()),inputFocused:document.activeElement===document.getElementById('message'),
   window:{height:round(window.innerHeight),scrollY:round(window.scrollY)},layoutHeight:document.documentElement.clientHeight,
   viewport:viewport?{height:round(viewport.height),offsetTop:round(viewport.offsetTop),pageTop:round(viewport.pageTop),scale:round(viewport.scale)}:null,
   shell:rect('#appShell'),header:rect('.topbar'),content:rect('#contentScroller'),composer:rect('.composer')};
  samples.push(record);if(samples.length>8)samples.shift();if(record.inputFocused)lastFocused=record;
 }
 const schedule=reason=>window.requestAnimationFrame(()=>capture(reason));
 window.addEventListener('resize',()=>schedule('window-resize'));
 window.addEventListener('scroll',()=>schedule('window-scroll'));
 document.addEventListener('focusin',()=>schedule('focus-in'));
 document.addEventListener('focusout',()=>schedule('focus-out'));
 window.visualViewport?.addEventListener('resize',()=>schedule('viewport-resize'));
 window.visualViewport?.addEventListener('scroll',()=>schedule('viewport-scroll'));
 const composer=document.querySelector('.composer');if(!composer)return;
 const button=document.createElement('button');button.type='button';button.textContent='Copy layout report';
 button.setAttribute('aria-label','Copy layout report');
 button.style.cssText='position:absolute;right:0;top:-28px;height:26px;padding:3px 8px;border:1px solid #38e1ff;background:#070b12;color:#e8f7fb;border-radius:6px;font:12px sans-serif;z-index:100';
 button.onclick=async()=>{
  capture('report-click');
  const report=JSON.stringify({version:'jarvis-layout-1',lastFocused,samples},null,2);
  try{await navigator.clipboard.writeText(report);button.textContent='Copied — paste in chat';}
  catch(e){window.prompt('Copy this layout report and paste it into our chat:',report);}
 };
 composer.appendChild(button);capture('initial');
})();
