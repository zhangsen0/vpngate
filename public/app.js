/**
 * app.js — 前端交互逻辑（无框架，纯静态）
 *
 * 职责：加载配置与服务器列表、表格渲染与排序筛选、节点详情抽屉、
 *       优选结果面板、配置面板（按服务端 SCHEMA 通用渲染）。
 * 约定：所有业务参数均来自 /api/config，前端不做硬编码决策。
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
  reachableOnly: false,  // 前端仅按探测结果过滤展示（探测结果存于行数据）
  lcOnly: false,         // 仅展示本机校验可达的节点
  local: { results: {}, targets: [] }, // 本机校验结果与当前目标
  storage: 'memory',
};

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
    // 版本号（用于页脚展示，非关键失败不影响使用）
    try {
      const h = await api('/api/health');
      state.version = h.version;
    } catch { /* 忽略 */ }
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

/** 当前可见列表（搜索 + 国家 + 排序 + 可连通过滤） */
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
  if (state.reachableOnly) list = list.filter((s) => s._reachable === true);
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
    const reachable = s._reachable;
    const badge = reachable === undefined
      ? ''
      : reachable
        ? `<span class="badge ok">可连通 ${s._rtt}ms</span>`
        : `<span class="badge bad">不可连通</span>`;
    const lc = state.local.results[s.id];
    const lcChip = !lc
      ? '<span class="chip dim">未测</span>'
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
        <td>${badge}</td>
      </tr>`;
  }).join('');
}

function renderFoot() {
  document.getElementById('footText').textContent =
    `v${state.version || '1'} · CF 探测延迟为边缘测量值 · 本机校验确认本机网络可达性 · 共 ${state.servers.length} 个节点`;
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
    ? '<div class="section-title">本机校验：<span class="chip dim">未测</span>（推荐对本机网络做可达性确认）</div>'
    : lc.reachable
      ? `<div class="section-title">本机校验：<span class="chip ok">可达 ${lc.rttMs}ms</span>（${esc(lc.detail || '')}）</div>`
      : `<div class="section-title">本机校验：<span class="chip bad">不可达</span>（${esc(lc.detail || '')}）</div>`;
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
    <div class="section-title">OpenVPN 连通性测试（端口 ${(state.config.probe.ports || [443]).join('/')}）</div>
    <div class="row-actions">
      <button class="btn" data-act="probe" data-id="${esc(s.id)}">CF 探测</button>
      <button class="btn" data-act="lc" data-id="${esc(s.id)}">本机校验</button>
      <button class="btn btn-primary" data-act="ovpn" data-id="${esc(s.id)}">下载 .ovpn</button>
      <button class="btn" data-act="pf" data-id="${esc(s.id)}">多端一键</button>
      <button class="btn" data-act="node" data-id="${esc(s.id)}">节点参数</button>
    </div>
    <div id="probeResult"></div>
    <div id="nodeResult"></div>`;
  document.getElementById('drawer').hidden = false;
}

async function probeServerById(id) {
  const s = state.servers.find((x) => x.id === id);
  if (!s) return;
  const box = document.getElementById('probeResult');
  box.innerHTML = '<div class="section-title">正在探测…</div>';
  try {
    const data = await api('/api/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: s.ip }),
    });
    s._reachable = data.reachable;
    s._rtt = data.reachable ? data.rttMs : null;
    box.innerHTML = `<div class="section-title">${data.reachable
      ? `<span class="badge ok">可连通 · 端口 ${data.port} · RTT ${data.rttMs}ms</span>`
      : `<span class="badge bad">不可连通（已测端口 ${(data.ports || []).join('/')}）</span>`}</div>`;
    renderTable();
  } catch (e) {
    box.innerHTML = `<div class="section-title"><span class="badge bad">探测失败：${esc(e.message)}</span></div>`;
  }
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

async function runOptimize() {
  const mask = document.getElementById('optMask');
  mask.hidden = false;
  document.getElementById('optBody').innerHTML =
    '<div class="empty">正在按配置评分并探测（静态评分前 ' + (state.config.probe.probeCount || 20) + ' 名）…</div>';
  // 探测受 Cloudflare 边缘 30s 墙钟限制，前端 25s 兜底超时并给出可操作提示
  const ctrl = new AbortController();
  const failTimer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const data = await api('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: ctrl.signal,
    });
    const ranked = data.ranked || [];
    if (ranked.length === 0) {
      document.getElementById('optBody').innerHTML =
        '<div class="empty">没有可用的优选结果：可尝试放宽筛选（如「仅保留可连通」开关）或刷新数据源。</div>';
      return;
    }
    // 渲染（本机实测结果可为空）；renderOptCards 内部已绑定按钮事件
    renderOptCards(ranked, data, null);
    const lcAllBtn = document.querySelector('[data-act="opt-lc-all"]');
    if (lcAllBtn) {
      lcAllBtn.addEventListener('click', () => {
        openLcModal(ranked.map((r) => ({
          id: r.id,
          ip: r.ip,
          hostname: r.hostname,
          countryShort: r.countryShort,
          ports: (state.config.probe.ports || [443]).slice(0, 3),
        })));
      });
    }
  } catch (e) {
    const timedOut = e.name === 'AbortError' || (e.message || '').includes('abort');
    document.getElementById('optBody').innerHTML = timedOut
      ? '<div class="empty">优选超时：边缘探测节点较慢。可在「配置 → 连通性探测」减小探测数量/超时后重试，或稍后再试。</div>'
      : `<div class="empty">优选失败：${esc(e.message)}</div>`;
  } finally {
    clearTimeout(failTimer);
  }
}

/** 渲染优选结果卡片。results: Map<id, {reachable,rttMs,why}> 或 null（未做本机实测） */
function renderOptCards(ranked, data, results) {
  const lp = state.config.localProbe || {};
  const maxNodes = lp.maxNodes || 120;
  const lcChipOf = (id) => {
    const r = results && results.get(id);
    if (!r) {
      const lc = state.local.results[id];
      return !lc ? '<span class="chip dim">本机未测</span>'
        : lc.reachable ? `<span class="chip ok">本机✓ ${lc.rttMs}ms</span>` : '<span class="chip bad">本机✗</span>';
    }
    if (r.udp) return `<span class="chip warn" title="UDP 端口浏览器无法探测，需试连">UDP 未测·试连</span>`;
    if (!r.reachable) return `<span class="chip bad">本机✗ 超时</span>`;
    // 叠加 CF 边缘 OpenVPN 服务探测结果（确认 443 上 OpenVPN 服务真实在线）
    let svc = '';
    if (r.service === true) svc = `<span class="chip ok" title="CF 边缘已发 OpenVPN 握手帧，服务确认在线">服务✓</span>`;
    else if (r.service === false) svc = `<span class="chip bad" title="CF 边缘探测：该节点 443 未响应 OpenVPN 握手（连不上主因）">服务✗</span>`;
    return `<span class="chip ok">本机✓ ${r.rttMs}ms</span>${svc}`;
  };
  // 实测 RTT/端口优先取本机实测结果（ids 模式服务端不返回实测 RTT，避免“毫秒缺失”）
  const lrOf = (id) => results && results.get(id);
  const body = document.getElementById('optBody');
  body.innerHTML = `
    <div class="section-title">${data.mode === 'local' ? '本机实测可达节点（按权重评分排序）' : `CF 边缘探测 ${(data.probed || []).length} 个候选，${ranked.length} 个达标节点（按最终评分排序）`}</div>
    <div class="row-actions" style="margin-bottom:10px">
      <button class="btn btn-primary" data-act="opt-probe">🔍 本机实测 Top ${maxNodes}（页面内直连）</button>
      <button class="btn" data-act="opt-lc-all">本机校验全部 ${ranked.length} 个</button>
    </div>
    ${ranked.map((r, i) => {
      const lr = lrOf(r.id);
      const rttShow = lr && lr.rttMs != null ? `${lr.rttMs}ms` : (r.reachable ? ((r.rttMs || '') + 'ms') : '不可达');
      const portShow = (lr && lr.port) || r.port || r.ports || '-';
      return `
      <div class="opt-card">
        <div class="opt-rank">${i + 1}</div>
        <div class="opt-main">
          <div class="row1"><span class="flag">${flagEmoji(r.countryShort)}</span><span class="ip">${esc(r.ip)}</span>
            <span class="badge ok">${esc(r.hostname)}</span>${lcChipOf(r.id)}</div>
          <div class="row2">端口 ${portShow} · ${(r.proto || '').toUpperCase() || '-'} · 在线 ${fmtUptime(r.uptimeHours)} · 基础分 ${(r.baseScore || 0).toFixed(3)} → ${(r.score || 0).toFixed(3)}</div>
        </div>
        <div class="opt-meta">
          <div class="rtt">${rttShow}</div>
          <div style="margin-top:4px;display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-sm" data-act="opt-lc" data-id="${esc(r.id)}">本机校验</button>
            <button class="btn btn-sm" data-act="opt-pf" data-id="${esc(r.id)}">多端</button>
            <button class="btn btn-sm" data-act="opt-ovpn" data-id="${esc(r.id)}">下载配置</button>
          </div>
        </div>
      </div>`;
    }).join('')}
    <div class="section-title">「本机实测」用你的浏览器直连各节点实际 TCP 端口（不另开窗口）：
      仅「连接超时」判为本机不可达（TCP 未建立）；
      端口有响应（含协议断开/证书错误）即视为本机可达；
      UDP 端口浏览器无法探测，标注「UDP 未测·试连」——优先选本机✓ 的 TCP 节点。
      ⚠️ <b>本机✓ 仅代表网络层可达（TCP 能建立）</b>，不代表 443 上 OpenVPN 服务一定可用：
      运营商可能干扰 OpenVPN 特征、或个别节点未启用 OpenVPN 服务。连接失败时：① 换节点重试；
      ② 改试「🔐 L2TP 原生」（SoftEther 默认开启 L2TP/IPsec，走 UDP/ESP，国内网络普遍可连）。</div>`;
  document.querySelectorAll('[data-act="opt-ovpn"]').forEach((btn) => {
    btn.addEventListener('click', () => downloadOvpn(btn.dataset.id));
  });
  document.querySelectorAll('[data-act="opt-pf"]').forEach((btn) => {
    btn.addEventListener('click', () => openPlatformModal(btn.dataset.id));
  });
  document.querySelectorAll('[data-act="opt-lc"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = state.servers.find((x) => x.id === btn.dataset.id);
      if (s) openLcModal([lcTargetFromServer(s)]);
    });
  });
  const probeBtn = document.querySelector('[data-act="opt-probe"]');
  if (probeBtn) probeBtn.addEventListener('click', () => localProbeAll(ranked, data, results));
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
      return { reachable: true, rttMs: Math.round(performance.now() - t0), port };
    } catch (e) {
      clearTimeout(timer);
      const dt = Math.round(performance.now() - t0);
      // 只有超时才是真正的不可达（TCP 未建立：被墙/丢包/端口无响应）。
      // 任何非超时的失败（无论快慢）都发生在 TCP 建立之后——
      // 说明端口有服务在响应（OpenVPN 收到 TLS 请求后断开、证书错误等）→ 视为可达。
      // 旧逻辑把「快速失败=端口拒绝」误判为不可达，会误杀真实可达节点（VPNGate 443 常见快速断开）。
      if (e.name === 'AbortError' || e.name === 'TimeoutError') continue; // 超时，试下一端口
      return { reachable: true, rttMs: dt, why: 'resp' };
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

/**
 * 本机实测：用总节点（按评分取前 maxNodes）在浏览器直连筛一遍，
 * 标出本机可达/不可达/UDP 未测；对 TCP 可达集合重新评分排序，
 * 并附带展示评分前 N 个 UDP 候选（需试连）。
 * 防全不可达：TCP 实测 0 可达时自动回退到 CF 边缘结果并警示。
 */
/** CF 边缘 OpenVPN 服务探测（分批 ≤25/请求，防 CF 子请求限制）。
 *  浏览器无法发 OpenVPN 首包，由 CF 边缘代发 HARD_RESET 帧确认服务在线。
 *  @returns {Promise<Object<string, {online: boolean, rttMs: number|null}>>} */
async function probeOvpnService(ids) {
  const out = {};
  const cfg = state.config.ovpnProbe || {};
  if (cfg.enabled === false || !ids.length) return out;
  const batch = 25;
  try {
    for (let i = 0; i < ids.length; i += batch) {
      const part = ids.slice(i, i + batch);
      const res = await api('/api/probe-ovpn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: part }),
      });
      if (res && res.results) Object.assign(out, res.results);
    }
  } catch (e) { console.warn('ovpn 服务探测失败', e); }
  return out;
}

async function localProbeAll(ranked, data, prevResults) {
  const lp = state.config.localProbe || {};
  if (lp.enabled === false) { toast('本机实测未启用（可在 配置 → 本机实测 打开）', 'err'); return; }
  const maxNodes = Math.max(5, Math.min(500, lp.maxNodes || 120));
  // 用总节点按评分粗排取前 N：不依赖 CF 边缘筛出的候选，防止边缘全可达但本机全不可达
  const pool = [...state.servers]
    .filter((s) => s.ip)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (a.pingMs || 1e9) - (b.pingMs || 1e9))
    .slice(0, maxNodes);
  const ports = (lp.ports || [443]).slice(0, 2);
  const timeoutMs = lp.timeoutMs || 3000;

  const body = document.getElementById('optBody');
  body.innerHTML = `<div class="section-title">🔍 本机实测中（共 ${pool.length} 个节点，按实际端口直连，UDP 标注未测）…</div>
    <div class="probe-bar"><div class="probe-bar-inner" id="probeBarInner" style="width:0%"></div></div>
    <div class="empty" id="probeStatus">已测 0 / ${pool.length}，本机可达 0…</div>`;

  const results = new Map();
  const CONC = 8;
  let idx = 0, done = 0, ok = 0, udpCount = 0;
  const barInner = document.getElementById('probeBarInner');
  const statusEl = document.getElementById('probeStatus');
  const tick = () => {
    barInner.style.width = Math.round((done / pool.length) * 100) + '%';
    statusEl.textContent = `已测 ${done} / ${pool.length}，本机可达 ${ok}，UDP 未测 ${udpCount}，超时 ${done - ok - udpCount}…`;
  };
  const workers = [];
  for (let w = 0; w < CONC; w++) {
    workers.push((async () => {
      while (idx < pool.length) {
        const s = pool[idx++];
        const r = await probeLocalServer(s, ports, timeoutMs);
        results.set(s.id, r);
        done++; if (r.reachable) ok++; else if (r.udp) udpCount++;
        if (done % 5 === 0 || done === pool.length) tick();
      }
    })());
  }
  await Promise.all(workers);
  tick();

  // TCP 实测可达集合（UDP 浏览器无法验证，另作候选展示）
  const reachableIds = [];
  const udpCandidates = [];
  results.forEach((v, id) => {
    if (v.reachable) reachableIds.push(id);
    if (v.udp) {
      const s = state.servers.find((x) => x.id === id);
      if (s) udpCandidates.push(s);
    }
  });
  // CF 边缘 OpenVPN 服务真实探测（仅对可达集合，确认 443 上 OpenVPN 服务在线，
  // 筛掉"端口通但没开 OpenVPN"的节点——本机✓ 却连不上的主因）；结果写入 results 供卡片展示
  if (reachableIds.length > 0) {
    body.innerHTML = '<div class="empty">正在用 CF 边缘确认 ' + reachableIds.length + ' 个可达节点的 OpenVPN 服务状态…</div>';
    try {
      const svc = await probeOvpnService(reachableIds);
      for (const [id, v] of Object.entries(svc)) {
        const cur = results.get(id);
        if (cur && typeof v.online === 'boolean') cur.service = v.online;
      }
    } catch (e) { console.warn('服务探测异常', e); }
  }
  // 只要 ≥1 个本机可达就采用本机结果（用户只需 1~2 个能连的节点）；
  // 仅 0 可达时回退 CF 边缘结果并警示（防全不可达：永远有结果可看）
  if (reachableIds.length === 0) {
    // 防全不可达：回退到 CF 边缘结果，标注实测状态并警示
    renderOptCards(ranked, data, results);
    body.insertAdjacentHTML('afterbegin', `<div class="empty" style="color:var(--err,#e5484d);margin-bottom:8px">
      ⚠️ 本机实测 ${pool.length} 个节点 TCP 全部超时（UDP ${udpCount} 个未测），已回退展示 CF 边缘探测结果；
      带「本机✗」的节点可能连不上。可切换网络（WiFi↔流量）、放宽筛选、增大实测节点上限或稍后再试。</div>`);
    toast('本机实测 TCP 全部不可达，已回退边缘结果', 'err');
    return;
  }
  // 对可达集合重新评分（服务端按权重排序，跳过边缘探测）
  body.innerHTML = '<div class="empty">正在对 ' + reachableIds.length + ' 个本机可达节点按权重重新评分…</div>';
  try {
    const d2 = await api('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: reachableIds }),
    });
    let list = d2.ranked || [];
    // 附带展示评分前 N 个 UDP 候选（浏览器无法探测 UDP，需试连）
    const maxUdp = Math.max(0, Math.min(50, lp.maxUdpCandidates || 8));
    if (maxUdp > 0 && udpCandidates.length > 0) {
      const udpTop = udpCandidates
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, maxUdp)
        .map((s) => ({
          id: s.id, hostname: s.hostname, ip: s.ip, countryShort: s.countryShort,
          port: s.port, proto: s.proto, baseScore: 0, score: 0, reachable: false, rttMs: null,
          udp: true,
        }));
      list = list.concat(udpTop);
    }
    renderOptCards(list, { ...data, mode: 'local', probed: d2.probed }, results);
    body.insertAdjacentHTML('afterbegin', `<div class="section-title" style="color:var(--ok,#30a46c)">
      ✅ 本机实测 ${pool.length} 个节点：TCP 可达 ${reachableIds.length} 个，已按权重重新评分
      ${maxUdp > 0 && udpCandidates.length > 0 ? `；另附 ${Math.min(maxUdp, udpCandidates.length)} 个 UDP 候选（标「UDP 未测·试连」）` : ''}。</div>`);
  } catch (e) {
    renderOptCards(ranked, data, results);
    body.insertAdjacentHTML('afterbegin', `<div class="empty" style="color:var(--err,#e5484d);margin-bottom:8px">重新评分失败（${esc(e.message)}），已保留实测标记。</div>`);
  }
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

/** 平台面板模板（url: 配置下载地址，label: 文件名） */
function pfPanelHtml(platform, url, label) {
  const ip = label.replace(/^vpngate-[A-Za-z]{2}-/, '');
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
      cmd: `New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\PolicyAgent" -Name AssumeUDPEncapsulationContext -Value 2 -PropertyType DWORD -Force | Out-Null; Add-VpnConnection -Name "${label}" -ServerAddress ${ip} -TunnelType L2tp -L2tpPsk "vpn" -AuthenticationMethod PAP -EncryptionLevel Optional -Force -RememberCredential`,
      cmdLabel: '复制 Windows 创建命令',
      altCmd: `rasdial "${label}" vpn vpn`,
      altCmdLabel: '复制 Windows 连接命令',
      extraCmd: `sudo apt install network-manager-l2tp && nmcli connection add type l2tp con-name "${label}" l2tp.gateway ${ip} l2tp.username vpn l2tp.password vpn ipsec.psk vpn ipsec.enable yes && nmcli connection up "${label}"`,
      extraCmdLabel: '复制 Linux 原生创建命令',
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
      ],
      cmd: url,
      cmdLabel: '复制配置链接',
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
      cmd: `curl.exe -L -o "%TEMP%\\${label}.ovpn" "${url}" && start "" "%TEMP%\\${label}.ovpn"`,
      cmdLabel: '复制 PowerShell 命令',
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
      cmd: `curl -L -o ~/Downloads/${label}.ovpn "${url}" && open ~/Downloads/${label}.ovpn`,
      cmdLabel: '复制终端命令',
    },
    linux: {
      tab: '🐧 Linux',
      title: 'Linux（NetworkManager 原生创建 / openvpn CLI）',
      steps: [
        `<b>①</b> 原生创建（推荐）：L2TP 用「🔐 L2TP 原生」标签页命令（network-manager-l2tp），或 OpenVPN 用下方 nmcli 导入；`,
        `<b>②</b> 连接：<b>nmcli connection up ${label}</b>；断开：<b>nmcli connection down ${label}</b>；`,
        `<b>③</b> 无桌面环境时用第二条命令（openvpn CLI）连接，账密输入 <b>vpn / vpn</b>，Ctrl+C 断开。`,
      ],
      cmd: `curl -L -o ~/${label}.ovpn "${url}" && nmcli connection import type openvpn file ~/${label}.ovpn`,
      cmdLabel: '复制原生创建命令',
      altCmd: `curl -L -o ~/${label}.ovpn "${url}" && sudo openvpn --config ~/${label}.ovpn`,
      altCmdLabel: '复制 CLI 连接命令',
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
  const panelHtml = Object.entries(panels).map(([k, x]) => `
    <div class="pf-panel ${k === key ? 'active' : ''}" data-pf-panel="${k}">
      <div class="section-title">${x.title}</div>
      <ol class="steps">${x.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      ${x.noCmd ? '' : `
      <div class="row-actions" style="margin-top:0">
        <a class="btn btn-primary" href="${esc(url)}" download="${k === 'mobile' ? esc(label + '.ovpn') : ''}">下载配置</a>
        ${k === 'mobile' ? `<button class="btn" data-pf-copy="${esc(url)}">复制链接</button>` : ''}
        <button class="btn" data-pf-copy="${esc(x.cmd)}">${x.cmdLabel}</button>
        ${x.altCmd ? `<button class="btn" data-pf-copy="${esc(x.altCmd)}">${x.altCmdLabel}</button>` : ''}
        ${x.extraCmd ? `<button class="btn" data-pf-copy="${esc(x.extraCmd)}">${x.extraCmdLabel}</button>` : ''}
      </div>
      <div class="pf-cmd">
        <div class="code-box">${esc(x.cmd)}</div>
        <button class="btn btn-sm" data-pf-copy="${esc(x.cmd)}">复制</button>
      </div>
      ${x.altCmd ? `<div class="pf-cmd" style="margin-top:8px">
        <div class="code-box">${esc(x.altCmd)}</div>
        <button class="btn btn-sm" data-pf-copy="${esc(x.altCmd)}">复制</button>
      </div>` : ''}
      ${x.extraCmd ? `<div class="pf-cmd" style="margin-top:8px">
        <div class="code-box">${esc(x.extraCmd)}</div>
        <button class="btn btn-sm" data-pf-copy="${esc(x.extraCmd)}">复制</button>
      </div>` : ''}`}
    </div>`).join('');

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
    `<b>一、两种连接方式怎么选</b><br/>本节点由 SoftEther 驱动，同时开放 <b>OpenVPN（TCP 443，需客户端）</b>与 <b>L2TP/IPsec（UDP，系统原生免客户端）</b>。账密统一 <b>vpn / vpn</b>，L2TP 预共享密钥 <b>vpn</b>。<br/>判断：卡片「本机✓」= 你的网络到节点 TCP 可达；「服务✓/✗」= CF 边缘确认该节点 443 是否启用 OpenVPN 服务——<b>服务✗ 时 OpenVPN 一定连不上，直接改用 L2TP</b>。`,
    `<b>二、OpenVPN · iOS（iPhone/iPad）</b><br/>① App Store 安装 <b>OpenVPN Connect</b>（官方免费）；<br/>② 本页「下载配置」保存 .ovpn（或复制链接在手机浏览器打开自动下载）；<br/>③ 打开 App →「Get connected」→ 切到 <b>Upload File</b> 标签 → 选择刚下载的 .ovpn 文件 → Import；<br/>④ 连接时账密输入 <b>vpn / vpn</b>（勾选 Import autologin profile 可免密）。<br/>⚠️ 不要在 URL 标签粘贴链接——那是「服务器地址/Cloud ID」入口，不支持 .ovpn 配置下载。`,
    `<b>三、OpenVPN · Android</b><br/>① Play 商店安装 <b>OpenVPN Connect</b>；<br/>② 本页「下载配置」保存 .ovpn（或复制链接在浏览器打开下载）；<br/>③ 方式 A：打开 App → Get connected → <b>Upload File</b> → 选 .ovpn → Import；方式 B：在「文件/下载」里点 .ovpn →「用 OpenVPN Connect 打开」→ 导入；<br/>④ 连接账密 <b>vpn / vpn</b>。`,
    `<b>四、OpenVPN · Windows（10/11）</b><br/>① 安装 <b>OpenVPN GUI</b>（openvpn.net 下载，装时选 OpenVPN Service 组件）或 OpenVPN Connect；<br/>② 本页「下载配置」保存 .ovpn → 右键 → <b>Open with OpenVPN GUI</b>（或 OpenVPN Connect 里 Upload File 导入）；<br/>③ 托盘图标 → Connect → 账密 <b>vpn / vpn</b>；<br/>④ 或用下方「复制 Windows OpenVPN 命令」一条命令下载并打开导入。`,
    `<b>五、OpenVPN · macOS</b><br/>① 安装 <b>Tunnelblick</b>（免费开源）或 OpenVPN Connect；<br/>② 本页「下载配置」保存 .ovpn → <b>双击</b> → 自动导入 Tunnelblick（或 Upload File 导入 Connect）；<br/>③ 连接账密 <b>vpn / vpn</b>。`,
    `<b>六、OpenVPN · Linux</b><br/>① 有桌面环境：<code>sudo apt install network-manager-openvpn-gnome</code>，然后在「设置 → 网络 → VPN」导入 .ovpn；<br/>② 纯命令行（推荐）：运行下方「复制 Linux OpenVPN 命令」——自动下载配置并用 <code>sudo openvpn --config</code> 连接，账密 <b>vpn / vpn</b>，Ctrl+C 断开。`,
    `<b>七、L2TP/IPsec · 统一参数</b><br/>服务器=<b>${host}</b> · 类型 <b>L2TP/IPsec（PSK）</b> · 预共享密钥 <b>vpn</b> · 账密 <b>vpn / vpn</b>。<br/>L2TP 走 UDP/ESP，国内网络普遍可连（OpenVPN 被运营商干扰/服务未开时优先用）。`,
    `<b>八、L2TP · iOS</b>：设置 → 通用 → VPN 与设备管理 → 添加 VPN 配置 → 类型 <b>L2TP/IPSec</b> → 服务器=${host}、账户=vpn、密码=vpn、密钥=<b>vpn</b> → 完成 → 连接。`,
    `<b>九、Android（原生参考 · 含高版本）</b><br/>① <b>L2TP/IPsec 开源客户端 TunnelForge（Android 12+ 无系统 L2TP 时的首选）</b>：GitHub <code>evokelektrique/tunnel-forge</code>（GPL-3.0 开源，专为现代 Android 重实现 L2TP/IPsec IKEv1），F-Droid 或 GitHub Releases 下载 APK 安装 → 新建配置：名称 vpngate、服务器=${host}、IPsec 预共享密钥 <b>vpn</b>、账密 <b>vpn / vpn</b> → 连接；若连不上（DH 组兼容）改用其 fork <code>tzlun167/tunnel-forge</code>（MODP1024/DH group 2，兼容老式 ipsec-tools 服务器）；<br/>② <b>IKEv2/IPsec MSCHAPv2（原生，Android 12+ 保留）</b>：设置 → VPN → 添加 → 类型 <b>IKEv2/IPsec MSCHAPv2</b> → 服务器=${host}、用户名 <b>vpn</b>、密码 <b>vpn</b> → 连接（SoftEther IPsec 服务默认开放 IKEv2）；<br/>③ IKEv2 不行试类型 <b>IKEv2/IPsec PSK</b> → 预共享密钥 <b>vpn</b>；<br/>④ 部分 ROM 仍有 <b>L2TP/IPSec PSK</b> 选项（国产 ROM MIUI/HarmonyOS/ColorOS/OriginOS 一般保留）：服务器=${host}、PSK=<b>vpn</b>、账密=vpn/vpn → 连接；<br/>⑤ 均不可用时用 OpenVPN Connect（见第三条）。<br/>⚠️ 原生 Android 12+ 已移除 L2TP 但<b>保留 IKEv2</b>；TunnelForge 不需要 ROOT（用户态网络栈）。`,
    `<b>十、L2TP · Windows</b>：以管理员 PowerShell 运行下方「复制 Windows L2TP 创建命令」（内置注册表 NAT 补丁 <code>AssumeUDPEncapsulationContext=2</code>，国内网络必填），再运行「复制 Windows L2TP 连接命令」。<br/>手动：设置 → 网络和 Internet → VPN → 添加 VPN 连接 → VPN 类型 <b>L2TP/IPsec</b> → 预共享密钥 <b>vpn</b> → 账密 vpn/vpn。`,
    `<b>十一、L2TP · macOS</b>：系统设置 → 网络 → VPN → 添加 VPN 配置 → 类型 <b>L2TP over IPsec</b> → 服务器=${host}、账户=vpn、密码=vpn → 认证设置选「共享的密钥」填 <b>vpn</b> → 连接。`,
    `<b>十二、L2TP · Linux</b>：运行下方「复制 Linux L2TP 创建命令」自动安装 network-manager-l2tp 并创建连接。<br/>纯 CLI：<code>sudo apt install -y xl2tpd strongswan</code>，在 /etc/ipsec.conf 设密钥 <b>vpn</b>、/etc/xl2tpd/xl2tpd.conf 指向 ${host} 后拨号。`,
    `<b>十三、下载配置链接说明</b>：面板/卡片的「下载配置」与「复制链接」是 <b>带令牌的免登录链接</b>（.ovpn 结尾），默认有效期 10 分钟；可在任意设备/客户端直接下载导入，无需登录本系统。`,
    `<b>十四、常见问题</b><br/>① 连不上 → 先看卡片「本机✗」（网络不可达，换节点/换网络）与「服务✗」（节点未开 OpenVPN，改用 L2TP）；<br/>② OpenVPN 导入失败 → 用 <b>Upload File</b> 选 .ovpn 文件，勿在 URL 标签粘贴；<br/>③ 反复要账密 → 账密是 <b>vpn / vpn</b>（不是登录本系统的密码）；<br/>④ Windows L2TP 报 789/691 → 确认注册表补丁已加、账密正确；<br/>⑤ iOS L2TP 报「IPsec 失败」→ 确认 PSK 填 <b>vpn</b>；<br/>⑥ 速度慢/不稳 → 选评分高、在线时间长（100+ 天）的节点；<br/>⑦ 部分节点 OpenVPN/L2TP 服务未启用 → 多试几个节点（配置参数格式一致）；<br/>⑧ 节点动态上下线 → 稍后重试或刷新列表。`,
  ];
}

/** 打开主页「使用说明」弹窗：全客户端详细使用说明（通用版，不绑定具体节点）。 */
function openGuideModal() {
  const body = document.getElementById('guideBody');
  const steps = fullGuideSteps(null);
  const winCmd = `New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\PolicyAgent" -Name AssumeUDPEncapsulationContext -Value 2 -PropertyType DWORD -Force | Out-Null; Add-VpnConnection -Name "vpngate" -ServerAddress 节点IP -TunnelType L2tp -L2tpPsk "vpn" -AuthenticationMethod PAP -EncryptionLevel Optional -Force -RememberCredential; rasdial "vpngate" vpn vpn`;
  const linuxL2tp = `sudo apt install -y network-manager-l2tp && nmcli connection add type l2tp con-name "vpngate" l2tp.gateway 节点IP l2tp.username vpn l2tp.password vpn ipsec.psk vpn ipsec.enable yes && nmcli connection up "vpngate"`;
  const winOvpn = `curl -L -o vpngate.ovpn "配置链接" && start vpngate.ovpn`;
  const linuxOvpn = `curl -L -o vpngate.ovpn "配置链接" && printf "vpn\\nvpn\\n" > auth.txt && sudo openvpn --config vpngate.ovpn --auth-user-pass auth.txt`;
  body.innerHTML = `
    <ol class="steps">${steps.map((st) => `<li>${st}</li>`).join('')}</ol>
    <div class="section-title">快捷命令（替换占位后使用）</div>
    <div class="pf-cmd"><div class="code-box">${esc(winCmd)}</div>
      <button class="btn btn-sm" data-pf-copy="${esc(winCmd)}">复制</button></div>
    <div class="pf-cmd" style="margin-top:8px"><div class="code-box">${esc(linuxL2tp)}</div>
      <button class="btn btn-sm" data-pf-copy="${esc(linuxL2tp)}">复制</button></div>
    <div class="pf-cmd" style="margin-top:8px"><div class="code-box">${esc(winOvpn)}</div>
      <button class="btn btn-sm" data-pf-copy="${esc(winOvpn)}">复制</button></div>
    <div class="pf-cmd" style="margin-top:8px"><div class="code-box">${esc(linuxOvpn)}</div>
      <button class="btn btn-sm" data-pf-copy="${esc(linuxOvpn)}">复制</button></div>`;
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

// ==================== 本机连通性校验 ====================
/**
 * 背景：CF 边缘探测只能证明“Cloudflare 网络可达”，用户本机 ISP 可能屏蔽该 IP。
 * 本机校验提供三种途径（按可靠性）：
 *  1. 本机探测命令（bash/python3 或 PowerShell，精确 TCP 连接，推荐）；
 *  2. 下载单文件探测页，本地 http 打开后用浏览器直测；
 *  3. 浏览器直连探测（仅当本页以 http:// 访问时有效，https 下被浏览器安全策略禁止）。
 * 结果存于 state.local.results，可过滤“仅本机可达”并在表格/优选卡片上标记。
 */

/** 打开本机校验面板（targets: [{id, ip, hostname, countryShort, ports}]） */
function openLcModal(targets) {
  state.local.targets = targets;
  renderLcBody();
  document.getElementById('lcMask').hidden = false;
}

/** 由节点 id 构造单节点校验目标 */
function lcTargetFromServer(s) {
  return {
    id: s.id,
    ip: s.ip,
    hostname: s.hostname,
    countryShort: s.countryShort,
    ports: (state.config.probe.ports || [443]).slice(0, 3),
  };
}

/** 面板标题文案 */
function lcHeadText() {
  const n = state.local.targets.length;
  const names = state.local.targets.slice(0, 3).map((t) => `${t.countryShort || ''} ${t.ip}`).join('、');
  return `待校验 ${n} 个节点：${names}${n > 3 ? ` 等` : ''}`;
}

function renderLcBody() {
  const body = document.getElementById('lcBody');
  const isHttps = location.protocol === 'https:';
  const hint = isHttps
    ? `<div class="lc-hint">⚠ 当前页面为 <b>https</b> 访问，浏览器安全策略禁止页面直连 http 目标（混合内容），
        “浏览器直连探测”不可用。请使用：<b>① 复制探测命令</b>在本机终端运行，或 <b>② 下载探测页</b>后用
        本地 http 服务打开进行浏览器直测。将结果粘贴回下方输入框即可自动标记。</div>`
    : `<div class="lc-hint">页面为 <b>http</b> 访问，可直接点击「浏览器直连探测」。注意：浏览器探测仅能确认端口
        有服务响应，被墙（丢包）与端口未开放均显示失败；精确结果请以本机探测命令为准。</div>`;

  body.innerHTML = `
    ${hint}
    <div class="section-title">${esc(lcHeadText())}</div>
    <div class="lc-targets">
      ${state.local.targets.map((t) => {
        const r = state.local.results[t.id];
        const chip = !r
          ? '<span class="chip dim">未测</span>'
          : r.reachable
            ? `<span class="chip ok">可达 ${r.rttMs}ms</span>`
            : `<span class="chip bad">不可达</span>`;
        return `
        <div class="lc-row" data-id="${esc(t.id)}">
          <div class="t-ip">
            <span class="flag">${flagEmoji(t.countryShort)}</span> ${esc(t.ip)}
            <span class="t-host">${esc(t.hostname)}</span>
            <span class="t-ports">端口 ${(t.ports || []).join('/')}</span>
            ${chip}
          </div>
          <div class="lc-actions">
            <button class="btn mini" data-lc="ok" data-id="${esc(t.id)}">标记可达</button>
            <button class="btn mini" data-lc="bad" data-id="${esc(t.id)}">标记不可达</button>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="lc-paste">
      <div class="section-title">粘贴本机探测输出并应用标记（支持 OK / FAIL / TIMEOUT / REFUSED 行）</div>
      <textarea id="lcPaste" placeholder="例如：&#10;OK 1.2.3.4:443 12ms&#10;TIMEOUT 5.6.7.8:1194 3000ms&#10;REFUSED 9.9.9.9:5555"></textarea>
      <div class="row-actions">
        <button class="btn" data-lc="apply">应用标记</button>
        <span class="cfg-hint" id="lcApplyResult"></span>
      </div>
    </div>`;
}

/** 浏览器直连探测（仅 http 页面生效） */
async function runBrowserProbe() {
  if (location.protocol === 'https:') {
    toast('https 页面禁止浏览器直连，请用命令模式或下载探测页', 'err');
    return;
  }
  const timeout = (state.config.probe.timeoutMs || 2500);
  const results = await Promise.all(state.local.targets.map(async (t) => {
    let ok = false, rtt = null, detail = '无响应';
    for (const port of t.ports || []) {
      const r = await wsProbe(t.ip, port, timeout);
      if (r.ok) { ok = true; rtt = r.rtt; detail = r.detail; break; }
      detail = r.detail;
    }
    setLcResult(t.id, ok, rtt, detail);
    return { id: t.id, ok, rtt, detail };
  }));
  const okN = results.filter((r) => r.ok).length;
  renderLcBody();
  toast(`浏览器探测完成：${okN}/${results.length} 可达`, okN > 0 ? 'ok' : 'err');
}

/** 单端口 WebSocket 探测（尽力而为） */
function wsProbe(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, rtt, detail) => {
      if (settled) return;
      settled = true;
      resolve({ ok, rtt, detail });
    };
    let ws;
    try {
      ws = new WebSocket(`ws://${ip}:${port}/`);
      const t0 = performance.now();
      ws.onopen = () => {
        try { ws.close(); } catch { /* 忽略 */ }
        done(true, Math.round(performance.now() - t0), `端口 ${port} 响应`);
      };
      ws.onclose = () => {
        try { ws.close(); } catch { /* 忽略 */ }
        done(false, null, `端口 ${port} 无 HTTP 响应（被墙/未开放/非 Web 服务）`);
      };
      setTimeout(() => {
        try { ws.close(); } catch { /* 忽略 */ }
        done(false, null, `端口 ${port} 超时（疑似被网络屏蔽）`);
      }, timeoutMs);
    } catch {
      done(false, null, '浏览器安全策略阻止');
    }
  });
}

/** 写入/清除本机校验结果 */
function setLcResult(id, reachable, rttMs, detail) {
  if (!id) return;
  if (reachable === null || reachable === undefined) {
    delete state.local.results[id];
  } else {
    state.local.results[id] = { reachable, rttMs: rttMs || null, detail: detail || '', ts: Date.now() };
  }
  renderTable();
  renderLcBody();
}

/** 手动标记某节点 */
function markLc(id, reachable) {
  setLcResult(id, reachable, null, reachable ? '手动标记' : '手动标记');
  toast(reachable ? '已标记为可达' : '已标记为不可达', reachable ? 'ok' : 'err');
}

/** 解析探测输出并应用标记 */
function applyLcParsed(text) {
  const lines = String(text || '').split(/\r?\n/);
  const byNode = new Map(); // nodeId → {reachable, rttMs, detail}
  for (const raw of lines) {
    const m = raw.trim().match(/^(OK|FAIL|TIMEOUT|REFUSED)\s+([\d.]+):(\d+)(?:\s+(\d+)ms)?/i);
    if (!m) continue;
    const [, status, ip, port, rttRaw] = m;
    const rtt = rttRaw ? Number.parseInt(rttRaw, 10) : null;
    const target = state.local.targets.find((t) => t.ip === ip);
    if (!target) continue;
    const cur = byNode.get(target.id) || { reachable: false, rttMs: null, detail: '' };
    if (status.toUpperCase() === 'OK') {
      cur.reachable = true;
      if (cur.rttMs == null || (rtt != null && rtt < cur.rttMs)) cur.rttMs = rtt;
    } else {
      cur.detail = (cur.detail ? cur.detail + '；' : '') + `${status} ${ip}:${port}`;
    }
    byNode.set(target.id, cur);
  }
  let applied = 0;
  for (const [id, r] of byNode) {
    setLcResult(id, r.reachable, r.reachable ? r.rttMs : null, r.detail || '本机命令探测');
    applied++;
  }
  const el = document.getElementById('lcApplyResult');
  if (el) el.textContent = applied > 0 ? `已应用 ${applied} 个节点` : '未解析到有效行（格式：OK/FAIL/TIMEOUT/REFUSED ip:port 12ms）';
  return applied;
}

/** 生成本机探测命令（win: PowerShell；其他: python3） */
function lcCmd() {
  const flat = [];
  for (const t of state.local.targets) {
    for (const p of (t.ports || [])) flat.push(`${t.ip}:${p}`);
  }
  const list = JSON.stringify(flat);
  if (/windows/i.test(navigator.userAgent)) {
    return `$targets=@(${flat.map((x) => `'${x}'`).join(',')}); foreach($t in $targets){ $ip,$p=$t -split ':'; $sw=[System.Diagnostics.Stopwatch]::StartNew(); $ok=Test-NetConnection -ComputerName $ip -Port $p -InformationLevel Quiet -WarningAction SilentlyContinue; $sw.Stop(); if($ok){"OK $t $($sw.ElapsedMilliseconds)ms"}else{"TIMEOUT $t $($sw.ElapsedMilliseconds)ms"} }`;
  }
  return `python3 - <<'EOF'
import socket,time
targets=${list}
for t in targets:
    ip,p=t.split(':'); p=int(p); s=time.time()
    try:
        sck=socket.create_connection((ip,p),timeout=3); sck.close()
        print(f"OK {t} {int((time.time()-s)*1000)}ms")
    except socket.timeout:
        print(f"TIMEOUT {t} {int((time.time()-s)*1000)}ms")
    except OSError as e:
        print(f"REFUSED {t}" if e.errno==111 else f"FAIL {t}")
EOF`;
}

async function copyLcCmd() {
  const cmd = lcCmd();
  try {
    await navigator.clipboard.writeText(cmd);
    toast('探测命令已复制，请在本机终端运行', 'ok');
  } catch {
    toast('复制失败，请手动选择复制', 'err');
  }
}

/** 下载单文件探测页（本机 http 打开后浏览器直测） */
function downloadProbePage() {
  const targets = state.local.targets.map((t) => ({
    ip: t.ip, hostname: t.hostname, cc: t.countryShort, ports: (t.ports || []).slice(0, 3),
  }));
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>VPNGate 本机探测页</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f1115;color:#e6e9ef;padding:24px;max-width:760px;margin:0 auto}
h1{font-size:18px} .hint{color:#8b93a5;font-size:13px;background:#171a21;border:1px solid #2a2f3a;border-radius:10px;padding:10px 12px}
button{padding:8px 16px;border-radius:8px;border:1px solid #2a2f3a;background:#1e222c;color:#e6e9ef;cursor:pointer;font-size:13px}
button:hover{border-color:#3b82f6} .btn-p{background:#3b82f6;color:#fff;border-color:#3b82f6}
table{width:100%;border-collapse:collapse;margin-top:14px}
th,td{padding:8px 10px;border-bottom:1px solid #2a2f3a;text-align:left;font-size:13px}
th{color:#8b93a5} .mono{font-family:monospace} .ok{color:#22c55e;font-weight:600} .bad{color:#ef4444;font-weight:600}
textarea{width:100%;min-height:90px;margin-top:12px;background:#171a21;color:#e6e9ef;border:1px solid #2a2f3a;border-radius:8px;padding:8px;font-family:monospace;font-size:12px}
</style></head><body>
<h1>VPNGate 本机连通性探测</h1>
<div class="hint">请在<b>本地</b>打开本页面：在文件所在目录运行 <b>python3 -m http.server 8000</b>，然后浏览器访问
<b>http://127.0.0.1:8000/vpngate-probe.html</b>（必须 http，不能用 file:// 或 https，否则浏览器会拦截探测）。
点击「开始探测」后，把结果复制回主站「本机连通性校验」面板粘贴即可自动标记。</div>
<div style="margin-top:12px"><button class="btn-p" id="run">开始探测</button>
<button id="copy">复制结果</button></div>
<table id="tb"><thead><tr><th>#</th><th>国家</th><th>IP</th><th>主机名</th><th>端口</th><th>结果</th><th>RTT</th></tr></thead><tbody></tbody></table>
<textarea id="out" placeholder="探测结果输出区"></textarea>
<script>
var TARGETS=${JSON.stringify(targets)};
var rows=[];
function $(id){return document.getElementById(id)}
function flag(cc){if(!cc||cc.length!==2)return '';return String.fromCodePoint.apply(null,[...cc.toUpperCase()].map(function(c){return 0x1f1e6+c.charCodeAt(0)-65}))}
function wsProbe(ip,port,timeout){return new Promise(function(resolve){var settled=false;function done(ok,rtt,detail){if(settled)return;settled=true;resolve({ok:ok,rtt:rtt,detail:detail})}
var ws;try{ws=new WebSocket('ws://'+ip+':'+port+'/');var t0=performance.now();ws.onopen=function(){try{ws.close()}catch(e){}done(true,Math.round(performance.now()-t0),'响应')}
ws.onclose=function(){try{ws.close()}catch(e){}done(false,null,'无HTTP响应')}
setTimeout(function(){try{ws.close()}catch(e){}done(false,null,'超时')},timeout)}catch(e){done(false,null,'安全策略')}})}
$('run').addEventListener('click',function(){var tb=$('tb').getElementsByTagName('tbody')[0];tb.innerHTML='<tr><td colspan="7">探测中…（并行，请稍候）</td></tr>';
Promise.all(TARGETS.map(function(t){return (async function(){var ok=false,rtt=null,detail='';for(var i=0;i<t.ports.length;i++){var r=await wsProbe(t.ip,t.ports[i],3000);if(r.ok){ok=true;rtt=r.rtt;detail=r.detail+' 端口'+t.ports[i];break}detail=r.detail+' 端口'+t.ports[i]}
rows.push({ip:t.ip,cc:t.cc,host:t.hostname,ports:t.ports.join('/'),ok:ok,rtt:rtt,detail:detail});return rows[rows.length-1]})()}))
.then(function(list){tb.innerHTML=list.map(function(r,i){return '<tr><td>'+(i+1)+'</td><td>'+flag(r.cc)+' '+r.cc+'</td><td class="mono">'+r.ip+'</td><td>'+r.host+'</td><td>'+r.ports+'</td><td class="'+(r.ok?'ok':'bad')+'">'+(r.ok?'可达':'不可达')+'</td><td>'+(r.rtt!=null?r.rtt+'ms':r.detail)+'</td></tr>'}).join('');
$('out').value=list.map(function(r){return (r.ok?'OK':'FAIL')+' '+r.ip+':0'+(r.rtt!=null?' '+r.rtt+'ms':'')+' '+r.detail}).join('\\n')})});
$('copy').addEventListener('click',function(){var lines=rows.map(function(r){return (r.ok?'OK':'FAIL')+' '+r.ip+':'+r.ports.split('/')[0]+(r.rtt!=null?' '+r.rtt+'ms':'')}).join('\\n');
$('out').value=lines;navigator.clipboard.writeText(lines).then(function(){alert('已复制，请粘贴回主站')},function(){alert('请手动复制下方内容')})});
</script></body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vpngate-probe.html';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('探测页已下载：python3 -m http.server 8000 后 http 打开', 'ok');
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
  document.getElementById('reachableOnly').addEventListener('change', (e) => {
    state.reachableOnly = e.target.checked;
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
  document.getElementById('btnCloseLc').addEventListener('click', () => {
    document.getElementById('lcMask').hidden = true;
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

  // 本机校验面板操作
  document.getElementById('btnLcProbe').addEventListener('click', runBrowserProbe);
  document.getElementById('btnLcCopyCmd').addEventListener('click', copyLcCmd);
  document.getElementById('btnLcDownload').addEventListener('click', downloadProbePage);
  document.getElementById('lcBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lc]');
    if (!btn) return;
    const { lc, id } = btn.dataset;
    if (lc === 'ok') markLc(id, true);
    if (lc === 'bad') markLc(id, false);
    if (lc === 'apply') applyLcParsed(document.getElementById('lcPaste').value);
  });

  // 抽屉内操作（事件委托）
  document.getElementById('drawerBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === 'probe') probeServerById(id);
    if (act === 'ovpn') downloadOvpn(id);
    if (act === 'node') showNodeParams(id);
    if (act === 'lc') {
      const s = state.servers.find((x) => x.id === id);
      if (s) openLcModal([lcTargetFromServer(s)]);
    }
    if (act === 'pf') openPlatformModal(id);
    if (act === 'l2tp-copy') copyText(btn.dataset.text, 'L2TP 参数已复制');
  });

  // 配置保存/重置
  document.getElementById('btnSaveCfg').addEventListener('click', saveConfigForm);
  document.getElementById('btnResetCfg').addEventListener('click', resetConfigForm);
}

// ==================== 启动 ====================

init();
