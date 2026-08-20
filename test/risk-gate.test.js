import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RiskGuard } from '../src/risk.js';
import { GridBot } from '../src/bot.js';
import { VenuePaperExchange } from '../src/exchange/common/paper.js';

const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function observe(guard, prices, start = 0, step = 60_000, context = {}) {
  let decision;
  prices.forEach((price, i) => {
    decision = guard.observe({ price, timestamp: start + i * step, ...context });
  });
  return decision;
}

class FakeRiskExchange extends EventEmitter {
  constructor() {
    super();
    this.mode = 'paper';
    this.dataSource = 'real';
    this.balance = 10_000;
    this.equity = 10_000;
    this.lastOkAt = Date.now();
    this.feeRate = 0.0005;
    this.price = 100;
    this.orders = new Map();
    this.position = null;
    this.seq = 0;
    this.cancelCalls = [];
    this.closeCalls = 0;
  }

  async getMarkets() {
    return [{
      marketId: 1, displayName: 'TEST-PERP', symbol: 'TEST', lastPrice: 100,
      stepSize: 0.1, stepPrice: 0.1, minOrderSize: 0.1, maxLeverage: 10,
    }];
  }

  async getPrice() { return this.price; }
  async setLeverage() { return true; }
  start() {}

  async placeLimitOrder(order) {
    const orderId = `risk-${++this.seq}`;
    this.orders.set(orderId, { orderId, ...order });
    return { orderId, price: order.price, sizeBase: order.sizeBase };
  }

  async cancelOrder(_marketId, orderId) {
    this.cancelCalls.push(String(orderId));
    this.orders.delete(String(orderId));
    return true;
  }

  async cancelAll() {
    this.orders.clear();
    return true;
  }

  async fetchOpenOrders() {
    return [...this.orders.values()].map(({ orderId, price, side, sizeBase }) => ({ orderId, price, side, sizeBase }));
  }

  getPosition() { return this.position; }

  async closePosition() {
    this.closeCalls++;
    this.position = null;
    return true;
  }

  emitPrice(price, timestamp) {
    this.price = price;
    this.emit('price', { marketId: 1, price, timestamp });
  }
}

class DelayedBatchRiskExchange extends FakeRiskExchange {
  constructor() {
    super();
    this.batchStarted = new Promise((resolve) => { this._resolveBatchStarted = resolve; });
    this.batchRelease = new Promise((resolve) => { this._resolveBatchRelease = resolve; });
  }

  async placeLimitOrders(orders) {
    this._resolveBatchStarted();
    await this.batchRelease;
    return Promise.all(orders.map((order) => this.placeLimitOrder(order)));
  }

  releaseBatch() { this._resolveBatchRelease(); }
}

console.log('risk gate');

{
  const guard = new RiskGuard({ moveWindowMs: 300_000, softMovePct: 0.0075 }, { gridCount: 20, sizeBase: 1 });
  const decision = observe(guard, [100, 100.2, 99.9, 100.1, 99.8, 100], 0);
  assert.equal(decision.level, 'normal');
  assert.equal(guard.canPlace({ side: 'buy', opening: true, sizeBase: 1, positionSize: 0 }).allowed, true);
}

{
  const guard = new RiskGuard({
    moveWindowMs: 300_000,
    softMovePct: 0.0075,
    shockMovePct: 0.2,
    softConfirmations: 3,
    stableResumeMs: 1_000,
  }, { gridCount: 20, sizeBase: 1 });
  const decision = observe(guard, [100, 100.2, 100.5, 100.8, 101.2, 101.5]);
  assert.equal(decision.level, 'soft');
  assert.equal(decision.blockedSide, 'sell');
  assert.equal(guard.canPlace({ side: 'sell', opening: true, sizeBase: 1, positionSize: 0 }).allowed, false);
  assert.equal(guard.canPlace({ side: 'sell', opening: false, sizeBase: 1, positionSize: 1 }).allowed, true);
}

{
  const guard = new RiskGuard({ moveWindowMs: 300_000, softMovePct: 0.0075, shockMovePct: 0.5, stableResumeMs: 1_000 }, { gridCount: 20, sizeBase: 1 });
  observe(guard, [100, 100.2, 100.5, 100.8, 101.2, 101.5]);
  let decision = guard.observe({ price: 100.4, timestamp: 360_000 });
  assert.equal(decision.level, 'soft');
  decision = guard.observe({ price: 100.4, timestamp: 362_000 });
  assert.equal(decision.level, 'normal');
  assert.equal(guard.canPlace({ side: 'sell', opening: true, sizeBase: 1, positionSize: 0 }).allowed, true);
}

{
  const guard = new RiskGuard({ moveWindowMs: 300_000, shockMovePct: 0.02 }, { gridCount: 20, sizeBase: 1 });
  const decision = observe(guard, [100, 102.5], 0, 300_000);
  assert.equal(decision.level, 'emergency');
  assert.equal(decision.latched, true);
  assert.equal(guard.canPlace({ side: 'buy', opening: true, sizeBase: 1, positionSize: 0 }).allowed, false);
}

{
  const guard = new RiskGuard({ moveWindowMs: 300_000, shockMovePct: 0.02 }, { gridCount: 20, sizeBase: 1 });
  guard.observe({ price: 100, timestamp: 0 });
  const decision = guard.observe({ price: 105, timestamp: 900_000 });
  assert.equal(decision.level, 'emergency', 'a large jump after a quote gap must not lose its baseline');
}

{
  const guard = new RiskGuard({ maxPositionBase: 2, shockMovePct: 0.5 }, { gridCount: 20, sizeBase: 1 });
  const decision = guard.observe({
    price: 100,
    timestamp: 0,
    position: { sizeBase: 2, entryPrice: 99 },
  });
  assert.equal(decision.level, 'soft');
  assert.equal(decision.blockedSide, 'buy');
  assert.equal(guard.canPlace({ side: 'buy', opening: true, sizeBase: 1, positionSize: 2 }).allowed, false);
  assert.equal(guard.canPlace({ side: 'sell', opening: false, sizeBase: 1, positionSize: 2 }).allowed, true);
}

{
  const guard = new RiskGuard({ maxPositionBase: 2, shockMovePct: 0.5 }, { gridCount: 20, sizeBase: 1 });
  assert.equal(guard.canPlace({ side: 'sell', opening: true, sizeBase: 10, positionSize: 1 }).allowed, false, 'an opening order that flips past the cap must be blocked');
}

{
  const guard = new RiskGuard({ drawdownEmergencyPct: 0.1, shockMovePct: 0.5 }, { gridCount: 20, sizeBase: 1 });
  const decision = guard.observe({ price: 100, timestamp: 0, equity: 8_900, startBalance: 10_000 });
  assert.equal(decision.level, 'emergency');
  assert.match(decision.reasons.join(','), /drawdown/);
}

{
  const guard = new RiskGuard({ liquidationWarnPct: 0.08, liquidationEmergencyPct: 0.04, shockMovePct: 0.5 }, { gridCount: 20, sizeBase: 1 });
  const decision = guard.observe({
    price: 100,
    timestamp: 0,
    position: { sizeBase: 1, entryPrice: 110, liquidationPrice: 97 },
  });
  assert.equal(decision.level, 'emergency');
  assert.match(decision.reasons.join(','), /liquidation/);
}

{
  const ex = new FakeRiskExchange();
  const bot = new GridBot(ex, {
    cancelVerifyDelayMs: 0,
    cancelVerifyStableReads: 1,
    cancelVerifyAttempts: 3,
  });
  await bot.start({
    marketId: 1,
    mode: 'neutral',
    lower: 90,
    upper: 110,
    gridCount: 4,
    sizeBase: 1,
    leverage: 2,
    outOfRangeAction: 'close',
    riskGuard: {
      softMovePct: 0.005,
      shockMovePct: 0.02,
      moveWindowMs: 300_000,
      softConfirmations: 2,
      stableResumeMs: 1_000,
      maxPositionBase: 10,
    },
  });
  const base = Date.now();
  const initialOrders = [...ex.orders.values()];
  assert.ok(initialOrders.some((order) => order.side === 'sell'));

  ex.emitPrice(100, base);
  ex.emitPrice(100.4, base + 60_000);
  ex.emitPrice(101, base + 120_000);
  ex.emitPrice(101.5, base + 300_000);
  await sleep();

  const soft = bot.getState();
  assert.equal(soft.riskGuard.level, 'soft');
  assert.ok([...ex.orders.values()].every((order) => order.side !== 'sell'));
  await assert.rejects(() => bot.refillGrid(), /风险闸门/);

  ex.position = { sizeBase: -1, entryPrice: 100, liquidationPrice: null };
  ex.emitPrice(104, base + 600_000);
  for (let i = 0; i < 240 && bot.running; i++) await sleep(10);
  assert.equal(bot.getState().riskGuard.level, 'emergency');
  assert.equal(bot.running, false);
  assert.equal(ex.closeCalls, 1);
}

{
  const ex = new FakeRiskExchange();
  const bot = new GridBot(ex, {
    cancelVerifyDelayMs: 0,
    cancelVerifyStableReads: 1,
    cancelVerifyAttempts: 3,
  });
  const order = await ex.placeLimitOrder({ marketId: 1, side: 'sell', price: 105, sizeBase: 1, reduceOnly: false });
  const at = Date.now();
  await bot.resume({
    config: {
      marketId: 1, displayName: 'TEST-PERP', mode: 'neutral', lower: 90, upper: 110,
      gridCount: 4, sizeBase: 1, leverage: 2, outOfRangeAction: 'close',
      riskGuard: { moveWindowMs: 300_000, shockMovePct: 0.02, maxPositionBase: 10 },
    },
    stats: {}, recovery: false, pnlBase: null, startBalance: 10_000,
    outOfRange: false, lastPrice: 100,
    riskGuard: {
      priceHistory: [{ price: 100, timestamp: at - 300_000 }, { price: 102.5, timestamp: at }],
      lastPrice: 102.5, lastTimestamp: at, direction: 1, directionStreak: 1,
      level: 'emergency', blockedSides: ['buy', 'sell'], reason: 'shock-move',
      reasons: ['shock-move'], softSince: at, stableSince: null, latched: true,
      updatedAt: at,
      decision: { level: 'emergency', blockedSide: 'both', blockedSides: ['buy', 'sell'], reason: 'shock-move', reasons: ['shock-move'], latched: true },
    },
    active: [[order.orderId, { levelIndex: 3, side: 'sell', price: 105, sizeBase: 1, opening: true, reduceOnly: false }]],
    placementProgress: null, retryQueue: [],
  });
  for (let i = 0; i < 100 && bot.running; i++) await sleep(10);
  assert.equal(bot.getState().riskGuard.level, 'emergency');
  assert.equal(bot.running, false, 'a resumed emergency latch must fail closed');
  assert.equal(ex.closeCalls, 1);
}

{
  const ex = new DelayedBatchRiskExchange();
  const bot = new GridBot(ex, {
    cancelVerifyDelayMs: 0,
    cancelVerifyStableReads: 1,
    cancelVerifyAttempts: 3,
  });
  const starting = bot.start({
    marketId: 1,
    mode: 'neutral',
    lower: 90,
    upper: 110,
    gridCount: 4,
    sizeBase: 1,
    leverage: 2,
    riskGuard: {
      softMovePct: 0.005,
      shockMovePct: 0.2,
      moveWindowMs: 300_000,
      softConfirmations: 2,
      stableResumeMs: 1_000,
      maxPositionBase: 10,
    },
  });
  await ex.batchStarted;
  const base = Date.now();
  ex.emitPrice(100, base);
  ex.emitPrice(100.4, base + 60_000);
  ex.emitPrice(101, base + 120_000);
  ex.emitPrice(101.5, base + 300_000);
  assert.equal(bot.getState().riskGuard.level, 'soft');
  ex.releaseBatch();
  await starting;
  await sleep(20);
  assert.ok([...ex.orders.values()].some((order) => order.side === 'buy'));
  assert.ok([...ex.orders.values()].every((order) => order.side !== 'sell'), 'a soft gate must cancel adverse orders returned by an in-flight batch');
  await bot.stop({ closePosition: false });
}

{
  const paper = new VenuePaperExchange({
    venue: 'risk-race',
    tickMs: 60_000,
    markets: [{ marketId: 1, displayName: 'TEST-PERP', symbol: 'TEST', lastPrice: 100, stepSize: 1, stepPrice: 1, minOrderSize: 1 }],
  });
  await paper.init();
  const first = await paper.placeLimitOrder({ marketId: 1, side: 'buy', price: 99, sizeBase: 1, reduceOnly: false });
  const second = await paper.placeLimitOrder({ marketId: 1, side: 'buy', price: 98, sizeBase: 1, reduceOnly: false });
  let fills = 0;
  paper.on('fill', () => {
    fills++;
    if (fills === 1) paper.cancelOrder(1, second.orderId);
  });
  paper.setPrice(1, 97);
  assert.equal(fills, 1, 'a cancellation during one fill must prevent a later snapshot item from filling');
  assert.equal(paper.getOpenOrders(1).length, 0);
  assert.ok(first.orderId);
  paper.stop();
}

console.log('risk gate tests passed');
