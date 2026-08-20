import { N1PaperExchange } from './paper.js';
import { N1Exchange } from './live.js';

export function createExchange(cfg = {}) {
  if (cfg.mode === 'live') {
    if (!cfg.keypairPath) throw new Error('N1 LIVE 模式需要 N1_KEYPAIR_PATH（默认 secrets/id.json）。');
    return new N1Exchange({
      ...cfg,
      apiUrl: cfg.apiUrl,
      keypairPath: cfg.keypairPath,
      tradingArmed: cfg.tradingArmed,
    });
  }
  return new N1PaperExchange(cfg);
}
