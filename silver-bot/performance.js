const fs = require('fs');
const path = require('path');
const { PIP_SIZE } = require('./config');  // instrument pip size (gold 0.10)

// On Railway, DATA_DIR is set to the mounted volume path (e.g. /data).
// Locally it falls back to __dirname so development is unaffected.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const perfFile = path.join(DATA_DIR, 'performance.json');

function readPerformance() {
  if (!fs.existsSync(perfFile)) return { trades: [], summary: {} };
  return JSON.parse(fs.readFileSync(perfFile, 'utf8'));
}

function writePerformance(data) {
  fs.writeFileSync(perfFile, JSON.stringify(data, null, 2));
}

function recordTradeOpen(tradeId, decision, executionPrice) {
  const perf = readPerformance();
  perf.trades.push({
    tradeId: tradeId.toString(),
    openTime: new Date().toISOString(),
    closeTime: null,
    direction: decision.action,
    entryMethod: decision.entry_method,
    entryPrice: executionPrice,
    exitPrice: null,
    stopLoss: decision.stop_loss,
    takeProfit: decision.take_profit,
    lotSize: decision.lot_size,
    pipsResult: null,
    profitGBP: null,
    outcome: null,
    exitReason: null,          // how it closed: TP HIT | SL HIT | TIME_STOP | TRAIL/SCALE — set on close
    pendingExitReason: null,   // set when the BOT initiates a close (e.g. time-stop) so booking records the true reason
    // ── Gold-demo measurement fields — tag every trade so we can split edge by sleeve ──
    mode: decision.mode || null,              // TREND | RANGE — which sleeve fired
    grade: decision.grade || null,            // A | B — setup quality at entry
    slPips: decision.sl_pips || null,         // planned stop distance in pips
    tpR: decision.tp_r || null,               // planned take-profit in R (3 trend / 2 range)
    riskGBP: decision.risk_gbp || null,       // planned £ at risk — denominator for realised R (survives scale-outs)
    rMultiple: null,                          // filled in on close = profitGBP / riskGBP
    mfeR: 0,                                  // max FAVOURABLE excursion in R — how far it went our way (was it right? did it have room to run?)
    maeR: 0,                                  // max ADVERSE excursion in R — how deep it dipped (stops too tight?)
    regimeAdx: decision.regime_adx || null,   // ADX at entry — context for regime analysis
    entrySeq: decision.entry_seq || 1,        // 1 = initial entry, 2+ = a proven pyramid add
    concurrentSameDir: decision.concurrent_same_dir || 0,  // same-direction trades already open when this fired
    // Full indicator snapshot at entry — so any indicator-conditioned question is
    // answerable later straight from the data, with no code change.
    entryContext: decision.context || null,   // { rsi, macdHist, atrPips, distEma20Pips, posInRangePct, spreadPips }
    reasoning: decision.reasoning
  });
  writePerformance(perf);
  console.log(`Performance: trade ${tradeId} recorded as open`);
}

// Called on every management pass while a trade is open. Tracks the peak
// favourable (MFE) and worst adverse (MAE) excursion in R, so the daily report
// can answer: was the direction right, did it have room, would a tighter trail
// have banked more. Writes only on a meaningful change to limit disk churn.
function recordExcursion(tradeId, rNow) {
  if (rNow === null || rNow === undefined || Number.isNaN(rNow)) return;
  const perf = readPerformance();
  const trade = perf.trades.find(t => t.tradeId === tradeId.toString() && !t.closeTime);
  if (!trade) return;
  const prevMfe = trade.mfeR || 0;
  const prevMae = trade.maeR || 0;
  const newMfe = Math.max(prevMfe, rNow);
  const newMae = Math.min(prevMae, rNow);
  if (newMfe - prevMfe >= 0.05 || prevMae - newMae >= 0.05) {
    trade.mfeR = parseFloat(newMfe.toFixed(2));
    trade.maeR = parseFloat(newMae.toFixed(2));
    writePerformance(perf);
  }
}

// Drop a stale OPEN record whose trade no longer exists on the account. A definitive
// 404 on lookup means it isn't ours to book — e.g. a demo record carried into the
// live bot when the volume wasn't reset, or a post-reset orphan. Removing it stops
// the endless per-cycle 404 retries without touching any real trade.
function removeOpenRecord(tradeId) {
  const perf = readPerformance();
  const before = perf.trades.length;
  perf.trades = perf.trades.filter(t => !(t.tradeId === tradeId.toString() && !t.closeTime));
  if (perf.trades.length !== before) {
    writePerformance(perf);
    console.log(`[book] pruned stale open record ${tradeId} — not on this account`);
    return true;
  }
  return false;
}

function recordTradeClose(tradeId, exitPrice, profitGBP, explicitReason = null) {
  const perf = readPerformance();
  const trade = perf.trades.find(t => t.tradeId === tradeId.toString() && !t.closeTime);

  if (!trade) {
    console.log(`Performance: trade ${tradeId} not found for close recording`);
    return;
  }

  const pips = trade.direction === 'BUY'
    ? ((exitPrice - trade.entryPrice) / PIP_SIZE)
    : ((trade.entryPrice - exitPrice) / PIP_SIZE);

  trade.closeTime = new Date().toISOString();
  trade.exitPrice = exitPrice;
  trade.pipsResult = parseFloat(pips.toFixed(1));
  trade.profitGBP = parseFloat(profitGBP.toFixed(2));
  trade.outcome = profitGBP > 0 ? 'WIN' : profitGBP < 0 ? 'LOSS' : 'BREAKEVEN';

  // Exit reason — how the trade actually ended. An explicit reason (bot-initiated,
  // e.g. a time-stop) always wins; otherwise infer from where price closed relative
  // to the planned target/stop. Note: winners often exit via the TRAILED stop after
  // a scale-out rather than the fixed TP, so those land in TRAIL/SCALE — that's
  // correct, not a miss. Tolerance is a few pips (or 5% of the stop distance).
  let reason = explicitReason || trade.pendingExitReason;
  if (!reason) {
    const tol = Math.max(5 * PIP_SIZE, (trade.slPips || 0) * 0.05 * PIP_SIZE);
    if (trade.takeProfit && Math.abs(exitPrice - trade.takeProfit) <= tol)      reason = 'TP HIT';
    else if (trade.stopLoss && Math.abs(exitPrice - trade.stopLoss) <= tol)     reason = 'SL HIT';
    else                                                                        reason = 'TRAIL/SCALE';
  }
  trade.exitReason = reason;
  trade.pendingExitReason = null;
  // Realised R = £ made ÷ £ risked. The single most important number for judging
  // whether a sleeve has edge — expectancy is just the average of this. Money-based
  // (not pip-based) so it stays correct through partial scale-outs.
  if (trade.riskGBP && trade.riskGBP > 0) {
    trade.rMultiple = parseFloat((trade.profitGBP / trade.riskGBP).toFixed(2));
  } else if (trade.slPips && trade.slPips > 0) {
    trade.rMultiple = parseFloat((trade.pipsResult / trade.slPips).toFixed(2));
  }

  writePerformance(perf);
  console.log(`Performance: trade ${tradeId} closed — ${trade.outcome} ${pips.toFixed(0)} pips £${profitGBP.toFixed(2)} (${trade.exitReason})`);
  return trade;   // so the caller (close-alert email) can show exit reason / R without re-reading
}

// Stamp an open record with the reason the BOT is closing it, BEFORE the close is
// discovered and booked by checkClosedTrades(). Used for bot-initiated exits (e.g.
// the 6h time-stop) so the booked trade carries the true reason instead of an
// inferred one. No-op if the trade isn't found or is already closed.
function markPendingExit(tradeId, reason) {
  const perf = readPerformance();
  const trade = perf.trades.find(t => t.tradeId === tradeId.toString() && !t.closeTime);
  if (!trade) return;
  trade.pendingExitReason = reason;
  writePerformance(perf);
}

function generateSummary() {
  const perf = readPerformance();
  const closed = perf.trades.filter(t => t.closeTime);

  if (closed.length === 0) return null;

  const wins = closed.filter(t => t.outcome === 'WIN');
  const losses = closed.filter(t => t.outcome === 'LOSS');
  const breakevens = closed.filter(t => t.outcome === 'BREAKEVEN');
  const decided = wins.length + losses.length;
  const winRate = decided > 0 ? ((wins.length / decided) * 100).toFixed(1) : '0.0';
  const totalPips = closed.reduce((sum, t) => sum + (t.pipsResult || 0), 0);
  const totalGBP = closed.reduce((sum, t) => sum + (t.profitGBP || 0), 0);
  const avgWin = wins.length > 0
    ? (wins.reduce((sum, t) => sum + t.pipsResult, 0) / wins.length).toFixed(1)
    : 0;
  const avgLoss = losses.length > 0
    ? (losses.reduce((sum, t) => sum + t.pipsResult, 0) / losses.length).toFixed(1)
    : 0;

  // Best entry method
  const methodStats = {};
  closed.forEach(t => {
    if (!methodStats[t.entryMethod]) methodStats[t.entryMethod] = { wins: 0, total: 0 };
    methodStats[t.entryMethod].total++;
    if (t.outcome === 'WIN') methodStats[t.entryMethod].wins++;
  });

  // Best time of day
  const hourStats = {};
  closed.forEach(t => {
    const hour = new Date(t.openTime).getUTCHours();
    if (!hourStats[hour]) hourStats[hour] = { wins: 0, total: 0 };
    hourStats[hour].total++;
    if (t.outcome === 'WIN') hourStats[hour].wins++;
  });

  return {
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: `${winRate}%`,
    totalPips: totalPips.toFixed(1),
    totalGBP: totalGBP.toFixed(2),
    avgWinPips: avgWin,
    avgLossPips: avgLoss,
    breakevens: breakevens.length,
    methodStats,
    hourStats,
    openTrades: perf.trades.filter(t => !t.closeTime).length
  };
}

function getRecentPerformanceSummary() {
  const perf = readPerformance();
  const closed = perf.trades.filter(t => t.closeTime);

  if (closed.length === 0) return 'No closed trades yet — insufficient data for performance weighting.';

  // Last 20 trades
  const recent = closed.slice(-20);
  const wins = recent.filter(t => t.outcome === 'WIN');
  const losses = recent.filter(t => t.outcome === 'LOSS');
  const decidedRecent = wins.length + losses.length;
  const winRate = decidedRecent > 0 ? ((wins.length / decidedRecent) * 100).toFixed(0) : '0';
  const totalPips = recent.reduce((sum, t) => sum + (t.pipsResult || 0), 0).toFixed(0);

  // Performance by entry method
  const methodStats = {};
  recent.forEach(t => {
    if (!methodStats[t.entryMethod]) methodStats[t.entryMethod] = { wins: 0, losses: 0, pips: 0 };
    if (t.outcome === 'WIN') methodStats[t.entryMethod].wins++;
    if (t.outcome === 'LOSS') methodStats[t.entryMethod].losses++;
    methodStats[t.entryMethod].pips += (t.pipsResult || 0);
  });

  // Performance by hour
  const hourStats = {};
  recent.forEach(t => {
    const hour = new Date(t.openTime).getUTCHours();
    if (!hourStats[hour]) hourStats[hour] = { wins: 0, losses: 0 };
    if (t.outcome === 'WIN') hourStats[hour].wins++;
    if (t.outcome === 'LOSS') hourStats[hour].losses++;
  });

  // Best and worst method
  let bestMethod = 'insufficient data';
  let worstMethod = 'insufficient data';
  let bestWinRate = -1;
  let worstWinRate = 101;

  Object.entries(methodStats).forEach(([method, stats]) => {
    const total = stats.wins + stats.losses;
    if (total < 2) return;
    const wr = (stats.wins / total) * 100;
    if (wr > bestWinRate) { bestWinRate = wr; bestMethod = method; }
    if (wr < worstWinRate) { worstWinRate = wr; worstMethod = method; }
  });

  // Best trading hours
  const bestHours = Object.entries(hourStats)
    .filter(([, stats]) => stats.wins + stats.losses >= 2)
    .sort(([, a], [, b]) => (b.wins / (b.wins + b.losses)) - (a.wins / (a.wins + a.losses)))
    .slice(0, 3)
    .map(([hour, stats]) => `${hour}:00 UTC (${stats.wins}W/${stats.losses}L)`)
    .join(', ');

  // Method breakdown
  const methodBreakdown = Object.entries(methodStats)
    .map(([method, stats]) => {
      const total = stats.wins + stats.losses;
      const wr = total > 0 ? ((stats.wins / total) * 100).toFixed(0) : 0;
      return `${method}: ${stats.wins}W/${stats.losses}L (${wr}% WR, ${stats.pips > 0 ? '+' : ''}${stats.pips.toFixed(0)} pips)`;
    })
    .join(' | ');

  return `
RECENT PERFORMANCE (last ${recent.length} trades):
Win Rate: ${winRate}% | Total Pips: ${totalPips > 0 ? '+' : ''}${totalPips}
Method Breakdown: ${methodBreakdown}
Best Method: ${bestMethod} (${bestWinRate.toFixed(0)}% WR)
Worst Method: ${worstMethod} (${worstWinRate.toFixed(0)}% WR)
Best Hours: ${bestHours || 'insufficient data'}

USE THIS DATA: Favour high win rate methods. Extra scrutiny on worst method. If win rate below 40% raise signal score requirement by 1. If above 60% lower by 1 during switchover windows.
`.trim();
}

// Records a trade that was closed on OANDA but never opened by this bot instance.
// Persists it so it is skipped permanently on future restarts.
function recordExternalTradeClose(tradeId, exitPrice, profitGBP) {
  const perf = readPerformance();
  const alreadyRecorded = perf.trades.some(t => t.tradeId === tradeId.toString());
  if (alreadyRecorded) return;

  perf.trades.push({
    tradeId:     tradeId.toString(),
    openTime:    null,
    closeTime:   new Date().toISOString(),
    direction:   'UNKNOWN',
    entryMethod: 'UNKNOWN',
    entryPrice:  null,
    exitPrice:   exitPrice,
    stopLoss:    null,
    takeProfit:  null,
    lotSize:     null,
    pipsResult:  null,
    profitGBP:   parseFloat(profitGBP.toFixed(2)),
    outcome:     profitGBP > 0 ? 'WIN' : profitGBP < 0 ? 'LOSS' : 'BREAKEVEN',
    signalScore: null,
    rsi1h:       null,
    macdLine:    null,
    reasoning:   'Pre-restart trade — no open record',
    preRestart:  true   // never counts toward consecutive loss streak
  });
  writePerformance(perf);
  console.log(`Performance: external trade ${tradeId} recorded as closed (pre-restart)`);
}

// ─── EXPECTANCY REPORT (split by sleeve) ──────────────────────────────────────
// The point of the whole demo: after a few dozen trades, does TREND have edge?
// Does RANGE? Expectancy (average realised R per trade) is the verdict.

function getExpectancyReport() {
  const perf = readPerformance();
  const closed = perf.trades.filter(t => t.closeTime && t.rMultiple !== null && t.rMultiple !== undefined);

  if (closed.length === 0) {
    return { text: 'No closed trades with R data yet — collecting sample.', modes: {}, overall: null };
  }

  function statsFor(trades) {
    if (trades.length === 0) return null;
    const wins   = trades.filter(t => t.outcome === 'WIN');
    const decided = trades.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS').length;
    const totalR = trades.reduce((s, t) => s + (t.rMultiple || 0), 0);
    const totalGBP = trades.reduce((s, t) => s + (t.profitGBP || 0), 0);
    return {
      trades:     trades.length,
      winRate:    decided > 0 ? (wins.length / decided * 100) : 0,
      expectancy: totalR / trades.length,   // avg R per trade — the edge
      totalR,
      totalGBP
    };
  }

  const modes = {};
  ['TREND', 'RANGE'].forEach(m => {
    const s = statsFor(closed.filter(t => t.mode === m));
    if (s) modes[m] = s;
  });
  const overall = statsFor(closed);

  const fmt = (label, s) => s
    ? `${label}: ${s.trades} trades | ${s.winRate.toFixed(0)}% WR | expectancy ${s.expectancy >= 0 ? '+' : ''}${s.expectancy.toFixed(2)}R | net ${s.totalR >= 0 ? '+' : ''}${s.totalR.toFixed(1)}R (£${s.totalGBP.toFixed(2)})`
    : `${label}: no trades yet`;

  const text = [
    fmt('OVERALL', overall),
    fmt('  TREND', modes.TREND),
    fmt('  RANGE', modes.RANGE)
  ].join('\n');

  return { text, modes, overall };
}

module.exports = { recordTradeOpen, recordTradeClose, recordExcursion, recordExternalTradeClose, removeOpenRecord, markPendingExit, generateSummary, readPerformance, getRecentPerformanceSummary, getPerformanceSummary: getRecentPerformanceSummary, getExpectancyReport };