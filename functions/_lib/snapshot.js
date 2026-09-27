/**
 * snapshot.js — 节点快照缓存（内存 + KV，尽力而为）
 *
 * 背景：节点列表来自数据源（官方/镜像），节点随刷新动态上下线。
 * 用户复制下载链接（带令牌，有效期默认 10 分钟）后，若列表刷新导致
 * 该节点被移除，/api/ovpn 会 404（客户端报 "服务器响应不正确"）。
 *
 * 方案：生成免登录链接时把节点数据写入快照（内存 + KV），
 * 列表查询不到时回退到快照，保证链接在有效期内始终可下载。
 *  - 内存：同 isolate 内零延迟；isolate 回收后丢失
 *  - KV：跨 isolate 可靠；KV 不可用时自动降级内存（不阻塞主流程）
 * KV 读写频率低：仅"生成链接"写 1 次、"列表缺失时下载"读 1 次。
 */

/** KV 快照 key 前缀 */
const KV_PREFIX = 'snap:';

/** 快照表：id → { server, expiresAt }（内存层） */
const mem = new Map();

/** 默认快照保留时长(ms)：链接令牌有效期的 3 倍，最短 15 分钟 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * 写入节点快照（内存 + 尽力写 KV）。
 * @param {object} server - 完整节点对象（含 configBase64）
 * @param {number} ttlMs - 保留时长（默认 15 分钟）
 * @param {object|null} env - 环境对象（含 VPNGATE_CFG KV binding）
 */
export function rememberServer(server, ttlMs = DEFAULT_TTL_MS, env = null) {
  if (!server || !server.id) return;
  const expiresAt = Date.now() + ttlMs;
  mem.set(server.id, { server, expiresAt });
  // 顺手清理过期项，防止 Map 无限增长
  if (mem.size > 500) {
    const now = Date.now();
    for (const [k, v] of mem) {
      if (v.expiresAt < now) mem.delete(k);
    }
  }
  // KV 持久化（尽力而为，失败不影响内存层）
  try {
    const kv = env && env.VPNGATE_CFG;
    if (kv && kv.put) {
      const ttlSec = Math.max(60, Math.ceil(ttlMs / 1000));
      kv.put(KV_PREFIX + server.id, JSON.stringify(server), { expirationTtl: ttlSec }).catch(() => {});
    }
  } catch { /* KV 不可用则降级内存 */ }
}

/**
 * 按 id 查找节点快照（未过期）：内存 → KV。
 * @param {string} id - 节点 id（hostname|ip）
 * @param {object|null} env - 环境对象（含 VPNGATE_CFG KV binding）
 * @returns {Promise<object|null>} 节点对象或 null
 */
export async function findServerSnapshot(id, env = null) {
  if (!id) return null;
  const hit = mem.get(id);
  if (hit) {
    if (hit.expiresAt < Date.now()) {
      mem.delete(id);
    } else {
      return hit.server;
    }
  }
  // 内存未命中 → KV（尽力而为）
  try {
    const kv = env && env.VPNGATE_CFG;
    if (kv && kv.get) {
      const raw = await kv.get(KV_PREFIX + id);
      if (raw) {
        const server = JSON.parse(raw);
        mem.set(id, { server, expiresAt: Date.now() + DEFAULT_TTL_MS });
        return server;
      }
    }
  } catch { /* KV 不可用则降级 */ }
  return null;
}

/** 当前内存快照数量（诊断/测试用） */
export function snapshotCount() {
  return mem.size;
}
