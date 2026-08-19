import { fetchPublicJson, intervalName, normalizeCandles } from '../common/market-data.js';

const DEFAULT_API = 'https://api.popdex.xyz';

function baseUrl(apiUrl) {
  return String(apiUrl || DEFAULT_API).replace(/\/$/, '');
}

async function fetchPopdexData(url) {
  const body = await fetchPublicJson(url);
  if (String(body?.code) !== '200') throw new Error('PopDEX 公开行情失败：' + (body?.msg || JSON.stringify(body).slice(0, 160)));
  return body.data;
}

function tickerFor(rows, symbol) {
  const list = Array.isArray(rows) ? rows : [];
  return list.find((row) => String(row?.symbol || '').toUpperCase() === String(symbol).toUpperCase()) || list[0];
}

export async function fetchPopdexPrice({ apiUrl, symbol = 'BTCUSDT' }) {
  const rows = await fetchPopdexData(`${baseUrl(apiUrl)}/api/v1/public/market/tickers?category=Futures&symbol=${encodeURIComponent(symbol)}`);
  const ticker = tickerFor(rows, symbol);
  if (!ticker) throw new Error('PopDEX 无公开 ticker ' + symbol);
  const bid = Number(ticker.bid1Price);
  const ask = Number(ticker.ask1Price);
  const mark = Number(ticker.markPrice);
  const last = Number(ticker.lastPrice);
  const price = bid > 0 && ask > 0 ? (bid + ask) / 2 : mark > 0 ? mark : last;
  if (!(price > 0)) throw new Error('PopDEX 返回无效公开价格');
  return price;
}

export async function fetchPopdexCandles({ apiUrl, symbol = 'BTCUSDT', intervalSec = 3600, count = 200 }) {
  const query = new URLSearchParams({
    category: 'Futures',
    symbol,
    interval: intervalName(intervalSec),
    limit: String(Math.max(1, Math.min(500, Number(count) || 200))),
  });
  const rows = await fetchPopdexData(`${baseUrl(apiUrl)}/api/v1/public/market/candles?${query}`);
  return normalizeCandles(rows);
}
