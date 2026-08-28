const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 10000;
const hasDatabase = Boolean(process.env.DATABASE_URL);
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
      done BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
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

app.get('/api/status', (req, res) => {
  res.json({ persistentStorage: hasDatabase });
});

app.get('/api/memories', async (req, res) => {
  if (!pool) return res.json({ persistentStorage: false, memories: [] });
  try {
    const { rows } = await pool.query(`
      SELECT id, created_at AS created, text, type, due_at AS due, priority, done
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
      RETURNING id, created_at AS created, text, type, due_at AS due, priority, done
    `, [memory.text, memory.type, memory.due, memory.priority]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Unable to save memory.' });
  }
});

app.patch('/api/memories/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Persistent storage is not configured yet.' });
  try {
    const id = Number(req.params.id);
    const done = Boolean(req.body.done);
    const { rows } = await pool.query(`
      UPDATE memories SET done=$1 WHERE id=$2
      RETURNING id, created_at AS created, text, type, due_at AS due, priority, done
    `, [done, id]);
    if (!rows[0]) return res.status(404).json({ error: 'Memory not found.' });
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
    app.listen(port, () => console.log(`Memory Bank running on ${port}; persistent storage: ${hasDatabase}`));
  })
  .catch((err) => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
