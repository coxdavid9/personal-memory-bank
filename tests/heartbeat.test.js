const test = require('node:test');
const assert = require('node:assert/strict');
const { attentionGate } = require('../portfolio-agent');

test('heartbeat stays silent below materiality', () => {
  const result = attentionGate({ dayChangePct: 0.4, dayChange: 250, totalIncomplete: false, holdings: [] }, null, 1);
  assert.equal(result.notify, false);
  assert.equal(result.reason, 'below_materiality_threshold');
});

test('heartbeat flags a material portfolio move', () => {
  const result = attentionGate({ dayChangePct: -1.8, dayChange: -1200, totalIncomplete: false, holdings: [] }, null, 1);
  assert.equal(result.notify, true);
  assert.equal(result.reason, 'material_portfolio_move');
});

test('heartbeat does not repeat the same quote outage', () => {
  const briefing = { missingQuotes: ['VOO'], staleSignature: 'VOO:timeout', stale: false, totalIncomplete: false, holdings: [] };
  const prior = { attention_key: 'VOO:timeout', notification_sent: true, total_incomplete: false };
  const result = attentionGate(briefing, prior, 1);
  assert.equal(result.notify, false);
  assert.equal(result.reason, 'same_quote_outage');
});
