// Single-account authentication for the dashboard.
// Passwords are verified against a scrypt hash; plaintext passwords are never
// stored, logged, or included in a URL.
import crypto from 'node:crypto';

export const DEFAULT_AUTH_EMAIL = 'jaychougo@gmail.com';

const HASH_ALGORITHM = 'scrypt';
const KEY_LENGTH = 64;
const DEFAULT_N = 16_384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const SESSION_COOKIE = 'grid_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FAILED_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 8;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url');
}

function parseHash(encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== HASH_ALGORITHM) throw new Error('密码哈希格式无效');
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || n < 16_384 || n > 1_048_576 || (n & (n - 1)) !== 0) {
    throw new Error('密码哈希成本参数无效');
  }
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 8) {
    throw new Error('密码哈希参数无效');
  }
  const salt = decode(parts[4]);
  const digest = decode(parts[5]);
  if (salt.length < 16 || digest.length !== KEY_LENGTH) throw new Error('密码哈希长度无效');
  return { n, r, p, salt, digest };
}

function derive(password, parsed) {
  return crypto.scryptSync(password, parsed.salt, KEY_LENGTH, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: Math.max(32 * 1024 * 1024, 128 * parsed.n * parsed.r + 1024),
  });
}

/** Generate a portable one-way password hash for AUTH_PASSWORD_HASH. */
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('密码至少需要 12 个字符');
  }
  const salt = crypto.randomBytes(16);
  const digest = derive(password, { n: DEFAULT_N, r: DEFAULT_R, p: DEFAULT_P, salt });
  return `${HASH_ALGORITHM}$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${encode(salt)}$${encode(digest)}`;
}

export function isPasswordHash(value) {
  try { parseHash(value); return true; } catch { return false; }
}

export function verifyPassword(password, encoded) {
  if (typeof password !== 'string') return false;
  try {
    const parsed = parseHash(encoded);
    const actual = derive(password, parsed);
    return crypto.timingSafeEqual(actual, parsed.digest);
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { cookies[name] = decodeURIComponent(value); } catch { /* ignore malformed cookies */ }
  }
  return cookies;
}

function requestAddress(req) {
  return String(req?.socket?.remoteAddress || 'unknown');
}

function cookieHeader(value, maxAge, secure) {
  return `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function createAuth({
  email = DEFAULT_AUTH_EMAIL,
  passwordHash = '',
  requireHttps = false,
  trustProxy = false,
  sessionTtlMs = SESSION_TTL_MS,
} = {}) {
  const accountEmail = normalizeEmail(email) || DEFAULT_AUTH_EMAIL;
  const configured = isPasswordHash(passwordHash);
  const sessions = new Map();
  const failures = new Map();

  function isSecureRequest(req) {
    if (trustProxy) {
      const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      if (forwarded === 'https') return true;
    }
    return !!req?.socket?.encrypted;
  }

  function purge(now = Date.now()) {
    for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
    for (const [key, attempt] of failures) if (attempt.resetAt <= now) failures.delete(key);
  }

  function session(req) {
    purge();
    const token = parseCookies(req?.headers?.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const current = sessions.get(token);
    if (!current || current.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return { ...current, token };
  }

  function status(req) {
    const current = session(req);
    return {
      authenticated: !!current,
      email: current?.email || null,
      accountEmail,
      configured,
      requireHttps,
    };
  }

  function login(req, body = {}) {
    if (requireHttps && !isSecureRequest(req)) {
      return { status: 400, body: { ok: false, error: '登录必须通过 HTTPS。' } };
    }
    if (!configured) {
      return { status: 503, body: { ok: false, error: '管理员密码尚未配置，请先设置 AUTH_PASSWORD_HASH。' } };
    }

    const now = Date.now();
    const key = requestAddress(req);
    const attempt = failures.get(key);
    if (attempt && attempt.resetAt > now && attempt.count >= MAX_FAILED_ATTEMPTS) {
      return {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((attempt.resetAt - now) / 1000)) },
        body: { ok: false, error: '登录尝试过于频繁，请稍后再试。' },
      };
    }

    const candidateEmail = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const valid = candidateEmail === accountEmail && verifyPassword(password, passwordHash);
    if (!valid) {
      const current = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + FAILED_WINDOW_MS };
      current.count += 1;
      failures.set(key, current);
      return { status: 401, body: { ok: false, error: '邮箱或密码错误。' } };
    }

    failures.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now + sessionTtlMs;
    sessions.set(token, { email: accountEmail, expiresAt });
    return {
      status: 200,
      headers: { 'Set-Cookie': cookieHeader(token, Math.floor(sessionTtlMs / 1000), requireHttps || isSecureRequest(req)) },
      body: { ok: true, email: accountEmail, expiresAt },
    };
  }

  function logout(req) {
    const current = session(req);
    if (current) sessions.delete(current.token);
    return {
      status: 200,
      headers: { 'Set-Cookie': cookieHeader('', 0, requireHttps || isSecureRequest(req)) },
      body: { ok: true },
    };
  }

  return {
    accountEmail,
    configured,
    requireHttps,
    isSecureRequest,
    isAuthenticated: (req) => !!session(req),
    status,
    login,
    logout,
  };
}
