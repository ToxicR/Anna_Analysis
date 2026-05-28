const state = {
  projects: [],
  repos: [],
  models: [],
  tasks: [],
  users: [],
  taskUserFilter: "",
  settings: {},
  editingProjectId: null,
  editingUserId: null,
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
  models: {
    title: "AI 模型",
    desc: "管理 Cursor 分析模型与默认选项",
  },
  accounts: {
    title: "账号管理",
    desc: "创建和管理前端分析页登录账号",
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
  switchAdminPage(readAdminPageFromHash());
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
  const [projects, repos, models, tasks, settings, users] = await Promise.all([
    api("/api/projects"),
    api("/api/repos"),
    api("/api/models"),
    api("/api/tasks"),
    api("/api/settings/gitlab-token"),
    api("/api/admin/users"),
  ]);
  state.projects = projects;
  state.repos = repos;
  state.models = models;
  state.tasks = tasks;
  state.settings = settings;
  state.users = users;
  render();
}

async function refreshUsersData() {
  state.users = await api("/api/admin/users");
  renderUsers();
  renderTaskUserFilter();
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

async function refreshTasksData() {
  const query = state.taskUserFilter ? `?user_id=${encodeURIComponent(state.taskUserFilter)}` : "";
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
  renderTaskUserFilter();
  renderTasks();
}

function renderUsers() {
  const list = $("userList");
  if (!list) return;
  if (!state.users.length) {
    list.innerHTML = `<div class="item"><small>暂无前端登录账号，请先创建。</small></div>`;
    return;
  }
  list.innerHTML = state.users.map((user) => `
    <div class="item">
      <strong>${escapeHtml(user.display_name || user.account)}</strong>
      <small>${escapeHtml(user.account)} · ${user.enabled ? "已启用" : "已禁用"}${user.must_change_password ? " · 待改密" : ""} · ${escapeHtml(userProjectAccessLabel(user))} · ${escapeHtml(user.created_at || "")}</small>
      <div class="actions">
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

function clearUserForm() {
  $("newUserAccount").value = "";
  $("newUserDisplayName").value = "";
  $("newUserEnabled").checked = true;
}

async function saveUser() {
  const account = $("newUserAccount").value.trim();
  if (!account) throw new Error("请填写登录账号");
  await api("/api/admin/users", {
    method: "POST",
    body: JSON.stringify({
      account,
      display_name: $("newUserDisplayName").value.trim(),
      enabled: $("newUserEnabled").checked,
    }),
  });
  clearUserForm();
  await refreshUsersData();
}

function openEditUserModal(userId) {
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;
  state.editingUserId = userId;
  $("editUserTitle").textContent = `编辑账号：${user.account}`;
  $("editUserSubtitle").textContent = "修改显示名称、状态或重置密码";
  $("editUserAccount").value = user.account;
  $("editUserDisplayName").value = user.display_name || "";
  $("editUserEnabled").checked = Boolean(user.enabled);
  $("editUserPassword").value = "";
  $("editUserProjectAccessAll").checked = user.project_access_all !== false;
  renderEditUserProjectAccessList(user);
  $("editUserBackdrop").hidden = false;
  $("editUserDisplayName").focus();
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
  const name = user?.display_name || user?.account || "该账号";
  openConfirmModal({
    title: "确认删除账号",
    message: `确定删除「${name}」吗？删除后该账号将无法登录前端分析页。`,
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

function renderModels() {
  $("modelList").innerHTML = state.models.map((model) => `
    <div class="item">
      <strong>${escapeHtml(model.name)}${model.is_default ? "（默认）" : ""}${model.recommended ? "（推荐分析）" : ""}</strong>
      <small>Cursor · ${escapeHtml(model.model_name || "未填写模型 ID")}</small>
      <div class="actions">
        <button data-default-model="${model.id}" ${model.is_default ? "disabled" : ""}>设为默认</button>
      </div>
    </div>
  `).join("");
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
      : "暂无分析历史。";
    list.innerHTML = `<div class="item"><small>${userHint}</small></div>`;
    return;
  }
  list.innerHTML = state.tasks.map((task) => {
    const project = state.projects.find((item) => item.id === task.project_id);
    const userLabel = task.user_display_name || task.user_account || "历史记录（未关联用户）";
    return `
      <div class="item">
        <strong>#${task.id} ${escapeHtml(project?.name || "未知项目")}</strong>
        <small>用户：${escapeHtml(userLabel)} · ${escapeHtml(task.analysis_type)} · ${escapeHtml(task.question)}</small>
        <div class="actions">
          <button data-delete-task="${task.id}" class="danger">删除</button>
        </div>
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
  const scopeLabel = user ? `「${user.display_name || user.account}」的` : "全部";
  openConfirmModal({
    title: "确认清空",
    message: `确定清空${scopeLabel}分析历史吗？此操作不可恢复。`,
    confirmText: "确认清空",
    action: async () => {
      const query = state.taskUserFilter ? `?user_id=${encodeURIComponent(state.taskUserFilter)}` : "";
      await api(`/api/tasks${query}`, { method: "DELETE" });
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

$("saveUser")?.addEventListener("click", () => saveUser().catch(alertError));
$("saveEditUser")?.addEventListener("click", () => saveEditUser().catch(alertError));
$("closeEditUser")?.addEventListener("click", closeEditUserModal);
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
  if (editId) openEditUserModal(Number(editId));
  if (deleteId) requestDeleteUser(Number(deleteId));
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
$("refreshModels").addEventListener("click", () => loadAll().catch(alertError));
$("clearTasks").addEventListener("click", () => requestClearTasks());
$("adminScreen")?.addEventListener("change", (event) => {
  if (event.target?.id === "taskUserFilter") handleTaskUserFilterChange(event);
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

checkAuth()
  .then((authed) => {
    if (authed) return loadAll();
  })
  .catch(alertError);
