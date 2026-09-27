/**
 * OpenVPN 服务真实探测（CF 边缘出站 TCP，cloudflare:sockets）。
 *
 * 背景：浏览器只能测 HTTP/TLS 语义（fetch/WebSocket），无法发送 OpenVPN
 * 自定义二进制首包；本模块由 CF 边缘向节点发送 P_CONTROL_HARD_RESET_CLIENT_V1
 * 帧，若服务器回 P_CONTROL_HARD_RESET_SERVER_V1（opcode 8）则证明该端口上
 * OpenVPN 服务真实在线——用于筛掉"端口通但没开 OpenVPN"的节点。
 *
 * 帧结构（无 tls-auth，VPNGate 官方配置均无 <tls-auth>）：
 *   opcode(1) = 0x38（opcode 7 << 3 | key_id 0） + session_id(8) = 共 9 字节
 * 服务器响应首字节 0x40（opcode 8 << 3 | key_id 0）。
 */

import { connect } from 'cloudflare:sockets';

/**
 * 探测单个节点指定端口是否运行 OpenVPN 服务。
 * @param {string} ip - 节点 IP
 * @param {number} port - 探测端口（默认 443）
 * @param {number} timeoutMs - 超时毫秒（默认 4000）
 * @returns {Promise<{online: boolean, rttMs: number|null, error: string|null}>}
 */
export async function probeOvpnOne(ip, port = 443, timeoutMs = 4000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (online, error) => {
      if (done) return;
      done = true;
      resolve({ online, rttMs: Date.now() - t0, error });
    };
    try {
      const socket = connect({ hostname: ip, port });
      const reader = socket.readable.getReader();
      const writer = socket.writable.getWriter();
      // OpenVPN P_CONTROL_HARD_RESET_CLIENT_V1：0x38 + 8 字节随机 session id
      const buf = new Uint8Array(9);
      buf[0] = 0x38;
      crypto.getRandomValues(buf.subarray(1));
      writer.write(buf).catch(() => finish(false, 'write-failed'));
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* 忽略 */ }
        finish(false, 'timeout');
      }, timeoutMs);
      (async () => {
        try {
          const { value } = await reader.read();
          if (value && value.length > 0) {
            const b = value[0];
            if ((b & 0xe0) === 0x40) {
              clearTimeout(timer);
              finish(true, null); // P_CONTROL_HARD_RESET_SERVER_V1
            } else {
              clearTimeout(timer);
              finish(false, `bad-response-0x${b.toString(16)}`);
            }
          } else {
            clearTimeout(timer);
            finish(false, 'empty');
          }
        } catch (e) {
          clearTimeout(timer);
          finish(false, `closed:${e.message}`);
        }
      })();
    } catch (e) {
      finish(false, e.message);
    }
  });
}

/**
 * 并发探测多个节点（限定并发数，避免超 CF 子请求限制）。
 * @param {object} config - 生效配置（含 ovpnProbe 组：ports/concurrency/timeoutMs）
 * @param {Array<{id: string, ip: string}>} servers - 待探测节点（含 ip）
 * @returns {Promise<Object<string, {online: boolean, rttMs: number|null, error: string|null}>>}
 */
export async function probeOvpnBatch(config, servers) {
  const cfg = config.ovpnProbe || {};
  const concurrency = Math.min(Math.max(Number(cfg.concurrency) || 6, 1), 20);
  const timeoutMs = Math.min(Math.max(Number(cfg.timeoutMs) || 4000, 1000), 10000);
  const ports = Array.isArray(cfg.ports) && cfg.ports.length ? cfg.ports : [443];
  const port = ports[0];
  const out = {};
  let idx = 0;
  async function worker() {
    while (idx < servers.length) {
      const s = servers[idx++];
      out[s.id] = await probeOvpnOne(s.ip, port, timeoutMs);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, servers.length || 1) }, worker);
  await Promise.all(workers);
  return out;
}
