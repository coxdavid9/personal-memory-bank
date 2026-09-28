const test = require('node:test');
const assert = require('node:assert/strict');

test('parseYahooChart returns current price and previous-close change', () => {
  const quote = require('../market').parseYahooChart({
    chart: {
      result: [{
        meta: {
          regularMarketPrice: 710.79,
          previousClose: 707.60,
          regularMarketTime: 1790697600
        }
      }]
    }
  });

  assert.equal(quote.price, 710.79);
  assert.equal(quote.previousClose, 707.60);
  assert.equal(Number(quote.change.toFixed(2)), 3.19);
  assert.equal(Number(quote.changePct.toFixed(2)), 0.45);
  assert.equal(quote.stale, false);
});

test('failed quote does not become a zero-dollar holding price', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('upstream failure', { status: 503 });
  try {
    const { getQuote } = require('../market');
    const quote = await getQuote('TEST-UNAVAILABLE-QUOTE');
    assert.equal(quote.price, null);
    assert.equal(quote.stale, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Yahoo retries query2 after query1 fails', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    if (calls === 1) return new Response('blocked', { status: 403 });
    return new Response(JSON.stringify({
      chart: { result: [{ meta: { regularMarketPrice: 710.79, previousClose: 707.60, regularMarketTime: 1790697600 } }] }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { getQuote } = require('../market');
    const quote = await getQuote('RETRY-YAHOO-TEST');
    assert.equal(quote.price, 710.79);
    assert.equal(quote.source, 'yahoo');
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Twelve Data is used when Yahoo hosts fail', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.TWELVEDATA_API_KEY;
  process.env.TWELVEDATA_API_KEY = 'test-key';
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    if (String(url).includes('yahoo')) return new Response('blocked', { status: 503 });
    return new Response(JSON.stringify({
      symbol: 'VOO',
      close: '710.79',
      change: '3.19',
      percent_change: '0.45',
      timestamp: '1790697600'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { getQuote } = require('../market');
    const quote = await getQuote('TWELVE-DATA-TEST');
    assert.equal(quote.price, 710.79);
    assert.equal(quote.change, 3.19);
    assert.equal(quote.source, 'twelvedata');
    assert.equal(calls, 3);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TWELVEDATA_API_KEY;
    else process.env.TWELVEDATA_API_KEY = originalKey;
  }
});
