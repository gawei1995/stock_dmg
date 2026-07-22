# 交易驾驶舱 Desktop

## 产品结构

```text
┌────────────────────┬──────────────────────────────────┬────────────────────────┐
│ 长桥真实账户        │ TradingView 个人网页会话          │ 交易 Agent              │
│ USD净资产/现金/仓位 │ Layout/画线/私有指标/Watchlist    │ Codex + EMA/Fib/风险计划 │
└────────────────────┴──────────────────────────────────┴────────────────────────┘
```

中间区域不是 TradingView Widget，也不使用应用自绘行情。它是 Electron `WebContentsView` 直接加载的 TradingView 完整网页，并使用独立持久会话。

## 安全架构

### TradingView

- 远程视图启用 `sandbox`、`contextIsolation` 和 `webSecurity`。
- 禁用 Node integration、preload、插件、`webview` 与实验特性。
- 主导航仅允许 TradingView HTTPS 域名。
- 不向 TradingView 注入脚本，不抓取页面 DOM，不共享 Chrome Cookie。
- Cookie/localStorage/cache 只存在 `persist:tradingview` 分区。

### Longbridge

- MCP 与 OAuth 全部运行在 Electron main process。
- OAuth 使用 PKCE、`127.0.0.1` 临时端口回调、随机 state 和 public-client 模式。
- Token、持仓缓存与观察计划使用 `safeStorage` 加密保存；没有明文回退。
- Renderer 只能调用窄化的“连接、刷新、运行 Agent”IPC，不暴露通用 `callTool`。
- 服务端 `/v2` 与六项查询工具白名单共同阻止订单写入；`option_quote` 只用于期权报价与真实合约乘数。Bearer Token 只允许发往官方 `.cn/.com` 的 HTTPS `/v2` 端点。

### Agent

- Codex App Server 是唯一的 Agent harness：它统一管理持久线程、历史、工具生命周期、Skills/MCP/Apps、流式事件、取消与结果收集。长桥、EMA/Fib 与风险计算只是同一 harness 的只读证据能力，不是第二个规则式 Agent。
- 右栏支持新建和直接打开多个独立 Codex 会话。每个会话使用自己的持久 `thread`；`thread/resume` 后显示原 transcript，下一次 `turn/start` 继续同一上下文。项目规则、Skills/MCP/Apps 共享，但对话上下文不会混在一起。应用只允许切换本机加密 registry 中登记的驾驶舱线程。
- 新会话先显示“新对话”，首个真实问题会在本地立即生成简洁摘要标题并同步到 App Server；不再用日期时间命名，也不会把驾驶舱内部提示词写成标题。
- 单个 App Server/RPC 连接按 `threadId` 管理多轮运行；不同会话可以并发，同一会话仍保持一轮一轮执行。每条会话拥有独立 spinner、流式文本、工具事件、取消和终态回收，不维护第二套 harness。
- 分析范围分为三类：`position` 读取选中真实持仓，`candidate` 可分析未持有代码并形成候选买入条件，`portfolio` 一次检查全部持仓与组合健康。
- 上下文按范围分层：单标的只注入目标和组合聚合摘要；只有全组合分析才注入完整持仓。稳定规则来自项目/Skills，实时数量、成本、价格、汇率、EMA/Fib 和权重来自本轮最新证据。
- 候选 scope 会把 Top1/Top5、主题暴露、现金、毛净暴露、保证金与组合告警聚合进 `portfolioConstraints`。只有 EMA21/日线证据、现金比例与组合估值完整，且组合没有尚未量化 Delta/标的名义风险的期权时，才生成仓位上限。Codex 使用 Skills/MCP 核验主题后返回结构化 sizing 复核；应用会把候选映射到当前主题 key，并只允许收紧初始新增、最大总/新增仓位，绝不放大本地上限。新增融资权重始终为 0。
- 数值由本地确定性引擎计算；EMA、Fib、权重与风险预算不交给语言模型猜测。
- 叙事结论使用本机已登录的 Codex App Server；线程为持久会话，应用重启后通过 `thread/resume` 延续。
- Codex 项目目录默认是 `~/Documents/stock_agent/trading-agent-workspace`，可用 `TRADING_COCKPIT_CODEX_WORKSPACE` 覆盖为其他绝对路径。
- 不再使用 `--ephemeral`、`--ignore-user-config`、广泛工具黑名单或 45 秒分析截止；正常继承本机 Codex 配置、项目规则、Skills、MCP 与可访问 Apps。普通分析保持自然 Markdown；候选 scope 仅用窄化输出 Schema 同时取得 Markdown 与可验证仓位复核。工具级例外仅包括：已识别 Longbridge 执行端的精确交易写 deny-list，以及 Apps SDK 的破坏性动作开关；读取和研究能力不受影响。
- Codex 可以使用网页、Shell、文件、Skills、MCP、Apps 与其他已配置工具；采用 `danger-full-access` 工作区能力和 Codex 原生自动审批审查。
- 应用先用 `config/read` 保留用户原有 `disabled_tools`，再通过 `thread/start` / `thread/resume` 的 `config` 并入 Longbridge 下单、改单、撤单、平仓、行权和 DCA 写工具；查询工具不受影响。同一配置将 `apps._default.destructive_enabled` 设为 `false`，不会额外拉一轮 App 清单拖慢启动。线程能力清单校验失败或仍暴露上述交易写工具时，模型 turn 会 fail closed。
- 选中持仓或候选目标、组合聚合风险和已验证指标通过 App Server `additionalContext` 注入；全组合 scope 才包含完整持仓。不会发送账户号、OAuth Token 或长桥凭证。
- 输入框支持 `/` 分析命令、`$Skill`/`$App` 和 `@MCP/tool` 实时联想；Skill 与 App 会转换为 App Server 原生结构化引用。
- Agent 正文和工具事件实时流式显示；取消使用 `turn/interrupt`，不会销毁持久线程。
- 右栏默认只突出 Codex 结论，确定性证据和风险卡片折叠显示；Markdown 使用暗色语义渲染，长输出在栏内独立滚动。标准 Markdown 来源链接、裸 HTTPS 与 Google 安全跳转会显示为暗色主题链接；点击后只经主进程二次校验并交给系统浏览器，不允许远程页面接管驾驶舱导航。
- 工具开始/完成事件按 App Server `itemId` 合并；Agent 消息也按 `itemId` 分流，`commentary` 只作运行预览，最终正文只聚合 `phase=final_answer` 的完整 item。通知是低延迟路径，同时每 5 秒按 active turn ID 轻量读取 `thread/turns/list(itemsView=summary)` 对账；发现终态后再单次读取持久 item 历史，按 turn 顺序去重并合并所有 final 段。
- 不再把首个 `final_answer` 当作整轮唯一结果，也不会在固定 2 秒后立即截断 turn。正常收口以 `turn/completed` 为准；若终态通知丢失，从持久历史回收。只有 final item 已完整结束、连续 5 秒无新 item 且持久终态仍不可读时，才用稳定的完整 final 序列本地收口并清理异常远端 turn。
- 最终消息通过事件、原 IPC、前端周期恢复和持久 turn 历史四条幂等路径返回；UI 从任务提交后即主动对账，不再依赖先收到某个 final 事件。持久历史的 terminal 状态优先于陈旧 active 标记；完成结果不会被下一条中断 turn 覆盖。UI 完成信号不等待加密写盘；每个 Codex 会话的最近结果仍分别加密保存，重载或切换后只恢复对应结果。
- Skills、MCP 与 App 能力清单使用 single-flight 与 10 分钟缓存；会话新建、切换和结果恢复不会重复枚举整套 MCP Schema。能力变化通知带 30 秒冷却，避免连接器重试触发清单自激循环和 App Server 高 CPU/内存占用。
- “本机对话”列表只读取 thread 元数据并在 renderer 本地筛选；点击后对目标 thread 执行一次 resume，并由 `initialTurnsPage` 顺带取最近 30 个摘要 turn。若 App Server 水合超时，界面使用加密本地索引立即打开，不会因对话数量增加而扫描全部正文。Agent 的显式历史查询仍由最近 30 天加密索引与动态工具提供。
- 归档按最后活动时间而不是创建时间判断；持续使用超过 30 天的会话不会被错误轮换。超过窗口且无活动的驾驶舱线程会原生归档、可恢复但不在 UI/工具结果中显示。
- 驾驶舱对话是本机 Codex App Server thread，不会同步成 `chatgpt-conversation://`，因此不会显示在 ChatGPT/GPT 网页聊天历史中。
- 模型尚未返回文本时每 15 秒更新一次已运行时长，界面不会把上游等待伪装成“卡死”，并始终允许取消。
- 当持久线程剩余模型上下文低于 2% 时自动请求 Codex 压缩，以保留关键历史继续工作。
- 技术数据不足时进入 `DEGRADED`，隐藏不可靠计划字段。
- 运行 Agent 时复用两分钟内的真实长桥快照；快照较旧时最多前台等待长桥 1.5 秒，随后用已有真实快照继续并把刷新转入后台。463、超时或断线只降低证据置信度，不再阻塞 Codex 最终答案；账户、汇率与持仓请求并行，日线使用两分钟缓存。
- 期权缺少 OPRA 或真实合约乘数时仍显示真实数量，但市值/权重明确降级；即使权利金市值可估，缺少标的映射、Delta/Greeks 与标的等价名义汇总时，也不会套用正股线性风险估算，候选仓位与杠杆会 fail closed。
- 证据链只展示数据源、参数、时间、记录数与状态，不展示内部思维链。
- 保存计划只会写入本地加密观察记录。
- 持久会话意味着每轮选中持仓证据与分析结果会进入本机 Codex rollout，并用于模型请求；线程记录仍由本机 `CODEX_HOME` 管理。

### 汇率与组合基准

- 组合默认统一按 USD 估值并计算仓位权重。
- 账户净资产、总现金和购买力直接请求长桥的 USD 口径；不会把同一账户的 HKD/USD 展示值相加，也不会对账户总额做第二次换算。
- 优先读取长桥账户汇率；长桥汇率工具不可用时，自动查询 ECB 最新每日参考汇率。
- 长桥 MCP 与 ECB 的原始汇率方向先分别适配成统一的 `from → to` 内部语义；USD/HKD 会做方向与数量级校验，异常时降级而不是继续计算权重。
- ECB 参考汇率保留来源与观察日期，并最多缓存 7 天；它只用于估值和权重，不代表券商可成交汇价。
- 左侧真实持仓与右侧 Agent 可独立隐藏；两条分隔线可拖拽或用键盘调整宽度并持久保存。右侧结论区域独立上下滚动，输入框固定在底部。

## 数据状态

- `LIVE`：本次启动内刚从 Longbridge MCP 同步。
- `CACHED`：上一次真实 Longbridge 快照的本机加密缓存。
- `DEGRADED`：真实账户与数量仍可用，但存在未定价持仓、缺失报价时间、技术行情不足或请求失败。
- `REAUTH_REQUIRED`：OAuth 已过期，需要用户重新授权。

应用不会使用生产演示持仓。未连接时显示空状态；测试目录中的合成数据只用于验证计算函数。

## 常用命令

```bash
npm install
npm test
npm run dev
npm run pack
npm run dist:mac
```

系统地区为中国时会自动使用 `.cn/v2`。也可以显式覆盖：

```bash
LONGBRIDGE_MCP_URL=https://mcp.longbridge.cn/v2 npm run dev
```

## 当前限制

- TradingView 登录状态属于 Electron 独立会话，不会复用浏览器或 TradingView Desktop 的登录状态。
- 左侧持仓与右侧 Agent 可独立收起，也可分别拖拽到合适宽度；中间 TradingView 永远保留最小可视宽度，调整只改变原生 `WebContentsView` 边界，不缩放或拉伸图表。布局偏好仅保存在本机。
- TradingView 工具栏只保留重载和返回已保存布局；无可靠语义的浏览历史前进/后退按钮已移除。
- 全组合 scope 为避免持仓越多越慢，不会自动逐只拉取日线；EMA/Fib 请切换到对应已持仓或候选标的分析。
- “同步标的到 TV”通过 TradingView URL 的 `symbol` 参数显式导航；不会自动读取当前图表选中的代码。
- Fib A/B/C 当前由最近 180 根日线主波段自动选择，C 需要右侧确认；后续可增加用户手工修正锚点。
- Codex 分析依赖本机 ChatGPT/Codex 已安装并登录；模型服务连接波动时线程仍会保留，用户可手动取消或稍后继续。
- 应用不嵌入 Codex CLI/PTY；桌面 UI 直接连接官方 App Server 协议，因此不会出现第二套 CLI 解析、工具监控和历史同步流程。
- App Server 可以继承当前 Codex 主机中已配置和已授权的 MCP/Apps；网页聊天临时注入、但未写入本机 Codex 配置的工具不会自动出现。
- MCP 工具如果要求自定义结构化确认表单，当前 UI 会拒绝该单项动作；普通只读 MCP、Skills、Apps、网页、Shell 和文件工具不受影响。
- 条件计划保存为静态快照，当前版本不在后台持续监控。
- 美股期权报价权限（OPRA）与长桥 App/Web 权限分开；未开通时只显示真实合约数量，不猜测期权估值。
- 对外分发前仍需 Apple Developer ID 签名和 notarization。
