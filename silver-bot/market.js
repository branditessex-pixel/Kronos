const axios = require('axios');
const { BASE, TOKEN, ACCOUNT, INSTRUMENT } = require('./config');

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json'
};

const http = axios.create({ headers, timeout: 30000 });

async function getCandles(instrument = INSTRUMENT, granularity = 'H1', count = 250) {
  const url = `${BASE}/v3/instruments/${instrument}/candles?granularity=${granularity}&count=${count}`;
  const res = await http.get(url);
  return res.data.candles.map(c => ({
    open: parseFloat(c.mid.o),
    high: parseFloat(c.mid.h),
    low: parseFloat(c.mid.l),
    close: parseFloat(c.mid.c),
    time: c.time
  }));
}

async function getCandles15m(instrument = INSTRUMENT) {
  const url = `${BASE}/v3/instruments/${instrument}/candles?granularity=M15&count=60`;
  const res = await http.get(url);
  return res.data.candles.map(c => ({
    open: parseFloat(c.mid.o),
    high: parseFloat(c.mid.h),
    low: parseFloat(c.mid.l),
    close: parseFloat(c.mid.c),
    time: c.time
  }));
}

async function getCandles4h(instrument = INSTRUMENT, count = 100) {
  const url = `${BASE}/v3/instruments/${instrument}/candles?granularity=H4&count=${count}`;
  const res = await http.get(url);
  return res.data.candles.map(c => ({
    open: parseFloat(c.mid.o),
    high: parseFloat(c.mid.h),
    low: parseFloat(c.mid.l),
    close: parseFloat(c.mid.c),
    time: c.time
  }));
}

async function getAccountInfo() {
  const url = `${BASE}/v3/accounts/${ACCOUNT}/summary`;
  const res = await http.get(url);
  const account = res.data.account;
  return {
    balance: parseFloat(account.balance),
    equity: parseFloat(account.NAV),
    unrealizedPL: parseFloat(account.unrealizedPL),
    currency: account.currency
  };
}

async function getOpenPositions() {
  const url = `${BASE}/v3/accounts/${ACCOUNT}/openTrades`;
  const res = await http.get(url);
  return res.data.trades
    .filter(t => t.instrument === INSTRUMENT)
    .map(t => ({
      id: t.id,
      instrument: t.instrument,
      type: parseFloat(t.currentUnits) > 0 ? 'BUY' : 'SELL',
      units: Math.abs(parseFloat(t.currentUnits)),
      openPrice: parseFloat(t.price),
      unrealizedProfit: parseFloat(t.unrealizedPL),
      stopLoss:   t.stopLossOrder   ? parseFloat(t.stopLossOrder.price)   : null,
      takeProfit: t.takeProfitOrder ? parseFloat(t.takeProfitOrder.price) : null
    }));
}

async function getCurrentPrice(instrument = INSTRUMENT) {
  const url = `${BASE}/v3/accounts/${ACCOUNT}/pricing?instruments=${instrument}`;
  const res = await http.get(url);
  const price = res.data.prices[0];
  return {
    bid: parseFloat(price.bids[0].price),
    ask: parseFloat(price.asks[0].price),
    mid: (parseFloat(price.bids[0].price) + parseFloat(price.asks[0].price)) / 2
  };
}

module.exports = { getCandles, getCandles15m, getCandles4h, getAccountInfo, getOpenPositions, getCurrentPrice };