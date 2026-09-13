const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 10000;
const hasDatabase = Boolean(process.env.DATABASE_URL);
const hasEmailReminders = Boolean(process.env.RESEND_API_KEY && process.env.REMINDER_EMAIL);
const hasNtfyReminders = Boolean(process.env.NTFY_TOPIC);
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const appUrl = process.env.APP_URL || 'https://personal-memory-bank.onrender.com';
const reminderFrom = process.env.REMINDER_FROM || 'Personal Memory Bank <onboarding@resend.dev>';
const ntfyTopic = process.env.NTFY_TOPIC;
const openAIModel = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const clearCfoApiUrl = process.env.CLEARCFO_API_URL || '';
const pool = hasDatabase
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS agent_messages_created_idx ON agent_messages(created_at DESC)`);

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

  const capabilities = [
    ['memory', 'Memory', 'Remember important information and bring it back at the right time.'],
    ['clearcfo', 'ClearCFO', 'Work with ClearCFO project context and, when configured, query the ClearCFO backend for current data.'],
    ['job-search', 'Job Search', 'Search and evaluate accounting/finance jobs using David’s saved preferences and application history.'],
    ['calendar', 'iPhone Calendar', 'Planned capability for permissioned iPhone Calendar and Reminder access.'],
  ];
  for (const [key, name, description] of capabilities) {
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
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#20242a"><h2>🧠 Personal Agent</h2><p style="color:#667085">You asked me to bring this back to your attention.</p><div style="border:1px solid #e5e7eb;border-left:4px solid #f79009;border-radius:10px;padding:16px;margin:20px 0"><div style="font-size:12px;color:#667085;margin-bottom:8px">${safeType} · ${safePriority} · ${due}</div><div style="font-size:18px;font-weight:600">${safeText}</div></div><a href="${appUrl}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:10px 14px;border-radius:9px">Open Personal Agent</a></div>`;
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

async function getAgentContext() {
  if (!pool) return { memories: [], projects: [], capabilities: [] };
  const [memories, projects, capabilities] = await Promise.all([
    pool.query(`SELECT id, created_at AS created, text, type, due_at AS due, priority, done FROM memories ORDER BY done ASC, due ASC NULLS LAST, created_at DESC LIMIT 80`),
    pool.query(`SELECT id, name, description, status FROM agent_projects ORDER BY name`),
    pool.query(`SELECT key, name, description, enabled, config FROM agent_capabilities ORDER BY name`),
  ]);
  return { memories: memories.rows, projects: projects.rows, capabilities: capabilities.rows };
}

function agentSystemPrompt(context) {
  return `You are David's personal AI agent. You are not a generic chatbot. Your job is to understand David's priorities, remember useful context, help him make decisions, and move projects forward. Be direct and practical. Do not invent facts. If information is missing, say so and propose the next step.

Architecture rules:
- Memory is personal context, not customer data.
- ClearCFO project knowledge can live in memory, but customer financial data must remain in ClearCFO's own backend/database and should only be accessed through an explicit, controlled integration.
- Job search is a capability. Use saved preferences and application history when evaluating jobs; never pretend a job is new if the data does not establish that.
- Calendar is permissioned device data and should only be used when the user grants access.
- Never expose secrets, API keys, database credentials, or internal configuration.

Current projects:
${JSON.stringify(context.projects, null, 2)}

Available capabilities:
${JSON.stringify(context.capabilities, null, 2)}

Relevant memory:
${JSON.stringify(context.memories, null, 2)}`;
}

async function runAgent(message) {
  if (!hasOpenAI) throw new Error('OPENAI_API_KEY is not configured on the server yet.');
  const context = await getAgentContext();
  const recent = pool ? (await pool.query(`SELECT role, content FROM agent_messages ORDER BY created_at DESC LIMIT 12`)).rows.reverse() : [];
  const input = [
    { role: 'system', content: agentSystemPrompt(context) },
    ...recent.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: openAIModel, input }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'The AI agent request failed.');
  const text = data.output_text || (data.output || []).flatMap(item => item.content || []).map(part => part.text || '').join('').trim();
  if (!text) throw new Error('The AI agent returned no text.');
  return text;
}

app.get('/api/status', (req, res) => res.json({ persistentStorage: hasDatabase, emailReminders: hasEmailReminders, ntfyReminders: hasNtfyReminders, aiAgent: hasOpenAI, clearCfoConnected: Boolean(clearCfoApiUrl), model: openAIModel }));

app.get('/api/agent/context', async (req, res) => {
  try { res.json(await getAgentContext()); } catch (err) { console.error(err); res.status(500).json({ error: 'Unable to load agent context.' }); }
});

app.get('/api/agent/messages', async (req, res) => {
  if (!pool) return res.json({ messages: [] });
  try { const { rows } = await pool.query(`SELECT id, role, content, created_at AS created FROM agent_messages ORDER BY created_at ASC LIMIT 100`); res.json({ messages: rows }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Unable to load agent conversation.' }); }
});

app.post('/api/agent/chat', async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 10000);
  if (!message) return res.status(400).json({ error: 'Message is required.' });
  try {
    const reply = await runAgent(message);
    if (pool) {
      await pool.query('INSERT INTO agent_messages(role,content) VALUES($1,$2)', ['user', message]);
      await pool.query('INSERT INTO agent_messages(role,content) VALUES($1,$2)', ['assistant', reply]);
    }
    res.json({ reply });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message || 'Unable to run agent.' }); }
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

initDb().then(() => app.listen(port, () => console.log(`Personal Agent running on ${port}; storage:${hasDatabase}; AI:${hasOpenAI}; ClearCFO:${Boolean(clearCfoApiUrl)}`))).catch(err => { console.error('Database initialization failed:', err); process.exit(1); });
