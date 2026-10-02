const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getAgentContext, isWorkPriorityQuestion, enforceAttentionLimit, buildGitHubPriorityItems } = require('../server');

test('work-priority detection is narrow', () => {
  assert.equal(isWorkPriorityQuestion('What should I work on right now?'), true);
  assert.equal(isWorkPriorityQuestion('What needs doing?'), true);
  assert.equal(isWorkPriorityQuestion("What's next up?"), true);
  assert.equal(isWorkPriorityQuestion('How do I reset my GitHub password?'), false);
  assert.equal(isWorkPriorityQuestion('Show me PR #62'), false);
});

test('green PR surfaces as a review/merge priority item', () => {
  const items = buildGitHubPriorityItems({
    repos: [{
      repository: 'coxdavid9/personal-memory-bank',
      openPullRequests: [{ number: 62, title: 'GitHub work radar', ciStatus: 'green', mergeable: true }],
      failingMainChecks: [],
      openIssues: []
    }]
  });
  assert.deepEqual(items, [{
    kind: 'pull_request',
    repository: 'coxdavid9/personal-memory-bank',
    number: 62,
    title: 'GitHub work radar',
    text: 'Review/merge PR #62 — CI green'
  }]);
});

test('failing main check surfaces as an actionable priority item', () => {
  const items = buildGitHubPriorityItems({
    repos: [{
      repository: 'coxdavid9/clearcfo',
      openPullRequests: [],
      failingMainChecks: [{ name: 'financial-engine', conclusion: 'failure' }],
      openIssues: []
    }]
  });
  assert.deepEqual(items, [{
    kind: 'main_check',
    repository: 'coxdavid9/clearcfo',
    check: 'financial-engine',
    text: 'main is failing on financial-engine'
  }]);
});

test('empty GitHub radar contributes nothing', async () => {
  const context = await getAgentContext(null, {
    includeGithub: true,
    githubClient: { getPriorityRadar: async () => ({ repos: [] }) }
  });
  assert.deepEqual(context.priorityContext.github, { repos: [], items: [], projects: [] });
});

test('non-priority questions make no GitHub API calls', async () => {
  let calls = 0;
  const githubClient = {
    getPriorityRadar: async () => {
      calls += 1;
      throw new Error('GitHub radar should not have been called');
    }
  };
  await getAgentContext(null, { includeGithub: false, githubClient });
  assert.equal(calls, 0);
});

test('priority radar is gated in runAgent context construction', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /getAgentContext\(pool, \{ includeGithub: isWorkPriorityQuestion\(message\) \}\)/);
  assert.match(source, /context\.priorityContext\.github\.items/);
  assert.match(source, /Never auto-merge, auto-push, or auto-fix/);
});

test('GitHub radar client is read-only and ignores bot noise in issues', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'engineering.js'), 'utf8');
  assert.match(source, /async function getPriorityRadar\(\)/);
  assert.match(source, /!issue\.pull_request && issue\.user\?\.type !== 'Bot'/);
  assert.match(source, /slice\(0, 5\)/);
  assert.match(source, /listBranchCheckRuns/);
});


test('attention context exposes market and approval signal buckets when radar is enabled', async () => {
  const context = await getAgentContext(null, { includeGithub: true, githubClient: { getPriorityRadar: async () => ({ repos: [] }) } });
  assert.ok(context.priorityContext.market);
  assert.ok(Array.isArray(context.priorityContext.approvals));
});


test('attention output is structurally capped at three main items', () => {
  const input = 'For tomorrow:\n\n1. First\nDetails one.\n\n2. Second\nDetails two.\n\n3. Third\nDetails three.\n\n4. Routine calendar item\nShould not survive.\n\nEverything else: Useful lower-priority context.';
  const output = enforceAttentionLimit(input, 3);
  assert.match(output, /1\. First/);
  assert.match(output, /3\. Third/);
  assert.doesNotMatch(output, /4\. Routine calendar item/);
  assert.doesNotMatch(output, /Should not survive/);
  assert.match(output, /Everything else: Useful lower-priority context/);
});

test('attention cap leaves ordinary non-numbered replies unchanged', () => {
  assert.equal(enforceAttentionLimit('Nothing urgent today.', 3), 'Nothing urgent today.');
});


test('server schedules Proactive Jarvis conservatively',()=>{const fs=require('node:fs'),path=require('node:path');const src=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');assert.match(src,/let proactiveTickRunning = false/);assert.match(src,/15 \* 60 \* 1000/);assert.match(src,/60 \* 1000/);assert.match(src,/if \(proactiveTickRunning\) return/);});


test('priority context includes verified GitHub project intelligence',async()=>{const ctx=await getAgentContext(null,{includeGithub:true,githubClient:{getPriorityRadar:async()=>({repos:[]}),getProjectIntelligence:async()=>[{repository:'coxdavid9/CMA-Agent',mainStatus:'green',recentlyCompleted:[],openIssues:[{number:1,title:'Audit bank'}],verifiedAt:'2026-10-02T00:00:00Z'}]}});assert.equal(ctx.priorityContext.github.projects[0].repository,'coxdavid9/CMA-Agent');assert.equal(ctx.priorityContext.github.projects[0].openIssues[0].title,'Audit bank');});
