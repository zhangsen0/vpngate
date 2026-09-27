/**
 * API 路由入口 — functions/api/[[path]].js
 *
 * 路由表：
 *  GET  /api/health             健康检查（版本、存储方式）
 *  GET  /api/healthz            无鉴权探活（仅 ok/版本/时间，供外部监控）
 *  GET  /api/config             读取生效配置 + 声明式 SCHEMA + 存储状态
 *  PUT  /api/config             保存配置（部分更新，服务端校验）
 *  POST /api/config/reset       恢复默认配置
 *  PUT  /api/config/storage     切换存储模式（auto / memory / kv）
 *  POST /api/config/storage/sync  手动把内存配置同步写入 KV
 *  GET  /api/servers?refresh=1  服务器列表（默认走缓存；refresh=1 强制刷新）
 *  POST /api/optimize           执行优选（可覆盖 country/topN/requireReachable，结果短时缓存）
 *  GET  /api/ovpn?id=...        生成并返回 .ovpn 配置文本
 *  GET  /api/node?id=...        返回节点参数摘要
 *  POST /api/probe              对指定 IP 做连通性探测 { ip, ports? }
 *  GET  /api/logs?limit=50      读取操作日志（需登录）
 */

import { json, readJson, queryParams, sha1Hex } from '../_lib/util.js';
import { loadConfig, saveConfig, resetConfig, setStorageMode, syncToKv, DEFAULTS, SCHEMA } from '../_lib/config.js';
import { getServers } from '../_lib/sources.js';
import { runOptimize } from '../_lib/optimize.js';
import { buildOvpn, nodeParams } from '../_lib/ovpn.js';
import { probeServer } from '../_lib/probe.js';
import {
  issueToken, authCookieHeaders, clearCookieHeaders, safeEqual, isAuthed,
  checkLoginLock, recordLoginFail, clearLoginLock, signFileToken,
} from '../_lib/auth.js';
import { rememberServer, findServerSnapshot } from '../_lib/snapshot.js';
import { log, readLogs, flushPendingLogs } from '../_lib/log.js';

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = (params.path || []).join('/');
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  try {
    const res = await route(method, path, request, env);
    // 请求结束时批量落盘操作日志（一次请求至多一次 KV 写）
    if (typeof context.waitUntil === 'function') {
      context.waitUntil(flushPendingLogs(env));
    }
    return res;
  } catch (e) {
    if (typeof context.waitUntil === 'function') {
      context.waitUntil(flushPendingLogs(env));
    }
    return json({ ok: false, error: e.message || '内部错误' }, 500);
  }
}

async function route(method, path, request, env) {
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';

  // —— 登录 / 登出 / 会话状态 ——
  if (method === 'POST' && path === 'auth/login') {
    const body = await readJson(request);
    const password = body && typeof body.password === 'string' ? body.password : '';
    const expected = env && env.APP_PASSWORD;
    if (!expected) {
      return json({ ok: false, error: '未配置访问密码（APP_PASSWORD）' }, 500);
    }
    const lock = checkLoginLock(env, clientIp);
    if (lock.locked) {
      return json({ ok: false, error: `尝试次数过多，请 ${lock.retryAfter} 秒后再试` }, 429);
    }
    if (!safeEqual(password, expected)) {
      recordLoginFail(env, clientIp);
      log(env, 'login-fail', '密码错误', clientIp);
      return json({ ok: false, error: '密码错误' }, 401);
    }
    clearLoginLock(clientIp);
    log(env, 'login', '登录成功', clientIp);
    const token = await issueToken(env);
    if (!token) return json({ ok: false, error: '未配置访问密码（APP_PASSWORD）' }, 500);
    return json({ ok: true }, 200, authCookieHeaders(env, token));
  }

  if (method === 'POST' && path === 'auth/logout') {
    log(env, 'logout', '退出登录', clientIp);
    return json({ ok: true }, 200, clearCookieHeaders());
  }

  if (method === 'GET' && path === 'auth/me') {
    return isAuthed(request, env)
      ? json({ ok: true, authed: true, user: 'admin' })
      : json({ ok: true, authed: false });
  }

  // —— 健康检查 ——
  if (method === 'GET' && path === 'health') {
    const { storage } = await loadConfig(env);
    return json({ ok: true, name: 'vpngate', version: DEFAULTS.version, storage });
  }

  // —— 无鉴权探活（中间件白名单放行；仅返回最基本信息） ——
  if (method === 'GET' && path === 'healthz') {
    return json({ ok: true, name: 'vpngate', version: DEFAULTS.version, ts: Date.now() });
  }

  // —— 配置 ——
  if (path === 'config') {
    if (method === 'GET') {
      const { config, storage } = await loadConfig(env);
      return json({ ok: true, config, schema: SCHEMA, defaults: DEFAULTS, storage });
    }
    if (method === 'PUT') {
      const body = await readJson(request);
      if (body == null) return json({ ok: false, error: '请求体必须为 JSON' }, 400);
      const { config, errors, storage } = await saveConfig(env, body);
      log(env, 'config-save', `生效存储=${storage.effective} 校验错误=${errors.length}`, clientIp);
      return json({ ok: errors.length === 0, config, errors, storage });
    }
  }
  if (method === 'POST' && path === 'config/reset') {
    const { config, storage } = await resetConfig(env);
    log(env, 'config-reset', '恢复默认配置', clientIp);
    return json({ ok: true, config, storage });
  }
  if (method === 'PUT' && path === 'config/storage') {
    const body = await readJson(request);
    if (!body || typeof body.mode !== 'string') return json({ ok: false, error: '缺少 mode（auto/memory/kv）' }, 400);
    const r = await setStorageMode(env, body.mode);
    log(env, 'storage-switch', `切换存储模式 → ${body.mode}${r.error ? '（' + r.error + '）' : ''}`, clientIp);
    return r.ok ? json({ ok: true, storage: r.storage, error: r.error || '' }) : json({ ok: false, error: r.error, storage: r.storage }, 400);
  }
  if (method === 'POST' && path === 'config/storage/sync') {
    const r = await syncToKv(env);
    log(env, 'storage-sync', r.ok ? '内存配置已同步到 KV' : `同步失败：${r.error}`, clientIp);
    return r.ok ? json({ ok: true, storage: r.storage }) : json({ ok: false, error: r.error, storage: r.storage }, 502);
  }

  // —— 服务器列表 ——
  if (method === 'GET' && path === 'servers') {
    const q = queryParams(request.url);
    const { config } = await loadConfig(env);
    const force = q.refresh === '1' || q.refresh === 'true';
    const result = await getServers(env, config, {
      force,
      sourceId: q.source || undefined,
    });
    if (force) log(env, 'servers-refresh', `强制刷新（源=${q.source || '全部'}）`, clientIp);
    // 列表返回轻量字段（不含 base64）
    const light = result.servers.map((s) => {
      const o = {};
      for (const k of ['id', 'hostname', 'ip', 'countryLong', 'countryShort', 'score', 'pingMs', 'speedBps', 'sessions', 'uptimeHours', 'logType', 'operator']) {
        o[k] = s[k];
      }
      return o;
    });
    return json({
      ok: true,
      servers: light,
      statuses: result.statuses,
      updatedAt: result.updatedAt,
      cacheHit: result.cacheHit,
      total: light.length,
      storage: (await loadConfig(env)).storage,
    });
  }

  // —— 优选（结果短时缓存，避免重复探测） ——
  if (method === 'POST' && path === 'optimize') {
    const body = await readJson(request);
    const { config } = await loadConfig(env);
    // 允许请求体临时覆盖部分参数（不落盘）：country / topN / requireReachable / probeCount / refresh
    const overrides = body && typeof body === 'object' ? body : {};
    const ovCountry = overrides.country ? String(overrides.country).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean) : null;
    const ovTopN = overrides.topN ? Number.parseInt(overrides.topN, 10) : null;
    const ovReq = typeof overrides.requireReachable === 'boolean' ? overrides.requireReachable : null;
    const ovProbeCount = overrides.probeCount ? Number.parseInt(overrides.probeCount, 10) : null;
    const ovRefresh = overrides.refresh === true || overrides.refresh === '1';
    const ovIds = Array.isArray(overrides.ids) ? overrides.ids.filter((x) => typeof x === 'string' && x) : null;
    if (ovCountry) config.filters.enabledCountryCodes = ovCountry;
    if (ovTopN) config.optimize.topN = ovTopN;
    if (ovReq !== null) config.probe.requireReachable = ovReq;
    if (ovProbeCount) config.probe.probeCount = Math.min(100, Math.max(1, ovProbeCount));

    // 缓存键：仅与影响优选结果的配置+覆盖参数相关
    const sig = await sha1Hex(JSON.stringify({
      d: config.dataSources,
      f: config.filters,
      w: config.weights,
      n: config.norm,
      p: { ports: config.probe.ports, timeoutMs: config.probe.timeoutMs, probeCount: config.probe.probeCount, concurrency: config.probe.concurrency, requireReachable: config.probe.requireReachable, reachableBoost: config.probe.reachableBoost },
      o: config.optimize.topN,
      ov: { c: ovCountry, n: ovTopN, r: ovReq, pc: ovProbeCount, ref: ovRefresh, ids: ovIds },
    }));
    const ttl = Math.max(0, config.optimize.cacheSeconds || 0);
    const cacheKey = `https://vpngate.local/cache/optimize/${sig}`;
    if (ttl > 0) {
      try {
        const cached = await caches.default.match(cacheKey);
        if (cached) {
          const data = await cached.json();
          return json({ ok: true, cacheHit: true, ...data });
        }
      } catch { /* 缓存不可用则直接执行 */ }
    }

    const result = await getServers(env, config, { force: ovRefresh });
    const { ranked, probed } = await runOptimize(result.servers, config, undefined, 15000, ovIds ? { ids: ovIds } : {});
    log(env, 'optimize', ovIds ? `本机实测模式：id 集合 ${ovIds.length} 个 / 达标 ${ranked.length} 个` : `候选 ${probed.length} 个 / 达标 ${ranked.length} 个`, clientIp);

    if (ttl > 0) {
      try {
        await caches.default.put(cacheKey, new Response(
          JSON.stringify({ ranked, probed, statuses: result.statuses, updatedAt: result.updatedAt }),
          { headers: { 'Cache-Control': `s-maxage=${ttl}` } },
        ));
      } catch { /* 写缓存失败不影响结果 */ }
    }
    return json({ ok: true, ranked, probed, statuses: result.statuses, updatedAt: result.updatedAt });
  }

  // —— 免登录下载链接（带短期令牌，供外部客户端如 OpenVPN Connect 直接导入） ——
  if (method === 'GET' && path === 'ovpn-url') {
    const q = queryParams(request.url);
    if (!q.id) return json({ ok: false, error: '缺少 id 参数' }, 400);
    const { config } = await loadConfig(env);
    const ttlMs = config.ovpn.linkTokenTtlSeconds * 1000;
    const token = await signFileToken(env, q.id, ttlMs);
    if (!token) return json({ ok: false, error: '签名密钥不可用（未配置 APP_PASSWORD）' }, 500);
    // 节点快照：列表刷新导致节点下线时，链接在有效期内仍可下载（内存 + KV）
    const result = await getServers(env, config);
    let server = result.servers.find((s) => s.id === q.id);
    if (!server) server = await findServerSnapshot(q.id, env); // 已下线但有快照时仍可生成链接
    if (server) rememberServer(server, ttlMs * 3, env);
    const url = new URL(request.url);
    // 链接以 .ovpn 结尾：多数客户端（含 OpenVPN Connect）按扩展名识别为配置文件
    const link = `${url.origin}/api/ovpn-file/${encodeURIComponent(q.id)}.ovpn?token=${encodeURIComponent(token)}`;
    log(env, 'ovpn-link', `生成免登录下载链接 ${q.id.slice(0, 40)}`, clientIp);
    return json({ ok: true, url: link, expiresIn: config.ovpn.linkTokenTtlSeconds });
  }

  // —— 生成 .ovpn（兼容两种路径：/api/ovpn?id= 与 /api/ovpn-file/{id}.ovpn） ——
  if (method === 'GET' && (path === 'ovpn' || (path.startsWith('ovpn-file/') && path.endsWith('.ovpn')))) {
    const q = queryParams(request.url);
    // params.path 为 URL 编码态，需解码后与签名时的 id 比对/查询列表（id 含 | 等特殊字符）
    const id = path === 'ovpn' ? (q.id || '') : decodeURIComponent(path.slice('ovpn-file/'.length, -'.ovpn'.length));
    if (!id) return json({ ok: false, error: '缺少 id 参数' }, 400);
    const { config } = await loadConfig(env);
    const result = await getServers(env, config);
    let server = result.servers.find((s) => s.id === id);
    // 列表刷新后节点可能下线：回退到快照（内存 + KV，链接有效期内仍可下载）
    if (!server) server = await findServerSnapshot(id, env);
    if (!server) return json({ ok: false, error: '未找到该服务器，可能已从列表移除' }, 404);
    // 任何一次成功下载都写入快照：即使节点随后下线，有效期内（令牌TTL×3）仍可重复下载
    const ttlMs = config.ovpn.linkTokenTtlSeconds * 1000;
    rememberServer(server, ttlMs * 3, env);
    const ovpn = buildOvpn(server, config);
    if (!ovpn) return json({ ok: false, error: '该服务器缺少 OpenVPN 配置数据' }, 404);
    const fileName = `vpngate-${server.countryShort}-${server.ip}.ovpn`;
    log(env, 'ovpn', `下载配置 ${server.ip} (${server.countryShort})`, clientIp);
    return new Response(ovpn.text, {
      headers: {
        // 不带 charset：部分 OpenVPN Connect 版本对带参数的 Content-Type 精确匹配失败
        'Content-Type': 'application/x-openvpn-profile',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // —— 节点参数 ——
  if (method === 'GET' && path === 'node') {
    const q = queryParams(request.url);
    if (!q.id) return json({ ok: false, error: '缺少 id 参数' }, 400);
    const { config } = await loadConfig(env);
    const result = await getServers(env, config);
    const server = result.servers.find((s) => s.id === q.id);
    if (!server) return json({ ok: false, error: '未找到该服务器，可能已从列表移除' }, 404);
    const ovpn = buildOvpn(server, config);
    return json({ ok: true, node: nodeParams(server, ovpn) });
  }

  // —— 单点探测 ——
  if (method === 'POST' && path === 'probe') {
    const body = await readJson(request);
    if (!body || !body.ip) return json({ ok: false, error: '缺少 ip' }, 400);
    const { config } = await loadConfig(env);
    const ports = Array.isArray(body.ports) && body.ports.length > 0 ? body.ports : config.probe.ports;
    const result = await probeServer({ ip: body.ip }, ports, config.probe.timeoutMs);
    return json({ ok: true, ...result, ports });
  }

  // —— 操作日志 ——
  if (method === 'GET' && path === 'logs') {
    const q = queryParams(request.url);
    const limit = Math.min(100, Math.max(1, Number.parseInt(q.limit, 10) || 50));
    const logs = await readLogs(env, limit);
    return json({ ok: true, logs });
  }

  return json({ ok: false, error: `未知路由: ${method} /api/${path}` }, 404);
}
