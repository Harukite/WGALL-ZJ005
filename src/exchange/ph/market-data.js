import { fetchPublicJson, intervalName, normalizeCandles } from '../common/market-data.js';

const DEFAULT_API = 'https://perp-api.phoenix.trade';

function baseUrl(apiUrl) {
  return String(apiUrl || DEFAULT_API).replace(/\/$/, '');
}

export function phoenixSymbol(value) {
  return String(value || 'BTC').trim().toUpperCase().replace(/-USD$/, '').replace(/-PERP$/, '') || 'BTC';
}

export async function fetchPhoenixPrice({ apiUrl, symbol }) {
  const body = await fetchPublicJson(`${baseUrl(apiUrl)}/v1/market/${encodeURIComponent(phoenixSymbol(symbol))}/stats/latest`);
  const price = Number(body?.mark_price ?? body?.oracle_price ?? body?.last_price);
  if (!(price > 0)) throw new Error('Phoenix 返回无效公开价格');
  return price;
}

export async function fetchPhoenixCandles({ apiUrl, symbol, intervalSec = 3600, count = 200 }) {
  const query = new URLSearchParams({
    timeframe: intervalName(intervalSec),
    limit: String(Math.max(1, Math.min(500, Number(count) || 200))),
  });
  const body = await fetchPublicJson(`${baseUrl(apiUrl)}/v1/candles/${encodeURIComponent(phoenixSymbol(symbol))}?${query}`);
  return normalizeCandles(Array.isArray(body) ? body : body?.candles);
}
