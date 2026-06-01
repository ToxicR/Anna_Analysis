import { db, getSetting, normalizeRow, normalizeRows, nowIso } from "../db.js";
import { inferAnalysisType, analyzeWithModel, type AnalysisResult, type AnalysisStreamCallbacks, type OutputMode } from "./ai.js";
import { searchCodeForAnalysis, syncReposToWorkspace, validateReposForAnalysis } from "./code.js";
import type { AIModel, GitRepo, Project } from "../types.js";

export interface RunAnalysisInput {
  project_id: number;
  repo_ids: number[];
  model_id?: number | null;
  analysis_type?: string;
  analysis_scope?: string;
  question?: string;
  log_text?: string;
  attachment_images?: { url: string }[];
  conversation_context?: string;
  chat_session_id?: string;
  output_mode?: OutputMode;
  skip_sync?: boolean;
  force_sync?: boolean;
  user_id?: number | null;
  source?: "web" | "feishu";
  feishu_chat_id?: string;
  feishu_open_id?: string;
  feishu_session_id?: string;
}

const workspaceSyncCache = new Map<string, number>();
const WORKSPACE_SYNC_TTL_MS = 1000 * 60 * 60 * 3;

function getProject(projectId: number): Project | undefined {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Project | undefined;
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
  const row = db.prepare(`
    SELECT * FROM ai_models
    WHERE provider = 'cursor' AND is_default = 1 AND enabled = 1
    ORDER BY id DESC LIMIT 1
  `).get() as AIModel | undefined;
  return row ? normalizeRow(row) : undefined;
}

function buildWorkspaceSyncKey(chatSessionId: string, projectId: number, repoIds: number[]): string {
  return `${chatSessionId || "default"}::${projectId}::${[...repoIds].sort((a, b) => a - b).join(",")}`;
}

function normalizeOutputMode(value?: string): OutputMode {
  return value === "developer" ? "developer" : "non_developer";
}

function normalizeAttachmentImages(images?: { url: string }[]) {
  return (images ?? []).filter((item) => item?.url?.trim()).map((item) => ({ url: item.url.trim() }));
}

export async function runAnalysis(
  payload: RunAnalysisInput,
  stream?: AnalysisStreamCallbacks,
  options: { assertProjectAccess?: (userId: number, projectId: number) => boolean } = {},
): Promise<{ analysis: AnalysisResult; taskId: number }> {
  if (!payload.repo_ids?.length) throw new Error("请至少选择一个仓库");
  const project = getProject(payload.project_id);
  if (!project) throw new Error("项目不存在");
  if (payload.user_id && options.assertProjectAccess && !options.assertProjectAccess(payload.user_id, payload.project_id)) {
    throw new Error("无权访问该项目");
  }

  let repos = getReposByIds(payload.repo_ids).filter((repo) => repo.project_id === payload.project_id);
  if (!repos.length) throw new Error("仓库与项目不匹配");

  const chatSessionId = payload.chat_session_id ?? "";
  const syncKey = buildWorkspaceSyncKey(chatSessionId, payload.project_id, payload.repo_ids);
  const cachedAt = workspaceSyncCache.get(syncKey);
  const canSkipSync = !payload.force_sync
    && (payload.skip_sync || (cachedAt !== undefined && Date.now() - cachedAt < WORKSPACE_SYNC_TTL_MS))
    && validateReposForAnalysis(payload.project_id, repos).ok;

  if (canSkipSync) {
    stream?.onStatus?.("使用本轮已同步的代码，继续分析...");
  } else {
    stream?.onStatus?.("正在更新仓库代码（首次或仓库变更时会较慢）...");
    const token = getSetting("gitlab_access_token");
    await syncReposToWorkspace(payload.project_id, repos, token);
    workspaceSyncCache.set(syncKey, Date.now());
    repos = getReposByIds(payload.repo_ids).filter((repo) => repo.project_id === payload.project_id);
  }

  const validation = validateReposForAnalysis(payload.project_id, repos);
  const errors = validation.issues.filter((issue) => issue.level === "error");
  if (errors.length) throw new Error(errors.map((issue) => issue.message).join("；"));

  const warnings = validation.issues.filter((issue) => issue.level === "warning");
  if (warnings.length) {
    stream?.onStatus?.(warnings.map((issue) => issue.message).join("；"));
  }

  const model = payload.model_id ? getModel(payload.model_id) : getDefaultModel();
  const question = payload.question ?? "";
  const logText = payload.log_text ?? "";
  const attachmentImages = normalizeAttachmentImages(payload.attachment_images);
  const conversationContext = payload.conversation_context ?? "";
  const outputMode = normalizeOutputMode(payload.output_mode);
  const analysisScope = payload.analysis_scope?.trim() ?? "";
  const analysisType = payload.analysis_type || inferAnalysisType(question, logText);
  const chunks = searchCodeForAnalysis(
    repos.map((repo) => repo.id),
    `${question}\n${conversationContext}\n${logText}\n${analysisScope}`,
    analysisType,
  );

  stream?.onStatus?.("分析助手正在阅读仓库...");
  const analysis = await analyzeWithModel(
    model,
    question,
    analysisType,
    chunks,
    logText,
    repos,
    conversationContext,
    chatSessionId,
    outputMode,
    attachmentImages,
    stream,
    analysisScope,
  );

  const source = payload.source ?? "web";
  const insertResult = db.prepare(`
    INSERT INTO analysis_tasks(
      project_id, model_id, analysis_type, question, log_text, selected_repo_ids,
      status, result, agent_id, run_id, workspace_path, analysis_scope, user_id, chat_session_id,
      source, feishu_chat_id, feishu_open_id, feishu_session_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.project_id,
    model?.id ?? null,
    analysisType,
    question,
    logText,
    payload.repo_ids.join(","),
    analysis.text,
    analysis.agentId ?? "",
    analysis.runId ?? "",
    analysis.workspacePath ?? validation.workspace_path,
    analysisScope,
    payload.user_id ?? null,
    chatSessionId,
    source,
    payload.feishu_chat_id ?? "",
    payload.feishu_open_id ?? "",
    payload.feishu_session_id ?? "",
    nowIso(),
  );

  return { analysis, taskId: Number(insertResult.lastInsertRowid) };
}

export function getEnabledReposForProject(projectId: number): GitRepo[] {
  const rows = db.prepare("SELECT * FROM git_repos WHERE project_id = ? AND enabled = 1 ORDER BY id DESC").all(projectId) as GitRepo[];
  return normalizeRows(rows);
}
