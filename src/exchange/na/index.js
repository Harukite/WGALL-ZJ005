import { NadoPaperExchange } from './paper.js';
import { NadoExchange } from './live.js';

export function createExchange(cfg = {}) {
  if (cfg.mode === 'live') {
    return new NadoExchange(cfg);
  }
  return new NadoPaperExchange(cfg);
}
