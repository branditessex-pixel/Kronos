function calculateEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const rs = gains / (losses || 1);
  return 100 - 100 / (1 + rs);
}

function calculateMACD(closes) {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macdLine = ema12 - ema26;

  const macdValues = [];
  for (let i = 26; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const e12 = calculateEMA(slice, 12);
    const e26 = calculateEMA(slice, 26);
    macdValues.push(e12 - e26);
  }

  const signalLine = calculateEMA(macdValues, 9);
  const histogram = macdLine - signalLine;

  const prevMacdValues = macdValues.slice(0, -1);
  const prevSignalLine = calculateEMA(prevMacdValues, 9);
  const prevMacdLine = prevMacdValues[prevMacdValues.length - 1] || macdLine;
  const prevHistogram = prevMacdLine - prevSignalLine;

  return { macdLine, signalLine, histogram, prevHistogram };
}

/**
 * calculateIndicators — used by mailer.js for morning briefing and daily summary.
 * candles1h and candles15m are arrays of { open, high, low, close, time } objects.
 * currentPrice is { bid, ask, mid } or a raw number.
 */
function calculateIndicators(candles1h, candles15m, currentPrice) {
  const closes1h  = candles1h.map(c => parseFloat(c.close || c.mid?.c || 0));
  const closes15m = candles15m
    ? candles15m.map(c => parseFloat(c.close || c.mid?.c || 0))
    : closes1h.slice(-20);

  const ema20  = calculateEMA(closes1h, 20);
  const ema50  = calculateEMA(closes1h, 50);
  const ema200 = calculateEMA(closes1h, 200);
  const rsi1h  = calculateRSI(closes1h, 14);
  const rsi15m = calculateRSI(closes15m, 14);
  const macd   = calculateMACD(closes1h);

  const price = typeof currentPrice === 'object'
    ? (currentPrice.bid || currentPrice.mid || 0)
    : parseFloat(currentPrice || 0);

  let emaStructure = 'NEUTRAL';
  if (ema20 > ema50 && ema50 > ema200) emaStructure = 'BULLISH';
  else if (ema20 < ema50 && ema50 < ema200) emaStructure = 'BEARISH';

  const macdSignal = macd.macdLine > macd.signalLine ? 'BULLISH'
    : macd.macdLine < macd.signalLine ? 'BEARISH' : 'NEUTRAL';
  const macdLabel  = `Histogram ${macd.histogram >= 0 ? '+' : ''}${macd.histogram.toFixed(4)}`;

  const recent24h    = candles1h.slice(-24);
  const overnightHigh = Math.max(...recent24h.map(c => parseFloat(c.high || c.mid?.h || 0)));
  const overnightLow  = Math.min(...recent24h.map(c => parseFloat(c.low  || c.mid?.l || 0)));

  return {
    price,
    ema20, ema50, ema200,
    emaStructure,
    rsi1h, rsi15m,
    macdLine:    macd.macdLine,
    macdSignal,
    macdLabel,
    macdHistogram: macd.histogram,
    overnightHigh,
    overnightLow
  };
}

module.exports = { calculateEMA, calculateRSI, calculateMACD, calculateIndicators };