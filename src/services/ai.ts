import { Agent, type SDKAgent, type SDKMessage } from "@cursor/sdk";
import { db, getSetting, setSetting } from "../db.js";
import type { AIModel, CodeChunk, GitRepo } from "../types.js";
import { formatContext } from "./code.js";

export interface AnalysisStreamCallbacks {
  onStatus?: (message: string) => void;
  onDelta?: (text: string) => void;
}

interface CursorSession {
  agentId: string;
  agent: SDKAgent;
  updatedAt: number;
}

const cursorSessions = new Map<string, CursorSession>();
const SESSION_TTL_MS = 1000 * 60 * 60 * 3;

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

export async function analyzeWithModel(
  model: AIModel | undefined,
  question: string,
  analysisType: string,
  chunks: CodeChunk[],
  logText: string,
  repos: GitRepo[],
  conversationContext = "",
  chatSessionId = "",
  stream?: AnalysisStreamCallbacks,
): Promise<string> {
  if (!model || !model.model_name) {
    const result = localAnalysis(question, analysisType, chunks, logText);
    stream?.onDelta?.(result);
    return result;
  }

  return analyzeWithCursor(model, question, analysisType, chunks, logText, repos, conversationContext, chatSessionId, stream);
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
  stream?: AnalysisStreamCallbacks,
): Promise<string> {
  const cwd = repos.map((repo) => repo.local_path).filter(Boolean);
  if (!cwd.length) {
    throw new Error("未找到本地仓库路径，请先同步代码后再分析");
  }

  const sessionKey = buildSessionKey(chatSessionId, model, repos, cwd);
  const agent = await getOrCreateCursorAgent(sessionKey, model, cwd, stream);

  try {
    const run = await agent.send(buildCursorPrompt(question, analysisType, chunks, logText, repos, conversationContext), {
      local: { force: true },
    });

    if (stream) {
      let accumulated = "";
      for await (const message of run.stream()) {
        const update = streamMessageToText(message);
        if (update.status) stream.onStatus?.(update.status);
        if (update.text) {
          const delta = extractStreamDelta(accumulated, update.text);
          accumulated += delta;
          if (delta) stream.onDelta?.(delta);
        }
      }

      const result = await run.wait();
      if (result.status !== "finished") {
        throw new Error(`Agent 分析未完成，状态：${result.status}`);
      }
      const finalText = result.result?.trim() || accumulated.trim() || "Agent 未返回分析内容。";
      const finalDelta = finalText.startsWith(accumulated) ? finalText.slice(accumulated.length) : "";
      if (finalDelta) stream.onDelta?.(finalDelta);
      return finalText;
    }

    const result = await run.wait();
    if (result.status !== "finished") {
      throw new Error(`Agent 分析未完成，状态：${result.status}`);
    }
    return result.result?.trim() || "Agent 未返回分析内容。";
  } finally {
    const session = cursorSessions.get(sessionKey);
    if (session) session.updatedAt = Date.now();
    cleanupExpiredCursorSessions();
  }
}

async function getOrCreateCursorAgent(
  sessionKey: string,
  model: AIModel,
  cwd: string[],
  stream?: AnalysisStreamCallbacks,
): Promise<SDKAgent> {
  const existing = cursorSessions.get(sessionKey);
  if (existing) {
    existing.updatedAt = Date.now();
    stream?.onStatus?.("Agent 会话已连接");
    return existing.agent;
  }

  const agent = await Agent.create({
    apiKey: getCursorApiKey(model),
    model: { id: model.model_name },
    name: "Anna Analysis",
    local: {
      cwd: cwd.length === 1 ? cwd[0] : cwd,
      sandboxOptions: { enabled: false },
      settingSources: ["project"],
    },
  });
  cursorSessions.set(sessionKey, { agentId: agent.agentId, agent, updatedAt: Date.now() });
  stream?.onStatus?.("Agent 会话已创建");
  return agent;
}

function buildSessionKey(chatSessionId: string, model: AIModel, repos: GitRepo[], cwd: string[]): string {
  const repoKey = repos
    .map((repo) => `${repo.id}:${repo.branch}:${repo.local_path}`)
    .sort()
    .join("|");
  return [chatSessionId || "default", model.id, model.model_name, repoKey, cwd.join("|")].join("::");
}

function cleanupExpiredCursorSessions(): void {
  const now = Date.now();
  for (const [key, session] of cursorSessions) {
    if (now - session.updatedAt <= SESSION_TTL_MS) continue;
    void session.agent.close();
    cursorSessions.delete(key);
  }
}

function streamMessageToText(message: SDKMessage): { status?: string; text?: string } {
  if (message.type === "assistant") {
    return {
      text: message.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    };
  }
  if (message.type === "thinking" && message.text) {
    return { status: "Agent 正在思考..." };
  }
  if (message.type === "tool_call") {
    const action = message.status === "running" ? "正在使用工具" : message.status === "completed" ? "工具执行完成" : "工具执行失败";
    return { status: `${action}：${message.name}` };
  }
  if (message.type === "status") {
    return { status: message.message || `Agent 状态：${message.status}` };
  }
  if (message.type === "task" && message.text) {
    return { status: message.text };
  }
  return {};
}

function extractStreamDelta(accumulated: string, incoming: string): string {
  if (!incoming) return "";
  if (!accumulated) return incoming;
  if (incoming.startsWith(accumulated)) return incoming.slice(accumulated.length);
  if (accumulated.endsWith(incoming) || accumulated.includes(incoming)) return "";
  return incoming;
}

function buildCursorPrompt(
  question: string,
  analysisType: string,
  chunks: CodeChunk[],
  logText: string,
  repos: GitRepo[],
  conversationContext: string,
): string {
  const repoList = repos.map((repo) => `- ${repo.name}: ${repo.local_path} (${repo.branch})`).join("\n");
  const logSection = logText.trim() ? `\n日志内容：\n${logText.slice(0, 12000)}\n` : "";
  const conversationSection = conversationContext.trim()
    ? `\n本轮对话上下文（用于理解“继续、上一轮、下一步、它、这个问题”等指代）：\n${conversationContext.slice(-12000)}\n`
    : "";
  const troubleshootingRule =
    analysisType === "incident"
      ? "- 如果是问题排查，最后给“下一步排查”，最多 3 条。"
      : "- 不输出“下一步建议”或泛泛排查建议，除非用户明确要求。";

  return `你是 Anna Analysis 的代码分析 Agent。请只读分析代码，不要修改文件、不要提交代码、不要执行破坏性命令。
分析类型：${analysisType}

参与分析的仓库：
${repoList}

用户问题：${question}
${conversationSection}
${logSection}
当前系统本地检索到的候选代码片段：
${formatContext(chunks)}

请根据仓库里的最新代码继续阅读必要文件，先判断用户问的目标功能/概念是否在代码中直接存在。

如果目标功能/概念未命中，必须按“未命中格式”输出：
## 结论
- 直接说明“未发现/未确认存在该功能”，1-3 句话。
## 排除依据
- 最多 5 条，只列用于排除的搜索词、文件范围或相近但不等价的代码。
## 不确定项
- 只列还不能完全排除的外部线索，例如后端配置、远程下发字段、未同步仓库。

未命中时的禁止项：
- 不要输出“关键代码”章节。
- 不要输出“实现链路”章节。
- 不要贴大段代码块。
- 不要把相近但不等价的代码写成目标功能实现。

如果目标功能/概念已明确命中，再按“命中格式”输出：
## 结论
## 关键代码
## 实现链路
## 依据与不确定项

通用风格：
- 结论优先，第一段直接回答用户问题，1-3 句话。
- 默认控制在 800 字以内。
- 只回答用户问的点，不扩展无关背景。
- 不使用复杂表格。
- 每节最多 5 条。
- 命中时，关键代码最多列 5 个文件/方法，必须引用实际文件路径。
- 命中时，实现链路最多 5 步。
- 区分“代码已确认”和“推测”。
- 如果证据不足，只说明缺失的关键线索，不展开长篇假设。
- 没有日志内容时，不要说缺少日志，直接按代码分析。
${troubleshootingRule}

硬性要求：
- 没有日志内容时，不要说缺少日志，直接按代码分析。
- 命中或排除依据必须引用实际文件路径、搜索范围或明确搜索词。
- 不要输出与问题无关的模块介绍。`;
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
      ? "已根据当前索引列出最相关代码入口。建议切换到 Cursor 模型以便继续跨文件阅读和推理。"
      : "缺少可引用代码上下文，无法给出可靠结论。",
  );

  if (logText.trim()) {
    lines.push("", "## 日志线索");
    lines.push(logText.slice(0, 1000));
  }

  lines.push("", "## 下一步排查/修复建议");
  lines.push("- 选择 Cursor 模型后重新发送问题，让 Agent 结合仓库代码继续分析。");
  return lines.join("\n");
}
