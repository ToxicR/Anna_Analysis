import { Agent, type SDKMessage } from "@cursor/sdk";
import { db, getSetting, setSetting } from "../db.js";
import type { AIModel, CodeChunk, GitRepo } from "../types.js";
import { formatContext } from "./code.js";

export interface AnalysisStreamCallbacks {
  onStatus?: (message: string) => void;
  onDelta?: (text: string) => void;
}

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
  stream?: AnalysisStreamCallbacks,
): Promise<string> {
  if (!model || !model.model_name) {
    const result = localAnalysis(question, analysisType, chunks, logText);
    stream?.onDelta?.(result);
    return result;
  }

  return analyzeWithCursor(model, question, analysisType, chunks, logText, repos, stream);
}

async function analyzeWithCursor(
  model: AIModel,
  question: string,
  analysisType: string,
  chunks: CodeChunk[],
  logText: string,
  repos: GitRepo[],
  stream?: AnalysisStreamCallbacks,
): Promise<string> {
  const cwd = repos.map((repo) => repo.local_path).filter(Boolean);
  if (!cwd.length) {
    throw new Error("未找到本地仓库路径，请先同步代码后再分析");
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

  try {
    const run = await agent.send(buildCursorPrompt(question, analysisType, chunks, logText, repos), { local: { force: true } });

    if (stream) {
      let accumulated = "";
      for await (const message of run.stream()) {
        const update = streamMessageToText(message);
        if (update.status) stream.onStatus?.(update.status);
        if (update.text) {
          const delta = toDelta(accumulated, update.text);
          accumulated = update.text;
          if (delta) stream.onDelta?.(delta);
        }
      }

      const result = await run.wait();
      if (result.status !== "finished") {
        throw new Error(`Cursor 分析未完成，状态：${result.status}`);
      }
      const finalText = result.result?.trim() || accumulated.trim() || "Cursor Agent 未返回分析内容。";
      const finalDelta = toDelta(accumulated, finalText);
      if (finalDelta) stream.onDelta?.(finalDelta);
      return finalText;
    }

    const result = await run.wait();
    if (result.status !== "finished") {
      throw new Error(`Cursor 分析未完成，状态：${result.status}`);
    }
    return result.result?.trim() || "Cursor Agent 未返回分析内容。";
  } finally {
    agent.close();
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
    return { status: "Cursor Agent 正在思考..." };
  }
  if (message.type === "tool_call") {
    const action = message.status === "running" ? "正在使用工具" : message.status === "completed" ? "工具执行完成" : "工具执行失败";
    return { status: `${action}：${message.name}` };
  }
  if (message.type === "status") {
    return { status: message.message || `Cursor Agent 状态：${message.status}` };
  }
  if (message.type === "task" && message.text) {
    return { status: message.text };
  }
  return {};
}

function toDelta(previous: string, next: string): string {
  if (!next) return "";
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  if (previous.includes(next)) return "";
  return `\n\n${next}`;
}

function buildCursorPrompt(
  question: string,
  analysisType: string,
  chunks: CodeChunk[],
  logText: string,
  repos: GitRepo[],
): string {
  const repoList = repos.map((repo) => `- ${repo.name}: ${repo.local_path} (${repo.branch})`).join("\n");
  const logSection = logText.trim() ? `\n日志内容：\n${logText.slice(0, 12000)}\n` : "";
  return `你是 Anna Analysis 的代码分析 Agent。请只读分析代码，不要修改文件、不要提交代码、不要执行破坏性命令。

分析类型：${analysisType}

参与分析的仓库：
${repoList}

用户问题：
${question}
${logSection}
当前系统本地检索到的候选代码片段：
${formatContext(chunks)}

请你根据仓库里的最新代码继续阅读必要文件，然后输出：
1. 结论摘要
2. 相关代码文件和关键方法
3. 实现流程或问题根因
4. 事实依据和推测项
5. 下一步排查/继续阅读建议

要求：
- 没有日志内容时，不要说缺少日志，直接按代码分析。
- 必须引用实际文件路径。
- 区分已从代码确认的事实与基于上下文的推测。
- 输出 Markdown，但避免复杂表格，优先使用清晰列表。`;
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
    "当前未配置可调用的 Cursor 模型，系统已基于关键词检索返回本地代码摘要。",
    "",
    `- 分析类型：${analysisType}`,
    `- 问题：${question || "未填写问题"}`,
  ];

  if (logText.trim()) {
    lines.push(`- 日志：已上传，长度 ${logText.length} 字符`);
  }

  lines.push("", "## 命中的代码文件");
  if (chunks.length) {
    for (const chunk of chunks) {
      const preview = chunk.content.trim().replace(/\s+/g, " ").slice(0, 260);
      lines.push(`- \`${chunk.file_path}\`：${preview}`);
    }
  } else {
    lines.push("- 未命中代码片段。建议换用更接近代码命名的关键词，例如页面类名、字段名、接口名、英文单词或具体 UI 文案。");
  }

  lines.push(
    "",
    "## 下一步建议",
    "- 配置 Cursor 模型后，可以让 Cursor Agent 直接在仓库目录中继续阅读代码并给出完整分析。",
    "- 如果当前问题是功能实现分析，不需要上传日志；只有排查运行异常时才需要日志。",
  );

  return lines.join("\n");
}
