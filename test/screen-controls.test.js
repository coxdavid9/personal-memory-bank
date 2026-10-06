const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function setup(viewport = {height:800,offsetTop:0,scale:1}) {
 const properties = new Map(), handlers = {}, observed = [];
 const header={getBoundingClientRect:()=>({height:84})};
 const composer={getBoundingClientRect:()=>({height:96})};
 const window={requestAnimationFrame:fn=>fn(),innerHeight:800,visualViewport:viewport,addEventListener:(name,fn)=>{handlers['window:'+name]=fn;}};
 if(viewport)viewport.addEventListener=(name,fn)=>{handlers['viewport:'+name]=fn;};
 function ResizeObserver(fn){this.observe=el=>observed.push(el);handlers.observer=fn;}
 window.ResizeObserver=ResizeObserver;
 const document={activeElement:{id:'message'},addEventListener:(name,fn)=>{handlers['document:'+name]=fn;},documentElement:{style:{setProperty:(key,value)=>properties.set(key,value)}},
 querySelector:selector=>selector==='.topbar'?header:composer,
 querySelectorAll:()=>[header,composer]};
 const context=vm.createContext({window,document,ResizeObserver});
 const start=html.indexOf('function updateScreenControls(){');
 const end=html.indexOf('\nload();',start);
 assert.ok(start>=0 && end>start);
 vm.runInContext(html.slice(start,end),context);
 return {properties,handlers,observed,viewport,window,document};
}
test('screen controls are outside the filtered Chat and main containers',()=>{
 const mainStart=html.indexOf('<main>'),mainEnd=html.indexOf('</main>');
 assert.ok(html.indexOf('<header class="topbar">')<mainStart);
 assert.ok(html.indexOf('<div class="composer">')>mainEnd);
});
test('mobile composer uses 16px input text and fixed screen controls',()=>{
 assert.match(html,/\.composer \.input\{font-size:16px\}/);
 assert.match(html,/\.topbar\{position:fixed;top:calc\(var\(--viewport-top\)/);
 assert.match(html,/\.composer\{bottom:var\(--keyboard-inset\)\}/);
});
test('keyboard viewport moves screen controls above keyboard without scrolling the document',()=>{
 const {properties,handlers,viewport}=setup();
 viewport.height=360;viewport.offsetTop=120;
 handlers['viewport:resize']();
 assert.equal(properties.get('--viewport-top'),'120px');
 assert.equal(properties.get('--keyboard-inset'),'320px');
});
test('keyboard dismissal resets control offsets on viewport events',()=>{
 const {properties,handlers,viewport}=setup({height:360,offsetTop:120,scale:1});
 viewport.height=800;viewport.offsetTop=0;
 handlers['viewport:scroll']();
 assert.equal(properties.get('--viewport-top'),'0px');
 assert.equal(properties.get('--keyboard-inset'),'0px');
});
test('control heights reserve space and respond to attachment/header resize',()=>{
 const {properties,handlers,observed}=setup();
 assert.equal(observed.length,2);
 assert.equal(properties.get('--header-height'),'84px');
 assert.equal(properties.get('--composer-height'),'96px');
 observed[1].getBoundingClientRect=()=>({height:150});
 handlers.observer();
 assert.equal(properties.get('--composer-height'),'150px');
});
test('fallback works without VisualViewport and manual zoom keeps native positioning',()=>{
 const {properties}=setup(null);
 assert.equal(properties.get('--viewport-top'),'0px');
 assert.equal(properties.get('--keyboard-inset'),'0px');
 const zoom=setup({height:300,offsetTop:50,scale:2});
 assert.equal(zoom.properties.get('--viewport-top'),'0px');
 assert.equal(zoom.properties.get('--keyboard-inset'),'0px');
});

test('blur clears keyboard offsets even when Safari retains stale viewport geometry',()=>{
 const {properties,handlers,document}=setup({height:360,offsetTop:120,scale:1});
 assert.equal(properties.get('--viewport-top'),'120px');
 document.activeElement={id:''};
 handlers['document:focusout']();
 assert.equal(properties.get('--viewport-top'),'0px');
 assert.equal(properties.get('--keyboard-inset'),'0px');
 handlers['viewport:scroll']();
 assert.equal(properties.get('--viewport-top'),'0px');
});
test('dismissed keyboard with input still focused ignores stale offsetTop',()=>{
 const {properties,handlers,viewport}=setup({height:360,offsetTop:120,scale:1});
 viewport.height=800;
 handlers['viewport:resize']();
 assert.equal(properties.get('--viewport-top'),'0px');
 assert.equal(properties.get('--keyboard-inset'),'0px');
});
test('toolbar-sized viewport changes do not move the header even with input focused',()=>{
 const {properties}=setup({height:740,offsetTop:20,scale:1});
 assert.equal(properties.get('--viewport-top'),'0px');
 assert.equal(properties.get('--keyboard-inset'),'0px');
});
