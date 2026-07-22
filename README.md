# 交易驾驶舱

本仓库包含两个入口：

- `desktop/`：当前主产品。Electron 桌面应用，把用户自己的 TradingView 网页会话、长桥真实持仓与本地交易 Agent 放在同一窗口。
- `app/`：早期托管网页原型。它不能透传 TradingView 的个人登录会话，因此不再作为主入口。

## 桌面版快速开始

环境要求：Node.js `>=22.13.0`、macOS。

```bash
npm --prefix desktop install
npm run desktop:test
npm run desktop:dev
```

首次启动后：

1. 在中间 TradingView 区域登录。该区域使用独立的 `persist:tradingview` 本机会话，保留个人 Layout、画线、指标与 Cookie。
2. 点击右上角“连接长桥”。系统浏览器会打开 Longbridge OAuth，只请求账户读取 scope；凭证通过 macOS Keychain 支持的 Electron `safeStorage` 加密保存。
3. 选择真实持仓，并按需点击“同步标的到 TV”。这个动作只导航 TradingView 页面，不读取或注入 TradingView DOM。
4. 在右侧选择“当前持仓 / 候选买入 / 全部组合”并运行持久 Codex Agent；候选标的不必已经持有，全组合模式会检查全部真实仓位但不会逐只拉 K 线。
5. 需要分开讨论时点击“新建”创建独立 Codex 会话；点击“本机对话”会直接打开原 thread、显示原内容并继续。不同会话可同时运行，各自显示状态；项目工具共享而聊天上下文隔离。输入 `/`、`$` 或 `@` 仍可联想命令、Skills、Apps 与 MCP 工具。
6. 两条分隔线可拖拽，左右栏也可隐藏；TradingView 只重算原生视口，不会被 CSS 缩放或拉伸。

## 只读边界

- Longbridge 根据系统地区在官方 `.cn/v2` 与 `.com/v2` 之间选择；也可用 `LONGBRIDGE_MCP_URL` 显式指定其中一个官方只读端点。
- OAuth 只请求 `scope=6`（账户读取）。
- 主进程仅允许 `account_balance`、`stock_positions`、`quote`、`option_quote`、`candlesticks` 和 `exchange_rate`；其中 `option_quote` 仅用于真实合约乘数与期权报价。
- 客户端拒绝调用白名单之外的所有工具；若缺少任一必需查询工具或出现真实订单工具，则拒绝建立连接。
- Renderer 不接触 MCP Client、OAuth Token、Node.js 或任意通用工具调用入口。
- Codex App Server 是唯一的 Agent harness，统一负责线程、历史、Skills/MCP/Apps、工具事件、取消和最终结果收集。EMA、Fib、仓位与风险引擎只是只读证据工具，不维护第二套会话或 Agent 状态。长桥桥接层不暴露提交、修改或取消订单的能力。
- Codex 仍可使用全部正常分析能力；应用会在 `thread/start` / `thread/resume` 的配置层精确禁用已识别 Longbridge MCP 的真实下单、改单、撤单、平仓、行权和 DCA 写工具，并禁用 Apps 的破坏性动作，同时保留行情、持仓、订单查询、研究类 Apps、Skills、网页、Shell 和文件能力。若校验后仍发现交易写工具，本轮不会启动。
- Agent 终态采用“通知快速返回 + 持久 turn 状态对账”双路径；漏掉完成通知时会从同一个 App Server 线程回收结果，最近完成结果也会加密保存供界面重载恢复。

## Agent 分析口径

- 短周期：EMA 3 / 5 / 8 / 13 / 21。
- 长周期：EMA 144 / 169。
- Fib 三点扩展：0.382 / 0.618 / 1 / 1.618，公式为 `C + (B - A) × ratio`；A→B→C 必须严格按时间排序，C 至少经过 3 根右侧 K 线确认。
- 行情计算：Longbridge 日线、前复权、仅常规交易时段，默认 260 根，足以覆盖 EMA169，并使用两分钟内存缓存避免每次分析重复等待。
- 持仓估值优先采用时间戳最新的常规/盘前/盘后/夜盘报价；组合 `quoteAsOf` 取所有已估值持仓中最旧的一项。
- 账户总额直接采用长桥 USD 口径；多币种持仓通过已规范方向并经 USD/HKD 合理性校验的汇率图换算。集中度使用 gross exposure，另保留 net exposure。
- 候选买入先以未验证 Stage 1 处理：只有日线 EMA21 证据、现金比例与组合估值完整，且现有期权 Delta/标的名义风险不会被漏算时，本地引擎才给出初始/最大仓位上限。Codex 再用 Skills/MCP 识别主题并返回结构化复核；结果只能收紧本地、现金与主题上限，新增融资始终为 0。
- 输出：技术结构、组合权重、主题暴露、参考位静态组合影响、牛/基准/熊静态条件计划与证据链。计划不在后台监控。

## Codex 持久项目

- 默认工作区为 `trading-agent-workspace/`，线程 ID 加密保存在应用状态中，重启后通过 App Server `thread/resume` 继续。
- Codex 正常继承本机配置、全局/项目 Skills、MCP、Apps、项目规则、网页和文件工具，不再使用临时或只读推理会话。
- 每轮按分析范围提供结构化上下文：单标的只有目标与组合摘要，全组合才包含完整持仓；账户号和 OAuth 凭证不会进入模型上下文。
- 驾驶舱可管理多个独立持久 thread，并在同一 App Server 连接内按 thread 并发运行；新会话不会继承其他会话的聊天内容，完成事件与取消也按 thread 隔离。
- UI 只拉取会话元数据并在本地筛选；点击会话后通过一次 `thread/resume` 同时取得最近 30 个摘要 turn，不再扫描所有对话或把摘要转成 `/history`。若正文水合超时，会立即打开同一 thread 并使用加密本地索引兜底。Agent 显式查询过去讨论时仍只允许最近 30 天。
- 这些记录是本机 `source=appServer` 的 Codex thread，不是 ChatGPT 网页对话，因此不会出现在 ChatGPT/GPT 网页历史侧栏；驾驶舱自己的“本机对话”列表才是可靠入口。
- 长桥本身仍是查询白名单，最终交易由用户在券商端手动确认。

## 构建 macOS 应用

```bash
npm run desktop:pack  # 生成未安装的 .app 目录
npm run desktop:dist  # 生成 DMG 与 ZIP
```

未签名的本地构建只适合本机开发。对外分发前需要配置 Apple Developer ID 签名与 notarization。

更详细说明见 [desktop/README.md](desktop/README.md)。
