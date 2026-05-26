import { db } from "../db.js";
import type { CodeChunk, GitRepo } from "../types.js";
import { searchCodeFts } from "./code-fts.js";
import {
  copyAttachmentsToWorkspace,
  projectWorkspaceRoot,
  repoWorkspaceSlot,
  resolveAnalysisCwd,
  sessionUploadsDir,
  syncReposToWorkspace,
  validateReposForAnalysis,
} from "./workspace.js";

export {
  copyAttachmentsToWorkspace,
  projectWorkspaceRoot,
  repoWorkspaceSlot,
  resolveAnalysisCwd,
  sessionUploadsDir,
  syncReposToWorkspace,
  validateReposForAnalysis,
};

export async function syncRepo(repo: GitRepo, accessToken = "") {
  const results = await syncReposToWorkspace(repo.project_id, [repo], accessToken);
  const result = results[0]!;
  return {
    local_path: result.local_path,
    indexed_chunks: result.indexed_chunks,
    workspace_path: projectWorkspaceRoot(repo.project_id),
    file_count: result.file_count,
  };
}

export function searchCodeForAnalysis(repoIds: number[], query: string, analysisType: string): CodeChunk[] {
  const limit = analysisType === "incident" ? 12 : analysisType === "feature" ? 0 : 6;
  if (!limit) return [];
  return searchCode(repoIds, query, limit);
}

export function searchCode(repoIds: number[], query: string, limit = 8): CodeChunk[] {
  const terms = extractTerms(query);
  if (!terms.length || !repoIds.length) return [];

  const ftsResults = searchCodeFts(repoIds, terms, limit);
  if (ftsResults?.length) return ftsResults;

  const placeholders = repoIds.map(() => "?").join(",");
  const candidates = db.prepare(`
    SELECT * FROM code_chunks
    WHERE repo_id IN (${placeholders})
    LIMIT 5000
  `).all(...repoIds) as CodeChunk[];

  const scored: Array<{ score: number; chunk: CodeChunk }> = [];
  for (const chunk of candidates) {
    const haystack = `${chunk.file_path}\n${chunk.content}`.toLowerCase();
    const pathLower = chunk.file_path.toLowerCase();
    const score = terms.reduce((sum, term) => {
      const lower = term.toLowerCase();
      const inPath = pathLower.includes(lower) ? 4 : 0;
      return sum + inPath + countOccurrences(haystack, lower);
    }, 0);
    if (score > 0) scored.push({ score, chunk });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((item) => item.chunk);
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0;
  return text.split(term).length - 1;
}

function extractTerms(text: string): string[] {
  const stackLike = text.match(/[A-Za-z_][\w.$]{2,}/g) ?? [];
  const chinese = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const expanded = expandChineseTerms(text);
  const seen = new Set<string>();
  const output: string[] = [];

  for (const rawTerm of [...stackLike, ...chinese, ...expanded]) {
    const term = rawTerm.trim().replace(/\.+$/, "");
    const key = term.toLowerCase();
    if (term && !seen.has(key)) {
      seen.add(key);
      output.push(term);
    }
  }
  return output.slice(0, 60);
}

function expandChineseTerms(text: string): string[] {
  const dictionary: Record<string, string[]> = {
    "首页": ["home", "main", "index", "dashboard"],
    "温度": ["temperature", "temp", "thermal", "degree"],
    "显示": ["display", "show", "render", "view", "text"],
    "页面": ["page", "activity", "fragment", "view", "screen"],
    "支付": ["pay", "payment", "paid"],
    "回调": ["callback", "notify", "notification"],
    "订单": ["order", "orderId"],
    "登录": ["login", "signin", "auth"],
    "鉴权": ["auth", "authorize", "permission"],
    "用户": ["user", "account"],
    "异常": ["exception", "error"],
    "空指针": ["null", "NullPointerException"],
    "接口": ["api", "controller", "endpoint"],
    "配置": ["config", "properties", "yaml"],
    "数据库": ["database", "repository", "mapper", "dao"],
    "缓存": ["cache", "redis"],
    "消息": ["message", "mq", "kafka", "rabbit"],
    "定时": ["schedule", "scheduler", "cron", "job"],
  };

  const expanded: string[] = [];
  for (const [keyword, terms] of Object.entries(dictionary)) {
    if (text.includes(keyword)) expanded.push(...terms);
  }
  return expanded;
}

export function formatContext(chunks: CodeChunk[]): string {
  if (!chunks.length) return "未检索到相关代码片段。";
  return chunks.map((chunk) => (
    `文件：${chunk.file_path}\n\`\`\`${chunk.language}\n${chunk.content.slice(0, 3000)}\n\`\`\``
  )).join("\n\n");
}
