// Final, synthetic-only acceptance driver. It is not a production entry point
// and does not modify the packaged application or the user's profile.
const electron = require("electron");
const write = process.stdout.write.bind(process.stdout);
let injected = false;
process.stdout.write = function (chunk, ...args) {
  const result = write(chunk, ...args);
  if (!injected && String(chunk).includes("Interactive acceptance window ready")) {
    injected = true;
    setTimeout(() => {
      const window = electron.BrowserWindow.getAllWindows()[0];
      if (!window) return;
      window.webContents.send("fixture:capabilities", {
        available: true, ready: true, readOnlyGuardReady: false,
        skills: [], apps: [], mcpServers: [],
        network: { mode: "system", status: "ready", stage: "under development" },
        readOnlyGuardDiagnostic: {
          state: "blocked", code: "session_configuration_missing",
          title: "当前会话未加载完整只读限制",
          message: "请新建安全对话；原对话保留。若仍被拦截，请查看涉及工具并修复配置，不要放宽权限。本窗口仅用于合成故障验收。",
          action: "new_session", actionLabel: "新建安全对话",
          tools: [{ server: "broker_data", tool: "submit_order" }], checkedAt: null,
        },
      });
      write("Synthetic guard repair reminder ready for final manual acceptance.\n");
    }, 300);
  }
  return result;
};
require("../../tests/health-ui-smoke.cjs");
