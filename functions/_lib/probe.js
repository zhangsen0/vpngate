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
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, rtt, error) => {
      if (settled) return;
      settled = true;
      resolve({ ip, port, ok, rttMs: ok ? rtt : null, error: error || null });
    };

    (async () => {
      let socket;
      try {
        const connect = await getConnect();
        // 新版 Socket API：opened/closed 为 Promise（旧式 addEventListener 已移除）
        socket = connect({ hostname: ip, port });
        const opened = Promise.resolve(socket.opened).then(() => done(true, Date.now() - t0));
        const closed = Promise.resolve(socket.closed).catch((e) =>
          done(false, null, String((e && e.message) || e || 'connection closed')));
        const timeout = new Promise((r) => setTimeout(() => done(false, null, 'timeout'), timeoutMs));
        await Promise.race([opened, closed, timeout]);
        try { socket.close(); } catch { /* 忽略 */ }
      } catch (e) {
        try { socket && socket.close(); } catch { /* 忽略 */ }
        done(false, null, `connect threw: ${e.message}`);
      }
    })();
  });
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
