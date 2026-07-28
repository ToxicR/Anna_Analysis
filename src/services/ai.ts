import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKAgent, SDKImage, SDKMessage, SDKUserMessage } from "@cursor/sdk";
import { isThirdPartyModelEnabled, isThirdPartyProvider, loadCursorSdk } from "./cursor-runtime.js";
import { db, getSetting, setSetting } from "../db.js";
import { DATA_DIR } from "../paths.js";
import type { AIModel, GitRepo } from "../types.js";
import { projectWorkspaceRoot, repoWorkspaceSlot } from "./workspace.js";

export interface AnalysisResult {
  text: string;
  agentId?: string;
  runId?: string;
  workspacePath?: string;
}

export interface AnalysisActivity {
  kind: "thinking" | "tool" | "status";
  message: string;
}

export interface AnalysisStreamCallbacks {
  onStatus?: (message: string) => void;
  onDelta?: (text: string) => void;
  onActivity?: (activity: AnalysisActivity) => void;
}

export type OutputMode = "developer" | "non_developer";
export type AttachmentImage = { url: string };

interface CursorSession {
  agentId: string;
  agent: SDKAgent;
  updatedAt: number;
}

const cursorSessions = new Map<string, CursorSession>();
const SESSION_TTL_MS = 1000 * 60 * 60 * 3;
const SERVER_LOG_PATH = path.join(DATA_DIR, "server.log");
const TOOL_LABELS: Record<string, string> = {
  read_file: "阅读代码文件",
  grep: "搜索代码",
  glob_file_search: "查找文件",
  codebase_search: "语义搜索代码",
  list_dir: "浏览目录",
  search_replace: "查看代码片段",
  run_terminal_cmd: "运行命令",
  web_search: "搜索资料",
};

let sessionMaintenanceStarted = false;

export function inferAnalysisType(question: string, logText: string): string {
  const text = `${question}\n${logText}`.toLowerCase();
  if (logText.trim() || ["exception", "error", "crash", "崩溃", "异常", "报错", "日志", "堆栈", "trace"].some((term) => text.includes(term))) {
    return "incident";
  }
  if (["review", "审查", "检查代码", "代码质量", "风险"].some((term) => text.includes(term))) {
    return "review";
  }
  if (["影响", "改动", "范围", "调用方", "依赖"].some((term) => text.includes(term))) {
    return "impact";
  }
  return "feature";
}

export function startCursorSessionMaintenance(): void {
  if (sessionMaintenanceStarted) return;
  sessionMaintenanceStarted = true;
  setInterval(() => {
    void cleanupExpiredCursorSessions();
  }, 10 * 60 * 1000).unref?.();
}

export async function analyzeWithModel(
  model: AIModel | undefined,
  question: string,
  analysisType: string,
  logText: string,
  repos: GitRepo[],
  chatSessionId = "",
  attachmentImages: AttachmentImage[] = [],
  stream?: AnalysisStreamCallbacks,
  focusDir?: string,
): Promise<AnalysisResult> {
  if (!model || !model.model_name) {
    const text = localAnalysis(question, analysisType, logText);
    stream?.onDelta?.(text);
    return { text };
  }

  return analyzeWithCursor(model, question, logText, repos, chatSessionId, attachmentImages, stream, focusDir);
}

function buildSdkUserMessage(question: string, logText: string, images: SDKImage[]): string | SDKUserMessage {
  const parts = [question.trim(), logText.trim()].filter(Boolean);
  const text = parts.join("\n\n") || " ";
  return images.length ? { text, images } : text;
}

async function analyzeWithCursor(
  model: AIModel,
  question: string,
  logText: string,
  repos: GitRepo[],
  chatSessionId: string,
  attachmentImages: AttachmentImage[],
  stream?: AnalysisStreamCallbacks,
  focusDir?: string,
): Promise<AnalysisResult> {
  const projectId = repos[0]?.project_id;
  if (!projectId) throw new Error("缺少项目信息，无法定位工作区");

  const workspacePath = projectWorkspaceRoot(projectId);
  const useCloud = shouldUseCloudRuntime();
  // 本地模式下，若指定了隔离目录，则把 cwd 收窄为「各仓库 + 该隔离目录」，
  // 避免 Agent 看到（并误读）uploads/ 下其他会话累积的历史日志。
  const cwd = !useCloud && focusDir && fs.existsSync(focusDir)
    ? buildScopedLocalCwd(projectId, repos, focusDir)
    : [workspacePath];
  const sdkImages = resolveSdkImages(useCloud, attachmentImages);
  const sdkMessage = buildSdkUserMessage(question, logText, sdkImages);
  const sessionKey = buildSessionKey(chatSessionId, model, repos, workspacePath, useCloud);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const agent = await getOrCreateCursorAgent(sessionKey, model, cwd, repos, useCloud, stream);
    let lastRunId = "";

    try {
      const final = await runAgentTurn(agent, sdkMessage, stream, true);
      lastRunId = final.runId;
      touchCursorSession(sessionKey);
      return { text: final.text, agentId: agent.agentId, runId: lastRunId, workspacePath };
    } catch (error) {
      writeServerLog("cursor_run_failed", {
        message: error instanceof Error ? error.message : String(error),
        model: model.model_name,
        workspacePath,
        useCloud,
        attempt,
        agentId: agent.agentId,
        runId: lastRunId,
      });
      await closeCursorSession(sessionKey);
      if (attempt === 0) {
        stream?.onStatus?.("分析未完成，正在重新连接 Agent 后重试...");
        continue;
      }
      throw error;
    }
  }

  throw new Error("Agent 分析失败，重试后仍未完成。");
}

interface AgentTurnResult {
  text: string;
  runId: string;
}

async function runAgentTurn(
  agent: SDKAgent,
  message: string | SDKUserMessage,
  stream: AnalysisStreamCallbacks | undefined,
  streamAnswer: boolean,
): Promise<AgentTurnResult> {
  const run = await agent.send(message);
  let accumulated = "";
  const statusMessages: string[] = [];

  if (stream) {
    for await (const streamMessage of run.stream()) {
      const update = streamMessageToUpdate(streamMessage);
      if (update.status) {
        statusMessages.push(update.status);
        stream.onStatus?.(update.status);
      }
      if (update.activity) stream.onActivity?.(update.activity);
      if (update.text && streamAnswer) {
        const delta = extractStreamDelta(accumulated, update.text);
        accumulated += delta;
        if (delta) stream.onDelta?.(delta);
      }
    }
  }

  const result = await run.wait();
  if (result.status !== "finished") {
    await logRunFailureDetails(run, result, statusMessages);
    throw new Error(formatRunFailure(result.status, statusMessages, result));
  }

  const finalText = result.result?.trim() || accumulated.trim() || "Agent 未返回分析内容。";
  if (streamAnswer) {
    const finalDelta = finalText.startsWith(accumulated) ? finalText.slice(accumulated.length) : "";
    if (finalDelta) stream?.onDelta?.(finalDelta);
  }
  return { text: finalText, runId: result.id };
}

function shouldUseCloudRuntime(): boolean {
  if (isThirdPartyModelEnabled()) return false;
  return process.env.CURSOR_AGENT_RUNTIME === "cloud" || getSetting("cursor_agent_runtime") === "cloud";
}

function resolveSdkImages(useCloud: boolean, attachmentImages: AttachmentImage[]): SDKImage[] {
  const resolved: SDKImage[] = [];
  for (const image of attachmentImages) {
    const reference = image.url.trim();
    if (!reference) continue;

    if (useCloud) {
      if (reference.startsWith("https://")) {
        resolved.push({ url: reference });
      }
      continue;
    }

    const filePath = filePathFromImageReference(reference);
    if (!filePath || !fs.existsSync(filePath)) continue;
    if (!isImageFilePath(filePath)) {
      writeServerLog("cursor_image_skipped", { reason: "not_image", filePath });
      continue;
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) {
      writeServerLog("cursor_image_skipped", { reason: "too_large", filePath, size: stat.size });
      continue;
    }

    resolved.push({
      data: fs.readFileSync(filePath).toString("base64"),
      mimeType: guessImageMimeType(filePath),
    });
  }
  return resolved;
}

function isImageFilePath(filePath: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(path.extname(filePath).toLowerCase());
}

function filePathFromImageReference(reference: string): string | null {
  if (reference.startsWith("file://")) {
    try {
      return fileURLToPath(reference);
    } catch {
      return null;
    }
  }
  if (fs.existsSync(reference)) return reference;
  return null;
}

function guessImageMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

function writeServerLog(event: string, payload: Record<string, unknown>): void {
  try {
    fs.appendFileSync(SERVER_LOG_PATH, `${JSON.stringify({ time: new Date().toISOString(), event, ...payload })}\n`, "utf8");
  } catch {
    // Logging must never break the analysis response path.
  }
}

/**
 * Build a scoped local cwd = each repo dir + the isolated focus dir.
 * Excludes the project root (and therefore the shared uploads/ tree), so the agent
 * cannot read other sessions' accumulated logs while still having full repo access.
 */
function buildScopedLocalCwd(projectId: number, repos: GitRepo[], focusDir: string): string[] {
  const workspaceRoot = projectWorkspaceRoot(projectId);
  const repoDirs = repos
    .map((repo) => repo.local_path?.trim() || path.join(workspaceRoot, repoWorkspaceSlot(repo)))
    .filter((dir) => fs.existsSync(dir));
  const roots = [...repoDirs, focusDir];
  return roots.length ? roots : [workspaceRoot];
}

function localAgentOptions(cwd: string[]) {
  return {
    cwd: cwd.length === 1 ? cwd[0]! : cwd,
    sandboxOptions: { enabled: false as const },
    settingSources: ["project" as const],
  };
}

async function getOrCreateCursorAgent(
  sessionKey: string,
  model: AIModel,
  cwd: string[],
  repos: GitRepo[],
  useCloud: boolean,
  stream?: AnalysisStreamCallbacks,
): Promise<SDKAgent> {
  const cached = cursorSessions.get(sessionKey);
  if (cached) {
    cached.updatedAt = Date.now();
    stream?.onStatus?.("已连接分析助手（继续上一轮对话）");
    return cached.agent;
  }

  const apiKey = getCursorApiKey(model);
  if (!apiKey && !isThirdPartyModelEnabled()) throw new Error("未配置 Cursor API Key");

  const thirdPartyId = isThirdPartyProvider(model.provider) ? model.id : null;
  const { Agent } = await loadCursorSdk(thirdPartyId);
  const resumed = await tryResumeCursorAgent(Agent, sessionKey, model, cwd, repos, useCloud, apiKey ?? "cursor-sdk-gateway");
  if (resumed) {
    cursorSessions.set(sessionKey, { agentId: resumed.agentId, agent: resumed, updatedAt: Date.now() });
    stream?.onStatus?.("已恢复分析助手会话");
    return resumed;
  }

  const agent = useCloud
    ? await Agent.create({
        apiKey,
        model: { id: model.model_name },
        name: "Anna Analysis",
        cloud: {
          repos: repos.map((repo) => ({ url: repo.git_url, startingRef: repo.branch || "main" })),
        },
      })
    : await Agent.create({
        apiKey,
        model: { id: model.model_name },
        name: "Anna Analysis",
        local: localAgentOptions(cwd),
      });
  persistCursorSession(sessionKey, agent.agentId);
  cursorSessions.set(sessionKey, { agentId: agent.agentId, agent, updatedAt: Date.now() });
  const readyHint = isThirdPartyProvider(model.provider)
    ? `已连接第三方分析助手（${model.model_name}）`
    : useCloud
      ? "已连接云端分析助手"
      : "分析助手已就绪";
  stream?.onStatus?.(readyHint);
  return agent;
}

async function tryResumeCursorAgent(
  Agent: typeof import("@cursor/sdk").Agent,
  sessionKey: string,
  model: AIModel,
  cwd: string[],
  repos: GitRepo[],
  useCloud: boolean,
  apiKey: string,
): Promise<SDKAgent | null> {
  const row = db.prepare("SELECT agent_id FROM cursor_agent_sessions WHERE session_key = ?").get(sessionKey) as { agent_id: string } | undefined;
  if (!row?.agent_id) return null;
  try {
    return Agent.resume(row.agent_id, {
      apiKey,
      model: { id: model.model_name },
      ...(useCloud
        ? { cloud: { repos: repos.map((repo) => ({ url: repo.git_url, startingRef: repo.branch || "main" })) } }
        : { local: localAgentOptions(cwd) }),
    });
  } catch (error) {
    writeServerLog("cursor_resume_failed", {
      sessionKey,
      agentId: row.agent_id,
      message: error instanceof Error ? error.message : String(error),
    });
    deletePersistedSession(sessionKey);
    return null;
  }
}

function persistCursorSession(sessionKey: string, agentId: string): void {
  db.prepare(`
    INSERT INTO cursor_agent_sessions(session_key, agent_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at
  `).run(sessionKey, agentId, new Date().toISOString());
}

function touchCursorSession(sessionKey: string): void {
  db.prepare("UPDATE cursor_agent_sessions SET updated_at = ? WHERE session_key = ?").run(new Date().toISOString(), sessionKey);
}

function deletePersistedSession(sessionKey: string): void {
  db.prepare("DELETE FROM cursor_agent_sessions WHERE session_key = ?").run(sessionKey);
}

function buildSessionKey(
  chatSessionId: string,
  model: AIModel,
  repos: GitRepo[],
  workspacePath: string,
  useCloud: boolean,
): string {
  const repoKey = repos
    .map((repo) => `${repo.id}:${repo.branch}`)
    .sort()
    .join("|");
  return [chatSessionId || "default", model.id, model.model_name, repoKey, workspacePath, useCloud ? "cloud" : "local"].join("::");
}

async function cleanupExpiredCursorSessions(): Promise<void> {
  const now = Date.now();
  for (const [key, session] of cursorSessions) {
    if (now - session.updatedAt <= SESSION_TTL_MS) continue;
    await disposeAgent(session.agent);
    cursorSessions.delete(key);
    deletePersistedSession(key);
  }

  const staleBefore = new Date(now - SESSION_TTL_MS).toISOString();
  const staleRows = db.prepare(`
    SELECT session_key, agent_id FROM cursor_agent_sessions WHERE updated_at < ?
  `).all(staleBefore) as Array<{ session_key: string; agent_id: string }>;
  for (const row of staleRows) {
    deletePersistedSession(row.session_key);
  }
}

async function closeCursorSession(sessionKey: string): Promise<void> {
  const session = cursorSessions.get(sessionKey);
  if (session) {
    await disposeAgent(session.agent);
    cursorSessions.delete(sessionKey);
  }
  deletePersistedSession(sessionKey);
}

/** 释放与 chat_session_id（如 feishu:fs_xxx）关联的全部 Cursor Agent 会话 */
export function releaseCursorSessionsForChat(chatSessionId: string): void {
  const id = chatSessionId.trim();
  if (!id) return;
  const prefix = `${id}::`;
  for (const key of [...cursorSessions.keys()]) {
    if (key !== id && !key.startsWith(prefix)) continue;
    const session = cursorSessions.get(key);
    cursorSessions.delete(key);
    if (session) void disposeAgent(session.agent);
  }
  db.prepare(`
    DELETE FROM cursor_agent_sessions
    WHERE session_key = ? OR session_key GLOB ?
  `).run(id, `${id}::*`);
}

async function disposeAgent(agent: SDKAgent): Promise<void> {
  const disposable = agent as SDKAgent & { [Symbol.asyncDispose]?: () => Promise<void>; close?: () => Promise<void> };
  if (typeof disposable[Symbol.asyncDispose] === "function") {
    await disposable[Symbol.asyncDispose]();
    return;
  }
  if (typeof disposable.close === "function") {
    await disposable.close();
  }
}

function streamMessageToUpdate(message: SDKMessage): {
  status?: string;
  text?: string;
  activity?: AnalysisActivity;
} {
  if (message.type === "assistant") {
    return {
      text: message.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    };
  }
  if (message.type === "thinking") {
    const text = message.text?.trim();
    return {
      status: "正在深入分析问题...",
      activity: { kind: "thinking", message: text || "正在深入分析问题..." },
    };
  }
  if (message.type === "tool_call") {
    const label = humanizeToolName(message.name);
    const pathHint = extractToolPath(message);
    const action = message.status === "running"
      ? `正在${label}`
      : message.status === "completed"
        ? `已完成${label}`
        : `${label}失败`;
    const detail = pathHint ? `${action}：${pathHint}` : action;
    return {
      status: detail,
      activity: { kind: "tool", message: detail },
    };
  }
  if (message.type === "status") {
    const text = message.message || `分析状态：${message.status}`;
    return { status: text, activity: { kind: "status", message: text } };
  }
  if (message.type === "task" && message.text) {
    return { status: message.text, activity: { kind: "status", message: message.text } };
  }
  return {};
}

function humanizeToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (TOOL_LABELS[normalized]) return TOOL_LABELS[normalized];
  return normalized.replaceAll("_", " ");
}

function extractToolPath(message: SDKMessage & { type: "tool_call" }): string | undefined {
  const payload = JSON.stringify(message);
  const patterns = [
    /"(?:path|file|filePath|target|uri)"\s*:\s*"([^"]+)"/i,
    /"(?:path|file|filePath|target|uri)"\s*:\s*'([^']+)'/i,
  ];
  for (const pattern of patterns) {
    const match = payload.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/\\\\/g, "/").split(/[/\\]/).slice(-3).join("/");
    }
  }
  return undefined;
}

function extractStreamDelta(accumulated: string, incoming: string): string {
  if (!incoming) return "";
  if (!accumulated) return incoming;
  if (incoming.startsWith(accumulated)) return incoming.slice(accumulated.length);
  if (accumulated.endsWith(incoming) || accumulated.includes(incoming)) return "";
  return incoming;
}

async function logRunFailureDetails(
  run: Awaited<ReturnType<SDKAgent["send"]>>,
  result: { id?: string; status?: string; result?: string; error?: string; message?: string },
  statusMessages: string[],
): Promise<void> {
  let conversation: unknown;
  if (typeof run.supports === "function" && run.supports("conversation")) {
    try {
      conversation = await run.conversation();
    } catch {
      conversation = undefined;
    }
  }
  writeServerLog("cursor_run_error_detail", {
    result,
    runResult: result.result,
    statusMessages,
    conversation: conversation ? JSON.stringify(conversation).slice(0, 4000) : undefined,
  });
}

function formatRunFailure(
  status: string,
  statusMessages: string[] = [],
  result?: { id?: string; result?: string; error?: string; message?: string },
): string {
  const details = [...new Set(statusMessages.map((message) => message.trim()).filter(Boolean))]
    .filter((message) => !message.includes("会话已") && !message.includes("已连接"))
    .slice(-3)
    .join("；");
  const runId = result?.id ? `运行 ID：${result.id}。` : "";
  const sdkMessage = result?.error || result?.message || result?.result;
  const sdkHint = sdkMessage && !sdkMessage.includes("RUNNING") ? `详情：${String(sdkMessage).slice(0, 300)}。` : "";
  const tail = details || "请稍后重试；若持续失败，请清空对话、重新同步代码，并改用「Composer 2.5」模型。";
  return `分析未完成（${status}）。${runId}${sdkHint}${tail}`;
}

export function getCursorApiKey(model?: AIModel): string | undefined {
  if (isThirdPartyModelEnabled()) {
    const envKey = process.env.CURSOR_API_KEY?.trim();
    if (envKey) return envKey;
    const settingKey = getSetting("cursor_api_key").trim();
    if (settingKey) return settingKey;
    return "cursor-sdk-gateway";
  }

  const envKey = process.env.CURSOR_API_KEY?.trim();
  if (envKey) return envKey;

  const settingKey = getSetting("cursor_api_key").trim();
  if (settingKey) return settingKey;

  const legacyKey = model?.api_key?.trim() || getLegacyCursorApiKey();
  if (legacyKey) {
    setSetting("cursor_api_key", legacyKey);
    return legacyKey;
  }
  return undefined;
}

function getLegacyCursorApiKey(): string {
  const row = db.prepare(`
    SELECT api_key FROM ai_models
    WHERE provider = 'cursor' AND api_key != ''
    ORDER BY id DESC
    LIMIT 1
  `).get() as { api_key: string } | undefined;
  return row?.api_key?.trim() ?? "";
}

function localAnalysis(question: string, analysisType: string, logText: string): string {
  const lines = [
    "## 结论摘要",
    `当前问题：${question}`,
    `系统判断类型：${analysisType}`,
    "",
    "## 说明",
    "- 未配置可用的 Cursor 模型，无法调用分析助手。",
    "- 请先在管理后台配置 Cursor API Key 或启用第三方模型，并在管理后台手动同步代码（或等待定时自动同步）后重试。",
  ];

  if (logText.trim()) {
    lines.push("", "## 日志线索");
    lines.push(logText.slice(0, 1000));
  }

  lines.push("", "## 下一步");
  lines.push("- 在管理后台确认已配置 Cursor API Key，并重新发送问题。");
  return lines.join("\n");
}
