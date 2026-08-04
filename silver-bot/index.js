'use strict';

/**
 * index.js — Gold Demo scheduler
 *
 * Deliberately simple compared to the old silver adaptive/Haiku scheduler:
 * one serialized minute loop drives everything, so trade management and new
 * entries can never race each other (important — scale-outs must not double-fire).
 *
 *   • Every minute        → manage/trail any open trades (24/7).
 *   • Every 5 min (open)   → run a full trading cycle (regime → sleeve → entry).
 *   • 20:00 UTC daily      → daily summary email + expectancy report.
 *   • 21:00 UTC daily      → nightly health check (optional; needs ANTHROPIC key).
 *   • 05:00 UTC weekdays   → morning briefing (optional; needs ANTHROPIC key).
 *
 * All reporting crons are wrapped so a missing optional key never crashes trading.
 */

const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');

const { runTradingCycle, runLightweightTrailUpdate } = require('./trader');
const { sendAlert, sendReport } = require('./alerts');
const { writeLog } = require('./log');
const { sendDailyReport } = require('./daily-report');
const { isLive, BOT_NAME, INSTRUMENT_LABEL } = require('./config');

// ─── BACKTEST MODE ────────────────────────────────────────────────────────────
// Set RUN_BACKTEST=XAG_USD (or XAG_USD,XAU_USD) in Railway, redeploy, and this
// service runs the regime-threshold calibration ONCE, emails you the results
// table, then idles WITHOUT trading. Remove the variable to resume normal trading.
// Lets the whole thing be driven from a phone — no terminal needed.
if (process.env.RUN_BACKTEST) {
  const { runForEmail } = require('./backtest');
  const instruments = process.env.RUN_BACKTEST.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  console.log(`[BACKTEST MODE] RUN_BACKTEST set — calibrating ${instruments.join(', ')}, then idling (NOT trading).`);

  (async () => {
    try {
      const text = await runForEmail(instruments);
      // Also dump to the Railway deploy logs as a fallback in case email is not
      // configured on this service — the table is still readable there.
      console.log('\n══════════ BACKTEST RESULTS (copy from here if no email) ══════════\n' + text + '\n═══════════════════════════════════════════════════════════════════\n');
      const html =
        `<div style="font-family:Arial,sans-serif;max-width:820px;margin:0 auto;">` +
        `<h2 style="margin:0 0 4px;">📊 Regime calibration backtest</h2>` +
        `<p style="color:#666;margin:0 0 12px;">${esc(instruments.join(', '))} — replayed through the live engine. ` +
        `Reply with this and I'll set the thresholds.</p>` +
        `<pre style="font-size:12px;line-height:1.35;white-space:pre-wrap;background:#0d1117;color:#c9d1d9;` +
        `padding:16px;border-radius:8px;overflow-x:auto;">${esc(text)}</pre>` +
        `<p style="color:#999;font-size:12px;">⚠️ Remove the <b>RUN_BACKTEST</b> variable in Railway to resume trading.</p>` +
        `</div>`;
      await sendReport('📊 Backtest — regime calibration results', html);
      console.log('[BACKTEST MODE] Done — results emailed. Remove RUN_BACKTEST to resume trading.');
    } catch (err) {
      console.error('[BACKTEST MODE] failed:', err.message);
      try { await sendReport('📊 Backtest — FAILED', `<pre>${esc(err.stack || err.message)}</pre>`); } catch (_) {}
    }
    // Stay alive so Railway does not restart the container and re-run/re-email.
    setInterval(() => {}, 1 << 30);
  })();

  return;   // Node wraps modules in a function — this skips all trading setup below.
}

// Morning briefing, daily summary and nightly health-check are intentionally NOT
// wired up — the user only wants three emails: bot live, bot broken, end-of-day
// report. Those extra Claude/mailer jobs are the "Silver health check / briefing"
// noise, so they're left disconnected here.

const modeLabel = isLive ? '🔴 LIVE' : '🟢 DEMO';
console.log(`${BOT_NAME} Bot started — ${modeLabel} | ${INSTRUMENT_LABEL}`);

// ─── MARKET HOURS (spot gold on OANDA) ────────────────────────────────────────
// Opens Sun 22:00 UTC, closes Fri 21:00 UTC. Weekend = closed.
function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();   // 0 Sun … 6 Sat
  const h   = now.getUTCHours();
  if (day === 6) return false;                 // Saturday
  if (day === 0 && h < 22) return false;        // Sunday before open
  if (day === 5 && h >= 21) return false;       // Friday after close
  return true;
}

// ─── SINGLE SERIALIZED LOOP ───────────────────────────────────────────────────
let busy = false;

cron.schedule('* * * * *', async () => {
  if (busy) { console.log('[loop] previous tick still running — skipping'); return; }
  busy = true;
  try {
    // 1) Always manage open trades (trailing runs 24/7 until trades close naturally)
    await runLightweightTrailUpdate();

    // 2) Look for new entries every 5 minutes while the market is open
    const minute = new Date().getUTCMinutes();
    if (isMarketOpen() && minute % 5 === 0) {
      await runTradingCycle();
    }
  } catch (err) {
    console.error('[loop] error:', err.message);
  } finally {
    busy = false;
  }
});

// ─── REPORTING (best-effort; never blocks trading) ────────────────────────────

// Comprehensive end-of-day report — 20:00 UTC (21:00 UK during BST). The ONLY
// scheduled email. (No health-check / morning-briefing crons — those were noise.)
cron.schedule('0 20 * * *', async () => {
  try { await sendDailyReport(); } catch (err) { console.error('Daily report error:', err.message); }
});

// ─── STARTUP DIAGNOSTICS ──────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || null;
if (DATA_DIR) {
  console.log(`[STORAGE] ✅ DATA_DIR set: ${DATA_DIR}`);
  console.log(`[STORAGE] performance.json: ${fs.existsSync(path.join(DATA_DIR, 'performance.json')) ? '✅ exists' : '⚠️  new volume / first run'}`);
} else {
  console.warn('[STORAGE] ⚠️  DATA_DIR not set — data writes to container FS and is LOST on redeploy!');
  console.warn('[STORAGE] Fix: add a Railway volume and set DATA_DIR to its mount path (e.g. /data).');
}

// Manual DATA RESET — set RESET_DATA=true, redeploy, then REMOVE it.
// Archives (does not delete) the trade history, decision log, equity history and
// risk state so the demo starts from a clean slate. Use this once to clear the
// inherited Silver-bot history that was polluting the gold report.
if (process.env.RESET_DATA === 'true') {
  const dir = process.env.DATA_DIR || __dirname;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  ['performance.json', 'trading-log.json', 'equity-history.json', 'live-risk-state.json'].forEach(name => {
    try {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        fs.renameSync(p, path.join(dir, `${name}.archived-${stamp}`));
        console.log(`[RESET_DATA] archived ${name} -> ${name}.archived-${stamp}`);
      }
    } catch (err) { console.error(`[RESET_DATA] failed to archive ${name}:`, err.message); }
  });
  console.log('[RESET_DATA] ✅ Data store cleared — gold demo starts fresh. REMOVE RESET_DATA now.');
}

// Manual halt reset — set RESET_HALT=true, redeploy, then remove it.
if (process.env.RESET_HALT === 'true') {
  try {
    const riskStateFile = path.join(process.env.DATA_DIR || __dirname, 'live-risk-state.json');
    const state = fs.existsSync(riskStateFile) ? JSON.parse(fs.readFileSync(riskStateFile, 'utf8')) : {};
    state.haltUntil = null; state.haltReason = null;
    state.haltResetAt = new Date().toISOString(); state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(riskStateFile, JSON.stringify(state, null, 2), 'utf8');
    console.log('[RESET_HALT] ✅ Halt cleared — trading resumed. Streak reset.');
  } catch (err) { console.error('[RESET_HALT] Failed:', err.message); }
}

writeLog({ type: 'STARTUP', message: `${BOT_NAME} starting — ${modeLabel}` });
sendAlert(`${BOT_NAME} Bot started — ${modeLabel} | ${INSTRUMENT_LABEL} | market ${isMarketOpen() ? 'OPEN' : 'CLOSED'}`,
  { emoji: '🚀', subject: `🚀 ${BOT_NAME} — Bot Started (${modeLabel})` });

// Kick a first management pass shortly after boot (let Railway settle).
setTimeout(() => { runLightweightTrailUpdate().catch(e => console.error('startup trail error:', e.message)); }, 10000);
