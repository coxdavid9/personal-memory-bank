const test = require('node:test'),assert = require('node:assert/strict'),fs = require('node:fs'),path = require('node:path'),vm = require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
function setup(viewport={height:635,offsetTop:0,scale:1},innerHeight=635) {
 const values=new Map(),handlers={};
 const document={activeElement:{id:'message'},documentElement:{clientHeight:635,style:{setProperty:(name,value)=>values.set(name,value)}},addEventListener:(name,fn)=>handlers['document:'+name]=fn};
 const window={innerHeight,visualViewport:viewport,requestAnimationFrame:fn=>fn(),addEventListener:(name,fn)=>handlers['window:'+name]=fn};
 Object.defineProperty(window,'scrollY',{get(){throw new Error('Do not add document scroll to the viewport offset');}});
 if(viewport)viewport.addEventListener=(name,fn)=>handlers['viewport:'+name]=fn;
 const start=html.indexOf('function updateScreenControls(){'),end=html.indexOf('\nload();',start);
 vm.runInNewContext(html.slice(start,end),{window,document});
 return {values,handlers,document,window,viewport};
}
test('frame stays fixed with only the middle pane scrolling',()=>{
 assert.match(html,/body\{position:fixed;inset:0;width:100%\}/);
 assert.match(html,/#appShell\{position:fixed;top:var\(--viewport-top,0px\);/);
 assert.match(html,/main#contentScroller\{[^}]*min-height:0;[^}]*overflow-y:auto/);
});
test('David measured Safari state compensates the 294px pan once even though innerHeight also shrinks',()=>{
 const {values,handlers}=setup({height:341,offsetTop:294,pageTop:294,scale:1},341);
 assert.equal(values.get('--viewport-top'),'294px');
 assert.equal(values.get('--screen-height'),'341px');
 // Measured uncorrected frame top was -294px. One 294px correction restores the screen origin.
 assert.equal(-294+parseFloat(values.get('--viewport-top')),0);
 for(let i=0;i<20;i++)handlers['viewport:scroll']();
 assert.equal(values.get('--viewport-top'),'294px');
 assert.equal(handlers['window:scroll'],undefined);
});
test('David measured keyboard-closed state restores top zero and 635px height',()=>{
 const {values,handlers,viewport,window}=setup({height:341,offsetTop:294,scale:1},341);
 viewport.height=635;viewport.offsetTop=0;window.innerHeight=635;
 handlers['viewport:resize']();
 assert.equal(values.get('--viewport-top'),'0px');
 assert.equal(values.get('--screen-height'),'635px');
});
test('David measured 49ms blur-to-resize transition keeps the frame visible until viewport recovery',()=>{
 const {values,handlers,document,viewport,window}=setup({height:341,offsetTop:294,scale:1},341);
 document.activeElement={};handlers['document:focusout']();
 assert.equal(values.get('--viewport-top'),'294px');
 assert.equal(values.get('--screen-height'),'341px');
 assert.equal(-294+parseFloat(values.get('--viewport-top')),0);
 viewport.height=635;viewport.offsetTop=0;window.innerHeight=635;
 handlers['viewport:resize']();
 assert.equal(values.get('--viewport-top'),'0px');
 assert.equal(values.get('--screen-height'),'635px');
});
test('full height with stale pan does not offset the frame even if input stays focused',()=>{
 const {values}=setup({height:635,offsetTop:294,scale:1});
 assert.equal(values.get('--viewport-top'),'0px');
});
test('toolbar changes and unpanned keyboard do not move the frame',()=>{
 assert.equal(setup({height:590,offsetTop:24,scale:1}).values.get('--viewport-top'),'0px');
 assert.equal(setup({height:341,offsetTop:0,scale:1},341).values.get('--viewport-top'),'0px');
});
test('offset correction cannot exceed the lost viewport height',()=>{
 assert.equal(setup({height:341,offsetTop:500,scale:1},341).values.get('--viewport-top'),'294px');
});
test('zoom preserves native geometry and missing viewport falls back to window height',()=>{
 const {values,handlers,viewport}=setup();viewport.scale=2;viewport.height=300;handlers['viewport:resize']();
 assert.equal(values.get('--screen-height'),'635px');
 const fallback=setup(null,500);
 assert.equal(fallback.values.get('--screen-height'),'500px');
 assert.equal(fallback.values.get('--viewport-top'),'0px');
});
