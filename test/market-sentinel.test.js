const test=require('node:test');const assert=require('node:assert/strict');const {normalizeTicker}=require('../market-sentinel');
test('Market Sentinel normalizes valid tickers',()=>{assert.equal(normalizeTicker(' voo '),'VOO');assert.equal(normalizeTicker('BRK-B'),'BRK-B');});
test('Market Sentinel rejects malformed tickers',()=>{assert.equal(normalizeTicker('VOO please'),null);assert.equal(normalizeTicker(''),null);});
