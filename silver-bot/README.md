# Silver Demo Bot

A **self-contained** copy of the gold-demo dual-sleeve trading model, configured
for **silver (XAG/USD)**. It lives in its own folder in the Kronos repo so it is
completely independent of the gold demo — changes here never touch, restart, or
affect the gold bot, and vice versa.

**Purpose:** run the *same* model on a second market. If the edge (Grade-A
setups, the RANGE sleeve) shows up on silver too, it's real rather than fitted to
gold. If it vanishes, it was gold-specific.

## What it is

Identical engine to the gold demo — ADX regime detector → TREND sleeve
(pullback/breakout) or RANGE sleeve (fade the edges), 1.0×ATR stops, scale-out +
breakeven + trail at 1R, 6h time stop, pyramid-only-into-strength, 1% risk, and
the same full end-of-day report. The only difference is `INSTRUMENT` defaults to
`XAG_USD` and the lot cap is silver-appropriate.

## Deploy (Railway)

Point the service's **root directory** at `silver-bot/` and set:

**Required**
| Var | Value |
|-----|-------|
| `TRADING_MODE` | `demo` |
| `OANDA_BASE_URL` | `https://api-fxpractice.oanda.com` |
| `OANDA_API_KEY` | a **silver** demo account token |
| `OANDA_ACCOUNT_ID` | that demo account id |
| `DATA_DIR` | `/data` (its **own** Railway volume) |

**Recommended (reports/alerts):** `RESEND_API_KEY`, `ALERT_EMAIL`.

Do **not** set `INSTRUMENT` (defaults to `XAG_USD`). At boot the logs read
`Bot: Silver Demo` / `Symbol: XAG_USD`.

## Switching to LIVE (only once it earns it)

The bot is demo-locked. To go live later:
1. Set `TRADING_MODE=live` **and** `ALLOW_LIVE=true`.
2. Provide `OANDA_LIVE_API_KEY` and `OANDA_LIVE_ACCOUNT_ID` (base URL switches to
   `api-fxtrade.oanda.com` automatically).

That's the only change — no code edits — so a well-performing demo flips to live
with three env vars.

## Tuning

All strategy constants are at the top of `trader.js`. The loss-halt thresholds
(`CONSEC_HALT_AT`, `MAX_DAILY_LOSS_PCT`) are env-overridable and default to the
relaxed demo values; tighten them for a live run.
