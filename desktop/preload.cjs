// eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron preload is intentionally CommonJS.
const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("cockpit", {
  getInitialState: () => ipcRenderer.invoke("cockpit:get-initial-state"),
  connectLongbridge: () => ipcRenderer.invoke("longbridge:connect"),
  refreshPortfolio: () => ipcRenderer.invoke("longbridge:refresh"),
  forgetLongbridge: () => ipcRenderer.invoke("longbridge:forget"),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  getAgentCapabilities: () => ipcRenderer.invoke("agent:capabilities"),
  getAgentHistory: (request) => ipcRenderer.invoke("agent:history:list", request),
  agentSessions: {
    list: () => ipcRenderer.invoke("agent:sessions:list"),
    create: (request) => ipcRenderer.invoke("agent:sessions:create", request),
    switch: (threadId) => ipcRenderer.invoke("agent:sessions:switch", { threadId }),
    open: (threadId) => ipcRenderer.invoke("agent:sessions:open", { threadId }),
  },
  runAgent: (request) => ipcRenderer.invoke("agent:run", request),
  recoverAgentResult: (request) => ipcRenderer.invoke("agent:result:recover", request),
  cancelAgent: (request) => ipcRenderer.invoke("agent:cancel", request),
  savePlan: (run) => ipcRenderer.invoke("agent:save-plan", run),
  tv: {
    setBounds: (bounds) => ipcRenderer.send("tv:set-bounds", bounds),
    loadSymbol: (tvSymbol) => ipcRenderer.invoke("tv:load-symbol", tvSymbol),
    reload: () => ipcRenderer.invoke("tv:reload"),
    home: () => ipcRenderer.invoke("tv:home"),
  },
  onStatus: (callback) => listen("cockpit:status", callback),
  onPortfolio: (callback) => listen("cockpit:portfolio", callback),
  onAgentCapabilities: (callback) => listen("cockpit:agent-capabilities", callback),
  onAgentStream: (callback) => listen("cockpit:agent-stream", callback),
  onAgentResult: (callback) => listen("cockpit:agent-result", callback),
  onTvState: (callback) => listen("cockpit:tv-state", callback),
  onRequestTvBounds: (callback) => listen("cockpit:request-tv-bounds", callback),
});
