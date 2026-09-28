const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deleteHolding, deleteManualHoldings } = require('../portfolio');
const { buildAgentTools, executeAgentTool } = require('../agent-tools');
const { classifySkill, TIERS } = require('../policy');

test('deleteHolding only removes manual holdings', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rowCount: 1 };
  }};
  const result = await deleteHolding(pool, 42);
  assert.deepEqual(result, { ok: true });
  assert.match(calls[0].sql, /source\s*=\s*'manual'/i);
  assert.deepEqual(calls[0].params, [42]);
});

test('deleteManualHoldings targets manual rows only and returns count', async () => {
  const pool = { query: async (sql) => {
    assert.match(sql, /source\s*=\s*'manual'/i);
    return { rowCount: 3 };
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
