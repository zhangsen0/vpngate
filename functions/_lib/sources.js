/**
 * sources.js — 数据源拉取、解析与缓存
 *
 * 支持的源类型：
 *  - csv：VPNGate 官方接口（http://www.vpngate.net/api/iphone/）返回的 CSV 文本；
 *  - json：auto-ovpn 镜像（[ { servers, countries }, lastUpdated ]）返回的 JSON。
 *
 * 解析结果统一归一化为轻量服务器对象，并通过 Cache API 按配置缓存。
 */

import { withTimeout, sha1Hex } from './util.js';

/** 可被序列化返回给前端的服务器字段白名单（不包含 base64 大字段） */
export const LIGHT_FIELDS = [
  'id', 'hostname', 'ip', 'countryLong', 'countryShort',
  'score', 'pingMs', 'speedBps', 'sessions', 'uptimeHours', 'logType', 'operator',
];

/** 数据源缓存命名空间前缀 */
const CACHE_PREFIX = 'https://vpngate.local/cache/';

// ==================== 拉取 ====================

/**
 * 拉取单个数据源原文（超时由调用方统一控制）。
 * @param {object} source - { id, url, type }
 * @returns {Promise<string>} 原文文本
 */
export async function fetchSource(source) {
  const res = await fetch(source.url, {
    headers: { 'User-Agent': 'vpngate-optimizer/1.0 (+https://github.com/zhangsen0/vpngate)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text || text.length < 100) throw new Error('响应体过小，疑似不可用');
  return text;
}

// ==================== 解析 ====================

/**
 * 解析 VPNGate CSV 文本。
 * 格式：首行为表头；数据行以逗号分隔；以 * 开头的行（如底部版权行）跳过。
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(',');
  const idx = (name) => header.indexOf(name);
  const iHost = idx('HostName'), iIp = idx('IP'), iScore = idx('Score'), iPing = idx('Ping'),
    iSpeed = idx('Speed'), iCountryLong = idx('CountryLong'), iCountryShort = idx('CountryShort'),
    iSessions = idx('NumVpnSessions'), iUptime = idx('Uptime'), iLog = idx('LogType'),
    iOperator = idx('Operator'), iB64 = idx('OpenVPN_ConfigData_Base64');
  if (iHost < 0 || iIp < 0 || iB64 < 0) throw new Error('CSV 表头不匹配，非 VPNGate 格式');

  const servers = [];
  for (const line of lines.slice(1)) {
    if (!line || line.startsWith('*') || line.startsWith('#') || line === '') continue;
    const f = line.split(',');
    if (f.length < iB64 + 1) continue;
    servers.push({
      hostname: f[iHost] || '',
      ip: f[iIp] || '',
      score: parseIntOf(f[iScore]),
      pingMs: parseIntOf(f[iPing]),
      speedBps: parseIntOf(f[iSpeed]),
      countryLong: f[iCountryLong] || '',
      countryShort: (f[iCountryShort] || '').toUpperCase(),
      sessions: parseIntOf(f[iSessions]),
      uptimeHours: Math.round((parseIntOf(f[iUptime]) || 0) / 3600000 * 10) / 10,
      logType: f[iLog] || '',
      operator: f[iOperator] || '',
      configBase64: f[iB64] || '',
    });
  }
  return servers;
}

/**
 * 解析 auto-ovpn 镜像 JSON： [ { servers, countries }, lastUpdated ]。
 * servers 内字段为小写，映射到统一模型。
 */
export function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSON 解析失败');
  }
  const list = Array.isArray(data) ? data[0] : data;
  const servers = (list && Array.isArray(list.servers) ? list.servers : [])
    .map((s) => ({
      hostname: s.hostname || '',
      ip: s.ip || '',
      score: parseIntOf(s.score),
      pingMs: parseIntOf(s.ping),
      speedBps: parseIntOf(s.speed),
      countryLong: s.countrylong || '',
      countryShort: String(s.countryshort || '').toUpperCase(),
      sessions: parseIntOf(s.numvpnsessions),
      uptimeHours: Math.round((parseIntOf(s.uptime) || 0) / 3600000 * 10) / 10,
      logType: s.logtype || '',
      operator: s.operator || '',
      configBase64: s.openvpn_configdata_base64 || '',
    }))
    .filter((s) => s.ip && s.hostname);
  if (servers.length === 0) throw new Error('JSON 中无有效服务器');
  return servers;
}

function parseIntOf(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/** 归一化：给服务器补 id 并裁剪字段（去 base64）供列表返回 */
export function normalizeServers(rawServers) {
  return rawServers
    .filter((s) => s.ip && /^\d+\.\d+\.\d+\.\d+$/.test(s.ip))
    .map((s) => {
      const base = {
        id: `${s.hostname}|${s.ip}`,
        hostname: s.hostname,
        ip: s.ip,
        countryLong: s.countryLong,
        countryShort: s.countryShort,
        score: s.score,
        pingMs: s.pingMs,
        speedBps: s.speedBps,
        sessions: s.sessions,
        uptimeHours: s.uptimeHours,
        logType: s.logType,
        operator: s.operator,
      };
      return base;
    });
}

// ==================== 缓存 ====================

/**
 * 取全量服务器列表（含 base64 用于生成配置）。
 * 流程：尝试按配置签名命中 Cache API → 未命中则按数据源顺序逐个拉取解析 → 写缓存。
 *
 * @param {object} env - 环境对象
 * @param {object} config - 生效配置
 * @param {object} opts - { force?: boolean, sourceId?: string }
 * @returns {Promise<{servers: Array, statuses: Array, updatedAt: number, cacheHit: boolean}>}
 */
export async function getServers(env, config, opts = {}) {
  const sig = await sha1Hex(JSON.stringify(config.dataSources) + '|' + config.fetch.maxServers);
  const cacheKey = CACHE_PREFIX + 'servers/' + sig;
  const ttl = config.fetch.cacheSeconds;

  if (!opts.force) {
    const cached = await cacheMatch(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return { ...parsed, cacheHit: true };
    }
  }

  const sources = (config.dataSources || []).filter((s) => s.enabled);
  const statuses = [];
  let servers = [];

  // 优先指定源；否则按配置顺序逐个尝试
  const ordered = opts.sourceId
    ? [...sources.filter((s) => s.id === opts.sourceId), ...sources.filter((s) => s.id !== opts.sourceId)]
    : sources;

  for (const source of ordered) {
    const t0 = Date.now();
    try {
      const text = await withTimeout(fetchSource(source), config.fetch.timeoutMs);
      const raw = source.type === 'json' ? parseJson(text) : parseCsv(text);
      servers = normalizeServers(raw).slice(0, config.fetch.maxServers);
      statuses.push({ id: source.id, name: source.name, ok: true, count: servers.length, ms: Date.now() - t0 });
      if (servers.length > 0) break;
    } catch (e) {
      statuses.push({ id: source.id, name: source.name, ok: false, error: e.message, ms: Date.now() - t0 });
    }
  }

  if (servers.length === 0) {
    // 全部源失败：若缓存存在仍可用旧数据兜底
    const stale = await cacheMatch(cacheKey);
    if (stale) {
      const parsed = JSON.parse(stale);
      return { ...parsed, cacheHit: true, statuses };
    }
    throw new Error(`所有数据源均不可用：${statuses.map((s) => `${s.name}(${s.error})`).join('；')}`);
  }

  const payload = {
    servers,
    statuses,
    updatedAt: Date.now(),
    cacheHit: false,
  };
  await cachePut(cacheKey, JSON.stringify(payload), ttl);
  return payload;
}

// ==================== Cache API 封装 ====================

async function cacheMatch(key) {
  try {
    const res = await caches.default.match(key);
    if (res && res.ok) return await res.text();
  } catch {
    /* 缓存不可用则忽略 */
  }
  return null;
}

async function cachePut(key, body, ttl) {
  try {
    const res = new Response(body, {
      headers: { 'Cache-Control': `public, max-age=0, s-maxage=${ttl}` },
    });
    await caches.default.put(key, res);
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}
