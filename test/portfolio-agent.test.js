const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attentionGate,
  getThresholdFromMemories,
  runDailyPortfolioAgent
} = require('../portfolio-agent');

test('quiet 0.2% move stays silent', () => {
  const result = attentionGate({
    dayChangePct: 0.2,
    dayChange: 200,
    totalIncomplete: false,
    stale: false,
    missingQuotes: [],
    holdings: []
  }, null, 1);
  assert.equal(result.notify, false);
});

test('2.1% move notifies', () => {
  const result = attentionGate({
    dayChangePct: 2.1,
    dayChange: 2560,
    totalIncomplete: false,
    stale: false,
    missingQuotes: [],
    holdings: []
  }, null, 1);
  assert.equal(result.notify, true);
  assert.equal(result.reason, 'material_portfolio_move');
});

test('quote failure with no snapshot notifies', () => {
  const result = attentionGate({
    dayChangePct: null,
    dayChange: null,
    totalIncomplete: true,
    stale: true,
    staleSignature: 'VOO:quote unavailable',
    missingQuotes: ['VOO'],
    holdings: []
  }, null, 1);
  assert.equal(result.notify, true);
  assert.equal(result.reason, 'quote_failure_no_snapshot');
});

test('same stale episode notifies once', () => {
  const briefing = {
    dayChangePct: null,
    dayChange: null,
    totalIncomplete: false,
    stale: true,
    staleSignature: 'VOO:Yahoo Finance unavailable',
    missingQuotes: [],
    holdings: []
  };
  const first = attentionGate(briefing, null, 1);
  const second = attentionGate(briefing, {
    attention_key: first.attentionKey,
    notification_sent: true,
    total_incomplete: false
  }, 1);
  assert.equal(first.notify, true);
  assert.equal(second.notify, false);
});

test('threshold memory overrides default percentage', () => {
  assert.equal(getThresholdFromMemories([{text: 'Only bother me if the portfolio moves more than 2%'}]), 2);
  assert.equal(getThresholdFromMemories([{text: 'Normal portfolio preference'}]), 1);
});

test('silent run still records a snapshot and never calls notifier', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT account,ticker')) return { rows: [
        { account: 'Fidelity', ticker: 'VOO', value: '70760' }
      ], rowCount: 1 };
      if (sql.includes('FROM memories')) return { rows: [] };
      if (sql.includes('FROM portfolio_agent_runs')) return { rows: [] };
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('DELETE FROM portfolio_snapshots')) return { rows: [] };
      if (sql.startsWith('INSERT INTO portfolio_snapshots')) return { rows: [] };
      if (sql.startsWith('INSERT INTO portfolio_agent_runs')) return { rows: [] };
      if (sql.startsWith('SELECT skill, description FROM tool_whitelist')) return { rows: [] };
      if (sql.startsWith('INSERT INTO tool_audit')) return { rows: [] };
      throw new Error('Unexpected SQL: ' + sql);
    }
  };

  let notifyCalls = 0;
  const result = await runDailyPortfolioAgent({
    pool,
    now: new Date('2026-09-28T12:30:00Z'),
    getPortfolioSummary: async () => ({
      totalValue: 70900,
      totalIncomplete: false,
      dayChange: 140,
      dayChangePct: 0.2,
      stale: false,
      holdings: [{
        account: 'Fidelity',
        ticker: 'VOO',
        shares: 100,
        price: 709,
        value: 70900,
        quoteError: null
      }]
    }),
    notify: async () => { notifyCalls += 1; }
  });

  assert.equal(result.gate.notify, false);
  assert.equal(notifyCalls, 0);
  assert.ok(calls.some(sql => sql.startsWith('INSERT INTO portfolio_snapshots')));
  assert.ok(calls.some(sql => sql.startsWith('INSERT INTO portfolio_agent_runs')));
});

test('notifier is called at most once for a material run', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT account,ticker')) return { rows: [
        { account: 'Fidelity', ticker: 'VOO', value: '68000' }
      ], rowCount: 1 };
      if (sql.includes('FROM memories')) return { rows: [] };
      if (sql.includes('FROM portfolio_agent_runs')) return { rows: [] };
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('DELETE FROM portfolio_snapshots')) return { rows: [] };
      if (sql.startsWith('INSERT INTO portfolio_snapshots')) return { rows: [] };
      if (sql.startsWith('INSERT INTO portfolio_agent_runs')) return { rows: [] };
      if (sql.startsWith('SELECT skill, description FROM tool_whitelist')) return { rows: [] };
      if (sql.startsWith('INSERT INTO tool_audit')) return { rows: [] };
      throw new Error('Unexpected SQL: ' + sql);
    }
  };

  let notifyCalls = 0;
  const result = await runDailyPortfolioAgent({
    pool,
    now: new Date('2026-09-28T12:30:00Z'),
    getPortfolioSummary: async () => ({
      totalValue: 71000,
      totalIncomplete: false,
      dayChange: 3000,
      dayChangePct: 4.41,
      stale: false,
      holdings: [{
        account: 'Fidelity',
        ticker: 'VOO',
        shares: 100,
        price: 710,
        value: 71000,
        quoteError: null
      }]
    }),
    notify: async () => { notifyCalls += 1; }
  });

  assert.equal(result.gate.notify, true);
  assert.equal(result.notificationSent, true);
  assert.equal(notifyCalls, 1);
});
