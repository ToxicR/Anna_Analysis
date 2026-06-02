const state = {
  projects: [],
  repos: [],
  models: [],
  tasks: [],
  users: [],
  loginRecords: [],
  feishuSettings: {},
  feishuUsers: [],
  feishuChats: [],
  feishuDirectoryUsers: [],
  feishuDirectoryAllUsers: [],
  feishuDirectoryPageToken: "",
  feishuDirectoryHasMore: false,
  feishuDirectoryLoading: false,
  feishuDirectorySelection: null,
  feishuRecentContacts: [],
  feishuDirectoryMeta: null,
  taskUserFilter: "",
  taskSourceFilter: "",
  settings: {},
  thirdPartyModel: null,
  thirdPartyEditingId: null,
  /** 管理页「模型选择」未保存前的临时选项，null 表示与服务器一致 */
  analysisProviderDraft: null,
  modelsPayload: null,
  editingProjectId: null,
  editingUserId: null,
  enablingWebLoginUserId: null,
  activePage: "projects",
  pendingConfirmAction: null,
  confirmDefaultMessage: "",
  syncingProjectIds: new Set(),
  syncAllLoading: false,
  projectSyncStatus: "",
};

const ADMIN_PAGES = {
  projects: {
    title: "项目与仓库",
    desc: "创建项目并绑定 Android / C++ 仓库",
  },
  integrations: {
    title: "集成配置",
    desc: "配置 GitLab 等外部服务凭据",
  },
  feishu: {
    title: "飞书集成",
    desc: "配置飞书机器人、创建用户与群项目绑定",
  },
  models: {
    title: "AI 模型",
    desc: "管理 Cursor 分析模型与默认选项",
  },
  accounts: {
    title: "用户管理",
    desc: "管理用户权限与 Web 登录方式",
  },
  "login-records": {
    title: "登录记录",
    desc: "查看前端用户登录成功与失败的审计记录",
  },
  history: {
    title: "分析历史",
    desc: "按前端登录用户查看和管理分析任务记录",
  },
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
      throw new Error(data.detail || text || response.statusText);
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
  $("adminScreen").hidden = true;
  $("loginScreen").hidden = false;
  const errorEl = $("loginError");
  if (message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  } else {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
}

function showAdmin() {
  $("loginScreen").hidden = true;
  $("adminScreen").hidden = false;
  bindAnalysisProviderSwitch();
  switchAdminPage(readAdminPageFromHash());
}

function resolveClickElement(event) {
  const target = event?.target;
  if (target instanceof Element) return target;
  if (target?.parentElement instanceof Element) return target.parentElement;
  return null;
}

function bindAnalysisProviderSwitch() {
  const root = $("analysisProviderSwitch");
  if (!root) return;
  root.querySelectorAll("[data-analysis-provider]").forEach((btn) => {
    if (btn.dataset.providerBound === "1") return;
    btn.dataset.providerBound = "1";
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const provider = btn.getAttribute("data-analysis-provider") || btn.dataset.provider;
      if (!provider) return;
      void applyAnalysisProviderChoice(provider).catch((error) => {
        showAdminToast(error?.message || String(error), true);
      });
    });
  });
}

function readAdminPageFromHash() {
  const page = location.hash.replace(/^#/, "");
  return ADMIN_PAGES[page] ? page : "projects";
}

function switchAdminPage(page) {
  if (!ADMIN_PAGES[page]) page = "projects";
  state.activePage = page;
  document.querySelectorAll(".admin-page-panel").forEach((panel) => {
    panel.hidden = panel.dataset.page !== page;
  });
  document.querySelectorAll(".admin-nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.adminPage === page);
  });
  $("adminPageTitle").textContent = ADMIN_PAGES[page].title;
  $("adminPageDesc").textContent = ADMIN_PAGES[page].desc;
  $("adminScreen")?.scrollTo?.({ top: 0, behavior: "smooth" });
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (location.hash !== `#${page}`) {
    history.replaceState(null, "", `#${page}`);
  }
  if (page === "history") {
    syncTaskUserFilterFromDom();
    refreshTasksData().catch(alertError);
  }
  if (page === "login-records") {
    refreshLoginRecordsData().catch(alertError);
  }
  if (page === "feishu") {
    refreshFeishuData().catch(alertError);
  }
}

async function checkAuth() {
  try {
    await api("/api/admin/me");
    showAdmin();
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
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ account, password }),
    });
    showAdmin();
    await loadAll();
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

async function logout() {
  try {
    await api("/api/admin/logout", { method: "POST" });
  } catch {
    // ignore
  }
  showLogin();
}

async function loadAll() {
  const [projects, repos, modelsPayload, thirdPartyModel, tasks, settings, users] = await Promise.all([
    api("/api/projects"),
    api("/api/repos"),
    api("/api/models"),
    api("/api/admin/third-party-models"),
    api("/api/tasks"),
    api("/api/settings/gitlab-token"),
    api("/api/admin/users"),
  ]);
  state.projects = projects;
  state.repos = repos;
  state.modelsPayload = modelsPayload;
  state.models = Array.isArray(modelsPayload) ? modelsPayload : (modelsPayload?.models || []);
  state.thirdPartyModel = thirdPartyModel;
  state.analysisProviderDraft = null;
  state.tasks = tasks;
  state.settings = settings;
  state.users = users;
  render();
  if (state.activePage === "login-records") {
    await refreshLoginRecordsData();
  }
  if (state.activePage === "feishu") {
    await refreshFeishuData();
  }
}

async function refreshUsersData() {
  state.users = await api("/api/admin/users");
  renderUsers();
  renderTaskUserFilter();
}

async function refreshFeishuData() {
  const [settings, users, chats, recent] = await Promise.all([
    api("/api/admin/feishu/settings"),
    api("/api/admin/feishu/users"),
    api("/api/admin/feishu/chats"),
    api("/api/admin/feishu/directory/recent").catch(() => ({ users: [], meta: null })),
  ]);
  state.feishuSettings = settings;
  state.feishuUsers = users;
  state.feishuChats = chats;
  state.feishuRecentContacts = Array.isArray(recent.users) ? recent.users : [];
  state.feishuDirectoryMeta = recent.meta || null;
  renderFeishu();
  await loadFeishuDirectoryAll(false);
}

async function saveFeishuSettings() {
  const payload = { app_id: $("feishuAppId").value.trim() };
  const appSecret = $("feishuAppSecret").value.trim();
  const verificationToken = $("feishuVerificationToken").value.trim();
  const encryptKey = $("feishuEncryptKey").value.trim();
  if (appSecret) payload.app_secret = appSecret;
  if (verificationToken) payload.verification_token = verificationToken;
  if (encryptKey) payload.encrypt_key = encryptKey;
  state.feishuSettings = await api("/api/admin/feishu/settings", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  $("feishuAppSecret").value = "";
  $("feishuVerificationToken").value = "";
  $("feishuEncryptKey").value = "";
  renderFeishuSettings();
}

function feishuSecretPlaceholder(masked, emptyHint) {
  return masked ? `已配置 (${masked})，留空则不修改` : emptyHint;
}

async function refreshFeishuUserBindings() {
  const [users, recent] = await Promise.all([
    api("/api/admin/feishu/users"),
    api("/api/admin/feishu/directory/recent").catch(() => ({ users: [], meta: null })),
  ]);
  state.feishuUsers = users;
  state.feishuRecentContacts = Array.isArray(recent.users) ? recent.users : [];
  renderFeishuUsers();
  renderFeishuRecentContacts();
}

async function saveFeishuUserBinding() {
  const openId = $("feishuUserOpenId").value.trim();
  if (!openId) throw new Error("请从飞书通讯录选择联系人");
  const displayName = $("feishuUserDisplayName").value.trim()
    || feishuRealName(state.feishuDirectorySelection)
    || "";
  await api("/api/admin/feishu/users", {
    method: "POST",
    body: JSON.stringify({
      open_id: openId,
      union_id: $("feishuUserUnionId").value.trim(),
      display_name: displayName,
      enabled: true,
    }),
  });
  clearFeishuUserForm();
  await refreshFeishuUserBindings();
  await refreshUsersData();
}

function clearFeishuUserForm() {
  state.feishuDirectorySelection = null;
  if ($("feishuUserOpenId")) $("feishuUserOpenId").value = "";
  if ($("feishuUserUnionId")) $("feishuUserUnionId").value = "";
  if ($("feishuUserDisplayName")) $("feishuUserDisplayName").value = "";
  renderFeishuDirectoryResults();
  renderFeishuRecentContacts();
  renderFeishuBindPreview();
}

async function loadFeishuDirectoryAll(forceRefresh = false) {
  state.feishuDirectoryLoading = true;
  state.feishuDirectoryAllUsers = [];
  state.feishuDirectoryUsers = [];
  renderFeishuDirectoryResults();
  try {
    let pageToken = "";
    const all = [];
    let meta = state.feishuDirectoryMeta;
    do {
      const params = new URLSearchParams({ page_size: "100" });
      if (pageToken) params.set("page_token", pageToken);
      if (forceRefresh && !pageToken) params.set("refresh", "1");
      const data = await api(`/api/admin/feishu/directory/users?${params}`);
      all.push(...(Array.isArray(data.users) ? data.users : []));
      pageToken = data.has_more ? (data.page_token || "") : "";
      meta = data.meta || meta;
    } while (pageToken);
    state.feishuDirectoryAllUsers = all;
    state.feishuDirectoryMeta = meta;
    applyFeishuDirectoryFilter();
  } finally {
    state.feishuDirectoryLoading = false;
    renderFeishuDirectoryResults();
  }
}

function applyFeishuDirectoryFilter() {
  const filter = ($("feishuDirectorySearch")?.value.trim() ?? "").toLowerCase();
  if (!filter) {
    state.feishuDirectoryUsers = [...state.feishuDirectoryAllUsers];
  } else {
    state.feishuDirectoryUsers = state.feishuDirectoryAllUsers.filter((user) =>
      user.name.toLowerCase().includes(filter)
      || user.open_id.toLowerCase().includes(filter)
      || String(user.user_id || "").toLowerCase().includes(filter),
    );
  }
  renderFeishuDirectoryResults();
}

function feishuRealName(user) {
  const name = (user?.name || "").trim();
  if (!name || name === user?.user_id || name === user?.open_id) return "";
  return name;
}

function feishuDisplayName(user) {
  return feishuRealName(user) || user?.name || user?.user_id || user?.open_id || "";
}

function feishuNameInitial(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  return trimmed.slice(0, 1);
}

function updateFeishuDirectoryCount(shown, total, filter) {
  const count = $("feishuDirectoryCount");
  if (!count) return;
  if (state.feishuDirectoryLoading) {
    count.textContent = "…";
    return;
  }
  if (!total) {
    count.textContent = "0 人";
    return;
  }
  count.textContent = filter ? `${shown}/${total} 人` : `${total} 人`;
}

function renderFeishuBindPreview() {
  const preview = $("feishuBindPreview");
  if (!preview) return;
  const user = state.feishuDirectorySelection;
  if (!user) {
    preview.className = "feishu-bind-preview is-empty";
    preview.textContent = "请从左侧选择飞书联系人";
    return;
  }
  const name = feishuDisplayName(user);
  preview.className = "feishu-bind-preview";
  preview.innerHTML = `
    <span class="feishu-bind-preview-avatar">${escapeHtml(feishuNameInitial(name))}</span>
    <span class="feishu-bind-preview-body">
      <span class="feishu-bind-preview-name">${escapeHtml(name)}</span>
      ${user.user_id ? `<span class="feishu-bind-preview-meta">user_id · ${escapeHtml(user.user_id)}</span>` : ""}
    </span>
  `;
}

function renderFeishuDirectoryItem(user, selectedId, attrName, attrValue) {
  const selected = selectedId === user.open_id ? " is-selected" : "";
  const name = feishuDisplayName(user);
  const subline = user.user_id ? user.user_id : "";
  return `
    <button type="button" class="feishu-directory-item${selected}" ${attrName}="${escapeHtml(attrValue)}">
      <span class="feishu-directory-avatar">${escapeHtml(feishuNameInitial(name))}</span>
      <span class="feishu-directory-body">
        <span class="feishu-directory-title">${escapeHtml(name)}</span>
        ${subline ? `<span class="feishu-directory-sub">${escapeHtml(subline)}</span>` : ""}
      </span>
    </button>
  `;
}

function findFeishuDirectoryUser(openId) {
  return state.feishuDirectoryAllUsers.find((item) => item.open_id === openId)
    || state.feishuDirectoryUsers.find((item) => item.open_id === openId)
    || state.feishuRecentContacts.find((item) => item.open_id === openId);
}

function selectFeishuDirectoryUser(openId) {
  const user = findFeishuDirectoryUser(openId);
  if (!user) return;
  state.feishuDirectorySelection = user;
  $("feishuUserOpenId").value = user.open_id;
  $("feishuUserUnionId").value = user.union_id || "";
  $("feishuUserDisplayName").value = feishuRealName(user) || user.name || "";
  renderFeishuDirectoryResults();
  renderFeishuRecentContacts();
  renderFeishuBindPreview();
}

function renderFeishuRecentContacts() {
  const list = $("feishuRecentContacts");
  if (!list) return;
  const contacts = state.feishuRecentContacts;
  if (!contacts.length) {
    list.innerHTML = `<p class="integration-hint">暂无记录。请让对方在飞书中给 Anna 机器人发任意消息（如 /帮助）。</p>`;
    return;
  }
  const selectedId = state.feishuDirectorySelection?.open_id || "";
  list.innerHTML = contacts.map((user) =>
    renderFeishuDirectoryItem(user, selectedId, "data-feishu-recent-open-id", user.open_id),
  ).join("");
}

function renderFeishuDirectoryResults() {
  const list = $("feishuDirectoryResults");
  const hint = $("feishuDirectoryHint");
  if (!list) return;

  const filter = $("feishuDirectorySearch")?.value.trim() ?? "";
  const total = state.feishuDirectoryAllUsers.length;
  const shown = state.feishuDirectoryUsers.length;

  if (state.feishuDirectoryLoading) {
    list.innerHTML = `<div class="feishu-directory-empty">正在从飞书加载通讯录…</div>`;
    if (hint) hint.textContent = "首次加载可能需要几秒钟";
    updateFeishuDirectoryCount(0, 0, filter);
    return;
  }

  if (!total) {
    list.innerHTML = `<div class="feishu-directory-empty">未加载到联系人，请检查飞书配置与通讯录权限范围</div>`;
    if (hint) hint.textContent = state.feishuDirectoryMeta?.hint || "点击「重新加载」重试";
    updateFeishuDirectoryCount(0, 0, filter);
    return;
  }

  if (!shown) {
    list.innerHTML = `<div class="feishu-directory-empty">筛选无结果，请换个关键词或清空筛选框</div>`;
    if (hint) hint.textContent = `共 ${total} 位联系人，输入中文姓名可快速定位`;
    updateFeishuDirectoryCount(0, total, filter);
    return;
  }

  const selectedId = state.feishuDirectorySelection?.open_id || "";
  list.innerHTML = state.feishuDirectoryUsers.map((user) =>
    renderFeishuDirectoryItem(user, selectedId, "data-feishu-directory-open-id", user.open_id),
  ).join("");

  updateFeishuDirectoryCount(shown, total, filter);
  if (hint) {
    hint.textContent = selectedId
      ? `已选择 ${feishuDisplayName(state.feishuDirectorySelection)}，请选择系统用户后保存`
      : "点击左侧联系人，右侧将显示绑定信息";
  }
}

async function saveFeishuChatBinding() {
  const chatId = $("feishuChatId").value.trim();
  if (!chatId) throw new Error("请填写 chat_id");
  let name = $("feishuChatName").value.trim();
  if (!name) {
    try {
      const info = await api(`/api/admin/feishu/chats/${encodeURIComponent(chatId)}/info`);
      name = info.name || "";
      if (info.chat_type) $("feishuChatType").value = info.chat_type;
      if (name) $("feishuChatName").value = name;
    } catch {
      // 保存时拉取失败仍允许手动保存。
    }
  }
  await api("/api/admin/feishu/chats", {
    method: "POST",
    body: JSON.stringify({
      chat_id: chatId,
      chat_type: $("feishuChatType").value,
      name,
      allow_shared_mode: $("feishuChatAllowShared").checked,
      enabled: true,
      project_ids: selectedFeishuChatProjectIds(),
    }),
  });
  $("feishuChatId").value = "";
  $("feishuChatName").value = "";
  setFeishuChatLookupHint("");
  if ($("feishuChatProjectFilter")) $("feishuChatProjectFilter").value = "";
  document.querySelectorAll("#feishuChatProjectList input[type=checkbox]").forEach((input) => {
    input.checked = false;
  });
  applyFeishuChatProjectFilter();
  await refreshFeishuData();
}

function setFeishuChatLookupHint(message = "") {
  const hint = $("feishuChatLookupHint");
  if (!hint) return;
  hint.textContent = message || "输入 chat_id 后点「获取群信息」，或失焦时自动拉取飞书群名称。需机器人已在该群内，并开通「获取群组信息」(im:chat:readonly)。";
}

async function lookupFeishuChatInfo(options = {}) {
  const chatId = $("feishuChatId")?.value.trim() ?? "";
  if (!chatId) {
    if (!options.silent) throw new Error("请先填写 chat_id");
    return;
  }
  const nameInput = $("feishuChatName");
  const previousName = nameInput?.value.trim() ?? "";
  setFeishuChatLookupHint("正在从飞书获取群信息…");
  try {
    const info = await api(`/api/admin/feishu/chats/${encodeURIComponent(chatId)}/info`);
    if (info.chat_type) $("feishuChatType").value = info.chat_type;
    if (info.name && (!previousName || options.overwrite)) {
      nameInput.value = info.name;
    }
    const typeLabel = info.chat_type === "p2p" ? "私聊" : "群聊";
    const nameLabel = info.name || "（飞书未返回名称，可手动填写）";
    setFeishuChatLookupHint(`已获取：${typeLabel} · ${nameLabel}`);
  } catch (error) {
    setFeishuChatLookupHint(`获取失败：${error.message}`);
    if (!options.silent) throw error;
  }
}

let feishuChatLookupTimer = null;
function scheduleFeishuChatLookup() {
  clearTimeout(feishuChatLookupTimer);
  feishuChatLookupTimer = setTimeout(() => {
    lookupFeishuChatInfo({ silent: true, overwrite: false }).catch(() => {});
  }, 500);
}

async function deleteFeishuUserBinding(openId) {
  await api(`/api/admin/feishu/users/${encodeURIComponent(openId)}`, { method: "DELETE" });
  await refreshFeishuData();
}

async function deleteFeishuChatBinding(chatId) {
  await api(`/api/admin/feishu/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" });
  await refreshFeishuData();
}

function selectedFeishuChatProjectIds() {
  return [...document.querySelectorAll("#feishuChatProjectList input[type=checkbox][data-feishu-project-id]:checked")]
    .map((input) => Number(input.dataset.feishuProjectId))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function updateFeishuChatProjectCount() {
  const count = $("feishuChatProjectCount");
  const list = $("feishuChatProjectList");
  if (!count || !list) return;
  const visible = [...list.querySelectorAll("[data-feishu-project-item]:not(.is-hidden)")];
  const selected = selectedFeishuChatProjectIds();
  const visibleSelected = visible.filter((item) =>
    item.querySelector("input[type=checkbox]")?.checked,
  ).length;
  if (!state.projects.length) {
    count.textContent = "0 项";
    return;
  }
  const filter = $("feishuChatProjectFilter")?.value.trim();
  count.textContent = filter
    ? `${visibleSelected}/${visible.length} 项`
    : `${selected.length}/${state.projects.length} 项`;
}

function applyFeishuChatProjectFilter() {
  const filter = ($("feishuChatProjectFilter")?.value.trim() ?? "").toLowerCase();
  const list = $("feishuChatProjectList");
  if (!list) return;
  list.querySelectorAll("[data-feishu-project-item]").forEach((item) => {
    const label = item.dataset.projectLabel?.toLowerCase() ?? "";
    item.classList.toggle("is-hidden", Boolean(filter) && !label.includes(filter));
  });
  updateFeishuChatProjectCount();
}

function renderFeishuSettings() {
  const settings = state.feishuSettings || {};
  $("feishuAppId").value = settings.app_id || "";
  $("feishuWebhookUrl").textContent = settings.webhook_path || "/api/feishu/webhook";
  $("feishuAppSecret").placeholder = feishuSecretPlaceholder(
    settings.app_secret,
    "留空则不修改",
  );
  $("feishuVerificationToken").placeholder = feishuSecretPlaceholder(
    settings.verification_token,
    "事件订阅校验 Token，留空则不修改",
  );
  $("feishuEncryptKey").placeholder = feishuSecretPlaceholder(
    settings.encrypt_key,
    "启用加密时填写，留空则不修改",
  );
  const status = $("feishuSettingsStatus");
  if (status) {
    const parts = [];
    if (settings.configured) parts.push("App ID / App Secret 已配置");
    else parts.push("请填写 App ID 与 App Secret");
    if (settings.verification_token) parts.push("Verification Token 已配置");
    else parts.push("Verification Token 未配置");
    if (settings.encrypt_key) parts.push("Encrypt Key 已配置");
    status.textContent = `${parts.join("；")}。请在飞书开放平台将事件订阅指向上述 URL，并开通「创建与更新卡片」(cardkit:card:write) 以支持分析结果流式输出。`;
  }
}

function renderFeishuUsers() {
  const list = $("feishuUserList");
  if (!list) return;
  if (!state.feishuUsers.length) {
    list.innerHTML = `<div class="item"><small>暂无飞书用户，请从上方通讯录创建。</small></div>`;
    return;
  }
  list.innerHTML = state.feishuUsers.map((item) => `
    <div class="item">
      <strong>${escapeHtml(item.display_name || item.open_id)}</strong>
      <small>open_id：${escapeHtml(item.open_id)} · 用户 #${item.app_user_id} · ${escapeHtml(item.app_user_display_name || "")} · ${item.enabled ? "启用" : "禁用"}</small>
      <div class="actions">
        <button data-delete-feishu-user="${escapeHtml(item.open_id)}" class="danger">删除绑定</button>
      </div>
    </div>
  `).join("");
}

function userLoginMethodsLabel(user) {
  const methods = [];
  if (user.feishu_open_id) methods.push("飞书");
  if (user.web_login_enabled) methods.push("Web");
  return methods.length ? methods.join(" + ") : "无登录方式";
}

function suggestWebLoginAccount(user) {
  const directoryUser = user.feishu_open_id
    ? findFeishuDirectoryUser(user.feishu_open_id)
    : null;
  const mobile = String(directoryUser?.mobile || "").trim();
  if (/^1\d{10}$/.test(mobile)) return mobile;
  const employeeId = String(directoryUser?.user_id || "").trim();
  if (employeeId && !employeeId.startsWith("ou_")) return employeeId;
  const name = (user.display_name || "").trim();
  if (name && !name.startsWith("飞书用户")) return name.replace(/\s+/g, "");
  return user.feishu_open_id ? `u${user.id}` : "";
}

function webLoginSuggestionHint(source, mobileAvailable) {
  if (source === "mobile") return "已使用飞书手机号作为登录账号。";
  if (!mobileAvailable) {
    return "未能读取飞书手机号（需开通「获取用户手机号」权限，且用户手机号设为可见）。已改用其他建议账号。";
  }
  return "请确认登录账号，初始密码为 123456。";
}

function renderFeishuChatProjectList() {
  const list = $("feishuChatProjectList");
  if (!list) return;
  if (!state.projects.length) {
    list.innerHTML = `<div class="feishu-directory-empty">暂无项目，请先在「项目与仓库」中创建。</div>`;
    updateFeishuChatProjectCount();
    return;
  }
  list.innerHTML = state.projects.map((project) => {
    const label = `${project.name} (#${project.id})`;
    return `
      <label class="checkbox-row" data-feishu-project-item data-project-label="${escapeHtml(label)}">
        <input type="checkbox" data-feishu-project-id="${project.id}">
        <span>${escapeHtml(project.name)} <small>(#${project.id})</small></span>
      </label>
    `;
  }).join("");
  applyFeishuChatProjectFilter();
}

function renderFeishuChats() {
  const list = $("feishuChatList");
  if (!list) return;
  if (!state.feishuChats.length) {
    list.innerHTML = `<div class="item"><small>暂无飞书群绑定。</small></div>`;
    return;
  }
  list.innerHTML = state.feishuChats.map((chat) => {
    const projectTags = (chat.project_ids || []).map((id) => {
      const name = state.projects.find((project) => project.id === id)?.name || `#${id}`;
      return `<span class="feishu-chat-bound-tag">${escapeHtml(name)}</span>`;
    }).join("") || `<span class="feishu-chat-bound-tag">未绑定项目</span>`;
    return `
      <div class="item feishu-chat-bound-item">
        <strong>${escapeHtml(chat.name || chat.chat_id)}</strong>
        <div class="feishu-chat-bound-meta">${escapeHtml(chat.chat_id)} · ${escapeHtml(chat.chat_type)} · ${chat.allow_shared_mode ? "允许协作" : "禁止协作"}</div>
        <div class="feishu-chat-bound-tags">${projectTags}</div>
        <div class="actions">
          <button data-delete-feishu-chat="${escapeHtml(chat.chat_id)}" class="danger">删除</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderFeishu() {
  renderFeishuSettings();
  renderFeishuChatProjectList();
  renderFeishuUsers();
  renderFeishuChats();
  renderFeishuDirectoryResults();
  renderFeishuRecentContacts();
  renderFeishuBindPreview();
}

async function refreshLoginRecordsData() {
  const list = $("loginRecordList");
  if (list) {
    list.innerHTML = `<div class="item"><small>加载中...</small></div>`;
  }
  state.loginRecords = await api("/api/admin/login-records");
  renderLoginRecords();
}

async function refreshProjectsData() {
  const [projects, repos] = await Promise.all([
    api("/api/projects"),
    api("/api/repos"),
  ]);
  state.projects = projects;
  state.repos = repos;
  renderProjects();
}

function buildTaskQuery() {
  const params = new URLSearchParams();
  if (state.taskUserFilter) params.set("user_id", state.taskUserFilter);
  if (state.taskSourceFilter) params.set("source", state.taskSourceFilter);
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function refreshTasksData() {
  const query = buildTaskQuery();
  const list = $("taskList");
  if (list) {
    list.innerHTML = `<div class="item"><small>加载中...</small></div>`;
  }
  state.tasks = await api(`/api/tasks${query}`);
  renderTasks();
}

function syncTaskUserFilterFromDom() {
  const select = $("taskUserFilter");
  if (!select) return;
  state.taskUserFilter = select.value;
}

function handleTaskUserFilterChange(event) {
  state.taskUserFilter = event.target.value;
  refreshTasksData().catch(alertError);
}

function handleTaskSourceFilterChange(event) {
  state.taskSourceFilter = event.target.value;
  refreshTasksData().catch(alertError);
}

function taskSourceLabel(source) {
  return source === "feishu" ? "飞书" : "Web";
}

function renderTaskUserFilter() {
  const select = $("taskUserFilter");
  if (!select) return;
  const current = state.taskUserFilter || select.value || "";
  select.innerHTML = [
    `<option value="">全部用户</option>`,
    ...state.users.map((user) => {
      const label = escapeHtml(user.display_name || user.account);
      const account = user.account !== user.display_name ? ` (${escapeHtml(user.account)})` : "";
      return `<option value="${user.id}">${label}${account}</option>`;
    }),
  ].join("");
  select.value = current;
  state.taskUserFilter = current;
}

function render() {
  renderProjects();
  renderModels();
  renderSettings();
  renderUsers();
  if (state.activePage === "login-records") {
    renderLoginRecords();
  }
  renderTaskUserFilter();
  renderTasks();
}

function renderUsers() {
  const list = $("userList");
  if (!list) return;
  if (!state.users.length) {
    list.innerHTML = `<div class="item"><small>暂无用户，请先在「飞书集成」中创建。</small></div>`;
    return;
  }
  list.innerHTML = state.users.map((user) => `
    <div class="item">
      <strong>${escapeHtml(user.display_name || user.account || `用户 #${user.id}`)}</strong>
      <small>${escapeHtml(userLoginMethodsLabel(user))}${user.web_login_enabled && user.account ? ` · ${escapeHtml(user.account)}` : ""} · ${user.enabled ? "已启用" : "已禁用"}${user.must_change_password ? " · 待改密" : ""} · ${escapeHtml(userProjectAccessLabel(user))} · ${escapeHtml(user.created_at || "")}</small>
      <div class="actions">
        ${user.web_login_enabled ? "" : `<button data-enable-web-login="${user.id}">开通 Web 登录</button>`}
        <button data-edit-user="${user.id}">编辑</button>
        <button data-delete-user="${user.id}" class="danger">删除</button>
      </div>
    </div>
  `).join("");
}

function userProjectAccessLabel(user) {
  if (user.project_access_all) return "全部项目";
  const ids = new Set((user.allowed_project_ids || []).map((id) => Number(id)));
  const names = state.projects.filter((project) => ids.has(project.id)).map((project) => project.name);
  return names.length ? `指定项目：${names.join("、")}` : "无可访问项目";
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function setProjectSyncStatus(message = "") {
  state.projectSyncStatus = message;
  const el = $("projectSyncStatus");
  if (el) {
    el.textContent = message || "项目创建后会自动在后台同步代码，也可手动同步。";
  }
}

function openEditUserModal(userId) {
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;
  state.editingUserId = userId;
  $("editUserTitle").textContent = `编辑用户：${user.display_name || user.account || `#${user.id}`}`;
  $("editUserSubtitle").textContent = "修改显示名称、状态、项目权限或重置密码";
  const hasWeb = Boolean(user.web_login_enabled);
  $("editUserAccountLabel").hidden = !hasWeb;
  $("editUserAccount").hidden = !hasWeb;
  $("editUserWebHint").hidden = hasWeb;
  $("editUserPasswordBlock").hidden = !hasWeb;
  $("editUserAccount").value = hasWeb ? user.account : "";
  $("editUserDisplayName").value = user.display_name || "";
  $("editUserEnabled").checked = Boolean(user.enabled);
  $("editUserPassword").value = "";
  $("editUserProjectAccessAll").checked = Boolean(user.project_access_all);
  renderEditUserProjectAccessList(user);
  $("editUserBackdrop").hidden = false;
  $("editUserDisplayName").focus();
}

async function openEnableWebLoginModal(userId) {
  const user = state.users.find((item) => item.id === userId);
  if (!user || user.web_login_enabled) return;
  state.enablingWebLoginUserId = userId;
  $("enableWebLoginTitle").textContent = `开通 Web 登录：${user.display_name || `用户 #${user.id}`}`;
  $("enableWebLoginSubtitle").textContent = "正在读取飞书账号建议…";
  $("enableWebLoginAccount").value = suggestWebLoginAccount(user);
  $("enableWebLoginBackdrop").hidden = false;
  try {
    const suggestion = await api(`/api/admin/users/${userId}/web-login-suggestion`);
    $("enableWebLoginAccount").value = suggestion.account || suggestWebLoginAccount(user);
    $("enableWebLoginSubtitle").textContent = webLoginSuggestionHint(suggestion.source, suggestion.mobile_available);
  } catch (error) {
    $("enableWebLoginSubtitle").textContent = `读取飞书信息失败：${error.message}。已使用本地建议账号，初始密码为 123456。`;
  }
  $("enableWebLoginAccount").focus();
  $("enableWebLoginAccount").select();
}

function closeEnableWebLoginModal() {
  $("enableWebLoginBackdrop").hidden = true;
  state.enablingWebLoginUserId = null;
}

async function saveEnableWebLogin() {
  if (!state.enablingWebLoginUserId) return;
  const account = $("enableWebLoginAccount").value.trim();
  if (!account) throw new Error("请填写登录账号");
  await api(`/api/admin/users/${state.enablingWebLoginUserId}/enable-web-login`, {
    method: "POST",
    body: JSON.stringify({ account }),
  });
  closeEnableWebLoginModal();
  await refreshUsersData();
}

function renderEditUserProjectAccessList(user) {
  const list = $("editUserProjectAccessList");
  if (!list) return;
  const accessAll = $("editUserProjectAccessAll").checked;
  list.hidden = accessAll;
  const allowed = new Set((user?.allowed_project_ids || []).map((id) => Number(id)));
  list.innerHTML = state.projects.length
    ? state.projects.map((project) => `
      <label class="checkbox-row">
        <input type="checkbox" value="${project.id}" ${allowed.has(project.id) ? "checked" : ""}>
        <span>${escapeHtml(project.name)}</span>
      </label>
    `).join("")
    : `<small>暂无项目</small>`;
}

function selectedEditUserProjectIds() {
  return [...$("editUserProjectAccessList").querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => Number(input.value))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function closeEditUserModal() {
  $("editUserBackdrop").hidden = true;
  state.editingUserId = null;
}

async function saveEditUser() {
  if (!state.editingUserId) return;
  const payload = {
    display_name: $("editUserDisplayName").value.trim(),
    enabled: $("editUserEnabled").checked,
    project_access_all: $("editUserProjectAccessAll").checked,
    allowed_project_ids: selectedEditUserProjectIds(),
  };
  const password = $("editUserPassword").value;
  if (password) payload.password = password;
  await api(`/api/admin/users/${state.editingUserId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  closeEditUserModal();
  await refreshUsersData();
}

function requestDeleteUser(userId) {
  const user = state.users.find((item) => item.id === userId);
  const name = user?.display_name || user?.account || "该用户";
  openConfirmModal({
    title: "确认删除用户",
    message: `确定删除「${name}」吗？将同时删除其飞书绑定与 Web 登录。`,
    confirmText: "确认删除",
    action: async () => {
      await api(`/api/admin/users/${userId}`, { method: "DELETE" });
      if (state.editingUserId === userId) closeEditUserModal();
      await refreshUsersData();
    },
  });
}

function renderProjects() {
  const syncAllButton = $("syncAllProjects");
  if (syncAllButton) {
    syncAllButton.disabled = state.syncAllLoading || !state.projects.length;
    syncAllButton.textContent = state.syncAllLoading ? "同步中..." : "同步所有项目代码";
  }
  setProjectSyncStatus(state.projectSyncStatus);
  $("projectList").innerHTML = state.projects.map((project) => {
    const repos = state.repos.filter((repo) => repo.project_id === project.id);
    const repoNames = repos.length ? repos.map((repo) => repo.name).join("、") : "暂无仓库";
    const lastSyncAt = repos
      .map((repo) => repo.last_sync_at)
      .filter(Boolean)
      .sort()
      .pop();
    const syncing = state.syncingProjectIds.has(project.id);
    return `
      <div class="item">
        <strong>${escapeHtml(project.name)}</strong>
        <small>${escapeHtml(repoNames)}${lastSyncAt ? ` · 最近同步：${escapeHtml(formatDateTime(lastSyncAt))}` : ""}</small>
        <div class="actions">
          <button data-sync-project="${project.id}" ${syncing ? "disabled" : ""}>${syncing ? "同步中..." : "同步代码"}</button>
          <button data-edit-project="${project.id}">编辑</button>
          <button data-delete-project="${project.id}" class="danger">删除</button>
        </div>
      </div>
    `;
  }).join("");
}

function showAdminToast(message, isError = false) {
  const toast = $("adminToast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.toggle("is-error", isError);
  clearTimeout(showAdminToast._timer);
  showAdminToast._timer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

async function refreshThirdPartyModelsData() {
  state.thirdPartyModel = await api("/api/admin/third-party-models");
  renderModels();
}

function getSavedAnalysisProvider() {
  const view = state.thirdPartyModel || { enabled: false };
  return view.enabled ? "third_party" : "cursor";
}

function getSelectedAnalysisProvider() {
  if (state.analysisProviderDraft) return state.analysisProviderDraft;
  return getSavedAnalysisProvider();
}

function setAnalysisProviderSelection(provider) {
  const next = provider === "third_party" ? "third_party" : "cursor";
  document.querySelectorAll("#analysisProviderSwitch .admin-model-provider-btn").forEach((btn) => {
    const active = btn.dataset.provider === next;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function updateAnalysisProviderStatusText() {
  const view = state.thirdPartyModel || { enabled: false, active: false, models: [] };
  const provider = getSelectedAnalysisProvider();
  const saved = getSavedAnalysisProvider();
  const pending = provider !== saved;
  const status = $("analysisProviderStatus");
  const models = Array.isArray(view.models) ? view.models : [];
  if (!status) return;

  if (provider === "third_party") {
    if (pending) {
      const hasConfigured = models.some((item) => item.configured);
      status.textContent = hasConfigured
        ? "正在切换为第三方模型…"
        : "已选择第三方模型。请先添加并完善至少一个第三方模型后再切换。";
      return;
    }
    if (view.active) {
      const current = models.find((item) => item.is_default) || models.find((item) => item.configured);
      status.textContent = current
        ? `当前使用第三方模型，默认：${current.name}（${current.model_name}）`
        : "当前使用第三方模型。";
    } else {
      status.textContent = "已选择第三方，但尚无可用配置。请先添加并完善至少一个第三方模型后再保存。";
    }
  } else if (pending) {
    status.textContent = "正在切换为 Cursor 模型…";
  } else {
    const cursorDefault = state.models.find((item) => item.is_default);
    status.textContent = cursorDefault
      ? `当前使用 Cursor 模型，默认：${cursorDefault.name}`
      : "当前使用 Cursor 模型。请在下方 Cursor 列表中设置默认模型。";
  }
}

function renderAnalysisProviderSelection() {
  setAnalysisProviderSelection(getSelectedAnalysisProvider());
  updateAnalysisProviderStatusText();
}

let analysisProviderSaving = false;

async function applyAnalysisProviderChoice(provider) {
  const next = provider === "third_party" ? "third_party" : "cursor";
  state.analysisProviderDraft = next;
  setAnalysisProviderSelection(next);
  updateAnalysisProviderStatusText();

  if (next === getSavedAnalysisProvider()) {
    state.analysisProviderDraft = null;
    return;
  }
  if (analysisProviderSaving) return;

  analysisProviderSaving = true;
  const switchEl = $("analysisProviderSwitch");
  const saveBtn = $("saveAnalysisProvider");
  if (switchEl) switchEl.dataset.busy = "1";
  if (saveBtn) saveBtn.disabled = true;
  try {
    await api("/api/admin/third-party-settings", {
      method: "PUT",
      body: JSON.stringify({ provider: next }),
    });
    await refreshThirdPartyModelsData();
    state.analysisProviderDraft = null;
    showAdminToast(next === "third_party" ? "已切换为第三方模型" : "已切换为 Cursor 模型");
  } catch (error) {
    state.analysisProviderDraft = null;
    renderAnalysisProviderSelection();
    showAdminToast(error.message || String(error), true);
    throw error;
  } finally {
    analysisProviderSaving = false;
    if (switchEl) delete switchEl.dataset.busy;
    if (saveBtn) saveBtn.disabled = false;
  }
}

function resetThirdPartyForm() {
  state.thirdPartyEditingId = null;
  $("thirdPartyEditingId").value = "";
  $("tpFormName").value = "";
  $("tpFormProvider").value = "openai-compatible";
  $("tpFormBaseUrl").value = "";
  $("tpFormModelName").value = "";
  $("tpFormApiKey").value = "";
  const input = $("tpFormApiKey");
  const toggle = $("toggleTpFormApiKey");
  if (input) input.type = "password";
  if (toggle) toggle.textContent = "显示";
  $("thirdPartyFormTitle").textContent = "添加第三方模型";
  $("thirdPartyFormSubtitle").textContent = "配置 OpenAI 兼容或 AI Gateway 接入信息";
  $("submitThirdPartyModel").textContent = "添加模型";
}

function fillThirdPartyForm(model) {
  state.thirdPartyEditingId = model.id;
  $("thirdPartyEditingId").value = String(model.id);
  $("tpFormName").value = model.name || "";
  $("tpFormProvider").value = model.provider === "ai-gateway" ? "ai-gateway" : "openai-compatible";
  $("tpFormBaseUrl").value = model.base_url || "";
  $("tpFormModelName").value = model.model_name || "";
  $("tpFormApiKey").value = "";
  $("thirdPartyFormTitle").textContent = `编辑：${model.name}`;
  $("thirdPartyFormSubtitle").textContent = "留空 API Key 表示不修改";
  $("submitThirdPartyModel").textContent = "保存修改";
}

function openThirdPartyModelModal(model = null) {
  resetThirdPartyForm();
  if (model) fillThirdPartyForm(model);
  const backdrop = $("thirdPartyModelBackdrop");
  if (backdrop) backdrop.hidden = false;
  $("tpFormName")?.focus();
}

function closeThirdPartyModelModal() {
  const backdrop = $("thirdPartyModelBackdrop");
  if (backdrop) backdrop.hidden = true;
  resetThirdPartyForm();
}

function renderThirdPartyModelList() {
  const view = state.thirdPartyModel || { models: [] };
  const models = Array.isArray(view.models) ? view.models : [];
  const list = $("thirdPartyModelList");
  if (!list) return;

  list.innerHTML = models.length
    ? models.map((model) => {
      const isDefault = Boolean(model.is_default);
      return `
        <div class="item">
          <strong>${escapeHtml(model.name)}${isDefault ? "（默认）" : ""}${!model.enabled ? "（已禁用）" : ""}</strong>
          <small>${escapeHtml(model.provider)} · ${escapeHtml(model.model_name || "未填写模型 ID")} · ${model.configured ? "已配置 Key" : "缺少 Key"}</small>
          <div class="actions">
            ${isDefault
    ? `<button type="button" class="secondary is-default-badge" disabled aria-current="true">默认</button>`
    : `<button type="button" data-tp-default="${model.id}">设为默认</button>`}
            <button type="button" data-tp-edit="${model.id}">编辑</button>
            <button type="button" data-tp-delete="${model.id}" class="danger">删除</button>
          </div>
        </div>
      `;
    }).join("")
    : `<div class="item"><small>暂无第三方模型，点击「添加第三方模型」创建。</small></div>`;
}

function renderModels() {
  renderAnalysisProviderSelection();
  renderThirdPartyModelList();

  const useThirdParty = Boolean(state.thirdPartyModel?.enabled);
  const intro = $("cursorModelsIntro");
  if (intro) {
    intro.textContent = useThirdParty
      ? "当前全站默认使用第三方模型；此处仍可设置 Cursor 默认，供用户在前端切换回 Cursor 时使用。"
      : "模型列表由 Cursor SDK 自动获取，可在此设置默认 Cursor 分析模型。";
  }

  $("modelList").innerHTML = state.models.length
    ? state.models.map((model) => `
    <div class="item">
      <strong>${escapeHtml(model.name)}${model.is_default ? "（默认）" : ""}${model.recommended ? "（推荐分析）" : ""}</strong>
      <small>Cursor · ${escapeHtml(model.model_name || "未填写模型 ID")}</small>
      <div class="actions">
        <button data-default-model="${model.id}" ${model.is_default ? "disabled" : ""}>设为默认</button>
      </div>
    </div>
  `).join("")
    : `<div class="item"><small>暂无 Cursor 模型，请点击「刷新」从 SDK 拉取。</small></div>`;
}

async function saveAnalysisProvider() {
  await applyAnalysisProviderChoice(getSelectedAnalysisProvider());
}

async function submitThirdPartyModelForm() {
  const button = $("submitThirdPartyModel");
  if (button) button.disabled = true;
  try {
    const editingId = Number($("thirdPartyEditingId").value) || null;
    const payload = {
      name: $("tpFormName").value.trim(),
      provider: $("tpFormProvider").value,
      base_url: $("tpFormBaseUrl").value.trim(),
      model_name: $("tpFormModelName").value.trim(),
      api_key: $("tpFormApiKey").value.trim(),
    };
    if (editingId) {
      await api(`/api/admin/third-party-models/${editingId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      showAdminToast("第三方模型已更新");
    } else {
      await api("/api/admin/third-party-models", {
        method: "POST",
        body: JSON.stringify({ ...payload, is_default: !(state.thirdPartyModel?.models?.length) }),
      });
      showAdminToast("第三方模型已添加");
    }
    closeThirdPartyModelModal();
    await refreshThirdPartyModelsData();
  } finally {
    if (button) button.disabled = false;
  }
}

async function setDefaultThirdPartyModel(modelId) {
  const list = $("thirdPartyModelList");
  if (list) list.dataset.busy = "1";
  try {
    await api(`/api/admin/third-party-models/${modelId}/default`, { method: "PUT", body: JSON.stringify({}) });
    await refreshThirdPartyModelsData();
    showAdminToast("已设为默认第三方模型");
  } finally {
    if (list) delete list.dataset.busy;
  }
}

async function deleteThirdPartyModel(modelId) {
  const model = state.thirdPartyModel?.models?.find((item) => item.id === modelId);
  openConfirmModal({
    title: "删除第三方模型",
    message: `确定删除「${model?.name || modelId}」吗？`,
    confirmText: "删除",
    action: async () => {
      await api(`/api/admin/third-party-models/${modelId}`, { method: "DELETE" });
      if (state.thirdPartyEditingId === modelId) closeThirdPartyModelModal();
      await refreshThirdPartyModelsData();
      showAdminToast("第三方模型已删除");
    },
  });
}

function toggleTpFormApiKeyVisibility() {
  const input = $("tpFormApiKey");
  const button = $("toggleTpFormApiKey");
  if (!input || !button) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  button.textContent = show ? "隐藏" : "显示";
}

function renderSettings() {
  const configured = Boolean(state.settings.configured);
  const badge = $("gitlabTokenBadge");
  if (badge) {
    badge.textContent = configured ? "已配置" : "未配置";
    badge.classList.toggle("is-configured", configured);
  }
  $("gitlabTokenStatus").textContent = configured
    ? "Token 已生效，全局同步 GitLab 仓库时将自动使用。"
    : "公开仓库可不填；私有仓库需配置 Personal Access Token。";
  $("globalGitlabToken").value = state.settings.access_token || "";
  $("globalGitlabToken").placeholder = configured ? "留空保存可清除 Token" : "glpat-xxxxxxxxxxxxxxxxxxxx";
}

function toggleGitlabTokenVisibility() {
  const input = $("globalGitlabToken");
  const button = $("toggleGitlabToken");
  if (!input || !button) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  button.textContent = show ? "隐藏" : "显示";
}

function renderTasks() {
  const list = $("taskList");
  if (!list) return;
  if (!state.tasks.length) {
    const userHint = state.taskUserFilter
      ? "该用户暂无分析历史。"
      : state.taskSourceFilter
        ? "该来源暂无分析历史。"
        : "暂无分析历史。";
    list.innerHTML = `<div class="item"><small>${userHint}</small></div>`;
    return;
  }
  list.innerHTML = state.tasks.map((task) => {
    const project = state.projects.find((item) => item.id === task.project_id);
    const userLabel = task.user_display_name || task.user_account || "历史记录（未关联用户）";
    const sourceLabel = taskSourceLabel(task.source || "web");
    return `
      <div class="item">
        <strong>#${task.id} ${escapeHtml(project?.name || "未知项目")}</strong>
        <small>来源：${escapeHtml(sourceLabel)} · 用户：${escapeHtml(userLabel)} · ${escapeHtml(task.analysis_type)} · ${escapeHtml(task.question)}</small>
        <div class="actions">
          <button data-delete-task="${task.id}" class="danger">删除</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderLoginRecords() {
  const list = $("loginRecordList");
  if (!list) return;
  if (!state.loginRecords.length) {
    list.innerHTML = `<div class="item"><small>暂无登录记录。</small></div>`;
    return;
  }
  list.innerHTML = state.loginRecords.map((record) => {
    const status = record.success ? "成功" : "失败";
    const statusClass = record.success ? "" : "danger";
    const userLabel = record.user_display_name || record.user_account || record.account || "未知账号";
    const reason = record.success ? "" : ` · ${escapeHtml(record.failure_reason || "登录失败")}`;
    const ip = record.ip ? ` · IP：${escapeHtml(record.ip)}` : "";
    return `
      <div class="item">
        <strong>${escapeHtml(userLabel)} <span class="${statusClass}">${status}</span></strong>
        <small>${escapeHtml(record.account)} · ${escapeHtml(formatDateTime(record.created_at))}${ip}${reason}</small>
        <small>${escapeHtml(record.user_agent || "")}</small>
      </div>
    `;
  }).join("");
}

function openEditProjectModal(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  const repos = getProjectRepos(projectId);
  state.editingProjectId = projectId;
  $("editProjectTitle").textContent = `编辑项目：${project.name}`;
  $("editProjectSubtitle").textContent = "修改项目信息与仓库配置";
  $("editProjectName").value = project.name || "";
  $("editProjectDesc").value = project.description || "";
  $("editAndroidRepoUrl").value = repos.android?.git_url || "";
  $("editAndroidRepoBranch").value = repos.android?.branch || "main";
  $("editCppRepoUrl").value = repos.cpp?.git_url || "";
  $("editCppRepoBranch").value = repos.cpp?.branch || "main";
  $("editProjectBackdrop").hidden = false;
  $("editProjectName").focus();
}

function closeEditProjectModal() {
  $("editProjectBackdrop").hidden = true;
  state.editingProjectId = null;
}

function editProjectPayload() {
  const androidUrl = $("editAndroidRepoUrl").value.trim();
  const cppUrl = $("editCppRepoUrl").value.trim();
  if (!androidUrl && !cppUrl) throw new Error("请至少填写 Android 仓库或 C++ 仓库中的一个");
  return {
    name: $("editProjectName").value.trim(),
    description: $("editProjectDesc").value.trim(),
    android_repo: { git_url: androidUrl, branch: $("editAndroidRepoBranch").value.trim() || "main" },
    cpp_repo: { git_url: cppUrl, branch: $("editCppRepoBranch").value.trim() || "main" },
  };
}

function clearProjectForm() {
  ["projectName", "projectDesc", "androidRepoUrl", "cppRepoUrl"].forEach((id) => {
    $(id).value = "";
  });
  $("androidRepoBranch").value = "main";
  $("cppRepoBranch").value = "main";
}

function repoKind(repo) {
  const name = repo.name.toLowerCase();
  if (name.includes("c++") || name.includes("cpp") || name.includes("native")) return "cpp";
  return "android";
}

function getProjectRepos(projectId) {
  const repos = state.repos.filter((repo) => repo.project_id === projectId);
  return {
    android: repos.find((repo) => repoKind(repo) === "android"),
    cpp: repos.find((repo) => repoKind(repo) === "cpp"),
  };
}

function projectPayload() {
  const androidUrl = $("androidRepoUrl").value.trim();
  const cppUrl = $("cppRepoUrl").value.trim();
  if (!androidUrl && !cppUrl) throw new Error("请至少填写 Android 仓库或 C++ 仓库中的一个");
  return {
    name: $("projectName").value.trim(),
    description: $("projectDesc").value.trim(),
    android_repo: { git_url: androidUrl, branch: $("androidRepoBranch").value.trim() || "main" },
    cpp_repo: { git_url: cppUrl, branch: $("cppRepoBranch").value.trim() || "main" },
  };
}

async function saveProject() {
  const payload = projectPayload();
  const result = await api("/api/projects/with-repos", { method: "POST", body: JSON.stringify(payload) });
  clearProjectForm();
  if (result?.sync_started) {
    setProjectSyncStatus(`项目「${result.project?.name || payload.name}」已保存，正在后台同步代码。`);
  }
  await refreshProjectsData();
}

async function saveEditProject() {
  if (!state.editingProjectId) return;
  const payload = editProjectPayload();
  await api(`/api/projects/${state.editingProjectId}/with-repos`, { method: "PUT", body: JSON.stringify(payload) });
  closeEditProjectModal();
  await refreshProjectsData();
}

function summarizeSyncResult(result) {
  const syncedCount = result?.synced?.length || 0;
  const issueCount = result?.validation?.issues?.length || 0;
  return `${result.project_name || "项目"}同步完成：${syncedCount} 个仓库${issueCount ? `，${issueCount} 个提示` : ""}`;
}

async function syncProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  state.syncingProjectIds.add(projectId);
  setProjectSyncStatus(`正在同步「${project?.name || "项目"}」代码...`);
  renderProjects();
  try {
    const result = await api(`/api/projects/${projectId}/sync`, { method: "POST" });
    setProjectSyncStatus(summarizeSyncResult(result));
    await refreshProjectsData();
  } finally {
    state.syncingProjectIds.delete(projectId);
    renderProjects();
  }
}

async function syncAllProjects() {
  state.syncAllLoading = true;
  setProjectSyncStatus("正在同步所有项目代码...");
  renderProjects();
  try {
    const summary = await api("/api/projects/sync", { method: "POST" });
    const results = summary?.results || [];
    const failed = results.filter((item) => item.error);
    setProjectSyncStatus(`所有项目同步完成：${results.length - failed.length} 个成功${failed.length ? `，${failed.length} 个失败` : ""}`);
    await refreshProjectsData();
  } finally {
    state.syncAllLoading = false;
    renderProjects();
  }
}

function setConfirmLoading(loading) {
  $("confirmAction").disabled = loading;
  $("cancelConfirm").disabled = loading;
  $("closeConfirm").disabled = loading;
}

function openConfirmModal({ title, message, confirmText = "确认", danger = true, action = null }) {
  state.pendingConfirmAction = action;
  state.confirmDefaultMessage = message;
  $("confirmTitle").textContent = title;
  $("confirmMessage").textContent = message;
  $("confirmAction").textContent = confirmText;
  $("confirmAction").className = danger ? "primary danger" : "primary";
  $("confirmIcon").classList.toggle("is-warning", danger);
  $("confirmIcon").textContent = danger ? "!" : "?";
  setConfirmLoading(false);
  $("confirmBackdrop").hidden = false;
  $("cancelConfirm").focus();
}

function closeConfirmModal() {
  $("confirmBackdrop").hidden = true;
  state.pendingConfirmAction = null;
  setConfirmLoading(false);
}

async function executeConfirmAction() {
  const action = state.pendingConfirmAction;
  if (!action) {
    closeConfirmModal();
    return;
  }
  const confirmBtn = $("confirmAction");
  const originalText = confirmBtn.textContent;
  setConfirmLoading(true);
  confirmBtn.textContent = "处理中...";
  try {
    await action();
    closeConfirmModal();
  } catch (error) {
    $("confirmMessage").textContent = error.message || String(error);
    $("confirmIcon").classList.add("is-warning");
    $("confirmIcon").textContent = "!";
  } finally {
    confirmBtn.textContent = originalText;
    setConfirmLoading(false);
  }
}

function requestDeleteProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  const name = project?.name || "该项目";
  openConfirmModal({
    title: "确认删除项目",
    message: `确定删除「${name}」吗？关联仓库和代码内容也会一起删除。`,
    confirmText: "确认删除",
    action: async () => {
      await api(`/api/projects/${projectId}`, { method: "DELETE" });
      if (state.editingProjectId === projectId) closeEditProjectModal();
      await refreshProjectsData();
    },
  });
}

function requestDeleteTask(taskId) {
  openConfirmModal({
    title: "确认删除",
    message: "确定删除这条分析历史吗？",
    confirmText: "确认删除",
    action: async () => {
      await api(`/api/tasks/${taskId}`, { method: "DELETE" });
      await refreshTasksData();
    },
  });
}

function requestClearTasks() {
  if (!state.tasks.length) return;
  const user = state.users.find((item) => String(item.id) === String(state.taskUserFilter));
  const sourceLabel = state.taskSourceFilter ? taskSourceLabel(state.taskSourceFilter) : "";
  let scopeLabel = "全部";
  if (user && sourceLabel) {
    scopeLabel = `「${user.display_name || user.account}」且来源为「${sourceLabel}」的`;
  } else if (user) {
    scopeLabel = `「${user.display_name || user.account}」的`;
  } else if (sourceLabel) {
    scopeLabel = `来源为「${sourceLabel}」的`;
  }
  openConfirmModal({
    title: "确认清空",
    message: `确定清空${scopeLabel}分析历史吗？此操作不可恢复。`,
    confirmText: "确认清空",
    action: async () => {
      await api(`/api/tasks${buildTaskQuery()}`, { method: "DELETE" });
      await refreshTasksData();
    },
  });
}

async function saveGitlabToken() {
  await api("/api/settings/gitlab-token", {
    method: "PUT",
    body: JSON.stringify({ access_token: $("globalGitlabToken").value.trim() }),
  });
  await loadAll();
}

async function setDefaultModel(modelId) {
  await api(`/api/models/${modelId}`, { method: "PUT", body: JSON.stringify({}) });
  await loadAll();
}

function alertError(error) {
  if (String(error.message || error).includes("未登录")) {
    showLogin("登录已过期，请重新登录");
    return;
  }
  alert(error.message || error);
}

$("loginForm").addEventListener("submit", submitLogin);
$("loginSubmit")?.addEventListener("click", (event) => {
  event.preventDefault();
  submitLogin(event);
});

$("logoutAdmin").addEventListener("click", () => logout().catch(alertError));

document.querySelector(".admin-nav")?.addEventListener("click", (event) => {
  const page = event.target?.closest?.("[data-admin-page]")?.dataset?.adminPage;
  if (page) switchAdminPage(page);
});

window.addEventListener("hashchange", () => {
  if ($("adminScreen").hidden) return;
  switchAdminPage(readAdminPageFromHash());
});


$("saveEditUser")?.addEventListener("click", () => saveEditUser().catch(alertError));
$("closeEditUser")?.addEventListener("click", closeEditUserModal);
$("saveEnableWebLogin")?.addEventListener("click", () => saveEnableWebLogin().catch(alertError));
$("closeEnableWebLogin")?.addEventListener("click", closeEnableWebLoginModal);
$("enableWebLoginBackdrop")?.addEventListener("click", (event) => {
  if (event.target === $("enableWebLoginBackdrop")) closeEnableWebLoginModal();
});
$("editUserProjectAccessAll")?.addEventListener("change", () => {
  const user = state.users.find((item) => item.id === state.editingUserId);
  renderEditUserProjectAccessList(user);
});
$("editUserBackdrop")?.addEventListener("click", (event) => {
  if (event.target === $("editUserBackdrop")) closeEditUserModal();
});

$("userList")?.addEventListener("click", (event) => {
  const editId = event.target?.dataset?.editUser;
  const deleteId = event.target?.dataset?.deleteUser;
  const enableWebId = event.target?.dataset?.enableWebLogin;
  if (editId) openEditUserModal(Number(editId));
  if (deleteId) requestDeleteUser(Number(deleteId));
  if (enableWebId) openEnableWebLoginModal(Number(enableWebId));
});

$("saveProject").addEventListener("click", () => saveProject().catch(alertError));
$("saveEditProject").addEventListener("click", () => saveEditProject().catch(alertError));
$("closeEditProject").addEventListener("click", closeEditProjectModal);
$("editProjectBackdrop").addEventListener("click", (event) => {
  if (event.target === $("editProjectBackdrop")) closeEditProjectModal();
});
$("confirmAction").addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  executeConfirmAction();
});
$("cancelConfirm").addEventListener("click", (event) => {
  event.stopPropagation();
  closeConfirmModal();
});
$("closeConfirm").addEventListener("click", (event) => {
  event.stopPropagation();
  closeConfirmModal();
});
$("confirmBackdrop").addEventListener("click", (event) => {
  if (event.target === $("confirmBackdrop")) closeConfirmModal();
});
document.querySelector(".admin-confirm-modal")?.addEventListener("click", (event) => {
  event.stopPropagation();
});
$("saveGitlabToken").addEventListener("click", () => saveGitlabToken().catch(alertError));
$("toggleGitlabToken")?.addEventListener("click", toggleGitlabTokenVisibility);
$("syncAllProjects")?.addEventListener("click", () => syncAllProjects().catch(alertError));
$("refreshLoginRecords")?.addEventListener("click", () => refreshLoginRecordsData().catch(alertError));
$("saveFeishuSettings")?.addEventListener("click", () => saveFeishuSettings().catch(alertError));
$("saveFeishuUser")?.addEventListener("click", () => saveFeishuUserBinding().catch(alertError));
$("reloadFeishuDirectory")?.addEventListener("click", () => loadFeishuDirectoryAll(true).catch(alertError));
$("feishuDirectorySearch")?.addEventListener("input", () => applyFeishuDirectoryFilter());
$("feishuDirectoryResults")?.addEventListener("click", (event) => {
  const target = event.target.closest("[data-feishu-directory-open-id]");
  if (target?.dataset?.feishuDirectoryOpenId) {
    selectFeishuDirectoryUser(target.dataset.feishuDirectoryOpenId);
  }
});
$("feishuRecentContacts")?.addEventListener("click", (event) => {
  const target = event.target.closest("[data-feishu-recent-open-id]");
  if (target?.dataset?.feishuRecentOpenId) {
    selectFeishuDirectoryUser(target.dataset.feishuRecentOpenId);
  }
});
$("feishuChatProjectList")?.addEventListener("change", () => updateFeishuChatProjectCount());
$("feishuChatProjectFilter")?.addEventListener("input", () => applyFeishuChatProjectFilter());
$("selectAllFeishuChatProjects")?.addEventListener("click", () => {
  document.querySelectorAll("#feishuChatProjectList [data-feishu-project-item]:not(.is-hidden) input[type=checkbox]").forEach((input) => {
    input.checked = true;
  });
  updateFeishuChatProjectCount();
});
$("clearFeishuChatProjects")?.addEventListener("click", () => {
  document.querySelectorAll("#feishuChatProjectList input[type=checkbox]").forEach((input) => {
    input.checked = false;
  });
  updateFeishuChatProjectCount();
});
$("saveFeishuChat")?.addEventListener("click", () => saveFeishuChatBinding().catch(alertError));
$("fetchFeishuChatInfo")?.addEventListener("click", () => lookupFeishuChatInfo({ overwrite: true }).catch(alertError));
$("feishuChatId")?.addEventListener("blur", () => scheduleFeishuChatLookup());
$("feishuChatId")?.addEventListener("input", () => {
  if (!$("feishuChatId").value.trim()) setFeishuChatLookupHint("");
});
$("feishuUserList")?.addEventListener("click", (event) => {
  const openId = event.target?.dataset?.deleteFeishuUser;
  if (openId) deleteFeishuUserBinding(openId).catch(alertError);
});
$("feishuChatList")?.addEventListener("click", (event) => {
  const chatId = event.target?.dataset?.deleteFeishuChat;
  if (chatId) deleteFeishuChatBinding(chatId).catch(alertError);
});
$("refreshModels")?.addEventListener("click", () => loadAll().catch(alertError));
$("saveAnalysisProvider")?.addEventListener("click", () => saveAnalysisProvider().catch((error) => {
  showAdminToast(error.message || String(error), true);
  alertError(error);
}));
$("openAddThirdPartyModel")?.addEventListener("click", () => openThirdPartyModelModal());
$("closeThirdPartyModelModal")?.addEventListener("click", closeThirdPartyModelModal);
$("thirdPartyModelBackdrop")?.addEventListener("click", (event) => {
  if (event.target === $("thirdPartyModelBackdrop")) closeThirdPartyModelModal();
});
$("submitThirdPartyModel")?.addEventListener("click", () => submitThirdPartyModelForm().catch((error) => {
  showAdminToast(error.message || String(error), true);
  alertError(error);
}));
$("toggleTpFormApiKey")?.addEventListener("click", toggleTpFormApiKeyVisibility);
$("thirdPartyModelList")?.addEventListener("click", (event) => {
  if ($("thirdPartyModelList")?.dataset?.busy === "1") return;
  const defaultBtn = event.target.closest?.("[data-tp-default]");
  const editBtn = event.target.closest?.("[data-tp-edit]");
  const deleteBtn = event.target.closest?.("[data-tp-delete]");
  if (defaultBtn?.dataset?.tpDefault) {
    setDefaultThirdPartyModel(Number(defaultBtn.dataset.tpDefault)).catch((error) => {
      showAdminToast(error.message || String(error), true);
      alertError(error);
    });
    return;
  }
  if (editBtn?.dataset?.tpEdit) {
    const model = state.thirdPartyModel?.models?.find((item) => item.id === Number(editBtn.dataset.tpEdit));
    if (model) openThirdPartyModelModal(model);
    return;
  }
  if (deleteBtn?.dataset?.tpDelete) {
    deleteThirdPartyModel(Number(deleteBtn.dataset.tpDelete)).catch(alertError);
  }
});
$("clearTasks").addEventListener("click", () => requestClearTasks());
$("adminScreen")?.addEventListener("change", (event) => {
  if (event.target?.id === "taskUserFilter") handleTaskUserFilterChange(event);
  if (event.target?.id === "taskSourceFilter") handleTaskSourceFilterChange(event);
});

$("modelList").addEventListener("click", (event) => {
  const modelId = event.target?.dataset?.defaultModel;
  if (modelId) setDefaultModel(Number(modelId)).catch(alertError);
});

$("projectList").addEventListener("click", (event) => {
  const editId = event.target?.dataset?.editProject;
  const deleteId = event.target?.dataset?.deleteProject;
  const syncId = event.target?.dataset?.syncProject;
  if (syncId) syncProject(Number(syncId)).catch(alertError);
  if (editId) openEditProjectModal(Number(editId));
  if (deleteId) requestDeleteProject(Number(deleteId));
});

$("taskList").addEventListener("click", (event) => {
  const taskId = event.target?.dataset?.deleteTask;
  if (taskId) requestDeleteTask(Number(taskId));
});

bindAnalysisProviderSwitch();

checkAuth()
  .then((authed) => {
    if (authed) return loadAll();
  })
  .catch(alertError);
