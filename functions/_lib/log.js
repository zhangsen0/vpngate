/**
 * log.js — 必要操作日志
 *
 * 记录安全/配置/数据类关键操作（登录、登出、配置变更、强制刷新、优选、配置下载等），
 * 供管理员在页面「日志」面板查看。
 *
 * 写入策略（控制 KV 写频率）：
 *  - 日志先进入隔离岛内存缓冲；
 *  - 请求结束时经 context.waitUntil 批量落盘（一次请求最多一次 KV 写）；
 *  - 缓冲达到阈值时也会提前落盘；读取日志时先落盘再返回；
 *  - KV 内保留最近 MAX_LOGS 条。
 */

const KV_LOG_KEY = 'logs:v1';
const MAX_LOGS = 200;
const FLUSH_THRESHOLD = 10;

/** 隔离岛级日志缓冲 */
const buffer = [];
let flushPending = false;

/**
 * 记录一条日志（同步入缓冲，不阻塞请求）。
 * @param {object} env - 环境对象
 * @param {string} action - 动作名（login / config-save / optimize 等）
 * @param {string} detail - 详情（短文本）
 * @param {string} ip - 客户端 IP（可选）
 */
export function log(env, action, detail, ip) {
  buffer.push({ t: Date.now(), act: action, d: String(detail || '').slice(0, 200), ip: ip || '' });
  if (buffer.length >= FLUSH_THRESHOLD && !flushPending) {
    flushPending = true;
    flushLogs(env)
      .catch(() => { /* 落盘失败保留缓冲，下次再试 */ })
      .finally(() => { flushPending = false; });
  }
}

/** 请求结束时调用：有日志则批量落盘 */
export function flushPendingLogs(env) {
  if (buffer.length === 0) return Promise.resolve();
  flushPending = true;
  return flushLogs(env)
    .catch(() => { /* 忽略 */ })
    .finally(() => { flushPending = false; });
}

/**
 * 读取日志（先落盘再合并返回）。
 * @param {object} env - 环境对象
 * @param {number} limit - 返回条数
 * @returns {Promise<Array>} 按时间倒序
 */
export async function readLogs(env, limit = 50) {
  await flushLogs(env).catch(() => { /* 忽略 */ });
  const kv = env && env.VPNGATE_CFG;
  let list = [];
  if (kv) {
    try {
      const raw = await kv.get(KV_LOG_KEY);
      if (raw) list = JSON.parse(raw);
    } catch { /* 忽略 */ }
  }
  // 合并 KV 历史与当前缓冲（去重：缓冲内日志若已落盘会被合并）
  const merged = [...list, ...buffer]
    .sort((a, b) => b.t - a.t)
    .slice(0, Math.max(limit, MAX_LOGS));
  return merged.slice(0, limit);
}

/**
 * 将缓冲日志合并写入 KV（保留最近 MAX_LOGS 条）。成功后才清空缓冲。
 * @param {object} env - 环境对象
 */
async function flushLogs(env) {
  if (buffer.length === 0) return;
  const kv = env && env.VPNGATE_CFG;
  let list = [];
  if (kv) {
    try {
      const raw = await kv.get(KV_LOG_KEY);
      if (raw) list = JSON.parse(raw);
    } catch { /* 忽略 */ }
  }
  const merged = [...buffer, ...list].sort((a, b) => b.t - a.t).slice(0, MAX_LOGS);
  if (kv) {
    await kv.put(KV_LOG_KEY, JSON.stringify(merged));
  }
  buffer.length = 0;
}
