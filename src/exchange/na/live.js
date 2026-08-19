import fs from 'node:fs';
import path from 'node:path';
import { createNadoClient } from '@nadohq/client';
import {
  CHAIN_ENV_TO_CHAIN,
  addDecimals,
  calcPerpBalanceValue,
  isPerpBalance,
  isSpotBalance,
  nowInSeconds,
  packOrderAppendix,
  removeDecimals,
} from '@nadohq/shared';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LiveVenueExchange, num, roundToStep, sleep } from '../common/live.js';
import { fetchNadoCandles } from './market-data.js';

const CHAIN_ENV_BY_NETWORK = {
  'ink-mainnet': 'inkMainnet',
  'ink-testnet': 'inkTestnet',
};
const DEFAULT_PRODUCT_ID = 2;
const INTERNAL_MARKET_ID = 1;
const SIZE_INC = 0.00005;
const PRICE_INC = 1;

function humanAmount(value) {
  const n = num(value);
  if (Math.abs(n) >= 1e12) return num(removeDecimals(value));
  return n;
}

function loadPrivateKey(privateKey, keyPath) {
  let raw = String(privateKey || '').trim();
  if (!raw && keyPath && fs.existsSync(keyPath)) raw = fs.readFileSync(keyPath, 'utf8').trim();
  if (!raw) throw new Error('缺少 NADO_PRIVATE_KEY（或 secrets/nado.key）');
  return (raw.startsWith('0x') ? raw : '0x' + raw);
}

export class NadoExchange extends LiveVenueExchange {
  constructor(opts = {}) {
    super({
      ...opts,
      venue: 'na',
      apiUrl: opts.apiUrl || 'https://app.nado.xyz',
      pollMs: opts.pollMs || 2500,
      feeRate: opts.feeRate ?? 0.0005,
    });
    this.rpcUrl = opts.rpcUrl || '';
    this.privateKey = opts.privateKey || '';
    this.keyPath = opts.keyPath || path.resolve(process.cwd(), 'secrets', 'nado.key');
    this.subaccountName = String(opts.subaccount || 'default').trim() || 'default';
    this.productId = Math.max(1, Number(opts.productId || DEFAULT_PRODUCT_ID));
    this.client = null;
    this.address = '';
    this.chain = null;
    this.chainEnv = CHAIN_ENV_BY_NETWORK[String(this.network || 'ink-mainnet').toLowerCase()] || 'inkMainnet';
  }

  async init() {
    this.chain = CHAIN_ENV_TO_CHAIN[this.chainEnv];
    if (!this.chain) throw new Error('Nado SDK 不支持链环境 ' + this.chainEnv);
    const rpc = this.rpcUrl || this.chain.rpcUrls.default.http[0] || 'https://rpc-gel.inkonchain.com';
    const publicClient = createPublicClient({ chain: this.chain, transport: http(rpc) });
    const account = privateKeyToAccount(loadPrivateKey(this.privateKey, this.keyPath));
    const walletClient = createWalletClient({ account, chain: this.chain, transport: http(rpc) });
    this.address = account.address;
    this.client = createNadoClient(this.chainEnv, {
      walletClient,
      publicClient,
    });
    const price = await this._mid();
    this._setMarkets([{
      marketId: INTERNAL_MARKET_ID,
      name: 'BTC-PERP',
      displayName: 'BTC-PERP',
      symbol: 'BTC',
      lastPrice: price,
      stepSize: SIZE_INC,
      stepPrice: PRICE_INC,
      minOrderSize: SIZE_INC,
      maxLeverage: 30,
    }], price);
    this._watch.add(INTERNAL_MARKET_ID);
    await this._refreshMarket(INTERNAL_MARKET_ID).then((snapshot) => this._applySnapshot(INTERNAL_MARKET_ID, snapshot));
    this.start();
    console.log('[na] address=' + this.address + ' subaccount=' + this.subaccountName + ' productId=' + this.productId);
    return true;
  }

  disconnect() {
    this.stop();
    this.dataSource = null;
    this.lastOkAt = 0;
    this.client = null;
    this.address = '';
  }

  _ensure() {
    if (!this.client || !this.address) throw new Error('Nado 实盘未连接');
    return this.client;
  }

  async getCandles(marketId, intervalSec = 3600, count = 200) {
    return fetchNadoCandles({
      exchange: this,
      market: this.markets.get(Number(marketId)),
      intervalSec,
      count,
    });
  }

  async _mid() {
    const client = this._ensure();
    try {
      const prices = await client.perp.getPerpPrices({ productId: this.productId });
      const mark = num(prices?.markPrice);
      if (mark > 0) return mark;
    } catch { /* fall through to BBO */ }
    const book = await client.market.getLatestMarketPrice({ productId: this.productId });
    const bid = num(book?.bid);
    const ask = num(book?.ask);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
    if (!(mid > 0)) throw new Error('Nado 返回无效 mid');
    return mid;
  }

  async _refreshMarket(_marketId) {
    const client = this._ensure();
    const mid = await this._mid();
    const [summary, ordersResponse] = await Promise.all([
      client.subaccount.getSubaccountSummary({
        subaccountOwner: this.address,
        subaccountName: this.subaccountName,
      }),
      client.market.getOpenSubaccountOrders({
        subaccountOwner: this.address,
        subaccountName: this.subaccountName,
        productId: this.productId,
      }),
    ]);
    if (!summary || !Array.isArray(summary.balances) || !ordersResponse || !Array.isArray(ordersResponse.orders)) {
      throw new Error('Nado 账户/挂单快照格式无效，拒绝继续交易');
    }
    let position = 0;
    let unrealizedPnl = 0;
    let quoteBalance = 0;
    for (const balance of summary?.balances || []) {
      if (isSpotBalance(balance) && balance.productId === 0) quoteBalance += humanAmount(balance.amount);
      if (isPerpBalance(balance) && balance.productId === this.productId) {
        position = humanAmount(balance.amount);
        try { unrealizedPnl = humanAmount(calcPerpBalanceValue(balance)); } catch { /* optional */ }
      }
    }
    const health = humanAmount(summary?.health?.unweighted?.health);
    const equity = health > 0 ? health : quoteBalance + unrealizedPnl;
    const openOrders = [];
    for (const order of ordersResponse?.orders || []) {
      const unfilled = humanAmount(order.unfilledAmount);
      if (!unfilled) continue;
      const price = roundToStep(humanAmount(order.price) || num(order.price), PRICE_INC);
      if (!(price > 0)) continue;
      openOrders.push({
        orderId: String(order.digest),
        side: unfilled > 0 ? 'buy' : 'sell',
        price,
        sizeBase: Math.abs(unfilled),
      });
    }
    return {
      price: mid,
      balance: equity > 0 ? equity : undefined,
      equity: equity > 0 ? equity : undefined,
      position: position ? { sizeBase: position, entryPrice: 0, unrealizedPnl } : null,
      openOrders,
    };
  }

  async setLeverage() {
    this.emit('error', new Error('Nado 当前适配器未发现可验证的统一杠杆设置接口，沿用交易所当前杠杆'));
    return false;
  }

  async placeLimitOrder(order) {
    const client = this._ensure();
    if (order.reduceOnly) {
      throw new Error('Nado 仅支持 taker reduce-only；当前网格的 reduce-only 限价腿不能安全映射，已拒绝下单');
    }
    const price = roundToStep(order.price, PRICE_INC);
    const size = roundToStep(order.sizeBase, SIZE_INC, 'down');
    if (!(price > 0) || !(size >= SIZE_INC)) throw new Error('Nado 订单精度或数量不足');
    const liveMid = await this._mid();
    if ((order.side === 'sell' && price <= liveMid) || (order.side === 'buy' && price >= liveMid)) {
      throw new Error('Nado PostOnly 订单穿价，等待下一轮行情');
    }
    const signedAmount = order.side === 'buy' ? addDecimals(size) : addDecimals(-size);
    const result = await client.market.placeOrder({
      productId: this.productId,
      order: {
        subaccountName: this.subaccountName,
        price,
        amount: signedAmount,
        expiration: nowInSeconds() + 86400 * 28,
        appendix: packOrderAppendix({
          orderExecutionType: 'post_only',
          reduceOnly: !!order.reduceOnly,
        }),
      },
    });
    if (result?.status === 'failure') throw new Error('Nado 下单失败：' + (result.error || '未知错误'));
    const directId = result?.data?.digest ?? result?.digest ?? result?.orderId ?? result?.id;
    if (!directId) throw new Error('Nado 下单回执缺少 digest，拒绝按模糊条件绑定订单');
    return this._registerPlaced(String(directId), { ...order, price, sizeBase: size });
  }

  async placeLimitOrders(orders) {
    const results = [];
    for (const order of orders) results.push(await this.placeLimitOrder(order));
    return results;
  }

  async cancelOrder(marketId, orderId) {
    const client = this._ensure();
    await client.market.cancelOrders({
      digests: [String(orderId)],
      productIds: [this.productId],
      subaccountName: this.subaccountName,
    });
    this._markCancelled(orderId);
    return true;
  }

  async cancelAll(marketId) {
    const client = this._ensure();
    await client.market.cancelProductOrders({
      productIds: [this.productId],
      subaccountName: this.subaccountName,
    });
    this._markMarketCancelled(marketId);
    return true;
  }

  async closePosition(marketId) {
    const client = this._ensure();
    const snapshot = await this._refreshMarket(marketId);
    const position = Number(snapshot.position?.sizeBase || 0);
    if (!position) return true;
    const mid = Number(snapshot.price || await this._mid());
    const size = roundToStep(Math.abs(position), SIZE_INC, 'down');
    const amount = position > 0 ? addDecimals(-size) : addDecimals(size);
    await client.market.placeOrder({
      productId: this.productId,
      order: {
        subaccountName: this.subaccountName,
        price: roundToStep(position > 0 ? mid * 0.998 : mid * 1.002, PRICE_INC),
        amount,
        expiration: nowInSeconds() + 120,
        appendix: packOrderAppendix({ orderExecutionType: 'ioc', reduceOnly: true }),
      },
    });
    return true;
  }
}
