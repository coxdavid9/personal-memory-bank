const GITHUB_API = 'https://api.github.com';

function buildGitHubClientFromEnv(fetchImpl = fetch) {
  const token = process.env.GITHUB_TOKEN || '';
  const repo = process.env.GITHUB_REPO || 'coxdavid9/personal-memory-bank';
  if (!token) return null;

  async function request(path, options = {}) {
    const response = await fetchImpl(`${GITHUB_API}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || `GitHub API request failed (${response.status}).`);
    return data;
  }

  async function getRepo() {
    return request(`/repos/${repo}`);
  }

  async function listOpenPullRequests() {
    return request(`/repos/${repo}/pulls?state=open&per_page=20`);
  }

  async function getPullRequest(number) {
    return request(`/repos/${repo}/pulls/${encodeURIComponent(number)}`);
  }

  async function listIssues(state = 'open') {
    return request(`/repos/${repo}/issues?state=${encodeURIComponent(state)}&per_page=30`);
  }

  async function getFile(path, ref = 'main') {
    return request(`/repos/${repo}/contents/${path.replace(/^\/+/, '')}?ref=${encodeURIComponent(ref)}`);
  }

  return {
    repo,
    getRepo,
    listOpenPullRequests,
    getPullRequest,
    listIssues,
    getFile
  };
}

function engineeringToolDefinitions() {
  return [
    {
      type: 'function',
      name: 'github_repo_status',
      description: 'Read the configured GitHub repository metadata.',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
    },
    {
      type: 'function',
      name: 'github_open_pull_requests',
      description: 'List open pull requests in the configured repository.',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
    },
    {
      type: 'function',
      name: 'github_pull_request',
      description: 'Read one pull request by number.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { number: { type: 'integer', description: 'Pull request number.' } },
        required: ['number'],
        additionalProperties: false
      }
    },
    {
      type: 'function',
      name: 'github_issues',
      description: 'List GitHub issues in the configured repository.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { state: { type: 'string', enum: ['open','closed'] } },
        required: ['state'],
        additionalProperties: false
      }
    }
  ];
}

async function executeEngineeringTool(name, args, client) {
  if (!client) return { ok: false, error: 'GitHub integration is not configured.' };
  if (name === 'github_repo_status') return { ok: true, repository: await client.getRepo() };
  if (name === 'github_open_pull_requests') return { ok: true, pullRequests: await client.listOpenPullRequests() };
  if (name === 'github_pull_request') return { ok: true, pullRequest: await client.getPullRequest(args.number) };
  if (name === 'github_issues') return { ok: true, issues: await client.listIssues(args.state) };
  return { ok: false, error: `Unknown engineering tool: ${name}` };
}

module.exports = { buildGitHubClientFromEnv, engineeringToolDefinitions, executeEngineeringTool };
