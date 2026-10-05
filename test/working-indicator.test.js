const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function setup() {
  const requests = [];
  const elements = {
    app: { classList: { toggle(name, active) { elements.app.working = active; } } },
    statusLine: { textContent: 'Ready' },
    attentionStatus: { textContent: '' },
    attentionRefresh: { disabled: false },
    message: { value: 'Hello' }
  };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    api: route => new Promise((resolve, reject) => requests.push({ route, resolve, reject })),
    renderMessages() {}, clearImage() {}, loadAttentionState: async () => {},
    loadApprovals: async () => {}, syncChat: async () => {},
    loadMarketLearning: async () => {}
  });
  vm.runInContext(`
    let sendInFlight=false, attentionBusy=false, attentionLoaded=false;
    let attentionItems=[], messages=[], selectedImageDataUrl=null, pendingChatScope=null;
  ` + ['setWorking', 'loadAttention', 'send'].map(name => {
    const line = html.split('\n').find(line => line.startsWith('function '+name+'(') || line.startsWith('async function '+name+'('));
    assert.ok(line, name+' function must exist');
    return line;
  }).join('\n'), context);
  return { context, elements, requests };
}

test('Today refresh shows working and returns to Ready after success', async () => {
  const { context, elements, requests } = setup();
  const refresh = context.loadAttention();
  assert.equal(elements.app.working, true);
  assert.equal(elements.statusLine.textContent, 'Working');
  assert.equal(elements.attentionRefresh.disabled, true);
  requests[0].resolve({ items: [], checkedAt: new Date().toISOString() });
  await refresh;
  assert.equal(elements.app.working, false);
  assert.equal(elements.statusLine.textContent, 'Ready');
  assert.equal(elements.attentionRefresh.disabled, false);
});

test('failed Today refresh clears working and displays the error', async () => {
  const { context, elements, requests } = setup();
  const refresh = context.loadAttention();
  requests[0].reject(new Error('Source unavailable'));
  await refresh;
  assert.equal(elements.app.working, false);
  assert.equal(elements.statusLine.textContent, 'Ready');
  assert.equal(elements.attentionStatus.textContent, 'Source unavailable');
  assert.equal(elements.attentionRefresh.disabled, false);
});

for (const first of ['chat', 'refresh']) {
  test('overlapping chat and refresh stay working when '+first+' finishes first', async () => {
    const { context, elements, requests } = setup();
    const chat = context.send();
    const refresh = context.loadAttention();
    const jobs = { chat, refresh };
    const finish = name => requests.find(r => r.route === (name === 'chat' ? '/api/agent/chat' : '/api/attention')).resolve(
      name === 'chat' ? { reply: 'Done' } : { items: [], checkedAt: new Date().toISOString() }
    );
    finish(first);
    await jobs[first];
    assert.equal(elements.app.working, true);
    assert.equal(elements.statusLine.textContent, 'Working');
    const last = first === 'chat' ? 'refresh' : 'chat';
    finish(last);
    await jobs[last];
    assert.equal(elements.app.working, false);
    assert.equal(elements.statusLine.textContent, 'Ready');
  });
}

test('repeated refresh does not start another request or clear working', async () => {
  const { context, elements, requests } = setup();
  const refresh = context.loadAttention();
  await context.loadAttention();
  assert.equal(requests.length, 1);
  assert.equal(elements.app.working, true);
  requests[0].resolve({ items: [], checkedAt: new Date().toISOString() });
  await refresh;
  assert.equal(elements.app.working, false);
});
