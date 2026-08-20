import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
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
  const state = { openOrders: [], lastPlaceArgs: null, placeCalls: 0, cancelCalls: 0 };
  const ex = new N1Exchange({ tradingArmed: true, pollMs: 500 });
  ex.nord = { getMarketStats: async () => ({ perpStats: { mark_price: 100 } }) };
  ex.accountId = 7;
  ex._ensureSession = async () => {};
  ex.user = {
    fetchInfo: async () => {},
    refreshSession: async () => {},
    placeOrder: async (args) => {
      state.placeCalls++;
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
  const state = { openOrders: [], placeArgs: null, baseUnits: null, sendCalls: 0 };
  const ex = new Venue({
    venue,
    orderGapMs: 0,
    orderDiscoveryAttempts: 1,
    orderDiscoveryPollMs: 0,
  });
  ex.client = {
    orderPackets: {
      buildLimitOrderPacket: async ({ side, baseUnits }) => {
        state.baseUnits = baseUnits;
        return {
          side,
          priceInTicks: 99,
          numBaseLots: 1000,
          orderFlags: 0,
        };
      },
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
  ex._marketPrecision.set(1, {
    baseLotsDecimals: 4,
    tickSizeInQuoteLots: 1,
    lotSize: 0.0001,
    priceStep: 0.01,
  });
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

const n1Partial = makeN1Harness({ placeResult: { actionId: 6n, fills: [] } });
let partialPosition = 0;
n1Partial.ex._refreshMarket = async () => ({
  price: 100,
  position: partialPosition ? { sizeBase: partialPosition } : null,
  openOrders: n1Partial.state.openOrders.map((row) => ({ ...row })),
});
await assert.rejects(n1Partial.ex.placeLimitOrder(order), (error) => error?.pending === true);
const partialClientOrderId = n1Partial.ex._pendingPlacements.keys().next().value;
n1Partial.state.openOrders = [{
  orderId: 606,
  clientOrderId: partialClientOrderId,
  side: 'buy',
  price: 99,
  sizeBase: 0.05,
}];
partialPosition = 0.05;
const partialFills = [];
n1Partial.ex.on('fill', (fill) => partialFills.push(fill));
await n1Partial.ex.fetchOpenOrders(1);
assert.equal(n1Partial.ex.getOpenOrders(1)[0].confirmedFillBase, 0.05, 'N1 must retain a partial fill while the remainder is open');
assert.equal(partialFills.length, 0, 'partial fill must not trigger a duplicate replacement while the remainder is open');
n1Partial.ex.getOpenOrders(1)[0].placedAt = Date.now() - n1Partial.ex._graceMs - 1;
n1Partial.state.openOrders = [];
await n1Partial.ex.fetchOpenOrders(1);
await n1Partial.ex.fetchOpenOrders(1);
assert.equal(partialFills.length, 1, 'N1 must emit the aggregated partial fill once the remote order is gone');
assert.equal(partialFills[0].sizeBase, 0.05);
n1Partial.ex.stop();

const n1Filled = makeN1Harness({ placeResult: { actionId: 3n, fills: [] } });
n1Filled.ex.markets.set(1, { stepPrice: 1 });
n1Filled.ex.nord.getTrades = async () => ({
  items: [{
    marketId: 0,
    makerId: 7,
    actionId: 3,
    takerSide: 'ask',
    orderId: 303,
    price: 99,
    baseSize: 0.1,
    time: new Date().toISOString(),
  }],
});
n1Filled.ex._refreshMarket = async () => {
  await n1Filled.ex._reconcilePendingPlacementFills(1);
  return { price: 100, position: null, openOrders: [] };
};
const n1Fills = [];
n1Filled.ex.on('fill', (fill) => n1Fills.push(fill));
const filledN1 = await n1Filled.ex.placeLimitOrder(order);
assert.equal(filledN1.orderId, '303', 'N1 must resolve a fully filled order from account trade history');
assert.equal(filledN1.filled, true);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(n1Fills.length, 1, 'N1 must emit the recovered fill after the caller can register the order');
assert.equal(n1Filled.ex._pendingPlacements.size, 0);
n1Filled.ex.stop();

const n1Background = makeN1Harness({ placeResult: { actionId: 4n, fills: [] } });
await assert.rejects(n1Background.ex.placeLimitOrder(order), (error) => error?.pending === true);
const backgroundFills = [];
n1Background.ex.on('fill', (fill) => backgroundFills.push(fill));
n1Background.ex._findPendingPlacementFill = async () => ({ orderId: 404, price: 99, sizeBase: 0.1 });
await n1Background.ex._reconcilePendingPlacementFills(1);
assert.equal(n1Background.ex._pendingPlacements.size, 0, 'background fill reconciliation must consume pending placement state');
assert.equal(n1Background.ex._pendingWrites.size, 0, 'background fill reconciliation must finish the pending write');
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(backgroundFills.length, 1, 'background fill reconciliation must emit the fill');
const resumedN1 = await n1Background.ex.placeLimitOrder(order);
assert.equal(resumedN1.orderId, '404', 'N1 must consume a background-resolved fill without resubmitting');
assert.equal(n1Background.state.placeCalls, 1, 'N1 background fill resolution must not send a second order');
assert.equal(n1Background.ex._pendingPlacements.size, 0);
n1Background.ex.stop();

const n1FillReceipt = makeN1Harness({
  placeResult: { actionId: 5n, fills: [{ orderId: 505n, price: 99, size: 0.1 }] },
});
const receiptFilledN1 = await n1FillReceipt.ex.placeLimitOrder(order);
assert.equal(receiptFilledN1.orderId, '505');
assert.equal(receiptFilledN1.filled, true, 'N1 fills-only receipt must be treated as a completed fill');
assert.equal(n1FillReceipt.ex.getOpenOrders(1).length, 0, 'N1 fills-only receipt must not create a phantom open order');
n1FillReceipt.ex.stop();

const n1Session = new N1Exchange({ pollMs: 500 });
let sessionRefreshes = 0;
n1Session.nord = {};
n1Session.accountId = 7;
n1Session.user = {
  refreshSession: async () => { sessionRefreshes++; },
};
n1Session.sessionExpiresAt = 0;
await n1Session._ensureSession();
assert.equal(sessionRefreshes, 1, 'N1 must refresh an expired session before writing');
await n1Session._ensureSession();
assert.equal(sessionRefreshes, 1, 'N1 must reuse a still-valid session');
n1Session.stop();

const n1Precision = new N1Exchange();
n1Precision._configureMarket({ symbol: 'ETHUSDC', priceDecimals: 2, sizeDecimals: 4 }, 100);
const [n1PrecisionMarket] = await n1Precision.getMarkets();
assert.equal(n1PrecisionMarket.stepPrice, 0.01, 'N1 must use authoritative priceDecimals');
assert.equal(n1PrecisionMarket.stepSize, 0.0001, 'N1 must use authoritative sizeDecimals');
assert.throws(
  () => n1Precision._configureMarket({ symbol: 'ETHUSDC', priceDecimals: 2 }, 100),
  /priceDecimals\/sizeDecimals 元数据/,
  'N1 must fail closed when market precision metadata is incomplete',
);

const phoenixPrecision = new PhoenixExchange({ venue: 'ph' });
const phoenixRows = phoenixPrecision._configureMarkets([{
  symbol: 'ALT-PERP',
  tickSize: 25,
  baseLotsDecimals: 2,
}]);
phoenixPrecision._setMarkets(phoenixRows, 100);
phoenixPrecision.client = {};
phoenixPrecision.kp = {};
phoenixPrecision.conn = {};
phoenixPrecision.authority = 'authority';
phoenixPrecision._mark = async () => 100;
phoenixPrecision._traderState = async () => ({
  snapshot: {
    subaccounts: [{
      subaccountIndex: 0,
      collateral: '1000000',
      positions: [{ symbol: 'ALT-PERP', basePositionLots: '3', entryPriceTicks: '40000' }],
      orders: [{
        symbol: 'ALT-PERP',
        orders: [{
          status: 'open',
          priceTicks: '40000',
          sizeRemainingLots: '2',
          orderSequenceNumber: '1',
          side: 'bid',
        }],
      }],
    }],
  },
});
const phoenixPrecisionSnapshot = await phoenixPrecision._refreshMarket(1);
assert.equal(phoenixRows[0].stepPrice, 0.0025, 'Phoenix must convert SDK tick metadata to display price step');
assert.equal(phoenixRows[0].stepSize, 0.01, 'Phoenix must convert SDK base lot metadata to base size step');
assert.equal(phoenixPrecisionSnapshot.position.sizeBase, 0.03, 'Phoenix positions must use the market base lot size');
assert.equal(phoenixPrecisionSnapshot.position.entryPrice, 100, 'Phoenix must convert raw entry ticks using market metadata');
assert.equal(phoenixPrecisionSnapshot.openOrders[0].price, 100, 'Phoenix must convert raw order ticks using market metadata');
assert.equal(phoenixPrecisionSnapshot.openOrders[0].sizeBase, 0.02, 'Phoenix open orders must use the market base lot size');
phoenixPrecision.stop();

for (const [Venue, venue] of [[PhoenixExchange, 'ph'], [Phoenix2Exchange, 'ph2']]) {
  const precision = makePhoenixHarness(Venue, venue);
  precision.ex._marketPrecision.set(1, {
    baseLotsDecimals: 2,
    tickSizeInQuoteLots: 25,
    lotSize: 0.01,
    priceStep: 0.25,
  });
  await precision.ex.placeLimitOrder({ ...order, sizeBase: 0.019 });
  assert.equal(precision.state.baseUnits, '0.01', venue + ' must round size using the market lot metadata');
  precision.ex.stop();

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

  const timeout = makePhoenixHarness(Venue, venue);
  const timeoutError = new Error('confirmation timeout');
  timeoutError.pending = true;
  timeoutError.txSignature = 'signature-timeout';
  timeout.ex._sendIxs = async () => { throw timeoutError; };
  await assert.rejects(
    timeout.ex.placeLimitOrder(order),
    (error) => error?.pending === true && error?.txSignature === 'signature-timeout',
    venue + ' confirmation timeout must remain pending with its transaction signature',
  );
  const timeoutPending = timeout.ex._pendingPlacements.values().next().value;
  assert.equal(
    timeoutPending?.txSignature,
    'signature-timeout',
    venue + ' must retain the transaction signature on pending placement state',
  );
  timeout.ex.stop();

  const filled = makePhoenixHarness(Venue, venue);
  filled.ex.client.api = {
    trades: () => ({
      getTraderTradesHistory: async () => ({
        data: [{
          marketSymbol: 'BTC-PERP',
          tradeType: 'limit',
          signature: 'signature',
          orderSequenceNumber: 7,
          baseLotsDelta: '1000',
          price: '99',
          timestamp: Date.now(),
        }],
      }),
    }),
  };
  filled.ex._refreshMarket = async () => {
    await filled.ex._reconcilePendingPlacementFills(1);
    return { price: 100, position: null, openOrders: [] };
  };
  const phoenixFills = [];
  filled.ex.on('fill', (fill) => phoenixFills.push(fill));
  const filledPhoenix = await filled.ex.placeLimitOrder(order);
  assert.equal(filledPhoenix.orderId, '99:7', venue + ' must recover a fully filled order from Phoenix trade history');
  assert.equal(filledPhoenix.filled, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(phoenixFills.length, 1, venue + ' must emit the recovered fill after the caller can register the order');
  assert.equal(filled.ex._pendingPlacements.size, 0);
  filled.ex.stop();
}

const phoenixTimeout = new PhoenixExchange({ venue: 'ph', computeUnitLimit: 200_000 });
phoenixTimeout.client = {};
phoenixTimeout.kp = Keypair.generate();
phoenixTimeout.authority = phoenixTimeout.kp.publicKey.toBase58();
phoenixTimeout.conn = {
  getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }),
  sendTransaction: async () => 'signature-timeout',
  confirmTransaction: async () => { throw new Error('confirmation timeout'); },
};
await assert.rejects(
  phoenixTimeout._sendIxs([]),
  (error) => error?.pending === true && error?.txSignature === 'signature-timeout',
  'Phoenix confirmation timeout must remain pending with its transaction signature',
);
phoenixTimeout.stop();

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

const nado = new NadoExchange({
  network: 'ink-testnet',
  orderDiscoveryAttempts: 1,
  orderDiscoveryPollMs: 0,
});
const nadoState = { open: false, placeCalls: 0, cancelCalls: 0 };
nado.address = '0x0000000000000000000000000000000000000001';
nado.client = {
  market: {
    getLatestMarketPrice: async () => ({ bid: 99, ask: 101 }),
    getOpenSubaccountOrders: async () => ({
      orders: nadoState.open ? [{ digest: 'digest-1', unfilledAmount: 0.00005, price: 99 }] : [],
    }),
    placeOrder: async () => {
      nadoState.placeCalls++;
      nadoState.open = true;
      return { status: 'success', data: { digest: 'digest-1' }, signature: 'sig' };
    },
    cancelOrders: async () => {
      nadoState.cancelCalls++;
      nadoState.open = false;
      return { status: 'success', data: { cancelled_orders: [] }, signature: 'sig' };
    },
  },
  subaccount: {
    getSubaccountSummary: async () => ({ balances: [], health: {} }),
  },
};
nado._mid = async () => 100;
const nadoPlaced = await nado.placeLimitOrder({ ...order, sizeBase: 0.00005 });
assert.equal(nadoPlaced.orderId, 'digest-1', 'Nado must return the digest only after authority confirms the order');
assert.equal(nadoState.placeCalls, 1);
await nado.cancelOrder(1, nadoPlaced.orderId);
assert.deepEqual(await nado.fetchOpenOrders(1), [], 'Nado cancellation must converge on the authoritative snapshot');
assert.equal(nadoState.cancelCalls, 1);
nado.stop();

const nadoUnknown = new NadoExchange({ network: 'ink-testnet' });
nadoUnknown.address = '0x0000000000000000000000000000000000000001';
nadoUnknown._refreshMarket = async () => ({ price: 100, position: null, openOrders: [] });
nadoUnknown.client = { market: { placeOrder: async () => undefined } };
await assert.rejects(
  nadoUnknown.placeLimitOrder({ ...order, sizeBase: 0.00005 }),
  (error) => error?.pending === true,
  'Nado must keep an empty write response pending',
);
assert.equal(nadoUnknown._pendingWrites.size, 1);
nadoUnknown.stop();

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
