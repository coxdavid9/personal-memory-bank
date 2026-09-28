const test = require('node:test');
const assert = require('node:assert/strict');
const { getTeamRoles, getTeamRole, delegateToTeam } = require('../agent-team');

test('team exposes the private operating roles', () => {
  const roles = getTeamRoles();
  assert.deepEqual(roles.map(r => r.key), [
    'chief_of_staff',
    'engineering',
    'business_ops',
    'product',
    'customer_ops'
  ]);
});

test('unknown team role is rejected', async () => {
  const result = await delegateToTeam({
    roleKey: 'unknown',
    task: 'Do something',
    callOpenAI: async () => 'should not run'
  });
  assert.equal(result.ok, false);
});

test('delegated work uses the selected specialist and records the result', async () => {
  const inserted = [];
  const pool = { query: async (sql, params) => {
    if (sql.startsWith('INSERT INTO agent_team_tasks')) inserted.push(params);
    return { rows: [] };
  }};
  const result = await delegateToTeam({
    pool,
    roleKey: 'engineering',
    task: 'Review the deployment architecture.',
    project: 'Personal Agent',
    context: 'Keep ClearCFO customer-facing code separate.',
    callOpenAI: async ({ system, user }) => {
      assert.match(system, /software engineering lead/i);
      assert.match(user, /deployment architecture/i);
      return 'Engineering review complete.';
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.role.key, 'engineering');
  assert.equal(result.result, 'Engineering review complete.');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0][0], 'engineering');
  assert.equal(inserted[0][2], 'completed');
});
