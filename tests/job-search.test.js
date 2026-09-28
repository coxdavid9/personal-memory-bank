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
    'web_search_preview'
  ]);
});

test('job search tool definitions include application tracking but not engineering writes', () => {
  const names = buildAgentTools({ job: 'job_search' }).map(tool => tool.name).filter(Boolean);
  assert.ok(names.includes('get_job_application_history'));
  assert.ok(names.includes('save_job_application'));
  assert.ok(!names.includes('github_create_pr'));
  assert.ok(!names.includes('render_redeploy'));
});
