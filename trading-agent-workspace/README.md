# 交易 Agent 持久工作区

交易驾驶舱会把右侧 Agent 连接到以本目录为 `cwd` 的持久 Codex 线程。

- 线程 ID 由应用加密保存，应用重启后使用 `thread/resume` 继续。
- Codex App Server 是唯一的对话与工具 harness；长桥、汇率、EMA/Fib 和组合风险是只读证据能力，不建立第二套 Agent 状态机。
- Codex 正常继承本机配置、全局和项目 Skills、MCP、Apps 与项目规则。
- 持仓、EMA、Fib、汇率和组合风险以每轮注入的最新驾驶舱证据为准。
- 最近 30 天历史通过应用登记的线程索引和 `query_recent_history` 查询；更早线程由 App Server 原生归档并从日常界面隐藏。
- Codex 的会话记录仍由本机 `CODEX_HOME` 管理；本目录负责项目归属和可版本化规则，不保存 OAuth 或券商凭证。
- 长桥连接保持只读，最终交易由用户在券商端手动确认。
