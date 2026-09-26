---
name: vpngate-devops
description: VPNGate 优选工具（Cloudflare Pages）的开发、部署、验证与排障。适用于拉取 VPNGate 节点做 IP 优选、生成 OpenVPN/L2TP 多端 VPN 配置的 Web 应用；覆盖测试/生产双环境部署、wrangler 直传、KV 绑定同步、Pages Functions 排障、全量 e2e 验证。当需要改这个项目、部署它、修线上问题或验证功能时使用。
---

# vpngate-devops — VPNGate 优选工具运维技能

项目根：`<repo>/vpngate`（git 仓库 zhangsen0/vpngate，公开）。
产物：Cloudflare Pages 静态站 + Pages Functions，全站登录保护，访问密码来自环境变量 `APP_PASSWORD`。

## 架构速览

```
public/              静态单页（index.html/app.js/style.css/login.html）
functions/
  api/[[path]].js    API 路由（config/servers/optimize/ovpn/node/probe/logs/auth/health/healthz）
  _middleware.js     全站鉴权（放行 /login.html、/login、/api/auth/*、/api/healthz）
  _lib/              config(存储双模式) sources(数据源) optimize(评分优选) probe(TCP探测)
                     ovpn(base64→.ovpn) auth(HMAC签名会话+登录防爆破) log(操作日志) util
scripts/
  package.mjs        生成部署包 dist/（public 平铺 + functions + _headers，不含 wrangler.toml）
  check-syntax.mjs   全量语法检查
  check-unit.mjs     单元测试（node:test，18 项）
  e2e-test.mjs       端到端全量验证 <baseUrl> <password>
  deploy-test.sh     测试环境手动部署（wrangler 直传）
  upload-pages.py    旧直传脚本（已被 wrangler 替代，保留参考）
.github/workflows/deploy.yml  生产自动部署
wrangler.toml        本地开发配置（严禁在仓库内配置绑定，见「部署」）
```

## 环境变量与绑定（全部配置化，代码不写死）

| 项 | 说明 |
|---|---|
| `APP_PASSWORD` | 访问密码（secret_text），必配；改密码即旧会话自动失效（HMAC 密钥=密码） |
| `SESSION_TTL_DAYS` | 会话有效期（默认 7 天） |
| `CONFIG_CACHE_SECONDS` | 配置内存缓存 TTL（默认 60，0=每次直读 KV） |
| `STORAGE_MODE` | 存储模式默认值（auto/memory/kv） |
| `LOGIN_MAX_FAIL` / `LOGIN_LOCK_MIN` | 登录防爆破：连续失败次数/锁定分钟（默认 5/10） |
| KV 绑定 `VPNGATE_CFG` | 配置键 `global`、存储模式元数据 `meta`、日志键 `logs:v1` |
| 数据源 | 官方 https://www.vpngate.net/api/iphone/（CSV）+ auto-ovpn GitHub 镜像（JSON），页面可配 |

## 部署（重要：绑定同步行为）

**wrangler 部署会用「CWD 的 wrangler.toml」同步项目级 KV 绑定**（本地配置无绑定会清掉项目 production 的 KV 绑定）。因此：

1. 仓库内 `wrangler.toml` 保持无绑定（仅本地 dev）。
2. 部署前生成带**真实 KV id** 的 wrangler.toml 并从其所在目录执行：
   - 测试：`deploy-test.sh` 生成 `dist/wrangler.toml` 后 `cd dist && wrangler pages deploy .`；
   - 生产：CI 用 Secrets 生成根目录 wrangler.toml 再部署。
3. 部署后**必须 API 幂等写回**绑定 + APP_PASSWORD（脚本/工作流已实现）。

手动部署测试环境：
```bash
APP_PASSWORD=admin123 CF_ACCOUNT=<测试账户ID> CF_TOKEN=<测试令牌> \
CF_PROJECT=vpngate-test CF_DOMAIN=vpngate-test.zhangsen.kdns.fr \
./scripts/deploy-test.sh
```
生产：push main 即 Actions 自动部署（Secrets：CF_API_TOKEN / CF_ACCOUNT_ID / CF_KV_NAMESPACE_ID / CF_APP_PASSWORD）。

## 验证

```bash
node scripts/check-syntax.mjs && node scripts/check-unit.mjs   # 18 项单测
node scripts/e2e-test.mjs <baseUrl> <password>                 # 46 项端到端（认证+全接口+用户流程）
```
e2e 通过 = 用户使用级测试 + 全部接口测试（登录/登出/配置读写/存储切换/同步/日志/servers/refresh/optimize/ovpn/node/probe/health/healthz/404/越界收敛）。

## 关键排障知识（踩坑记录）

- **Pages 直传 API 是两步流程**：先 POST `/pages/assets/upload`（JWT 认证）传文件，再 POST `/deployments` 带 manifest+`_worker.bundle`。旧的「manifest+文件一次性 multipart」会被静默接受但文件不挂载（部署记录 file_hash_list 为空、页面全 404）——直接用 wrangler 部署即可规避。
- **cloudflare:sockets 新版 API**：`connect({hostname,port})` 返回 Socket，用 `socket.opened`（Promise）/`socket.closed`（Promise）判断连通；旧式 `addEventListener('opened')` 会报 `socket.addEventListener is not a function`，导致所有节点探测全 false。
- **Pages 平台会把 `/login.html` 自动 308 到 `/login`**（去扩展名）；中间件必须同时放行 `/login`，否则登录页 308→/login→302→/login.html 死循环。
- **normalizeServers 必须保留 `configBase64`**（列表接口由路由裁剪）；裁掉会导致所有 .ovpn 404「缺少 OpenVPN 配置数据」。
- **自定义域名绑定用 POST** `/pages/projects/{p}/domains`（body `{"name":...}`）；PUT 会 405。
- **项目 pages.dev 子域不一定是 `<project>.pages.dev`**（被占用时会生成如 `vpngate-b44.pages.dev`）；CNAME 目标必须以项目实际 subdomain 为准，否则域名卡 pending。
- **Pages 项目 kv_namespaces 是对象结构**：`{"VPNGATE_CFG":{"namespace_id":"..."}}`，不是数组；env_vars 同样对象结构。
- **VPNGate 官方源可能 504**（外部故障）：镜像源（97 节点）自动兜底，页面数据源状态会显示失败，属正常降级。
- **大多免费节点真实不可达**（97 个里只有 2~3 个在线）；`requireReachable=true`（默认）时 ranked 可能为空是正确行为，配合「本机校验」使用（CF 可达 ≠ 本机可达）。
- **wrangler.toml 不要提交占位 KV id**：部署时会按它同步项目绑定导致生产绑定被清/报 `KV namespace '0000...' not found`。
- **GitHub Secrets 需公钥加密**：用 `gh secret set`（或 PyNaCl），不能直接 PUT 明文。
- **pages-action 已不可用**（`Unable to resolve action cloudflare/pages-action`）：改用 `npx wrangler@4 pages deploy` 直传。
- **CI heredoc 写 wrangler.toml 别用引号 `<<'EOF'`**：环境变量不会展开，KV id 会变成字面量 `${CF_KV_NAMESPACE_ID}`。

## 多端 VPN 要点

- VPNGate 节点（SoftEther）开放 **L2TP/IPsec**：PSK `vpn`、账密 `vpn/vpn`，iOS/Android/Windows/macOS/Linux 系统内置 VPN 原生创建（Windows：`Add-VpnConnection -TunnelType L2tp -L2tpPsk "vpn"` + `rasdial`；Linux：network-manager-l2tp + nmcli）。
- OpenVPN 方式：.ovpn 下载 + 各端导入命令；远程需改写 remote 为优选 IP（`rewriteRemoteToIp` 配置）。
- 部分系统新版本可能移除 L2TP 选项，面板已注明。
