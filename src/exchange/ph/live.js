import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  OrderFlags,
  Side as PhoenixSide,
  createPhoenixClient,
} from '@ellipsis-labs/rise';
import { LiveVenueExchange, num, sleep, stableId } from '../common/live.js';
import { fetchPhoenixCandles } from './market-data.js';

const DEFAULT_API = 'https://perp-api.phoenix.trade';
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const QUOTE_LOTS_DECIMALS = 6;

function loadKeypair(privateKey, keypairPath, label) {
  const rawKey = String(privateKey || '').trim();
  if (rawKey) {
    if (rawKey.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey)));
    return Keypair.fromSecretKey(bs58.decode(rawKey));
  }
  if (!keypairPath || !fs.existsSync(keypairPath)) throw new Error('缺少 ' + label + ' Solana keypair：' + keypairPath);
  const raw = fs.readFileSync(keypairPath, 'utf8').trim();
  if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  return Keypair.fromSecretKey(bs58.decode(raw));
}

function roundLot(size, lotSize) {
  if (!(size > 0) || !(lotSize > 0)) return 0;
  return Number((Math.floor(size / lotSize + 1e-12) * lotSize).toPrecision(15));
}

function powerOfTen(exponent) {
  return Number(`1e${exponent >= 0 ? '+' : ''}${exponent}`);
}

function marketPrecision(market) {
  const baseLotsDecimals = Number(market?.baseLotsDecimals);
  const tickSizeInQuoteLots = Number(market?.tickSize);
  if (!Number.isInteger(baseLotsDecimals) || !(tickSizeInQuoteLots > 0)) {
    throw new Error('Phoenix 市场元数据缺少有效的 tickSize/baseLotsDecimals');
  }
  const lotSize = powerOfTen(-baseLotsDecimals);
  const priceStep = tickSizeInQuoteLots * powerOfTen(baseLotsDecimals - QUOTE_LOTS_DECIMALS);
  if (!(lotSize > 0) || !(priceStep > 0) || !Number.isFinite(lotSize) || !Number.isFinite(priceStep)) {
    throw new Error('Phoenix 市场元数据无法转换为有效的价格/数量精度');
  }
  return { baseLotsDecimals, tickSizeInQuoteLots, lotSize, priceStep };
}

function ticksToPrice(priceTicks, precision) {
  const ticks = Number(priceTicks);
  if (!Number.isFinite(ticks)) return 0;
  return ticks * precision.tickSizeInQuoteLots * powerOfTen(precision.baseLotsDecimals - QUOTE_LOTS_DECIMALS);
}

function fromPhoenixSide(side) {
  const text = String(side || '').toLowerCase();
  return text === 'ask' || text === 'sell' || text === '1' ? 'sell' : 'buy';
}

function toPhoenixSide(side) {
  return side === 'buy' ? PhoenixSide.Bid : PhoenixSide.Ask;
}

function orderId(priceTicks, sequence) {
  return String(priceTicks) + ':' + String(sequence);
}

function parseOrderId(id) {
  const match = String(id).match(/^(\d+):(\d+)$/);
  return match ? { priceTicks: BigInt(match[1]), sequence: BigInt(match[2]) } : null;
}

function kitIxToWeb3(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: ix.accounts.map((account) => ({
      pubkey: new PublicKey(account.address),
      isSigner: account.role === 2 || account.role === 3,
      isWritable: account.role === 1 || account.role === 3,
    })),
    data: Buffer.from(ix.data),
  });
}

export class PhoenixExchange extends LiveVenueExchange {
  constructor(opts = {}) {
    super({
      ...opts,
      venue: opts.venue || 'ph',
      apiUrl: opts.apiUrl || DEFAULT_API,
      pollMs: opts.pollMs || 2500,
      feeRate: opts.feeRate ?? 0.0005,
    });
    this.id = opts.venue || 'ph';
    this.rpcUrl = opts.rpcUrl || DEFAULT_RPC;
    this.privateKey = opts.privateKey || '';
    this.symbol = String(opts.symbol || '').trim();
    this.keypairPath = opts.keypairPath || path.resolve(process.cwd(), 'secrets', this.id === 'ph2' ? 'phoenix2.key' : 'phoenix.key');
    this.computeUnitLimit = Number(opts.computeUnitLimit || 600_000);
    this.orderGapMs = Math.max(0, Number(opts.orderGapMs || 800));
    this.orderDiscoveryPollMs = Math.max(0, Number(opts.orderDiscoveryPollMs ?? 300));
    this.orderDiscoveryAttempts = Math.max(1, Math.floor(Number(opts.orderDiscoveryAttempts ?? 6)));
    this.client = null;
    this.kp = null;
    this.conn = null;
    this.authority = '';
    this.symbolByMarket = new Map();
    this._marketPrecision = new Map();
  }

  async init() {
    this.client = createPhoenixClient({
      apiUrl: this.apiUrl,
      rpcUrl: this.rpcUrl,
      exchangeMetadata: { stream: false },
      ws: false,
    });
    await this.client.exchange.ready();
    this.kp = loadKeypair(this.privateKey, this.keypairPath, this.id === 'ph2' ? 'Phoenix2' : 'Phoenix');
    this.authority = this.kp.publicKey.toBase58();
    this.conn = new Connection(this.rpcUrl, 'confirmed');
    const allMarkets = this.client.exchange.snapshot()?.markets?.filter((market) => market?.symbol) || [];
    let markets = allMarkets;
    if (this.symbol) {
      const requested = this.symbol.toUpperCase().replace(/-USD$/, '').replace(/-PERP$/, '');
      const selected = allMarkets.find((market) => String(market.symbol).toUpperCase() === this.symbol.toUpperCase())
        || allMarkets.find((market) => String(market.symbol).toUpperCase() === requested)
        || allMarkets.find((market) => String(market.symbol).toUpperCase().startsWith(requested));
      if (!selected) throw new Error(this.id + ' 未找到配置的市场 ' + this.symbol);
      markets = [selected];
    }
    const rows = this._configureMarkets(markets);
    if (!rows.length) throw new Error('Phoenix 未返回可交易市场');
    this._setMarkets(rows, 100_000);
    this._watch.add(rows[0].marketId);
    await this._refreshMarket(rows[0].marketId).then((snapshot) => this._applySnapshot(rows[0].marketId, snapshot));
    this.start();
    console.log('[' + this.id + '] authority=' + this.authority);
    return true;
  }

  _configureMarkets(markets) {
    this._marketPrecision.clear();
    this.symbolByMarket.clear();
    return markets.map((market, index) => {
      const marketId = index + 1;
      const symbol = String(market.symbol);
      const precision = marketPrecision(market);
      this._marketPrecision.set(marketId, precision);
      this.symbolByMarket.set(marketId, symbol);
      return {
        marketId,
        name: symbol,
        displayName: symbol,
        symbol,
        lastPrice: index === 0 ? 100_000 : 0,
        stepSize: precision.lotSize,
        stepPrice: precision.priceStep,
        minOrderSize: precision.lotSize,
        maxLeverage: 30,
      };
    });
  }

  disconnect() {
    this.stop();
    this.dataSource = null;
    this.lastOkAt = 0;
    try { this.client?.dispose?.(); } catch { /* ignore */ }
    this.client = null;
    this.kp = null;
    this.conn = null;
    this.authority = '';
    this.symbolByMarket.clear();
    this._marketPrecision.clear();
  }

  _ensure() {
    if (!this.client || !this.kp || !this.conn || !this.authority) throw new Error(this.id + ' 实盘未连接');
  }

  _symbolForMarket(marketId) {
    const symbol = this.symbolByMarket.get(Number(marketId));
    if (!symbol) throw new Error(this.id + ' 未知市场 marketId=' + marketId);
    return symbol;
  }

  _precisionForMarket(marketId) {
    const precision = this._marketPrecision.get(Number(marketId));
    if (!precision) throw new Error(this.id + ' 缺少市场精度元数据 marketId=' + marketId);
    return precision;
  }

  async getCandles(marketId, intervalSec = 3600, count = 200) {
    return fetchPhoenixCandles({
      apiUrl: this.apiUrl,
      symbol: this._symbolForMarket(marketId),
      intervalSec,
      count,
    });
  }

  async _sendIxs(ixs) {
    this._ensure();
    const cuLimit = Math.max(200_000, this.computeUnitLimit || 600_000);
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: this.kp.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ...ixs.map(kitIxToWeb3),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([this.kp]);
    let signature;
    try {
      signature = await this.conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    } catch (error) {
      error.pending = true;
      throw error;
    }
    let confirmation;
    try {
      confirmation = await this.conn.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
    } catch (error) {
      error.pending = true;
      error.txSignature = signature;
      throw error;
    }
    if (confirmation.value.err) {
      const error = new Error(this.id + ' Solana 交易失败：' + JSON.stringify(confirmation.value.err));
      error.receiptKnown = true;
      error.txSignature = signature;
      throw error;
    }
    return signature;
  }

  async _mark(symbol) {
    const response = await fetch(this.apiUrl + '/v1/market/' + encodeURIComponent(symbol) + '/mark-price', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(this.id + ' mark-price HTTP ' + response.status);
    const body = await response.json();
    const price = num(body?.markPrice?.price ?? body?.price);
    if (!(price > 0)) throw new Error(this.id + ' 返回无效 mark price');
    return price;
  }

  async _traderState() {
    const response = await fetch(this.apiUrl + '/v1/trader/state/' + this.authority, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(this.id + ' trader state HTTP ' + response.status);
    return response.json();
  }

  async _refreshMarket(marketId) {
    this._ensure();
    const symbol = this._symbolForMarket(marketId);
    const precision = this._precisionForMarket(marketId);
    const [price, state] = await Promise.all([this._mark(symbol), this._traderState()]);
    if (!state?.snapshot || !Array.isArray(state.snapshot.subaccounts) || !state.snapshot.subaccounts.length) {
      throw new Error(this.id + ' 账户快照格式无效，拒绝继续交易');
    }
    const snapshot = state.snapshot;
    const subaccount = snapshot.subaccounts.find((row) => Number(row.subaccountIndex) === 0)
      || snapshot.subaccounts[0];
    const collateral = num(subaccount.collateral) / 1e6;
    let position = 0;
    let entryPrice = 0;
    let unrealizedPnl = 0;
    for (const row of subaccount.positions || []) {
      if (String(row.symbol || '').toUpperCase() !== String(symbol).toUpperCase()) continue;
      position = num(row.basePositionLots) * precision.lotSize;
      entryPrice = num(row.entryPriceUsd ?? ticksToPrice(row.entryPriceTicks, precision));
      if (entryPrice > 0) unrealizedPnl = position * (price - entryPrice);
      break;
    }
    const openOrders = [];
    for (const block of subaccount.orders || []) {
      if (String(block.symbol || '').toUpperCase() !== String(symbol).toUpperCase()) continue;
      for (const row of block.orders || []) {
        if (String(row.status || '').toLowerCase() === 'cancelled') continue;
        const sizeBase = num(row.sizeRemainingLots ?? row.initialSizeLots) * precision.lotSize;
        const priceValue = num(row.priceUsd ?? ticksToPrice(row.priceTicks, precision));
        const sequence = row.orderSequenceNumber;
        if (!(sizeBase > 0) || !(priceValue > 0)) {
          throw new Error(this.id + ' 权威挂单快照包含无效价格或数量，拒绝继续交易');
        }
        if (sequence == null || row.priceTicks == null) {
          throw new Error(this.id + ' 权威挂单快照缺少可撤销的 priceTicks/orderSequenceNumber');
        }
        openOrders.push({
          orderId: orderId(row.priceTicks ?? Math.round(priceValue), sequence),
          clientOrderId: row.clientOrderId ?? row.client_order_id ?? '',
          side: fromPhoenixSide(row.side),
          price: priceValue,
          sizeBase,
        });
      }
    }
    const result = {
      price,
      balance: collateral > 0 ? collateral : undefined,
      equity: collateral > 0 ? collateral : undefined,
      position: position ? { sizeBase: position, entryPrice, unrealizedPnl } : null,
      openOrders,
    };
    await this._reconcilePendingPlacementFills(marketId);
    return result;
  }

  async setLeverage() {
    this.emit('error', new Error(this.id + ' 当前适配器未发现可验证的统一杠杆设置接口，沿用交易所当前杠杆'));
    return false;
  }

  async _findPlacedOrder(marketId, order) {
    for (let attempt = 0; attempt < this.orderDiscoveryAttempts; attempt++) {
      const snapshot = await this._refreshMarket(marketId);
      const exact = snapshot.openOrders.find((row) => row.clientOrderId
        && String(row.clientOrderId) === String(order.clientOrderId));
      if (exact) return exact;
      if (attempt + 1 < this.orderDiscoveryAttempts && this.orderDiscoveryPollMs) {
        await sleep(this.orderDiscoveryPollMs);
      }
    }
    return null;
  }

  async _findPendingPlacementFill(pending) {
    if (!pending.txSignature) return null;
    const trades = this.client?.api?.trades?.();
    if (!trades?.getTraderTradesHistory) return null;
    const order = pending.order || {};
    const symbol = this._symbolForMarket(order.marketId);
    const precision = this._precisionForMarket(order.marketId);
    let response;
    try {
      response = await trades.getTraderTradesHistory(this.authority, {
        pdaIndex: 0,
        marketSymbol: symbol,
        limit: 100,
      });
    } catch {
      return null;
    }
    const rows = Array.isArray(response?.data) ? response.data : [];
    const expectedPrice = Number(order.price);
    const expectedSize = Math.abs(Number(order.sizeBase));
    const priceTicks = pending.metadata?.priceTicks;
    const txSignature = stableId(pending.txSignature);
    if (!(expectedPrice > 0) || !(expectedSize > 0) || priceTicks == null || !txSignature) return null;
    const targetLots = expectedSize / precision.lotSize;
    const expectedSign = order.side === 'buy' ? 1 : order.side === 'sell' ? -1 : 0;
    const priceTolerance = Math.max(expectedPrice * 1e-9, 1e-8);
    const grouped = new Map();
    for (const row of rows) {
      if (String(row.marketSymbol || '').toUpperCase() !== String(symbol).toUpperCase()) continue;
      if (row.tradeType && row.tradeType !== 'limit') continue;
      if (stableId(row.signature) !== txSignature) continue;
      const sequence = row.orderSequenceNumber;
      const deltaLots = Number(row.baseLotsDelta);
      const fillPrice = Number(row.price);
      if (sequence == null || !Number.isFinite(deltaLots) || !Number.isFinite(fillPrice)
        || !(Math.abs(deltaLots) > 0) || !(fillPrice > 0)) continue;
      if (expectedSign && Math.sign(deltaLots) !== expectedSign) continue;
      if (Math.abs(fillPrice - expectedPrice) > priceTolerance) continue;
      const timestamp = Number(row.timestamp);
      const timestampMs = Number.isFinite(timestamp)
        ? (timestamp > 1e12 ? timestamp : timestamp * 1000)
        : NaN;
      if (Number.isFinite(timestampMs) && timestampMs < pending.submittedAt) continue;
      const key = String(sequence);
      const item = grouped.get(key) || { sequence: key, lots: 0, quote: 0 };
      const lots = Math.abs(deltaLots);
      item.lots += lots;
      item.quote += fillPrice * lots;
      grouped.set(key, item);
    }
    const matches = [...grouped.values()].filter((item) => item.lots + 1e-9 >= targetLots);
    if (matches.length !== 1) return null;
    const match = matches[0];
    return {
      orderId: orderId(priceTicks, match.sequence),
      price: match.quote / match.lots,
      sizeBase: expectedSize,
    };
  }

  async placeLimitOrder(order) {
    this._ensure();
    const requestedClientOrderId = stableId(order.clientOrderId);
    if (!requestedClientOrderId) throw new Error(this.id + ' 下单缺少稳定 clientOrderId');
    const resolved = this._takePendingPlacementOutcome(order);
    if (resolved) return resolved;
    this._assertNoPendingPlacements('下单');
    const marketId = Number(order.marketId);
    const symbol = this._symbolForMarket(marketId);
    const precision = this._precisionForMarket(marketId);
    const size = roundLot(Number(order.sizeBase), precision.lotSize);
    if (!(size > 0)) throw new Error(this.id + ' size 小于 lot=' + precision.lotSize);
    const price = Number(order.price);
    const before = await this._refreshMarket(marketId);
    this._applySnapshot(marketId, before);
    const mark = Number(before.price) || await this._mark(symbol);
    if ((order.side === 'sell' && price <= mark) || (order.side === 'buy' && price >= mark)) {
      throw new Error(this.id + ' PostOnly 订单穿价，等待下一轮行情');
    }
    if (this.orderGapMs) await sleep(this.orderGapMs);
    const packet = await this.client.orderPackets.buildLimitOrderPacket({
      symbol,
      side: toPhoenixSide(order.side),
      priceUsd: String(price),
      baseUnits: String(size),
    });
    const remoteClientOrderId = BigInt(requestedClientOrderId);
    if (remoteClientOrderId <= 0n) throw new Error(this.id + ' 下单缺少稳定 clientOrderId');
    const ix = await this.client.ixs.buildPlacePostOnlyOrder({
      authority: this.authority,
      symbol,
      orderPacket: {
        side: packet.side,
        priceInTicks: packet.priceInTicks,
        numBaseLots: packet.numBaseLots,
        clientOrderId: remoteClientOrderId,
        slide: true,
        lastValidSlot: null,
        orderFlags: order.reduceOnly ? (packet.orderFlags | OrderFlags.ReduceOnly) : packet.orderFlags,
        cancelExisting: false,
      },
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    });
    const pending = this._beginPendingPlacement({
      ...order,
      marketId,
      clientOrderId: String(remoteClientOrderId),
      requestClientOrderId: requestedClientOrderId,
      price,
      sizeBase: size,
    }, remoteClientOrderId, {
      metadata: { symbol, priceTicks: String(packet.priceInTicks) },
    });
    try {
      const signature = await this._sendIxs([ix]);
      pending.txSignature = signature;
      const placed = await this._findPlacedOrder(marketId, {
        ...order,
        clientOrderId: String(remoteClientOrderId),
        sizeBase: size,
        price,
      });
      if (!placed) {
        const filled = await this._resolvePendingPlacementAfterWrite(pending.order);
        if (filled) return filled;
        throw this._pendingPlacementError(
          new Error(this.id + ' 交易已确认但权威挂单列表暂未发现订单'),
          pending,
          this.id + ' 订单发现结果未知，等待权威挂单对账',
        );
      }
      const result = this._registerPlaced(placed.orderId, {
        ...order,
        clientOrderId: String(remoteClientOrderId),
        price: placed.price,
        sizeBase: placed.sizeBase,
      });
      this._pendingPlacements.delete(pending.clientOrderId);
      this._finishPendingWrite(pending.write);
      return result;
    } catch (error) {
      pending.txSignature = pending.txSignature || stableId(error?.txSignature) || null;
      const filled = await this._resolvePendingPlacementAfterWrite(pending.order);
      if (filled) return filled;
      if (error?.receiptKnown) {
        this._pendingPlacements.delete(pending.clientOrderId);
        this._finishPendingWrite(pending.write);
      } else if (!error?.pending) {
        this._pendingPlacementError(error, pending, this.id + ' 下单结果未知，等待权威挂单对账');
      } else {
        error.clientOrderId = error.clientOrderId || pending.clientOrderId;
        error.writeId = error.writeId || pending.write?.id;
      }
      throw error;
    }
  }

  async placeLimitOrders(orders) {
    const results = [];
    for (const order of orders) results.push(await this.placeLimitOrder(order));
    return results;
  }

  async cancelOrder(marketId, orderIdValue) {
    this._ensure();
    this._assertNoPendingPlacements('撤单');
    const parsed = parseOrderId(orderIdValue);
    if (!parsed) throw new Error(this.id + ' 无法解析 orderId=' + orderIdValue);
    const ix = await this.client.ixs.buildCancelOrdersById({
      authority: this.authority,
      symbol: this._symbolForMarket(marketId),
      orders: [{ price: parsed.priceTicks, orderSequenceNumber: String(parsed.sequence) }],
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    });
    const write = this._beginPendingWrite('cancel', { marketId: Number(marketId), orderId: String(orderIdValue) });
    try {
      await this._sendIxs([ix]);
      this._finishPendingWrite(write);
    } catch (error) {
      if (error?.receiptKnown) this._finishPendingWrite(write);
      else {
        error.pending = true;
        error.writeId = write.id;
      }
      throw error;
    }
    this._markCancelled(orderIdValue);
    return true;
  }

  async cancelAll(marketId) {
    this._ensure();
    this._assertNoPendingPlacements('撤销全部挂单');
    const before = await this._refreshMarket(marketId);
    const ix = await this.client.ixs.buildCancelAll({
      authority: this.authority,
      symbol: this._symbolForMarket(marketId),
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    });
    const write = this._beginPendingWrite('cancelAll', {
      marketId: Number(marketId),
      orderIds: before.openOrders.map((row) => String(row.orderId)),
    });
    try {
      await this._sendIxs([ix]);
      this._finishPendingWrite(write);
    } catch (error) {
      if (error?.receiptKnown) this._finishPendingWrite(write);
      else {
        error.pending = true;
        error.writeId = write.id;
      }
      throw error;
    }
    this._markMarketCancelled(marketId);
    return true;
  }

  async closePosition(marketId) {
    this._ensure();
    this._assertNoPendingPlacements('平仓');
    const snapshot = await this._refreshMarket(marketId);
    const position = Number(snapshot.position?.sizeBase || 0);
    if (!position) return true;
    const symbol = this._symbolForMarket(marketId);
    const precision = this._precisionForMarket(marketId);
    const packet = await this.client.orderPackets.buildMarketOrderPacket({
      symbol,
      side: position > 0 ? PhoenixSide.Ask : PhoenixSide.Bid,
      baseUnits: String(roundLot(Math.abs(position), precision.lotSize)),
    });
    packet.orderFlags = OrderFlags.ReduceOnly;
    const ix = await this.client.ixs.buildPlaceMarketOrder({
      authority: this.authority,
      symbol,
      orderPacket: packet,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    });
    const write = this._beginPendingWrite('closePosition', { marketId: Number(marketId) });
    try {
      await this._sendIxs([ix]);
      this._finishPendingWrite(write);
    } catch (error) {
      if (error?.receiptKnown) this._finishPendingWrite(write);
      else {
        error.pending = true;
        error.writeId = write.id;
      }
      throw error;
    }
    return true;
  }
}
