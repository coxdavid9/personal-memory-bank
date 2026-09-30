const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const multer = require('multer');
const { buildAgentTools, executeAgentTool, inferJob, validateImageDataUrl } = require('./agent-tools');
const { CAPABILITY_DEFINITIONS } = require('./agent-capabilities');
const { buildCalDAVClientFromEnv } = require('./caldav');
const { buildEmailClientsFromEnv, isActionableEmail } = require('./email');
const { initPortfolioDb, recordHolding, getPortfolioSummary, deleteHolding, deleteManualHoldings, buildPortfolioContext, isStalePortfolioGuidance } = require('./portfolio');
const { initPortfolioAgentDb, runDailyPortfolioAgent } = require('./portfolio-agent');
const { getTeamRoles, initAgentTeamDb, getRecentTeamTasks, delegateToTeam } = require('./agent-team');
const { buildGitHubClientFromEnv, engineeringToolDefinitions, executeEngineeringTool } = require('./engineering');
const { buildRenderClientFromEnv, renderToolDefinitions, executeRenderTool } = require('./render-ops');
const { initJobSearchDb, getJobApplicationHistory, saveJobApplication, isDismissedJobText } = require('./job-search');
const { initWorkflowDb, saveApplicationWithWorkflow, recordInterview, getWorkflows, deliverWorkflowMessage, processDueWorkflows } = require('./workflow-engine');
const { initPolicyDb, getApproval, decideApproval, auditToolCall, executeSkill } = require('./policy');
const { verifyGitHubSignature, failedCheckRunEvent } = require('./github-webhook');
const { UPLOAD_DIR, MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE, MAX_TOTAL_BYTES, ensureUploadDir, isSpreadsheetName, safeFileName, profileFile, initExcelDb, purgeExpiredExcelFiles, purgeMissingExcelFiles, getExcelFile, createExcelFile, queryExcelFile, buildWorkbook, deleteExcelFile } = require('./excel');
const app = express();
const port = Number(process.env.PORT) || 10000;
const hasDatabase = Boolean(process.env.DATABASE_URL);
const hasEmailReminders = Boolean(process.env.RESEND_API_KEY && process.env.REMINDER_EMAIL);
const hasNtfyReminders = Boolean(process.env.NTFY_TOPIC);
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const appUrl = process.env.APP_URL || 'https://personal-memory-bank.onrender.com';
const reminderFrom = process.env.REMINDER_FROM || 'Personal Memory Bank <onboarding@resend.dev>';
const ntfyTopic = process.env.NTFY_TOPIC;
const openAIModel = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const clearCfoApiUrl = process.env.CLEARCFO_API_URL || '';
const authPassword = process.env.PERSONAL_AGENT_PASSWORD || '';
const authSecret = process.env.PERSONAL_AGENT_SESSION_SECRET || '';
const caldav = buildCalDAVClientFromEnv();
const emailClients = buildEmailClientsFromEnv();
const dailyPortfolioCronSecret = process.env.DAILY_PORTFOLIO_CRON_SECRET || '';
const github = buildGitHubClientFromEnv();
const renderOps = buildRenderClientFromEnv();
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET || '';
const renderServiceId = process.env.RENDER_SERVICE_ID || 'srv-da8pp1p5efls73e9beo0';
ensureUploadDir();
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', authSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function validSession(token) {
  if (!authSecret || !token) return false;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return false;
  const expected = crypto.createHmac('sha256', authSecret).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now();
  } catch { return false; }
}
function isAuthenticated(req) {
  return validSession(req.headers.cookie?.match(/(?:^|;\\s*)pa_session=([^;]+)/)?.[1]);
}
function authPage(message = '') {
  const safe = String(message).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#070b12"><title>Jarvis — Sign in</title><style>
  *{box-sizing:border-box}body{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;background:#070b12;color:#e8f7fb;margin:0;min-height:100vh;display:grid;place-items:center;position:relative;overflow:hidden}
  body:before{content:"";position:fixed;inset:0;background:linear-gradient(rgba(7,11,18,.88),rgba(7,11,18,.94)),url('/reactor.jpg') center/420px 420px no-repeat;opacity:.42}
  .card{position:relative;width:min(90%,390px);background:rgba(11,20,30,.78);border:1px solid rgba(56,225,255,.22);border-radius:18px;padding:28px;box-shadow:0 18px 50px rgba(0,0,0,.5),0 0 28px rgba(56,225,255,.08);backdrop-filter:blur(16px)}
  h1{margin:0 0 8px;letter-spacing:.18em;text-transform:uppercase;color:#38e1ff}.muted{color:#7e9aa8;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:20px}
  input{width:100%;padding:13px;border:1px solid rgba(56,225,255,.20);border-radius:10px;background:#070d14;color:#e8f7fb;font:inherit;margin-bottom:10px}input:focus{outline:none;border-color:#38e1ff;box-shadow:0 0 0 3px rgba(56,225,255,.10)}
  button{width:100%;padding:13px;border:0;border-radius:10px;background:#38e1ff;color:#041018;font-weight:800;font:inherit;letter-spacing:.08em;text-transform:uppercase}.error{color:#ff8290;background:rgba(255,130,144,.06);border:1px solid rgba(255,130,144,.24);padding:9px;border-radius:9px;margin-bottom:12px;font-size:12px}
  </style></head><body><main class="card"><h1>JARVIS</h1><div class="muted">Private access</div>${safe?`<div class="error">${safe}</div>`:''}<form method="POST" action="/login"><input name="password" type="password" autocomplete="current-password" placeholder="Password" autofocus required><button>Sign in</button></form></main></body></html>`;
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  if (req.path === '/login' || req.path === '/api/auth/login' || req.path === '/api/status' || req.path === '/api/internal/daily-portfolio' || req.path === '/api/webhooks/github' || req.path === '/manifest.webmanifest' || req.path === '/sw.js' || req.path.startsWith('/icons/')) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required.' });
  return res.redirect('/login');
}
const pool = hasDatabase
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

app.use(express.json({ limit: '5mb', verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: false }));
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/login', (req, res) => res.type('html').send(authPage()));
app.post('/login', (req, res) => {
  if (!authPassword || !authSecret) return res.status(503).type('html').send(authPage('Private authentication is not configured yet.'));
  const password = String(req.body.password || '');
  const a = Buffer.from(password);
  const b = Buffer.from(authPassword);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).type('html').send(authPage('Incorrect password.'));
  const token = signSession({ exp: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  res.setHeader('Set-Cookie', `pa_session=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
  res.redirect('/');
});
app.post('/api/auth/login', (req, res) => {
  if (!authPassword || !authSecret) return res.status(503).json({ error: 'Private authentication is not configured yet.' });
  const password = String(req.body.password || '');
  const a = Buffer.from(password), b = Buffer.from(authPassword);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Incorrect password.' });
  const token = signSession({ exp: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  res.setHeader('Set-Cookie', `pa_session=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
  res.json({ ok: true });
});
app.post('/api/auth/logout', (req, res) => { res.setHeader('Set-Cookie', 'pa_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'); res.json({ ok: true }); });

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      text TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'Work',
      due_at TIMESTAMPTZ NULL,
      priority TEXT NOT NULL DEFAULT 'Normal',
      done BOOLEAN NOT NULL DEFAULT FALSE,
      reminder_email_id TEXT NULL
    )
  `);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS reminder_email_id TEXT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS memories_due_idx ON memories(done, due_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_projects (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_capabilities (
      id BIGSERIAL PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id BIGSERIAL PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      actions JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS actions JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`CREATE INDEX IF NOT EXISTS agent_messages_created_idx ON agent_messages(created_at DESC)`);
  await initPortfolioDb(pool);
  await initPortfolioAgentDb(pool);
  await initAgentTeamDb(pool);
  await initJobSearchDb(pool);
  await initPolicyDb(pool);
  await initExcelDb(pool);
  await initWorkflowDb(pool);
  await purgeMissingExcelFiles(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS github_webhook_events (
      delivery_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event_name TEXT NOT NULL,
      action TEXT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS github_webhook_events_created_idx ON github_webhook_events(created_at DESC)');

  const projects = [
    ['ClearCFO', 'AI-powered financial intelligence product. Keep project knowledge here; customer financial data stays in ClearCFO and is accessed through a controlled integration.', 'active'],
    ['Job Search', 'Personal accounting and finance job search. Prioritize Jonesboro, AR, then Memphis; target around $75k; avoid jobs already applied to or rejected; avoid manufacturing-only roles.', 'active'],
  ];
  for (const [name, description, status] of projects) {
    await pool.query(`
      INSERT INTO agent_projects(name, description, status) VALUES($1,$2,$3)
      ON CONFLICT(name) DO UPDATE SET description=EXCLUDED.description, status=EXCLUDED.status, updated_at=NOW()
    `, [name, description, status]);
  }

  for (const [key, name, description] of CAPABILITY_DEFINITIONS) {
    await pool.query(`
      INSERT INTO agent_capabilities(key,name,description) VALUES($1,$2,$3)
      ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, updated_at=NOW()
    `, [key, name, description]);
  }
}

function cleanMemory(input) {
  return {
    text: String(input.text || '').trim().slice(0, 5000),
    type: String(input.type || 'Work').slice(0, 40),
    due: input.due ? new Date(input.due).toISOString() : null,
    priority: String(input.priority || 'Normal').slice(0, 20),
  };
}

function emailHtml(memory) {
  const safeText = String(memory.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
  const safeType = String(memory.type || 'Work').replace(/[&<>\"']/g, '');
  const safePriority = String(memory.priority || 'Normal').replace(/[&<>\"']/g, '');
  const due = new Date(memory.due).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#20242a"><h2>🧠 Jarvis</h2><p style="color:#667085">You asked me to bring this back to your attention.</p><div style="border:1px solid #e5e7eb;border-left:4px solid #f79009;border-radius:10px;padding:16px;margin:20px 0"><div style="font-size:12px;color:#667085;margin-bottom:8px">${safeType} · ${safePriority} · ${due}</div><div style="font-size:18px;font-weight:600">${safeText}</div></div><a href="${appUrl}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:10px 14px;border-radius:9px">Open Jarvis</a></div>`;
}

async function sendAgentEmail(subject, text) {
  if (!hasEmailReminders) return { sent: false, reason: 'email_not_configured' };
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: reminderFrom,
      to: [process.env.REMINDER_EMAIL],
      subject: String(subject).slice(0, 180),
      text: String(text).slice(0, 10000)
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || 'Unable to send agent email.');
  return { sent: true, id: data.id || null };
}

async function scheduleReminderEmail(memory) {
  if (!hasEmailReminders || !memory.due || memory.done) return { id: null };
  const due = new Date(memory.due), now = Date.now(), max = now + 30 * 24 * 60 * 60 * 1000;
  if (Number.isNaN(due.getTime()) || due.getTime() <= now || due.getTime() > max) return { id: null };
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, body: JSON.stringify({ from: reminderFrom, to: [process.env.REMINDER_EMAIL], subject: `Reminder: ${memory.text.slice(0, 90)}`, html: emailHtml(memory), scheduledAt: due.toISOString() }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || 'Unable to schedule reminder email.');
  return { id: data.id || null };
}

async function scheduleReminderNtfy(memory) {
  if (!hasNtfyReminders || !memory.due || memory.done) return false;
  const due = new Date(memory.due), now = Date.now(), min = now + 10 * 1000, max = now + 3 * 24 * 60 * 60 * 1000;
  if (Number.isNaN(due.getTime()) || due.getTime() < min || due.getTime() > max) return false;
  const sequenceId = String(memory.id);
  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(ntfyTopic)}/${encodeURIComponent(sequenceId)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8', 'At': String(Math.floor(due.getTime() / 1000)), 'Title': `Agent reminder: ${memory.text.slice(0, 70)}`, 'Priority': memory.priority === 'High' ? '4' : memory.priority === 'Low' ? '2' : '3', 'Tags': 'brain', 'Click': appUrl }, body: memory.text });
  if (!response.ok) { const detail = await response.text().catch(() => ''); throw new Error(detail || `Unable to schedule phone reminder (${response.status}).`); }
  return true;
}

async function cancelReminderNtfy(memoryId) {
  if (!hasNtfyReminders || !memoryId) return;
  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(ntfyTopic)}/${encodeURIComponent(String(memoryId))}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) console.error('Unable to cancel phone reminder:', await response.text().catch(() => response.statusText));
}

async function cancelReminderEmail(emailId) {
  if (!hasEmailReminders || !emailId) return;
  const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(emailId)}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
  if (!response.ok) console.error('Unable to cancel scheduled reminder:', response.statusText);
}

function isWorkPriorityQuestion(message = '') {
  const text = String(message).trim().toLowerCase();
  if (!text) return false;
  return [
    /what should i (?:work on|do|tackle|focus on|handle)/,
    /what do i need to (?:do|work on|tackle|focus on)/,
    /what needs (?:doing|to be done)/,
    /what(?:'s| is) next(?: up)?/,
    /what are my (?:top )?priorit(?:y|ies)/,
    /what(?:'s| is) (?:the )?(?:next )?(?:thing|task) (?:i should|to)/
  ].some(pattern => pattern.test(text));
}

function buildGitHubPriorityItems(radar = { repos: [] }) {
  const items = [];
  for (const repo of radar.repos || []) {
    for (const pr of repo.openPullRequests || []) {
      if (pr.ciStatus === 'green' && pr.mergeable !== false) {
        items.push({
          kind: 'pull_request',
          repository: repo.repository,
          number: pr.number,
          title: pr.title,
          text: `Review/merge PR #${pr.number} — CI green`
        });
      } else if (pr.ciStatus === 'failing') {
        items.push({
          kind: 'pull_request',
          repository: repo.repository,
          number: pr.number,
          title: pr.title,
          text: `PR #${pr.number} failing CI`
        });
      }
    }
    for (const check of repo.failingMainChecks || []) {
      items.push({
        kind: 'main_check',
        repository: repo.repository,
        check: check.name,
        text: `main is failing on ${check.name}`
      });
    }
    for (const issue of repo.openIssues || []) {
      items.push({
        kind: 'issue',
        repository: repo.repository,
        number: issue.number,
        title: issue.title,
        text: `Review issue #${issue.number} — ${issue.title}`
      });
    }
  }
  return items;
}

async function getAgentContext(db = pool, options = {}) {
  const includeGithub = Boolean(options.includeGithub);
  const includeRadar = options.includeRadar === undefined ? includeGithub : Boolean(options.includeRadar);
  const githubClient = options.githubClient === undefined ? github : options.githubClient;
  const emptyGithub = { repos: [], items: [] };
  const githubPromise = includeGithub && githubClient?.getPriorityRadar
    ? githubClient.getPriorityRadar().then(radar => ({ ...radar, items: buildGitHubPriorityItems(radar) })).catch(() => emptyGithub)
    : Promise.resolve(emptyGithub);
  const emailPromise = includeRadar ? Promise.all([emailClients.yahoo.isConfigured()?emailClients.yahoo.listUnread(10).catch(()=>[]):Promise.resolve([]),emailClients.gmail.isConfigured()?emailClients.gmail.listUnread(10).catch(()=>[]):Promise.resolve([])]).then(([yahoo,gmail])=>({yahoo:yahoo.filter(isActionableEmail).slice(0,5),gmail:gmail.filter(isActionableEmail).slice(0,5)})) : Promise.resolve({yahoo:[],gmail:[]});
  const calendarPromise = includeRadar && caldav ? caldav.listUpcomingEvents({days:2}).catch(()=>[]) : Promise.resolve([]);

  if (!db) {
    const [githubRadar,radarEmail,radarCalendar] = await Promise.all([githubPromise,emailPromise,calendarPromise]);
    return {
      memories: [],
      projects: [],
      capabilities: [],
      portfolioState: { manualCount: 0, plaidCount: 0 },
      priorityContext: { memories: [], jobs: [], github: githubRadar, email: radarEmail, calendar: radarCalendar }
    };
  }

  const [memories, projects, capabilities, jobs, portfolio, githubRadar, radarEmail, radarCalendar] = await Promise.all([
    db.query(`SELECT id, created_at AS created, text, type, due_at AS due, priority, done FROM memories ORDER BY done ASC, due ASC NULLS LAST, created_at DESC LIMIT 80`),
    db.query(`SELECT id, name, description, status FROM agent_projects WHERE status='active' ORDER BY name`),
    db.query(`SELECT key, name, description, enabled, config FROM agent_capabilities ORDER BY name`),
    db.query(`SELECT id, created_at AS created, updated_at AS updated, title, company, location, url, status, notes
               FROM job_applications
               WHERE status NOT IN ('ignore','rejected')
               ORDER BY updated_at DESC LIMIT 100`),
    db.query(`SELECT
                COUNT(*) FILTER (WHERE source='manual')::int AS "manualCount",
                COUNT(*) FILTER (WHERE source='plaid')::int AS "plaidCount"
              FROM holdings`),
    githubPromise,
    emailPromise,
    calendarPromise
  ]);
  const portfolioState = buildPortfolioContext({
    manualCount: portfolio.rows[0]?.manualCount,
    plaidCount: portfolio.rows[0]?.plaidCount
  });
  const enabledKeys = new Set(capabilities.rows.filter(row => row.enabled).map(row => row.key));
  const currentMemories = enabledKeys.has('memory') ? memories.rows.filter(row => !isStalePortfolioGuidance(row.text)) : [];
  const actionableMemories = currentMemories.filter(row => !row.done && !isDismissedJobText(row.text));
  return {
    memories: currentMemories,
    projects: projects.rows,
    capabilities: capabilities.rows,
    portfolioState,
    portfolioGuidance: portfolioState.guidance,
    priorityContext: { memories: actionableMemories, jobs: jobs.rows, github: githubRadar, email: radarEmail, calendar: radarCalendar }
  };
}

function loadAgentOperatingFiles() {
  const names = ['SOUL.md', 'USER.md', 'AGENTS.md'];
  return names.map(name => {
    try { return { name, content: fs.readFileSync(path.join(__dirname, name), 'utf8') }; }
    catch { return { name, content: '' }; }
  }).filter(item => item.content);
}

function agentSystemPrompt(context, teamRoles = [], recentTeamTasks = [], excelFiles = []) {
  const operatingFiles = loadAgentOperatingFiles();
  return `You are Jarvis, David's personal AI agent. You are not a generic chatbot. Your job is to understand David's priorities, remember useful context, help him make decisions, and move projects forward. Be direct and practical. Do not invent facts. If information is missing, say so and propose the next step.

Current server time: ${new Date().toISOString()}
David's current local date/time: ${new Intl.DateTimeFormat('en-US', {timeZone:'America/Chicago',dateStyle:'full',timeStyle:'short'}).format(new Date())}. Resolve relative dates against this clock; clarify ambiguous times.

Identity rules:
- Your name is Jarvis. When referring to yourself or this app, say Jarvis — never 'Personal Agent'.

Architecture rules:
- Freshness rule: memory notes describe what was true when written. Before repeating a note's claim about current conditions (holdings exist, a job is open, an approval is pending), check the live tool or table when one exists. Live state wins on conflict; say which source you trusted. Notes remain authoritative for preferences, history, and standing instructions; only current-state claims defer to live data.
- Portfolio caution is derived from live context.portfolioState, not from stored caution notes. If context.portfolioState.manualCount > 0, you may mention the manual-data caution after verifying current portfolio data. If it is 0, do not mention fake, stale, or unreliable manual numbers at all.
- Memory is personal context, not customer data.
- ClearCFO project knowledge can live in memory, but customer financial data must remain in ClearCFO's own backend/database and should only be accessed through an explicit, controlled integration.
- Job search is a live capability. For job-search requests, use the built-in web search tool to find current listings, and use get_job_application_history before evaluating results. Apply David's saved preferences: prioritize Jonesboro, then Memphis; target around $75k; accounting/finance; avoid manufacturing-only roles; exclude jobs already applied to or rejected when the history establishes that. Be transparent when a listing's salary or status is unavailable. Do not claim a listing is new unless current search data supports it. When David explicitly asks to track a job decision, use save_job_application only after the decision has been explicitly confirmed by David.
  - Job-search list accuracy is strict: never present two competing numbered job lists in one response. Use exactly one numbered job list per response. If a second ordering or grouping is useful, refer to jobs by exact title and company instead of assigning a second set of numbers.
  - When David refers to job numbers, resolve them only against the single most recent visible numbered job list. If more than one numbered job list exists in recent context, the reference is ambiguous: do not guess across lists and do not write records; ask David which list he means. If he references a number beyond the visible excerpt, resolve it against the full list if the full list is available; otherwise ask for clarification.
  - Before writing any applied, rejected, excluded, saved, or ignored job record from numbered references, echo the resolved mapping as number -> exact title + company and ask David to confirm it. Do not silently write records from an initial numbered-reference message.
  - For corrections, re-read the source user message(s) supporting each surviving record. Quote the relevant wording in the confirmation. If a surviving record is not supported by a source quote, drop it and ask David to restate/confirm it rather than defending the record from memory.
  - Treat job records as structured state: applied, excluded/rejected, and considering/saved. Applied and excluded/rejected roles must be suppressed from future job lead lists.
  - Priority hygiene is strict: when David asks what he should work on, use only context.priorityContext as the candidate pool. List only actionable items, each with a concrete next-step verb (fix, verify, send, review, build…). Never include "ignore X", "don't do Y", "X is stale", or equivalent dismissal work. Dismissed, deleted, ignored, and resolved items are omitted silently. If everything is handled, say so in one line.
  - GitHub work radar is read-only and is populated only for work-priority questions. Treat context.priorityContext.github.items as candidates alongside memories and jobs.\n  - Work-radar email/calendar candidates live in context.priorityContext.email and context.priorityContext.calendar. Use concrete verbs such as \"Reply to X about Y\" and \"You have X at 2pm\". Never include newsletters, promotions, or automated messages as priority candidates. For a green, mergeable PR use the concrete form "Review/merge PR #N — CI green"; for a failing PR use "PR #N failing CI"; for a failing default branch check use "main is failing on X". Open issues may be surfaced as "Review issue #N — title". Never auto-merge, auto-push, or auto-fix from the radar; David decides when to merge. If the GitHub radar is empty, omit it silently.
  - GitHub priority radar data is empty when GITHUB_TOKEN is unset; do not mention the missing token or produce integration-error noise.
  - Dismissed job postings stay in job history for explicit questions, but never enter priority candidates. When David says a posting is stale/closed/no longer available, record it as status "ignore" and acknowledge in one line.
- Interview/workflow state is durable. For confirmed interviews, look up the tracked application id, then call record_interview; create a job record first if needed. Ask for a missing date/time rather than guessing. Use explicit timezone offsets. Record scheduled, completed, cancelled, or response_received as David reports them. A promised response date belongs in expected_response_at. A scheduled interview creates Jarvis chat steps only; use create_calendar_event separately when requested.
- Read get_workflows before reporting current follow-ups. Live workflow state outranks old chat reminders and retired memory notes. A due follow-up does not prove no reply arrived: ask or verify with an explicitly requested email read. Background V1 creates checklists and draft messages, not automatic company research, email sends, applications, or calendar writes.
- Calendar is permissioned device data and should only be used when the user grants access.\n- Portfolio is reporting-only: it can record manual holdings and later sync brokerage holdings, but it must not give buy/sell recommendations. David can remove manual holdings through the approval flow; never delete Plaid-synced holdings and never give buy/sell recommendations.
- Live portfolio state:
${JSON.stringify(context.portfolioState, null, 2)}
- GitHub work radar (populated only for work-priority questions):
${JSON.stringify(context.priorityContext?.github || { repos: [], items: [] }, null, 2)}
- Derived portfolio guidance (when present):
${context.portfolioGuidance || 'No manual-balance caution applies.'}
- When portfolio quote data is stale or unavailable, explain the quote error/source returned by the portfolio tool when one is present. Never describe an unavailable quote as $0 or imply a market price was retrieved when it was not.
- David's calendar timezone is America/Chicago. For calendar requests without another timezone explicitly stated, interpret times as David's local America/Chicago time and use the correct daylight-saving offset for the event date (CDT, UTC-05:00, during daylight time; CST, UTC-06:00, during standard time). Do not label a September event as CST when it is actually CDT.
- When David asks to put something on his calendar, use create_calendar_event. After approval, the server writes only to the configured CalDAV calendar (which may be Yahoo or iCloud); otherwise the PWA presents the existing iCalendar handoff. Never select a different calendar yourself.
- Connection tests return the actual calendar provider. Use that provider label; do not assume iCloud. If a calendar is missing, use the returned availableCalendars names to explain the configuration fix.
- You have tools. Use them when an action is appropriate instead of merely telling David how to do it.
- For live job searches, search the web rather than relying on model memory. Prefer current employer or major job-board listings, include the listing date when available, and distinguish sourced facts from your fit analysis.
- You are the primary conversational router. Handle straightforward questions yourself. When a request clearly benefits from a specialist (engineering, business operations, product, customer operations, or Chief of Staff synthesis), delegate the concrete task to the appropriate internal specialist instead of pretending you completed specialist work yourself.
- Do not delegate simple conversational questions just to use the team. Delegate when specialist context, project work, implementation, or structured synthesis would materially improve the result.
- When a specialist is delegated, use its returned result as input to your answer and clearly distinguish specialist analysis from actions actually executed.
- When David explicitly asks you to remember something, actually call save_memory.
- When David asks for a reminder, use save_memory with a due time when one is clear.
- After using a tool, tell David what you actually did. Never claim an action happened unless the tool succeeded.
- Never expose secrets, API keys, database credentials, or internal configuration.

Current projects:
${JSON.stringify(context.projects, null, 2)}

Available capabilities:
${JSON.stringify(context.capabilities, null, 2)}

Private internal AI team:
${JSON.stringify(teamRoles, null, 2)}

Recent team work:
${JSON.stringify(recentTeamTasks, null, 2)}

Team rules: The team is private to David. It is for building and operating David's projects, not for ClearCFO customers. Delegate concrete work to specialists instead of pretending you personally completed external actions.

Relevant memory:
${JSON.stringify(context.memories, null, 2)}

Live portfolio state:
${JSON.stringify(context.portfolioState, null, 2)}

Derived portfolio guidance:
${context.portfolioGuidance || 'No manual-balance caution applies.'}

Uploaded Excel files available for this turn:
${JSON.stringify(excelFiles, null, 2)}

Excel rules: when files are attached, use excel_summary first if the user has not asked a specific question; use excel_query for all arithmetic; never treat missing or empty cells as zero; do not dump raw tables into chat; when David asks for a workbook, use excel_build and provide the generated download action.
`;
}

async function callSpecialist({ roleKey, system, user, runId, onAction }) {
  let input = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const tools = roleKey === 'engineering'
    ? [...engineeringToolDefinitions(), ...renderToolDefinitions()]
    : undefined;

  for (let turn = 0; turn < 6; turn += 1) {
    const body = { model: openAIModel, input };
    if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || 'Specialist agent request failed.');

    const toolCalls = (data.output || []).filter(item => item.type === 'function_call');
    if (!toolCalls.length) {
      const text = data.output_text || (data.output || []).flatMap(item => item.content || []).map(part => part.text || '').join('').trim();
      if (!text) throw new Error('Specialist agent returned no text.');
      return text;
    }

    input = [...input, ...(data.output || [])];
    for (const call of toolCalls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch {}
      let result;
      if (call.name.startsWith('github_')) {
        if (call.name === 'github_create_pr') {
          result = await executeSkill('github_create_pr', args, {
            pool, runId, execute: () => ({ ok: true, approvedExecutionRequired: true }),
          });
        } else {
          result = await executeEngineeringTool(call.name, args, github);
          await auditToolCall(pool, { runId, skill: call.name, tier: 'safe', decision: result.ok ? 'allow' : 'error', args, durationMs: 0, error: result.ok ? null : result.error });
        }
      } else if (call.name.startsWith('render_')) {
        if (call.name === 'render_redeploy') {
          result = await executeSkill('render_redeploy', args, {
            pool, runId, execute: () => ({ ok: true, approvedExecutionRequired: true }),
          });
        } else {
          result = await executeRenderTool(call.name, args, renderOps);
          await auditToolCall(pool, { runId, skill: call.name, tier: 'safe', decision: result.ok ? 'allow' : 'error', args, durationMs: 0, error: result.ok ? null : result.error });
        }
      } else {
        result = { ok: false, error: `Unknown engineering tool: ${call.name}` };
      }

      if (result?.approvalRequired && onAction) {
        onAction({
          type: 'tool.approval',
          approvalId: result.approval?.approvalId,
          skill: call.name,
          args,
          expiresAt: result.approval?.expiresAt,
          tier: result.policy?.tier,
          preview: call.name === 'github_create_pr' ? {
            title: args.title,
            branch: args.branch,
            diff: String(args.diff || '').slice(0, 12000),
            files: (args.files || []).map(file => ({ path: file.path, content: file.content }))
          } : null
        });
      }
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }
  }
  throw new Error('Engineering specialist reached its tool-call limit.');
}

function buildToolDeps({ actions = [], runId = null, skipPolicy = false, overrides = {} } = {}) {
  const resolvedRunId = runId || `chat_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  return {
    pool,
    hasEmailReminders,
    hasNtfyReminders,
    scheduleReminderEmail,
    scheduleReminderNtfy,
    getAgentContext,
    recordHolding,
    deleteHolding,
    deleteManualHoldings,
    getPortfolioSummary,
    getJobApplicationHistory,
    saveJobApplication: saveApplicationWithWorkflow,
    recordInterview,
    getWorkflows,
    deliverWorkflowMessage,
    caldav,
    emailClients,
    github,
    renderOps,
    delegateToTeam,
    getExcelFile,
    profileExcelFile: profileFile,
    queryExcelFile,
    buildExcelWorkbook: buildWorkbook,
    createExcelFile,
    deleteExcelFile,
    excelUploadDir: UPLOAD_DIR,
    callSpecialist: (args) => callSpecialist({ ...args, runId: resolvedRunId, onAction: action => actions.push(action) }),
    onAction: action => actions.push(action),
    runId: resolvedRunId,
    skipPolicy,
    ...overrides
  };
}

async function runAgent(message, imageDataUrl = null, fileIds = []) {
  const actions = [];
  if (!hasOpenAI) throw new Error('OPENAI_API_KEY is not configured on the server yet.');
  const context = await getAgentContext(pool, { includeGithub: isWorkPriorityQuestion(message) });
  const ids = [...new Set((Array.isArray(fileIds) ? fileIds : []).map(Number).filter(id => Number.isInteger(id)))];
  if (ids.length > MAX_FILES_PER_MESSAGE) throw new Error('You can attach up to 5 Excel/CSV files per message.');
  const excelFiles = [];
  let totalBytes = 0;
  for (const id of ids) {
    const file = await getExcelFile(pool, id, 'source');
    if (!file || !fs.existsSync(file.path)) throw new Error('One of the attached Excel files was not found or has expired.');
    totalBytes += Number(file.size_bytes || 0);
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('The attached files exceed the 100 MB total limit for one message.');
    const profile = await profileFile(file.path, file.name);
    excelFiles.push({ id:file.id, name:file.name, size_bytes:Number(file.size_bytes), sheet_names:file.sheet_names, total_rows:file.total_rows, profile });
  }
  const teamRoles = getTeamRoles();
  const recentTeamTasks = await getRecentTeamTasks(pool, 12);
  const recent = pool ? (await pool.query(`SELECT role, content FROM agent_messages ORDER BY created_at DESC LIMIT 12`)).rows.reverse() : [];
  const image = validateImageDataUrl(imageDataUrl);
  const userContent = image
    ? [{ type: 'input_text', text: String(message || '').trim().slice(0, 10000) || 'Please analyze this image.' }, { type: 'input_image', image_url: image, detail: 'auto' }]
    : String(message || '').trim().slice(0, 10000);
  if (!String(message || '').trim() && !image && !excelFiles.length) throw new Error('Message, image, or Excel file is required.');

  const input = [
    { role: 'system', content: agentSystemPrompt(context, teamRoles, recentTeamTasks, excelFiles) },
    ...recent.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];

  const job = inferJob(message, excelFiles.length > 0, recent);
  const tools = buildAgentTools({ job, enabledCapabilities: context.capabilities });
  let responseInput = input;

  for (let turn = 0; turn < 4; turn += 1) {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: openAIModel, input: responseInput, tools, tool_choice: 'auto' }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || 'The AI agent request failed.');

    const toolCalls = (data.output || []).filter(item => item.type === 'function_call');
    if (!toolCalls.length) {
      const text = data.output_text || (data.output || [])
        .flatMap(item => item.content || [])
        .map(part => part.text || '')
        .join('')
        .trim();
      if (!text) throw new Error('The AI agent returned no text.');
      return { text, actions };
    }
    responseInput = [...responseInput, ...(data.output || [])];
    for (const call of toolCalls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch {}
      const result = await executeAgentTool(call.name, args, buildToolDeps({
        actions,
        runId: `chat_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
      }))
      responseInput.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }
  }

  throw new Error('The agent reached its tool-call limit before completing the request.');
}

app.get('/api/calendar.ics', (req, res) => {
  const title = String(req.query.title || 'Calendar event').slice(0, 200);
  const start = new Date(String(req.query.start || ''));
  const end = new Date(String(req.query.end || ''));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) return res.status(400).type('text').send('Invalid calendar event.');
  const esc = value => String(value || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const dt = value => { const d = new Date(value); const pad = n => String(n).padStart(2, '0'); return d.getUTCFullYear()+pad(d.getUTCMonth()+1)+pad(d.getUTCDate())+'T'+pad(d.getUTCHours())+pad(d.getUTCMinutes())+pad(d.getUTCSeconds())+'Z'; };
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//David Personal Agent//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','BEGIN:VEVENT','UID:'+Date.now()+'@personal-memory-bank','DTSTAMP:'+dt(new Date()),'DTSTART:'+dt(start),'DTEND:'+dt(end),'SUMMARY:'+esc(title)];
  if (req.query.notes) lines.push('DESCRIPTION:'+esc(String(req.query.notes).slice(0, 4000)));
  if (req.query.location) lines.push('LOCATION:'+esc(String(req.query.location).slice(0, 500)));
  lines.push('END:VEVENT','END:VCALENDAR');
  res.setHeader('Content-Type','text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition','inline; filename="personal-agent-event.ics"');
  res.setHeader('Cache-Control','no-store');
  res.send(lines.join('\r\n')+'\r\n');
});

app.post('/api/webhooks/github', async (req, res) => {
  if (!githubWebhookSecret) return res.status(503).json({ error: 'GitHub webhook is not configured.' });
  const signature = String(req.get('x-hub-signature-256') || '');
  if (!verifyGitHubSignature(githubWebhookSecret, req.rawBody || Buffer.from(''), signature)) return res.status(401).json({ error: 'Invalid webhook signature.' });

  const deliveryId = String(req.get('x-github-delivery') || '');
  const eventName = String(req.get('x-github-event') || '');
  if (!deliveryId || !eventName) return res.status(400).json({ error: 'Missing GitHub webhook headers.' });

  try {
    if (pool) {
      const inserted = await pool.query(
        'INSERT INTO github_webhook_events(delivery_id,event_name,action,payload) VALUES($1,$2,$3,$4) ON CONFLICT(delivery_id) DO NOTHING RETURNING delivery_id',
        [deliveryId, eventName, req.body?.action || null, JSON.stringify(req.body || {})]
      );
      if (!inserted.rowCount) return res.json({ ok: true, duplicate: true });
    }

    if (failedCheckRunEvent(eventName, req.body)) {
      const check = req.body.check_run;
      const pr = check.pull_requests?.[0]?.number;
      const repo = req.body.repository?.full_name || process.env.GITHUB_REPO || 'coxdavid9/personal-memory-bank';
      const subject = `CI failed on PR #${pr || '?'}`;
      const text = `${subject} in ${repo}. Failing check: ${check.name || 'unknown'}. Open the Personal Agent to inspect the PR and logs.`;
      const email = await sendAgentEmail(subject, text);
      return res.json({ ok: true, notificationSent: email.sent });
    }

    if (eventName === 'push' && req.body?.ref === 'refs/heads/main' && pool) {
      const head = req.body.head_commit;
      if (head?.id) {
        await pool.query(
          'INSERT INTO memories(text,type,priority) VALUES($1,$2,$3)',
          [`GitHub main changed: ${head.id.slice(0,12)} — ${String(head.message || '').split('\\n')[0].slice(0,300)}`, 'Work', 'Normal']
        );
      }
    }

    if (eventName === 'pull_request' && req.body?.action === 'closed' && req.body?.pull_request?.merged && pool) {
      const pr = req.body.pull_request;
      await pool.query(
        'INSERT INTO memories(text,type,priority) VALUES($1,$2,$3)',
        [`GitHub PR #${pr.number} merged: ${String(pr.title || '').slice(0,300)} — ${String(pr.merge_commit_sha || '').slice(0,12)}`, 'Work', 'Normal']
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('GitHub webhook processing failed:', err);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

app.post('/api/internal/daily-portfolio', async (req, res) => {
  if (!dailyPortfolioCronSecret) return res.status(503).json({ error: 'Daily portfolio scheduler is not configured.' });
  const supplied = String(req.get('x-daily-portfolio-secret') || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(dailyPortfolioCronSecret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const result = await runDailyPortfolioAgent({ pool, getPortfolioSummary });
    res.json({
      ok: true,
      asOf: result.asOf,
      decision: result.gate.notify ? 'notify' : 'silent',
      reason: result.gate.reason,
      notificationSent: result.notificationSent
    });
  } catch (err) {
    console.error('Daily portfolio agent failed:', err);
    res.status(500).json({ error: err.message || 'Daily portfolio agent failed.' });
  }
});

app.get('/api/portfolio', async (req,res) => {
  try { res.json(await getPortfolioSummary(pool)); }
  catch (err) { console.error('Portfolio summary failed:',err); res.status(500).json({error:'Unable to load portfolio.'}); }
});

app.post('/api/portfolio/holdings', async (req,res) => {
  try {
    const result=await recordHolding(pool,req.body||{});
    if(!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  } catch(err) { console.error('Manual holding failed:',err); res.status(500).json({error:'Unable to save holding.'}); }
});

app.delete('/api/portfolio/holdings/:id', async (req,res) => {
  try {
    const result=await deleteHolding(pool, req.params.id);
    if (!result.ok) return res.status(404).json({ error:'Manual holding not found.' });
    res.json(result);
  } catch(err) { console.error('Manual holding delete failed:',err); res.status(500).json({error:'Unable to delete holding.'}); }
});

app.delete('/api/portfolio/holdings', async (req,res) => {
  if (String(req.query.source || '') !== 'manual' || String(req.query.confirm || '') !== 'true') {
    return res.status(400).json({ error:'Explicit confirmation is required: source=manual&confirm=true.' });
  }
  try {
    const result=await deleteManualHoldings(pool);
    if (!result.ok) return res.status(503).json(result);
    res.json(result);
  } catch(err) { console.error('Manual holdings cleanup failed:',err); res.status(500).json({error:'Unable to delete manual holdings.'}); }
});



app.get('/api/team', async (req, res) => {
  try {
    res.json({ roles: getTeamRoles(), recentTasks: await getRecentTeamTasks(pool, 30), integrations: { github: Boolean(github) } });
  } catch (err) {
    console.error('Unable to load agent team:', err);
    res.status(500).json({ error: 'Unable to load agent team.' });
  }
});

app.get('/api/status', (req, res) => res.json({ authenticated: isAuthenticated(req), authConfigured: Boolean(authPassword && authSecret), persistentStorage: hasDatabase, emailReminders: hasEmailReminders, ntfyReminders: hasNtfyReminders, aiAgent: hasOpenAI, clearCfoConnected: Boolean(clearCfoApiUrl), caldavConfigured: Boolean(caldav), caldavCalendar: caldav ? caldav.calendarName : null, model: openAIModel }));

app.get('/api/agent/context', async (req, res) => {
  try { res.json(await getAgentContext()); } catch (err) { console.error(err); res.status(500).json({ error: 'Unable to load agent context.' }); }
});

app.get('/api/workflows', async (req,res) => {
  try {
    const result = await executeSkill('get_workflows',{}, {pool,execute:()=>getWorkflows(pool)});
    res.json(result);
  } catch (err) { res.status(500).json({error:'Unable to load workflows.'}); }
});

app.get('/api/approvals', async (req, res) => {
  if (!pool) return res.json({ approvals: [], decided: [] });
  try {
    const { rows } = await pool.query(`SELECT id, created_at AS "createdAt", expires_at AS "expiresAt", run_id AS "runId", skill, args, status, decided_at AS "decidedAt", decision FROM tool_approvals WHERE status='pending' ORDER BY created_at ASC`);
    for (const approval of rows) if (new Date(approval.expiresAt).getTime() <= Date.now()) {
      await pool.query('UPDATE tool_approvals SET status=\'expired\', decided_at=NOW(), decision=\'timeout\' WHERE id=$1 AND status=\'pending\'', [approval.id]);
      approval.status = 'expired';
      approval.decision = 'timeout';
    }
    const { rows: decided } = await pool.query(`SELECT id, status, decision, decided_at AS "decidedAt" FROM tool_approvals WHERE status IN ('approved','denied','expired') ORDER BY decided_at DESC NULLS LAST LIMIT 100`);
    res.json({ approvals: rows.filter(row => row.status === 'pending'), decided });
  } catch (err) { res.status(500).json({ error: 'Unable to load approvals.' }); }
});

async function getLatestAgentMessages(db, limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const { rows } = await db.query(`SELECT id, role, content, actions, created_at AS created FROM agent_messages ORDER BY created_at DESC LIMIT $1`, [safeLimit]);
  return rows.reverse();
}

async function recordApprovalDecision(db, approval, decision) {
  const verb = decision === 'approve' ? 'Approved' : 'Denied';
  const content = `${verb}: ${approval.skill}.`;
  await db.query(
    'INSERT INTO agent_messages(role,content,actions) VALUES($1,$2,$3)',
    ['assistant', content, JSON.stringify([])]
  );
  return content;
}

app.post('/api/approvals/:id/decision', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Persistent storage is not configured yet.' });
  try {
    const id = Number(req.params.id);
    const decision = String(req.body.decision || '').toLowerCase();
    const current = await getApproval(pool, id);
    if (!current) return res.status(404).json({ error: 'Approval not found.' });
    if (decision === 'deny') {
      const result = await decideApproval(pool, id, 'deny');
      if (result.ok) await recordApprovalDecision(pool, current, 'deny');
      return res.json(result);
    }
    if (decision !== 'approve') return res.status(400).json({ error: 'Decision must be approve or deny.' });
    const result = await decideApproval(pool, id, 'approve');
    if (!result.ok) return res.status(409).json(result);
    await recordApprovalDecision(pool, current, 'approve');

    const actions = [];
    const execution = await executeAgentTool(current.skill, current.args, buildToolDeps({
      actions,
      runId: current.runId,
      skipPolicy: true
    }))
    await auditToolCall(pool, { runId: current.runId, skill: current.skill, tier: 'ask', decision: 'approved_execute', args: current.args, durationMs: 0 });
    res.json({ ok: true, approval: result.approval, execution, actions });
  } catch (err) {
    console.error('Approval execution failed:', err);
    res.status(500).json({ error: err.message || 'Unable to execute approved action.' });
  }
});


const excelUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { ensureUploadDir(); cb(null, UPLOAD_DIR); },
    filename: (_req, file, cb) => cb(null, `upload-${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${safeFileName(file.originalname)}`)
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_MESSAGE, parts: MAX_FILES_PER_MESSAGE + 2 },
  fileFilter: (_req, file, cb) => isSpreadsheetName(file.originalname) ? cb(null, true) : cb(new Error(`"${file.originalname}" is not an Excel/CSV file. Excel/CSV uploads only.`))
});

app.post('/api/files', (req, res) => {
  excelUpload.array('files', MAX_FILES_PER_MESSAGE)(req, res, async err => {
    const uploaded = req.files || [];
    const cleanup = async () => { for (const file of uploaded) await fs.promises.unlink(file.path).catch(() => {}); };
    if (err) {
      await cleanup();
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `"${err.filename || 'The file'}" is larger than 25 MB.` });
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_COUNT') return res.status(413).json({ error: 'You can upload up to 5 Excel/CSV files at a time.' });
      return res.status(400).json({ error: err.message || 'Unable to upload the files.' });
    }
    if (!uploaded.length) return res.status(400).json({ error: 'Choose one or more .xlsx, .xls, or .csv files.' });
    const total = uploaded.reduce((sum, file) => sum + Number(file.size || 0), 0);
    if (total > MAX_TOTAL_BYTES) { await cleanup(); return res.status(413).json({ error: 'The selected files exceed the 100 MB total upload limit.' }); }
    try {
      if (!pool) { await cleanup(); return res.status(503).json({ error: 'Persistent storage is not configured yet.' }); }
      const results=[];
      for (const file of uploaded) {
        if (!isSpreadsheetName(file.originalname)) throw new Error(`"${file.originalname}" is not an Excel/CSV file.`);
        const profile=await profileFile(file.path,file.originalname);
        const row=await createExcelFile(pool,{name:safeFileName(file.originalname),sizeBytes:file.size,path:file.path,profile,mimeType:file.mimetype||'application/octet-stream',kind:'source'});
        results.push({id:Number(row.id),name:row.name,size_bytes:Number(row.size_bytes)});
      }
      res.status(201).json(results);
    } catch (uploadErr) {
      await cleanup();
      console.error('Excel upload failed:',uploadErr);
      res.status(400).json({ error: uploadErr.message || 'Unable to process the uploaded Excel file.' });
    }
  });
});

app.get('/api/files/:id/download', async (req, res) => {
  try {
    const file=await getExcelFile(pool,req.params.id,'generated');
    if(!file) return res.status(404).json({error:'Generated workbook not found or expired.'});
    if(!fs.existsSync(file.path)) return res.status(404).json({error:'Generated workbook is no longer available.'});
    res.download(file.path,file.name,{headers:{'Cache-Control':'no-store'}});
  } catch(err) { console.error('Excel download failed:',err); res.status(500).json({error:'Unable to download the workbook.'}); }
});

app.get('/api/agent/messages', async (req, res) => {
  if (!pool) return res.json({ messages: [] });
  try {
    const { rows } = await getLatestAgentMessages(pool, 100);
    res.json({ messages: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Unable to load agent conversation.' }); }
});

app.post('/api/agent/chat', async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 10000);
  const image = req.body.imageDataUrl || null;
  const fileIds = Array.isArray(req.body.fileIds) ? req.body.fileIds : [];
  if (!message && !image && !fileIds.length) return res.status(400).json({ error: 'Message or image is required.' });
  try {
    const rawFileIds = Array.isArray(req.body.fileIds) ? req.body.fileIds : [];
    const result = await runAgent(message, image, rawFileIds);
    if (pool) {
      await pool.query('INSERT INTO agent_messages(role,content) VALUES($1,$2)', ['user', message || (rawFileIds.length ? '[Excel files attached]' : '[Image attached]')]);
      await pool.query('INSERT INTO agent_messages(role,content,actions) VALUES($1,$2,$3)', ['assistant', result.text, JSON.stringify(result.actions || [])]);
    }
    res.json({ reply: result.text, actions: result.actions || [] });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message || 'Unable to run agent.' }); }
});

app.patch('/api/capabilities/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Persistent storage is not configured yet.' });
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid capability id.' });
    if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean.' });
    const { rows } = await pool.query(
      'UPDATE agent_capabilities SET enabled=$1,updated_at=NOW() WHERE id=$2 RETURNING id,key,name,description,enabled,config',
      [req.body.enabled, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Capability not found.' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(400).json({ error: 'Unable to update capability.' }); }
});

app.patch('/api/projects/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Persistent storage is not configured yet.' });
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid project id.' });
    const { rows } = await pool.query(
      `UPDATE agent_projects SET status = CASE status WHEN 'active' THEN 'paused' WHEN 'paused' THEN 'done' WHEN 'done' THEN 'active' ELSE 'active' END, updated_at=NOW() WHERE id=$1 RETURNING id,name,description,status`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Project not found.' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(400).json({ error: 'Unable to update project.' }); }
});

app.get('/api/projects', async (req, res) => {
  if (!pool) return res.json({ projects: [] });
  try { const { rows } = await pool.query('SELECT * FROM agent_projects ORDER BY name'); res.json({ projects: rows }); }
  catch (err) { res.status(500).json({ error: 'Unable to load projects.' }); }
});

app.get('/api/memories', async (req, res) => {
  if (!pool) return res.json({ persistentStorage: false, memories: [] });
  try { const { rows } = await pool.query(`SELECT id, created_at AS created, text, type, due_at AS due, priority, done, reminder_email_id FROM memories ORDER BY done ASC, due ASC NULLS LAST, created_at DESC`); res.json({ persistentStorage: true, memories: rows }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Unable to load memories.' }); }
});

app.post('/api/memories', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Persistent storage is not configured yet.' });
  try {
    const memory = cleanMemory(req.body);
    if (!memory.text) return res.status(400).json({ error: 'Text is required.' });
    const { rows } = await pool.query(`INSERT INTO memories(text,type,due_at,priority) VALUES($1,$2,$3,$4) RETURNING id,created_at AS created,text,type,due_at AS due,priority,done,reminder_email_id`, [memory.text, memory.type, memory.due, memory.priority]);
    const saved = rows[0]; let reminderScheduled = false; let reminderChannels = []; let reminderError = null;
    if (saved.due) {
      if (hasEmailReminders) try { const scheduled = await scheduleReminderEmail(saved); if (scheduled.id) { saved.reminder_email_id = scheduled.id; reminderScheduled = true; reminderChannels.push('email'); await pool.query('UPDATE memories SET reminder_email_id=$1 WHERE id=$2', [scheduled.id, saved.id]); } } catch (err) { reminderError = err.message; console.error('Reminder email scheduling failed:', err); }
      if (hasNtfyReminders) try { if (await scheduleReminderNtfy(saved)) { reminderScheduled = true; reminderChannels.push('phone'); } } catch (err) { reminderError = reminderError || err.message; console.error('Phone reminder scheduling failed:', err); }
    }
    res.status(201).json({ ...saved, reminderScheduled, reminderChannels, reminderError });
  } catch (err) { console.error(err); res.status(400).json({ error: 'Unable to save memory.' }); }
});

app.patch('/api/memories/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Persistent storage is not configured yet.' });
  try {
    const id = Number(req.params.id);
    const currentResult = await pool.query(`SELECT id,created_at AS created,text,type,due_at AS due,priority,done,reminder_email_id FROM memories WHERE id=$1`, [id]);
    const current = currentResult.rows[0]; if (!current) return res.status(404).json({ error: 'Memory not found.' });
    const done = Boolean(req.body.done);
    if (done) { if (current.reminder_email_id) await cancelReminderEmail(current.reminder_email_id); await cancelReminderNtfy(current.id); }
    let reminderEmailId = done ? null : current.reminder_email_id;
    if (!done && !reminderEmailId && current.due && hasEmailReminders) try { const scheduled = await scheduleReminderEmail({ ...current, done: false }); reminderEmailId = scheduled.id || null; } catch (err) { console.error('Reminder rescheduling failed:', err); }
    if (!done && current.due && hasNtfyReminders) try { await cancelReminderNtfy(current.id); await scheduleReminderNtfy({ ...current, done: false }); } catch (err) { console.error('Phone reminder rescheduling failed:', err); }
    const { rows } = await pool.query(`UPDATE memories SET done=$1,reminder_email_id=$2 WHERE id=$3 RETURNING id,created_at AS created,text,type,due_at AS due,priority,done,reminder_email_id`, [done, reminderEmailId, id]);
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(400).json({ error: 'Unable to update memory.' }); }
});

app.delete('/api/memories/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Persistent storage is not configured yet.' });
  try { const id = Number(req.params.id); const { rows } = await pool.query('SELECT reminder_email_id FROM memories WHERE id=$1', [id]); if (rows[0]?.reminder_email_id) await cancelReminderEmail(rows[0].reminder_email_id); await cancelReminderNtfy(id); await pool.query('DELETE FROM memories WHERE id=$1', [id]); res.status(204).end(); }
  catch (err) { console.error(err); res.status(400).json({ error: 'Unable to delete memory.' }); }
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  initDb().then(async () => {
    if (pool) {
      let workflowTickRunning = false;
      const tick = async () => {
        if (workflowTickRunning) return;
        workflowTickRunning = true;
        try { await processDueWorkflows(pool); }
        catch (err) { console.error('Workflow tick failed:', err.message); }
        finally { workflowTickRunning = false; }
      };
      await tick();
      setInterval(tick, 30 * 1000).unref();
    }
    if (pool) setInterval(() => purgeExpiredExcelFiles(pool).catch(err => console.error('Excel purge failed:', err)), 24 * 60 * 60 * 1000);
    if (caldav) await caldav.discover();
    app.listen(port, '0.0.0.0', () => console.log(`Personal Agent running on ${port}; storage:${hasDatabase}; AI:${hasOpenAI}; ClearCFO:${Boolean(clearCfoApiUrl)}; CalDAV:${Boolean(caldav)}`));
  }).catch(err => { console.error('Database initialization failed:', err); process.exit(1); });
}

module.exports = { app, buildToolDeps, getAgentContext, getLatestAgentMessages, recordApprovalDecision, isWorkPriorityQuestion, buildGitHubPriorityItems, agentSystemPrompt, emailHtml };
