/**
 * API 路由入口 — functions/api/[[path]].js
 *
 * 路由表：
 *  GET  /api/health            健康检查（版本、存储方式）
 *  GET  /api/config            读取生效配置 + 声明式 SCHEMA（供前端渲染配置面板）
 *  PUT  /api/config            保存配置（部分更新，服务端校验）
 *  POST /api/config/reset      恢复默认配置
 *  GET  /api/servers?refresh=1 服务器列表（默认走缓存；refresh=1 强制刷新）
 *  POST /api/optimize          执行优选（可选请求体覆盖部分参数，如 country/topN）
 *  GET  /api/ovpn?id=...       生成并返回 .ovpn 配置文本
 *  GET  /api/node?id=...       返回节点参数摘要
 *  POST /api/probe             对指定 IP 做连通性探测 { ip, ports? }
 */

import { json, readJson, queryParams } from '../_lib/util.js';
import { loadConfig, saveConfig, resetConfig, DEFAULTS, SCHEMA } from '../_lib/config.js';
import { getServers } from '../_lib/sources.js';
import { runOptimize } from '../_lib/optimize.js';
import { buildOvpn, nodeParams } from '../_lib/ovpn.js';
import { probeServer } from '../_lib/probe.js';
import { issueToken, authCookieHeaders, clearCookieHeaders, safeEqual, isAuthed } from '../_lib/auth.js';

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
    return await route(method, path, request, env);
  } catch (e) {
    return json({ ok: false, error: e.message || '内部错误' }, 500);
  }
}

async function route(method, path, request, env) {
  // —— 登录 / 登出 / 会话状态 ——
  if (method === 'POST' && path === 'auth/login') {
    const body = await readJson(request);
    const password = body && typeof body.password === 'string' ? body.password : '';
    const expected = env && env.APP_PASSWORD;
    if (!expected) {
      return json({ ok: false, error: '未配置访问密码（APP_PASSWORD）' }, 500);
    }
    if (!safeEqual(password, expected)) {
      return json({ ok: false, error: '密码错误' }, 401);
    }
    const token = await issueToken(env);
    if (!token) return json({ ok: false, error: '未配置访问密码（APP_PASSWORD）' }, 500);
    return json({ ok: true }, 200, authCookieHeaders(env, token));
  }

  if (method === 'POST' && path === 'auth/logout') {
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
      return json({ ok: errors.length === 0, config, errors, storage });
    }
  }
  if (method === 'POST' && path === 'config/reset') {
    const { config, storage } = await resetConfig(env);
    return json({ ok: true, config, storage });
  }

  // —— 服务器列表 ——
  if (method === 'GET' && path === 'servers') {
    const q = queryParams(request.url);
    const { config } = await loadConfig(env);
    const result = await getServers(env, config, {
      force: q.refresh === '1' || q.refresh === 'true',
      sourceId: q.source || undefined,
    });
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

  // —— 优选 ——
  if (method === 'POST' && path === 'optimize') {
    const body = await readJson(request);
    const { config } = await loadConfig(env);
    // 允许请求体临时覆盖部分参数（不落盘）：country / topN / requireReachable
    const overrides = body && typeof body === 'object' ? body : {};
    if (overrides.country) {
      config.filters.enabledCountryCodes = String(overrides.country).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (overrides.topN) config.optimize.topN = Number.parseInt(overrides.topN, 10) || config.optimize.topN;
    if (typeof overrides.requireReachable === 'boolean') config.probe.requireReachable = overrides.requireReachable;

    const result = await getServers(env, config, { force: overrides.refresh === true || overrides.refresh === '1' });
    const { ranked, probed } = await runOptimize(result.servers, config);
    return json({ ok: true, ranked, probed, statuses: result.statuses, updatedAt: result.updatedAt });
  }

  // —— 生成 .ovpn ——
  if (method === 'GET' && path === 'ovpn') {
    const q = queryParams(request.url);
    if (!q.id) return json({ ok: false, error: '缺少 id 参数' }, 400);
    const { config } = await loadConfig(env);
    const result = await getServers(env, config);
    const server = result.servers.find((s) => s.id === q.id);
    if (!server) return json({ ok: false, error: '未找到该服务器，可能已从列表移除' }, 404);
    const ovpn = buildOvpn(server, config);
    if (!ovpn) return json({ ok: false, error: '该服务器缺少 OpenVPN 配置数据' }, 404);
    const fileName = `vpngate-${server.countryShort}-${server.ip}.ovpn`;
    return new Response(ovpn.text, {
      headers: {
        'Content-Type': 'application/x-openvpn-profile; charset=utf-8',
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

  return json({ ok: false, error: `未知路由: ${method} /api/${path}` }, 404);
}
