/**
 * optimize.js — 筛选与优选评分
 *
 * 优选流程（全部参数来自配置，可前台调整）：
 *  1. 按 filters 剔除不符合条件的服务器；
 *  2. 对剩余服务器计算静态归一化评分（weights × 归一化值）；
 *  3. 取静态评分前 probe.probeCount 名做 TCP 连通性探测（并发受 concurrency 限制）；
 *  4. 可连通节点获得 reachableBoost 加成；requireReachable=true 时剔除不可连通节点；
 *  5. 按最终评分排序，返回前 optimize.topN 名。
 */

import { chunkParallel } from './util.js';
import { probeServer } from './probe.js';

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * 应用筛选条件。
 * @param {Array} servers - 服务器列表
 * @param {object} config - 生效配置
 * @returns {Array} 筛选后的服务器
 */
export function applyFilters(servers, config) {
  const f = config.filters;
  const hostRe = f.hostRegex ? new RegExp(f.hostRegex) : null;
  return servers.filter((s) => {
    if (f.disabledCountryCodes.includes(s.countryShort)) return false;
    if (f.enabledCountryCodes.length > 0 && !f.enabledCountryCodes.includes(s.countryShort)) return false;
    if (f.minUptimeHours > 0 && s.uptimeHours < f.minUptimeHours) return false;
    if (f.minSpeedMbps > 0 && s.speedBps < f.minSpeedMbps * 1e6) return false;
    if (f.maxPingMs > 0 && s.pingMs > 0 && s.pingMs > f.maxPingMs) return false;
    if (hostRe && !hostRe.test(s.hostname) && !hostRe.test(s.ip)) return false;
    return true;
  });
}

/**
 * 计算单台服务器的静态归一化评分（0~1）。
 * @param {object} s - 服务器
 * @param {object} config - 生效配置
 * @returns {number}
 */
export function scoreServer(s, config) {
  const { weights, norm } = config;
  const nScore = clamp01(s.score / norm.scoreRef);
  const nPing = s.pingMs > 0 ? clamp01(1 - s.pingMs / norm.pingTargetMs) : 0;
  const nSpeed = clamp01(s.speedBps / norm.speedTargetBps);
  const nUptime = clamp01(s.uptimeHours / norm.uptimeRefHours);
  const nFree = s.sessions > 0 ? clamp01(1 - s.sessions / norm.sessionsTarget) : 1;

  const total = weights.score + weights.ping + weights.speed + weights.uptime + weights.freeSessions;
  if (total <= 0) return 0;
  return (
    (weights.score * nScore + weights.ping * nPing + weights.speed * nSpeed +
      weights.uptime * nUptime + weights.freeSessions * nFree) / total
  );
}

/**
 * 执行完整优选。
 * @param {Array} servers - 全量服务器（含 base64 与否均可，仅用轻量字段）
 * @param {object} config - 生效配置
 * @param {Function} [probeFn] - 探测函数（默认 probeServer；单测可注入桩函数）
 * @param {number} [budgetMs] - 整体探测时间预算（默认 20000，平台 30s 墙钟内兜底）
 * @param {object} [opts] - 可选：{ ids: string[] } 本机实测模式——只对给定 id 集合按静态权重评分排序，跳过边缘探测
 * @returns {Promise<{ranked: Array, probed: Array}>}
 */
export async function runOptimize(servers, config, probeFn = probeServer, budgetMs = 15000, opts = {}) {
  const filtered = applyFilters(servers, config);

  // 静态评分排序，取前 probeCount 名探测
  const withBase = filtered.map((s) => ({ ...s, baseScore: scoreServer(s, config) }));
  withBase.sort((a, b) => b.baseScore - a.baseScore);

  // 本机实测模式：ids 集合已在浏览器直连筛过，直接按权重评分排序（跳过边缘探测）
  if (opts && Array.isArray(opts.ids)) {
    const inIds = new Set(opts.ids);
    const probed = withBase.filter((s) => inIds.has(s.id))
      .map((s) => ({ ...s, reachable: true, rttMs: null, port: null, score: s.baseScore }));
    probed.sort((a, b) => b.score - a.score);
    return {
      ranked: probed.slice(0, config.optimize.topN),
      probed: probed.map(({ id, hostname, ip, countryShort, baseScore, score, reachable, rttMs, port }) => ({
        id, hostname, ip, countryShort, baseScore, score, reachable, rttMs, port,
      })),
    };
  }

  const candidates = withBase.slice(0, config.probe.probeCount);

  // 并发探测：整体时间预算兜底，超时未返回的候选标记为不可达。
  // 原因：cloudflare:sockets 走边缘 egress，并发连接可能被限流挂起，
  // 逐批 Promise.all 会被最慢节点拖死；预算保证请求在平台墙钟内返回。
  const budget = Math.max(1000, budgetMs);
  const probed = await (async () => {
    const results = new Array(candidates.length).fill(null);
    const tasks = candidates.map((s, i) => (async () => {
      const p = await probeFn(s, config.probe.ports, config.probe.timeoutMs);
      results[i] = { ...s, ...p, score: p.reachable ? s.baseScore * (1 + config.probe.reachableBoost) : s.baseScore };
    })());
    const done = Promise.all(tasks.map((t) => t.catch(() => {})));
    const guard = new Promise((r) => setTimeout(r, budget));
    await Promise.race([done, guard]);
    return candidates.map((s, i) => results[i] || { ...s, reachable: false, rttMs: null, port: null, error: 'probe timeout', score: s.baseScore });
  })();

  // 是否仅保留可连通节点
  const pool = config.probe.requireReachable ? probed.filter((p) => p.reachable) : probed;
  pool.sort((a, b) => b.score - a.score);

  return {
    ranked: pool.slice(0, config.optimize.topN),
    probed: probed.map(({ id, hostname, ip, countryShort, baseScore, score, reachable, rttMs, port }) => ({
      id, hostname, ip, countryShort, baseScore, score, reachable, rttMs, port,
    })),
  };
}
