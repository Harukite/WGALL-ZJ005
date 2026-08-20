import { PhoenixPaperExchange } from './paper.js';
import { PhoenixExchange } from './live.js';

export function createExchange(cfg = {}) {
  if (cfg.mode === 'live') {
    return new PhoenixExchange({
      ...cfg,
      venue: 'ph',
      privateKey: cfg.privateKey,
      keypairPath: cfg.keypairPath,
    });
  }
  return new PhoenixPaperExchange(cfg);
}
