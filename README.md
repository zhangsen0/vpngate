# VPNGate 优选工具

> 拉取 VPNGate 全球公共节点 → 按可配置权重评分 → TCP 连通性实测 → 一键优选并生成可用 OpenVPN 节点配置。

## 特性

- **登录保护**：全站需登录访问，访问密码通过 Pages 环境变量 `APP_PASSWORD` 配置（当前为 `admin123`），换密码无需改代码。
- **实时节点**：从 VPNGate 官方接口 / GitHub 镜像拉取节点列表，数据源可在页面配置、按序回退。
- **可配置优选**：评分权重、筛选阈值、探测端口、结果条数等全部参数均可在页面修改（存于 Cloudflare KV）。
- **实测连通**：对静态评分靠前的节点做 TCP 握手探测（Cloudflare 边缘），只推荐真实可达的节点。
- **本机校验**：CF 边缘可达 ≠ 本机可达（ISP 可能屏蔽该 IP）。提供三种本机校验途径：一键本机探测命令（python3/PowerShell，精确 TCP 结果）、单文件浏览器探测页（本地 http 打开直测）、浏览器直连探测（http 页面自动生效）。结果可粘贴回页面自动标记，支持“仅本机可达”过滤。
- **多端原生创建 VPN**：节点详情与优选卡片内置「多端」面板。
  - **🔐 L2TP/IPsec 原生（免客户端）**：VPNGate 节点由 SoftEther 驱动，普遍开放 L2TP/IPsec（PSK=`vpn`、账密 `vpn/vpn`），iOS/Android/Windows/macOS/Linux **系统内置 VPN 直接创建**，无需第三方客户端。Windows 一条命令 `Add-VpnConnection + rasdial` 创建并连接；Linux `network-manager-l2tp + nmcli` 原生创建。
  - OpenVPN 方式：Linux NetworkManager 原生创建；iOS/Android 官方 OpenVPN Connect 一键导入；Windows/macOS 官方客户端一键导入；均附下载、复制链接/命令入口。
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
   ├── /api/optimize     评分 + TCP 连通性探测 + 优选排序（结果短时缓存）
   ├── /api/ovpn         生成 .ovpn 配置（remote 可改写为优选 IP）
   ├── /api/node         节点参数摘要
   ├── /api/probe        单点连通性测试
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
│   └── _lib/               # 核心库：config / sources / probe / optimize / ovpn / util
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
| 连通性探测 | ports / timeoutMs / probeCount / concurrency / requireReachable / reachableBoost | 探测参数与加成（整体探测预算 15s，超时节点标记不可达，保证平台 30s 墙钟内返回） |
| 优选结果 | topN / cacheSeconds | 返回条数 / 优选结果缓存时长（0 关闭；`POST /api/optimize` 支持 body 覆盖 country/topN/requireReachable/probeCount） |
| 节点配置 | rewriteRemoteToIp / appendOptions | remote 改写为优选 IP、附加 OpenVPN 选项 |
| 界面 | theme / defaultSort | 主题与默认排序 |

> 说明：连通性 RTT 由 Cloudflare 边缘测得，代表“节点可达性”而非用户本机延迟。
> 推荐配合「本机校验」确认本机网络可达性：优选结果与节点详情中均可一键发起，
> 使用本机探测命令（python3 / PowerShell）或本地 http 打开探测页完成浏览器直测，
> 结果粘贴回页面即可自动标记；勾选「仅本机可达」可过滤掉本机不可达的节点。

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
| POST | /api/optimize | 执行优选（可覆盖 country/topN/requireReachable，结果短时缓存） |
| GET | /api/ovpn?id= | 下载 .ovpn |
| GET | /api/node?id= | 节点参数 |
| POST | /api/probe | 单点探测 { ip, ports? } |
| GET | /api/logs?limit=50 | 操作日志 |
| POST | /api/auth/login \| logout | 登录 / 登出 |
| GET | /api/auth/me | 会话状态 |

## 使用示例

1. 打开站点，点击「刷新列表」获取最新节点；
2. 点击「⚡ 立即优选」查看实测可达的最优节点；
3. 在优选结果中点「本机校验全部」，用弹出的命令/探测页确认本机网络是否可达（防 CF 可达但本机不可达）；
4. 对可达节点点击节点 → 「多端一键」选择你的系统（iOS/Android/Windows/macOS/Linux），下载配置或复制一条命令即可连接；也可直接下载 .ovpn。

## 免责声明

- 本工具仅做公开节点信息聚合与连通性检测，不提供任何 VPN 传输服务。
- 请遵守所在地区法律法规，仅将节点用于合法用途。

## 许可证

MIT
