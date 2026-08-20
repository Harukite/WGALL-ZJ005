import { VenuePaperExchange } from './paper.js';
import { fallbackMarkets } from './markets.js';
import { normalizeCandles } from './market-data.js';

export class NewVenuePaperExchange extends VenuePaperExchange {
  constructor(key, opts = {}) {
    super({
      ...opts,
      venue: key,
      markets: opts.markets || fallbackMarkets(key),
    });
    this.network = opts.network || 'mainnet';
    this._realMarketData = opts.realMarketData !== false
      && (typeof opts.realPriceLoader === 'function' || typeof opts.realCandleLoader === 'function');
    this._realPriceLoader = opts.realPriceLoader || null;
    this._realCandleLoader = opts.realCandleLoader || null;
    this._realPollMs = Math.max(500, Number(opts.realPollMs || opts.pollMs) || 5000);
    this._realTimer = null;
    this._realBusy = false;
    this._realEverOk = false;
    this._candleCache = new Map();
    if (this._realMarketData) this.dataSource = 'connecting';
  }

  async init() {
    await super.init();
    if (this._realMarketData) {
      await this._pollReal();
      if (!this._realEverOk) this.dataSource = 'synthetic';
    }
    return true;
  }

  async reconnect() {
    this.stop();
    if (this._realMarketData) this.dataSource = 'connecting';
    this.start();
    const connected = await this._pollReal();
    if (this._realMarketData && !this._realEverOk) this.dataSource = 'synthetic';
    else if (this._realMarketData && this.dataSource === 'connecting') this.dataSource = 'real';
    if (connected) this.lastOkAt = Date.now();
    return connected;
  }

  async getCandles(marketId, intervalSec = 3600, count = 200) {
    const id = Number(marketId);
    const cacheKey = id + ':' + Number(intervalSec || 3600);
    if (this._realMarketData && this._realCandleLoader) {
      try {
        const rows = await this._realCandleLoader({
          exchange: this,
          market: this.markets.get(id),
          marketId: id,
          intervalSec,
          count,
        });
        const candles = normalizeCandles(rows);
        if (!candles.length) throw new Error('公开行情返回空 K 线');
        this._candleCache.set(cacheKey, candles);
        this._realEverOk = true;
        this.dataSource = 'real';
        this.lastOkAt = Date.now();
        this.lastError = null;
        return candles.slice(-Math.max(1, Math.min(500, Number(count) || 200)));
      } catch (error) {
        this.lastError = String(error?.message || error);
        const cached = this._candleCache.get(cacheKey);
        if (cached?.length) return cached.slice(-Math.max(1, Math.min(500, Number(count) || 200)));
        if (this._realEverOk) return [];
      }
    }
    return super.getCandles(marketId, intervalSec, count);
  }

  start() {
    super.start();
    if (!this._realMarketData || this._realTimer) return;
    this._realTimer = setInterval(() => { this._pollReal().catch(() => {}); }, this._realPollMs);
    this._realTimer.unref?.();
  }

  stop() {
    super.stop();
    if (this._realTimer) clearInterval(this._realTimer);
    this._realTimer = null;
  }

  _tick() {
    if (this._realMarketData && this.dataSource !== 'synthetic') {
      this._refreshEquity();
      return;
    }
    super._tick();
  }

  async _pollReal() {
    if (!this._realMarketData || !this._realPriceLoader || this._realBusy) return false;
    this._realBusy = true;
    let updated = 0;
    let lastError = null;
    try {
      for (const [marketId, market] of this.markets) {
        try {
          const result = await this._realPriceLoader({ exchange: this, market, marketId });
          const price = Number(typeof result === 'object' ? result?.price : result);
          if (!(price > 0)) throw new Error('公开行情返回无效价格');
          this.setPrice(marketId, price);
          market.lastPrice = price;
          updated += 1;
        } catch (error) {
          lastError = error;
        }
      }
      if (updated) {
        this.dataSource = 'real';
        this._realEverOk = true;
        this.lastOkAt = Date.now();
        this.lastError = null;
        return true;
      }
      if (lastError) throw lastError;
      throw new Error('没有可读取的公开市场');
    } catch (error) {
      this.lastError = String(error?.message || error);
      if (!this._realEverOk) this.dataSource = 'synthetic';
      return false;
    } finally {
      this._realBusy = false;
    }
  }
}
