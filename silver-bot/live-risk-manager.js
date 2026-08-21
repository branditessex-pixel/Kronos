/**
 * live-risk-manager.js — Silver Trader
 *
 * Dynamic risk management for XAG/USD live trading.
 *
 * Silver-specific values vs gold:
 *   PIP_SIZE        = 0.001  (vs 0.10 for gold)
 *   PIP_VALUE/LOT   = $0.10  (100 units × $0.001/pip)
 *   MAX_LOT         = 0.10   (silver is cheap — ~$33/oz vs $4700/oz)
 *
 * Formula: lot = (balance × 0.01) / (stopLossPips × 0.10)
 * Example at $50 balance, 400-pip SL (calibrated for silver at ~$75):
 *   (50 × 0.01) / (400 × 0.10) = 0.50 / 40 = 0.0125 → 0.01 lots (1 unit, MIN_LOT)
 *   Risk = 0.01 × 400 × $0.10 = $0.40 = 0.8% of $50 ✓
 *   TP   = 0.01 × 800 × $0.10 = $0.80 per winning trade (2:1 R:R) ✓
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { sendAlert } = require('./alerts');
const { PIP_VALUE_PER_LOT, MAX_LOT } = require('./config');  // instrument-specific (gold 10/$pip & cap 10; silver 0.10 & cap 500)

// ─── CONFIGURATION ────────────────────────────────────────────────────────────

const MAX_RISK_PCT          = 0.01;   // 1% of account balance per trade (trade 1)
const TRADE2_RISK_PCT       = 0.005;  // 0.5% for dip-continuation second trade
const MIN_LOT               = 0.0005; // 0.0005 lot = 0.05 units — 5× the OANDA index minimum. MIN_LOT == MAX_LOT pins every US30 trade at exactly 0.05 units (~£105 margin / ~£3.50–4.85 risk ≈ 0.9–1.0% of the ~£387 account). Nudged from 0.04 toward the 1% risk target; still a small fraction of the shared account. (Balance-scaling "Option A" is parked, not wired — flip on later.)
// MAX_LOT now imported from config — instrument-specific sanity cap; 1% risk is the real limiter
const COMPOUND_GROWTH_STEP  = 0.10;   // rebase every 10% account growth

// ── Loss-halt thresholds — RELAXED FOR DEMO DATA GATHERING ────────────────────
// The point of the demo is to measure true expectancy over a large sample, so we
// must NOT stop after a normal losing streak (that truncates and biases the data).
// All three are env-overridable; 0 disables a check. Defaults: streak halts OFF,
// lot-reduction OFF (keeps sizing consistent for clean R stats), and only a wide
// 15% daily-loss backstop to catch a genuinely broken day. Tighten these (e.g.
// CONSEC_HALT_AT=3, MAX_DAILY_LOSS_PCT=0.04) when moving toward a real evaluation.
const CONSEC_REDUCE_AT      = parseInt(process.env.CONSEC_REDUCE_AT ?? '0', 10);   // 0 = off
const CONSEC_HALT_AT        = parseInt(process.env.CONSEC_HALT_AT ?? '0', 10);     // 0 = off
const MAX_DAILY_LOSS_PCT    = parseFloat(process.env.MAX_DAILY_LOSS_PCT ?? '0.15'); // 0 = off

// ─── MIDNIGHT RESET HELPER ────────────────────────────────────────────────────
// Returns a Date representing midnight tonight (00:00 Europe/London).
// DST-safe: detects UTC offset so midnight is correct in both GMT and BST.
// The bot sleeps from 20:00–07:00 anyway, so a midnight reset means the halt
// is always cleared before the bot wakes — no manual intervention needed.

function getMidnightReset() {
  const now = new Date();

  // Today's date string in London time (en-CA gives YYYY-MM-DD format)
  const todayLondon = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London'
  }).format(now); // e.g. "2026-05-01"

  const [y, m, d] = todayLondon.split('-').map(Number);

  // Tomorrow's date (JS Date handles month/year overflow automatically)
  const tomorrowJS  = new Date(y, m - 1, d + 1);
  const ty = tomorrowJS.getFullYear();
  const tm = String(tomorrowJS.getMonth() + 1).padStart(2, '0');
  const td = String(tomorrowJS.getDate()).padStart(2, '0');
  const tomorrowStr = `${ty}-${tm}-${td}`;

  // Detect London UTC offset at noon tomorrow
  const noonProbe = new Date(`${tomorrowStr}T12:00:00Z`);
  const londonNoon = parseInt(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: 'numeric', hour12: false
    }).format(noonProbe),
    10
  );
  const utcOffset = londonNoon - 12; // 0 = GMT, 1 = BST

  // Midnight London in UTC:
  //   GMT (offset 0): 00:00 UTC on tomorrow's date
  //   BST (offset 1): 23:00 UTC on today's date (= 00:00 London next day)
  if (utcOffset === 0) {
    return new Date(`${tomorrowStr}T00:00:00Z`);
  } else {
    return new Date(`${todayLondon}T23:00:00Z`);
  }
}

// ─── STATE FILE ───────────────────────────────────────────────────────────────

const DATA_DIR      = process.env.DATA_DIR || __dirname;
const perfFile      = path.join(DATA_DIR, 'performance.json');
const riskStateFile = path.join(DATA_DIR, 'live-risk-state.json');

const DEFAULT_STATE = {
  baselineBalance: null,
  haltUntil:       null,
  haltReason:      null,
  haltResetAt:     null,   // set when a halt is cleared — consecutive losses only count after this
  lastUpdated:     null
};

function readRiskState() {
  try {
    if (!fs.existsSync(riskStateFile)) return { ...DEFAULT_STATE };
    return JSON.parse(fs.readFileSync(riskStateFile, 'utf8'));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeRiskState(state) {
  try {
    const tmp = riskStateFile + '.tmp';
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, riskStateFile);
  } catch (err) {
    process.stderr.write(`[SILVER RISK STATE WRITE FAILED] ${err.message}\n`);
  }
}

function readPerformance() {
  try {
    if (!fs.existsSync(perfFile)) return { trades: [] };
    return JSON.parse(fs.readFileSync(perfFile, 'utf8'));
  } catch {
    return { trades: [] };
  }
}

// ─── 1. DYNAMIC LOT SIZING ────────────────────────────────────────────────────

function calculateDynamicLotSize(accountBalance, stopLossPips, riskPct = MAX_RISK_PCT) {
  if (!accountBalance || accountBalance <= 0 || !stopLossPips || stopLossPips <= 0) {
    return { lotSize: MIN_LOT, riskPct: null, note: 'Invalid inputs — using minimum lot' };
  }

  const rawLot = (accountBalance * riskPct) / (stopLossPips * PIP_VALUE_PER_LOT);
  const clampedLot = Math.min(MAX_LOT, Math.max(MIN_LOT, parseFloat(rawLot.toFixed(2))));
  const actualRiskPct = ((clampedLot * stopLossPips * PIP_VALUE_PER_LOT) / accountBalance * 100).toFixed(2);

  return {
    lotSize:  clampedLot,
    riskPct:  actualRiskPct,
    note:     `Risk: ${actualRiskPct}% of $${accountBalance.toFixed(2)} | SL: ${stopLossPips} pips | Raw lot: ${rawLot.toFixed(4)} → ${clampedLot}`
  };
}

// ─── 2. DAILY LOSS LIMIT ──────────────────────────────────────────────────────

function getDailyPnl() {
  const perf = readPerformance();
  const today = new Date().toISOString().slice(0, 10);
  const todayTrades = perf.trades.filter(t =>
    t.closeTime && t.closeTime.startsWith(today) && t.profitGBP !== null && !t.preRestart
  );
  return todayTrades.reduce((sum, t) => sum + (t.profitGBP || 0), 0);
}

async function checkDailyLossLimit(accountBalance) {
  const dailyPnl      = getDailyPnl();
  const dailyLossLimit = accountBalance * MAX_DAILY_LOSS_PCT;
  const dailyLossPct   = ((Math.abs(Math.min(0, dailyPnl)) / accountBalance) * 100).toFixed(2);

  if (MAX_DAILY_LOSS_PCT > 0 && dailyPnl <= -dailyLossLimit) {
    const message = `Daily loss limit hit: -$${Math.abs(dailyPnl).toFixed(2)} (${dailyLossPct}% of balance $${accountBalance.toFixed(2)}). Trading halted until tomorrow.`;
    console.log(`RISK — ${message}`);
    return { halt: true, reason: message, dailyPnl, dailyLossPct };
  }

  return {
    halt:       false,
    dailyPnl,
    dailyLossPct,
    remaining:  parseFloat((dailyLossLimit + dailyPnl).toFixed(2)),
    note:       `Daily P&L: $${dailyPnl.toFixed(2)} | Limit: -$${dailyLossLimit.toFixed(2)} | Headroom: $${(dailyLossLimit + dailyPnl).toFixed(2)}`
  };
}

// ─── 3. CONSECUTIVE LOSS PROTECTION ──────────────────────────────────────────

function getConsecutiveLosses(sinceISO = null) {
  const perf = readPerformance();
  // Exclude pre-restart trades and anything before the last halt reset
  const closed = perf.trades.filter(t => {
    if (!t.closeTime || !t.outcome || t.preRestart) return false;
    if (sinceISO && t.closeTime <= sinceISO) return false;
    return true;
  });
  let count = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    if (closed[i].outcome === 'LOSS') count++;
    else break;
  }
  return count;
}

async function checkConsecutiveLosses() {
  const state       = readRiskState();
  // Only count losses that occurred after the last halt reset — prevents
  // the bot re-halting itself immediately after a manual or midnight reset
  const consecutive = getConsecutiveLosses(state.haltResetAt || null);

  // Active halt?
  if (state.haltUntil && Date.now() < new Date(state.haltUntil).getTime()) {
    const minutesLeft = Math.ceil((new Date(state.haltUntil).getTime() - Date.now()) / 60000);
    return {
      halt:              true,
      lotMultiplier:     0,
      consecutiveLosses: consecutive,
      reason:            `Halt active — ${consecutive} consecutive losses. Resumes in ${minutesLeft} min (${state.haltReason})`
    };
  }

  // Clear expired halt — stamp haltResetAt so the streak restarts from now
  if (state.haltUntil && Date.now() >= new Date(state.haltUntil).getTime()) {
    state.haltUntil   = null;
    state.haltReason  = null;
    state.haltResetAt = new Date().toISOString();
    writeRiskState(state);
    console.log('SILVER RISK — Trading halt expired, trading resumed. Consecutive loss streak reset.');
  }

  if (CONSEC_HALT_AT > 0 && consecutive >= CONSEC_HALT_AT) {
    const resumeAt   = getMidnightReset();
    const haltUntil  = resumeAt.toISOString();
    const resumeStr  = resumeAt.toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'short', timeStyle: 'short' });
    const reason     = `${consecutive} consecutive losses`;
    state.haltUntil  = haltUntil;
    state.haltReason = reason;
    writeRiskState(state);
    const message = `Silver trading paused after ${consecutive} consecutive losses. Halt clears at midnight UK (${resumeStr}) — bot resumes normally at 07:00.`;
    console.log(`SILVER RISK — ${message}`);
    await sendAlert(message, { emoji: '⏸️', subject: `⏸️ Silver Trader — Trading Paused (${consecutive} losses)` });
    return { halt: true, lotMultiplier: 0, consecutiveLosses: consecutive, reason: message };
  }

  if (CONSEC_REDUCE_AT > 0 && consecutive >= CONSEC_REDUCE_AT) {
    const message = `${consecutive} consecutive losses — lot size reduced by 50%`;
    console.log(`RISK — ${message}`);
    return { halt: false, lotMultiplier: 0.5, consecutiveLosses: consecutive, reason: message };
  }

  return { halt: false, lotMultiplier: 1.0, consecutiveLosses: consecutive, reason: null };
}

// ─── 4. COMPOUND GROWTH SCALING ───────────────────────────────────────────────

function checkCompoundGrowth(accountBalance) {
  const state = readRiskState();

  if (!state.baselineBalance) {
    state.baselineBalance = accountBalance;
    writeRiskState(state);
    console.log(`SILVER RISK — Compound baseline set: $${accountBalance.toFixed(2)}`);
    return { rebased: false, baselineBalance: accountBalance };
  }

  const growthPct = (accountBalance - state.baselineBalance) / state.baselineBalance;
  if (growthPct >= COMPOUND_GROWTH_STEP) {
    const oldBaseline = state.baselineBalance;
    state.baselineBalance = accountBalance;
    writeRiskState(state);
    console.log(`SILVER RISK — Account grew ${(growthPct * 100).toFixed(1)}% — compound baseline rebased: $${oldBaseline.toFixed(2)} → $${accountBalance.toFixed(2)}`);
    return { rebased: true, oldBaseline, newBaseline: accountBalance, growthPct: (growthPct * 100).toFixed(1) };
  }

  const progressPct = (growthPct / COMPOUND_GROWTH_STEP * 100).toFixed(0);
  return {
    rebased:         false,
    baselineBalance: state.baselineBalance,
    growthPct:       (growthPct * 100).toFixed(1),
    progressToNext:  `${progressPct}% of the way to next 10% rebase`
  };
}

// ─── 5. COMBINED ASSESSMENT ───────────────────────────────────────────────────

async function getLiveRiskAssessment(accountBalance, stopLossPips, riskPctOverride = null) {
  // Compound growth check (passive — logs and rebases if needed)
  const compound = checkCompoundGrowth(accountBalance);

  // Daily loss limit
  const daily = await checkDailyLossLimit(accountBalance);
  if (daily.halt) {
    return { approved: false, lotSize: 0, reason: daily.reason, log: daily.note };
  }

  // Consecutive loss protection
  const consec = await checkConsecutiveLosses();
  if (consec.halt) {
    return { approved: false, lotSize: 0, reason: consec.reason, log: `Consecutive losses: ${consec.consecutiveLosses}` };
  }

  // Dynamic lot sizing
  const sizing = calculateDynamicLotSize(accountBalance, stopLossPips, riskPctOverride || MAX_RISK_PCT);
  let finalLot  = sizing.lotSize;

  // Apply consecutive-loss reduction if needed
  if (consec.lotMultiplier < 1.0) {
    finalLot = Math.max(MIN_LOT, parseFloat((finalLot * consec.lotMultiplier).toFixed(2)));
    console.log(`SILVER RISK — Lot reduced: ${sizing.lotSize} × ${consec.lotMultiplier} = ${finalLot} (${consec.reason})`);
  }

  const logLine = [
    sizing.note,
    consec.consecutiveLosses > 0 ? `Consecutive losses: ${consec.consecutiveLosses}` : null,
    consec.reason,
    daily.note,
    compound.rebased ? `Compound rebased to $${compound.newBaseline}` : `Growth: ${compound.growthPct}% (${compound.progressToNext || ''})`
  ].filter(Boolean).join(' | ');

  console.log(`SILVER RISK — ${logLine}`);

  return {
    approved: true,
    lotSize:  finalLot,
    riskPct:  sizing.riskPct,
    reason:   null,
    log:      logLine
  };
}

// ─── FAST HALT CHECK ──────────────────────────────────────────────────────────
// Cheap synchronous check — reads state file only, no API calls.
// Called at the very top of runTradingCycle() before any Claude calls
// so a halted bot never wastes tokens or accidentally trades.
//
// Also handles:
//   RESET_HALT=true env var  — clears all halt state immediately (manual override)
//   Expired halt auto-clear  — if haltUntil is in the past, clear it here so the
//                              bot doesn't re-halt itself on the next redeploy

function isTradingHalted() {
  const state = readRiskState();

  // Manual reset via Railway env var — set RESET_HALT=true, deploy, then remove it
  if (process.env.RESET_HALT?.toLowerCase() === 'true') {
    state.haltUntil   = null;
    state.haltReason  = null;
    state.haltResetAt = new Date().toISOString();
    writeRiskState(state);
    console.log('SILVER RISK — Manual halt reset (RESET_HALT=true). All halts cleared, consecutive loss streak reset.');
    return { halted: false };
  }

  // Active halt — still in the future
  if (state.haltUntil && Date.now() < new Date(state.haltUntil).getTime()) {
    const minutesLeft = Math.ceil((new Date(state.haltUntil).getTime() - Date.now()) / 60000);
    return {
      halted: true,
      reason: `Trading paused — ${state.haltReason}. Resumes in ${minutesLeft} min.`
    };
  }

  // Expired halt — clear it now and stamp haltResetAt so checkConsecutiveLosses()
  // won't re-count the same old losses and immediately re-halt on next cycle/deploy
  if (state.haltUntil && Date.now() >= new Date(state.haltUntil).getTime()) {
    state.haltUntil   = null;
    state.haltReason  = null;
    state.haltResetAt = new Date().toISOString();
    writeRiskState(state);
    console.log('SILVER RISK — Trading halt expired, cleared. Consecutive loss streak reset.');
  }

  return { halted: false };
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  getLiveRiskAssessment,
  calculateDynamicLotSize,
  TRADE2_RISK_PCT,
  checkDailyLossLimit,
  checkConsecutiveLosses,
  checkCompoundGrowth,
  isTradingHalted,
  getDailyPnl,
  getConsecutiveLosses
};
