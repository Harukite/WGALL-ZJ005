// Arcus LIVE adapter. REST is used for signed order entry and authoritative
// reconciliation; WebSocket supplies low-latency lifecycle updates. Arcus
// acknowledges writes asynchronously, so no order/cancel is considered final
// until a WS event or a subsequent REST snapshot confirms it.
import { EventEmitter } from 'node:events';
import { WebSocket } from 'undici';
import {
  alignDecimal, buildCancelPayload, buildPlacePayload, canonicalJson, chooseTick,
  futureGoodTilUs, legacySignature, loadEd25519PrivateKey, publicKeyHex, signHex,
  timestampNs, toUnitsExact,
} from './signing.js';

const INTERVALS = {
  60: '1m', 180: '3m', 300: '5m', 900: '15m', 1800: '30m',
  3600: '1h', 7200: '2h', 14400: '4h', 28800: '8h',
  43200: '12h', 86400: '1d', 259200: '3d', 604800: '1w',
};
const FINAL_ORDER_STATES = new Set(['FILLED', 'CANCELED', 'CANCELLED', 'MARGIN_CANCELED', 'REJECTED', 'EXPIRED']);
const USER_AGENT = 'WG-ArcusGridBot/1.0';
// Arcus allows 1,500 IP weight/minute. Keep background reads far below that
// budget and stagger them so the web app and this bot can share one public IP.
// Order writes are not delayed by this scheduler (Arcus rates them separately
// per subaccount), so safety-critical place/cancel/close requests stay prompt.
const POLL_TICK_MS = 1000;
const POLL_INTERVAL_MS = {
  // WebSocket is the primary source for prices, account equity and positions.
  // These REST reads are deliberately slow, authoritative safety snapshots.
  prices: 60_000,       // weight 20
  account: 60_000,      // weight 2
  positions: 60_000,    // weight 2
  openOrdersIdle: 60_000, // weight 20
  openOrdersActive: 15_000,
};
const RATE_LIMIT_MAX_BACKOFF_MS = 60_000;
const RATE_LIMIT_ALERT_INTERVAL_MS = 60_000;
const RATE_LIMIT_RECOVERY_MS = 60_000;
const WS_RECONCILE_MIN_INTERVAL_MS = 15_000;
const WS_STALE_MS = 20_000;

export class ArcusExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.network = opts.network === 'testnet' ? 'testnet' : 'mainnet';
    this.apiUrl = String(opts.apiUrl || '').replace(/\/$/, '');
    this.wsUrl = String(opts.wsUrl || '');
    this.address = String(opts.address || '').toLowerCase();
    this.accountIndex = Number(opts.accountIndex ?? 0);
    this.apiKey = String(opts.apiKey || '').replace(/^0x/i, '').toLowerCase();
    this.apiPrivateKey = opts.apiPrivateKey || '';
    this.apiPrivateKeyFile = opts.apiPrivateKeyFile || '';
    this.goodTilDays = Number(opts.goodTilDays || 40);
    this.pollMs = Math.max(2000, Number(opts.pollMs || 5000));
    this.feeRate = Number(opts.feeRate) || 0.0005;
    this.markets = new Map();
    this.balance = null;
    this.equity = null;
    this.lastOkAt = 0;
    this.lastError = null;
    this.dataSource = null;
    this._privateKey = null;
    this._prices = new Map();
    this._positions = new Map();
    this._tracked = new Map();
    this._watch = new Set();
    this._terminalEvents = new Map();
    // Arcus sequence numbers belong to their WebSocket channel. Keeping one
    // shared value makes normal snapshots from another channel look like a
    // gap and needlessly pulls weighted REST reconciliation forward.
    this._lastSequenceByChannel = new Map();
    this._timer = null;
    this._busy = false;
    this._ws = null;
    this._wsWanted = false;
    this._wsReconnectTimer = null;
    this._wsBackoffMs = 1000;
    this._wsNeedsReconcile = false;
    this._lastWsMessageAt = 0;
    this._reconcileTimer = null;
    this._reconcileDueAt = 0;
    this._lastWsReconcileAt = 0;
    this._nextPollAt = { prices: Infinity, account: Infinity, positions: Infinity, openOrders: Infinity };
    this._readRateLimitedUntil = 0;
    this._rateLimitBackoffMs = 0;
    this._lastRateLimitAt = 0;
    this._lastRateLimitAlertAt = 0;
    this._lastPollErrorAlertAt = 0;
  }

  async init() {
    this._validateCredentials();
    this._privateKey = loadEd25519PrivateKey({ value: this.apiPrivateKey, file: this.apiPrivateKeyFile });
    const derived = publicKeyHex(this._privateKey);
    if (derived !== this.apiKey) {
      throw new Error('ARCUS_API_KEY 与 ARCUS_API_PRIVATE_KEY 不是同一对 Ed25519 密钥，已拒绝启动实盘。');
    }
    await this._loadMarkets();
    // Small reads are intentionally sequential; a fresh process must not burst
    // several requests at the shared Arcus IP bucket at once.
    await this._refreshAccount();
    await this._refreshPositions();
    await this._refreshFeeRate();
    this.dataSource = 'real';
    this.lastOkAt = Date.now();
    this.start();
    return true;
  }

  _validateCredentials() {
    if (!/^0x[0-9a-f]{40}$/.test(this.address)) throw new Error('ARCUS_ADDRESS 必须是 0x 开头的 40 位 Ethereum 钱包公开地址。');
    if (!Number.isInteger(this.accountIndex) || this.accountIndex < 0 || this.accountIndex > 9) throw new Error('ARCUS_ACCOUNT_INDEX 必须是 0-9。');
    if (!/^[0-9a-f]{64}$/.test(this.apiKey)) throw new Error('ARCUS_API_KEY 必须是 64 位十六进制 Ed25519 公钥。');
    if (!this.apiPrivateKey && !this.apiPrivateKeyFile) throw new Error('LIVE 模式需要 ARCUS_API_PRIVATE_KEY 或 ARCUS_API_PRIVATE_KEY_FILE。');
  }

  async reconnect() {
    this.stop();
    this._busy = false;
    this.lastError = null;
    await this._loadMarkets();
    await this._refreshAccount();
    await this._refreshPositions();
    await this._refreshOpenOrders();
    this.dataSource = 'real';
    this.lastOkAt = Date.now();
    this.start();
    return true;
  }

  async _loadMarkets() {
    const data = await this._get('/v1/markets');
    const list = Array.isArray(data) ? data : data?.markets;
    if (!Array.isArray(list) || !list.length) throw new Error('Arcus 未返回市场列表。');
    const next = new Map();
    for (const raw of list) {
      if (String(raw.type || 'PERPETUAL').toUpperCase() !== 'PERPETUAL') continue;
      if (String(raw.status || '').toUpperCase() !== 'ONLINE') continue;
      const marketId = Number(raw.marketId);
      const price = Number(raw.markPrice || raw.oraclePrice || raw.lastTradePrice || 0);
      const imf = Number(raw.isOutsideRth ? raw.offHoursInitialMarginFraction : raw.initialMarginFraction);
      const maxLeverage = Number.isFinite(imf) && imf > 0 ? Math.max(1, Math.floor(1 / imf + 1e-9)) : 50;
      const stepPrice = Number(chooseTick(raw, price || raw.tickSize));
      const market = {
        marketId,
        name: raw.marketDisplayName,
        displayName: raw.marketDisplayName,
        symbol: raw.baseAsset,
        category: raw.category || null,
        status: raw.status,
        lastPrice: price,
        stepSize: Number(raw.stepSize),
        stepPrice,
        qtyStep: String(raw.stepSize),
        priceStep: String(raw.tickSize),
        tickSize: String(raw.tickSize),
        tickTiers: Array.isArray(raw.tickTiers) ? raw.tickTiers.map((x) => ({ upToPrice: x.upToPrice, tick: x.tick })) : [],
        minOrderSize: Number(raw.minOrderSize || raw.stepSize),
        minOrderNotional: Number(raw.minOrderNotional || 0),
        maxOrderSize: Number(raw.maxOrderSize || Infinity),
        maxLeverage,
        isOutsideRth: !!raw.isOutsideRth,
        upperTradingBound: raw.upperTradingBound ?? null,
        lowerTradingBound: raw.lowerTradingBound ?? null,
      };
      if (!Number.isInteger(marketId) || !(market.stepSize > 0) || !(Number(raw.tickSize) > 0)) continue;
      next.set(marketId, market);
      if (price > 0) this._prices.set(marketId, price);
    }
    if (!next.size) throw new Error('Arcus 当前没有 ONLINE 状态的永续市场。');
    this.markets = next;
  }

  _headers(extra = {}) {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
      ...extra,
    };
  }

  async _req(method, path, body, headers = {}) {
    const route = String(path).split('?')[0];
    // Fail fast locally during an IP-read cooldown instead of sending another
    // request that cannot succeed. Trading writes deliberately bypass this:
    // Arcus charges them to the independent per-subaccount order/cancel pools.
    if (method === 'GET' && Date.now() < this._readRateLimitedUntil) {
      const waitMs = Math.max(1, this._readRateLimitedUntil - Date.now());
      const err = new Error(`Arcus 读取限流退避中，约 ${Math.ceil(waitMs / 1000)} 秒后恢复。`);
      err.status = 429;
      err.retryAfterMs = waitMs;
      err.localRateLimit = true;
      err.silent = true;
      err.endpoint = route;
      throw err;
    }
    let res;
    let networkError = null;
    // A residential SOCKS path can occasionally lose an idle connection.
    // Retry idempotent reads once with a fresh request; never retry writes here
    // because a timed-out place/cancel may already have reached the exchange.
    const attempts = method === 'GET' ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        res = await fetch(this.apiUrl + path, {
          method,
          // Residential SOCKS proxies commonly drop idle pooled tunnels
          // without a clean FIN. Fresh connections keep low-frequency reads
          // from reusing a half-dead tunnel; writes retain normal pooling.
          headers: this._headers(method === 'GET' ? { Connection: 'close', ...headers } : headers),
          body: body === undefined ? undefined : canonicalJson(body),
          signal: AbortSignal.timeout(15000),
        });
        break;
      } catch (e) {
        networkError = e;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!res) {
      const detail = networkError?.cause?.message || networkError?.message || networkError;
      const err = new Error(`Arcus 网络请求失败（${route}）：${detail}`, { cause: networkError });
      err.endpoint = route;
      err.network = true;
      throw err;
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
    if (res.ok) return data;
    const detail = data?.message || data?.error?.message || data?.error || data?.rejectReason || `HTTP ${res.status}`;
    let message;
    if (data?.code === 'GEO_RESTRICTED') message = 'Arcus 拒绝交易：当前账户或地区受 GEO_RESTRICTED 限制。';
    else if (res.status === 401) message = 'Arcus API 鉴权失败：检查 API key、签名私钥和电脑时间。';
    else if (res.status === 403) message = 'Arcus 拒绝访问：钱包地址或 accountIndex 与 API key 不匹配。';
    else if (res.status === 429) {
      const reason = String(data?.reason || data?.error?.reason || '').toLowerCase();
      const serverWaitMs = Math.max(1000, Number(data?.retryAfterMs || res.headers.get('retry-after') * 1000 || 1000));
      const readLimited = method === 'GET' && (!reason || reason === 'ip');
      const waitMs = readLimited ? this._registerReadRateLimit(serverWaitMs) : serverWaitMs;
      message = readLimited
        ? `Arcus IP 读取限流（${route}），已自动全局退避 ${Math.ceil(waitMs / 1000)} 秒。`
        : `Arcus 子账户交易限流（${reason || 'unknown'}），请在 ${Math.ceil(waitMs / 1000)} 秒后重试。`;
    }
    else message = `Arcus 接口错误 ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    err.endpoint = route;
    err.retryAfterMs = res.status === 429
      ? Math.max(1000, this._readRateLimitedUntil - Date.now(), Number(data?.retryAfterMs || res.headers.get('retry-after') * 1000 || 1000))
      : Number(data?.retryAfterMs || res.headers.get('retry-after') * 1000 || 0);
    throw err;
  }

  _registerReadRateLimit(serverWaitMs, now = Date.now()) {
    const quietFor = this._lastRateLimitAt ? now - this._lastRateLimitAt : Infinity;
    const previous = quietFor > RATE_LIMIT_RECOVERY_MS ? 0 : this._rateLimitBackoffMs;
    const waitMs = Math.min(
      RATE_LIMIT_MAX_BACKOFF_MS,
      Math.max(1000, Number(serverWaitMs) || 1000, previous ? previous * 2 : 0),
    );
    this._rateLimitBackoffMs = waitMs;
    this._lastRateLimitAt = now;
    this._readRateLimitedUntil = Math.max(this._readRateLimitedUntil, now + waitMs);
    return waitMs;
  }

  _get(path) { return this._req('GET', path); }

  _accountQuery(extra = '') {
    const q = `address=${encodeURIComponent(this.address)}&accountIndex=${this.accountIndex}`;
    return q + (extra ? '&' + extra : '');
  }

  async getMarkets() { return [...this.markets.values()]; }

  _market(marketId) {
    const market = this.markets.get(Number(marketId));
    if (!market) throw new Error('未知 Arcus 市场 marketId=' + marketId);
    return market;
  }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const market = this._market(marketId);
    const timeframe = INTERVALS[Number(intervalSec)] || '1h';
    const toUs = BigInt(Date.now()) * 1000n;
    const path = `/v1/candles?market=${encodeURIComponent(market.name)}&timeframe=${timeframe}&to=${toUs}&countback=${Math.min(1500, Math.max(1, Number(n) || 200))}`;
    const data = await this._get(path);
    const rows = Array.isArray(data) ? data : data?.candles;
    return (rows || []).map((c) => ({
      time: Math.floor(Number(c.openTime ?? c.timestamp ?? 0) / 1000),
      open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume || 0),
    })).filter((c) => Number.isFinite(c.close) && c.time > 0).sort((a, b) => a.time - b.time);
  }

  async getPrice(marketId) {
    const market = this._market(marketId);
    this._watch.add(market.marketId);
    try {
      const bbo = await this._get(`/v1/bbo/${encodeURIComponent(market.name)}`);
      const bid = Number(bbo?.bestBid?.price ?? bbo?.bestBid);
      const ask = Number(bbo?.bestAsk?.price ?? bbo?.bestAsk);
      const price = bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid > 0 ? bid : ask);
      if (price > 0) { this._prices.set(market.marketId, price); return price; }
    } catch { /* global prices/cache below */ }
    if (!this._prices.has(market.marketId)) await this._refreshPrices().catch(() => {});
    return this._prices.get(market.marketId) ?? market.lastPrice;
  }

  async _signedTyped(path, payload, body, ts) {
    const signature = signHex(payload, this._privateKey);
    return this._req('POST', `${path}?address=${encodeURIComponent(this.address)}`, body, {
      'X-Timestamp': String(ts), 'X-Signature': signature,
    });
  }

  async _signedLegacy(path, action, body) {
    const ts = timestampNs();
    const signature = legacySignature({ timestamp: ts, action, body, privateKey: this._privateKey });
    return this._req('POST', `${path}?address=${encodeURIComponent(this.address)}`, body, {
      'X-Timestamp': String(ts), 'X-Signature': signature,
    });
  }

  _prepareOrder(market, order) {
    const tierTick = chooseTick(market, order.price);
    const price = alignDecimal(order.price, tierTick, 'nearest');
    const quantity = alignDecimal(order.sizeBase, market.qtyStep, 'down');
    if (toUnitsExact(quantity, market.qtyStep) <= 0n) throw new Error(`数量过小，Arcus ${market.name} 最小数量为 ${market.minOrderSize}。`);
    if (Number(quantity) < market.minOrderSize) throw new Error(`数量 ${quantity} 低于 Arcus ${market.name} 最小下单量 ${market.minOrderSize}。`);
    if (Number(quantity) > market.maxOrderSize) throw new Error(`数量 ${quantity} 超过 Arcus ${market.name} 最大下单量 ${market.maxOrderSize}。`);
    if (!order.reduceOnly && market.minOrderNotional > 0 && Number(price) * Number(quantity) < market.minOrderNotional) {
      throw new Error(`订单名义价值低于 Arcus ${market.name} 最低 ${market.minOrderNotional} USD。`);
    }
    return {
      price,
      quantity,
      priceTicks: toUnitsExact(price, market.priceStep),
      quantityQuantums: toUnitsExact(quantity, market.qtyStep),
    };
  }

  async _submitOrder(order) {
    const market = this._market(order.marketId);
    const prepared = this._prepareOrder(market, order);
    const ts = timestampNs();
    const goodTilTime = futureGoodTilUs(this.goodTilDays);
    const side = String(order.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const timeInForce = String(order.timeInForce || (order.orderType === 'MARKET' ? 'IOC' : order.postOnly ? 'ALO' : 'GTT')).toUpperCase();
    const clientId = String(order.clientId || `wg${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 36);
    const payload = buildPlacePayload({
      address: this.address, accountIndex: this.accountIndex, clientId,
      timestamp: ts, goodTilTimeUs: goodTilTime, marketId: market.marketId,
      priceTicks: prepared.priceTicks, quantityQuantums: prepared.quantityQuantums,
      reduceOnly: !!order.reduceOnly, side, timeInForce,
    });
    const body = {
      address: this.address, accountIndex: this.accountIndex, marketId: market.marketId,
      orderSide: side, orderType: order.orderType || 'LIMIT', quantity: prepared.quantity,
      // Arcus HTTP schema requires goodTilTime to be a decimal STRING in
      // microseconds. The typed signing payload above independently converts
      // the same value to its required nanosecond integer `g`.
      price: prepared.price, timeInForce, goodTilTime: String(goodTilTime),
      reduceOnly: !!order.reduceOnly, clientId, timestamp: ts,
    };
    let data;
    try {
      data = await this._signedTyped('/v1/placeOrder', payload, body, ts);
    } catch (e) {
      // A network timeout after sending is ambiguous. Resolve by the unique
      // clientId before reporting failure so the bot never leaves an orphan.
      if (!e.status) {
        const found = await this._findOrderByClientId(clientId).catch(() => null);
        if (found?.orderId) data = found;
        else throw e;
      } else throw e;
    }
    const orderId = String(data?.orderId || data?.result?.orderId || '');
    if (!orderId) throw new Error('Arcus 已响应下单请求，但未返回 orderId，已停止本次挂单。');
    const tracked = {
      orderId, clientId, marketId: market.marketId, levelIndex: order.levelIndex,
      side: side.toLowerCase(), price: Number(prepared.price), sizeBase: Number(prepared.quantity),
      placedAt: Date.now(), seen: false, goneAttempts: 0, resolving: false,
    };
    this._watch.add(market.marketId);
    this._tracked.set(orderId, tracked);
    const early = this._terminalEvents.get(orderId);
    if (early) { this._terminalEvents.delete(orderId); this._handleOrderUpdate(early); }
    if (data?.status && FINAL_ORDER_STATES.has(String(data.status).toUpperCase())) this._handleOrderUpdate(data);
    return { orderId, clientId, price: Number(prepared.price), sizeBase: Number(prepared.quantity) };
  }

  async placeLimitOrder(o) {
    return this._submitOrder({
      ...o,
      side: o.side,
      orderType: 'LIMIT',
      timeInForce: o.postOnly ? 'ALO' : 'GTT',
      clientId: o.clientOrderId ? `wg${String(o.clientOrderId)}` : undefined,
    });
  }

  async cancelOrder(marketId, orderId) {
    const market = this._market(marketId);
    const ts = timestampNs();
    const payload = buildCancelPayload({
      address: this.address, accountIndex: this.accountIndex, timestamp: ts,
      orderId: String(orderId), marketId: market.marketId,
    });
    const body = {
      address: this.address, accountIndex: this.accountIndex, marketId: market.marketId,
      kind: 'orderId', orderId: String(orderId), timestamp: ts,
    };
    await this._signedTyped('/v1/cancelOrder', payload, body, ts);
    return true;
  }

  async _batchCancel(rows) {
    for (let offset = 0; offset < rows.length; offset += 100) {
      const chunk = rows.slice(offset, offset + 100);
      const ts = timestampNs();
      const cancels = chunk.map((o) => {
        const payload = buildCancelPayload({
          address: this.address, accountIndex: this.accountIndex, timestamp: ts,
          orderId: String(o.orderId), marketId: Number(o.marketId),
        });
        return {
          address: this.address, accountIndex: this.accountIndex, marketId: Number(o.marketId),
          kind: 'orderId', orderId: String(o.orderId), timestamp: ts,
          signature: signHex(payload, this._privateKey),
        };
      });
      await this._req('POST', `/v1/batchCancelOrders?address=${encodeURIComponent(this.address)}`, { cancels }, {
        'X-Timestamp': String(ts), 'X-Signature': cancels[0].signature,
      });
    }
    return true;
  }

  /** Cancel every order on this subaccount+market, using cheap per-order batches. */
  async cancelAll(marketId) {
    const mId = Number(marketId);
    const rows = await this._fetchAllOpenOrders();
    if (!Array.isArray(rows)) throw new Error('Arcus 无法读取真实挂单，已拒绝执行批量撤单。');
    const targets = rows.filter((o) => Number(o.marketId) === mId);
    if (!targets.length) return true;
    return this._batchCancel(targets);
  }

  async setLeverage(marketId, value) {
    const market = this._market(marketId);
    const leverage = Math.max(1, Math.min(market.maxLeverage, Math.floor(Number(value) || 1)));
    const body = { address: this.address, accountIndex: this.accountIndex, marketId: market.marketId, leverage };
    try {
      const data = await this._signedLegacy('/v1/setLeverage', 'setLeverage', body);
      if (String(data?.status || '').toUpperCase() === 'REJECTED') throw new Error(data?.rejectReason || '杠杆设置被拒绝');
      return true;
    } catch (e) {
      this.emit('error', e);
      return false;
    }
  }

  getOpenOrders(marketId) {
    return [...this._tracked.values()].filter((o) => o.marketId === Number(marketId));
  }

  forgetOrder(orderId) { this._tracked.delete(String(orderId)); }
  forgetOrders(marketId) {
    for (const [id, o] of this._tracked) if (o.marketId === Number(marketId)) this._tracked.delete(id);
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    const mId = Number(marketId);
    this._watch.add(mId);
    this._tracked.set(String(orderId), {
      orderId: String(orderId), marketId: mId, levelIndex, side,
      price: Number(price), sizeBase: Number(sizeBase), placedAt: Date.now(), seen: false,
      goneAttempts: 0, resolving: false,
    });
  }

  async fetchOpenOrders(marketId) {
    const rows = await this._fetchAllOpenOrders();
    if (!Array.isArray(rows)) return null;
    return rows.filter((o) => Number(o.marketId) === Number(marketId)).map((o) => ({
      orderId: String(o.orderId), price: Number(o.price),
      side: String(o.side || o.orderSide).toLowerCase() === 'buy' ? 'buy' : 'sell',
      marketId: Number(o.marketId),
    }));
  }

  async _fetchAllOpenOrders() {
    const data = await this._get('/v1/openOrders?' + this._accountQuery());
    const interval = this._tracked.size ? POLL_INTERVAL_MS.openOrdersActive : POLL_INTERVAL_MS.openOrdersIdle;
    this._nextPollAt.openOrders = Math.max(this._nextPollAt.openOrders, Date.now() + interval);
    const rows = Array.isArray(data) ? data : (data?.orders ?? data?.openOrders);
    return Array.isArray(rows) ? rows.filter((o) => o && o.orderId && (o.accountIndex == null || Number(o.accountIndex) === this.accountIndex)) : null;
  }

  async _findOrderByClientId(clientId) {
    const data = await this._get('/v1/orders?' + this._accountQuery('limit=200'));
    const rows = Array.isArray(data) ? data : data?.orders;
    return (rows || []).find((o) => String(o.clientId || '').toLowerCase() === String(clientId).toLowerCase()) || null;
  }

  getPosition(marketId) {
    const p = this._positions.get(Number(marketId));
    return p && p.sizeBase !== 0 ? p : null;
  }

  /** Same behavior as the existing adapters: reduce-only IOC with a ±5% bound. */
  async closePosition(marketId) {
    const market = this._market(marketId);
    await this._refreshPositions().catch(() => {});
    const pos = this._positions.get(market.marketId);
    if (!pos?.sizeBase) return true;
    const isBuy = pos.sizeBase < 0;
    const last = await this.getPrice(market.marketId);
    const worst = last * (isBuy ? 1.05 : 0.95);
    return this._submitOrder({
      marketId: market.marketId, side: isBuy ? 'buy' : 'sell',
      price: worst, sizeBase: Math.abs(pos.sizeBase), reduceOnly: true,
      orderType: 'MARKET', timeInForce: 'IOC',
    });
  }

  start() {
    this._wsWanted = true;
    if (!this._timer) {
      this._initPollSchedule();
      this._timer = setInterval(() => this._poll(), POLL_TICK_MS);
      this._timer.unref?.();
      this._poll().catch(() => {});
    }
    this._connectWs();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._reconcileTimer) { clearTimeout(this._reconcileTimer); this._reconcileTimer = null; }
    this._reconcileDueAt = 0;
    if (this._wsReconnectTimer) { clearTimeout(this._wsReconnectTimer); this._wsReconnectTimer = null; }
    this._wsWanted = false;
    this._lastWsMessageAt = 0;
    const ws = this._ws; this._ws = null;
    if (ws) { try { ws.close(1000, 'client stop'); } catch { /* ignore */ } }
  }

  _initPollSchedule(now = Date.now()) {
    this._nextPollAt = {
      // init() has just loaded markets/account/positions. Give the WebSocket
      // snapshots time to arrive and only check real open orders early.
      prices: now + 60_000,
      account: now + 70_000,
      positions: now + 80_000,
      openOrders: now + 10_000,
    };
  }

  _pollTasks() {
    return [
      { key: 'prices', interval: POLL_INTERVAL_MS.prices, run: () => this._refreshPrices() },
      { key: 'account', interval: POLL_INTERVAL_MS.account, run: () => this._refreshAccount() },
      { key: 'positions', interval: POLL_INTERVAL_MS.positions, run: () => this._refreshPositions() },
      {
        key: 'openOrders',
        interval: this._tracked.size ? POLL_INTERVAL_MS.openOrdersActive : POLL_INTERVAL_MS.openOrdersIdle,
        run: () => this._refreshOpenOrders(),
      },
    ];
  }

  async _poll(now = Date.now()) {
    this._ensureWsFresh(now);
    if (this._busy || now < this._readRateLimitedUntil) return;
    const task = this._pollTasks()
      .filter((x) => now >= this._nextPollAt[x.key])
      .sort((a, b) => this._nextPollAt[a.key] - this._nextPollAt[b.key])[0];
    if (!task) return;
    this._busy = true;
    // Advance before running so failures cannot create a tight retry loop.
    this._nextPollAt[task.key] = now + task.interval;
    try {
      await task.run();
      this.lastOkAt = Date.now();
      if (!this._lastRateLimitAt || Date.now() - this._lastRateLimitAt > RATE_LIMIT_RECOVERY_MS) {
        this.lastError = null;
        this._rateLimitBackoffMs = 0;
      }
    } catch (e) {
      this.lastError = e?.message || String(e);
      const isRateLimit = e?.status === 429;
      const minAlertGap = isRateLimit ? RATE_LIMIT_ALERT_INTERVAL_MS : 5000;
      const lastAlert = isRateLimit ? this._lastRateLimitAlertAt : this._lastPollErrorAlertAt;
      if (!e?.silent && (!lastAlert || now - lastAlert >= minAlertGap)) {
        if (isRateLimit) this._lastRateLimitAlertAt = now;
        else this._lastPollErrorAlertAt = now;
        this.emit('error', e);
      }
    } finally { this._busy = false; }
  }

  async _refreshPrices() {
    const data = await this._get('/v1/prices');
    const rows = data?.prices && typeof data.prices === 'object' ? data.prices : data;
    if (!rows || typeof rows !== 'object') return;
    for (const [idRaw, row] of Object.entries(rows)) {
      const id = Number(row?.marketId ?? idRaw);
      const price = Number(row?.markPrice || row?.oraclePrice || 0);
      this._applyPrice(id, price);
    }
  }

  _applyPrice(marketId, price) {
    const id = Number(marketId);
    const value = Number(price);
    if (!this.markets.has(id) || !(value > 0)) return false;
    this._prices.set(id, value);
    const market = this.markets.get(id);
    if (market) market.lastPrice = value;
    if (this._watch.has(id) || [...this._tracked.values()].some((o) => o.marketId === id) || this._positions.has(id)) {
      this.emit('price', { marketId: id, price: value });
    }
    return true;
  }

  _applyWsOraclePrices(contents) {
    const rows = Array.isArray(contents?.prices) ? contents.prices : [];
    for (const row of rows) {
      // Arcus explicitly documents markPrice="0" as unavailable.
      this._applyPrice(row?.marketId, row?.markPrice);
    }
  }

  _applyWsAccount(contents) {
    if (!contents || typeof contents !== 'object') return false;
    if (contents.accountIndex != null && Number(contents.accountIndex) !== this.accountIndex) return false;
    let changed = false;
    const balance = Number(contents.netQuoteBalance);
    const equity = Number(contents.accountEquity ?? contents.equity);
    if (contents.netQuoteBalance != null && Number.isFinite(balance)) { this.balance = balance; changed = true; }
    if ((contents.accountEquity != null || contents.equity != null) && Number.isFinite(equity)) { this.equity = equity; changed = true; }
    if (contents.positions != null) changed = this._applyWsPositions(contents) || changed;
    return changed;
  }

  _applyWsPositions(contents) {
    if (!contents || typeof contents !== 'object') return false;
    if (contents.accountIndex != null && Number(contents.accountIndex) !== this.accountIndex) return false;
    const source = contents.positions;
    const single = contents.marketId != null ? [[contents.marketId, contents]] : [];
    const entries = Array.isArray(source)
      ? source.map((row) => [row?.marketId, row])
      : (source && typeof source === 'object' ? Object.entries(source) : single);
    if (!entries.length && contents.isSnapshot !== true) return false;
    const next = contents.isSnapshot === true ? new Map() : new Map(this._positions);
    for (const [key, raw] of entries) {
      const p = raw && typeof raw === 'object' ? raw : {};
      if (p.accountIndex != null && Number(p.accountIndex) !== this.accountIndex) continue;
      const marketId = Number(p.marketId ?? key);
      if (!this.markets.has(marketId)) continue;
      let size = Number(p.size ?? p.sizeBase ?? 0);
      if (String(p.side).toUpperCase() === 'SHORT' && size > 0) size = -size;
      if (!Number.isFinite(size) || size === 0) { next.delete(marketId); continue; }
      next.set(marketId, {
        sizeBase: size,
        entryPrice: Number(p.averageEntryPrice ?? p.entryPrice ?? 0),
        unrealizedPnl: Number(p.unrealizedPnl ?? 0),
        leverage: p.leverage != null ? Number(p.leverage) : null,
      });
      this._watch.add(marketId);
    }
    this._positions = next;
    return true;
  }

  async _refreshAccount() {
    try {
      const data = await this._get('/v1/account?' + this._accountQuery());
      const rawBalance = data?.netQuoteBalance;
      const rawEquity = data?.equity;
      const balance = rawBalance == null || rawBalance === '' ? NaN : Number(rawBalance);
      const equity = rawEquity == null || rawEquity === '' ? NaN : Number(rawEquity);
      // Never erase a previously verified live balance with a malformed or
      // partial 200 response. Unknown equity must fail closed so server startup
      // and the grid margin pre-check cannot treat an invalid snapshot as safe.
      if (!Number.isFinite(balance) || !Number.isFinite(equity)) {
        throw new Error('Arcus 账户快照缺少有效的 netQuoteBalance/equity，已保留上一份有效数据。');
      }
      this.balance = balance;
      this.equity = equity;
    } catch (e) {
      if (e.status === 404) { this.balance = 0; this.equity = 0; return; }
      throw e;
    }
  }

  async _refreshPositions() {
    try {
      const data = await this._get('/v1/positions?' + this._accountQuery());
      const source = data?.positions ?? data;
      const rows = Array.isArray(source) ? source : (source && typeof source === 'object' ? Object.values(source) : []);
      const next = new Map();
      for (const p of rows) {
        if (!p || (p.accountIndex != null && Number(p.accountIndex) !== this.accountIndex)) continue;
        const marketId = Number(p.marketId);
        let size = Number(p.size || 0);
        if (String(p.side).toUpperCase() === 'SHORT' && size > 0) size = -size;
        if (!this.markets.has(marketId) || !size) continue;
        next.set(marketId, {
          sizeBase: size,
          entryPrice: Number(p.averageEntryPrice || 0),
          unrealizedPnl: Number(p.unrealizedPnl || 0),
          leverage: p.leverage != null ? Number(p.leverage) : null,
          liquidationPrice: firstFinite(p.liquidationPrice, p.estimatedLiquidationPrice, p.liquidation_price),
        });
        this._watch.add(marketId);
      }
      this._positions = next;
    } catch (e) {
      if (e.status === 404) { this._positions.clear(); return; }
      throw e;
    }
  }

  async _refreshFeeRate() {
    try {
      const data = await this._get(`/v1/account/stats?address=${encodeURIComponent(this.address)}&include=feeTier`);
      const tier = data?.tradingFeeTier;
      const maker = Number(tier?.makerFeePpm);
      const taker = Number(tier?.takerFeePpm);
      if (Number.isFinite(maker) || Number.isFinite(taker)) this.feeRate = Math.max(0, maker || 0, taker || 0) / 1_000_000;
    } catch { /* configured/default conservative fee remains */ }
  }

  async _refreshOpenOrders() {
    const rows = await this._fetchAllOpenOrders();
    if (!Array.isArray(rows)) return;
    const live = new Map(rows.map((o) => [String(o.orderId), o]));
    for (const [id, order] of live) {
      const tracked = this._tracked.get(id);
      if (tracked) { tracked.seen = true; tracked.goneAttempts = 0; }
      if (FINAL_ORDER_STATES.has(String(order.status || order.state).toUpperCase())) this._handleOrderUpdate(order);
    }
    const now = Date.now();
    for (const [id, tracked] of this._tracked) {
      if (live.has(id) || tracked.resolving || now - tracked.placedAt < this.pollMs * 2) continue;
      tracked.goneAttempts = (tracked.goneAttempts || 0) + 1;
      if (tracked.goneAttempts < 2) continue;
      tracked.resolving = true;
      this._resolveGone(id).finally(() => { const t = this._tracked.get(id); if (t) t.resolving = false; });
    }
  }

  async _resolveGone(orderId) {
    try {
      const order = await this._get(`/v1/order/${encodeURIComponent(orderId)}?` + this._accountQuery());
      this._handleOrderUpdate(order?.order || order);
    } catch (e) {
      if (e.status === 404) {
        const t = this._tracked.get(String(orderId));
        if (t && ++t.goneAttempts >= 6) {
          this._tracked.delete(String(orderId));
          this.emit('error', new Error(`Arcus 订单 ${orderId} 已离开挂单簿但无法确认成交，已停止跟踪且不补单。`));
        }
      }
    }
  }

  _handleOrderUpdate(order) {
    if (!order || order.orderId == null) return;
    if (order.accountIndex != null && Number(order.accountIndex) !== this.accountIndex) return;
    const id = String(order.orderId);
    const status = String(order.status || order.state || '').toUpperCase();
    const tracked = this._tracked.get(id);
    if (!tracked) {
      if (FINAL_ORDER_STATES.has(status)) {
        this._terminalEvents.set(id, order);
        setTimeout(() => this._terminalEvents.delete(id), 30_000).unref?.();
      }
      return;
    }
    if (status === 'OPEN' || status === 'PENDING' || status === 'PARTIALLY_FILLED') {
      tracked.seen = true;
      return;
    }
    if (!FINAL_ORDER_STATES.has(status)) return;
    const original = Number(order.originalSize ?? tracked.sizeBase);
    const remaining = Number(order.remainingSize ?? 0);
    const explicitFilled = Number(order.filledSize);
    const filledSize = Number.isFinite(explicitFilled) ? explicitFilled : Math.max(0, original - remaining);
    this._tracked.delete(id);
    if (filledSize > 0 || status === 'FILLED') {
      const size = filledSize > 0 ? filledSize : original;
      const price = Number(order.avgFillPrice || order.averagePrice || order.price || tracked.price);
      this.emit('fill', {
        orderId: id, marketId: tracked.marketId, side: tracked.side,
        price: Number.isFinite(price) ? price : tracked.price,
        sizeBase: size, levelIndex: tracked.levelIndex,
      });
    } else if (status === 'REJECTED' || status === 'MARGIN_CANCELED') {
      this.emit('error', new Error(`Arcus 订单 ${id} 被拒绝/取消：${order.rejectionReason || status}`));
    }
  }

  _connectWs() {
    if (!this._wsWanted || this._ws || !this.wsUrl) return;
    let ws;
    try { ws = new WebSocket(this.wsUrl); }
    catch (e) { this._scheduleWsReconnect(e); return; }
    this._ws = ws;
    ws.addEventListener('open', () => {
      if (this._ws !== ws) return;
      this._wsBackoffMs = 1000;
      this._lastWsMessageAt = Date.now();
      this._lastSequenceByChannel.clear();
      const reconcileAfterReconnect = this._wsNeedsReconcile;
      this._wsNeedsReconcile = false;
      for (const channel of ['orders', 'userFills', 'positions', 'account']) {
        ws.send(JSON.stringify({ type: 'subscribe', channel, id: this.address, snapshot: true }));
      }
      // Public global stream containing mark prices for every market. This is
      // the bot's real-time price source; REST /v1/prices is only a fallback.
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'oraclePrices' }));
      // init()/reconnect() already performed authoritative REST snapshots.
      // Only a recovery from an unexpected WS drop needs another reconcile.
      if (reconcileAfterReconnect) this._scheduleReconcile({ urgent: true });
    });
    ws.addEventListener('message', (event) => {
      try { this._handleWsMessage(JSON.parse(String(event.data))); }
      catch { /* malformed/unrecognised frame */ }
    });
    ws.addEventListener('error', () => { this.lastError = 'Arcus WebSocket 连接错误'; });
    ws.addEventListener('close', () => {
      if (this._ws === ws) this._ws = null;
      if (this._wsWanted) {
        this._wsNeedsReconcile = true;
        this._scheduleWsReconnect();
      }
    });
  }

  _scheduleWsReconnect(error) {
    if (error) this.lastError = error?.message || String(error);
    if (!this._wsWanted || this._wsReconnectTimer) return;
    const delay = this._wsBackoffMs;
    this._wsBackoffMs = Math.min(30_000, this._wsBackoffMs * 2);
    this._wsReconnectTimer = setTimeout(() => {
      this._wsReconnectTimer = null;
      this._connectWs();
    }, delay);
    this._wsReconnectTimer.unref?.();
  }

  _handleWsMessage(msg) {
    if (!msg || (msg.type !== 'channel_data' && msg.type !== 'subscribed')) return;
    this._lastWsMessageAt = Date.now();
    if (msg.channel === 'oraclePrices') this._applyWsOraclePrices(msg.contents);
    else if (msg.channel === 'account') this._applyWsAccount(msg.contents);
    else if (msg.channel === 'positions') this._applyWsPositions(msg.contents);
    const records = collectRecords(msg.contents);
    const sequenceKey = String(msg.channel || 'unknown');
    let lastSequence = this._lastSequenceByChannel.get(sequenceKey);
    let sequenceGap = false;
    for (const row of records) {
      if (row.accountIndex != null && Number(row.accountIndex) !== this.accountIndex) continue;
      // sequenceNumber on order/trade messages is exchange-global and may jump
      // because of other users' events. Only account-scoped counters can be
      // checked for continuity here.
      const seq = Number(row.sequenceNum ?? row.accountSequenceNum);
      if (Number.isFinite(seq)) {
        if (lastSequence != null && seq > lastSequence + 1) sequenceGap = true;
        lastSequence = Math.max(lastSequence ?? 0, seq);
        this._lastSequenceByChannel.set(sequenceKey, lastSequence);
      }
      if (row.orderId != null && (row.status != null || row.state != null)) this._handleOrderUpdate(row);
    }
    // Account/position pushes may arrive every second. The staggered 10-second
    // REST scheduler already refreshes them, so do not fan every push into a
    // weighted three-request reconciliation. Fills still request one coalesced
    // snapshot, and a sequence gap bypasses the normal 15-second throttle.
    if (sequenceGap) this._scheduleReconcile({ urgent: true });
    else if (msg.channel === 'userFills' && msg.contents?.isSnapshot !== true) this._scheduleReconcile();
    this.lastOkAt = Date.now();
  }

  _ensureWsFresh(now = Date.now()) {
    if (!this._wsWanted || !this._ws || !this._lastWsMessageAt || now - this._lastWsMessageAt <= WS_STALE_MS) return false;
    const stale = this._ws;
    this._ws = null;
    this._lastWsMessageAt = 0;
    this._wsNeedsReconcile = true;
    this.lastError = 'Arcus WebSocket 20 秒未收到消息，正在自动重连';
    try { stale.close(4000, 'stale connection'); } catch { /* reconnect below */ }
    this._scheduleWsReconnect();
    return true;
  }

  _scheduleReconcile({ urgent = false } = {}) {
    const now = Date.now();
    const dueAt = urgent
      ? now + 1000
      : Math.max(now + 1000, this._lastWsReconcileAt + WS_RECONCILE_MIN_INTERVAL_MS);
    if (this._reconcileTimer) {
      if (!urgent || dueAt >= this._reconcileDueAt) return;
      clearTimeout(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    this._reconcileDueAt = dueAt;
    this._reconcileTimer = setTimeout(() => {
      this._reconcileTimer = null;
      this._reconcileDueAt = 0;
      const now = Date.now();
      this._lastWsReconcileAt = now;
      // Bring the three authoritative snapshots forward, but let the normal
      // one-at-a-time scheduler stagger them instead of sending a REST burst.
      this._nextPollAt.account = Math.min(this._nextPollAt.account, now);
      this._nextPollAt.positions = Math.min(this._nextPollAt.positions, now + 1000);
      this._nextPollAt.openOrders = Math.min(this._nextPollAt.openOrders, now + 2000);
      this._poll().catch(() => {});
    }, Math.max(1, dueAt - now));
    this._reconcileTimer.unref?.();
  }
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function collectRecords(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (!Array.isArray(value) && (value.orderId != null || value.marketId != null || value.sequenceNumber != null || value.sequenceNum != null || value.accountSequenceNum != null)) out.push(value);
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, out);
  } else {
    for (const child of Object.values(value)) if (child && typeof child === 'object') collectRecords(child, out);
  }
  return out;
}
