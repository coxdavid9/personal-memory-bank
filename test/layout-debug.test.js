const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const script=fs.readFileSync(path.join(__dirname,'../public/layout-debug.js'),'utf8');
test('diagnostics do nothing unless explicitly enabled by URL',()=>{
 vm.runInNewContext(script,{URLSearchParams,window:{location:{search:''}}});
});
test('report keeps focused viewport measurements and excludes message text',async()=>{
 const handlers={},copied=[],elements={};let button;
 for(const selector of ['#appShell','.topbar','#contentScroller','.composer'])elements[selector]={getBoundingClientRect:()=>({top:40,bottom:340,height:300})};
 elements['.composer'].appendChild=el=>button=el;
 const input={value:'PRIVATE MESSAGE MUST NOT APPEAR',textContent:'PRIVATE CONTENT'};
 const document={activeElement:input,documentElement:{clientHeight:800},getElementById:()=>input,querySelector:s=>elements[s],
 createElement:()=>({style:{},setAttribute(){}}),addEventListener:(name,fn)=>handlers[name]=fn};
 const viewport={height:360,offsetTop:120,pageTop:300,scale:1,addEventListener:(name,fn)=>handlers['viewport-'+name]=fn};
 const window={location:{search:'?layoutdebug=1'},innerHeight:800,scrollY:180,visualViewport:viewport,
 requestAnimationFrame:fn=>fn(),addEventListener:(name,fn)=>handlers['window-'+name]=fn};
 vm.runInNewContext(script,{URLSearchParams,window,document,getComputedStyle:()=>({position:'fixed'}),performance:{now:()=>10},
 navigator:{clipboard:{writeText:async text=>copied.push(text)}}});
 handlers['viewport-resize']();
 document.activeElement={};handlers.focusout();
 await button.onclick();
 const report=JSON.parse(copied[0]);
 assert.equal(report.lastFocused.inputFocused,true);
 assert.equal(report.lastFocused.viewport.offsetTop,120);
 assert.equal(report.lastFocused.window.scrollY,180);
 assert.equal(report.samples.at(-1).inputFocused,false);
 assert.ok(report.samples.length<=8);
 assert.doesNotMatch(copied[0],/PRIVATE|MESSAGE MUST|textContent|value/);
});
