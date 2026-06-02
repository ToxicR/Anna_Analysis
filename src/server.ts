import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import dotenv from "dotenv";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  clearAdminSessionCookie,
  createAdminSession,
  destroyAdminSession,
  getAdminSession,
  getAdminSessionToken,
  isAdminAuthenticated,
  requireAdmin,
  setAdminSessionCookie,
  verifyAdminCredentials,
} from "./auth.js";
import { db, boolToInt, flagToBoolean, getSetting, initDb, normalizeRow, normalizeRows, nowIso, setSetting } from "./db.js";
import { STATIC_DIR, UPLOAD_DIR } from "./paths.js";
import { startCursorSessionMaintenance, type AnalysisResult, type OutputMode } from "./services/ai.js";
import { getEnabledReposForProject, runAnalysis } from "./services/analysis-runner.js";
import { initCodeFts } from "./services/code-fts.js";
import { searchCodeForAnalysis, syncRepo, syncReposToWorkspace, validateReposForAnalysis, copyAttachmentsToWorkspace } from "./services/code.js";
import { deleteProjectCascade, deleteRepoCascade } from "./services/project-delete.js";
import { syncCursorModels } from "./services/cursor-models.js";
import { warmupCursorRuntime } from "./services/cursor-runtime.js";
import {
  createThirdPartyModel,
  deleteThirdPartyModel,
  getThirdPartyModelAdminView,
  getThirdPartyModelsForClient,
  migrateLegacyThirdPartySettings,
  setDefaultThirdPartyModel,
  setThirdPartyAnalysisEnabled,
  updateThirdPartyModel,
} from "./services/third-party-models.js";
import {
  createAppUser,
  changeAppUserPassword,
  deleteAppUser,
  enableWebLoginForUser,
  getAppUserByAccount,
  getAppUserById,
  listAppUserLoginRecords,
  listAppUsers,
  recordAppUserLogin,
  updateAppUser,
  verifyAppUserCredentials,
} from "./services/app-users.js";
import {
  clearUserSessionCookie,
  createUserSession,
  destroyUserSession,
  getUserSession,
  getUserIdFromRequest,
  getUserSessionToken,
  isUserAuthenticated,
  requireUser,
  setUserSessionCookie,
} from "./user-auth.js";
import type { AIModel, AnalysisTask, ChatMessage, ChatSession, GitRepo, Project, ProjectWithReposInput, RepoSlotInput } from "./types.js";
import { registerFeishuRoutes } from "./services/feishu/routes.js";
import { startFeishuSessionIdleMaintenance } from "./services/feishu/sessions.js";
import { resolveWebLoginAccountSuggestion } from "./services/feishu/directory.js";
import { getFeishuUserByAppUserId } from "./services/feishu/users.js";

dotenv.config();
initDb();
migrateLegacyThirdPartySettings();
initCodeFts();
startCursorSessionMaintenance();
startFeishuSessionIdleMaintenance();

interface UploadedAttachment {
  file_name: string;
  stored_name: string;
  mime_type: string;
  path: string;
  workspace_path?: string;
  relative_path?: string;
  size: number;
  text: string;
  image_url?: string;
}

interface AnalyzePayload {
  project_id: number;
  repo_ids: number[];
  model_id?: number | null;
  third_party_model_id?: number | null;
  model_provider?: string;
  analysis_type?: string;
  analysis_scope?: string;
  question?: string;
  log_text?: string;
  attachment_images?: { url: string }[];
  conversation_context?: string;
  chat_session_id?: string;
  output_mode?: OutputMode;
}

interface ProjectSyncSummary {
  project_id: number;
  project_name: string;
  synced: Awaited<ReturnType<typeof syncReposToWorkspace>>;
  validation: ReturnType<typeof validateReposForAnalysis>;
}

interface ProjectSyncErrorSummary {
  project_id: number;
  project_name: string;
  error: string;
}

const MAX_CHAT_SESSIONS_PER_USER = 10;
const REPO_SYNC_INTERVAL_HOURS = 2;
const projectSyncJobs = new Map<number, Promise<ProjectSyncSummary>>();

const app = Fastify({ logger: true, bodyLimit: 5 * 1024 * 1024 });

await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
await app.register(staticPlugin, { root: STATIC_DIR, prefix: "/static/" });

app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
  reply.status(statusCode).send({ detail: error.message || "Internal Server Error" });
});

function getApiPath(url: string): string {
  return url.split("?")[0] ?? url;
}

app.addHook("onRequest", async (request, reply) => {
  const path = getApiPath(request.url);
  if (!path.startsWith("/api/")) return;
  reply.header("Cache-Control", "no-store");
  if (path.startsWith("/api/admin")) return;
  if (path.startsWith("/api/feishu/webhook")) return;
  if (path === "/api/auth/login" || path === "/api/auth/logout") return;

  const userSession = getUserSession(request);
  if (userSession) {
    const user = getAppUserById(userSession.userId);
    if (user?.enabled && flagToBoolean(user.must_change_password)) {
      const allowedWhilePasswordChange = new Set(["/api/auth/me", "/api/auth/logout", "/api/auth/change-password"]);
      if (!allowedWhilePasswordChange.has(path)) {
        return reply.status(403).send({ detail: "首次登录请先修改密码", must_change_password: true });
      }
    }
  }

  if (path === "/api/auth/me" || path === "/api/auth/change-password") return;

  if (!isUserAuthenticated(request) && !isAdminAuthenticated(request)) {
    return reply.status(401).send({ detail: "请先登录" });
  }
});

app.get("/", async (_request, reply) => {
  return reply
    .header("Cache-Control", "no-store")
    .type("text/html")
    .send(fs.createReadStream(path.join(STATIC_DIR, "index.html")));
});

app.get("/admin", async (_request, reply) => {
  return reply
    .header("Cache-Control", "no-store")
    .type("text/html")
    .send(fs.createReadStream(path.join(STATIC_DIR, "admin.html")));
});

app.get("/api/admin/me", async (request, reply) => {
  const session = getAdminSession(request);
  if (!session) return reply.status(401).send({ detail: "未登录或会话已过期" });
  return { account: session.account };
});

app.post("/api/admin/login", async (request, reply) => {
  const payload = request.body as { account?: string; password?: string };
  const account = payload.account?.trim() ?? "";
  const password = payload.password ?? "";
  if (!verifyAdminCredentials(account, password)) {
    return reply.status(401).send({ detail: "账号或密码错误" });
  }
  const token = createAdminSession(account);
  setAdminSessionCookie(reply, token);
  return { account };
});

app.post("/api/admin/logout", async (request, reply) => {
  destroyAdminSession(getAdminSessionToken(request));
  clearAdminSessionCookie(reply);
  return { ok: true };
});

app.get("/api/auth/me", async (request, reply) => {
  const session = getUserSession(request);
  if (!session) return reply.status(401).send({ detail: "未登录或会话已过期" });
  const user = getAppUserById(session.userId);
  if (!user || !user.enabled) return reply.status(401).send({ detail: "账号不存在或已禁用" });
  return {
    id: user.id,
    account: user.account,
    display_name: user.display_name || user.account,
    must_change_password: flagToBoolean(user.must_change_password),
  };
});

app.post("/api/auth/login", async (request, reply) => {
  const payload = request.body as { account?: string; password?: string };
  const account = payload.account?.trim() ?? "";
  const password = payload.password ?? "";
  const existingUser = account ? getAppUserByAccount(account) : undefined;
  const user = verifyAppUserCredentials(account, password);
  if (!user) {
    recordAppUserLogin({
      userId: existingUser?.id ?? null,
      account,
      success: false,
      ip: request.ip,
      userAgent: String(request.headers["user-agent"] || ""),
      failureReason: existingUser && !flagToBoolean(existingUser.enabled) ? "账号已禁用" : "账号或密码错误",
    });
    return reply.status(401).send({ detail: "账号或密码错误，或账号已禁用" });
  }
  recordAppUserLogin({
    userId: user.id,
    account: user.account,
    success: true,
    ip: request.ip,
    userAgent: String(request.headers["user-agent"] || ""),
  });
  const token = createUserSession(user.id, user.account);
  setUserSessionCookie(reply, token);
  return user;
});

app.post("/api/auth/change-password", async (request, reply) => {
  const session = getUserSession(request);
  if (!session) return reply.status(401).send({ detail: "未登录或会话已过期" });
  const payload = request.body as { current_password?: string; new_password?: string };
  try {
    const user = changeAppUserPassword(session.userId, payload.new_password ?? "", payload.current_password);
    return user;
  } catch (error) {
    return badRequest(reply, error instanceof Error ? error.message : String(error));
  }
});

app.post("/api/auth/logout", async (request, reply) => {
  destroyUserSession(getUserSessionToken(request));
  clearUserSessionCookie(reply);
  return { ok: true };
});

app.get("/api/admin/users", { preHandler: requireAdmin }, async () => {
  return listAppUsers();
});

app.get("/api/admin/login-records", { preHandler: requireAdmin }, async (request) => {
  const query = request.query as { user_id?: string; limit?: string };
  return listAppUserLoginRecords({
    userId: Number(query.user_id) || undefined,
    limit: Number(query.limit) || 100,
  });
});

app.post("/api/admin/users", { preHandler: requireAdmin }, async (request, reply) => {
  const payload = request.body as { account?: string; display_name?: string; enabled?: boolean; project_access_all?: boolean; allowed_project_ids?: number[] };
  try {
    return createAppUser({
      account: payload.account ?? "",
      display_name: payload.display_name,
      enabled: payload.enabled,
      project_access_all: payload.project_access_all,
      allowed_project_ids: payload.allowed_project_ids,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed: app_users.account")) {
      return badRequest(reply, "账号已存在，请换一个账号");
    }
    return badRequest(reply, message);
  }
});

app.put("/api/admin/users/:userId", { preHandler: requireAdmin }, async (request, reply) => {
  const userId = Number((request.params as { userId: string }).userId);
  const payload = request.body as { display_name?: string; enabled?: boolean; password?: string; project_access_all?: boolean; allowed_project_ids?: number[] };
  try {
    const user = updateAppUser(userId, payload);
    if (!user) return notFound(reply, "用户不存在");
    return user;
  } catch (error) {
    return badRequest(reply, error instanceof Error ? error.message : String(error));
  }
});

app.post("/api/admin/users/:userId/enable-web-login", { preHandler: requireAdmin }, async (request, reply) => {
  const userId = Number((request.params as { userId: string }).userId);
  const payload = request.body as { account?: string };
  try {
    if (!getAppUserById(userId)) return notFound(reply, "用户不存在");
    return enableWebLoginForUser(userId, payload.account ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed: app_users.account")) {
      return badRequest(reply, "账号已存在，请换一个账号");
    }
    return badRequest(reply, message);
  }
});

app.get("/api/admin/users/:userId/web-login-suggestion", { preHandler: requireAdmin }, async (request, reply) => {
  const userId = Number((request.params as { userId: string }).userId);
  const user = getAppUserById(userId);
  if (!user) return notFound(reply, "用户不存在");
  const binding = getFeishuUserByAppUserId(userId);
  try {
    return await resolveWebLoginAccountSuggestion({
      userId,
      displayName: user.display_name,
      feishuOpenId: binding?.open_id,
    });
  } catch (error) {
    return reply.status(502).send({
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.delete("/api/admin/users/:userId", { preHandler: requireAdmin }, async (request, reply) => {
  const userId = Number((request.params as { userId: string }).userId);
  if (!getAppUserById(userId)) return notFound(reply, "用户不存在");
  deleteAppUser(userId);
  return { ok: true };
});

app.get("/api/projects", async (request) => {
  const userId = getUserIdFromRequest(request);
  const scope = (request.query as { scope?: string }).scope;
  const access = userId && (scope === "user" || !isAdminAuthenticated(request)) ? getUserProjectAccess(userId) : { all: true, projectIds: [] };
  const rows = access.all
    ? db.prepare("SELECT * FROM projects ORDER BY id DESC").all() as Project[]
    : access.projectIds.length
      ? db.prepare(`SELECT * FROM projects WHERE id IN (${access.projectIds.map(() => "?").join(",")}) ORDER BY id DESC`).all(...access.projectIds) as Project[]
      : [];
  return normalizeRows(rows);
});

app.post("/api/projects/sync", { preHandler: requireAdmin }, async () => {
  return syncAllProjectCode();
});

app.post("/api/projects", { preHandler: requireAdmin }, async (request, reply) => {
  const payload = request.body as { name?: string; description?: string; enabled?: boolean };
  try {
    const result = db.prepare(`
      INSERT INTO projects(name, code, description, enabled, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      normalizeProjectName(payload.name),
      generateProjectCode(),
      payload.description?.trim() ?? "",
      boolToInt(payload.enabled),
      nowIso(),
    );
    return getProject(Number(result.lastInsertRowid));
  } catch (error) {
    return duplicateError(reply, error);
  }
});

app.put("/api/projects/:projectId", { preHandler: requireAdmin }, async (request, reply) => {
  const projectId = Number((request.params as { projectId: string }).projectId);
  if (!getProject(projectId)) return notFound(reply, "项目不存在");
  const payload = request.body as { name?: string; description?: string; enabled?: boolean };
  try {
    db.prepare("UPDATE projects SET name = ?, description = ?, enabled = ? WHERE id = ?")
      .run(normalizeProjectName(payload.name), payload.description?.trim() ?? "", boolToInt(payload.enabled), projectId);
    return getProject(projectId);
  } catch (error) {
    return duplicateError(reply, error);
  }
});

app.post("/api/projects/with-repos", { preHandler: requireAdmin }, async (request, reply) => {
  const payload = request.body as ProjectWithReposInput;
  const slots = [
    ["Android", payload.android_repo ?? {}],
    ["C++", payload.cpp_repo ?? {}],
  ] as const;
  const filled = slots.filter(([, repo]) => repo.git_url?.trim());
  if (!filled.length) return badRequest(reply, "请至少填写 Android 仓库或 C++ 仓库中的一个");

  const name = normalizeProjectName(payload.name);
  const tx = db.transaction(() => {
    const projectResult = db.prepare(`
      INSERT INTO projects(name, code, description, enabled, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, generateProjectCode(), payload.description?.trim() ?? "", boolToInt(payload.enabled), nowIso());
    const projectId = Number(projectResult.lastInsertRowid);

    const repos: GitRepo[] = [];
    for (const [kind, repoPayload] of filled) {
      const repoResult = db.prepare(`
        INSERT INTO git_repos(project_id, name, git_url, branch, access_token, enabled, local_path)
        VALUES (?, ?, ?, ?, '', 1, '')
      `).run(projectId, `${name} ${kind}`, repoPayload.git_url?.trim(), repoPayload.branch?.trim() || "main");
      repos.push(getRepo(Number(repoResult.lastInsertRowid))!);
    }

    return { project: getProject(projectId)!, repos };
  });

  try {
    const result = tx();
    triggerProjectSync(result.project.id, "项目创建后自动同步代码");
    return { ...result, sync_started: true };
  } catch (error) {
    return duplicateError(reply, error);
  }
});

app.post("/api/projects/:projectId/sync", { preHandler: requireAdmin }, async (request, reply) => {
  const projectId = Number((request.params as { projectId: string }).projectId);
  if (!getProject(projectId)) return notFound(reply, "项目不存在");
  try {
    return syncProjectCode(projectId);
  } catch (error) {
    throw new Error(`同步项目代码失败：${error instanceof Error ? error.message : String(error)}`);
  }
});

app.put("/api/projects/:projectId/with-repos", { preHandler: requireAdmin }, async (request, reply) => {
  const projectId = Number((request.params as { projectId: string }).projectId);
  const payload = request.body as ProjectWithReposInput;
  const project = getProject(projectId);
  if (!project) return notFound(reply, "项目不存在");
  if (!payload.android_repo?.git_url?.trim() && !payload.cpp_repo?.git_url?.trim()) {
    return badRequest(reply, "请至少填写 Android 仓库或 C++ 仓库中的一个");
  }

  const tx = db.transaction(() => {
    const name = normalizeProjectName(payload.name);
    db.prepare("UPDATE projects SET name = ?, description = ?, enabled = ? WHERE id = ?")
      .run(name, payload.description?.trim() ?? "", boolToInt(payload.enabled), projectId);

    const existing = db.prepare("SELECT * FROM git_repos WHERE project_id = ?").all(projectId) as GitRepo[];
    applyRepoSlot(projectId, name, "Android", payload.android_repo ?? {}, existing);
    applyRepoSlot(projectId, name, "C++", payload.cpp_repo ?? {}, existing);

    return {
      project: getProject(projectId)!,
      repos: db.prepare("SELECT * FROM git_repos WHERE project_id = ? ORDER BY id DESC").all(projectId) as GitRepo[],
    };
  });

  try {
    return tx();
  } catch (error) {
    return duplicateError(reply, error);
  }
});

app.delete("/api/projects/:projectId", { preHandler: requireAdmin }, async (request, reply) => {
  const projectId = Number((request.params as { projectId: string }).projectId);
  if (!getProject(projectId)) return notFound(reply, "项目不存在");
  try {
    deleteProjectCascade(projectId);
    return { ok: true };
  } catch (error) {
    throw new Error(`删除项目失败：${error instanceof Error ? error.message : String(error)}`);
  }
});

app.get("/api/repos", async (request) => {
  const query = request.query as { project_id?: string; scope?: string };
  const projectId = Number(query.project_id);
  const userId = getUserIdFromRequest(request);
  if (userId && (query.scope === "user" || !isAdminAuthenticated(request))) {
    if (projectId && !userCanAccessProject(userId, projectId)) return [];
    const access = getUserProjectAccess(userId);
    const rows = projectId
      ? db.prepare("SELECT * FROM git_repos WHERE project_id = ? ORDER BY id DESC").all(projectId)
      : access.all
        ? db.prepare("SELECT * FROM git_repos ORDER BY id DESC").all()
        : access.projectIds.length
          ? db.prepare(`SELECT * FROM git_repos WHERE project_id IN (${access.projectIds.map(() => "?").join(",")}) ORDER BY id DESC`).all(...access.projectIds)
          : [];
    return normalizeRows(rows as GitRepo[]);
  }
  const rows = projectId
    ? db.prepare("SELECT * FROM git_repos WHERE project_id = ? ORDER BY id DESC").all(projectId)
    : db.prepare("SELECT * FROM git_repos ORDER BY id DESC").all();
  return normalizeRows(rows as GitRepo[]);
});

app.post("/api/repos", { preHandler: requireAdmin }, async (request, reply) => {
  const payload = request.body as {
    project_id?: number;
    name?: string;
    git_url?: string;
    branch?: string;
    access_token?: string;
    enabled?: boolean;
  };
  if (!payload.project_id || !getProject(payload.project_id)) return notFound(reply, "项目不存在");
  if (!payload.git_url?.trim()) return badRequest(reply, "GitLab 地址不能为空");
  const result = db.prepare(`
    INSERT INTO git_repos(project_id, name, git_url, branch, access_token, enabled, local_path)
    VALUES (?, ?, ?, ?, ?, ?, '')
  `).run(
    payload.project_id,
    payload.name?.trim() || "GitLab 仓库",
    payload.git_url.trim(),
    payload.branch?.trim() || "main",
    payload.access_token?.trim() ?? "",
    boolToInt(payload.enabled),
  );
  return getRepo(Number(result.lastInsertRowid));
});

app.put("/api/repos/:repoId", { preHandler: requireAdmin }, async (request, reply) => {
  const repoId = Number((request.params as { repoId: string }).repoId);
  if (!getRepo(repoId)) return notFound(reply, "仓库不存在");
  const payload = request.body as {
    project_id?: number;
    name?: string;
    git_url?: string;
    branch?: string;
    access_token?: string;
    enabled?: boolean;
  };
  if (!payload.project_id || !getProject(payload.project_id)) return notFound(reply, "项目不存在");
  if (!payload.git_url?.trim()) return badRequest(reply, "GitLab 地址不能为空");
  db.prepare(`
    UPDATE git_repos
    SET project_id = ?, name = ?, git_url = ?, branch = ?, access_token = ?, enabled = ?
    WHERE id = ?
  `).run(
    payload.project_id,
    payload.name?.trim() || "GitLab 仓库",
    payload.git_url.trim(),
    payload.branch?.trim() || "main",
    payload.access_token?.trim() ?? "",
    boolToInt(payload.enabled),
    repoId,
  );
  return getRepo(repoId);
});

app.delete("/api/repos/:repoId", { preHandler: requireAdmin }, async (request, reply) => {
  const repoId = Number((request.params as { repoId: string }).repoId);
  if (!getRepo(repoId)) return notFound(reply, "仓库不存在");
  try {
    deleteRepoCascade(repoId);
    return { ok: true };
  } catch (error) {
    throw new Error(`删除仓库失败：${error instanceof Error ? error.message : String(error)}`);
  }
});

app.post("/api/repos/sync", { preHandler: requireAdmin }, async (request, reply) => {
  const payload = request.body as { repo_ids?: number[] };
  const repoIds = payload.repo_ids ?? [];
  if (!repoIds.length) return badRequest(reply, "请至少选择一个仓库");
  const repos = getReposByIds(repoIds);
  if (repos.length !== repoIds.length) return notFound(reply, "仓库不存在");

  const projectId = repos[0]!.project_id;
  if (!repos.every((repo) => repo.project_id === projectId)) {
    return badRequest(reply, "一次只能同步同一项目下的仓库");
  }

  try {
    const token = getSetting("gitlab_access_token");
    const synced = await syncReposToWorkspace(projectId, repos, token);
    const refreshed = getReposByIds(repoIds);
    const validation = validateReposForAnalysis(projectId, refreshed);
    return { synced, validation };
  } catch (error) {
    throw new Error(`刷新代码失败：${error instanceof Error ? error.message : String(error)}`);
  }
});

app.post("/api/repos/:repoId/sync", { preHandler: requireAdmin }, async (request, reply) => {
  const repoId = Number((request.params as { repoId: string }).repoId);
  const repo = getRepo(repoId);
  if (!repo) return notFound(reply, "仓库不存在");
  return syncRepo(repo, getSetting("gitlab_access_token"));
});

app.get("/api/settings/gitlab-token", { preHandler: requireAdmin }, async () => {
  const token = getSetting("gitlab_access_token");
  return { configured: Boolean(token), access_token: token };
});

app.put("/api/settings/gitlab-token", { preHandler: requireAdmin }, async (request) => {
  const payload = request.body as { access_token?: string };
  const token = payload.access_token?.trim() ?? "";
  setSetting("gitlab_access_token", token);
  return { configured: Boolean(token) };
});

app.get("/api/models", async () => {
  const rows = await syncCursorModels();
  const thirdParty = getThirdPartyModelsForClient();
  return {
    models: rows.map(publicModel),
    third_party: thirdParty,
    active_provider: thirdParty.active_provider,
  };
});

app.post("/api/models", async (request, reply) => {
  return badRequest(reply, "Cursor 模型列表由 Cursor SDK 自动获取，不支持手动新增");
});

app.put("/api/models/:modelId", { preHandler: requireAdmin }, async (request, reply) => {
  const modelId = Number((request.params as { modelId: string }).modelId);
  const model = getModel(modelId);
  if (!model) return notFound(reply, "模型不存在");
  db.prepare("UPDATE ai_models SET is_default = 0 WHERE provider = 'cursor'").run();
  db.prepare("UPDATE ai_models SET is_default = 1 WHERE id = ?").run(modelId);
  return publicModel(normalizeRow(getModel(modelId)!));
});

app.delete("/api/models/:modelId", async (request, reply) => {
  return badRequest(reply, "Cursor 模型列表由 Cursor SDK 自动获取，不支持手动删除");
});

app.get("/api/admin/third-party-models", { preHandler: requireAdmin }, async () => {
  return getThirdPartyModelAdminView();
});

app.get("/api/admin/third-party-model", { preHandler: requireAdmin }, async () => {
  return getThirdPartyModelAdminView();
});

app.put("/api/admin/third-party-settings", { preHandler: requireAdmin }, async (request, reply) => {
  const payload = request.body as { enabled?: boolean; provider?: string };
  const useThirdParty = payload.provider === "third_party"
    ? true
    : payload.provider === "cursor"
      ? false
      : payload.enabled;
  if (useThirdParty) {
    const view = getThirdPartyModelAdminView();
    if (!view.models.some((model) => model.configured)) {
      return badRequest(reply, "请先添加至少一个已配置完整的第三方模型");
    }
  }
  if (useThirdParty !== undefined) {
    setThirdPartyAnalysisEnabled(Boolean(useThirdParty));
  }
  void warmupCursorRuntime();
  return getThirdPartyModelAdminView();
});

app.post("/api/admin/third-party-models", { preHandler: requireAdmin }, async (request, reply) => {
  try {
    const payload = request.body as {
      name?: string;
      provider?: string;
      base_url?: string;
      api_key?: string;
      model_name?: string;
      enabled?: boolean;
      is_default?: boolean;
    };
    const created = createThirdPartyModel({
      name: payload.name ?? "",
      provider: payload.provider ?? "openai-compatible",
      base_url: payload.base_url,
      api_key: payload.api_key ?? "",
      model_name: payload.model_name ?? "",
      enabled: payload.enabled,
      is_default: payload.is_default,
    });
    void warmupCursorRuntime();
    return created;
  } catch (error) {
    return badRequest(reply, error instanceof Error ? error.message : String(error));
  }
});

app.put("/api/admin/third-party-models/:modelId/default", { preHandler: requireAdmin }, async (request, reply) => {
  try {
    const modelId = Number((request.params as { modelId: string }).modelId);
    if (!Number.isInteger(modelId) || modelId <= 0) return badRequest(reply, "无效的模型 ID");
    const updated = setDefaultThirdPartyModel(modelId);
    void warmupCursorRuntime();
    return updated;
  } catch (error) {
    return badRequest(reply, error instanceof Error ? error.message : String(error));
  }
});

app.put("/api/admin/third-party-models/:modelId", { preHandler: requireAdmin }, async (request, reply) => {
  try {
    const modelId = Number((request.params as { modelId: string }).modelId);
    const payload = request.body as {
      name?: string;
      provider?: string;
      base_url?: string;
      api_key?: string;
      model_name?: string;
      enabled?: boolean;
    };
    const updated = updateThirdPartyModel(modelId, payload);
    void warmupCursorRuntime();
    return updated;
  } catch (error) {
    return badRequest(reply, error instanceof Error ? error.message : String(error));
  }
});

app.delete("/api/admin/third-party-models/:modelId", { preHandler: requireAdmin }, async (request, reply) => {
  try {
    const modelId = Number((request.params as { modelId: string }).modelId);
    deleteThirdPartyModel(modelId);
    void warmupCursorRuntime();
    return { ok: true };
  } catch (error) {
    return badRequest(reply, error instanceof Error ? error.message : String(error));
  }
});

app.post("/api/analyze", { preHandler: requireUser }, async (request, reply) => {
  const payload = request.body as AnalyzePayload;
  if (!payload.repo_ids?.length) return badRequest(reply, "请至少选择一个仓库");
  const userId = getUserIdFromRequest(request)!;
  if (!assertUserCanAccessProject(userId, payload.project_id, reply)) return;
  if (!assertChatSessionOwned(payload.chat_session_id, userId, reply)) return;
  const { taskId } = await executeAnalysis(payload, userId);
  return getTask(taskId);
});

app.post("/api/analyze/stream", { preHandler: requireUser }, async (request, reply) => {
  const payload = request.body as AnalyzePayload;
  const userId = getUserIdFromRequest(request)!;
  if (!assertUserCanAccessProject(userId, payload.project_id, reply)) return;
  if (!assertChatSessionOwned(payload.chat_session_id, userId, reply)) return;

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const send = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    send("status", { message: "准备分析上下文" });
    const { taskId } = await executeAnalysis(payload, userId, {
      onStatus: (message) => send("status", { message }),
      onDelta: (text) => send("delta", { text }),
      onActivity: (activity) => send("activity", activity),
    });
    send("result", getTask(taskId));
    send("done", { ok: true });
  } catch (error) {
    send("error", { detail: error instanceof Error ? error.message : String(error) });
  } finally {
    reply.raw.end();
  }
});

app.post("/api/analyze/upload-log", { preHandler: requireUser }, async (request, reply) => {
  const query = request.query as { project_id?: string; chat_session_id?: string };
  const projectId = Number(query.project_id);
  const chatSessionId = String(query.chat_session_id || "");
  const userId = getUserIdFromRequest(request)!;
  if (projectId && !assertUserCanAccessProject(userId, projectId, reply)) return;
  if (!assertChatSessionOwned(chatSessionId || undefined, userId, reply)) return;

  const uploaded: UploadedAttachment[] = [];
  for await (const file of request.files()) {
    const safeName = path.basename(file.filename);
    const storedName = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${safeName}`;
    const filePath = path.join(UPLOAD_DIR, storedName);
    const buffer = await file.toBuffer();
    fs.writeFileSync(filePath, buffer);
    const text = isTextAttachment(safeName, file.mimetype) ? buffer.toString("utf8").slice(0, 100_000) : "";

    let workspacePath = filePath;
    let relativePath = storedName;
    if (projectId) {
      const copied = copyAttachmentsToWorkspace(projectId, chatSessionId || "default", [{ stored_name: storedName, source_path: filePath }]);
      if (copied[0]) {
        workspacePath = copied[0].workspace_path;
        relativePath = copied[0].relative_path;
      }
    }

    const imageUrl = file.mimetype.startsWith("image/") ? pathToFileURL(workspacePath).href : undefined;
    uploaded.push({
      file_name: safeName,
      stored_name: storedName,
      mime_type: file.mimetype,
      path: filePath,
      workspace_path: workspacePath,
      relative_path: relativePath,
      size: buffer.length,
      text,
      image_url: imageUrl,
    });
  }

  if (!uploaded.length) return badRequest(reply, "请选择要分析的附件");

  const text = uploaded.map((file) => formatAttachmentForPrompt(file)).join("\n\n");
  return { files: uploaded, text, file_name: uploaded.map((file) => file.file_name).join(", ") };
});

app.get("/api/chat/sessions", { preHandler: requireUser }, async (request, reply) => {
  const userId = getUserIdFromRequest(request)!;
  const projectId = Number((request.query as { project_id?: string }).project_id);
  if (projectId) {
    if (!getProject(projectId)) return notFound(reply, "项目不存在");
    if (!assertUserCanAccessProject(userId, projectId, reply)) return;
    return listChatSessions(userId, projectId);
  }
  return listChatSessions(userId).filter((session) => userCanAccessProject(userId, Number(session.project_id)));
});

app.post("/api/chat/sessions", { preHandler: requireUser }, async (request, reply) => {
  const userId = getUserIdFromRequest(request)!;
  const payload = request.body as {
    id?: string;
    project_id?: number;
    title?: string;
    model_id?: number | null;
    third_party_model_id?: number | null;
    model_provider?: string;
    output_mode?: string;
    analysis_scope?: string;
    repo_ids?: number[];
  };
  const projectId = Number(payload.project_id);
  if (!projectId) return badRequest(reply, "请指定 project_id");
  if (!getProject(projectId)) return notFound(reply, "项目不存在");
  if (!assertUserCanAccessProject(userId, projectId, reply)) return;
  if (!assertUserCanUseRepos(userId, projectId, payload.repo_ids ?? [], reply)) return;
  if (countUserChatSessions(userId) >= MAX_CHAT_SESSIONS_PER_USER) {
    return badRequest(reply, chatSessionLimitMessage());
  }
  return createChatSession({
    userId,
    id: payload.id,
    projectId,
    title: payload.title,
    modelId: payload.model_id ?? null,
    thirdPartyModelId: payload.third_party_model_id ?? null,
    modelProvider: normalizeModelProvider(payload.model_provider),
    outputMode: payload.output_mode,
    analysisScope: payload.analysis_scope,
    repoIds: payload.repo_ids ?? [],
  });
});

app.get("/api/chat/sessions/:sessionId", { preHandler: requireUser }, async (request, reply) => {
  const userId = getUserIdFromRequest(request)!;
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = getChatSessionDetail(sessionId, userId);
  if (!session) return notFound(reply, "会话不存在");
  if (!assertUserCanAccessProject(userId, Number(session.session.project_id), reply)) return;
  return session;
});

app.put("/api/chat/sessions/:sessionId", { preHandler: requireUser }, async (request, reply) => {
  const userId = getUserIdFromRequest(request)!;
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = getChatSession(sessionId, userId);
  if (!session) return notFound(reply, "会话不存在");
  if (!assertUserCanAccessProject(userId, Number(session.project_id), reply)) return;
  const payload = request.body as {
    title?: string;
    model_id?: number | null;
    third_party_model_id?: number | null;
    model_provider?: string;
    output_mode?: string;
    analysis_scope?: string;
    repo_ids?: number[];
  };
  if (!assertUserCanUseRepos(userId, Number(session.project_id), payload.repo_ids ?? [], reply)) return;
  return updateChatSession(sessionId, userId, payload);
});

app.delete("/api/chat/sessions/:sessionId", { preHandler: requireUser }, async (request, reply) => {
  const userId = getUserIdFromRequest(request)!;
  const sessionId = (request.params as { sessionId: string }).sessionId;
  if (!getChatSession(sessionId, userId)) return notFound(reply, "会话不存在");
  db.prepare("DELETE FROM chat_sessions WHERE id = ? AND user_id = ?").run(sessionId, userId);
  return { ok: true };
});

app.post("/api/chat/sessions/:sessionId/messages", { preHandler: requireUser }, async (request, reply) => {
  const userId = getUserIdFromRequest(request)!;
  const sessionId = (request.params as { sessionId: string }).sessionId;
  if (!getChatSession(sessionId, userId)) return notFound(reply, "会话不存在");
  const payload = request.body as { role?: string; meta?: string; body?: string; title?: string };
  if (!payload.role || !payload.body) return badRequest(reply, "请提供 role 和 body");
  const message = appendChatMessage(sessionId, payload.role, payload.meta ?? "", payload.body);
  if (payload.title?.trim()) {
    updateChatSession(sessionId, userId, { title: payload.title.trim() });
  } else if (payload.role === "user") {
    maybeAutoTitleChatSession(sessionId, userId, payload.body);
  }
  return message;
});

app.delete("/api/chat/sessions/:sessionId/messages", { preHandler: requireUser }, async (request, reply) => {
  const userId = getUserIdFromRequest(request)!;
  const sessionId = (request.params as { sessionId: string }).sessionId;
  if (!getChatSession(sessionId, userId)) return notFound(reply, "会话不存在");
  db.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(sessionId);
  db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ? AND user_id = ?").run(nowIso(), sessionId, userId);
  return { ok: true };
});

app.get("/api/tasks", { preHandler: requireAdmin }, async (request) => {
  const query = request.query as { project_id?: string; user_id?: string; source?: string };
  const projectId = Number(query.project_id) || 0;
  const userId = Number(query.user_id) || 0;
  const source = normalizeTaskSourceFilter(query.source);
  return listAnalysisTasks({ projectId, userId, source });
});

app.delete("/api/tasks/:taskId", { preHandler: requireAdmin }, async (request, reply) => {
  const taskId = Number((request.params as { taskId: string }).taskId);
  if (!getTask(taskId)) return notFound(reply, "分析历史不存在");
  db.prepare("DELETE FROM analysis_tasks WHERE id = ?").run(taskId);
  return { ok: true };
});

app.delete("/api/tasks", { preHandler: requireAdmin }, async (request) => {
  const query = request.query as { project_id?: string; user_id?: string; source?: string };
  const projectId = Number(query.project_id) || 0;
  const userId = Number(query.user_id) || 0;
  const source = normalizeTaskSourceFilter(query.source);
  let sql = "DELETE FROM analysis_tasks WHERE 1=1";
  const params: Array<number | string> = [];
  if (projectId) {
    sql += " AND project_id = ?";
    params.push(projectId);
  }
  if (userId) {
    sql += " AND user_id = ?";
    params.push(userId);
  }
  if (source) {
    sql += " AND COALESCE(source, 'web') = ?";
    params.push(source);
  }
  const result = db.prepare(sql).run(...params);
  return { ok: true, deleted: result.changes };
});

function getProject(projectId: number): Project | undefined {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Project | undefined;
  return row ? normalizeRow(row) : undefined;
}

function getUserProjectAccess(userId: number): { all: boolean; projectIds: number[] } {
  const user = getAppUserById(userId);
  if (!user || flagToBoolean(user.project_access_all)) return { all: true, projectIds: [] };
  const rows = db.prepare("SELECT project_id FROM app_user_projects WHERE user_id = ? ORDER BY project_id ASC").all(userId) as Array<{ project_id: number }>;
  return { all: false, projectIds: rows.map((row) => Number(row.project_id)) };
}

function userCanAccessProject(userId: number, projectId: number): boolean {
  if (!projectId) return false;
  const access = getUserProjectAccess(userId);
  return access.all || access.projectIds.includes(projectId);
}

function assertUserCanAccessProject(userId: number, projectId: number, reply: FastifyReply): boolean {
  if (userCanAccessProject(userId, projectId)) return true;
  reply.status(403).send({ detail: "无权访问该项目" });
  return false;
}

function assertUserCanUseRepos(userId: number, projectId: number, repoIds: number[], reply: FastifyReply): boolean {
  if (!repoIds.length) return true;
  if (!userCanAccessProject(userId, projectId)) {
    reply.status(403).send({ detail: "无权访问该项目" });
    return false;
  }
  const repos = getReposByIds(repoIds);
  if (repos.length !== repoIds.length || repos.some((repo) => repo.project_id !== projectId)) {
    reply.status(403).send({ detail: "无权使用所选仓库" });
    return false;
  }
  return true;
}

function getRepo(repoId: number): GitRepo | undefined {
  const row = db.prepare("SELECT * FROM git_repos WHERE id = ?").get(repoId) as GitRepo | undefined;
  return row ? normalizeRow(row) : undefined;
}

function getReposByIds(repoIds: number[]): GitRepo[] {
  if (!repoIds.length) return [];
  const placeholders = repoIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM git_repos WHERE id IN (${placeholders})`).all(...repoIds) as GitRepo[];
  return normalizeRows(rows);
}

function getModel(modelId: number): AIModel | undefined {
  const row = db.prepare("SELECT * FROM ai_models WHERE id = ? AND provider = 'cursor'").get(modelId) as AIModel | undefined;
  return row ? normalizeRow(row) : undefined;
}

function getDefaultModel(): AIModel | undefined {
  const row = db.prepare("SELECT * FROM ai_models WHERE provider = 'cursor' AND is_default = 1 AND enabled = 1 ORDER BY id DESC LIMIT 1").get() as AIModel | undefined;
  return row ? normalizeRow(row) : undefined;
}

function getTask(taskId: number): AnalysisTask | undefined {
  return db.prepare("SELECT * FROM analysis_tasks WHERE id = ?").get(taskId) as AnalysisTask | undefined;
}

function normalizeTaskSourceFilter(value?: string): "web" | "feishu" | "" {
  const source = String(value || "").trim().toLowerCase();
  if (source === "web" || source === "feishu") return source;
  return "";
}

function listAnalysisTasks(filters: { projectId?: number; userId?: number; source?: "web" | "feishu" | "" } = {}): AnalysisTask[] {
  const projectId = filters.projectId || 0;
  const userId = filters.userId || 0;
  const source = filters.source || "";
  let sql = `
    SELECT
      t.*,
      u.account AS user_account,
      COALESCE(NULLIF(u.display_name, ''), u.account) AS user_display_name
    FROM analysis_tasks t
    LEFT JOIN app_users u ON u.id = t.user_id
    WHERE 1=1
  `;
  const params: Array<number | string> = [];
  if (projectId) {
    sql += " AND t.project_id = ?";
    params.push(projectId);
  }
  if (userId) {
    sql += " AND t.user_id = ?";
    params.push(userId);
  }
  if (source) {
    sql += " AND COALESCE(t.source, 'web') = ?";
    params.push(source);
  }
  sql += " ORDER BY t.id DESC LIMIT 50";
  return normalizeRows(db.prepare(sql).all(...params) as AnalysisTask[]);
}

function publicModel(model: AIModel): Omit<AIModel, "api_key" | "base_url"> & { api_key: string; base_url: string; configured: boolean; recommended: boolean } {
  const configured = Boolean(process.env.CURSOR_API_KEY?.trim() || getSetting("cursor_api_key").trim() || model.api_key);
  const name = (model.model_name || "").toLowerCase();
  const recommended = name === "default" || name.includes("composer-2.5") || name === "composer-2";
  return {
    ...model,
    api_key: "",
    base_url: "",
    configured,
    recommended,
  };
}

function normalizeOutputMode(mode?: string): OutputMode {
  return mode === "developer" ? "developer" : "non_developer";
}

function normalizeAttachmentImages(images?: { url: string }[]): { url: string }[] {
  const imageExt = /\.(png|jpe?g|gif|webp|bmp)$/i;
  return Array.isArray(images)
    ? images
      .filter((image) => typeof image.url === "string" && image.url.trim())
      .map((image) => ({ url: image.url.trim() }))
      .filter((image) => image.url.startsWith("https://") || imageExt.test(image.url))
    : [];
}

function isTextAttachment(fileName: string, mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    /\.(log|txt|json|xml|csv|md|trace|out|err|ini|properties|yaml|yml)$/i.test(fileName)
  );
}

function formatAttachmentForPrompt(file: UploadedAttachment): string {
  const readPath = file.relative_path || file.workspace_path || file.path;
  const header = [
    file.file_name,
    file.mime_type || "unknown",
    `${file.size} bytes`,
    readPath,
  ].join("\n");

  if (file.text) {
    return `${header}\n\n${file.text}`;
  }

  if (file.mime_type.startsWith("image/")) {
    return header;
  }

  return header;
}

async function executeAnalysis(
  payload: AnalyzePayload,
  userId?: number | null,
  stream?: {
    onStatus?: (message: string) => void;
    onDelta?: (text: string) => void;
    onActivity?: (activity: { kind: string; message: string }) => void;
  },
): Promise<{ analysis: AnalysisResult; taskId: number }> {
  return runAnalysis(
    {
      project_id: payload.project_id,
      repo_ids: payload.repo_ids,
      model_id: payload.model_id,
      third_party_model_id: payload.third_party_model_id,
      model_provider: payload.model_provider,
      analysis_type: payload.analysis_type,
      analysis_scope: payload.analysis_scope,
      question: payload.question,
      log_text: payload.log_text,
      attachment_images: payload.attachment_images,
      chat_session_id: payload.chat_session_id,
      output_mode: payload.output_mode,
      user_id: userId ?? null,
      source: "web",
    },
    stream,
    {
      assertProjectAccess: (subjectUserId, projectId) => userCanAccessProject(subjectUserId, projectId),
    },
  );
}

function generateChatSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function chatSessionLimitMessage(): string {
  return `每个用户最多保留 ${MAX_CHAT_SESSIONS_PER_USER} 个会话，请先删除旧会话后再新建。`;
}

function countUserChatSessions(userId: number): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM chat_sessions WHERE user_id = ?").get(userId) as { count: number };
  return Number(row?.count ?? 0);
}

function assertChatSessionOwned(
  sessionId: string | undefined,
  userId: number,
  reply: FastifyReply,
): boolean {
  if (!sessionId?.trim()) return true;
  if (getChatSession(sessionId, userId)) return true;
  reply.status(404).send({ detail: "会话不存在或无权访问" });
  return false;
}

function getChatSession(sessionId: string, userId: number): ChatSession | undefined {
  const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?").get(sessionId, userId) as ChatSession | undefined;
  return row ? normalizeRow(row) : undefined;
}

function listChatSessions(userId: number, projectId?: number): ChatSession[] {
  const rows = (projectId
    ? db.prepare(`
      SELECT
        s.*,
        COUNT(m.id) AS message_count,
        (
          SELECT body FROM chat_messages
          WHERE session_id = s.id
          ORDER BY id DESC
          LIMIT 1
        ) AS last_message_preview
      FROM chat_sessions s
      LEFT JOIN chat_messages m ON m.session_id = s.id
      WHERE s.user_id = ? AND s.project_id = ?
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT 100
    `).all(userId, projectId)
    : db.prepare(`
      SELECT
        s.*,
        COUNT(m.id) AS message_count,
        (
          SELECT body FROM chat_messages
          WHERE session_id = s.id
          ORDER BY id DESC
          LIMIT 1
        ) AS last_message_preview
      FROM chat_sessions s
      LEFT JOIN chat_messages m ON m.session_id = s.id
      WHERE s.user_id = ?
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT 200
    `).all(userId)) as Array<ChatSession & { message_count: number; last_message_preview?: string }>;
  return rows.map((row) => ({
    ...normalizeRow(row),
    message_count: Number(row.message_count || 0),
    last_message_preview: row.last_message_preview ? String(row.last_message_preview).slice(0, 120) : "",
  }));
}

function getChatSessionDetail(sessionId: string, userId: number): { session: ChatSession; messages: ChatMessage[] } | undefined {
  const session = getChatSession(sessionId, userId);
  if (!session) return undefined;
  const messages = db.prepare(`
    SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC
  `).all(sessionId) as ChatMessage[];
  return { session, messages };
}

function normalizeModelProvider(value?: string): "cursor" | "third_party" {
  return value?.trim() === "third_party" ? "third_party" : "cursor";
}

function createChatSession(input: {
  userId: number;
  id?: string;
  projectId: number;
  title?: string;
  modelId?: number | null;
  thirdPartyModelId?: number | null;
  modelProvider?: string;
  outputMode?: string;
  analysisScope?: string;
  repoIds?: number[];
}): ChatSession {
  if (countUserChatSessions(input.userId) >= MAX_CHAT_SESSIONS_PER_USER) {
    throw new Error(chatSessionLimitMessage());
  }
  const id = input.id?.trim() || generateChatSessionId();
  const title = input.title?.trim() || "新会话";
  const outputMode = input.outputMode === "developer" ? "developer" : "non_developer";
  const repoIds = (input.repoIds ?? []).join(",");
  const timestamp = nowIso();
  const modelProvider = normalizeModelProvider(input.modelProvider);
  db.prepare(`
    INSERT INTO chat_sessions(
      id, user_id, project_id, title, model_id, third_party_model_id, model_provider, output_mode, analysis_scope, repo_ids, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.userId,
    input.projectId,
    title,
    input.modelId ?? null,
    input.thirdPartyModelId ?? null,
    modelProvider,
    outputMode,
    input.analysisScope?.trim() ?? "",
    repoIds,
    timestamp,
    timestamp,
  );
  return getChatSession(id, input.userId)!;
}

function updateChatSession(
  sessionId: string,
  userId: number,
  payload: {
    title?: string;
    model_id?: number | null;
    third_party_model_id?: number | null;
    model_provider?: string;
    output_mode?: string;
    analysis_scope?: string;
    repo_ids?: number[];
  },
): ChatSession {
  const current = getChatSession(sessionId, userId)!;
  const title = payload.title?.trim() || current.title;
  const modelId = payload.model_id === undefined ? current.model_id : payload.model_id;
  const thirdPartyModelId = payload.third_party_model_id === undefined
    ? (current.third_party_model_id ?? null)
    : payload.third_party_model_id;
  const modelProvider = payload.model_provider === undefined
    ? normalizeModelProvider(current.model_provider)
    : normalizeModelProvider(payload.model_provider);
  const outputMode = payload.output_mode === "developer" || payload.output_mode === "non_developer"
    ? payload.output_mode
    : current.output_mode;
  const analysisScope = payload.analysis_scope === undefined ? current.analysis_scope : payload.analysis_scope.trim();
  const repoIds = payload.repo_ids === undefined ? current.repo_ids : payload.repo_ids.join(",");
  db.prepare(`
    UPDATE chat_sessions
    SET title = ?, model_id = ?, third_party_model_id = ?, model_provider = ?, output_mode = ?, analysis_scope = ?, repo_ids = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(title, modelId, thirdPartyModelId, modelProvider, outputMode, analysisScope, repoIds, nowIso(), sessionId, userId);
  return getChatSession(sessionId, userId)!;
}

function appendChatMessage(sessionId: string, role: string, meta: string, body: string): ChatMessage {
  const result = db.prepare(`
    INSERT INTO chat_messages(session_id, role, meta, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, role, meta, body, nowIso());
  db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(nowIso(), sessionId);
  return db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(Number(result.lastInsertRowid)) as ChatMessage;
}

function maybeAutoTitleChatSession(sessionId: string, userId: number, body: string): void {
  const session = getChatSession(sessionId, userId);
  if (!session || session.title !== "新会话") return;
  const count = db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ? AND role = 'user'").get(sessionId) as { count: number };
  if (count.count > 1) return;
  const title = body.replace(/\s+/g, " ").trim().slice(0, 40) || "新会话";
  updateChatSession(sessionId, userId, { title });
}

function normalizeProjectName(name = ""): string {
  const normalized = name.trim();
  if (!normalized) throw new Error("请填写项目名称");
  return normalized;
}

function generateProjectCode(): string {
  return `project-${new Date().toISOString().replace(/\D/g, "")}-${Math.random().toString(16).slice(2, 8)}`;
}

function repoKind(repo: GitRepo): "Android" | "C++" {
  const name = repo.name.toLowerCase();
  return name.includes("c++") || name.includes("cpp") || name.includes("native") ? "C++" : "Android";
}

function applyRepoSlot(projectId: number, projectName: string, kind: "Android" | "C++", payload: RepoSlotInput, existing: GitRepo[]): void {
  const repo = existing.find((item) => repoKind(item) === kind);
  const gitUrl = payload.git_url?.trim() ?? "";
  const branch = payload.branch?.trim() || "main";

  if (!gitUrl) {
    if (repo) db.prepare("DELETE FROM git_repos WHERE id = ?").run(repo.id);
    return;
  }

  if (repo) {
    db.prepare(`
      UPDATE git_repos SET name = ?, git_url = ?, branch = ?, access_token = '', enabled = 1 WHERE id = ?
    `).run(`${projectName} ${kind}`, gitUrl, branch, repo.id);
  } else {
    db.prepare(`
      INSERT INTO git_repos(project_id, name, git_url, branch, access_token, enabled, local_path)
      VALUES (?, ?, ?, ?, '', 1, '')
    `).run(projectId, `${projectName} ${kind}`, gitUrl, branch);
  }
}

async function doSyncProjectCode(projectId: number): Promise<ProjectSyncSummary> {
  const project = getProject(projectId);
  if (!project) throw new Error("项目不存在");
  const repos = getEnabledReposForProject(projectId);
  if (!repos.length) throw new Error("项目未配置可同步的仓库");
  const token = getSetting("gitlab_access_token");
  const synced = await syncReposToWorkspace(projectId, repos, token);
  const refreshed = getEnabledReposForProject(projectId);
  const validation = validateReposForAnalysis(projectId, refreshed);
  return {
    project_id: project.id,
    project_name: project.name,
    synced,
    validation,
  };
}

async function syncProjectCode(projectId: number): Promise<ProjectSyncSummary> {
  const existing = projectSyncJobs.get(projectId);
  if (existing) return existing;
  const job = doSyncProjectCode(projectId).finally(() => {
    projectSyncJobs.delete(projectId);
  });
  projectSyncJobs.set(projectId, job);
  return job;
}

async function syncAllProjectCode(): Promise<{ results: Array<ProjectSyncSummary | ProjectSyncErrorSummary> }> {
  const projects = normalizeRows(db.prepare("SELECT * FROM projects WHERE enabled = 1 ORDER BY id ASC").all() as Project[]);
  const results: Array<ProjectSyncSummary | ProjectSyncErrorSummary> = [];
  for (const project of projects) {
    try {
      results.push(await syncProjectCode(project.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ project_id: project.id, project_name: project.name, error: message });
      app.log.error({ projectId: project.id, err: error }, "project code sync failed");
    }
  }
  return { results };
}

function triggerProjectSync(projectId: number, reason: string): void {
  void syncProjectCode(projectId)
    .then((result) => {
      app.log.info({ projectId, repoCount: result.synced.length, reason }, "project code sync completed");
    })
    .catch((error) => {
      app.log.error({ projectId, err: error, reason }, "project code sync failed");
    });
}

function msUntilNextScheduledRepoSync(): number {
  const now = new Date();
  const intervalMs = REPO_SYNC_INTERVAL_HOURS * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  const msSinceMidnight =
    now.getHours() * 3_600_000
    + now.getMinutes() * 60_000
    + now.getSeconds() * 1_000
    + now.getMilliseconds();

  let nextMsSinceMidnight = Math.ceil(msSinceMidnight / intervalMs) * intervalMs;
  if (nextMsSinceMidnight >= dayMs) {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    return next.getTime() - now.getTime();
  }

  const next = new Date(now);
  next.setHours(0, 0, 0, 0);
  next.setTime(next.getTime() + nextMsSinceMidnight);
  return Math.max(0, next.getTime() - now.getTime());
}

function schedulePeriodicRepoSync(): void {
  const scheduleNext = () => {
    const timer = setTimeout(() => {
      void syncAllProjectCode()
        .then((summary) => {
          app.log.info(
            { projectCount: summary.results.length, intervalHours: REPO_SYNC_INTERVAL_HOURS },
            "scheduled project code sync completed",
          );
        })
        .catch((error) => {
          app.log.error({ err: error, intervalHours: REPO_SYNC_INTERVAL_HOURS }, "scheduled project code sync failed");
        })
        .finally(scheduleNext);
    }, msUntilNextScheduledRepoSync());
    timer.unref?.();
  };
  scheduleNext();
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ detail: message });
}

function notFound(reply: FastifyReply, message: string) {
  return reply.status(404).send({ detail: message });
}

function duplicateError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE constraint failed: projects.name")) {
    return badRequest(reply, "项目名称已存在，请换一个项目名称");
  }
  if (message.includes("UNIQUE constraint failed: ai_models.name")) {
    return badRequest(reply, "模型名称已存在，请换一个模型名称");
  }
  return badRequest(reply, `保存失败：${message}`);
}

registerFeishuRoutes(app, requireAdmin);

const port = Number(process.env.PORT || 8765);
const host = process.env.HOST || "127.0.0.1";

await warmupCursorRuntime();
await app.listen({ port, host });
schedulePeriodicRepoSync();
