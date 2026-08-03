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

const INSTRUMENT = (process.env.INSTRUMENT || 'XAG_USD').trim();  // silver bot — defaults to XAG/USD

// Per-instrument pip maths. PIP_SIZE = price move that equals "1 pip".
// PIP_VALUE_PER_LOT = USD P&L per pip per "lot", where 1 lot = 100 units.
// maxLot is a sanity cap on position size; the 1% risk rule is the real limiter.
// It must scale with how cheap each instrument's pip is: silver pips are 100×
// cheaper than gold's, so silver needs a far higher cap to reach 1% on a big
// account, whereas gold/US30 would be dangerous with a high cap.
const INSTRUMENT_SPECS = {
  XAU_USD:  { pipSize: 0.10,  pipValuePerLot: 10,   maxLot: 10,  label: 'XAU/USD', name: 'Gold'   },
  XAG_USD:  { pipSize: 0.001, pipValuePerLot: 0.10, maxLot: 500, label: 'XAG/USD', name: 'Silver' },
  US30_USD: { pipSize: 1.0,   pipValuePerLot: 100,  maxLot: 5,   label: 'US30',    name: 'US30'   }
};

const SPEC = INSTRUMENT_SPECS[INSTRUMENT] || INSTRUMENT_SPECS.XAU_USD;

const PIP_SIZE          = SPEC.pipSize;
const PIP_VALUE_PER_LOT = SPEC.pipValuePerLot;
const MAX_LOT           = SPEC.maxLot;
const INSTRUMENT_LABEL  = SPEC.label;
const INSTRUMENT_NAME   = SPEC.name;
const BOT_NAME          = `${SPEC.name} Demo`;

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

module.exports = {
  BASE, TOKEN, ACCOUNT, TRADING_MODE, isLive,
  INSTRUMENT, PIP_SIZE, PIP_VALUE_PER_LOT, MAX_LOT, INSTRUMENT_LABEL, INSTRUMENT_NAME, BOT_NAME
};
