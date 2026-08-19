import { NewVenuePaperExchange } from '../common/new-paper.js';
import { fetchNadoCandles, fetchNadoPrice } from './market-data.js';

export class NadoPaperExchange extends NewVenuePaperExchange {
  constructor(opts = {}) {
    super('na', {
      ...opts,
      realPriceLoader: opts.realPriceLoader || ((ctx) => fetchNadoPrice({
        exchange: ctx.exchange,
        market: ctx.market,
      })),
      realCandleLoader: opts.realCandleLoader || ((ctx) => fetchNadoCandles({
        exchange: ctx.exchange,
        market: ctx.market,
        intervalSec: ctx.intervalSec,
        count: ctx.count,
      })),
    });
    this.productId = Math.max(1, Number(opts.productId || 2));
    this.rpcUrl = opts.rpcUrl || '';
  }
}
