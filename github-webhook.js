const crypto = require('crypto');

function verifyGitHubSignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody || Buffer.from('')).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function failedCheckRunEvent(eventName, payload) {
  return eventName === 'check_run' && payload?.action === 'completed' && payload?.check_run?.conclusion === 'failure';
}

module.exports = { verifyGitHubSignature, failedCheckRunEvent };
