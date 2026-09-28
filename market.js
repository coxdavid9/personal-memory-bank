const cache = new Map();
const TTL = 15 * 60 * 1000;

function parseYahooChart(data) {
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  const price = Number(meta?.regularMarketPrice);
  const previousClose = Number(meta?.previousClose ?? meta?.chartPreviousClose);

  if (!Number.isFinite(price)) throw new Error('Quote price unavailable.');

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
    stale: false
  };
}

async function getQuote(ticker) {
  const key = String(ticker).trim().toUpperCase();
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  try {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - (2 * 86400);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(key)}?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplits`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Personal-Agent/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Quote service returned ${response.status}.`);

    const value = parseYahooChart(await response.json());
    cache.set(key, { value, expires: Date.now() + TTL });
    return value;
  } catch (err) {
    const fallback = cached?.value;
    if (fallback) return { ...fallback, stale: true, error: err.message };
    return {
      price: null,
      previousClose: null,
      change: null,
      changePct: null,
      asOf: null,
      stale: true,
      error: err.message
    };
  }
}

module.exports = { getQuote, parseYahooChart };
