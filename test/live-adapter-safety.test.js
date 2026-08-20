import assert from 'node:assert/strict';
import { LiveVenueExchange } from '../src/exchange/common/live.js';
import { NadoExchange } from '../src/exchange/na/live.js';
import { PopdexExchange } from '../src/exchange/pd/live.js';

function snapshot(position, openOrders) {
  return { price: 100, position: position ? { sizeBase: position } : null, openOrders };
}

function track(ex, order) {
  ex.adoptOrder({ marketId: 1, ...order });
  ex._tracked.get(String(order.orderId)).placedAt = Date.now() - 10_000;
}

const cancelled = new LiveVenueExchange({ venue: 'cancel-test', pollMs: 500 });
const cancelledFills = [];
cancelled.on('fill', (fill) => cancelledFills.push(fill));
track(cancelled, { orderId: 'cancel-1', side: 'buy', price: 99, sizeBase: 1 });
cancelled._applySnapshot(1, snapshot(0, [{ orderId: 'cancel-1', side: 'buy', price: 99, sizeBase: 1 }]));
cancelled._applySnapshot(1, snapshot(0, []));
cancelled._applySnapshot(1, snapshot(0, []));
assert.equal(cancelledFills.length, 0, 'order disappearance without position change is not a fill');

const filled = new LiveVenueExchange({ venue: 'fill-test', pollMs: 500 });
const fills = [];
filled.on('fill', (fill) => fills.push(fill));
track(filled, { orderId: 'fill-1', side: 'buy', price: 99, sizeBase: 1 });
filled._applySnapshot(1, snapshot(0, [{ orderId: 'fill-1', side: 'buy', price: 99, sizeBase: 1 }]));
filled._applySnapshot(1, snapshot(1, []));
filled._applySnapshot(1, snapshot(1, []));
assert.equal(fills.length, 1, 'position change plus disappearance is a fill');
assert.equal(fills[0].sizeBase, 1);

const partial = new LiveVenueExchange({ venue: 'partial-test', pollMs: 500 });
const partialFills = [];
partial.on('fill', (fill) => partialFills.push(fill));
track(partial, { orderId: 'partial-1', side: 'sell', price: 101, sizeBase: 1 });
partial._applySnapshot(1, snapshot(0, [{ orderId: 'partial-1', side: 'sell', price: 101, sizeBase: 1 }]));
partial._applySnapshot(1, snapshot(-0.4, [{ orderId: 'partial-1', side: 'sell', price: 101, sizeBase: 0.6 }]));
assert.equal(partialFills.length, 0, 'partial fill stays tracked while the order remains open');
partial._applySnapshot(1, snapshot(-0.4, []));
partial._applySnapshot(1, snapshot(-0.4, []));
assert.equal(partialFills.length, 1, 'confirmed partial execution is emitted after the order closes');
assert.equal(partialFills[0].sizeBase, 0.4);

const cachedOutcome = new LiveVenueExchange({ venue: 'cached-outcome-test', pollMs: 500 });
const cachedPending = cachedOutcome._beginPendingPlacement(
  { marketId: 1, side: 'buy', price: 99, sizeBase: 1, clientOrderId: 'cached-client-1' },
  'cached-client-1',
);
assert.equal(cachedOutcome._markPendingPlacementFilled(cachedPending, {
  orderId: 'cached-fill-1',
  price: 99,
  sizeBase: 1,
}), true);
cachedOutcome._publishPendingPlacementOutcome(cachedPending);
assert.doesNotThrow(
  () => cachedOutcome._assertNoPendingPlacements('下单'),
  'a resolved fill cache must not block an unrelated grid write',
);
assert.equal(
  cachedOutcome._takePendingPlacementOutcome({ marketId: 1, side: 'buy', price: 99, sizeBase: 2, clientOrderId: 'cached-client-1' }),
  null,
  'a different order size must not consume a cached fill outcome',
);
assert.equal(
  cachedOutcome._takePendingPlacementOutcome({ marketId: 1, side: 'buy', price: 99, sizeBase: 1 }),
  null,
  'an order without a stable client id must not consume a cached fill outcome',
);
assert.deepEqual(
  cachedOutcome._takePendingPlacementOutcome({ marketId: 1, side: 'buy', price: 99, sizeBase: 1, clientOrderId: 'cached-client-1' }),
  { orderId: 'cached-fill-1', price: 99, sizeBase: 1, filled: true },
  'the same order must still consume its cached fill outcome without resubmitting',
);

const aliasedOutcome = new LiveVenueExchange({ venue: 'aliased-outcome-test', pollMs: 500 });
const aliasedPending = aliasedOutcome._beginPendingPlacement(
  { marketId: 1, side: 'buy', price: 99, sizeBase: 1, clientOrderId: 'remote-1', requestClientOrderId: 'request-1' },
  'remote-1',
);
aliasedOutcome._markPendingPlacementFilled(aliasedPending, {
  orderId: 'aliased-fill-1',
  price: 99,
  sizeBase: 1,
});
aliasedOutcome._publishPendingPlacementOutcome(aliasedPending);
assert.equal(
  aliasedOutcome._takePendingPlacementOutcome({ marketId: 1, side: 'buy', price: 99, sizeBase: 1, clientOrderId: 'request-2' }),
  null,
  'a different request client id must not consume a cached fill outcome',
);
assert.equal(
  aliasedOutcome._takePendingPlacementOutcome({ marketId: 1, side: 'buy', price: 99, sizeBase: 1, clientOrderId: 'request-1' })?.orderId,
  'aliased-fill-1',
  'the original request client id must consume the aliased cached fill outcome',
);

const cancelledAfterPartial = new LiveVenueExchange({ venue: 'cancel-partial-test', pollMs: 500 });
const cancelledAfterPartialFills = [];
cancelledAfterPartial.on('fill', (fill) => cancelledAfterPartialFills.push(fill));
track(cancelledAfterPartial, { orderId: 'cancel-partial-1', side: 'buy', price: 99, sizeBase: 1 });
cancelledAfterPartial._applySnapshot(1, snapshot(0, [{ orderId: 'cancel-partial-1', side: 'buy', price: 99, sizeBase: 1 }]));
cancelledAfterPartial._applySnapshot(1, snapshot(0.3, [{ orderId: 'cancel-partial-1', side: 'buy', price: 99, sizeBase: 0.7 }]));
cancelledAfterPartial._markCancelled('cancel-partial-1');
cancelledAfterPartial._applySnapshot(1, snapshot(0.3, []));
assert.equal(cancelledAfterPartialFills.length, 1, 'confirmed partial execution is retained when the remainder is cancelled');
assert.equal(cancelledAfterPartialFills[0].sizeBase, 0.3);

const nadoTestnet = new NadoExchange({ network: 'ink-testnet' });
assert.equal(nadoTestnet.chainEnv, 'inkTestnet', 'Nado should honor the configured chain');
nadoTestnet.client = {};
nadoTestnet.address = '0x0000000000000000000000000000000000000001';
await assert.rejects(
  nadoTestnet.placeLimitOrder({ marketId: 1, side: 'sell', price: 101, sizeBase: 1, reduceOnly: true }),
  /仅支持 taker reduce-only/,
  'Nado must fail closed when a reduce-only maker leg cannot be represented',
);

const popdex = new PopdexExchange();
popdex.address = '0x0000000000000000000000000000000000000001';
popdex._mid = async () => 100;
popdex._apiGet = async (pathname) => {
  if (pathname.includes('/positions')) throw new Error('positions unavailable');
  if (pathname.includes('/overview')) return { accountEquity: 1000 };
  return [];
};
await assert.rejects(
  popdex._refreshMarket(1),
  /positions unavailable/,
  'PopDEX must not turn an account API failure into an empty snapshot',
);

console.log('live adapter disappearance/fill safety tests passed');
