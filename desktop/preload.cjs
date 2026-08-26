// eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron preload is intentionally CommonJS.
const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("cockpit", {
  getInitialState: () => ipcRenderer.invoke("cockpit:get-initial-state"),
  connectLongbridge: (request) => ipcRenderer.invoke("longbridge:connect", request),
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
  workspace: {
    setMode: (mode) => ipcRenderer.invoke("workspace:set-mode", { mode }),
  },
  review: {
    snapshot: () => ipcRenderer.invoke("review:snapshot"),
    intakeSnapshot: (request) => ipcRenderer.invoke("review:intake:snapshot", request),
    lookupEventCandidates: (request) => ipcRenderer.invoke("review:intake:events", request),
    preloadRecentEventCandidates: (request) => ipcRenderer.invoke("review:intake:recent-events", request),
    createCase: (request) => ipcRenderer.invoke("review:case:create", request),
    createCaseFromRecords: (request) => ipcRenderer.invoke("review:case:create-from-records", request),
    updateCase: (request) => ipcRenderer.invoke("review:case:update", request),
    freezeCase: (request) => ipcRenderer.invoke("review:case:freeze", request),
    linkBrokerRecords: (request) => ipcRenderer.invoke("review:case:link-broker", request),
    createCycle: (request) => ipcRenderer.invoke("review:cycle:create", request),
    createOrderFirstCycle: (request) => ipcRenderer.invoke("review:cycle:create-order-first", request),
    updateCycle: (request) => ipcRenderer.invoke("review:cycle:update", request),
    saveCycleRetrospectiveNote: (request) => ipcRenderer.invoke("review:cycle:retrospective-note", request),
    sealCycle: (request) => ipcRenderer.invoke("review:cycle:seal", request),
    linkCycleRecords: (request) => ipcRenderer.invoke("review:cycle:link-broker", request),
    addCycleCheckpoint: (request) => ipcRenderer.invoke("review:cycle:checkpoint", request),
    capturePortfolioSnapshot: (request) => ipcRenderer.invoke("review:portfolio-snapshot:capture", request),
    syncTradeHistory: (request) => ipcRenderer.invoke("review:trade-history:sync", request),
    syncIntake: (request) => ipcRenderer.invoke("review:intake:sync", request),
    registerTest: (request) => ipcRenderer.invoke("review:test:register", request),
    completeTest: (request) => ipcRenderer.invoke("review:test:complete", request),
    createRule: (request) => ipcRenderer.invoke("review:rule:create", request),
    transitionRule: (request) => ipcRenderer.invoke("review:rule:transition", request),
    addRuleReview: (request) => ipcRenderer.invoke("review:rule:review", request),
    createValidationVersion: (request) => ipcRenderer.invoke("review:validation:create-version", request),
    archiveValidation: (request) => ipcRenderer.invoke("review:validation:archive", request),
    acceptLearningProposal: (request) => ipcRenderer.invoke("review:learning:accept", request),
  },
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
