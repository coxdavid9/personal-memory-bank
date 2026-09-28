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
