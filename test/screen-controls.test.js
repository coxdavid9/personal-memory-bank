const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function setup(viewport={height:800,offsetTop:0,scale:1}) {
 const values=new Map(),handlers={};
 const document={documentElement:{style:{setProperty:(name,value)=>values.set(name,value)}}};
 const window={innerHeight:800,visualViewport:viewport,addEventListener:(name,fn)=>handlers['window:'+name]=fn};
 Object.defineProperty(window,'scrollY',{get(){throw new Error('Frame must never read document scroll position');}});
 if(viewport){viewport.addEventListener=(name,fn)=>handlers['viewport:'+name]=fn;Object.defineProperty(viewport,'offsetTop',{get(){throw new Error('Frame must never follow Safari pan offsets');}});}
 const start=html.indexOf('function updateScreenControls(){'),end=html.indexOf('\nload();',start);
 vm.runInNewContext(html.slice(start,end),{window,document});
 return {values,handlers,document,window,viewport};
}
test('fixed root prevents focus scrolling from moving the entire app',()=>{
 assert.match(html,/body\{position:fixed;inset:0;width:100%\}/);
 assert.match(html,/#appShell\{position:fixed;top:0;/);
 assert.doesNotMatch(html,/--screen-top/);
 const header=html.indexOf('<header class="topbar">'),main=html.indexOf('<main id="contentScroller">'),mainEnd=html.indexOf('</main>'),composer=html.indexOf('<div class="composer">');
 assert.ok(header<main&&main<mainEnd&&mainEnd<composer);
 assert.match(html,/main#contentScroller\{[^}]*min-height:0;[^}]*overflow-y:auto/);
});
test('keyboard opening changes only frame height, never its top',()=>{
 const {values,handlers,viewport}=setup();
 viewport.height=360;
 handlers['viewport:resize']();
 assert.deepEqual([...values],[['--screen-height','360px']]);
});
test('viewport scroll events never read or copy page/pan offsets',()=>{
 const {values,handlers}=setup({height:360,scale:1});
 for(let i=0;i<20;i++)handlers['viewport:scroll']();
 assert.deepEqual([...values],[['--screen-height','360px']]);
 assert.equal(handlers['window:scroll'],undefined);
});
test('keyboard dismissal restores full frame height',()=>{
 const {values,handlers,viewport}=setup({height:360,scale:1});
 viewport.height=800;handlers['viewport:resize']();
 assert.equal(values.get('--screen-height'),'800px');
});
test('pinch zoom preserves frame size instead of fighting user zoom',()=>{
 const {values,handlers,viewport}=setup();
 viewport.scale=2;viewport.height=300;handlers['viewport:resize']();
 assert.equal(values.get('--screen-height'),'800px');
});
test('fallback without VisualViewport uses window height',()=>{
 const {values,handlers,window}=setup(null);
 window.innerHeight=500;handlers['window:resize']();
 assert.equal(values.get('--screen-height'),'500px');
});
