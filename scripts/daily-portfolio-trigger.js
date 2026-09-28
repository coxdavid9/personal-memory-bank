const appUrl = process.env.APP_URL || 'https://personal-memory-bank.onrender.com';
const secret = process.env.DAILY_PORTFOLIO_CRON_SECRET || '';

if (!secret) throw new Error('DAILY_PORTFOLIO_CRON_SECRET is not configured.');

const now = new Date();
const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
}).formatToParts(now);
const hour = Number(parts.find(p => p.type === 'hour')?.value);
const minute = Number(parts.find(p => p.type === 'minute')?.value);

if (hour !== 7 || minute !== 30) {
  console.log(`Daily portfolio trigger skipped at America/Chicago ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}.`);
  process.exit(0);
}

const response = await fetch(`${appUrl}/api/internal/daily-portfolio`, {
  method: 'POST',
  headers: { 'x-daily-portfolio-secret': secret, 'content-type': 'application/json' },
  body: '{}'
});
const body = await response.text();
if (!response.ok) throw new Error(`Daily portfolio endpoint returned ${response.status}: ${body}`);
console.log(body);
