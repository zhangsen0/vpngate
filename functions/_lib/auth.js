/**
 * auth.js — 登录认证（基于签名 Cookie 的无状态会话）
 *
 * 密码来源（配置变量，代码不写死）：
 *  1. Pages 环境变量 APP_PASSWORD（生产/测试均可，推荐在 CF 控制台或 API 配置）；
 *  2. 兜底：无 APP_PASSWORD 时拒绝所有登录（提示未配置密码），避免默认口令风险。
 *
 * 会话：HMAC-SHA256 签名令牌（payload=base64url{u, e}），存于 HttpOnly Cookie，
 *       无服务端会话存储，TTL 默认 7 天（可用环境变量 SESSION_TTL_DAYS 调整）。
 */

const COOKIE_NAME = 'vg_sess';
const DEFAULT_TTL_DAYS = 7;

/** 获取签名密钥（未配置密码时返回空串，配合 isAuthed 恒拒绝） */
function signingKey(env) {
  return (env && (env.APP_PASSWORD || '')) || '';
}

// ==================== 免登录文件链接令牌（短期） ====================
// 用于 .ovpn 等下载链接：外部客户端（OpenVPN Connect 等）无登录 Cookie，
// 携带签名令牌即可在有效期内直接下载。令牌绑定 id 与过期时间，防篡改/防重放。

/** 签发文件访问令牌：payload = {id, e}，签名 = HMAC(payload) */
export async function signFileToken(env, id, ttlMs) {
  const key = signingKey(env);
  if (!key || !id) return null;
  const payload = b64urlEncode(JSON.stringify({ id, e: Date.now() + ttlMs }));
  const sig = await hmacHex(key, payload);
  return `${payload}.${sig}`;
}

/** 校验文件访问令牌：签名有效、未过期、id 匹配 */
export async function verifyFileToken(env, token, id) {
  if (!token || !id) return false;
  const key = signingKey(env);
  if (!key) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = await hmacHex(key, payload);
  if (expected !== sig) return false;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    return data.id === id && typeof data.e === 'number' && data.e > Date.now();
  } catch {
    return false;
  }
}

/** 从请求 Cookie 中取出会话令牌 */
export function getCookie(request) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** 是否已登录（校验签名与有效期） */
export function isAuthed(request, env) {
  const token = getCookie(request);
  if (!token) return false;
  const key = signingKey(env);
  if (!key) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  return verifySig(key, payload, sig);
}

/**
 * 校验 payload 签名且未过期。
 * @returns {boolean}
 */
async function verifySig(key, payload, sig) {
  try {
    const expected = await hmacHex(key, payload);
    if (expected !== sig) return false;
    const data = JSON.parse(b64urlDecode(payload));
    return typeof data.e === 'number' && data.e > Date.now();
  } catch {
    return false;
  }
}

/** 签发会话令牌（当前用户 + 过期时间） */
export async function issueToken(env) {
  const key = signingKey(env);
  if (!key) return null;
  const ttlDays = Number.parseInt(env.SESSION_TTL_DAYS, 10) || DEFAULT_TTL_DAYS;
  const payload = b64urlEncode(JSON.stringify({ u: 'admin', e: Date.now() + ttlDays * 86400000 }));
  const sig = await hmacHex(key, payload);
  return `${payload}.${sig}`;
}

/** 生成设置 Cookie 的响应头 */
export function authCookieHeaders(env, token) {
  const secure = '; Secure';
  return {
    'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=604800`,
  };
}

/** 生成清除 Cookie 的响应头 */
export function clearCookieHeaders() {
  return {
    'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  };
}

// ==================== 底层工具 ====================

async function hmacHex(key, data) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 常量时间比较（防时序攻击） */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ==================== 登录防爆破（内存级，尽力而为） ====================
// 默认：同一 IP 连续 5 次失败锁定 10 分钟；可用环境变量 LOGIN_MAX_FAIL / LOGIN_LOCK_MIN 调整。

const failMap = new Map(); // ip → { count, resetAt }

/**
 * 检查登录锁定状态。
 * @param {object} env - 环境对象
 * @param {string} ip - 客户端 IP
 * @returns {{locked: boolean, retryAfter?: number}}
 */
export function checkLoginLock(env, ip) {
  const maxFail = Number.parseInt(env && env.LOGIN_MAX_FAIL, 10) || 5;
  const rec = failMap.get(ip);
  if (!rec) return { locked: false };
  if (Date.now() > rec.resetAt) {
    failMap.delete(ip);
    return { locked: false };
  }
  if (rec.count >= maxFail) {
    return { locked: true, retryAfter: Math.max(1, Math.ceil((rec.resetAt - Date.now()) / 1000)) };
  }
  return { locked: false };
}

/** 记录一次登录失败 */
export function recordLoginFail(env, ip) {
  const maxFail = Number.parseInt(env && env.LOGIN_MAX_FAIL, 10) || 5;
  const lockMs = (Number.parseInt(env && env.LOGIN_LOCK_MIN, 10) || 10) * 60 * 1000;
  const now = Date.now();
  const rec = failMap.get(ip);
  if (!rec || now > rec.resetAt) {
    failMap.set(ip, { count: 1, resetAt: now + lockMs });
    return;
  }
  rec.count = Math.min(rec.count + 1, maxFail + 99);
}

/** 登录成功后清除锁定 */
export function clearLoginLock(ip) {
  failMap.delete(ip);
}

function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b64)));
}
