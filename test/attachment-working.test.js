const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../public/excel-ui.js'), 'utf8');
function setup(attentionBusy = false) {
  const requests = [];
  const elements = {
    app: { classList: { toggle(name, active) { elements.app.working = active; } } },
    statusLine: { textContent: 'Ready' },
    message: { value: 'Hello' },
    imageFile: {}
  };
  const context = vm.createContext({
    document: { getElementById: id => elements[id], querySelector: () => null,
      createElement: () => ({}), head: { appendChild() {} }, readyState: 'complete' },
    api: () => new Promise((resolve, reject) => requests.push({resolve, reject})),
    clearImage() {}, renderMessages() {}, syncChat: async () => {}
  });
  context.window = context;
  vm.runInContext('let sendInFlight=false, attentionBusy='+attentionBusy+', selectedImageDataUrl=null, messages=[];\n'+html.split('\n').find(l => l.startsWith('function setWorking(')), context);
  vm.runInContext(script, context);
  return { context, elements, requests };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('installed attachment send handler shows working until successful completion', async () => {
  const {context, elements, requests} = setup();
  context.send();
  assert.equal(elements.app.working, true);
  assert.equal(elements.statusLine.textContent, 'Working');
  context.send();
  assert.equal(requests.length, 1);
  requests[0].resolve({reply:'Done'});
  await flush();
  assert.equal(elements.app.working, false);
  assert.equal(elements.statusLine.textContent, 'Ready');
});
test('installed send handler clears working after failure', async () => {
  const {context, elements, requests} = setup();
  context.send();
  requests[0].reject(new Error('Unavailable'));
  await flush();
  assert.equal(elements.app.working, false);
  assert.equal(elements.statusLine.textContent, 'Ready');
});
test('installed send handler keeps working during concurrent Today refresh', async () => {
  const {context, elements, requests} = setup(true);
  context.send();
  requests[0].resolve({reply:'Done'});
  await flush();
  assert.equal(elements.app.working, true);
  assert.equal(elements.statusLine.textContent, 'Working');
});
