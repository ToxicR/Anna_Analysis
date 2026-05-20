import fs from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import dotenv from "dotenv";
import Fastify, { type FastifyReply } from "fastify";
import { db, boolToInt, getSetting, initDb, normalizeRow, normalizeRows, nowIso, setSetting } from "./db.js";
import { STATIC_DIR, UPLOAD_DIR } from "./paths.js";
import { inferAnalysisType, analyzeWithModel } from "./services/ai.js";
import { searchCode, syncRepo } from "./services/code.js";
import { syncCursorModels } from "./services/cursor-models.js";
import type { AIModel, AnalysisTask, GitRepo, Project, ProjectWithReposInput, RepoSlotInput } from "./types.js";

dotenv.config();
initDb();

const app = Fastify({ logger: true, bodyLimit: 5 * 1024 * 1024 });

await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
await app.register(staticPlugin, { root: STATIC_DIR, prefix: "/static/" });

app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
  reply.status(statusCode).send({ detail: error.message || "Internal Server Error" });
});

app.get("/", async (_request, reply) => {
  return reply.type("text/html").send(fs.createReadStream(path.join(STATIC_DIR, "index.html")));
});

app.get("/api/projects", async () => {
  const rows = db.prepare("SELECT * FROM projects ORDER BY id DESC").all() as Project[];
  return normalizeRows(rows);
});

app.post("/api/projects", async (request, reply) => {
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

app.put("/api/projects/:projectId", async (request, reply) => {
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

app.post("/api/projects/with-repos", async (request, reply) => {
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
    return tx();
  } catch (error) {
    return duplicateError(reply, error);
  }
});

app.put("/api/projects/:projectId/with-repos", async (request, reply) => {
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

app.delete("/api/projects/:projectId", async (request, reply) => {
  const projectId = Number((request.params as { projectId: string }).projectId);
  if (!getProject(projectId)) return notFound(reply, "项目不存在");
  db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  return { ok: true };
});

app.get("/api/repos", async (request) => {
  const projectId = Number((request.query as { project_id?: string }).project_id);
  const rows = projectId
    ? db.prepare("SELECT * FROM git_repos WHERE project_id = ? ORDER BY id DESC").all(projectId)
    : db.prepare("SELECT * FROM git_repos ORDER BY id DESC").all();
  return normalizeRows(rows as GitRepo[]);
});

app.post("/api/repos", async (request, reply) => {
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

app.put("/api/repos/:repoId", async (request, reply) => {
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

app.delete("/api/repos/:repoId", async (request, reply) => {
  const repoId = Number((request.params as { repoId: string }).repoId);
  if (!getRepo(repoId)) return notFound(reply, "仓库不存在");
  db.prepare("DELETE FROM git_repos WHERE id = ?").run(repoId);
  return { ok: true };
});

app.post("/api/repos/sync", async (request, reply) => {
  const payload = request.body as { repo_ids?: number[] };
  const repoIds = payload.repo_ids ?? [];
  if (!repoIds.length) return badRequest(reply, "请至少选择一个仓库");
  const repos = getReposByIds(repoIds);
  if (repos.length !== repoIds.length) return notFound(reply, "仓库不存在");

  const token = getSetting("gitlab_access_token");
  const results = [];
  for (const repo of repos) {
    try {
      const result = await syncRepo(repo, token);
      results.push({ repo_id: repo.id, repo_name: repo.name, ...result });
    } catch (error) {
      throw new Error(`${repo.name} 刷新代码索引失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { synced: results };
});

app.post("/api/repos/:repoId/sync", async (request, reply) => {
  const repoId = Number((request.params as { repoId: string }).repoId);
  const repo = getRepo(repoId);
  if (!repo) return notFound(reply, "仓库不存在");
  return syncRepo(repo, getSetting("gitlab_access_token"));
});

app.get("/api/settings/gitlab-token", async () => {
  const token = getSetting("gitlab_access_token");
  return { configured: Boolean(token), access_token: token };
});

app.put("/api/settings/gitlab-token", async (request) => {
  const payload = request.body as { access_token?: string };
  const token = payload.access_token?.trim() ?? "";
  setSetting("gitlab_access_token", token);
  return { configured: Boolean(token) };
});

app.get("/api/models", async () => {
  const rows = await syncCursorModels();
  return rows.map(publicModel);
});

app.post("/api/models", async (request, reply) => {
  return badRequest(reply, "Cursor 模型列表由 Cursor SDK 自动获取，不支持手动新增");
});

app.put("/api/models/:modelId", async (request, reply) => {
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

app.post("/api/analyze", async (request, reply) => {
  const payload = request.body as {
    project_id: number;
    repo_ids: number[];
    model_id?: number | null;
    analysis_type?: string;
    question?: string;
    log_text?: string;
    conversation_context?: string;
  };
  if (!payload.repo_ids?.length) return badRequest(reply, "请至少选择一个仓库");
  const project = getProject(payload.project_id);
  if (!project) return notFound(reply, "项目不存在");

  const repos = getReposByIds(payload.repo_ids).filter((repo) => repo.project_id === payload.project_id);
  if (!repos.length) return badRequest(reply, "仓库与项目不匹配");

  const model = payload.model_id ? getModel(payload.model_id) : getDefaultModel();
  const question = payload.question ?? "";
  const logText = payload.log_text ?? "";
  const conversationContext = payload.conversation_context ?? "";
  const chunks = searchCode(repos.map((repo) => repo.id), `${question}\n${conversationContext}\n${logText}`);
  const analysisType = payload.analysis_type || inferAnalysisType(question, logText);
  const result = await analyzeWithModel(model, question, analysisType, chunks, logText, repos, conversationContext);

  const insertResult = db.prepare(`
    INSERT INTO analysis_tasks(project_id, model_id, analysis_type, question, log_text, selected_repo_ids, status, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)
  `).run(payload.project_id, model?.id ?? null, analysisType, question, logText, payload.repo_ids.join(","), result, nowIso());

  return getTask(Number(insertResult.lastInsertRowid));
});

app.post("/api/analyze/stream", async (request, reply) => {
  const payload = request.body as {
    project_id: number;
    repo_ids: number[];
    model_id?: number | null;
    analysis_type?: string;
    question?: string;
    log_text?: string;
    conversation_context?: string;
  };

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
    if (!payload.repo_ids?.length) throw new Error("请至少选择一个仓库");
    const project = getProject(payload.project_id);
    if (!project) throw new Error("项目不存在");

    const repos = getReposByIds(payload.repo_ids).filter((repo) => repo.project_id === payload.project_id);
    if (!repos.length) throw new Error("仓库与项目不匹配");

    const model = payload.model_id ? getModel(payload.model_id) : getDefaultModel();
    const question = payload.question ?? "";
    const logText = payload.log_text ?? "";
    const conversationContext = payload.conversation_context ?? "";
    const chunks = searchCode(repos.map((repo) => repo.id), `${question}\n${conversationContext}\n${logText}`);
    const analysisType = payload.analysis_type || inferAnalysisType(question, logText);

    send("status", { message: "Agent 正在分析代码" });
    const result = await analyzeWithModel(model, question, analysisType, chunks, logText, repos, conversationContext, {
      onStatus: (message) => send("status", { message }),
      onDelta: (text) => send("delta", { text }),
    });
    const insertResult = db.prepare(`
      INSERT INTO analysis_tasks(project_id, model_id, analysis_type, question, log_text, selected_repo_ids, status, result, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)
    `).run(payload.project_id, model?.id ?? null, analysisType, question, logText, payload.repo_ids.join(","), result, nowIso());

    send("result", getTask(Number(insertResult.lastInsertRowid)));
    send("done", { ok: true });
  } catch (error) {
    send("error", { detail: error instanceof Error ? error.message : String(error) });
  } finally {
    reply.raw.end();
  }
});

app.post("/api/analyze/upload-log", async (request, reply) => {
  const file = await request.file();
  if (!file) return badRequest(reply, "请选择日志文件");
  const safeName = path.basename(file.filename);
  const buffer = await file.toBuffer();
  fs.writeFileSync(path.join(UPLOAD_DIR, safeName), buffer);
  return { file_name: safeName, text: buffer.toString("utf8").slice(0, 200_000) };
});

app.get("/api/tasks", async (request) => {
  const projectId = Number((request.query as { project_id?: string }).project_id);
  const rows = projectId
    ? db.prepare("SELECT * FROM analysis_tasks WHERE project_id = ? ORDER BY id DESC LIMIT 50").all(projectId)
    : db.prepare("SELECT * FROM analysis_tasks ORDER BY id DESC LIMIT 50").all();
  return rows as AnalysisTask[];
});

app.delete("/api/tasks/:taskId", async (request, reply) => {
  const taskId = Number((request.params as { taskId: string }).taskId);
  if (!getTask(taskId)) return notFound(reply, "分析历史不存在");
  db.prepare("DELETE FROM analysis_tasks WHERE id = ?").run(taskId);
  return { ok: true };
});

app.delete("/api/tasks", async (request) => {
  const projectId = Number((request.query as { project_id?: string }).project_id);
  const result = projectId
    ? db.prepare("DELETE FROM analysis_tasks WHERE project_id = ?").run(projectId)
    : db.prepare("DELETE FROM analysis_tasks").run();
  return { ok: true, deleted: result.changes };
});

function getProject(projectId: number): Project | undefined {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Project | undefined;
  return row ? normalizeRow(row) : undefined;
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

function publicModel(model: AIModel): Omit<AIModel, "api_key" | "base_url"> & { api_key: string; base_url: string; configured: boolean } {
  const configured = Boolean(process.env.CURSOR_API_KEY?.trim() || getSetting("cursor_api_key").trim() || model.api_key);
  return {
    ...model,
    api_key: "",
    base_url: "",
    configured,
  };
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

const port = Number(process.env.PORT || 8765);
const host = process.env.HOST || "127.0.0.1";

await app.listen({ port, host });
