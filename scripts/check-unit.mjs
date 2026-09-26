/**
 * check-unit.mjs — 单元测试
 *
 * 覆盖：配置校验/合并、CSV/JSON 解析、归一化、筛选、评分、优选（注入桩探测）、
 *       OpenVPN 配置生成。运行：node scripts/check-unit.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig, mergeConfig, DEFAULTS } from '../functions/_lib/config.js';
import { parseCsv, parseJson, normalizeServers } from '../functions/_lib/sources.js';
import { applyFilters, scoreServer, runOptimize } from '../functions/_lib/optimize.js';
import { decodeConfig, buildOvpn, nodeParams } from '../functions/_lib/ovpn.js';

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

test('normalizeServers：过滤非法 IP 并生成 id', () => {
  const servers = normalizeServers(parseJson(sampleJson()));
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, 'public-vpn-3|3.3.3.3');
  assert.ok(!('configBase64' in servers[0]), '轻量对象不应包含 base64');
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

// ==================== 汇总 ====================

test('汇总：所有模块可加载、默认配置结构完整', () => {
  assert.ok(DEFAULTS.fetch.timeoutMs > 0);
  assert.ok(DEFAULTS.dataSources.length >= 1);
  assert.ok(['csv', 'json'].includes(DEFAULTS.dataSources[0].type));
});
