import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

loadEnv();

const value = (key) => String(process.env[key] ?? '').trim();
const required = (keys, label) => {
  const missing = keys.filter((key) => !value(key));
  if (missing.length) errors.push(`${label} 缺少：${missing.join(', ')}`);
};
const mode = (key) => {
  const current = (value(key) || 'paper').toLowerCase();
  if (!['paper', 'live'].includes(current)) errors.push(`${key} 只能是 paper 或 live，当前为 ${current || '<空>'}`);
  return current;
};
const modeAlias = (primary, fallback) => {
  const current = (value(primary) || value(fallback) || 'paper').toLowerCase();
  if (!['paper', 'live'].includes(current)) errors.push(`${primary}/${fallback} 只能是 paper 或 live，当前为 ${current || '<空>'}`);
  return current;
};
const network = (key, { mainnetOnly = false } = {}) => {
  const current = (value(key) || 'mainnet').toLowerCase();
  if (mainnetOnly && current !== 'mainnet') errors.push(`${key} 当前接入只支持 mainnet。`);
  else if (!mainnetOnly && !['mainnet', 'testnet'].includes(current)) errors.push(`${key} 只能是 mainnet 或 testnet。`);
};
const integer = (key, min, max) => {
  const current = Number(value(key));
  if (!Number.isInteger(current) || current < min || current > max) errors.push(`${key} 必须是 ${min}-${max} 的整数。`);
};
const validUrlIfSet = (key, protocols = ['http:', 'https:']) => {
  const current = value(key);
  if (!current) return;
  try {
    const parsed = new URL(current);
    if (!protocols.includes(parsed.protocol)) throw new Error('protocol');
  } catch {
    errors.push(`${key} 不是有效地址；应以 ${protocols.join(' 或 ')} 开头。`);
  }
};

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 20) errors.push(`Node.js 必须为 20 或更高版本，当前是 ${process.versions.node}。`);

const port = Number(value('PORT') || 8283);
if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('PORT 必须是 1-65535 的整数。');
const balance = Number(value('PAPER_BALANCE') || 10000);
if (!Number.isFinite(balance) || balance <= 0) errors.push('PAPER_BALANCE 必须是大于 0 的数字。');

const host = value('HOST') || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  warnings.push(`HOST=${host} 不是纯本机监听地址；仪表盘没有登录鉴权，请勿直接暴露到公网。`);
}

const modes = {
  de: mode('DE_MODE'),
  ex: mode('EX_MODE'),
  rs: mode('RS_MODE'),
  ar: mode('AR_MODE'),
  lr: mode('LR_MODE'),
  n1: mode('N1_MODE'),
  ph: mode('PH_MODE'),
  ph2: mode('PH2_MODE'),
  na: modeAlias('NADO_MODE', 'NA_MODE'),
  pd: modeAlias('POPDEX_MODE', 'PD_MODE'),
};
network('DE_NETWORK');
network('EX_NETWORK');
network('RS_NETWORK');
network('AR_NETWORK');
network('LR_NETWORK', { mainnetOnly: true });

if (modes.de === 'live') {
  required(['DECIBEL_API_KEY', 'DECIBEL_PRIVATE_KEY', 'DECIBEL_SUBACCOUNT'], 'Decibel LIVE');
}
if (modes.ex === 'live') {
  required(['EXTENDED_API_KEY', 'EXTENDED_VAULT', 'EXTENDED_STARK_PRIVATE_KEY'], 'Extended LIVE');
  const vault = value('EXTENDED_VAULT');
  if (vault && (!/^\d+$/.test(vault) || Number(vault) <= 0)) errors.push('EXTENDED_VAULT 必须是大于 0 的整数。');
  for (const key of ['EXTENDED_STARK_PRIVATE_KEY', 'EXTENDED_STARK_PUBLIC_KEY']) {
    const current = value(key);
    if (current) {
      try { BigInt(current); } catch { errors.push(`${key} 必须是可解析的十进制或 0x 十六进制整数。`); }
    }
  }
}
if (modes.rs === 'live') {
  required(['ACCOUNT_ADDRESS', 'SIGNER_PRIVATE_KEY'], 'RISEx LIVE');
  if (value('ACCOUNT_ADDRESS') && !/^0x[0-9a-f]{40}$/i.test(value('ACCOUNT_ADDRESS'))) errors.push('ACCOUNT_ADDRESS 应为 0x + 40 位十六进制钱包公开地址。');
  if (value('SIGNER_PRIVATE_KEY') && !/^0x[0-9a-f]{64}$/i.test(value('SIGNER_PRIVATE_KEY'))) errors.push('SIGNER_PRIVATE_KEY 应为 0x + 64 位十六进制 session signer 私钥。');
}
if (modes.ar === 'live') {
  required(['ARCUS_ADDRESS', 'ARCUS_API_KEY'], 'Arcus LIVE');
  if (!value('ARCUS_API_PRIVATE_KEY') && !value('ARCUS_API_PRIVATE_KEY_FILE')) errors.push('Arcus LIVE 需要 ARCUS_API_PRIVATE_KEY 或 ARCUS_API_PRIVATE_KEY_FILE（二选一）。');
  if (value('ARCUS_ADDRESS') && !/^0x[0-9a-f]{40}$/i.test(value('ARCUS_ADDRESS'))) errors.push('ARCUS_ADDRESS 应为 0x + 40 位十六进制公开地址。');
  if (value('ARCUS_API_KEY') && !/^(?:0x)?[0-9a-f]{64}$/i.test(value('ARCUS_API_KEY'))) errors.push('ARCUS_API_KEY 应为 64 位十六进制 Ed25519 公钥。');
  integer('ARCUS_ACCOUNT_INDEX', 0, 9);
}
if (modes.lr === 'live') {
  required(['LIGHTER_ACCOUNT_INDEX', 'LIGHTER_API_KEY_INDEX'], 'RHC Lighter LIVE');
  if (!value('LIGHTER_API_PRIVATE_KEY') && !value('LIGHTER_API_PRIVATE_KEY_FILE')) errors.push('RHC Lighter LIVE 需要 LIGHTER_API_PRIVATE_KEY 或 LIGHTER_API_PRIVATE_KEY_FILE（二选一）。');
  const accountIndex = Number(value('LIGHTER_ACCOUNT_INDEX'));
  if (!Number.isInteger(accountIndex) || accountIndex < 0) errors.push('LIGHTER_ACCOUNT_INDEX 必须是非负整数。');
  integer('LIGHTER_API_KEY_INDEX', 4, 254);
}
if (modes.n1 === 'live') {
  required(['N1_KEYPAIR_PATH'], 'N1 LIVE');
  if (value('N1_TRADING_ARMED').toUpperCase() !== 'YES') warnings.push('N1 LIVE 尚未设置 N1_TRADING_ARMED=YES，适配器将保持只读，无法提交真实订单。');
}
if (modes.ph === 'live') {
  if (!value('PHOENIX_PRIVATE_KEY') && !value('PHOENIX_KEYPAIR_PATH')) errors.push('Phoenix LIVE 需要 PHOENIX_PRIVATE_KEY 或 PHOENIX_KEYPAIR_PATH（二选一）。');
}
if (modes.ph2 === 'live') {
  if (!value('PHOENIX2_PRIVATE_KEY') && !value('PHOENIX2_KEYPAIR_PATH')) errors.push('Phoenix2 LIVE 需要 PHOENIX2_PRIVATE_KEY 或 PHOENIX2_KEYPAIR_PATH（二选一）。');
}
if (modes.na === 'live') {
  if (!value('NADO_PRIVATE_KEY') && !value('NADO_KEY_PATH') && !fs.existsSync(path.join(ROOT, 'secrets', 'nado.key'))) errors.push('Nado LIVE 需要 NADO_PRIVATE_KEY、NADO_KEY_PATH，或默认文件 secrets/nado.key。');
  if (value('NADO_NETWORK') && !['ink-mainnet', 'ink-testnet'].includes(value('NADO_NETWORK').toLowerCase())) errors.push('NADO_NETWORK 只能是 ink-mainnet 或 ink-testnet。');
}
if (modes.pd === 'live') {
  if (!value('POPDEX_PRIVATE_KEY') && !value('POPDEX_KEY_PATH') && !fs.existsSync(path.join(ROOT, 'secrets', 'popdex.key'))) errors.push('PopDEX LIVE 需要 POPDEX_PRIVATE_KEY、POPDEX_KEY_PATH，或默认文件 secrets/popdex.key。');
}
if (value('POPDEX_NETWORK') && value('POPDEX_NETWORK').toLowerCase() !== 'mainnet') {
  errors.push('POPDEX_NETWORK 当前接入只支持 mainnet。');
}

for (const key of ['DECIBEL_API_URL', 'EXTENDED_API_URL', 'RISEX_API_URL', 'ARCUS_API_URL', 'N1_API_URL', 'PHOENIX_API_URL', 'PHOENIX2_API_URL', 'NADO_RPC_URL', 'POPDEX_API_URL', 'AI_BASE_URL', 'NOTIFY_WEBHOOK']) validUrlIfSet(key);
for (const key of ['N1_SOLANA_RPC', 'PHOENIX_RPC_URL', 'PHOENIX2_RPC_URL']) validUrlIfSet(key);
for (const key of ['RISEX_WS_URL', 'ARCUS_WS_URL']) validUrlIfSet(key, ['ws:', 'wss:']);

for (const key of ['ARCUS_API_PRIVATE_KEY_FILE', 'LIGHTER_API_PRIVATE_KEY_FILE', 'N1_KEYPAIR_PATH', 'PHOENIX_KEYPAIR_PATH', 'PHOENIX2_KEYPAIR_PATH', 'NADO_KEY_PATH', 'POPDEX_KEY_PATH']) {
  const configured = value(key);
  if (!configured) continue;
  if (['N1_KEYPAIR_PATH', 'PHOENIX_KEYPAIR_PATH', 'PHOENIX2_KEYPAIR_PATH', 'NADO_KEY_PATH', 'POPDEX_KEY_PATH'].includes(key)
    && !['live'].includes(modes[{ N1_KEYPAIR_PATH: 'n1', PHOENIX_KEYPAIR_PATH: 'ph', PHOENIX2_KEYPAIR_PATH: 'ph2', NADO_KEY_PATH: 'na', POPDEX_KEY_PATH: 'pd' }[key]])) continue;
  const resolved = path.resolve(ROOT, configured);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) errors.push(`${key} 指向的文件不存在：${configured}`);
}

const liveNames = Object.entries(modes).filter(([, current]) => current === 'live').map(([key]) => key.toUpperCase());
console.log('配置预检（不会连接交易所，也不会输出任何密钥）');
console.log(`  服务地址: http://${host}:${port}`);
console.log(`  模式: DE=${modes.de.toUpperCase()}  EX=${modes.ex.toUpperCase()}  RS=${modes.rs.toUpperCase()}  AR=${modes.ar.toUpperCase()}  LR=${modes.lr.toUpperCase()}  N1=${modes.n1.toUpperCase()}  PH=${modes.ph.toUpperCase()}  PH2=${modes.ph2.toUpperCase()}  NA=${modes.na.toUpperCase()}  PD=${modes.pd.toUpperCase()}`);
if (liveNames.length) warnings.push(`已启用真实交易：${liveNames.join(', ')}。启动后请先核对账户、网络、市场和余额，再点击“启动网格”。`);

for (const warning of warnings) console.warn(`  [警告] ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`  [错误] ${error}`);
  console.error(`预检失败：共 ${errors.length} 个问题。请修改 .env 后重试。`);
  process.exitCode = 1;
} else {
  console.log('  [通过] 配置格式检查完成。');
}
