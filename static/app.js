const state = {
  projects: [],
  repos: [],
  models: [],
  tasks: [],
  settings: {},
  editingProjectId: null,
  attachments: [],
  attachmentText: "",
  chatTurns: [],
  chatSessionId: createChatSessionId(),
};

const $ = (id) => document.getElementById(id);

function createChatSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
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
  return response.json();
}

function optionList(items, labelFn) {
  return items.map((item) => `<option value="${item.id}">${escapeHtml(labelFn(item))}</option>`).join("");
}

async function loadAll() {
  const [projects, repos, models, tasks, settings] = await Promise.all([
    api("/api/projects"),
    api("/api/repos"),
    api("/api/models"),
    api("/api/tasks"),
    api("/api/settings/gitlab-token"),
  ]);
  state.projects = projects;
  state.repos = repos;
  state.models = models;
  state.tasks = tasks;
  state.settings = settings;
  render();
}

function render() {
  renderSelectors();
  renderProjects();
  renderRepos();
  renderModels();
  renderSettings();
  renderTasks();
  renderProjectFormMode();
  renderChatContext();
}

function renderSelectors() {
  $("analysisProject").innerHTML = optionList(state.projects, (project) => project.name);
  $("analysisModel").innerHTML = `<option value="">默认/本地摘要</option>${optionList(state.models.filter((model) => model.enabled), (model) => model.is_default ? `${model.name}（默认）` : model.name)}`;
  renderAnalysisRepos();
}

function renderAnalysisRepos() {
  const projectId = Number($("analysisProject").value);
  const repos = state.repos.filter((repo) => repo.project_id === projectId && repo.enabled);
  $("analysisRepos").innerHTML = repos.length
    ? repos.map((repo) => `<label><input type="checkbox" value="${repo.id}" checked> ${escapeHtml(repo.name)} <small>${escapeHtml(repo.branch)}</small></label>`).join("")
    : "<span class='empty'>当前项目还没有填写 Android 或 C++ 仓库</span>";
  renderChatContext();
}

function renderChatContext() {
  const project = state.projects.find((item) => item.id === Number($("analysisProject").value));
  const repoCount = $("analysisRepos").querySelectorAll("input:checked").length;
  const modelSelect = $("analysisModel");
  const modelName = modelSelect.options[modelSelect.selectedIndex]?.textContent || "默认/本地摘要";
  $("chatContext").textContent = project
    ? `当前项目：${project.name} · 已选仓库：${repoCount} · 模型：${modelName}`
    : "请先在管理后台添加项目和仓库。";
}

function renderProjects() {
  $("projectList").innerHTML = state.projects.map((project) => {
    const repos = state.repos.filter((repo) => repo.project_id === project.id);
    const repoNames = repos.length ? repos.map((repo) => repo.name).join("、") : "暂无仓库";
    return `
      <div class="item">
        <strong>${escapeHtml(project.name)}</strong>
        <small>${escapeHtml(repoNames)}</small>
        <div class="actions">
          <button data-edit-project="${project.id}">编辑</button>
          <button data-delete-project="${project.id}" class="danger">删除</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderRepos() {
  if (!state.repos.length) {
    $("repoList").innerHTML = "<div class='empty'>暂无仓库。请在上方保存项目时填写 Android 仓库、C++ 仓库，至少一个。</div>";
    return;
  }
  $("repoList").innerHTML = state.repos.map((repo) => {
    const project = state.projects.find((item) => item.id === repo.project_id);
    const syncText = repo.last_sync_at ? `最近获取代码：${repo.last_sync_at}` : "发送问题时会自动获取代码";
    return `
      <div class="item">
        <strong>${escapeHtml(repo.name)}</strong>
        <small>${escapeHtml(project?.name || "未知项目")} · ${escapeHtml(repo.branch)} · ${escapeHtml(syncText)}</small>
        <small>${escapeHtml(repo.git_url)}</small>
      </div>
    `;
  }).join("");
}

function renderModels() {
  $("modelList").innerHTML = state.models.map((model) => `
    <div class="item">
      <strong>${escapeHtml(model.name)}${model.is_default ? "（默认）" : ""}</strong>
      <small>Cursor · ${escapeHtml(model.model_name || "未填写模型 ID")}</small>
      <div class="actions">
        <button data-default-model="${model.id}" ${model.is_default ? "disabled" : ""}>设为默认</button>
      </div>
    </div>
  `).join("");
}

function renderSettings() {
  $("gitlabTokenStatus").textContent = state.settings.configured ? "已配置，全局获取 GitLab 仓库时使用" : "未配置，公开仓库可不填";
  $("globalGitlabToken").value = state.settings.access_token || "";
}

function renderTasks() {
  $("taskList").innerHTML = state.tasks.map((task) => {
    const project = state.projects.find((item) => item.id === task.project_id);
    return `
      <div class="item">
        <strong>#${task.id} ${escapeHtml(project?.name || "未知项目")}</strong>
        <small>${escapeHtml(task.analysis_type)} · ${escapeHtml(task.question)}</small>
        <div class="actions">
          <button data-delete-task="${task.id}" class="danger">删除</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderProjectFormMode() {
  const editing = Boolean(state.editingProjectId);
  $("projectFormTitle").textContent = editing ? "编辑项目与仓库" : "项目与仓库";
  $("saveProject").textContent = editing ? "保存修改" : "保存项目和仓库";
  $("cancelEditProject").style.display = editing ? "inline-block" : "none";
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

function fillProjectForm(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  const repos = getProjectRepos(projectId);
  state.editingProjectId = projectId;
  $("projectName").value = project.name || "";
  $("projectDesc").value = project.description || "";
  $("androidRepoUrl").value = repos.android?.git_url || "";
  $("androidRepoBranch").value = repos.android?.branch || "main";
  $("cppRepoUrl").value = repos.cpp?.git_url || "";
  $("cppRepoBranch").value = repos.cpp?.branch || "main";
  renderProjectFormMode();
}

function clearProjectForm() {
  state.editingProjectId = null;
  ["projectName", "projectDesc", "androidRepoUrl", "cppRepoUrl"].forEach((id) => {
    $(id).value = "";
  });
  $("androidRepoBranch").value = "main";
  $("cppRepoBranch").value = "main";
  renderProjectFormMode();
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
  if (state.editingProjectId) {
    await api(`/api/projects/${state.editingProjectId}/with-repos`, { method: "PUT", body: JSON.stringify(payload) });
  } else {
    await api("/api/projects/with-repos", { method: "POST", body: JSON.stringify(payload) });
  }
  clearProjectForm();
  await loadAll();
}

async function deleteProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  const name = project?.name || "该项目";
  if (!confirm(`确定删除「${name}」吗？关联仓库和代码内容也会一起删除。`)) return;
  await api(`/api/projects/${projectId}`, { method: "DELETE" });
  if (state.editingProjectId === projectId) clearProjectForm();
  await loadAll();
}

async function deleteTask(taskId) {
  if (!confirm("确定删除这条分析历史吗？")) return;
  await api(`/api/tasks/${taskId}`, { method: "DELETE" });
  await loadAll();
}

async function clearTasks() {
  if (!state.tasks.length) return;
  if (!confirm("确定清空全部分析历史吗？")) return;
  await api("/api/tasks", { method: "DELETE" });
  await loadAll();
}

async function saveGitlabToken() {
  await api("/api/settings/gitlab-token", {
    method: "PUT",
    body: JSON.stringify({ access_token: $("globalGitlabToken").value.trim() }),
  });
  await loadAll();
}

async function refreshModels() {
  await loadAll();
}

async function setDefaultModel(modelId) {
  await api(`/api/models/${modelId}`, { method: "PUT", body: JSON.stringify({}) });
  await loadAll();
}

function appendMessage(role, body, meta) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const avatar = role === "user"
    ? `<div class="avatar user-avatar">你</div>`
    : `<img class="avatar ai-avatar" src="/static/assets/anna-logo.png" alt="Anna AI">`;
  article.innerHTML = `
    ${avatar}
    <div class="bubble">
      <div class="message-meta">${escapeHtml(meta)}</div>
      <div class="message-body"></div>
    </div>
  `;
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

function renderMessageBody(element, markdown) {
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
  $("analysisResult").textContent = "正在获取最新代码...";
  return api("/api/repos/sync", {
    method: "POST",
    body: JSON.stringify({ repo_ids: repoIds }),
  });
}

async function streamAnalysis(payload, handlers) {
  const response = await fetch("/api/analyze/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
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
    .filter((file) => file.image_url)
    .map((file) => ({ url: file.image_url }));
}

async function runAnalysis() {
  const repoIds = [...$("analysisRepos").querySelectorAll("input:checked")].map((input) => Number(input.value));
  const question = $("question").value.trim();
  const currentAttachmentText = attachmentText();
  const currentAttachmentNames = attachmentNames();
  if (!repoIds.length) throw new Error("请至少选择一个参与分析的仓库");
  if (!question && !state.attachments.length) throw new Error("请输入要分析的问题，或添加附件");

  const project = state.projects.find((item) => item.id === Number($("analysisProject").value));
  const meta = `${project?.name || "未选择项目"} · 自动判断分析方式${currentAttachmentNames ? ` · 附件：${currentAttachmentNames}` : ""}`;
  const userMessage = question || `分析附件：${currentAttachmentNames}`;
  const conversationContext = conversationContextForNextTurn();
  appendMessage("user", userMessage, meta);
  rememberTurn("user", userMessage, meta);
  $("question").value = "";
  const pending = appendMessage("assistant", "准备分析...", "Anna Analysis");

  $("runAnalysis").disabled = true;
  try {
    await refreshSelectedRepos(repoIds, pending);
    renderMessageBody(pending.querySelector(".message-body"), "已获取最新代码，正在分析...");
    $("analysisResult").textContent = "正在分析...";
    let streamedText = "";
    const task = await streamAnalysis({
      project_id: Number($("analysisProject").value),
      repo_ids: repoIds,
      model_id: $("analysisModel").value ? Number($("analysisModel").value) : null,
      question,
      log_text: currentAttachmentText,
      attachment_images: attachmentImages(),
      conversation_context: conversationContext,
      chat_session_id: state.chatSessionId,
      output_mode: $("outputMode").value,
    }, {
      onStatus: (message) => {
        if (message) $("analysisResult").textContent = message;
        if (!streamedText && message) renderMessageBody(pending.querySelector(".message-body"), message);
      },
      onDelta: (text) => {
        streamedText += text;
        renderMessageBody(pending.querySelector(".message-body"), streamedText);
      },
    });
    if (task?.result) renderMessageBody(pending.querySelector(".message-body"), task.result);
    rememberTurn("assistant", task?.result || streamedText, "Anna Analysis");
    $("analysisResult").textContent = "分析完成";
    await loadAll();
  } catch (error) {
    renderMessageBody(pending.querySelector(".message-body"), `分析失败：${error.message || error}`);
    $("analysisResult").textContent = "分析失败";
  } finally {
    $("runAnalysis").disabled = false;
  }
}

async function attachLogFiles(files) {
  const selectedFiles = [...files];
  if (!selectedFiles.length) return;
  const form = new FormData();
  selectedFiles.forEach((file) => form.append("files", file));
  const result = await api("/api/analyze/upload-log", { method: "POST", body: form });
  state.attachments.push(...(result.files || []));
  state.attachmentText = [state.attachmentText, result.text].filter(Boolean).join("\n\n");
  $("attachmentName").textContent = `已添加附件：${attachmentNames()}`;
  $("attachmentBar").hidden = false;
  $("analysisResult").textContent = `已添加 ${state.attachments.length} 个附件`;
}

async function uploadLog() {
  const files = $("logFile").files;
  if (files?.length) await attachLogFiles(files);
  $("logFile").value = "";
}

function removeAttachment() {
  state.attachments = [];
  state.attachmentText = "";
  $("logFile").value = "";
  $("attachmentName").textContent = "";
  $("attachmentBar").hidden = true;
  $("analysisResult").textContent = "准备就绪";
}

function clearChat() {
  $("chatMessages").innerHTML = `
    <article class="message assistant">
      <img class="avatar ai-avatar" src="/static/assets/anna-logo.png" alt="Anna AI">
      <div class="bubble">
        <div class="message-meta">Anna Analysis</div>
        <div class="message-body">对话已清空。继续输入问题即可开始新的分析。</div>
      </div>
    </article>
  `;
  state.chatTurns = [];
  state.chatSessionId = createChatSessionId();
  $("analysisResult").textContent = "准备就绪";
}

function resetChatSession() {
  state.chatTurns = [];
  state.chatSessionId = createChatSessionId();
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
  resetChatSession();
  renderAnalysisRepos();
  renderChatContext();
});
$("analysisModel").addEventListener("change", () => {
  resetChatSession();
  renderChatContext();
});
$("analysisRepos").addEventListener("change", () => {
  resetChatSession();
  renderChatContext();
});
$("outputMode").addEventListener("change", () => {
  resetChatSession();
  renderChatContext();
});
$("saveProject").addEventListener("click", () => saveProject().catch(alertError));
$("cancelEditProject").addEventListener("click", clearProjectForm);
$("saveGitlabToken").addEventListener("click", () => saveGitlabToken().catch(alertError));
$("refreshModels").addEventListener("click", () => refreshModels().catch(alertError));
$("modelList").addEventListener("click", (event) => {
  const modelId = event.target?.dataset?.defaultModel;
  if (modelId) setDefaultModel(Number(modelId)).catch(alertError);
});
$("runAnalysis").addEventListener("click", () => runAnalysis().catch(alertError));
$("clearChat").addEventListener("click", clearChat);
$("clearTasks").addEventListener("click", () => clearTasks().catch(alertError));
$("logFile").addEventListener("change", () => uploadLog().catch(alertError));
$("addAttachment").addEventListener("click", () => $("logFile").click());
$("removeAttachment").addEventListener("click", removeAttachment);
$("openAdmin").addEventListener("click", () => {
  $("adminBackdrop").hidden = false;
});
$("closeAdmin").addEventListener("click", () => {
  $("adminBackdrop").hidden = true;
});
$("adminBackdrop").addEventListener("click", (event) => {
  if (event.target === $("adminBackdrop")) $("adminBackdrop").hidden = true;
});

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

$("projectList").addEventListener("click", (event) => {
  const editId = event.target?.dataset?.editProject;
  const deleteId = event.target?.dataset?.deleteProject;
  if (editId) fillProjectForm(Number(editId));
  if (deleteId) deleteProject(Number(deleteId)).catch(alertError);
});

$("taskList").addEventListener("click", (event) => {
  const taskId = event.target?.dataset?.deleteTask;
  if (taskId) deleteTask(Number(taskId)).catch(alertError);
});

function alertError(error) {
  alert(error.message || error);
}

const renderChatContextBase = renderChatContext;
renderChatContext = function renderChatContextWithOutputMode() {
  renderChatContextBase();
  const context = $("chatContext");
  if (!context || !state.projects.length) return;
  const mode = $("outputMode")?.value;
  const outputModeName = mode === "developer" ? "研发模式" : mode === "non_developer" ? "非研发模式" : "Auto";
  if (!context.textContent.includes(outputModeName)) {
    context.textContent = `${context.textContent} · ${outputModeName}`;
  }
};

loadAll().catch(alertError);
