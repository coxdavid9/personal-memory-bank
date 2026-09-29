const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildAgentTools } = require('../agent-tools');
const { agentSystemPrompt, emailHtml } = require('../server');
const { PORTFOLIO_NOTIFICATION_SUBJECT } = require('../portfolio-agent');

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


test('server imports capability definitions before initDb references them', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const importPos = source.indexOf("require('./agent-capabilities')");
  const initPos = source.indexOf('async function initDb()');
  assert.ok(importPos >= 0);
  assert.ok(initPos >= 0);
  assert.ok(importPos < initPos);
});

test('Jarvis v3 UI wiring is present and purple legacy accents are gone', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /JARVIS/);
  assert.match(html, /\/reactor\.jpg/);
  assert.match(html, /setWorking\(active\)/);
  assert.match(html, /Working/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /Personal Agent/);
  for (const purple of ['#3b2a6e','#8b7cf6','#6d28d9','#4c1d95','#b9b3f0']) assert.doesNotMatch(html, new RegExp(purple, 'i'));
  assert.match(manifest, /"name": "Jarvis"/);
  assert.match(manifest, /"short_name": "Jarvis"/);
  assert.match(server, /<title>Jarvis — Sign in<\/title>/);
  assert.match(server, /<h1>JARVIS<\/h1>/);
});


test('chat paste handler routes clipboard images through the attachment flow', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /async function attachImageFile\(file\)/);
  assert.match(html, /function handleImagePaste\(event\)/);
  assert.ok(html.includes('clipboardData'));
  assert.ok(html.includes("startsWith('image/')"));
  assert.match(html, /event\.preventDefault\(\)/);
  assert.match(html, /void attachImageFile\(file\)/);
  assert.match(html, /messageInput\.addEventListener\('paste',handleImagePaste\)/);
  assert.match(html, /document\.addEventListener\('paste',handleImagePaste\)/);
});

test('Jarvis identity is consistent across prompt and notification surfaces', () => {
  const prompt = agentSystemPrompt({ memories: [], projects: [], capabilities: [], portfolioState: { manualCount: 0, plaidCount: 0 }, priorityContext: { memories: [], jobs: [] } });
  const reminder = emailHtml({ text: 'Test reminder', type: 'Work', priority: 'Normal', due: new Date().toISOString() });
  assert.match(prompt, /You are Jarvis, David's personal AI agent\./);
  assert.match(prompt, /Your name is Jarvis\./);
  assert.match(prompt, /never 'Personal Agent'/);
  assert.equal((prompt.match(/Personal Agent/g) || []).length, 1);
  assert.match(reminder, /🧠 Jarvis/);
  assert.match(reminder, /Open Jarvis/);
  assert.doesNotMatch(reminder, /Personal Agent/);
  assert.match(PORTFOLIO_NOTIFICATION_SUBJECT, /^Jarvis — portfolio alert$/);
  assert.doesNotMatch(PORTFOLIO_NOTIFICATION_SUBJECT, /Personal Agent/);

  const toolsSource = fs.readFileSync(path.join(__dirname, '..', 'agent-tools.js'), 'utf8');
  assert.match(toolsSource, /such as ClearCFO, Jarvis, Portfolio, or Job Search/);
  assert.doesNotMatch(toolsSource, /such as ClearCFO, Personal Agent, Portfolio, or Job Search/);
});
