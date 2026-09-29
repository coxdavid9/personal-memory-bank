const { getQuote } = require('./market');

function normalizeTicker(value) {
  const ticker = value == null ? null : String(value).trim().toUpperCase();
  return ticker ? ticker.slice(0, 20) : null;
}

async function initPortfolioDb(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS holdings (
      id BIGSERIAL PRIMARY KEY,
      account TEXT NOT NULL,
      ticker TEXT NULL,
      shares NUMERIC(20,8) NULL,
      balance NUMERIC(20,2) NULL,
      cost_basis NUMERIC(20,2) NULL,
      source TEXT NOT NULL CHECK (source IN ('manual','plaid')),
      plaid_account_id TEXT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id BIGSERIAL PRIMARY KEY,
      as_of DATE NOT NULL,
      account TEXT NOT NULL,
      ticker TEXT NULL,
      shares NUMERIC(20,8) NULL,
      price NUMERIC(20,8) NULL,
      value NUMERIC(20,2) NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plaid_items (
      id BIGSERIAL PRIMARY KEY,
      item_id TEXT NOT NULL UNIQUE,
      access_token_encrypted TEXT NOT NULL,
      institution_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','login_required','error')),
      last_sync TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS holdings_account_idx ON holdings(account)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS portfolio_snapshots_date_idx ON portfolio_snapshots(as_of DESC)`);
}

async function recordHolding(pool, input) {
  if (!pool) return { ok:false, error:'Persistent storage is not configured.' };
  const account = String(input.account || '').trim().slice(0,120);
  const ticker = normalizeTicker(input.ticker);
  const shares = input.shares == null || input.shares === '' ? null : Number(input.shares);
  const balance = input.balance == null || input.balance === '' ? null : Number(input.balance);
  if (!account) return { ok:false, error:'Account is required.' };
  if (shares != null && (!Number.isFinite(shares) || shares < 0)) return { ok:false, error:'Shares must be a non-negative number.' };
  if (balance != null && (!Number.isFinite(balance) || balance < 0)) return { ok:false, error:'Balance must be a non-negative number.' };
  if (!ticker && balance == null) return { ok:false, error:'Provide a ticker with shares or a balance amount.' };
  if (ticker && shares == null && balance == null) return { ok:false, error:'Provide shares or a balance amount.' };

  const existing = await pool.query(
    `SELECT id FROM holdings WHERE source='manual' AND account=$1 AND ticker IS NOT DISTINCT FROM $2 LIMIT 1`,
    [account,ticker]
  );
  let row;
  if (existing.rows[0]) {
    const result = await pool.query(
      `UPDATE holdings SET shares=$1,balance=$2,updated_at=NOW() WHERE id=$3
       RETURNING id,account,ticker,shares,balance,cost_basis,source,updated_at`,
      [shares,balance,existing.rows[0].id]
    );
    row=result.rows[0];
  } else {
    const result = await pool.query(
      `INSERT INTO holdings(account,ticker,shares,balance,source)
       VALUES($1,$2,$3,$4,'manual')
       RETURNING id,account,ticker,shares,balance,cost_basis,source,updated_at`,
      [account,ticker,shares,balance]
    );
    row=result.rows[0];
  }
  return { ok:true, holding:row };
}

async function getPortfolioSummary(pool) {
  if (!pool) return { totalValue:0, dayChange:0, dayChangePct:null, accounts:[], holdings:[], stale:false, connections:[] };
  const { rows } = await pool.query(`
    SELECT id,account,ticker,shares,balance,cost_basis,source,plaid_account_id,updated_at
    FROM holdings ORDER BY account,ticker NULLS LAST,id
  `);
  const holdings=[];
  let stale=false;
  for (const row of rows) {
    let price=null, change=null, changePct=null, quoteError=null, value=Number(row.balance || 0);
    if (row.ticker && row.shares != null) {
      const quote=await getQuote(row.ticker);
      price=quote.price;
      change=quote.change;
      changePct=quote.changePct;
      quoteError=quote.error || null;
      if (quote.stale) stale=true;
      if (Number.isFinite(Number(price))) {
        value=Number(row.shares)*Number(price);
      } else {
        const snapshot = await pool.query(
          `SELECT price FROM portfolio_snapshots
           WHERE account=$1 AND ticker=$2 AND price IS NOT NULL
           ORDER BY as_of DESC, id DESC LIMIT 1`,
          [row.account,row.ticker]
        );
        const snapshotPrice = Number(snapshot.rows[0]?.price);
        if (Number.isFinite(snapshotPrice)) {
          price=snapshotPrice;
          value=Number(row.shares)*snapshotPrice;
        } else {
          value=null;
        }
      }
    } else if (row.ticker && row.balance != null) {
      value=Number(row.balance);
    }
    holdings.push({
      id:Number(row.id), account:row.account, ticker:row.ticker,
      shares:row.shares==null?null:Number(row.shares), balance:row.balance==null?null:Number(row.balance),
      price, change, changePct, value, quoteError,
      source:row.source, updatedAt:row.updated_at
    });
  }
  const totalValue=holdings.reduce((sum,h)=>sum+(Number.isFinite(Number(h.value)) ? Number(h.value) : 0),0);
  const totalIncomplete=holdings.some(h=>!Number.isFinite(Number(h.value)));
  const accountsMap=new Map();
  for(const h of holdings){
    const current=accountsMap.get(h.account)||{account:h.account,value:0};
    if (Number.isFinite(Number(h.value))) current.value+=Number(h.value);
    accountsMap.set(h.account,current);
  }
  const accounts=[...accountsMap.values()].map(a=>({...a,allocationPct:totalValue?((a.value/totalValue)*100):0}));
  const dateInChicago = (date) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
  const today=dateInChicago(new Date());
  const prior=dateInChicago(new Date(Date.now()-86400000));
  const snap=await pool.query(`SELECT COALESCE(SUM(value),0) AS value FROM portfolio_snapshots WHERE as_of=$1`,[prior]);
  const priorValue=Number(snap.rows[0]?.value||0);
  const dayChange=priorValue?totalValue-priorValue:null;
  const dayChangePct=priorValue?((dayChange/priorValue)*100):null;
  for(const h of holdings) h.allocationPct=totalValue?((h.value/totalValue)*100):0;
  const connections=await pool.query(`SELECT institution_name,status,last_sync FROM plaid_items ORDER BY institution_name`);
  return { totalValue, totalIncomplete, dayChange, dayChangePct, accounts, holdings, stale, connections:connections.rows, asOf:today };
}

function isStalePortfolioGuidance(text) {
  return /\b(?:fake\s+(?:manual|portfolio|investment)\s+(?:numbers|balances|values)|manual\s+(?:numbers|balances|portfolio\s+(?:numbers|values)|investment\s+numbers)\s+(?:are\s+)?(?:fake|stale|unreliable)|(?:don't|do not)\s+(?:rely on|use)\s+(?:the\s+)?(?:current\s+)?manual\s+(?:numbers|balances|portfolio\s+(?:numbers|values)|investment\s+numbers))\b/i.test(String(text || ''));
}

function chicagoDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

async function retireStalePortfolioGuidance(pool) {
  if (!pool) return { retired: 0, supersedingNoteCreated: false };
  const result = await pool.query(
    "UPDATE memories SET done=true WHERE done=false AND lower(text) ~ '(fake[[:space:]]+(manual|portfolio|investment)[[:space:]]+(numbers|balances|values)|manual[[:space:]]+(numbers|balances|portfolio[[:space:]]+(numbers|values)|investment[[:space:]]+numbers)[[:space:]]+(are[[:space:]]+)?(fake|stale|unreliable)|do[[:space:]]+not[[:space:]]+rely[[:space:]]+on[[:space:]]+(the[[:space:]]+)?(current[[:space:]]+)?manual[[:space:]]+(numbers|balances|portfolio[[:space:]]+(numbers|values)|investment[[:space:]]+numbers)|don.t[[:space:]]+rely[[:space:]]+on[[:space:]]+(the[[:space:]]+)?(current[[:space:]]+)?manual[[:space:]]+(numbers|balances|portfolio[[:space:]]+(numbers|values)|investment[[:space:]]+numbers))'",
    []
  );
  const note = 'Manual holdings deleted ' + chicagoDateString() + '; none remain. Portfolio is empty pending Plaid.';
  const existing = await pool.query('SELECT id FROM memories WHERE done=false AND text=$1 LIMIT 1', [note]);
  if (!existing.rows[0]) {
    await pool.query('INSERT INTO memories(text,type,priority) VALUES($1,$2,$3)', [note, 'Portfolio', 'Normal']);
  }
  return { retired: result.rowCount || 0, supersedingNoteCreated: !existing.rows[0] };
}
async function deleteHolding(pool, id) {
  if (!pool) return { ok:false, error:'Persistent storage is not configured.' };
  const holdingId = Number(id);
  if (!Number.isInteger(holdingId) || holdingId <= 0) return { ok:false, error:'Holding id must be a positive integer.' };
  const r = await pool.query('DELETE FROM holdings WHERE id = $1 AND source = \'manual\'', [holdingId]);
  if (!r.rowCount) return { ok:false };
  const remaining = await pool.query("SELECT COUNT(*)::int AS count FROM holdings WHERE source='manual'");
  if (Number(remaining.rows[0]?.count || 0) === 0) await retireStalePortfolioGuidance(pool);
  return { ok:true };
}

async function deleteManualHoldings(pool) {
  if (!pool) return { ok:false, error:'Persistent storage is not configured.' };
  const r = await pool.query("DELETE FROM holdings WHERE source = 'manual'");
  await retireStalePortfolioGuidance(pool);
  return { ok:true, deleted:r.rowCount };
}

module.exports={initPortfolioDb,recordHolding,getPortfolioSummary,deleteHolding,deleteManualHoldings,isStalePortfolioGuidance,retireStalePortfolioGuidance};
