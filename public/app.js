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

/** 统一 API 请求 */
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
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
  el.textContent = `数据源：${srcs} · 更新 ${t} · 存储 ${state.storage}`;
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
    `v1.1 · CF 探测延迟为边缘测量值 · 本机校验确认本机网络可达性 · 共 ${state.servers.length} 个节点`;
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
    <div class="section-title">连通性测试（端口 ${(state.config.probe.ports || [443]).join('/')}）</div>
    <div class="row-actions">
      <button class="btn" data-act="probe" data-id="${esc(s.id)}">CF 探测</button>
      <button class="btn" data-act="lc" data-id="${esc(s.id)}">本机校验</button>
      <button class="btn btn-primary" data-act="ovpn" data-id="${esc(s.id)}">下载 .ovpn</button>
      <button class="btn" data-act="node" data-id="${esc(s.id)}">获取节点参数</button>
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
    const res = await fetch(`/api/ovpn?id=${encodeURIComponent(id)}`);
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
  try {
    const data = await api('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const ranked = data.ranked || [];
    if (ranked.length === 0) {
      document.getElementById('optBody').innerHTML =
        '<div class="empty">没有可用的优选结果：可尝试放宽筛选（如「仅保留可连通」开关）或刷新数据源。</div>';
      return;
    }
    document.getElementById('optBody').innerHTML = `
      <div class="section-title">共探测 ${(data.probed || []).length} 个候选，${ranked.length} 个达标节点（按最终评分排序）</div>
      <div class="row-actions" style="margin-bottom:10px">
        <button class="btn" data-act="opt-lc-all">本机校验全部 ${ranked.length} 个</button>
      </div>
      ${ranked.map((r, i) => {
        const lc = state.local.results[r.id];
        const lcChip = !lc
          ? '<span class="chip dim">本机未测</span>'
          : lc.reachable
            ? `<span class="chip ok">本机✓ ${lc.rttMs}ms</span>`
            : `<span class="chip bad">本机✗</span>`;
        return `
        <div class="opt-card">
          <div class="opt-rank">${i + 1}</div>
          <div class="opt-main">
            <div class="row1"><span class="flag">${flagEmoji(r.countryShort)}</span><span class="ip">${esc(r.ip)}</span>
              <span class="badge ok">${esc(r.hostname)}</span>${lcChip}</div>
            <div class="row2">端口 ${r.port} · 基础分 ${r.baseScore.toFixed(3)} → ${r.score.toFixed(3)}</div>
          </div>
          <div class="opt-meta">
            <div class="rtt">${r.reachable ? r.rttMs + 'ms' : '不可达'}</div>
            <div style="margin-top:4px;display:flex;gap:6px;justify-content:flex-end">
              <button class="btn" data-act="opt-lc" data-id="${esc(r.id)}">本机校验</button>
              <button class="btn" data-act="opt-ovpn" data-id="${esc(r.id)}">下载配置</button>
            </div>
          </div>
        </div>`;
      }).join('')}
      <div class="section-title">说明：RTT 为 Cloudflare 边缘到节点的 TCP 握手延迟，作为可达性参考；
        「本机校验」用于确认你的本机网络是否可达（防止 CF 可达但本机不可达）。</div>`;
    // 绑定下载与本机校验
    document.querySelectorAll('[data-act="opt-ovpn"]').forEach((btn) => {
      btn.addEventListener('click', () => downloadOvpn(btn.dataset.id));
    });
    document.querySelectorAll('[data-act="opt-lc"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = state.servers.find((x) => x.id === btn.dataset.id);
        if (s) openLcModal([lcTargetFromServer(s)]);
      });
    });
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
    document.getElementById('optBody').innerHTML = `<div class="empty">优选失败：${esc(e.message)}</div>`;
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
  body.innerHTML = Object.keys(groups).map((g) => `
    <div class="cfg-group">
      <h4>${esc(g)}</h4>
      ${groups[g].map((it) => cfgRowHtml(it)).join('')}
    </div>`).join('');
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

// ==================== 事件绑定 ====================

function bindEvents() {
  document.getElementById('btnRefresh').addEventListener('click', () => loadServers(true));
  document.getElementById('btnOptimize').addEventListener('click', runOptimize);
  document.getElementById('btnConfig').addEventListener('click', () => {
    renderConfigForm();
    document.getElementById('cfgMask').hidden = false;
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
  document.querySelectorAll('.modal-mask').forEach((mask) => {
    mask.addEventListener('click', (e) => {
      if (e.target === mask) mask.hidden = true;
    });
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
  });

  // 配置保存/重置
  document.getElementById('btnSaveCfg').addEventListener('click', saveConfigForm);
  document.getElementById('btnResetCfg').addEventListener('click', resetConfigForm);
}

// ==================== 启动 ====================

init();
