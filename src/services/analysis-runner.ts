import { db, normalizeRow, normalizeRows, nowIso } from "../db.js";
import { inferAnalysisType, analyzeWithModel, type AnalysisResult, type AnalysisStreamCallbacks } from "./ai.js";
import { isThirdPartyModelEnabled, isThirdPartyProvider, resolveEffectiveAnalysisModel } from "./cursor-runtime.js";
import { validateReposForAnalysis } from "./code.js";
import type { AIModel, GitRepo, Project } from "../types.js";

export interface RunAnalysisInput {
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
  chat_session_id?: string;
  output_mode?: string;
  user_id?: number | null;
  source?: "web" | "feishu";
  feishu_chat_id?: string;
  feishu_open_id?: string;
  feishu_session_id?: string;
  /** 飞书分析时本轮聚焦文件的隔离目录；提供时 Agent 仅能访问仓库与该目录。 */
  feishu_focus_dir?: string;
}

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

  const repos = getReposByIds(payload.repo_ids).filter((repo) => repo.project_id === payload.project_id);
  if (!repos.length) throw new Error("仓库与项目不匹配");

  const chatSessionId = payload.chat_session_id ?? "";
  const question = payload.question ?? "";
  const logText = payload.log_text ?? "";
  const attachmentImages = normalizeAttachmentImages(payload.attachment_images);
  const validation = validateReposForAnalysis(payload.project_id, repos);
  const errors = validation.issues.filter((issue) => issue.level === "error");
  if (errors.length) {
    throw new Error(`${errors.map((issue) => issue.message).join("；")}。请在管理后台手动同步代码，或等待定时自动同步（每天 0 点起每 2 小时）。`);
  }

  const warnings = validation.issues.filter((issue) => issue.level === "warning");
  if (warnings.length) {
    stream?.onStatus?.(warnings.map((issue) => issue.message).join("；"));
  }

  // 调用方未显式指定 provider（如飞书）时，跟随后台全局「第三方模型」开关，
  // 否则会无视后台设置、强制落到 Cursor 默认模型并扣 Cursor 用量。
  const useThirdParty = payload.model_provider
    ? payload.model_provider === "third_party"
    : isThirdPartyModelEnabled();
  const cursorModel = !useThirdParty
    ? (payload.model_id ? getModel(payload.model_id) : getDefaultModel())
    : undefined;
  const thirdPartyModelId = useThirdParty ? (payload.third_party_model_id ?? null) : null;
  const model = resolveEffectiveAnalysisModel(cursorModel, thirdPartyModelId);
  if (model && isThirdPartyProvider(model.provider)) {
    stream?.onStatus?.(`使用第三方模型：${model.name}（${model.model_name}）`);
  }

  const analysisScope = payload.analysis_scope?.trim() ?? "";
  const analysisType = payload.analysis_type || inferAnalysisType(question, logText);

  stream?.onStatus?.("分析助手处理中...");
  const analysis = await analyzeWithModel(
    model,
    question,
    analysisType,
    logText,
    repos,
    chatSessionId,
    attachmentImages,
    stream,
    payload.feishu_focus_dir?.trim() || undefined,
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
