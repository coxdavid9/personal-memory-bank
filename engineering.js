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

  async function getRepo() { return request(`/repos/${repo}`); }
  async function listOpenPullRequests() { return request(`/repos/${repo}/pulls?state=open&per_page=20`); }
  async function getPullRequest(number) { return request(`/repos/${repo}/pulls/${encodeURIComponent(number)}`); }
  async function getPullRequestStatus(number) {
    const pr = await getPullRequest(number);
    const checks = pr.head?.sha ? await request(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=50`) : { check_runs: [] };
    return { number: pr.number, state: pr.state, merged: pr.merged, mergeable: pr.mergeable, mergeCommitSha: pr.merge_commit_sha, headSha: pr.head?.sha || null, checks: (checks.check_runs || []).map(check => ({ name: check.name, status: check.status, conclusion: check.conclusion, htmlUrl: check.html_url })) };
  }
  async function listIssues(state = 'open') { return request(`/repos/${repo}/issues?state=${encodeURIComponent(state)}&per_page=30`); }

  async function getFile(path, ref = 'main') {
    const data = await request(`/repos/${repo}/contents/${path.replace(/^\/+/, '')}?ref=${encodeURIComponent(ref)}`);
    if (Array.isArray(data)) return { path, ref, entries: data };
    const content = data.content ? Buffer.from(data.content, 'base64').toString('utf8') : '';
    return { path: data.path, ref, sha: data.sha, content, size: data.size };
  }

  async function getBranchSha(branch = 'main') {
    const data = await request(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    return data.object?.sha;
  }

  async function createBranch(branch, base = 'main') {
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.length > 200) throw new Error('Invalid Git branch name.');
    const sha = await getBranchSha(base);
    return request(`/repos/${repo}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha })
    });
  }

  async function updateFile({ path, content, branch, sha, message }) {
    let currentSha = sha;
    if (!currentSha) {
      try { currentSha = (await getFile(path, branch)).sha; } catch (err) { if (!/404/.test(err.message)) throw err; }
    }
    const payload = { message: message || `Update ${path}`, content: Buffer.from(String(content)).toString('base64'), branch };
    if (currentSha) payload.sha = currentSha;
    return request(`/repos/${repo}/contents/${path.replace(/^\/+/, '')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async function createPullRequest({ branch, base = 'main', title, body, draft = false }) {
    return request(`/repos/${repo}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, head: branch, base, draft })
    });
  }

  async function createPR({ branch, base = 'main', title, body, files = [], draft = false }) {
    await createBranch(branch, base);
    const committed = [];
    for (const file of files) {
      if (!file?.path || typeof file.content !== 'string') throw new Error('Each PR file needs path and content.');
      const result = await updateFile({
        path: file.path,
        content: file.content,
        branch,
        sha: file.sha,
        message: file.message || `Update ${file.path}`
      });
      committed.push({ path: file.path, sha: result.content?.sha || null });
    }
    const pr = await createPullRequest({ branch, base, title, body, draft });
    return { pr, committed };
  }

  return { repo, getRepo, listOpenPullRequests, getPullRequest, listIssues, getFile, createBranch, updateFile, createPullRequest, createPR };
}

function engineeringToolDefinitions({ render = false } = {}) {
  const tools = [
    {
      type: 'function', name: 'github_repo_status',
      description: 'Read the configured GitHub repository metadata.',
      strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
    },
    {
      type: 'function', name: 'github_open_pull_requests',
      description: 'List open pull requests in the configured repository.',
      strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
    },
    {
      type: 'function', name: 'github_pr_status',
      description: 'Read a pull request plus its GitHub Actions check status, mergeability, and merge commit.',
      strict: true, parameters: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'], additionalProperties: false }
    },
    {
      type: 'function', name: 'github_pull_request',
      description: 'Read one pull request by number.',
      strict: true, parameters: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'], additionalProperties: false }
    },
    {
      type: 'function', name: 'github_issues',
      description: 'List GitHub issues in the configured repository.',
      strict: true, parameters: { type: 'object', properties: { state: { type: 'string', enum: ['open','closed'] } }, required: ['state'], additionalProperties: false }
    },
    {
      type: 'function', name: 'github_file',
      description: 'Read a text file from the repository at a branch or commit. Safe read-only operation.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, ref: { type: 'string' } },
        required: ['path','ref'], additionalProperties: false
      }
    },
    {
      type: 'function', name: 'github_create_pr',
      description: 'Create a branch, apply the proposed full-file patches, and open a GitHub pull request. This is an external write and ALWAYS requires David approval; never call it expecting immediate execution.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          base: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          draft: { type: 'boolean' },
          diff: { type: 'string', description: 'Concise unified-style diff or change summary to show David before approval.' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                sha: { type: ['string','null'] },
                message: { type: ['string','null'] }
              },
              required: ['path','content','sha','message'],
              additionalProperties: false
            }
          }
        },
        required: ['branch','base','title','body','draft','diff','files'],
        additionalProperties: false
      }
    }
  ];
  return tools;
}

async function executeEngineeringTool(name, args, client) {
  if (!client) return { ok: false, error: 'GitHub integration is not configured.' };
  if (name === 'github_repo_status') return { ok: true, repository: await client.getRepo() };
  if (name === 'github_open_pull_requests') return { ok: true, pullRequests: await client.listOpenPullRequests() };
  if (name === 'github_pr_status') return { ok: true, status: await client.getPullRequestStatus(args.number) };
  if (name === 'github_pull_request') return { ok: true, pullRequest: await client.getPullRequest(args.number) };
  if (name === 'github_issues') return { ok: true, issues: await client.listIssues(args.state) };
  if (name === 'github_file') return { ok: true, file: await client.getFile(args.path, args.ref) };
  if (name === 'github_create_pr') {
    return { ok: false, error: 'github_create_pr must be executed through the policy approval flow.' };
  }
  return { ok: false, error: `Unknown engineering tool: ${name}` };
}

module.exports = { buildGitHubClientFromEnv, engineeringToolDefinitions, executeEngineeringTool };
