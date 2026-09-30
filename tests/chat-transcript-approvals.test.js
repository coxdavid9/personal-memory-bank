const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getLatestAgentMessages, recordApprovalDecision } = require('../server');

test('latest transcript returns newest 100 in chronological order', async () => {
  let seenSql = '';
  let seenLimit = null;
  const newestFirst = Array.from({ length: 100 }, (_, i) => ({
    id: 200 - i,
    role: 'assistant',
    content: `message ${200 - i}`,
    actions: [],
    created: new Date(200 - i)
  }));
  const db = {
    query: async (sql, params) => {
      seenSql = sql;
      seenLimit = params?.[0];
      return { rows: newestFirst };
    }
  };

  const rows = await getLatestAgentMessages(db, 100);

  assert.match(seenSql, /ORDER BY created_at DESC LIMIT \$1/);
  assert.equal(seenLimit, 100);
  assert.equal(rows.length, 100);
  assert.equal(rows[0].id, 101);
  assert.equal(rows[99].id, 200);
});

test('approval decision is persisted with the affected skill', async () => {
  const inserts = [];
  const db = {
    query: async (sql, params) => {
      if (/INSERT INTO agent_messages/.test(sql)) inserts.push({ sql, params });
      return { rows: [] };
    }
  };

  const content = await recordApprovalDecision(db, { skill: 'save_job_application' }, 'approve');

  assert.equal(content, 'Approved: save_job_application.');
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0].params, ['assistant', 'Approved: save_job_application.', '[]']);
});

test('inline approval rendering reconciles against live pending approvals', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /pendingApprovalIds\.has\(id\)/);
  assert.match(html, /Approval status unavailable/);
  assert.doesNotMatch(html, /Already decided/);
  assert.match(html, /Expired/);
  assert.match(html, /approvalStateLoaded/);
});
