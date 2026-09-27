const cache = new Map();
const TTL = 15 * 60 * 1000;

function parseCsv(text) {
  const lines=String(text).trim().split(/\\r?\\n/);
  if(lines.length<2) throw new Error('Empty quote response.');
  const cols=lines[1].split(',');
  const price=Number(cols[6]);
  const change=cols[7] === 'N/D' ? null : Number(cols[7]);
  const changePct=cols[8] === 'N/D' ? null : Number(cols[8]);
  if(!Number.isFinite(price)) throw new Error('Quote price unavailable.');
  return {price,change:Number.isFinite(change)?change:null,changePct:Number.isFinite(changePct)?changePct:null,asOf:cols[1]||null,stale:false};
}

async function getQuote(ticker) {
  const key=String(ticker).trim().toLowerCase();
  const cached=cache.get(key);
  if(cached && cached.expires>Date.now()) return cached.value;
  try {
    const response=await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(key)}&f=sd2t2ohlcv&h&e=csv`,{signal:AbortSignal.timeout(10000)});
    if(!response.ok) throw new Error(`Quote service returned ${response.status}.`);
    const value=parseCsv(await response.text());
    cache.set(key,{value,expires:Date.now()+TTL});
    return value;
  } catch (err) {
    const fallback=cached?.value;
    if(fallback) return {...fallback,stale:true};
    return {price:0,change:null,changePct:null,asOf:null,stale:true,error:err.message};
  }
}
module.exports={getQuote,parseCsv};
