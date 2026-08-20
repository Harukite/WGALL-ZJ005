// Arcus paper adapter: real Arcus market universe/prices/candles with local
// simulated orders, balances and positions. No Arcus credential is used.
import { EventEmitter } from 'node:events';
import { chooseTick } from './signing.js';

const INTERVALS = {
  60: '1m', 180: '3m', 300: '5m', 900: '15m', 1800: '30m',
  3600: '1h', 7200: '2h', 14400: '4h', 28800: '8h', 43200: '12h',
  86400: '1d', 259200: '3d', 604800: '1w',
};
const FALLBACK_MARKETS = [
  { marketId: 1, marketDisplayName: 'BTC-USD', baseAsset: 'BTC', markPrice: '65000', tickSize: '0.1', stepSize: '0.00000001', minOrderSize: '0.0001', minOrderNotional: '5', maxOrderSize: '10000', initialMarginFraction: '0.025', status: 'ONLINE', type: 'PERPETUAL' },
  { marketId: 2, marketDisplayName: 'ETH-USD', baseAsset: 'ETH', markPrice: '2000', tickSize: '0.01', stepSize: '0.0000001', minOrderSize: '0.001', minOrderNotional: '5', maxOrderSize: '100000', initialMarginFraction: '0.04', status: 'ONLINE', type: 'PERPETUAL' },
  { marketId: 3, marketDisplayName: 'SOL-USD', baseAsset: 'SOL', markPrice: '75', tickSize: '0.001', stepSize: '0.000001', minOrderSize: '0.01', minOrderNotional: '5', maxOrderSize: '1000000', initialMarginFraction: '0.05', status: 'ONLINE', type: 'PERPETUAL' },
];

export class PaperExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.balance = Number(opts.startBalance ?? 10000);
    this.feeRate = Number(opts.feeRate) || 0.0005;
    this.network = opts.network === 'testnet' ? 'testnet' : 'mainnet';
    const preferred = opts.apiUrl || (this.network === 'testnet' ? 'https://api.testnet.arcus.xyz' : 'https://api.arcus.xyz');
    this.candidates = [...new Set([preferred, 'https://api.arcus.xyz', 'https://api.testnet.arcus.xyz'].map((x) => String(x).replace(/\/$/, '')))];
    this.apiUrl = this.candidates[0];
    this.dataSource = 'connecting';
    this.tickMs = Math.max(500, Number(opts.tickMs || 1000));
    this.pollMs = Math.max(2500, Number(opts.pollMs || 5000));
    this.volPerTick = Number(opts.volPerTick || 0.0015);
    this.markets = new Map();
    this.orders = new Map();
    this.positions = new Map();
    this.prices = new Map();
    this.realTarget = new Map();
    this.realizedPnl = 0;
    this.lastOkAt = Date.now();
    this.lastError = null;
    this._seq = 1;
    this._tickTimer = null;
    this._pollTimer = null;
  }

  async init() {
    let selected = null;
    for (const url of this.candidates) {
      const rows = await this._fetchMarkets(url);
      if (rows?.length) { selected = { url, rows }; break; }
    }
    if (selected) {
      this.apiUrl = selected.url;
      this.network = selected.url.includes('testnet') ? 'testnet' : 'mainnet';
      this.dataSource = 'real';
      this._setMarkets(selected.rows);
    } else {
      this.dataSource = 'synthetic';
      this._setMarkets(FALLBACK_MARKETS);
    }
    for (const [id, market] of this.markets) {
      this.prices.set(id, market.lastPrice || 100);
      this.realTarget.set(id, market.lastPrice || 100);
    }
    this._startLoops();
    return true;
  }

  async reconnect() {
    for (const url of this.candidates) {
      const rows = await this._fetchMarkets(url);
      if (!rows?.length) continue;
      this.apiUrl = url;
      this.network = url.includes('testnet') ? 'testnet' : 'mainnet';
      this.dataSource = 'real';
      this._setMarkets(rows);
      for (const [id, market] of this.markets) {
        if (!this.prices.has(id)) this.prices.set(id, market.lastPrice || 100);
        this.realTarget.set(id, market.lastPrice || this.prices.get(id) || 100);
      }
      break;
    }
    this._startLoops();
    this.lastOkAt = Date.now();
    return true;
  }

  async _fetchMarkets(url) {
    try {
      const res = await fetch(url + '/v1/markets', { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const data = await res.json();
      const rows = Array.isArray(data) ? data : data?.markets;
      return Array.isArray(rows) ? rows : null;
    } catch { return null; }
  }

  _setMarkets(rows) {
    const next = new Map();
    for (const raw of rows) {
      if (String(raw.type || 'PERPETUAL').toUpperCase() !== 'PERPETUAL') continue;
      if (String(raw.status || '').toUpperCase() !== 'ONLINE') continue;
      const id = Number(raw.marketId);
      const price = Number(raw.markPrice || raw.oraclePrice || raw.lastTradePrice || 0);
      const imf = Number(raw.isOutsideRth ? raw.offHoursInitialMarginFraction : raw.initialMarginFraction);
      const market = {
        marketId: id, name: raw.marketDisplayName, displayName: raw.marketDisplayName,
        symbol: raw.baseAsset, category: raw.category || null, lastPrice: price || 100,
        stepSize: Number(raw.stepSize || 0.001), stepPrice: Number(chooseTick(raw, price || raw.tickSize)),
        minOrderSize: Number(raw.minOrderSize || raw.stepSize || 0.001),
        minOrderNotional: Number(raw.minOrderNotional || 0),
        maxOrderSize: Number(raw.maxOrderSize || Infinity),
        maxLeverage: Number.isFinite(imf) && imf > 0 ? Math.max(1, Math.floor(1 / imf + 1e-9)) : 50,
      };
      if (Number.isInteger(id)) next.set(id, market);
    }
    if (next.size) this.markets = next;
  }

  async getMarkets() { return [...this.markets.values()]; }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const market = this.markets.get(Number(marketId));
    if (this.dataSource === 'real' && market) {
      try {
        const timeframe = INTERVALS[Number(intervalSec)] || '1h';
        const to = BigInt(Date.now()) * 1000n;
        const url = `${this.apiUrl}/v1/candles?market=${encodeURIComponent(market.name)}&timeframe=${timeframe}&to=${to}&countback=${Math.min(1500, Number(n) || 200)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json();
          const rows = Array.isArray(data) ? data : data?.candles;
          const out = (rows || []).map((c) => ({
            time: Math.floor(Number(c.openTime || 0) / 1000),
            open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume || 0),
          })).filter((c) => Number.isFinite(c.close) && c.time > 0).sort((a, b) => a.time - b.time);
          if (out.length >= 20) return out;
        }
      } catch { /* synthetic fallback below */ }
    }
    return synthCandles(this.prices.get(Number(marketId)) || 100, Number(n) || 200, Number(intervalSec) || 3600);
  }

  async getPrice(marketId) { return this.prices.get(Number(marketId)); }
  async setLeverage() { return true; }

  async placeLimitOrder(order) {
    const id = `ar-paper-${this._seq++}`;
    this.orders.set(id, { orderId: id, ...order, marketId: Number(order.marketId) });
    return { orderId: id };
  }

  async cancelOrder(_marketId, orderId) { this.orders.delete(String(orderId)); return true; }
  async cancelAll(marketId) {
    for (const [id, order] of this.orders) if (order.marketId === Number(marketId)) this.orders.delete(id);
    return true;
  }
  getOpenOrders(marketId) { return [...this.orders.values()].filter((o) => o.marketId === Number(marketId)); }
  async fetchOpenOrders(marketId) {
    return this.getOpenOrders(marketId).map((o) => ({ orderId: String(o.orderId), price: Number(o.price), side: o.side, marketId: Number(o.marketId) }));
  }
  forgetOrder(orderId) { this.orders.delete(String(orderId)); }
  forgetOrders(marketId) {
    for (const [id, order] of this.orders) if (order.marketId === Number(marketId)) this.orders.delete(id);
  }
  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    this.orders.set(String(orderId), { orderId: String(orderId), marketId: Number(marketId), levelIndex, side, price: Number(price), sizeBase: Number(sizeBase), reduceOnly: false });
  }

  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    if (!p?.sizeBase) return null;
    const last = this.prices.get(Number(marketId)) || p.entryPrice;
    return { sizeBase: p.sizeBase, entryPrice: p.entryPrice, unrealizedPnl: p.sizeBase * (last - p.entryPrice) };
  }

  async closePosition(marketId) {
    const id = Number(marketId);
    const p = this.positions.get(id);
    if (!p?.sizeBase) return true;
    const price = this.prices.get(id) || p.entryPrice;
    this._applyFill(id, p.sizeBase > 0 ? 'sell' : 'buy', price, Math.abs(p.sizeBase));
    return true;
  }

  start() { this._startLoops(); }
  stop() { /* paper price feed remains alive, matching the other paper adapters */ }

  _startLoops() {
    if (!this._tickTimer) { this._tickTimer = setInterval(() => this._tick(), this.tickMs); this._tickTimer.unref?.(); }
    if (this.dataSource === 'real' && !this._pollTimer) { this._pollTimer = setInterval(() => this._pollReal(), this.pollMs); this._pollTimer.unref?.(); }
  }

  async _pollReal() {
    try {
      const res = await fetch(this.apiUrl + '/v1/prices', { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return;
      const data = await res.json();
      const rows = data?.prices && typeof data.prices === 'object' ? data.prices : data;
      for (const [key, row] of Object.entries(rows || {})) {
        const id = Number(row?.marketId ?? key);
        const price = Number(row?.markPrice || row?.oraclePrice || 0);
        if (this.markets.has(id) && price > 0) this.realTarget.set(id, price);
      }
      this.lastOkAt = Date.now();
    } catch (e) { this.lastError = e?.message || String(e); }
  }

  _tick() {
    this.lastOkAt = Date.now();
    for (const [id, current] of this.prices) {
      let next;
      if (this.dataSource === 'real') {
        const target = this.realTarget.get(id) ?? current;
        next = current + (target - current) * 0.25;
        if (Math.abs(next - target) / Math.max(target, 1e-12) < 1e-5) next = target;
      } else {
        const seed = this.markets.get(id)?.lastPrice || current;
        const drift = (seed - current) / seed * 0.02;
        next = Math.max(1e-8, current * (1 + drift + (Math.random() * 2 - 1) * this.volPerTick));
      }
      this.prices.set(id, next);
      this.emit('price', { marketId: id, price: next });
      this._matchFills(id, next);
    }
  }

  _matchFills(marketId, price) {
    for (const order of [...this.orders.values()]) {
      if (order.marketId !== marketId) continue;
      if (!this.orders.has(order.orderId)) continue;
      if (!(order.side === 'buy' ? price <= order.price : price >= order.price)) continue;
      if (order.reduceOnly && !this._reduces(marketId, order.side)) { this.orders.delete(order.orderId); continue; }
      this.orders.delete(order.orderId);
      this._applyFill(marketId, order.side, Number(order.price), Number(order.sizeBase));
      this.emit('fill', { orderId: order.orderId, marketId, side: order.side, price: Number(order.price), sizeBase: Number(order.sizeBase), levelIndex: order.levelIndex });
    }
  }

  _reduces(marketId, side) {
    const p = this.positions.get(marketId);
    return !!p?.sizeBase && (side === 'sell' ? p.sizeBase > 0 : p.sizeBase < 0);
  }

  _applyFill(marketId, side, price, qty) {
    const fee = price * qty * this.feeRate;
    this.balance -= fee;
    this.realizedPnl -= fee;
    const p = this.positions.get(marketId) || { sizeBase: 0, entryPrice: 0 };
    const signed = side === 'buy' ? qty : -qty;
    if (!p.sizeBase || Math.sign(p.sizeBase) === Math.sign(signed)) {
      const nextSize = p.sizeBase + signed;
      p.entryPrice = (Math.abs(p.sizeBase) * p.entryPrice + Math.abs(signed) * price) / Math.abs(nextSize);
      p.sizeBase = nextSize;
    } else {
      const closed = Math.min(Math.abs(p.sizeBase), Math.abs(signed));
      const pnl = p.sizeBase > 0 ? closed * (price - p.entryPrice) : closed * (p.entryPrice - price);
      this.balance += pnl; this.realizedPnl += pnl;
      const remaining = p.sizeBase + signed;
      if (!remaining || Math.sign(remaining) === Math.sign(p.sizeBase)) { p.sizeBase = remaining; if (!remaining) p.entryPrice = 0; }
      else { p.sizeBase = remaining; p.entryPrice = price; }
    }
    this.positions.set(marketId, p);
  }
}

function synthCandles(start, count, intervalSec) {
  const out = [];
  let price = start;
  let time = Date.now() - count * intervalSec * 1000;
  const regime = Math.random() < 0.34 ? 0.0012 : Math.random() < 0.5 ? -0.0012 : 0;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 + regime + (Math.random() * 2 - 1) * 0.006);
    out.push({ time, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 100 });
    price = close; time += intervalSec * 1000;
  }
  return out;
}
