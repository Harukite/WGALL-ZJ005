import fs from 'node:fs';
import { createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';

const RAW_ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
let lastTimestampNs = 0n;

/** Stable JSON used by Arcus legacy signatures. BigInts stay JSON numbers. */
export function canonicalJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Arcus 签名内容包含非有限数字。');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v ?? null)).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  throw new Error('Arcus 签名内容包含不支持的类型。');
}

/** Nanosecond Unix timestamp, guaranteed monotonic inside this process. */
export function timestampNs() {
  const coarse = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
  lastTimestampNs = coarse > lastTimestampNs ? coarse : lastTimestampNs + 1n;
  return lastTimestampNs;
}

export function futureGoodTilUs(days = 40) {
  const safeDays = Math.max(32, Math.min(180, Number(days) || 40));
  return BigInt(Date.now() + safeDays * 86_400_000) * 1000n;
}

function decimalFraction(value) {
  const raw = String(value).trim();
  const m = raw.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m || (!m[2] && !m[3])) throw new Error(`无效十进制数字: ${raw}`);
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = m[2] || '0';
  const frac = m[3] || '';
  const exp = Number(m[4] || 0);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 100) throw new Error(`十进制指数超出范围: ${raw}`);
  const digits = (whole + frac).replace(/^0+(?=\d)/, '') || '0';
  let scale = frac.length - exp;
  let n = BigInt(digits) * sign;
  if (scale < 0) { n *= 10n ** BigInt(-scale); scale = 0; }
  return { n, scale };
}

function pow10(n) { return 10n ** BigInt(n); }

function commonIntegers(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.n * pow10(scale - a.scale),
    b: b.n * pow10(scale - b.scale),
    scale,
  };
}

function divFloor(a, b) {
  let q = a / b;
  const r = a % b;
  if (r !== 0n && ((r > 0n) !== (b > 0n))) q -= 1n;
  return q;
}

function formatScaled(n, scale) {
  const neg = n < 0n;
  let digits = (neg ? -n : n).toString();
  if (scale === 0) return (neg ? '-' : '') + digits;
  if (digits.length <= scale) digits = digits.padStart(scale + 1, '0');
  const out = digits.slice(0, -scale) + '.' + digits.slice(-scale);
  const trimmed = out.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return (neg ? '-' : '') + trimmed;
}

/** Align a decimal to an exact decimal step without binary floating-point math. */
export function alignDecimal(value, step, mode = 'nearest') {
  const v = decimalFraction(value);
  const u = decimalFraction(step);
  if (u.n <= 0n) throw new Error(`无效步长: ${step}`);
  const x = commonIntegers(v, u);
  let q = divFloor(x.a, x.b);
  const rem = x.a - q * x.b;
  if (mode === 'up' && rem !== 0n) q += 1n;
  else if (mode === 'nearest' && rem * 2n >= x.b) q += 1n;
  const unitAtScale = u.n * pow10(x.scale - u.scale);
  return formatScaled(q * unitAtScale, x.scale);
}

/** Exact decimal division used for signed tick/quantum integers. */
export function toUnitsExact(value, unit) {
  const v = decimalFraction(value);
  const u = decimalFraction(unit);
  if (u.n <= 0n) throw new Error(`无效单位: ${unit}`);
  const x = commonIntegers(v, u);
  if (x.a % x.b !== 0n) throw new Error(`${value} 不是 ${unit} 的整数倍。`);
  return x.a / x.b;
}

export function chooseTick(market, price) {
  const px = Number(price);
  const tiers = Array.isArray(market?.tickTiers) ? market.tickTiers : [];
  for (const tier of tiers) {
    if (tier?.upToPrice == null || px <= Number(tier.upToPrice)) return String(tier.tick ?? market.tickSize);
  }
  return String(market?.tickSize || '0.01');
}

export function buildPlacePayload({ address, accountIndex, clientId, timestamp, goodTilTimeUs, marketId, priceTicks, quantityQuantums, reduceOnly, side, timeInForce }) {
  const c = clientId ? `,"c":${JSON.stringify(String(clientId).toLowerCase())}` : '';
  return `{"ad":${JSON.stringify(String(address).toLowerCase())},"ai":${Number(accountIndex)}${c},"ct":${BigInt(timestamp)},"g":${BigInt(goodTilTimeUs) * 1000n},"m":${Number(marketId)},"op":1,"p":${BigInt(priceTicks)},"q":${BigInt(quantityQuantums)},"r":${reduceOnly ? 1 : 0},"s":${String(side).toUpperCase() === 'SELL' ? 1 : 0},"t":${timeInForceCode(timeInForce)},"v":1}`;
}

export function buildCancelPayload({ address, accountIndex, clientId, timestamp, orderId, marketId }) {
  const c = clientId ? `,"c":${JSON.stringify(String(clientId).toLowerCase())}` : '';
  const id = orderId ? `,"id":${JSON.stringify(String(orderId))}` : '';
  if ((c && id) || (!c && !id)) throw new Error('Arcus 撤单必须且只能指定 orderId 或 clientId。');
  return `{"ad":${JSON.stringify(String(address).toLowerCase())},"ai":${Number(accountIndex)}${c},"ct":${BigInt(timestamp)}${id},"m":${Number(marketId)},"op":2,"v":1}`;
}

function timeInForceCode(value) {
  const map = { GTT: 0, FOK: 1, IOC: 2, ALO: 3 };
  const code = map[String(value || 'GTT').toUpperCase()];
  if (code == null) throw new Error('Arcus 不支持的 timeInForce: ' + value);
  return code;
}

export function loadEd25519PrivateKey({ value, file } = {}) {
  let raw = String(value || '').trim();
  if (file) raw = fs.readFileSync(String(file), 'utf8').trim();
  if (!raw) throw new Error('缺少 Arcus Ed25519 API 私钥。');
  raw = raw.replace(/\\n/g, '\n');
  try {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw)) return createPrivateKey(raw);
    const clean = raw.replace(/^0x/i, '').replace(/\s+/g, '');
    if (/^[0-9a-f]{64}$/i.test(clean)) {
      return createPrivateKey({ key: Buffer.concat([RAW_ED25519_PKCS8_PREFIX, Buffer.from(clean, 'hex')]), format: 'der', type: 'pkcs8' });
    }
    if (/^[0-9a-f]+$/i.test(clean) && clean.length % 2 === 0) {
      return createPrivateKey({ key: Buffer.from(clean, 'hex'), format: 'der', type: 'pkcs8' });
    }
    return createPrivateKey({ key: Buffer.from(clean, 'base64'), format: 'der', type: 'pkcs8' });
  } catch (e) {
    throw new Error('Arcus Ed25519 API 私钥格式无效：支持 64 位 seed hex、PKCS#8 PEM/DER(hex/base64) 或私钥文件。', { cause: e });
  }
}

export function publicKeyHex(privateKey) {
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return Buffer.from(der).subarray(-32).toString('hex');
}

export function signHex(message, privateKey) {
  return cryptoSign(null, Buffer.from(String(message), 'utf8'), privateKey).toString('hex');
}

export function legacySignature({ timestamp, action, body, privateKey }) {
  return signHex(String(timestamp) + String(action) + canonicalJson(body), privateKey);
}
