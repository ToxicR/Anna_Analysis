const QUESTION_TEMPLATES = [
  {
    id: "feature-how",
    category: "功能了解",
    label: "功能怎么实现",
    analysisType: "feature",
    prompt: "请说明【功能名称，如：首页温度显示】是怎么实现的？请说明：用户看到什么、背后经过哪些步骤、Android 和 C++ 各做什么。",
  },
  {
    id: "feature-flow",
    category: "功能了解",
    label: "业务流程",
    analysisType: "feature",
    prompt: "请梳理【业务场景，如：用户点击支付到完成订单】的完整流程，说明关键步骤、涉及页面/模块，以及可能失败的地方。",
  },
  {
    id: "feature-cross",
    category: "功能了解",
    label: "两端如何配合",
    analysisType: "feature",
    prompt: "请说明【功能或接口名称】在 Android 与 C++ 之间是如何调用和传递数据的？用步骤说明，避免贴大段代码。",
  },
  {
    id: "incident-crash",
    category: "问题排查",
    label: "崩溃/报错原因",
    analysisType: "incident",
    prompt: "请根据我上传的日志/截图，分析【问题现象，如：启动闪退、接口超时】的可能原因、影响范围，并给出可执行的排查建议。",
  },
  {
    id: "incident-log",
    category: "问题排查",
    label: "日志定位问题",
    analysisType: "incident",
    prompt: "请结合附件日志，定位【错误关键字或时间点】对应的代码位置，说明为什么会发生，以及建议先检查什么。",
  },
  {
    id: "incident-screenshot",
    category: "问题排查",
    label: "截图/UI 异常",
    analysisType: "incident",
    prompt: "请根据截图/附件，说明【界面异常现象】可能由哪些模块或配置导致，并给出验证办法。",
  },
  {
    id: "impact-change",
    category: "影响评估",
    label: "改动影响范围",
    analysisType: "impact",
    prompt: "如果修改【模块/文件/接口名称】，可能影响哪些功能、页面或调用方？请按影响大小排序说明。",
  },
  {
    id: "review-risk",
    category: "代码审查",
    label: "风险点审查",
    analysisType: "review",
    prompt: "请审查【模块或目录名称】是否存在明显风险（异常处理、线程、资源释放、兼容性），列出问题与建议，优先说业务影响。",
  },
];

const SECTION_CARD_META = {
  结论: { key: "conclusion", title: "结论", icon: "结", tone: "primary" },
  关键位置: { key: "locations", title: "关键位置", icon: "位", tone: "default" },
  关键代码: { key: "locations", title: "关键代码", icon: "码", tone: "default" },
  流程或原因说明: { key: "flow", title: "流程或原因", icon: "链", tone: "default" },
  实现链路: { key: "flow", title: "实现链路", icon: "链", tone: "default" },
  依据与不确定点: { key: "evidence", title: "依据与不确定点", icon: "据", tone: "muted" },
  依据与不确定项: { key: "evidence", title: "依据与不确定项", icon: "据", tone: "muted" },
  已排除的范围: { key: "excluded", title: "已排除的范围", icon: "排", tone: "muted" },
  还不确定什么: { key: "uncertain", title: "还不确定", icon: "？", tone: "warning" },
  不确定项: { key: "uncertain", title: "不确定项", icon: "？", tone: "warning" },
  建议下一步: { key: "next", title: "建议下一步", icon: "→", tone: "primary" },
  下一步排查: { key: "next", title: "下一步排查", icon: "→", tone: "primary" },
};

const NEW_CHAT_HEADLINE = "想让我帮你分析些什么？";

const state = {
  projects: [],
  repos: [],
  models: [],
  attachments: [],
  attachmentText: "",
  currentUser: null,
  chatTurns: [],
  chatSessionId: createChatSessionId(),
  activeChatSession: null,
  chatSessions: [],
  allChatSessions: [],
  syncedRepoKeyBySession: {},
  selectedTemplateId: null,
  selectedAnalysisType: null,
  chatPanelVisible: false,
  activeAnalyses: {},
};

const $ = (id) => document.getElementById(id);

function createChatSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, {
    ...options,
    headers: Object.keys(headers).length ? headers : undefined,
    credentials: "same-origin",
  });
  if (!response.ok) {
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      const detail = data.detail || text || response.statusText;
      if (response.status === 401) {
        showLogin(typeof detail === "string" ? detail : "请先登录");
      }
      throw new Error(detail);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(text || response.statusText);
      throw error;
    }
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  return response.json();
}

function showLogin(message = "") {
  $("appScreen").hidden = true;
  hideMainPanels();
  $("loginScreen").hidden = false;
  const errorEl = $("loginError");
  if (message && message !== "请先登录") {
    errorEl.textContent = message;
    errorEl.hidden = false;
  } else {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
}

function showApp() {
  $("loginScreen").hidden = true;
  $("appShell")?.classList.add("has-main-panel");
  if (state.chatPanelVisible) {
    $("newChatPanel").hidden = true;
    $("chatPanel").hidden = false;
    $("appShell")?.classList.add("has-active-chat");
  } else {
    $("newChatPanel").hidden = false;
    $("chatPanel").hidden = true;
    $("appShell")?.classList.remove("has-active-chat");
  }
  $("appScreen").hidden = false;
}

function showNewChatPanel(options = {}) {
  state.chatPanelVisible = false;
  if (!options.keepActiveSession) {
    state.activeChatSession = null;
    state.chatSessionId = createChatSessionId();
  }
  $("newChatPanel").hidden = false;
  $("chatPanel").hidden = true;
  $("appShell")?.classList.add("has-main-panel");
  $("appShell")?.classList.remove("has-active-chat");
  renderNewChatHeadline();
  renderQuestionTemplates();
  renderSessionSummary();
  renderSidebarSessionList();
  setAnalysisStatus("准备就绪");
}

function hideMainPanels() {
  state.chatPanelVisible = false;
  $("newChatPanel").hidden = true;
  $("chatPanel").hidden = true;
  $("appShell")?.classList.remove("has-main-panel");
  $("appShell")?.classList.remove("has-active-chat");
}

function showChatPanel() {
  state.chatPanelVisible = true;
  $("newChatPanel").hidden = true;
  $("chatPanel").hidden = false;
  $("appShell")?.classList.add("has-main-panel");
  $("appShell")?.classList.add("has-active-chat");
}

function renderNewChatHeadline() {
  const el = $("newChatHeadline");
  if (el) el.textContent = NEW_CHAT_HEADLINE;
}

function setAnalysisStatus(text) {
  if ($("analysisResult")) $("analysisResult").textContent = text;
  if ($("newAnalysisResult")) $("newAnalysisResult").textContent = text;
}

function prepareNewChatLanding() {
  if (!state.projects.length) {
    showNewChatPanel();
    setAnalysisStatus("请先在管理后台添加项目");
    return;
  }
  if (!$("analysisProject").value) {
    $("analysisProject").value = String(state.projects[0].id);
  }
  renderAnalysisRepos();
  showNewChatPanel();
}

function renderUserLabel() {
  const label = $("userAccountLabel");
  if (!label) return;
  const user = state.currentUser;
  label.textContent = user ? (user.display_name || user.account) : "";
}

async function checkAuth() {
  try {
    const user = await api("/api/auth/me");
    state.currentUser = user;
    await loadAll();
    showApp();
    renderUserLabel();
    return true;
  } catch {
    showLogin();
    return false;
  }
}

async function login(account, password) {
  const submitBtn = $("loginSubmit");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "登录中...";
  }
  try {
    const user = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account, password }),
    });
    state.currentUser = user;
    await loadAll();
    showApp();
    renderUserLabel();
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "登录";
    }
  }
}

function submitLogin(event) {
  event.preventDefault();
  const account = $("loginAccount").value.trim();
  const password = $("loginPassword").value;
  if (!account) {
    showLogin("请输入账号");
    $("loginAccount").focus();
    return;
  }
  if (!password) {
    showLogin("请输入密码");
    $("loginPassword").focus();
    return;
  }
  login(account, password).catch((error) => showLogin(error.message || String(error)));
}

async function logoutUser() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // ignore logout errors
  }
  state.currentUser = null;
  resetChatState();
  showLogin();
}

function resetChatState() {
  state.chatTurns = [];
  state.chatSessionId = createChatSessionId();
  state.activeChatSession = null;
  state.chatSessions = [];
  state.allChatSessions = [];
  state.syncedRepoKeyBySession = {};
  state.selectedTemplateId = null;
  state.selectedAnalysisType = null;
  clearAttachments({ keepStatus: true });
  hideMainPanels();
  renderWelcomeMessage();
  renderSessionSummary();
  renderSidebarSessionList();
}

function optionList(items, labelFn) {
  return items.map((item) => `<option value="${item.id}">${escapeHtml(labelFn(item))}</option>`).join("");
}

async function loadAll() {
  const [projects, repos, models] = await Promise.all([
    api("/api/projects"),
    api("/api/repos"),
    api("/api/models"),
  ]);
  state.projects = projects;
  state.repos = repos;
  state.models = models;
  render();
  await initChatSessionForProject();
}

function getCurrentProjectId() {
  return Number($("analysisProject").value) || 0;
}

function getSelectedRepoIds() {
  const checked = [...$("analysisRepos").querySelectorAll("input:checked")].map((input) => Number(input.value));
  if (checked.length) return checked;
  const projectId = getCurrentProjectId();
  return state.repos
    .filter((repo) => repo.project_id === projectId && repo.enabled)
    .map((repo) => repo.id);
}

function captureSessionSettings() {
  return {
    model_id: $("analysisModel").value ? Number($("analysisModel").value) : null,
    output_mode: $("outputMode").value,
    analysis_scope: $("analysisScope")?.value?.trim() || "",
    repo_ids: getSelectedRepoIds(),
  };
}

function applySessionSettings(session) {
  if (session.project_id) {
    $("analysisProject").value = String(session.project_id);
    renderAnalysisRepos();
  }
  if (session.model_id) $("analysisModel").value = String(session.model_id);
  if (session.output_mode) $("outputMode").value = session.output_mode;
  if ($("analysisScope")) $("analysisScope").value = session.analysis_scope || "";
  const repoIds = session.repo_ids ? session.repo_ids.split(",").map(Number).filter(Boolean) : [];
  $("analysisRepos").querySelectorAll("input").forEach((input) => {
    input.checked = repoIds.length ? repoIds.includes(Number(input.value)) : true;
  });
}

function renderWelcomeMessage() {
  $("chatMessages").innerHTML = `
    <article class="message assistant">
      <img class="avatar ai-avatar" src="/static/assets/anna-logo.png" alt="Anna AI">
      <div class="bubble">
        <div class="message-meta">Anna Analysis</div>
        <div class="message-body">选择项目和仓库后，点击下方<strong>快速提问</strong>模板，把【括号内容】改成你的实际情况即可发送。也可直接输入问题，或上传日志/截图排查问题。</div>
      </div>
    </article>
  `;
}

function renderSessionSummary() {
  if (!state.activeChatSession) {
    $("sessionSummary").textContent = "暂无会话，点击「新建会话」开始分析";
    renderChatProjectContext();
    return;
  }
  const project = state.projects.find((item) => item.id === state.activeChatSession.project_id);
  const title = state.activeChatSession.title || "新会话";
  const projectName = project?.name || "未选择项目";
  const count = state.chatTurns.length;
  $("sessionSummary").textContent = `当前会话：${title}${count ? ` · ${count} 条消息` : ""}`;
  renderChatProjectContext();
}

function renderChatProjectContext() {
  const el = $("chatProjectContext");
  if (!el) return;
  if (!state.activeChatSession) {
    el.textContent = "尚未创建会话，请先新建会话并选择项目";
    return;
  }

  const session = state.activeChatSession;
  const project = state.projects.find((item) => item.id === session.project_id);
  const repoIds = session.repo_ids ? session.repo_ids.split(",").map(Number).filter(Boolean) : getSelectedRepoIds();
  const repoNames = repoIds
    .map((repoId) => state.repos.find((repo) => repo.id === repoId)?.name)
    .filter(Boolean);
  const model = state.models.find((item) => item.id === session.model_id);
  const modelSelect = $("analysisModel");
  const modelName = model?.name
    || modelSelect?.options[modelSelect.selectedIndex]?.textContent
    || "默认模型";
  const outputMode = session.output_mode === "developer" ? "研发模式" : "非研发模式";
  const scope = session.analysis_scope?.trim();

  const parts = [
    `项目：${project?.name || "未选择项目"}`,
    repoNames.length ? `仓库：${repoNames.join("、")}` : "仓库：未选择",
    `模型：${modelName}`,
    outputMode,
  ];
  if (scope) parts.push(`范围：${scope}`);
  el.textContent = parts.join(" · ");
  el.title = parts.join(" · ");
}

function openNewChatLanding() {
  if (!state.projects.length) {
    throw new Error("请先在管理后台添加项目（访问 /admin）");
  }
  state.activeChatSession = null;
  state.chatTurns = [];
  state.chatSessionId = createChatSessionId();
  state.selectedTemplateId = null;
  state.selectedAnalysisType = null;
  $("newQuestion").value = "";
  $("question").value = "";
  clearAttachments({ keepStatus: true });
  prepareNewChatLanding();
}

async function refreshAllChatSessions() {
  state.allChatSessions = await api("/api/chat/sessions");
  state.chatSessions = state.allChatSessions.filter((session) => session.project_id === getCurrentProjectId());
}

async function refreshChatSessions() {
  await refreshAllChatSessions();
}

async function ensureActiveSession() {
  if (state.activeChatSession?.id === state.chatSessionId) return;
  await createNewChatSession({ silent: true });
}

async function createNewChatSession(options = {}) {
  const projectId = getCurrentProjectId();
  if (!projectId) throw new Error("请先选择项目");
  const repoIds = getSelectedRepoIds();
  if (!repoIds.length) throw new Error("请至少选择一个参与分析的仓库");
  const session = await api("/api/chat/sessions", {
    method: "POST",
    body: JSON.stringify({
      id: state.chatSessionId || createChatSessionId(),
      project_id: projectId,
      ...captureSessionSettings(),
    }),
  });
  state.chatSessionId = session.id;
  await refreshChatSessions();
  if (!options.skipLoad) {
    await loadChatSession(session.id, { silent: true, ...options });
  } else {
    state.activeChatSession = session;
    applySessionSettings(session);
    renderSessionSummary();
    renderSidebarSessionList();
  }
}

async function initChatSessionForProject() {
  await refreshAllChatSessions();
  state.activeChatSession = null;
  state.chatTurns = [];
  state.chatSessionId = createChatSessionId();
  clearAttachments({ keepStatus: true });
  prepareNewChatLanding();
  renderSessionSummary();
  renderSidebarSessionList();
}

async function loadChatSession(sessionId, options = {}) {
  const detail = await api(`/api/chat/sessions/${sessionId}`);
  const { session, messages } = detail;
  state.activeChatSession = session;
  state.chatSessionId = session.id;
  applySessionSettings(session);
  state.chatTurns = messages.map((message) => ({
    role: message.role,
    meta: message.meta || "",
    body: message.body || "",
  }));
  $("chatMessages").innerHTML = "";
  if (!messages.length && !isAnalysisActiveFor(sessionId)) {
    renderWelcomeMessage();
  } else {
    messages.forEach((message) => appendMessage(message.role, message.body, message.meta));
    attachActiveAnalysisToView(sessionId);
  }
  clearAttachments({ keepStatus: true });
  showChatPanel();
  renderSessionSummary();
  renderSidebarSessionList();
}

async function reloadSessionMessages(sessionId) {
  const detail = await api(`/api/chat/sessions/${sessionId}`);
  const { session, messages } = detail;
  if (state.chatSessionId !== sessionId) return;
  state.activeChatSession = session;
  state.chatTurns = messages.map((message) => ({
    role: message.role,
    meta: message.meta || "",
    body: message.body || "",
  }));
  $("chatMessages").innerHTML = "";
  if (!messages.length && !isAnalysisActiveFor(sessionId)) {
    renderWelcomeMessage();
  } else {
    messages.forEach((message) => appendMessage(message.role, message.body, message.meta));
    attachActiveAnalysisToView(sessionId);
  }
  renderSessionSummary();
  renderSidebarSessionList();
}

function isAnalysisActiveFor(sessionId) {
  return Boolean(state.activeAnalyses[sessionId]);
}

function attachActiveAnalysisToView(sessionId) {
  const analysis = state.activeAnalyses[sessionId];
  if (!analysis || state.chatSessionId !== sessionId) return;
  const text = analysis.streamedText || "分析进行中...";
  const pending = appendMessage("assistant", text, "Anna Analysis");
  analysis.pendingBody = pending.querySelector(".message-body");
  if (analysis.streamedText) {
    renderMessageBody(analysis.pendingBody, analysis.streamedText);
  }
}

function clearActiveAnalysis(sessionId) {
  delete state.activeAnalyses[sessionId];
}

async function syncSessionSettings() {
  if (!state.chatSessionId) {
    await ensureActiveSession();
  }
  const updated = await api(`/api/chat/sessions/${state.chatSessionId}`, {
    method: "PUT",
    body: JSON.stringify(captureSessionSettings()),
  });
  state.activeChatSession = updated;
  renderSessionSummary();
}

async function persistChatMessage(role, body, meta, sessionId = state.chatSessionId) {
  if (!sessionId) return;
  await api(`/api/chat/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ role, meta, body }),
  });
  if (state.activeChatSession?.id === sessionId && state.activeChatSession?.title === "新会话" && role === "user") {
    state.activeChatSession.title = String(body).replace(/\s+/g, " ").trim().slice(0, 40) || "新会话";
  }
  await refreshAllChatSessions();
  if (state.chatSessionId === sessionId) {
    const current = state.allChatSessions.find((item) => item.id === sessionId);
    if (current) state.activeChatSession = current;
    renderSessionSummary();
  }
  renderSidebarSessionList();
}

function formatSessionTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderSidebarSessionList() {
  const container = $("sidebarSessionList");
  if (!container) return;
  if (!state.allChatSessions.length) {
    container.innerHTML = `<div class="session-empty">暂无会话记录</div>`;
    return;
  }

  const projectMap = new Map(state.projects.map((project) => [project.id, project.name]));
  const grouped = new Map();
  for (const session of state.allChatSessions) {
    const projectId = session.project_id;
    if (!grouped.has(projectId)) grouped.set(projectId, []);
    grouped.get(projectId).push(session);
  }

  const projectIds = [...grouped.keys()].sort((a, b) => {
    const latestA = grouped.get(a)?.[0]?.updated_at || "";
    const latestB = grouped.get(b)?.[0]?.updated_at || "";
    return latestB.localeCompare(latestA);
  });

  container.innerHTML = projectIds.map((projectId) => {
    const projectName = projectMap.get(projectId) || `项目 #${projectId}`;
    const sessions = grouped.get(projectId) || [];
    return `
      <section class="sidebar-session-group">
        <div class="sidebar-session-project">${escapeHtml(projectName)}</div>
        ${sessions.map((session) => {
          const active = session.id === state.chatSessionId ? " active" : "";
          const title = session.title || "新会话";
          const meta = `${formatSessionTime(session.updated_at)} · ${session.message_count || 0} 条`;
          const preview = session.last_message_preview || "暂无消息";
          return `
            <div class="sidebar-session-item${active}">
              <button type="button" class="sidebar-session-main" data-session-id="${escapeHtml(session.id)}">
                <span class="sidebar-session-title">${escapeHtml(title)}</span>
                <span class="sidebar-session-meta">${escapeHtml(meta)}</span>
                <span class="sidebar-session-preview">${escapeHtml(preview)}</span>
              </button>
              <button
                type="button"
                class="sidebar-session-close"
                data-close-session="${escapeHtml(session.id)}"
                title="关闭会话"
                aria-label="关闭会话"
              >×</button>
            </div>
          `;
        }).join("")}
      </section>
    `;
  }).join("");
}

async function deleteChatSession(sessionId) {
  if (!sessionId) return;
  try {
    await api(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  await refreshAllChatSessions();
  if (state.chatSessionId === sessionId) {
    if (state.allChatSessions.length) {
      await loadChatSession(state.allChatSessions[0].id, { silent: true });
    } else {
      state.activeChatSession = null;
      state.chatTurns = [];
      state.chatSessionId = createChatSessionId();
      prepareNewChatLanding();
    }
    setAnalysisStatus("会话已关闭");
    return;
  }
  renderSidebarSessionList();
  setAnalysisStatus("会话已关闭");
}

function renderSessionList() {
  renderSidebarSessionList();
}

async function openSessionPicker() {
  await refreshAllChatSessions();
  renderSidebarSessionList();
}

function closeSessionPicker() {
  // 保留兼容旧调用，侧边栏模式下无需弹窗。
}

function render() {
  renderSelectors();
  renderQuestionTemplates();
  renderSessionSummary();
  renderSidebarSessionList();
}

function renderQuestionTemplates() {
  const groups = [...new Set(QUESTION_TEMPLATES.map((item) => item.category))];
  const html = groups.map((category) => {
    const chips = QUESTION_TEMPLATES
      .filter((item) => item.category === category)
      .map((item) => (
        `<button type="button" class="template-chip${state.selectedTemplateId === item.id ? " active" : ""}" data-template-id="${item.id}" title="${escapeHtml(item.prompt)}">${escapeHtml(item.label)}</button>`
      ))
      .join("");
    return `<div class="template-group"><span class="template-group-label">${escapeHtml(category)}</span>${chips}</div>`;
  }).join("");
  for (const id of ["questionTemplates", "newQuestionTemplates"]) {
    const container = $(id);
    if (container) container.innerHTML = html;
  }
}

function applyQuestionTemplate(templateId) {
  const template = QUESTION_TEMPLATES.find((item) => item.id === templateId);
  if (!template) return;
  state.selectedTemplateId = template.id;
  state.selectedAnalysisType = template.analysisType;
  if ($("newQuestion")) $("newQuestion").value = template.prompt;
  if ($("question")) $("question").value = template.prompt;
  ($("newQuestion") || $("question"))?.focus();
  const end = template.prompt.indexOf("】");
  const input = $("newQuestion") || $("question");
  if (end > 0 && input) {
    input.setSelectionRange(template.prompt.indexOf("【") + 1, end);
  }
  renderQuestionTemplates();
  const hint = {
    feature: "将按「功能了解」分析",
    incident: "建议上传日志或截图后发送",
    impact: "将按「影响评估」分析",
    review: "将按「代码审查」分析",
  }[template.analysisType];
  setAnalysisStatus(hint || "模板已填入，请修改【】中的内容");
}

function renderSelectors() {
  $("analysisProject").innerHTML = optionList(state.projects, (project) => project.name);
  $("analysisModel").innerHTML = optionList(
    state.models.filter((model) => model.enabled),
    (model) => {
      const tags = [];
      if (model.is_default) tags.push("默认");
      if (model.recommended) tags.push("推荐分析");
      const suffix = tags.length ? `（${tags.join(" · ")}）` : "";
      return `${model.name}${suffix}`;
    },
  );
  renderAnalysisRepos();
}

function renderAnalysisRepos() {
  const projectId = Number($("analysisProject").value);
  const repos = state.repos.filter((repo) => repo.project_id === projectId && repo.enabled);
  $("analysisRepos").innerHTML = repos.length
    ? repos.map((repo) => `<label><input type="checkbox" value="${repo.id}" checked hidden></label>`).join("")
    : "";
  renderSessionSummary();
}

function appendMessage(role, body, meta) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const bubbleHtml = `
    <div class="bubble">
      <div class="message-meta">${escapeHtml(meta)}</div>
      <div class="message-body"></div>
    </div>
  `;
  const userAvatar = `<div class="avatar user-avatar">你</div>`;
  const aiAvatar = `<img class="avatar ai-avatar" src="/static/assets/anna-logo.png" alt="Anna AI">`;
  article.innerHTML = role === "user" ? `${bubbleHtml}${userAvatar}` : `${aiAvatar}${bubbleHtml}`;
  renderMessageBody(article.querySelector(".message-body"), body);
  $("chatMessages").appendChild(article);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  return article;
}

function rememberTurn(role, body, meta) {
  state.chatTurns.push({
    role,
    meta: String(meta || ""),
    body: String(body || "").slice(0, 4000),
  });
  state.chatTurns = state.chatTurns.slice(-8);
}

function conversationContextForNextTurn() {
  return state.chatTurns
    .map((turn) => `${turn.role === "user" ? "用户" : "Agent"}（${turn.meta}）：\n${turn.body}`)
    .join("\n\n---\n\n")
    .slice(-12000);
}

function resolveSectionMeta(title) {
  const normalized = String(title || "").replace(/[（(].+[)）]/g, "").trim();
  if (SECTION_CARD_META[normalized]) return { ...SECTION_CARD_META[normalized] };
  for (const [key, meta] of Object.entries(SECTION_CARD_META)) {
    if (normalized.startsWith(key)) return { ...meta, title: meta.title || normalized };
  }
  return { key: "section", title: normalized || "详情", icon: "·", tone: "default" };
}

function parseAnalysisSections(markdown) {
  const text = normalizeMarkdownWhitespace(markdown);
  if (!/^##\s+/m.test(text)) return [];
  const blocks = text.split(/^##\s+/m);
  const lead = blocks[0]?.trim() || "";
  const cards = [];
  for (let index = 1; index < blocks.length; index += 1) {
    const chunk = blocks[index];
    const lineBreak = chunk.indexOf("\n");
    const rawTitle = (lineBreak >= 0 ? chunk.slice(0, lineBreak) : chunk).trim();
    const body = (lineBreak >= 0 ? chunk.slice(lineBreak + 1) : "").trim();
    if (!rawTitle) continue;
    const meta = resolveSectionMeta(rawTitle);
    cards.push({ ...meta, body });
  }
  if (lead && cards.length) {
    cards[0].body = cards[0].body ? `${lead}\n\n${cards[0].body}` : lead;
  }
  return cards;
}

function renderAnalysisCards(cards) {
  return `<div class="analysis-cards">${cards.map((card) => `
    <article class="analysis-card tone-${card.tone || "default"}">
      <div class="analysis-card-header">
        <span class="analysis-card-icon" aria-hidden="true">${escapeHtml(card.icon || "·")}</span>
        <span class="analysis-card-title">${escapeHtml(card.title)}</span>
      </div>
      <div class="analysis-card-body">${markdownToHtml(card.body || "暂无内容")}</div>
    </article>
  `).join("")}</div>`;
}

function renderMessageBody(element, markdown) {
  const cards = parseAnalysisSections(markdown);
  if (cards.length >= 2) {
    element.classList.add("has-analysis-cards");
    element.innerHTML = renderAnalysisCards(cards);
    return;
  }
  element.classList.remove("has-analysis-cards");
  element.innerHTML = markdownToHtml(normalizeMarkdownWhitespace(markdown));
}

function normalizeMarkdownWhitespace(markdown) {
  return String(markdown || "")
    .replace(/([^\n])\n([^\n#\-*`\d|])/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n");
}

function markdownToHtml(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let listOpen = false;
  let codeOpen = false;
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${formatInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listOpen) return;
    html.push("</ul>");
    listOpen = false;
  };
  const flushCode = () => {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
    codeOpen = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      closeList();
      if (codeOpen) {
        flushCode();
      } else {
        codeOpen = true;
        codeLines = [];
      }
      continue;
    }

    if (codeOpen) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    if (isTableStart(lines, index)) {
      flushParagraph();
      closeList();
      const parsed = collectTable(lines, index);
      html.push(renderTable(parsed.rows));
      index = parsed.nextIndex - 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 1, 4);
      html.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${formatInline(bullet[1])}</li>`);
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (numbered) {
      flushParagraph();
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${formatInline(numbered[1])}</li>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  if (codeOpen) flushCode();
  flushParagraph();
  closeList();
  return html.join("");
}

window.markdownToHtml = markdownToHtml;

function isTableStart(lines, index) {
  const current = lines[index]?.trim() || "";
  const next = lines[index + 1]?.trim() || "";
  return current.includes("|") && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(next);
}

function collectTable(lines, startIndex) {
  const rows = [];
  let index = startIndex;
  while (index < lines.length && lines[index].includes("|")) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }
  return { rows, nextIndex: index };
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderTable(rows) {
  if (rows.length < 2) return "";
  const header = rows[0];
  const body = rows.slice(2);
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>${header.map((cell) => `<th>${formatInline(cell)}</th>`).join("")}</tr></thead>
        <tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${formatInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>
  `;
}

function formatInline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

async function refreshSelectedRepos(repoIds, pending) {
  renderMessageBody(pending.querySelector(".message-body"), "正在获取所选仓库的最新代码...");
  setAnalysisStatus("正在获取最新代码...");
  const result = await api("/api/repos/sync", {
    method: "POST",
    body: JSON.stringify({ repo_ids: repoIds }),
  });
  if (result.validation?.issues?.length) {
    const warnings = result.validation.issues.filter((issue) => issue.level === "warning");
    if (warnings.length) {
      setAnalysisStatus(warnings.map((issue) => issue.message).join("；"));
    }
  }
  return result;
}

function ensureActivityPanel(messageEl) {
  const bubble = messageEl?.closest(".bubble");
  if (!bubble) return null;
  let panel = bubble.querySelector(".analysis-activity");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "analysis-activity";
    panel.hidden = true;
    bubble.insertBefore(panel, messageEl);
  }
  return panel;
}

function pushActivity(messageEl, activity) {
  const panel = ensureActivityPanel(messageEl);
  if (!panel || !activity?.message) return;
  panel.hidden = false;
  const item = document.createElement("div");
  item.className = `activity-item activity-${activity.kind || "status"}`;
  item.textContent = activity.message;
  panel.appendChild(item);
  while (panel.children.length > 6) {
    panel.removeChild(panel.firstChild);
  }
  panel.scrollTop = panel.scrollHeight;
}

async function streamAnalysis(payload, handlers) {
  const response = await fetch("/api/analyze/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(payload),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    if (response.status === 401) showLogin("登录已过期，请重新登录");
    throw new Error(text || response.statusText);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalTask = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const event = parseSseEvent(part);
      if (!event) continue;
      if (event.event === "status") handlers.onStatus?.(normalizeStatusText(event.data.message || ""));
      if (event.event === "activity") handlers.onActivity?.(event.data);
      if (event.event === "delta") handlers.onDelta?.(event.data.text || "");
      if (event.event === "result") finalTask = event.data;
      if (event.event === "error") throw new Error(event.data.detail || "分析失败");
    }
  }

  if (buffer.trim()) {
    const event = parseSseEvent(buffer);
    if (event?.event === "result") finalTask = event.data;
    if (event?.event === "error") throw new Error(event.data.detail || "分析失败");
  }
  return finalTask;
}

function normalizeStatusText(text) {
  return String(text || "").replace(/\s+/g, " ").replaceAll("Cursor Agent", "Agent").trim();
}

function parseSseEvent(raw) {
  const lines = raw.split(/\r?\n/);
  let event = "message";
  const data = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: JSON.parse(data.join("\n")) };
}

function attachmentText() {
  return state.attachmentText || state.attachments.map((file) => file.text).filter(Boolean).join("\n\n");
}

function attachmentNames() {
  return state.attachments.map((file) => file.file_name || file.name).filter(Boolean).join("、");
}

function attachmentImages() {
  return state.attachments
    .filter((file) => file.mime_type?.startsWith("image/") || file.image_url)
    .map((file) => ({ url: file.workspace_path ? pathToFileUrl(file.workspace_path) : file.image_url }))
    .filter((item) => item.url);
}

function pathToFileUrl(filePath) {
  if (!filePath) return "";
  if (filePath.startsWith("file://")) return filePath;
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

async function runAnalysis(options = {}) {
  const fromNewPanel = options.fromNewPanel ?? !state.chatPanelVisible;
  const questionInput = fromNewPanel ? $("newQuestion") : $("question");
  const repoIds = getSelectedRepoIds();
  const question = questionInput?.value.trim() || "";
  const currentAttachmentText = attachmentText();
  const currentAttachmentNames = attachmentNames();
  const currentAttachmentImages = attachmentImages();
  if (!repoIds.length) throw new Error("请至少选择一个参与分析的仓库");
  if (!question && !currentAttachmentNames) throw new Error("请输入要分析的问题，或添加附件");

  if (!state.activeChatSession) {
    await createNewChatSession({ silent: true, skipLoad: true });
    showChatPanel();
    renderWelcomeMessage();
    $("question").value = question;
  } else if (fromNewPanel) {
    showChatPanel();
    $("question").value = question;
  }

  const analysisSessionId = state.chatSessionId;
  const project = state.projects.find((item) => item.id === Number($("analysisProject").value));
  const meta = `${project?.name || "未选择项目"} · 自动判断分析方式${currentAttachmentNames ? ` · 附件：${currentAttachmentNames}` : ""}`;
  const userMessage = question || `分析附件：${currentAttachmentNames}`;
  const conversationContext = conversationContextForNextTurn();
  appendMessage("user", userMessage, meta);
  rememberTurn("user", userMessage, meta);
  await syncSessionSettings();
  await persistChatMessage("user", userMessage, meta, analysisSessionId);
  if (questionInput) questionInput.value = "";
  $("question").value = "";
  if (currentAttachmentNames) clearAttachments({ keepStatus: true });

  state.activeAnalyses[analysisSessionId] = { streamedText: "" };
  const pending = appendMessage("assistant", "准备分析...", "Anna Analysis");
  state.activeAnalyses[analysisSessionId].pendingBody = pending.querySelector(".message-body");

  const sendButtons = [$("runAnalysis"), $("newRunAnalysis")].filter(Boolean);
  sendButtons.forEach((button) => { button.disabled = true; });
  try {
    const repoKey = [...repoIds].sort((a, b) => a - b).join(",");
    const alreadySynced = state.syncedRepoKeyBySession[analysisSessionId] === repoKey;
    const statusText = alreadySynced ? "继续分析..." : "准备分析...";
    const analysisState = state.activeAnalyses[analysisSessionId];
    if (state.chatSessionId === analysisSessionId && analysisState?.pendingBody) {
      renderMessageBody(analysisState.pendingBody, statusText);
    }
    setAnalysisStatus(statusText);
    const task = await streamAnalysis({
      project_id: Number($("analysisProject").value),
      repo_ids: repoIds,
      model_id: $("analysisModel").value ? Number($("analysisModel").value) : null,
      analysis_type: state.selectedAnalysisType || undefined,
      analysis_scope: $("analysisScope")?.value?.trim() || "",
      question,
      log_text: currentAttachmentText,
      attachment_images: currentAttachmentImages,
      conversation_context: conversationContext,
      chat_session_id: analysisSessionId,
      output_mode: $("outputMode").value,
      skip_sync: alreadySynced,
    }, {
      onStatus: (message) => {
        if (message) setAnalysisStatus(message);
        const analysis = state.activeAnalyses[analysisSessionId];
        if (!analysis) return;
        if (!analysis.streamedText && message && state.chatSessionId === analysisSessionId && analysis.pendingBody) {
          renderMessageBody(analysis.pendingBody, message);
        }
      },
      onActivity: (activity) => {
        const analysis = state.activeAnalyses[analysisSessionId];
        if (state.chatSessionId === analysisSessionId && analysis?.pendingBody) {
          pushActivity(analysis.pendingBody, activity);
        }
        if (activity?.message) setAnalysisStatus(activity.message);
      },
      onDelta: (text) => {
        const analysis = state.activeAnalyses[analysisSessionId];
        if (!analysis) return;
        analysis.streamedText += text;
        if (state.chatSessionId !== analysisSessionId || !analysis.pendingBody) return;
        const body = analysis.pendingBody;
        const panel = ensureActivityPanel(body);
        if (panel) panel.hidden = true;
        renderMessageBody(body, analysis.streamedText);
      },
    });
    const analysis = state.activeAnalyses[analysisSessionId];
    const assistantText = task?.result || analysis?.streamedText || "";
    if (state.chatSessionId === analysisSessionId && analysis?.pendingBody && task?.result) {
      renderMessageBody(analysis.pendingBody, task.result);
    }
    if (state.chatSessionId === analysisSessionId) {
      rememberTurn("assistant", assistantText, "Anna Analysis");
    }
    await persistChatMessage("assistant", assistantText, "Anna Analysis", analysisSessionId);
    state.syncedRepoKeyBySession[analysisSessionId] = repoKey;
    setAnalysisStatus("分析完成");
    state.selectedTemplateId = null;
    state.selectedAnalysisType = null;
    renderQuestionTemplates();
    const viewingAnalysisSession = state.chatSessionId === analysisSessionId;
    clearActiveAnalysis(analysisSessionId);
    if (viewingAnalysisSession) {
      await reloadSessionMessages(analysisSessionId);
    } else {
      await refreshAllChatSessions();
      renderSidebarSessionList();
    }
  } catch (error) {
    const analysis = state.activeAnalyses[analysisSessionId];
    if (state.chatSessionId === analysisSessionId && analysis?.pendingBody) {
      renderMessageBody(analysis.pendingBody, `分析失败：${error.message || error}`);
    }
    setAnalysisStatus("分析失败");
    clearActiveAnalysis(analysisSessionId);
  } finally {
    sendButtons.forEach((button) => { button.disabled = false; });
  }
}

function updateAttachmentBar() {
  const name = attachmentNames();
  const visible = Boolean(name);
  for (const id of ["attachmentBar", "newAttachmentBar"]) {
    const bar = $(id);
    if (!bar) continue;
    bar.hidden = !visible;
    const label = bar.querySelector("[data-attachment-name]") || bar.querySelector("span");
    if (label) label.textContent = `已添加附件：${name}`;
  }
  $("newAddAttachment")?.classList.toggle("has-attachment", visible);
  $("addAttachment")?.classList.toggle("has-attachment", visible);
}

async function attachLogFiles(files) {
  const selectedFiles = [...files];
  if (!selectedFiles.length) return;
  const form = new FormData();
  selectedFiles.forEach((file) => form.append("files", file));
  const projectId = Number($("analysisProject").value);
  const query = new URLSearchParams({
    project_id: String(projectId || ""),
    chat_session_id: state.chatSessionId,
  });
  const result = await api(`/api/analyze/upload-log?${query}`, { method: "POST", body: form });
  state.attachments.push(...(result.files || []));
  state.attachmentText = [state.attachmentText, result.text].filter(Boolean).join("\n\n");
  updateAttachmentBar();
  setAnalysisStatus(`已添加 ${state.attachments.length} 个附件`);
}

async function uploadLog() {
  const files = $("logFile").files;
  if (files?.length) await attachLogFiles(files);
  $("logFile").value = "";
}

function clearAttachments(options = {}) {
  state.attachments = [];
  state.attachmentText = "";
  $("logFile").value = "";
  updateAttachmentBar();
  if (!options.keepStatus) {
    setAnalysisStatus("准备就绪");
  }
}

function removeAttachment() {
  clearAttachments();
}

function clearChat() {
  if (!state.chatSessionId) {
    state.chatTurns = [];
    renderWelcomeMessage();
    renderSessionSummary();
    return;
  }
  api(`/api/chat/sessions/${state.chatSessionId}/messages`, { method: "DELETE" })
    .then(() => {
      state.chatTurns = [];
      delete state.syncedRepoKeyBySession[state.chatSessionId];
      renderWelcomeMessage();
      renderSessionSummary();
      setAnalysisStatus("对话已清空");
    })
    .catch(alertError);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

$("analysisProject").addEventListener("change", () => {
  renderAnalysisRepos();
});
$("analysisModel").addEventListener("change", () => {
  if (state.activeChatSession) syncSessionSettings().catch(() => {});
  renderSessionSummary();
});
$("analysisRepos").addEventListener("change", () => {
  if (state.activeChatSession) syncSessionSettings().catch(() => {});
  renderSessionSummary();
});
$("analysisScope")?.addEventListener("change", () => {
  if (state.activeChatSession) syncSessionSettings().catch(() => {});
});
$("outputMode").addEventListener("change", () => {
  if (state.activeChatSession) syncSessionSettings().catch(() => {});
  renderSessionSummary();
});
$("newChatSession").addEventListener("click", () => {
  try {
    openNewChatLanding();
  } catch (error) {
    alertError(error);
  }
});
$("newRunAnalysis")?.addEventListener("click", () => runAnalysis({ fromNewPanel: true }).catch(alertError));
$("newAddAttachment")?.addEventListener("click", () => $("logFile").click());
$("newRemoveAttachment")?.addEventListener("click", removeAttachment);
$("newQuestion")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  if (event.altKey) return;
  event.preventDefault();
  runAnalysis({ fromNewPanel: true }).catch(alertError);
});
$("newQuestionTemplates")?.addEventListener("click", (event) => {
  const templateId = event.target?.closest?.("[data-template-id]")?.dataset?.templateId;
  if (templateId) applyQuestionTemplate(templateId);
});
["dragenter", "dragover"].forEach((eventName) => {
  $("newChatComposer")?.addEventListener(eventName, (event) => {
    event.preventDefault();
    $("newChatComposer").classList.add("drag-over");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  $("newChatComposer")?.addEventListener(eventName, (event) => {
    event.preventDefault();
    $("newChatComposer").classList.remove("drag-over");
  });
});
$("newChatComposer")?.addEventListener("drop", (event) => {
  const files = event.dataTransfer?.files;
  if (files?.length) attachLogFiles(files).catch(alertError);
});
$("sidebarSessionList").addEventListener("click", (event) => {
  const closeBtn = event.target?.closest?.("[data-close-session]");
  if (closeBtn) {
    event.preventDefault();
    event.stopPropagation();
    deleteChatSession(closeBtn.dataset.closeSession).catch(alertError);
    return;
  }
  const sessionBtn = event.target?.closest?.("[data-session-id]");
  if (sessionBtn) loadChatSession(sessionBtn.dataset.sessionId).catch(alertError);
});
$("questionTemplates")?.addEventListener("click", (event) => {
  const templateId = event.target?.closest?.("[data-template-id]")?.dataset?.templateId;
  if (templateId) applyQuestionTemplate(templateId);
});
$("newQuestion")?.addEventListener("input", () => {
  if (!state.selectedTemplateId) return;
  const prompt = QUESTION_TEMPLATES.find((item) => item.id === state.selectedTemplateId)?.prompt;
  if ($("newQuestion").value.trim() !== prompt) {
    state.selectedTemplateId = null;
    state.selectedAnalysisType = null;
    renderQuestionTemplates();
  }
});
$("question").addEventListener("input", () => {
  if (!state.selectedTemplateId) return;
  if ($("question").value.trim() !== QUESTION_TEMPLATES.find((item) => item.id === state.selectedTemplateId)?.prompt) {
    state.selectedTemplateId = null;
    state.selectedAnalysisType = null;
    renderQuestionTemplates();
  }
});
$("runAnalysis").addEventListener("click", () => runAnalysis().catch(alertError));
$("clearChat").addEventListener("click", clearChat);
$("logFile").addEventListener("change", () => uploadLog().catch(alertError));
$("addAttachment").addEventListener("click", () => $("logFile").click());
$("removeAttachment").addEventListener("click", removeAttachment);

$("question").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  if (event.altKey) return;
  event.preventDefault();
  runAnalysis().catch(alertError);
});

["dragenter", "dragover"].forEach((eventName) => {
  $("composer").addEventListener(eventName, (event) => {
    event.preventDefault();
    $("composer").classList.add("drag-over");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  $("composer").addEventListener(eventName, (event) => {
    event.preventDefault();
    $("composer").classList.remove("drag-over");
  });
});

$("composer").addEventListener("drop", (event) => {
  const files = event.dataTransfer?.files;
  if (files?.length) attachLogFiles(files).catch(alertError);
});

function alertError(error) {
  if (String(error.message || error).includes("请先登录") || String(error.message || error).includes("未登录")) {
    showLogin("登录已过期，请重新登录");
    return;
  }
  alert(error.message || error);
}

$("loginForm")?.addEventListener("submit", submitLogin);
$("loginSubmit")?.addEventListener("click", (event) => {
  event.preventDefault();
  submitLogin(event);
});
$("logoutUser")?.addEventListener("click", () => logoutUser().catch(alertError));

checkAuth().catch(alertError);
