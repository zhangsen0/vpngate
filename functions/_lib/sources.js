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
  'port', 'proto',
];

/**
 * 从 OpenVPN 原始配置（base64）解析 remote 端口与协议。
 * 前端本机实测按实际端口/协议探测，避免「探测 443 而配置走 UDP 1194」导致连不上。
 * @param {string} configBase64
 * @returns {{port: number|null, proto: string|null}} proto: tcp/udp，无 remote 时为 null
 */
export function parseRemotePortProto(configBase64) {
  if (!configBase64) return { port: null, proto: null };
  try {
    const raw = atob(configBase64);
    // remote 行两种格式：`remote <host> <port>`（协议在单独 proto 指令）或 `remote <host> <port> <tcp|udp>`。
    // 不锚定行首：兼容官方源 base64 解码后可能带前导空白/BOM 的情况。
    const m = raw.match(/remote[ \t]+\S+[ \t]+(\d+)(?:[ \t]+(\w+))?/);
    if (m) {
      const port = Number.parseInt(m[1], 10);
      let proto = m[2] ? m[2].toLowerCase() : null;
      if (!proto) {
        const pm = raw.match(/proto[ \t]+(\w+)/); // 单独 proto 指令，如 proto udp
        if (pm) proto = pm[1].toLowerCase();
      }
      return { port, proto };
    }
    const m2 = raw.match(/port[ \t]+(\d+)/); // 无 remote 时回退 port 指令
    if (m2) return { port: Number.parseInt(m2[1], 10), proto: null };
  } catch { /* base64 解码失败则忽略 */ }
  return { port: null, proto: null };
}

/** 数据源缓存命名空间前缀 */
const CACHE_PREFIX = 'https://vpngate.local/cache/';
/** 服务器数据结构版本：结构变更（新增字段等）时 bump，避免旧缓存无新字段 */
const SERVERS_DATA_VERSION = 4;

// ==================== 拉取 ====================

/**
 * 拉取单个数据源原文（内部含失败重试；总预算由调用方 withTimeout 控制）。
 * @param {object} source - { id, url, type }
 * @param {object} fetchOpts - { userAgent, retries, timeoutMs, dnsResolver }
 * @returns {Promise<string>} 原文文本
 */
export async function fetchSource(source, fetchOpts = {}) {
  const {
    userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    retries = 1,
    timeoutMs = 8000,
    dnsResolver = '',
  } = fetchOpts;
  const headers = {
    'User-Agent': userAgent,
    Accept: 'text/plain,text/csv,application/json,text/html,*/*',
  };
  const url = source.url;
  let lastErr;

  // 可选：官方源 DNS 覆盖（绕国内 DNS 污染）——用 Google DoH 解析真实 IP 后直连
  const tryResolve = async (u) => {
    if (!dnsResolver || dnsResolver !== 'google') return u;
    const host = new URL(u).hostname;
    try {
      const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, {
        headers: { 'User-Agent': 'vpngate-dns/1.0' },
      });
      if (!r.ok) return u;
      const j = await r.json();
      const ip = (j.Answer || []).find((a) => a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(a.data));
      if (!ip) return u;
      const nu = new URL(u);
      nu.hostname = ip.data;
      return nu.toString();
    } catch {
      return u;
    }
  };

  for (let i = 0; i <= retries; i++) {
    try {
      const target = await tryResolve(url);
      const res = await fetch(target, { headers, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text || text.length < 100) throw new Error(`响应体过小(${text.length}B)：${text.slice(0, 120)}`);
      return text;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ==================== 解析 ====================

/**
 * 解析 VPNGate CSV 文本。
 * 官方格式：首行 `*vpn_servers`（版本标记），第二行以 `#` 开头的表头，之后为数据行；底部另有 `*` 版权行。
 * 兼容无 `*`/`#` 的简化 CSV（直接首行为表头）。
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  // 表头行：优先取以 # 开头的行（官方格式）；否则取首个非空行
  let headerLine = lines.find((l) => l.startsWith('#'));
  if (!headerLine) {
    const first = lines.find((l) => l && !l.startsWith('*') && !l.startsWith('#'));
    headerLine = first || lines[0] || '';
  }
  const header = headerLine.replace(/^#/, '').split(',');
  const idx = (name) => header.indexOf(name);
  const iHost = idx('HostName'), iIp = idx('IP'), iScore = idx('Score'), iPing = idx('Ping'),
    iSpeed = idx('Speed'), iCountryLong = idx('CountryLong'), iCountryShort = idx('CountryShort'),
    iSessions = idx('NumVpnSessions'), iUptime = idx('Uptime'), iLog = idx('LogType'),
    iOperator = idx('Operator'), iB64 = idx('OpenVPN_ConfigData_Base64');
  if (iHost < 0 || iIp < 0 || iB64 < 0) throw new Error(`CSV 表头不匹配，非 VPNGate 格式：${text.slice(0, 160)}`);

  const servers = [];
  for (const line of lines) {
    if (!line || line.startsWith('*') || line.startsWith('#') || line === headerLine) continue;
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

/** 归一化：给服务器补 id 并补齐可选字段（保留 configBase64 供生成配置；列表返回时由路由裁剪） */
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
        // 保留 base64（.ovpn 生成必需；大字段仅在 /api/servers 路由中被裁剪）
        configBase64: s.configBase64 || '',
      };
      const rp = parseRemotePortProto(base.configBase64);
      base.port = rp.port;
      base.proto = rp.proto;
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
  const cacheKey = CACHE_PREFIX + `servers/v${SERVERS_DATA_VERSION}/` + sig;
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
      const fetchOpts = {
        userAgent: config.fetch.userAgent,
        retries: config.fetch.retries,
        timeoutMs: config.fetch.timeoutMs,
        dnsResolver: config.fetch.dnsResolver,
      };
      const totalBudget = config.fetch.timeoutMs * (config.fetch.retries + 1);
      const text = await withTimeout(fetchSource(source, fetchOpts), totalBudget);
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
