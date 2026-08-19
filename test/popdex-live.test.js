import assert from 'node:assert/strict';
import http from 'node:http';
import { decodeFunctionData, parseTransaction, toFunctionSelector } from 'viem';
import { PopdexExchange } from '../src/exchange/pd/live.js';

const TEST_PRIVATE_KEY = '0x' + '11'.repeat(32);

function sendJson(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function startApi(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const healthyAccountApi = (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname.includes('/config/symbol')) {
    return sendJson(res, { code: '50005', msg: 'symbol config unavailable', data: null });
  }
  if (pathname.includes('/public/market/tickers')) {
    return sendJson(res, {
      code: '200', msg: 'success',
      data: [{ symbol: 'BTCUSDT', bid1Price: '99', ask1Price: '101', markPrice: '100', lastPrice: '100' }],
    });
  }
  if (pathname.includes('/overview')) return sendJson(res, { code: '200', msg: 'success', data: { accountEquity: '1000' } });
  if (pathname.includes('/positions')) return sendJson(res, { code: '200', msg: 'success', data: [] });
  if (pathname.includes('/orders')) return sendJson(res, { code: '200', msg: 'success', data: [] });
  return sendJson(res, { code: '50005', msg: 'not found', data: null }, 404);
};

const api = await startApi(healthyAccountApi);
const exchange = new PopdexExchange({
  apiUrl: api.url,
  privateKey: TEST_PRIVATE_KEY,
  symbol: 'BTCUSDT',
  orderGapMs: 0,
});

await assert.rejects(
  exchange.init(),
  /symbol metadata|symbol config|市场配置/,
  'live init must fail closed when authoritative symbol metadata is unavailable',
);

exchange.stop();
exchange.disconnect();
await api.close();

console.log('popdex live metadata safety test passed');

const placeAbi = [{
  type: 'function',
  name: 'placeOrder',
  inputs: [
    { name: 'account', type: 'address' },
    { name: 'clientOrderId', type: 'bytes32' },
    { name: 'symbolId', type: 'uint16' },
    { name: 'orderParams', type: 'bytes32' },
    { name: 'price', type: 'uint256' },
    { name: 'qty', type: 'uint256' },
    { name: 'slippage', type: 'uint256' },
    { name: 'builder', type: 'address' },
    { name: 'builderFeeRate', type: 'uint256' },
  ],
  outputs: [{ name: 'success', type: 'bool' }],
}];

const cancelAbi = [{
  type: 'function',
  name: 'cancelOrder',
  inputs: [
    { name: 'account', type: 'address' },
    { name: 'orderId', type: 'uint128' },
    { name: 'clientOrderId', type: 'bytes32' },
  ],
  outputs: [{ name: 'success', type: 'bool' }],
}];

const placeSelector = toFunctionSelector(placeAbi[0]);
const cancelSelector = toFunctionSelector(cancelAbi[0]);

const tradingState = {
  open: false,
  clientOid: '',
  cancelClientOid: '',
  writes: 0,
  hideOrders: false,
  receiptCalls: 0,
  receiptNotBefore: 0,
  rpcChainId: '0x888',
  injectDiscoveryError: false,
  ordersError: false,
};

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

const tradingApi = await startApi(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/v1/web3/rpc') {
    const body = await readBody(req);
    let result = null;
    if (body.method === 'eth_chainId') result = tradingState.rpcChainId;
    else if (body.method === 'eth_getTransactionCount') result = '0x0';
    else if (body.method === 'eth_fillTransaction') {
      const request = body.params[0];
      result = {
        tx: {
          ...request,
          input: request.data,
          gas: request.gas || '0x7a120',
          gasPrice: request.gasPrice || '0x0',
          nonce: request.nonce || '0x0',
          chainId: request.chainId || '0x888',
        },
      };
    }
    else if (body.method === 'eth_sendRawTransaction') {
      const parsed = parseTransaction(body.params[0]);
      if (parsed.to?.toLowerCase() !== '0x0000000000000000000000000000000000001000') throw new Error('unexpected order contract');
      const selector = parsed.data.slice(0, 10).toLowerCase();
      if (selector === placeSelector.toLowerCase()) {
        const place = decodeFunctionData({ abi: placeAbi, data: parsed.data });
        tradingState.clientOid = String(place.args[1]);
        tradingState.open = true;
        if (tradingState.injectDiscoveryError) tradingState.ordersError = true;
      } else if (selector === cancelSelector.toLowerCase()) {
        const cancel = decodeFunctionData({ abi: cancelAbi, data: parsed.data });
        tradingState.cancelClientOid = String(cancel.args[2]);
        tradingState.open = false;
      } else {
        throw new Error('unexpected function selector ' + selector);
      }
      tradingState.writes++;
      result = '0x' + String(tradingState.writes).padStart(64, '0');
    } else if (body.method === 'eth_getTransactionReceipt') {
      tradingState.receiptCalls++;
      result = tradingState.receiptCalls <= tradingState.receiptNotBefore ? null : {
        transactionHash: body.params[0],
        blockNumber: '0x1',
        status: '0x1',
        logs: [],
      };
    } else {
      throw new Error('unexpected RPC method ' + body.method);
    }
    return sendJson(res, { jsonrpc: '2.0', id: body.id, result });
  }
  if (url.pathname.includes('/config/symbol')) {
    return sendJson(res, {
      code: '200', msg: 'success',
      data: { symbolId: '20000', tickSize: '1', lotSize: '0.0001', minQty: '0.0001', minNotional: '10' },
    });
  }
  if (url.pathname.includes('/public/market/tickers')) {
    return sendJson(res, {
      code: '200', msg: 'success',
      data: [{ symbol: 'BTCUSDT', bid1Price: '99', ask1Price: '101', markPrice: '100', lastPrice: '100' }],
    });
  }
  if (url.pathname.includes('/overview')) return sendJson(res, { code: '200', msg: 'success', data: { accountEquity: '1000' } });
  if (url.pathname.includes('/positions')) return sendJson(res, { code: '200', msg: 'success', data: [] });
  if (url.pathname.includes('/orders')) {
    if (tradingState.ordersError) return sendJson(res, { code: '50005', msg: 'indexer temporarily unavailable', data: null }, 500);
    const data = tradingState.open && !tradingState.hideOrders ? [{
      orderId: '42',
      clientOid: tradingState.clientOid,
      side: 'buy',
      price: '99',
      remainingQty: '0.2',
    }] : [];
    return sendJson(res, { code: '200', msg: 'success', data });
  }
  return sendJson(res, { code: '50005', msg: 'not found', data: null }, 404);
});

const tradingExchange = new PopdexExchange({
  apiUrl: tradingApi.url,
  privateKey: TEST_PRIVATE_KEY,
  symbol: 'BTCUSDT',
  orderGapMs: 0,
  receiptPollMs: 0,
  receiptPollAttempts: 1,
  orderDiscoveryPollMs: 0,
  orderDiscoveryAttempts: 1,
});

tradingState.rpcChainId = '0x889';
const wrongChainExchange = new PopdexExchange({
  apiUrl: tradingApi.url,
  privateKey: TEST_PRIVATE_KEY,
  symbol: 'BTCUSDT',
});
await assert.rejects(wrongChainExchange.init(), /chainId mismatch/, 'LIVE must refuse an unexpected RPC chain');
wrongChainExchange.stop();
wrongChainExchange.disconnect();
tradingState.rpcChainId = '0x888';

try {
  await tradingExchange.init();
  const placed = await tradingExchange.placeLimitOrder({
    marketId: 1,
    side: 'buy',
    price: 99,
    sizeBase: 0.2,
    reduceOnly: false,
    levelIndex: 1,
    clientOrderId: 123,
  });
  assert.equal(placed.orderId, '42');
  assert.match(tradingState.clientOid, /^0x[0-9a-f]{64}$/i);

  await tradingExchange.cancelOrder(1, placed.orderId);
  assert.equal(tradingState.cancelClientOid, tradingState.clientOid, 'cancel must carry the discovered clientOid');
  assert.deepEqual(await tradingExchange.fetchOpenOrders(1), [], 'authoritative snapshot must confirm cancellation');

  tradingState.injectDiscoveryError = true;
  const failedDiscoveryExchange = new PopdexExchange({
    apiUrl: tradingApi.url,
    privateKey: TEST_PRIVATE_KEY,
    symbol: 'BTCUSDT',
    orderGapMs: 0,
    receiptPollMs: 0,
    receiptPollAttempts: 1,
    orderDiscoveryPollMs: 0,
    orderDiscoveryAttempts: 1,
  });
  try {
    await failedDiscoveryExchange.init();
    let discoveryReadError;
    try {
      await failedDiscoveryExchange.placeLimitOrder({
        marketId: 1,
        side: 'buy',
        price: 99,
        sizeBase: 0.2,
        reduceOnly: false,
        levelIndex: 2,
        clientOrderId: 124,
      });
    } catch (error) {
      discoveryReadError = error;
    }
    assert.equal(discoveryReadError?.pending, true, 'order discovery errors must remain pending');
    assert.equal(failedDiscoveryExchange._pendingOrders.size, 1, 'discovery errors must remain reconcilable');

    tradingState.injectDiscoveryError = false;
    tradingState.ordersError = false;
    assert.deepEqual((await failedDiscoveryExchange.fetchOpenOrders(1)).map((row) => row.orderId), ['42']);
    await failedDiscoveryExchange.cancelOrder(1, '42');
  } finally {
    failedDiscoveryExchange.stop();
    failedDiscoveryExchange.disconnect();
    tradingState.injectDiscoveryError = false;
    tradingState.ordersError = false;
  }

  tradingState.hideOrders = true;
  const delayedExchange = new PopdexExchange({
    apiUrl: tradingApi.url,
    privateKey: TEST_PRIVATE_KEY,
    symbol: 'BTCUSDT',
    orderGapMs: 0,
    receiptPollMs: 0,
    receiptPollAttempts: 1,
    orderDiscoveryPollMs: 0,
    orderDiscoveryAttempts: 1,
  });
  try {
    const writesBeforeDelayed = tradingState.writes;
    await delayedExchange.init();
    let discoveryError;
    try {
      await delayedExchange.placeLimitOrder({
        marketId: 1,
        side: 'buy',
        price: 99,
        sizeBase: 0.2,
        reduceOnly: false,
        levelIndex: 2,
        clientOrderId: 124,
      });
    } catch (error) {
      discoveryError = error;
    }
    assert.equal(discoveryError?.pending, true, 'indexer lag must leave the order pending');
    assert.equal(delayedExchange._pendingOrders.size, 1, 'unresolved order must remain reconcilable');
    assert.equal(tradingState.writes, writesBeforeDelayed + 1, 'indexer lag must not trigger an automatic duplicate write');

    tradingState.hideOrders = false;
    assert.deepEqual((await delayedExchange.fetchOpenOrders(1)).map((row) => row.orderId), ['42']);
    assert.equal(delayedExchange._pendingOrders.size, 0, 'later authoritative discovery must resolve pending state');
    await delayedExchange.cancelOrder(1, '42');
  } finally {
    delayedExchange.stop();
    delayedExchange.disconnect();
  }

  const uncertainExchange = new PopdexExchange({
    apiUrl: tradingApi.url,
    privateKey: TEST_PRIVATE_KEY,
    symbol: 'BTCUSDT',
    orderGapMs: 0,
    receiptPollMs: 0,
    receiptPollAttempts: 1,
    orderDiscoveryPollMs: 0,
    orderDiscoveryAttempts: 1,
  });
  try {
    tradingState.receiptCalls = 0;
    tradingState.receiptNotBefore = 99;
    await uncertainExchange.init();
    let receiptError;
    try {
      await uncertainExchange.placeLimitOrder({
        marketId: 1,
        side: 'buy',
        price: 99,
        sizeBase: 0.2,
        reduceOnly: false,
        levelIndex: 3,
        clientOrderId: 125,
      });
    } catch (error) {
      receiptError = error;
    }
    assert.equal(receiptError?.pending, true, 'unknown receipt must remain pending');
    const writesBeforeCancel = tradingState.writes;
    await assert.rejects(
      uncertainExchange.cancelAll(1),
      (error) => error?.pending === true,
      'cancellation must wait for an unresolved transaction instead of racing it',
    );
    assert.equal(tradingState.writes, writesBeforeCancel, 'uncertain placement must not be followed by a cancellation write');
  } finally {
    uncertainExchange.stop();
    uncertainExchange.disconnect();
    tradingState.receiptNotBefore = 0;
  }
} finally {
  tradingExchange.stop();
  tradingExchange.disconnect();
  await tradingApi.close();
}

console.log('popdex live place-discover-cancel test passed');
