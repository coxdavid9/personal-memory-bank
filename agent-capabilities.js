const CAPABILITY_DEFINITIONS = [
  ['memory', 'Memory', 'Remember important information and bring it back at the right time.'],
  ['clearcfo', 'ClearCFO', 'Work with ClearCFO project context and, when configured, query the ClearCFO backend for current data.'],
  ['job-search', 'Job Search', 'Search and evaluate accounting/finance jobs using David’s saved preferences and application history.'],
  ['calendar', 'iPhone Calendar', 'Read upcoming iCloud calendar events and prepare calendar events for the iPhone.'],
  ['email', 'Email', 'Read personal Yahoo email and work Gmail when explicitly requested or when building the work radar.'],
  ['portfolio', 'Market Sentinel', 'Monitor holdings and a stock/ETF watchlist, flag material moves, and support evidence-based investment research without placing trades.'],
  ['agent-team', 'AI Team', 'Private specialist agents for engineering, business operations, product, customer operations, and Chief of Staff work.'],
  ['excel', 'Excel', 'Analyze uploaded spreadsheets and generate Excel workbooks.'],
];

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

module.exports = { CAPABILITY_DEFINITIONS, clearCfoQuery, jobSearch };
