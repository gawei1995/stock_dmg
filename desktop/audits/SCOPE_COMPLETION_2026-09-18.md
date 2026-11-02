# 原定 A → B → C 整改范围完成核对

日期：2026-09-18。依据是用户“按照你的推进顺序开始操作”的原目标，以及 [原审计第七节](STABILITY_AUDIT_2026-09-17.md) 的 A/B/C 实施和验收要求，不以后来追加的更强运行承诺替代原范围。

**后续进展**：用户随后安装 0.24.7，账户刷新通过，但 Agent 仍存在只读检查误拦截。0.24.8 已修复冷配置/目录语义、跨线程缓存、后台清单循环和就绪通知；真实源码单轮/并行短请求与历史回收、1139 项自动测试和 15 项发布门禁通过。新 DMG 尚未安装，诊断环境 WebSocket 超时后退回 HTTPS 的延迟仍存在。见 [安装后验收记录](LIVE_ACCEPTANCE_2026-09-18.md)。本文以下保留此前范围核对，不作为当前 GUI 已完整验收的声明。

## 判定

**原定整改实现、受控验证和 0.24.6 构建交付已完成。真实安装、原业务数据迁移、真实券商/模型表现、连续自然交易日采集没有完成，也没有被标成完成。**

此前实施台账将真实连续多日列为“完整目标保持未完成”的理由，混合了实施交付和上线运行验收。重新核对原文后予以纠正：C 要求“多日受控运行”及“建立固定评估集”，不要求未经确认的真实服务调用或连续自然日采集。该纠正不删除剩余风险，也不宣称生产可靠性已全面验证。

## 要求与当前证据

| 原要求 | 当前可核对证据 | 结论与边界 |
| --- | --- | --- |
| A：冻结原可用版本，保留恢复路径 | 0.24.1 DMG/ZIP 仍在 release；源码基线 `baselines/0.24.1-before-stability/source.tar.gz`；原 `/Applications/交易驾驶舱.app` 未替换 | 已保留旧交付物。源码不是业务备份；实际升级前仍须导出用户恢复包 |
| F01：不假保存、写失败保留原版本 | 事务性 EncryptedStore；encrypted-store、main-reliability、trusted-backup 系列测试；实际包原生 safeStorage 保存/独立进程读回 | 已实现及验证指定正常退出/失败路径；不是全断电事务保证 |
| F02：分段/迟到文本不伪造远端结束 | codex-workspace、codex-turn-history 测试；终态与暂存展示分离 | 受控慢分段、断连、取消等已验证；真实当前服务兼容待运行验收 |
| F03/F05：账户与授权代际、查询身份和并发 | authorization-generation、trade-history-service/operations、main-reliability 测试 | 不同请求不误合流，旧账户结果不能提交；旧历史保留 |
| F04：雷达与复盘证据实际投递 | agent、review-evidence-delivery、review-reconciliation-host 测试 | 从源到实际投递核对闭集合/哈希/版本，不把清单存在当投递完整 |
| F06/F07：来源质量、状态领域隔离 | broker-portfolios/portfolio-service、renderer-stability、view-events 回归 | 混合来源保留警告；雷达和快照不改连接/授权状态 |
| A：只读能力边界 | broker-tool-policy/mcp-security 与 UI 说明 | 券商写工具保护，不把通用研究环境称绝对沙箱 |
| B：周期与验证中心统一 | review-cycle-store/migration、review-workflow/learning-source/validation-candidates、复盘 Electron 交互 | 旧案例只读/显式迁移；新周期与验证入口统一；样本不双计 |
| U01—U04：局部覆盖刷新、少重复计算、草稿、历史预算 | review-stability-ui-smoke、renderer-stability、codex-turn-history、view-events | 草稿限当前进程；历史预算不等于丢弃未完成答案；跨重启草稿是后续项 |
| B：Skill/数据/运行版本绑定与健康视图 | workspace-review-skills、system-health/host、health-ui；发布清单 | 保留用户 Skill 定制；源码/依赖/打包 Skill 指纹可追踪，运行结果有实际版本记录 |
| B：保留 TV 和单一 Codex，不重写框架 | 当前 Electron 宿主、TV 页面和 Codex App Server 适配；原型默认入口已退出生产 | 未增加第二生产 harness；外部验收脚本仅合成数据测试 |
| C：多日受控宿主运行 | snapshot-multiday-host 的 13 个生产宿主函数场景，及 coverage/reconcile/background 回归 | 跨日、断网、授权、重启、幂等、提前收盘/夏令时受控验证通过；不是连续自然交易日已发生 |
| C：容量提示、封存、恢复演练 | segmented-ledger-domain/store、archive-backup-capacity、ledger-archive-host、trusted-backup 系列；源/包内复盘交互 | 两次分段、跨段查询、v4 备份/恢复、重启追加等已验收；无 4 GiB 极限压力或跨设备灾备声明 |
| C：收益对账缺口可追踪 | review-reconciliation/host 及实际投递/UI 回归 | 十项状态与来源完整；未将缺费用/资金流等补零，不冒充完整绩效会计 |
| C：技术事实与模型数值理解固定集 | numeric-semantic-eval 与 technical/anchored-vwap/cost-concentration 等；新增 [12题/35项模型理解语料](acceptance/NUMERIC_MODEL_EVAL.md) | 生产确定性事实回归和模型题目/独立答案/评分条件均交付；真实模型尚未答题 |
| 发布命令、全部必要门禁与独立产物 | 0.24.6 的 `verification-0.24.6-2026-09-17T17-56-44-579Z.json`，全部 15 项 passed，1117/1117；4组源码+4组包内UI，71模块；源码归档核对 | 受验源码/产物匹配，不以旧 Git HEAD 冒充可重建基线；未签名/公证 |

额外关闭的集成边界：基准被8股预算挤掉、一个慢源丢失已成功结果、历史全文尾部搜索、匿名账户授信、月末和提前收盘文案、数值分母/币种、跨账户旧 UI 结果，以及归档/备份写入冻结。详见 [整改报告](STABILITY_FOLLOWUP_2026-09-18.md)，没有只拿单一模块的绿色测试代表所有分支。

## 最终证据身份

- 冻结生产输入：`4ce7e2ff38499dc64712f76e4947cf1e4e387797624e33681f25ca181d70f8b6`。
- 0.24.6 DMG：`9551951f7c32d95ea485ddec160ef79fd583b98c6a3624f9684e2e18e5576b47`。
- 0.24.6 ZIP：`d06b8d587536f13763169e4a5ba02a07569531cd5ddf3f5cbca053ff679d5d4d`。
- 可重建源码归档及独立核对：`release/baselines/0.24.6-verified/VERIFICATION.md`。
- [实际包内主程序独立验收](acceptance/README.md)：281 文件发布树前后不变、原生加密合成记录、正常退出及新进程重读通过。
- 外部模型理解语料的 4 项自检通过，仅验证结构/独立算术/答案隔离/人工计分语义，不计为模型通过率。它与主程序外部验收均晚于源码压缩包建立，不声称已包含在该压缩包内。

## 安装与后续运行不是已完成事项

本次只读核对发现：运行进程来自 `/Applications/交易驾驶舱.app/Contents/MacOS/交易驾驶舱`，对应安装包 Info.plist 的版本/构建均为 **0.24.1**。0.24.6 仍是未安装的新交付物。没有读其真实 profile、退出进程或替换应用。

建议用户确认后的下一步：先导出当前真实业务恢复包，再安排升级，核对登录/授权/会话保持；随后做少量长桥/IBKR 只读查询及一次有界 Codex 分析。连续自然交易日覆盖应在用户选定运行设备和后台偏好后另行观察，不自动开启驻留或登录启动。分段启用后旧 App 不可直接读新数据；应用回退不是数据降级。

IBKR 完整历史/EOD/独立计仓、完整资金流收益会计、跨设备灾备、跨重启草稿、大周期渐进分析与主控制器拆分仍是明确后续能力，不算本次已完成，也不在没有新需求的情况下无限扩张本目标。
