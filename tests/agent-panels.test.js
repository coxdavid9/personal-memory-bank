const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildAgentTools } = require('../agent-tools');
const { getAgentContext } = require('../server');

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


function makeContextDb(state) {
  return {
    async query(sql) {
      if (sql.includes('FROM memories')) return { rows: state.memories };
      if (sql.includes('FROM agent_projects')) {
        return { rows: sql.includes("WHERE status='active'") ? state.projects.filter(p => p.status === 'active') : state.projects };
      }
      if (sql.includes('FROM agent_capabilities')) return { rows: state.capabilities };
      if (sql.includes('FROM job_applications')) return { rows: [] };
      if (sql.includes('FROM holdings')) return { rows: [{ manualCount: 0, plaidCount: 0 }] };
      throw new Error('Unexpected context query: ' + sql);
    }
  };
}

test('deleting a memory removes it from subsequent agent context loads', async () => {
  const state = {
    memories: [{ id: 7, text: 'Remember this', type: 'Work', done: false }],
    projects: [],
    capabilities: [{ key: 'memory', enabled: true }]
  };
  const db = makeContextDb(state);
  assert.equal((await getAgentContext(db)).memories.length, 1);
  state.memories = [];
  assert.equal((await getAgentContext(db)).memories.length, 0);
});

test('completing a project removes it from subsequent agent context loads', async () => {
  const state = {
    memories: [],
    projects: [{ id: 9, name: 'Jarvis', description: 'Build Jarvis', status: 'active' }],
    capabilities: [{ key: 'memory', enabled: true }]
  };
  const db = makeContextDb(state);
  assert.equal((await getAgentContext(db)).projects.length, 1);
  state.projects[0].status = 'done';
  assert.equal((await getAgentContext(db)).projects.length, 0);
});

test('Jarvis UI uses the reactor working state and removes Personal Agent branding', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /JARVIS/);
  assert.match(html, /\/reactor\.jpg/);
  assert.match(html, /setWorking\(active\)/);
  assert.match(html, /Working/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /Personal Agent/);
  assert.match(manifest, /"name": "Jarvis"/);
  assert.match(manifest, /"short_name": "Jarvis"/);
  assert.match(server, /<title>Jarvis — Sign in<\/title>/);
  assert.match(server, /<h1>JARVIS<\/h1>/);
});
