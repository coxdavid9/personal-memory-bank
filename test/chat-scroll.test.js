const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

function setup(view = 'today', scrollY = 0) {
  const scrolls = [];
  const elements = {
    chatView: { style: { display: view === 'today' ? 'none' : '' } },
    messages: { innerHTML: '' },
    attentionStatus: { textContent: '' },
    attentionRefresh: { disabled: false }
  };
  const context = vm.createContext({
    document: { getElementById: id => elements[id], documentElement: { scrollHeight: 1000 } },
    window: { scrollY, innerHeight: 900, scrollTo: args => scrolls.push(args) },
    api: async route => route === '/api/attention/state' ? { states: [] } : { items: [], checkedAt: new Date().toISOString() },
    renderAttention() {}, setWorking() {}
  });
  const renderStart = html.indexOf('function renderMessages(');
  const render = html.slice(renderStart, html.indexOf('\n', renderStart));
  const state = html.split('\n').find(line => line.startsWith('async function loadAttentionState('));
  const refresh = html.split('\n').find(line => line.startsWith('async function loadAttention('));
  vm.runInContext('let messages=[],attentionBusy=false,attentionItems=[],attentionStates=new Map(),attentionStateChecked=0,attentionLoaded=false;\n'+[render,state,refresh].join('\n'), context);
  return { context, elements, scrolls };
}

test('Today refresh updates results without scrolling the hidden chat to the bottom', async () => {
  const { context, elements, scrolls } = setup('today', 100);
  await context.loadAttention();
  assert.equal(scrolls.length, 0);
  assert.match(elements.attentionStatus.textContent, /^Checked /);
  assert.equal(elements.attentionRefresh.disabled, false);
});

for (const force of [false, true]) {
  test('Today preserves scroll position during '+(force ? 'forced' : 'ordinary')+' background chat rendering', () => {
    const { context, scrolls } = setup('today', 100);
    context.renderMessages(force);
    assert.equal(scrolls.length, 0);
  });
}

test('Chat still follows new messages when already near the bottom', () => {
  const { context, scrolls } = setup('chat', 100);
  context.renderMessages();
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].top, 1000);
});

test('Chat preserves position when reading older messages', () => {
  const { context, scrolls } = setup('chat', 0);
  context.renderMessages();
  assert.equal(scrolls.length, 0);
});

test('forced scrolling still works when Chat is visible', () => {
  const { context, scrolls } = setup('chat', 0);
  context.renderMessages(true);
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].behavior, 'auto');
});
