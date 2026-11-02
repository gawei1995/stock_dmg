# Trading Cockpit development workflow

## Batch release policy (user confirmed 2026-09-24)

- The installed baseline is desktop 0.24.8. Preserve its frozen artifacts, source archive and verification manifest.
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

- Do not repeatedly use Computer Use during intermediate implementation or review. Prefer code inspection and automated source tests.
- After the batch's fixes and automated tests are complete, perform one consolidated Computer Use acceptance pass. If it fails, fix and recheck only the failed paths.
- Do not spend tokens reopening the application or repeatedly capturing UI state merely to confirm unchanged progress.
