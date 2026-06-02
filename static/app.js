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
const MAX_CHAT_SESSIONS_PER_USER = 10;

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
  chatPanelVisible: false,
  activeAnalyses: {},
  modelProvider: "cursor",
  defaultModelProvider: "cursor",
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
    cache: "no-store",
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
  $("changePasswordScreen").hidden = true;
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

function showChangePasswordScreen(message = "") {
  $("loginScreen").hidden = true;
  $("appScreen").hidden = true;
  hideMainPanels();
  $("changePasswordScreen").hidden = false;
  const errorEl = $("changePasswordError");
  if (message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  } else {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
}

function showApp() {
  $("loginScreen").hidden = true;
  $("changePasswordScreen").hidden = true;
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

function userMustChangePassword(user) {
  return user?.must_change_password === true;
}

async function checkAuth() {
  try {
    const user = await api("/api/auth/me");
    state.currentUser = user;
    if (userMustChangePassword(user)) {
      showChangePasswordScreen();
      return true;
    }
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
    if (userMustChangePassword(user)) {
      showChangePasswordScreen();
      return;
    }
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

async function submitChangePassword(event) {
  event.preventDefault();
  const newPassword = $("changeNewPassword").value;
  const confirmPassword = $("changeConfirmPassword").value;
  if (!newPassword) {
    showChangePasswordScreen("请输入新密码");
    $("changeNewPassword").focus();
    return;
  }
  if (newPassword !== confirmPassword) {
    showChangePasswordScreen("两次输入的新密码不一致");
    $("changeConfirmPassword").focus();
    return;
  }
  const submitBtn = $("changePasswordSubmit");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "保存中...";
  }
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ new_password: newPassword }),
    });
    const verified = await api("/api/auth/me");
    if (userMustChangePassword(verified)) {
      showChangePasswordScreen("密码修改未生效，请重试或联系管理员");
      return;
    }
    state.currentUser = verified;
    $("changeNewPassword").value = "";
    $("changeConfirmPassword").value = "";
    try {
      await loadAll();
    } catch (loadError) {
      setAnalysisStatus(loadError.message || String(loadError));
    }
    showApp();
    renderUserLabel();
  } catch (error) {
    showChangePasswordScreen(error.message || String(error));
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "保存并进入";
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
  clearAttachments({ keepStatus: true });
  hideMainPanels();
  renderWelcomeMessage();
  renderSessionSummary();
  renderSidebarSessionList();
}

function optionList(items, labelFn) {
  return items.map((item) => `<option value="${item.id}">${escapeHtml(labelFn(item))}</option>`).join("");
}

function normalizeThirdPartyModel(model) {
  return {
    ...model,
    enabled: Boolean(model.enabled),
    is_default: Boolean(model.is_default),
    configured: Boolean(model.configured),
  };
}

function applyModelsPayload(modelsPayload) {
  state.modelsPayload = modelsPayload;
  state.models = Array.isArray(modelsPayload) ? modelsPayload : (modelsPayload?.models || []);
  const thirdParty = !Array.isArray(modelsPayload) ? (modelsPayload?.third_party || {}) : {};
  state.thirdPartyModels = (thirdParty.models || []).map(normalizeThirdPartyModel);
  state.thirdPartyEnabled = Boolean(thirdParty.enabled);
  state.thirdPartyDefaultId = thirdParty.default_model_id ?? null;
  state.thirdPartyActive = state.thirdPartyEnabled
    && state.thirdPartyModels.some((model) => model.enabled && model.configured);
  const activeProvider = !Array.isArray(modelsPayload) ? modelsPayload?.active_provider : null;
  state.defaultModelProvider = activeProvider === "third_party" && state.thirdPartyActive
    ? "third_party"
    : "cursor";
  state.modelProvider = getDefaultModelProvider();
}

function isThirdPartyAvailable() {
  return state.thirdPartyEnabled
    && state.thirdPartyModels.some((model) => model.enabled && model.configured);
}

function getDefaultModelProvider() {
  if (state.defaultModelProvider === "third_party" && isThirdPartyAvailable()) {
    return "third_party";
  }
  return "cursor";
}

function getAnalysisModelProvider() {
  return getDefaultModelProvider();
}

function renderModelSelectForProvider(provider, preferredModelId = null) {
  const modelSelect = $("analysisModel");
  if (!modelSelect) return;

  if (provider === "third_party") {
    const models = state.thirdPartyModels.filter((model) => model.enabled && model.configured);
    modelSelect.disabled = !models.length;
    modelSelect.innerHTML = models.length
      ? models.map((model) => {
        const suffix = model.is_default ? "（默认）" : "";
        return `<option value="${model.id}">${escapeHtml(model.name)}${suffix}</option>`;
      }).join("")
      : `<option value="">未配置第三方模型</option>`;
    const pick = preferredModelId && models.some((model) => model.id === preferredModelId)
      ? preferredModelId
      : (state.thirdPartyDefaultId || models[0]?.id);
    if (pick) modelSelect.value = String(pick);
    return;
  }

  const cursorModels = state.models.filter((model) => model.enabled);
  modelSelect.disabled = !cursorModels.length;
  modelSelect.innerHTML = cursorModels.length
    ? optionList(
      cursorModels,
      (model) => {
        const tags = [];
        if (model.is_default) tags.push("默认");
        if (model.recommended) tags.push("推荐");
        const suffix = tags.length ? `（${tags.join(" · ")}）` : "";
        return `${model.name}${suffix}`;
      },
    )
    : `<option value="">暂无 Cursor 模型</option>`;
  const pick = preferredModelId && cursorModels.some((model) => model.id === preferredModelId)
    ? preferredModelId
    : cursorModels.find((model) => model.is_default)?.id ?? cursorModels[0]?.id;
  if (pick) modelSelect.value = String(pick);
}

function setAnalysisModelProvider(provider, options = {}) {
  const next = provider === "third_party" && isThirdPartyAvailable()
    ? "third_party"
    : getDefaultModelProvider();
  state.modelProvider = next;
  renderModelSelectForProvider(next, options.preferredModelId ?? null);
}

function renderModelProviderUI() {
  setAnalysisModelProvider(state.modelProvider || "cursor");
}

async function loadAll() {
  const [projects, repos, modelsPayload] = await Promise.all([
    api("/api/projects?scope=user"),
    api("/api/repos?scope=user"),
    api("/api/models"),
  ]);
  state.projects = projects;
  state.repos = repos;
  applyModelsPayload(modelsPayload);
  render();
  await initChatSessionForProject();
}

async function refreshModelsForClient() {
  const modelsPayload = await api("/api/models");
  applyModelsPayload(modelsPayload);
  renderModelProviderUI();
  renderChatProjectContext();
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

function getOutputMode() {
  return state.activeChatSession?.output_mode || "non_developer";
}

function getAnalysisScope() {
  return state.activeChatSession?.analysis_scope?.trim() || "";
}

function captureSessionSettings() {
  const provider = getAnalysisModelProvider();
  const modelId = Number($("analysisModel").value) || null;
  return {
    model_provider: provider,
    model_id: provider === "cursor" ? modelId : null,
    third_party_model_id: provider === "third_party" ? modelId : null,
    output_mode: getOutputMode(),
    analysis_scope: getAnalysisScope(),
    repo_ids: getSelectedRepoIds(),
  };
}

function applySessionSettings(session) {
  if (session.project_id) {
    $("analysisProject").value = String(session.project_id);
    renderAnalysisRepos();
  }
  const provider = getDefaultModelProvider();
  state.modelProvider = provider;
  const preferredModelId = provider === "third_party"
    ? (session.third_party_model_id || state.thirdPartyDefaultId)
    : session.model_id;
  setAnalysisModelProvider(provider, { preferredModelId });
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
        <div class="message-body">选择项目和仓库后，直接输入问题即可开始分析；也可上传日志或截图辅助排查。</div>
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
  const provider = session.model_provider === "third_party" ? "第三方" : "Cursor";
  const modelSelect = $("analysisModel");
  let modelName = modelSelect?.options[modelSelect.selectedIndex]?.textContent?.trim() || "";
  if (!modelName && session.model_provider === "third_party" && session.third_party_model_id) {
    const thirdParty = state.thirdPartyModels.find((item) => item.id === Number(session.third_party_model_id));
    modelName = thirdParty?.name || "第三方模型";
  }
  if (!modelName && session.model_id) {
    const cursorModel = state.models.find((item) => item.id === session.model_id);
    modelName = cursorModel?.name || "Cursor 模型";
  }
  if (!modelName) modelName = "默认模型";
  modelName = `${provider} · ${modelName}`;

  const parts = [
    `项目：${project?.name || "未选择项目"}`,
    repoNames.length ? `仓库：${repoNames.join("、")}` : "仓库：未选择",
    `模型：${modelName}`,
  ];
  el.textContent = parts.join(" · ");
  el.title = parts.join(" · ");
}

function isSessionLimitReached() {
  return state.allChatSessions.length >= MAX_CHAT_SESSIONS_PER_USER;
}

function sessionLimitMessage() {
  return `每个用户最多保留 ${MAX_CHAT_SESSIONS_PER_USER} 个会话，请先删除旧会话后再新建。`;
}

function assertCanCreateSession() {
  if (isSessionLimitReached()) throw new Error(sessionLimitMessage());
}

function updateNewSessionButton() {
  const button = $("newChatSession");
  if (!button) return;
  const limited = isSessionLimitReached();
  button.disabled = limited;
  button.title = limited ? sessionLimitMessage() : "";
}

function openNewChatLanding() {
  assertCanCreateSession();
  if (!state.projects.length) {
    throw new Error("请先在管理后台添加项目（访问 /admin）");
  }
  state.activeChatSession = null;
  state.chatTurns = [];
  state.chatSessionId = createChatSessionId();
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

async function ensureActiveSession(options = {}) {
  if (state.activeChatSession?.id === state.chatSessionId) return;
  await createNewChatSession({ silent: true, ...options });
}

async function createNewChatSession(options = {}) {
  assertCanCreateSession();
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
    updateNewSessionButton();
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
  updateNewSessionButton();
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
  renderSessionSummary();
  renderSidebarSessionList();
}

function renderSelectors() {
  $("analysisProject").innerHTML = optionList(state.projects, (project) => project.name);
  renderModelProviderUI();
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
    const statusText = "准备分析...";
    const analysisState = state.activeAnalyses[analysisSessionId];
    if (state.chatSessionId === analysisSessionId && analysisState?.pendingBody) {
      renderMessageBody(analysisState.pendingBody, statusText);
    }
    setAnalysisStatus(statusText);
    const sessionSettings = captureSessionSettings();
    const task = await streamAnalysis({
      project_id: Number($("analysisProject").value),
      repo_ids: repoIds,
      model_provider: sessionSettings.model_provider,
      model_id: sessionSettings.model_id,
      third_party_model_id: sessionSettings.third_party_model_id,
      analysis_type: undefined,
      analysis_scope: getAnalysisScope(),
      question,
      log_text: currentAttachmentText,
      attachment_images: currentAttachmentImages,
      chat_session_id: analysisSessionId,
      output_mode: getOutputMode(),
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
    setAnalysisStatus("分析完成");
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
  await ensureActiveSession({ skipLoad: true });
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
  renderChatProjectContext();
  renderSessionSummary();
});
$("analysisRepos").addEventListener("change", () => {
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
  if (event.target?.form) return;
  submitLogin(event);
});
$("changePasswordForm")?.addEventListener("submit", (event) => submitChangePassword(event));
$("changePasswordLogout")?.addEventListener("click", () => logoutUser().catch(alertError));
$("logoutUser")?.addEventListener("click", () => logoutUser().catch(alertError));

checkAuth().catch(alertError);
