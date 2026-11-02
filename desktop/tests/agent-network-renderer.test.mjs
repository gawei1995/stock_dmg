import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const renderer = await readFile(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const html = await readFile(new URL("../renderer/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../renderer/styles.css", import.meta.url), "utf8");

function implementation(name) {
  const start = renderer.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = renderer.slice(start);
  const end = tail.slice(1).search(/\n(?:async )?function \w+\(/);
  return end < 0 ? tail : tail.slice(0, end + 1);
}

function fixture({ save = async ({ mode }) => ({ mode, effectiveMode: "inherit", requiresRestart: mode !== "inherit" }), recheck = async () => ({}), legacy = false } = {}) {
  const elements = Object.fromEntries([
    "agentNetworkSettings", "agentNetworkForm", "agentNetworkMode", "agentNetworkSave", "agentNetworkSummary",
    "agentNetworkEffective", "agentNetworkRuntime", "agentNetworkFeedback", "agentAvailability",
    "agentGuardActions", "agentGuardRecheck", "agentGuardNewSession", "agentGuardFeedback",
  ].map(key => [key, { dataset: {}, hidden: true }]));
  elements.codexBadge = { classList: { toggle() {} } };
  const context = vm.createContext({
    api: legacy ? {} : { setAgentNetworkPreferences: save, recheckAgentReadOnlyGuard: recheck }, elements,
    state: { agentNetworkSaving: false, agentNetworkRuntime: null },
    updateAgentSubmitState() {}, renderAgentSessions() {}, updatePromptSuggestions() {},
  });
  vm.runInContext([
    "agentNetworkModeLabel", "agentNetworkRuntimeView", "setAgentNetworkPreferences", "renderAgentNetworkPreferences",
    "saveAgentNetworkPreferences", "setCodexStatus", "setAgentCapabilities", "recheckAgentReadOnlyGuard",
  ].map(implementation).join("\n"), context);
  context.setAgentNetworkPreferences({ mode: "inherit", effectiveMode: "inherit", requiresRestart: false });
  return context;
}

test("network settings are optional for older hosts and reflect confirmed startup mode without assuming a route", () => {
  const legacy = fixture({ legacy: true });
  assert.equal(legacy.elements.agentNetworkSettings.hidden, true);
  assert.equal(legacy.state.agentNetworkPreferences, null);
  const context = fixture();
  assert.equal(context.elements.agentNetworkSettings.hidden, false);
  assert.match(context.elements.agentNetworkEffective.textContent, /沿用启动环境/);
  assert.equal(context.elements.agentNetworkSave.disabled, true);
  context.setAgentNetworkPreferences({ mode: "unsupported", effectiveMode: "unsupported" });
  assert.equal(context.elements.agentNetworkMode.value, "");
  assert.equal(context.elements.agentNetworkSave.disabled, true);
  assert.match(context.elements.agentNetworkEffective.textContent, /未启动／模式未知/);
  context.state.agentNetworkDraft = "system";
  context.renderAgentNetworkPreferences();
  assert.equal(context.elements.agentNetworkSave.disabled, false);
});

test("guard reminders distinguish checking, specific repair actions and successful recovery", async () => {
  const context = fixture();
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: false,
    readOnlyGuardDiagnostic: { state: "checking", title: "正在检查只读隔离", message: "核验工具清单中", tools: [] } });
  assert.match(context.elements.agentAvailability.textContent, /核验工具清单中/);
  assert.equal(context.elements.agentGuardRecheck.disabled, true);
  assert.equal(context.elements.agentGuardNewSession.hidden, true);
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: false,
    readOnlyGuardDiagnostic: { state: "blocked", action: "new_session", title: "旧对话配置需更新", message: "新建安全对话，原对话保留", tools: [{ server: "codex_apps", tool: "ibkr.place_order" }] } });
  assert.match(context.elements.agentAvailability.textContent, /codex_apps\/ibkr.place_order/);
  assert.equal(context.elements.agentGuardRecheck.disabled, false);
  assert.equal(context.elements.agentGuardNewSession.hidden, false);
  assert.equal(context.state.codexAvailable, false);
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: true });
  assert.equal(context.elements.agentAvailability.hidden, true);
  assert.equal(context.elements.agentGuardActions.hidden, true);
});

test("guard recheck is single-flight, updates capabilities and does not expose raw transport errors", async () => {
  let resolve, calls = 0;
  const context = fixture({ recheck: () => { calls++; return new Promise(done => { resolve = done; }); } });
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: false });
  const pending = context.recheckAgentReadOnlyGuard();
  await context.recheckAgentReadOnlyGuard();
  assert.equal(calls, 1);
  assert.equal(context.elements.agentGuardRecheck.disabled, true);
  resolve({ available: true, ready: true, readOnlyGuardReady: true });
  await pending;
  assert.equal(context.state.codexAvailable, true);
  assert.equal(context.state.guardRepairBusy, false);
  assert.match(context.elements.agentGuardFeedback.textContent, /只读隔离已通过/);
  context.api.recheckAgentReadOnlyGuard = async () => { throw new Error("https://token:secret@private.invalid"); };
  await context.recheckAgentReadOnlyGuard();
  assert.match(context.elements.agentGuardFeedback.textContent, /检查请求未完成/);
  assert.doesNotMatch(context.elements.agentGuardFeedback.textContent, /secret|private/);
  assert.equal(context.state.guardRepairBusy, false);
});

test("repair controls retain guard and use trusted read-only host checks", async () => {
  const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../preload.cjs", import.meta.url), "utf8");
  assert.match(html, /id="agent-guard-recheck" type="button"/);
  assert.match(html, /id="agent-guard-new-session" type="button" hidden/);
  assert.match(main, /ipcMain\.handle\("agent:guard:recheck", async \(event\) => \{\s*assertTrustedSender\(event\);\s*assertTrustedRestoreIdle\(\);\s*return codexAnalysis\.recheckReadOnlyGuard\(\);/);
  assert.match(preload, /recheckAgentReadOnlyGuard: \(\) => ipcRenderer\.invoke\("agent:guard:recheck"\)/);
  assert.doesNotMatch(implementation("recheckAgentReadOnlyGuard"), /runAgent|relaunch|restart\(|dispose\(|createSession|setAgentNetworkPreferences/);
});

test("network save is explicit, single-flight and preserves the current route until restart", async () => {
  const calls = [];
  let resolveSave;
  const context = fixture({ save: request => {
    calls.push({ ...request });
    return new Promise(resolve => { resolveSave = resolve; });
  } });
  context.state.agentNetworkDraft = "system";
  context.renderAgentNetworkPreferences();
  assert.equal(calls.length, 0);
  assert.match(context.elements.agentNetworkSummary.textContent, /未保存/);
  let prevented = 0;
  const pending = context.saveAgentNetworkPreferences({ preventDefault: () => prevented++ });
  await context.saveAgentNetworkPreferences();
  assert.equal(prevented, 1);
  assert.deepEqual(calls, [{ mode: "system" }]);
  assert.equal(context.elements.agentNetworkMode.disabled, true);
  context.setCodexStatus({ available: true, ready: true, network: { mode: "inherit", status: "ready" } });
  assert.equal(context.state.agentNetworkDraft, "system", "capability pushes must not reset a pending draft");
  resolveSave({ mode: "system", effectiveMode: "inherit", requiresRestart: true });
  await pending;
  assert.equal(context.state.agentNetworkPreferences.mode, "system");
  assert.equal(context.state.agentNetworkPreferences.effectiveMode, "inherit");
  assert.equal(context.state.agentNetworkRuntime.mode, "inherit");
  assert.match(context.elements.agentNetworkFeedback.textContent, /重启应用后生效.*当前任务未中断/);
  assert.match(context.elements.agentNetworkSummary.textContent, /重启后生效/);
  assert.equal(context.elements.agentNetworkSave.disabled, true);
});

test("failed or malformed save replies retain current evidence and the editable draft without exposing private errors", async () => {
  for (const save of [
    async () => { throw new Error("proxy=https://user:secret@private.invalid"); },
    async () => ({ mode: "system" }),
    async () => ({ mode: "unexpected", effectiveMode: "inherit" }),
  ]) {
    const context = fixture({ save });
    const confirmed = context.state.agentNetworkPreferences;
    context.state.agentNetworkDraft = "system";
    await context.saveAgentNetworkPreferences();
    assert.equal(context.state.agentNetworkPreferences, confirmed);
    assert.equal(context.state.agentNetworkDraft, "system");
    assert.equal(context.elements.agentNetworkMode.disabled, false);
    assert.equal(context.elements.agentNetworkSave.disabled, false);
    assert.match(context.elements.agentNetworkFeedback.textContent, /保存未获确认/);
    assert.doesNotMatch(context.elements.agentNetworkFeedback.textContent, /private|secret|unexpected/);
    assert.match(context.elements.agentNetworkEffective.textContent, /沿用启动环境/);
  }
});

test("saving the effective mode again can cancel a pending switch without restarting the runtime", async () => {
  const context = fixture();
  context.setAgentNetworkPreferences({ mode: "system", effectiveMode: "inherit", requiresRestart: true });
  context.state.agentNetworkDraft = "inherit";
  await context.saveAgentNetworkPreferences();
  assert.equal(context.state.agentNetworkPreferences.requiresRestart, false);
  assert.equal(context.elements.agentNetworkFeedback.hidden, true);
  assert.doesNotMatch(context.elements.agentNetworkSummary.textContent, /重启/);
});

test("failed, unavailable and unknown network states are not misrepresented as perpetual startup", () => {
  for (const status of ["failed", "unavailable", "unknown"]) {
    const context = fixture();
    context.setCodexStatus({ available: true, ready: false, network: { mode: "system", status, message: "本机不支持系统代理功能" } });
    assert.equal(context.state.codexAvailable, false);
    assert.equal(context.elements.codexBadge.textContent, "CODEX NETWORK");
    assert.equal(context.elements.agentAvailability.hidden, false);
    assert.match(context.elements.agentAvailability.textContent, /本机不支持系统代理功能/);
    assert.match(context.elements.agentNetworkRuntime.textContent, /本机不支持系统代理功能/);
  }
});

test("network settings never remove a broker guard and never equate applied configuration with connectivity", () => {
  const context = fixture();
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: false, network: { mode: "system", status: "failed" } });
  assert.equal(context.elements.codexBadge.textContent, "CODEX GUARD");
  assert.match(context.elements.agentAvailability.textContent, /券商写工具只读隔离尚未通过/);
  assert.match(context.elements.agentAvailability.textContent, /网络配置需检查/);
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: false, network: { mode: "system", status: "ready" } });
  assert.equal(context.state.codexAvailable, false);
  assert.match(context.elements.agentAvailability.textContent, /券商写工具只读隔离尚未通过/);
  assert.match(context.elements.agentNetworkRuntime.textContent, /实际连通性以请求结果为准/);
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: true, network: { mode: "system", status: "ready" } });
  assert.equal(context.state.codexAvailable, true);
  assert.equal(context.elements.agentAvailability.hidden, true);
});

test("connection controls are collapsed, bounded in narrow panes and bound without automatic model or restart actions", () => {
  assert.match(html, /<details class="agent-network-settings" id="agent-network-settings" hidden>/);
  const settings = html.slice(html.indexOf('<details class="agent-network-settings"'), html.indexOf('</details>', html.indexOf('<details class="agent-network-settings"')));
  assert.doesNotMatch(settings, /\bopen\b/);
  assert.match(settings, /跟随系统代理（实验性）/);
  assert.match(settings, /不修改全局配置、模型或 MCP 授权/);
  assert.match(settings, /不向所有工具注入代理环境/);
  assert.match(settings, /不保证 PAC 或所有工具链路可用/);
  assert.match(css, /\.agent-network-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
  assert.match(css, /\.agent-network-form\s*\{[^}]*max-height:\s*min\(230px, 30vh\)[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.agent-network-settings\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(renderer, /setAgentNetworkPreferences\(initial\.agentNetwork\)/);
  assert.match(renderer, /agentNetworkForm\?\.addEventListener\("submit", saveAgentNetworkPreferences\)/);
  assert.match(renderer, /agentNetworkMode\?\.addEventListener\("change", \(\) => \{[\s\S]*?state\.agentNetworkDraft = elements\.agentNetworkMode\.value/);
  assert.doesNotMatch(implementation("saveAgentNetworkPreferences"), /runAgent|createSession|relaunch|restart\(|dispose\(|prepare\(/);
});
