/**
 * probe.js — TCP 连通性探测
 *
 * 借助 Cloudflare 运行时内置的 cloudflare:sockets 能力，对目标 IP:端口做 TCP 握手探测，
 * 返回是否可连通与握手耗时(RTT)。ICMP ping 在浏览器/Worker 侧不可用，TCP 握手是
 * 评估“节点可达性”最可靠的替代信号（注意：RTT 测量于 Cloudflare 边缘，非用户本机）。
 *
 * 说明：cloudflare:sockets 仅在 workerd 运行时存在；本地 Node 单测会以桩函数替代本模块。
 */

let connectFn = null;

/** 动态获取 cloudflare:sockets 的 connect（避免在 Node 环境顶层引入报错） */
async function getConnect() {
  if (connectFn) return connectFn;
  const mod = await import('cloudflare:sockets');
  connectFn = mod.connect;
  return connectFn;
}

/**
 * 对单个 IP:端口做 TCP 握手探测。
 * @param {string} ip - 目标 IPv4
 * @param {number} port - 目标端口
 * @param {number} timeoutMs - 超时毫秒
 * @returns {Promise<{ip: string, port: number, ok: boolean, rttMs: number|null}>}
 */
export async function probeTcp(ip, port, timeoutMs) {
  const t0 = Date.now();
  let socket = null;
  let timer = null;
  try {
    const connect = await getConnect();
    socket = connect({ hostname: ip, port });
    // 新版 Socket API：opened/closed 为 Promise（旧式 addEventListener 已移除）。
    // 关键：opened/closed 都必须挂 catch，否则不可达 IP 的 opened reject 会产生
    // unhandled rejection，导致 workerd isolate 报 internal call error、请求挂死。
    return await new Promise((resolve) => {
      let settled = false;
      const done = (ok, rtt, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket && socket.close(); } catch { /* 忽略 */ }
        resolve({ ip, port, ok, rttMs: ok ? rtt : null, error: error || null });
      };
      socket.opened
        .then(() => done(true, Date.now() - t0, null))
        .catch((e) => done(false, null, String((e && e.message) || e || 'open failed')));
      socket.closed
        .then(() => done(false, null, 'closed'))
        .catch((e) => done(false, null, String((e && e.message) || e || 'closed')));
      // 超时：触发 done 后立即 close，避免挂起的握手占用资源
      timer = setTimeout(() => done(false, null, 'timeout'), timeoutMs);
    });
  } catch (e) {
    try { socket && socket.close(); } catch { /* 忽略 */ }
    return { ip, port, ok: false, rttMs: null, error: `connect threw: ${(e && e.message) || e}` };
  }
}

/**
 * 对某服务器按端口列表探测，取首个成功端口。
 * @param {object} server - { ip }
 * @param {number[]} ports - 探测端口列表
 * @param {number} timeoutMs - 单端口超时
 * @returns {Promise<{reachable: boolean, rttMs: number|null, port: number|null}>}
 */
export async function probeServer(server, ports, timeoutMs) {
  let lastError = null;
  for (const port of ports) {
    const r = await probeTcp(server.ip, port, timeoutMs);
    if (r.ok) return { reachable: true, rttMs: r.rttMs, port, error: null };
    if (r.error) lastError = r.error;
  }
  return { reachable: false, rttMs: null, port: null, error: lastError };
}
