const { getQuote } = require('./market');

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
async function getMarketSentinelState(pool){
  const watchlist=await listWatchlist(pool); const active=watchlist.filter(x=>x.enabled);
  const quotes=await Promise.all(active.map(async x=>({ticker:x.ticker,note:x.note,...await getQuote(x.ticker)})));
  return {watchlist:quotes,material:quotes.filter(q=>Number.isFinite(Number(q.changePct))&&Math.abs(Number(q.changePct))>=3)};
}
module.exports={normalizeTicker,initMarketSentinelDb,listWatchlist,addWatch,removeWatch,getMarketSentinelState};
