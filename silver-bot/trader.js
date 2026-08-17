'use strict';

/**
 * trader.js — Gold Demo engine (dual-mode, regime-aware)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A deliberately DIFFERENT strategy from the live gold bot, running on a demo
 * account so we can measure edge safely. Design goals:
 *
 *   1. Trade often enough to build a real sample (target ~4–8 trades/week),
 *      not once a week waiting for a "perfect" setup that never is.
 *   2. Match the tactic to the market REGIME instead of running one strategy
 *      and sitting out whenever gold isn't trending.
 *   3. Let a favourable reward:risk do the work — we do not need to be right
 *      more than ~35% of the time.
 *   4. Tag every trade (mode / grade / R) so the nightly report tells us which
 *      sleeve actually has edge.
 *
 * Two sleeves, chosen by ADX(14) on H1:
 *   • TREND  (ADX > 18): H4-EMA50 bias → pullback to H1-EMA20 OR fresh breakout,
 *                        confirmed by one MACD check. SL 1.5×ATR, target 3R.
 *   • RANGE  (ADX < 14): fade the edges of the recent H1 range when RSI is
 *                        stretched and the candle rejects. SL beyond the edge,
 *                        target the midline (~2R).
 *   • In between: hold the previous regime (hysteresis — no whipsawing).
 *
 * Position management (both sleeves): scale 50% off at the scale-out R, move the
 * stop to breakeven, then trail the remainder. Final close is left to OANDA's
 * SL/TP and booked by checkClosedTrades().
 *
 * All money maths and the instrument come from config.js — nothing here is
 * silver- or gold-specific by hardcode.
 */

const axios = require('axios');
const {
  BASE, TOKEN, ACCOUNT, isLive,
  INSTRUMENT, PIP_SIZE, PIP_VALUE_PER_LOT, MAX_LOT, INSTRUMENT_LABEL, INSTRUMENT_NAME, BOT_NAME,
  ENTRY_TF, BIAS_TF, ENTRY_TF_MIN
} = require('./config');
const { getCandles, getCandles15m, getCandles4h, getAccountInfo, getOpenPositions, getCurrentPrice } = require('./market');
const { writeLog } = require('./log');
const { recordTradeOpen, recordTradeClose, recordExcursion, recordExternalTradeClose, removeOpenRecord, markPendingExit, readPerformance } = require('./performance');
const { sendAlert } = require('./alerts');
const { getLiveRiskAssessment, isTradingHalted } = require('./live-risk-manager');
const { calculateEMA, calculateRSI, calculateMACD } = require('./indicators');

const headers = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const http = axios.create({ headers, timeout: 30000 });

// Price rounding precision derived from pip size (gold → 2 dp, US30 → 1 dp, silver → 3 dp)
const PRICE_DECIMALS = PIP_SIZE >= 1 ? 1 : PIP_SIZE >= 0.1 ? 2 : 3;
const px = (n) => parseFloat(Number(n).toFixed(PRICE_DECIMALS));

// ─── STRATEGY CONSTANTS (gold H1) ─────────────────────────────────────────────

const MAX_CONCURRENT_TRADES = 2;   // gold-model value (replicating the live gold bot exactly on US30)

// Regime thresholds (ADX-14 on entry TF) with a hysteresis gap so we don't
// flip-flop. GOLD-MODEL VALUES (22/18) — this bot now replicates the live gold
// strategy exactly on US30, so its edge is comparable like-for-like.
const ADX_TREND_MIN = 22;
const ADX_RANGE_MAX = 18;
const RANGE_ADX_FLOOR = 15;   // dead-market floor: below this the market is flatlined — a fade has no wobble to bounce off, so stand aside (both US30 time-stop losses were sub-15; the winner had ADX ~19)

// ER constants retained for the calcER helper (exported for tests) but the regime
// gate itself is DISABLED to match the gold model, which is ADX-only (the ER
// trend-quality gate was a silver-only addition; gold reverted it — commit d48e000).
const ER_LOOKBACK  = 20;
const ER_TREND_MIN = 0.30;

// Stops / targets. SL is ATR-based, so it auto-scales when the timeframe changes.
// A spread floor keeps the stop sensible relative to silver's wide spread on fast
// timeframes (spread must be a small fraction of the risk, or it eats the edge).
const ATR_SL_MULT_TREND = 1.0;
const ATR_SL_MULT_RANGE = 1.0;
const MIN_SL_PIPS       = 40;    // absolute floor (any TF)
const MAX_SL_PIPS       = 300;   // absolute cap (won't bind on fast TFs)
const MIN_SL_SPREAD_MULT = 5;    // SL must be >= 5× the current spread → spread ≤20% of risk (protects fast-TF silver)
const TREND_TP_R        = 3.0;   // final take-profit = 3× risk
const RANGE_TP_R        = 2.0;

// Position management. Distances are expressed as FRACTIONS OF THE STOP (which is
// ATR-based), so they scale with the timeframe automatically — no per-TF tuning.
const SCALEOUT_R_TREND  = 1.0;   // bank half + move to breakeven + start trailing at 1.0R
const SCALEOUT_R_RANGE  = 1.0;
const TRAIL_SL_FRAC     = 0.32;  // runner trails this fraction of the stop distance behind price (~80p on a 250p H1 stop)
const BE_BUFFER_FRAC    = 0.06;  // breakeven lock = this fraction of the stop beyond entry (~15p on a 250p stop)
const MAX_TRADE_HOURS   = 6;     // wall-clock time stop — cut a trade that never reached breakeven, to free the book

// TREND sleeve tuning — deliberately loose (one confirmation, not seven gates).
// Distances are ATR multiples so they scale with the timeframe automatically.
const BIAS_NEUTRAL_ATR     = 0.15;  // dead band around the bias EMA, as a multiple of entry-TF ATR
const PULLBACK_ZONE_ATR    = 0.65;  // how far from the entry EMA20 still counts as a pullback (× ATR)
const BREAKOUT_MAX_CANDLES = 3;     // "fresh" breakout = ≤3 entry-TF closes beyond EMA20
const RSI_HARD_BLOCK_HI    = 78;    // gold-model value — block BUY only when truly overbought
const RSI_HARD_BLOCK_LO    = 22;    // gold-model value — block SELL only when truly oversold

// RANGE sleeve tuning
const RANGE_LOOKBACK   = 20;   // H1 candles defining the range
const RANGE_EDGE_PCT   = 0.30; // price must be in top/bottom 30% of the range
const RANGE_MIN_ATR    = 2.0;  // range must be at least this many ATRs wide to bother
const RANGE_RSI_HI     = 60;
const RANGE_RSI_LO     = 40;

let consecutiveCycleErrors = 0;
let lastRegime = 'RANGE';   // hysteresis memory

// ─── INDICATOR HELPERS (ATR / ADX — not in indicators.js) ─────────────────────

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;   // Wilder smoothing
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return 0;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low;
    const pc = candles[i - 1].close, ph = candles[i - 1].high, pl = candles[i - 1].low;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, down = pl - l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const wilder = (arr) => {
    const out = [];
    let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
    out[period - 1] = sum;
    for (let i = period; i < arr.length; i++) { sum = sum - sum / period + arr[i]; out[i] = sum; }
    return out;
  };
  const trS = wilder(tr), pdmS = wilder(plusDM), mdmS = wilder(minusDM);
  const dx = [];
  for (let i = period - 1; i < tr.length; i++) {
    if (!trS[i]) continue;
    const pdi = 100 * pdmS[i] / trS[i];
    const mdi = 100 * mdmS[i] / trS[i];
    const denom = pdi + mdi;
    dx.push(denom === 0 ? 0 : 100 * Math.abs(pdi - mdi) / denom);
  }
  if (dx.length < period) return dx.length ? dx[dx.length - 1] : 0;
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  return adx;
}

// Kaufman efficiency ratio over H1 closes: |net move| ÷ total path length.
// ~1 = a clean one-way trend; ~0 = lots of movement but no net progress (chop).
function calcER(candles, period = ER_LOOKBACK) {
  if (candles.length < period + 1) return 0;
  const c = candles.map(x => x.close);
  const n = c.length;
  const net = Math.abs(c[n - 1] - c[n - 1 - period]);
  let path = 0;
  for (let i = n - period; i < n; i++) path += Math.abs(c[i] - c[i - 1]);
  return path === 0 ? 0 : net / path;
}

// ─── REGIME DETECTION ─────────────────────────────────────────────────────────

function detectRegime(candles1h) {
  // ADX-only, matching the gold model exactly (no ER trend-quality gate).
  const adx = calcADX(candles1h, 14);
  let regime;
  if (adx >= ADX_TREND_MIN)      regime = 'TREND';
  else if (adx <= ADX_RANGE_MAX) regime = 'RANGE';
  else                           regime = lastRegime;   // in-between: carry previous (hysteresis)
  lastRegime = regime;
  return { regime, adx };
}

// ─── ENTRY: TREND SLEEVE ──────────────────────────────────────────────────────

function evaluateTrend(candles1h, candles4h, currentPrice, adx) {
  const closes4h = candles4h.map(c => c.close);
  const closes1h = candles1h.map(c => c.close);
  const price    = currentPrice.mid;

  if (closes4h.length < 50) return hold('Insufficient bias-TF data');

  const atr        = calcATR(candles1h, 14);
  const atrPips    = atr / PIP_SIZE;
  const spreadPips = (currentPrice.ask - currentPrice.bid) / PIP_SIZE;

  // Higher-timeframe trend bias with an ATR-scaled dead band
  const h4Ema50 = calculateEMA(closes4h, 50);
  const bullish = price > h4Ema50 + BIAS_NEUTRAL_ATR * atr;
  const bearish = price < h4Ema50 - BIAS_NEUTRAL_ATR * atr;
  if (!bullish && !bearish) return hold(`Price in ${BIAS_TF} EMA50 neutral band (${h4Ema50.toFixed(2)})`);
  const bias = bullish ? 'BUY' : 'SELL';

  const h1Ema20 = calculateEMA(closes1h, 20);
  const macd    = calculateMACD(closes1h);
  const rsi     = calculateRSI(closes1h, 14);

  // Two ways momentum can confirm the trade:
  //   favours  = histogram already on the trade's side (good for breakouts)
  //   turning  = histogram moving back toward the trade's side (good for pullbacks —
  //              a pullback has counter-momentum by definition, so we want it WANING)
  const macdFavours = bias === 'BUY' ? macd.histogram > 0 : macd.histogram < 0;
  const macdTurning = bias === 'BUY'
    ? macd.histogram > macd.prevHistogram
    : macd.histogram < macd.prevHistogram;

  // Entry mode: pullback to EMA20, or a fresh breakout beyond it
  const distPips = Math.abs(price - h1Ema20) / PIP_SIZE;
  const onTrendSide = bias === 'BUY' ? price >= h1Ema20 : price <= h1Ema20;

  let entryMode, grade;
  if (distPips <= PULLBACK_ZONE_ATR * atrPips) {
    entryMode = 'PULLBACK';
    // Pullback: momentum must be re-aligning with the trend (turning), not already extended.
    if (!macdTurning) return hold(`${bias} pullback but MACD not turning back yet (hist ${macd.histogram.toFixed(2)} vs prev ${macd.prevHistogram.toFixed(2)})`);
    grade = macdFavours ? 'A' : 'B';   // A if momentum has already flipped to the trend side
  } else if (onTrendSide) {
    // Count consecutive H1 closes beyond EMA20 — "freshness" of the breakout.
    let beyond = 0;
    for (let i = closes1h.length - 1; i >= 0; i--) {
      const isBeyond = bias === 'BUY' ? closes1h[i] > h1Ema20 : closes1h[i] < h1Ema20;
      if (isBeyond) beyond++; else break;
    }
    // Gold model: fresh breakout only (no continuation/chase). Stale → hold.
    if (beyond > BREAKOUT_MAX_CANDLES) return hold(`${bias} breakout stale (${beyond} candles beyond EMA20)`);
    if (!macdFavours) return hold(`${bias} breakout but MACD histogram ${macd.histogram.toFixed(2)} against it`);
    entryMode = 'BREAKOUT';
    grade = macdTurning ? 'A' : 'B';   // A if still strengthening
  } else {
    return hold(`${bias} bias but price ${distPips.toFixed(0)} pips on wrong side of H1 EMA20`);
  }

  // Only hard-block on a genuine exhaustion reading
  if (bias === 'BUY'  && rsi > RSI_HARD_BLOCK_HI) return hold(`BUY blocked — RSI ${rsi.toFixed(0)} overbought`);
  if (bias === 'SELL' && rsi < RSI_HARD_BLOCK_LO) return hold(`SELL blocked — RSI ${rsi.toFixed(0)} oversold`);

  const slPips = clampSlWithSpread(Math.round(atrPips * ATR_SL_MULT_TREND), spreadPips);
  return buildEntry('TREND', bias, entryMode, grade, currentPrice, slPips, TREND_TP_R, adx,
    `${BIAS_TF} ${bias} bias, ${entryMode.toLowerCase()} at ${ENTRY_TF} EMA20 (${h1Ema20.toFixed(2)}), MACD ${macd.histogram.toFixed(3)} (grade ${grade}), RSI ${rsi.toFixed(0)}, SL ${slPips}p (ATR-based)`,
    { rsi, macdHist: macd.histogram, atrPips, distEma20Pips: (price - h1Ema20) / PIP_SIZE });
}

// ─── ENTRY: RANGE SLEEVE ──────────────────────────────────────────────────────

function evaluateRange(candles1h, currentPrice, adx) {
  // Dead-market floor — don't fade a flatlined market (no oscillation = no bounce =
  // the trade just sits until the time-stop). Targets the US30 time-stop losses.
  if (adx < RANGE_ADX_FLOOR) return hold(`Range too dead to fade (ADX ${adx.toFixed(1)} < ${RANGE_ADX_FLOOR})`);

  const recent = candles1h.slice(-RANGE_LOOKBACK);
  if (recent.length < RANGE_LOOKBACK) return hold('Insufficient entry-TF data for range');

  const rangeHigh = Math.max(...recent.map(c => c.high));
  const rangeLow  = Math.min(...recent.map(c => c.low));
  const width     = rangeHigh - rangeLow;
  const atr       = calcATR(candles1h, 14);
  if (atr <= 0 || width < RANGE_MIN_ATR * atr) return hold('Range too tight to fade');

  const price      = currentPrice.mid;
  const spreadPips = (currentPrice.ask - currentPrice.bid) / PIP_SIZE;
  const posInRange = (price - rangeLow) / width;   // 0 = bottom, 1 = top
  const rsi        = calculateRSI(candles1h.map(c => c.close), 14);
  const last       = candles1h[candles1h.length - 2] || candles1h[candles1h.length - 1]; // last completed

  // Fade the top: near range high, RSI stretched up, candle rejecting (bearish)
  if (posInRange >= 1 - RANGE_EDGE_PCT && rsi >= RANGE_RSI_HI) {
    const rejecting = last.close < last.open || (last.high - Math.max(last.open, last.close)) > (last.high - last.low) * 0.4;
    if (rejecting) {
      const slPips = clampSlWithSpread(Math.round(((rangeHigh - price) / PIP_SIZE) + (atr / PIP_SIZE) * ATR_SL_MULT_RANGE), spreadPips);
      const grade  = rsi >= 68 ? 'A' : 'B';
      return buildEntry('RANGE', 'SELL', 'RANGE_FADE', grade, currentPrice, slPips, RANGE_TP_R, adx,
        `Fade top of range [${rangeLow.toFixed(2)}–${rangeHigh.toFixed(2)}], pos ${(posInRange*100).toFixed(0)}%, RSI ${rsi.toFixed(0)} (grade ${grade}), SL ${slPips}p`,
        { rsi, atrPips: atr / PIP_SIZE, posInRangePct: posInRange * 100 });
    }
  }
  // Fade the bottom
  if (posInRange <= RANGE_EDGE_PCT && rsi <= RANGE_RSI_LO) {
    const rejecting = last.close > last.open || (Math.min(last.open, last.close) - last.low) > (last.high - last.low) * 0.4;
    if (rejecting) {
      const slPips = clampSlWithSpread(Math.round(((price - rangeLow) / PIP_SIZE) + (atr / PIP_SIZE) * ATR_SL_MULT_RANGE), spreadPips);
      const grade  = rsi <= 32 ? 'A' : 'B';
      return buildEntry('RANGE', 'BUY', 'RANGE_FADE', grade, currentPrice, slPips, RANGE_TP_R, adx,
        `Fade bottom of range [${rangeLow.toFixed(2)}–${rangeHigh.toFixed(2)}], pos ${(posInRange*100).toFixed(0)}%, RSI ${rsi.toFixed(0)} (grade ${grade}), SL ${slPips}p`,
        { rsi, atrPips: atr / PIP_SIZE, posInRangePct: posInRange * 100 });
    }
  }
  return hold(`Range mode, price mid-range (${(posInRange*100).toFixed(0)}%) or RSI ${rsi.toFixed(0)} not stretched`);
}

// ─── ENTRY BUILDERS ───────────────────────────────────────────────────────────

function hold(reason) { return { shouldEnter: false, reasoning: reason }; }
function clampSl(p)   { return Math.max(MIN_SL_PIPS, Math.min(MAX_SL_PIPS, p)); }
// Stop must be at least MIN_SL_SPREAD_MULT× the spread, so on a fast timeframe the
// wide silver spread can't become a huge fraction of the risk. Then clamped.
function clampSlWithSpread(atrBasedPips, spreadPips) {
  const floor = Math.ceil((spreadPips || 0) * MIN_SL_SPREAD_MULT);
  return clampSl(Math.max(atrBasedPips, floor));
}

function buildEntry(mode, action, entryMethod, grade, currentPrice, slPips, tpR, adx, reasoning, context = {}) {
  const entry = action === 'BUY' ? currentPrice.ask : currentPrice.bid;
  const stopLoss = action === 'BUY'
    ? px(entry - slPips * PIP_SIZE)
    : px(entry + slPips * PIP_SIZE);
  const takeProfit = action === 'BUY'
    ? px(entry + slPips * tpR * PIP_SIZE)
    : px(entry - slPips * tpR * PIP_SIZE);
  return {
    shouldEnter: true,
    mode, action, entryMethod, grade, slPips, adx, tpR,
    entryPrice: px(entry), stopLoss, takeProfit, reasoning,
    // Indicator snapshot at entry — captured so indicator-conditioned questions
    // ("do high-RSI entries do worse?") are answerable later with no code change.
    context: {
      rsi:            context.rsi ?? null,
      macdHist:       context.macdHist ?? null,
      atrPips:        context.atrPips ?? null,
      distEma20Pips:  context.distEma20Pips ?? null,
      posInRangePct:  context.posInRangePct ?? null,
      spreadPips:     Math.round(((currentPrice.ask - currentPrice.bid) / PIP_SIZE) * 10) / 10
    }
  };
}

// ─── MAIN CYCLE ───────────────────────────────────────────────────────────────

async function runTradingCycle() {
  console.log(`\n[${new Date().toISOString()}] ${BOT_NAME} — trading cycle (${INSTRUMENT_LABEL})`);

  const halt = isTradingHalted();
  if (halt.halted) { console.log(`HALTED — ${halt.reason}`); return; }

  try {
    await checkClosedTrades();

    const [candles1h, candles4h, accountInfo, openPositions, currentPrice] = await Promise.all([
      getCandles(INSTRUMENT, ENTRY_TF, 250),   // entry/regime timeframe (default M15)
      getCandles(INSTRUMENT, BIAS_TF, 120),    // higher-timeframe bias (default H1)
      getAccountInfo(),
      getOpenPositions(),
      getCurrentPrice(INSTRUMENT)
    ]);

    // Manage any open trades first (scale-out / breakeven / trail)
    for (const pos of openPositions) await manageOpenPosition(pos, currentPrice);

    if (openPositions.length >= MAX_CONCURRENT_TRADES) {
      console.log(`Max concurrent trades (${openPositions.length}/${MAX_CONCURRENT_TRADES}) — no new entry`);
      return;
    }

    // Equity guard — stand down if drawdown is biting
    const balance = parseFloat(accountInfo.balance || 0);
    const equity  = parseFloat(accountInfo.equity  || balance);
    if (balance > 0 && equity < balance * 0.85) {
      console.log(`EQUITY GUARD — equity ${equity.toFixed(2)} < 85% of balance ${balance.toFixed(2)}`);
      writeLog({ type: 'SAFETY_BLOCK', reason: 'Equity guard' });
      return;
    }

    // Pick the sleeve by regime, then evaluate it
    const { regime, adx } = detectRegime(candles1h);
    const signal = regime === 'TREND'
      ? evaluateTrend(candles1h, candles4h, currentPrice, adx)
      : evaluateRange(candles1h, currentPrice, adx);

    console.log(`Regime: ${regime} (ADX ${adx.toFixed(1)}) | ${signal.shouldEnter ? `${signal.action} ${signal.mode}/${signal.entryMethod} grade ${signal.grade}` : 'HOLD'} | ${signal.reasoning}`);

    if (!signal.shouldEnter) { writeLog({ type: 'HOLD', regime, adx: +adx.toFixed(1), reasoning: signal.reasoning }); return; }

    // Opposing-position guard (OANDA netting)
    const opposing = openPositions.find(p =>
      (p.type === 'BUY' && signal.action === 'SELL') || (p.type === 'SELL' && signal.action === 'BUY'));
    if (opposing) {
      console.log(`OPPOSING POSITION — cannot ${signal.action} while trade ${opposing.id} (${opposing.type}) open`);
      writeLog({ type: 'SAFETY_BLOCK', reason: 'Opposing position' });
      return;
    }

    // ── Pyramid guard — only add into a PROVEN move ───────────────────────────
    // A second (or third…) trade in the same direction is allowed ONLY once every
    // existing same-direction trade has scaled out to breakeven (proven + de-risked).
    // This permits genuine pyramiding into a trend but blocks stacking several
    // at-risk trades on one swing (the "4 longs within $12" cluster). Net effect:
    // at most ONE at-risk trade in a direction at a time; older ones ride risk-free.
    const sameDir = openPositions.filter(p => p.type === signal.action);
    const atRiskSameDir = sameDir.filter(p => !(p.stopLoss != null &&
      (p.type === 'BUY' ? p.stopLoss >= p.openPrice : p.stopLoss <= p.openPrice)));
    if (atRiskSameDir.length > 0) {
      console.log(`ADD BLOCKED — ${atRiskSameDir.length} ${signal.action} trade(s) not yet at breakeven; wait for the prior to prove itself before pyramiding`);
      writeLog({ type: 'SAFETY_BLOCK', reason: 'Add blocked — prior same-direction trade not yet at breakeven' });
      return;
    }
    // Tag this entry: 1 = initial, 2+ = a proven pyramid add
    signal.entrySeq         = sameDir.length + 1;
    signal.concurrentSameDir = sameDir.length;

    // Risk-managed lot size
    const risk = await getLiveRiskAssessment(balance, signal.slPips);
    if (!risk.approved) { console.log(`Risk block: ${risk.reason}`); writeLog({ type: 'RISK_BLOCK', reason: risk.reason }); return; }

    await executeTrade(signal, risk.lotSize);
    consecutiveCycleErrors = 0;

  } catch (err) {
    console.error('Cycle error:', err.message);
    writeLog({ type: 'CYCLE_ERROR', error: err.message });
    if (++consecutiveCycleErrors >= 3) {
      await sendAlert(`${BOT_NAME}: 3 consecutive cycle errors — ${err.message}`, { emoji: '🔧', subject: `🔧 ${BOT_NAME} — Repeated Errors` });
      consecutiveCycleErrors = 0;
    }
  }
}

// ─── ORDER EXECUTION ──────────────────────────────────────────────────────────

async function executeTrade(signal, lotSize) {
  // 2 dp so tiny sizes place correctly — US30 pins at 0.01 units, which .toFixed(1)
  // would have rounded to 0.0 (a no-fill or, worse, an ambiguous order).
  const rawUnits = parseFloat((lotSize * 100).toFixed(2));   // 1 lot = 100 units

  // ── HARD LOT BACKSTOP ──────────────────────────────────────────────────────
  // Absolute last line of defence against a huge lot by mistake: refuse to send
  // any order above 5× the configured cap, or a non-positive size. The risk
  // manager already clamps to MAX_LOT, but this catches anything that ever slips
  // past it (a bad calc, a config typo) BEFORE it hits the live account.
  const absMaxUnits = MAX_LOT * 100 * 5;
  if (!(rawUnits > 0) || rawUnits > absMaxUnits) {
    console.error(`SAFETY: refusing order — ${rawUnits} units (ceiling ${absMaxUnits}, lot ${lotSize}). Not placed.`);
    writeLog({ type: 'SAFETY_BLOCK', reason: `Lot backstop: ${rawUnits}u vs ${absMaxUnits}u ceiling` });
    return;
  }

  const units    = signal.action === 'BUY' ? rawUnits : -rawUnits;
  const riskGBP  = parseFloat((lotSize * signal.slPips * PIP_VALUE_PER_LOT).toFixed(2));

  const order = {
    order: {
      type: 'MARKET',
      instrument: INSTRUMENT,
      units: units.toString(),
      stopLossOnFill:   { price: signal.stopLoss.toFixed(PRICE_DECIMALS),   timeInForce: 'GTC' },
      takeProfitOnFill: { price: signal.takeProfit.toFixed(PRICE_DECIMALS), timeInForce: 'GTC' },
      timeInForce: 'FOK',
      positionFill: 'DEFAULT',
      tradeClientExtensions: { comment: `${signal.mode}:${signal.entryMethod}:${signal.grade}` }
    }
  };

  const res = await http.post(`${BASE}/v3/accounts/${ACCOUNT}/orders`, order);
  const fill    = res.data.orderFillTransaction;
  // ONLY a genuine fill (with an opened trade) counts. Do NOT fall back to
  // relatedTransactionIDs — on a cancelled/unfilled order that grabs the cancel
  // transaction id and records a phantom "open" trade that never existed.
  const tradeId = fill?.tradeOpened?.tradeID;

  if (!tradeId) {
    const cancel = res.data.orderCancelTransaction;
    const reason = cancel?.reason || res.data.orderRejectTransaction?.rejectReason || 'unfilled (no fill, no cancel reason)';
    console.warn(`Order NOT filled — reason: ${reason} | ${units} units ${INSTRUMENT} | ${JSON.stringify(res.data).slice(0, 400)}`);
    writeLog({ type: 'ORDER_CANCELLED', reason, units, action: signal.action, mode: signal.mode });
    return res.data;
  }

  const fillPx = fill.price ? parseFloat(fill.price) : signal.entryPrice;

  recordTradeOpen(tradeId, {
    action: signal.action,
    entry_method: `${signal.mode}_${signal.entryMethod}`,
    entry_price: fillPx,
    stop_loss: signal.stopLoss,
    take_profit: signal.takeProfit,
    lot_size: lotSize,
    mode: signal.mode,
    grade: signal.grade,
    sl_pips: signal.slPips,
    tp_r: signal.tpR,
    risk_gbp: riskGBP,
    regime_adx: parseFloat(signal.adx.toFixed(1)),
    entry_seq: signal.entrySeq || 1,
    concurrent_same_dir: signal.concurrentSameDir || 0,
    context: signal.context,
    reasoning: signal.reasoning
  }, fillPx);

  const label = isLive ? '🔴 LIVE' : '🟢 DEMO';
  // Entry-read line — the fingerprint we judge quality by. Method-specific: trend/
  // breakout entries report distance from the H1 EMA20 (extension); range fades
  // report how far into the range edge we faded. Breakouts at high RSI are a chase.
  const ctx = signal.context || {};
  const rsiStr = ctx.rsi != null ? ctx.rsi.toFixed(0) : '—';
  const locStr = ctx.distEma20Pips != null ? ` · ${ctx.distEma20Pips >= 0 ? '+' : ''}${ctx.distEma20Pips.toFixed(0)}p vs EMA20`
               : ctx.posInRangePct != null ? ` · ${ctx.posInRangePct.toFixed(0)}% in range` : '';
  const macdStr = ctx.macdHist != null ? ` · MACD ${ctx.macdHist.toFixed(2)}` : '';
  const stretched = (signal.entryMethod === 'BREAKOUT' && ctx.rsi != null && ctx.rsi >= 70) ? ' ⚠️ stretched breakout (elevated RSI)' : '';
  await sendAlert(
    `${label} ${INSTRUMENT_NAME} ${signal.action} | ${signal.mode}/${signal.entryMethod} (grade ${signal.grade}) | Entry ${fillPx} | SL ${signal.stopLoss} | TP ${signal.takeProfit} | ${signal.slPips}p risk | ${lotSize} lot (£${riskGBP} risk)` +
    `<br>Entry read: ADX ${signal.adx.toFixed(1)} · RSI ${rsiStr}${locStr}${macdStr}${stretched}`,
    { emoji: '📈', subject: `📈 ${BOT_NAME} — ${signal.action} ${signal.mode}` }
  );
  console.log(`Trade ${tradeId} opened: ${signal.action} ${signal.mode} @ ${fillPx}`);
  return res.data;
}

// ─── POSITION MANAGEMENT — scale-out, breakeven, trail ────────────────────────
//
// Stateless: uses the current SL position to decide whether we've already scaled.
// SL still on the risk side of entry  → not yet scaled → look to scale at target R.
// SL at/beyond breakeven              → already scaled  → trail the runner.

async function manageOpenPosition(pos, currentPrice) {
  try {
    const rec    = readPerformance().trades.find(t => t.tradeId === pos.id.toString() && !t.closeTime);
    const slPips = rec?.slPips || MIN_SL_PIPS;
    const mode   = rec?.mode || 'TREND';
    const scaleR = mode === 'RANGE' ? SCALEOUT_R_RANGE : SCALEOUT_R_TREND;
    // Management distances scale with THIS trade's (ATR-based) stop, so they're
    // right on any timeframe with no per-TF tuning.
    const beBufferPips = Math.max(1, Math.round(BE_BUFFER_FRAC * slPips));
    const trailPips    = Math.max(1, Math.round(TRAIL_SL_FRAC * slPips));

    const mid = currentPrice.mid;
    const pipsProfit = pos.type === 'BUY'
      ? (mid - pos.openPrice) / PIP_SIZE
      : (pos.openPrice - mid) / PIP_SIZE;
    const rNow = pipsProfit / slPips;

    // Record peak favourable / worst adverse excursion for trade-quality analysis
    recordExcursion(pos.id, rNow);

    const atBreakeven = pos.stopLoss != null && (
      pos.type === 'BUY' ? pos.stopLoss >= pos.openPrice : pos.stopLoss <= pos.openPrice);

    // ── Time stop: cut a trade that never proved itself ──
    // If it hasn't scaled out to breakeven within MAX_TRADE_HOURS, close it fully.
    // Stops one stuck trade from camping the book all day (blocking the opposite
    // side via the opposing guard and the same side via the pyramid guard).
    if (!atBreakeven && rec?.openTime) {
      const ageHours = (Date.now() - new Date(rec.openTime).getTime()) / 3600000;
      if (ageHours >= MAX_TRADE_HOURS) {
        await http.put(`${BASE}/v3/accounts/${ACCOUNT}/trades/${pos.id}/close`, {});
        markPendingExit(pos.id, 'TIME_STOP');   // so checkClosedTrades books the true reason, not an inferred one
        console.log(`Trade ${pos.id} — TIME STOP after ${ageHours.toFixed(1)}h (never reached breakeven) — closed to free the book`);
        writeLog({ type: 'TIME_STOP', tradeId: pos.id, ageHours: +ageHours.toFixed(1), rAtStop: +rNow.toFixed(2) });
        return;
      }
    }

    // ── Phase 1: scale out + move to breakeven ──
    if (!atBreakeven && rNow >= scaleR) {
      if (pos.units >= 2) {
        const half = Math.floor(pos.units / 2);
        await http.put(`${BASE}/v3/accounts/${ACCOUNT}/trades/${pos.id}/close`, { units: half.toString() });
        console.log(`Trade ${pos.id} — scaled out ${half} units at ${rNow.toFixed(2)}R`);
      }
      const bePrice = pos.type === 'BUY'
        ? px(pos.openPrice + beBufferPips * PIP_SIZE)
        : px(pos.openPrice - beBufferPips * PIP_SIZE);
      await moveStop(pos.id, bePrice);
      writeLog({ type: 'SCALE_OUT', tradeId: pos.id, rAtScale: +rNow.toFixed(2), breakeven: bePrice });
      return;
    }

    // ── Phase 2: trail the runner ──
    // Begins the moment a trade has scaled out (atBreakeven implies we scaled at
    // scaleR), so there's no dead zone where a deeply-in-profit trade sits at
    // breakeven. The `improves` check ratchets the stop up only — it can never
    // move the SL below the breakeven lock, even if TRAIL_PIPS exceeds the profit.
    if (atBreakeven) {
      const trailPrice = pos.type === 'BUY'
        ? px(mid - trailPips * PIP_SIZE)
        : px(mid + trailPips * PIP_SIZE);
      const improves = pos.type === 'BUY' ? trailPrice > pos.stopLoss : trailPrice < pos.stopLoss;
      if (improves) {
        await moveStop(pos.id, trailPrice);
        console.log(`Trade ${pos.id} — trailed SL to ${trailPrice} (${rNow.toFixed(2)}R)`);
      }
    }
  } catch (err) {
    console.error(`Manage trade ${pos.id} error:`, err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message);
  }
}

async function moveStop(tradeId, price) {
  await http.put(`${BASE}/v3/accounts/${ACCOUNT}/trades/${tradeId}/orders`, {
    stopLoss: { price: price.toFixed(PRICE_DECIMALS), timeInForce: 'GTC' }
  });
}

// ─── CLOSED-TRADE BOOKING ─────────────────────────────────────────────────────

async function checkClosedTrades() {
  try {
    // Book by DIRECT LOOKUP of our own open trades, not by scanning a windowed
    // CLOSED list. The old approach (trades?state=CLOSED&count=20) only returned a
    // slice of the account's closed history — once that history grew past the
    // window, newly-closed trades fell off the edge and were never booked (the
    // "0 closed but the balance moved" bug). Here we fetch each trade we opened by
    // its exact id, so booking is deterministic regardless of history size,
    // ordering, or partial (scale-out) closes.
    const perf = readPerformance();
    const openRecs = perf.trades.filter(r => !r.closeTime && r.tradeId);
    if (openRecs.length === 0) return;

    let booked = 0, stillOpen = 0, missing = 0, pruned = 0;
    for (const rec of openRecs) {
      try {
        const res = await http.get(`${BASE}/v3/accounts/${ACCOUNT}/trades/${rec.tradeId}`);
        const t = res.data.trade;
        if (!t) { missing++; continue; }
        if (t.state !== 'CLOSED' || !t.closeTime) { stillOpen++; continue; }   // partial/scale-out or still running

        const pl        = parseFloat(t.realizedPL || 0);
        const exitPrice = parseFloat(t.averageClosePrice || t.price || rec.entryPrice || 0);
        const closedTrade = recordTradeClose(rec.tradeId, exitPrice, pl);   // preserves the open record's metadata (mode/grade/R)
        booked++;
        const emoji = pl >= 0 ? '✅' : '❌';
        // Tie the result to the entry fingerprint AND the exit reason, so a close is
        // fully diagnosable from the email alone (no log needed) — e.g. "did it hit SL
        // or time-stop?" is answered right here.
        const pips  = rec.direction === 'BUY' ? (exitPrice - rec.entryPrice) / PIP_SIZE : (rec.entryPrice - exitPrice) / PIP_SIZE;
        const rMult = closedTrade?.rMultiple != null ? closedTrade.rMultiple : (rec.riskGBP ? pl / rec.riskGBP : null);
        const exitReason = closedTrade?.exitReason || '—';
        const ectx = rec.entryContext || {};
        const locBit = ectx.distEma20Pips != null ? ` · ${ectx.distEma20Pips >= 0 ? '+' : ''}${ectx.distEma20Pips.toFixed(0)}p vs EMA20`
                     : ectx.posInRangePct != null ? ` · ${ectx.posInRangePct.toFixed(0)}% in range` : '';
        const entryRead = `${rec.entryMethod || rec.mode || '—'}${rec.grade ? ` grade ${rec.grade}` : ''}${ectx.rsi != null ? ` · entry RSI ${ectx.rsi.toFixed(0)}` : ''}${locBit}`;
        await sendAlert(
          `${INSTRUMENT_NAME} trade ${rec.tradeId} closed | ${rec.direction} ${rec.mode || ''} | £${pl.toFixed(2)}${rMult != null ? ` (${rMult >= 0 ? '+' : ''}${rMult.toFixed(2)}R)` : ''} · ${pips >= 0 ? '+' : ''}${pips.toFixed(0)}p · exit: ${exitReason}` +
          `<br>Entry was: ${entryRead}`,
          { emoji, subject: `${emoji} ${BOT_NAME} — Trade Closed (£${pl.toFixed(2)})` });
      } catch (e) {
        // A definitive 404 = the trade isn't on this account (stale demo record
        // carried into the live bot, or a post-reset orphan). Prune it so it stops
        // 404-ing every cycle. Any OTHER error is transient — log and retry later.
        if (e.response?.status === 404) {
          removeOpenRecord(rec.tradeId);
          pruned++;
        } else {
          console.warn(`[book] trade ${rec.tradeId} lookup failed: ${e.response?.status || e.message}`);
          missing++;
        }
      }
    }
    if (booked || missing || pruned) {
      console.log(`[book] direct lookup of ${openRecs.length} open record(s) | booked ${booked} | still-open ${stillOpen} | pruned-stale ${pruned} | missing/error ${missing}`);
    }
  } catch (err) {
    console.error('checkClosedTrades error:', err.message);
  }
}

// ─── SCHEDULER ENTRY POINTS ───────────────────────────────────────────────────

// Called frequently by index.js — trails/manages open trades with no candle fetch.
async function runLightweightTrailUpdate() {
  try {
    const positions = await getOpenPositions();
    if (positions.length === 0) return;
    const currentPrice = await getCurrentPrice(INSTRUMENT);
    for (const pos of positions) await manageOpenPosition(pos, currentPrice);
  } catch (err) {
    console.error('Trail update error:', err.message);
  }
}

// Overnight: keep trailing + book any closes. No new entries.
async function runOvernightManagement() {
  try {
    await checkClosedTrades();
    await runLightweightTrailUpdate();
  } catch (err) {
    console.error('Overnight management error:', err.message);
  }
}

// Full monitor pass (has candles available) — currently same management path.
async function monitorOpenTrades(openPositions, currentPrice /*, candles1h, candles15m */) {
  for (const pos of openPositions) await manageOpenPosition(pos, currentPrice);
}

// Kept for index.js compatibility — trailing runs 24/7 so no separate bedtime lock needed.
async function runBedtimeProtection() { /* no-op */ }

module.exports = {
  runTradingCycle,
  monitorOpenTrades,
  runLightweightTrailUpdate,
  runOvernightManagement,
  runBedtimeProtection,
  // exposed for offline unit tests only
  _internals: { calcATR, calcADX, calcER, detectRegime, evaluateTrend, evaluateRange }
};
