# VPNGate 优选工具

> 拉取 VPNGate 全球公共节点 → 按可配置权重评分 → 浏览器本地实测连通性 → 一键优选并生成可用 OpenVPN 节点配置。
>
> 服务端只做数据拉取、解析与纯评分计算，**不提供任何 CF 边缘探测能力**；连通性一律由你的浏览器直连实测，因此不存在「边缘探测节点较慢 / 优选超时」问题。

## 特性

- **登录保护**：全站需登录访问，访问密码通过 Pages 环境变量 `APP_PASSWORD` 配置（当前为 `admin123`），换密码无需改代码。
- **实时节点**：从 VPNGate 官方接口 / GitHub 镜像拉取节点列表，数据源可在页面配置、按序回退。
- **可配置优选**：评分权重、筛选阈值、浏览器实测端口、结果条数等全部参数均可在页面修改（存于 Cloudflare KV）。
- **浏览器本地实测 + 加强优选**：点击「⚡ 立即优选」即在**当前页面内**用浏览器直连各节点实际 TCP 端口（`fetch` no-cors），只推荐本机网络真实可达的节点；超时自动补测一次，结果按「静态评分 × 本机实测延迟 × 服务类型」综合排序（慢节点靠后、疑似网页服务降权），连不上可一键跳过；不依赖 Cloudflare 边缘探测，无 30s 墙钟超时。
- **简洁**：服务端仅保留纯静态评分排序，已移除 TCP 握手探测、OpenVPN 服务探测、单点探测接口以及命令行/下载探测页等冗余路径。
- **多端原生创建 VPN**：节点详情与优选卡片内置「多端」面板。
  - **🔐 L2TP/IPsec 原生（免客户端）**：VPNGate 节点由 SoftEther 驱动，普遍开放 L2TP/IPsec（PSK=`vpn`、账密 `vpn/vpn`），iOS/Android/Windows/macOS/Linux **系统内置 VPN 直接创建**，无需第三方客户端。Windows 一条命令 `Add-VpnConnection + rasdial` 创建并连接；Linux `network-manager-l2tp + nmcli` 原生创建。
  - OpenVPN 方式：Linux NetworkManager 原生创建；iOS/Android 官方 OpenVPN Connect 一键导入；Windows/macOS 官方客户端一键导入；均附下载、复制链接/命令入口。
  - **可清理**：每条创建命令都列出「创建了什么」（下载的文件、Windows 注册表值 / 系统 VPN 连接、Linux 软件包 / NetworkManager 连接），并配一条可复制的「删除命令」；配置连不上或用不上时可完整清理，主页「使用说明」的快捷命令同样附带删除命令。
- **即配即用**：一键下载 .ovpn 配置文件，或复制节点参数（IP / 端口 / 协议 / 账密）。
- **轻量可信**：无框架单页应用，加载快；信息精炼，只展示关键指标。
- **KV 少读写 + 操作日志**：配置读取走内存缓存（默认 60s，`CONFIG_CACHE_SECONDS` 可调），KV 只在必要时读写；登录/登出/配置变更/强制刷新/优选/下载等必要操作记录日志（KV 缓冲批量落盘，保留 200 条），页面「日志」面板可查。
- **存储双模式**：KV / 内存自动降级——KV 故障时自动降级内存模式继续服务，恢复后可在配置面板手动「同步到 KV」；也支持手动切换 `auto / memory / kv`。
- **安全加固**：登录防爆破（连续失败锁定，`LOGIN_MAX_FAIL`/`LOGIN_LOCK_MIN` 可调）；签名 Cookie 会话（改密即旧会话失效）；`/api/healthz` 无鉴权探活接口；静态资源长缓存。
- **快速部署**：测试环境手动直传部署包；生产环境 GitHub Actions 自动部署（均托管在 Cloudflare Pages）。

## 技术架构

```
浏览器（public/ 静态单页）
   │  /api/*
   ▼
Cloudflare Pages Functions（functions/）
   ├── /api/config       读取/保存配置（KV: VPNGATE_CFG，内存缓存 + 双模式降级）
   ├── /api/config/storage       切换存储模式 / 手动同步内存到 KV
   ├── /api/servers      拉取并解析节点列表（Cache API 缓存，可强制刷新）
   ├── /api/optimize     纯静态筛选 + 评分排序（可传 ids 只排浏览器实测可达集合）
   ├── /api/ovpn         生成 .ovpn 配置（remote 可改写为优选 IP）
   ├── /api/node         节点参数摘要
   ├── /api/logs         操作日志
   ├── /api/healthz      无鉴权探活
   └── /api/auth/*       登录/登出/会话
数据源（按序回退，全部可在页面配置）：VPNGate 官方 https://www.vpngate.net/api/iphone/（CSV；国内直连 DNS 被污染不可达，经 CF 边缘 + 浏览器 UA + 失败重试可正常拉取，部署实测 ✅ 97 节点）
+ GitHub 镜像：9xN/auto-ovpn（JSON）、Vepashka94 / NetLops / ezedin63 的 vpngate-mirror（CSV，官方格式）
```

## 目录结构

```
vpngate/
├── public/                 # 前端静态资源（index.html / app.js / style.css）
├── functions/              # Pages Functions API
│   ├── api/[[path]].js     # API 路由入口
│   └── _lib/               # 核心库：config / sources / optimize / ovpn / util
├── scripts/
│   ├── check-syntax.mjs    # 全量语法检查
│   ├── check-unit.mjs      # 单元测试
│   ├── package.mjs         # 生成部署包（zip）
│   └── deploy-test.sh      # 测试环境手动部署
├── .github/workflows/      # 生产环境自动部署
├── wrangler.toml           # 本地开发配置
└── AGENTS.md               # 开发规范
```

## 快速开始

### 本地开发

```bash
npm install          # 安装 wrangler
npm run check        # 语法检查 + 单元测试
npm run dev          # 本地启动（http://localhost:8787）
```

本地开发时配置保存在隔离岛内存中（无 KV 绑定），功能与线上一致。
本地登录密码：在项目根目录创建 `.dev.vars` 文件（已 gitignore）：

```bash
APP_PASSWORD=admin123
```

### 访问控制

- 整个项目（页面 + API）需要登录使用，未登录访问页面自动跳转登录页。
- 访问密码来自 Pages **环境变量** `APP_PASSWORD`（`secret_text` 类型），部署脚本自动注入；当前默认值为 `admin123`。
- 修改密码：CF 控制台 → Workers & Pages → 项目 → 设置 → 环境变量 → 更新 `APP_PASSWORD`（或使用 `scripts/deploy-test.sh` 的 `APP_PASSWORD` 入参重新部署）。
- 会话有效期默认 7 天，可用环境变量 `SESSION_TTL_DAYS` 调整。

### 配置说明

页面右上角「⚙ 配置」可修改全部参数，实时保存到 KV。主要参数：

| 分组 | 参数 | 说明 |
|---|---|---|
| 数据源 | dataSources | 数据源列表（csv / json），按序尝试直到成功。默认：官方接口（常不可达，自动跳过）+ 4 个 GitHub 镜像（见上文），均可增删改 |
| 拉取 | timeoutMs / maxServers / cacheSeconds | 超时、节点数上限、缓存时长 |
| 筛选 | disabledCountryCodes / enabledCountryCodes | 禁用/仅保留国家（两位码） |
| 筛选 | minUptimeHours / minSpeedMbps / maxPingMs / hostRegex | 在线时长、速度、延迟、主机名白名单 |
| 评分权重 | score / ping / speed / uptime / freeSessions | 各指标权重（0~10） |
| 归一化参考 | scoreRef / pingTargetMs / speedTargetBps / uptimeRefHours / sessionsTarget | 各指标归一化基准 |
| 浏览器实测 | enabled / ports / timeoutMs / maxNodes / maxUdpCandidates | 页面内直连实测开关、端口、单端口超时、实测节点上限、UDP 候选展示数 |
| 优选结果 | topN | 返回条数（`POST /api/optimize` 支持 body 覆盖 country/topN/refresh/ids） |
| 节点配置 | rewriteRemoteToIp / appendOptions | remote 改写为优选 IP、附加 OpenVPN 选项（默认仅 auth-nocache；勿追加 block-outside-dns——Windows 专用，Linux/macOS 上 OpenVPN 2.5+ 报 Options error；勿追加 data-ciphers——会覆盖原始配置导致 cipher 协商失败） |
| 界面 | theme / defaultSort | 主题与默认排序 |

> 说明：连通性由**你的浏览器**直连实测，RTT 反映本机网络到节点的延迟，服务端不做任何探测。
> 判定规则：仅「连接超时」判不可达（TCP 未建立）；端口有响应（含协议断开/证书错误）即视为可达；
> UDP 端口浏览器无法探测，标注「UDP 未测·试连」。勾选「仅本机可达」可过滤掉实测超时的节点。

### 配置存储（KV / 内存双模式）

- 配置面板顶部提供「配置存储」区：模式 `auto`（默认，KV 优先）/ `仅内存` / `仅KV`；
- KV 故障时自动降级为内存模式继续服务（页面与 `/api/health` 会显示降级状态）；
- KV 恢复后点击「同步内存到 KV」手动写回；切换为 `kv` 模式时也会自动同步一次；
- 环境变量：`STORAGE_MODE`（默认 auto）、`CONFIG_CACHE_SECONDS`（配置缓存 TTL，默认 60s，0 表示每次直读 KV）。

### 操作日志

- 记录：登录成功/失败、登出、配置保存/恢复、存储模式切换/同步、强制刷新、优选、.ovpn 下载；
- 日志先入内存缓冲、请求结束时批量落盘（KV 键 `logs:v1`，保留最近 200 条），KV 写频率极低；
- 页面右上角「日志」可查看最近 50 条（时间 / 动作 / IP / 详情）。

## 部署

### 测试环境（手动上传部署包）

```bash
APP_PASSWORD=admin123 \
CF_ACCOUNT=<测试账户ID> CF_TOKEN=<测试API令牌> \
CF_PROJECT=vpngate-test CF_DOMAIN=vpngate-test.zhangsen.kdns.fr \
./scripts/deploy-test.sh
```

脚本自动完成：生成部署包 → 创建 Pages 项目 / KV（如缺）→ wrangler 直传部署包（部署期配置注入真实 KV 绑定）→ 部署后写回 KV 绑定与 `APP_PASSWORD` → 绑定自定义域名 → 校验/提示 DNS。

> 说明：部署后绑定写回是关键步骤——wrangler 部署会用部署目录的 `wrangler.toml` 同步项目级绑定，因此脚本生成带真实 KV id 的配置并从 `dist` 目录执行，部署后再 API 幂等写回绑定与密码。

### 生产环境（GitHub Actions 自动部署）

1. 首次初始化（脚本已代为实现，步骤供参考）：
   - 创建 Pages 项目 `vpngate`、KV 命名空间 `vpngate-cfg`；
   - 绑定自定义域名 `vpngate.520215.xyz`，并添加 CNAME：`vpngate → <项目默认 pages.dev 域名>`（注意以项目实际 subdomain 为准，不一定是 `vpngate.pages.dev`）；
   - 项目绑定 KV `VPNGATE_CFG` 与环境变量 `APP_PASSWORD`（secret_text）。
2. 在 GitHub 仓库 `Settings → Secrets and variables → Actions` 配置：

   | Secret | 值 |
   |---|---|
   | `CF_API_TOKEN` | 生产环境 API 令牌 |
   | `CF_ACCOUNT_ID` | 生产环境账户 ID |
   | `CF_KV_NAMESPACE_ID` | 生产 KV 命名空间 ID |
   | `CF_APP_PASSWORD` | 访问密码（如 `admin123`） |

3. 推送 `main` 即自动部署：代码检查（语法+单测）→ 生成生产绑定配置 → 组装部署包 → wrangler 直传 → 幂等写回绑定。生产域名 `vpngate.520215.xyz`。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 健康检查（含存储状态） |
| GET | /api/healthz | 无鉴权探活（外部监控用） |
| GET | /api/config | 读取配置 + SCHEMA + 存储状态 |
| PUT | /api/config | 保存配置 |
| POST | /api/config/reset | 恢复默认配置 |
| PUT | /api/config/storage | 切换存储模式 { mode: auto/memory/kv } |
| POST | /api/config/storage/sync | 手动把内存配置同步到 KV |
| GET | /api/servers?refresh=1 | 节点列表（refresh 强制刷新） |
| POST | /api/optimize | 纯静态评分排序（可覆盖 country/topN/refresh，或传 `{ ids }` 只排浏览器实测可达集合） |
| GET | /api/ovpn?id= | 下载 .ovpn |
| GET | /api/node?id= | 节点参数 |
| GET | /api/logs?limit=50 | 操作日志 |
| POST | /api/auth/login \| logout | 登录 / 登出 |
| GET | /api/auth/me | 会话状态 |

## 使用示例

1. 打开站点，点击「强制刷新」获取最新节点；
2. 点击「⚡ 立即优选」：浏览器**当前页面内**直连评分前 `localProbe.maxNodes` 名（默认 120）节点的实际 TCP 端口，实时显示进度与「本机✓ / 本机✗(超时)」；超时节点自动补测一次，减少抖动误杀；
3. 实测完成后把**本机可达集合**交给服务端按静态权重评分，前端再按「静态评分 × 本机实测 RTT × 服务类型」综合重排：延迟高的自动靠后，端口返回完整网页响应（标「疑似网页服务」）的节点降权；可在结果中点「🔍 重新实测」再测一次；
4. 若全部超时，展示静态评分结果并提示（可切换 WiFi/流量、增大实测节点上限后重试）；
5. 试连失败时点卡片「连不上」：该节点本次会话内不再入选，换下一个；也可在配置里设置 RTT 上限硬过滤慢节点；
6. 对达标节点点「多端」选择系统（iOS/Android/Windows/macOS/Linux）创建连接，或直接「下载配置」。

> 实测参数全部可配（配置 → 浏览器实测）：启用开关 / 端口 / 单端口超时 / 实测节点上限 / UDP 候选数 / 实测 RTT 上限（`maxRttMs`，0 = 不过滤仅降权）。
> ⚠️ 浏览器只能验证 TCP 端口可达：无法发 OpenVPN 协议包、无法验证账密与认证、无法测 UDP，所以「本机✓」不等于一定能连上（节点也可能刚下线），连不上请换节点或改用 L2TP。
> 若关闭实测，则「立即优选」直接返回静态评分 Top N。

## 免责声明

- 本工具仅做公开节点信息聚合与连通性检测，不提供任何 VPN 传输服务。
- 请遵守所在地区法律法规，仅将节点用于合法用途。

## 许可证

MIT
