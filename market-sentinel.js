const { getQuote } = require('./market');
const { getTickerNews } = require('./market-news');

function normalizeTicker(value){const t=String(value||'').trim().toUpperCase();return /^[A-Z0-9.^-]{1,20}$/.test(t)?t:null;}

async function initMarketSentinelDb(pool){
  if(!pool)return;
  await pool.query(`CREATE TABLE IF NOT EXISTS market_watchlist (
    id BIGSERIAL PRIMARY KEY,
    ticker TEXT NOT NULL UNIQUE,
    note TEXT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS market_sentinel_events (id BIGSERIAL PRIMARY KEY,ticker TEXT NOT NULL,observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),change_pct NUMERIC(20,8),driver TEXT NOT NULL,confidence TEXT NOT NULL,summary TEXT NOT NULL,headlines JSONB NOT NULL DEFAULT '[]'::jsonb)`);
  await pool.query('CREATE INDEX IF NOT EXISTS market_sentinel_events_ticker_idx ON market_sentinel_events(ticker,observed_at DESC)');
}
async function listWatchlist(pool){
  if(!pool)return [];
  const {rows}=await pool.query('SELECT id,ticker,note,enabled,created_at,updated_at FROM market_watchlist ORDER BY ticker');
  return rows;
}
async function addWatch(pool,input={}){
  const ticker=normalizeTicker(input.ticker); if(!ticker)return {ok:false,error:'Enter a valid ticker.'};
  const note=String(input.note||'').trim().slice(0,240)||null;
  const q=await getQuote(ticker); if(!Number.isFinite(Number(q.price)))return {ok:false,error:`I could not verify ${ticker} with the quote provider.`};
  const {rows}=await pool.query(`INSERT INTO market_watchlist(ticker,note) VALUES($1,$2)
    ON CONFLICT(ticker) DO UPDATE SET note=COALESCE(EXCLUDED.note,market_watchlist.note),enabled=true,updated_at=NOW()
    RETURNING id,ticker,note,enabled,created_at,updated_at`,[ticker,note]);
  return {ok:true,item:rows[0],quote:q};
}
async function removeWatch(pool,ticker){
  const key=normalizeTicker(ticker); if(!key)return {ok:false};
  const r=await pool.query('DELETE FROM market_watchlist WHERE ticker=$1',[key]); return {ok:Boolean(r.rowCount)};
}

function classifyDriver(ticker,headlines=[]){
 const text=headlines.map(x=>x.title).join(' ').toLowerCase();
 const company=/earnings|revenue|profit|guidance|forecast|ceo|acquisition|merger|lawsuit|fda|product|recall|dividend|buyback|downgrade|upgrade/;
 const broad=/fed|federal reserve|inflation|jobs report|interest rate|treasury|s&p 500|nasdaq|dow jones|wall street|market selloff|market rally/;
 const sector=/sector|semiconductor|banks|energy stocks|oil prices|biotech|retail stocks|airlines|automakers/;
 if(company.test(text))return {driver:'company-specific',confidence:'medium'};
 if(sector.test(text))return {driver:'sector-wide',confidence:'low'};
 if(broad.test(text))return {driver:'broad-market',confidence:'low'};
 return {driver:'unclear',confidence:'low'};
}
async function investigateMove(pool,item){
 let headlines=[];try{headlines=await getTickerNews(item.ticker,8);}catch(_){}
 const classification=classifyDriver(item.ticker,headlines);
 const pct=Number(item.changePct);const direction=pct>=0?'up':'down';
 const evidence=headlines.slice(0,3).map(x=>x.title);
 const summary=classification.driver==='unclear'
   ? `${item.ticker} is ${direction} ${Math.abs(pct).toFixed(1)}%. I found recent headlines, but not enough evidence to claim a cause.`
   : `${item.ticker} is ${direction} ${Math.abs(pct).toFixed(1)}%. Recent headlines suggest a ${classification.driver} driver; confidence is ${classification.confidence}.`;
 if(pool)await pool.query('INSERT INTO market_sentinel_events(ticker,change_pct,driver,confidence,summary,headlines) VALUES($1,$2,$3,$4,$5,$6)',[item.ticker,pct,classification.driver,classification.confidence,summary,JSON.stringify(headlines.slice(0,8))]);
 return {...item,...classification,summary,headlines:evidence,news:headlines};
}
async function investigateMaterialMoves(pool,items=[]){return Promise.all(items.map(x=>investigateMove(pool,x)));}

async function getMarketSentinelState(pool){
  const watchlist=await listWatchlist(pool); const active=watchlist.filter(x=>x.enabled);
  const quotes=await Promise.all(active.map(async x=>({ticker:x.ticker,note:x.note,...await getQuote(x.ticker)})));
  const material=quotes.filter(q=>Number.isFinite(Number(q.changePct))&&Math.abs(Number(q.changePct))>=3);
  const investigations=await investigateMaterialMoves(pool,material);
  return {watchlist:quotes,material,investigations};
}
module.exports={normalizeTicker,initMarketSentinelDb,listWatchlist,addWatch,removeWatch,getMarketSentinelState,classifyDriver,investigateMove,investigateMaterialMoves};
