const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGitHubClientFromEnv, engineeringToolDefinitions, executeEngineeringTool } = require('../engineering');

test('engineering tools expose read-only GitHub operations', () => {
  const names = engineeringToolDefinitions().map(x => x.name);
  assert.deepEqual(names, ['github_repo_status','github_open_pull_requests','github_pull_request','github_issues']);
});

test('GitHub client reads repository metadata with authorization', async () => {
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  let seen;
  const client = buildGitHubClientFromEnv(async (url, options) => {
    seen = { url, options };
    return { ok: true, json: async () => ({ full_name: 'coxdavid9/personal-memory-bank' }) };
  });
  const result = await client.getRepo();
  assert.equal(result.full_name, 'coxdavid9/personal-memory-bank');
  assert.match(seen.options.headers.Authorization, /^Bearer /);
  if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = oldToken;
});

test('engineering tool reports missing integration instead of pretending it worked', async () => {
  const result = await executeEngineeringTool('github_repo_status', {}, null);
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/i);
});
