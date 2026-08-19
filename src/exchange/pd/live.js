import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  pad,
  parseUnits,
  stringToHex,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LiveVenueExchange, num, roundToStep, sleep } from '../common/live.js';
import { fetchPopdexCandles } from './market-data.js';

const DEFAULT_API = 'https://api.popdex.xyz';
const ORDER_CONTRACT = '0x0000000000000000000000000000000000001000';
const CHAIN_ID = 0x888;
const DEFAULT_SYMBOL = 'BTCUSDT';
const DEFAULT_SYMBOL_ID = 20_000;
const CATEGORY_FUTURES = 2;
const ORDER_TYPE_LIMIT = 0;
const ORDER_TYPE_MARKET = 1;
const SIDE_BUY = 0;
const SIDE_SELL = 1;
const TIF_IOC = 2;
const TIF_POST_ONLY = 4;
const MARKET_UNIT_BASE = 0;
const POSITION_NONE = 0;
const ORDER_CATEGORY_REGULAR = 0;

const placeAbi = [{
  type: 'function',
  name: 'placeOrder',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'account', type: 'address' },
    { name: 'clientOrderId', type: 'bytes32' },
    { name: 'symbolId', type: 'uint16' },
    { name: 'orderParams', type: 'bytes32' },
    { name: 'price', type: 'uint256' },
    { name: 'qty', type: 'uint256' },
    { name: 'slippage', type: 'uint256' },
    { name: 'builder', type: 'address' },
    { name: 'builderFeeRate', type: 'uint256' },
  ],
  outputs: [{ name: 'success', type: 'bool' }],
}];

const cancelAbi = [{
  type: 'function',
  name: 'cancelOrder',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'account', type: 'address' },
    { name: 'orderId', type: 'uint128' },
    { name: 'clientOrderId', type: 'bytes32' },
  ],
  outputs: [{ name: 'success', type: 'bool' }],
}];

const cancelAllAbi = [{
  type: 'function',
  name: 'cancelAllOrders',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'account', type: 'address' },
    { name: 'symbolId', type: 'uint16' },
    {
      name: 'category',
      type: 'tuple',
      components: [{ name: 'isSome', type: 'bool' }, { name: 'value', type: 'uint8' }],
    },
    {
      name: 'orderCategory',
      type: 'tuple',
      components: [{ name: 'isSome', type: 'bool' }, { name: 'value', type: 'uint8' }],
    },
    {
      name: 'isFullPositionTpsl',
      type: 'tuple',
      components: [{ name: 'isSome', type: 'bool' }, { name: 'value', type: 'bool' }],
    },
  ],
  outputs: [{ name: 'success', type: 'bool' }],
}];

function packOrderParams({ orderType, side, timeInForce, isReduceOnly = 0 }) {
  const bytes = new Uint8Array(32);
  bytes[0] = CATEGORY_FUTURES;
  bytes[1] = orderType;
  bytes[2] = side;
  bytes[3] = timeInForce;
  bytes[4] = MARKET_UNIT_BASE;
  bytes[6] = isReduceOnly ? 1 : 0;
  bytes[7] = POSITION_NONE;
  return toHex(bytes);
}

function clientOrderId(label) {
  return pad(stringToHex(String(label).slice(0, 31)), { size: 32, dir: 'right' });
}

function loadPrivateKey(privateKey, keyPath) {
  let raw = String(privateKey || '').trim();
  if (!raw && keyPath && fs.existsSync(keyPath)) raw = fs.readFileSync(keyPath, 'utf8').trim();
  if (!raw) throw new Error('缺少 POPDEX_PRIVATE_KEY（或 secrets/popdex.key）');
  return (raw.startsWith('0x') ? raw : '0x' + raw);
}

const popdexChain = defineChain({
  id: CHAIN_ID,
  name: 'PopDEX',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_API + '/api/v1/web3/rpc'] } },
});

export class PopdexExchange extends LiveVenueExchange {
  constructor(opts = {}) {
    super({
      ...opts,
      venue: 'pd',
      apiUrl: opts.apiUrl || DEFAULT_API,
      pollMs: opts.pollMs || 3000,
      feeRate: opts.feeRate ?? 0.0005,
    });
    this.symbol = opts.symbol || DEFAULT_SYMBOL;
    this.symbolId = DEFAULT_SYMBOL_ID;
    this.tickSize = 1;
    this.lotSize = 0.0001;
    this.minQty = 0.0001;
    this.minNotional = 10;
    this.privateKey = opts.privateKey || '';
    this.keyPath = opts.keyPath || path.resolve(process.cwd(), 'secrets', 'popdex.key');
    this.account = null;
    this.address = '';
    this.wallet = null;
    this.pub = null;
    this.orderGapMs = Math.max(0, Number(opts.orderGapMs || 200));
  }

  async _apiGet(pathname) {
    const response = await fetch(this.apiUrl + pathname, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok || String(body?.code) !== '200') {
      throw new Error(pathname + ' => ' + response.status + ' ' + (body?.msg || JSON.stringify(body).slice(0, 180)));
    }
    return body.data;
  }

  async _rpc(method, params = []) {
    const response = await fetch(this.apiUrl + '/api/v1/web3/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    if (body?.error) throw new Error('PopDEX RPC ' + method + ': ' + JSON.stringify(body.error));
    return body?.result;
  }

  async init() {
    this.symbol = String(this.symbol || DEFAULT_SYMBOL).trim() || DEFAULT_SYMBOL;
    try {
      const config = await this._apiGet('/api/v1/config/symbol?symbol=' + encodeURIComponent(this.symbol) + '&category=Futures');
      this.symbolId = Math.max(1, num(config?.symbolId, DEFAULT_SYMBOL_ID));
      this.tickSize = num(config?.tickSize, 1) || 1;
      this.lotSize = num(config?.lotSize, 0.0001) || 0.0001;
      this.minQty = num(config?.minQty, this.lotSize) || this.lotSize;
      this.minNotional = num(config?.minNotional, 10) || 10;
    } catch (error) {
      this.lastError = 'PopDEX symbol 配置读取失败，使用保守默认值：' + (error?.message || error);
    }
    const account = privateKeyToAccount(loadPrivateKey(this.privateKey, this.keyPath));
    this.account = account;
    this.address = account.address;
    const transport = custom({
      request: async ({ method, params }) => this._rpc(method, params || []),
    });
    this.wallet = createWalletClient({ account, chain: popdexChain, transport });
    this.pub = createPublicClient({ chain: popdexChain, transport });
    const price = await this._mid();
    this._setMarkets([{
      marketId: 1,
      name: this.symbol,
      displayName: this.symbol,
      symbol: this.symbol,
      lastPrice: price,
      stepSize: this.lotSize,
      stepPrice: this.tickSize,
      minOrderSize: this.minQty,
      minOrderNotional: this.minNotional,
      maxLeverage: 30,
    }], price);
    this._watch.add(1);
    await this._refreshMarket(1).then((snapshot) => this._applySnapshot(1, snapshot));
    this.start();
    console.log('[pd] address=' + this.address + ' symbol=' + this.symbol + ' id=' + this.symbolId);
    return true;
  }

  disconnect() {
    this.stop();
    this.dataSource = null;
    this.lastOkAt = 0;
    this.account = null;
    this.wallet = null;
    this.pub = null;
    this.address = '';
  }

  async _mid() {
    const rows = await this._apiGet('/api/v1/public/market/tickers?category=Futures&symbol=' + encodeURIComponent(this.symbol));
    const list = Array.isArray(rows) ? rows : [];
    const ticker = list.find((row) => String(row.symbol || '').toUpperCase() === this.symbol.toUpperCase()) || list[0];
    if (!ticker) throw new Error('PopDEX 无 ticker ' + this.symbol);
    const bid = num(ticker.bid1Price), ask = num(ticker.ask1Price);
    const mark = num(ticker.markPrice), last = num(ticker.lastPrice);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : mark > 0 ? mark : last;
    if (!(mid > 0)) throw new Error('PopDEX 返回无效 mid');
    return mid;
  }

  async getCandles(marketId, intervalSec = 3600, count = 200) {
    return fetchPopdexCandles({
      apiUrl: this.apiUrl,
      symbol: this.symbol,
      intervalSec,
      count,
    });
  }

  async _refreshMarket(_marketId) {
    const mid = await this._mid();
    const [overview, positions, orders] = await Promise.all([
      this._apiGet('/api/v1/account/' + this.address + '/overview'),
      this._apiGet('/api/v1/account/' + this.address + '/positions'),
      this._apiGet('/api/v1/account/' + this.address + '/orders?status=pending&category=Futures&symbol=' + encodeURIComponent(this.symbol)),
    ]);
    if (!overview || !Array.isArray(positions) || !Array.isArray(orders)) {
      throw new Error('PopDEX 账户/持仓/挂单快照格式无效，拒绝继续交易');
    }
    let position = 0;
    let unrealizedPnl = 0;
    let entryPrice = 0;
    for (const row of positions || []) {
      if (String(row.symbol || '').toUpperCase() !== this.symbol.toUpperCase()) continue;
      const size = num(row.holdQty ?? row.size ?? row.holdSize ?? row.qty ?? row.positionSize);
      const side = String(row.side || row.positionSide || '').toLowerCase();
      position += side.includes('short') || side === 'sell' ? -Math.abs(size) : row.size != null && Number(row.size) < 0 ? Number(row.size) : Math.abs(size);
      entryPrice = num(row.avgPrice ?? row.entryPrice ?? row.avgEntryPrice);
      const upl = num(row.unPnl ?? row.unrealizedPnl ?? row.upl ?? row.unrealizedProfit, NaN);
      if (Number.isFinite(upl)) unrealizedPnl += upl;
    }
    const openOrders = [];
    for (const row of orders || []) {
      const remaining = num(row.remainingQty ?? row.qty);
      const price = roundToStep(row.price, this.tickSize);
      if (!(remaining > 0) || !(price > 0)) continue;
      openOrders.push({
        orderId: String(row.orderId || row.clientOid || ''),
        clientOid: String(row.clientOid || ''),
        side: String(row.side || '').toLowerCase().startsWith('s') ? 'sell' : 'buy',
        price,
        sizeBase: remaining,
      });
    }
    const equity = num(overview?.accountEquity, NaN);
    return {
      price: mid,
      balance: Number.isFinite(equity) && equity > 0 ? equity : undefined,
      equity: Number.isFinite(equity) && equity > 0 ? equity : undefined,
      position: position ? { sizeBase: position, entryPrice, unrealizedPnl } : null,
      openOrders: openOrders.filter((row) => row.orderId),
    };
  }

  async setLeverage() {
    this.emit('error', new Error('PopDEX 当前适配器未发现可验证的统一杠杆设置接口，沿用交易所当前杠杆'));
    return false;
  }

  _roundSize(size, price) {
    let result = roundToStep(size, this.lotSize, 'down');
    const minByNotional = price > 0 ? Math.ceil(this.minNotional / price / this.lotSize) * this.lotSize : this.minQty;
    if (result > 0 && result < Math.max(this.minQty, minByNotional)) result = Math.max(this.minQty, minByNotional);
    return Number(result.toFixed(8));
  }

  async _send(data, gas = 500_000n) {
    if (!this.wallet || !this.pub || !this.account) throw new Error('PopDEX 未连接');
    const hash = await this.wallet.sendTransaction({
      to: ORDER_CONTRACT,
      data,
      value: 0n,
      gas,
      gasPrice: 0n,
    });
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      const receipt = await this.pub.getTransactionReceipt({ hash }).catch(() => null);
      if (!receipt) continue;
      if (receipt.status !== 'success') throw new Error('PopDEX 交易回滚 ' + hash);
      return hash;
    }
    throw new Error('PopDEX 交易回执超时，未确认写入结果：' + hash);
  }

  async _findPlacedOrder(order, clientOid, previousIds = new Set()) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const snapshot = await this._refreshMarket(order.marketId);
      const exact = snapshot.openOrders.find((row) => String(row.clientOid || '') === String(clientOid));
      const candidates = snapshot.openOrders
        .filter((row) => !previousIds.has(String(row.orderId)))
        .filter((row) => row.side === order.side && Math.abs(row.price - order.price) <= this.tickSize)
        .filter((row) => Math.abs(Number(row.sizeBase) - Number(order.sizeBase)) <= Math.max(this.lotSize, Number(order.sizeBase) * 0.01));
      if (exact) return exact;
      if (candidates.length === 1) return candidates[0];
      await sleep(400);
    }
    return null;
  }

  async placeLimitOrder(order) {
    const price = roundToStep(order.price, this.tickSize);
    const size = this._roundSize(order.sizeBase, price);
    if (!(price > 0) || !(size >= this.minQty)) throw new Error('PopDEX 订单精度或数量不足');
    const before = await this._refreshMarket(1);
    const liveMid = Number(before.price) || await this._mid();
    if ((order.side === 'sell' && price <= liveMid) || (order.side === 'buy' && price >= liveMid)) {
      throw new Error('PopDEX PostOnly 订单穿价，等待下一轮行情');
    }
    if (this.orderGapMs) await sleep(this.orderGapMs);
    const oid = clientOrderId('grid-' + Date.now().toString(36) + '-' + order.clientOrderId);
    const params = packOrderParams({
      orderType: ORDER_TYPE_LIMIT,
      side: order.side === 'buy' ? SIDE_BUY : SIDE_SELL,
      timeInForce: TIF_POST_ONLY,
      isReduceOnly: order.reduceOnly,
    });
    const data = encodeFunctionData({
      abi: placeAbi,
      functionName: 'placeOrder',
      args: [
        this.address,
        oid,
        this.symbolId,
        params,
        parseUnits(String(price), 18),
        parseUnits(String(size), 18),
        0n,
        '0x0000000000000000000000000000000000000000',
        0n,
      ],
    });
    await this._send(data);
    const previousIds = new Set(before.openOrders.map((row) => String(row.orderId)));
    const placed = await this._findPlacedOrder({ ...order, marketId: 1, price, sizeBase: size }, oid, previousIds);
    if (!placed?.orderId) throw new Error('PopDEX 交易已确认但 indexer 暂未发现真实订单，停止自动重发');
    return this._registerPlaced(placed.orderId, { ...order, price: placed.price, sizeBase: placed.sizeBase });
  }

  async placeLimitOrders(orders) {
    const results = [];
    for (const order of orders) results.push(await this.placeLimitOrder(order));
    return results;
  }

  async cancelOrder(marketId, orderId) {
    if (!/^\d+$/.test(String(orderId))) throw new Error('PopDEX 无效 orderId=' + orderId);
    const data = encodeFunctionData({
      abi: cancelAbi,
      functionName: 'cancelOrder',
      args: [this.address, BigInt(String(orderId)), pad('0x', { size: 32 })],
    });
    await this._send(data, 300_000n);
    this._markCancelled(orderId);
    return true;
  }

  async cancelAll(marketId) {
    const data = encodeFunctionData({
      abi: cancelAllAbi,
      functionName: 'cancelAllOrders',
      args: [
        this.address,
        this.symbolId,
        { isSome: true, value: CATEGORY_FUTURES },
        { isSome: true, value: ORDER_CATEGORY_REGULAR },
        { isSome: false, value: false },
      ],
    });
    await this._send(data, 400_000n);
    this._markMarketCancelled(marketId);
    return true;
  }

  async closePosition(marketId) {
    const snapshot = await this._refreshMarket(marketId);
    const position = Number(snapshot.position?.sizeBase || 0);
    if (!position) return true;
    const size = this._roundSize(Math.abs(position), Number(snapshot.price));
    const oid = clientOrderId('close-' + Date.now().toString(36));
    const params = packOrderParams({
      orderType: ORDER_TYPE_MARKET,
      side: position > 0 ? SIDE_SELL : SIDE_BUY,
      timeInForce: TIF_IOC,
      isReduceOnly: true,
    });
    const data = encodeFunctionData({
      abi: placeAbi,
      functionName: 'placeOrder',
      args: [
        this.address,
        oid,
        this.symbolId,
        params,
        0n,
        parseUnits(String(size), 18),
        parseUnits('0.01', 18),
        '0x0000000000000000000000000000000000000000',
        0n,
      ],
    });
    await this._send(data);
    return true;
  }
}
