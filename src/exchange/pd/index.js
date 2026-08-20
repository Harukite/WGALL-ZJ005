import { PopdexPaperExchange } from './paper.js';
import { PopdexExchange } from './live.js';

export function createExchange(cfg = {}) {
  if (cfg.mode === 'live') {
    return new PopdexExchange(cfg);
  }
  return new PopdexPaperExchange(cfg);
}
