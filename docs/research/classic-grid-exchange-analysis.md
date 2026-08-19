# classic-grid 五所交易所接入分析

## 结论

从源码层面看，N1、Phoenix、Phoenix2、Nado、PopDEX 均具备接入条件；但不能把 classic-grid 的五个文件直接复制到本项目。classic-grid 是 TypeScript 项目，采用 `VenueExecutor` 的「读取 snapshot → 生成 intents → 批量 apply」循环；本项目是 Node.js ESM/JavaScript 项目，`GridBot` 直接依赖交易所适配器的行情、挂单、成交、撤单确认、持仓和恢复能力。

推荐方案是：只移植五个交易所的交易所 I/O 与精度/鉴权逻辑，新增本项目风格的适配器和 paper 实现；继续使用现有 `src/grid.js` 与 `src/bot.js`，不引入 classic-grid 的 `grid.ts`、`loop.ts`，也不改变当前网格的中性/做多/做空、成交后反向补一档、风控和恢复语义。

本结论基于 classic-grid 主分支提交 `69494206fffdc84aeb4d845d6bf3d05c1d4b677e` 的源码阅读，以及本项目当前 `GridBot` 和五所适配器契约的对照。

## 关键架构差异

| 对照项 | classic-grid | 当前项目 | 对接结论 |
|---|---|---|---|
| 运行模型 | `VenueExecutor.snapshot()` 返回统一快照，`apply(intents)` 批量写入 | `GridBot` 通过 `getPrice`、`placeLimitOrder`、`cancelOrder`、`fetchOpenOrders`、`getPosition` 等方法驱动，并接收 `price`/`fill`/`error` 事件 | 必须做适配器转换，不能直接复用 executor |
| 策略位置 | `src/grid.ts` + `src/loop.ts` 负责锚定、计划、补单 | `src/grid.js` + `src/bot.js` 已是现有策略核心 | 不复制外部策略；只移植交易所 I/O |
| 下单确认 | `ApplyResult` 只有 placed/cancelled/failed 计数 | `GridBot` 下单后需要 `orderId` 写入 active，并依赖后续权威挂单快照 | 新适配器必须返回可追踪的远端订单 ID；PopDEX 需要额外做订单发现 |
| 撤单安全 | executor 返回写入结果，循环再读快照 | 当前项目要求撤单后连续权威快照确认订单消失，并防止瞬时空快照误清理 | 保留当前项目的撤单确认与对账机制 |
| 语言/运行时 | TypeScript，依赖 `tsx` | JavaScript ESM，无 TypeScript/tsx 运行脚本 | 推荐以当前 JS 风格移植，避免为五个适配器改造整个启动链路 |
| 订单事件 | 外部实现主要靠轮询 snapshot 推断 | 当前项目支持事件驱动，同时有周期性真实挂单对账 | 新适配器至少要提供可靠轮询；成交事件可作为优化，不能取代对账 |

证据：classic-grid 的统一接口见 [`src/venues/types.ts`](https://github.com/beibei030/classic-grid/blob/69494206fffdc84aeb4d845d6bf3d05c1d4b677e/src/venues/types.ts)；其策略循环见 [`src/loop.ts`](https://github.com/beibei030/classic-grid/blob/69494206fffdc84aeb4d845d6bf3d05c1d4b677e/src/loop.ts)；本项目的交易所方法约定见 [`src/exchange/ex/types.js`](../../src/exchange/ex/types.js)，策略与对账实现见 [`src/bot.js`](../../src/bot.js) 和 [`src/grid.js`](../../src/grid.js)。

## 五个交易所的可行性

### N1：可行性高，适配难度中等

- 外部实现使用 `@n1xyz/nord-ts` 与 `@solana/web3.js`；默认市场为 `marketId=0`。
- 实盘连接需要 Solana keypair、N1 session/account；下单使用 PostOnly，撤单按订单 ID，平仓使用 IOC + reduce-only。
- snapshot 可读取标记价、持仓、权益和挂单；订单 ID 可直接从 SDK 回执取得。
- 需要补齐当前项目要求的 `getMarkets`、`getPrice`、`fetchOpenOrders`、`getPosition`、`placeLimitOrder` 等方法，并将 session 刷新、账户唯一性和 `N1_TRADING_ARMED=YES` 保留为 fail-closed 保护。
- 外部普通下单把 `isReduceOnly` 固定为 `false`，不能原样移植；当前项目的做多/做空模式会要求平仓方向挂单带 reduce-only，需按当前 `GridBot` 传入值映射。

证据：[`src/venues/n1.ts`](https://github.com/beibei030/classic-grid/blob/69494206fffdc84aeb4d845d6bf3d05c1d4b677e/src/venues/n1.ts)。

### Phoenix / Phoenix2：可行性高，适配难度中等

- 外部实现使用 `@ellipsis-labs/rise` 和 `@solana/web3.js`，通过 Solana 指令签名和确认完成下单、撤单、全撤和市价减仓。
- Phoenix 与 Phoenix2 共用一套适配器逻辑，区别主要是独立的 API/RPC/私钥/环境变量和 venue ID；因此实现上可共享底层 Phoenix adapter，由两个配置实例隔离账户与状态。
- 外部 snapshot 通过 mark-price 与 trader state 组合出持仓、权益、未实现盈亏和挂单；订单 ID 由 `priceTicks:orderSequenceNumber` 组合而成，撤单时再解析。
- 外部 `apply()` 的普通限价下单只返回计数，没有向调用方返回订单 ID；移植到当前项目时必须在交易确认后通过价格/序号或权威订单快照拿到稳定 ID，否则 `GridBot` 无法建立 active 跟踪。
- 需要保留外部的 PostOnly、穿价跳过、lot 对齐、compute budget、交易确认和下单间隔；杠杆是否有可调用接口须在 SDK/官方 API 核实，不能伪造成功。

证据：[`src/venues/phoenix.ts`](https://github.com/beibei030/classic-grid/blob/69494206fffdc84aeb4d845d6bf3d05c1d4b677e/src/venues/phoenix.ts)；Phoenix 相关地区/链上 CLOB 风险也记录在 [`docs/CHALLENGES.md`](https://github.com/beibei030/classic-grid/blob/69494206fffdc84aeb4d845d6bf3d05c1d4b677e/docs/CHALLENGES.md)。

### Nado：可行性中高，适配难度中等

- 外部实现使用 `@nadohq/client`、`@nadohq/shared` 与 `viem`，目标为 Ink 主网，默认 BTC 永续 product id 为 2。
- 支持读取 mark、账户摘要、持仓、权益和挂单；挂单撤销使用 order digest；下单按 `0.00005` 数量步长、整数价格步长对齐，并使用 PostOnly。
- 外部普通 `apply()` 未把当前 intent 的 reduce-only 语义传入普通挂单；平仓单单独使用 IOC。因此移植时必须先确认 Nado SDK 的 appendix/订单参数如何表达 reduce-only，确保做多/做空网格不会被错误地当成开仓单。
- Nado 的 place 调用本身未向外层返回当前项目所需的统一 order ID；需以 digest/权威挂单查询建立稳定映射。
- 需要处理 Ink RPC、签名账户、subaccount、product id、价格/数量定点换算与下单间隔，所有失败要能被当前 bot 的安全重试策略识别。

证据：[`src/venues/nado.ts`](https://github.com/beibei030/classic-grid/blob/69494206fffdc84aeb4d845d6bf3d05c1d4b677e/src/venues/nado.ts)；依赖清单见 [`package.json`](https://github.com/beibei030/classic-grid/blob/69494206fffdc84aeb4d845d6bf3d05c1d4b677e/package.json)。

### PopDEX：可行性中等，五者中风险最高

- 外部实现把 PopDEX 作为 Morph Tachyon 链上的 CLOB：行情和账户数据走 HTTP API，写操作通过 viem 编码 Order 合约调用，再经 JSON-RPC `eth_sendRawTransaction` 广播。
- 需要处理 chain id `0x888`、钱包签名、symbol 配置、tick/lot/min quantity/min notional、gasless relay、订单合约的 place/cancel/cancelAll 与 IOC reduce-only 平仓。
- 最大接入风险是写入确认与订单确认不同：链上交易回执只能说明合约调用已确认，不一定等价于订单已经被 indexer 识别；外部实现的 `apply()` 只增加 placed 计数，且回执超时会记录警告后返回 hash。当前 `GridBot` 需要真正的订单 ID，因此不能把交易 hash 直接当成挂单 ID。
- 推荐建立 `clientOrderId → 权威挂单 ID` 的短期 pending 映射：交易回执成功后轮询账户订单接口，匹配 wallet、symbol、side、价格、数量和 client order id；在未发现真实订单前不得把该档位标记为已确认，也不得无条件重发可能造成重复挂单的开仓单。
- 必须对 indexer 延迟、RPC 超时、链上回滚、订单尚未可见和重复提交分别建模测试；PopDEX 应最后接入实盘。

证据：[`src/venues/popdex.ts`](https://github.com/beibei030/classic-grid/blob/69494206fffdc84aeb4d845d6bf3d05c1d4b677e/src/venues/popdex.ts)；链上 CLOB 与 gasless 注意事项见 [`docs/CHALLENGES.md`](https://github.com/beibei030/classic-grid/blob/69494206fffdc84aeb4d845d6bf3d05c1d4b677e/docs/CHALLENGES.md)。

## 依赖与工程影响

classic-grid 的依赖包括 `@n1xyz/nord-ts`、`@ellipsis-labs/rise`、`@nadohq/client`、`@nadohq/shared`、`@solana/web3.js`、`viem`、`bs58`、`tsx` 等；当前项目只已有部分链/交易所依赖，且没有 TypeScript 运行链路。

实施时应先做 import/功能审计，再只加入实际需要的依赖，不应整份复制外部 `package.json`。新增依赖会改变锁文件、安装体积和发布审计，须在实现确认后单独验证。

外部仓库自身的测试脚本目前聚焦 `test/grid.test.ts` 的网格纯函数；不能把它当作五个适配器已经通过真实交易所集成测试的证明。安全规则与密钥隔离要求见其 [`SECURITY.md`](https://github.com/beibei030/classic-grid/blob/69494206fffdc84aeb4d845d6bf3d05c1d4b677e/SECURITY.md)。

## 推荐实施方案（策略冻结）

### 1. 冻结策略边界

明确不改以下文件的策略语义：

- `src/grid.js` 的等差档位、`isReduceOnly`、初始铺单和成交后反向一档；
- `src/bot.js` 的启动/停止、风险检查、补单、撤单连续确认、真实挂单对账、恢复和统计；
- 现有五所的行为与 API 路由。

允许的配套改动仅限于「让新交易所被当前系统发现和控制」所必需的配置、工厂、路由、看板、AI 映射、持久化键和测试。接入交易所不等于重写策略，但不可能只新增五个孤立文件。

### 2. 采用当前项目的适配器契约

为每个新 venue 提供 `paper` 与 `live` 两层：

1. paper 适配器先实现与现有 paper 交易所一致的方法，返回稳定的本地订单 ID，并支持价格推进/成交模拟，用于验证当前 `GridBot`；
2. live 适配器只负责市场发现、行情、精度转换、鉴权、下单、撤单、挂单查询、持仓查询和连接重连；
3. 交易所的 SDK/HTTP/RPC 错误统一归一化为当前 bot 可识别的错误类别；
4. 任何链上写入超时都不得直接视为订单成功；只有权威订单快照或明确回执能确认订单 ID 时才写入 active；
5. 对于没有真实杠杆接口的 venue，适配器返回明确的“不支持/未确认”状态并在配置层做风控说明，不返回虚假的成功。

### 3. 以注册表扩展运行面

在不改变 bot 算法的前提下，增加五个 venue 的配置和工厂注册：

- 建议内部 key：`n1`、`ph`、`ph2`、`na`、`pd`；显示名分别为 N1、Phoenix、Phoenix2、Nado、PopDEX；
- `ph` 与 `ph2` 共享 Phoenix 底层 adapter，但隔离 API/RPC/账户/状态；
- 每个新 venue 默认 `paper`，无凭据时不能自动进入 live；
- 接入 server 的 overview、SSE、恢复和路由；若希望继续使用当前仪表盘操作，还需补齐前端的 venue 列表和面板；
- AI 服务的交易所 key/name 映射也需扩展，否则后端有数据而 AI 侧看不到新所；
- 持久化状态使用独立 key，避免新旧 venue 的 active order/恢复状态互相污染。

### 4. 精度与订单生命周期统一

每个 adapter 都要先解析并缓存市场元数据：symbol/market id、price tick、size lot、最小数量、最小名义、订单方向和 reduce-only 能力。网格价格和数量在发送前统一定点对齐，禁止直接依赖二进制浮点严格相等。

订单生命周期必须满足：

`请求下单 → 得到稳定远端订单 ID → 写入 active → 权威挂单对账 → 成交/撤单后确认消失 → GridBot 按原策略补反向档`

任何一步没有权威结果，都进入 pending/reconcile，而不是直接重发。这个约束对 Phoenix/Nado/PopDEX 尤其重要。

## 分阶段交付与验证闸门

### 阶段 A：契约与 paper 验证

- 增加五所的配置 schema、工厂注册、paper adapter 和 adapter contract test；
- 用当前 `GridBot` 跑小网格，模拟买成交、卖成交、部分成交、撤单、空快照、重启恢复和收敛；
- 验证做多/做空模式的 reduce-only 标志不变；
- 通过后才进入任何 SDK/RPC live 代码。

### 阶段 B：N1 + Phoenix/Phoenix2 只读与沙盒

- 加入必要依赖和 live adapter；
- 先只读连接、市场发现、mark、持仓、权益、挂单快照；
- 以 mock SDK/RPC 固定测试 session 过期、签名失败、交易确认超时、精度和订单 ID；
- 如有官方测试环境，再执行小额/隔离市场的单次挂单—查询—撤单闭环；没有测试环境则不把主网写入作为默认验收。

### 阶段 C：Nado 只读与最小写闭环

- 先验证 Ink RPC、subaccount/product id、digest、价格/数量步长；
- 明确 SDK 是否能表达普通 reduce-only 挂单；未确认前禁止做多/做空实盘；
- 完成单笔 PostOnly 下单、权威查询、撤单与状态收敛后，才接入 GridBot 的 paper/live 开关。

### 阶段 D：PopDEX 订单确认闭环

- 先验证 symbol 配置、账户 overview/positions/orders、chain id 和 RPC；
- 实现 client order id 与真实 order id 的关联、receipt/indexer 延迟和失败重试保护；
- 完成「下单—发现真实订单—撤单—连续查询确认消失」后再允许接入网格。

### 阶段 E：系统级三闸与发布审计

- 现有测试全部执行，RHC 市场步长使用十进制归一化，保留严格精度断言，不能用放宽断言掩盖精度问题；
- 新增适配器 contract/paper/GridBot 集成测试；
- 执行 `npm run check:config`；当前项目尚无既有 lint/typecheck/build 命令，不臆造新闸门；
- 在没有 `.env`、`.state.json`、`node_modules` 的干净目录执行 `npm run audit:release`；
- 每个 venue 记录“已通过 paper / 已通过只读 / 已通过单笔写闭环 / 未验证”的状态。

## 本轮不做的事情

- 不复制 classic-grid 的 `grid.ts`、`loop.ts`，不替换当前网格算法；
- 不在未确认方案前安装依赖、改 `package.json`、改路由或改业务代码；
- 不使用真实私钥、不自动开启 live、不发送真实订单；
- 不把“交易所 SDK 能调用”视为“已经跑通当前项目网格”；验收必须包含当前 `GridBot` 的 paper 回归和每所订单生命周期闭环。

## 待确认决策

1. 是否按上述五所全部接入，并同步扩展当前服务端/仪表盘/AI 映射；
2. Phoenix2 是否确实是独立账户/独立 endpoint，还是仅希望把 Phoenix 的第二套账户命名为 Phoenix2；
3. 是否允许在用户明确提供凭据并确认后做单笔真实下单—撤单验证；默认只做到 paper + 只读，不触发真实写入。
