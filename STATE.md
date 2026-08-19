# 项目状态

## 最近运行

- 2026-08-19（Asia/Shanghai）：完成 N1、Phoenix、Phoenix2、Nado、PopDEX 的 paper/live 适配器接入、服务端/AI/仪表盘注册、统一 UI 控制台和 paper 网格闭环验证；五个新增适配器已用现有 `GridBot` 完成中性/做多/做空启停测试，N1 页面完成启动/停止按钮闭环；未触发真实交易。
- 2026-08-19（Asia/Shanghai）：继续修复 paper 行情链路；五所 paper 适配器已连接公开真实价格/K 线，服务端 `/api/n1|ph|ph2|na|pd/trend` 均实测返回 `dataSource=real`，网格策略文件哈希未变。

## 当前任务

- 用户已确认实施 N1、Phoenix、Phoenix2、Nado、PopDEX；当前接入与 UI 一致性范围已完成，策略冻结。不得修改 `src/grid.js`、`src/bot.js` 的网格算法和订单编排语义。

## 已确认

- 项目是 Node.js ESM 的十交易所永续合约网格机器人：原有 Decibel、Extended、RISEx、Arcus、Robinhood Chain Lighter，加上 N1、Phoenix、Phoenix2、Nado、PopDEX。
- 运行链路为 `src/server.js` → 十个交易所工厂/适配器 + 十个 `GridBot` → `public/index.html` 仪表盘；`src/ai/service.js` 为旁路 AI 风控/分析/通知。
- 核心安全路径包括真实挂单对账、撤单连续确认、平仓重试/确认、崩溃状态快照与实盘启动 fail-closed。
- `npm run check:config` 通过；`node test/overview.test.js`、`node test/arcus.test.js` 通过。
- `.env.example` 与 `.gitignore` 已补齐：模板十所均为 `paper`、凭据为空；忽略规则覆盖 `.env`、`.state.json`、`node_modules`、私钥与运行时目录。
- `npm test` 已全量通过；RHC 步长精度已在实现层用十进制科学记数法归一化，严格断言保持不变。
- `npm run audit:release` 已通过模板存在性检查，但当前工作目录仍被 `.env`、`.state.json`、`node_modules` 拦截；应在干净发布目录运行。

## 未决

- 是否在用户明确授权并提供凭据后执行单笔真实下单—撤单闭环；当前默认只做 paper 与只读验证。
- 工作树已有用户改动：`README.md` 大幅重写、原 ZIP 删除，并新增源码/测试/文档/依赖等；本次未清理、回退或提交。
- 根目录未发现项目内 `AGENTS.md`（本轮协作规则来自用户上下文）；`SKILL.md`、`STATE.md` 为本轮按规则新建；`.gitignore`、`.env.example` 已由用户补齐；README 引用的 `docs/发布前检查清单.md` 仍未发现。
- paper 真实行情依赖各交易所公开接口；N1 的公开历史接口当前只有 `PT1H` snapshot，15m/更细周期不能视为交易所原生 OHLC，只能展示真实 hourly mark-price 序列或按小时聚合。
- 发布配套文件和 lint/typecheck/CI 是否补齐，待用户决定。

## 已知之险

- 外部 classic-grid 的 `VenueExecutor`/`snapshot → apply` 契约与当前 `GridBot` 的适配器契约不同；不能直接复制五个 venue 文件，必须补稳定订单 ID、reduce-only 映射和权威对账。
- PopDEX 的链上交易回执不等于订单簿订单确认；接入必须通过 client order id/权威订单查询发现真实订单，超时不能直接重发开仓单。
- Nado 协议错误码 `REDUCE_ONLY_NOT_TAKER` 表明 reduce-only 只能做 taker；适配器拒绝 reduce-only maker 腿，保留 IOC reduce-only 平仓，不能宣称 Nado live 的长/短/回收限价腿已完全等价支持。
- 新 live 适配器的成交事件只有在订单消失与权威持仓方向变化共同确认时才发出；单纯撤单/过期/拒单不再触发补单，但交易所人工并发交易仍是残余识别风险。
- 外部仓库只对网格纯函数有测试；本项目五个新增适配器已通过 paper 契约测试和现有 `GridBot` 的中性/做多/做空启停测试，但仍未通过真实账户/网络的交易所集成测试。
- `live` 模式涉及真实保证金、订单、持仓、手续费、滑点和强平；不能在没有 paper 回归和交易所官网复核的情况下操作。
- 仪表盘能启动/停止交易、修改 `.env`，当前默认只监听回环地址且未发现登录鉴权；不要设置公网监听而不加外部防护。
- 五个新增交易所现在复用既有交易所的独立 Tab、总览卡和完整控制器；UI parity contract 只验证结构契约，真实 live 页面仍需凭据后人工复核视觉和交易所返回数据。
- 虽然已存在 `.gitignore`，发布审计仍会主动拒绝当前目录中的 `.env`、`.state.json`、`node_modules`；发布前必须关闭程序并在干净目录/ZIP 上复核。
- `npm run audit:release` 仍需在没有 `.env`、`.state.json`、`node_modules` 的干净目录执行；当前工作目录中的这些本地文件均已被 `.gitignore` 排除，不会进入提交。

## 教训（近三）

- 外部交易所适配器只能作为 I/O 参考；接入前必须先对齐宿主项目的订单生命周期和安全契约，尤其不能把批量写入计数当成稳定订单确认。
- 交易精度边界不能依赖二进制浮点的严格等值。
- 发布审计命令本身是当前项目的重要停止条件，缺模板/忽略规则时不能把“测试通过”当作可发布。
- 恢复/撤单相关改动必须同时看内存跟踪、交易所权威快照和异常时序，不能只看成功响应。
- paper 行情不能再默认使用合成正弦波：统一读取器要把时间戳归一到毫秒、将远端价格送回本地撮合，并在公开接口不可用时明确降级为 `synthetic`。
