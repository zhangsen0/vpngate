/**
 * e2e-test.mjs — 端到端全量验证（用户使用级 + 全接口）
 *
 * 覆盖：
 *  A. 认证与访问控制（未登录跳转/401、错误密码、登录、会话、登出）
 *  B. 全接口测试（health/config/servers/optimize/ovpn/node/auth）
 *  C. 用户使用级流程（登录 → 首页资源加载 → 配置读取 → 列表 → 优选 → 节点/配置产出）
 *
 * 用法：node scripts/e2e-test.mjs <baseUrl> <password>
 * 退出码：0 全部通过；1 存在失败
 */

import { execSync } from 'node:child_process';

const BASE = (process.argv[2] || 'https://vpngate-test.zhangsen.kdns.fr').replace(/\/$/, '');
const PASSWORD = process.argv[3] || 'admin123';
const TIMEOUT_MS = 90000;

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 简易 cookie jar */
const jar = { cookie: '' };

/** 请求封装（自动携带/记录 cookie） */
async function req(path, opts = {}) {
  const url = BASE + path;
  const headers = { ...(opts.headers || {}) };
  if (jar.cookie) headers.Cookie = jar.cookie;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, headers, redirect: 'manual', signal: controller.signal });
    const setCookie = res.headers.get('Set-Cookie');
    if (setCookie) jar.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
    return { status: res.status, headers: res.headers, text, json, location: res.headers.get('location') };
  } finally {
    clearTimeout(timer);
  }
}

const section = (s) => console.log(`\n== ${s} ==`);

// ==================== A. 认证与访问控制 ====================
section('A. 认证与访问控制');

let r = await req('/');
ok('未登录访问首页 → 302 跳转登录页', r.status === 302 && (r.location || '').includes('/login.html'), `status=${r.status} loc=${r.location}`);

r = await req('/index.html');
ok('未登录访问 index.html → 302', r.status === 302);

// 静态资源带 cache-busting 参数：避免命中边缘缓存（缓存命中会绕过中间件鉴权）
r = await req(`/style.css?e2e=${Date.now()}`);
ok('未登录访问静态资源 → 302', r.status === 302, `status=${r.status}`);

r = await req('/api/health');
ok('未登录访问 API → 401', r.status === 401 && r.json && r.json.ok === false);

r = await req('/api/auth/me');
ok('/api/auth/me 未登录 → authed:false', r.status === 200 && r.json && r.json.authed === false);

r = await req('/api/healthz');
ok('/api/healthz 无鉴权探活 → 200', r.status === 200 && r.json && r.json.ok === true);

// Pages 会把 /login.html 自动 308 到 /login（去扩展名），因此登录页以 /login 验证
r = await req('/login');
ok('登录页可访问 → 200', r.status === 200 && r.text.includes('访问密码'));

r = await req('/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'wrong-password' }),
});
ok('错误密码登录 → 401', r.status === 401);

r = await req('/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
ok('正确密码登录 → 200 + Set-Cookie', r.status === 200 && r.json && r.json.ok === true && !!jar.cookie);

r = await req('/api/auth/me');
ok('登录后 /api/auth/me → authed:true', r.status === 200 && r.json && r.json.authed === true);

// ==================== B. 用户使用级：资源加载 ====================
section('B. 用户使用级：资源加载');

r = await req('/');
ok('登录后首页 → 200', r.status === 200 && r.text.includes('VPNGate'));

for (const asset of ['/app.js', '/style.css', '/login.html']) {
  r = await req(asset);
  // Pages 对 /login.html 会 308 → /login（去扩展名），页面本体已验证 200
  ok(`登录后资源 ${asset} → 200 或 308(平台跳转)`, r.status === 200 || r.status === 308);
}

// ==================== C. 全接口测试 ====================
section('C. 全接口测试');

r = await req('/api/healthz');
ok('GET /api/healthz 无鉴权探活 → 200', r.status === 200 && r.json && r.json.ok === true);

r = await req('/api/health');
ok('GET /api/health → ok', r.status === 200 && r.json && r.json.ok === true && r.json.name === 'vpngate');

r = await req('/api/config');
ok('GET /api/config → 配置+SCHEMA', r.status === 200 && r.json && r.json.ok && r.json.config && Array.isArray(r.json.schema) && r.json.schema.length >= 10);

r = await req('/api/config', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ optimize: { topN: 5 } }),
});
ok('PUT /api/config 修改 topN=5 → 生效', r.status === 200 && r.json && r.json.ok && r.json.config.optimize.topN === 5);

r = await req('/api/config');
ok('GET /api/config 确认 topN=5 已持久化', r.status === 200 && r.json.config.optimize.topN === 5);

r = await req('/api/config', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fetch: { timeoutMs: 999999 } }),
});
ok('PUT /api/config 越界值收敛（timeout→60000）', r.status === 200 && r.json.config.fetch.timeoutMs === 60000);

r = await req('/api/config/reset', { method: 'POST' });
ok('POST /api/config/reset 恢复默认（topN=8）', r.status === 200 && r.json.config.optimize.topN === 8);

r = await req('/api/servers');
const servers = r.json && r.json.servers || [];
const first = servers[0] || {};
ok('GET /api/servers → 拉取 VPNGate 节点成功', r.status === 200 && r.json.ok && r.json.total > 0, `total=${r.json && r.json.total}`);
ok('节点字段完整（id/ip/countryShort/score）', !!first.id && !!first.ip && !!first.countryShort && first.score !== undefined);
ok('数据源状态返回', Array.isArray(r.json.statuses) && r.json.statuses.length > 0);

r = await req('/api/servers?refresh=1');
ok('GET /api/servers?refresh=1 强制刷新 → 200', r.status === 200 && r.json && r.json.ok && (r.json.servers || []).length > 0);

// 节点动态上下线：强制刷新后重新取当前列表首个节点，避免用已下线的 id 测 node/ovpn 链路
r = await req('/api/servers');
const liveFirst = (r.json && r.json.servers || [])[0] || first;

r = await req('/api/optimize', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
});
const ranked = r.json && r.json.ranked || [];
ok('POST /api/optimize → 优选结果', r.status === 200 && r.json && r.json.ok);
ok('优选返回 topN 达标节点（按配置 8）', Array.isArray(ranked) && ranked.length > 0 && ranked.length <= 8, `ranked=${ranked.length}`);
ok('优选节点字段完整（id/ip/baseScore/score）', !!ranked[0] && !!ranked[0].id && !!ranked[0].ip && ranked[0].baseScore !== undefined && ranked[0].score !== undefined);
ok('服务端不做连通性标记（探测只在浏览器）', ranked.every((x) => x.reachable === undefined));

r = await req('/api/optimize', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ topN: 3, country: liveFirst.countryShort }),
});
ok('POST /api/optimize 覆盖参数（topN=3 + 国家筛选）', r.status === 200 && (r.json.ranked || []).length <= 3);
ok('国家筛选生效', (r.json.ranked || []).every((x) => x.countryShort === liveFirst.countryShort));

r = await req('/api/optimize', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids: [liveFirst.id] }),
});
ok('POST /api/optimize ids 模式（浏览器实测可达集合）→ 只返回该节点', r.status === 200 && (r.json.ranked || []).length <= 1 && (r.json.ranked || []).every((x) => x.id === liveFirst.id));

const nodeId = liveFirst.id;
r = await req(`/api/node?id=${encodeURIComponent(nodeId)}`);
ok('GET /api/node → 节点参数（ip/port/账密）', r.status === 200 && r.json && r.json.ok && r.json.node.ip === liveFirst.ip && r.json.node.authUser === 'vpn');

r = await req(`/api/ovpn?id=${encodeURIComponent(nodeId)}`);
ok('GET /api/ovpn → 生成 .ovpn（含 remote 与 client）', r.status === 200 && r.text.includes('client') && r.text.includes('remote'), `len=${r.text.length}`);
ok('ovpn 响应头为附件下载', (r.headers.get('Content-Disposition') || '').includes('attachment'));

// 免登录 .ovpn 结尾链接：ovpn-url 生成 → 无 Cookie 下载（模拟 OpenVPN Connect 导入）
r = await req(`/api/ovpn-url?id=${encodeURIComponent(nodeId)}`);
const ovpnFileUrl = r.json && r.json.ok ? r.json.url : '';
ok('GET /api/ovpn-url → 返回 .ovpn 结尾链接', r.status === 200 && ovpnFileUrl.includes('.ovpn') && ovpnFileUrl.startsWith('http'), `url=${ovpnFileUrl.slice(0, 80)}...`);
if (ovpnFileUrl) {
  const bare = await fetch(ovpnFileUrl);
  const text = await bare.text();
  ok('免登录 .ovpn 链接（无 Cookie）→ 200 且内容为配置', bare.status === 200 && text.includes('client') && text.includes('remote'), `status=${bare.status} len=${text.length}`);
}

r = await req(`/api/ovpn?id=not-exist-node`);
ok('GET /api/ovpn 未知 id → 404', r.status === 404);

r = await req('/api/probe', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ip: liveFirst.ip }),
});
ok('POST /api/probe → 404（CF 边缘探测接口已移除）', r.status === 404);

r = await req('/api/probe-ovpn', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids: [liveFirst.id] }),
});
ok('POST /api/probe-ovpn → 404（CF 边缘探测接口已移除）', r.status === 404);

r = await req('/api/not-exist');
ok('未知路由 → 404', r.status === 404);

// 存储模式：切仅内存 → 同步回 KV → 恢复自动
r = await req('/api/config/storage', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'memory' }),
});
ok('切换存储模式为 memory → 生效', r.status === 200 && r.json && r.json.storage.mode === 'memory' && r.json.storage.effective === 'memory');

r = await req('/api/config/storage', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'kv' }),
});
ok('切换回 kv 模式并自动同步 → 生效', r.status === 200 && r.json && r.json.storage.mode === 'kv' && r.json.storage.effective === 'kv');

r = await req('/api/config/storage', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'invalid' }),
});
ok('非法存储模式 → 400', r.status === 400);

r = await req('/api/config/storage', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'auto' }),
});
ok('恢复自动模式 → 生效', r.status === 200 && r.json && r.json.storage.mode === 'auto');

r = await req('/api/config/storage/sync', { method: 'POST' });
ok('手动同步内存到 KV → 成功', r.status === 200 && r.json && r.json.ok === true && r.json.storage.effective === 'kv');

r = await req('/api/logs?limit=20');
ok('GET /api/logs → 返回日志（含 login/config-save 等）', r.status === 200 && r.json && r.json.ok && Array.isArray(r.json.logs) && r.json.logs.some((l) => l.act === 'login' || l.act === 'config-save'));

// ==================== D. 登出与会话失效 ====================
section('D. 登出与会话失效');

r = await req('/api/auth/logout', { method: 'POST' });
ok('POST /api/auth/logout → 清除会话', r.status === 200 && r.json && r.json.ok === true && (r.headers.get('Set-Cookie') || '').includes('Max-Age=0'));

jar.cookie = '';
r = await req('/api/health');
ok('登出后访问 API → 401', r.status === 401);

// ==================== 汇总 ====================
console.log(`\n============================================`);
console.log(`端到端测试完成：通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log(`失败项：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('全部通过 ✅');
