const test = require('node:test');
const assert = require('node:assert/strict');
const { inferJob, buildAgentTools } = require('../agent-tools');

test('router sends calendar requests to calendar skills only', () => {
  assert.equal(inferJob('Put a dentist appointment on my calendar'), 'calendar');
  const names = buildAgentTools({ job: 'calendar' }).map(tool => tool.name);
  assert.deepEqual(names, ['save_memory','get_personal_context','create_calendar_event']);
});

test('router sends portfolio requests to portfolio skills', () => {
  assert.equal(inferJob('How is my Fidelity portfolio doing?'), 'portfolio');
  const names = buildAgentTools({ job: 'portfolio' }).map(tool => tool.name);
  assert.deepEqual(names, ['save_memory','get_personal_context','get_portfolio_summary','record_holding']);
});

test('router keeps engineering tools out of normal chat', () => {
  assert.equal(inferJob('What do you know about ClearCFO?'), 'general');
  const names = buildAgentTools({ job: 'general' }).map(tool => tool.name);
  assert.ok(!names.includes('github_repo_status'));
  assert.ok(!names.includes('github_create_pr'));
  assert.ok(names.includes('delegate_to_team'));
});
