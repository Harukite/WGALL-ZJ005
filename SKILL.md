# 项目技能记录

## 技术栈

- Node.js/JavaScript，ES module（`package.json` 的 `type` 为 `module`），运行时要求 Node.js >= 20；本次勘察实际版本为 Node.js 22.10.0、npm 10.9.0。
- 服务端使用 Node.js 原生 `http`、`fs`、`events` 与 `fetch`，HTTP 代理额外使用 `undici`。
- 配置校验使用 `zod` 依赖以外的原生脚本逻辑；测试使用 Node.js 原生 `assert/strict`，无已发现的 Jest/Vitest/Mocha 配置。
- 交易所依赖：`@aptos-labs/ts-sdk`、`@decibeltrade/sdk`、可选 `risex-client`；Extended/Arcus/RHC 还有项目内签名与适配逻辑。
- RHC Lighter 实盘通过 Node.js 子进程调用项目内 Python `signer_worker.py`，依赖见 `requirements-lighter.txt`；一键启动脚本为 Windows PowerShell/BAT。
- 前端为单文件 `public/index.html`，由 `src/server.js` 提供静态文件与 JSON/SSE API。

## 约定

- `src/server.js` 是启动入口：加载配置和代理，创建十个交易所与十个 `GridBot`，启动 AI 服务、HTTP 路由、SSE、交易所初始化和崩溃恢复。
- 十个交易所均以 `src/exchange/*/index.js` 工厂按 `*_MODE` 选择 `paper` 或 `live`；适配器共享市场、行情、下单、撤单、持仓、启动/停止等方法，并通过 `EventEmitter` 发出 `price`、`fill`、`error` 事件。
- `src/bot.js` 是跨交易所共用的策略编排层；网格生成与档位替换在 `src/grid.js`，趋势/指标在 `src/trend.js` 与 `src/indicators.js`，不把交易策略放进 HTTP 或前端。
- 订单安全以交易所真实快照为准：撤单后要求连续确认目标订单消失；对账会接管未跟踪存单、去重，但不会自动重新铺开仓单；失败下单仅在适配器声明安全能力并经权威对账后重试。
- 状态由 `src/persist.js` 延迟、原子写入根目录 `.state.json`；快照保存公开配置、统计、挂单跟踪与恢复信息，不设计为保存密钥。AI 也只消费精简运行状态。
- 默认配置是十所 `paper`、监听 `127.0.0.1:8283`；实盘适配器在账户/签名/权益校验不完整时保持离线或拒绝交易。
- 现有源码以中文注释/用户提示为主，使用 2 空格缩进、单引号、分号；新增代码应保持就地风格，避免格式化无关行。

## 硬规

- 这是交易软件：第一次使用必须全 `paper`；`live` 会发送真实订单，任何改动都要优先验证撤单、平仓、断线与恢复安全。
- 服务默认只监听回环地址；没有发现登录鉴权，不能把仪表盘直接暴露到公网。
- 不能向 AI、日志或前端泄露私钥、API key、完整代理凭据；RHC 集成只允许官方主网 endpoint/chain ID，且不提供提现/转账操作。
- 改动前先复现，逻辑变化要补测试；验证三闸未过时只允许针对明确的局部实现错误、己改导致的既有测试失败、类型/import/语法或 lint/格式问题自动修复，至多三轮。触及公共 API/数据契约、需求方向不确定、同错回环、扩散或需放宽/删除断言时停止并报告。
- 每次交付需说明改动文件与原因、功能验证、正式测试、风险；本项目目前未发现统一 lint、类型检查或构建脚本，不能臆造对应命令。

## 验证套件

- `npm run check:config`：本次通过；默认无 `.env` 时按十所 `paper`、`127.0.0.1:8283` 检查。
- `npm run test:new-exchanges`：本次通过；五个新增 paper 适配器均完成市场精度、下单、撤单及现有 `GridBot` 的中性/做多/做空启停闭环。
- `npm run test:ui`：本次通过；五个新增交易所均有独立 Tab、总览卡和与既有交易所相同的完整控制器 DOM/交互契约。
- `npm test`：串行运行既有测试和新增适配器测试，本次通过；其中 RHC 的步长精度回归保持严格等值断言。
- `npm run audit:release`：当前工作目录会因本地 `.env`、`.state.json`、`node_modules` 被主动拦截；在排除这些本地运行文件的干净临时目录执行后通过。
- 未发现 `lint`、`typecheck`、`build` 或 CI 命令配置；后续若新增命令，须以 manifest/CI 的实际配置为准补录。

## 教训（按时序追加）

- 2026-08-18：分析 classic-grid 时确认，外部仓库的 `VenueExecutor` 与本项目 `GridBot` 不是同一契约；以后接入外部 venue 先做订单 ID、reduce-only、撤单确认、持仓回收和精度的契约对照，再移植交易所 I/O，禁止顺手替换策略循环。
- 2026-08-18：已补齐全 `paper` 空凭据的 `.env.example` 与覆盖运行文件/私钥的 `.gitignore`；发布审计仍会主动扫描并拒绝当前目录中的 `.env`、`.state.json`、`node_modules`，发布前必须使用干净目录或干净 ZIP 验证。
- 2026-08-18/19：交易所精度是核心边界；RHC 市场步长不能直接依赖 `10 ** -decimals` 的二进制浮点结果，已改为十进制科学记数法归一化，并保留严格回归断言。

## 待确认

- 是否补齐仍缺失的 `docs/发布前检查清单.md`，并修正 README 中指向它的链接；`.env.example` 与 `.gitignore` 已由用户补齐，当前未改发布文档。
- 是否需要建立统一 lint/typecheck/CI；当前源码与 manifest 中未见既有约定。

## 本轮复盘

- 2026-08-19：五个新增交易所已通过 paper 适配器与现有 `GridBot` 的中性/做多/做空启停闭环；实盘写操作保持交易所各自的精度、reduce-only、权威订单确认和 fail-closed 约束。Phoenix 的市场筛选和 Nado 的链环境必须由配置实际驱动，不能只在 `.env.example` 中声明。
- 2026-08-19：Nado SDK 明确拒绝 post-only + reduce-only（`REDUCE_ONLY_NOT_TAKER`）；遇到宿主策略要求的 reduce-only maker 腿必须失败关闭，不能偷偷降级为普通开仓单。
- 2026-08-19：新增交易所的前端必须复用 `makeExchangeCtrl` 和既有控制台布局；独立紧凑面板会造成趋势、风险、补格、恢复和账户监控能力不一致，禁止再引入第二套 venue 控制器。
- 2026-08-19：paper 模式的真实行情应通过交易所公开只读接口读取，价格更新仍调用宿主 paper 的本地 `setPrice`/撮合路径；网络失败必须保留合成回退并标记 `synthetic`。N1 当前公开历史接口只有 hourly snapshot，不能把它宣称成任意周期的原生 OHLC。
