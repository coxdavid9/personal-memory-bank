const cache = new Map();
const TTL = 15 * 60 * 1000;

function parseYahooChart(data) {
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  const price = Number(meta?.regularMarketPrice);
  const previousClose = Number(meta?.previousClose ?? meta?.chartPreviousClose);

  if (!Number.isFinite(price)) throw new Error('Yahoo quote price unavailable.');

  const change = Number.isFinite(previousClose) ? price - previousClose : null;
  const changePct = Number.isFinite(previousClose) && previousClose !== 0
    ? (change / previousClose) * 100
    : null;

  return {
    price,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    change: Number.isFinite(change) ? change : null,
    changePct: Number.isFinite(changePct) ? changePct : null,
    asOf: meta?.regularMarketTime
      ? new Date(Number(meta.regularMarketTime) * 1000).toISOString()
      : null,
    stale: false,
    source: 'yahoo'
  };
}

function parseTwelveDataQuote(data) {
  if (!data || data.status === 'error' || data.code) {
    throw new Error(data?.message || 'Twelve Data quote unavailable.');
  }

  const price = Number(data.close ?? data.price);
  const change = Number(data.change);
  const changePct = Number(String(data.percent_change ?? '').replace('%', ''));
  const previousClose = Number.isFinite(price) && Number.isFinite(change)
    ? price - change
    : null;

  if (!Number.isFinite(price)) throw new Error('Twelve Data quote price unavailable.');

  return {
    price,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    change: Number.isFinite(change) ? change : null,
    changePct: Number.isFinite(changePct) ? changePct : null,
    asOf: data.timestamp
      ? new Date(Number(data.timestamp) * 1000).toISOString()
      : null,
    stale: false,
    source: 'twelvedata'
  };
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Quote service returned ${response.status}.`);
  return response.json();
}

async function fetchYahoo(key) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - (2 * 86400);
  const query = `?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplits`;
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastError = null;

  for (const host of hosts) {
    try {
      const data = await fetchJson(
        `https://${host}/v8/finance/chart/${encodeURIComponent(key)}${query}`,
        {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*'
        }
      );
      return parseYahooChart(data);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Yahoo Finance unavailable: ${lastError?.message || 'unknown error'}`);
}

async function fetchTwelveData(key) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new Error('Twelve Data API key is not configured.');

  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(key)}&apikey=${encodeURIComponent(apiKey)}`;
  return parseTwelveDataQuote(await fetchJson(url, {
    'User-Agent': 'Personal-Agent/1.0',
    'Accept': 'application/json'
  }));
}

async function getQuote(ticker) {
  const key = String(ticker).trim().toUpperCase();
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  let lastError = null;

  try {
    const value = await fetchYahoo(key);
    cache.set(key, { value, expires: Date.now() + TTL });
    return value;
  } catch (err) {
    lastError = err;
  }

  try {
    const value = await fetchTwelveData(key);
    cache.set(key, { value, expires: Date.now() + TTL });
    return value;
  } catch (err) {
    lastError = new Error(`Yahoo Finance and Twelve Data failed: ${err.message || lastError?.message || 'unknown error'}`);
  }

  const fallback = cached?.value;
  if (fallback) return {
    ...fallback,
    stale: true,
    error: lastError?.message || 'Quote providers unavailable.'
  };

  return {
    price: null,
    previousClose: null,
    change: null,
    changePct: null,
    asOf: null,
    stale: true,
    error: lastError?.message || 'Quote providers unavailable.',
    source: null
  };
}

module.exports = { getQuote, parseYahooChart, parseTwelveDataQuote };
