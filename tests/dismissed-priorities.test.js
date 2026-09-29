const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isDismissedJobText } = require('../job-search');

test('dismissal language is recognized without deleting history', () => {
  assert.equal(isDismissedJobText('Onin posting is stale'), true);
  assert.equal(isDismissedJobText('Acme posting is closed'), true);
  assert.equal(isDismissedJobText('Ignore this job'), true);
  assert.equal(isDismissedJobText('Review the Acme posting'), false);
});


test('server priority rules explicitly exclude dismissed jobs and require actionable verbs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /status NOT IN \('ignore','rejected'\)/);
  assert.match(source, /use only context\.priorityContext as the candidate pool/);
  assert.match(source, /Never include "ignore X", "don't do Y", "X is stale"/);
  assert.match(source, /record it as status "ignore"/);
});
