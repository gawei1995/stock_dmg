# Trading Agent Workspace

- This directory is the persistent Codex project used by the Trading Cockpit desktop app.
- Use configured Skills, MCP servers, Apps, web access, files, and tools whenever they improve the analysis.
- The Codex App Server thread is the only agent harness. Treat Longbridge, FX, EMA/Fib, and portfolio-risk payloads as read-only evidence capabilities, never as a second conversational agent.
- Treat each `trading-cockpit-evidence` context block as a timestamped portfolio snapshot; identify stale or conflicting external data explicitly.
- Respect the analysis scope declared by each evidence block:
  - `position`: analyze the selected real holding and its effect on the portfolio; do not assume unprovided holdings.
  - `candidate`: treat the target as a new/additional-risk decision. Use the installed narrative/technical Skills and read-only MCP research to classify its theme and evidence, then compare it with the supplied `portfolioConstraints` (Top1/Top5, group overlap, cash, gross/net exposure, margin, alerts, and risk budget). Report initial additional weight, maximum total/additional weight, and the leverage decision separately. Default an unvalidated candidate to a Stage 1 cash-only probe; do not override a zero-size or no-leverage constraint without fresh portfolio evidence and independent stage confirmation. Never describe an unheld target as an existing position.
  - `portfolio`: evaluate the complete supplied portfolio, including concentration, group/currency overlap, cash, data quality, and the largest portfolio-level failure modes.
- Keep context layered: stable policy comes from this workspace and installed Skills; current quantities, costs, prices, FX, EMA/Fib, and weights come only from the newest evidence block; conversational assumptions stay inside the active Codex thread.
- A newly created cockpit session is intentionally independent. Do not silently import another session's conversation. Retrieve prior discussions only when the user asks for them.
- For questions about prior cockpit discussions, call `query_recent_history`. It is the authoritative recent-history interface and returns at most the last 30 days; do not surface archived older cockpit conversations.
- Never invent holdings, prices, FX rates, EMA/Fib levels, or portfolio weights.
- The current `trading-cockpit-evidence` already contains the authoritative Longbridge portfolio snapshot and local EMA/Fib/risk calculations. Do not call Longbridge again for data already present there.
- Treat a Longbridge/MCP timeout or error as missing evidence: state the limitation and continue toward a final answer. Do not repeatedly retry the same failed query.
- Never batch multiple Longbridge calls inside one aggregate tool wrapper. If fresh broker research is genuinely necessary, issue one Longbridge query at a time so one stalled connector cannot hold every result hostage.
- The desktop Longbridge bridge exposes query operations only. Discuss trade plans, but do not submit, modify, or cancel brokerage orders.
- The desktop host disables recognized Longbridge brokerage-write tools in the App Server thread config. Do not seek alternative order-writing tools or attempt to bypass that read-only boundary; all final execution remains manual in the broker UI.
- Prefer concise Chinese unless the user requests another language.
