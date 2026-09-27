/**
 * snapshot.js — 节点快照缓存（内存，尽力而为）
 *
 * 背景：节点列表来自数据源（官方/镜像），节点会随刷新动态上下线。
 * 用户复制下载链接（带令牌，有效期默认 10 分钟）后，若列表刷新导致
 * 该节点被移除，/api/ovpn 会 404（客户端报 "服务器响应不正确"）。
 *
 * 方案：生成免登录链接时把节点数据写入内存快照（TTL = 链接令牌有效期×3），
 * 列表查询不到时回退到快照，保证链接在有效期内始终可下载。
 * 注意：workerd isolate 可能被回收，快照为尽力而为，不影响主流程。
 */

/** 快照表：id → { server, expiresAt } */
const snapshots = new Map();

/** 默认快照保留时长(ms)：链接令牌有效期的 3 倍，最短 15 分钟 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * 写入节点快照。
 * @param {object} server - 完整节点对象（含 configBase64）
 * @param {number} ttlMs - 保留时长（默认 15 分钟）
 */
export function rememberServer(server, ttlMs = DEFAULT_TTL_MS) {
  if (!server || !server.id) return;
  snapshots.set(server.id, { server, expiresAt: Date.now() + ttlMs });
  // 顺手清理过期项，防止 Map 无限增长
  if (snapshots.size > 500) {
    const now = Date.now();
    for (const [k, v] of snapshots) {
      if (v.expiresAt < now) snapshots.delete(k);
    }
  }
}

/**
 * 按 id 查找节点快照（未过期）。
 * @param {string} id - 节点 id（hostname|ip）
 * @returns {object|null} 节点对象或 null
 */
export function findServerSnapshot(id) {
  if (!id) return null;
  const hit = snapshots.get(id);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    snapshots.delete(id);
    return null;
  }
  return hit.server;
}

/** 当前快照数量（诊断/测试用） */
export function snapshotCount() {
  return snapshots.size;
}
