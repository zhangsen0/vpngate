/**
 * config.js — 全局配置体系
 *
 * 职责：
 *  1. 定义全部可配置参数的默认值 DEFAULTS 与声明式 SCHEMA（供前端通用渲染配置面板）；
 *  2. 提供配置的深合并、校验、归一化能力；
 *  3. 提供配置的存取：优先 KV（绑定名 VPNGATE_CFG），无绑定时回退进程内内存（隔离岛级）。
 *
 * 约定：代码内不做任何硬编码决策，业务参数一律从配置读取。
 */

// ==================== 默认配置 ====================

/** 数据源为列表，按顺序逐个尝试，取第一个成功的源作为服务器列表来源 */
export const DEFAULT_SOURCES = [
  {
    id: 'vpngate-official',
    name: 'VPNGate 官方接口',
    url: 'https://www.vpngate.net/api/iphone/',
    type: 'csv',
    enabled: true,
  },
  {
    id: 'auto-ovpn-mirror',
    name: 'auto-ovpn GitHub 镜像(JSON)',
    url: 'https://raw.githubusercontent.com/9xN/auto-ovpn/main/json/data.json',
    type: 'json',
    enabled: true,
  },
  {
    id: 'vpngate-csv-mirror-1',
    name: 'GitHub CSV 镜像① (Vepashka94)',
    url: 'https://raw.githubusercontent.com/Vepashka94/vpngate-mirror/main/vpngate.csv',
    type: 'csv',
    enabled: true,
  },
  {
    id: 'vpngate-csv-mirror-2',
    name: 'GitHub CSV 镜像② (NetLops)',
    url: 'https://raw.githubusercontent.com/NetLops/vpngate-mirror/main/vpngate.csv',
    type: 'csv',
    enabled: true,
  },
  {
    id: 'vpngate-csv-mirror-3',
    name: 'GitHub CSV 镜像③ (ezedin63)',
    url: 'https://raw.githubusercontent.com/ezedin63/vpngate-mirror/main/data/vpngate.csv',
    type: 'csv',
    enabled: true,
  },
];

export const DEFAULTS = {
  version: 1,
  dataSources: DEFAULT_SOURCES,
  fetch: {
    /** 单数据源拉取超时(ms)（镜像源实测 <1s；官方不可达时快速交给镜像接管） */
    timeoutMs: 8000,
    /** 解析后最多保留的服务器数（防过载） */
    maxServers: 400,
    /** 服务器列表缓存时长(秒) */
    cacheSeconds: 300,
    /** 请求 UA（官方源对非浏览器 UA 可能拒绝；镜像源无感） */
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    /** 拉取失败重试次数（官方源瞬时 504/超时可自动重试） */
    retries: 1,
    /** 官方源 DNS 覆盖：留空用 Cloudflare 边缘自带干净 DNS；填 'google' 时先经 DoH 解析真实 IP 再直连（绕国内 DNS 污染） */
    dnsResolver: '',
  },
  filters: {
    /** 禁用国家（ISO 3166 两位码），命中即剔除 */
    disabledCountryCodes: [],
    /** 仅保留指定国家；留空表示不限 */
    enabledCountryCodes: [],
    /** 最低在线时长(小时)，低于则剔除 */
    minUptimeHours: 0,
    /** 最低速度(Mbps)，低于则剔除 */
    minSpeedMbps: 0,
    /** 最高 Ping(ms)，0 表示不限 */
    maxPingMs: 0,
    /** 主机名/IP 白名单正则（JS 正则字符串），留空不限 */
    hostRegex: '',
  },
  weights: {
    /** 以下权重为 0~10 的倍数，评分 = Σ(权重×归一化值)/Σ(权重) */
    score: 1.0,
    ping: 1.0,
    speed: 1.0,
    uptime: 1.0,
    freeSessions: 0.5,
  },
  norm: {
    /** 归一化参考：评分满值 */
    scoreRef: 10000000,
    /** 归一化参考：ping 目标值(ms)，越小越好 */
    pingTargetMs: 50,
    /** 归一化参考：速度目标值(B/s) */
    speedTargetBps: 50000000,
    /** 归一化参考：在线时长目标值(小时) */
    uptimeRefHours: 720,
    /** 归一化参考：会话数目标值（超过视为拥挤，越小越好） */
    sessionsTarget: 50,
  },
  probe: {
    /** 连通性探测端口列表（TCP），按序探测取首个成功 */
    ports: [443, 1194],
    /** 单次探测超时(ms) */
    timeoutMs: 2000,
    /** 静态评分前 N 名进入连通性探测 */
    probeCount: 10,
    /** 探测并发数 */
    concurrency: 20,
    /** 优选结果是否仅保留可连通的节点 */
    requireReachable: true,
    /** 可连通节点评分加成（比例，0~1，加到总分上） */
    reachableBoost: 0.2,
  },
  optimize: {
    /** 优选返回的节点条数 */
    topN: 8,
    /** 优选结果缓存时长(秒)：相同参数下避免重复探测；0 关闭缓存 */
    cacheSeconds: 30,
  },
  ovpn: {
    /** 生成的 .ovpn 中是否把 remote 主机名改写为 IP（直连优选 IP） */
    rewriteRemoteToIp: true,
    /** 追加到 .ovpn 末尾的附加选项（每行一个） */
    appendOptions: [
      'data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305',
      'auth-nocache',
      'block-outside-dns',
    ],
  },
  ui: {
    theme: 'dark',
    /** 表格默认排序字段（score-desc / ping-asc / speed-desc / uptime-desc） */
    defaultSort: 'score-desc',
  },
};

// ==================== 声明式 SCHEMA（供前端通用渲染） ====================

/**
 * SCHEMA 项字段：
 *  - key: 点分路径，如 "fetch.cacheSeconds"
 *  - group: 分组名（前端按分组渲染）
 *  - label: 中文标签
 *  - type: string / text / int / number / boolean / arrayNumber / arrayString
 *  - unit / hint / options / min / max / step：渲染与校验提示
 */
export const SCHEMA = [
  // —— 数据源 ——
  { key: 'dataSources', group: '数据源', label: '数据源列表', type: 'text',
    hint: 'JSON 数组，依次尝试直到成功。type: csv | json，csv 为 VPNGate 官方格式，json 为 auto-ovpn 镜像格式' },

  // —— 拉取 ——
  { key: 'fetch.timeoutMs', group: '拉取', label: '数据源超时(ms)', type: 'int', min: 1000, max: 60000, unit: 'ms' },
  { key: 'fetch.maxServers', group: '拉取', label: '最大服务器数', type: 'int', min: 1, max: 2000 },
  { key: 'fetch.cacheSeconds', group: '拉取', label: '列表缓存时长(秒)', type: 'int', min: 30, max: 86400, unit: 's' },
  { key: 'fetch.userAgent', group: '拉取', label: '请求 UA', type: 'text',
    hint: '官方源对非浏览器 UA 可能拒绝；留空用默认浏览器 UA' },
  { key: 'fetch.retries', group: '拉取', label: '失败重试次数', type: 'int', min: 0, max: 5, unit: '次',
    hint: '官方源瞬时 504/超时可自动重试' },
  { key: 'fetch.dnsResolver', group: '拉取', label: '官方源 DNS 解析', type: 'select', options: ['', 'google'],
    hint: '留空用 CF 边缘干净 DNS；google=先经 Google DoH 解析真实 IP 再直连（绕国内 DNS 污染）' },

  // —— 筛选 ——
  { key: 'filters.disabledCountryCodes', group: '筛选', label: '禁用国家(两位码)', type: 'arrayString',
    hint: '如 ["RU","CN"]，命中即剔除；留空不限' },
  { key: 'filters.enabledCountryCodes', group: '筛选', label: '仅保留国家(两位码)', type: 'arrayString',
    hint: '留空表示不限' },
  { key: 'filters.minUptimeHours', group: '筛选', label: '最低在线时长(小时)', type: 'number', min: 0, max: 8760, unit: 'h' },
  { key: 'filters.minSpeedMbps', group: '筛选', label: '最低速度(Mbps)', type: 'number', min: 0, max: 10000, unit: 'Mbps' },
  { key: 'filters.maxPingMs', group: '筛选', label: '最高 Ping(ms)', type: 'int', min: 0, max: 5000, unit: 'ms',
    hint: '0 表示不限' },
  { key: 'filters.hostRegex', group: '筛选', label: '主机名/IP 白名单正则', type: 'string',
    hint: '如 ^public-vpn-|^jp  ，留空不限' },

  // —— 评分权重 ——
  { key: 'weights.score', group: '评分权重', label: '评分(Score)权重', type: 'number', min: 0, max: 10, step: 0.1 },
  { key: 'weights.ping', group: '评分权重', label: '延迟(Ping)权重', type: 'number', min: 0, max: 10, step: 0.1 },
  { key: 'weights.speed', group: '评分权重', label: '速度(Speed)权重', type: 'number', min: 0, max: 10, step: 0.1 },
  { key: 'weights.uptime', group: '评分权重', label: '在线时长权重', type: 'number', min: 0, max: 10, step: 0.1 },
  { key: 'weights.freeSessions', group: '评分权重', label: '空闲度(会话少)权重', type: 'number', min: 0, max: 10, step: 0.1 },

  // —— 归一化参考 ——
  { key: 'norm.scoreRef', group: '归一化参考', label: '评分满值参考', type: 'int', min: 1, max: 1000000000 },
  { key: 'norm.pingTargetMs', group: '归一化参考', label: 'Ping 目标值(ms)', type: 'int', min: 1, max: 1000, unit: 'ms' },
  { key: 'norm.speedTargetBps', group: '归一化参考', label: '速度目标值(B/s)', type: 'int', min: 1000, max: 10000000000 },
  { key: 'norm.uptimeRefHours', group: '归一化参考', label: '在线时长目标值(小时)', type: 'int', min: 1, max: 87600, unit: 'h' },
  { key: 'norm.sessionsTarget', group: '归一化参考', label: '会话数目标值', type: 'int', min: 1, max: 10000 },

  // —— 连通性探测 ——
  { key: 'probe.ports', group: '连通性探测', label: '探测端口列表', type: 'arrayNumber',
    hint: '如 [443,1194,5555,992]，按序探测取首个成功' },
  { key: 'probe.timeoutMs', group: '连通性探测', label: '探测超时(ms)', type: 'int', min: 200, max: 10000, unit: 'ms' },
  { key: 'probe.probeCount', group: '连通性探测', label: '探测数量(静态评分前 N)', type: 'int', min: 1, max: 100 },
  { key: 'probe.concurrency', group: '连通性探测', label: '探测并发数', type: 'int', min: 1, max: 50 },
  { key: 'probe.requireReachable', group: '连通性探测', label: '仅保留可连通节点', type: 'boolean' },
  { key: 'probe.reachableBoost', group: '连通性探测', label: '可连通评分加成(0~1)', type: 'number', min: 0, max: 1, step: 0.05 },

  // —— 优选结果 ——
  { key: 'optimize.topN', group: '优选结果', label: '优选返回条数', type: 'int', min: 1, max: 50 },
  { key: 'optimize.cacheSeconds', group: '优选结果', label: '优选缓存时长(秒)', type: 'int', min: 0, max: 3600, unit: 's',
    hint: '相同参数下缓存优选结果，避免重复探测；0 关闭' },

  // —— 节点配置生成 ——
  { key: 'ovpn.rewriteRemoteToIp', group: '节点配置生成', label: 'remote 改写为优选 IP', type: 'boolean' },
  { key: 'ovpn.appendOptions', group: '节点配置生成', label: '附加 OpenVPN 选项(每行一条)', type: 'arrayString' },

  // —— 界面 ——
  { key: 'ui.theme', group: '界面', label: '主题', type: 'string', options: ['dark', 'light'] },
  { key: 'ui.defaultSort', group: '界面', label: '默认排序', type: 'string', options: ['score-desc', 'ping-asc', 'speed-desc', 'uptime-desc'] },
];

// ==================== 合并与校验 ====================

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * 把用户配置深合并到默认值上，返回新对象（不修改入参）。
 * 对未识别的键做丢弃，保证配置结构受控。
 */
export function mergeConfig(user) {
  const base = structuredClone(DEFAULTS);
  if (!user || typeof user !== 'object') return base;
  deepMerge(base, user);
  return base;
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (Array.isArray(sv)) {
      target[key] = structuredClone(sv);
    } else if (sv && typeof sv === 'object' && tv && typeof tv === 'object') {
      deepMerge(tv, sv);
    } else {
      target[key] = sv;
    }
  }
}

/**
 * 校验并归一化配置：越界值收敛到合法范围，类型错误的回退默认。
 * 返回 { config, errors }，errors 为人类可读的中文问题列表。
 */
export function validateConfig(cfg) {
  const config = mergeConfig(cfg);
  const errors = [];

  const withDefault = (path, def) => {
    const node = path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), config);
    return node === undefined || node === null ? def : node;
  };

  config.fetch.timeoutMs = clamp(intOf(withDefault('fetch.timeoutMs', 8000), 8000), 1000, 60000);
  config.fetch.maxServers = clamp(intOf(withDefault('fetch.maxServers', 400), 400), 1, 2000);
  config.fetch.cacheSeconds = clamp(intOf(withDefault('fetch.cacheSeconds', 300), 300), 30, 86400);
  config.fetch.retries = clamp(intOf(withDefault('fetch.retries', 1), 1), 0, 5);
  config.fetch.userAgent = typeof withDefault('fetch.userAgent', '') === 'string' && config.fetch.userAgent
    ? config.fetch.userAgent : DEFAULTS.fetch.userAgent;
  config.fetch.dnsResolver = ['', 'google'].includes(config.fetch.dnsResolver) ? config.fetch.dnsResolver : '';

  config.filters.disabledCountryCodes = strArrayOf(withDefault('filters.disabledCountryCodes', []));
  config.filters.enabledCountryCodes = strArrayOf(withDefault('filters.enabledCountryCodes', []));
  config.filters.minUptimeHours = clamp(numOf(withDefault('filters.minUptimeHours', 0), 0), 0, 8760);
  config.filters.minSpeedMbps = clamp(numOf(withDefault('filters.minSpeedMbps', 0), 0), 0, 10000);
  config.filters.maxPingMs = clamp(intOf(withDefault('filters.maxPingMs', 0), 0), 0, 5000);
  if (typeof withDefault('filters.hostRegex', '') === 'string' && config.filters.hostRegex !== '') {
    try {
      new RegExp(config.filters.hostRegex);
    } catch {
      config.filters.hostRegex = '';
      errors.push('hostRegex 不是合法正则，已重置为空');
    }
  }

  for (const k of Object.keys(config.weights)) {
    config.weights[k] = clamp(numOf(withDefault(`weights.${k}`, DEFAULTS.weights[k]), DEFAULTS.weights[k]), 0, 10);
  }
  for (const k of Object.keys(config.norm)) {
    config.norm[k] = Math.max(1, numOf(withDefault(`norm.${k}`, DEFAULTS.norm[k]), DEFAULTS.norm[k]));
  }

  config.probe.ports = intArrayOf(withDefault('probe.ports', [443, 1194])).filter((p) => p >= 1 && p <= 65535);
  if (config.probe.ports.length === 0) config.probe.ports = [443];
  config.probe.timeoutMs = clamp(intOf(withDefault('probe.timeoutMs', 2500), 2500), 200, 10000);
  config.probe.probeCount = clamp(intOf(withDefault('probe.probeCount', 20), 20), 1, 100);
  config.probe.concurrency = clamp(intOf(withDefault('probe.concurrency', 10), 10), 1, 50);
  config.probe.requireReachable = boolOf(withDefault('probe.requireReachable', true), true);
  config.probe.reachableBoost = clamp(numOf(withDefault('probe.reachableBoost', 0.2), 0.2), 0, 1);

  config.optimize.topN = clamp(intOf(withDefault('optimize.topN', 8), 8), 1, 50);
  config.optimize.cacheSeconds = clamp(intOf(withDefault('optimize.cacheSeconds', 30), 30), 0, 3600);

  config.ovpn.rewriteRemoteToIp = boolOf(withDefault('ovpn.rewriteRemoteToIp', true), true);
  config.ovpn.appendOptions = strArrayOf(withDefault('ovpn.appendOptions', []));

  config.ui.theme = ['dark', 'light'].includes(withDefault('ui.theme', 'dark')) ? config.ui.theme : 'dark';
  const sorts = ['score-desc', 'ping-asc', 'speed-desc', 'uptime-desc'];
  config.ui.defaultSort = sorts.includes(withDefault('ui.defaultSort', 'score-desc')) ? config.ui.defaultSort : 'score-desc';

  if (!Array.isArray(config.dataSources) || config.dataSources.length === 0) {
    config.dataSources = structuredClone(DEFAULT_SOURCES);
    errors.push('dataSources 无效，已恢复默认数据源');
  } else {
    config.dataSources = config.dataSources
      .filter((s) => s && typeof s.url === 'string' && s.url.length > 0)
      .map((s) => ({
        id: String(s.id || s.url),
        name: String(s.name || s.url),
        url: s.url,
        type: s.type === 'json' ? 'json' : 'csv',
        enabled: s.enabled !== false,
      }));
    if (config.dataSources.length === 0) {
      config.dataSources = structuredClone(DEFAULT_SOURCES);
      errors.push('dataSources 为空，已恢复默认数据源');
    }
  }

  return { config, errors };
}

// ==================== 类型收敛工具 ====================

function intOf(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
function numOf(v, fallback) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
function boolOf(v, fallback) {
  if (typeof v === 'boolean') return v;
  return fallback;
}
function strArrayOf(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return strArrayOf(parsed);
    } catch {
      /* 忽略非法 JSON，按逗号拆分 */
    }
    return v.split(/[,，\s]+/).filter(Boolean).map((x) => x.toUpperCase());
  }
  return [];
}
function intArrayOf(v) {
  if (Array.isArray(v)) return v.map((x) => Number.parseInt(x, 10)).filter((n) => Number.isFinite(n));
  if (typeof v === 'string' && v.trim()) {
    return v.split(/[,，\s]+/).map((x) => Number.parseInt(x, 10)).filter((n) => Number.isFinite(n));
  }
  return [];
}

// ==================== 存储（KV / 内存双模式） ====================

const KV_KEY = 'global';
const META_KEY = 'meta';
/** 配置内存缓存 TTL（毫秒）：显著降低 KV 读频率；可用环境变量 CONFIG_CACHE_SECONDS 调整 */
const CONFIG_CACHE_TTL_DEFAULT = 60;

/** 隔离岛级内存兜底（无 KV 绑定时使用） */
const memStore = new Map();

/** 配置内存缓存（KV 读取结果复用） */
const cfgCache = { config: null, ts: 0 };

/**
 * 存储模式状态（隔离岛级）：
 *  - mode：用户指定 auto / memory / kv（默认 auto，可用环境变量 STORAGE_MODE 指定）
 *  - effective：实际生效存储（KV 故障时自动降级 memory）
 *  - degraded：是否因 KV 故障自动降级
 */
const storageState = {
  mode: 'auto',
  effective: 'memory',
  degraded: false,
  kvAvailable: true,
};
let metaLoaded = false;

function validMode(m) {
  return m === 'auto' || m === 'memory' || m === 'kv' ? m : null;
}

/** 当前存储状态快照 */
function snapshot() {
  return {
    mode: storageState.mode,
    effective: storageState.effective,
    degraded: storageState.degraded,
    kvAvailable: storageState.kvAvailable,
  };
}

/** 惰性恢复存储模式（每隔离岛一次）：KV meta 持久化 > 环境变量 > auto */
async function resolveMode(env) {
  if (metaLoaded) return;
  let mode = (env && env.STORAGE_MODE) || '';
  if (!validMode(mode)) mode = '';
  const kv = env && env.VPNGATE_CFG;
  if (kv && !mode) {
    try {
      const raw = await kv.get(META_KEY);
      if (raw) {
        const m = validMode(JSON.parse(raw).mode);
        if (m) mode = m;
      }
    } catch {
      /* KV 不可用则用环境/默认 */
    }
  }
  storageState.mode = validMode(mode) || 'auto';
  metaLoaded = true;
}

/** 从 KV 读取配置（不抛异常） */
async function loadFromKv(env) {
  const kv = env && env.VPNGATE_CFG;
  if (!kv) return { config: null, ok: false, reason: '未绑定 KV' };
  try {
    const raw = await kv.get(KV_KEY);
    if (!raw) return { config: null, ok: true };
    return { config: validateConfig(JSON.parse(raw)).config, ok: true };
  } catch (e) {
    return { config: null, ok: false, reason: e.message };
  }
}

/** 写入 KV（不抛异常） */
async function writeToKv(env, config) {
  const kv = env && env.VPNGATE_CFG;
  if (!kv) return { ok: false, reason: '未绑定 KV' };
  try {
    await kv.put(KV_KEY, JSON.stringify(config));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** 读取内存配置（无则默认值） */
function readMemory() {
  return memStore.get(KV_KEY) || validateConfig(null).config;
}

/** 写入内存（同时刷新缓存） */
function writeMemory(config) {
  memStore.set(KV_KEY, config);
  cfgCache.config = config;
  cfgCache.ts = Date.now();
}

/**
 * 读取当前生效配置（优先内存缓存，TTL 内不读 KV）。
 * 存储模式为 auto/kv 时尝试 KV：成功 → effective=kv；失败 → 自动降级 memory（degraded=true）。
 * 存储模式为 memory 时仅用内存，不访问 KV。
 * @param {object} env - Pages Functions 环境对象
 * @returns {Promise<{config: object, storage: object}>}
 */
export async function loadConfig(env) {
  await resolveMode(env);
  const ttlSec = Number.parseInt(env && env.CONFIG_CACHE_SECONDS, 10);
  const ttlMs = (Number.isNaN(ttlSec) ? CONFIG_CACHE_TTL_DEFAULT : Math.max(0, ttlSec)) * 1000;
  if (cfgCache.config && Date.now() - cfgCache.ts < ttlMs) {
    return { config: cfgCache.config, storage: snapshot() };
  }

  let config;
  if (storageState.mode !== 'memory') {
    const r = await loadFromKv(env);
    if (r.ok) {
      if (r.config) {
        config = r.config;
        storageState.effective = 'kv';
        storageState.degraded = false;
        storageState.kvAvailable = true;
      } else {
        config = readMemory();
        storageState.effective = 'memory';
        storageState.kvAvailable = true;
      }
    } else {
      storageState.effective = 'memory';
      storageState.degraded = true;
      storageState.kvAvailable = false;
      config = readMemory();
    }
  } else {
    storageState.effective = 'memory';
    config = readMemory();
  }

  cfgCache.config = config;
  cfgCache.ts = Date.now();
  return { config, storage: snapshot() };
}

/**
 * 保存配置（部分更新）。写内存（兜底）+ 按模式写 KV（低频必要写）。
 * @param {object} env - Pages Functions 环境对象
 * @param {object} partial - 用户提交的配置片段
 * @returns {Promise<{config: object, errors: string[], storage: object}>}
 */
export async function saveConfig(env, partial) {
  await resolveMode(env);
  const merged = mergeConfig(partial); // 以默认值为底再合入用户片段，避免用户省略字段导致丢失
  const { config, errors } = validateConfig(merged);
  writeMemory(config);

  if (storageState.mode !== 'memory') {
    const w = await writeToKv(env, config);
    if (w.ok) {
      storageState.effective = 'kv';
      storageState.degraded = false;
      storageState.kvAvailable = true;
    } else {
      storageState.effective = 'memory';
      storageState.degraded = true;
      storageState.kvAvailable = false;
      errors.push(`KV 写入失败，已自动降级为内存存储（可稍后手动同步到 KV）：${w.reason}`);
    }
  } else {
    storageState.effective = 'memory';
  }
  return { config, errors, storage: snapshot() };
}

/** 恢复默认配置 */
export async function resetConfig(env) {
  await resolveMode(env);
  const { config } = validateConfig(null);
  writeMemory(config);

  if (storageState.mode !== 'memory') {
    const w = await writeToKv(env, config);
    if (w.ok) {
      storageState.effective = 'kv';
      storageState.degraded = false;
      storageState.kvAvailable = true;
    } else {
      storageState.effective = 'memory';
      storageState.degraded = true;
      storageState.kvAvailable = false;
    }
  } else {
    storageState.effective = 'memory';
  }
  return { config, storage: snapshot() };
}

/**
 * 手动切换存储模式：auto / memory / kv。
 * 切换为非 memory 时立即把当前内存配置同步到 KV（若 KV 可用）。
 * @param {object} env - Pages Functions 环境对象
 * @param {string} mode - auto | memory | kv
 * @returns {Promise<{ok: boolean, error?: string, storage: object}>}
 */
export async function setStorageMode(env, mode) {
  await resolveMode(env);
  const m = validMode(mode);
  if (!m) return { ok: false, error: 'mode 必须为 auto / memory / kv', storage: snapshot() };

  storageState.mode = m;
  const kv = env && env.VPNGATE_CFG;
  if (kv) {
    try {
      await kv.put(META_KEY, JSON.stringify({ mode: m }));
    } catch {
      /* KV 不可用：模式仅保存在内存，随 KV 恢复后可重新设置 */
    }
  }
  if (m !== 'memory') {
    const r = await syncToKv(env);
    if (!r.ok) return { ok: true, error: r.error, storage: snapshot() };
  } else {
    storageState.effective = 'memory';
  }
  return { ok: true, storage: snapshot() };
}

/**
 * 手动把内存配置同步写入 KV（KV 恢复后使用），成功后解除降级标记。
 * @param {object} env - Pages Functions 环境对象
 * @returns {Promise<{ok: boolean, error?: string, storage: object}>}
 */
export async function syncToKv(env) {
  await resolveMode(env);
  const config = readMemory();
  const w = await writeToKv(env, config);
  if (w.ok) {
    storageState.effective = 'kv';
    storageState.degraded = false;
    storageState.kvAvailable = true;
    const kv = env && env.VPNGATE_CFG;
    if (kv) {
      try {
        await kv.put(META_KEY, JSON.stringify({ mode: storageState.mode }));
      } catch {
        /* 忽略 */
      }
    }
    return { ok: true, storage: snapshot() };
  }
  return { ok: false, error: `KV 不可用：${w.reason}`, storage: snapshot() };
}

/** 读取当前存储状态（供页面展示） */
export function getStorageState() {
  return snapshot();
}
