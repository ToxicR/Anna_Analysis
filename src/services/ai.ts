import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type SDKAgent, type SDKImage, type SDKMessage, type SDKUserMessage } from "@cursor/sdk";
import { db, getSetting, setSetting } from "../db.js";
import { DATA_DIR } from "../paths.js";
import type { AIModel, CodeChunk, GitRepo } from "../types.js";
import { formatContext } from "./code.js";
import { projectWorkspaceRoot, repoWorkspaceSlot } from "./workspace.js";

export interface AnalysisResult {
  text: string;
  agentId?: string;
  runId?: string;
  workspacePath?: string;
}

const TWO_PHASE_ENABLED = process.env.ANALYSIS_TWO_PHASE !== "0";

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
const RULE_FILE_CANDIDATES = [
  ".cursor/rules",
  ".cursorrules",
  "AGENTS.md",
  ".cursor/AGENTS.md",
];

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
  chunks: CodeChunk[],
  logText: string,
  repos: GitRepo[],
  conversationContext = "",
  chatSessionId = "",
  outputMode: OutputMode = "non_developer",
  attachmentImages: AttachmentImage[] = [],
  stream?: AnalysisStreamCallbacks,
  analysisScope = "",
): Promise<AnalysisResult> {
  if (!model || !model.model_name) {
    const text = localAnalysis(question, analysisType, chunks, logText);
    stream?.onDelta?.(text);
    return { text };
  }

  return analyzeWithCursor(
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
}

async function analyzeWithCursor(
  model: AIModel,
  question: string,
  analysisType: string,
  chunks: CodeChunk[],
  logText: string,
  repos: GitRepo[],
  conversationContext: string,
  chatSessionId: string,
  outputMode: OutputMode,
  attachmentImages: AttachmentImage[],
  stream?: AnalysisStreamCallbacks,
  analysisScope = "",
): Promise<AnalysisResult> {
  const projectId = repos[0]?.project_id;
  if (!projectId) throw new Error("缺少项目信息，无法定位工作区");

  const workspacePath = projectWorkspaceRoot(projectId);
  const useCloud = shouldUseCloudRuntime();
  const cwd = [workspacePath];
  const sdkImages = resolveSdkImages(useCloud, attachmentImages);
  if (attachmentImages.length && !sdkImages.length) {
    stream?.onStatus?.(useCloud
      ? "云端模式仅支持 https 图片链接，将改为通过附件路径文字说明分析..."
      : "图片未能直接注入 Agent，将改为通过工作区路径读取...");
  }
  const sessionKey = buildSessionKey(chatSessionId, outputMode, model, repos, workspacePath, useCloud);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const agent = await getOrCreateCursorAgent(sessionKey, model, cwd, repos, useCloud, stream);
    let lastRunId = "";

    try {
      let researchNotes = "";
      if (TWO_PHASE_ENABLED) {
        stream?.onStatus?.("第 1 阶段：在仓库中调研并收集证据...");
        const research = await runAgentTurn(
          agent,
          buildResearchPrompt(question, analysisType, chunks, logText, repos, conversationContext, analysisScope, workspacePath),
          sdkImages,
          stream,
          false,
        );
        lastRunId = research.runId;
        researchNotes = research.text;
        writeServerLog("cursor_research_done", { runId: research.runId, agentId: agent.agentId, workspacePath, length: researchNotes.length });
        stream?.onStatus?.("第 2 阶段：根据调研结果撰写结论...");
      }

      const finalPrompt = TWO_PHASE_ENABLED
        ? buildFinalPrompt(question, analysisType, researchNotes, logText, repos, conversationContext, outputMode, analysisScope, workspacePath)
        : buildCursorPrompt(question, analysisType, chunks, logText, repos, conversationContext, outputMode, analysisScope, workspacePath);

      const final = await runAgentTurn(agent, finalPrompt, TWO_PHASE_ENABLED ? [] : sdkImages, stream, true);
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
  prompt: string,
  images: SDKImage[],
  stream: AnalysisStreamCallbacks | undefined,
  streamAnswer: boolean,
): Promise<AgentTurnResult> {
  const message: string | SDKUserMessage = images.length ? { text: prompt, images } : prompt;
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
  if (!apiKey) throw new Error("未配置 Cursor API Key");

  const resumed = await tryResumeCursorAgent(sessionKey, model, cwd, repos, useCloud, apiKey);
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
          repos: repos.map((repo) => ({ url: repo.git_url, ref: repo.branch || "main" })),
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
  stream?.onStatus?.(useCloud ? "已连接云端分析助手" : "分析助手已就绪，开始阅读代码");
  return agent;
}

async function tryResumeCursorAgent(
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
        ? { cloud: { repos: repos.map((repo) => ({ url: repo.git_url, ref: repo.branch || "main" })) } }
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
  outputMode: OutputMode,
  model: AIModel,
  repos: GitRepo[],
  workspacePath: string,
  useCloud: boolean,
): string {
  const repoKey = repos
    .map((repo) => `${repo.id}:${repo.branch}`)
    .sort()
    .join("|");
  return [chatSessionId || "default", outputMode, model.id, model.model_name, repoKey, workspacePath, useCloud ? "cloud" : "local"].join("::");
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

function workspaceLayoutSection(workspacePath: string, repos: GitRepo[]): string {
  const manifest = path.join(workspacePath, "WORKSPACE.md");
  const slots = repos.map((repo) => `- \`${repoWorkspaceSlot(repo)}/\` → ${repo.name}（${repo.branch || "main"}）`).join("\n");
  const manifestText = fs.existsSync(manifest) ? fs.readFileSync(manifest, "utf8").slice(0, 2000) : "";
  return `统一工作区根目录：${workspacePath}
子目录：
${slots}
${manifestText ? `\nWORKSPACE.md：\n${manifestText}\n` : ""}`;
}

function scopeSection(analysisScope: string): string {
  const scope = analysisScope.trim();
  if (!scope) return "";
  return `\n用户指定优先搜索范围（类似 Cursor @ 文件夹，请先从这里查起）：\n${scope}\n`;
}

function attachmentSection(logText: string, workspacePath: string): string {
  if (!logText.trim()) return "";
  return `\n用户附件（位于工作区 uploads/ 下，请用 read_file 等工具直接读取，不要只看摘要）：\n${logText.slice(0, 12000)}\n工作区根目录：${workspacePath}\n`;
}

function loadProjectRules(repos: GitRepo[]): string {
  const sections: string[] = [];
  for (const repo of repos) {
    const repoPath = repo.local_path;
    if (!repoPath) continue;
    for (const candidate of RULE_FILE_CANDIDATES) {
      const fullPath = path.join(repo.local_path, candidate);
      if (!fs.existsSync(fullPath)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          const files = fs.readdirSync(fullPath).filter((name) => name.endsWith(".md") || name.endsWith(".mdc"));
          for (const file of files.slice(0, 5)) {
            const content = fs.readFileSync(path.join(fullPath, file), "utf8").trim();
            if (content) sections.push(`【${repo.name} / ${candidate}/${file}】\n${content.slice(0, 4000)}`);
          }
          continue;
        }
        const content = fs.readFileSync(fullPath, "utf8").trim();
        if (content) sections.push(`【${repo.name} / ${candidate}】\n${content.slice(0, 6000)}`);
      } catch {
        // Skip unreadable rule files.
      }
    }
  }
  if (!sections.length) return "";
  return `\n项目规则（与 Cursor IDE 一致，分析时请遵守）：\n${sections.join("\n\n")}\n`;
}

function buildResearchPrompt(
  question: string,
  analysisType: string,
  chunks: CodeChunk[],
  logText: string,
  repos: GitRepo[],
  conversationContext: string,
  analysisScope: string,
  workspacePath: string,
): string {
  const prefetchSection = chunks.length
    ? `\n系统预检索线索（仅供参考）：\n${formatContext(chunks)}\n`
    : "";
  return `你是 Anna Analysis 的代码调研助手（第 1 阶段：只调研，不写最终业务结论）。请在统一工作区内主动搜索、打开、交叉阅读文件，像 Cursor IDE 一样工作。禁止改文件。
${loadProjectRules(repos)}
分析类型：${analysisType}
${workspaceLayoutSection(workspacePath, repos)}
${scopeSection(analysisScope)}
用户问题：${question}
${conversationContext.trim() ? `\n对话上下文：\n${conversationContext.slice(-12000)}\n` : ""}
${attachmentSection(logText, workspacePath)}
${prefetchSection}

本阶段输出必须使用以下 Markdown 标题（不要输出面向业务的最终结论卡片）：
## 调研记录
## 已读文件
## 搜索词与发现
## 待验证问题

要求：
- 「已读文件」列出真实相对路径，最多 15 条。
- 「搜索词与发现」写清已确认事实与推测。
- 有附件时必须先读取 uploads/ 下的文件。`;
}

function buildFinalPrompt(
  question: string,
  analysisType: string,
  researchNotes: string,
  logText: string,
  repos: GitRepo[],
  conversationContext: string,
  outputMode: OutputMode,
  analysisScope: string,
  workspacePath: string,
): string {
  return `${buildCursorPrompt(question, analysisType, [], logText, repos, conversationContext, outputMode, analysisScope, workspacePath)}

以下是第 1 阶段调研记录（结论必须以此为准，不得脱离）：
${researchNotes.slice(0, 16000)}`;
}

function buildCursorPrompt(
  question: string,
  analysisType: string,
  chunks: CodeChunk[],
  logText: string,
  repos: GitRepo[],
  conversationContext: string,
  outputMode: OutputMode,
  analysisScope: string,
  workspacePath: string,
): string {
  const conversationSection = conversationContext.trim()
    ? `\n对话上下文（理解“继续、它、这个问题”等指代）：\n${conversationContext.slice(-12000)}\n`
    : "";
  const prefetchSection = chunks.length
    ? `\n系统预检索线索（仅供参考，你必须主动打开、搜索、交叉验证实际文件）：\n${formatContext(chunks)}\n`
    : `\n请直接在统一工作区内搜索并阅读相关文件。\n`;
  const projectRules = loadProjectRules(repos);
  const evidencePriority = logText.trim()
    ? `证据优先级：附件为主、代码为辅；先读附件中的现象/报错/截图，再用代码验证与定位。`
    : `证据优先级：以仓库代码为准，主动检索与阅读，不要提示用户“缺少日志”。`;
  const troubleshootingRule =
    analysisType === "incident"
      ? "问题排查类：结尾增加「建议下一步」最多 3 条，用非技术人员能执行的语言描述。"
      : "非排查类：不要输出泛泛的“下一步建议”，除非用户明确要求。";
  const outputModeRule =
    outputMode === "non_developer"
      ? `受众：非研发（产品/测试/运营/项目）。默认不贴代码块；用「现象、原因、影响、怎么验证、怎么处理」；技术词要白话解释；先给结论再展开。`
      : `受众：研发。可给文件路径、方法名、必要短代码片段；区分「已确认」与「推测」。`;

  return `你是 Anna Analysis 的代码分析助手，工作方式应对齐 Cursor IDE：在仓库内主动搜索、打开、交叉阅读文件，再给出结论。只读分析，禁止改文件、禁止提交、禁止破坏性命令。
${projectRules}
分析类型：${analysisType}
${outputModeRule}

${workspaceLayoutSection(workspacePath, repos)}
${scopeSection(analysisScope)}

用户问题：${question}
${conversationSection}
${attachmentSection(logText, workspacePath)}
${prefetchSection}
${evidencePriority}

工作流程（必须执行）：
1. 根据问题在仓库内搜索/定位相关模块（不要只依赖预检索片段）。
2. 打开关键文件阅读，建立实现链路或故障链路。
3. 有附件时，先用附件事实，再用代码印证。
4. 证据不足时明确说缺什么，不要编造。

输出格式（Markdown，章节标题必须完全一致，便于网页卡片展示）：
- 已找到相关内容时，按顺序输出且仅使用这些二级标题：
  ## 结论
  ## 关键位置
  ## 流程或原因说明
  ## 依据与不确定点
${analysisType === "incident" ? "  ## 建议下一步" : ""}
- 未找到时，按顺序输出：
  ## 结论
  ## 已排除的范围
  ## 还不确定什么
- 「结论」第一段必须直接回答问题；默认 800 字内；每节最多 5 条 bullet。
${troubleshootingRule}`;
}

export function getCursorApiKey(model?: AIModel): string | undefined {
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

function localAnalysis(question: string, analysisType: string, chunks: CodeChunk[], logText: string): string {
  const lines = [
    "## 结论摘要",
    `当前问题：${question}`,
    `系统判断类型：${analysisType}`,
    "",
    "## 相关代码文件和关键方法",
  ];

  if (!chunks.length) {
    lines.push("- 未检索到直接相关的代码片段，请先确认已选择仓库并同步代码。");
  } else {
    chunks.slice(0, 8).forEach((chunk) => {
      lines.push(`- ${chunk.file_path}: ${chunk.language || "相关片段"}`);
    });
  }

  lines.push("", "## 实现流程或问题原因");
  lines.push(
    chunks.length
      ? "已根据当前索引列出最相关代码入口。请配置 Cursor API Key 后重新分析，以获得接近 Cursor 的跨文件阅读结论。"
      : "缺少可引用代码上下文，无法给出可靠结论。",
  );

  if (logText.trim()) {
    lines.push("", "## 日志线索");
    lines.push(logText.slice(0, 1000));
  }

  lines.push("", "## 下一步");
  lines.push("- 在管理后台确认已配置 Cursor API Key，并重新发送问题。");
  return lines.join("\n");
}
