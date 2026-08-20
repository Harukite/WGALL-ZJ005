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

export function stableId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || /^(undefined|null|nan|\[object object\])$/i.test(text)) return null;
  return text;
}

function clientIdFrom(row) {
  return stableId(row?.clientOrderId ?? row?.client_order_id ?? row?.clientOid ?? row?.client_oid);
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
    this._pendingPlacements = new Map();
    this._pendingWrites = new Map();
    this._resolvedPlacementOutcomes = new Map();
    this._writeSeq = 0;
    this._cancelled = new Set();
    this._watch = new Set();
    this._positionSnapshots = new Map();
    this._timer = null;
    this._busy = false;
    this._graceMs = Math.max(1000, this.pollMs * 2);
    this._pendingOutcomeTtlMs = Math.max(30_000, Number(opts.pendingOutcomeTtlMs) || 300_000);
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
      orderId: stableId(order.orderId ?? order.id),
      marketId: id,
      side: order.side === 'sell' ? 'sell' : 'buy',
      price: Number(order.price),
      sizeBase: Number(order.sizeBase || order.size || 0),
      ...(clientIdFrom(order) ? { clientOrderId: clientIdFrom(order) } : {}),
    }));
  }

  async setLeverage() { return false; }

  getOpenOrders(marketId) {
    const id = Number(marketId);
    return [...this._tracked.values()].filter((order) => order.marketId === id);
  }

  adoptOrder(order) {
    const id = stableId(order.orderId ?? order.id);
    if (!id) throw new Error(this.venue + ' 权威挂单快照缺少稳定 orderId');
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
    const id = stableId(orderId);
    if (!id) throw new Error(this.venue + ' 下单成功但没有远端 orderId');
    this._tracked.set(id, {
      ...order,
      orderId: id,
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
    return { orderId: id };
  }

  _assertNoPendingPlacements(action = '写操作') {
    if (!this._pendingPlacements.size && !this._pendingWrites.size) return;
    const pendingId = this._pendingPlacements.keys().next().value
      || this._pendingWrites.keys().next().value;
    const error = new Error(`${this.venue} 存在未完成的写入权威确认，拒绝继续${action}：${pendingId}`);
    error.pending = true;
    error.clientOrderId = this._pendingPlacements.keys().next().value;
    error.writeId = this._pendingWrites.keys().next().value;
    throw error;
  }

  _beginPendingWrite(kind, metadata = {}) {
    const id = `${this.venue}:${kind}:${Date.now().toString(36)}:${++this._writeSeq}`;
    const write = { id, kind, convergedReads: 0, submittedAt: Date.now(), ...metadata };
    this._pendingWrites.set(id, write);
    return write;
  }

  _finishPendingWrite(write) {
    if (write?.id) this._pendingWrites.delete(write.id);
  }

  _beginPendingPlacement(order, clientOrderId, options = {}) {
    const key = stableId(clientOrderId);
    if (!key) throw new Error(this.venue + ' 下单缺少稳定 clientOrderId');
    const pendingOrder = { ...order };
    if (!stableId(pendingOrder.clientOrderId)) pendingOrder.clientOrderId = key;
    const pending = {
      clientOrderId: key,
      order: pendingOrder,
      previousIds: new Set(options.previousIds || []),
      metadata: { ...(options.metadata || {}) },
      outcome: null,
      fill: null,
      submittedAt: Date.now(),
    };
    pending.write = this._beginPendingWrite('place', {
      marketId: Number(order.marketId),
      clientOrderId: key,
    });
    this._pendingPlacements.set(key, pending);
    return pending;
  }

  _markPendingPlacementFilled(pending, fill) {
    if (!pending || pending.outcome || !this._pendingPlacements.has(pending.clientOrderId)) return false;
    const orderId = stableId(fill?.orderId ?? fill?.id);
    const price = Number(fill?.price ?? pending.order.price);
    const sizeBase = Number(fill?.sizeBase ?? pending.order.sizeBase);
    if (!orderId || !(price > 0) || !(sizeBase > 0)) return false;
    pending.outcome = 'filled';
    pending.fill = { orderId, price, sizeBase };
    return true;
  }

  _placementMatches(expected, order) {
    const marketId = Number(order?.marketId);
    if (Number(expected?.marketId) !== marketId) return false;
    if (expected?.side && order?.side && expected.side !== order.side) return false;
    if (expected?.levelIndex != null && order?.levelIndex != null
      && Number(expected.levelIndex) !== Number(order.levelIndex)) return false;
    const expectedClientIds = new Set(
      [expected?.clientOrderId, expected?.requestClientOrderId].map(stableId).filter(Boolean),
    );
    const actualClientIds = new Set(
      [order?.clientOrderId, order?.requestClientOrderId].map(stableId).filter(Boolean),
    );
    if (!expectedClientIds.size || !actualClientIds.size
      || ![...expectedClientIds].some((clientId) => actualClientIds.has(clientId))) return false;
    const expectedPrice = Number(expected?.price);
    const requestedPrice = Number(order?.price);
    if (Number.isFinite(expectedPrice) && Number.isFinite(requestedPrice)
      && Math.abs(expectedPrice - requestedPrice) > Math.max(1e-12, Math.abs(expectedPrice) * 1e-10)) return false;
    const expectedSize = Number(expected?.sizeBase);
    const requestedSize = Number(order?.sizeBase);
    return !(Number.isFinite(expectedSize) && Number.isFinite(requestedSize)
      && Math.abs(expectedSize - requestedSize) > Math.max(1e-12, Math.max(Math.abs(expectedSize), Math.abs(requestedSize)) * 1e-9));
  }

  _publishPendingPlacementOutcome(pending) {
    if (!pending?.fill || !this._pendingPlacements.has(pending.clientOrderId)) return null;
    const result = {
      orderId: pending.fill.orderId,
      price: pending.fill.price,
      sizeBase: pending.fill.sizeBase,
      filled: true,
    };
    const event = {
      ...(pending.order || {}),
      ...result,
      marketId: Number(pending.order?.marketId),
      side: pending.order?.side === 'sell' ? 'sell' : 'buy',
      clientOrderId: pending.clientOrderId,
    };
    const key = `${this.venue}:filled:${Date.now().toString(36)}:${++this._writeSeq}`;
    const record = { key, order: { ...(pending.order || {}) }, result, event };
    this._pendingPlacements.delete(pending.clientOrderId);
    this._finishPendingWrite(pending.write);
    this._resolvedPlacementOutcomes.set(key, record);
    setTimeout(() => this.emit('fill', event), 0);
    const cleanup = setTimeout(() => {
      if (this._resolvedPlacementOutcomes.get(key) === record) this._resolvedPlacementOutcomes.delete(key);
    }, this._pendingOutcomeTtlMs);
    cleanup.unref?.();
    return record;
  }

  _takePendingPlacementOutcome(order) {
    for (const [clientOrderId, pending] of this._pendingPlacements) {
      if (pending.outcome !== 'filled') continue;
      if (!this._placementMatches(pending.order, order)) continue;
      return this._publishPendingPlacementOutcome(pending)?.result || null;
    }
    for (const [key, record] of this._resolvedPlacementOutcomes) {
      if (!this._placementMatches(record.order, order)) continue;
      this._resolvedPlacementOutcomes.delete(key);
      return record.result;
    }
    return null;
  }

  async _reconcilePendingPlacementFills(marketId) {
    if (typeof this._findPendingPlacementFill !== 'function') return;
    const id = Number(marketId);
    for (const pending of this._pendingPlacements.values()) {
      if (pending.outcome || Number(pending.order?.marketId) !== id) continue;
      try {
        const fill = await this._findPendingPlacementFill(pending);
        if (fill && this._markPendingPlacementFilled(pending, fill)) {
          this._publishPendingPlacementOutcome(pending);
        }
      } catch { /* a history read cannot authorize a write by itself */ }
    }
  }

  async _resolvePendingPlacementAfterWrite(order) {
    const immediate = this._takePendingPlacementOutcome(order);
    if (immediate) return immediate;
    try {
      const marketId = Number(order.marketId);
      const snapshot = await this._refreshMarket(marketId);
      this._applySnapshot(marketId, snapshot);
    } catch { /* keep the original write pending when authority is unavailable */ }
    return this._takePendingPlacementOutcome(order);
  }

  _pendingPlacementError(error, pending, message = '') {
    const result = error instanceof Error ? error : new Error(String(error || message || '订单写入结果未知'));
    if (message) result.message = message + (result.message ? '：' + result.message : '');
    result.pending = true;
    result.clientOrderId = pending.clientOrderId;
    result.writeId = pending.write?.id;
    return result;
  }

  _resolvePendingPlacements(openOrders) {
    const claimed = new Set();
    for (const [clientOrderId, pending] of [...this._pendingPlacements]) {
      if (pending.outcome) continue;
      const matches = openOrders.filter((row) => clientIdFrom(row) === clientOrderId
        && !claimed.has(stableId(row.orderId ?? row.id)));
      if (matches.length !== 1) continue;
      const row = matches[0];
      const orderId = stableId(row.orderId ?? row.id);
      if (!orderId) throw new Error(this.venue + ' pending 订单已匹配但缺少稳定 orderId');
      claimed.add(orderId);
      this._pendingPlacements.delete(clientOrderId);
      this._finishPendingWrite(pending.write);
      this._registerPlaced(orderId, {
        ...pending.order,
        clientOrderId,
        price: Number(row.price ?? pending.order.price),
        sizeBase: Number(pending.order.sizeBase ?? row.sizeBase ?? row.size),
      });
    }
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
    for (const order of snapshot.openOrders) {
      if (!stableId(order.orderId ?? order.id)) {
        throw new Error(this.venue + ' 权威挂单快照缺少稳定 orderId，拒绝继续交易');
      }
    }
    this._reconcilePendingWrites(id, snapshot);
    this._resolvePendingPlacements(snapshot.openOrders);
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
    const openById = new Map(open.map((order) => [stableId(order.orderId ?? order.id), order]));
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

  _reconcilePendingWrites(marketId, snapshot) {
    const id = Number(marketId);
    const openIds = new Set(snapshot.openOrders.map((order) => stableId(order.orderId ?? order.id)));
    const positionPresent = Object.prototype.hasOwnProperty.call(snapshot, 'position');
    const positionSize = !positionPresent || snapshot.position == null
      ? 0
      : Number(typeof snapshot.position === 'object' ? snapshot.position.sizeBase : snapshot.position);
    for (const [writeId, write] of [...this._pendingWrites]) {
      if (write.marketId != null && Number(write.marketId) !== id) continue;
      if (write.kind === 'place') {
        const orderId = stableId(write.orderId);
        const remote = orderId && snapshot.openOrders.find((order) => stableId(order.orderId ?? order.id) === orderId);
        if (remote) {
          this._finishPendingWrite(write);
          if (write.order) {
            this._registerPlaced(orderId, {
              ...write.order,
              price: Number(remote.price ?? write.order.price),
              sizeBase: Number(write.order.sizeBase ?? remote.sizeBase ?? remote.size),
            });
          }
        }
        continue;
      }
      let converged = false;
      if (write.kind === 'cancel') converged = !openIds.has(stableId(write.orderId));
      else if (write.kind === 'cancelAll') {
        converged = (write.orderIds || []).every((orderId) => !openIds.has(stableId(orderId)));
      } else if (write.kind === 'closePosition') {
        converged = positionPresent && Number.isFinite(positionSize) && Math.abs(positionSize) <= 1e-12;
      }
      if (!converged) {
        write.convergedReads = 0;
        continue;
      }
      write.convergedReads = (write.convergedReads || 0) + 1;
      if (write.convergedReads >= 2) this._pendingWrites.delete(writeId);
    }
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
