const test=require('node:test');const assert=require('node:assert/strict');const {normalizeTicker,classifyDriver}=require('../market-sentinel');
test('Market Sentinel normalizes valid tickers',()=>{assert.equal(normalizeTicker(' voo '),'VOO');assert.equal(normalizeTicker('BRK-B'),'BRK-B');});
test('Market Sentinel rejects malformed tickers',()=>{assert.equal(normalizeTicker('VOO please'),null);assert.equal(normalizeTicker(''),null);});

test('driver classifier is conservative',()=>{assert.equal(classifyDriver('AAPL',[{title:'Apple raises revenue guidance'}]).driver,'company-specific');assert.equal(classifyDriver('VOO',[{title:'Federal Reserve holds interest rates'}]).driver,'broad-market');assert.equal(classifyDriver('XYZ',[{title:'Shares move in afternoon trading'}]).driver,'unclear');});
