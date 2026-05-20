import { Agent } from "@cursor/sdk";
import type { AIModel, CodeChunk, GitRepo } from "../types.js";
import { formatContext } from "./code.js";

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
): Promise<string> {
  if (!model || !model.provider || !model.model_name) {
    return localAnalysis(question, analysisType, chunks, logText);
  }

  if (model.provider === "cursor") {
    return analyzeWithCursor(model, question, analysisType, chunks, logText, repos);
  }

  if (model.provider === "openai-compatible") {
    return analyzeWithOpenAICompatible(model, question, analysisType, chunks, logText);
  }

  return localAnalysis(question, analysisType, chunks, logText);
}

async function analyzeWithCursor(
  model: AIModel,
  question: string,
  analysisType: string,
  chunks: CodeChunk[],
  logText: string,
  repos: GitRepo[],
): Promise<string> {
  const cwd = repos.map((repo) => repo.local_path).filter(Boolean);
  if (!cwd.length) {
    throw new Error("未找到本地仓库路径，请先同步代码后再分析");
  }

  const agent = await Agent.create({
    apiKey: model.api_key || undefined,
    model: { id: model.model_name },
    name: "Anna Analysis",
    local: {
      cwd: cwd.length === 1 ? cwd[0] : cwd,
      sandboxOptions: { enabled: true },
      settingSources: ["project"],
    },
  });

  try {
    const prompt = buildCursorPrompt(question, analysisType, chunks, logText, repos);
    const run = await agent.send(prompt, { local: { force: true } });
    const result = await run.wait();
    if (result.status !== "finished") {
      throw new Error(`Cursor 分析未完成，状态：${result.status}`);
    }
    return result.result?.trim() || "Cursor Agent 未返回分析内容。";
  } finally {
    agent.close();
  }
}

async function analyzeWithOpenAICompatible(
  model: AIModel,
  question: string,
  analysisType: string,
  chunks: CodeChunk[],
  logText: string,
): Promise<string> {
  if (!model.base_url || !model.api_key) {
    return localAnalysis(question, analysisType, chunks, logText);
  }

  let url = model.base_url.replace(/\/+$/, "");
  if (!url.endsWith("/chat/completions")) {
    url = `${url}/chat/completions`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${model.api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model.model_name,
      messages: [
        {
          role: "system",
          content: [
            "你是资深研发代码分析助手。",
            "日志是可选输入；没有日志时，直接基于代码上下文分析，不要要求用户上传日志。",
            "如果代码上下文不足，说明缺少哪些代码线索，并给出可继续检索的关键词。",
            "回答必须引用文件路径，区分事实和推测。",
          ].join(""),
        },
        { role: "user", content: buildPrompt(question, analysisType, chunks, logText) },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    throw new Error(`AI 模型调用失败：${response.status} ${await response.text()}`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
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

function buildPrompt(question: string, analysisType: string, chunks: CodeChunk[], logText: string): string {
  const logSection = logText.trim() ? `\n日志内容：\n${logText.slice(0, 12000)}\n` : "";
  return `分析类型：${analysisType}

用户问题：${question}
${logSection}
检索到的代码上下文：
${formatContext(chunks)}

请输出：
1. 结论摘要
2. 相关代码文件和关键方法
3. 实现流程或问题根因
4. 事实依据和推测项
5. 下一步排查/继续阅读建议

注意：
- 如果没有日志内容，不要提“缺少日志”，直接按代码分析。
- 如果代码上下文没有命中，不要把原因归结为未上传日志。`;
}

function localAnalysis(question: string, analysisType: string, chunks: CodeChunk[], logText: string): string {
  const lines = [
    "## 结论摘要",
    "当前未配置可调用的 AI 模型，系统已基于关键词检索返回本地代码摘要。",
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
    "- 配置 provider 为 `cursor` 的模型后，可以让 Cursor Agent 直接在仓库目录中继续阅读代码并给出完整分析。",
    "- 如果当前问题是功能实现分析，不需要上传日志；只有排查运行异常时才需要日志。",
  );

  return lines.join("\n");
}
