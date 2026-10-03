const GITHUB_API = 'https://api.github.com';

function parseProjectStatus(content='') {
  const text=String(content||'');
  const sections={};
  const re=/^##\s+(.+)\s*$\n([\s\S]*?)(?=^##\s+|\s*$)/gm;
  let m; while((m=re.exec(text))) sections[m[1].trim().toLowerCase()]=m[2].trim();
  const clean=v=>String(v||'').replace(/\*\*/g,'').replace(/^[-*]\s+/gm,'').trim();
  const lines=v=>clean(v).split(/\n+/).map(x=>x.trim()).filter(Boolean);
  const currentState=clean(sections['current state']||'');
  const open=sections['open work / next milestones']||sections['open work']||'';
  const next=sections['next milestone']||sections['next steps']||'';
  const blockers=sections['blockers']||'';
  const nextActions=[...lines(next),...lines(open)].filter((x,i,a)=>a.indexOf(x)===i).slice(0,5);
  return { currentState, openWork:lines(open).slice(0,8), blockers:lines(blockers).slice(0,5), nextActions };
}


function buildGitHubClientFromEnv(fetchImpl = fetch) {
  const token = process.env.GITHUB_TOKEN || '';
  const repo = process.env.GITHUB_REPO || 'coxdavid9/personal-memory-bank';
  const additionalRepos = String(process.env.GITHUB_ADDITIONAL_REPOS || 'coxdavid9/clearcfo,coxdavid9/CMA-Agent')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const allowedRepos = new Set([repo, ...additionalRepos]);
  if (!token) return null;

  function resolveRepo(requestedRepo = '') {
    if (!requestedRepo) return repo;
    const normalized = String(requestedRepo).trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
      throw new Error('Invalid GitHub repository. Use owner/name.');
    }
    if (!allowedRepos.has(normalized)) {
      throw new Error(`GitHub repository is not configured: ${normalized}`);
    }
    return normalized;
  }

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

  async function getRepo(requestedRepo) {
    const targetRepo = resolveRepo(requestedRepo);
    return request(`/repos/${targetRepo}`);
  }
  async function listOpenPullRequests(requestedRepo) {
    const targetRepo = resolveRepo(requestedRepo);
    return request(`/repos/${targetRepo}/pulls?state=open&per_page=20`);
  }
  async function listRecentMergedPullRequests(requestedRepo) {
    const targetRepo = resolveRepo(requestedRepo);
    const pulls = await request(`/repos/${targetRepo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`);
    return pulls.filter(pr => pr.merged_at).slice(0, 10);
  }
  async function getPullRequest(number, requestedRepo) {
    const targetRepo = resolveRepo(requestedRepo);
    return request(`/repos/${targetRepo}/pulls/${encodeURIComponent(number)}`);
  }
  async function getPullRequestStatus(number, requestedRepo) {
    const targetRepo = resolveRepo(requestedRepo);
    const pr = await getPullRequest(number, targetRepo);
    const checks = pr.head?.sha ? await request(`/repos/${targetRepo}/commits/${pr.head.sha}/check-runs?per_page=50`) : { check_runs: [] };
    return { number: pr.number, state: pr.state, merged: pr.merged, mergeable: pr.mergeable, mergeCommitSha: pr.merge_commit_sha, headSha: pr.head?.sha || null, checks: (checks.check_runs || []).map(check => ({ name: check.name, status: check.status, conclusion: check.conclusion, htmlUrl: check.html_url })) };
  }
  async function listIssues(state = 'open', requestedRepo) {
    const targetRepo = resolveRepo(requestedRepo);
    return request(`/repos/${targetRepo}/issues?state=${encodeURIComponent(state)}&per_page=30`);
  }

  async function listBranchCheckRuns(branch = 'main', requestedRepo) {
    const targetRepo = resolveRepo(requestedRepo);
    const data = await request(`/repos/${targetRepo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=50`);
    return data.check_runs || [];
  }

  function summarizeCi(checks = []) {
    if (!checks.length) return 'unknown';
    if (checks.some(check => ['failure','cancelled','timed_out','action_required','startup_failure'].includes(check.conclusion))) return 'failing';
    if (checks.some(check => check.status !== 'completed')) return 'pending';
    if (checks.every(check => check.conclusion === 'success' || check.conclusion === 'skipped' || check.conclusion === 'neutral')) return 'green';
    return 'unknown';
  }

  async function getPriorityRadar() {
    if (!token) return { repos: [] };
    const repositories = [...allowedRepos];
    const repoResults = await Promise.all(repositories.map(async repository => {
      try {
        const repoInfo = await getRepo(repository);
        const defaultBranch = repoInfo.default_branch || 'main';
        const [pullRequests, mainChecks, issues] = await Promise.all([
          listOpenPullRequests(repository),
          listBranchCheckRuns(defaultBranch, repository),
          listIssues('open', repository)
        ]);
        const openPrs = await Promise.all(pullRequests.map(async pr => {
          try {
            const status = await getPullRequestStatus(pr.number, repository);
            return {
              number: pr.number,
              title: pr.title,
              htmlUrl: pr.html_url,
              ciStatus: summarizeCi(status.checks),
              mergeable: status.mergeable,
              headSha: status.headSha
            };
          } catch {
            return {
              number: pr.number,
              title: pr.title,
              htmlUrl: pr.html_url,
              ciStatus: 'unknown',
              mergeable: null,
              headSha: pr.head?.sha || null
            };
          }
        }));
        const failingMainChecks = mainChecks
          .filter(check => check.conclusion === 'failure')
          .map(check => ({ name: check.name, conclusion: check.conclusion, htmlUrl: check.html_url }));
        const openIssues = issues
          .filter(issue => !issue.pull_request && issue.user?.type !== 'Bot')
          .slice(0, 5)
          .map(issue => ({ number: issue.number, title: issue.title, updatedAt:issue.updated_at, htmlUrl: issue.html_url }));
        return {
          repository,
          defaultBranch,
          openPullRequests: openPrs,
          failingMainChecks,
          openIssues
        };
      } catch {
        return null;
      }
    }));
    return { repos: repoResults.filter(Boolean) };
  }


  async function getProjectIntelligence() {
    const states = [];
    for (const repository of allowedRepos) {
      try {
        const info = await getRepo(repository), defaultBranch = info.default_branch || 'main';
        const [merged, openPrs, issues, checks] = await Promise.all([
          listRecentMergedPullRequests(repository), listOpenPullRequests(repository), listIssues('open', repository), listBranchCheckRuns(defaultBranch, repository)
        ]);
        let projectDoc = null;
        for (const path of ['PROJECT_STATUS.md','STATUS.md','README.md']) {
          try { const file = await getFile(path, defaultBranch, repository); if (file?.content) { projectDoc={path,content:file.content.slice(0,12000)}; break; } } catch {}
        }
        const structuredStatus = parseProjectStatus(projectDoc?.content || '');
        states.push({
          repository, description: info.description || '', defaultBranch,
          recentlyCompleted: merged.slice(0,8).map(pr=>({number:pr.number,title:pr.title,mergedAt:pr.merged_at})),
          openPullRequests: openPrs.slice(0,8).map(pr=>({number:pr.number,title:pr.title,updatedAt:pr.updated_at})),
          openIssues: issues.filter(x=>!x.pull_request&&x.user?.type!=='Bot').slice(0,10).map(x=>({number:x.number,title:x.title,updatedAt:x.updated_at})),
          mainStatus: summarizeCi(checks),
          health: summarizeCi(checks)==='failing'?'blocked':(openPrs.length?'active':'ready'),
          projectDoc, projectState: structuredStatus,
          verifiedAt: new Date().toISOString()
        });
      } catch (err) { states.push({repository,error:err.message,verifiedAt:new Date().toISOString()}); }
    }
    return states;
  }

  async function getFile(path, ref = 'main', requestedRepo) {
    const targetRepo = resolveRepo(requestedRepo);
    const data = await request(`/repos/${targetRepo}/contents/${path.replace(/^\/+/, '')}?ref=${encodeURIComponent(ref)}`);
    if (Array.isArray(data)) return { path, ref, entries: data };
    const content = data.content ? Buffer.from(data.content, 'base64').toString('utf8') : '';
    return { path: data.path, ref, sha: data.sha, content, size: data.size };
  }

  async function getBranchSha(branch = 'main', requestedRepo) {
    const targetRepo = resolveRepo(requestedRepo);
    const data = await request(`/repos/${targetRepo}/git/ref/heads/${encodeURIComponent(branch)}`);
    return data.object?.sha;
  }

  async function createBranch(branch, base = 'main', requestedRepo) {
    const targetRepo = resolveRepo(requestedRepo);
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.length > 200) throw new Error('Invalid Git branch name.');
    const sha = await getBranchSha(base, targetRepo);
    return request(`/repos/${targetRepo}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha })
    });
  }

  async function updateFile({ path, content, branch, sha, message, repository }) {
    const targetRepo = resolveRepo(repository);
    let currentSha = sha;
    if (!currentSha) {
      try { currentSha = (await getFile(path, branch, targetRepo)).sha; } catch (err) { if (!/404/.test(err.message)) throw err; }
    }
    const payload = { message: message || `Update ${path}`, content: Buffer.from(String(content)).toString('base64'), branch };
    if (currentSha) payload.sha = currentSha;
    return request(`/repos/${targetRepo}/contents/${path.replace(/^\/+/, '')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async function createPullRequest({ branch, base = 'main', title, body, draft = false, repository }) {
    const targetRepo = resolveRepo(repository);
    return request(`/repos/${targetRepo}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, head: branch, base, draft })
    });
  }

  async function createPR({ repository, branch, base = 'main', title, body, files = [], draft = false }) {
    const targetRepo = resolveRepo(repository);
    await createBranch(branch, base, targetRepo);
    const committed = [];
    for (const file of files) {
      if (!file?.path || typeof file.content !== 'string') throw new Error('Each PR file needs path and content.');
      const result = await updateFile({
        path: file.path,
        content: file.content,
        branch,
        sha: file.sha,
        message: file.message || `Update ${file.path}`,
        repository: targetRepo
      });
      committed.push({ path: file.path, sha: result.content?.sha || null });
    }
    const pr = await createPullRequest({ branch, base, title, body, draft, repository: targetRepo });
    return { pr, committed };
  }

  return { repo, allowedRepos: [...allowedRepos], resolveRepo, getRepo, listOpenPullRequests, listRecentMergedPullRequests, getPullRequest, getPullRequestStatus, listIssues, getPriorityRadar, getProjectIntelligence, getFile, createBranch, updateFile, createPullRequest, createPR };
}

function engineeringToolDefinitions({ render = false } = {}) {
  const tools = [
    {
      type: 'function', name: 'github_repo_status',
      description: 'Read the configured GitHub repository metadata.',
      strict: true, parameters: { type: 'object', properties: { repository: { type: ['string','null'], description: 'Optional configured repository in owner/name form.' } }, required: ['repository'], additionalProperties: false }
    },
    {
      type: 'function', name: 'github_open_pull_requests',
      description: 'List open pull requests in the configured repository.',
      strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
    },
    {
      type: 'function', name: 'github_pr_status',
      description: 'Read a pull request plus its GitHub Actions check status, mergeability, and merge commit.',
      strict: true, parameters: { type: 'object', properties: { number: { type: 'integer' }, repository: { type: ['string','null'], description: 'Optional configured repository in owner/name form.' } }, required: ['number','repository'], additionalProperties: false }
    },
    {
      type: 'function', name: 'github_pull_request',
      description: 'Read one pull request by number.',
      strict: true, parameters: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'], additionalProperties: false }
    },
    {
      type: 'function', name: 'github_issues',
      description: 'List GitHub issues in the configured repository.',
      strict: true, parameters: { type: 'object', properties: { state: { type: 'string', enum: ['open','closed'] }, repository: { type: ['string','null'], description: 'Optional configured repository in owner/name form.' } }, required: ['state','repository'], additionalProperties: false }
    },
    {
      type: 'function', name: 'github_file',
      description: 'Read a text file from the repository at a branch or commit. Safe read-only operation.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, ref: { type: 'string' }, repository: { type: ['string','null'], description: 'Optional configured repository in owner/name form.' } },
        required: ['path','ref','repository'], additionalProperties: false
      }
    },
    {
      type: 'function', name: 'github_recent_merged_pull_requests',
      description: 'List the most recently merged pull requests in the selected configured repository. Safe read-only operation.',
      strict: true,
      parameters: { type: 'object', properties: { repository: { type: ['string','null'], description: 'Optional configured repository in owner/name form.' } }, required: ['repository'], additionalProperties: false }
    },
    {
      type: 'function', name: 'github_create_pr',
      description: 'Create a branch, apply the proposed full-file patches, and open a GitHub pull request. This is an external write and ALWAYS requires David approval; never call it expecting immediate execution.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          repository: { type: ['string','null'], description: 'Optional configured repository in owner/name form.' },
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
        required: ['repository','branch','base','title','body','draft','diff','files'],
        additionalProperties: false
      }
    }
  ];
  return tools;
}

async function executeEngineeringTool(name, args, client) {
  if (!client) return { ok: false, error: 'GitHub integration is not configured.' };
  if (name === 'github_repo_status') return { ok: true, repository: await client.getRepo(args.repository) };
  if (name === 'github_open_pull_requests') return { ok: true, pullRequests: await client.listOpenPullRequests(args.repository) };
  if (name === 'github_recent_merged_pull_requests') return { ok: true, pullRequests: await client.listRecentMergedPullRequests(args.repository) };
  if (name === 'github_pr_status') return { ok: true, status: await client.getPullRequestStatus(args.number, args.repository) };
  if (name === 'github_pull_request') return { ok: true, pullRequest: await client.getPullRequest(args.number, args.repository) };
  if (name === 'github_issues') return { ok: true, issues: await client.listIssues(args.state, args.repository) };
  if (name === 'github_file') return { ok: true, file: await client.getFile(args.path, args.ref, args.repository) };
  if (name === 'github_create_pr') {
    return { ok: false, error: 'github_create_pr must be executed through the policy approval flow.' };
  }
  return { ok: false, error: `Unknown engineering tool: ${name}` };
}

module.exports = { buildGitHubClientFromEnv, engineeringToolDefinitions, executeEngineeringTool, parseProjectStatus };

