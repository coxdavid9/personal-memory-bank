const test = require('node:test');
const assert = require('node:assert/strict');
const { inferJob, buildAgentTools } = require('../agent-tools');

test('router sends job requests to job search', () => {
  assert.equal(inferJob('Find me accounting jobs around Jonesboro'), 'job_search');
  const tools = buildAgentTools({ job: 'job_search' });
  const names = tools.map(tool => tool.name).filter(Boolean);
  assert.deepEqual(names, [
    'save_memory',
    'get_personal_context',
    'get_job_application_history',
    'save_job_application',
    'record_interview',
    'get_workflows'
  ]);
  assert.ok(tools.some(tool => tool.type === 'web_search_preview'));
});

test('job search tool definitions include application tracking but not engineering writes', () => {
  const names = buildAgentTools({ job: 'job_search' }).map(tool => tool.name).filter(Boolean);
  assert.ok(names.includes('get_job_application_history'));
  assert.ok(names.includes('save_job_application'));
  assert.ok(!names.includes('github_create_pr'));
  assert.ok(!names.includes('render_redeploy'));
});

const { classifySkill, TIERS } = require('../policy');

test('job record writes require explicit approval', () => {
  const policy = classifySkill('save_job_application');
  assert.equal(policy.tier, TIERS.ASK);
});

test('ambiguous numbered job lists are not safe to resolve by number', () => {
  const response = [
    '## Best matches',
    '1. Senior Accountant — Robert Half',
    '2. Accountant — Onin Technology',
    '',
    '## My recommended order',
    '1. Accountant — Onin Technology',
    '2. Senior Accountant — Robert Half'
  ].join('\\n');
  const numberedListStarts = response.split('1. ').length - 1;
  assert.equal(numberedListStarts, 2);
});
