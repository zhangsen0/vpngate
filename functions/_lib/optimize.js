/**
 * optimize.js — 筛选与静态评分排序（纯计算，无任何网络探测）
 *
 * 架构约定：连通性探测只在用户浏览器内完成（见前端 localProbe），
 * 服务端仅按配置做筛选、归一化评分与排序，因此不存在边缘探测超时风险。
 */

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
 * 按配置筛选、评分并排序，返回前 topN 名。
 * @param {Array} servers - 全量服务器
 * @param {object} config - 生效配置
 * @param {string[]|null} [ids] - 仅保留这些 id（浏览器实测可达集合）；null 表示不过滤
 * @returns {{ranked: Array}} 排名结果，每项附带 baseScore / score
 */
export function rankServers(servers, config, ids = null) {
  const inIds = Array.isArray(ids) ? new Set(ids) : null;
  const ranked = applyFilters(servers, config)
    .filter((s) => !inIds || inIds.has(s.id))
    .map((s) => {
      const score = scoreServer(s, config);
      return { ...s, baseScore: score, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, config.optimize.topN);
  return { ranked };
}
