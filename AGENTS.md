# Trading Cockpit development workflow

## Starting and handing off a development session

- Start at the repository root. Read `README.md` and `NEXT_STEPS.md` before choosing work; read older audits only for the selected task. `NEXT_STEPS.md` is the single active handoff and prioritized backlog, not authorization to implement every item.
- Recheck Git status, current source version and relevant evidence. Distinguish implemented source, frozen release, installed application and live-service verification; never infer the latter two from package metadata or past chat.
- A fresh development chat need not inherit previous conversation history. Preserve progress in project files, and update `NEXT_STEPS.md` with completed work, actual checks, unresolved dependencies and the next bounded action before handing off.
- `trading-agent-workspace/` is the cockpit analysis Agent's runtime project, not the development root. Do not modify it, user Skills, credentials or personal account data merely to prepare a handoff.

## Batch release policy (user confirmed 2026-09-24)

- Preserve the frozen desktop 0.24.8 baseline and all later verified artifacts, source archives and manifests. As of 2026-11-03, the latest accepted local build is 0.24.13; the main installed bundle is 0.24.11 and its 281-file tree hash matches that frozen build. Its user profile and live behavior remain separately unverified.
- On 2026-11-07 the user authorized one new build and later separately confirmed installation replacement. Version 0.24.14 passed 1352 tests and 18 release checks; its frozen inputs/artifacts are preserved separately. It is now installed with its 281-file tree hash verified; 0.24.11 is backed up. It was not automatically launched at installation. On 2026-11-24, after the user granted app control, one consolidated installed-profile P0 pass verified a new nonprivate SOXX research record, two actual restricted-model rounds, explicit draft adoption, original versions, session switching and one normal cold restart. Full and restricted guards were separately verified; full-mode model/tool execution was not tested. IBKR history-order linkage remains unsupported, its snapshot remained stale/cached and after cold restart the connection was not restored. Slow/reconnecting responses, unavailable TradingView MCP and a public Longbridge OAuth host compatibility gap remain recorded in NEXT_STEPS.md; do not repeat passed cases or rebuild merely to investigate them.
- Accumulate the current reliability fixes in source. Do not bump the version, build a new DMG/ZIP, replace the installed application or ask the user to reinstall after each individual fix.
- Maintain one bounded batch checklist with evidence, regression results and unresolved external dependencies. Do not turn known future capabilities into unrequested release requirements or promise that software has zero bugs.
- Use source tests and isolated UI/integration checks during development. Freeze the batch only after its required fixes and verification are complete; then generate one new version and run the full release gate once. Failed verification must not be presented as a release.
- Do not overwrite a previously verified 0.24.8 artifact with changed source under the same version. Installed-app replacement remains a separate user-confirmed step.

## Stable boundaries

- Keep the user's native TradingView view and one Codex App Server harness. The older website prototype is not the target of desktop fixes.
- Broker access is read-only; never submit, amend, cancel, exercise or transfer. Do not bypass the existing capability guard or silently relax user configuration.
- Preserve existing dirty-worktree changes, account data, conversation history, authorization and user-authored Skills. Use isolated synthetic data for fault injection.
- Do not edit global Codex settings or disable certificate/security checks to make a network test pass. Diagnose local GUI and terminal runtime differences before changing transport behavior.
- No Developer ID signing or Apple notarization in this batch.
- User confirmed on 2026-09-24 that the next version's Agent should follow the configured system proxy. Use only the native per-process `respect_system_proxy` switch after checking runtime support; preserve its experimental label and a visible per-app opt-out. Do not modify OS/global Codex settings, inject proxy environment variables into the whole tool tree, or silently fall back on startup failure. Saved changes apply on the next application launch, without interrupting active analysis.

## UI acceptance policy (user confirmed 2026-09-24)

- User confirmed on 2026-11-03: finish the bounded batch before consolidated automated case testing; do not repeatedly test intermediate versions. After a failure, recheck only the affected paths unless source changes justify broader regression.
- Do not repeatedly use Computer Use during intermediate implementation or review. Prefer code inspection and automated source tests.
- After the batch's fixes and automated tests are complete, perform one consolidated Computer Use acceptance pass. If it fails, fix and recheck only the failed paths.
- Do not spend tokens reopening the application or repeatedly capturing UI state merely to confirm unchanged progress.
