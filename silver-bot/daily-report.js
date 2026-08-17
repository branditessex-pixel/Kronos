'use strict';

/**
 * daily-report.js — Gold Demo end-of-day report
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A deliberately EXHAUSTIVE report so the strategy can be stress-tested purely
 * from its output — by you or by pasting it into another model — without any
 * further code changes. It answers, from the stored data alone:
 *
 *   • Account state & P&L (realised today, unrealised, cumulative, drawdown)
 *   • Headline edge metrics (win rate, expectancy in R, profit factor, streaks)
 *   • Breakdowns by SLEEVE, GRADE, DIRECTION, ENTRY METHOD, ADX bucket, HOUR
 *   • Open positions right now
 *   • Trade-by-trade table for the day
 *   • Activity/decision stats (holds, blocks, errors, scale-outs, regime split)
 *   • Caveats a reader needs to interpret the numbers honestly
 *   • A machine-readable JSON block (+ an archived JSON file in DATA_DIR)
 *
 * Pure over stored data — it changes no trading behaviour.
 */

const fs   = require('fs');
const path = require('path');
const { readPerformance } = require('./performance');
const { readLog }         = require('./log');
const { getAccountInfo, getOpenPositions, getCurrentPrice } = require('./market');
const { sendReport }      = require('./alerts');
const { INSTRUMENT, INSTRUMENT_LABEL, INSTRUMENT_NAME, BOT_NAME, isLive } = require('./config');

const DATA_DIR = process.env.DATA_DIR || __dirname;

// ─── SMALL HELPERS ────────────────────────────────────────────────────────────

const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
const todayUTC = () => new Date().toISOString().slice(0, 10);
const isToday  = (iso) => iso && iso.slice(0, 10) === todayUTC();

const dash = (v) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : v;
const fR   = (v) => v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
const fG   = (v) => v === null || v === undefined ? '—' : `${v >= 0 ? '+' : '−'}£${Math.abs(v).toFixed(2)}`;
const fP   = (v) => v === null || v === undefined ? '—' : `${v.toFixed(0)}%`;
const fN   = (v, d = 1) => v === null || v === undefined ? '—' : Number(v).toFixed(d);
const fPF  = (v) => v === null || v === undefined ? '—' : (v === Infinity ? '∞' : v.toFixed(2));
const fMin = (v) => v === null || v === undefined ? '—' : v >= 60 ? `${(v / 60).toFixed(1)}h` : `${Math.round(v)}m`;

// ─── CORE STATS ───────────────────────────────────────────────────────────────

function statsFor(trades) {
  const n       = trades.length;
  const wins    = trades.filter(t => t.outcome === 'WIN');
  const losses  = trades.filter(t => t.outcome === 'LOSS');
  const be      = trades.filter(t => t.outcome === 'BREAKEVEN');
  const decided = wins.length + losses.length;
  const rVals   = trades.map(t => t.rMultiple).filter(v => v !== null && v !== undefined);
  const gbp     = trades.map(t => t.profitGBP).filter(v => v !== null && v !== undefined);
  const grossWin  = sum(wins.map(t => t.profitGBP));
  const grossLoss = Math.abs(sum(losses.map(t => t.profitGBP)));
  const holds = trades.filter(t => t.openTime && t.closeTime)
    .map(t => (new Date(t.closeTime) - new Date(t.openTime)) / 60000);
  const mfe = trades.map(t => t.mfeR).filter(v => v !== null && v !== undefined);
  const mae = trades.map(t => t.maeR).filter(v => v !== null && v !== undefined);
  return {
    trades: n, wins: wins.length, losses: losses.length, breakeven: be.length,
    winRate:     decided ? wins.length / decided * 100 : null,
    expectancyR: rVals.length ? sum(rVals) / rVals.length : null,
    totalR:      rVals.length ? sum(rVals) : null,
    totalGBP:    gbp.length ? sum(gbp) : 0,
    avgWinR:     wins.length ? sum(wins.map(t => t.rMultiple)) / wins.length : null,
    avgLossR:    losses.length ? sum(losses.map(t => t.rMultiple)) / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    largestWinR:  rVals.length ? Math.max(...rVals) : null,
    largestLossR: rVals.length ? Math.min(...rVals) : null,
    avgHoldMins:  holds.length ? sum(holds) / holds.length : null,
    avgMfeR:     mfe.length ? sum(mfe) / mfe.length : null,
    avgMaeR:     mae.length ? sum(mae) / mae.length : null
  };
}

// ─── TRADE QUALITY — "was it right / did it have room" (uses MFE & MAE) ────────
function tradeQuality(closed) {
  const withExc = closed.filter(t => t.mfeR !== null && t.mfeR !== undefined && t.maeR !== null && t.maeR !== undefined);
  if (!withExc.length) return null;
  const wins   = withExc.filter(t => t.outcome === 'WIN');
  const losses = withExc.filter(t => t.outcome === 'LOSS');
  // Direction was "right" if it moved at least +0.5R in our favour at some point
  const directionRight = withExc.filter(t => t.mfeR >= 0.5);
  // Losers that were up ≥1R before losing — management losses, not wrong calls
  const gaveBack = losses.filter(t => t.mfeR >= 1.0);
  // Winners that dipped hard first — measures whether the stop had *just* enough room
  const winnersNearStop = wins.filter(t => t.maeR <= -0.8);
  // Avg give-back = how much of the peak we returned before exit
  const giveBacks = withExc.map(t => (t.mfeR || 0) - (t.rMultiple || 0));
  return {
    n: withExc.length,
    directionRightRate: directionRight.length / withExc.length * 100,
    gaveBackCount: gaveBack.length,
    gaveBackOfLosses: losses.length ? gaveBack.length / losses.length * 100 : null,
    avgWinnerMae: wins.length ? sum(wins.map(t => t.maeR)) / wins.length : null,
    winnersNearStop: winnersNearStop.length,
    winnersTotal: wins.length,
    avgGiveBackR: giveBacks.length ? sum(giveBacks) / giveBacks.length : null
  };
}

// ─── TRAIL WHAT-IF — would locking in a floor at +X R have banked more? ────────
// APPROXIMATION: uses peak favourable excursion (MFE). A "floor at +X" means once
// a trade reaches +X R we guarantee it can't close below ~+X. Trades that never
// reached +X are unchanged; winners beyond +X keep running (a floor, not a cap).
// This estimates the UPSIDE of tighter management only — it cannot see winners a
// real trail would choke off early, so treat each row as an optimistic upper bound.
function trailWhatIf(closed) {
  const t = closed.filter(x => x.mfeR !== null && x.mfeR !== undefined && x.riskGBP);
  if (!t.length) return null;
  const actualGBP = sum(t.map(x => x.profitGBP || 0));
  return [0.8, 1.0, 1.5, 2.0].map(X => {
    let reclaimedGBP = 0, saved = 0;
    for (const x of t) {
      const rActual = x.rMultiple || 0;
      if (x.mfeR >= X && rActual < X) {
        reclaimedGBP += (X - rActual) * x.riskGBP;
        if (x.outcome !== 'WIN') saved++;   // a loss/breakeven turned into a +X win
      }
    }
    return { floorR: X, reachedCount: t.filter(x => x.mfeR >= X).length, tradesImproved: t.filter(x => x.mfeR >= X && (x.rMultiple || 0) < X).length, lossesSaved: saved, reclaimedGBP, wouldBeGBP: actualGBP + reclaimedGBP };
  });
}

function breakdown(trades, keyFn) {
  const groups = {};
  for (const t of trades) {
    const k = keyFn(t) ?? 'unknown';
    (groups[k] = groups[k] || []).push(t);
  }
  return Object.entries(groups)
    .map(([key, ts]) => ({ key, ...statsFor(ts) }))
    .sort((a, b) => b.trades - a.trades);
}

// Time-stop what-if — of the trades we cut at 6h, where did price go afterwards?
function timeStopWhatIf(closed) {
  const ts = closed.filter(t => t.exitReason === 'TIME_STOP' && t.timeStopWhatIf);
  if (!ts.length) return null;
  const c = { WOULD_TP: 0, WOULD_SL: 0, SCRATCH: 0, PENDING: 0 };
  for (const t of ts) {
    const r = t.timeStopWhatIf.resolved;
    if (r === 'WOULD_TP') c.WOULD_TP++;
    else if (r === 'WOULD_SL') c.WOULD_SL++;
    else if (r === 'SCRATCH') c.SCRATCH++;
    else c.PENDING++;
  }
  return { total: ts.length, ...c };
}

// Skipped-fade what-if — of the fades our guards blocked, would they have won or lost?
// Split by which guard blocked them so we can see WHICH dial (if any) is too strict.
function skippedFadeWhatIf(perf) {
  const sf = (perf && perf.skippedFades) || [];
  if (!sf.length) return null;
  const bucket = () => ({ WOULD_WIN: 0, WOULD_LOSE: 0, SCRATCH: 0, PENDING: 0 });
  const byReason = { COUNTER_TREND: bucket(), DEAD_MARKET: bucket() };
  const all = bucket();
  for (const s of sf) {
    const key = s.resolved || 'PENDING';
    if (!byReason[s.reason]) byReason[s.reason] = bucket();
    if (byReason[s.reason][key] !== undefined) byReason[s.reason][key]++;
    if (all[key] !== undefined) all[key]++;
  }
  return { total: sf.length, all, byReason };
}

function drawdownAndStreaks(closedSortedByClose) {
  let cum = 0, peak = 0, maxDdGBP = 0;
  let cumR = 0, peakR = 0, maxDdR = 0;
  let curW = 0, curL = 0, maxW = 0, maxL = 0, curStreak = 0;
  for (const t of closedSortedByClose) {
    cum  += t.profitGBP || 0; peak  = Math.max(peak,  cum);  maxDdGBP = Math.max(maxDdGBP, peak  - cum);
    cumR += t.rMultiple || 0; peakR = Math.max(peakR, cumR); maxDdR   = Math.max(maxDdR,   peakR - cumR);
    if (t.outcome === 'WIN')  { curW++; curL = 0; maxW = Math.max(maxW, curW); curStreak = curW; }
    else if (t.outcome === 'LOSS') { curL++; curW = 0; maxL = Math.max(maxL, curL); curStreak = -curL; }
  }
  return { maxDrawdownGBP: maxDdGBP, maxDrawdownR: maxDdR, maxWinStreak: maxW, maxLossStreak: maxL, currentStreak: curStreak };
}

function adxBucket(adx) {
  if (adx === null || adx === undefined) return 'unknown';
  if (adx < 18) return 'A: <18 (range)';
  if (adx < 22) return 'B: 18–22 (transition)';
  if (adx < 30) return 'C: 22–30 (trend)';
  return 'D: 30+ (strong trend)';
}

// ─── ASSEMBLE REPORT DATA ─────────────────────────────────────────────────────

async function buildReportData() {
  const perf   = readPerformance();
  const trades = perf.trades || [];
  const closed = trades.filter(t => t.closeTime);
  const open   = trades.filter(t => !t.closeTime);
  const closedSorted = [...closed].sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));
  const closedToday  = closed.filter(t => isToday(t.closeTime));
  const openedToday  = trades.filter(t => isToday(t.openTime));

  // Live account + positions (best-effort — report still renders if the API is down)
  let account = null, positions = [], priceNow = null, apiError = null;
  try {
    [account, positions, priceNow] = await Promise.all([
      getAccountInfo(), getOpenPositions(), getCurrentPrice(INSTRUMENT)
    ]);
  } catch (err) { apiError = err.message; }

  const realisedToday   = sum(closedToday.map(t => t.profitGBP));
  // Instrument-only: getOpenPositions() already filters to INSTRUMENT, so this is
  // THIS bot's open risk — not account.unrealizedPL, which on a shared account also
  // carries the other bot's (gold's) open positions.
  const unrealisedNow   = sum(positions.map(p => p.unrealizedProfit || 0));
  const cumulativeGBP   = sum(closed.map(t => t.profitGBP));

  // Daily equity snapshot — appended once per day so account growth over time is
  // reconstructable without any code change. Deduped by date.
  const equityHistory = snapshotEquity(account, { realisedToday, cumulativeGBP });

  // Activity from the raw log (today only)
  const log = readLog().filter(e => isToday(e.timestamp));
  const byType = {};
  for (const e of log) byType[e.type] = (byType[e.type] || 0) + 1;
  const holdReasons = {};
  const regimeSplit = { TREND: 0, RANGE: 0 };
  for (const e of log) {
    if (e.type === 'HOLD') {
      if (e.regime) regimeSplit[e.regime] = (regimeSplit[e.regime] || 0) + 1;
      const r = (e.reasoning || 'unspecified').split('(')[0].slice(0, 60).trim();
      holdReasons[r] = (holdReasons[r] || 0) + 1;
    }
  }
  const blockReasons = {};
  for (const e of log) {
    if (e.type === 'SAFETY_BLOCK' || e.type === 'RISK_BLOCK') {
      blockReasons[e.reason || 'unspecified'] = (blockReasons[e.reason || 'unspecified'] || 0) + 1;
    }
  }
  const topHoldReasons = Object.entries(holdReasons).sort((a, b) => b[1] - a[1]).slice(0, 6);

  return {
    meta: { bot: BOT_NAME, instrument: INSTRUMENT, label: INSTRUMENT_LABEL, mode: isLive ? 'LIVE' : 'DEMO', date: todayUTC(), generatedAt: new Date().toISOString() },
    account: account ? { balance: account.balance, equity: account.equity, currency: account.currency, unrealizedPL: account.unrealizedPL } : null,
    apiError,
    priceNow,
    pnl: { realisedToday, unrealisedNow, cumulativeGBP },
    counts: { totalTrades: trades.length, closed: closed.length, open: open.length, closedToday: closedToday.length, openedToday: openedToday.length },
    overall: statsFor(closed),
    today:   statsFor(closedToday),
    risk:    drawdownAndStreaks(closedSorted),
    quality: tradeQuality(closed),
    trailWhatIf: trailWhatIf(closed),
    byMode:      breakdown(closed, t => t.mode),
    byEntrySeq:  breakdown(closed, t => (t.entrySeq && t.entrySeq >= 2) ? 'ADD (pyramid)' : 'INITIAL'),
    byGrade:     breakdown(closed, t => t.grade),
    byDirection: breakdown(closed, t => t.direction),
    byMethod:    breakdown(closed, t => t.entryMethod),
    byExitReason: breakdown(closed, t => t.exitReason || 'unknown'),
    timeStop:    timeStopWhatIf(closed),
    skippedFades: skippedFadeWhatIf(perf),
    byAdx:       breakdown(closed, t => adxBucket(t.regimeAdx)).sort((a, b) => a.key.localeCompare(b.key)),
    byHour:      breakdown(closed, t => t.openTime ? `${new Date(t.openTime).getUTCHours()}:00` : 'unknown')
                   .sort((a, b) => parseInt(a.key) - parseInt(b.key)),
    openPositions: positions.map(p => ({
      id: p.id, type: p.type, units: p.units, openPrice: p.openPrice,
      stopLoss: p.stopLoss, takeProfit: p.takeProfit, unrealizedProfit: p.unrealizedProfit
    })),
    todaysTrades: closedToday.map(t => ({
      id: t.tradeId, dir: t.direction, mode: t.mode, grade: t.grade, method: t.entryMethod,
      entry: t.entryPrice, exit: t.exitPrice, slPips: t.slPips, adx: t.regimeAdx,
      r: t.rMultiple, mfeR: t.mfeR, maeR: t.maeR, gbp: t.profitGBP, outcome: t.outcome, exitReason: t.exitReason,
      holdMins: t.openTime && t.closeTime ? (new Date(t.closeTime) - new Date(t.openTime)) / 60000 : null
    })),
    activity: { byType, regimeSplit, topHoldReasons, blockReasons },
    equityHistory,
    // COMPLETE raw trade history — every field of every trade. This is the export
    // that makes the report future-proof: any question can be answered by slicing
    // this array downstream, with no code change here.
    rawTrades: trades
  };
}

// Append today's account state to equity-history.json (once per day) and return
// the full history. Falls back gracefully if the file or account is unavailable.
function snapshotEquity(account, { realisedToday, cumulativeGBP }) {
  const file = path.join(DATA_DIR, 'equity-history.json');
  let hist = [];
  try { if (fs.existsSync(file)) hist = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { hist = []; }
  const today = todayUTC();
  const entry = {
    date: today,
    balance:  account ? account.balance : null,
    equity:   account ? account.equity  : null,
    realisedToday,
    cumulativeRealisedGBP: cumulativeGBP,
    live: isLive                        // tag each row so demo snapshots never pollute the live growth table
  };
  const idx = hist.findIndex(h => h.date === today);
  if (idx >= 0) hist[idx] = entry; else hist.push(entry);

  // Self-heal stale demo rows. The US30 service reused the demo /data volume, so
  // equity-history carried demo-era snapshots (a ~£85k demo balance) into the live
  // growth table. Rule: rows tagged {live:true} are always kept; {live:false} are
  // dropped; legacy untagged rows are kept only if their balance is in scale with
  // the live account (≤5× the current live balance) — the ~£85k demo rows are
  // 200×+ out of scale and get pruned, while the genuine go-live baseline stays.
  // The scale check is skipped when the account API is unavailable (never prunes on
  // missing data — it just heals on the next cycle).
  const liveBal = (account && account.balance) ? account.balance : null;
  hist = hist.filter(h => {
    if (h.live === true)  return true;
    if (h.live === false) return false;
    if (liveBal && h.balance != null && h.balance > liveBal * 5) return false;
    return true;
  });

  try { fs.writeFileSync(file, JSON.stringify(hist, null, 2), 'utf8'); } catch (err) { console.error('equity-history write failed:', err.message); }
  return hist;
}

// ─── HTML RENDERING ───────────────────────────────────────────────────────────

const TH = 'style="text-align:left;padding:6px 10px;border-bottom:2px solid #333;font-size:12px;color:#111;"';
const TD = 'style="padding:5px 10px;border-bottom:1px solid #eee;font-size:13px;color:#222;"';

function table(headers, rows) {
  if (!rows.length) return '<p style="color:#888;font-size:13px;">No data yet.</p>';
  const head = headers.map(h => `<th ${TH}>${h}</th>`).join('');
  const body = rows.map(r => `<tr>${r.map(c => `<td ${TD}>${c}</td>`).join('')}</tr>`).join('');
  return `<table style="border-collapse:collapse;width:100%;margin:6px 0 18px;">${`<tr>${head}</tr>`}${body}</table>`;
}

function statsRow(label, s) {
  return [label, s.trades, `${s.wins}/${s.losses}/${s.breakeven}`, fP(s.winRate), fR(s.expectancyR),
    fR(s.totalR), fG(s.totalGBP), fPF(s.profitFactor), fR(s.avgWinR), fR(s.avgLossR), fMin(s.avgHoldMins)];
}
const STATS_HEADERS = ['', 'Trades', 'W/L/BE', 'Win%', 'Expectancy', 'Net R', 'Net £', 'PF', 'Avg win', 'Avg loss', 'Avg hold'];

function h2(t) { return `<h2 style="font-size:16px;color:#111;border-bottom:1px solid #ccc;padding-bottom:4px;margin:22px 0 6px;">${t}</h2>`; }
function kv(label, val) { return `<span style="display:inline-block;min-width:190px;color:#666;font-size:13px;">${label}</span><b style="font-size:13px;color:#111;">${val}</b><br>`; }

function renderHtml(d) {
  const o = d.overall, r = d.risk;
  const acc = d.account;
  const modeColour = d.pnl.cumulativeGBP >= 0 ? '#1a7a1a' : '#8b0000';

  let html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:820px;margin:0 auto;color:#222;">`;
  html += `<div style="background:${modeColour};padding:18px 20px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:20px;">📊 ${d.meta.bot} — End of Day</h1>
    <p style="color:rgba(255,255,255,.85);margin:4px 0 0;font-size:13px;">${d.meta.label} · ${d.meta.mode} · ${d.meta.date} (UTC)</p></div>`;
  html += `<div style="background:#fafafa;padding:20px;border-radius:0 0 8px 8px;">`;

  // P&L — lead with THIS bot's own booked P&L. The OANDA balance/equity is the
  // SHARED account (this bot runs alongside gold on the same account), so it is not
  // bot-specific — shown demoted below as context, never as the headline.
  const label = d.meta.label;
  const heroColour = d.pnl.cumulativeGBP >= 0 ? '#1a7a1a' : '#8b0000';
  html += h2(`${label} P&L (this bot only)`);
  html += `<div style="font-size:26px;font-weight:bold;color:${heroColour};line-height:1.1;margin:2px 0;">${fG(d.pnl.cumulativeGBP)}</div>`;
  html += `<div style="font-size:12.5px;color:#666;margin-bottom:10px;">cumulative realised — ${label}'s own booked P&L, clean of the shared balance</div>`;
  html += kv('Realised today', fG(d.pnl.realisedToday));
  html += kv('Open (unrealised) now', fG(d.pnl.unrealisedNow));
  if (d.priceNow) html += kv('Price now (mid)', d.priceNow.mid.toFixed(2));

  // Shared-account context — deliberately demoted so it isn't mistaken for US30's own.
  if (acc) {
    html += `<p style="font-size:12px;color:#999;margin-top:10px;">Shared account (gold + ${label}): balance £${acc.balance.toFixed(2)} · equity £${acc.equity.toFixed(2)} ${acc.currency || ''}. This is the <i>whole</i> account, not ${label} alone — judge ${label} by the realised figures above, not this balance.</p>`;
  } else {
    html += `<p style="color:#8b0000;font-size:13px;">⚠️ Live account unavailable${d.apiError ? ` (${d.apiError})` : ''} — figures above are from stored trades only.</p>`;
  }

  // Account growth over time
  if (d.equityHistory && d.equityHistory.length) {
    html += h2('Account growth (daily snapshots)');
    html += table(['Date', 'Balance', 'Equity', 'Realised that day', 'Cumulative realised'],
      d.equityHistory.slice(-30).map(h => [h.date,
        h.balance != null ? `£${h.balance.toFixed(2)}` : '—',
        h.equity != null ? `£${h.equity.toFixed(2)}` : '—',
        fG(h.realisedToday), fG(h.cumulativeRealisedGBP)]));
    html += `<p style="font-size:12px;color:#999;">Balance/Equity are the shared account (gold + ${label}); the ${label}-only curve is the <b>Cumulative realised</b> column.</p>`;
  }

  // Headline metrics (all-time closed)
  html += h2('Headline edge (all closed trades)');
  html += kv('Closed trades', o.trades);
  html += kv('Win rate', `${fP(o.winRate)} (${o.wins}W / ${o.losses}L / ${o.breakeven}BE)`);
  html += kv('Expectancy per trade', `${fR(o.expectancyR)}  ← the number that matters`);
  html += kv('Total R / Net £', `${fR(o.totalR)}  /  ${fG(o.totalGBP)}`);
  html += kv('Profit factor', fPF(o.profitFactor));
  html += kv('Avg win / Avg loss', `${fR(o.avgWinR)} / ${fR(o.avgLossR)}`);
  html += kv('Largest win / loss', `${fR(o.largestWinR)} / ${fR(o.largestLossR)}`);
  html += kv('Avg peak reached / dip (MFE / MAE)', `${fR(o.avgMfeR)} / ${fR(o.avgMaeR)}`);
  html += kv('Max drawdown', `${fR(r.maxDrawdownR ? -r.maxDrawdownR : 0)}  (£${r.maxDrawdownGBP.toFixed(2)})`);
  html += kv('Streaks', `current ${r.currentStreak >= 0 ? r.currentStreak + 'W' : (-r.currentStreak) + 'L'} · max ${r.maxWinStreak}W / ${r.maxLossStreak}L`);
  html += kv('Avg hold time', fMin(o.avgHoldMins));

  // Today
  html += h2("Today");
  html += kv('Opened / closed today', `${d.counts.openedToday} / ${d.counts.closedToday}`);
  if (d.today.trades) html += table(STATS_HEADERS, [statsRow("Today's closed", d.today)]);

  // By sleeve — the core question
  html += h2('By sleeve — does each have edge?');
  html += table(STATS_HEADERS, d.byMode.map(s => statsRow(s.key, s)));

  // Initial vs add — do the pyramid adds actually help?
  html += h2('Initial vs add — do pyramid adds help?');
  html += table(STATS_HEADERS, d.byEntrySeq.map(s => statsRow(s.key, s)));

  // Other breakdowns
  html += h2('By grade (A vs B — is the grading meaningful?)');
  html += table(STATS_HEADERS, d.byGrade.map(s => statsRow('Grade ' + s.key, s)));
  html += h2('By direction');
  html += table(STATS_HEADERS, d.byDirection.map(s => statsRow(s.key, s)));
  html += h2('By entry method');
  html += table(STATS_HEADERS, d.byMethod.map(s => statsRow(s.key, s)));

  html += h2('By exit reason — how did trades actually close?');
  html += table(['Exit reason', 'Trades', 'Win%', 'Net £'],
    d.byExitReason.map(s => [s.key, s.trades, fP(s.winRate), fG(s.totalGBP)]));
  html += `<p style="font-size:12.5px;color:#555;">The check that answers "did it hit the stop?" at a glance. <b>TP HIT</b> = target reached · <b>SL HIT</b> = full stop · <b>TRAIL/SCALE</b> = banked/trailed out after moving the stop · <b>TIME_STOP</b> = cut at the 6h wall-clock limit for never reaching breakeven. Watch the <b>TIME_STOP</b> row: a pile of them means the setup keeps entering but the market gives no follow-through — the key warning sign for a range bot. A healthy book is mostly TP HIT / TRAIL, not time-stops.</p>`;

  if (d.timeStop) {
    const t = d.timeStop;
    html += h2('Time-stop what-if — are the 6h cuts right?');
    html += table(['After the cut, price would have…', 'Count'],
      [['✅ Hit the target — we cut a winner', t.WOULD_TP],
       ['🛑 Hit the stop — the cut saved a bigger loss', t.WOULD_SL],
       ['➖ Just drifted / scratched — cut was neutral', t.SCRATCH],
       ['⏳ Still watching', t.PENDING]]);
    html += `<p style="font-size:12.5px;color:#555;">Each 6h cut is watched for up to 12h afterwards. If many would have <b>hit the target</b>, we're cutting too early — lengthen the time-stop. If most would have <b>hit the stop</b> or just drifted, the cut is doing its job (tiny loss, book freed). Estimate from 5-min sampling — read the direction, not the exact count. Needs a handful before it means anything.</p>`;
  }

  if (d.skippedFades) {
    const s = d.skippedFades;
    const rowFor = (label, b) => [label, b.WOULD_WIN, b.WOULD_LOSE, b.SCRATCH, b.PENDING];
    const rows = [];
    if (s.byReason.COUNTER_TREND) rows.push(rowFor('Counter-trend (H4 bias filter)', s.byReason.COUNTER_TREND));
    if (s.byReason.DEAD_MARKET)   rows.push(rowFor('Dead market (ADX floor)',        s.byReason.DEAD_MARKET));
    rows.push(rowFor('All skipped fades', s.all));
    html += h2('Skipped-fade what-if — are the fade filters too strict?');
    html += table(['Skipped because', "Would've won", "Would've lost", 'Scratched', 'Watching'], rows);
    html += `<p style="font-size:12.5px;color:#555;">Every fade a guard blocks is watched for up to 12h to see what it would have done. Read each row on its own: if <b>would've won ≫ would've lost</b>, that filter is too strict — loosen that dial. If <b>would've lost</b> dominates (or they just scratched), the filter is saving you money — leave it. This is the number that decides whether we've over-tightened. Estimate from 5-min sampling; needs a handful of resolved skips before it means anything.</p>`;
  }

  html += h2('By ADX bucket at entry (regime quality vs outcome)');
  html += table(STATS_HEADERS, d.byAdx.map(s => statsRow(s.key, s)));
  html += h2('By hour opened (UTC)');
  html += table(STATS_HEADERS, d.byHour.map(s => statsRow(s.key, s)));

  // Trade quality — was it right, did it have room
  html += h2('Trade quality — was the call right, did it have room?');
  if (d.quality) {
    const q = d.quality;
    html += kv('Direction was right', `${fP(q.directionRightRate)} of trades went ≥ +0.5R in our favour at some point`);
    html += kv('“Right but lost”', `${q.gaveBackCount} losing trade(s) were up ≥ +1R first${q.gaveBackOfLosses !== null ? ` (${fP(q.gaveBackOfLosses)} of all losses)` : ''} — management losses, not wrong calls`);
    html += kv('Room check (winners’ avg dip)', `${fR(q.avgWinnerMae)} — how far winners went against us before working. Near −1R = stops barely wide enough; near 0 = plenty of room`);
    html += kv('Winners that nearly stopped out', `${q.winnersNearStop} of ${q.winnersTotal} winners dipped ≤ −0.8R first`);
    html += kv('Avg give-back', `${fR(q.avgGiveBackR)} handed back between peak (MFE) and exit`);
  } else {
    html += `<p style="color:#888;font-size:13px;">No excursion data yet — populates as trades open and are managed.</p>`;
  }

  // Trail what-if
  html += h2('Trail what-if — would banking a floor at +X R have saved more?');
  if (d.trailWhatIf) {
    html += table(['Lock floor at', 'Trades that reached it', 'Trades improved', 'Losses→wins', '£ reclaimed (upper bound)', 'Net £ would-be'],
      d.trailWhatIf.map(w => [`+${w.floorR}R`, w.reachedCount, w.tradesImproved, w.lossesSaved, fG(w.reclaimedGBP), fG(w.wouldBeGBP)]));
    html += `<p style="font-size:12px;color:#8b6b00;">⚠️ Optimistic upper bound: based on peak favourable excursion, so it counts every giveback saved but <b>cannot</b> see winners a tighter trail would cut short early. Use it to spot whether givebacks are a real problem, not as a promised P&L.</p>`;
  } else {
    html += `<p style="color:#888;font-size:13px;">No excursion data yet.</p>`;
  }

  // Open positions
  html += h2('Open positions right now');
  html += table(['Ticket', 'Dir', 'Units', 'Entry', 'SL', 'TP', 'Unrealised £'],
    d.openPositions.map(p => [p.id, p.type, p.units, fN(p.openPrice, 2), dash(p.stopLoss), dash(p.takeProfit), fG(p.unrealizedProfit)]));

  // Trade-by-trade today
  html += h2("Today's trades (blow-by-blow)");
  html += table(['Ticket', 'Dir', 'Sleeve', 'Gr', 'Method', 'Entry', 'Exit', 'SL(p)', 'ADX', 'MFE', 'MAE', 'R', '£', 'Hold'],
    d.todaysTrades.map(t => [t.id, t.dir, t.mode || '—', t.grade || '—', t.method || '—',
      fN(t.entry, 2), fN(t.exit, 2), dash(t.slPips), fN(t.adx, 1), fR(t.mfeR), fR(t.maeR), fR(t.r), fG(t.gbp), fMin(t.holdMins)]));

  // Activity / decisions
  html += h2('Activity & decisions today');
  const at = d.activity.byType;
  html += kv('Cycle outcomes', Object.entries(at).map(([k, v]) => `${k}:${v}`).join('  ') || 'none logged');
  html += kv('Regime split (holds)', `TREND ${d.activity.regimeSplit.TREND || 0} · RANGE ${d.activity.regimeSplit.RANGE || 0}`);
  if (d.activity.topHoldReasons.length) {
    html += `<p style="color:#666;font-size:13px;margin:8px 0 2px;">Top reasons for not trading:</p><ul style="margin:0 0 10px;font-size:13px;color:#333;">`;
    html += d.activity.topHoldReasons.map(([r2, c]) => `<li>${r2} <b>×${c}</b></li>`).join('');
    html += `</ul>`;
  }
  if (Object.keys(d.activity.blockReasons).length) {
    html += kv('Safety/risk blocks', Object.entries(d.activity.blockReasons).map(([k, v]) => `${k} ×${v}`).join('  '));
  }

  // Caveats
  html += h2('How to read this (caveats)');
  html += `<ul style="font-size:12.5px;color:#555;line-height:1.5;">
    <li><b>Expectancy (R)</b> is the average pounds made ÷ pounds risked per trade. Positive = edge. It is the single most important figure — judge each sleeve on its own row, not the blend.</li>
    <li><b>Sample size:</b> expectancy is noise below ~20–30 closed trades <i>per sleeve</i>. Don't act on a handful of trades.</li>
    <li><b>R is money-based</b> (£ made ÷ £ risked), so it stays correct through partial scale-outs.</li>
    <li><b>Risk basis:</b> sizing uses a USD pip value against a GBP balance, so "1% risk" is really ~0.8% in GBP terms — conservative and consistent with the live gold bot.</li>
    <li><b>Half of each trade is banked at the scale-out R</b> and the runner trails; a trade can therefore close net positive with a sub-1R average because risk came off early.</li>
    <li><b>MFE</b> = furthest a trade went in our favour; <b>MAE</b> = furthest against, both in R (peak/trough at 1-minute resolution). MFE ≥ +0.5R means the direction was right at some point; a loss with high MFE was given back, not a wrong call. Winner MAE shows how much room the stop actually needed.</li>
    <li>Times are UTC. "Today" = the UTC calendar day this report ran.</li>
  </ul>`;

  // Machine-readable appendix
  html += h2('Machine-readable data (for stress-testing elsewhere)');
  html += `<p style="font-size:12px;color:#666;">Complete export — includes <b>every field of every trade</b> (<code>rawTrades</code>, ${d.rawTrades.length} trades), the equity history, and all breakdowns. Paste it into another model to ask <i>anything</i> about the data — no code change needed here. A copy is also archived at <code>${path.join(DATA_DIR, `daily-report-${d.meta.date}.json`)}</code>.</p>`;
  html += `<pre style="background:#111;color:#0f0;padding:12px;border-radius:6px;font-size:10.5px;overflow-x:auto;white-space:pre-wrap;">${escapeHtml(JSON.stringify(d, null, 2))}</pre>`;

  html += `<p style="font-size:11px;color:#999;margin-top:18px;">${d.meta.bot} · generated ${d.meta.generatedAt} · branditessex.com</p>`;
  html += `</div></div>`;
  return html;
}

function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

async function sendDailyReport() {
  const data = await buildReportData();

  // Archive the raw JSON so the data survives outside email and can be fed elsewhere.
  try {
    fs.writeFileSync(path.join(DATA_DIR, `daily-report-${data.meta.date}.json`), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) { console.error('Report archive write failed:', err.message); }

  const html = renderHtml(data);
  const net  = data.pnl.cumulativeGBP;
  const subj = `📊 ${data.meta.bot} — ${data.meta.date} | ${data.counts.closedToday} closed today | cum ${net >= 0 ? '+' : '−'}£${Math.abs(net).toFixed(2)}`;
  await sendReport(subj, html);
  console.log(`Daily report sent — ${data.counts.closed} closed trades, expectancy ${data.overall.expectancyR === null ? 'n/a' : data.overall.expectancyR.toFixed(2) + 'R'}`);
  return data;
}

module.exports = { sendDailyReport, buildReportData, renderHtml, _stats: { statsFor, breakdown, drawdownAndStreaks } };
