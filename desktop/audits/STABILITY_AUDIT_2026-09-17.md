# 交易驾驶舱稳定性与收敛审计

审计开始：2026-09-17；完成：2026-09-18。基线：当前工作区桌面代码 0.24.1。

## 结论

当前产品已经具备可用的个人研究终端形态，下一步应当是可靠性收敛，而不是继续扩展页面和指标。最重要的风险集中在跨模块边界：保存是否真正落盘、同步结果属于哪个账户与请求、模型实际收到了什么、分析何时才算完成，以及页面是否如实展示这些状态。

目前不能把它称为“可长期无人值守、完整核算收益、研究结果可完全复现”的闭环。这不是推翻当前架构的理由：TradingView 原生界面、券商只读数据桥、单一 Codex 运行时、宿主确定性证据与模型判断的分工，值得保留。

## 范围与证据等级

- 本次是审查，不是修复；没有修改应用代码、真实账户、授权、历史记录或已安装 DMG。
- 没有调用真实券商接口或发起真实 Agent 分析；故障注入使用临时目录、假响应和隔离数据。
- 全量现有测试：721 / 721 通过。首次受限环境的本机回调监听失败，在允许本机监听的环境重跑通过，不计为产品缺陷。
- 另外进行了保存失败、账户切换竞态、不同参数并发同步、慢分段答案、上下文投递、质量标签和 UI 状态的隔离检查。
- “已复现”表示能在隔离输入下触发；“源码确认”表示明确代码路径，尚无真实运行耗时或事故证据；“待验证”不可当作生产事故。
- 未重新证明当前 DMG 与整个未提交工作区逐文件一致，也未做连续多日真实账户运行验收。
- P1：新增功能前应优先处理。P2：下一轮可靠性收敛。P3：有回归保护后整理。不是事故损失评级。

## 一、优先处理的确认缺陷

### F01 · P1 · 保存失败后内存与磁盘不是同一版本【已复现】

`EncryptedStore.set/update` 先改变内存，再加密写盘；写入失败不会回滚。加密能力不可用时，写盘函数直接返回成功。

- 加密失败探针：调用报错，但内存为 revision 2、磁盘仍为 revision 1。
- 加密能力中途不可用探针：调用正常返回，内存为 revision 2、磁盘仍为 revision 1。
- 影响：页面、后续操作、重启恢复可能基于不同事实；“保存成功”不能始终代表持久保存。没有证据表明现有用户数据已经损坏。
- 处理：持久提交成功后才更新已提交内存；不可加密时明确拒绝持久写入。所有业务存储统一暴露健康状态。区分暂时不可解密与文件损坏，保留恢复副本但不要无提示变成空工作区。
- 验收：磁盘写入、加密、重命名失败和中途失去加密能力时，旧版本仍完整；不能成功返回未落盘的新版本；重启后结果一致。

证据：[encrypted-store.mjs:66](/Users/gawei1995/Documents/stock_agent/desktop/src/security/encrypted-store.mjs:66)、[encrypted-store.mjs:98](/Users/gawei1995/Documents/stock_agent/desktop/src/security/encrypted-store.mjs:98)、[main.mjs:695](/Users/gawei1995/Documents/stock_agent/desktop/main.mjs:695)。

### F02 · P1 · 静默 5 秒会截断仍在运行的分段答案【已复现】

第一段 final 完成后，静默计时器会查询远端；即使明确得到 `inProgress`，仍可能本地合成 `completed` 并发送 `turn/interrupt`。

- 故障注入：第一段立即到达，第二段“风险与限制”在 6.5 秒到达；远端状态查询正常且始终明确仍在运行。
- 结果：约 5.021 秒返回第一段，第二段未交付，宿主已经发送中断。
- 处理：严格拆开“收到可展示文本”“远端结束”“完整结果已持久核验”。远端仍运行时不能以静默时长代替完成；断连时可显示暂存答案，但必须标注终态未核验。
- 验收：慢分段、工具间歇、漏完成通知、断连重连、主动取消都不丢答案、不串会话、不伪报成功。

证据：[codex-workspace.mjs:2455](/Users/gawei1995/Documents/stock_agent/desktop/src/engine/codex-workspace.mjs:2455)、[codex-workspace.mjs:2595](/Users/gawei1995/Documents/stock_agent/desktop/src/engine/codex-workspace.mjs:2595)。协议核对使用 OpenAI Docs：最终终态由 `turn/completed` 表达；单条消息完成不等于整轮完成。[官方生命周期说明](https://learn.chatgpt.com/docs/app-server#lifecycle-overview)

### F03 · P1 · 历史同步中途换账户可能混写证据【已复现】

历史同步只在开始读取账户作用域，订单与成交分阶段查询，提交时没有复核账户或授权代际；该同步也没有加入已有授权生命周期的任务跟踪。

- 隔离输入：暂停 A 账户订单响应，切到 B 后再完成成交查询。
- 结果：保存的 archive 标记为 A，却同时含 A 订单和 B 成交。
- 处理：从请求到提交贯穿账户标识、授权代际和操作 ID；在每次异步返回及最终提交前核验。换号时旧操作不得继续发布结果。
- 验收：任意查询阶段换号，旧结果不能进入缓存、复盘、财报关联或成交后快照；保留旧历史，不以清空数据绕过隔离问题。

证据：[trade-history-service.mjs:275](/Users/gawei1995/Documents/stock_agent/desktop/src/data/trade-history-service.mjs:275)、[trade-history-service.mjs:406](/Users/gawei1995/Documents/stock_agent/desktop/src/data/trade-history-service.mjs:406)、[main.mjs:1251](/Users/gawei1995/Documents/stock_agent/desktop/main.mjs:1251)。

### F04 · P1 · 组合 Agent 证据漏掉雷达明细，清单却称完整【已复现】

上游已经把雷达批次放入 `scopedContext.technicalRadar`，但模型上下文装配没有传递它。带唯一批次和卡片标记的输入，最终模型包中均找不到；交付清单仍可为 `complete`。

- 影响：页面有逐标的技术状态，整体组合 Agent 却没收到同一份明细，证据追踪与实际输入不一致。
- 处理：按分析范围声明必需输入，显式投递紧凑雷达块；完整性从“应该投递什么”核验，不能只哈希“已经投递的东西”。
- 验收：源字段、模型证据块、页面来源三者同版本；重要数据缺失必须显式降级，而非成功显示完整。

证据：[agent.mjs:1308](/Users/gawei1995/Documents/stock_agent/desktop/src/engine/agent.mjs:1308)、[codex-workspace.mjs:3693](/Users/gawei1995/Documents/stock_agent/desktop/src/engine/codex-workspace.mjs:3693)。

### F05 · P2 · 并发不同历史查询会返回同一个请求的结果【已复现】

单个 `this.syncing` 合并了所有并发调用，没有比较账户、日期和标的。先查 AAPL 8 月 1—10 日，再并发查 MSFT 8 月 11—20 日，第二个调用正常返回第一组结果，实际没有查询第二组。

处理及验收：只有完全相同的请求才共享任务；其他请求排队、独立执行或明确提示忙碌。每个结果返回实际查询范围与操作 ID，不能把 A 完成当作 B 完成。

证据：[trade-history-service.mjs:247](/Users/gawei1995/Documents/stock_agent/desktop/src/data/trade-history-service.mjs:247)。

### F06 · P2 · 双券商汇总把降级来源误标为实时【已复现】

汇总固定 `fxStatus: live` 并清空来源告警，券商子账户也没有保留完整质量信息。参考缓存汇率输入会变成“实时、无告警”，影响页面与 Agent 来源陈述。

未发现该路径重复汇率换算；这里确认的是可信度标签失真，不是总金额已经算错。现有汇总估值门槛仍未开放，应继续保留。

处理及验收：逐券商保留来源、观察时间和限制；汇总显示最保守状态或“混合来源”。来源标签不能随着切换汇总视图消失，Agent 与 UI 必须一致。

证据：[broker-portfolios.mjs:49](/Users/gawei1995/Documents/stock_agent/desktop/src/data/broker-portfolios.mjs:49)。

### F07 · P2 · 雷达和快照消息会覆盖长桥连接提示【已复现】

所有非 Agent 状态被交给长桥连接状态函数。雷达完成会把“长桥已连接”改成“连接长桥”；快照缺口还能抹掉“需要升级只读授权”的提示。后台不一定真的断连。

处理及验收：固定连接、授权、雷达、快照、复盘各自的状态域。任务消息不得改变连接或授权状态；后台任务完成不能让连接按钮变错。

证据：[renderer.js:196](/Users/gawei1995/Documents/stock_agent/desktop/renderer/renderer.js:196)、[renderer.js:3935](/Users/gawei1995/Documents/stock_agent/desktop/renderer/renderer.js:3935)。

## 二、UI 与交付性能问题

| 编号 | 确认事实 | 处理与验收 |
| --- | --- | --- |
| U01 · P2 | 自动快照成功没有推送复盘覆盖更新；停留页面可能一直显示旧状态 | 以账本版本推送局部更新；不必切页，确认状态应及时出现 |
| U02 · P2 | 一次复盘刷新串行构建两次完整快照，并用全局 loading 阻止切回 TV | 一份带版本的摘要、独立订单分页；读取不锁导航。重复计算已确认，实际耗时尚未测量 |
| U03 · P2 | 验证中心表单每次重建，未提交净 R、备注、候选和 v2 条件没有独立草稿 | 按验证 ID 与协议版本保存草稿；后台任务完成、切页不能清空输入 |
| U04 · P2 | 最终文本到达后仍等待完整历史分页，最多 20 页串行读取 | 对历史核对设置总预算；已有可证明完整的文本先交付，缺失部分才分页。不能用 F02 的强制中断代替性能优化 |

证据：[review.js:294](/Users/gawei1995/Documents/stock_agent/desktop/renderer/review.js:294)、[main.mjs:3638](/Users/gawei1995/Documents/stock_agent/desktop/main.mjs:3638)、[review.js:502](/Users/gawei1995/Documents/stock_agent/desktop/renderer/review.js:502)、[review.js:444](/Users/gawei1995/Documents/stock_agent/desktop/renderer/review.js:444)、[review.js:609](/Users/gawei1995/Documents/stock_agent/desktop/renderer/review.js:609)、[codex-workspace.mjs:1829](/Users/gawei1995/Documents/stock_agent/desktop/src/engine/codex-workspace.mjs:1829)、[codex-workspace.mjs:2705](/Users/gawei1995/Documents/stock_agent/desktop/src/engine/codex-workspace.mjs:2705)。

## 三、不是偶发 Bug，而是尚未闭合的能力

### 1. IBKR 与长桥还不是全流程对等

| 能力 | 长桥 | IBKR | 双券商汇总 |
| --- | --- | --- | --- |
| 持仓与期权展示 | 已接入，受权限与行情质量约束 | 已接入，受权限与行情质量约束 | 可汇总展示；质量标签需修复 |
| Agent 研究输入 | 已接入 | 可作研究输入 | 可作研究输入；不等于可精确计仓 |
| 已核验仓位规模计划 | 满足新鲜度及估值等门槛后开放 | 估值 gate 尚未接入 | 独立汇总 gate 尚未接入 |
| 券商历史订单及成交关联 | 已接入；需修复同步隔离 | 尚未接入 | 不能声称覆盖全部券商 |
| 自动常规收盘快照 | 已实现条件式采集，记录为 partial | 尚未接入 | 不是完整合并账户账本 |

不要为了让按钮可点而放开现有保护。产品应直接说明“可展示、可研究、可核验、可复盘”的区别。

证据：[ibkr-portfolio.mjs:101](/Users/gawei1995/Documents/stock_agent/desktop/src/data/ibkr-portfolio.mjs:101)、[broker-portfolios.mjs:55](/Users/gawei1995/Documents/stock_agent/desktop/src/data/broker-portfolios.mjs:55)、[freshness.mjs:42](/Users/gawei1995/Documents/stock_agent/desktop/src/data/freshness.mjs:42)。

### 2. 每日留档不等于完整收益账本

正常持久化前提下，应用运行时每 15 分钟核验，并在唤醒/解锁后补检；当前版本当日 EOD 已确认后，不会再联网重估覆盖。无人值守后台/登录启动需要用户显式开启，机器关机或睡眠仍不能保证每日捕获。

当前 EOD 用常规收盘价格，但数量、现金来自收盘后的抓取；未完整对账盘后交易、资金流、费用和公司行动，所以主动标为 `partial`，不应改标签假装完整净值端点。成交后观察依赖同步/刷新触发及最近 15 分钟窗口，也不等于逐成交实时订阅。

应分别显示：日终观察覆盖率、成交后观察覆盖率、收益起终点可用性。需要可靠月度收益时，补的是库存与现金流对账链，而不只是增加快照次数。错过的历史只能缺口说明，不能拿当前账户倒填。

快照账本已有“不静默删除历史”的保护，但容量上限是 12,000 条 / 64 MiB；雷达为 400 批 / 96 MiB。还需容量预警、受控封存和可恢复的分段账本方案，否则长期使用最终会拒绝新写入。

证据：[main.mjs:3383](/Users/gawei1995/Documents/stock_agent/desktop/main.mjs:3383)、[main.mjs:3554](/Users/gawei1995/Documents/stock_agent/desktop/main.mjs:3554)、[main.mjs:3654](/Users/gawei1995/Documents/stock_agent/desktop/main.mjs:3654)、[portfolio-snapshot-store.mjs:7](/Users/gawei1995/Documents/stock_agent/desktop/src/data/portfolio-snapshot-store.mjs:7)、[technical-radar-store.mjs:8](/Users/gawei1995/Documents/stock_agent/desktop/src/data/technical-radar-store.mjs:8)。

### 3. 只读承诺需要分层，而非笼统宣称

券商桥接有真实的查询白名单；Codex 也禁用了已识别长桥写工具和 Apps 破坏性动作。但通用 Agent 使用较宽权限，对其他命令、文件和权限请求存在自动接受路径。构造 Longbridge + IBKR MCP 配置时，保护函数只给 Longbridge 生成覆盖规则。

这不证明用户安装了 IBKR MCP，也不证明发生过下单；TWS 自身只读设置仍可独立保护。问题在于“整个 Agent 技术上绝不可能下单”的承诺强于现有防线。

建议保持分析、搜索、Skills 和研究工具自由，另外定义真实交易写操作和凭证访问边界；按能力统一禁止交易写工具，而非只识别一个服务名。未知交易服务默认不授予写权限，权限状态对用户可见。

证据：[codex-workspace.mjs:2262](/Users/gawei1995/Documents/stock_agent/desktop/src/engine/codex-workspace.mjs:2262)、[codex-workspace.mjs:6178](/Users/gawei1995/Documents/stock_agent/desktop/src/engine/codex-workspace.mjs:6178)、[renderer.js:1593](/Users/gawei1995/Documents/stock_agent/desktop/renderer/renderer.js:1593)。

### 4. 当前备份是同机恢复，不是完整灾难恢复

备份只复制四类加密业务文件，依赖原 macOS Keychain / safeStorage 身份；不支持换机器或丢失密钥后恢复。排除混有凭证的 `secure-state.bin` 是正确的，但其中的会话索引和部分结果恢复状态也不在这四类文件里。

补充方向：先把凭证与非秘密业务索引分离，列出备份覆盖清单并做恢复演练；再由用户确认是否需要可移植加密备份。不能通过直接打包密钥或账户凭证解决。

证据：[trusted-backup-bundle.mjs:39](/Users/gawei1995/Documents/stock_agent/desktop/src/security/trusted-backup-bundle.mjs:39)、[trusted-backup-bundle.mjs:61](/Users/gawei1995/Documents/stock_agent/desktop/src/security/trusted-backup-bundle.mjs:61)。

## 四、冗余建设与历史遗留

1. **旧财报案例与新周期复盘双轨。** 新周期能生成结构化验证草案，候选索引也读取 cycles；旧案例保留独立模型/UI，不能假设相同闭环。应统一“周期”为核心对象，财报/月度/交易区间只是模板，旧记录用兼容只读视图保留。
2. **隐藏的旧规则页面仍有写入口。** 导航隐藏不等于流程退役，旧 hash 路由、建规则、迁移和 Review 表单仍在。应将旧入口导向验证中心并保留审计历史，停止扩展重复写路径。
3. **能力文案落后于实现。** 旧页面和 README 仍泛称“确定性引擎未接入”，代码已经有协议评估器；同时部分技术样本确实仍受独立性等资格限制。应按协议返回具体未就绪原因，而不是一段全局旧文案。
4. **网页原型与桌面生产并存。** 根目录默认命令仍指向原型；原型在证据选择等细节上已与桌面不同。建议冻结为设计参考并移出生产默认验收路径，不再平行维护第二个产品。
5. **样式和主控逻辑累积。** 雷达旧样式由新文件覆盖；主进程、会话与复盘大文件承载多个领域。拆分应围绕状态所有权和数据契约，而非只追求文件变短或更换框架。

这些不是要求删除历史。旧数据要保留来源和只读入口，旧写路径才应退出；业务缓存、快照与雷达账本职责不同，不应一概当作重复缓存删除。现有 Codex 适配、结果持久化和 UI 操作索引也不等于另建第二套 Agent harness，应收敛身份与终态，而不是再嵌入一套 CLI 来回避问题。

证据：[codex-workspace.mjs:4438](/Users/gawei1995/Documents/stock_agent/desktop/src/engine/codex-workspace.mjs:4438)、[review-validation-candidates.mjs:16](/Users/gawei1995/Documents/stock_agent/desktop/src/review/review-validation-candidates.mjs:16)、[review.js:3960](/Users/gawei1995/Documents/stock_agent/desktop/renderer/review.js:3960)、[review.js:4000](/Users/gawei1995/Documents/stock_agent/desktop/renderer/review.js:4000)、[review-store.mjs:315](/Users/gawei1995/Documents/stock_agent/desktop/src/data/review-store.mjs:315)、[package.json:9](/Users/gawei1995/Documents/stock_agent/package.json:9)。

## 五、必须补齐的版本与数值契约

### 版本可复现

- 当前工作区为 0.24.1，HEAD 中 desktop/package.json 为 0.18.1；本次检查没有发布标签，许多当前生产模块仍未纳入提交。已有 DMG 校验值不等于可从仓库精确重建。
- 发布应绑定源码提交、锁定依赖、应用哈希、Codex 兼容版本、Skill 内容哈希与测试清单。先形成可回退基线，再修复；回退同时考虑数据格式，不只是替换旧 App。
- 当前构建命令只强制执行 `.test.mjs`；UI 与已打包依赖 smoke 检查未纳入发布门禁。统一发布验收入口，避免手工步骤下次遗漏。
- 已存在的复盘 Skill 一律保留、不比较版本；“文件存在”会被当作 ready。应保留用户定制，但提示内置版差异，检查协议兼容性，并为每份复盘保存实际 Skill 版本/哈希。

证据：[desktop/package.json:11](/Users/gawei1995/Documents/stock_agent/desktop/package.json:11)、[workspace-review-skills.mjs:38](/Users/gawei1995/Documents/stock_agent/desktop/src/engine/workspace-review-skills.mjs:38)。

### 数值不是越多越好，而是语义要稳定

当前候选仓位有结构化数值校验，但这不等于持仓、组合、复盘自然语言中的全部金额、胜率和归因数字已经逐项核验。输入有哈希也不保证模型没有误解单位或分母。

- 宿主负责事实和运算：金额、币种、换算方向、数量、期权乘数、时间、敞口、样本分母与可计算性。
- 模型负责解释和决策建议：选择指标、解释冲突、设定情景、提出 Fib 锚点及仓位建议；不将 EMA/Fib 固化为唯一策略。
- 关键计划数字绑定 factId、单位、时间和来源；展示区分“宿主已核验”“模型假设”“资料缺口”。缺失不补零，事后信息不冒充事前判断。
- 技术数据先投递紧凑状态、变化、关键水平、覆盖缺口，再按需读取明细。单标的不应默认背负全组合全量历史；整体组合也不应丢失逐标的雷达摘要。
- 对 EMA、调整方式、形成中 K 线、交易日与日内时段、AVWAP 锚点、Fib 锚点、币种与期权乘数建立固定样例。对模型建立包含冲突和缺失值的离线评估，而不只验证 JSON 合法。
- 当前“成本集中度”实现是日 OHLCV 区间均匀分配的低置信度近似，不是真实持有人成本、逐笔订单流或筹码归属。这个标签应在 UI、证据包和最终结论保持一致。

证据：[numeric-claim-audit.mjs:92](/Users/gawei1995/Documents/stock_agent/desktop/src/engine/numeric-claim-audit.mjs:92)、[cost-concentration.mjs:4](/Users/gawei1995/Documents/stock_agent/desktop/src/engine/cost-concentration.mjs:4)。

### 统一健康视图，而不是再建一套监控体系

现有业务账本和部分诊断记录值得保留，但还需一个轻量总览：各券商连接与授权、数据截至时间、查询范围、快照最近成功/缺口、存储健康/容量、模型证据交付、对话终态、实际使用的版本。近期错误按操作 ID 关联并脱敏，不写原始账户号、凭证或整份财务数据。

这能回答“为什么慢、为什么不能计仓、为什么不是完整复盘”，而不让用户通过反复刷新或重启猜测。

## 六、应固定下来的产品约束

1. **事实身份不可混淆：** 券商、账户、标的/合约、查询范围、证据版本、会话和操作 ID 贯穿全链路。
2. **保存成功就是已持久化：** 明确失败，保留旧事实，不以缓存新值冒充成功。
3. **界面、模型、账本使用同一份证据：** 缓存、参考汇率、近似指标和缺口标签不能在汇总时消失。
4. **终态只结束自己的操作：** 不用短静默推断远端完成，不因一个会话结束取消另一个。
5. **未来不能倒灌过去：** 事后回忆、当时封存判断、未来计划分别存储；改选订单生成新证据版本，旧结果留存并标旧。
6. **数值与判断分工：** 宿主核验单位/数学/硬风险边界，模型保留策略与解释自由。用户当前 150% 毛敞口上限不得由模型自行修改。
7. **历史不静默消失：** 成功 EOD 不被盘后价格覆盖；漏采不补造；归档、数据迁移和容量处理都可审计恢复。
8. **只有一条复盘到验证主路径：** AI 提案，用户确认开始观察及纳入样本，系统计算，达标后人工决策。不能把历史校准样本充当前向证据，也不能把唯一周期数量冒充统计独立性。
9. **只读承诺与实际权限一致：** 研究能力开放不等于交易写权限开放。

## 七、推进顺序与验收

### 阶段 A：先建立可靠基线

冻结当前可用版本与可恢复备份；修复 F01—F07，补跨账户/并发/慢分段/存储失败行为测试；明确只读能力范围。验收核心是“不混账户、不假完成、不假保存、不丢证据、不误报来源”。

### 阶段 B：把使用路径收敛

统一复盘周期与验证中心；修复草稿丢失、重复加载和覆盖状态刷新；将 Skill/数据/运行时版本与业务记录绑定；发布命令强制执行桌面与打包 smoke。保留 TV、左右栏与单一 Codex 运行时，不做前端框架重写。

### 阶段 C：补长期使用能力

用多日受控运行检查睡眠、唤醒、断网、重新授权和重启；补容量预警与恢复演练。根据需求再扩展 IBKR 历史/快照和收盘库存现金流对账。建立技术证据及模型数值理解的固定评估集，而不是直接增加更多指标。

发布验收至少覆盖：不同参数并发同步、同步中途换账户、迟到 final、断连回收、重启恢复、保存失败、混合汇率来源、缺失期权乘数、形成中 K 线、改选订单后的旧结果、填写中后台刷新、收盘后采集幂等与错过窗口。

### 尚待核实，不作为已确认事故

历史查询分片从上一片结束时间加 1000ms 开始。毫秒精度的假服务中可漏掉边界的 999ms，但真实影响取决于券商接口时间精度；需核对契约，并用重叠查询加稳定 ID 去重消除边界歧义。

证据：[trade-history-service.mjs:1571](/Users/gawei1995/Documents/stock_agent/desktop/src/data/trade-history-service.mjs:1571)。

本轮不建议：新增第二套 Agent、放宽数据门槛来让按钮可用、删除旧账本、强制覆盖自定义 Skill、继续复制旧原型功能，或把签名/Apple 公证纳入本次范围。
