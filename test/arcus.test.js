import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { ArcusExchange } from '../src/exchange/ar/arcus.js';
import {
  alignDecimal, buildCancelPayload, buildPlacePayload, canonicalJson,
  chooseTick, loadEd25519PrivateKey, publicKeyHex, signHex, toUnitsExact,
} from '../src/exchange/ar/signing.js';

// Exact decimal handling: JS floating noise must never leak into signed ticks.
assert.equal(alignDecimal(64721.50000000001, '0.1', 'nearest'), '64721.5');
assert.equal(alignDecimal('0.00123456789', '0.00000001', 'down'), '0.00123456');
assert.equal(toUnitsExact('600000.2', '0.1'), 6000002n);
assert.equal(chooseTick({ tickSize: '0.1', tickTiers: [
  { upToPrice: '500000', tick: '0.1' }, { upToPrice: '1000000', tick: '0.2' }, { tick: '0.5' },
] }, '600000.11'), '0.2');

assert.equal(canonicalJson({ z: 2, a: { y: true, x: 1n } }), '{"a":{"x":1,"y":true},"z":2}');

const address = '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD';
assert.equal(buildPlacePayload({
  address, accountIndex: 2, clientId: 'WG_ABC', timestamp: 1712345678000000000n,
  goodTilTimeUs: 4102444800000000n, marketId: 1, priceTicks: 500000n,
  quantityQuantums: 1000n, reduceOnly: false, side: 'BUY', timeInForce: 'GTT',
}), '{"ad":"0xabcdefabcdefabcdefabcdefabcdefabcdefabcd","ai":2,"c":"wg_abc","ct":1712345678000000000,"g":4102444800000000000,"m":1,"op":1,"p":500000,"q":1000,"r":0,"s":0,"t":0,"v":1}');

assert.equal(buildCancelPayload({
  address, accountIndex: 2, timestamp: 1712345678000000001n, orderId: '0x123', marketId: 1,
}), '{"ad":"0xabcdefabcdefabcdefabcdefabcdefabcdefabcd","ai":2,"ct":1712345678000000001,"id":"0x123","m":1,"op":2,"v":1}');

// Raw 32-byte seed support must reproduce the public half of a generated key.
const generated = generateKeyPairSync('ed25519');
const seed = generated.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
const loaded = loadEd25519PrivateKey({ value: seed });
assert.equal(publicKeyHex(loaded), generated.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'));
const message = 'arcus-signing-self-test';
const signature = Buffer.from(signHex(message, loaded), 'hex');
assert.equal(verify(null, Buffer.from(message), generated.publicKey, signature), true);

// Every ONLINE perpetual returned by Arcus is kept; offline rows are not offered
// because they cannot accept orders.
const ex = new ArcusExchange({});
ex._get = async () => ({ markets: [
  { marketId: 1, marketDisplayName: 'BTC-USD', baseAsset: 'BTC', type: 'PERPETUAL', status: 'ONLINE', markPrice: '100', tickSize: '0.1', stepSize: '0.001', minOrderSize: '0.001', minOrderNotional: '5', maxOrderSize: '10', initialMarginFraction: '0.05', tickTiers: [{ tick: '0.1' }] },
  { marketId: 2, marketDisplayName: 'ETH-USD', baseAsset: 'ETH', type: 'PERPETUAL', status: 'ONLINE', markPrice: '10', tickSize: '0.01', stepSize: '0.01', minOrderSize: '0.01', minOrderNotional: '5', maxOrderSize: '100', initialMarginFraction: '0.1', tickTiers: [{ tick: '0.01' }] },
  { marketId: 3, marketDisplayName: 'OFFLINE-USD', baseAsset: 'OFF', type: 'PERPETUAL', status: 'OFFLINE', markPrice: '1', tickSize: '0.01', stepSize: '1', initialMarginFraction: '0.1' },
] });
await ex._loadMarkets();
assert.deepEqual((await ex.getMarkets()).map((m) => m.displayName), ['BTC-USD', 'ETH-USD']);

// Arcus close uses the same existing adapter policy: reduce-only IOC and ±5%.
ex._positions.set(1, { sizeBase: 2, entryPrice: 100, unrealizedPnl: 0 });
ex._refreshPositions = async () => {};
ex.getPrice = async () => 100;
let closeOrder = null;
ex._submitOrder = async (o) => { closeOrder = o; return { orderId: 'close-test' }; };
await ex.closePosition(1);
assert.deepEqual(closeOrder, {
  marketId: 1, side: 'sell', price: 95, sizeBase: 2,
  reduceOnly: true, orderType: 'MARKET', timeInForce: 'IOC',
});

// Background REST reads are staggered: each scheduler tick executes at most
// one due endpoint instead of bursting prices/account/positions/openOrders.
const pollEx = new ArcusExchange({});
const pollCalls = [];
pollEx._refreshPrices = async () => { pollCalls.push('prices'); };
pollEx._refreshAccount = async () => { pollCalls.push('account'); };
pollEx._refreshPositions = async () => { pollCalls.push('positions'); };
pollEx._refreshOpenOrders = async () => { pollCalls.push('openOrders'); };
pollEx._initPollSchedule(1000);
assert.deepEqual(pollEx._nextPollAt, {
  prices: 61000, account: 71000, positions: 81000, openOrders: 11000,
});
pollEx._nextPollAt = { prices: 1000, account: 1000, positions: 1000, openOrders: 1000 };
await pollEx._poll(1000);
await pollEx._poll(1000);
await pollEx._poll(1000);
await pollEx._poll(1000);
assert.deepEqual(pollCalls, ['prices', 'account', 'positions', 'openOrders']);
assert.equal(pollEx._nextPollAt.prices, 61000);
assert.equal(pollEx._nextPollAt.account, 61000);
assert.equal(pollEx._nextPollAt.positions, 61000);
assert.equal(pollEx._nextPollAt.openOrders, 61000);

// Repeated IP 429s exponentially extend one shared read cooldown, while a
// quiet minute resets it to the server-provided delay.
const limitEx = new ArcusExchange({});
assert.equal(limitEx._registerReadRateLimit(1000, 100000), 1000);
assert.equal(limitEx._registerReadRateLimit(1000, 100500), 2000);
assert.equal(limitEx._registerReadRateLimit(3000, 101000), 4000);
assert.equal(limitEx._readRateLimitedUntil, 105000);
assert.equal(limitEx._registerReadRateLimit(1000, 200000), 1000);
assert.equal(limitEx._readRateLimitedUntil, 201000);

// Reads fail locally during cooldown (no HTTP request is sent); order writes
// deliberately do not use this gate because Arcus rates them separately.
limitEx._readRateLimitedUntil = Date.now() + 5000;
await assert.rejects(limitEx._get('/v1/prices'), (err) => err.status === 429 && err.localRateLimit === true && err.silent === true);

// High-frequency account/position WebSocket pushes must not each trigger a
// weighted REST reconciliation. Each channel owns its sequence space: a jump
// between channels is normal, while a gap inside one channel reconciles urgently.
const wsEx = new ArcusExchange({});
let reconcileCalls = 0;
let lastUrgent = false;
wsEx._scheduleReconcile = ({ urgent = false } = {}) => { reconcileCalls += 1; lastUrgent = urgent; };
wsEx._handleWsMessage({ type: 'channel_data', channel: 'account', contents: { accountIndex: 0, accountSequenceNum: 1 } });
wsEx._handleWsMessage({ type: 'channel_data', channel: 'positions', contents: { accountIndex: 0, accountSequenceNum: 200 } });
assert.equal(reconcileCalls, 0);
wsEx._handleWsMessage({ type: 'channel_data', channel: 'userFills', contents: { accountIndex: 0, accountSequenceNum: 50 } });
assert.equal(reconcileCalls, 1);
assert.equal(lastUrgent, false);
wsEx._handleWsMessage({ type: 'channel_data', channel: 'orders', contents: { accountIndex: 0, accountSequenceNum: 1000 } });
assert.equal(reconcileCalls, 1);
wsEx._handleWsMessage({ type: 'channel_data', channel: 'orders', contents: { accountIndex: 0, accountSequenceNum: 1002 } });
assert.equal(reconcileCalls, 2);
assert.equal(lastUrgent, true);

// Exchange-global order sequenceNumber values may jump because of unrelated
// users and must never be mistaken for a gap in this account.
wsEx._handleWsMessage({ type: 'channel_data', channel: 'orders', contents: { accountIndex: 0, sequenceNumber: 5000 } });
wsEx._handleWsMessage({ type: 'channel_data', channel: 'orders', contents: { accountIndex: 0, sequenceNumber: 9000 } });
assert.equal(reconcileCalls, 2);

// WebSocket snapshots are the primary live source for mark prices, equity and
// positions; malformed/foreign snapshots must not overwrite verified values.
const wsStateEx = new ArcusExchange({ accountIndex: 0 });
wsStateEx.markets.set(1, { marketId: 1, lastPrice: 100 });
wsStateEx._watch.add(1);
let wsPrice = null;
wsStateEx.on('price', (row) => { wsPrice = row.price; });
wsStateEx._handleWsMessage({ type: 'subscribed', channel: 'oraclePrices', contents: { prices: [{ marketId: 1, markPrice: '123.45' }] } });
assert.equal(wsStateEx._prices.get(1), 123.45);
assert.equal(wsPrice, 123.45);
wsStateEx._handleWsMessage({ type: 'subscribed', channel: 'account', contents: { isSnapshot: true, accountIndex: 0, netQuoteBalance: '490.3', accountEquity: '491.2', positions: { 1: { marketId: 1, side: 'LONG', size: '0.25', averageEntryPrice: '120' } } } });
assert.equal(wsStateEx.balance, 490.3);
assert.equal(wsStateEx.equity, 491.2);
assert.equal(wsStateEx.getPosition(1).sizeBase, 0.25);
wsStateEx._handleWsMessage({ type: 'subscribed', channel: 'positions', contents: { isSnapshot: true, accountIndex: 1, positions: {} } });
assert.equal(wsStateEx.getPosition(1).sizeBase, 0.25);
wsStateEx._handleWsMessage({ type: 'channel_data', channel: 'positions', contents: { isSnapshot: true, accountIndex: 0, positions: {} } });
assert.equal(wsStateEx.getPosition(1), null);

// Intermittent proxy failures retry idempotent reads once, while writes are
// never automatically replayed (a timed-out order may already be accepted).
const originalFetch = globalThis.fetch;
let fetchAttempts = 0;
let readConnectionHeader = null;
globalThis.fetch = async (_url, options) => {
  fetchAttempts += 1;
  readConnectionHeader = options?.headers?.Connection;
  if (fetchAttempts === 1) throw new Error('simulated proxy timeout');
  return { ok: true, status: 200, text: async () => '{"ok":true}' };
};
const retryEx = new ArcusExchange({ apiUrl: 'https://example.invalid' });
assert.deepEqual(await retryEx._get('/v1/time'), { ok: true });
assert.equal(fetchAttempts, 2);
assert.equal(readConnectionHeader, 'close');
fetchAttempts = 0;
globalThis.fetch = async () => { fetchAttempts += 1; throw new Error('simulated write timeout'); };
await assert.rejects(
  retryEx._req('POST', '/v1/placeOrder', {}),
  (err) => err.network === true && err.endpoint === '/v1/placeOrder' && /\/v1\/placeOrder/.test(err.message),
);
assert.equal(fetchAttempts, 1);
globalThis.fetch = originalFetch;

// A half-open WebSocket must be replaced when the documented five-second
// account snapshots have been silent for more than 20 seconds.
const staleWsEx = new ArcusExchange({});
let staleClosed = false;
let staleReconnects = 0;
staleWsEx._wsWanted = true;
staleWsEx._lastWsMessageAt = 1000;
staleWsEx._ws = { close: () => { staleClosed = true; } };
staleWsEx._scheduleWsReconnect = () => { staleReconnects += 1; };
assert.equal(staleWsEx._ensureWsFresh(21001), true);
assert.equal(staleClosed, true);
assert.equal(staleReconnects, 1);
assert.equal(staleWsEx._ws, null);
assert.equal(staleWsEx._wsNeedsReconcile, true);

// A malformed successful account response must fail closed without erasing the
// last verified live equity used by margin checks and dashboard totals.
const accountEx = new ArcusExchange({});
accountEx.balance = 123;
accountEx.equity = 124;
accountEx._get = async () => ({ netQuoteBalance: 'invalid', equity: null });
await assert.rejects(accountEx._refreshAccount(), /账户快照缺少有效/);
assert.equal(accountEx.balance, 123);
assert.equal(accountEx.equity, 124);

// Signed REST order entry keeps int64 timestamps as BigInt JSON numbers and
// signs the exact typed payload, without touching any real endpoint.
const tradeEx = new ArcusExchange({
  network: 'mainnet', apiUrl: 'https://example.invalid', wsUrl: '',
  address: address.toLowerCase(), accountIndex: 2,
  apiKey: publicKeyHex(loaded), apiPrivateKey: seed,
});
tradeEx._privateKey = loaded;
tradeEx.markets = ex.markets;
const calls = [];
tradeEx._req = async (method, path, body, headers) => {
  calls.push({ method, path, body, headers });
  return { orderId: '0xorder', status: 'ACK' };
};
await tradeEx.placeLimitOrder({ marketId: 1, side: 'buy', price: 99.96, sizeBase: 0.051, levelIndex: 7, clientOrderId: 123 });
assert.equal(calls.length, 1);
assert.equal(calls[0].method, 'POST');
assert.equal(calls[0].path, `/v1/placeOrder?address=${encodeURIComponent(address.toLowerCase())}`);
assert.equal(typeof calls[0].body.timestamp, 'bigint');
assert.equal(typeof calls[0].body.goodTilTime, 'string');
assert.match(calls[0].body.goodTilTime, /^\d+$/);
assert.equal(calls[0].body.price, '100');
assert.equal(calls[0].body.quantity, '0.051');
assert.equal(calls[0].body.clientId, 'wg123');
assert.equal(calls[0].headers['X-Signature'].length, 128);

console.log('arcus.test.js: all tests passed');
