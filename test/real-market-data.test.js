import assert from 'node:assert/strict';
import { NewVenuePaperExchange } from '../src/exchange/common/new-paper.js';

const candles = [
  { time: 1_700_000_000_000, open: 100, high: 105, low: 99, close: 103, volume: 12 },
  { time: 1_700_003_600_000, open: 103, high: 107, low: 102, close: 106, volume: 18 },
  { time: 1_700_007_200_000, open: 106, high: 108, low: 104, close: 105, volume: 16 },
];

const exchange = new NewVenuePaperExchange('ph', {
  realMarketData: true,
  tickMs: 60_000,
  realPollMs: 60_000,
  realPriceLoader: async () => 106.5,
  realCandleLoader: async () => candles,
});

await exchange.init();
assert.equal(exchange.dataSource, 'real', 'paper 应标记为真实行情源');
assert.equal(await exchange.getPrice(1), 106.5, 'paper 价格应来自真实行情读取器');
assert.deepEqual(await exchange.getCandles(1, 3600, 3), candles, 'paper K 线应来自真实行情读取器');

const placed = await exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 100, sizeBase: 0.001 });
assert.match(placed.orderId, /^ph-paper-/, 'paper 下单仍应使用本地订单');
assert.equal(exchange.getOpenOrders(1).length, 1, 'paper 订单撮合仍应保持本地状态');
exchange.stop();

const fallback = new NewVenuePaperExchange('ph', {
  realMarketData: true,
  tickMs: 60_000,
  realPollMs: 60_000,
  realPriceLoader: async () => { throw new Error('test network failure'); },
  realCandleLoader: async () => { throw new Error('test candle failure'); },
});

await fallback.init();
assert.equal(fallback.dataSource, 'synthetic', '真实行情不可用时应安全回退并标记合成行情');
assert.equal((await fallback.getCandles(1, 3600, 20)).length, 20, '回退 K 线仍应满足现有页面最小数据量');
fallback.stop();

const degraded = new NewVenuePaperExchange('ph', {
  realMarketData: true,
  tickMs: 60_000,
  realPollMs: 60_000,
  realPriceLoader: async () => 106.5,
  realCandleLoader: async () => { throw new Error('temporary candle failure'); },
});

await degraded.init();
assert.equal(degraded.dataSource, 'real', '价格源可用时仍应保持真实行情状态');
assert.deepEqual(await degraded.getCandles(1, 3600, 20), [], '无缓存 K 线失败时不能把合成数据冒充真实行情');
const lastOkAt = 123;
degraded.lastOkAt = lastOkAt;
degraded._realPriceLoader = async () => { throw new Error('temporary price failure'); };
assert.equal(await degraded.reconnect(), false, '重连失败应返回失败');
assert.equal(degraded.lastOkAt, lastOkAt, '重连失败不能刷新真实行情时间');
degraded.stop();

console.log('real-market-data tests passed');
