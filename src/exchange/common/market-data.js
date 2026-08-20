const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchPublicJson(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options;
  const response = await fetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const error = new Error('HTTP ' + response.status + ' ' + url);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function numberValue(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function candleTime(value) {
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return Date.parse(value);
  const n = numberValue(value);
  if (!(n > 0)) return NaN;
  return n < 1e12 ? n * 1000 : n;
}

export function normalizeCandles(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const tuple = Array.isArray(row);
    const time = candleTime(tuple ? row[0] : row?.time ?? row?.timestamp ?? row?.ts ?? row?.t ?? row?.T);
    const open = numberValue(tuple ? row[1] : row?.open ?? row?.o);
    const high = numberValue(tuple ? row[2] : row?.high ?? row?.h);
    const low = numberValue(tuple ? row[3] : row?.low ?? row?.l);
    const close = numberValue(tuple ? row[4] : row?.close ?? row?.c);
    const volume = numberValue(tuple ? row[5] : row?.volume ?? row?.v, 0);
    if (!(time > 0) || !(open > 0) || !(close > 0) || !(high > 0) || !(low > 0)) continue;
    out.push({
      time,
      open,
      high: Math.max(open, high, close),
      low: Math.min(open, low, close),
      close,
      volume: volume >= 0 ? volume : 0,
    });
  }
  const unique = new Map(out.map((candle) => [candle.time, candle]));
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

export function aggregateCandles(rows, intervalSec, count = 200) {
  const candles = normalizeCandles(rows);
  const interval = Math.max(1, Number(intervalSec) || 3600) * 1000;
  const grouped = new Map();
  for (const candle of candles) {
    const bucket = Math.floor(candle.time / interval) * interval;
    const current = grouped.get(bucket);
    if (!current) {
      grouped.set(bucket, { ...candle, time: bucket });
      continue;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  }
  const limit = Math.max(1, Math.min(500, Number(count) || 200));
  return [...grouped.values()].sort((a, b) => a.time - b.time).slice(-limit);
}

export function intervalName(intervalSec, fallback = '1h') {
  return ({
    60: '1m',
    300: '5m',
    900: '15m',
    1800: '30m',
    3600: '1h',
    7200: '2h',
    14400: '4h',
    86400: '1d',
  })[Number(intervalSec)] || fallback;
}
