const TEAM_ROLES = [
  {
    key: 'chief_of_staff',
    name: 'Chief of Staff',
    description: 'Coordinates David’s personal agent, keeps projects moving, and decides which specialist should handle work.',
    systemPrompt: 'Act as David’s private Chief of Staff. Organize work, clarify the objective, identify dependencies, and return a concise action plan or synthesis. Do not invent facts or claim an action happened unless a tool confirms it.'
  },
  {
    key: 'engineering',
    name: 'Engineering',
    description: 'Helps build and maintain David’s software projects, including GitHub, tests, bugs, deployments, and technical planning.',
    systemPrompt: "Act as David’s private software engineering lead. Focus on implementation details, code changes, tests, architecture, bugs, GitHub workflow, and deployment concerns. Use GitHub and Render tools when available. IMPORTANT: when David asks about GitHub repository status, open pull requests, a PR, CI/checks, branches, commits, or repository files, you MUST use the live GitHub read tool instead of relying on memory, recent team-task text, or saying access is unavailable. The configured GitHub repository is the source of truth for those questions. Reads are safe; GitHub PR creation and Render redeploys require David's approval. Show a concise proposed diff before asking for approval. Never merge, force-push, rewrite history, delete branches, or claim code was changed, tested, merged, or deployed unless an external tool confirms it."
  },
  {
    key: 'business_ops',
    name: 'Business Operations',
    description: 'Helps David run the business: revenue, costs, customers, processes, follow-ups, metrics, and operating priorities.',
    systemPrompt: 'Act as David’s private business operations lead. Focus on running and growing the business, operating metrics, customer processes, costs, revenue, follow-ups, and practical next actions. Separate known facts from assumptions.'
  },
  {
    key: 'product',
    name: 'Product',
    description: 'Turns customer feedback and ideas into product requirements, priorities, workflows, and specifications.',
    systemPrompt: 'Act as David’s private product lead. Turn ideas, bugs, and customer feedback into clear requirements, acceptance criteria, priorities, and implementation-ready specifications. Do not make customer-facing claims without evidence.'
  },
  {
    key: 'customer_ops',
    name: 'Customer Operations',
    description: 'Tracks customer issues, feature requests, onboarding, support follow-ups, and recurring customer problems.',
    systemPrompt: 'Act as David’s private customer operations lead. Organize customer issues, requests, onboarding, follow-ups, and recurring themes. Protect customer confidentiality and do not invent customer facts.'
  }
];

function getTeamRoles() {
  return TEAM_ROLES.map(({ key, name, description }) => ({ key, name, description }));
}

function getTeamRole(key) {
  return TEAM_ROLES.find(role => role.key === key) || null;
}

async function initAgentTeamDb(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_team_tasks (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      role_key TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      result TEXT NULL,
      project TEXT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS agent_team_tasks_created_idx ON agent_team_tasks(created_at DESC)');
}

async function getRecentTeamTasks(pool, limit = 20) {
  if (!pool) return [];
  const result = await pool.query(
    'SELECT id, created_at AS created, role_key, task, status, result, project FROM agent_team_tasks ORDER BY created_at DESC LIMIT $1',
    [Math.min(Math.max(Number(limit) || 20, 1), 50)]
  );
  return result.rows;
}

async function delegateToTeam({ pool, roleKey, task, project, context = '', callOpenAI }) {
  const role = getTeamRole(roleKey);
  if (!role) return { ok: false, error: `Unknown team role: ${roleKey}` };
  const cleanTask = String(task || '').trim().slice(0, 10000);
  if (!cleanTask) return { ok: false, error: 'Team task is required.' };

  let resultText = '';
  try {
    resultText = await callOpenAI({
      roleKey: role.key,
      system: role.systemPrompt,
      user: JSON.stringify({
        task: cleanTask,
        project: project ? String(project).slice(0, 200) : null,
        context: String(context || '').slice(0, 12000)
      })
    });
  } catch (err) {
    if (pool) {
      await pool.query(
        'INSERT INTO agent_team_tasks(role_key,task,status,result,project) VALUES($1,$2,$3,$4,$5)',
        [role.key, cleanTask, 'failed', err.message || 'Team task failed.', project || null]
      );
    }
    throw err;
  }

  if (pool) {
    await pool.query(
      'INSERT INTO agent_team_tasks(role_key,task,status,result,project) VALUES($1,$2,$3,$4,$5)',
      [role.key, cleanTask, 'completed', resultText, project || null]
    );
  }

  return { ok: true, role: { key: role.key, name: role.name }, result: resultText };
}

module.exports = { TEAM_ROLES, getTeamRoles, getTeamRole, initAgentTeamDb, getRecentTeamTasks, delegateToTeam };
