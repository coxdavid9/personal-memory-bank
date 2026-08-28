const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 10000;
const hasDatabase = Boolean(process.env.DATABASE_URL);
const hasEmailReminders = Boolean(process.env.RESEND_API_KEY && process.env.REMINDER_EMAIL);
const appUrl = process.env.APP_URL || 'https://personal-memory-bank.onrender.com';
const reminderFrom = process.env.REMINDER_FROM || 'Personal Memory Bank <onboarding@resend.dev>';
const pool = hasDatabase
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

app.use(express.json({ limit: '100kb' }));
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
  const safeText = String(memory.text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const safeType = String(memory.type || 'Work').replace(/[&<>"']/g, '');
  const safePriority = String(memory.priority || 'Normal').replace(/[&<>"']/g, '');
  const due = new Date(memory.due).toLocaleString('en-US', {
    dateStyle: 'full',
    timeStyle: 'short',
  });
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#20242a">
      <h2 style="margin-bottom:6px">🧠 Personal Memory Bank</h2>
      <p style="color:#667085">You asked me to bring this back to your attention.</p>
      <div style="border:1px solid #e5e7eb;border-left:4px solid #f79009;border-radius:10px;padding:16px;margin:20px 0">
        <div style="font-size:12px;color:#667085;margin-bottom:8px">${safeType} · ${safePriority} · ${due}</div>
        <div style="font-size:18px;font-weight:600">${safeText}</div>
      </div>
      <a href="${appUrl}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:10px 14px;border-radius:9px">Open Memory Bank</a>
    </div>
  `;
}

async function scheduleReminderEmail(memory) {
  if (!hasEmailReminders || !memory.due || memory.done) return { id: null };
  const due = new Date(memory.due);
  const now = Date.now();
  const max = now + 30 * 24 * 60 * 60 * 1000;
  if (Number.isNaN(due.getTime()) || due.getTime() <= now || due.getTime() > max) return { id: null };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: reminderFrom,
      to: [process.env.REMINDER_EMAIL],
      subject: `Reminder: ${memory.text.slice(0, 90)}`,
      html: emailHtml(memory),
      scheduledAt: due.toISOString(),
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || 'Unable to schedule reminder email.');
  }
  return { id: data.id || null };
}

async function cancelReminderEmail(emailId) {
  if (!hasEmailReminders || !emailId) return;
  const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(emailId)}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    console.error('Unable to cancel scheduled reminder:', data?.message || data?.error || response.statusText);
  }
}

app.get('/api/status', (req, res) => {
  res.json({ persistentStorage: hasDatabase, emailReminders: hasEmailReminders });
});

app.get('/api/memories', async (req, res) => {
  if (!pool) return res.json({ persistentStorage: false, memories: [] });
  try {
    const { rows } = await pool.query(`
      SELECT id, created_at AS created, text, type, due_at AS due, priority, done, reminder_email_id
      FROM memories
      ORDER BY done ASC, due ASC NULLS LAST, created_at DESC
    `);
    res.json({ persistentStorage: true, memories: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to load memories.' });
  }
});

app.post('/api/memories', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Persistent storage is not configured yet.' });
  try {
    const memory = cleanMemory(req.body);
    if (!memory.text) return res.status(400).json({ error: 'Text is required.' });

    const { rows } = await pool.query(`
      INSERT INTO memories(text, type, due_at, priority)
      VALUES($1, $2, $3, $4)
      RETURNING id, created_at AS created, text, type, due_at AS due, priority, done, reminder_email_id
    `, [memory.text, memory.type, memory.due, memory.priority]);

    const saved = rows[0];
    let reminderScheduled = false;
    let reminderError = null;

    if (saved.due && hasEmailReminders) {
      try {
        const scheduled = await scheduleReminderEmail(saved);
        if (scheduled.id) {
          saved.reminder_email_id = scheduled.id;
          reminderScheduled = true;
          await pool.query('UPDATE memories SET reminder_email_id=$1 WHERE id=$2', [scheduled.id, saved.id]);
        }
      } catch (err) {
        reminderError = err.message;
        console.error('Reminder scheduling failed:', err);
      }
    }

    res.status(201).json({ ...saved, reminderScheduled, reminderError });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Unable to save memory.' });
  }
});

app.patch('/api/memories/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Persistent storage is not configured yet.' });
  try {
    const id = Number(req.params.id);
    const currentResult = await pool.query(`
      SELECT id, created_at AS created, text, type, due_at AS due, priority, done, reminder_email_id
      FROM memories WHERE id=$1
    `, [id]);
    const current = currentResult.rows[0];
    if (!current) return res.status(404).json({ error: 'Memory not found.' });

    const done = Boolean(req.body.done);
    if (done && current.reminder_email_id) await cancelReminderEmail(current.reminder_email_id);

    let reminderEmailId = done ? null : current.reminder_email_id;
    if (!done && !reminderEmailId && current.due && hasEmailReminders) {
      try {
        const scheduled = await scheduleReminderEmail({ ...current, done: false });
        reminderEmailId = scheduled.id || null;
      } catch (err) {
        console.error('Reminder rescheduling failed:', err);
      }
    }

    const { rows } = await pool.query(`
      UPDATE memories SET done=$1, reminder_email_id=$2 WHERE id=$3
      RETURNING id, created_at AS created, text, type, due_at AS due, priority, done, reminder_email_id
    `, [done, reminderEmailId, id]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Unable to update memory.' });
  }
});

app.delete('/api/memories/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Persistent storage is not configured yet.' });
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query('SELECT reminder_email_id FROM memories WHERE id=$1', [id]);
    if (rows[0]?.reminder_email_id) await cancelReminderEmail(rows[0].reminder_email_id);
    await pool.query('DELETE FROM memories WHERE id=$1', [id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Unable to delete memory.' });
  }
});

// Express 5 SPA fallback.
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb()
  .then(() => {
    app.listen(port, () => console.log(`Memory Bank running on ${port}; persistent storage: ${hasDatabase}; email reminders: ${hasEmailReminders}`));
  })
  .catch((err) => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
