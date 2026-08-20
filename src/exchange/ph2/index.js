import { Phoenix2PaperExchange } from './paper.js';
import { Phoenix2Exchange } from './live.js';

export function createExchange(cfg = {}) {
  if (cfg.mode === 'live') {
    return new Phoenix2Exchange({
      ...cfg,
      venue: 'ph2',
      privateKey: cfg.privateKey,
      keypairPath: cfg.keypairPath,
    });
  }
  return new Phoenix2PaperExchange(cfg);
}
