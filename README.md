# VPNGate 优选工具

> 拉取 VPNGate 全球公共节点 → 按可配置权重评分 → TCP 连通性实测 → 一键优选并生成可用 OpenVPN 节点配置。

## 特性

- **实时节点**：从 VPNGate 官方接口 / GitHub 镜像拉取节点列表，数据源可在页面配置、按序回退。
- **可配置优选**：评分权重、筛选阈值、探测端口、结果条数等全部参数均可在页面修改（存于 Cloudflare KV）。
- **实测连通**：对静态评分靠前的节点做 TCP 握手探测（Cloudflare 边缘），只推荐真实可达的节点。
- **本机校验**：CF 边缘可达 ≠ 本机可达（ISP 可能屏蔽该 IP）。提供三种本机校验途径：一键本机探测命令（python3/PowerShell，精确 TCP 结果）、单文件浏览器探测页（本地 http 打开直测）、浏览器直连探测（http 页面自动生效）。结果可粘贴回页面自动标记，支持“仅本机可达”过滤。
- **即配即用**：一键下载 .ovpn 配置文件，或复制节点参数（IP / 端口 / 协议 / 账密）。
- **轻量可信**：无框架单页应用，加载快；信息精炼，只展示关键指标。
- **快速部署**：测试环境手动直传部署包；生产环境 GitHub Actions 自动部署（均托管在 Cloudflare Pages）。

## 技术架构

```
浏览器（public/ 静态单页）
   │  /api/*
   ▼
Cloudflare Pages Functions（functions/）
   ├── /api/config      读取/保存配置（KV: VPNGATE_CFG，内存兜底）
   ├── /api/servers     拉取并解析节点列表（Cache API 缓存，可强制刷新）
   ├── /api/optimize    评分 + TCP 连通性探测 + 优选排序
   ├── /api/ovpn        生成 .ovpn 配置（remote 可改写为优选 IP）
   ├── /api/node        节点参数摘要
   └── /api/probe       单点连通性测试
数据源：http://www.vpngate.net/api/iphone/（CSV）+ auto-ovpn GitHub 镜像（JSON）
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

### 配置说明

页面右上角「⚙ 配置」可修改全部参数，实时保存到 KV。主要参数：

| 分组 | 参数 | 说明 |
|---|---|---|
| 数据源 | dataSources | 数据源列表（csv / json），按序尝试直到成功 |
| 拉取 | timeoutMs / maxServers / cacheSeconds | 超时、节点数上限、缓存时长 |
| 筛选 | disabledCountryCodes / enabledCountryCodes | 禁用/仅保留国家（两位码） |
| 筛选 | minUptimeHours / minSpeedMbps / maxPingMs / hostRegex | 在线时长、速度、延迟、主机名白名单 |
| 评分权重 | score / ping / speed / uptime / freeSessions | 各指标权重（0~10） |
| 归一化参考 | scoreRef / pingTargetMs / speedTargetBps / uptimeRefHours / sessionsTarget | 各指标归一化基准 |
| 连通性探测 | ports / timeoutMs / probeCount / concurrency / requireReachable / reachableBoost | 探测参数与加成 |
| 优选结果 | topN | 返回条数 |
| 节点配置 | rewriteRemoteToIp / appendOptions | remote 改写为优选 IP、附加 OpenVPN 选项 |
| 界面 | theme / defaultSort | 主题与默认排序 |

> 说明：连通性 RTT 由 Cloudflare 边缘测得，代表“节点可达性”而非用户本机延迟。
> 推荐配合「本机校验」确认本机网络可达性：优选结果与节点详情中均可一键发起，
> 使用本机探测命令（python3 / PowerShell）或本地 http 打开探测页完成浏览器直测，
> 结果粘贴回页面即可自动标记；勾选「仅本机可达」可过滤掉本机不可达的节点。

## 部署

### 测试环境（手动上传部署包）

```bash
CF_ACCOUNT=<测试账户ID> CF_TOKEN=<测试API令牌> \
CF_PROJECT=vpngate-test CF_DOMAIN=vpngate-test.zhangsen.kdns.fr \
./scripts/deploy-test.sh
```

脚本自动完成：生成部署包 → 创建 Pages 项目 / KV → 绑定 KV → 直传部署包 → 绑定自定义域名 → 校验 DNS。

### 生产环境（GitHub Actions 自动部署）

1. 在 GitHub 仓库 `Settings → Secrets and variables → Actions` 配置：

   | Secret | 值 |
   |---|---|
   | `CF_API_TOKEN` | 生产环境 API 令牌 |
   | `CF_ACCOUNT_ID` | 生产环境账户 ID |

2. 首次需要手动创建生产 Pages 项目与 KV 绑定（同测试脚本逻辑，参数换成生产值即可）。
3. 推送 `main` 分支即自动部署到生产，绑定域名 `vpngate.520215.xyz`。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 健康检查 |
| GET | /api/config | 读取配置 + SCHEMA |
| PUT | /api/config | 保存配置 |
| POST | /api/config/reset | 恢复默认配置 |
| GET | /api/servers?refresh=1 | 节点列表（refresh 强制刷新） |
| POST | /api/optimize | 执行优选 |
| GET | /api/ovpn?id= | 下载 .ovpn |
| GET | /api/node?id= | 节点参数 |
| POST | /api/probe | 单点探测 { ip, ports? } |

## 使用示例

1. 打开站点，点击「刷新列表」获取最新节点；
2. 点击「⚡ 立即优选」查看实测可达的最优节点；
3. 在优选结果中点「本机校验全部」，用弹出的命令/探测页确认本机网络是否可达（防 CF 可达但本机不可达）；
4. 对可达节点点击节点 → 下载 .ovpn，或复制节点参数到客户端。

## 免责声明

- 本工具仅做公开节点信息聚合与连通性检测，不提供任何 VPN 传输服务。
- 请遵守所在地区法律法规，仅将节点用于合法用途。

## 许可证

MIT
