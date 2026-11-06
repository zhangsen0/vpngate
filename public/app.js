/**
 * app.js — 前端交互逻辑（无框架，纯静态）
 *
 * 职责：加载配置与服务器列表、表格渲染与排序筛选、节点详情抽屉、
 *       优选结果面板（浏览器本地实测）、配置面板（按服务端 SCHEMA 通用渲染）。
 * 约定：所有业务参数均来自 /api/config；连通性探测只在浏览器内完成，服务端不探测。
 */

'use strict';

// ==================== 全局状态 ====================

const state = {
  config: null,          // 生效配置
  schema: [],            // 配置声明（服务端下发）
  servers: [],           // 轻量服务器列表
  statuses: [],          // 数据源状态
  updatedAt: 0,          // 列表更新时间
  search: '',
  country: '',
  sort: 'score-desc',
  lcOnly: false,         // 仅展示浏览器实测可达的节点
  local: {
    results: {},          // 浏览器实测结果：id → { reachable, rttMs, port, udp, why }
    blocked: new Set(),   // 用户标记「连不上」的节点：本次会话内不再入选
  },
  storage: 'memory',
};

try {
  JSON.parse(sessionStorage.getItem('vpngate.blocked') || '[]').forEach((id) => state.local.blocked.add(id));
} catch { /* 忽略 */ }

/** 标记节点连不上（本次会话内跳过） */
function blockNode(id) {
  state.local.blocked.add(id);
  try { sessionStorage.setItem('vpngate.blocked', JSON.stringify([...state.local.blocked])); } catch { /* 忽略 */ }
}
function clearBlocked() {
  state.local.blocked.clear();
  try { sessionStorage.removeItem('vpngate.blocked'); } catch { /* 忽略 */ }
}

// ==================== 基础工具 ====================

/** 统一 API 请求（401 时跳转登录页） */
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) {
      location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
      throw new Error('未登录');
    }
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  if (data && data.ok === false) throw new Error(data.error || '请求失败');
  return data;
}

/** 退出登录 */
async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  location.href = '/login.html';
}

/** 国家两位码 → 国旗 emoji */
function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** 速度格式化（B/s → Mbps 或 GB/s） */
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '-';
  const mbps = (bps * 8) / 1e6;
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(1)}G`;
  return `${mbps.toFixed(0)}M`;
}

/** 在线时长格式化（小时 → 天/小时） */
function fmtUptime(hours) {
  if (!hours || hours <= 0) return '-';
  if (hours >= 24) return `${Math.round(hours / 24)}天`;
  return `${hours}h`;
}

/** 评分格式化（原始分 → 百万单位显示） */
function fmtScore(score) {
  if (!score) return '-';
  return (score / 1e6).toFixed(1);
}

/** 轻量提示 */
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 2800);
}

/** 转义 HTML */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ==================== 数据加载 ====================

/** 初始化：并行加载配置与服务器列表 */
async function init() {
  bindEvents();
  try {
    const cfgData = await api('/api/config');
    state.config = cfgData.config;
    state.schema = cfgData.schema;
    state.storage = cfgData.storage;
    applyTheme(state.config.ui.theme);
    fillSortOptions();
    await loadServers();
  } catch (e) {
    setStatus(`初始化失败：${e.message}`, 'err');
  }
}

/** 拉取服务器列表 */
async function loadServers(force = false) {
  setStatus(force ? '正在强制刷新…' : '正在拉取节点…', '');
  try {
    const data = await api('/api/servers' + (force ? '?refresh=1' : ''));
    state.servers = data.servers;
    state.statuses = data.statuses;
    state.updatedAt = data.updatedAt;
    fillCountrySelect();
    render();
    const hit = data.cacheHit ? '（缓存）' : '';
    setStatus(`已加载 ${data.total} 个节点${hit}`, 'ok');
  } catch (e) {
    setStatus(`拉取失败：${e.message}`, 'err');
  }
}

function setStatus(text, cls) {
  const el = document.getElementById('statusText');
  el.textContent = text;
  el.className = `status ${cls}`;
}

// ==================== 表格渲染 ====================

/** 当前可见列表（搜索 + 国家 + 排序 + 本机可达过滤） */
function visibleServers() {
  let list = state.servers.slice();
  const kw = state.search.trim().toLowerCase();
  if (kw) {
    list = list.filter((s) =>
      s.ip.toLowerCase().includes(kw) ||
      s.hostname.toLowerCase().includes(kw) ||
      String(s.operator || '').toLowerCase().includes(kw));
  }
  if (state.country) list = list.filter((s) => s.countryShort === state.country);
  if (state.lcOnly) list = list.filter((s) => state.local.results[s.id] && state.local.results[s.id].reachable);
  // 排序
  const cmp = {
    'score-desc': (a, b) => (b.score || 0) - (a.score || 0),
    'ping-asc': (a, b) => (a.pingMs || 99999) - (b.pingMs || 99999),
    'speed-desc': (a, b) => (b.speedBps || 0) - (a.speedBps || 0),
    'uptime-desc': (a, b) => (b.uptimeHours || 0) - (a.uptimeHours || 0),
  }[state.sort] || ((a, b) => (b.score || 0) - (a.score || 0));
  list.sort(cmp);
  return list;
}

function render() {
  renderMeta();
  renderTable();
  renderFoot();
}

function renderMeta() {
  const el = document.getElementById('metaText');
  const t = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : '-';
  const srcs = (state.statuses || [])
    .map((s) => `${s.name}${s.ok ? '' : '(失败)'}`)
    .join(' / ') || '无';
  const st = state.storage;
  const storageTxt = st ? `存储 ${st.effective === 'kv' ? 'KV' : '内存'}${st.degraded ? '(降级)' : ''}` : '';
  el.textContent = `数据源：${srcs} · 更新 ${t}${storageTxt ? ' · ' + storageTxt : ''}`;
}

function renderTable() {
  const tbody = document.getElementById('serverTbody');
  const list = visibleServers();
  document.getElementById('emptyText').hidden = list.length > 0;
  tbody.innerHTML = list.map((s, i) => {
    const lc = state.local.results[s.id];
    const lcChip = !lc
      ? '<span class="chip dim">未测</span>'
      : lc.udp
        ? '<span class="chip warn">UDP 未测</span>'
        : lc.reachable
          ? `<span class="chip ok">本机✓ ${lc.rttMs}ms</span>`
          : `<span class="chip bad">本机✗</span>`;
    return `
      <tr data-id="${esc(s.id)}">
        <td class="num">${i + 1}</td>
        <td><span class="flag">${flagEmoji(s.countryShort)}</span><span class="cc">${esc(s.countryShort)}</span></td>
        <td>
          <div class="ip">${esc(s.ip)}</div>
          <div class="host">${esc(s.hostname)}</div>
        </td>
        <td class="num">${s.pingMs ? s.pingMs + 'ms' : '-'}</td>
        <td class="num">${fmtSpeed(s.speedBps)}</td>
        <td class="num">${fmtScore(s.score)}</td>
        <td class="num">${fmtUptime(s.uptimeHours)}</td>
        <td class="num">${s.sessions || '-'}</td>
        <td>${lcChip}</td>
      </tr>`;
  }).join('');
}

function renderFoot() {
  document.getElementById('footText').textContent =
    `v${(state.config && state.config.version) || 1} · 连通性仅由你的浏览器本地实测 · 共 ${state.servers.length} 个节点`;
}

function fillCountrySelect() {
  const sel = document.getElementById('countrySelect');
  const current = state.country;
  const codes = [...new Set(state.servers.map((s) => s.countryShort).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">全部国家</option>' +
    codes.map((c) => `<option value="${esc(c)}">${flagEmoji(c)} ${esc(c)}</option>`).join('');
  sel.value = current;
}

function fillSortOptions() {
  const opts = [
    ['score-desc', '评分 ↓'],
    ['ping-asc', 'Ping ↑'],
    ['speed-desc', '速度 ↓'],
    ['uptime-desc', '在线时长 ↓'],
  ];
  document.getElementById('sortSelect').innerHTML = opts
    .map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
}

function applyTheme(theme) {
  document.body.dataset.theme = theme || 'dark';
}

// ==================== 节点详情抽屉 ====================

function openDrawer(id) {
  const s = state.servers.find((x) => x.id === id);
  if (!s) return toast('未找到该节点', 'err');
  const lc = state.local.results[s.id];
  const lcLine = !lc
    ? '<div class="section-title">浏览器实测：<span class="chip dim">未测</span>（可用下方「本机探测」或「立即优选」实测）</div>'
    : lc.udp
      ? '<div class="section-title">浏览器实测：<span class="chip warn">UDP 无法探测，需试连</span></div>'
      : lc.reachable
        ? `<div class="section-title">浏览器实测：<span class="chip ok">可达 ${lc.rttMs}ms · 端口 ${lc.port || '-'}</span></div>`
        : '<div class="section-title">浏览器实测：<span class="chip bad">不可达（连接超时）</span></div>';
  const l2tpParams = `服务器 ${s.ip}\n类型 L2TP/IPsec (PSK)\nPSK vpn\n用户名 vpn\n密码 vpn`;
  const l2tpLine = `
    <div class="section-title">L2TP/IPsec 原生参数（系统内置 VPN，免客户端）</div>
    <div class="code-box">${esc(l2tpParams)}</div>
    <div class="row-actions">
      <button class="btn btn-sm" data-act="l2tp-copy" data-text="${esc(l2tpParams)}">复制参数</button>
      <button class="btn btn-sm" data-act="pf" data-id="${esc(s.id)}">各端一键创建</button>
    </div>`;
  const body = document.getElementById('drawerBody');
  body.innerHTML = `
    <dl class="kv">
      <dt>国家</dt><dd><span class="flag">${flagEmoji(s.countryShort)}</span> ${esc(s.countryLong || s.countryShort)}</dd>
      <dt>IP</dt><dd class="mono">${esc(s.ip)}</dd>
      <dt>主机名</dt><dd class="mono">${esc(s.hostname)}</dd>
      <dt>评分</dt><dd>${fmtScore(s.score)}</dd>
      <dt>Ping</dt><dd>${s.pingMs ? s.pingMs + 'ms（VPNGate 测量）' : '-'}</dd>
      <dt>速度</dt><dd>${fmtSpeed(s.speedBps)}</dd>
      <dt>在线</dt><dd>${fmtUptime(s.uptimeHours)}</dd>
      <dt>会话</dt><dd>${s.sessions || '-'}</dd>
      <dt>日志</dt><dd>${esc(s.logType || '-')}</dd>
      <dt>运营商</dt><dd>${esc(s.operator || '-')}</dd>
    </dl>
    ${lcLine}
    ${l2tpLine}
    <div class="section-title">浏览器本地探测（端口 ${(state.config.localProbe.ports || [443]).join('/')}）</div>
    <div class="row-actions">
      <button class="btn" data-act="probe" data-id="${esc(s.id)}">本机探测</button>
      <button class="btn btn-primary" data-act="ovpn" data-id="${esc(s.id)}">下载 .ovpn</button>
      <button class="btn" data-act="pf" data-id="${esc(s.id)}">多端一键</button>
      <button class="btn" data-act="node" data-id="${esc(s.id)}">节点参数</button>
    </div>
    <div id="probeResult"></div>
    <div id="nodeResult"></div>`;
  document.getElementById('drawer').hidden = false;
}

/** 单节点浏览器本地探测（抽屉内「本机探测」按钮） */
async function probeServerById(id) {
  const s = state.servers.find((x) => x.id === id);
  if (!s) return;
  const box = document.getElementById('probeResult');
  box.innerHTML = '<div class="section-title">正在用浏览器直连探测…</div>';
  const lp = state.config.localProbe || {};
  const ports = (lp.ports || [443]).slice(0, 2);
  const r = await probeLocalIp(s.ip, ports, lp.timeoutMs || 3000);
  state.local.results[s.id] = { reachable: r.reachable, rttMs: r.rttMs, port: r.port || ports[0], why: r.why };
  const hint = r.reachable && r.why === 'http'
    ? '<span class="chip warn">疑似网页服务（可能非 OpenVPN）</span>' : '';
  box.innerHTML = r.reachable
    ? `<div class="section-title"><span class="badge ok">本机可达 · 端口 ${r.port} · ${r.rttMs}ms</span>${hint}</div>`
    : '<div class="section-title"><span class="badge bad">本机不可达（连接超时）</span></div>';
  renderTable();
}

async function downloadOvpn(id) {
  try {
    // 先取免登录带 token 链接（服务端同时把该节点写入快照，节点下线后 30 分钟内仍可下载），
    // 再按链接下载——避免直接 /api/ovpn?id= 因列表刷新节点下线而 404。
    const linkRes = await fetch(`/api/ovpn-url?id=${encodeURIComponent(id)}`);
    const linkData = await linkRes.json().catch(() => null);
    if (!linkRes.ok || !linkData || !linkData.url) {
      throw new Error((linkData && linkData.error) || `生成下载链接失败（HTTP ${linkRes.status}）`);
    }
    const res = await fetch(linkData.url);
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      throw new Error((d && d.error) || `HTTP ${res.status}`);
    }
    const text = await res.text();
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="(.+?)"/)?.[1] || `node-${id}.ovpn`;
    const blob = new Blob([text], { type: 'application/x-openvpn-profile' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('配置已下载', 'ok');
  } catch (e) {
    toast(`下载失败：${e.message}`, 'err');
  }
}

async function showNodeParams(id) {
  const box = document.getElementById('nodeResult');
  box.innerHTML = '<div class="section-title">加载中…</div>';
  try {
    const data = await api(`/api/node?id=${encodeURIComponent(id)}`);
    const n = data.node;
    const lines = [
      `# ${n.remark}`,
      `类型: openvpn`,
      `地址: ${n.ip}:${n.port || '443'} (${n.proto || 'tcp'})`,
      `用户名: ${n.authUser}  密码: ${n.authPass}`,
      `国家: ${n.country}`,
    ].join('\n');
    box.innerHTML = `
      <div class="section-title">节点参数（可复制）</div>
      <div class="code-box">${esc(lines)}</div>
      <div class="row-actions">
        <button class="btn" data-act="copy-node">复制参数</button>
      </div>`;
    box.querySelector('[data-act="copy-node"]').addEventListener('click', () => {
      navigator.clipboard.writeText(lines).then(
        () => toast('已复制', 'ok'),
        () => toast('复制失败', 'err'));
    });
  } catch (e) {
    box.innerHTML = `<div class="section-title"><span class="badge bad">${esc(e.message)}</span></div>`;
  }
}

// ==================== 优选面板 ====================
/**
 * 「立即优选」一站式流程（唯一探测途径 = 浏览器页面内直连，未经 Cloudflare 边缘）：
 *  1. 从已加载的全量节点按评分取前 localProbe.maxNodes 个；
 *  2. 浏览器 fetch(no-cors) 直连各节点实际 TCP 端口，筛出本机可达集合；
 *  3. POST /api/optimize { ids } 由服务端按配置权重重新评分排序后渲染；
 *  4. 未启用实测或 0 可达时回退展示静态评分结果并提示。
 * 服务端只做纯计算，因此不存在探测超时问题。
 */
async function runOptimize() {
  const body = document.getElementById('optBody');
  document.getElementById('optMask').hidden = false;
  const lp = state.config.localProbe || {};

  /** 请求服务端按配置筛选/评分/排序；ids 非空时只排浏览器实测可达集合 */
  const rank = async (ids) => {
    const d = await api('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids ? { ids } : {}),
    });
    return d.ranked || [];
  };

  if (lp.enabled === false) {
    body.innerHTML = '<div class="empty">正在按配置评分…</div>';
    try {
      renderOptCards(await rank(null), { mode: 'static' });
    } catch (e) {
      body.innerHTML = `<div class="empty">优选失败：${esc(e.message)}</div>`;
    }
    return;
  }

  const maxNodes = Math.max(5, Math.min(500, lp.maxNodes || 120));
  const pool = [...state.servers]
    .filter((s) => s.ip && !state.local.blocked.has(s.id))
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (a.pingMs || 1e9) - (b.pingMs || 1e9))
    .slice(0, maxNodes);
  if (!pool.length) {
    body.innerHTML = '<div class="empty">暂无节点，请先点击「强制刷新」拉取数据源。</div>';
    return;
  }

  const ports = (lp.ports || [443]).slice(0, 2);
  const timeoutMs = lp.timeoutMs || 3000;
  body.innerHTML = `
    <div class="section-title">🔍 浏览器本地实测中（共 ${pool.length} 个节点，按实际端口直连）…</div>
    <div class="probe-bar"><div class="probe-bar-inner" id="probeBarInner" style="width:0%"></div></div>
    <div class="empty" id="probeStatus">已测 0 / ${pool.length}，本机可达 0…</div>`;
  const barInner = document.getElementById('probeBarInner');
  const statusEl = document.getElementById('probeStatus');

  // 浏览器对跨源 fetch 有并发限制，用 8 个 worker 循环处理
  let idx = 0, done = 0, okCount = 0, udpCount = 0;
  const tick = () => {
    barInner.style.width = Math.round((done / pool.length) * 100) + '%';
    statusEl.textContent = `已测 ${done} / ${pool.length}，本机可达 ${okCount}，UDP 未测 ${udpCount}，超时 ${done - okCount - udpCount}…`;
  };
  const CONC = 8;
  await Promise.all(Array.from({ length: Math.min(CONC, pool.length) }, async () => {
    while (idx < pool.length) {
      const s = pool[idx++];
      let r = await probeLocalServer(s, ports, timeoutMs);
      // 单次超时可能只是网络抖动，补测一次再判不可达（只对超时节点重试，不拖慢整体）
      if (!r.reachable && !r.udp && r.why === 'timeout') {
        r = await probeLocalServer(s, ports, timeoutMs);
      }
      state.local.results[s.id] = r;
      done++;
      if (r.reachable) okCount++;
      else if (r.udp) udpCount++;
      if (done % 5 === 0 || done === pool.length) tick();
    }
  }));
  tick();
  renderTable();

  const reachableIds = [];
  const udpCandidates = [];
  pool.forEach((s) => {
    const r = state.local.results[s.id];
    if (r.reachable) reachableIds.push(s.id);
    else if (r.udp) udpCandidates.push(s);
  });

  try {
    if (!reachableIds.length) {
      renderOptCards(await rank(null), { mode: 'static' });
      body.insertAdjacentHTML('afterbegin', `<div class="empty" style="color:var(--err,#e5484d);margin-bottom:8px">
        ⚠️ 浏览器实测 ${pool.length} 个节点 TCP 全部超时（另有 ${udpCount} 个 UDP 节点无法探测），已展示静态评分结果；
        这些节点本机可能连不上。可切换网络（WiFi↔流量）、增大实测节点上限或稍后再试。</div>`);
      return;
    }
    let list = await rank(reachableIds);
    // 综合排序：静态评分 × 本机实测 RTT 惩罚 × 服务类型惩罚。
    // 响应越慢越靠后；端口返回完整网页响应（疑似非 OpenVPN 服务）的节点大幅降权。
    const finalScore = (r) => {
      const lr = state.local.results[r.id];
      const rtt = lr && lr.rttMs != null ? lr.rttMs : 9999;
      const typeF = lr && lr.why === 'http' ? 0.35 : 1;
      return (r.score || 0) * (1000 / (1000 + rtt)) * typeF;
    };
    const maxRtt = Math.max(0, Number(lp.maxRttMs) || 0);
    if (maxRtt > 0) {
      const kept = list.filter((r) => {
        const lr = state.local.results[r.id];
        return !lr || lr.rttMs == null || lr.rttMs <= maxRtt;
      });
      if (kept.length) list = kept; // 全被过滤时保留原结果，避免空列表
    }
    list.sort((a, b) => finalScore(b) - finalScore(a));
    const maxUdp = Math.max(0, Math.min(50, lp.maxUdpCandidates || 8));
    if (maxUdp > 0 && udpCandidates.length) {
      // UDP 端口浏览器无法探测，附带展示评分前 N 个候选供试连
      list.push(...udpCandidates
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, maxUdp)
        .map((s) => ({
          id: s.id, hostname: s.hostname, ip: s.ip, countryShort: s.countryShort,
          port: s.port, proto: s.proto, speedBps: s.speedBps, uptimeHours: s.uptimeHours,
          baseScore: 0, score: 0, udp: true,
        })));
    }
    renderOptCards(list, { mode: 'local' });
    body.insertAdjacentHTML('afterbegin', `<div class="section-title" style="color:var(--ok,#30a46c)">
      ✅ 浏览器实测 ${pool.length} 个节点：TCP 可达 ${reachableIds.length} 个，已按「静态评分 + 本机实测延迟 + 服务类型」综合重排
      ${maxUdp > 0 && udpCandidates.length ? `；另附 ${Math.min(maxUdp, udpCandidates.length)} 个 UDP 候选（标「UDP 未测·试连」）` : ''}。</div>`);
  } catch (e) {
    body.innerHTML = `<div class="empty">优选失败：${esc(e.message)}</div>`;
  }
}

/** 渲染优选结果卡片（可达性标记统一取自 state.local.results 的浏览器实测结果） */
function renderOptCards(ranked, data) {
  // 渲染时按黑名单过滤，但闭包保留完整列表，点「恢复」即可还原
  const shown = ranked.filter((r) => !state.local.blocked.has(r.id));
  const chipOf = (id) => {
    const r = state.local.results[id];
    if (!r) return '<span class="chip dim">本机未测</span>';
    if (r.udp) return '<span class="chip warn" title="UDP 端口浏览器无法探测，需试连">UDP 未测·试连</span>';
    if (!r.reachable) return '<span class="chip bad">本机✗ 超时</span>';
    if (r.why === 'http') return `<span class="chip warn" title="端口返回了完整网页响应，可能不是 OpenVPN 服务，已在排序中降权">本机✓ ${r.rttMs}ms · 疑似网页服务</span>`;
    return `<span class="chip ok" title="TLS/协议不匹配（符合 OpenVPN 服务特征），TCP 可达">本机✓ ${r.rttMs}ms</span>`;
  };
  const body = document.getElementById('optBody');
  body.innerHTML = `
    <div class="section-title">${data.mode === 'local'
      ? `浏览器实测可达节点（共 ${shown.length} 个，按综合评分排序）`
      : `静态评分前 ${shown.length} 个节点（未启用实测或本机无可达节点时展示）`}</div>
    <div class="row-actions" style="margin-bottom:10px">
      <button class="btn btn-primary" data-act="opt-probe">🔍 重新实测</button>
      ${state.local.blocked.size ? `<button class="btn" data-act="opt-clear-blocked">恢复已跳过的 ${state.local.blocked.size} 个节点</button>` : ''}
    </div>
    ${shown.map((r, i) => {
      const lr = state.local.results[r.id];
      const rttShow = lr && lr.rttMs != null ? `${lr.rttMs}ms` : (lr && lr.udp ? '需试连' : '-');
      const portShow = (lr && lr.port) || r.port || '-';
      return `
      <div class="opt-card">
        <div class="opt-rank">${i + 1}</div>
        <div class="opt-main">
          <div class="row1"><span class="flag">${flagEmoji(r.countryShort)}</span><span class="ip">${esc(r.ip)}</span>
            <span class="badge ok">${esc(r.hostname)}</span>${chipOf(r.id)}</div>
          <div class="row2">速度 <b>${fmtSpeed(r.speedBps)}</b> · 端口 ${portShow} · ${(r.proto || '').toUpperCase() || '-'} · 在线 ${fmtUptime(r.uptimeHours)} · 基础分 ${(r.baseScore || 0).toFixed(3)} → ${(r.score || 0).toFixed(3)}</div>
        </div>
        <div class="opt-meta">
          <div class="rtt">${rttShow}</div>
          <div style="margin-top:4px;display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-sm" data-act="opt-block" data-id="${esc(r.id)}" title="试连失败后点这里，本次会话不再推荐该节点">连不上</button>
            <button class="btn btn-sm" data-act="opt-pf" data-id="${esc(r.id)}">多端</button>
            <button class="btn btn-sm" data-act="opt-ovpn" data-id="${esc(r.id)}">下载配置</button>
          </div>
        </div>
      </div>`;
    }).join('')}
    <div class="section-title">「重新实测」用你的浏览器直连各节点实际 TCP 端口（不另开窗口）：
      仅连接超时判为不可达，超时节点自动补测一次；UDP 端口浏览器无法探测，标注「UDP 未测·试连」。
      结果按 <b>静态评分 × 本机实测延迟 × 服务类型</b> 综合排序：延迟高的自动靠后；
      端口返回完整网页响应（标「疑似网页服务」）的节点大概率没跑 OpenVPN，已降权。
      ⚠️ <b>浏览器只能验证 TCP 端口可达</b>：无法发 OpenVPN 协议包、无法验证账密/认证、无法测 UDP，
      所以「本机✓」不等于一定能连上（节点也可能刚下线）。连不上时点卡片「连不上」跳过（本次会话不再入选），
      换下一个试试，或改用「🔐 L2TP 原生」（SoftEther 默认开启 L2TP/IPsec，国内网络普遍可连）。</div>`;
  document.querySelectorAll('[data-act="opt-ovpn"]').forEach((btn) => {
    btn.addEventListener('click', () => downloadOvpn(btn.dataset.id));
  });
  document.querySelectorAll('[data-act="opt-pf"]').forEach((btn) => {
    btn.addEventListener('click', () => openPlatformModal(btn.dataset.id));
  });
  document.querySelectorAll('[data-act="opt-block"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      blockNode(btn.dataset.id);
      renderOptCards(ranked, data);
      toast('已跳过该节点，下次实测也不会入选（本次会话）', 'ok');
    });
  });
  const clearBtn = document.querySelector('[data-act="opt-clear-blocked"]');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    clearBlocked();
    renderOptCards(ranked, data);
    toast('已恢复被跳过的节点', 'ok');
  });
  const probeBtn = document.querySelector('[data-act="opt-probe"]');
  if (probeBtn) probeBtn.addEventListener('click', runOptimize);
}

/** 对单个 IP 做浏览器直连 TCP 探测（https 探测：TLS 失败但 TCP 建立 = 端口有服务） */
async function probeLocalIp(ip, ports, timeoutMs) {
  for (const port of ports) {
    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      await fetch(`https://${ip}:${port}/`, {
        mode: 'no-cors', cache: 'no-store', signal: ctrl.signal, referrerPolicy: 'no-referrer',
      });
      clearTimeout(timer);
      // 端口返回了完整 HTTPS 响应 → 大概率是网页/管理服务，而非 OpenVPN（结果中降权标注）
      return { reachable: true, rttMs: Math.round(performance.now() - t0), port, why: 'http' };
    } catch (e) {
      clearTimeout(timer);
      const dt = Math.round(performance.now() - t0);
      // 只有超时才是真正的不可达（TCP 未建立：被墙/丢包/端口无响应）。
      // 任何非超时的失败（无论快慢）都发生在 TCP 建立之后——
      // 说明端口有服务在响应（OpenVPN 收到非协议请求后断开、TLS/证书不匹配等）→ 视为可达，
      // 且这种「TLS/协议不匹配」比返回网页响应更符合 OpenVPN 服务特征，优先推荐。
      if (e.name === 'AbortError' || e.name === 'TimeoutError') continue; // 超时，试下一端口
      return { reachable: true, rttMs: dt, port, why: 'tls' };
    }
  }
  return { reachable: false, rttMs: null, why: 'timeout' };
}

/**
 * 按节点实际 OpenVPN 端口/协议探测：
 * - TCP（或未解析出协议）：浏览器直连实际端口（默认端口兜底），可达/超时；
 * - UDP：浏览器无法发 UDP 探测，返回 udp:true 标记「未测·试连」。
 */
async function probeLocalServer(s, fallbackPorts, timeoutMs) {
  const proto = (s.proto || '').toLowerCase();
  const port = s.port || fallbackPorts[0];
  if (proto === 'udp') return { reachable: null, udp: true, port, why: 'udp' };
  const r = await probeLocalIp(s.ip, [port, ...fallbackPorts.filter((p) => p !== port)], timeoutMs);
  return { ...r, port: r.port || port };
}

// ==================== 配置面板 ====================

/** 把点分路径值写入对象 */
function setPath(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]];
  node[parts[parts.length - 1]] = value;
}

/** 通用配置表单渲染（依据服务端 SCHEMA） */
function renderConfigForm() {
  const groups = {};
  for (const item of state.schema) {
    (groups[item.group] = groups[item.group] || []).push(item);
  }
  const body = document.getElementById('cfgBody');
  body.innerHTML = `
    <div class="cfg-group">
      <h4>配置存储</h4>
      <div class="cfg-row">
        <label>存储模式</label>
        <div>
          <div class="storage-mode" data-storage-mode>
            <label><input type="radio" name="storageMode" value="auto" ${state.storage.mode === 'auto' ? 'checked' : ''} /> 自动（KV 优先，故障降级内存）</label>
            <label><input type="radio" name="storageMode" value="memory" ${state.storage.mode === 'memory' ? 'checked' : ''} /> 仅内存（不读写 KV）</label>
            <label><input type="radio" name="storageMode" value="kv" ${state.storage.mode === 'kv' ? 'checked' : ''} /> 仅 KV（KV 故障时降级内存并告警）</label>
          </div>
          <div class="cfg-hint">当前生效：<b>${state.storage.effective === 'kv' ? 'KV' : '内存'}</b>
            ${state.storage.degraded ? '<span class="chip bad">已自动降级（KV 不可用）</span>' : ''}
            ${state.storage.effective === 'memory' && state.storage.kvAvailable && state.storage.mode !== 'memory' ? ' · <span class="chip ok">KV 已恢复，可手动同步</span>' : ''}</div>
        </div>
      </div>
      <div class="cfg-row" style="border:none;padding-bottom:0">
        <label></label>
        <div class="row-actions" style="margin:0">
          <button class="btn btn-sm" id="btnApplyStorage">应用存储模式</button>
          <button class="btn btn-sm" id="btnSyncKv" ${state.storage.effective === 'kv' ? 'disabled' : ''}
            title="${state.storage.effective === 'kv' ? '当前即 KV 存储，无需同步' : 'KV 恢复后把内存配置手动写入 KV'}">同步内存到 KV</button>
        </div>
      </div>
    </div>
    ${Object.keys(groups).map((g) => `
    <div class="cfg-group">
      <h4>${esc(g)}</h4>
      ${groups[g].map((it) => cfgRowHtml(it)).join('')}
    </div>`).join('')}`;
  // 绑定输入变更 → 写入本地 state.config
  body.querySelectorAll('[data-path]').forEach((el) => {
    el.addEventListener('input', () => {
      const path = el.dataset.path;
      const item = state.schema.find((x) => x.key === path);
      if (!item) return;
      const v = cfgReadValue(el, item);
      setPath(state.config, path, v);
    });
  });
  // 存储模式操作
  document.getElementById('btnApplyStorage').addEventListener('click', async () => {
    const mode = document.querySelector('input[name="storageMode"]:checked').value;
    try {
      const data = await api('/api/config/storage', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      state.storage = data.storage;
      renderConfigForm();
      renderMeta();
      toast(data.error ? `已切换（${data.error}）` : `已切换为「${mode}」模式`, data.error ? 'err' : 'ok');
    } catch (e) {
      toast(`切换失败：${e.message}`, 'err');
    }
  });
  document.getElementById('btnSyncKv').addEventListener('click', async () => {
    try {
      const data = await api('/api/config/storage/sync', { method: 'POST' });
      state.storage = data.storage;
      renderConfigForm();
      renderMeta();
      toast('内存配置已同步到 KV', 'ok');
    } catch (e) {
      toast(`同步失败：${e.message}`, 'err');
    }
  });
}

function cfgRowHtml(it) {
  const val = it.key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), state.config);
  const hint = it.hint ? `<div class="cfg-hint">${esc(it.hint)}</div>` : '';
  let input = '';
  if (it.type === 'boolean') {
    input = `<select data-path="${esc(it.key)}">
      <option value="true" ${val ? 'selected' : ''}>开启</option>
      <option value="false" ${val ? '' : 'selected'}>关闭</option>
    </select>`;
  } else if (it.options) {
    input = `<select data-path="${esc(it.key)}">` +
      it.options.map((o) => `<option value="${esc(o)}" ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('') +
      `</select>`;
  } else if (it.type === 'arrayNumber' || it.type === 'arrayString') {
    input = `<textarea data-path="${esc(it.key)}" data-arr="1">${esc(Array.isArray(val) ? JSON.stringify(val) : '[]')}</textarea>`;
  } else if (it.type === 'text') {
    input = `<textarea data-path="${esc(it.key)}">${esc(typeof val === 'string' ? val : JSON.stringify(val, null, 1))}</textarea>`;
  } else {
    const num = it.type === 'int' || it.type === 'number';
    input = `<input type="${num ? 'number' : 'text'}" data-path="${esc(it.key)}"
      value="${esc(val)}" ${num ? `step="${it.step || (it.type === 'int' ? 1 : 'any')}" min="${it.min ?? ''}" max="${it.max ?? ''}"` : ''} />`;
  }
  return `
    <div class="cfg-row">
      <label>${esc(it.label)}${it.unit ? ` <span class="cfg-hint">(${esc(it.unit)})</span>` : ''}</label>
      <div>${input}${hint}</div>
      <div class="cfg-hint">${esc('默认: ' + (typeof val === 'object' ? JSON.stringify(val) : val))}</div>
    </div>`;
}

function cfgReadValue(el, item) {
  if (el.dataset.arr) {
    try { return JSON.parse(el.value); } catch { return []; }
  }
  if (item.type === 'boolean') return el.value === 'true';
  if (item.type === 'int') return Number.parseInt(el.value, 10) || 0;
  if (item.type === 'number') return Number.parseFloat(el.value) || 0;
  return el.value;
}

async function saveConfigForm() {
  try {
    const data = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.config),
    });
    state.config = data.config;
    applyTheme(data.config.ui.theme);
    if (data.errors && data.errors.length) {
      toast(`已保存，但：${data.errors.join('；')}`, 'err');
    } else {
      toast('配置已保存', 'ok');
    }
    document.getElementById('cfgMask').hidden = true;
    renderFoot();
  } catch (e) {
    toast(`保存失败：${e.message}`, 'err');
  }
}

async function resetConfigForm() {
  try {
    const data = await api('/api/config/reset', { method: 'POST' });
    state.config = data.config;
    applyTheme(data.config.ui.theme);
    renderConfigForm();
    toast('已恢复默认配置', 'ok');
  } catch (e) {
    toast(`恢复失败：${e.message}`, 'err');
  }
}

// ==================== 多端一键使用 ====================
/**
 * 为单个节点生成“多端一键使用”面板：
 *  - iOS/Android：移动端文件关联一步打开（OpenVPN Connect）；
 *  - Windows/macOS/Linux：下载 + 一条命令完成导入/连接（需安装对应 OpenVPN 客户端）。
 */

function ovpnUrl(id) {
  // 必须返回完整绝对 URL：复制链接 / 多端 curl 命令在用户本机或手机浏览器使用时，
  // 相对路径（无协议+域名）无法访问；以 .ovpn 结尾便于 OpenVPN Connect 等客户端
  // 按扩展名识别为配置文件（避免被当作"服务器地址"直连导致导入失败）
  return `${location.origin}/api/ovpn-file/${encodeURIComponent(id)}.ovpn`;
}

/** 复制文本到剪贴板 */
async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || '已复制', 'ok');
  } catch {
    toast('复制失败，请手动复制', 'err');
  }
}

/**
 * 各端「创建命令」及其副作用说明与删除命令（多端面板 + 主页使用说明共用）。
 * @param {string} label - 连接名/文件名（vpngate-XX-1.2.3.4）
 * @param {string} ip - 节点 IP
 * @param {string} url - .ovpn 下载链接
 */
function pfCmds(label, ip, url) {
  const L = esc(label);
  return {
    winL2tpCreate: {
      title: 'Windows L2TP 创建命令（管理员 PowerShell）',
      cmd: `New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\PolicyAgent" -Name AssumeUDPEncapsulationContext -Value 2 -PropertyType DWORD -Force | Out-Null; Add-VpnConnection -Name "${label}" -ServerAddress ${ip} -TunnelType L2tp -L2tpPsk "vpn" -AuthenticationMethod PAP -EncryptionLevel Optional -Force -RememberCredential`,
      creates: `① 注册表值 <code>HKLM\\SYSTEM\\CurrentControlSet\\Services\\PolicyAgent\\AssumeUDPEncapsulationContext = 2</code>（NAT-T 补丁，<b>-Force 会覆盖原有值</b>）；② 系统 VPN 连接「<b>${L}</b>」（写入 rasphone.pbk）；③ <code>-RememberCredential</code> 记住的账密（Windows 凭据管理器）。`,
      cleanup: `rasdial "${label}" /disconnect; Remove-VpnConnection -Name "${label}" -Force; Remove-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\PolicyAgent" -Name AssumeUDPEncapsulationContext -Force`,
      cleanupNote: `需<b>管理员 PowerShell</b>。若该注册表值原本就存在（非本工具创建），请手动改回原值而不是删除；记住的凭据在「控制面板 → 凭据管理器 → Windows 凭据」中删除对应条目。`,
    },
    winL2tpConnect: {
      title: 'Windows L2TP 连接命令',
      cmd: `rasdial "${label}" vpn vpn`,
      creates: `只建立一次 VPN 拨号会话，<b>不新增任何持久配置或文件</b>。`,
      cleanup: `rasdial "${label}" /disconnect`,
      cleanupNote: `断开后无残留；若连上后不想保留该 VPN 连接，用上面「Windows L2TP 创建命令」配套的删除命令移除。`,
    },
    linuxL2tpCreate: {
      title: 'Linux L2TP 创建命令（NetworkManager）',
      cmd: `sudo apt install network-manager-l2tp && nmcli connection add type l2tp con-name "${label}" l2tp.gateway ${ip} l2tp.username vpn l2tp.password vpn ipsec.psk vpn ipsec.enable yes && nmcli connection up "${label}"`,
      creates: `① 用 apt 安装软件包 <code>network-manager-l2tp</code>（及依赖 strongswan / xl2tpd 等）；② NetworkManager 连接「<b>${L}</b>」，一般在 <code>/etc/NetworkManager/system-connections/${L}.nmconnection</code>（含 PSK 与账密）；③ 连接时产生的虚拟网卡与路由（断开即消失）。`,
      cleanup: `nmcli connection down "${label}" 2>/dev/null; nmcli connection delete "${label}" 2>/dev/null; rm -f "/etc/NetworkManager/system-connections/${label}.nmconnection" 2>/dev/null; echo "已删除连接 ${label}"`,
      cleanupNote: `删除连接即可清掉配置，<b>不要</b>随意 <code>apt remove network-manager-l2tp</code>（会影响其它 L2TP 连接）；确需卸载用 <code>sudo apt remove -y network-manager-l2tp && sudo apt autoremove -y</code>。`,
    },
    winOvpnDownload: {
      title: 'Windows OpenVPN 下载/导入命令（PowerShell）',
      cmd: `curl.exe -L -o "%TEMP%\\${label}.ovpn" "${url}" && start "" "%TEMP%\\${label}.ovpn"`,
      creates: `① 文件 <code>%TEMP%\\${L}.ovpn</code>（即 <code>C:\\Users\\&lt;用户名&gt;\\AppData\\Local\\Temp\\${L}.ovpn</code>）；② <code>start</code> 会用关联的 OpenVPN 客户端打开，若用 <b>OpenVPN GUI 导入</b>，还会在 <code>%USERPROFILE%\\OpenVPN\\config\\</code> 或 <code>C:\\Program Files\\OpenVPN\\config\\</code> 生成同名配置并注册 profile。`,
      cleanup: `Remove-Item "$env:TEMP\\${label}.ovpn" -Force -ErrorAction SilentlyContinue; Remove-Item "$env:USERPROFILE\\OpenVPN\\config\\${label}.ovpn" -Force -ErrorAction SilentlyContinue; Remove-Item "C:\\Program Files\\OpenVPN\\config\\${label}.ovpn" -Force -ErrorAction SilentlyContinue`,
      cleanupNote: `另需在客户端（OpenVPN GUI / Connect）里删除已导入的 profile。若创建命令在 PowerShell 5.x 下 <code>%TEMP%</code> 未展开，文件会落在当前目录，请一并手动删除。`,
    },
    macOvpnDownload: {
      title: 'macOS OpenVPN 下载/导入命令（终端）',
      cmd: `curl -L -o ~/Downloads/${label}.ovpn "${url}" && open ~/Downloads/${label}.ovpn`,
      creates: `① 文件 <code>~/Downloads/${L}.ovpn</code>；② <code>open</code> 触发客户端导入（Tunnelblick 复制到 <code>~/Library/Application Support/Tunnelblick/Configurations/</code>，OpenVPN Connect 存到自身配置库）。`,
      cleanup: `rm -f ~/Downloads/${label}.ovpn`,
      cleanupNote: `另需在客户端里删除已导入的 profile（Tunnelblick 删除上面对应目录里的 <code>.tblk</code>）。`,
    },
    linuxOvpnImport: {
      title: 'Linux OpenVPN 原生创建命令（NetworkManager）',
      cmd: `curl -L -o ~/${label}.ovpn "${url}" && nmcli connection import type openvpn file ~/${label}.ovpn`,
      creates: `① 文件 <code>~/${L}.ovpn</code>；② NetworkManager 连接「<b>${L}</b>」（<code>/etc/NetworkManager/system-connections/${L}.nmconnection</code>，含配置与账密）。`,
      cleanup: `nmcli connection down "${label}" 2>/dev/null; nmcli connection delete "${label}" 2>/dev/null; rm -f ~/${label}.ovpn`,
      cleanupNote: `先断开、再删连接、最后删下载的文件；<code>2&gt;/dev/null</code> 用于忽略「连接不存在」的提示。`,
    },
    linuxOvpnCli: {
      title: 'Linux OpenVPN CLI 连接命令（不写系统配置）',
      cmd: `curl -L -o ~/${label}.ovpn "${url}" && sudo openvpn --config ~/${label}.ovpn`,
      creates: `仅文件 <code>~/${L}.ovpn</code> 与一个前台 <code>openvpn</code> 进程；运行期间临时创建 tun 网卡与路由，<b>Ctrl+C 退出后自动消失，不写入任何系统配置</b>。`,
      cleanup: `rm -f ~/${label}.ovpn`,
      cleanupNote: `先在终端按 <b>Ctrl+C</b> 结束进程，再删文件即可，无需 sudo 清理。`,
    },
  };
}

/** 渲染一条命令：命令本体 + 创建了什么 + 删除命令 */
function pfCmdBlockHtml(c) {
  return `
    <div class="pf-cmd-block">
      <div class="pf-cmd-label">${c.title}</div>
      <div class="pf-cmd">
        <div class="code-box">${esc(c.cmd)}</div>
        <button class="btn btn-sm" data-pf-copy="${esc(c.cmd)}">复制</button>
      </div>
      ${c.creates ? `<div class="pf-creates"><b>创建了：</b>${c.creates}</div>` : ''}
      ${c.cleanup ? `<div class="pf-cleanup">
        <div class="pf-cleanup-label">🗑 删除命令（配置用不上时清理）</div>
        <div class="pf-cmd">
          <div class="code-box">${esc(c.cleanup)}</div>
          <button class="btn btn-sm" data-pf-copy="${esc(c.cleanup)}">复制</button>
        </div>
        ${c.cleanupNote ? `<div class="pf-note">${c.cleanupNote}</div>` : ''}
      </div>` : ''}
    </div>`;
}

/** 平台面板模板（url: 配置下载地址，label: 文件名） */
function pfPanelHtml(platform, url, label) {
  const ip = label.replace(/^vpngate-[A-Za-z]{2}-/, '');
  const C = pfCmds(label, ip, url);
  const panels = {
    l2tp: {
      tab: '🔐 L2TP 原生',
      title: 'L2TP/IPsec（系统原生 · 无需第三方客户端）',
      steps: [
        `<b>推荐优先使用</b>：OpenVPN 连不上时（运营商干扰/节点未启用），L2TP/IPsec 走 UDP/ESP 国内普遍可连。VPNGate 节点由 SoftEther 驱动，普遍开放 <b>L2TP/IPsec</b>：服务器 <b>${ip}</b>，PSK <b>vpn</b>，账密 <b>vpn / vpn</b>。`,
        `<b>iOS</b>：设置 → 通用 → VPN 与设备管理 → 添加 VPN → 类型选 <b>L2TP/IPSec</b> → 填上述参数 → 连接。`,
        `<b>Android</b>：设置 → 网络与互联网 → VPN → 添加 → 类型选 <b>L2TP/IPSec PSK</b> → 填参数 → 连接（部分新系统已移除 L2TP 选项）。`,
        `<b>macOS</b>：系统设置 → 网络 → VPN → 添加 → 类型 <b>L2TP over IPsec</b> → 填参数 → 连接。`,
        `部分节点可能未启用 L2TP，连接失败时换 OpenVPN 方式或换节点。`,
      ],
      // Windows 原生 L2TP 需注册表 AssumeUDPEncapsulationContext=2（国内 NAT 环境），否则默认直连失败
      cmds: [C.winL2tpCreate, C.winL2tpConnect, C.linuxL2tpCreate],
    },
    mobile: {
      tab: '📱 iOS / Android',
      title: 'iOS / Android（OpenVPN Connect）',
      steps: [
        `<b>①</b> 点下方「下载配置」保存 .ovpn（手机浏览器直接下载）；`,
        `<b>②</b> 打开 OpenVPN Connect →「Get connected」→ 切到「<b>Upload File</b>」标签 → 选择刚下载的 .ovpn 文件 → Import；`,
        `<b>③</b> 或直接在「文件/下载」中点该 .ovpn →「用 OpenVPN Connect 打开」→ 导入；`,
        `<b>④</b> 连接时账密输入 <b>vpn / vpn</b>（勾选 Import autologin profile 可免密）。`,
        `⚠️ 不要用 URL 标签粘贴链接：那是「服务器地址/Cloud ID」入口，不支持 .ovpn 配置下载。`,
        `<b>Android 高版本用 L2TP</b>：安装开源客户端 <b>TunnelForge</b>（GitHub evokelektrique/tunnel-forge，F-Droid/APK 均可，无需 ROOT）→ 新建配置：服务器=${ip}、IPsec PSK=<b>vpn</b>、账密 vpn/vpn → 连接。`,
        `<b>Android 原生参考（无 L2TP 选项时）</b>：设置 → VPN → 添加 → 类型 <b>IKEv2/IPsec MSCHAPv2</b> → 服务器=${ip}、用户名/密码 <b>vpn / vpn</b> → 连接（SoftEther 默认开放 IKEv2）；或类型 <b>IKEv2/IPsec PSK</b> → 密钥 <b>vpn</b>。`,
        `<b>用不上时清理</b>：在客户端里删除已导入的 profile，并删除手机「下载」目录中的 ${esc(label)}.ovpn 文件；系统原生 L2TP/IKEv2 在系统 VPN 设置里删除该配置即可。`,
      ],
      cmds: [],
    },
    windows: {
      tab: '🪟 Windows',
      title: 'Windows（OpenVPN GUI / Connect）',
      steps: [
        `<b>①</b> 在 PowerShell 中运行下方命令（自动下载并打开导入）；`,
        `<b>②</b> 已安装并关联 .ovpn 时自动弹出导入窗口，点击导入即可；`,
        `<b>③</b> 连接时账密输入 <b>vpn / vpn</b>。`,
        `更推荐「🔐 L2TP 原生」标签页：Windows 内置 VPN 支持，一条命令创建。`,
      ],
      cmds: [C.winOvpnDownload],
    },
    macos: {
      tab: '🍎 macOS',
      title: 'macOS（Tunnelblick / OpenVPN Connect）',
      steps: [
        `<b>①</b> 在终端运行下方命令（自动下载并打开导入）；`,
        `<b>②</b> 已安装 Tunnelblick 或 OpenVPN Connect 时自动完成导入；`,
        `<b>③</b> 连接时账密输入 <b>vpn / vpn</b>。`,
        `更推荐「🔐 L2TP 原生」标签页：系统设置 → 网络 → VPN → L2TP over IPsec。`,
      ],
      cmds: [C.macOvpnDownload],
    },
    linux: {
      tab: '🐧 Linux',
      title: 'Linux（NetworkManager 原生创建 / openvpn CLI）',
      steps: [
        `<b>①</b> 原生创建（推荐）：L2TP 用「🔐 L2TP 原生」标签页命令（network-manager-l2tp），或 OpenVPN 用下方 nmcli 导入；`,
        `<b>②</b> 连接：<b>nmcli connection up ${label}</b>；断开：<b>nmcli connection down ${label}</b>；`,
        `<b>③</b> 无桌面环境时用第二条命令（openvpn CLI）连接，账密输入 <b>vpn / vpn</b>，Ctrl+C 断开。`,
      ],
      cmds: [C.linuxOvpnImport, C.linuxOvpnCli],
    },
    guide: {
      tab: '📖 使用说明',
      title: '全客户端使用说明（OpenVPN / L2TP · 详细步骤）',
      noCmd: true, // 纯文档面板：不渲染下载配置与命令按钮（内容含命令由复制按钮提供）
      steps: fullGuideSteps(ip),
    },
  };
  const key = platform && panels[platform] ? platform : 'l2tp';
  const p = panels[key];
  const tabHtml = Object.values(panels).map((x, i) =>
    `<button class="pf-tab ${x === p ? 'active' : ''}" data-pf-tab="${Object.keys(panels)[i]}">${x.tab}</button>`).join('');
  const panelHtml = Object.entries(panels).map(([k, x]) => {
    const cmds = x.noCmd ? '' : `
      <div class="row-actions" style="margin-top:0">
        <a class="btn btn-primary" href="${esc(url)}" download="${k === 'mobile' ? esc(label + '.ovpn') : ''}">下载配置</a>
        ${k === 'mobile' ? `<button class="btn" data-pf-copy="${esc(url)}">复制链接</button>` : ''}
      </div>
      ${(x.cmds || []).map(pfCmdBlockHtml).join('')}`;
    return `
    <div class="pf-panel ${k === key ? 'active' : ''}" data-pf-panel="${k}">
      <div class="section-title">${x.title}</div>
      <ol class="steps">${x.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      ${cmds}
    </div>`;
  }).join('');

  return `<div class="lc-hint">VPNGate 节点（SoftEther）同时开放 <b>OpenVPN</b> 与 <b>L2TP/IPsec</b>：
    「🔐 L2TP 原生」用系统内置 VPN 直接创建（iOS/Android/Windows/macOS/Linux 均原生支持，免客户端）；
    OpenVPN 方式无需系统 VPN 限制但需官方客户端。账密统一 <b>vpn / vpn</b>。</div>
    <div class="pf-tabs">${tabHtml}</div>${panelHtml}`;
}

/** 全客户端使用说明（详细版）：OpenVPN + L2TP/IPsec 全平台步骤与常见问题。
 * @param {string|null} ip - 节点 IP（主页传 null 用占位；多端面板传节点 IP）
 * @returns {string[]} 步骤数组（渲染为 <ol>）
 */
function fullGuideSteps(ip) {
  const host = ip || '节点IP';
  const ovpnUrl = ip ? '' : '（从优选卡片/多端面板复制）';
  return [
    `<b>一、两种连接方式怎么选</b><br/>本节点由 SoftEther 驱动，同时开放 <b>OpenVPN（TCP 443，需客户端）</b>与 <b>L2TP/IPsec（UDP，系统原生免客户端）</b>。账密统一 <b>vpn / vpn</b>，L2TP 预共享密钥 <b>vpn</b>。<br/>判断：卡片「本机✓」= 你的浏览器本地实测到节点 TCP 可达（唯一连通性判据），优先选本机✓ 的节点；OpenVPN 连不上时直接改用 L2TP。`,
    `<b>二、OpenVPN · iOS（iPhone/iPad）</b><br/>① App Store 安装 <b>OpenVPN Connect</b>（官方免费）；<br/>② 本页「下载配置」保存 .ovpn（或复制链接在手机浏览器打开自动下载）；<br/>③ 打开 App →「Get connected」→ 切到 <b>Upload File</b> 标签 → 选择刚下载的 .ovpn 文件 → Import；<br/>④ 连接时账密输入 <b>vpn / vpn</b>（勾选 Import autologin profile 可免密）。<br/>⚠️ 不要在 URL 标签粘贴链接——那是「服务器地址/Cloud ID」入口，不支持 .ovpn 配置下载。`,
    `<b>三、OpenVPN · Android</b><br/>① Play 商店安装 <b>OpenVPN Connect</b>；<br/>② 本页「下载配置」保存 .ovpn（或复制链接在浏览器打开下载）；<br/>③ 方式 A：打开 App → Get connected → <b>Upload File</b> → 选 .ovpn → Import；方式 B：在「文件/下载」里点 .ovpn →「用 OpenVPN Connect 打开」→ 导入；<br/>④ 连接账密 <b>vpn / vpn</b>。`,
    `<b>四、OpenVPN · Windows（10/11）</b><br/>① 安装 <b>OpenVPN GUI</b>（openvpn.net 下载，装时选 OpenVPN Service 组件）或 OpenVPN Connect；<br/>② 本页「下载配置」保存 .ovpn → 右键 → <b>Open with OpenVPN GUI</b>（或 OpenVPN Connect 里 Upload File 导入）；<br/>③ 托盘图标 → Connect → 账密 <b>vpn / vpn</b>；<br/>④ 或用「多端一键 → 🪟 Windows」里的命令下载并打开导入（下方列有它创建了什么与删除命令）。`,
    `<b>五、OpenVPN · macOS</b><br/>① 安装 <b>Tunnelblick</b>（免费开源）或 OpenVPN Connect；<br/>② 本页「下载配置」保存 .ovpn → <b>双击</b> → 自动导入 Tunnelblick（或 Upload File 导入 Connect）；<br/>③ 连接账密 <b>vpn / vpn</b>。`,
    `<b>六、OpenVPN · Linux</b><br/>① 有桌面环境：<code>sudo apt install network-manager-openvpn-gnome</code>，然后在「设置 → 网络 → VPN」导入 .ovpn；<br/>② 纯命令行（推荐）：用「多端一键 → 🐧 Linux」的「Linux OpenVPN CLI 连接命令」——自动下载配置并用 <code>sudo openvpn --config</code> 连接，账密 <b>vpn / vpn</b>，Ctrl+C 断开；该命令不写系统配置，删除时只需删掉下载的 .ovpn 文件。`,
    `<b>七、L2TP/IPsec · 统一参数</b><br/>服务器=<b>${host}</b> · 类型 <b>L2TP/IPsec（PSK）</b> · 预共享密钥 <b>vpn</b> · 账密 <b>vpn / vpn</b>。<br/>L2TP 走 UDP/ESP，国内网络普遍可连（OpenVPN 被运营商干扰/服务未开时优先用）。`,
    `<b>八、L2TP · iOS</b>：设置 → 通用 → VPN 与设备管理 → 添加 VPN 配置 → 类型 <b>L2TP/IPSec</b> → 服务器=${host}、账户=vpn、密码=vpn、密钥=<b>vpn</b> → 完成 → 连接。`,
    `<b>九、Android（原生参考 · 含高版本）</b><br/>① <b>L2TP/IPsec 开源客户端 TunnelForge（Android 12+ 无系统 L2TP 时的首选）</b>：GitHub <code>evokelektrique/tunnel-forge</code>（GPL-3.0 开源，专为现代 Android 重实现 L2TP/IPsec IKEv1），F-Droid 或 GitHub Releases 下载 APK 安装 → 新建配置：名称 vpngate、服务器=${host}、IPsec 预共享密钥 <b>vpn</b>、账密 <b>vpn / vpn</b> → 连接；<b>若同一节点 iPhone 能连而安卓 TunnelForge 连不上（日志「IKE no reply」）＝客户端 IKE 兼容问题</b>，改用其 fork <code>tzlun167/tunnel-forge</code>（MODP1024/DH group 2，兼容 SoftEther/racoon 老式 IPsec 服务器），配置不变；或同节点试安卓原生 IKEv2（见②）；<br/>② <b>IKEv2/IPsec MSCHAPv2（原生，Android 12+ 保留）</b>：设置 → VPN → 添加 → 类型 <b>IKEv2/IPsec MSCHAPv2</b> → 服务器=${host}、用户名 <b>vpn</b>、密码 <b>vpn</b> → 连接（SoftEther IPsec 服务默认开放 IKEv2）；<br/>③ IKEv2 不行试类型 <b>IKEv2/IPsec PSK</b> → 预共享密钥 <b>vpn</b>；<br/>④ 部分 ROM 仍有 <b>L2TP/IPSec PSK</b> 选项（国产 ROM MIUI/HarmonyOS/ColorOS/OriginOS 一般保留）：服务器=${host}、PSK=<b>vpn</b>、账密=vpn/vpn → 连接；<br/>⑤ 均不可用时用 OpenVPN Connect（见第三条）。<br/>⚠️ 原生 Android 12+ 已移除 L2TP 但<b>保留 IKEv2</b>；TunnelForge 不需要 ROOT（用户态网络栈）。`,
    `<b>十、L2TP · Windows</b>：以管理员 PowerShell 运行「多端一键 → 🔐 L2TP 原生」的「Windows L2TP 创建命令」（内置注册表 NAT 补丁 <code>AssumeUDPEncapsulationContext=2</code>，国内网络必填），再运行「Windows L2TP 连接命令」；用不上时运行该命令下方配套的「删除命令」即可移除 VPN 连接与注册表项。<br/>手动：设置 → 网络和 Internet → VPN → 添加 VPN 连接 → VPN 类型 <b>L2TP/IPsec</b> → 预共享密钥 <b>vpn</b> → 账密 vpn/vpn。`,
    `<b>十一、L2TP · macOS</b>：系统设置 → 网络 → VPN → 添加 VPN 配置 → 类型 <b>L2TP over IPsec</b> → 服务器=${host}、账户=vpn、密码=vpn → 认证设置选「共享的密钥」填 <b>vpn</b> → 连接。`,
    `<b>十二、L2TP · Linux</b>：运行「多端一键 → 🔐 L2TP 原生」的「Linux L2TP 创建命令」自动安装 network-manager-l2tp 并创建连接；用不上时运行其配套「删除命令」（先断开再 <code>nmcli connection delete</code>），无需卸载软件包。<br/>纯 CLI：<code>sudo apt install -y xl2tpd strongswan</code>，在 /etc/ipsec.conf 设密钥 <b>vpn</b>、/etc/xl2tpd/xl2tpd.conf 指向 ${host} 后拨号。`,
    `<b>十三、下载配置链接说明</b>：面板/卡片的「下载配置」与「复制链接」是 <b>带令牌的免登录链接</b>（.ovpn 结尾），默认有效期 10 分钟；可在任意设备/客户端直接下载导入，无需登录本系统。`,
    `<b>十四、常见问题</b><br/>① 连不上 → 先看卡片「本机✗」（浏览器实测超时，换节点/换网络）或节点未启用 OpenVPN 服务（改用 L2TP）；<br/>② OpenVPN 导入失败 → 用 <b>Upload File</b> 选 .ovpn 文件，勿在 URL 标签粘贴；<br/>③ 反复要账密 → 账密是 <b>vpn / vpn</b>（不是登录本系统的密码）；<br/>④ Windows L2TP 报 789/691 → 确认注册表补丁已加、账密正确；<br/>⑤ iOS L2TP 报「IPsec 失败」→ 确认 PSK 填 <b>vpn</b>；<br/>⑥ 速度慢/不稳 → 选评分高、在线时间长（100+ 天）的节点；<br/>⑦ 部分节点 OpenVPN/L2TP 服务未启用 → 多试几个节点（配置参数格式一致）；<br/>⑧ 节点动态上下线 → 稍后重试或刷新列表。`,
    `<b>十五、命令创建了什么 / 用不上时怎么删</b><br/>「多端一键」和下方每条快捷命令都标注了 <b>创建了什么</b>，并配一条 <b>删除命令</b>（可直接复制）：<br/>① <b>Windows L2TP</b>：创建注册表 NAT-T 值 + 系统 VPN 连接 + 记住的凭据 → 用 <code>Remove-VpnConnection</code> 与 <code>Remove-ItemProperty</code> 删除（需管理员）；<br/>② <b>Linux L2TP</b>：安装 <code>network-manager-l2tp</code> 包 + 创建 NetworkManager 连接（<code>/etc/NetworkManager/system-connections/</code>）→ 用 <code>nmcli connection delete</code> 删除连接即可，不必卸载软件包；<br/>③ <b>Windows OpenVPN</b>：下载 <code>%TEMP%\\xxx.ovpn</code>，客户端导入还会在 config 目录生成同名配置 → 用 <code>Remove-Item</code> 清理这几处，并在客户端里删 profile；<br/>④ <b>Linux OpenVPN</b>：下载 <code>~/xxx.ovpn</code>，nmcli 导入还会建 NetworkManager 连接 → 删除命令先删连接再删文件；CLI 方式只留一个 .ovpn 文件，<code>rm</code> 即可；<br/>⑤ <b>macOS</b>：下载到 <code>~/Downloads/</code>，<code>rm</code> 删除，客户端里的 profile 手动移除。<br/>⚠️ 删除命令只清理本工具创建的项；若注册表值或软件包原本就存在（非本工具创建），请勿一并删除。`,
  ];
}

/** 打开主页「使用说明」弹窗：全客户端详细使用说明（通用版，不绑定具体节点）。 */
function openGuideModal() {
  const body = document.getElementById('guideBody');
  const steps = fullGuideSteps(null);
  const C = pfCmds('vpngate', '节点IP', '配置链接');
  const quick = [
    { ...C.winL2tpCreate, title: 'Windows L2TP（创建 + 连接）', cmd: `${C.winL2tpCreate.cmd}; ${C.winL2tpConnect.cmd}` },
    { ...C.linuxL2tpCreate, title: 'Linux L2TP（创建 + 连接）' },
    { ...C.winOvpnDownload, title: 'Windows OpenVPN（下载 + 导入）' },
    { ...C.linuxOvpnCli, title: 'Linux OpenVPN（下载 + CLI 连接）' },
  ];
  body.innerHTML = `
    <ol class="steps">${steps.map((st) => `<li>${st}</li>`).join('')}</ol>
    <div class="section-title">快捷命令（替换占位符后使用；每条都列出「创建了什么」与配套的删除命令）</div>
    ${quick.map(pfCmdBlockHtml).join('')}`;
  document.getElementById('guideMask').hidden = false;
  document.querySelectorAll('#guideBody [data-pf-copy]').forEach((b) => {
    b.addEventListener('click', () => copyText(b.dataset.pfCopy, '已复制'));
  });
}

async function openPlatformModal(id) {
  const s = state.servers.find((x) => x.id === id) || {};
  const label = `vpngate-${s.countryShort || 'x'}-${s.ip || 'node'}`;
  const body = document.getElementById('pfBody');
  // 免登录下载链接（带短期令牌）：外部客户端（OpenVPN Connect 等）无登录 Cookie 也能直接导入
  let url = '';
  try {
    const res = await fetch(`/api/ovpn-url?id=${encodeURIComponent(id)}`);
    const d = await res.json().catch(() => null);
    if (res.ok && d && d.url) url = d.url;
  } catch { /* 令牌接口失败时降级为登录会话内可用的相对路径 */ }
  if (!url) url = ovpnUrl(id);
  body.innerHTML = `
    <div class="section-title">节点 ${esc(s.ip || id)}${s.countryShort ? ` · ${esc(s.countryShort)}` : ''}</div>
    <div class="cfg-hint" style="margin:6px 0 10px;padding:8px 10px;border:1px solid #f0c36d;background:#fef9e7;border-radius:6px">
      ⚠️ 连不上？OpenVPN TCP 443 可能被运营商干扰或节点未启用服务——<b>优先试「🔐 L2TP 原生」</b>（系统内置 VPN，
      SoftEther 默认开启 L2TP/IPsec，走 UDP/ESP 国内普遍可连），或换一个节点重试。
    </div>
    ${pfPanelHtml('', url, label)}`;
  document.getElementById('pfMask').hidden = false;
}

// ==================== 操作日志 ====================

const LOG_ACT_LABEL = {
  login: '登录成功', 'login-fail': '登录失败', logout: '登出',
  'config-save': '保存配置', 'config-reset': '恢复默认配置',
  'storage-switch': '切换存储模式', 'storage-sync': '同步存储',
  'servers-refresh': '强制刷新节点', optimize: '执行优选',
  'ovpn-download': '下载 .ovpn', 'node-view': '查看节点',
};

/** 格式化日志时间 */
function fmtLogTime(t) {
  if (!t) return '-';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 打开操作日志弹窗并加载日志 */
async function openLogs() {
  const mask = document.getElementById('logMask');
  const body = document.getElementById('logBody');
  mask.hidden = false;
  body.innerHTML = '<div class="dim">加载中…</div>';
  try {
    const data = await api('/api/logs?limit=50');
    const logs = data.logs || [];
    if (!logs.length) {
      body.innerHTML = '<div class="dim">暂无操作日志</div>';
      return;
    }
    body.innerHTML = '<div class="log-list">' + logs.map((l) => {
      const label = LOG_ACT_LABEL[l.act] || l.act || '-';
      return `<div class="log-item">
        <span class="log-time">${esc(fmtLogTime(l.t))}</span>
        <span class="log-act">${esc(label)}</span>
        <span class="log-ip">${esc(l.ip || '')}</span>
        ${l.d ? `<span class="log-detail">${esc(l.d)}</span>` : ''}
      </div>`;
    }).join('') + '</div>';
  } catch (e) {
    body.innerHTML = `<div class="err">加载日志失败：${esc(e.message)}</div>`;
  }
}

// ==================== 事件绑定 ====================

function bindEvents() {
  document.getElementById('btnRefresh').addEventListener('click', () => loadServers(true));
  document.getElementById('btnOptimize').addEventListener('click', runOptimize);
  document.getElementById('btnGuide').addEventListener('click', openGuideModal);
  document.getElementById('btnGuideClose').addEventListener('click', () => { document.getElementById('guideMask').hidden = true; });
  document.getElementById('btnConfig').addEventListener('click', () => {
    renderConfigForm();
    document.getElementById('cfgMask').hidden = false;
  });
  document.getElementById('btnLogs').addEventListener('click', openLogs);
  document.getElementById('btnLogRefresh').addEventListener('click', openLogs);
  document.getElementById('btnCloseLog').addEventListener('click', () => {
    document.getElementById('logMask').hidden = true;
  });

  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderTable();
  });
  document.getElementById('countrySelect').addEventListener('change', (e) => {
    state.country = e.target.value;
    renderTable();
  });
  document.getElementById('sortSelect').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderTable();
  });
  document.getElementById('lcOnly').addEventListener('change', (e) => {
    state.lcOnly = e.target.checked;
    renderTable();
  });

  // 表格行点击 → 详情；事件委托
  document.getElementById('serverTbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDrawer(tr.dataset.id);
  });

  // 退出登录
  document.getElementById('btnLogout').addEventListener('click', (e) => {
    e.preventDefault();
    logout();
  });

  // 抽屉/面板关闭
  document.getElementById('btnCloseDrawer').addEventListener('click', () => {
    document.getElementById('drawer').hidden = true;
  });
  document.getElementById('btnCloseOpt').addEventListener('click', () => {
    document.getElementById('optMask').hidden = true;
  });
  document.getElementById('btnCloseCfg').addEventListener('click', () => {
    document.getElementById('cfgMask').hidden = true;
  });
  document.getElementById('btnClosePf').addEventListener('click', () => {
    document.getElementById('pfMask').hidden = true;
  });
  document.querySelectorAll('.modal-mask').forEach((mask) => {
    mask.addEventListener('click', (e) => {
      if (e.target === mask) mask.hidden = true;
    });
  });

  // 多端一键面板：切换平台 / 复制命令
  document.getElementById('pfBody').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-pf-tab]');
    if (tab) {
      const key = tab.dataset.pfTab;
      document.querySelectorAll('[data-pf-tab]').forEach((t) => t.classList.toggle('active', t.dataset.pfTab === key));
      document.querySelectorAll('[data-pf-panel]').forEach((p) => p.classList.toggle('active', p.dataset.pfPanel === key));
      return;
    }
    const cp = e.target.closest('[data-pf-copy]');
    if (cp) copyText(cp.dataset.pfCopy, '已复制，可在本机终端运行');
  });

  // 抽屉内操作（事件委托）
  document.getElementById('drawerBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === 'probe') probeServerById(id);
    if (act === 'ovpn') downloadOvpn(id);
    if (act === 'node') showNodeParams(id);
    if (act === 'pf') openPlatformModal(id);
    if (act === 'l2tp-copy') copyText(btn.dataset.text, 'L2TP 参数已复制');
  });

  // 配置保存/重置
  document.getElementById('btnSaveCfg').addEventListener('click', saveConfigForm);
  document.getElementById('btnResetCfg').addEventListener('click', resetConfigForm);
}

// ==================== 启动 ====================

init();
