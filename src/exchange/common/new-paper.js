import { VenuePaperExchange } from './paper.js';
import { fallbackMarkets } from './markets.js';

export class NewVenuePaperExchange extends VenuePaperExchange {
  constructor(key, opts = {}) {
    super({
      ...opts,
      venue: key,
      markets: opts.markets || fallbackMarkets(key),
    });
    this.network = opts.network || 'mainnet';
  }
}
