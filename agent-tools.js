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

function buildAgentTools() {
  return [memoryTool, contextTool, calendarEventTool, portfolioSummaryTool, recordHoldingTool, delegateTeamTool];
}

async function executeAgentTool(name, args, deps) {
  if (name === 'delegate_to_team') {
    if (!deps.delegateToTeam || !deps.callSpecialist) return { ok: false, error: 'The internal team is not configured.' };
    return deps.delegateToTeam({ pool: deps.pool, roleKey: args.role, task: args.task, project: args.project, context: args.context, callOpenAI: deps.callSpecialist });
  }

  if (name === 'record_holding') return deps.recordHolding(deps.pool, args);
  if (name === 'get_portfolio_summary') return { ok: true, portfolio: await deps.getPortfolioSummary(deps.pool) };

  if (name === 'save_memory') {
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
  }

  if (name === 'create_calendar_event') {
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
  }

  if (name === 'get_personal_context') {
    return { ok: true, context: await deps.getAgentContext() };
  }

  return { ok: false, error: `Unknown agent tool: ${name}` };
}

module.exports = { buildAgentTools, executeAgentTool };
