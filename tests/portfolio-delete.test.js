const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deleteHolding, deleteManualHoldings, buildPortfolioContext, isStalePortfolioGuidance } = require('../portfolio');
const { buildAgentTools, executeAgentTool } = require('../agent-tools');
const { classifySkill, TIERS } = require('../policy');

test('deleteHolding only removes manual holdings', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/COUNT\(\*\).*source='manual'/i.test(sql)) return { rows: [{ count: 1 }] };
    return { rowCount: 1 };
  }};
  const result = await deleteHolding(pool, 42);
  assert.deepEqual(result, { ok: true });
  assert.match(calls[0].sql, /source\s*=\s*'manual'/i);
  assert.deepEqual(calls[0].params, [42]);
});

test('deleteManualHoldings targets manual rows only and returns count', async () => {
  let step = 0;
  const pool = { query: async (sql) => {
    assert.match(sql, /source\s*=\s*'manual'/i);
    step += 1;
    if (step === 1) return { rowCount: 3 };
    if (step === 2) return { rows: [] };
    if (step === 3) return { rowCount: 1 };
    throw new Error('Unexpected query');
  }};
  assert.deepEqual(await deleteManualHoldings(pool), { ok: true, deleted: 3 });
});

test('portfolio delete tool is approval-gated and isolated from general tools', () => {
  assert.equal(classifySkill('delete_holding').tier, TIERS.ASK);
  assert.equal(classifySkill('delete_secret').tier, TIERS.BLOCK);
  const names = buildAgentTools({ job: 'portfolio' }).map(tool => tool.name).filter(Boolean);
  assert.ok(names.includes('delete_holding'));
  assert.ok(!buildAgentTools({ job: 'general' }).map(tool => tool.name).includes('delete_holding'));
});

test('delete_holding executor never receives a Plaid delete path', async () => {
  let deletedId = null;
  let deletedAll = false;
  const result = await executeAgentTool('delete_holding', { holding_id: 7, delete_all_manual: false }, {
    skipPolicy: true,
    deleteHolding: async (_pool, id) => { deletedId = id; return { ok: true }; },
    deleteManualHoldings: async () => { deletedAll = true; return { ok: true, deleted: 0 }; },
    pool: {}
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(deletedId, 7);
  assert.equal(deletedAll, false);
});

test('portfolio delete endpoints are present and require explicit manual confirmation', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.delete\('\/api\/portfolio\/holdings\/:id'/);
  assert.match(server, /app\.delete\('\/api\/portfolio\/holdings'/);
  assert.match(server, /source.*manual.*confirm.*true/s);
});


test('manual portfolio deletion retires stale guidance and writes one superseding note', async () => {
  const queries = [];
  let step = 0;
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      step += 1;
      if (step === 1) return { rowCount: 1 }; // holdings delete
      if (step === 2) return { rowCount: 1 }; // stale guidance update
      if (step === 3) return { rows: [] }; // no active superseding note yet
      if (step === 4) return { rowCount: 1 }; // superseding note insert
      throw new Error('Unexpected query');
    }
  };
  assert.deepEqual(await deleteManualHoldings(pool), { ok: true, deleted: 1 });
  assert.match(queries[1].sql, /UPDATE memories SET done=true/i);
  assert.match(queries[1].sql, /fake/i);
  assert.match(queries[3].sql, /INSERT INTO memories/i);
  assert.match(queries[3].params[0], /^Manual holdings deleted \d{4}-\d{2}-\d{2}; none remain\. Portfolio is empty pending Plaid\.$/);
});

test('portfolio guidance is derived from live counts, not stored caution notes', () => {
  assert.equal(isStalePortfolioGuidance('Don’t rely on the current manual investment numbers; they are fake.'), true);
  assert.equal(buildPortfolioContext({ manualCount: 0, plaidCount: 0 }).guidance, null);
  assert.match(buildPortfolioContext({ manualCount: 2, plaidCount: 1 }).guidance, /Manual holdings are present/);
});

test('freshness rules make live portfolio state outrank an old holdings note', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /memory notes describe what was true when written/);
  assert.match(server, /Live state wins on conflict/);
  assert.match(server, /context\.portfolioState\.manualCount > 0/);
  assert.match(server, /If it is 0, do not mention fake, stale, or unreliable manual numbers/);
  assert.match(server, /buildPortfolioContext/);
  assert.match(server, /COUNT\(\*\) FILTER \(WHERE source='manual'\)/);
});
