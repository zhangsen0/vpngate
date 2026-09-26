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
        <td>${badge}</td>
      </tr>`;
  }).join('');
}

function renderFoot() {
  document.getElementById('footText').textContent =
    `v1.0 · 探测延迟为 Cloudflare 边缘测量值，非本机延迟 · 共 ${state.servers.length} 个节点`;
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
    <div class="section-title">连通性测试（端口 ${(state.config.probe.ports || [443]).join('/')}）</div>
    <div class="row-actions">
      <button class="btn" data-act="probe" data-id="${esc(s.id)}">测试连通</button>
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
      ${ranked.map((r, i) => `
        <div class="opt-card">
          <div class="opt-rank">${i + 1}</div>
          <div class="opt-main">
            <div class="row1"><span class="flag">${flagEmoji(r.countryShort)}</span><span class="ip">${esc(r.ip)}</span>
              <span class="badge ok">${esc(r.hostname)}</span></div>
            <div class="row2">端口 ${r.port} · 基础分 ${r.baseScore.toFixed(3)} → ${r.score.toFixed(3)}</div>
          </div>
          <div class="opt-meta">
            <div class="rtt">${r.reachable ? r.rttMs + 'ms' : '不可达'}</div>
            <div style="margin-top:4px">
              <button class="btn" data-act="opt-ovpn" data-id="${esc(r.id)}">下载配置</button>
            </div>
          </div>
        </div>`).join('')}
      <div class="section-title">说明：RTT 为 Cloudflare 边缘到节点的 TCP 握手延迟，作为可达性参考。</div>`;
    // 绑定下载
    document.querySelectorAll('[data-act="opt-ovpn"]').forEach((btn) => {
      btn.addEventListener('click', () => downloadOvpn(btn.dataset.id));
    });
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
  document.querySelectorAll('.modal-mask').forEach((mask) => {
    mask.addEventListener('click', (e) => {
      if (e.target === mask) mask.hidden = true;
    });
  });

  // 抽屉内操作（事件委托）
  document.getElementById('drawerBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === 'probe') probeServerById(id);
    if (act === 'ovpn') downloadOvpn(id);
    if (act === 'node') showNodeParams(id);
  });

  // 配置保存/重置
  document.getElementById('btnSaveCfg').addEventListener('click', saveConfigForm);
  document.getElementById('btnResetCfg').addEventListener('click', resetConfigForm);
}

// ==================== 启动 ====================

init();
