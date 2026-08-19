import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const report = (target, type) => failures.push({ target: path.relative(ROOT, target) || '.', type });

const forbiddenPaths = [
  '.env', '.state.json', 'secrets', 'node_modules', '.runtime', '.lighter-venv', '.codex-backups',
];
for (const relative of forbiddenPaths) {
  const target = path.join(ROOT, relative);
  if (fs.existsSync(target)) report(target, '不应进入源码发布包的本地文件/目录');
}

const forbiddenExtensions = new Set(['.log', '.pem', '.key', '.p12', '.pfx', '.pyc', '.bak']);
const textPatterns = [
  ['PEM 私钥头', /-----BEGIN [^-\r\n]*PRIVATE\s+KEY-----/],
  ['OpenAI 风格高风险 token', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Telegram Bot token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (forbiddenExtensions.has(extension)) report(full, `禁止的敏感/运行文件扩展名 ${extension}`);
    const stat = fs.statSync(full);
    if (stat.size > 5 * 1024 * 1024) continue;
    let content;
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    for (const [name, pattern] of textPatterns) {
      if (pattern.test(content)) report(full, name);
    }
  }
}
walk(ROOT);

const exampleFile = path.join(ROOT, '.env.example');
if (!fs.existsSync(exampleFile)) {
  report(exampleFile, '缺少安全配置模板');
} else {
  const env = new Map();
  for (const line of fs.readFileSync(exampleFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match) env.set(match[1], match[2].trim());
  }
  for (const key of ['DE_MODE', 'EX_MODE', 'RS_MODE', 'AR_MODE', 'LR_MODE']) {
    if (env.get(key) !== 'paper') report(exampleFile, `${key} 必须保持 paper`);
  }
  const mustBeEmpty = [
    'GLOBAL_PROXY', 'DECIBEL_PROXY', 'EXTENDED_PROXY', 'RISEX_PROXY', 'ARCUS_PROXY', 'LIGHTER_PROXY',
    'DECIBEL_API_KEY', 'DECIBEL_PRIVATE_KEY', 'DECIBEL_SUBACCOUNT', 'DECIBEL_API_URL',
    'EXTENDED_API_KEY', 'EXTENDED_VAULT', 'EXTENDED_STARK_PRIVATE_KEY', 'EXTENDED_STARK_PUBLIC_KEY', 'EXTENDED_API_URL',
    'ACCOUNT_ADDRESS', 'SIGNER_PRIVATE_KEY', 'RISEX_API_URL', 'RISEX_WS_URL',
    'ARCUS_ADDRESS', 'ARCUS_API_KEY', 'ARCUS_API_PRIVATE_KEY', 'ARCUS_API_PRIVATE_KEY_FILE', 'ARCUS_API_URL', 'ARCUS_WS_URL',
    'LIGHTER_ACCOUNT_INDEX', 'LIGHTER_API_KEY_INDEX', 'LIGHTER_API_PRIVATE_KEY', 'LIGHTER_API_PRIVATE_KEY_FILE', 'LIGHTER_PYTHON',
    'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_MODEL_SMALL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'NOTIFY_WEBHOOK',
  ];
  for (const key of mustBeEmpty) {
    if ((env.get(key) || '').length > 0) report(exampleFile, `${key} 模板值必须为空`);
  }
}

const unique = [...new Map(failures.map((item) => [`${item.target}\0${item.type}`, item])).values()];
if (unique.length) {
  console.error(`发布审计失败：发现 ${unique.length} 项。`);
  for (const item of unique) console.error(`  ${item.target}: ${item.type}`);
  process.exitCode = 1;
} else {
  console.log('发布审计通过：未发现本地凭据、运行状态、缓存、备份、日志或常见真实 token；.env.example 为全 PAPER 空凭据模板。');
}
