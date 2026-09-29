const fs = require('fs');
const path = require('path');
const { executeSkill } = require('./policy');

const IMAGE_DATA_URL_RE = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/i;
const MAX_IMAGE_DATA_URL_LENGTH = 4_500_000;
function validateImageDataUrl(value) {
  if (value == null || value === '') return null;
  const image = String(value);
  if (image.length > MAX_IMAGE_DATA_URL_LENGTH) throw new Error('Image is too large. Please use an image under about 3.5 MB.');
  if (!IMAGE_DATA_URL_RE.test(image)) throw new Error('Unsupported image. Please upload a JPEG, PNG, WebP, or GIF image.');
  return image;
}

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

const deleteHoldingTool = {
  type: 'function',
  name: 'delete_holding',
  description: 'Delete a manual investment holding by its id, or all manual holdings at once. Use when David asks to remove portfolio entries. Never delete plaid-synced holdings.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      holding_id: { type: ['number','null'], description: 'Holding id to delete, or null to delete all manual holdings.' },
      delete_all_manual: { type: 'boolean', description: 'Set true to delete every manual holding.' }
    },
    required: ['delete_all_manual'],
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


const excelSummaryTool = {
  type: 'function',
  name: 'excel_summary',
  description: 'Return the structural profile of an uploaded Excel or CSV file. Use this to understand sheets, row counts, columns, detected types, and samples without dumping the raw table.',
  strict: true,
  parameters: {
    type: 'object',
    properties: { file_id: { type: 'integer', description: 'Uploaded source file id.' } },
    required: ['file_id'],
    additionalProperties: false
  }
};

const excelQueryTool = {
  type: 'function',
  name: 'excel_query',
  description: 'Deterministically compute over an uploaded Excel or CSV file. Supported operations: sum, avg, min, max, group_by, top_n, filter. All arithmetic happens in the tool, not in the model.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'integer', description: 'Uploaded source file id.' },
      sheet: { type: 'string', description: 'Exact sheet name, or CSV for a CSV file.' },
      operation: { type: 'string', enum: ['sum','avg','min','max','group_by','top_n','filter'], description: 'Deterministic operation.' },
      column: { type: ['string','null'], description: 'Numeric/value column for the operation.' },
      group_by: { type: ['string','null'], description: 'Column to group by when operation is group_by.' },
      limit: { type: 'integer', description: 'Maximum rows/groups returned.' },
      filters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string' },
            op: { type: 'string', enum: ['eq','contains','gt','gte','lt','lte'] },
            value: { type: ['string','number','null'] }
          },
          required: ['column','op','value'],
          additionalProperties: false
        }
      }
    },
    required: ['file_id','sheet','operation','column','group_by','limit','filters'],
    additionalProperties: false
  }
};

const excelBuildTool = {
  type: 'function',
  name: 'excel_build',
  description: 'Generate a new Excel workbook from a JSON workbook specification and return a download action. Use for requested summaries, analysis workbooks, and follow-up deliverables.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Output workbook filename.' },
      sheets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            headers: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array', items: {} } }
          },
          required: ['name','headers','rows'],
          additionalProperties: false
        }
      }
    },
    required: ['name','sheets'],
    additionalProperties: false
  }
};

const excelDeleteTool = {
  type: 'function',
  name: 'excel_delete',
  description: 'Delete an uploaded source Excel/CSV file. This action requires David approval and never deletes generated workbooks through the chat tool.',
  strict: true,
  parameters: {
    type: 'object',
    properties: { file_id: { type: 'integer', description: 'Uploaded source file id.' } },
    required: ['file_id'],
    additionalProperties: false
  }
};

const JOB_SKILLS = Object.freeze({
  general: ['save_memory','get_personal_context','get_portfolio_summary','delegate_to_team'],
  excel_analysis: ['save_memory','get_personal_context','excel_summary','excel_query','excel_build','excel_delete','delegate_to_team'],
  job_search: ['save_memory','get_personal_context','get_job_application_history','save_job_application'],
  portfolio: ['save_memory','get_personal_context','get_portfolio_summary','record_holding','delete_holding'],
  calendar: ['save_memory','get_personal_context','create_calendar_event'],
  engineering: ['save_memory','get_personal_context','delegate_to_team'],
  business: ['save_memory','get_personal_context','delegate_to_team'],
  product: ['save_memory','get_personal_context','delegate_to_team']
});

function inferJob(message = '', hasFiles = false) {
  const text = String(message).toLowerCase();
  if (hasFiles) return 'excel_analysis';
  if (/job|jobs|career|hiring|position|opening|accounting role|finance role|apply|application/.test(text)) return 'job_search';
  if (/calendar|schedule|appointment|meeting|block time|reminder on my iphone/.test(text)) return 'calendar';
  if (/portfolio|401k|fidelity|voo|spaxx|holding|investment/.test(text)) return 'portfolio';
  if (/github|pull request|pr #|code|bug|deploy|render|repository|repo|test/.test(text)) return 'engineering';
  if (/customer|revenue|cost|business|sales|operations/.test(text)) return 'business';
  return 'general';
}

function buildAgentTools({ job = 'general' } = {}) {
  const all = [memoryTool, contextTool, calendarEventTool, portfolioSummaryTool, recordHoldingTool, deleteHoldingTool, jobHistoryTool, saveJobApplicationTool, delegateTeamTool, excelSummaryTool, excelQueryTool, excelBuildTool, excelDeleteTool];
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


  if (name === 'excel_summary') return run('excel_summary', async () => {
    const file = await deps.getExcelFile(deps.pool, args.file_id, 'source');
    if (!file) return { ok: false, error: 'Uploaded Excel file not found or expired.' };
    return { ok: true, file: { id:file.id, name:file.name, size_bytes:Number(file.size_bytes), sheet_names:file.sheet_names, total_rows:file.total_rows }, profile: await deps.profileExcelFile(file.path, file.name) };
  });
  if (name === 'excel_query') return run('excel_query', async () => {
    const file = await deps.getExcelFile(deps.pool, args.file_id, 'source');
    if (!file) return { ok: false, error: 'Uploaded Excel file not found or expired.' };
    return { ok: true, file: { id:file.id, name:file.name }, result: await deps.queryExcelFile(file.path, file.name, args) };
  });
  if (name === 'excel_build') return run('excel_build', async () => {
    if (!deps.pool) return { ok:false, error:'Persistent storage is not configured.' };
    const name = String(args.name || 'analysis.xlsx').replace(/[^a-zA-Z0-9._-]/g,'_').replace(/\.xlsx$/i,'') + '.xlsx';
    const tempPath = path.join(deps.excelUploadDir, 'generated-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.xlsx');
    await deps.buildExcelWorkbook(tempPath, { sheets: args.sheets || [] });
    const stat = await fs.promises.stat(tempPath);
    const row = await deps.createExcelFile(deps.pool, { name, sizeBytes: stat.size, path: tempPath, profile: { sheets: (args.sheets || []).map(s => ({ name:s.name })), total_rows: (args.sheets || []).reduce((n,s)=>n+(s.rows||[]).length,n) }, mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind:'generated' });
    const action = { type:'file_download', fileId:row.id, name:row.name, url:'/api/files/'+row.id+'/download' };
    if (deps.onAction) deps.onAction(action);
    return { ok:true, file:row, action };
  });
  if (name === 'excel_delete') return run('excel_delete', () => deps.deleteExcelFile(deps.pool, args.file_id));

  if (name === 'get_job_application_history') return run('get_job_application_history', () => deps.getJobApplicationHistory(deps.pool));
  if (name === 'save_job_application') return run('save_job_application', () => deps.saveJobApplication(deps.pool, args));

  if (name === 'record_holding') return run('record_holding', () => deps.recordHolding(deps.pool, args));
  if (name === 'delete_holding') {
    if (args.delete_all_manual) return run('delete_holding', () => deps.deleteManualHoldings(deps.pool));
    if (args.holding_id == null) return { ok:false, error:'Provide a holding id or set delete_all_manual to true.' };
    return run('delete_holding', () => deps.deleteHolding(deps.pool, args.holding_id));
  }
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

module.exports = { JOB_SKILLS, inferJob, buildAgentTools, executeAgentTool, validateImageDataUrl };
