import { NewVenuePaperExchange } from '../common/new-paper.js';
import { fetchPopdexCandles, fetchPopdexPrice } from './market-data.js';

export class PopdexPaperExchange extends NewVenuePaperExchange {
  constructor(opts = {}) {
    super('pd', {
      ...opts,
      realPriceLoader: opts.realPriceLoader || ((ctx) => fetchPopdexPrice({
        apiUrl: ctx.exchange.apiUrl,
        symbol: ctx.exchange.symbol,
      })),
      realCandleLoader: opts.realCandleLoader || ((ctx) => fetchPopdexCandles({
        apiUrl: ctx.exchange.apiUrl,
        symbol: ctx.exchange.symbol,
        intervalSec: ctx.intervalSec,
        count: ctx.count,
      })),
    });
    this.symbol = String(opts.symbol || 'BTCUSDT').trim() || 'BTCUSDT';
  }
}
