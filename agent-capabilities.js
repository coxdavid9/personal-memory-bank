const JOB_SEARCH_URL = process.env.JOB_SEARCH_API_URL || '';
const CLEARCFO_URL = process.env.CLEARCFO_API_URL || '';
const CLEARCFO_TOKEN = process.env.CLEARCFO_API_TOKEN || '';

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || data?.message || `Capability request failed (${response.status}).`);
  return data;
}

async function clearCfoQuery(path, params = {}) {
  if (!CLEARCFO_URL) return { connected: false, reason: 'CLEARCFO_API_URL is not configured.' };
  const url = new URL(path, CLEARCFO_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return fetchJson(url.toString(), {
    headers: {
      Accept: 'application/json',
      ...(CLEARCFO_TOKEN ? { Authorization: `Bearer ${CLEARCFO_TOKEN}` } : {}),
    },
  });
}

async function jobSearch(params = {}) {
  if (!JOB_SEARCH_URL) return { connected: false, reason: 'JOB_SEARCH_API_URL is not configured.', criteria: params };
  const url = new URL('/search', JOB_SEARCH_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return fetchJson(url.toString(), { headers: { Accept: 'application/json' } });
}

module.exports = { clearCfoQuery, jobSearch };
