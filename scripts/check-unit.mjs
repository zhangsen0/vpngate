/**
 * check-unit.mjs — 单元测试
 *
 * 覆盖：配置校验/合并、CSV/JSON 解析、归一化、筛选、评分、优选（注入桩探测）、
 *       OpenVPN 配置生成。运行：node scripts/check-unit.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig, mergeConfig, DEFAULTS, loadConfig, saveConfig, setStorageMode, syncToKv } from '../functions/_lib/config.js';
import { parseCsv, parseJson, normalizeServers } from '../functions/_lib/sources.js';
import { applyFilters, scoreServer, runOptimize } from '../functions/_lib/optimize.js';
import { decodeConfig, buildOvpn, nodeParams } from '../functions/_lib/ovpn.js';
import { checkLoginLock, recordLoginFail, clearLoginLock, signFileToken, verifyFileToken } from '../functions/_lib/auth.js';
import { rememberServer, findServerSnapshot } from '../functions/_lib/snapshot.js';
import { log, readLogs } from '../functions/_lib/log.js';

// ==================== 构造样本数据 ====================

/** 手工构造一段 VPNGate CSV（含表头、两行数据、一行版权脚注） */
function sampleCsv() {
  const head = 'HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64';
  const row1 = 'public-vpn-1,1.1.1.1,5000000,20,30000000,Japan,JP,10,86400000,100,1000,1,Test Operator,msg,'
    + Buffer.from('client\nremote 1.1.1.1 443 tcp\nproto tcp\n').toString('base64');
  const row2 = 'public-vpn-2,2.2.2.2,3000000,120,5000000,Russia,RU,200,3600000,50,500,1,Op2,,'
    + Buffer.from('client\nremote 2.2.2.2 1194 udp\n').toString('base64');
  return [head, row1, row2, '*VPN Gate Academic Experiment Project 2026'].join('\r\n');
}

function sampleJson() {
  return JSON.stringify([{
    servers: [
      {
        hostname: 'public-vpn-3', ip: '3.3.3.3', score: '8000000', ping: '30',
        speed: '60000000', countrylong: 'United States', countryshort: 'US',
        numvpnsessions: '5', uptime: '172800000', logtype: '1week', operator: 'Op3',
        openvpn_configdata_base64: Buffer.from('client\nremote 3.3.3.3 5555 udp\n').toString('base64'),
      },
      { hostname: 'bad-ip', ip: 'not-an-ip', score: '1', ping: '1', speed: '1',
        countrylong: 'X', countryshort: 'XX', numvpnsessions: '1', uptime: '1',
        openvpn_configdata_base64: '' },
    ],
    countries: ['US'],
  }, 1780000000000]);
}

// ==================== 配置校验与合并 ====================

test('validateConfig：越界值收敛、非法类型回退默认', () => {
  const { config, errors } = validateConfig({
    fetch: { timeoutMs: 999999, cacheSeconds: 1, maxServers: -5 },
    filters: { maxPingMs: 50000, hostRegex: '([' },
    probe: { ports: [443, 99999, 'abc'], concurrency: 999 },
    weights: { score: 999, ping: -1 },
    optimize: { cacheSeconds: 99999 },
  });
  assert.equal(config.fetch.timeoutMs, 60000, 'timeout 应收敛到上限');
  assert.equal(config.fetch.cacheSeconds, 30, 'cache 应收敛到下限');
  assert.equal(config.fetch.maxServers, 1, 'maxServers 应收敛到下限');
  assert.equal(config.filters.maxPingMs, 5000);
  assert.equal(config.filters.hostRegex, '', '非法正则应重置');
  assert.ok(errors.some((e) => e.includes('hostRegex')), '应记录 hostRegex 错误');
  assert.deepEqual(config.probe.ports, [443], '非法端口应被过滤');
  assert.equal(config.probe.concurrency, 50);
  assert.equal(config.weights.score, 10);
  assert.equal(config.weights.ping, 0);
  assert.equal(config.optimize.cacheSeconds, 3600, '优选缓存应收敛到上限');
});

test('validateConfig：数据源为空时恢复默认', () => {
  const { config, errors } = validateConfig({ dataSources: [] });
  assert.equal(config.dataSources.length, DEFAULTS.dataSources.length);
  assert.ok(errors.length > 0);
});

test('mergeConfig：部分更新保留其余默认', () => {
  const cfg = mergeConfig({ optimize: { topN: 5 } });
  assert.equal(cfg.optimize.topN, 5);
  assert.equal(cfg.fetch.timeoutMs, DEFAULTS.fetch.timeoutMs);
});

// ==================== 解析 ====================

test('parseCsv：正确解析表头/数据/脚注，uptime 毫秒转小时', () => {
  const servers = parseCsv(sampleCsv());
  assert.equal(servers.length, 2);
  const s1 = servers[0];
  assert.equal(s1.hostname, 'public-vpn-1');
  assert.equal(s1.ip, '1.1.1.1');
  assert.equal(s1.countryShort, 'JP');
  assert.equal(s1.uptimeHours, 24, '86400000ms = 24h');
  assert.ok(s1.configBase64.length > 0);
});

test('parseJson：auto-ovpn 格式解析，字段映射正确', () => {
  const servers = parseJson(sampleJson());
  assert.equal(servers.length, 2, '含一个非法 IP 也应先解析（过滤在 normalize 阶段）');
  const s = servers.find((x) => x.ip === '3.3.3.3');
  assert.equal(s.countryShort, 'US');
  assert.equal(s.speedBps, 60000000);
  assert.equal(s.uptimeHours, 48, '172800000ms = 48h');
});

test('normalizeServers：过滤非法 IP 并生成 id，保留 configBase64', () => {
  const servers = normalizeServers(parseJson(sampleJson()));
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, 'public-vpn-3|3.3.3.3');
  assert.ok(servers[0].configBase64 && servers[0].configBase64.length > 0, '应保留 configBase64 供生成配置');
});

// ==================== 筛选与评分 ====================

function sampleServers() {
  return normalizeServers(parseCsv(sampleCsv()).concat(parseJson(sampleJson())));
}

test('applyFilters：禁用国家、最低在线、最低速度、最高 ping、正则', () => {
  const cfg = mergeConfig({
    filters: {
      disabledCountryCodes: ['RU'],
      minUptimeHours: 10,
      minSpeedMbps: 20,
      maxPingMs: 100,
      hostRegex: '^public-vpn-',
    },
  });
  const out = applyFilters(sampleServers(), cfg);
  // JP(24h,30Mbps,20ms) 通过；RU 被禁用；US(48h,60Mbps,30ms) 通过
  assert.deepEqual(out.map((s) => s.countryShort).sort(), ['JP', 'US']);
});

test('scoreServer：权重与归一化方向正确', () => {
  const cfg = mergeConfig();
  const fast = { score: 10000000, pingMs: 10, speedBps: 100000000, uptimeHours: 720, sessions: 5 };
  const slow = { score: 1000000, pingMs: 200, speedBps: 1000000, uptimeHours: 1, sessions: 500 };
  const a = scoreServer(fast, cfg);
  const b = scoreServer(slow, cfg);
  assert.ok(a > b, '优质节点评分应更高');
  assert.ok(a > 0.5 && a <= 1);
});

test('runOptimize：静态评分 → 探测 → 可连通加成/过滤 → topN（注入桩探测）', async () => {
  const cfg = mergeConfig({
    probe: { probeCount: 10, concurrency: 5, requireReachable: true, reachableBoost: 0.2, ports: [443] },
    optimize: { topN: 2 },
    filters: { minSpeedMbps: 0 },
  });
  const servers = sampleServers();
  // 桩：只有 1.1.1.1 可连通，RTT 40ms
  const stub = async (s) => s.ip === '1.1.1.1'
    ? { reachable: true, rttMs: 40, port: 443 }
    : { reachable: false, rttMs: null, port: null };

  const { ranked, probed } = await runOptimize(servers, cfg, stub);
  assert.ok(ranked.length > 0 && ranked.length <= 2);
  assert.ok(ranked.every((r) => r.reachable), 'requireReachable 时结果必须全部可连通');
  assert.ok(ranked.every((r) => r.ip === '1.1.1.1'));
  assert.equal(probed.length, servers.length, '候选应全部被探测');
  const r0 = ranked[0];
  assert.equal(r0.score, r0.baseScore * 1.2, '可连通加成生效');
});

test('runOptimize：requireReachable=false 时保留不可连通节点且无加成', async () => {
  const cfg = mergeConfig({ probe: { requireReachable: false, probeCount: 10 } });
  const stub = async () => ({ reachable: false, rttMs: null, port: null });
  const { ranked } = await runOptimize(sampleServers(), cfg, stub);
  assert.ok(ranked.length > 0, '不要求可连通时仍应有结果');
  assert.ok(ranked.every((r) => r.score === r.baseScore));
});

// ==================== OpenVPN 配置生成 ====================

test('buildOvpn：base64 解码、remote 改写为 IP、附加选项追加', () => {
  const cfg = mergeConfig({ ovpn: { rewriteRemoteToIp: true, appendOptions: ['auth-nocache'] } });
  const server = parseCsv(sampleCsv())[0];
  const ovpn = buildOvpn(server, cfg);
  assert.ok(ovpn, '应成功生成');
  assert.ok(ovpn.text.includes('remote 1.1.1.1 443 tcp'), 'remote 应改写为 IP');
  assert.ok(ovpn.text.includes('auth-nocache'), '附加选项应追加');
  assert.equal(ovpn.port, 443);
  assert.equal(ovpn.proto, 'tcp');
});

test('buildOvpn：rewriteRemoteToIp=false 时保留原始 remote', () => {
  const cfg = mergeConfig({ ovpn: { rewriteRemoteToIp: false } });
  const server = parseCsv(sampleCsv())[1];
  const ovpn = buildOvpn(server, cfg);
  assert.ok(ovpn.text.includes('remote 2.2.2.2 1194 udp'));
  assert.equal(ovpn.port, 1194);
  assert.equal(ovpn.proto, 'udp');
});

test('decodeConfig：缺失 base64 返回 null，损坏 base64 返回 null', () => {
  assert.equal(decodeConfig({}), null);
  assert.equal(decodeConfig({ configBase64: '!!!not-base64!!!' }), null);
  assert.ok(decodeConfig({ configBase64: Buffer.from('client').toString('base64') }).includes('client'));
});

test('nodeParams：生成可复制的节点参数摘要', () => {
  const cfg = mergeConfig();
  const server = parseCsv(sampleCsv())[0];
  const ovpn = buildOvpn(server, cfg);
  const n = nodeParams(server, ovpn);
  assert.equal(n.ip, '1.1.1.1');
  assert.equal(n.authUser, 'vpn');
  assert.ok(n.remark.includes('JP'));
});

// ==================== 存储双模式（KV / 内存） ====================

test('存储双模式：KV 故障自动降级内存，恢复后手动同步回 KV，可手动切换', async () => {
  const store = new Map();
  const fail = { flag: false };
  const kv = {
    get: async (k) => { if (fail.flag) throw new Error('kv down'); return store.get(k) ?? null; },
    put: async (k, v) => { if (fail.flag) throw new Error('kv down'); store.set(k, v); },
  };
  const env = { VPNGATE_CFG: kv, CONFIG_CACHE_SECONDS: '0' }; // 0 = 关闭缓存，直读直写

  let r = await saveConfig(env, { optimize: { topN: 6 } });
  assert.equal(r.storage.effective, 'kv', 'KV 可用时应写入 KV');
  assert.equal(r.config.optimize.topN, 6);

  fail.flag = true; // KV 故障
  r = await loadConfig(env);
  assert.equal(r.storage.effective, 'memory', 'KV 故障应自动降级内存');
  assert.ok(r.storage.degraded, '应标记降级');

  r = await saveConfig(env, { optimize: { topN: 4 } });
  assert.equal(r.storage.effective, 'memory', '降级期间保存应落内存');
  assert.equal(r.config.optimize.topN, 4);

  fail.flag = false; // KV 恢复
  r = await syncToKv(env);
  assert.equal(r.ok, true, '手动同步应成功');
  assert.equal(r.storage.effective, 'kv', '同步后应恢复 KV 生效');
  assert.equal(JSON.parse(store.get('global')).optimize.topN, 4, 'KV 中应为最新配置');

  r = await setStorageMode(env, 'memory');
  assert.equal(r.ok, true);
  assert.equal(r.storage.mode, 'memory');
  r = await saveConfig(env, { optimize: { topN: 3 } });
  assert.equal(r.storage.effective, 'memory', '仅内存模式下不应写 KV');

  r = await setStorageMode(env, 'kv');
  assert.equal(r.storage.mode, 'kv');
  assert.equal(r.storage.effective, 'kv');
  assert.equal(JSON.parse(store.get('global')).optimize.topN, 3, '切回 KV 应把当前配置同步上去');

  r = await setStorageMode(env, 'invalid');
  assert.equal(r.ok, false, '非法模式应拒绝');
});

// ==================== 操作日志 ====================

test('操作日志：记录并可读取（含 IP），落盘到 KV', async () => {
  const store = new Map();
  const kv = {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v); },
  };
  const env = { VPNGATE_CFG: kv };
  log(env, 'login', '登录成功', '1.2.3.4');
  log(env, 'config-save', '生效存储=kv', '1.2.3.4');
  const logs = await readLogs(env, 10);
  assert.ok(logs.some((l) => l.act === 'login' && l.ip === '1.2.3.4'), '应返回 login 日志及 IP');
  assert.ok(logs.some((l) => l.act === 'config-save'), '应返回 config-save 日志');
  const raw = JSON.parse(store.get('logs:v1') || '[]');
  assert.ok(raw.length >= 2, 'KV 中应已落盘日志');
});

// ==================== 登录防爆破 ====================

test('登录防爆破：连续失败锁定，成功后解锁', () => {
  const env = { LOGIN_MAX_FAIL: '3', LOGIN_LOCK_MIN: '1' };
  const ip = '203.0.113.7';
  recordLoginFail(env, ip);
  recordLoginFail(env, ip);
  assert.equal(checkLoginLock(env, ip).locked, false, '未达阈值不应锁定');
  recordLoginFail(env, ip);
  assert.equal(checkLoginLock(env, ip).locked, true, '达到阈值应锁定');
  clearLoginLock(ip);
  assert.equal(checkLoginLock(env, ip).locked, false, '成功后应解锁');
});

// ==================== 汇总 ====================

test('汇总：所有模块可加载、默认配置结构完整', () => {
  assert.ok(DEFAULTS.fetch.timeoutMs > 0);
  assert.ok(DEFAULTS.dataSources.length >= 1);
  assert.ok(['csv', 'json'].includes(DEFAULTS.dataSources[0].type));
});

// ==================== 免登录文件令牌 ====================

test('signFileToken/verifyFileToken：签名有效、id 绑定、过期拒绝、篡改拒绝', async () => {
  const env = { APP_PASSWORD: 'admin123' };
  const id = 'public-vpn-1|1.1.1.1';
  const token = await signFileToken(env, id, 60000);
  assert.ok(token && token.includes('.'), '令牌格式 payload.sig');

  assert.ok(await verifyFileToken(env, token, id), '正确 id + 有效期内 → true');
  assert.ok(!(await verifyFileToken(env, token, 'other-id')), 'id 不匹配 → false');
  assert.ok(!(await verifyFileToken(env, token + 'x', id)), '签名被篡改 → false');
  assert.ok(!(await verifyFileToken(env, token, '')), '空 id → false');

  const expired = await signFileToken(env, id, -1000);
  assert.ok(!(await verifyFileToken(env, expired, id)), '已过期 → false');

  // 无密钥时不可签发
  assert.equal(await signFileToken({}, id, 60000), null);
});

// ==================== 节点快照缓存 ====================

test('rememberServer/findServerSnapshot：写入可查、过期清理、未过期保留', () => {
  const s1 = { id: 'a|1.1.1.1', ip: '1.1.1.1', configBase64: 'x' };
  const s2 = { id: 'b|2.2.2.2', ip: '2.2.2.2', configBase64: 'y' };
  rememberServer(s1, 3600000); // 1h
  rememberServer(s2, -1000);   // 已过期
  assert.equal(findServerSnapshot('a|1.1.1.1').ip, '1.1.1.1', '未过期可查');
  assert.equal(findServerSnapshot('b|2.2.2.2'), null, '过期清理');
  assert.equal(findServerSnapshot('不存在'), null, '未知 id 返回 null');
  rememberServer(null); // 非法输入不报错
});
