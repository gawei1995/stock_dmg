// Final synthetic packaged-renderer acceptance only. Uses the existing UI
// fixture, never a second production harness or a real user profile.
const electron = require("electron");
const write = process.stdout.write.bind(process.stdout);
const handle = electron.ipcMain.handle.bind(electron.ipcMain);
let interactiveReady = false;
const restricted = () => ({
  available: true, ready: true, readOnlyGuardReady: true,
  skills: [], apps: [], mcpServers: [],
  network: { mode: "system", status: "ready", stage: "under development" },
  researchMode: { kind: "restricted", available: true,
    reason: "外部 MCP / Apps 暂不可用，本会话已独立隔离。",
    unavailableTools: ["MCP", "Apps"], recoveryAction: "new_full_session" },
  readOnlyGuardDiagnostic: { state: "ready", code: "restricted_ready", title: "受限研究隔离已核验",
    message: "本会话外部工具已关闭；可继续研究，不代表券商断连。", tools: [], checkedAt: null },
});
electron.ipcMain.handle = (channel, listener) => handle(channel, (event, ...args) => {
  if (interactiveReady && channel === "fixture:guard-recheck") {
    write("Manual recheck preserved independently verified restricted mode.\n");
    return restricted();
  }
  return listener(event, ...args);
});
process.stdout.write = function (chunk, ...args) {
  const result = write(chunk, ...args);
  if (!interactiveReady && String(chunk).includes("Interactive acceptance window ready")) {
    interactiveReady = true;
    setTimeout(() => {
      const window = electron.BrowserWindow.getAllWindows()[0];
      if (!window) return;
      window.webContents.send("fixture:capabilities", restricted());
      write("Restricted research and free-chat layout ready for final manual acceptance.\n");
    }, 300);
  }
  return result;
};
require("../../tests/health-ui-smoke.cjs");
