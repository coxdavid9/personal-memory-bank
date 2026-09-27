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

function buildAgentTools() {
  return [memoryTool, contextTool];
}

async function executeAgentTool(name, args, deps) {
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

  if (name === 'get_personal_context') {
    return { ok: true, context: await deps.getAgentContext() };
  }

  return { ok: false, error: `Unknown agent tool: ${name}` };
}

module.exports = { buildAgentTools, executeAgentTool };
