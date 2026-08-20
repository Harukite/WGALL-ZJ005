import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FillMode, Nord, NordUser, Side, calcCurrPosLiqPrice } from '@n1xyz/nord-ts';
import { Connection } from '@solana/web3.js';
import { LiveVenueExchange, num, stableId } from '../common/live.js';
import { fetchN1Candles } from './market-data.js';

const DEFAULT_APP = 'zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5';
const DEFAULT_API = 'https://zo-mainnet.n1.xyz';
const DEFAULT_SOLANA = 'https://api.mainnet-beta.solana.com';
const MAX_SAFE_CLIENT_ID = (1n << 52n) - 1n;
const REMOTE_MARKET_ID = 0;
const INTERNAL_MARKET_ID = 1;

function loadKeypair(pathname) {
  if (!pathname || !fs.existsSync(pathname)) {
    throw new Error('缺少 N1 keypair：' + pathname + '（设置 N1_KEYPAIR_PATH 或放 secrets/id.json）');
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(pathname, 'utf8')); }
  catch (error) { throw new Error('N1 keypair 文件不是有效 JSON：' + (error?.message || error)); }
  if (!Array.isArray(raw) || raw.length < 32) throw new Error('N1 keypair 必须是 Solana secret key 数组');
  return Uint8Array.from(raw);
}

function clientOrderId(tag) {
  const digest = crypto.createHash('sha256').update(tag).digest();
  const value = digest.readBigUInt64BE(0) & MAX_SAFE_CLIENT_ID;
  return value === 0n ? 1n : value;
}

function signedPerpSize(perp) {
  const size = num(perp?.baseSize);
  if (perp?.isLong === true) return Math.abs(size);
  if (perp?.isLong === false) return -Math.abs(size);
  return size;
}

function n1MarketPrecision(market) {
  const symbol = String(market?.symbol || '').trim();
  const priceDecimals = Number(market?.priceDecimals);
  const sizeDecimals = Number(market?.sizeDecimals);
  if (!symbol || !Number.isInteger(priceDecimals) || priceDecimals < 0
    || !Number.isInteger(sizeDecimals) || sizeDecimals < 0) {
    throw new Error('N1 缺少目标市场的 priceDecimals/sizeDecimals 元数据');
  }
  return {
    symbol,
    stepSize: Number(`1e-${sizeDecimals}`),
    stepPrice: Number(`1e-${priceDecimals}`),
  };
}

export class N1Exchange extends LiveVenueExchange {
  constructor(opts = {}) {
    super({
      ...opts,
      venue: 'n1',
      apiUrl: opts.apiUrl || DEFAULT_API,
      pollMs: opts.pollMs || 2500,
      feeRate: opts.feeRate ?? 0.0005,
    });
    this.appPublicKey = opts.appPublicKey || DEFAULT_APP;
    this.solanaRpc = opts.solanaRpc || DEFAULT_SOLANA;
    this.keypairPath = opts.keypairPath || path.resolve(process.cwd(), 'secrets', 'id.json');
    this.tradingArmed = opts.tradingArmed === true || opts.tradingArmed === 'YES';
    this.nord = null;
    this.user = null;
    this.accountId = null;
    this.sessionExpiresAt = 0;
    this._remoteMarketId = REMOTE_MARKET_ID;
  }

  async init() {
    const secret = loadKeypair(this.keypairPath);
    this.nord = await Nord.new({
      app: this.appPublicKey,
      solanaConnection: new Connection(this.solanaRpc, 'confirmed'),
      webServerUrl: this.apiUrl,
    });
    this.user = NordUser.fromPrivateKey(this.nord, secret);
    await this.user.updateAccountId();
    await this.user.fetchInfo();
    const ids = this.user.accountIds ?? [];
    if (ids.length !== 1) throw new Error('N1 需要恰好 1 个账户，当前数量=' + ids.length);
    this.accountId = ids[0];
    const market = this.nord.markets?.find((row) => Number(row.marketId) === this._remoteMarketId);
    const stats = await this.nord.getMarketStats({ marketId: this._remoteMarketId });
    const price = num(stats?.perpStats?.mark_price, num(stats?.indexPrice, 100_000));
    this._configureMarket(market, price);
    this._watch.add(INTERNAL_MARKET_ID);
    await this._refreshMarket(INTERNAL_MARKET_ID).then((snapshot) => this._applySnapshot(INTERNAL_MARKET_ID, snapshot));
    this.start();
    return true;
  }

  _configureMarket(market, price) {
    const precision = n1MarketPrecision(market);
    this._setMarkets([{
      marketId: INTERNAL_MARKET_ID,
      name: precision.symbol,
      displayName: precision.symbol,
      symbol: precision.symbol,
      lastPrice: price,
      stepSize: precision.stepSize,
      stepPrice: precision.stepPrice,
      minOrderSize: precision.stepSize,
      maxLeverage: 30,
    }], price);
  }

  async reconnect() {
    this.stop();
    this.dataSource = null;
    this.lastOkAt = 0;
    if (!this.user) return this.init();
    await this.user.fetchInfo();
    const snapshot = await this._refreshMarket(INTERNAL_MARKET_ID);
    this._applySnapshot(INTERNAL_MARKET_ID, snapshot);
    this.start();
    return true;
  }

  disconnect() {
    this.stop();
    this.dataSource = null;
    this.lastOkAt = 0;
    this.nord = null;
    this.user = null;
    this.accountId = null;
    this.sessionExpiresAt = 0;
  }

  _ensure() {
    if (!this.nord || !this.user || this.accountId == null) throw new Error('N1 未连接');
  }

  async getCandles(marketId, intervalSec = 3600, count = 200) {
    return fetchN1Candles({
      apiUrl: this.apiUrl,
      remoteMarketId: this._remoteMarketId,
      intervalSec,
      count,
    });
  }

  async _ensureSession() {
    this._ensure();
    const now = Date.now();
    if (now + 5 * 60_000 < this.sessionExpiresAt) return;
    const expiry = Math.floor(now / 1000) + 12 * 60 * 60;
    await this.user.refreshSession(BigInt(expiry));
    this.sessionExpiresAt = expiry * 1000;
  }

  async _refreshMarket(_marketId) {
    this._ensure();
    await this.user.fetchInfo();
    const stats = await this.nord.getMarketStats({ marketId: this._remoteMarketId });
    const price = num(stats?.perpStats?.mark_price, num(stats?.indexPrice));
    if (!(price > 0)) throw new Error('N1 返回无效 mark price');
    const accountKey = String(this.accountId);
    const accountOrders = this.user.orders?.[accountKey];
    const accountPositions = this.user.positions?.[accountKey];
    const accountBalances = this.user.balances?.[accountKey];
    if (!Array.isArray(accountOrders) || !Array.isArray(accountPositions) || !Array.isArray(accountBalances)) {
      throw new Error('N1 账户订单/持仓/余额快照格式无效，拒绝继续交易');
    }
    const positions = accountPositions
      .filter((row) => Number(row.marketId) === this._remoteMarketId && row.perp);
    const positionSize = positions.reduce((sum, row) => sum + signedPerpSize(row.perp), 0);
    const first = positions[0]?.perp || positions[0] || {};
    const entryPrice = num(first.price ?? first.entryPrice ?? first.avgEntryPrice);
    let unrealizedPnl = 0;
    for (const row of positions) {
      const perp = row.perp || row;
      const direct = Number(perp.sizePricePnl ?? perp.tradingPnl ?? perp.unrealizedPnl ?? perp.unrealized_pnl);
      if (Number.isFinite(direct)) unrealizedPnl += direct;
      else {
        const entry = num(perp.price ?? perp.entryPrice ?? perp.avgEntryPrice ?? row.entryPrice);
        unrealizedPnl += signedPerpSize(perp) * (price - entry);
      }
    }
    const rows = accountOrders
      .filter((row) => Number(row.marketId) === this._remoteMarketId)
      .map((row) => {
        const rawOrderId = row.orderId ?? row.id;
        const orderId = stableId(rawOrderId);
        if (!orderId) {
          throw new Error('N1 权威挂单快照缺少稳定 orderId，拒绝继续交易');
        }
        return {
          orderId,
          clientOrderId: row.clientOrderId ?? row.client_order_id ?? null,
          side: row.side === 'bid' || row.side === 'Bid' ? 'buy' : 'sell',
          price: num(row.price ?? row.placedPrice),
          sizeBase: num(row.size ?? row.originalOrderSize),
        };
      })
      .filter((row) => row.price > 0 && row.sizeBase > 0);
    const balances = accountBalances;
    const usdc = balances.find((row) => String(row.symbol || '').toUpperCase() === 'USDC');
    const margin = this.user.margins?.[accountKey];
    const equity = Number(usdc?.balance ?? margin?.mf ?? margin?.omf);
    let liquidationPrice = 0;
    try {
      const marginEquity = Number(margin?.mf ?? margin?.omf);
      const mmf = Number(margin?.mmf);
      const notional = Math.abs(positionSize) * price;
      const mmfBase = mmf / notional;
      if (Math.abs(positionSize) > 0 && marginEquity > 0 && mmfBase > 0) {
        liquidationPrice = Number(calcCurrPosLiqPrice({
          baseSize: Math.abs(positionSize),
          isLong: positionSize >= 0,
          indexPrice: price,
          mmfBase,
          accountEquity: marginEquity,
          otherPositionsMmf: 0,
        }).toString());
      }
    } catch { /* liq price is optional */ }
    const snapshot = {
      price,
      balance: Number.isFinite(equity) ? equity : undefined,
      equity: Number.isFinite(equity) ? equity : undefined,
      position: positionSize ? { sizeBase: positionSize, entryPrice, unrealizedPnl, liquidationPrice } : null,
      openOrders: rows,
    };
    await this._reconcilePendingPlacementFills(_marketId);
    return snapshot;
  }

  async _findPendingPlacementFill(pending) {
    if (!this.nord?.getTrades || this.accountId == null) return null;
    const order = pending.order || {};
    const expectedSide = order.side === 'buy' ? 'ask' : order.side === 'sell' ? 'bid' : null;
    if (!expectedSide) return null;
    let response;
    try {
      response = await this.nord.getTrades({
        marketId: this._remoteMarketId,
        makerId: this.accountId,
        takerSide: expectedSide,
        pageSize: 50,
        since: new Date(Math.max(0, pending.submittedAt - 30_000)).toISOString(),
      });
    } catch {
      return null;
    }
    const rows = Array.isArray(response?.items) ? response.items
      : Array.isArray(response?.trades) ? response.trades
        : Array.isArray(response?.data) ? response.data : [];
    const expectedPrice = Number(order.price);
    const expectedSize = Math.abs(Number(order.sizeBase));
    if (!(expectedPrice > 0) || !(expectedSize > 0)) return null;
    const stepPrice = Number(this.markets.get(Number(order.marketId))?.stepPrice) || 0;
    const priceTolerance = Math.max(stepPrice * 0.51, expectedPrice * 1e-9, 1e-9);
    const grouped = new Map();
    for (const row of rows) {
      if (Number(row.marketId) !== this._remoteMarketId) continue;
      if (row.makerId != null && Number(row.makerId) !== Number(this.accountId)) continue;
      if (String(row.takerSide || '').toLowerCase() !== expectedSide) continue;
      const actionId = stableId(pending.metadata?.actionId);
      if (actionId && stableId(row.actionId) !== actionId) continue;
      const orderId = stableId(row.orderId);
      const price = Number(row.price);
      const sizeBase = Math.abs(Number(row.baseSize));
      if (!orderId || !(price > 0) || !(sizeBase > 0)) continue;
      if (Math.abs(price - expectedPrice) > priceTolerance) continue;
      const timestamp = Date.parse(row.time ?? row.timestamp ?? '');
      if (!actionId && Number.isFinite(timestamp) && timestamp < pending.submittedAt) continue;
      const item = grouped.get(orderId) || { orderId, sizeBase: 0, quote: 0 };
      item.sizeBase += sizeBase;
      item.quote += price * sizeBase;
      grouped.set(orderId, item);
    }
    const matches = [...grouped.values()].filter((item) => item.sizeBase + 1e-12 >= expectedSize);
    if (matches.length !== 1) return null;
    const match = matches[0];
    return {
      orderId: match.orderId,
      price: match.quote / match.sizeBase,
      sizeBase: expectedSize,
    };
  }

  async setLeverage() {
    this.emit('error', new Error('N1 当前适配器未发现可验证的统一杠杆设置接口，沿用交易所当前杠杆'));
    return false;
  }

  async placeLimitOrder(order) {
    this._ensure();
    const resolved = this._takePendingPlacementOutcome(order);
    if (resolved) return resolved;
    this._assertNoPendingPlacements('下单');
    if (!this.tradingArmed) throw new Error('N1 实盘下单未授权：设置 N1_TRADING_ARMED=YES');
    await this._ensureSession();
    const before = await this._refreshMarket(order.marketId);
    this._applySnapshot(order.marketId, before);
    const remoteClientOrderId = clientOrderId('grid:' + order.side + ':' + order.levelIndex + ':' + order.clientOrderId);
    const pending = this._beginPendingPlacement({
      ...order,
      clientOrderId: String(remoteClientOrderId),
      requestClientOrderId: stableId(order.clientOrderId),
    }, remoteClientOrderId);
    try {
      const receipt = await this.user.placeOrder({
        marketId: this._remoteMarketId,
        side: order.side === 'buy' ? Side.Bid : Side.Ask,
        fillMode: FillMode.PostOnly,
        isReduceOnly: !!order.reduceOnly,
        size: Number(order.sizeBase),
        price: Number(order.price),
        accountId: this.accountId,
        clientOrderId: remoteClientOrderId,
      });
      pending.metadata.actionId = stableId(receipt?.actionId);
      const receiptFill = receipt?.fills?.find?.((fill) => stableId(fill?.orderId) && Number(fill?.size ?? fill?.sizeBase) > 0);
      const orderId = receipt?.orderId
        ?? receipt?.id
        ?? receiptFill?.orderId;
      if (!stableId(orderId)) {
        const filled = await this._resolvePendingPlacementAfterWrite(pending.order);
        if (filled) return filled;
        throw this._pendingPlacementError(
          new Error('N1 下单回执缺少稳定 orderId'),
          pending,
          'N1 下单结果未知，等待权威挂单对账',
        );
      }
      if (!receipt?.orderId && !receipt?.id && receiptFill) {
        const marked = this._markPendingPlacementFilled(pending, {
          orderId,
          price: Number(receiptFill.price ?? order.price),
          sizeBase: Number(receiptFill.size ?? receiptFill.sizeBase),
        });
        if (marked) return this._takePendingPlacementOutcome(pending.order);
        throw this._pendingPlacementError(
          new Error('N1 成交回执缺少有效价格或数量，结果未知'),
          pending,
          'N1 下单结果未知，等待权威成交/挂单对账',
        );
      }
      const result = this._registerPlaced(orderId, {
        ...order,
        clientOrderId: pending.clientOrderId,
      });
      this._pendingPlacements.delete(pending.clientOrderId);
      this._finishPendingWrite(pending.write);
      return result;
    } catch (error) {
      const filled = await this._resolvePendingPlacementAfterWrite(pending.order);
      if (filled) return filled;
      if (!error?.pending) this._pendingPlacementError(error, pending, 'N1 下单结果未知，等待权威挂单对账');
      throw error;
    }
  }

  async placeLimitOrders(orders) {
    const results = [];
    for (const order of orders) results.push(await this.placeLimitOrder(order));
    return results;
  }

  async cancelOrder(marketId, orderId) {
    this._ensure();
    this._assertNoPendingPlacements('撤单');
    await this._ensureSession();
    const write = this._beginPendingWrite('cancel', { marketId: Number(marketId), orderId: String(orderId) });
    try {
      await this.user.cancelOrder(BigInt(String(orderId)), this.accountId);
      this._finishPendingWrite(write);
      this._markCancelled(orderId);
    } catch (error) {
      error.pending = true;
      error.writeId = write.id;
      throw error;
    }
    return true;
  }

  async cancelAll(marketId) {
    this._ensure();
    this._assertNoPendingPlacements('撤销全部挂单');
    await this.user.fetchInfo();
    await this._ensureSession();
    const rows = (this.user.orders?.[String(this.accountId)] || [])
      .filter((row) => Number(row.marketId) === this._remoteMarketId);
    const orderIds = rows.map((row) => stableId(row.orderId ?? row.id));
    for (const orderId of orderIds) {
      if (!orderId) {
        throw new Error('N1 撤单快照缺少稳定 orderId，拒绝继续撤单');
      }
    }
    const write = this._beginPendingWrite('cancelAll', { marketId: Number(marketId), orderIds });
    try {
      for (const orderId of orderIds) {
        await this.user.cancelOrder(BigInt(orderId), this.accountId);
      }
      this._finishPendingWrite(write);
    } catch (error) {
      error.pending = true;
      error.writeId = write.id;
      throw error;
    }
    this._markMarketCancelled(marketId);
    return true;
  }

  async closePosition(marketId) {
    this._ensure();
    this._assertNoPendingPlacements('平仓');
    if (!this.tradingArmed) throw new Error('N1 实盘平仓未授权：设置 N1_TRADING_ARMED=YES');
    const snapshot = await this._refreshMarket(marketId);
    const position = Number(snapshot.position?.sizeBase || 0);
    if (!position) return true;
    const price = Number(snapshot.price);
    await this._ensureSession();
    const write = this._beginPendingWrite('closePosition', { marketId: Number(marketId) });
    try {
      const receipt = await this.user.placeOrder({
        marketId: this._remoteMarketId,
        side: position > 0 ? Side.Ask : Side.Bid,
        fillMode: FillMode.ImmediateOrCancel,
        isReduceOnly: true,
        size: Math.abs(position),
        price: position > 0 ? price * 0.992 : price * 1.008,
        accountId: this.accountId,
        clientOrderId: clientOrderId('flat:' + Date.now()),
      });
      if (!receipt?.orderId && !receipt?.id && !(Array.isArray(receipt?.fills) && receipt.fills.length)) {
        const error = new Error('N1 平仓回执缺少 orderId/fills，结果未知');
        error.pending = true;
        error.writeId = write.id;
        throw error;
      }
      this._finishPendingWrite(write);
    } catch (error) {
      if (!error?.pending) {
        error.pending = true;
        error.writeId = write.id;
      }
      throw error;
    }
    return true;
  }
}
