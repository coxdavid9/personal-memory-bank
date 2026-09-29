const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildAgentTools } = require('../agent-tools');

test('disabling a capability removes its tools from the built toolset', () => {
  const tools = buildAgentTools({
    job: 'portfolio',
    enabledCapabilities: [
      { key: 'memory', enabled: true },
      { key: 'portfolio', enabled: false }
    ]
  }).map(tool => tool.name).filter(Boolean);

  assert.ok(!tools.includes('get_portfolio_summary'));
  assert.ok(!tools.includes('record_holding'));
  assert.ok(!tools.includes('delete_holding'));
  assert.ok(tools.includes('save_memory'));
});

test('server only supplies active projects to agent context', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /SELECT id, name, description, status FROM agent_projects WHERE status='active'/);
});

test('memory deletion endpoint and project status cycle are present', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /app\.delete\('\/api\/memories\/\:id'/);
  assert.match(source, /app\.patch\('\/api\/projects\/\:id'/);
  assert.match(source, /active: 'paused', paused: 'done', done: 'active'/);
});

test('capability toggle endpoint persists enabled state', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /app\.patch\('\/api\/capabilities\/\:id'/);
  assert.match(source, /UPDATE agent_capabilities SET enabled=\$1,updated_at=NOW\(\)/);
});

test('server imports capability definitions before initDb uses them', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /require\(['"]\.\/agent-capabilities['"]\)/);
  assert.match(source, /CAPABILITY_DEFINITIONS/);
});
