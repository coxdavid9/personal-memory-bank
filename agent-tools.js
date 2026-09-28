const { executeSkill } = require('./policy');

const memoryTool = {
  type: 'function',
  name: 'save_memory',
  description: 'Save something important to David\'s personal memory. Use this when David explicitly asks you to remember, save, track, or remind him about something.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The concise fact, task, idea, or follow-up to remember.' },
      type: { type: 'string', enum: ['Work','Personal','Idea','Follow-up','Learning'], description: 'Memory category.' },
      due: { type: ['string','null'], description: 'ISO 8601 due/reminder time, or null if none.' },
      priority: { type: 'string', enum: ['Low','Normal','High'], description: 'Priority.' }
    },
    required: ['text','type','due','priority'],
    additionalProperties: false
  }
};

const contextTool = {
  type: 'function',
  name: 'get_personal_context',
  description: 'Retrieve current personal-agent context when the available context in the prompt is not enough. Returns recent memories, projects, and capabilities.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false
  }
};

const portfolioSummaryTool = {
  type: 'function',
  name: 'get_portfolio_summary',
  description: 'Report David\'s current investment portfolio from manual holdings and later Plaid-synced holdings. Use this for questions about total value, accounts, holdings, allocation, or how the portfolio is doing. Do not give buy/sell recommendations.',
  strict: true,
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
};

const recordHoldingTool = {
  type: 'function',
  name: 'record_holding',
  description: 'Record or update a manual investment holding. Use when David gives you a current account balance or ticker/share count. Manual holdings are never overwritten by Plaid sync.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'Account name, such as 401k or Fidelity.' },
      ticker: { type: ['string','null'], description: 'Ticker symbol, or null for a balance-only account.' },
      shares: { type: ['number','null'], description: 'Number of shares, or null for balance-only holdings.' },
      balance: { type: ['number','null'], description: 'Manual dollar balance, or null for share-based holdings.' }
    },
    required: ['account','ticker','shares','balance'],
    additionalProperties: false
  }
};

const calendarEventTool = {
  type: 'function',
  name: 'create_calendar_event',
  description: 'Prepare a calendar event for David. Use this when David asks to put something on his calendar, schedule an event, block time, or add a calendar reminder. The PWA will present an Add to iPhone Calendar action; the native iPhone client can create it on-device. Use ISO 8601 timestamps with an explicit timezone offset.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short calendar event title.' },
      start: { type: 'string', description: 'ISO 8601 start timestamp with timezone offset.' },
      end: { type: 'string', description: 'ISO 8601 end timestamp with timezone offset.' },
      notes: { type: ['string','null'], description: 'Optional event notes.' },
      location: { type: ['string','null'], description: 'Optional event location.' },
      allDay: { type: 'boolean', description: 'Whether this is an all-day event.' }
    },
    required: ['title','start','end','notes','location','allDay'],
    additionalProperties: false
  }
};



const jobHistoryTool = {
  type: 'function',
  name: 'get_job_application_history',
  description: "Retrieve David's tracked job applications and rejections so live job searches can exclude roles he already applied to or rejected. Use before evaluating live jobs.",
  strict: true,
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
};

const saveJobApplicationTool = {
  type: 'function',
  name: 'save_job_application',
  description: 'Track a job David has applied to, rejected, saved for later, or wants to ignore. Use when David explicitly tells you about a job decision or asks you to track it.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Job title.' },
      company: { type: 'string', description: 'Employer name.' },
      location: { type: ['string','null'], description: 'Job location, or null.' },
      url: { type: ['string','null'], description: 'Job listing URL, or null.' },
      status: { type: 'string', enum: ['saved','applied','rejected','ignore'], description: 'Current decision/status.' },
      notes: { type: ['string','null'], description: 'Optional notes about the job.' }
    },
    required: ['title','company','location','url','status','notes'],
    additionalProperties: false
  }
};

const delegateTeamTool = {
  type: 'function',
  name: 'delegate_to_team',
  description: 'Delegate a private task to one specialist on David’s internal AI team. Use for engineering, business operations, product, customer operations, or Chief of Staff work. This team is internal only and is never exposed to ClearCFO customers.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: ['chief_of_staff','engineering','business_ops','product','customer_ops'], description: 'Specialist role to handle the task.' },
      task: { type: 'string', description: 'The concrete task for the specialist.' },
      project: { type: ['string','null'], description: 'Related project, such as ClearCFO, Personal Agent, Portfolio, or Job Search.' },
      context: { type: ['string','null'], description: 'Relevant context the specialist needs.' }
    },
    required: ['role','task','project','context'],
    additionalProperties: false
  }
};

const JOB_SKILLS = Object.freeze({
  general: ['save_memory','get_personal_context','get_portfolio_summary','delegate_to_team'],
  job_search: ['save_memory','get_personal_context','get_job_application_history','save_job_application'],
  portfolio: ['save_memory','get_personal_context','get_portfolio_summary','record_holding'],
  calendar: ['save_memory','get_personal_context','create_calendar_event'],
  engineering: ['save_memory','get_personal_context','delegate_to_team'],
  business: ['save_memory','get_personal_context','delegate_to_team'],
  product: ['save_memory','get_personal_context','delegate_to_team']
});

function inferJob(message = '') {
  const text = String(message).toLowerCase();
  if (/job|jobs|career|hiring|position|opening|accounting role|finance role|apply|application/.test(text)) return 'job_search';
  if (/calendar|schedule|appointment|meeting|block time|reminder on my iphone/.test(text)) return 'calendar';
  if (/portfolio|401k|fidelity|voo|spaxx|holding|investment/.test(text)) return 'portfolio';
  if (/github|pull request|pr #|code|bug|deploy|render|repository|repo|test/.test(text)) return 'engineering';
  if (/customer|revenue|cost|business|sales|operations/.test(text)) return 'business';
  return 'general';
}

function buildAgentTools({ job = 'general' } = {}) {
  const all = [memoryTool, contextTool, calendarEventTool, portfolioSummaryTool, recordHoldingTool, jobHistoryTool, saveJobApplicationTool, delegateTeamTool];
  const allowed = new Set(JOB_SKILLS[job] || JOB_SKILLS.general);
  const selected = all.filter(tool => allowed.has(tool.name));
  if (job === 'job_search') selected.push({ type: 'web_search_preview' });
  return selected;
}

async function executeAgentTool(name, args, deps) {
  const runId = deps.runId || `chat_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const run = async (skill, fn) => {
    if (deps.skipPolicy) return fn();
    const result = await executeSkill(skill, args, { pool: deps.pool, runId, execute: fn });
    if (result?.approvalRequired && deps.onAction) deps.onAction({ type: 'tool.approval', approvalId: result.approval?.approvalId, skill, args: result.approval?.args || args, expiresAt: result.approval?.expiresAt, tier: result.policy?.tier });
    return result;
  };
  if (name === 'github_create_pr') {
    if (!deps.github) return { ok: false, error: 'GitHub integration is not configured.' };
    return run('github_create_pr', () => deps.github.createPR({
      repository: args.repository,
      branch: args.branch,
      base: args.base,
      title: args.title,
      body: args.body,
      draft: Boolean(args.draft),
      files: args.files
    }));
  }

  if (name === 'render_redeploy') {
    if (!deps.renderOps) return { ok: false, error: 'Render integration is not configured.' };
    return run('render_redeploy', () => deps.renderOps.redeploy());
  }

  if (name === 'delegate_to_team') {
    if (!deps.delegateToTeam || !deps.callSpecialist) return { ok: false, error: 'The internal team is not configured.' };
    return run('delegate_to_team', () => deps.delegateToTeam({ pool: deps.pool, roleKey: args.role, task: args.task, project: args.project, context: args.context, callOpenAI: deps.callSpecialist }));
  }

  if (name === 'get_job_application_history') return run('get_job_application_history', () => deps.getJobApplicationHistory(deps.pool));
  if (name === 'save_job_application') return run('save_job_application', () => deps.saveJobApplication(deps.pool, args));

  if (name === 'record_holding') return run('record_holding', () => deps.recordHolding(deps.pool, args));
  if (name === 'get_portfolio_summary') return run('get_portfolio_summary', async () => ({ ok: true, portfolio: await deps.getPortfolioSummary(deps.pool) }));

  if (name === 'save_memory') {
    return run('save_memory', async () => {
    if (!deps.pool) return { ok: false, error: 'Persistent memory is not configured.' };
    const memory = {
      text: String(args.text || '').trim().slice(0, 5000),
      type: String(args.type || 'Work').slice(0, 40),
      due: args.due ? new Date(args.due).toISOString() : null,
      priority: String(args.priority || 'Normal').slice(0, 20)
    };
    if (!memory.text) return { ok: false, error: 'Memory text is required.' };
    const { rows } = await deps.pool.query(
      `INSERT INTO memories(text,type,due_at,priority) VALUES($1,$2,$3,$4)
       RETURNING id,created_at AS created,text,type,due_at AS due,priority,done`,
      [memory.text, memory.type, memory.due, memory.priority]
    );
    const saved = rows[0];
    let reminderScheduled = false;
    let reminderChannels = [];
    if (saved.due) {
      if (deps.hasEmailReminders) {
        try {
          const scheduled = await deps.scheduleReminderEmail(saved);
          if (scheduled.id) {
            reminderScheduled = true;
            reminderChannels.push('email');
            await deps.pool.query('UPDATE memories SET reminder_email_id=$1 WHERE id=$2', [scheduled.id, saved.id]);
          }
        } catch (err) {
          console.error('Agent email reminder scheduling failed:', err);
        }
      }
      if (deps.hasNtfyReminders) {
        try {
          if (await deps.scheduleReminderNtfy(saved)) {
            reminderScheduled = true;
            reminderChannels.push('phone');
          }
        } catch (err) {
          console.error('Agent phone reminder scheduling failed:', err);
        }
      }
    }
      return { ok: true, memory: saved, reminderScheduled, reminderChannels };
    });
  }

  if (name === 'create_calendar_event') {
    return run('create_calendar_event', async () => {
    const start = new Date(args.start);
    const end = new Date(args.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return { ok: false, error: 'Calendar event dates must be valid ISO 8601 timestamps.' };
    }
    if (end.getTime() <= start.getTime() && !args.allDay) {
      return { ok: false, error: 'Calendar event end must be after its start.' };
    }
    const action = {
      type: 'calendar.create_event',
      delivery: 'pwa_ics_or_native_client',
      title: String(args.title || '').trim().slice(0, 200),
      start: start.toISOString(),
      end: end.toISOString(),
      notes: args.notes ? String(args.notes).slice(0, 4000) : null,
      location: args.location ? String(args.location).slice(0, 500) : null,
      allDay: Boolean(args.allDay)
    };
    if (!action.title) return { ok: false, error: 'Calendar event title is required.' };
    if (deps.caldav?.isConfigured()) {
      try {
        await deps.caldav.createCalDAVEvent(action);
        action.delivery = 'caldav';
        if (deps.onAction) deps.onAction(action);
        return { ok: true, delivery: 'caldav', action };
      } catch (err) {
        console.error('CalDAV calendar write failed; falling back to PWA handoff:', err.message);
      }
    }
    if (deps.onAction) deps.onAction(action);
      return { ok: true, preparedForCalendar: true, delivery: 'pwa_ics_or_native_client', action };
    });
  }

  if (name === 'get_personal_context') return run('get_personal_context', async () => ({ ok: true, context: await deps.getAgentContext() }));

  return { ok: false, error: `Unknown agent tool: ${name}` };
}

module.exports = { JOB_SKILLS, inferJob, buildAgentTools, executeAgentTool };
