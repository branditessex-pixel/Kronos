const fs   = require('fs');
const path = require('path');

// On Railway, DATA_DIR is set to the mounted volume path (e.g. /data).
// Locally it falls back to __dirname so development is unaffected.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const logFile = path.join(DATA_DIR, 'trading-log.json');

function safeAppend(line) {
  let attempts = 0;
  while (attempts < 3) {
    try {
      fs.appendFileSync(logFile, line, 'utf8');
      return true;
    } catch (err) {
      attempts++;
      if (attempts >= 3) throw err;
      const until = Date.now() + 100;
      while (Date.now() < until) {}
    }
  }
}

function logMessage(message) {
  const entry = {
    timestamp:  new Date().toISOString(),
    bot:        'Silver Trader',
    instrument: 'XAG/USD',
    message
  };
  console.log(`[Silver Trader] ${entry.timestamp} — ${message}`);
  writeLog(entry);
}

function writeLog(entry) {
  try {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    safeAppend(line);
  } catch (err) {
    process.stderr.write(`[SILVER LOG WRITE FAILED] ${err.message} | ${JSON.stringify(entry)}\n`);
  }
}

function readLog() {
  try {
    if (!fs.existsSync(logFile)) return [];
    const raw = fs.readFileSync(logFile, 'utf8').trim();
    if (!raw) return [];
    if (raw.startsWith('[')) return JSON.parse(raw);
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    process.stderr.write(`[SILVER LOG READ FAILED] ${err.message}\n`);
    return [];
  }
}

module.exports = { logMessage, writeLog, readLog };
