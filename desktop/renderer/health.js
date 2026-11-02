// Local status presentation only. This view never refreshes business data,
// evaluates indicators, changes a workspace, or writes review drafts.
(() => {
  const STATES = Object.freeze({ healthy: "正常", degraded: "需要留意", unavailable: "不可用", unknown: "未知", running: "进行中" });
  const SUPPORT = Object.freeze({ implemented: "已支持", conditional: "有条件支持", not_supported: "暂不支持", disabled: "已停用" });

  function status(value) { return Object.hasOwn(STATES, value) ? value : "unknown"; }
  function textValue(value) {
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "未取得";
    return typeof value === "string" && value.trim() ? value : "未取得";
  }
  function timeLabel(value) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "未记录";
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium", hour12: false }).format(new Date(value));
  }
  function sourceLabel(value) {
    return ({
      "EncryptedStore.health": "本机加密存储检查",
      "brokerUiSnapshot.views": "本机券商视图记录",
      "broker portfolio / freshness / dataQuality": "券商持仓观测与质量标记",
      "verified portfolio ledger + persisted coverage calendar": "已核验快照账本与保存日历",
      "persisted coverage calendar": "已保存的快照覆盖日历",
      "coverage calendar + capture runtime": "快照覆盖日历与采集状态",
      "capture policy / background preferences": "快照采集设置",
      "CodexWorkspace.status / active operations": "本机 Agent 服务与活动任务",
      "additionalContextContract / contextDiagnostics": "Agent 上下文交接检查",
      "last Agent result envelope / resultDelivery": "最近一次 Agent 结果回收记录",
      "explicit host counts / configured limits": "宿主已统计条数与配置上限",
      "portfolio snapshot ledger status": "组合快照账本状态",
      "host version / observed server handshake": "应用版本与服务握手记录",
    })[value] ?? "本机已记录状态";
  }
  function validateSnapshot(model) {
    if (model?.schemaVersion !== 1 || !Number.isFinite(Date.parse(model.generatedAt))
      || !Array.isArray(model.sections) || !model.sections.length || !Array.isArray(model.capabilities)) {
      throw new Error("HEALTH_MODEL_INVALID");
    }
    for (const section of model.sections) {
      if (!section || !Array.isArray(section.cards)) throw new Error("HEALTH_SECTION_INVALID");
    }
    return model;
  }
  function element(document, tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = textValue(content);
    return node;
  }
  function badge(document, state, label) {
    const node = element(document, "span", "system-health-badge", label ?? STATES[status(state)]);
    node.dataset.status = status(state);
    return node;
  }
  function renderSnapshot(document, target, model) {
    validateSnapshot(model);
    const content = document.createDocumentFragment();
    for (const section of model.sections) {
      const group = element(document, "section", "system-health-section");
      const heading = element(document, "div", "system-health-section-heading");
      heading.append(element(document, "h3", "", section.title), badge(document, section.state));
      group.append(heading);
      if (section.summary) group.append(element(document, "p", "system-health-section-summary", section.summary));
      const cards = element(document, "div", "system-health-cards");
      for (const card of section.cards) {
        if (!card || typeof card !== "object") continue;
        const article = element(document, "article", "system-health-card");
        const title = element(document, "div", "system-health-card-heading");
        title.append(element(document, "h4", "", card.title), badge(document, card.state));
        article.append(title, element(document, "p", "system-health-card-summary", card.summary));
        const fields = element(document, "dl");
        for (const field of Array.isArray(card.fields) ? card.fields : []) {
          if (!field || typeof field !== "object") continue;
          fields.append(element(document, "dt", "", field.label), element(document, "dd", "", field.value));
        }
        fields.append(element(document, "dt", "", "本机观测时间"), element(document, "dd", "", timeLabel(card.observedAt)));
        if (card.source) fields.append(element(document, "dt", "", "记录来源"), element(document, "dd", "", sourceLabel(card.source)));
        article.append(fields);
        if (Array.isArray(card.details) && card.details.length) {
          const details = element(document, "ul");
          for (const detail of card.details) details.append(element(document, "li", "", detail));
          article.append(details);
        }
        cards.append(article);
      }
      group.append(cards);
      content.append(group);
    }
    const capabilitySection = element(document, "section", "system-health-capabilities");
    capabilitySection.append(element(document, "h3", "", "能力范围与边界"));
    for (const group of model.capabilities) {
      if (!group || !Array.isArray(group.items)) continue;
      capabilitySection.append(element(document, "h4", "", group.label));
      for (const item of group.items) {
        if (!item || typeof item !== "object") continue;
        const row = element(document, "div", "system-health-capability");
        row.append(element(document, "strong", "", item.label),
          badge(document, item.state, SUPPORT[item.support] ?? "待确认"),
          element(document, "p", "", item.detail));
        capabilitySection.append(row);
      }
    }
    content.append(capabilitySection);
    target.replaceChildren(content);
  }

  function createController({ api, elements, document, render = renderSnapshot }) {
    let phase = "closed";
    let requestId = 0;
    let busy = false;
    let returnFocus = null;
    function controls() {
      elements.open.disabled = phase === "opening" || phase === "closing";
      elements.close.disabled = phase === "closing";
      elements.refresh.disabled = phase !== "open" || busy;
      elements.body.setAttribute("aria-busy", String(busy));
    }
    function message(value, state = "unknown") {
      elements.message.textContent = value;
      elements.message.dataset.state = state;
    }
    function clearSnapshot() {
      elements.body.replaceChildren();
      elements.asof.textContent = "本次状态尚未读取";
    }
    async function refresh() {
      if (phase !== "open" || busy) return;
      const mine = ++requestId;
      busy = true;
      clearSnapshot();
      message("正在读取本机状态；不会连接外部服务…", "loading");
      controls();
      try {
        const model = validateSnapshot(await api.snapshot());
        if (phase !== "open" || mine !== requestId) return;
        render(document, elements.body, model);
        elements.asof.textContent = `本地汇总生成于 ${timeLabel(model.generatedAt)} · 非行情时间`;
        const level = status(model.status);
        message(`本机记录：${STATES[level]}。连接、实时性与证据完整性分别列示。`, level === "unavailable" ? "error" : level);
      } catch {
        if (phase !== "open" || mine !== requestId) return;
        clearSnapshot();
        message("本次读取失败，无法确认系统状态。未保留旧的正常标记；请稍后重试。", "error");
      } finally {
        if (mine === requestId) { busy = false; controls(); }
      }
    }
    async function open() {
      if (phase !== "closed") return;
      returnFocus = document.activeElement;
      phase = "opening";
      controls();
      try {
        const result = await api.setOpen(true);
        if (result?.ok === false) throw new Error("HEALTH_VISIBILITY_FAILED");
        clearSnapshot();
        elements.dialog.showModal();
        phase = "open";
        elements.close.focus();
        controls();
        await refresh();
      } catch {
        try { await api.setOpen(false); } catch { /* Host may already be unavailable. */ }
        phase = "closed";
        elements.open.textContent = "状态暂不可用";
        elements.open.title = "无法打开本机状态，请重试。不会改变现有业务数据。";
        controls();
      }
    }
    async function close() {
      if (phase !== "open") return;
      phase = "closing";
      ++requestId;
      busy = false;
      controls();
      try {
        const result = await api.setOpen(false);
        if (result?.ok === false) throw new Error("HEALTH_VISIBILITY_FAILED");
        phase = "closed";
        elements.dialog.close();
        clearSnapshot();
        elements.open.textContent = "系统状态";
        elements.open.title = "查看本机已掌握的状态";
        controls();
        if (returnFocus?.isConnected && typeof returnFocus.focus === "function") returnFocus.focus();
        else elements.open.focus();
      } catch {
        phase = "open";
        clearSnapshot();
        message("关闭状态视图时未能确认看盘区域恢复，请再次点击关闭。现有工作区与草稿未修改。", "error");
        controls();
      }
    }
    function bind() {
      elements.open.addEventListener("click", open);
      elements.refresh.addEventListener("click", refresh);
      elements.close.addEventListener("click", close);
      elements.dialog.addEventListener("cancel", (event) => { event.preventDefault(); void close(); });
      // Cover a native/programmatic close outside these controls without
      // touching workspace state. Normal closes already restored host bounds.
      elements.dialog.addEventListener("close", () => { if (phase === "open") void close(); });
      controls();
    }
    return Object.freeze({ open, close, refresh, bind });
  }

  globalThis.CockpitHealthUI = Object.freeze({ createController, renderSnapshot, validateSnapshot, textValue, timeLabel });
  if (typeof document === "undefined") return;
  const elements = Object.fromEntries(["open", "dialog", "close", "refresh", "asof", "message", "body"].map((name) => [name, document.getElementById(`system-health-${name}`)]));
  if (Object.values(elements).some((node) => !node)) return;
  if (typeof window.cockpit?.health?.snapshot !== "function" || typeof window.cockpit?.health?.setOpen !== "function") {
    elements.open.disabled = true;
    elements.open.title = "当前宿主尚未提供系统状态视图";
    return;
  }
  createController({ api: window.cockpit.health, elements, document }).bind();
})();
