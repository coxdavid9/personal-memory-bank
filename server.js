const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const { buildAgentTools, executeAgentTool } = require('./agent-tools');

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
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#172033"><title>Personal Agent — Sign in</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fb;margin:0;min-height:100vh;display:grid;place-items:center;color:#172033}.card{width:min(90%,380px);background:#fff;border:1px solid #e4e7ec;border-radius:18px;padding:28px;box-shadow:0 8px 30px #10182812}h1{margin:0 0 8px}.muted{color:#667085;font-size:14px;margin-bottom:20px}input{width:100%;box-sizing:border-box;padding:13px;border:1px solid #d0d5dd;border-radius:10px;font:inherit;margin-bottom:10px}button{width:100%;padding:13px;border:0;border-radius:10px;background:#172033;color:#fff;font-weight:700;font:inherit}.error{color:#b42318;background:#fef3f2;padding:9px;border-radius:9px;margin-bottom:12px;font-size:13px}</style></head><body><main class="card"><h1>🧠 Personal Agent</h1><div class="muted">Private access</div>${safe?`<div class="error">${safe}</div>`:''}<form method="POST" action="/login"><input name="password" type="password" autocomplete="current-password" placeholder="Password" autofocus required><button>Sign in</button></form></main></body></html>`;
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  if (req.path === '/login' || req.path === '/api/auth/login' || req.path === '/api/status' || req.path === '/manifest.webmanifest' || req.path === '/sw.js' || req.path.startsWith('/icons/')) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required.' });
  return res.redirect('/login');
}
const pool = hasDatabase
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

app.use(express.json({ limit: '200kb' }));
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
    ['calendar', 'iPhone Calendar', 'Prepare calendar events for the iPhone. The PWA presents an Add to iPhone Calendar action; the native mobile app can also create events on-device after permission is granted.'],
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
- When David asks to put something on his iPhone Calendar, use create_calendar_event. The PWA will present the prepared event as an iCalendar file the user can add to Calendar; the native mobile client can create it on-device after permission is granted.
- You have tools. Use them when an action is appropriate instead of merely telling David how to do it.
- When David explicitly asks you to remember something, actually call save_memory.
- When David asks for a reminder, use save_memory with a due time when one is clear.
- After using a tool, tell David what you actually did. Never claim an action happened unless the tool succeeded.
- Never expose secrets, API keys, database credentials, or internal configuration.

Current projects:
${JSON.stringify(context.projects, null, 2)}

Available capabilities:
${JSON.stringify(context.capabilities, null, 2)}

Relevant memory:
${JSON.stringify(context.memories, null, 2)}`;
}

async function runAgent(message) {
  const actions = [];
  if (!hasOpenAI) throw new Error('OPENAI_API_KEY is not configured on the server yet.');
  const context = await getAgentContext();
  const recent = pool ? (await pool.query(`SELECT role, content FROM agent_messages ORDER BY created_at DESC LIMIT 12`)).rows.reverse() : [];
  const input = [
    { role: 'system', content: agentSystemPrompt(context) },
    ...recent.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  const tools = buildAgentTools();
  let responseInput = input;

  for (let turn = 0; turn < 4; turn += 1) {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: openAIModel,
        input: responseInput,
        tools,
        tool_choice: 'auto',
      }),
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

    responseInput = [
      ...responseInput,
      ...(data.output || []),
    ];

    for (const call of toolCalls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); }
      catch { args = {}; }

      const result = await executeAgentTool(call.name, args, {
        pool,
        hasEmailReminders,
        hasNtfyReminders,
        scheduleReminderEmail,
        scheduleReminderNtfy,
        getAgentContext,
        onAction: (action) => actions.push(action),
      });

      responseInput.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
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
  res.send(lines.join('\\r\\n')+'\\r\\n');
});

app.get('/api/status', (req, res) => res.json({ authenticated: isAuthenticated(req), authConfigured: Boolean(authPassword && authSecret), persistentStorage: hasDatabase, emailReminders: hasEmailReminders, ntfyReminders: hasNtfyReminders, aiAgent: hasOpenAI, clearCfoConnected: Boolean(clearCfoApiUrl), model: openAIModel }));

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
    const result = await runAgent(message);
    if (pool) {
      await pool.query('INSERT INTO agent_messages(role,content) VALUES($1,$2)', ['user', message]);
      await pool.query('INSERT INTO agent_messages(role,content) VALUES($1,$2)', ['assistant', result.text]);
    }
    res.json({ reply: result.text, actions: result.actions || [] });
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

initDb().then(() => app.listen(port, '0.0.0.0', () => console.log(`Personal Agent running on ${port}; storage:${hasDatabase}; AI:${hasOpenAI}; ClearCFO:${Boolean(clearCfoApiUrl)}`))).catch(err => { console.error('Database initialization failed:', err); process.exit(1); });
