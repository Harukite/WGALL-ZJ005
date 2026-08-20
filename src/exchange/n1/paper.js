import { NewVenuePaperExchange } from '../common/new-paper.js';
import { fetchN1Candles, fetchN1Price } from './market-data.js';

export class N1PaperExchange extends NewVenuePaperExchange {
  constructor(opts = {}) {
    super('n1', {
      ...opts,
      realPriceLoader: opts.realPriceLoader || ((ctx) => fetchN1Price({
        apiUrl: ctx.exchange.apiUrl,
        remoteMarketId: ctx.exchange.remoteMarketId,
      })),
      realCandleLoader: opts.realCandleLoader || ((ctx) => fetchN1Candles({
        apiUrl: ctx.exchange.apiUrl,
        remoteMarketId: ctx.exchange.remoteMarketId,
        intervalSec: ctx.intervalSec,
        count: ctx.count,
      })),
    });
    this.remoteMarketId = 0;
  }
}
