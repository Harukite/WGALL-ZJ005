import { EventEmitter } from 'node:events';

function digits(step) {
  const text = String(step);
  if (/e-/i.test(text)) return Number(text.split('e-')[1]);
  return Math.max(0, (text.split('.')[1] || '').length);
}

export function roundToStep(value, step, mode = 'nearest') {
  const n = Number(value), s = Number(step);
  if (!Number.isFinite(n) || !(s > 0)) return 0;
  const units = n / s;
  const rounded = mode === 'down' ? Math.floor(units + 1e-12) : Math.round(units);
  return Number((rounded * s).toFixed(Math.min(16, digits(s) + 4)));
}

export function normalizeMarket(raw, index, fallbackPrice = 100) {
  const marketId = Number(raw.marketId ?? index + 1);
  const stepSize = Number(raw.stepSize ?? raw.qtyStep ?? 0.001) || 0.001;
  const stepPrice = Number(raw.stepPrice ?? raw.priceStep ?? 0.1) || 0.1;
  const lastPrice = Number(raw.lastPrice ?? raw.markPrice ?? fallbackPrice) || fallbackPrice;
  return {
    marketId,
    name: String(raw.name || raw.displayName || raw.symbol || ('BTC-' + marketId)),
    displayName: String(raw.displayName || raw.name || raw.symbol || ('BTC-' + marketId)),
    symbol: String(raw.symbol || raw.asset || raw.baseAsset || 'BTC'),
    lastPrice,
    stepSize,
    stepPrice,
    qtyStep: String(raw.qtyStep || stepSize),
    priceStep: String(raw.priceStep || stepPrice),
    minOrderSize: Number(raw.minOrderSize ?? stepSize) || stepSize,
    minOrderNotional: Number(raw.minOrderNotional ?? 1) || 1,
    maxOrderSize: Number(raw.maxOrderSize ?? Infinity),
    maxLeverage: Number(raw.maxLeverage ?? 50) || 50,
  };
}

export class VenuePaperExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.venue = String(opts.venue || 'paper');
    this.network = opts.network || 'mainnet';
    this.apiUrl = opts.apiUrl || '';
    this.balance = Number(opts.startBalance ?? 10_000);
    this.equity = this.balance;
    this.feeRate = Number(opts.feeRate ?? 0.0005);
    this.dataSource = 'synthetic';
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.markets = new Map();
    this.prices = new Map();
    this.orders = new Map();
    this.positions = new Map();
    this.realizedPnl = 0;
    this._leverage = new Map();
    this._seq = 0;
    this._timer = null;
    this._tickMs = Math.max(50, Number(opts.tickMs) || 1000);
    this._volPerTick = Number(opts.volPerTick ?? 0.0015);
    this._marketPrice = Number(opts.marketPrice);
    this._fallbackMarkets = Array.isArray(opts.markets) && opts.markets.length
      ? opts.markets
      : [{ marketId: 1, displayName: 'BTC-PERP', symbol: 'BTC', lastPrice: 100, stepSize: 0.001, stepPrice: 0.1, minOrderSize: 0.001, maxLeverage: 50 }];
  }

  async init() {
    this._setMarkets(this._fallbackMarkets);
    this.start();
    return true;
  }

  async reconnect() {
    this.start();
    this.lastOkAt = Date.now();
    return true;
  }

  _setMarkets(rows) {
    this.markets.clear();
    rows.map((row, index) => normalizeMarket(row, index, this._marketPrice > 0 ? this._marketPrice : 100))
      .forEach((market) => {
        this.markets.set(market.marketId, market);
        if (!this.prices.has(market.marketId)) {
          this.prices.set(market.marketId, this._marketPrice > 0 ? this._marketPrice : market.lastPrice);
        }
      });
  }

  async getMarkets() { return [...this.markets.values()]; }

  async getCandles(marketId, intervalSec = 3600, count = 200) {
    const n = Math.max(20, Math.min(500, Number(count) || 200));
    const interval = Number(intervalSec) || 3600;
    let price = this.prices.get(Number(marketId)) || 100;
    const out = [];
    let time = Math.floor(Date.now() / 1000) - n * interval;
    for (let i = 0; i < n; i++) {
      const open = price;
      const close = Math.max(0.0001, open * (1 + Math.sin(i / 7) * 0.001));
      out.push({ time, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 100 });
      price = close;
      time += interval;
    }
    return out;
  }

  async getPrice(marketId) { return this.prices.get(Number(marketId)); }

  setPrice(marketId, price) {
    const id = Number(marketId), next = Number(price);
    if (!(next > 0) || !this.markets.has(id)) throw new Error('无效 paper 价格 marketId=' + marketId);
    const previous = this.prices.get(id) || next;
    this.prices.set(id, next);
    this.emit('price', { marketId: id, price: next });
    this._matchFills(id, previous, next);
    this._refreshEquity();
  }

  async setLeverage(marketId, leverage) {
    const m = this.markets.get(Number(marketId));
    this._leverage.set(Number(marketId), Math.min(Number(leverage) || 1, m?.maxLeverage || 50));
    return true;
  }

  async placeLimitOrder(order) {
    const market = this.markets.get(Number(order.marketId));
    if (!market) throw new Error('找不到 paper 市场 ' + order.marketId);
    const price = roundToStep(order.price, market.stepPrice);
    const sizeBase = roundToStep(order.sizeBase, market.stepSize, 'down');
    if (!(price > 0) || !(sizeBase >= market.minOrderSize)) throw new Error('paper 订单精度或数量不足');
    const orderId = this.venue + '-paper-' + (++this._seq);
    this.orders.set(orderId, {
      ...order,
      orderId,
      marketId: Number(order.marketId),
      price,
      sizeBase,
    });
    return { orderId, price, sizeBase };
  }

  async placeLimitOrders(orders) {
    const results = [];
    for (const order of orders) results.push(await this.placeLimitOrder(order));
    return results;
  }

  async cancelOrder(_marketId, orderId) {
    this.orders.delete(String(orderId));
    return true;
  }

  async cancelAll(marketId) {
    const id = Number(marketId);
    for (const [orderId, order] of this.orders) if (order.marketId === id) this.orders.delete(orderId);
    return true;
  }

  getOpenOrders(marketId) {
    const id = Number(marketId);
    return [...this.orders.values()].filter((order) => order.marketId === id);
  }

  async fetchOpenOrders(marketId) {
    return this.getOpenOrders(marketId).map((order) => ({
      orderId: String(order.orderId),
      marketId: order.marketId,
      side: order.side,
      price: Number(order.price),
      sizeBase: Number(order.sizeBase),
    }));
  }

  adoptOrder(order) {
    this.orders.set(String(order.orderId), {
      ...order,
      orderId: String(order.orderId),
      marketId: Number(order.marketId),
      price: Number(order.price),
      sizeBase: Number(order.sizeBase),
    });
  }

  forgetOrder(orderId) { this.orders.delete(String(orderId)); }

  forgetOrders(marketId) {
    const id = Number(marketId);
    for (const [orderId, order] of this.orders) if (order.marketId === id) this.orders.delete(orderId);
  }

  getPosition(marketId) {
    const position = this.positions.get(Number(marketId));
    if (!position || !position.sizeBase) return null;
    const price = this.prices.get(Number(marketId)) || position.entryPrice;
    return {
      ...position,
      unrealizedPnl: position.sizeBase * (price - position.entryPrice),
    };
  }

  async closePosition(marketId) {
    const id = Number(marketId);
    const position = this.positions.get(id);
    if (!position?.sizeBase) return true;
    const price = this.prices.get(id) || position.entryPrice;
    this._applyFill(id, position.sizeBase > 0 ? 'sell' : 'buy', price, Math.abs(position.sizeBase));
    return true;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this._tickMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    this.lastOkAt = Date.now();
    for (const [marketId, previous] of this.prices) {
      const market = this.markets.get(marketId);
      const seed = market?.lastPrice || previous;
      const drift = ((seed - previous) / Math.max(seed, 1)) * 0.02;
      const next = Math.max(0.0001, previous * (1 + drift + (Math.random() * 2 - 1) * this._volPerTick));
      this.prices.set(marketId, next);
      this.emit('price', { marketId, price: next });
      this._matchFills(marketId, previous, next);
    }
    this._refreshEquity();
  }

  _matchFills(marketId, _previous, current) {
    for (const order of [...this.getOpenOrders(marketId)]) {
      const crossed = order.side === 'buy' ? current <= Number(order.price) : current >= Number(order.price);
      if (!crossed) continue;
      if (order.reduceOnly && !this._reduces(marketId, order.side)) {
        this.orders.delete(order.orderId);
        continue;
      }
      this.orders.delete(order.orderId);
      this._applyFill(marketId, order.side, Number(order.price), Number(order.sizeBase));
      this.emit('fill', { ...order, price: Number(order.price), sizeBase: Number(order.sizeBase) });
    }
  }

  _reduces(marketId, side) {
    const position = this.positions.get(Number(marketId));
    return !!position?.sizeBase && (side === 'sell' ? position.sizeBase > 0 : position.sizeBase < 0);
  }

  _applyFill(marketId, side, price, quantity) {
    const fee = price * quantity * this.feeRate;
    this.balance -= fee;
    this.realizedPnl -= fee;
    const position = this.positions.get(marketId) || { sizeBase: 0, entryPrice: 0, leverage: null, liquidationPrice: null };
    const signed = side === 'buy' ? quantity : -quantity;
    if (!position.sizeBase || Math.sign(position.sizeBase) === Math.sign(signed)) {
      const next = position.sizeBase + signed;
      position.entryPrice = (Math.abs(position.sizeBase) * position.entryPrice + quantity * price) / Math.abs(next);
      position.sizeBase = next;
    } else {
      const closed = Math.min(Math.abs(position.sizeBase), quantity);
      const pnl = position.sizeBase > 0
        ? closed * (price - position.entryPrice)
        : closed * (position.entryPrice - price);
      this.balance += pnl;
      this.realizedPnl += pnl;
      const next = position.sizeBase + signed;
      if (!next || Math.sign(next) === Math.sign(position.sizeBase)) {
        position.sizeBase = next;
        if (!next) position.entryPrice = 0;
      } else {
        position.sizeBase = next;
        position.entryPrice = price;
      }
    }
    this.positions.set(marketId, position);
    this._refreshEquity();
  }

  _refreshEquity() {
    let unrealized = 0;
    for (const [marketId, position] of this.positions) {
      const price = this.prices.get(marketId) || position.entryPrice;
      unrealized += position.sizeBase * (price - position.entryPrice);
    }
    this.equity = this.balance + unrealized;
  }
}
