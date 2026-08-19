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
import { LiveVenueExchange, num, roundToStep, sleep, stableId } from '../common/live.js';
import { fetchNadoCandles } from './market-data.js';

const CHAIN_ENV_BY_NETWORK = {
  'ink-mainnet': 'inkMainnet',
  'ink-testnet': 'inkTestnet',
  inkmainnet: 'inkMainnet',
  inktestnet: 'inkTestnet',
  mainnet: 'inkMainnet',
  testnet: 'inkTestnet',
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

function chainEnvFor(network) {
  const key = String(network || 'ink-mainnet').trim().toLowerCase();
  const chainEnv = CHAIN_ENV_BY_NETWORK[key];
  if (!chainEnv) throw new Error('Nado 不支持 network=' + network + '，拒绝 LIVE 初始化');
  return chainEnv;
}

function requireExecutionSuccess(result, action) {
  if (result?.status === 'success') return;
  const error = new Error('Nado ' + action + '结果未知：' + (result?.error || '缺少 success 状态'));
  error.receiptKnown = result?.status === 'failure';
  if (error.receiptKnown) error.message = 'Nado ' + action + '失败：' + (result.error || '未知错误');
  throw error;
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
    this.orderDiscoveryPollMs = Math.max(0, Number(opts.orderDiscoveryPollMs ?? 300));
    this.orderDiscoveryAttempts = Math.max(1, Math.floor(Number(opts.orderDiscoveryAttempts ?? 6)));
    this.client = null;
    this.address = '';
    this.chain = null;
    this.chainEnv = chainEnvFor(this.network);
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
      const digest = stableId(order.digest);
      if (!digest) {
        throw new Error('Nado 权威挂单快照缺少稳定 digest，拒绝继续交易');
      }
      openOrders.push({
        orderId: digest,
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

  async _findPlacedOrder(marketId, orderId) {
    for (let attempt = 0; attempt < this.orderDiscoveryAttempts; attempt++) {
      const snapshot = await this._refreshMarket(marketId);
      const placed = snapshot.openOrders.find((row) => String(row.orderId) === String(orderId));
      if (placed) return placed;
      if (attempt + 1 < this.orderDiscoveryAttempts && this.orderDiscoveryPollMs) {
        await sleep(this.orderDiscoveryPollMs);
      }
    }
    return null;
  }

  async placeLimitOrder(order) {
    const client = this._ensure();
    this._assertNoPendingPlacements('下单');
    if (order.reduceOnly) {
      throw new Error('Nado 仅支持 taker reduce-only；当前网格的 reduce-only 限价腿不能安全映射，已拒绝下单');
    }
    const price = roundToStep(order.price, PRICE_INC);
    const size = roundToStep(order.sizeBase, SIZE_INC, 'down');
    if (!(price > 0) || !(size >= SIZE_INC)) throw new Error('Nado 订单精度或数量不足');
    const before = await this._refreshMarket(order.marketId);
    const liveMid = Number(before.price) || await this._mid();
    if ((order.side === 'sell' && price <= liveMid) || (order.side === 'buy' && price >= liveMid)) {
      throw new Error('Nado PostOnly 订单穿价，等待下一轮行情');
    }
    const signedAmount = order.side === 'buy' ? addDecimals(size) : addDecimals(-size);
    const placedOrder = { ...order, marketId: Number(order.marketId), price, sizeBase: size };
    const write = this._beginPendingWrite('place', {
      marketId: Number(order.marketId),
      price,
      sizeBase: size,
      order: placedOrder,
    });
    try {
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
      requireExecutionSuccess(result, '下单');
      const directId = result?.data?.digest ?? result?.digest ?? result?.orderId ?? result?.id;
      if (!directId) {
        const error = new Error('Nado 下单回执缺少 digest，结果未知，等待人工/权威核验');
        error.pending = true;
        error.writeId = write.id;
        throw error;
      }
      write.orderId = String(directId);
      const authoritative = await this._findPlacedOrder(order.marketId, write.orderId);
      if (!authoritative) {
        const error = new Error('Nado 交易已确认但权威挂单列表暂未发现 digest=' + write.orderId);
        error.pending = true;
        error.writeId = write.id;
        throw error;
      }
      const placed = this._registerPlaced(write.orderId, {
        ...placedOrder,
        price: authoritative.price,
        sizeBase: authoritative.sizeBase,
      });
      this._finishPendingWrite(write);
      return placed;
    } catch (error) {
      if (error?.receiptKnown) {
        this._finishPendingWrite(write);
      } else if (!error?.pending) {
        error.pending = true;
        error.writeId = write.id;
      } else {
        error.writeId = error.writeId || write.id;
      }
      throw error;
    }
  }

  async placeLimitOrders(orders) {
    const results = [];
    for (const order of orders) results.push(await this.placeLimitOrder(order));
    return results;
  }

  async cancelOrder(marketId, orderId) {
    const client = this._ensure();
    this._assertNoPendingPlacements('撤单');
    const write = this._beginPendingWrite('cancel', { marketId: Number(marketId), orderId: String(orderId) });
    try {
      const result = await client.market.cancelOrders({
        digests: [String(orderId)],
        productIds: [this.productId],
        subaccountName: this.subaccountName,
      });
      requireExecutionSuccess(result, '撤单');
      this._finishPendingWrite(write);
    } catch (error) {
      if (error?.receiptKnown) this._finishPendingWrite(write);
      else {
        error.pending = true;
        error.writeId = write.id;
      }
      throw error;
    }
    this._markCancelled(orderId);
    return true;
  }

  async cancelAll(marketId) {
    const client = this._ensure();
    this._assertNoPendingPlacements('撤销全部挂单');
    const before = await this._refreshMarket(marketId);
    const orderIds = before.openOrders.map((order) => String(order.orderId));
    const write = this._beginPendingWrite('cancelAll', { marketId: Number(marketId), orderIds });
    try {
      const result = await client.market.cancelProductOrders({
        productIds: [this.productId],
        subaccountName: this.subaccountName,
      });
      requireExecutionSuccess(result, '撤销全部挂单');
      this._finishPendingWrite(write);
    } catch (error) {
      if (error?.receiptKnown) this._finishPendingWrite(write);
      else {
        error.pending = true;
        error.writeId = write.id;
      }
      throw error;
    }
    this._markMarketCancelled(marketId);
    return true;
  }

  async closePosition(marketId) {
    const client = this._ensure();
    this._assertNoPendingPlacements('平仓');
    const snapshot = await this._refreshMarket(marketId);
    const position = Number(snapshot.position?.sizeBase || 0);
    if (!position) return true;
    const mid = Number(snapshot.price || await this._mid());
    const size = roundToStep(Math.abs(position), SIZE_INC, 'down');
    const amount = position > 0 ? addDecimals(-size) : addDecimals(size);
    const write = this._beginPendingWrite('closePosition', { marketId: Number(marketId) });
    try {
      const result = await client.market.placeOrder({
        productId: this.productId,
        order: {
          subaccountName: this.subaccountName,
          price: roundToStep(position > 0 ? mid * 0.998 : mid * 1.002, PRICE_INC),
          amount,
          expiration: nowInSeconds() + 120,
          appendix: packOrderAppendix({ orderExecutionType: 'ioc', reduceOnly: true }),
        },
      });
      requireExecutionSuccess(result, '平仓');
      this._finishPendingWrite(write);
    } catch (error) {
      if (error?.receiptKnown) this._finishPendingWrite(write);
      else if (!error?.pending) {
        error.pending = true;
        error.writeId = write.id;
      } else {
        error.writeId = error.writeId || write.id;
      }
      throw error;
    }
    return true;
  }
}
