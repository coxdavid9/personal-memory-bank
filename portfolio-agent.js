const crypto = require('crypto');
const { executeSkill } = require('./policy');

const CHICAGO_TZ = 'America/Chicago';
const DEFAULT_PCT_THRESHOLD = 1;
const DEFAULT_DOLLAR_THRESHOLD = 1000;
const HOLDING_PCT_THRESHOLD = 3;

function localDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CHICAGO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

function getThresholdFromMemories(memories = []) {
  for (const memory of memories) {
    const text = String(memory.text || '');
    if (!/(portfolio|bother me|threshold|only bother)/i.test(text)) continue;
    const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (match) {
      const pct = Number(match[1]);
      if (Number.isFinite(pct) && pct > 0 && pct <= 100) return pct;
    }
  }
  return DEFAULT_PCT_THRESHOLD;
}

function attentionGate(briefing, previousRun, thresholdPct = DEFAULT_PCT_THRESHOLD) {
  const dayChangePct = Number(briefing.dayChangePct);
  const dayChange = Number(briefing.dayChange);
  const newIncomplete = Boolean(briefing.totalIncomplete) && !previousRun?.total_incomplete;
  const staleKey = briefing.staleSignature || null;
  const priorKey = previousRun?.attention_key || null;
  const staleAlreadyNotified = Boolean(staleKey && priorKey && staleKey === priorKey && previousRun?.notification_sent);

  if (briefing.missingQuotes?.length) {
    if (!staleAlreadyNotified) {
      return { notify: true, reason: 'quote_failure_no_snapshot', attentionKey: staleKey || 'missing-quote' };
    }
    return { notify: false, reason: 'same_quote_outage', attentionKey: staleKey || 'missing-quote' };
  }

  if (briefing.stale && !staleAlreadyNotified) {
    return { notify: true, reason: 'stale_quote_episode', attentionKey: staleKey || 'stale-quotes' };
  }

  if (newIncomplete) {
    return { notify: true, reason: 'new_incomplete_total', attentionKey: staleKey || 'new-incomplete' };
  }

  if (!briefing.totalIncomplete && Number.isFinite(dayChangePct) && Number.isFinite(dayChange)) {
    if (Math.abs(dayChangePct) >= thresholdPct || Math.abs(dayChange) >= DEFAULT_DOLLAR_THRESHOLD) {
      return { notify: true, reason: 'material_portfolio_move', attentionKey: 'movement' };
    }
  }

  const materialHolding = (briefing.holdings || []).find(h =>
    Number.isFinite(Number(h.dayChangePct)) && Math.abs(Number(h.dayChangePct)) >= HOLDING_PCT_THRESHOLD
  );
  if (materialHolding) {
    return { notify: true, reason: 'material_holding_move', attentionKey: `holding-move:${materialHolding.ticker}` };
  }

  return { notify: false, reason: 'below_materiality_threshold', attentionKey: null };
}

async function initPortfolioAgentDb(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio_agent_runs (
      id BIGSERIAL PRIMARY KEY,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      as_of DATE NOT NULL,
      day_change NUMERIC(20,2) NULL,
      day_change_pct NUMERIC(20,8) NULL,
      gate_decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      notification_sent BOOLEAN NOT NULL DEFAULT FALSE,
      attention_key TEXT NULL,
      total_incomplete BOOLEAN NOT NULL DEFAULT FALSE,
      briefing JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS portfolio_agent_runs_as_of_idx ON portfolio_agent_runs(as_of DESC)');
}

async function recordSnapshot(pool, summary, asOf) {
  if (!pool) throw new Error('Persistent storage is required for portfolio snapshots.');
  await pool.query('BEGIN');
  try {
    await pool.query('DELETE FROM portfolio_snapshots WHERE as_of=$1', [asOf]);
    for (const h of summary.holdings || []) {
      await pool.query(
        `INSERT INTO portfolio_snapshots(as_of,account,ticker,shares,price,value)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [asOf, h.account, h.ticker, h.shares, Number.isFinite(Number(h.price)) ? Number(h.price) : null, Number.isFinite(Number(h.value)) ? Number(h.value) : 0]
      );
    }
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }
}

async function buildBriefing(pool, summary, asOf) {
  const priorDate = localDate(new Date(Date.parse(asOf + 'T12:00:00Z') - 86400000));
  const priorRows = await pool.query(
    `SELECT account,ticker,SUM(value) AS value
     FROM portfolio_snapshots WHERE as_of=$1 GROUP BY account,ticker`,
    [priorDate]
  );
  const priorMap = new Map(priorRows.rows.map(r => [`${r.account}|${r.ticker || ''}`, Number(r.value)]));
  const holdings = (summary.holdings || []).map(h => {
    const prior = priorMap.get(`${h.account}|${h.ticker || ''}`);
    const dayChange = Number.isFinite(Number(prior)) && Number.isFinite(Number(h.value))
      ? Number(h.value) - Number(prior)
      : null;
    const dayChangePct = Number.isFinite(Number(prior)) && Number(prior) !== 0 && Number.isFinite(Number(dayChange))
      ? (Number(dayChange) / Number(prior)) * 100
      : null;
    return { ...h, dayChange, dayChangePct };
  });
  const missingQuotes = holdings.filter(h => h.ticker && !Number.isFinite(Number(h.price)) && !Number.isFinite(Number(h.value))).map(h => h.ticker);
  const staleTickers = holdings.filter(h => h.ticker && h.quoteError).map(h => h.ticker);
  const staleSignature = [...holdings.filter(h => h.ticker && (h.quoteError || summary.stale)).map(h => `${h.ticker}:${h.quoteError || 'stale'}`)].sort().join('|') || null;
  return {
    asOf,
    totalValue: summary.totalValue,
    totalIncomplete: summary.totalIncomplete,
    dayChange: summary.dayChange,
    dayChangePct: summary.dayChangePct,
    stale: Boolean(summary.stale),
    staleTickers,
    missingQuotes,
    staleSignature,
    holdings,
    snapshotCount: priorRows.rowCount
  };
}

async function getRelevantMemories(pool) {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT text,created_at FROM memories
     WHERE done=false AND (text ILIKE '%portfolio%' OR text ILIKE '%bother me%' OR text ILIKE '%threshold%')
     ORDER BY created_at DESC LIMIT 20`
  );
  return result.rows;
}

function fallbackNotification(briefing, gate) {
  const money = Number.isFinite(Number(briefing.dayChange)) ? `~$${Math.round(Math.abs(Number(briefing.dayChange))).toLocaleString()}` : '';
  const pct = Number.isFinite(Number(briefing.dayChangePct)) ? `${Number(briefing.dayChangePct).toFixed(1)}%` : null;
  if (gate.reason === 'quote_failure_no_snapshot') {
    const ticker = briefing.missingQuotes[0] || 'a holding';
    return `I couldn't get a current ${ticker} quote this morning, and I don't have a last-known snapshot for it. I can't give you a reliable portfolio value for that holding.`;
  }
  if (gate.reason === 'stale_quote_episode') {
    const ticker = briefing.staleTickers[0] || 'a holding';
    return `Your ${ticker} price hasn't refreshed this morning. I'm using the last known value rather than treating it as $0. I'll keep trying.`;
  }
  if (gate.reason === 'new_incomplete_total') {
    return `Your portfolio total is incomplete this morning because a holding doesn't have a reliable value. I didn't present a partial total as exact.`;
  }
  if (gate.reason === 'material_holding_move') {
    const h = briefing.holdings.find(x => Number.isFinite(Number(x.dayChangePct)) && Math.abs(Number(x.dayChangePct)) >= HOLDING_PCT_THRESHOLD);
    return `${h.ticker} moved ${Number(h.dayChangePct).toFixed(1)}% today, which is material enough to flag. Your portfolio is ${Number(briefing.dayChangePct) >= 0 ? 'up' : 'down'} ${pct || ''}.`.replace(/  /g,' ');
  }
  return `Your portfolio is ${Number(briefing.dayChangePct) >= 0 ? 'up' : 'down'} ${pct || ''} today (${money}), which crossed your notification threshold.`;
}

async function composeNotification(briefing, gate) {
  if (!process.env.OPENAI_API_KEY) return fallbackNotification(briefing, gate);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
        input: [
          {
            role: 'system',
            content: 'You write one short conversational notification for David from a validated portfolio briefing. Never invent facts. Lead with the number or concrete problem. Explain the main reason. Never give investment advice. Never output a table, bullets, markdown heading, or more than 3 sentences.'
          },
          { role: 'user', content: JSON.stringify({ briefing, gate }) }
        ]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || 'OpenAI notification generation failed.');
    const text = String(data.output_text || '').trim();
    if (text) return text;
  } catch (err) {
    console.error('Portfolio notification reasoning failed; using deterministic fallback:', err.message);
  }
  return fallbackNotification(briefing, gate);
}

const PORTFOLIO_NOTIFICATION_SUBJECT = 'Jarvis — portfolio alert';

async function sendNotification(message) {
  if (!process.env.RESEND_API_KEY || !process.env.REMINDER_EMAIL) {
    throw new Error('Email notification is not configured.');
  }
  const from = process.env.REMINDER_FROM || 'Personal Memory Bank <onboarding@resend.dev>';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from,
      to: [process.env.REMINDER_EMAIL],
      subject: PORTFOLIO_NOTIFICATION_SUBJECT,
      text: message,
      html: `<p>${message.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || 'Unable to send portfolio notification.');
  return { id: data.id || null };
}

async function runDailyPortfolioAgent({ pool, getPortfolioSummary, now = new Date(), notify = sendNotification }) {
  const asOf = localDate(now);
  const summary = await getPortfolioSummary(pool);
  const briefing = await buildBriefing(pool, summary, asOf);
  const memories = await getRelevantMemories(pool);
  const thresholdPct = getThresholdFromMemories(memories);
  const previousResult = await pool.query(
    `SELECT * FROM portfolio_agent_runs ORDER BY run_at DESC LIMIT 1`
  );
  const previousRun = previousResult.rows[0] || null;
  const gate = attentionGate(briefing, previousRun, thresholdPct);

  await executeSkill('record_snapshot', { asOf }, { pool, runId: `heartbeat_${asOf}`, execute: () => recordSnapshot(pool, summary, asOf) });

  let notificationSent = false;
  if (gate.notify) {
    const message = await composeNotification(briefing, gate);
    const notification = await executeSkill('notify', { recipient: 'David', reason: gate.reason }, { pool, runId: `heartbeat_${asOf}`, execute: () => notify(message) });
    if (notification?.ok === false) throw new Error(notification?.error || 'Portfolio notification was not sent.');
    notificationSent = true;
  }

  await pool.query(
    `INSERT INTO portfolio_agent_runs(as_of,day_change,day_change_pct,gate_decision,reason,notification_sent,attention_key,total_incomplete,briefing)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [asOf, briefing.dayChange, briefing.dayChangePct, gate.notify ? 'notify' : 'silent', gate.reason, notificationSent, gate.attentionKey, Boolean(briefing.totalIncomplete), JSON.stringify({ ...briefing, thresholdPct })]
  );

  return { ok: true, asOf, gate, notificationSent, briefing, thresholdPct };
}

module.exports = { PORTFOLIO_NOTIFICATION_SUBJECT,
  CHICAGO_TZ,
  DEFAULT_PCT_THRESHOLD,
  DEFAULT_DOLLAR_THRESHOLD,
  HOLDING_PCT_THRESHOLD,
  localDate,
  getThresholdFromMemories,
  attentionGate,
  initPortfolioAgentDb,
  recordSnapshot,
  buildBriefing,
  fallbackNotification,
  composeNotification,
  sendNotification,
  runDailyPortfolioAgent
};
