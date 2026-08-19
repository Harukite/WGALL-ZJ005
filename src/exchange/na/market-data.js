import { createNadoClient } from '@nadohq/client';
import { CHAIN_ENV_TO_CHAIN } from '@nadohq/shared';
import { createPublicClient, http } from 'viem';
import { normalizeCandles } from '../common/market-data.js';

const CHAIN_ENV_BY_NETWORK = {
  'ink-mainnet': 'inkMainnet',
  'ink-testnet': 'inkTestnet',
  inkmainnet: 'inkMainnet',
  inktestnet: 'inkTestnet',
  mainnet: 'inkMainnet',
  testnet: 'inkTestnet',
};
const clientCache = new Map();

function chainEnvFor(network) {
  return CHAIN_ENV_BY_NETWORK[String(network || 'ink-mainnet').toLowerCase()] || 'inkMainnet';
}

function publicClientFor({ network, rpcUrl }) {
  const chainEnv = chainEnvFor(network);
  const chain = CHAIN_ENV_TO_CHAIN[chainEnv];
  if (!chain) throw new Error('Nado SDK 不支持链环境 ' + chainEnv);
  const rpc = rpcUrl || chain.rpcUrls.default.http[0];
  const key = chainEnv + ':' + rpc;
  if (!clientCache.has(key)) {
    const publicClient = createPublicClient({ chain, transport: http(rpc) });
    clientCache.set(key, createNadoClient(chainEnv, { publicClient }));
  }
  return clientCache.get(key);
}

function productIdFor(exchange, market) {
  return Math.max(1, Number(exchange?.productId || market?.remoteProductId || 2));
}

function periodFor(intervalSec) {
  return ({
    60: 60,
    300: 300,
    900: 900,
    3600: 3600,
    14400: 14400,
    86400: 86400,
  })[Number(intervalSec)] || 3600;
}

export async function fetchNadoPrice({ exchange, market }) {
  const client = publicClientFor({ network: exchange?.network, rpcUrl: exchange?.rpcUrl });
  const productId = productIdFor(exchange, market);
  try {
    const prices = await client.perp.getPerpPrices({ productId });
    const mark = Number(prices?.markPrice);
    if (mark > 0) return mark;
  } catch { /* fall through to public BBO */ }
  const book = await client.market.getLatestMarketPrice({ productId });
  const bid = Number(book?.bid);
  const ask = Number(book?.ask);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
  if (!(mid > 0)) throw new Error('Nado 返回无效公开价格');
  return mid;
}

export async function fetchNadoCandles({ exchange, market, intervalSec = 3600, count = 200 }) {
  const client = publicClientFor({ network: exchange?.network, rpcUrl: exchange?.rpcUrl });
  const rows = await client.market.getCandlesticks({
    productId: productIdFor(exchange, market),
    period: periodFor(intervalSec),
    limit: Math.max(1, Math.min(500, Number(count) || 200)),
  });
  return normalizeCandles(rows);
}
