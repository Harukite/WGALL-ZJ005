import { ArcusExchange } from './arcus.js';
import { PaperExchange } from './paper.js';

export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!cfg.address || !cfg.apiKey || (!cfg.apiPrivateKey && !cfg.apiPrivateKeyFile)) {
      throw new Error('Arcus LIVE 模式需要 ARCUS_ADDRESS、ARCUS_API_KEY，以及 ARCUS_API_PRIVATE_KEY 或 ARCUS_API_PRIVATE_KEY_FILE。不要填写 Ethereum 主钱包私钥。');
    }
    return new ArcusExchange({
      network: cfg.network, apiUrl: cfg.apiUrl, wsUrl: cfg.wsUrl,
      address: cfg.address, accountIndex: cfg.accountIndex,
      apiKey: cfg.apiKey, apiPrivateKey: cfg.apiPrivateKey,
      apiPrivateKeyFile: cfg.apiPrivateKeyFile,
      goodTilDays: cfg.goodTilDays, feeRate: cfg.feeRate,
    });
  }
  return new PaperExchange({
    network: cfg.network, apiUrl: cfg.apiUrl,
    startBalance: cfg.startBalance, feeRate: cfg.feeRate,
  });
}
