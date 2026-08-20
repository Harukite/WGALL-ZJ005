# Dokploy Web 部署指南

本文说明如何使用 Dokploy Web 控制台部署本项目。
项目是一个需要持续运行的 Node.js 服务，不是静态网站。
首次部署必须使用 `paper` 模式完成验收，再考虑启用 `live`。

<!-- prettier-ignore -->
> [!CAUTION]
> 仪表盘可以启动、停止网格并修改配置，必须完成单账户登录。
> 生产环境必须配置 HTTPS、`AUTH_PASSWORD_HASH` 和可信反向代理设置；启用
> `live` 前仍建议配置 VPN、Cloudflare Access 或其他访问控制。

## 1. 部署前确认

开始前确认代码来自已验证的 Git 分支，并准备好 Dokploy 服务器的域名、
HTTPS、单账户密码哈希和访问控制方案。

- 仓库：`Harukite/WGALL-ZJ005`；可以选择已推送的
  `codex/grid-risk-gate` 分支进行验证。
- 运行时：Node.js 20 或更高版本。
- 启动命令：`npm start`，实际执行 `node src/server.js`。
- 服务端口：`8283`。
- 当前仓库没有 `Dockerfile`、`docker-compose.yml` 或 Dokploy 专用配置，
  使用 Dokploy 的 Railpack 或 Nixpacks 构建即可。

Dokploy 应用和构建方式的官方说明见
[Applications](https://docs.dokploy.com/docs/core/applications) 和
[Build Type](https://docs.dokploy.com/docs/core/applications/build-type)。

## 2. 创建 Dokploy 应用

在 Dokploy Web 控制台中按以下步骤创建应用：

1. 创建一个 Project，例如 `WGALL-ZJ005`。
2. 创建一个 Environment，例如 `production`。
3. 创建 **Application**，不要选择 Static Site。
4. 连接 GitHub，选择仓库 `Harukite/WGALL-ZJ005`。
5. 选择要部署的分支，例如 `codex/grid-risk-gate`。
6. 将构建方式设置为 Railpack 或 Nixpacks。
7. 保存应用设置。

## 3. 配置构建、启动和端口

在应用的构建设置中填写以下值。没有前端构建步骤，应用启动后由 Node.js
服务直接提供 `public/` 页面和 API/SSE 接口。

```text
Install Command: npm ci --omit=dev
Build Command:   留空
Start Command:   npm start
Internal Port:   8283
```

如果 Dokploy 的构建方式自动识别了 `package.json`，仍然要确认最终使用
的是 Node.js 20 或更高版本。
不要把本项目配置成 Static 部署，也不要把外部域名端口误填成应用内部
端口以外的值。

## 4. 配置环境变量

进入 **Environment Variables**，首次部署只配置 Paper 模式。
下面的配置不会发送真实订单：

```dotenv
HOST=0.0.0.0
PORT=8283
AUTH_EMAIL=jaychougo@gmail.com
AUTH_PASSWORD_HASH=<npm run auth:hash 输出的完整 scrypt 哈希>
AUTH_REQUIRE_HTTPS=1
AUTH_TRUST_PROXY=1
PAPER_BALANCE=10000

DE_MODE=paper
EX_MODE=paper
RS_MODE=paper
AR_MODE=paper
LR_MODE=paper
N1_MODE=paper
PH_MODE=paper
PH2_MODE=paper
NADO_MODE=paper
POPDEX_MODE=paper
```

`AUTH_PASSWORD_HASH` 必须先在本地或安全终端运行 `npm run auth:hash` 生成，
再把完整输出配置到 Dokploy；不要把明文密码放进环境变量、Git 或构建日志。
`AUTH_REQUIRE_HTTPS=1` 会拒绝非 HTTPS 登录。`AUTH_TRUST_PROXY=1` 仅适用于
Dokploy/Traefik 等你控制的反向代理已经终止 TLS 的场景。
`HOST=0.0.0.0` 只表示容器监听所有网卡，必须配合 HTTPS、单账户登录和网络
访问控制；它不代表可以安全地把仪表盘公开到互联网。

API key、私钥、代理密码和 AI key 必须填写在 Dokploy 的环境变量中，
不要把 `.env` 提交到仓库，也不要把私钥写进构建参数。
Dokploy 环境变量的官方说明见
[Environment Variables](https://docs.dokploy.com/docs/core/variables)。

## 5. 配置域名和访问控制

在应用的 **Domains** 页面添加域名，并将请求转发到内部端口 `8283`。
配置 HTTPS 后，应用会要求使用唯一账户登录；再通过以下方式之一限制访问：

- VPN 或 Tailscale 私网访问；
- Cloudflare Access 等身份代理；
- 其他带登录鉴权的反向代理。

首次访问使用配置的 `AUTH_EMAIL` 和对应密码；应用不会提供注册入口或创建第二个账户。
不要只配置域名和 HTTPS 就直接进入 `live`。
当前页面包含启动、停止、撤单和平仓操作，域名配置参考
[Domains](https://docs.dokploy.com/docs/core/domains)。

## 6. 配置 `.state.json` 持久化

项目当前的 `src/persist.js` 将状态文件固定写在项目根目录：

```text
<项目根目录>/.state.json
```

程序会延迟保存，并使用 `.state.json.tmp` 后原子重命名的方式写入。
状态文件包含网格配置、统计、恢复信息和挂单跟踪，不设计为保存私钥。

### 当前版本的限制

当前代码还没有读取 `STATE_DIR` 或其他外部状态目录配置。
因此，在 Dokploy 中仅添加下面的变量并不会改变写入位置：

```dotenv
STATE_DIR=/data
```

不要把持久卷直接挂到 `/app`，因为 `/app` 通常也是应用代码目录。
挂载后可能遮蔽代码，并导致后续 Git 部署使用旧代码。
也不要只把单个 `.state.json` 文件作为挂载目标，因为程序会通过原子重
命名替换该文件。

### 推荐的生产配置

在项目支持外部状态目录后，再按以下方式配置：

1. 在应用中打开 **Advanced → Mounts/Volumes**。
2. 创建一个可读写的持久卷，名称可以是 `grid-state`。
3. 将容器挂载路径设置为 `/data`。
4. 在环境变量中设置 `STATE_DIR=/data`。
5. 重新部署应用，但不要删除 `grid-state` 卷。
6. 通过重启或重新部署验证 `/data/.state.json` 仍然存在。

Dokploy 的卷、绑定和文件挂载说明见
[Volumes & Mounts](https://docs.dokploy.com/docs/core/troubleshooting/volumes-mounts)。

持久化状态不能替代交易所的权威订单和持仓对账。
重启或重新部署前，必须先停止网格、撤单并到交易所官网确认挂单和持仓；
恢复后仍要再次核对真实状态。

## 7. 部署和 Paper 验收

完成配置后，按以下步骤验证：

1. 点击 **Deploy**，查看部署日志。
2. 确认日志显示服务已启动，且十个交易所均为 `PAPER`。
3. 打开域名，确认仪表盘、行情、趋势和各交易所 Tab 正常显示。
4. 只启动一个 Paper 网格，观察订单、成交和风险闸门状态。
5. 执行一次停止流程，确认挂单清理和页面状态正常。
6. 重启应用，确认服务能重新加载配置并继续提供页面和 API。
7. 完成持久卷配置后，再重复一次重启/重新部署验收，确认状态文件没有
   丢失。

如果日志出现端口监听失败，确认 Dokploy 的内部端口是 `8283`，并确认
环境变量中没有把 `HOST` 留为 `127.0.0.1`。

## 8. 启用 Live 前的检查

Paper 验收通过后，再逐个交易所配置 Live。
每次只启用一个交易所，并完成最小额度的下单、查询、撤单和持仓确认；
不要一次性把十个交易所全部切换到 Live。

- 确认 API key 和私钥只具有必要权限；
- 确认持久卷可读写且已经备份；
- 确认域名有外部鉴权；
- 确认 Dokploy 重启策略不会频繁重启交易进程；
- 确认交易所官网可以作为机器人故障时的人工接管入口；
- RHC/Lighter Live 还需要 Python 3.12 和 `lighter-sdk` 运行环境。

Dokploy 的生产部署建议可参考
[Going Production](https://docs.dokploy.com/docs/core/applications/going-production)。

## 下一步

当前分支可以先完成 Paper 部署验证。
要让 Dokploy 的 `/data` 持久卷真正接管 `.state.json`，还需要在代码中
增加 `STATE_DIR` 支持；这项改动只涉及状态文件路径，不应修改
`src/grid.js` 或现有网格策略。
