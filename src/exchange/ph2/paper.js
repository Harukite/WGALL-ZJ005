import { NewVenuePaperExchange } from '../common/new-paper.js';
import { fetchPhoenixCandles, fetchPhoenixPrice } from '../ph/market-data.js';

export class Phoenix2PaperExchange extends NewVenuePaperExchange {
  constructor(opts = {}) {
    super('ph2', {
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
