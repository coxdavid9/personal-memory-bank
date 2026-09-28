const test = require('node:test');
const assert = require('node:assert/strict');
const { executeAgentTool } = require('../agent-tools');
const { verifyGitHubSignature, failedCheckRunEvent } = require('../github-webhook');
const { buildRenderClientFromEnv } = require('../render-ops');
const crypto = require('crypto');

function fakePool() {
  return {
    query: async (sql) => {
      if (sql.startsWith('SELECT skill')) return { rows: [] };
      if (sql.startsWith('INSERT INTO tool_approvals')) return { rows: [{ id: 42, expiresAt: new Date(Date.now() + 120000) }] };
      return { rows: [] };
    }
  };
}

test('github_create_pr is blocked behind an approval without executing the write', async () => {
  let calls = 0;
  const result = await executeAgentTool('github_create_pr', {
    branch: 'agent/test',
    base: 'main',
    title: 'Test',
    body: 'Test',
    draft: true,
    files: [{ path: 'x.txt', content: 'x', sha: null, message: 'test' }]
  }, {
    pool: fakePool(),
    github: { createPR: async () => { calls += 1; } }
  });
  assert.equal(result.approvalRequired, true);
  assert.equal(result.approval.approvalId, 42);
  assert.equal(calls, 0);
});

test('approved github_create_pr executes the write exactly once', async () => {
  let calls = 0;
  const result = await executeAgentTool('github_create_pr', {
    branch: 'agent/test',
    base: 'main',
    title: 'Test',
    body: 'Test',
    draft: true,
    files: [{ path: 'x.txt', content: 'x', sha: null, message: 'test' }]
  }, {
    pool: fakePool(),
    github: { createPR: async args => { calls += 1; return { pr: { number: 99 }, args }; } },
    skipPolicy: true
  });
  assert.equal(result.pr.number, 99);
  assert.equal(calls, 1);
});

test('GitHub webhook accepts only the correct HMAC signature', () => {
  const secret = 'webhook-secret';
  const raw = Buffer.from('{"action":"completed"}');
  const good = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(verifyGitHubSignature(secret, raw, good), true);
  assert.equal(verifyGitHubSignature(secret, raw, 'sha256=bad'), false);
  assert.equal(failedCheckRunEvent('check_run', { action: 'completed', check_run: { conclusion: 'failure' } }), true);
  assert.equal(failedCheckRunEvent('check_run', { action: 'completed', check_run: { conclusion: 'success' } }), false);
});

test('Render client uses the configured API key and redeploy endpoint', async () => {
  const oldKey = process.env.RENDER_API_KEY;
  process.env.RENDER_API_KEY = 'render-test';
  let seen;
  const client = buildRenderClientFromEnv(async (url, options) => {
    seen = { url, options };
    return { ok: true, json: async () => ({ id: 'dep-test', status: 'created' }) };
  });
  const result = await client.redeploy();
  assert.equal(result.id, 'dep-test');
  assert.match(seen.options.headers.Authorization, /^Bearer /);
  assert.match(seen.url, /\/services\/srv-/);
  if (oldKey === undefined) delete process.env.RENDER_API_KEY;
  else process.env.RENDER_API_KEY = oldKey;
});
