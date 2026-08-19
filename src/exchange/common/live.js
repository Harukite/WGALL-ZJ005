import { EventEmitter } from 'node:events';
import { normalizeMarket } from './paper.js';

export function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function roundToStep(value, step, mode = 'nearest') {
  const n = Number(value), s = Number(step);
  if (!Number.isFinite(n) || !(s > 0)) return 0;
  const units = n / s;
  const rounded = mode === 'down' ? Math.floor(units + 1e-12) : Math.round(units);
  const decimals = Math.max(0, String(s).split('.')[1]?.length || 0);
  return Number((rounded * s).toFixed(Math.min(16, decimals + 4)));
}

export async function fetchJson(url, options = {}) {
  const { timeoutMs = 10_000, ...init } = options;
  const response = await fetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const error = new Error('HTTP ' + response.status + ' ' + String(url));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export class LiveVenueExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.venue = String(opts.venue || 'live');
    this.network = opts.network || 'mainnet';
    this.apiUrl = String(opts.apiUrl || '').replace(/\/$/, '');
    this.feeRate = Number(opts.feeRate ?? 0.0005);
    this.pollMs = Math.max(500, Number(opts.pollMs) || 2500);
    this.dataSource = null;
    this.lastOkAt = 0;
    this.lastError = null;
    this.balance = null;
    this.equity = null;
    this.realizedPnl = 0;
    this.markets = new Map();
    this.prices = new Map();
    this.positions = new Map();
    this._tracked = new Map();
    this._cancelled = new Set();
    this._watch = new Set();
    this._positionSnapshots = new Map();
    this._timer = null;
    this._busy = false;
    this._graceMs = Math.max(1000, this.pollMs * 2);
  }

  _setMarkets(rows, fallbackPrice = 100) {
    this.markets.clear();
    for (const [index, raw] of rows.entries()) {
      const market = normalizeMarket(raw, index, fallbackPrice);
      this.markets.set(market.marketId, market);
      if (market.lastPrice > 0 && !this.prices.has(market.marketId)) {
        this.prices.set(market.marketId, market.lastPrice);
      }
    }
  }

  async getMarkets() { return [...this.markets.values()]; }

  async getCandles(_marketId, _intervalSec = 3600, _count = 200) { return []; }

  async getPrice(marketId) {
    const id = Number(marketId);
    this._watch.add(id);
    const snapshot = await this._refreshMarket(id);
    this._applySnapshot(id, snapshot);
    return this.prices.get(id) || this.markets.get(id)?.lastPrice;
  }

  async fetchOpenOrders(marketId) {
    const id = Number(marketId);
    this._watch.add(id);
    const snapshot = await this._refreshMarket(id);
    this._applySnapshot(id, snapshot);
    if (!Array.isArray(snapshot?.openOrders)) return null;
    return snapshot.openOrders.map((order) => ({
      orderId: String(order.orderId),
      marketId: id,
      side: order.side === 'sell' ? 'sell' : 'buy',
      price: Number(order.price),
      sizeBase: Number(order.sizeBase || order.size || 0),
    }));
  }

  async setLeverage() { return false; }

  getOpenOrders(marketId) {
    const id = Number(marketId);
    return [...this._tracked.values()].filter((order) => order.marketId === id);
  }

  adoptOrder(order) {
    const id = String(order.orderId);
    this._tracked.set(id, {
      ...order,
      orderId: id,
      marketId: Number(order.marketId),
      price: Number(order.price),
      sizeBase: Number(order.sizeBase || order.size || 0),
      initialSizeBase: Number(order.sizeBase || order.size || 0),
      confirmedFillBase: 0,
      placedAt: Date.now(),
      seen: false,
      gone: 0,
    });
    this._watch.add(Number(order.marketId));
  }

  forgetOrder(orderId) {
    const id = String(orderId);
    this._tracked.delete(id);
    this._cancelled.delete(id);
  }

  forgetOrders(marketId) {
    const id = Number(marketId);
    for (const [orderId, order] of this._tracked) {
      if (order.marketId === id) this.forgetOrder(orderId);
    }
  }

  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    return p && Number(p.sizeBase) !== 0 ? p : null;
  }

  _registerPlaced(orderId, order) {
    if (!orderId) throw new Error(this.venue + ' 下单成功但没有远端 orderId');
    this._tracked.set(String(orderId), {
      ...order,
      orderId: String(orderId),
      marketId: Number(order.marketId),
      price: Number(order.price),
      sizeBase: Number(order.sizeBase),
      initialSizeBase: Number(order.sizeBase),
      confirmedFillBase: 0,
      placedAt: Date.now(),
      seen: false,
      gone: 0,
    });
    this._watch.add(Number(order.marketId));
    return { orderId: String(orderId) };
  }

  _markCancelled(orderId) {
    this._cancelled.add(String(orderId));
  }

  _markMarketCancelled(marketId) {
    const id = Number(marketId);
    for (const order of this._tracked.values()) if (order.marketId === id) this._markCancelled(order.orderId);
  }

  _applySnapshot(marketId, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.openOrders)) return;
    const id = Number(marketId);
    const previousPosition = this._positionSnapshots.get(id);
    const positionPresent = Object.prototype.hasOwnProperty.call(snapshot, 'position');
    const currentPosition = !positionPresent || snapshot.position == null
      ? 0
      : Number(typeof snapshot.position === 'object' ? snapshot.position.sizeBase : snapshot.position);
    const hasPosition = positionPresent && Number.isFinite(currentPosition);
    const positionDelta = hasPosition && previousPosition != null ? currentPosition - previousPosition : 0;
    if (hasPosition) this._positionSnapshots.set(id, currentPosition);
    const currentPrice = Number(snapshot.price);
    if (currentPrice > 0) {
      this.prices.set(id, currentPrice);
      this.emit('price', { marketId: id, price: currentPrice });
    }
    if (snapshot.balance != null && Number.isFinite(Number(snapshot.balance))) this.balance = Number(snapshot.balance);
    if (snapshot.equity != null && Number.isFinite(Number(snapshot.equity))) this.equity = Number(snapshot.equity);
    if (snapshot.realizedPnl != null && Number.isFinite(Number(snapshot.realizedPnl))) this.realizedPnl = Number(snapshot.realizedPnl);
    if (snapshot.position != null) {
      const position = typeof snapshot.position === 'object'
        ? snapshot.position
        : { sizeBase: Number(snapshot.position), entryPrice: Number(snapshot.entryPrice || 0) };
      if (Number(position.sizeBase)) this.positions.set(id, { ...position, sizeBase: Number(position.sizeBase) });
      else this.positions.delete(id);
    }
    const open = snapshot.openOrders;
    const openById = new Map(open.map((order) => [String(order.orderId || order.id), order]));
    const now = Date.now();
    const candidates = [];
    for (const [orderId, tracked] of this._tracked) {
      if (tracked.marketId !== id) continue;
      const remote = openById.get(orderId);
      if (remote) {
        const remaining = Number(remote.sizeBase ?? remote.size ?? tracked.sizeBase);
        const decrease = Number(tracked.sizeBase) - remaining;
        if (decrease > 1e-12) candidates.push({ tracked, capacity: decrease });
      } else if (!this._cancelled.has(orderId)) {
        candidates.push({ tracked, capacity: Number(tracked.sizeBase) || Number(tracked.initialSizeBase) || 0 });
      }
    }
    let remainingPositionDelta = positionDelta;
    for (const candidate of candidates) {
      if (!(Math.abs(remainingPositionDelta) > 1e-12) || !(candidate.capacity > 1e-12)) break;
      const expectedSign = candidate.tracked.side === 'sell' ? -1 : 1;
      if (Math.sign(remainingPositionDelta) !== expectedSign) continue;
      const filled = Math.min(Math.abs(remainingPositionDelta), candidate.capacity);
      candidate.tracked.confirmedFillBase = (candidate.tracked.confirmedFillBase || 0) + filled;
      remainingPositionDelta -= expectedSign * filled;
    }
    for (const [orderId, tracked] of [...this._tracked]) {
      if (tracked.marketId !== id) continue;
      const remote = openById.get(orderId);
      if (remote) {
        tracked.seen = true;
        tracked.gone = 0;
        tracked.price = Number(remote.price ?? tracked.price);
        tracked.sizeBase = Number(remote.sizeBase ?? remote.size ?? tracked.sizeBase);
        continue;
      }
      if (this._cancelled.has(orderId)) {
        this._tracked.delete(orderId);
        this._cancelled.delete(orderId);
        const fillSize = Number(tracked.confirmedFillBase || 0);
        if (fillSize > 1e-12) {
          this.emit('fill', {
            ...tracked,
            marketId: id,
            side: tracked.side === 'sell' ? 'sell' : 'buy',
            price: Number(tracked.price),
            sizeBase: fillSize,
          });
        }
        continue;
      }
      if (now - tracked.placedAt < this._graceMs && !tracked.seen) continue;
      tracked.gone = (tracked.gone || 0) + 1;
      if (tracked.gone < 2) continue;
      this._tracked.delete(orderId);
      const fillSize = Number(tracked.confirmedFillBase || 0);
      if (fillSize > 1e-12) {
        this.emit('fill', {
          ...tracked,
          marketId: id,
          side: tracked.side === 'sell' ? 'sell' : 'buy',
          price: Number(tracked.price),
          sizeBase: fillSize,
        });
      }
    }
    this.lastOkAt = now;
    this.lastError = null;
    this.dataSource = 'real';
  }

  async _poll() {
    if (this._busy) return;
    this._busy = true;
    try {
      for (const marketId of this._watch) {
        const snapshot = await this._refreshMarket(marketId);
        this._applySnapshot(marketId, snapshot);
      }
    } catch (error) {
      this.lastError = error?.message || String(error);
      this.emit('error', error);
    } finally {
      this._busy = false;
    }
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._poll().catch(() => {}), this.pollMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async reconnect() {
    this.stop();
    this.dataSource = null;
    this.lastOkAt = 0;
    try {
      await this.init();
      return true;
    } catch (error) {
      this.lastError = error?.message || String(error);
      throw error;
    }
  }
}
