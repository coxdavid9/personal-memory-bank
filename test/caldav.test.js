const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVEvent } = require('../caldav');

test('builds a parseable timed VEVENT with UTC timestamps and escaped text', () => {
  const ics = buildVEvent({
    uid: 'test-uid@personal-agent',
    title: 'Work, on Personal Agent',
    start: '2026-09-28T14:00:00.000Z',
    end: '2026-09-28T15:00:00.000Z',
    notes: 'Line one\nLine two; keep this',
    location: 'Home, office',
    allDay: false,
  });
  assert.match(ics, /UID:test-uid@personal-agent/);
  assert.ok(ics.includes('\r\n'));
  assert.match(ics, /DTSTART:20260928T140000Z/);
  assert.match(ics, /DTEND:20260928T150000Z/);
  assert.ok(ics.includes('SUMMARY:Work\\, on Personal Agent'));
  assert.ok(ics.includes('DESCRIPTION:Line one\\nLine two\\; keep this'));
  assert.ok(ics.includes('LOCATION:Home\\, office'));
});

test('builds an all-day VEVENT with an exclusive DTEND date', () => {
  const ics = buildVEvent({
    uid: 'all-day@personal-agent',
    title: 'Vacation',
    start: '2026-09-28T00:00:00.000Z',
    end: '2026-09-29T00:00:00.000Z',
    notes: null,
    location: null,
    allDay: true,
  });
  assert.match(ics, /DTSTART;VALUE=DATE:20260928/);
  assert.match(ics, /DTEND;VALUE=DATE:20260929/);
  assert.match(ics, /UID:all-day@personal-agent/);
});
