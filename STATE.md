# 项目状态

## 最近运行

- 2026-08-19（Asia/Shanghai）：完成 N1、Phoenix、Phoenix2、Nado、PopDEX 的 paper/live 适配器接入、服务端/AI/仪表盘注册、统一 UI 控制台和 paper 网格闭环验证；五个新增适配器已用现有 `GridBot` 完成中性/做多/做空启停测试，N1 页面完成启动/停止按钮闭环；未触发真实交易。
- 2026-08-19（Asia/Shanghai）：继续修复 paper 行情链路；五所 paper 适配器已连接公开真实价格/K 线，服务端 `/api/n1|ph|ph2|na|pd/trend` 均实测返回 `dataSource=real`，网格策略文件哈希未变。
- 2026-08-19（Asia/Shanghai）：完成 PopDEX live 写入闭环：严格校验 symbol 元数据与 RPC chain ID；链上 receipt、indexer 订单发现、`clientOid → orderId` 映射、带 clientOid 撤单和 pending/不重复写入保护均已覆盖本地 RPC/API 集成测试；未使用真实账户或发送主网交易。
- 2026-08-19（Asia/Shanghai）：补齐 N1、Phoenix、Phoenix2 live 的稳定 client order id、权威订单发现和 pending/reconcile；Solana/N1 写结果不确定时阻断后续写操作，撤单/平仓未知结果等待连续权威快照收敛。新增 `test/live-new-exchange-lifecycle.test.js` 覆盖三所成功与延迟发现路径；未使用真实账户或发送真实订单。
- 2026-08-19（Asia/Shanghai）：进一步补齐 Nado 普通 PostOnly 的 digest→权威挂单发现、空/失败写响应保护，并加入 N1 session 刷新、Phoenix 确认超时和 Nado 普通下单—查询—撤单 mock 测试；Nado reduce-only maker 仍明确拒绝。
- 2026-08-20（Asia/Shanghai）：补齐 N1/Phoenix/Phoenix2 成交收敛：N1 使用 `items + actionId`，Phoenix/Phoenix2 使用精确交易签名；覆盖 fills-only 回执、后台成交清理 pending/write、短期结果消费防重发，以及部分成交在远端订单消失后的聚合事件；`npm test`、专项生命周期、配置和 PopDEX 回归均通过。
- 2026-08-20（Asia/Shanghai）：再次回归 N1、Phoenix、Phoenix2、PopDEX：专项与全量测试均通过，策略文件未改；一致性审阅发现 PopDEX pending 订单的写入屏障/后台 tracking 不完整、Phoenix 确认超时未把 txSignature 回写 pending，另有精度硬编码、PopDEX 小仓位平仓数量抬高和成交结果缓存阻断无关写入等风险，暂未改业务代码。
- 2026-08-20（Asia/Shanghai）：修复上述回归问题并提交 `a269931`、`b452dca`、`d69f08d`；PopDEX 精确 clientOid 后台接管进入 `_tracked`，未完成订单发现阻断撤单/撤全/平仓，reduce-only 平仓不再向上抬数量；Phoenix/Phoenix2 超时签名回写 pending；N1/Phoenix/Phoenix2 使用权威市场精度，成交缓存要求数量与稳定 client-id/别名精确匹配；缺少稳定 id 的 live 开仓 fail-closed，`npm test`、配置预检、语法检查均通过，未发送真实订单。

## 当前任务

- 本轮发现的 N1、Phoenix、Phoenix2、PopDEX live 生命周期问题已修复并完成本地回归；现有网格策略保持冻结，`src/grid.js`、`src/bot.js` 未修改。Nado 仍因协议不支持 reduce-only maker、且当前适配器没有接入可验证的成交历史查询，现有长/短网格 live 不能宣称完全等价支持。

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
- 本轮提交后工作树 clean；此前 README、源码、测试、文档和依赖等用户改动均被保留在既有提交中，未回退。
- 根目录未发现项目内 `AGENTS.md`（本轮协作规则来自用户上下文）；`SKILL.md`、`STATE.md` 为本轮按规则新建；`.gitignore`、`.env.example` 已由用户补齐；README 引用的 `docs/发布前检查清单.md` 仍未发现。
- paper 真实行情依赖各交易所公开接口；N1 的公开历史接口当前只有 `PT1H` snapshot，15m/更细周期不能视为交易所原生 OHLC，只能展示真实 hourly mark-price 序列或按小时聚合。
- 发布配套文件和 lint/typecheck/CI 是否补齐，待用户决定。

## 已知之险

- 外部 classic-grid 的 `VenueExecutor`/`snapshot → apply` 契约与当前 `GridBot` 的适配器契约不同；不能直接复制五个 venue 文件，必须补稳定订单 ID、reduce-only 映射和权威对账。
- PopDEX 的链上交易回执不等于订单簿订单确认；接入必须通过 client order id/权威订单查询发现真实订单，超时不能直接重发开仓单。
- PopDEX 若广播、回执或 indexer 查询不确定，会保留 pending 并阻断新的开仓写入；若订单已成交而未进入 pending orders，仍需人工结合仓位/交易历史核验，不能把空挂单快照当作已撤单。
- Nado 协议错误码 `REDUCE_ONLY_NOT_TAKER` 表明 reduce-only 只能做 taker；适配器拒绝 reduce-only maker 腿，保留 IOC reduce-only 平仓，不能宣称 Nado live 的长/短/回收限价腿已完全等价支持。
- N1/Phoenix/Phoenix2 的 pending/reconcile 已通过 mock SDK/HTTP/Solana seam 验证，但没有官方 sandbox 或真实账户写入证据；上线前仍需单笔最小额度下单—查询—撤单—持仓确认。
- Nado live 当前可安全覆盖普通 PostOnly 和 IOC reduce-only 平仓的适配器路径；现有 GridBot 的长/短模式依赖 reduce-only maker，未改变策略去迁就协议，因此只能按能力边界使用，不能标记为完整 live 网格闭环。
- N1/Phoenix/Phoenix2 的成交历史闭环依赖交易所返回可关联的 `actionId`/交易签名；缺少精确关联或历史接口不可用时仍会保留 pending 并阻断写入。Nado 若订单在权威挂单发现前成交，当前只能安全保留 pending，需人工结合成交/持仓核验。
- Phoenix/Phoenix2 的 pending 成交恢复依赖异常中的 `txSignature`、精确交易签名和可用历史接口；现在确认超时签名会写回 pending，历史不可用时仍按 fail-closed 保持 pending。
- PopDEX 已把 `_pendingOrders` 纳入统一写屏障，后台只接受精确 clientOid 并接管 `_tracked`；indexer 发现前若订单已成交且没有可验证历史，仍只能保留 pending，需人工结合成交/持仓核验。
- N1/Phoenix/Phoenix2 的市场精度现在读取交易所/SDK 元数据并在缺失时 fail-closed；上线前仍需用真实市场响应复核元数据含义。
- PopDEX reduce-only 平仓按持仓向下取整，若无法满足最小数量会拒绝发送；不会为满足最小名义价值而超出持仓。
- 公共成交结果缓存只在同一委托的 market/side/level/price/size 与 client-id 别名匹配时消费，不再作为全局 pending 屏障；交易所人工并发同价同量订单仍是残余识别风险。
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
- PopDEX live 不能把交易 hash 作为 GridBot 的订单 ID；必须等权威订单接口返回可撤销的数字 orderId，撤单时优先复用原 clientOid；现有 GridBot 负责撤单连续消失和 IOC 平仓后的仓位确认。
- 成交历史只能在精确标识下授权；fills-only 回执不能转成 active 挂单，部分成交事件必须延迟到远端余单消失，避免现有策略重复补挂。
