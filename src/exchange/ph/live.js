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
import { LiveVenueExchange, num, sleep } from '../common/live.js';
import { fetchPhoenixCandles } from './market-data.js';

const DEFAULT_API = 'https://perp-api.phoenix.trade';
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const LOT = 0.0001;

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

function roundLot(size) {
  if (!(size > 0)) return 0;
  return Number((Math.floor(size / LOT + 1e-12) * LOT).toFixed(8));
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
    this.client = null;
    this.kp = null;
    this.conn = null;
    this.authority = '';
    this.symbolByMarket = new Map();
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
    const allSymbols = this.client.exchange.snapshot()?.markets?.map((market) => market.symbol).filter(Boolean) || [];
    let symbols = allSymbols;
    if (this.symbol) {
      const requested = this.symbol.toUpperCase().replace(/-USD$/, '').replace(/-PERP$/, '');
      const selected = allSymbols.find((value) => String(value).toUpperCase() === this.symbol.toUpperCase())
        || allSymbols.find((value) => String(value).toUpperCase() === requested)
        || allSymbols.find((value) => String(value).toUpperCase().startsWith(requested));
      if (!selected) throw new Error(this.id + ' 未找到配置的市场 ' + this.symbol);
      symbols = [selected];
    }
    const rows = symbols.map((symbol, index) => {
      const marketId = index + 1;
      this.symbolByMarket.set(marketId, String(symbol));
      return {
        marketId,
        name: String(symbol),
        displayName: String(symbol),
        symbol: String(symbol),
        lastPrice: index === 0 ? 100_000 : 0,
        stepSize: LOT,
        stepPrice: 1,
        minOrderSize: LOT,
        maxLeverage: 30,
      };
    });
    if (!rows.length) throw new Error('Phoenix 未返回可交易市场');
    this._setMarkets(rows, 100_000);
    this._watch.add(rows[0].marketId);
    await this._refreshMarket(rows[0].marketId).then((snapshot) => this._applySnapshot(rows[0].marketId, snapshot));
    this.start();
    console.log('[' + this.id + '] authority=' + this.authority);
    return true;
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
  }

  _ensure() {
    if (!this.client || !this.kp || !this.conn || !this.authority) throw new Error(this.id + ' 实盘未连接');
  }

  _symbolForMarket(marketId) {
    const symbol = this.symbolByMarket.get(Number(marketId));
    if (!symbol) throw new Error(this.id + ' 未知市场 marketId=' + marketId);
    return symbol;
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
    const signature = await this.conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    const confirmation = await this.conn.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (confirmation.value.err) throw new Error(this.id + ' Solana 交易失败：' + JSON.stringify(confirmation.value.err));
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
      position = num(row.basePositionLots) * LOT;
      entryPrice = num(row.entryPriceUsd ?? row.entryPriceTicks);
      if (entryPrice > 0) unrealizedPnl = position * (price - entryPrice);
      break;
    }
    const openOrders = [];
    for (const block of subaccount.orders || []) {
      if (String(block.symbol || '').toUpperCase() !== String(symbol).toUpperCase()) continue;
      for (const row of block.orders || []) {
        if (String(row.status || '').toLowerCase() === 'cancelled') continue;
        const sizeBase = num(row.sizeRemainingLots ?? row.initialSizeLots) * LOT;
        const priceValue = num(row.priceUsd ?? row.priceTicks);
        const sequence = row.orderSequenceNumber;
        if (!(sizeBase > 0) || !(priceValue > 0) || sequence == null) continue;
        openOrders.push({
          orderId: orderId(row.priceTicks ?? Math.round(priceValue), sequence),
          clientOrderId: row.clientOrderId ?? row.client_order_id ?? '',
          side: fromPhoenixSide(row.side),
          price: priceValue,
          sizeBase,
        });
      }
    }
    return {
      price,
      balance: collateral > 0 ? collateral : undefined,
      equity: collateral > 0 ? collateral : undefined,
      position: position ? { sizeBase: position, entryPrice, unrealizedPnl } : null,
      openOrders,
    };
  }

  async setLeverage() {
    this.emit('error', new Error(this.id + ' 当前适配器未发现可验证的统一杠杆设置接口，沿用交易所当前杠杆'));
    return false;
  }

  async _findPlacedOrder(marketId, order, previousIds = new Set()) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const snapshot = await this._refreshMarket(marketId);
      const exact = snapshot.openOrders.find((row) => row.clientOrderId
        && String(row.clientOrderId) === String(order.clientOrderId));
      if (exact) return exact;
      const candidates = snapshot.openOrders
        .filter((row) => !previousIds.has(String(row.orderId)))
        .filter((row) => row.side === order.side)
        .filter((row) => Math.abs(Number(row.price) - Number(order.price)) <= 2)
        .filter((row) => Math.abs(Number(row.sizeBase) - Number(order.sizeBase)) <= Math.max(LOT, Number(order.sizeBase) * 0.01));
      if (candidates.length === 1) return candidates[0];
      await sleep(300);
    }
    return null;
  }

  async placeLimitOrder(order) {
    this._ensure();
    const marketId = Number(order.marketId);
    const symbol = this._symbolForMarket(marketId);
    const size = roundLot(Number(order.sizeBase));
    if (!(size > 0)) throw new Error(this.id + ' size 小于 lot=' + LOT);
    const price = Number(order.price);
    const before = await this._refreshMarket(marketId);
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
    const ix = await this.client.ixs.buildPlacePostOnlyOrder({
      authority: this.authority,
      symbol,
      orderPacket: {
        side: packet.side,
        priceInTicks: packet.priceInTicks,
        numBaseLots: packet.numBaseLots,
        clientOrderId: BigInt(order.clientOrderId || 0),
        slide: true,
        lastValidSlot: null,
        orderFlags: order.reduceOnly ? (packet.orderFlags | OrderFlags.ReduceOnly) : packet.orderFlags,
        cancelExisting: false,
      },
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    });
    await this._sendIxs([ix]);
    const previousIds = new Set(before.openOrders.map((row) => String(row.orderId)));
    const placed = await this._findPlacedOrder(marketId, { ...order, sizeBase: size, price }, previousIds);
    if (!placed) throw new Error(this.id + ' 交易已确认但权威挂单列表暂未发现订单，停止自动重发');
    return this._registerPlaced(placed.orderId, { ...order, price: placed.price, sizeBase: placed.sizeBase });
  }

  async placeLimitOrders(orders) {
    const results = [];
    for (const order of orders) results.push(await this.placeLimitOrder(order));
    return results;
  }

  async cancelOrder(marketId, orderIdValue) {
    this._ensure();
    const parsed = parseOrderId(orderIdValue);
    if (!parsed) throw new Error(this.id + ' 无法解析 orderId=' + orderIdValue);
    const ix = await this.client.ixs.buildCancelOrdersById({
      authority: this.authority,
      symbol: this._symbolForMarket(marketId),
      orders: [{ price: parsed.priceTicks, orderSequenceNumber: String(parsed.sequence) }],
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    });
    await this._sendIxs([ix]);
    this._markCancelled(orderIdValue);
    return true;
  }

  async cancelAll(marketId) {
    this._ensure();
    const ix = await this.client.ixs.buildCancelAll({
      authority: this.authority,
      symbol: this._symbolForMarket(marketId),
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    });
    await this._sendIxs([ix]);
    this._markMarketCancelled(marketId);
    return true;
  }

  async closePosition(marketId) {
    this._ensure();
    const snapshot = await this._refreshMarket(marketId);
    const position = Number(snapshot.position?.sizeBase || 0);
    if (!position) return true;
    const symbol = this._symbolForMarket(marketId);
    const packet = await this.client.orderPackets.buildMarketOrderPacket({
      symbol,
      side: position > 0 ? PhoenixSide.Ask : PhoenixSide.Bid,
      baseUnits: String(roundLot(Math.abs(position))),
    });
    packet.orderFlags = OrderFlags.ReduceOnly;
    const ix = await this.client.ixs.buildPlaceMarketOrder({
      authority: this.authority,
      symbol,
      orderPacket: packet,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    });
    await this._sendIxs([ix]);
    return true;
  }
}
