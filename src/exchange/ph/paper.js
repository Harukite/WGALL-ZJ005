import { NewVenuePaperExchange } from '../common/new-paper.js';
import { fetchPhoenixCandles, fetchPhoenixPrice } from './market-data.js';

export class PhoenixPaperExchange extends NewVenuePaperExchange {
  constructor(opts = {}) {
    super('ph', {
      ...opts,
      realPriceLoader: opts.realPriceLoader || ((ctx) => fetchPhoenixPrice({
        apiUrl: ctx.exchange.apiUrl,
        symbol: ctx.exchange.symbol || ctx.market?.symbol,
      })),
      realCandleLoader: opts.realCandleLoader || ((ctx) => fetchPhoenixCandles({
        apiUrl: ctx.exchange.apiUrl,
        symbol: ctx.exchange.symbol || ctx.market?.symbol,
        intervalSec: ctx.intervalSec,
        count: ctx.count,
      })),
    });
    this.symbol = String(opts.symbol || '').trim();
  }
}
