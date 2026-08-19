import assert from 'node:assert/strict';
import { N1Exchange } from '../src/exchange/n1/live.js';
import { PhoenixExchange } from '../src/exchange/ph/live.js';
import { Phoenix2Exchange } from '../src/exchange/ph2/live.js';
import { NadoExchange } from '../src/exchange/na/live.js';

const order = {
  marketId: 1,
  side: 'buy',
  price: 99,
  sizeBase: 0.1,
  reduceOnly: false,
  levelIndex: 2,
  clientOrderId: 42,
};

function makeN1Harness({ placeResult, placeError = null } = {}) {
  const state = { openOrders: [], lastPlaceArgs: null, cancelCalls: 0 };
  const ex = new N1Exchange({ tradingArmed: true, pollMs: 500 });
  ex.nord = { getMarketStats: async () => ({ perpStats: { mark_price: 100 } }) };
  ex.accountId = 7;
  ex._ensureSession = async () => {};
  ex.user = {
    fetchInfo: async () => {},
    refreshSession: async () => {},
    placeOrder: async (args) => {
      state.lastPlaceArgs = args;
      if (placeError) throw placeError;
      return placeResult;
    },
    cancelOrder: async () => { state.cancelCalls++; state.openOrders = []; },
  };
  ex._refreshMarket = async () => ({
    price: 100,
    position: null,
    openOrders: state.openOrders.map((row) => ({ ...row })),
  });
  return { ex, state };
}

function makePhoenixHarness(Venue, venue) {
  const state = { openOrders: [], placeArgs: null, sendCalls: 0 };
  const ex = new Venue({
    venue,
    orderGapMs: 0,
    orderDiscoveryAttempts: 1,
    orderDiscoveryPollMs: 0,
  });
  ex.client = {
    orderPackets: {
      buildLimitOrderPacket: async ({ side }) => ({
        side,
        priceInTicks: 99,
        numBaseLots: 1000,
        orderFlags: 0,
      }),
    },
    ixs: {
      buildPlacePostOnlyOrder: async (args) => {
        state.placeArgs = args;
        return { kind: 'place' };
      },
      buildCancelOrdersById: async () => ({ kind: 'cancel' }),
    },
  };
  ex.kp = { publicKey: { toBase58: () => 'authority' } };
  ex.conn = {};
  ex.authority = 'authority';
  ex.symbolByMarket.set(1, 'BTC-PERP');
  ex._refreshMarket = async () => ({
    price: 100,
    position: null,
    openOrders: state.openOrders.map((row) => ({ ...row })),
  });
  ex._sendIxs = async (ixs) => {
    state.sendCalls++;
    if (ixs[0]?.kind === 'cancel') state.openOrders = [];
    if (ixs[0]?.kind === 'place' && state.placeArgs && state.openOrders.length === 0) {
      const clientOrderId = String(state.placeArgs.orderPacket.clientOrderId);
      state.openOrders = [{
        orderId: '100:1',
        clientOrderId,
        side: 'buy',
        price: 99,
        sizeBase: 0.1,
      }];
    }
    return 'signature';
  };
  return { ex, state };
}

const n1 = makeN1Harness({ placeResult: { actionId: 1n, orderId: 101n, fills: [] } });
const placedN1 = await n1.ex.placeLimitOrder(order);
assert.equal(placedN1.orderId, '101', 'N1 must expose the stable remote order id');
assert.equal(n1.ex.getOpenOrders(1).length, 1, 'N1 must track an accepted order');
await n1.ex.cancelOrder(1, placedN1.orderId);
assert.deepEqual(await n1.ex.fetchOpenOrders(1), [], 'N1 cancellation must converge on the authoritative snapshot');
assert.equal(n1.state.cancelCalls, 1);
n1.ex.stop();

const n1Pending = makeN1Harness({ placeResult: { actionId: 2n, fills: [] } });
await assert.rejects(
  n1Pending.ex.placeLimitOrder(order),
  (error) => error?.pending === true,
  'N1 must mark an order without a remote id as pending instead of allowing a duplicate write',
);
assert.equal(n1Pending.ex._pendingPlacements.size, 1);
const n1ClientOrderId = n1Pending.ex._pendingPlacements.keys().next().value;
n1Pending.state.openOrders = [{
  orderId: 202,
  clientOrderId: n1ClientOrderId,
  side: 'buy',
  price: 99,
  sizeBase: 0.1,
}];
assert.deepEqual((await n1Pending.ex.fetchOpenOrders(1)).map((row) => row.orderId), ['202']);
assert.equal(n1Pending.ex._pendingPlacements.size, 0, 'N1 must resolve pending placement from a later authoritative snapshot');
assert.equal(n1Pending.ex.getOpenOrders(1)[0].orderId, '202');
n1Pending.ex.stop();

for (const [Venue, venue] of [[PhoenixExchange, 'ph'], [Phoenix2Exchange, 'ph2']]) {
  const harness = makePhoenixHarness(Venue, venue);
  const placed = await harness.ex.placeLimitOrder(order);
  assert.equal(placed.orderId, '100:1', venue + ' must discover the authoritative Phoenix order id');
  await harness.ex.cancelOrder(1, placed.orderId);
  assert.deepEqual(await harness.ex.fetchOpenOrders(1), [], venue + ' cancellation must converge on the authoritative snapshot');
  harness.ex.stop();

  const pending = makePhoenixHarness(Venue, venue);
  pending.ex._sendIxs = async (ixs) => {
    pending.state.sendCalls++;
    if (ixs[0]?.kind === 'place') pending.state.placeArgs = pending.state.placeArgs;
    return 'signature';
  };
  await assert.rejects(
    pending.ex.placeLimitOrder(order),
    (error) => error?.pending === true,
    venue + ' must preserve an order-discovery timeout as pending',
  );
  assert.equal(pending.ex._pendingPlacements.size, 1);
  assert.equal(pending.state.sendCalls, 1, venue + ' must not resubmit while discovery is pending');
  const clientOrderId = pending.ex._pendingPlacements.keys().next().value;
  pending.state.openOrders = [{
    orderId: '200:2',
    clientOrderId,
    side: 'buy',
    price: 99,
    sizeBase: 0.1,
  }];
  assert.deepEqual((await pending.ex.fetchOpenOrders(1)).map((row) => row.orderId), ['200:2']);
  assert.equal(pending.ex._pendingPlacements.size, 0, venue + ' must resolve delayed order discovery');
  pending.ex.stop();
}

assert.throws(
  () => new NadoExchange({ network: 'unknown-network' }),
  /不支持 network|拒绝 LIVE/,
  'Nado must fail closed for an unknown network instead of silently selecting mainnet',
);

const nadoSnapshot = new NadoExchange({ network: 'ink-testnet' });
nadoSnapshot.client = {
  market: {
    getLatestMarketPrice: async () => ({ bid: 99, ask: 101 }),
  },
  subaccount: {
    getSubaccountSummary: async () => ({ balances: [], health: {} }),
  },
};
nadoSnapshot.address = '0x0000000000000000000000000000000000000001';
nadoSnapshot._mid = async () => 100;
nadoSnapshot.client.market.getOpenSubaccountOrders = async () => ({
  orders: [{ digest: null, unfilledAmount: 1, price: 99 }],
});
await assert.rejects(
  nadoSnapshot._refreshMarket(1),
  /digest|稳定订单 ID/,
  'Nado must reject an authoritative order snapshot without a digest',
);

const nadoClose = new NadoExchange({ network: 'ink-testnet' });
nadoClose.address = '0x0000000000000000000000000000000000000001';
nadoClose._refreshMarket = async () => ({
  price: 100,
  position: { sizeBase: 1 },
  openOrders: [],
});
nadoClose.client = {
  market: {
    placeOrder: async () => ({ status: 'failure', error: 'REDUCE_ONLY_NOT_TAKER' }),
  },
};
await assert.rejects(
  nadoClose.closePosition(1),
  /Nado 平仓失败|REDUCE_ONLY_NOT_TAKER/,
  'Nado must not report a failed IOC close as successful',
);

console.log('new live exchange lifecycle tests passed');
