import { aggregateCandles, fetchPublicJson, normalizeCandles } from '../common/market-data.js';

const DEFAULT_API = 'https://zo-mainnet.n1.xyz';
const DEFAULT_MARKET_ID = 0;
// N1's documented public history endpoint is hourly only. Keep the real
// hourly series instead of manufacturing finer-grained candles when the UI
// requests 1m/5m/15m.

function baseUrl(apiUrl) {
  return String(apiUrl || DEFAULT_API).replace(/\/$/, '');
}

export async function fetchN1Price({ apiUrl, remoteMarketId = DEFAULT_MARKET_ID }) {
  const body = await fetchPublicJson(`${baseUrl(apiUrl)}/market/${Number(remoteMarketId)}/live`);
  const bid = Number(body?.clob?.bestBidPrice);
  const ask = Number(body?.clob?.bestAskPrice);
  const mark = Number(body?.perpetuals?.markPrice);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : mark;
  if (!(mid > 0)) throw new Error('N1 返回无效公开价格');
  return mid;
}

export async function fetchN1Candles({ apiUrl, remoteMarketId = DEFAULT_MARKET_ID, intervalSec = 3600, count = 200 }) {
  const body = await fetchPublicJson(`${baseUrl(apiUrl)}/market/${Number(remoteMarketId)}/history/PT1H?pageSize=200`);
  const items = Array.isArray(body?.items) ? [...body.items].reverse() : [];
  let previous = 0;
  const rows = items.map((item) => {
    const close = Number(item?.markPrice ?? item?.indexPrice);
    if (!(close > 0)) return null;
    const open = previous > 0 ? previous : close;
    const index = Number(item?.indexPrice);
    previous = close;
    return {
      time: item?.time,
      open,
      high: Math.max(open, close, index > 0 ? index : close),
      low: Math.min(open, close, index > 0 ? index : close),
      close,
      volume: 0,
    };
  }).filter(Boolean);
  return aggregateCandles(normalizeCandles(rows), intervalSec, count);
}
