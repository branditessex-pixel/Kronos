'use strict';

/**
 * backtest.js — regime-threshold calibration harness
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 * ---------------
 * The live engine's regime detector (ADX_TREND_MIN 22 / ADX_RANGE_MAX 18 and
 * the RSI hard-blocks 78/22) was fitted to GOLD. On silver's first live day the
 * same numbers ran ADX ~19–20, so a real uptrend was classified as RANGE and
 * FADED — six counter-trend sells, −£3.6k. Rather than eyeball new numbers off
 * one bad day (the guess-and-bleed trap), this harness replays months of real
 * H1/H4 history through the EXACT same dual-sleeve logic and sweeps the regime
 * thresholds to find where trend and range actually separate FOR EACH MARKET.
 *
 * WHAT IT DOES
 * ------------
 *   1. fetch  — pull months of OANDA H1 + H4 candles (paginated) and cache to
 *               ./backtest-data/<INSTR>-<gran>.json so a sweep is repeatable
 *               offline.
 *   2. run    — replay the engine over the cached candles for a grid of ADX /
 *               RSI thresholds, simulating scale-out → breakeven → trail →
 *               time-stop plus the opposing / pyramid / max-concurrent guards,
 *               then rank configs by expectancy (avg R per trade).
 *   3. selftest — no network: synthesise a trending leg and a ranging leg and
 *               assert both sleeves fire and the metrics compute. Lets us prove
 *               the harness before trusting its numbers.
 *
 * FAITHFULNESS
 * ------------
 * The heavy indicator maths is imported from the live code (calcATR / calcADX
 * via trader.js `_internals`, and calculateEMA/RSI/MACD from indicators.js), so
 * the numbers match the bot exactly. Only the threshold COMPARISONS — the thing
 * being swept — are re-expressed here, reading from a per-candle feature
 * snapshot computed once. Non-swept tunables mirror trader.js (see STRAT below);
 * if you change them there, change them here.
 *
 * MODELLING NOTES / assumptions (documented, not hidden):
 *   • Bar-close entries: a signal fills at the H1 candle close; the trade is then
 *     managed from the NEXT candle using each bar's high/low/close. The live bot
 *     re-evaluates every 5 min, but signals are H1-close driven, so one decision
 *     per H1 bar is a faithful approximation.
 *   • Spread: entry is taken at mid ± half-spread (BUY=ask, SELL=bid) exactly as
 *     buildEntry does; SL/TP fills use the candle's mid high/low. Per-instrument
 *     spread (in pips) is configurable — silver's spread is a real cost and is
 *     modelled.
 *   • Both-hit-in-one-bar is resolved adversely (SL before TP).
 *   • A trade still open at the end of the data is marked-to-market at the last
 *     close and flagged (forcedExit) so it never silently vanishes.
 *
 * USAGE
 *   node backtest.js selftest                 # offline sanity check
 *   node backtest.js fetch XAG_USD            # cache silver history (needs creds)
 *   node backtest.js fetch XAU_USD            # cache gold history
 *   node backtest.js run  XAG_USD            # sweep on cached silver
 *   node backtest.js run  XAU_USD            # sweep on cached gold (sanity-check)
 *   node backtest.js XAG_USD                  # fetch-if-missing then run
 *
 * Credentials come from config.js (the same OANDA_* env vars the bot uses); the
 * instrument is taken from the CLI arg, NOT from the INSTRUMENT env var, so one
 * checkout can calibrate every market.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { BASE, TOKEN } = require('./config');
const { calculateEMA, calculateRSI, calculateMACD } = require('./indicators');
const { _internals } = require('./trader');
const { calcATR, calcADX } = _internals;

const http = axios.create({
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  timeout: 30000
});

const DATA_DIR = path.join(__dirname, 'backtest-data');

// ─── INSTRUMENT SPECS (mirror config.js) + modelled spread ────────────────────
// spreadPips = typical OANDA spread expressed in this instrument's pips. Silver's
// pip is 100× cheaper than gold's, so its raw spread is a much bigger pip-count
// and a real drag — modelling it stops the sweep from flattering silver.
const SPECS = {
  XAU_USD:  { pipSize: 0.10,  pipValuePerLot: 10,   label: 'XAU/USD', name: 'Gold',   spreadPips: 3  },
  XAG_USD:  { pipSize: 0.001, pipValuePerLot: 0.10, label: 'XAG/USD', name: 'Silver', spreadPips: 25 },
  US30_USD: { pipSize: 1.0,   pipValuePerLot: 100,  label: 'US30',    name: 'US30',   spreadPips: 3  }
};

// ─── STRATEGY TUNABLES (mirror trader.js) ─────────────────────────────────────
// Values under SWEEP are overridden per combo; the rest are held fixed so the
// sweep isolates the regime thresholds. Keep these in sync with trader.js.
const STRAT = {
  MAX_CONCURRENT_TRADES: 6,
  // ── swept (defaults mirror trader.js — silver-calibrated) ──
  ADX_TREND_MIN: 18,
  ADX_RANGE_MAX: 14,
  RSI_HARD_BLOCK_HI: 85,
  RSI_HARD_BLOCK_LO: 15,
  RANGE_RSI_HI: 60,
  RANGE_RSI_LO: 40,
  // ── fixed ──
  ATR_SL_MULT_TREND: 1.0,
  ATR_SL_MULT_RANGE: 1.0,
  MIN_SL_PIPS: 120,
  MAX_SL_PIPS: 300,
  TREND_TP_R: 3.0,
  RANGE_TP_R: 2.0,
  SCALEOUT_R_TREND: 1.0,
  SCALEOUT_R_RANGE: 1.0,
  TRAIL_PIPS: 80,
  BREAKEVEN_BUFFER_PIPS: 15,
  MAX_TRADE_HOURS: 6,
  H4_NEUTRAL_PIPS: 30,
  PULLBACK_ZONE_PIPS: 130,
  BREAKOUT_MAX_CANDLES: 3,
  RANGE_LOOKBACK: 20,
  RANGE_EDGE_PCT: 0.30,
  RANGE_MIN_ATR: 2.0
};

const H1_HISTORY = 250;   // live bot fetches 250 H1 per cycle — match its view
const H4_HISTORY = 120;   // live bot fetches 120 H4

// ═══════════════════════════════════════════════════════════════════════════
// DATA — paginated OANDA fetch + cache
// ═══════════════════════════════════════════════════════════════════════════

async function fetchCandles(instrument, granularity, want) {
  if (!TOKEN) throw new Error('No OANDA token — set OANDA_API_KEY (see config.js). Cannot fetch from this environment.');
  const collected = [];
  let to = null;
  while (collected.length < want) {
    let url = `${BASE}/v3/instruments/${instrument}/candles?granularity=${granularity}&price=M&count=5000`;
    if (to) url += `&to=${encodeURIComponent(to)}&includeFirst=false`;
    const res = await http.get(url);
    const raw = (res.data.candles || []).filter(c => c.complete);
    if (raw.length === 0) break;
    const mapped = raw.map(c => ({
      time: c.time,
      open: parseFloat(c.mid.o), high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),  close: parseFloat(c.mid.c)
    }));
    collected.unshift(...mapped);       // older batch goes in front
    to = mapped[0].time;                // walk further back next loop
    process.stdout.write(`\r  ${granularity}: ${collected.length} candles…`);
    if (raw.length < 5000) break;       // hit the start of available history
  }
  process.stdout.write('\n');
  // dedupe by time + sort ascending
  const seen = new Map();
  for (const c of collected) seen.set(c.time, c);
  return [...seen.values()].sort((a, b) => new Date(a.time) - new Date(b.time));
}

async function fetchAndCache(instrument) {
  if (!SPECS[instrument]) throw new Error(`Unknown instrument ${instrument}`);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`Fetching ${instrument} history from OANDA (${BASE})…`);
  const h1 = await fetchCandles(instrument, 'H1', 6000);   // ~8 months of H1
  const h4 = await fetchCandles(instrument, 'H4', 1500);   // comfortably covers it
  fs.writeFileSync(path.join(DATA_DIR, `${instrument}-H1.json`), JSON.stringify(h1));
  fs.writeFileSync(path.join(DATA_DIR, `${instrument}-H4.json`), JSON.stringify(h4));
  const span = (new Date(h1[h1.length - 1].time) - new Date(h1[0].time)) / 86400000;
  console.log(`Cached ${h1.length} H1 + ${h4.length} H4 candles — ${span.toFixed(0)} days (${h1[0].time.slice(0, 10)} → ${h1[h1.length - 1].time.slice(0, 10)})`);
  return { h1, h4 };
}

function loadCached(instrument) {
  const p1 = path.join(DATA_DIR, `${instrument}-H1.json`);
  const p4 = path.join(DATA_DIR, `${instrument}-H4.json`);
  if (!fs.existsSync(p1) || !fs.existsSync(p4)) return null;
  return { h1: JSON.parse(fs.readFileSync(p1)), h4: JSON.parse(fs.readFileSync(p4)) };
}

// ═══════════════════════════════════════════════════════════════════════════
// FEATURE PRECOMPUTE — one pass over H1, param-independent
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything a trade decision needs EXCEPT the swept thresholds. Computed once
// so the sweep is O(1) per candle per combo. Uses the same 250-H1 / 120-H4
// windows the live bot sees.

function precomputeFeatures(h1, h4, spec) {
  const pip = spec.pipSize;
  const feats = new Array(h1.length).fill(null);

  // For each H1 index, find the newest H4 candle whose close-time <= this H1 time.
  // h4 is ascending; advance a pointer.
  let h4ptr = 0;
  const startIdx = Math.max(H1_HISTORY - 1, 60);   // need a full window + warmup

  for (let i = startIdx; i < h1.length; i++) {
    const cur = h1[i];
    const win1h = h1.slice(i - (H1_HISTORY - 1), i + 1);
    const closes1h = win1h.map(c => c.close);

    while (h4ptr + 1 < h4.length && new Date(h4[h4ptr + 1].time) <= new Date(cur.time)) h4ptr++;
    const h4hi = h4ptr;
    const h4Start = Math.max(0, h4hi - (H4_HISTORY - 1));
    const win4h = h4.slice(h4Start, h4hi + 1).filter(c => new Date(c.time) <= new Date(cur.time));
    const closes4h = win4h.map(c => c.close);

    const adx = calcADX(win1h, 14);
    const atr = calcATR(win1h, 14);
    const h1Ema20 = calculateEMA(closes1h, 20);
    const rsi = calculateRSI(closes1h, 14);
    const macd = calculateMACD(closes1h);
    const h4Ema50 = closes4h.length >= 50 ? calculateEMA(closes4h, 50) : null;
    const price = cur.close;   // bar-close mid

    // consecutive closes beyond H1 EMA20, both directions (for breakout freshness)
    let beyondUp = 0, beyondDown = 0;
    for (let k = closes1h.length - 1; k >= 0; k--) { if (closes1h[k] > h1Ema20) beyondUp++; else break; }
    for (let k = closes1h.length - 1; k >= 0; k--) { if (closes1h[k] < h1Ema20) beyondDown++; else break; }

    // recent range (for the RANGE sleeve)
    const recent = win1h.slice(-STRAT.RANGE_LOOKBACK);
    const rangeHigh = Math.max(...recent.map(c => c.high));
    const rangeLow = Math.min(...recent.map(c => c.low));
    const width = rangeHigh - rangeLow;
    const posInRange = width > 0 ? (price - rangeLow) / width : 0.5;
    const lastCompleted = win1h[win1h.length - 2] || cur;   // mirror trader.js "last completed"

    feats[i] = {
      i, time: cur.time, price, high: cur.high, low: cur.low,
      adx, atr, atrPips: atr / pip, h1Ema20, rsi,
      macdHist: macd.histogram, macdPrevHist: macd.prevHistogram,
      h4Ema50, beyondUp, beyondDown,
      rangeHigh, rangeLow, width, posInRange, lastCompleted
    };
  }
  return { feats, startIdx };
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL LOGIC — parameterised mirror of trader.js (reads a feature snapshot)
// ═══════════════════════════════════════════════════════════════════════════

const hold = (r) => ({ shouldEnter: false, reasoning: r });
const clampSl = (p, P) => Math.max(P.MIN_SL_PIPS, Math.min(P.MAX_SL_PIPS, p));

function detectRegime(adx, P, state) {
  let regime;
  if (adx >= P.ADX_TREND_MIN) regime = 'TREND';
  else if (adx <= P.ADX_RANGE_MAX) regime = 'RANGE';
  else regime = state.lastRegime;
  state.lastRegime = regime;
  return regime;
}

function evaluateTrend(f, P, spec) {
  const pip = spec.pipSize;
  if (f.h4Ema50 == null) return hold('Insufficient H4 data');
  const price = f.price;
  const bullish = price > f.h4Ema50 + P.H4_NEUTRAL_PIPS * pip;
  const bearish = price < f.h4Ema50 - P.H4_NEUTRAL_PIPS * pip;
  if (!bullish && !bearish) return hold('H4 neutral band');
  const bias = bullish ? 'BUY' : 'SELL';

  const macdFavours = bias === 'BUY' ? f.macdHist > 0 : f.macdHist < 0;
  const macdTurning = bias === 'BUY' ? f.macdHist > f.macdPrevHist : f.macdHist < f.macdPrevHist;

  const distPips = Math.abs(price - f.h1Ema20) / pip;
  const onTrendSide = bias === 'BUY' ? price >= f.h1Ema20 : price <= f.h1Ema20;

  let entryMode, grade;
  if (distPips <= P.PULLBACK_ZONE_PIPS) {
    entryMode = 'PULLBACK';
    if (!macdTurning) return hold('pullback, MACD not turning');
    grade = macdFavours ? 'A' : 'B';
  } else if (onTrendSide) {
    const beyond = bias === 'BUY' ? f.beyondUp : f.beyondDown;
    if (beyond > P.BREAKOUT_MAX_CANDLES) return hold('breakout stale');
    if (!macdFavours) return hold('breakout, MACD against');
    entryMode = 'BREAKOUT';
    grade = macdTurning ? 'A' : 'B';
  } else {
    return hold('wrong side of EMA20');
  }

  if (bias === 'BUY' && f.rsi > P.RSI_HARD_BLOCK_HI) return hold(`BUY blocked RSI ${f.rsi.toFixed(0)}`);
  if (bias === 'SELL' && f.rsi < P.RSI_HARD_BLOCK_LO) return hold(`SELL blocked RSI ${f.rsi.toFixed(0)}`);

  const slPips = clampSl(Math.round(f.atrPips * P.ATR_SL_MULT_TREND), P);
  return buildEntry('TREND', bias, entryMode, grade, f, slPips, P.TREND_TP_R, spec);
}

function evaluateRange(f, P, spec) {
  const pip = spec.pipSize;
  if (f.atr <= 0 || f.width < P.RANGE_MIN_ATR * f.atr) return hold('range too tight');
  const price = f.price, last = f.lastCompleted;

  if (f.posInRange >= 1 - P.RANGE_EDGE_PCT && f.rsi >= P.RANGE_RSI_HI) {
    const rejecting = last.close < last.open || (last.high - Math.max(last.open, last.close)) > (last.high - last.low) * 0.4;
    if (rejecting) {
      const slPips = clampSl(Math.round(((f.rangeHigh - price) / pip) + f.atrPips * P.ATR_SL_MULT_RANGE), P);
      const grade = f.rsi >= 68 ? 'A' : 'B';
      return buildEntry('RANGE', 'SELL', 'RANGE_FADE', grade, f, slPips, P.RANGE_TP_R, spec);
    }
  }
  if (f.posInRange <= P.RANGE_EDGE_PCT && f.rsi <= P.RANGE_RSI_LO) {
    const rejecting = last.close > last.open || (Math.min(last.open, last.close) - last.low) > (last.high - last.low) * 0.4;
    if (rejecting) {
      const slPips = clampSl(Math.round(((price - f.rangeLow) / pip) + f.atrPips * P.ATR_SL_MULT_RANGE), P);
      const grade = f.rsi <= 32 ? 'A' : 'B';
      return buildEntry('RANGE', 'BUY', 'RANGE_FADE', grade, f, slPips, P.RANGE_TP_R, spec);
    }
  }
  return hold('mid-range / RSI not stretched');
}

function buildEntry(mode, action, entryMethod, grade, f, slPips, tpR, spec) {
  const pip = spec.pipSize;
  const half = (spec.spreadPips * pip) / 2;
  const entry = action === 'BUY' ? f.price + half : f.price - half;   // ask / bid
  const stopLoss = action === 'BUY' ? entry - slPips * pip : entry + slPips * pip;
  const takeProfit = action === 'BUY' ? entry + slPips * tpR * pip : entry - slPips * tpR * pip;
  return { shouldEnter: true, mode, action, entryMethod, grade, slPips, tpR, entry, stopLoss, takeProfit };
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMULATION — one full replay for a given param set
// ═══════════════════════════════════════════════════════════════════════════

function simulate(h1, feats, startIdx, P, spec) {
  const pip = spec.pipSize;
  const open = [];         // live trades
  const closed = [];       // finished trades
  const state = { lastRegime: 'RANGE' };

  const applyCandle = (t, c) => {
    // returns true if the trade closed on this candle
    const dir = t.dir;
    const riskDist = t.slPips * pip;
    const rAt = (px) => ((px - t.entry) / riskDist) * dir;

    // excursions (intrabar)
    const favPx = dir > 0 ? c.high : c.low;
    const advPx = dir > 0 ? c.low : c.high;
    t.mfeR = Math.max(t.mfeR, rAt(favPx));
    t.maeR = Math.min(t.maeR, rAt(advPx));

    const ageH = (new Date(c.time) - new Date(t.openTime)) / 3600000;

    // 1) time stop (only before breakeven, mirroring trader.js)
    if (!t.scaled && ageH >= P.MAX_TRADE_HOURS) {
      t.realizedR += t.frac * rAt(c.close);
      t.exit = 'TIME_STOP'; return true;
    }
    // 2) stop-loss hit (adverse-first)
    const slHit = dir > 0 ? c.low <= t.currentSL : c.high >= t.currentSL;
    if (slHit) {
      t.realizedR += t.frac * rAt(t.currentSL);
      t.exit = t.scaled ? 'TRAIL_SL' : 'STOP'; return true;
    }
    // 3) take-profit hit (runner keeps original TP)
    const tpHit = dir > 0 ? c.high >= t.takeProfit : c.low <= t.takeProfit;
    if (tpHit) {
      t.realizedR += t.frac * rAt(t.takeProfit);
      t.exit = 'TP'; return true;
    }
    // 4) scale-out + breakeven
    if (!t.scaled && rAt(c.close) >= t.scaleR) {
      t.realizedR += 0.5 * rAt(c.close);   // bank half at close
      t.frac = 0.5; t.scaled = true;
      t.currentSL = t.entry + P.BREAKEVEN_BUFFER_PIPS * pip * dir;
    } else if (t.scaled) {
      // 5) trail the runner (ratchet only)
      const trail = c.close - P.TRAIL_PIPS * pip * dir;
      if (dir > 0 ? trail > t.currentSL : trail < t.currentSL) t.currentSL = trail;
    }
    return false;
  };

  for (let i = startIdx; i < h1.length; i++) {
    const c = h1[i];
    // (a) manage existing trades on this candle
    for (let k = open.length - 1; k >= 0; k--) {
      if (applyCandle(open[k], c)) { closed.push(open[k]); open.splice(k, 1); }
    }
    const f = feats[i];
    if (!f) continue;

    // (b) consider a new entry (fills at this close, managed from next candle)
    if (open.length >= P.MAX_CONCURRENT_TRADES) continue;   // matches live early-return
    const regime = detectRegime(f.adx, P, state);
    const sig = regime === 'TREND' ? evaluateTrend(f, P, spec) : evaluateRange(f, P, spec);
    if (!sig.shouldEnter) continue;

    // guards
    const opposing = open.some(t => (t.action === 'BUY' && sig.action === 'SELL') || (t.action === 'SELL' && sig.action === 'BUY'));
    if (opposing) continue;
    const sameDir = open.filter(t => t.action === sig.action);
    const atRisk = sameDir.filter(t => !t.scaled);
    if (atRisk.length > 0) continue;

    open.push({
      dir: sig.action === 'BUY' ? 1 : -1, action: sig.action,
      mode: sig.mode, grade: sig.grade, entryMethod: sig.entryMethod,
      entry: sig.entry, currentSL: sig.stopLoss, takeProfit: sig.takeProfit,
      slPips: sig.slPips, scaleR: sig.mode === 'RANGE' ? P.SCALEOUT_R_RANGE : P.SCALEOUT_R_TREND,
      openTime: c.time, openIndex: i, frac: 1.0, scaled: false,
      realizedR: 0, mfeR: 0, maeR: 0, entryAdx: f.adx, entryRsi: f.rsi,
      entrySeq: sameDir.length + 1
    });
  }

  // mark any still-open trades to market at the last close
  const lastC = h1[h1.length - 1];
  for (const t of open) {
    t.realizedR += t.frac * (((lastC.close - t.entry) / (t.slPips * pip)) * t.dir);
    t.exit = 'FORCED_EOD'; t.forced = true;
    closed.push(t);
  }
  return closed;
}

// ═══════════════════════════════════════════════════════════════════════════
// METRICS
// ═══════════════════════════════════════════════════════════════════════════

function metrics(trades, spanDays) {
  const n = trades.length;
  if (n === 0) return { n: 0, winRate: 0, expectancy: 0, profitFactor: 0, sumR: 0, perWeek: 0, avgMfe: 0, avgMae: 0 };
  const rs = trades.map(t => t.realizedR);
  const wins = rs.filter(r => r > 0), losses = rs.filter(r => r <= 0);
  const sumR = rs.reduce((a, b) => a + b, 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    n,
    winRate: wins.length / n,
    expectancy: sumR / n,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    sumR,
    perWeek: spanDays > 0 ? n / (spanDays / 7) : 0,
    avgMfe: trades.reduce((a, t) => a + t.mfeR, 0) / n,
    avgMae: trades.reduce((a, t) => a + t.maeR, 0) / n
  };
}

function bySleeve(trades, spanDays) {
  const out = {};
  for (const sleeve of ['TREND', 'RANGE']) {
    out[sleeve] = metrics(trades.filter(t => t.mode === sleeve), spanDays);
  }
  return out;
}

const pf = (x) => (x === Infinity ? '∞' : x.toFixed(2));

// ═══════════════════════════════════════════════════════════════════════════
// SWEEP
// ═══════════════════════════════════════════════════════════════════════════

function runSweep(instrument, data) {
  const spec = SPECS[instrument];
  const { h1, h4 } = data;
  const spanDays = (new Date(h1[h1.length - 1].time) - new Date(h1[0].time)) / 86400000;

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`  ${spec.name} (${instrument}) — ${h1.length} H1 candles, ${spanDays.toFixed(0)} days`);
  console.log(`  ${h1[0].time.slice(0, 10)} → ${h1[h1.length - 1].time.slice(0, 10)} | modelled spread ${spec.spreadPips} pips`);
  console.log('═'.repeat(78));

  process.stdout.write('Precomputing features… ');
  const { feats, startIdx } = precomputeFeatures(h1, h4, spec);
  console.log('done.');

  // ── ADX-bucket diagnostic: where does each sleeve's edge actually live? ──
  // Run the current gold baseline once, then bucket its trades by entry ADX so
  // we can SEE the natural trend/range boundary for this market before trusting
  // any single sweep winner.
  const baseTrades = simulate(h1, feats, startIdx, STRAT, spec);
  console.log(`\nBaseline (gold config: ADX ${STRAT.ADX_TREND_MIN}/${STRAT.ADX_RANGE_MAX}, RSI ${STRAT.RSI_HARD_BLOCK_HI}/${STRAT.RSI_HARD_BLOCK_LO}):`);
  printResult(metrics(baseTrades, spanDays), bySleeve(baseTrades, spanDays));

  console.log('\nEntry-ADX buckets (baseline trades) — expectancy R by ADX at entry:');
  const buckets = [[0, 15], [15, 18], [18, 20], [20, 22], [22, 25], [25, 30], [30, 100]];
  console.log('  ADX range   n    win%   expR   sleeve mix');
  for (const [lo, hi] of buckets) {
    const b = baseTrades.filter(t => t.entryAdx >= lo && t.entryAdx < hi);
    if (b.length === 0) { console.log(`  ${String(lo).padStart(2)}–${String(hi).padStart(3)}     0`); continue; }
    const m = metrics(b, spanDays);
    const tr = b.filter(t => t.mode === 'TREND').length, rg = b.length - tr;
    console.log(`  ${String(lo).padStart(2)}–${String(hi).padStart(3)}   ${String(b.length).padStart(3)}  ${(m.winRate * 100).toFixed(0).padStart(4)}%  ${m.expectancy.toFixed(3).padStart(6)}   T:${tr} R:${rg}`);
  }

  // ── the sweep ──
  const trendMins = [16, 18, 20, 22, 24];
  const rangeMaxs = [12, 14, 16, 18];
  const rsiBlocks = [[78, 22], [82, 18], [85, 15]];   // [hi, lo] — how extreme before we veto with-trend entries
  const MIN_TRADES = 20;

  const results = [];
  for (const tmin of trendMins) {
    for (const rmax of rangeMaxs) {
      if (tmin - rmax < 3) continue;   // preserve a hysteresis gap
      for (const [rhi, rlo] of rsiBlocks) {
        const P = { ...STRAT, ADX_TREND_MIN: tmin, ADX_RANGE_MAX: rmax, RSI_HARD_BLOCK_HI: rhi, RSI_HARD_BLOCK_LO: rlo };
        const trades = simulate(h1, feats, startIdx, P, spec);
        const m = metrics(trades, spanDays);
        results.push({ tmin, rmax, rhi, rlo, m, sleeves: bySleeve(trades, spanDays) });
      }
    }
  }

  const ranked = results
    .filter(r => r.m.n >= MIN_TRADES)
    .sort((a, b) => b.m.expectancy - a.m.expectancy);

  console.log(`\nSweep — ${results.length} configs, showing those with ≥${MIN_TRADES} trades, best expectancy first:`);
  console.log('  ADXtrend ADXrange  RSIblk   n   /wk  win%   expR    PF    sumR   TRENDexp RANGEexp');
  for (const r of ranked.slice(0, 15)) {
    const t = r.sleeves.TREND, g = r.sleeves.RANGE;
    console.log(
      `   ${String(r.tmin).padStart(3)}      ${String(r.rmax).padStart(3)}    ${String(r.rhi)}/${String(r.rlo).padEnd(2)}  ` +
      `${String(r.m.n).padStart(3)} ${r.m.perWeek.toFixed(1).padStart(4)} ${(r.m.winRate * 100).toFixed(0).padStart(4)}% ` +
      `${r.m.expectancy.toFixed(3).padStart(6)} ${pf(r.m.profitFactor).padStart(5)} ${r.m.sumR.toFixed(1).padStart(6)}  ` +
      `${t.n ? t.expectancy.toFixed(3) : '  –  '}(${t.n})  ${g.n ? g.expectancy.toFixed(3) : '  –  '}(${g.n})`
    );
  }
  if (ranked.length === 0) console.log('  (no config reached the minimum trade count — widen the grid or fetch more history)');

  console.log('\nHow to read this:');
  console.log('  • expR = expectancy = average R per trade. Positive = edge. This is the number to maximise.');
  console.log('  • PF = profit factor (gross win R / gross loss R). >1 profitable, >1.3 healthy.');
  console.log('  • TRENDexp / RANGEexp isolate each sleeve — a config can only be trusted if the sleeve it leans on is the one with edge.');
  console.log('  • Cross-check the winner against the ADX buckets above: the chosen ADX_TREND_MIN should sit where trend-following starts to pay.');
}

function printResult(m, sleeves) {
  console.log(`  n=${m.n}  win=${(m.winRate * 100).toFixed(0)}%  expectancy=${m.expectancy.toFixed(3)}R  PF=${pf(m.profitFactor)}  sumR=${m.sumR.toFixed(1)}  (${m.perWeek.toFixed(1)}/wk)  avgMFE=${m.avgMfe.toFixed(2)}R avgMAE=${m.avgMae.toFixed(2)}R`);
  console.log(`     TREND: n=${sleeves.TREND.n} exp=${sleeves.TREND.expectancy.toFixed(3)}R PF=${pf(sleeves.TREND.profitFactor)}   RANGE: n=${sleeves.RANGE.n} exp=${sleeves.RANGE.expectancy.toFixed(3)}R PF=${pf(sleeves.RANGE.profitFactor)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SELF-TEST — no network. Synthesise trend + range legs and assert both sleeves
// fire and metrics compute. Proves the harness end-to-end before trusting data.
// ═══════════════════════════════════════════════════════════════════════════

// deterministic PRNG so the self-test is reproducible
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let x = Math.imul(seed ^ seed >>> 15, 1 | seed);
    x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x;
    return ((x ^ x >>> 14) >>> 0) / 4294967296;
  };
}

function synth() {
  // Build H1 candles: a strong uptrend leg (fires the TREND sleeve), then a
  // mean-reverting random walk (choppy → low ADX with occasional RSI stretches,
  // which is what actually fires the RANGE sleeve — a smooth sine cannot, because
  // any swing slow enough to stretch RSI also reads as trending).
  const rnd = mulberry32(7);
  const h1 = [];
  let price = 2000, t = new Date('2026-01-01T00:00:00Z').getTime();
  const push = (p, nextP) => {
    const wig = rnd() * 2 + 1;
    h1.push({ time: new Date(t).toISOString(), open: p, high: Math.max(p, nextP) + wig, low: Math.min(p, nextP) - wig, close: nextP });
    t += 3600000;
  };
  // trend leg: +0.9/bar drift + noise
  for (let i = 0; i < 600; i++) { const nx = price + 0.9 + (Math.sin(i * 1.7) * 1.2); push(price, nx); price = nx; }
  // range leg: Ornstein-Uhlenbeck-style mean reversion (theta 0.08, sigma 7)
  const mean = price;
  for (let i = 0; i < 700; i++) { const nx = price + 0.08 * (mean - price) + (rnd() - 0.5) * 2 * 7; push(price, nx); price = nx; }
  // aggregate H1 → H4
  const h4 = [];
  for (let i = 0; i + 4 <= h1.length; i += 4) {
    const grp = h1.slice(i, i + 4);
    h4.push({
      time: grp[3].time, open: grp[0].open,
      high: Math.max(...grp.map(c => c.high)), low: Math.min(...grp.map(c => c.low)),
      close: grp[3].close
    });
  }
  return { h1, h4 };
}

function selftest() {
  console.log('SELF-TEST (synthetic, no network)');
  const spec = SPECS.XAU_USD;
  const { h1, h4 } = synth();
  const { feats, startIdx } = precomputeFeatures(h1, h4, spec);
  const trades = simulate(h1, feats, startIdx, STRAT, spec);
  const spanDays = (new Date(h1[h1.length - 1].time) - new Date(h1[0].time)) / 86400000;
  const m = metrics(trades, spanDays);
  const sleeves = bySleeve(trades, spanDays);

  const checks = [];
  checks.push(['features computed', feats.filter(Boolean).length > 500]);
  checks.push(['some trades taken', trades.length > 0]);
  checks.push(['TREND sleeve fired', sleeves.TREND.n > 0]);
  checks.push(['RANGE sleeve fired', sleeves.RANGE.n > 0]);
  checks.push(['no NaN in expectancy', Number.isFinite(m.expectancy)]);
  checks.push(['every trade has a defined exit', trades.every(t => !!t.exit)]);
  checks.push(['R accounting bounded (no trade < -1.2R)', trades.every(t => t.realizedR >= -1.2001)]);

  console.log(`  trades=${trades.length}  TREND=${sleeves.TREND.n}  RANGE=${sleeves.RANGE.n}  expectancy=${m.expectancy.toFixed(3)}R  PF=${pf(m.profitFactor)}`);
  console.log('  exit-reason mix:', trades.reduce((a, t) => { a[t.exit] = (a[t.exit] || 0) + 1; return a; }, {}));
  let ok = true;
  for (const [label, pass] of checks) { console.log(`  ${pass ? '✓' : '✗'} ${label}`); if (!pass) ok = false; }
  console.log(ok ? '\nSELF-TEST PASSED' : '\nSELF-TEST FAILED');
  process.exit(ok ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args[0] || '').toLowerCase();

  if (cmd === 'selftest') return selftest();

  if (cmd === 'fetch') {
    const inst = args[1];
    if (!SPECS[inst]) { console.error(`Usage: node backtest.js fetch <${Object.keys(SPECS).join('|')}>`); process.exit(1); }
    await fetchAndCache(inst);
    return;
  }

  // `run <inst>` or bare `<inst>` (fetch-if-missing then run)
  const inst = cmd === 'run' ? args[1] : args[0];
  if (!SPECS[inst]) {
    console.error('Usage:');
    console.error('  node backtest.js selftest');
    console.error(`  node backtest.js fetch <${Object.keys(SPECS).join('|')}>`);
    console.error(`  node backtest.js run   <${Object.keys(SPECS).join('|')}>`);
    console.error(`  node backtest.js <${Object.keys(SPECS).join('|')}>   (fetch-if-missing then run)`);
    process.exit(1);
  }

  let data = loadCached(inst);
  if (!data) {
    if (cmd === 'run') { console.error(`No cached data for ${inst}. Run: node backtest.js fetch ${inst}`); process.exit(1); }
    data = await fetchAndCache(inst);
  }
  runSweep(inst, data);
}

// ═══════════════════════════════════════════════════════════════════════════
// PROGRAMMATIC ENTRY — used by index.js "backtest mode" (RUN_BACKTEST env var)
// so the results can be run on Railway and emailed, no terminal needed.
// Captures everything runSweep prints and returns it as one text blob.
// ═══════════════════════════════════════════════════════════════════════════

async function runForEmail(instruments) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  try {
    for (const inst of instruments) {
      if (!SPECS[inst]) { console.log(`Skipping unknown instrument: ${inst}`); continue; }
      let data = loadCached(inst);
      if (!data) data = await fetchAndCache(inst);
      runSweep(inst, data);
    }
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

module.exports = { runForEmail, runSweep, simulate, precomputeFeatures, SPECS, STRAT };

// Only run the CLI when invoked directly (node backtest.js …), NOT when required.
if (require.main === module) {
  main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
