# 证据与时间防火墙

## 1. 周期与阶段标识

每次运行至少记录：

```text
cycle_id
cycle_mode
review_mode: lightweight | rigorous
phase: retrospective | blind | outcome
thread_id
linked_thread_id
record_revision
evidence_revision
decision_at
cutoff_at
data_as_of
timezone
blind_assessment_id
```

`blind` 与 `outcome` 使用不同 thread；两者通过 `cycle_id` 和冻结的 `blind_assessment_id` 关联。`retrospective` 使用自己的独立 thread，且 `blind_assessment_id=null`。每个 phase 内的继续追问复用原 thread。outcome 不得覆盖 blind 证据或判断。

## 2. 证据标签

| 标签 | 内容 | 约束 |
|---|---|---|
| `用户原话` | 我的判断、市场相信什么、计划动作、失效条件 | 原样保存、版本化；短不等于无效 |
| `AI事前结构化` | AI 在 cutoff 前对用户原话的结构化和补问结果 | 保留来源、生成时间和用户确认；不得替代原话 |
| `券商事实` | 有效成交、已成交父订单、费用、现金、持仓快照、币种及排除审计 | 订单不等于成交；纯未成交和不可核验记录不得进入主分析；不得改写 |
| `基本面/市场事实` | 公告、财务、共识、宏观、行业和新闻 | 记录发布时间、来源和当时可得性 |
| `技术事实` | OHLCV、相对强弱、筹码、波动率、期权与图表快照 | 记录时间框架、复权、盘前盘后和锚点 |
| `派生指标` | P&L、R、MAE/MFE、敞口、滑点、相对基准 | 记录公式、窗口、基准、FX 与缺失字段 |
| `Agent推断` | 评价、归因、Stage、技术温度、改进假设 | 标注置信度，不冒充任何事实或用户原话 |

轻量 retrospective 的用户记录必须拆成三个独立标签：

| 标签 | 时间语义 | 使用边界 |
|---|---|---|
| `事后回忆的当时判断` | 当前记录的历史回忆 | 永远不是事前证据，不进入正式判断质量评分 |
| `本次感悟` | 当前复盘反思 | 不回填当时计划或失效条件 |
| `从记录时点起生效的未来预判` | `effective_from=recorded_at` | 可用于未来验证，不得倒用于本周期 |

分别保存用户原文、`recorded_at` 和 revision。AI 结构化必须另存，不得覆盖、合并或换标签。

市场叙事 Stage 与技术温度分别保存。技术证据按案例选择，不能以缺少 EMA/Fib 判定技术证据不完整。

## 3. 时间准入

blind 证据只有在以下条件均满足时才能准入：

1. 原始来源的 `published_at` 或实际可得时间不晚于 `cutoff_at`；
2. 用户/AI 内容的 `authored_at` 和最后修改时间不晚于 `cutoff_at`；
3. 数据库抓取时间不能替代原始发布时间；
4. 修订数据使用当时版本，不使用后来重述值；
5. 每个决策检查点单独应用 cutoff，不能用周期结束时的信息评价早期动作。

无法证明准入时间时标为 `unknown_time`，从正式 blind 评分中排除。cutoff 后补写统一标为 `retrospective`。

## 4. 两阶段交接

blind thread 冻结：证据清单、缺失项、用户原话、AI 事前结构化、当时判断和版本哈希。outcome thread 只读取冻结包作为事前判断，再读取 cutoff 后事实。

组合快照必须保留 `snapshot_at`。只有时间位于周期范围内且来源可追溯的历史快照可作为周期末证据；在 outcome 运行时临时读取的当前组合仅是 `current_portfolio_context`，不能改名为周期末组合，也不能用来重建历史仓位或敞口。

若 blind thread 已接触未来事实，标记 `contaminated` 并重建新的 blind thread；不得把受污染输出当成正式盲评。

直接 retrospective 路径不制造虚假的两阶段交接。它可以读取周期结束前后的已准入事实来评价执行和结果，但必须显式保留 `evidence_grade=retrospective`，不能事后生成一个 blind 版本再冒充事前判断。

券商记录重新关联时使用追加式 revision：保留旧关联与旧输出，记录增删 ID 和原因，把旧输出标为 `stale`，再以最新有效 `evidence_revision` 重跑完整分析。任何展示结果都必须声明其 `based_on_evidence_revision`，避免错选订单修正后继续引用旧结论。

## 5. 证据等级

- `prospective`：关键主观字段和计划在 cutoff 前封存，可正式评价判断与纪律。
- `partial_prospective`：部分字段事前封存；只评价有证据的维度。
- `retrospective`：没有可靠事前封存；不可正式评价判断、计划遵守或失效纪律。
- `contaminated`：blind 接触未来事实；必须重建或仅作探索性材料。

始终保留原始记录；AI 的结构化、补全和推断只能新增版本，不能覆写历史。

## 6. 验证与规则晋级

AI 只能先生成结构化验证草案：假设、适用条件、动作、失效、主/次指标、窗口、样本纳入与排除、基准、混杂因素、失败环境及留出验证。用户确认或编辑后才登记测试。AI 可以汇总测试结果并提出建议，但规则状态的每次晋级都需要人工确认，不能由分数、胜率或模型自动触发。
