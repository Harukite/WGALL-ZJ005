// 十交易所整合配置加载器
// 支持全局代理（GLOBAL_PROXY）+ 各交易所独立代理覆盖
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function optionalNumber(name) {
  const raw = process.env[name];
  return raw == null || String(raw).trim() === '' ? Number.NaN : Number(raw);
}

export function loadEnv() {
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        const q = v.match(/^"([^"]*)"|^'([^']*)'/); // quoted: take the quoted content
        if (q) v = q[1] ?? q[2];
        else v = v.replace(/\s+#.*$/, '').trim();   // unquoted: strip inline comments
        process.env[m[1]] = v;
      }
    }
  }
}

export function getConfig() {
  loadEnv();

  // 全局代理：作为所有交易所的默认代理
  const globalProxy =
    process.env.GLOBAL_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    '';

  // ── Decibel ──────────────────────────────────────────────────────────────
  const deNet = (process.env.DE_NETWORK || 'mainnet').toLowerCase();
  const deDefaults =
    deNet === 'testnet'
      ? { api: 'https://api.testnet.aptoslabs.com/decibel' }
      : { api: 'https://api.mainnet.aptoslabs.com/decibel' };

  const de = {
    mode: (process.env.DE_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: deNet,
    apiKey: process.env.DECIBEL_API_KEY || '',
    privateKey: process.env.DECIBEL_PRIVATE_KEY || '',
    subaccount: process.env.DECIBEL_SUBACCOUNT || '',
    apiUrl: (process.env.DECIBEL_API_URL || deDefaults.api).replace(/\/$/, ''),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.DECIBEL_PROXY || globalProxy,
  };

  // ── Extended ──────────────────────────────────────────────────────────────
  const exNet = (process.env.EX_NETWORK || 'mainnet').toLowerCase();
  const exDefaults =
    exNet === 'testnet'
      ? { api: 'https://api.starknet.sepolia.extended.exchange' }
      : { api: 'https://api.starknet.extended.exchange' };

  const ex = {
    mode: (process.env.EX_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: exNet,
    apiKey: process.env.EXTENDED_API_KEY || '',
    vault: process.env.EXTENDED_VAULT || '',
    starkPrivateKey: process.env.EXTENDED_STARK_PRIVATE_KEY || '',
    starkPublicKey: process.env.EXTENDED_STARK_PUBLIC_KEY || '',
    feeRate: process.env.EXTENDED_MAX_FEE || '0.0005',
    apiUrl: (process.env.EXTENDED_API_URL || exDefaults.api).replace(/\/$/, ''),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.EXTENDED_PROXY || globalProxy,
  };

  // ── RISEx ─────────────────────────────────────────────────────────────────
  const rsNet = (process.env.RS_NETWORK || 'mainnet').toLowerCase();
  const rsDefaults =
    rsNet === 'testnet'
      ? { api: 'https://api.testnet.rise.trade', ws: 'wss://ws.testnet.rise.trade' }
      : { api: 'https://api.rise.trade', ws: 'wss://api.rise.trade/ws/' };

  const rs = {
    mode: (process.env.RS_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: rsNet,
    account: process.env.ACCOUNT_ADDRESS || '',
    signerKey: process.env.SIGNER_PRIVATE_KEY || '',
    apiUrl: process.env.RISEX_API_URL || rsDefaults.api,
    wsUrl: process.env.RISEX_WS_URL || rsDefaults.ws,
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.RISEX_PROXY || globalProxy,
  };

  // ── Arcus ─────────────────────────────────────────────────────────────────
  const arNet = (process.env.AR_NETWORK || 'mainnet').toLowerCase() === 'testnet' ? 'testnet' : 'mainnet';
  const arDefaults = arNet === 'testnet'
    ? { api: 'https://api.testnet.arcus.xyz', ws: 'wss://api.testnet.arcus.xyz/v1/ws' }
    : { api: 'https://api.arcus.xyz', ws: 'wss://api.arcus.xyz/v1/ws' };

  const ar = {
    mode: (process.env.AR_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: arNet,
    address: process.env.ARCUS_ADDRESS || '',
    accountIndex: Math.max(0, Math.min(9, Number(process.env.ARCUS_ACCOUNT_INDEX || 0))),
    apiKey: process.env.ARCUS_API_KEY || '',
    apiPrivateKey: process.env.ARCUS_API_PRIVATE_KEY || '',
    apiPrivateKeyFile: process.env.ARCUS_API_PRIVATE_KEY_FILE || '',
    apiUrl: (process.env.ARCUS_API_URL || arDefaults.api).replace(/\/$/, ''),
    wsUrl: process.env.ARCUS_WS_URL || arDefaults.ws,
    goodTilDays: Math.max(32, Math.min(180, Number(process.env.ARCUS_GOOD_TIL_DAYS || 40))),
    feeRate: Number(process.env.ARCUS_FEE_RATE || 0.0005),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.ARCUS_PROXY || globalProxy,
  };

  // ── Robinhood Chain Lighter (RHC) ────────────────────────────────────────
  // This integration is intentionally pinned to the official RHC mainnet
  // endpoint/profile.  It never accepts an ETH wallet private key and exposes
  // no withdrawal/transfer operation.
  const lr = {
    mode: (process.env.LR_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: 'mainnet',
    apiUrl: 'https://api.rh.lighter.xyz',
    wsUrl: 'wss://api.rh.lighter.xyz/stream',
    chainId: 466324,
    accountIndex: optionalNumber('LIGHTER_ACCOUNT_INDEX'),
    apiKeyIndex: optionalNumber('LIGHTER_API_KEY_INDEX'),
    apiPrivateKey: process.env.LIGHTER_API_PRIVATE_KEY || '',
    apiPrivateKeyFile: process.env.LIGHTER_API_PRIVATE_KEY_FILE || '',
    pythonPath: process.env.LIGHTER_PYTHON || '',
    feeRate: Number(process.env.LIGHTER_FEE_RATE || 0.0005),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.LIGHTER_PROXY || globalProxy,
  };

  // ── N1 ────────────────────────────────────────────────────────────────────
  const n1 = {
    mode: (process.env.N1_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: 'mainnet',
    keypairPath: process.env.N1_KEYPAIR_PATH || path.join(root, 'secrets', 'id.json'),
    appPublicKey: process.env.N1_APP_PUBLIC_KEY || '',
    apiUrl: (process.env.N1_API_URL || 'https://zo-mainnet.n1.xyz').replace(/\/$/, ''),
    solanaRpc: process.env.N1_SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
    tradingArmed: String(process.env.N1_TRADING_ARMED || '').toUpperCase() === 'YES',
    feeRate: Number(process.env.N1_FEE_RATE || 0.0005),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.N1_PROXY || globalProxy,
  };

  // ── Phoenix / Phoenix2 ───────────────────────────────────────────────────
  const phoenixDefaults = {
    api: 'https://perp-api.phoenix.trade',
    rpc: 'https://api.mainnet-beta.solana.com',
  };
  const ph = {
    mode: (process.env.PH_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: 'mainnet',
    privateKey: process.env.PHOENIX_PRIVATE_KEY || '',
    keypairPath: process.env.PHOENIX_KEYPAIR_PATH || path.join(root, 'secrets', 'phoenix.key'),
    apiUrl: (process.env.PHOENIX_API_URL || phoenixDefaults.api).replace(/\/$/, ''),
    rpcUrl: process.env.PHOENIX_RPC_URL || phoenixDefaults.rpc,
    symbol: process.env.PHOENIX_SYMBOL || '',
    computeUnitLimit: Number(process.env.PHOENIX_COMPUTE_UNIT_LIMIT || 600000),
    orderGapMs: Number(process.env.PHOENIX_ORDER_GAP_MS || 800),
    feeRate: Number(process.env.PHOENIX_FEE_RATE || 0.0005),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.PHOENIX_PROXY || globalProxy,
  };
  const ph2 = {
    mode: (process.env.PH2_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: 'mainnet',
    privateKey: process.env.PHOENIX2_PRIVATE_KEY || '',
    keypairPath: process.env.PHOENIX2_KEYPAIR_PATH || path.join(root, 'secrets', 'phoenix2.key'),
    apiUrl: (process.env.PHOENIX2_API_URL || process.env.PHOENIX_API_URL || phoenixDefaults.api).replace(/\/$/, ''),
    rpcUrl: process.env.PHOENIX2_RPC_URL || process.env.PHOENIX_RPC_URL || phoenixDefaults.rpc,
    symbol: process.env.PHOENIX2_SYMBOL || '',
    computeUnitLimit: Number(process.env.PHOENIX2_COMPUTE_UNIT_LIMIT || process.env.PHOENIX_COMPUTE_UNIT_LIMIT || 600000),
    orderGapMs: Number(process.env.PHOENIX2_ORDER_GAP_MS || process.env.PHOENIX_ORDER_GAP_MS || 800),
    feeRate: Number(process.env.PHOENIX2_FEE_RATE || process.env.PHOENIX_FEE_RATE || 0.0005),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.PHOENIX2_PROXY || process.env.PHOENIX_PROXY || globalProxy,
  };

  // ── Nado ──────────────────────────────────────────────────────────────────
  const na = {
    mode: (process.env.NADO_MODE || process.env.NA_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: process.env.NADO_NETWORK || 'ink-mainnet',
    privateKey: process.env.NADO_PRIVATE_KEY || '',
    keyPath: process.env.NADO_KEY_PATH || '',
    subaccount: process.env.NADO_SUBACCOUNT || '',
    productId: Number(process.env.NADO_PRODUCT_ID || 2),
    rpcUrl: process.env.NADO_RPC_URL || '',
    feeRate: Number(process.env.NADO_FEE_RATE || 0.0005),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.NADO_PROXY || globalProxy,
  };

  // ── PopDEX ────────────────────────────────────────────────────────────────
  const pd = {
    mode: (process.env.POPDEX_MODE || process.env.PD_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: process.env.POPDEX_NETWORK || 'mainnet',
    privateKey: process.env.POPDEX_PRIVATE_KEY || '',
    keyPath: process.env.POPDEX_KEY_PATH || '',
    symbol: process.env.POPDEX_SYMBOL || 'BTCUSDT',
    apiUrl: (process.env.POPDEX_API_URL || 'https://api.popdex.xyz').replace(/\/$/, ''),
    orderGapMs: Number(process.env.POPDEX_ORDER_GAP_MS || 800),
    feeRate: Number(process.env.POPDEX_FEE_RATE || 0.0005),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.POPDEX_PROXY || globalProxy,
  };

  return {
    port: Number(process.env.PORT || 8283),
    // SECURITY: bind to loopback by default so the dashboard (which can start/stop
    // LIVE trading and edit .env) is NOT exposed to the local network. Set
    // HOST=0.0.0.0 explicitly only if you understand the risk and add your own auth.
    host: process.env.HOST || '127.0.0.1',
    globalProxy,
    de,
    ex,
    rs,
    ar,
    lr,
    n1,
    ph,
    ph2,
    na,
    pd,
  };
}

export const ROOT = root;
