/**
 * ovpn.js — OpenVPN 配置生成
 *
 * 基于服务器自带的 base64 配置文本，按配置规则做轻量改写：
 *  - 可选：把 remote 主机名改写为优选 IP（直连优选 IP，避免 DNS 解析到别的地址）；
 *  - 追加配置中的附加选项（如 data-ciphers / auth-nocache）。
 */

/**
 * 解码服务器自带配置文本。
 * @param {object} server - 服务器（含 configBase64）
 * @returns {string|null} 解码后的配置文本
 */
export function decodeConfig(server) {
  if (!server || !server.configBase64) return null;
  try {
    const bytes = Uint8Array.from(atob(server.configBase64), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 生成最终 .ovpn 配置文本。
 * @param {object} server - 服务器（含 configBase64）
 * @param {object} config - 生效配置（读取 ovpn.* 段）
 * @returns {{text: string, port: number|null, proto: string|null}|null}
 */
export function buildOvpn(server, config) {
  const raw = decodeConfig(server);
  if (raw == null) return null;
  const ov = config.ovpn;

  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // 清理 SoftEther 模板残留的大写指令行（证书块后）：DATA-CIPHERS / AUTH-NOCACHE /
  // BLOCK-OUTSIDE-DNS。OpenVPN 选项大小写敏感，大写形式不被识别，
  // 客户端解析报 Options error → 导入/连接失败。
  // 用白名单精确删除（不依赖标签行解析），正确的小写形式要么已存在
  // （如 data-ciphers AES-128-CBC），要么非必需，删除不影响功能。
  text = text
    .replace(/^[ \t]*(DATA-CIPHERS|AUTH-NOCACHE|BLOCK-OUTSIDE-DNS)(\s.*)?$/gm, '')
    .replace(/\n{2,}/g, '\n');

  // 改写 remote：remote <host> <port> [proto] 或 remote <ip> <port> [proto]
  let port = null;
  let proto = null;
  if (ov.rewriteRemoteToIp) {
    text = text.replace(/^(remote)\s+\S+\s+(\d{1,5})(\s+(udp|tcp))?.*$/gim, (_m, _r, p, _t, pr) => {
      port = Number.parseInt(p, 10);
      proto = (pr || '').toLowerCase() || null;
      return `remote ${server.ip} ${p}${pr ? ' ' + pr : ''}`;
    });
  } else {
    const m = text.match(/^remote\s+\S+\s+(\d{1,5})(\s+(udp|tcp))?/im);
    if (m) {
      port = Number.parseInt(m[1], 10);
      proto = (m[3] || '').toLowerCase() || null;
    }
  }

  // 附加选项
  const extras = Array.isArray(ov.appendOptions) ? ov.appendOptions.filter(Boolean) : [];
  if (extras.length > 0) text += '\n' + extras.join('\n');

  // 临时诊断标记：验证线上是否运行最新 buildOvpn（验证后移除）
  text += '\n# debug-ovpn-clean-5071196\n';

  return { text, port, proto };
}

/**
 * 生成“节点参数”摘要（供前端展示与复制，不含配置全文）。
 * @param {object} server - 服务器
 * @param {object} ovpn - buildOvpn 的返回
 * @returns {object}
 */
export function nodeParams(server, ovpn) {
  return {
    id: server.id,
    hostname: server.hostname,
    ip: server.ip,
    port: ovpn && ovpn.port,
    proto: ovpn && ovpn.proto,
    authUser: 'vpn',
    authPass: 'vpn',
    country: server.countryShort,
    remark: `vpngate-${server.countryShort}-${server.ip}`,
  };
}
