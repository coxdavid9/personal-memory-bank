const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGitHubClientFromEnv, engineeringToolDefinitions, executeEngineeringTool } = require('../engineering');

test('engineering tools expose read-only GitHub operations', () => {
  const names = engineeringToolDefinitions().map(x => x.name);
  assert.deepEqual(names, ['github_repo_status','github_open_pull_requests','github_pr_status','github_pull_request','github_issues','github_file','github_recent_merged_pull_requests','github_create_pr']);
});

test('GitHub client reads repository metadata with authorization', async () => {
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  let seen;
  const client = buildGitHubClientFromEnv(async (url, options) => {
    seen = { url, options };
    return { ok: true, json: async () => ({ full_name: 'coxdavid9/clearcfo' }) };
  });
  const result = await client.getRepo('coxdavid9/clearcfo');
  assert.equal(result.full_name, 'coxdavid9/clearcfo');
  assert.match(seen.url, /repos\/coxdavid9\/clearcfo$/);
  assert.match(seen.options.headers.Authorization, /^Bearer /);
  if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = oldToken;
});

test('engineering tool reports missing integration instead of pretending it worked', async () => {
  const result = await executeEngineeringTool('github_repo_status', {}, null);
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/i);
});

test('GitHub client rejects repositories outside the configured allowlist', async () => {
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  const client = buildGitHubClientFromEnv(async () => ({ ok: true, json: async () => ({}) }));
  await assert.rejects(() => client.getRepo('coxdavid9/not-configured'), /not configured/i);
  if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = oldToken;
});

test('GitHub client can list recent merged PRs for ClearCFO', async () => {
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  let seen;
  const client = buildGitHubClientFromEnv(async (url) => {
    seen = url;
    return { ok: true, json: async () => [
      { number: 167, title: 'Latest merged', merged_at: '2026-09-24T00:00:00Z' },
      { number: 166, title: 'Older merged', merged_at: '2026-09-23T00:00:00Z' },
      { number: 165, title: 'Closed without merge', merged_at: null }
    ] };
  });
  const result = await client.listRecentMergedPullRequests('coxdavid9/clearcfo');
  assert.equal(result.length, 2);
  assert.equal(result[0].number, 167);
  assert.match(seen, /repos\/coxdavid9\/clearcfo\/pulls\?state=closed/);
  if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = oldToken;
});
