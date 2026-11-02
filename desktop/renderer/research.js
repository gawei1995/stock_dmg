(() => {
  "use strict";

  const api = window.cockpit?.research;
  const panel = document.querySelector("#review-panel-research");
  if (!panel) return;
  const elements = {
    list: document.querySelector("#research-list"), detail: document.querySelector("#research-detail"),
    notice: document.querySelector("#research-notice"), refresh: document.querySelector("#research-refresh"),
    create: document.querySelector("#research-create-form"), symbol: document.querySelector("#research-create-symbol"),
    myView: document.querySelector("#research-create-view"), search: document.querySelector("#research-search"),
    archived: document.querySelector("#research-show-archived"), count: document.querySelector("#research-tab-count"),
    statusFilter: document.querySelector("#research-status-filter"), dueOnly: document.querySelector("#research-due-only"),
  };
  const FIELD_LABELS = {
    myView: "我目前的判断", marketBelief: "市场目前相信什么", expectationGap: "预期差在哪里",
    counterEvidence: "什么证据会推翻判断", nextTrigger: "下一个验证点 / 催化", horizon: "观察周期",
    invalidation: "失效条件", stage: "叙事阶段（不等于技术温度）", nextReviewAt: "下次检查日期",
  };
  const STAGES = ["unknown", "0", "1", "2", "3", "4P", "4E", "4F", "2R", "3R"];
  const STATUS_LABELS = { active: "跟踪中", watching: "观察中", archived: "已归档" };
  const OBSERVATION_LABELS = { pending: "待确认", confirmed: "支持判断", contradicted: "反证出现", inconclusive: "尚无结论" };
  const state = {
    snapshot: { theses: [], reviewCycles: [] }, selectedId: null, loaded: false, active: false,
    requestToken: 0, loading: false, pendingOpenId: null, busy: new Set(), drafts: new Map(), auxiliaryDrafts: new Map(), proposalDrafts: new Map(),
  };

  elements.create.addEventListener("submit", createThesis);
  elements.refresh.addEventListener("click", () => refreshSnapshot());
  elements.search.addEventListener("input", renderList);
  elements.archived.addEventListener("change", renderList);
  elements.statusFilter.addEventListener("change", renderList);
  elements.dueOnly.addEventListener("change", renderList);
  window.addEventListener("cockpit:review-tab-changed", (event) => {
    state.active = event.detail?.tab === "research" && event.detail?.mode === "review";
    if (state.active && !state.loaded && !state.loading) void refreshSnapshot();
  });
  window.addEventListener("hashchange", () => {
    if (window.location.hash === "#/review/research" && !state.loaded && !state.loading) void refreshSnapshot();
  });
  window.addEventListener("cockpit:research-opened", async (event) => {
    const id = event.detail?.researchThesisId;
    if (!id) return;
    state.pendingOpenId = id;
    elements.search.value = ""; elements.statusFilter.value = "all"; elements.dueOnly.checked = false;
    elements.archived.checked = true;
    window.location.hash = "#/review/research";
    // Hash routing owns the native workspace switch; do not duplicate it.
    await refreshSnapshot({ quiet: true });
  });
  window.cockpit?.onAgentResult?.((envelope) => {
    const id = envelope?.run?.context?.researchThesisId ?? envelope?.researchThesisId;
    if (id && state.snapshot.theses.some((item) => item.id === id)) void refreshSnapshot({ quiet: true });
  });
  if (window.location.hash === "#/review/research") void refreshSnapshot();

  async function refreshSnapshot({ quiet = false } = {}) {
    const token = ++state.requestToken;
    state.loading = true;
    elements.refresh.disabled = true;
    panel.setAttribute("aria-busy", "true");
    try {
      if (typeof api?.snapshot !== "function") throw new Error("研究主线桥接尚未就绪，请使用包含本功能的应用版本。");
      const result = await api.snapshot();
      if (token !== state.requestToken) return false;
      const snapshot = normalizeSnapshot(result);
      adoptSnapshot(snapshot);
      state.loaded = true;
      if (state.pendingOpenId) {
        const target = state.snapshot.theses.find((item) => item.id === state.pendingOpenId);
        if (target) { state.selectedId = target.id; state.pendingOpenId = null; elements.archived.checked = target.status === "archived"; }
        else { notify("研究记录当前不可用，请刷新核对。", "error"); state.pendingOpenId = null; }
      }
      if (state.selectedId && !state.snapshot.theses.some((item) => item.id === state.selectedId)) state.selectedId = null;
      renderList();
      renderDetail();
      if (!quiet) notify("已读取本机研究记录；保留尚未保存的编辑，不会自动调用行情或 Agent。");
      return true;
    } catch (error) {
      if (token !== state.requestToken) return false;
      notify(`${state.loaded ? "刷新失败，仍保留上次成功记录与未保存编辑。" : "研究记录读取失败。"}${error.message}`, "error");
      return false;
    } finally {
      if (token === state.requestToken) {
        elements.refresh.disabled = false;
        state.loading = false;
        panel.setAttribute("aria-busy", "false");
      }
    }
  }

  function normalizeSnapshot(result) {
    const source = result?.snapshot ?? result;
    if (!source || !Number.isInteger(source.revision) || !Array.isArray(source.theses) || !Array.isArray(source.reviewCycles)) throw new Error("研究记录返回格式不完整，未用空列表替代。");
    return { ...source, theses: source.theses, reviewCycles: source.reviewCycles };
  }

  function adoptSnapshot(snapshot) {
    if (Number.isInteger(state.snapshot.revision) && snapshot.revision < state.snapshot.revision) return false;
    state.snapshot = snapshot;
    return true;
  }

  async function createThesis(event) {
    event.preventDefault();
    if (state.busy.has("create")) return;
    const myView = elements.myView.value.trim();
    if (!myView) { notify("先写一句你目前的判断即可。", "error"); elements.myView.focus(); return; }
    const symbol = elements.symbol.value.trim().toUpperCase();
    state.busy.add("create");
    const submit = elements.create.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const result = await api.create({ symbol: symbol || null, myView });
      const id = result?.thesis?.id;
      const snapshot = normalizeSnapshot(result);
      if (!id) throw new Error("保存响应缺少研究标识，请刷新核对后再重试。");
      state.requestToken += 1;
      adoptSnapshot(snapshot);
      state.loading = false;
      elements.refresh.disabled = false; panel.setAttribute("aria-busy", "false");
      state.loaded = true;
      state.selectedId = id;
      // Do not clear new typing that arrived while this save was pending.
      if (elements.myView.value.trim() === myView && elements.symbol.value.trim().toUpperCase() === symbol) elements.create.reset();
      renderList(); renderDetail();
      notify("判断已保存为 v1。可以直接开始研究，其余字段不必一次填满。", "success");
    } catch (error) { notify(`未完成保存：${error.message}`, "error"); }
    finally { state.busy.delete("create"); submit.disabled = false; }
  }

  function renderList() {
    const query = elements.search.value.trim().toLowerCase();
    const visible = state.snapshot.theses.filter((item) => (elements.archived.checked || item.status !== "archived")
      && (elements.statusFilter.value === "all" || item.status === elements.statusFilter.value)
      && (!elements.dueOnly.checked || reviewDue(item))
      && `${item.symbol ?? ""} ${item.name ?? ""} ${latest(item).fields?.myView ?? ""}`.toLowerCase().includes(query));
    elements.count.textContent = String(state.snapshot.theses.filter((item) => item.status !== "archived").length);
    elements.list.replaceChildren();
    if (!visible.length) elements.list.append(node("p", "research-muted", state.loaded ? "暂无匹配研究。先记录一句判断。" : "打开研究主线后读取本机记录。"));
    for (const item of visible) {
      const button = node("button", "research-list-item");
      button.type = "button";
      button.setAttribute("aria-pressed", String(item.id === state.selectedId));
      button.append(node("strong", "", item.name || item.symbol || "未命名研究"),
        node("span", "", compact(latest(item).fields?.myView, 95) || "判断待补充"),
        node("small", "", `${item.symbol || "主题研究"} · ${STATUS_LABELS[item.status] || "未知状态"} · v${latest(item).version ?? "?"}${reviewDue(item) ? " · 待检查" : ""}${state.drafts.get(item.id)?.dirty ? " · 未保存" : ""}`));
      button.addEventListener("click", () => { state.pendingOpenId = null; state.selectedId = item.id; renderList(); renderDetail(); });
      elements.list.append(button);
    }
  }

  function renderDetail() {
    const item = selected();
    if (!item) return renderEmpty();
    elements.detail.replaceChildren();
    const version = latest(item);
    const heading = node("header", "research-detail-heading");
    const identity = node("div");
    identity.append(node("span", "research-eyebrow", `${item.symbol || "主题研究"} / IMMUTABLE JUDGMENT HISTORY`),
      node("h2", "", item.name || "未命名研究"),
      node("p", "research-muted", `当前判断 v${version.version} · 保存于 ${formatTime(version.recordedAt)} · 记录修订 ${item.revision}`));
    heading.append(identity, node("span", "research-status", STATUS_LABELS[item.status] || "未知状态"));
    elements.detail.append(heading);
    const actions = node("div", "research-actions");
    actions.append(action("新对话研究并生成草案", () => prepareResearch(item), { primary: true, disabled: item.status === "archived" || state.busy.has(item.id) }));
    actions.append(action(item.status === "archived" ? "恢复跟踪" : "归档研究", () => mutate(item.id, "setStatus", { expectedRevision: item.revision, status: item.status === "archived" ? "active" : "archived" }), { disabled: state.busy.has(item.id) }));
    if (item.status !== "archived") actions.append(action(item.status === "watching" ? "转为跟踪中" : "转为观察中", () => mutate(item.id, "setStatus", { expectedRevision: item.revision, status: item.status === "watching" ? "active" : "watching" }), { disabled: state.busy.has(item.id) }));
    elements.detail.append(actions, node("p", "research-muted", "研究会创建新的持久对话并运行 Agent；外部工具是否可用以该对话核验结果为准。AI 更新只进入草案，不会覆盖判断或自动升级阶段。"));
    const draft = ensureDraft(item);
    renderJudgment(item, draft);
    renderProposals(item);
    renderEvidence(item);
    renderObservations(item);
    renderReviewLinks(item);
    renderVersions(item);
    if (state.busy.has(item.id)) for (const input of elements.detail.querySelectorAll("input,textarea,select")) input.disabled = true;
  }

  function renderEmpty() {
    const empty = node("div", "research-empty");
    empty.append(node("h2", "", "让研究有一条连续的主线"), node("p", "", "记录“我信什么”，跟踪市场预期、证据与反证，再关联交易复盘。选择左侧记录查看详情；未持仓的候选也可以研究。"));
    elements.detail.replaceChildren(empty);
  }

  function ensureDraft(item) {
    let draft = state.drafts.get(item.id);
    if (!draft || (!draft.dirty && draft.baseRevision !== item.revision)) {
      draft = { baseRevision: item.revision, fields: { ...latest(item).fields }, name: item.name, dirty: false };
      state.drafts.set(item.id, draft);
    }
    return draft;
  }

  function renderJudgment(item, draft) {
    const card = node("section", "research-card");
    card.append(node("h3", "", "我的判断 · 版本化保存"));
    const form = node("form");
    const grid = node("div", "research-form-grid");
    grid.append(inputField("研究标题", "text", draft.name, (value) => { draft.name = value; markDirty(draft); }, { maxLength: 160, wide: true }));
    for (const key of ["myView", "marketBelief", "expectationGap", "nextTrigger"]) grid.append(judgmentField(key, draft.fields[key], (value) => { draft.fields[key] = value; markDirty(draft); }));
    form.append(grid);
    const more = disclosure("反证、失效条件与检查日期（可逐步补充）");
    const secondary = node("div", "research-form-grid");
    for (const key of ["counterEvidence", "invalidation", "horizon", "stage", "nextReviewAt"]) secondary.append(judgmentField(key, draft.fields[key], (value) => { draft.fields[key] = value; markDirty(draft); }));
    more.append(secondary, node("p", "research-muted", "检查日期是待办记录，不会后台自动运行 Agent。阶段变化须由你确认；不能从一次涨跌自动推断。"));
    form.append(more);
    if (draft.baseRevision !== item.revision && draft.dirty) form.append(node("p", "research-conflict", "服务器已有新修订。你的未保存编辑仍保留；保存将按原修订校验，不会覆盖新记录。可先查看下方历史，或重新载入已保存内容。"));
    const buttons = node("div", "research-actions");
    const save = action("保存为新判断版本", null, { primary: true, disabled: item.status === "archived" || state.busy.has(item.id) });
    save.type = "submit";
    buttons.append(save, action("重新载入已保存内容", () => {
      if (draft.dirty && !window.confirm("丢弃这条研究尚未保存的判断编辑，载入最新已保存版本？")) return;
      state.drafts.delete(item.id); renderDetail(); renderList();
    }, { disabled: state.busy.has(item.id) }));
    form.append(buttons);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void mutate(item.id, "revise", { expectedRevision: draft.baseRevision, name: draft.name, ...draft.fields }, { clearDraft: draft });
    });
    card.append(form); elements.detail.append(card);
  }

  function markDirty(draft) { draft.dirty = true; renderList(); }

  function renderProposals(item) {
    const proposals = [...(item.proposals ?? [])].reverse();
    const pending = proposals.filter((proposal) => proposal.status === "pending");
    if (!proposals.length) return;
    const card = node("section", "research-card research-proposal");
    card.append(node("h3", "", `AI 更新草案 · ${pending.length} 条待确认`), node("p", "research-warning", "AI 对来源、财务与市场预期的整理仍需核验。采纳只创建新版本，不能倒填为事件前已知判断。"));
    for (const proposal of proposals) {
      const block = disclosure(`草案 · ${formatTime(proposal.recordedAt)} · ${proposal.status === "adopted" ? "已采纳" : proposal.status === "superseded" ? "已过期" : "待确认"}`, proposal.status === "pending");
      block.append(node("p", "research-muted", `基于判断 v${proposal.baseThesisVersion} / 记录修订 ${proposal.baseRevision}。当前判断 v${latest(item).version}。`));
      const questions = Array.isArray(proposal.openQuestions) ? proposal.openQuestions : [];
      if (questions.length) block.append(node("p", "research-warning", `仍待核验：${questions.join("；")}`));
      if (proposal.status !== "pending") {
        block.append(fieldCopies(proposal.fields)); card.append(block); continue;
      }
      const key = `${item.id}:${proposal.id}`;
      let draft = state.proposalDrafts.get(key);
      if (!draft) { draft = { fields: { ...proposal.fields }, selected: new Set(Object.keys(proposal.fields ?? {}).filter((field) => proposal.fields[field] != null && proposal.fields[field] !== "")), selectedEvidenceIndexes: new Set() }; state.proposalDrafts.set(key, draft); }
      const form = node("form");
      const grid = node("div", "research-form-grid");
      for (const field of Object.keys(proposal.fields ?? {}).filter((name) => FIELD_LABELS[name])) {
        const wrapper = node("div");
        const check = checkbox(`采纳：${FIELD_LABELS[field]}`, draft.selected.has(field), (checked) => checked ? draft.selected.add(field) : draft.selected.delete(field));
        wrapper.append(check.label, judgmentField(field, draft.fields[field], (value) => { draft.fields[field] = value; }));
        if (proposal.fields[field] == null || proposal.fields[field] === "") wrapper.append(node("p", "research-muted", "未建议更新；默认不采纳。如需手动补充，请编辑后勾选。"));
        grid.append(wrapper);
      }
      const confirmation = checkbox("我已核对勾选字段与来源，并确认保存为新判断版本。", false, () => {});
      const button = action("确认采纳勾选字段", null, { primary: true, disabled: item.status === "archived" || state.busy.has(item.id) }); button.type = "submit";
      form.append(grid);
      for (const [index, evidence] of (proposal.evidence ?? []).entries()) {
        form.append(evidenceRecord(evidence, "AI 建议来源 · 未独立核验"));
        form.append(checkbox("纳入证据账本（来源仍待核验）", draft.selectedEvidenceIndexes.has(index), (checked) => checked ? draft.selectedEvidenceIndexes.add(index) : draft.selectedEvidenceIndexes.delete(index)).label);
      }
      form.append(confirmation.label, button);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!confirmation.input.checked || draft.selected.size === 0) { notify("请勾选要采纳的字段，并确认已核对；未保存任何变更。", "error"); return; }
        const fields = Object.fromEntries([...draft.selected].map((field) => [field, draft.fields[field]]));
        void mutate(item.id, "acceptProposal", { expectedRevision: item.revision, proposalId: proposal.id, fields, selectedEvidenceIndexes: [...draft.selectedEvidenceIndexes].sort((a, b) => a - b), confirmed: true }, { clearProposal: key });
      });
      block.append(form); card.append(block);
    }
    elements.detail.append(card);
  }

  function renderEvidence(item) {
    const card = node("section", "research-card");
    card.append(node("h3", "", `证据与反证 · ${item.evidence?.length ?? 0}`), node("p", "research-muted", "保留发布时间、数字单位与分母。手动输入和 AI 建议不等于已核验事实；未知项留空，不将缺失当作零。"));
    for (const evidence of [...(item.evidence ?? [])].reverse()) card.append(evidenceRecord(evidence, evidence.provenance === "ai_accepted_unverified" ? "用户确认纳入 AI 来源 · 仍未独立核验" : evidence.provenance === "ai_suggested_unverified" ? "AI 建议来源 · 未独立核验" : "手动记录 · 来源未独立核验"));
    const add = disclosure("添加一条证据 / 反证");
    const draft = auxiliaryDraft(item, "evidence", { claim: "", stance: "context", kind: "fact", sourceTitle: "", url: "", publishedAt: "", value: "", unit: "", period: "", currency: "", denominator: "" });
    const form = node("form"), grid = node("div", "research-form-grid");
    grid.append(inputField("证据 / 反证内容", "textarea", draft.fields.claim, (value) => draft.fields.claim = value, { wide: true, required: true }));
    grid.append(selectField("作用", draft.fields.stance, [["context", "背景"], ["support", "支持判断"], ["counter", "反证"]], (value) => draft.fields.stance = value));
    grid.append(selectField("内容类型", draft.fields.kind, [["fact", "来源声称的事实（未核验）"], ["inference", "推断 / 解释"]], (value) => draft.fields.kind = value));
    grid.append(inputField("来源标题（可选）", "text", draft.fields.sourceTitle, (value) => draft.fields.sourceTitle = value));
    grid.append(inputField("来源链接（可选，https/http）", "url", draft.fields.url, (value) => draft.fields.url = value));
    grid.append(inputField("来源发布时间（可选）", "date", draft.fields.publishedAt, (value) => draft.fields.publishedAt = value));
    form.append(grid);
    const numeric = disclosure("数值口径（可选）：保留 0、单位、期间、币种与分母");
    const numberGrid = node("div", "research-form-grid");
    for (const [key, label] of [["value", "原始数值"], ["unit", "单位，如 % / 百万美元"], ["period", "所属期间，如 FY2026 Q2"], ["currency", "币种，如 USD"], ["denominator", "分母 / 比较口径"]]) numberGrid.append(inputField(label, key === "value" ? "number" : "text", draft.fields[key], (value) => draft.fields[key] = value));
    numeric.append(numberGrid); form.append(numeric);
    const submit = action("保存证据记录", null, { disabled: item.status === "archived" || state.busy.has(item.id) }); submit.type = "submit"; form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      try { void mutate(item.id, "addEvidence", { expectedRevision: draft.baseRevision, ...evidencePayload(draft.fields) }, { clearAuxiliary: `${item.id}:evidence` }); }
      catch (error) { notify(error.message, "error"); }
    });
    add.append(form); card.append(add); elements.detail.append(card);
  }

  function evidencePayload(fields) {
    const numericValue = fields.value === "" || fields.value == null ? null : Number(fields.value);
    if (numericValue !== null && !Number.isFinite(numericValue)) throw new Error("数值必须为有限数字；缺失请留空。未保存记录。");
    return {
      claim: fields.claim, stance: fields.stance, kind: fields.kind, sourceTitle: fields.sourceTitle || null,
      url: fields.url || null, publishedAt: dateIso(fields.publishedAt),
      numeric: numericValue === null ? null : { value: numericValue, unit: fields.unit || null, period: fields.period || null, currency: fields.currency?.trim().toUpperCase() || null, denominator: fields.denominator || null },
    };
  }

  function evidenceRecord(evidence, label) {
    const record = node("div", "research-record");
    record.append(node("strong", "", evidence.claim || "无证据说明"), node("small", "", `${label} · ${evidence.stance === "counter" ? "反证" : evidence.stance === "support" ? "支持" : "背景"} · ${evidence.kind === "inference" ? "推断" : "来源声称的事实"}`));
    if (evidence.sourceTitle) record.append(node("p", "", evidence.sourceTitle));
    const url = safeUrl(evidence.url);
    if (url) { const link = node("a", "", `查看来源：${new URL(url).hostname} ↗`); link.href = url; record.append(link); }
    record.append(node("small", "", `来源发布：${formatTime(evidence.publishedAt)} · 本机记录：${formatTime(evidence.recordedAt)}${evidence.thesisVersion ? ` · 判断 v${evidence.thesisVersion}` : ""}`));
    if (evidence.numeric && evidence.numeric.value != null) {
      const value = evidence.numeric;
      record.append(node("p", "", `原始数值 ${value.value} ${value.unit ?? ""} · 币种 ${value.currency ?? "未注明"} · 期间 ${value.period ?? "未注明"} · 分母 ${value.denominator ?? "未注明"}`));
    }
    return record;
  }

  function renderObservations(item) {
    const card = node("section", "research-card");
    card.append(node("h3", "", `验证与观察 · ${item.observations?.length ?? 0}`), node("p", "research-muted", "记录新信息是否支持判断。一次确认不代表统计验证通过，也不会自动升级 Stage。"));
    for (const observation of [...(item.observations ?? [])].reverse()) {
      const row = node("div", "research-record");
      row.append(node("strong", "", OBSERVATION_LABELS[observation.status] || "未知结果"), node("p", "", observation.note || ""), node("small", "", `${formatTime(observation.recordedAt)} · 判断 v${observation.thesisVersion ?? "?"}${observation.eventAt ? ` · 事件时间 ${formatTime(observation.eventAt)}` : ""}`));
      card.append(row);
    }
    const add = disclosure("记录一次观察");
    const draft = auxiliaryDraft(item, "observation", { status: "pending", note: "" });
    const form = node("form"), grid = node("div", "research-form-grid");
    grid.append(selectField("本次观察", draft.fields.status, Object.entries(OBSERVATION_LABELS), (value) => draft.fields.status = value), inputField("观察内容 / 感悟", "textarea", draft.fields.note, (value) => draft.fields.note = value, { wide: true, required: true }));
    const submit = action("保存观察", null, { disabled: item.status === "archived" || state.busy.has(item.id) }); submit.type = "submit"; form.append(grid, submit);
    form.addEventListener("submit", (event) => { event.preventDefault(); void mutate(item.id, "addObservation", { expectedRevision: draft.baseRevision, ...draft.fields }, { clearAuxiliary: `${item.id}:observation` }); });
    add.append(form); card.append(add); elements.detail.append(card);
  }

  function renderReviewLinks(item) {
    const card = node("section", "research-card");
    card.append(node("h3", "", "关联真实交易与复盘"), node("p", "research-muted", "只列出当前账户可访问的周期。关联锁定当时判断版本；事后建立关联不会被认作事件前已知判断。"));
    for (const link of item.reviewLinks ?? []) {
      const cycle = state.snapshot.reviewCycles.find((row) => row.id === link.cycleId);
      const row = node("div", "research-record");
      row.append(node("strong", "", cycle?.title || link.cycleTitle || "已关联周期（当前账户不可访问）"), node("small", "", `判断 v${link.thesisVersion ?? "?"} · 冻结上下文修订 ${link.contextSnapshot?.revision ?? "?"} · ${formatTime(link.linkedAt)} · 事后关联，不回填事前判断`));
      if (cycle) row.append(action("打开原复盘周期", () => window.dispatchEvent(new CustomEvent("cockpit:research-open-review", { detail: { cycleId: cycle.id } }))));
      card.append(row);
    }
    const add = disclosure("选择一个复盘周期进行关联");
    const form = node("form");
    const label = node("label", "", "当前账户复盘周期"), select = node("select");
    const blank = node("option", "", "选择周期，不自动按标的猜测"); blank.value = ""; select.append(blank);
    for (const cycle of state.snapshot.reviewCycles) { const option = node("option", "", `${cycle.title || cycle.id} · ${(cycle.symbols ?? []).join(", ") || "组合"} · ${formatDate(cycle.startAt)} — ${formatDate(cycle.endAt)}`); option.value = cycle.id; select.append(option); }
    label.append(select);
    const confirmation = checkbox("确认关联当前已保存判断版本；这不证明它是事件前判断。", false, () => {});
    const submit = action("确认关联", null, { disabled: item.status === "archived" || state.busy.has(item.id) || state.snapshot.reviewCycles.length === 0 }); submit.type = "submit";
    form.append(label, confirmation.label, submit);
    if (!state.snapshot.reviewCycles.length) form.append(node("p", "research-muted", "当前账户暂无可关联周期。可先到“复盘周期”选择真实订单建立周期，再返回刷新。"));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!select.value || !confirmation.input.checked) { notify("请选择周期并确认关联口径。", "error"); return; }
      void mutate(item.id, "linkReview", { expectedRevision: item.revision, cycleId: select.value, confirmed: true });
    });
    add.append(form); card.append(add); elements.detail.append(card);
  }

  function renderVersions(item) {
    const card = node("section", "research-card");
    card.append(node("h3", "", "判断历史 · 原版本不覆盖"), node("p", "research-muted", "这里显示实际保存时间与当时字段。事后补写和 AI 更新不能冒充事件前证据。"));
    for (const version of [...(item.versions ?? [])].reverse()) {
      const history = disclosure(`v${version.version} · ${formatTime(version.recordedAt)} · ${version.origin === "accepted_ai_proposal" ? "确认采纳 AI 草案" : "本人记录"}`);
      history.append(fieldCopies(version.fields)); card.append(history);
    }
    elements.detail.append(card);
  }

  function auxiliaryDraft(item, kind, initial) {
    const key = `${item.id}:${kind}`;
    if (!state.auxiliaryDrafts.has(key)) state.auxiliaryDrafts.set(key, { baseRevision: item.revision, fields: { ...initial } });
    // These actions append immutable records, not replacements. Re-rendering
    // shows the latest judgment before an explicit append against that revision.
    state.auxiliaryDrafts.get(key).baseRevision = item.revision;
    return state.auxiliaryDrafts.get(key);
  }

  async function mutate(id, method, payload, options = {}) {
    if (state.busy.has(id)) return false;
    state.busy.add(id);
    // Preserve typing in other records and all pending forms; only this record is locked.
    if (state.selectedId === id) renderDetail();
    try {
      if (typeof api?.[method] !== "function") throw new Error("该研究操作桥接尚未就绪。");
      const result = await api[method]({ id, ...payload });
      const snapshot = normalizeSnapshot(result);
      state.requestToken += 1;
      adoptSnapshot(snapshot); state.loaded = true; state.loading = false;
      if (options.clearDraft && state.drafts.get(id) === options.clearDraft) state.drafts.delete(id);
      if (options.clearAuxiliary) state.auxiliaryDrafts.delete(options.clearAuxiliary);
      if (options.clearProposal) state.proposalDrafts.delete(options.clearProposal);
      notify("已保存。原判断版本保留，未自动运行其他分析。", "success");
      return true;
    } catch (error) {
      notify(`未完成保存，草稿仍保留。${error.message} 如记录已更新，请先刷新核对修订；不会覆盖新版本。`, "error");
      return false;
    } finally {
      state.busy.delete(id);
      renderList(); renderDetail();
      panel.setAttribute("aria-busy", "false"); elements.refresh.disabled = false;
    }
  }

  function prepareResearch(item) {
    if (state.drafts.get(item.id)?.dirty) { notify("研究使用已保存判断；请先保存或重新载入本地编辑，再生成草案。", "error"); return; }
    window.dispatchEvent(new CustomEvent("cockpit:research-analysis-prepared", { detail: {
      researchThesisId: item.id, researchIntent: "update", name: item.name,
      task: `$analyze-market-narratives 跟进这条研究主线：${item.name}。区分我的判断与市场当前预期，核验基本面、估值/预期差、技术面和反证，标明数据日期与来源。方法不限于 EMA/Fib。保留数值单位、期间与分母，不把未知当作零。给出下一验证点及结构化更新草案；不要倒填历史判断，不自动升级阶段，不执行交易。`,
    } }));
    notify("已请求在新持久对话研究并生成草案；原判断不会自动改变。");
  }

  function judgmentField(key, value, onInput) {
    if (key === "stage") return selectField(FIELD_LABELS[key], value || "unknown", STAGES.map((stage) => [stage, stage === "unknown" ? "尚未判断" : `Stage ${stage}`]), onInput);
    if (key === "nextReviewAt") return inputField(FIELD_LABELS[key], "date", value ? String(value).slice(0, 10) : "", (date) => onInput(dateIso(date)));
    return inputField(FIELD_LABELS[key], key === "horizon" ? "text" : "textarea", value ?? "", onInput);
  }

  function inputField(labelText, type, value, onInput, options = {}) {
    const label = node("label", options.wide ? "research-wide" : "", labelText);
    const input = node(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") input.type = type;
    else input.rows = 3;
    if (type === "number") input.step = "any";
    input.value = value == null ? "" : String(value);
    input.maxLength = options.maxLength ?? 5000;
    input.required = options.required === true;
    input.addEventListener("input", () => onInput(input.value));
    label.append(input); return label;
  }

  function selectField(labelText, value, choices, onChange) {
    const label = node("label", "", labelText), select = node("select");
    for (const [key, text] of choices) { const option = node("option", "", text); option.value = key; select.append(option); }
    select.value = value;
    select.addEventListener("change", () => onChange(select.value)); label.append(select); return label;
  }

  function checkbox(text, checked, onChange) {
    const label = node("label", "research-checkbox"), input = node("input");
    input.type = "checkbox"; input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked)); label.append(input, node("span", "", text)); return { label, input };
  }

  function action(text, listener, { primary = false, disabled = false } = {}) {
    const button = node("button", `review-button ${primary ? "primary" : "secondary"}`, text);
    button.type = "button"; button.disabled = disabled;
    if (listener) button.addEventListener("click", listener); return button;
  }

  function disclosure(text, open = false) { const details = node("details", "research-disclosure"); details.open = open; details.append(node("summary", "", text)); return details; }
  function fieldCopies(fields = {}) { const list = node("dl", "research-field-copy"); for (const [key, label] of Object.entries(FIELD_LABELS)) if (fields[key] != null && fields[key] !== "") list.append(node("dt", "", label), node("dd", "", key === "nextReviewAt" ? formatDate(fields[key]) : fields[key])); return list; }
  function latest(item) { return item.versions?.at(-1) ?? { fields: {} }; }
  function selected() { return state.snapshot.theses.find((item) => item.id === state.selectedId) ?? null; }
  function reviewDue(item) { const at = latest(item).fields?.nextReviewAt; return item.status !== "archived" && at && Number.isFinite(Date.parse(at)) && Date.parse(at) <= Date.now(); }
  function node(tag, className = "", text) { const result = document.createElement(tag); if (className) result.className = className; if (text != null) result.textContent = String(text); return result; }
  function compact(value, length) { const text = String(value ?? ""); return text.length > length ? `${text.slice(0, length)}…` : text; }
  function notify(text, tone = "info") { elements.notice.textContent = text; elements.notice.dataset.tone = tone; elements.notice.hidden = false; }
  function safeUrl(value) { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; } }
  function dateIso(value) { if (!value) return null; const date = new Date(`${value}T00:00:00.000Z`); if (!Number.isFinite(date.getTime())) throw new Error("日期格式无效。"); return date.toISOString(); }
  function formatTime(value) { if (!value) return "未知 / 未提供"; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "日期不可用"; }
  function formatDate(value) { if (!value) return "未提供"; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleDateString("zh-CN") : "日期不可用"; }
})();
