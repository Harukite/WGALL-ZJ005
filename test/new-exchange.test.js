import assert from 'node:assert/strict';
import { GridBot } from '../src/bot.js';
import { getConfig } from '../src/config.js';
import { createExchange as createN1Exchange } from '../src/exchange/n1/index.js';
import { createExchange as createPhoenixExchange } from '../src/exchange/ph/index.js';
import { createExchange as createPhoenix2Exchange } from '../src/exchange/ph2/index.js';
import { createExchange as createNadoExchange } from '../src/exchange/na/index.js';
import { createExchange as createPopdexExchange } from '../src/exchange/pd/index.js';

const factories = [
  ['n1', createN1Exchange],
  ['ph', createPhoenixExchange],
  ['ph2', createPhoenix2Exchange],
  ['na', createNadoExchange],
  ['pd', createPopdexExchange],
];

const cfg = getConfig();

for (const [key, factory] of factories) {
  const ex = factory({
    ...cfg[key],
    mode: 'paper',
    tickMs: 60_000,
    marketPrice: 100,
    realMarketData: false,
  });
  await ex.init();
  const markets = await ex.getMarkets();
  assert.ok(markets.length > 0, `${key} paper should expose a market`);
  const market = markets[0];
  assert.ok(market.stepSize > 0, `${key} paper should expose size precision`);
  assert.ok(market.stepPrice > 0, `${key} paper should expose price precision`);

  const result = await ex.placeLimitOrder({
    marketId: market.marketId,
    side: 'buy',
    price: 99,
    sizeBase: Math.max(market.minOrderSize, market.stepSize),
    reduceOnly: false,
    levelIndex: 1,
    clientOrderId: 123,
  });
  assert.ok(result?.orderId, `${key} paper must return an order id`);
  const open = await ex.fetchOpenOrders(market.marketId);
  assert.equal(open.length, 1, `${key} paper should report its resting order`);
  assert.equal(String(open[0].orderId), String(result.orderId));
  assert.equal(open[0].side, 'buy');

  await ex.cancelOrder(market.marketId, result.orderId);
  assert.equal((await ex.fetchOpenOrders(market.marketId)).length, 0);

  const bot = new GridBot(ex, {
    cancelVerifyDelayMs: 1,
    cancelVerifyStableReads: 1,
    cancelVerifyAttempts: 3,
  });
  const price = await ex.getPrice(market.marketId);
  const size = Math.max(market.minOrderSize, market.stepSize);
  const state = await bot.start({
    marketId: market.marketId,
    mode: 'neutral',
    lower: price * 0.9,
    upper: price * 1.1,
    gridCount: 4,
    sizeBase: size,
    leverage: 2,
    outOfRangeAction: 'close',
  });
  assert.equal(state.running, true, `${key} should run the existing GridBot`);
  assert.ok(state.openOrders > 0, `${key} GridBot should seed resting orders`);
  await bot.stop({ closePosition: false });
  assert.equal((await ex.fetchOpenOrders(market.marketId)).length, 0);

  for (const mode of ['long', 'short']) {
    const directionalState = await bot.start({
      marketId: market.marketId,
      mode,
      lower: price * 0.9,
      upper: price * 1.1,
      gridCount: 4,
      sizeBase: size,
      leverage: 2,
      outOfRangeAction: 'close',
    });
    assert.equal(directionalState.running, true, `${key} should run the existing ${mode} GridBot`);
    const directionalOrders = await ex.fetchOpenOrders(market.marketId);
    assert.ok(directionalOrders.length > 0, `${key} ${mode} GridBot should seed resting orders`);
    assert.ok(directionalOrders.every((order) => order.side === (mode === 'long' ? 'buy' : 'sell')));
    await bot.stop({ closePosition: false });
    assert.equal((await ex.fetchOpenOrders(market.marketId)).length, 0);
  }

  ex.stop?.();
}

console.log('new exchange paper adapters and GridBot integration passed');
