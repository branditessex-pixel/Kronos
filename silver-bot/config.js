'use strict';

/**
 * config.js — Gold Demo Trader
 *
 * This service was formerly the Silver Trader. It has been repurposed into a
 * GOLD DEMO bot: same instrument as the live gold bot (XAU/USD) but running a
 * deliberately different, higher-frequency, regime-aware strategy on a DEMO
 * account, purely to measure edge before anything touches real money.
 *
 * Single source of truth for OANDA credentials AND the traded instrument.
 * Everything else in the codebase imports from here — never from process.env
 * directly, and never hardcodes the instrument.
 *
 * Required env vars (DEMO — the default and only supported mode here):
 *   OANDA_BASE_URL       https://api-fxpractice.oanda.com
 *   OANDA_API_KEY        practice account API token
 *   OANDA_ACCOUNT_ID     practice account ID
 *
 * Optional:
 *   INSTRUMENT           OANDA instrument (default XAU_USD)
 *   ALLOW_LIVE=true      unlock live mode (guardrail — off by default)
 */

require('dotenv').config();

// ─── DEMO GUARDRAIL ───────────────────────────────────────────────────────────
// This is a demo research bot. It refuses to run against a live account unless
// ALLOW_LIVE=true is explicitly set, so it can never accidentally trade real money.

const TRADING_MODE = (process.env.TRADING_MODE || 'demo').toLowerCase().trim();
const wantsLive    = TRADING_MODE === 'live';
const allowLive    = (process.env.ALLOW_LIVE || '').toLowerCase().trim() === 'true';

if (wantsLive && !allowLive) {
  console.error('[CONFIG] FATAL: This is a DEMO bot. TRADING_MODE=live is blocked.');
  console.error('[CONFIG] If you really mean to go live, set ALLOW_LIVE=true — but you almost certainly do not.');
  process.exit(1);
}

const isLive = wantsLive && allowLive;

const BASE = isLive
  ? 'https://api-fxtrade.oanda.com'
  : (process.env.OANDA_BASE_URL || 'https://api-fxpractice.oanda.com');

const TOKEN = isLive
  ? (process.env.OANDA_LIVE_API_KEY   || '').trim()
  : (process.env.OANDA_API_KEY        || '').trim();

const ACCOUNT = isLive
  ? (process.env.OANDA_LIVE_ACCOUNT_ID || '').trim()
  : (process.env.OANDA_ACCOUNT_ID      || '').trim();

// ─── INSTRUMENT ───────────────────────────────────────────────────────────────
// Gold by default. One place defines the instrument and its pip maths; every
// other module imports these rather than hardcoding 'XAG_USD'/'XAU_USD'.

const INSTRUMENT = (process.env.INSTRUMENT || 'US30_USD').trim();  // demo research bot — repurposed to US30 (replicating the gold model on a cleaner-trending index)

// Per-instrument pip maths. PIP_SIZE = price move that equals "1 pip".
// PIP_VALUE_PER_LOT = USD P&L per pip per "lot", where 1 lot = 100 units.
// maxLot is a sanity cap on position size; the 1% risk rule is the real limiter.
// It must scale with how cheap each instrument's pip is: silver pips are 100×
// cheaper than gold's, so silver needs a far higher cap to reach 1% on a big
// account, whereas gold/US30 would be dangerous with a high cap.
const INSTRUMENT_SPECS = {
  XAU_USD:  { pipSize: 0.10,  pipValuePerLot: 10,   maxLot: 10,  label: 'XAU/USD', name: 'Gold'   },
  XAG_USD:  { pipSize: 0.001, pipValuePerLot: 0.10, maxLot: 500, label: 'XAG/USD', name: 'Silver' },
  US30_USD: { pipSize: 1.0,   pipValuePerLot: 100,  maxLot: 0.0004, label: 'US30', name: 'US30' }  // LIVE (shared small acct): 0.0004 lot = 0.04 units — 4× the OANDA index minimum. MIN_LOT also 0.0004, so every US30 trade is pinned to exactly 0.04 units (~£84 margin / ~£4–5.60 risk per trade; 2 concurrent ≈ £168 margin). Still a hard cap vs the old 5 (=500 units) that could have blown the account; executeTrade backstop = MAX_LOT×100×5 = 0.2 units.
};

const SPEC = INSTRUMENT_SPECS[INSTRUMENT] || INSTRUMENT_SPECS.XAU_USD;

const PIP_SIZE          = SPEC.pipSize;
const PIP_VALUE_PER_LOT = SPEC.pipValuePerLot;
const MAX_LOT           = SPEC.maxLot;
const INSTRUMENT_LABEL  = SPEC.label;
const INSTRUMENT_NAME   = SPEC.name;
const BOT_NAME          = `${SPEC.name} ${isLive ? 'Live' : 'Demo'}`;   // e.g. "US30 Live" once TRADING_MODE=live — so emails don't mislabel a live bot as Demo

// ─── TIMEFRAME ────────────────────────────────────────────────────────────────
// The strategy is timeframe-portable: ENTRY_TF drives entries/regime, BIAS_TF the
// higher-timeframe trend bias. Silver defaults to the faster M15/H1 pairing (the
// hypothesis is silver's moves are quicker than the H1/H4 gold pairing can catch);
// override via env to experiment. All distance-based tunables in trader.js scale
// with ATR / the stop, so changing the timeframe rescales them automatically.
const ENTRY_TF = (process.env.ENTRY_TF || 'H1').trim().toUpperCase();  // gold-model pairing: H1 entries
const BIAS_TF  = (process.env.BIAS_TF  || 'H4').trim().toUpperCase();  // gold-model pairing: H4 bias
const TF_MINUTES = { M1: 1, M2: 2, M5: 5, M10: 10, M15: 15, M30: 30, H1: 60, H2: 120, H4: 240 };
const ENTRY_TF_MIN = TF_MINUTES[ENTRY_TF] || 15;

// ─── STARTUP VALIDATION ───────────────────────────────────────────────────────

if (isLive) {
  if (!TOKEN)   { console.error('[CONFIG] FATAL: live mode but OANDA_LIVE_API_KEY not set');    process.exit(1); }
  if (!ACCOUNT) { console.error('[CONFIG] FATAL: live mode but OANDA_LIVE_ACCOUNT_ID not set'); process.exit(1); }
} else {
  if (!TOKEN)   console.warn('[CONFIG] Warning: OANDA_API_KEY is not set');
  if (!ACCOUNT) console.warn('[CONFIG] Warning: OANDA_ACCOUNT_ID is not set');
}

const tokenPreview = TOKEN ? `${TOKEN.slice(0, 6)}…` : 'NOT SET';

console.log(`[CONFIG] ─────────────────────────────────────────────`);
console.log(`[CONFIG] Bot     : ${BOT_NAME}`);
console.log(`[CONFIG] Mode    : ${isLive ? '🔴 LIVE' : '🟢 DEMO'}`);
console.log(`[CONFIG] Symbol  : ${INSTRUMENT} (${INSTRUMENT_LABEL})`);
console.log(`[CONFIG] Account : ${ACCOUNT || 'NOT SET'}`);
console.log(`[CONFIG] Base URL: ${BASE}`);
console.log(`[CONFIG] Token   : ${tokenPreview}`);
console.log(`[CONFIG] ─────────────────────────────────────────────`);

console.log(`[CONFIG] Timeframe: ${ENTRY_TF} entries / ${BIAS_TF} bias`);

module.exports = {
  BASE, TOKEN, ACCOUNT, TRADING_MODE, isLive,
  INSTRUMENT, PIP_SIZE, PIP_VALUE_PER_LOT, MAX_LOT, INSTRUMENT_LABEL, INSTRUMENT_NAME, BOT_NAME,
  ENTRY_TF, BIAS_TF, ENTRY_TF_MIN
};
