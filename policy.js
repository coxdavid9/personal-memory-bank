const TIERS = Object.freeze({ SAFE: 'safe', MONITOR: 'monitor', ASK: 'ask', BLOCK: 'block' });

const DEFAULT_POLICIES = Object.freeze({
  save_memory: TIERS.MONITOR,
  get_personal_context: TIERS.SAFE,
  get_portfolio_summary: TIERS.SAFE,
  record_holding: TIERS.MONITOR,
  create_calendar_event: TIERS.ASK,
  delegate_to_team: TIERS.MONITOR,
  github_repo_status: TIERS.SAFE,
  github_open_pull_requests: TIERS.SAFE,
  github_pr_status: TIERS.SAFE,
  github_pull_request: TIERS.SAFE,
  github_issues: TIERS.SAFE,
  github_file: TIERS.SAFE,
  github_create_pr: TIERS.ASK,
  render_deploy_status: TIERS.SAFE,
  render_logs: TIERS.SAFE,
  render_redeploy: TIERS.ASK,
  record_snapshot: TIERS.MONITOR,
  notify: TIERS.MONITOR,
});

const BLACKLIST = [
  /^delete_/i,
  /secret|credential|password|api[_-]?key/i,
  /raw[_-]?sql|execute[_-]?sql/i,
  /reconnect.*(financial|bank|brokerage)/i,
];

function matchesAny(value, patterns) {
  return patterns.some(pattern => pattern.test(String(value || '')));
}

function classifySkill(name, args = {}, { whitelist = [] } = {}) {
  if (matchesAny(name, BLACKLIST) || matchesAny(JSON.stringify(args), BLACKLIST)) {
    return { tier: TIERS.BLOCK, decision: 'block', reason: 'blacklist' };
  }

  if (whitelist.some(rule => rule.skill === name && (!rule.matcher || rule.matcher(args)))) {
    return { tier: TIERS.SAFE, decision: 'allow', reason: 'whitelist', approvedBy: 'whitelist' };
  }

  return { tier: DEFAULT_POLICIES[name] || TIERS.ASK, decision: 'allow', reason: 'skill_default' };
}

async function initPolicyDb(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tool_audit (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      run_id TEXT NOT NULL,
      skill TEXT NOT NULL,
      tier TEXT NOT NULL,
      decision TEXT NOT NULL,
      args_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      duration_ms INTEGER NULL,
      error TEXT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS tool_audit_created_idx ON tool_audit(created_at DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tool_whitelist (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      skill TEXT NOT NULL,
      description TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS tool_whitelist_skill_idx ON tool_whitelist(skill, enabled)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tool_approvals (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      run_id TEXT NOT NULL,
      skill TEXT NOT NULL,
      args JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_at TIMESTAMPTZ NULL,
      decision TEXT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS tool_approvals_pending_idx ON tool_approvals(status, expires_at)');
}

function summarizeArgs(args = {}) {
  const scrub = value => {
    if (Array.isArray(value)) return value.slice(0, 20).map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k,v]) => [k, /secret|token|password|key/i.test(k) ? '[REDACTED]' : scrub(v)]));
    if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + '…' : value;
    return value;
  };
  return scrub(args);
}

async function loadWhitelist(pool) {
  if (!pool) return [];
  const { rows } = await pool.query('SELECT skill, description FROM tool_whitelist WHERE enabled=true');
  return rows.map(row => ({ skill: row.skill, description: row.description }));
}

async function auditToolCall(pool, entry) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO tool_audit(run_id,skill,tier,decision,args_summary,duration_ms,error)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [entry.runId, entry.skill, entry.tier, entry.decision, JSON.stringify(summarizeArgs(entry.args)), entry.durationMs ?? null, entry.error || null]
  );
}

async function getApproval(pool, id) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT id,run_id AS "runId",skill,args,status,expires_at AS "expiresAt" FROM tool_approvals WHERE id=$1', [id]);
  const approval = rows[0] || null;
  if (approval && approval.status === 'pending' && new Date(approval.expiresAt).getTime() <= Date.now()) {
    await pool.query('UPDATE tool_approvals SET status=\'expired\', decided_at=NOW(), decision=\'timeout\' WHERE id=$1 AND status=\'pending\'', [id]);
    approval.status = 'expired';
    approval.decision = 'timeout';
  }
  return approval;
}

async function decideApproval(pool, id, decision) {
  const approval = await getApproval(pool, id);
  if (!approval) return { ok: false, error: 'Approval not found.' };
  if (approval.status !== 'pending') return { ok: false, error: `Approval is already ${approval.status}.`, approval };
  if (!['approve','deny'].includes(decision)) return { ok: false, error: 'Decision must be approve or deny.' };
  await pool.query('UPDATE tool_approvals SET status=$1, decided_at=NOW(), decision=$2 WHERE id=$3', [decision === 'approve' ? 'approved' : 'denied', decision, id]);
  return { ok: true, approval: { ...approval, status: decision === 'approve' ? 'approved' : 'denied', decision } };
}

async function requestApproval(pool, { runId, skill, args, timeoutMs = 120000 }) {
  if (!pool) return { status: 'denied', reason: 'approval_storage_unavailable' };
  const expiresAt = new Date(Date.now() + timeoutMs);
  const { rows } = await pool.query(
    `INSERT INTO tool_approvals(run_id,skill,args,expires_at) VALUES($1,$2,$3,$4) RETURNING id,expires_at AS "expiresAt"`,
    [runId, skill, JSON.stringify(args), expiresAt]
  );
  return { status: 'pending', approvalId: rows[0].id, expiresAt: rows[0].expiresAt };
}

async function executeSkill(name, args, { pool, runId = cryptoRandomId(), execute, whitelist = [] } = {}) {
  const effectiveWhitelist = whitelist.length ? whitelist : await loadWhitelist(pool);
  const policy = classifySkill(name, args, { whitelist: effectiveWhitelist });
  const started = Date.now();

  if (policy.tier === TIERS.BLOCK) {
    await auditToolCall(pool, { runId, skill: name, tier: policy.tier, decision: 'block', args });
    return { ok: false, blocked: true, error: 'This action is blocked by the agent safety policy.', policy };
  }

  if (policy.tier === TIERS.ASK) {
    const approval = await requestApproval(pool, { runId, skill: name, args });
    await auditToolCall(pool, { runId, skill: name, tier: policy.tier, decision: approval.status === 'pending' ? 'approval_required' : 'denied', args, durationMs: Date.now() - started });
    return { ok: false, approvalRequired: approval.status === 'pending', approval, policy };
  }

  try {
    const result = await execute();
    await auditToolCall(pool, { runId, skill: name, tier: policy.tier, decision: 'allow', args, durationMs: Date.now() - started });
    return result;
  } catch (err) {
    await auditToolCall(pool, { runId, skill: name, tier: policy.tier, decision: 'error', args, durationMs: Date.now() - started, error: err.message });
    throw err;
  }
}

function cryptoRandomId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2,10)}`;
}

module.exports = { TIERS, DEFAULT_POLICIES, classifySkill, initPolicyDb, loadWhitelist, summarizeArgs, auditToolCall, requestApproval, getApproval, decideApproval, executeSkill };
