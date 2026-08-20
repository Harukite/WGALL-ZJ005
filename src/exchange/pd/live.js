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
import { LiveVenueExchange, num, roundToStep, sleep, stableId } from '../common/live.js';
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

function isNumericOrderId(value) {
  return /^\d+$/.test(String(value ?? '').trim());
}

function isBytes32(value) {
  return /^0x[0-9a-f]{64}$/i.test(String(value ?? '').trim());
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
    this.orderGapMs = Number.isFinite(Number(opts.orderGapMs)) ? Math.max(0, Number(opts.orderGapMs)) : 200;
    this.receiptPollMs = Number.isFinite(Number(opts.receiptPollMs)) ? Math.max(0, Number(opts.receiptPollMs)) : 400;
    this.receiptPollAttempts = Math.max(1, Math.floor(Number.isFinite(Number(opts.receiptPollAttempts)) ? Number(opts.receiptPollAttempts) : 30));
    this.orderDiscoveryPollMs = Number.isFinite(Number(opts.orderDiscoveryPollMs)) ? Math.max(0, Number(opts.orderDiscoveryPollMs)) : 400;
    this.orderDiscoveryAttempts = Math.max(1, Math.floor(Number.isFinite(Number(opts.orderDiscoveryAttempts)) ? Number(opts.orderDiscoveryAttempts) : 12));
    this._pendingTransactions = new Map();
    this._pendingOrders = new Map();
    this._orderClientOids = new Map();
    this._ownedOrderIds = new Set();
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
      const symbolId = num(config?.symbolId, NaN);
      const tickSize = num(config?.tickSize, NaN);
      const lotSize = num(config?.lotSize, NaN);
      const minQty = num(config?.minQty, NaN);
      const minNotional = num(config?.minNotional, NaN);
      if (!Number.isInteger(symbolId) || !(symbolId > 0) || !(tickSize > 0) || !(lotSize > 0) || !(minQty > 0) || !(minNotional > 0)) {
        throw new Error('PopDEX symbol metadata is incomplete or invalid');
      }
      this.symbolId = symbolId;
      this.tickSize = tickSize;
      this.lotSize = lotSize;
      this.minQty = minQty;
      this.minNotional = minNotional;
    } catch (error) {
      throw new Error('PopDEX symbol metadata unavailable; refusing LIVE initialization: ' + (error?.message || error));
    }
    const account = privateKeyToAccount(loadPrivateKey(this.privateKey, this.keyPath));
    this.account = account;
    this.address = account.address;
    const transport = custom({
      request: async ({ method, params }) => this._rpc(method, params || []),
    });
    this.wallet = createWalletClient({ account, chain: popdexChain, transport });
    this.pub = createPublicClient({ chain: popdexChain, transport });
    const chainId = await this._rpc('eth_chainId');
    if (Number(chainId) !== CHAIN_ID) {
      throw new Error('PopDEX RPC chainId mismatch: expected ' + CHAIN_ID + ', got ' + chainId);
    }
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
    const ticker = list.find((row) => String(row.symbol || '').toUpperCase() === this.symbol.toUpperCase());
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
      const orderId = String(row.orderId ?? row.order_id ?? row.id ?? '').trim();
      const clientOid = String(row.clientOid ?? row.clientOrderId ?? '').trim();
      const rowSymbol = row.symbol ?? row.marketSymbol;
      if (rowSymbol != null && String(rowSymbol).trim() && String(rowSymbol).toUpperCase() !== this.symbol.toUpperCase()) {
        throw new Error('PopDEX 返回非目标 symbol 的挂单：' + rowSymbol);
      }
      const rowAccount = row.account ?? row.accountAddress ?? row.address ?? row.owner;
      if (rowAccount != null && String(rowAccount).trim() && String(rowAccount).toLowerCase() !== this.address.toLowerCase()) {
        throw new Error('PopDEX 返回非当前账户的挂单，拒绝继续交易');
      }
      if (!isNumericOrderId(orderId)) {
        throw new Error('PopDEX 返回无法安全撤销的非数字 orderId=' + (orderId || clientOid || '<empty>'));
      }
      if (isBytes32(clientOid)) this._orderClientOids.set(orderId, clientOid);
      openOrders.push({
        orderId,
        clientOid,
        side: String(row.side || '').toLowerCase().startsWith('s') ? 'sell' : 'buy',
        price,
        sizeBase: remaining,
      });
    }
    this._resolvePendingOrders(openOrders);
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

  _assertNoPendingPlacements(action = '写操作') {
    if (this._pendingOrders.size) {
      const clientOid = this._pendingOrders.keys().next().value;
      const error = new Error(`PopDEX 存在尚未完成真实订单发现，拒绝继续${action}：${clientOid}`);
      error.pending = true;
      error.clientOrderId = clientOid;
      error.clientOid = clientOid;
      throw error;
    }
    return super._assertNoPendingPlacements(action);
  }

  _roundSize(size, price, { enforceMinNotional = true } = {}) {
    let result = roundToStep(size, this.lotSize, 'down');
    const minByNotional = price > 0 ? Math.ceil(this.minNotional / price / this.lotSize) * this.lotSize : this.minQty;
    if (enforceMinNotional && result > 0 && result < Math.max(this.minQty, minByNotional)) {
      result = Math.max(this.minQty, minByNotional);
    }
    return Number(result.toFixed(8));
  }

  async _waitForReceipt(hash) {
    for (let i = 0; i < this.receiptPollAttempts; i++) {
      if (this.receiptPollMs) await sleep(this.receiptPollMs);
      const receipt = await this.pub.getTransactionReceipt({ hash }).catch(() => null);
      if (!receipt) continue;
      if (receipt.status !== 'success') {
        const error = new Error('PopDEX 交易回滚 ' + hash);
        error.txHash = hash;
        error.receiptKnown = true;
        this._pendingTransactions.delete(hash);
        throw error;
      }
      this._pendingTransactions.delete(hash);
      return receipt;
    }
    const error = new Error('PopDEX 交易回执超时，未确认写入结果：' + hash);
    error.pending = true;
    error.txHash = hash;
    throw error;
  }

  async _waitForPendingTransactions() {
    for (const [hash, pending] of [...this._pendingTransactions]) {
      try {
        await this._waitForReceipt(hash);
      } catch (error) {
        if (error?.pending) {
          error.message = 'PopDEX 存在未确认链上交易，拒绝继续发送新的写操作：' + hash;
          error.kind = pending.kind;
          throw error;
        }
        // A receipt-confirmed revert is known not to have changed the account.
      }
    }
  }

  async _send(data, gas = 500_000n, meta = {}) {
    if (!this.wallet || !this.pub || !this.account) throw new Error('PopDEX 未连接');
    const hash = await this.wallet.sendTransaction({
      to: ORDER_CONTRACT,
      data,
      value: 0n,
      gas,
      gasPrice: 0n,
    });
    this._pendingTransactions.set(hash, { ...meta, hash, submittedAt: Date.now() });
    await this._waitForReceipt(hash);
    return hash;
  }

  _matchPlacedOrder(openOrders, clientOid, excludedIds = new Set()) {
    const exact = openOrders.find((row) => String(row.clientOid || '') === String(clientOid) && !excludedIds.has(String(row.orderId)));
    return exact || null;
  }

  _resolvePendingOrders(openOrders) {
    const claimed = new Set();
    for (const [clientOid, pending] of [...this._pendingOrders]) {
      const placed = this._matchPlacedOrder(openOrders, clientOid, claimed);
      if (!placed?.orderId) continue;
      const orderId = String(placed.orderId);
      const resolvedClientOid = isBytes32(placed.clientOid) ? placed.clientOid : clientOid;
      claimed.add(orderId);
      if (!this._tracked.has(orderId)) {
        this._registerPlaced(orderId, {
          ...pending.order,
          clientOrderId: resolvedClientOid,
          price: Number(placed.price ?? pending.order.price),
          sizeBase: Number(placed.sizeBase ?? pending.order.sizeBase),
        });
      }
      this._orderClientOids.set(orderId, resolvedClientOid);
      this._ownedOrderIds.add(orderId);
      this._pendingOrders.delete(clientOid);
    }
  }

  async _findPlacedOrder(order, clientOid) {
    for (let attempt = 0; attempt < this.orderDiscoveryAttempts; attempt++) {
      const snapshot = await this._refreshMarket(order.marketId);
      const placed = this._matchPlacedOrder(snapshot.openOrders, clientOid);
      if (placed) return placed;
      if (attempt + 1 < this.orderDiscoveryAttempts && this.orderDiscoveryPollMs) await sleep(this.orderDiscoveryPollMs);
    }
    return null;
  }

  async placeLimitOrder(order) {
    const requestClientOrderId = stableId(order.clientOrderId);
    if (!requestClientOrderId) throw new Error('PopDEX 下单缺少稳定 clientOrderId');
    const price = roundToStep(order.price, this.tickSize);
    const size = this._roundSize(order.sizeBase, price);
    if (!(price > 0) || !(size >= this.minQty)) throw new Error('PopDEX 订单精度或数量不足');
    await this._waitForPendingTransactions();
    const before = await this._refreshMarket(1);
    this._assertNoPendingPlacements('发送开仓单');
    const liveMid = Number(before.price) || await this._mid();
    if ((order.side === 'sell' && price <= liveMid) || (order.side === 'buy' && price >= liveMid)) {
      throw new Error('PopDEX PostOnly 订单穿价，等待下一轮行情');
    }
    if (this.orderGapMs) await sleep(this.orderGapMs);
    const oid = clientOrderId('grid-' + requestClientOrderId);
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
    const pending = {
      clientOid: oid,
      order: { ...order, marketId: 1, price, sizeBase: size },
      txHash: null,
      submittedAt: Date.now(),
    };
    this._pendingOrders.set(oid, pending);
    try {
      pending.txHash = await this._send(data, 500_000n, { kind: 'place', clientOid: oid });
      const placed = await this._findPlacedOrder(pending.order, oid);
      if (!placed?.orderId) {
        const error = new Error('PopDEX 交易已确认但 indexer 暂未发现真实订单，停止自动重发');
        error.pending = true;
        error.clientOid = oid;
        error.txHash = pending.txHash;
        throw error;
      }
      this._pendingOrders.delete(oid);
      this._orderClientOids.set(String(placed.orderId), isBytes32(placed.clientOid) ? placed.clientOid : oid);
      this._ownedOrderIds.add(String(placed.orderId));
      return this._registerPlaced(placed.orderId, { ...order, price: placed.price, sizeBase: placed.sizeBase });
    } catch (error) {
      if (error?.receiptKnown) {
        this._pendingOrders.delete(oid);
      } else {
        pending.txHash = pending.txHash || error?.txHash || null;
        error.pending = true;
        error.clientOid = error.clientOid || oid;
        error.txHash = error.txHash || pending.txHash;
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
    if (!isNumericOrderId(orderId)) throw new Error('PopDEX 无效 orderId=' + orderId);
    await this._waitForPendingTransactions();
    this._assertNoPendingPlacements('撤单');
    const knownClientOid = this._orderClientOids.get(String(orderId));
    if (this._ownedOrderIds.has(String(orderId)) && !isBytes32(knownClientOid)) {
      throw new Error('PopDEX 缺少自有订单的 clientOid，拒绝发送不完整撤单请求：' + orderId);
    }
    const data = encodeFunctionData({
      abi: cancelAbi,
      functionName: 'cancelOrder',
      args: [this.address, BigInt(String(orderId)), isBytes32(knownClientOid) ? knownClientOid : pad('0x', { size: 32 })],
    });
    await this._send(data, 300_000n, { kind: 'cancel', orderId: String(orderId) });
    this._markCancelled(orderId);
    this._orderClientOids.delete(String(orderId));
    this._ownedOrderIds.delete(String(orderId));
    return true;
  }

  async cancelAll(marketId) {
    await this._waitForPendingTransactions();
    this._assertNoPendingPlacements('撤销全部挂单');
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
    await this._send(data, 400_000n, { kind: 'cancelAll', marketId });
    this._markMarketCancelled(marketId);
    return true;
  }

  async closePosition(marketId) {
    await this._waitForPendingTransactions();
    this._assertNoPendingPlacements('平仓');
    const snapshot = await this._refreshMarket(marketId);
    const position = Number(snapshot.position?.sizeBase || 0);
    if (!position) return true;
    const absPosition = Math.abs(position);
    const size = this._roundSize(absPosition, Number(snapshot.price), { enforceMinNotional: false });
    const tolerance = Math.max(this.lotSize * 1e-6, 1e-12);
    if (!(size > 0) || size < this.minQty || size > absPosition + tolerance) {
      throw new Error('PopDEX 平仓数量无法在不超过当前持仓的前提下满足市场精度：position=' + absPosition);
    }
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
    await this._send(data, 500_000n, { kind: 'closePosition', clientOid: oid });
    return true;
  }
}
