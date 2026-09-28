const test = require('node:test');
const assert = require('node:assert/strict');
const { classifySkill, summarizeArgs, TIERS } = require('../policy');

test('blacklist beats whitelist', () => {
  const result = classifySkill('delete_data', {}, { whitelist: [{ skill: 'delete_data' }] });
  assert.equal(result.tier, TIERS.BLOCK);
  assert.equal(result.reason, 'blacklist');
});

test('secret-like arguments are blocked', () => {
  const result = classifySkill('some_skill', { api_key: 'abc' });
  assert.equal(result.tier, TIERS.BLOCK);
});

test('whitelist downgrades an ask skill to safe', () => {
  const result = classifySkill('create_calendar_event', { title: 'Dentist' }, {
    whitelist: [{ skill: 'create_calendar_event', matcher: args => args.title === 'Dentist' }]
  });
  assert.equal(result.tier, TIERS.SAFE);
  assert.equal(result.approvedBy, 'whitelist');
});

test('unknown skills default to ask', () => {
  assert.equal(classifySkill('new_external_write').tier, TIERS.ASK);
});

test('argument summaries redact secrets', () => {
  const result = summarizeArgs({ token: 'secret', title: 'hello' });
  assert.equal(result.token, '[REDACTED]');
  assert.equal(result.title, 'hello');
});
