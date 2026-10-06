const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function setup(viewport={height:800,offsetTop:0,scale:1}) {
 const values=new Map(),handlers={};
 const document={activeElement:{id:'message'},documentElement:{clientHeight:800,style:{setProperty:(name,value)=>values.set(name,value)}},
 addEventListener:(name,fn)=>handlers['document:'+name]=fn};
 const window={innerHeight:800,scrollY:0,visualViewport:viewport,requestAnimationFrame:fn=>fn(),addEventListener:(name,fn)=>handlers['window:'+name]=fn};
 if(viewport)viewport.addEventListener=(name,fn)=>handlers['viewport:'+name]=fn;
 const start=html.indexOf('function updateScreenControls(){');
 const end=html.indexOf('\nload();',start);
 vm.runInNewContext(html.slice(start,end),{window,document});
 return {values,handlers,document,window,viewport};
}
test('header, content scroller and composer are siblings in one screen',()=>{
 const shell=html.indexOf('<div id="appShell">');
 const header=html.indexOf('<header class="topbar">');
 const main=html.indexOf('<main id="contentScroller">');
 const mainEnd=html.indexOf('</main>');
 const composer=html.indexOf('<div class="composer">');
 const drawer=html.indexOf('<div id="drawer"');
 assert.ok(shell<header&&header<main&&main<mainEnd&&mainEnd<composer&&composer<drawer);
 assert.match(html,/\.topbar\{position:relative;top:auto/);
 assert.match(html,/\.composer\{position:relative;left:auto;right:auto;bottom:auto/);
 assert.match(html,/main#contentScroller\{[^}]*min-height:0;[^}]*overflow-y:auto/);
 assert.match(html,/\.composer \.input\{font-size:16px\}/);
});
test('keyboard shrinks a single screen with no separate bottom correction',()=>{
 const {values,handlers,viewport,window}=setup();
 viewport.height=360;viewport.offsetTop=120;window.scrollY=200;
 handlers['viewport:resize']();
 assert.equal(values.get('--screen-height'),'360px');
 assert.equal(values.get('--screen-top'),'320px');
 assert.equal(values.has('--keyboard-inset'),false);
});
test('blur ignores stale Safari offset and keeps screen in document coordinates',()=>{
 const {values,handlers,document,window}=setup({height:360,offsetTop:120,scale:1});
 window.scrollY=200;document.activeElement={};
 handlers['document:focusout']();
 assert.equal(values.get('--screen-top'),'200px');
});
test('keyboard dismissal resets offset while input remains focused',()=>{
 const {values,handlers,viewport}=setup({height:360,offsetTop:120,scale:1});
 viewport.height=800;
 handlers['viewport:resize']();
 assert.equal(values.get('--screen-top'),'0px');
 assert.equal(values.get('--screen-height'),'800px');
});
test('browser toolbar changes do not count as an open keyboard',()=>{
 const {values}=setup({height:740,offsetTop:20,scale:1});
 assert.equal(values.get('--screen-top'),'0px');
 assert.equal(values.get('--screen-height'),'740px');
});
test('pinch zoom preserves the screen geometry instead of fighting user zoom',()=>{
 const {values,handlers,viewport}=setup();
 viewport.scale=2;viewport.height=300;viewport.offsetTop=50;
 handlers['viewport:resize']();
 assert.equal(values.get('--screen-top'),'0px');
 assert.equal(values.get('--screen-height'),'800px');
});
test('fallback without VisualViewport follows window height and document scroll',()=>{
 const {values,handlers,window}=setup(null);
 window.innerHeight=500;window.scrollY=80;
 handlers['window:resize']();
 assert.equal(values.get('--screen-height'),'500px');
 assert.equal(values.get('--screen-top'),'80px');
});
