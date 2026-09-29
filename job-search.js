async function initJobSearchDb(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_applications (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT NULL,
      url TEXT NULL,
      status TEXT NOT NULL CHECK (status IN ('saved','applied','rejected','ignore')),
      notes TEXT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS job_applications_company_title_idx ON job_applications(LOWER(company), LOWER(title))');
  await pool.query('CREATE INDEX IF NOT EXISTS job_applications_status_idx ON job_applications(status)');
}

function isDismissedJobText(text) {
  return /\b(stale|closed|dismissed|ignore|ignored|resolved|no longer available)\b/i.test(String(text || ''));
}

async function getJobApplicationHistory(pool) {
  if (!pool) return { applications: [], legacyMemories: [] };
  const applications = await pool.query(`
    SELECT id, created_at AS created, updated_at AS updated, title, company, location, url, status, notes
    FROM job_applications
    ORDER BY updated_at DESC
    LIMIT 200
  `);
  const legacyMemories = await pool.query(`
    SELECT id, created_at AS created, text, priority
    FROM memories
    WHERE LOWER(text) LIKE '%applied%'
       OR LOWER(text) LIKE '%rejected%'
       OR LOWER(text) LIKE '%job%'
       OR LOWER(text) LIKE '%nestle%'
       OR LOWER(text) LIKE '%hytrol%'
       OR LOWER(text) LIKE '%aercap%'
       OR LOWER(text) LIKE '%canteen%'
    ORDER BY created_at DESC
    LIMIT 100
  `);
  return { applications: applications.rows, legacyMemories: legacyMemories.rows };
}

async function saveJobApplication(pool, args) {
  if (!pool) return { ok: false, error: 'Persistent storage is not configured.' };
  const title = String(args.title || '').trim().slice(0, 300);
  const company = String(args.company || '').trim().slice(0, 200);
  if (!title || !company) return { ok: false, error: 'Job title and company are required.' };

  const existing = await pool.query(`
    SELECT id FROM job_applications
    WHERE LOWER(title)=LOWER($1) AND LOWER(company)=LOWER($2)
    ORDER BY updated_at DESC LIMIT 1
  `, [title, company]);
  if (existing.rows[0]) {
    const result = await pool.query(`
      UPDATE job_applications
      SET location=$1, url=$2, status=$3, notes=$4, updated_at=NOW()
      WHERE id=$5
      RETURNING id, created_at AS created, updated_at AS updated, title, company, location, url, status, notes
    `, [
      args.location ? String(args.location).slice(0, 300) : null,
      args.url ? String(args.url).slice(0, 2000) : null,
      args.status,
      args.notes ? String(args.notes).slice(0, 4000) : null,
      existing.rows[0].id
    ]);
    return { ok: true, application: result.rows[0], updated: true };
  }

  const result = await pool.query(`
    INSERT INTO job_applications(title, company, location, url, status, notes)
    VALUES($1,$2,$3,$4,$5,$6)
    RETURNING id, created_at AS created, updated_at AS updated, title, company, location, url, status, notes
  `, [
    title,
    company,
    args.location ? String(args.location).slice(0, 300) : null,
    args.url ? String(args.url).slice(0, 2000) : null,
    args.status,
    args.notes ? String(args.notes).slice(0, 4000) : null
  ]);
  return { ok: true, application: result.rows[0] };
}

module.exports = { initJobSearchDb, getJobApplicationHistory, saveJobApplication, isDismissedJobText };
