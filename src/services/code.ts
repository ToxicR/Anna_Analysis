import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { db, nowIso } from "../db.js";
import { REPO_DIR } from "../paths.js";
import type { CodeChunk, GitRepo } from "../types.js";

const TEXT_EXTENSIONS = new Set([
  ".java", ".kt", ".py", ".js", ".jsx", ".ts", ".tsx", ".vue", ".go", ".rs",
  ".cs", ".cpp", ".c", ".h", ".hpp", ".php", ".rb", ".sql", ".xml", ".yaml",
  ".yml", ".json", ".properties", ".gradle", ".md", ".txt", ".sh", ".bat",
]);

const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".idea", ".vscode", "__pycache__"]);

export function safeRepoDir(repo: GitRepo): string {
  const digest = crypto.createHash("sha1").update(`${repo.id}:${repo.git_url}`).digest("hex").slice(0, 12);
  return path.join(REPO_DIR, `repo_${repo.id}_${digest}`);
}

function withGitToken(gitUrl: string, accessToken = ""): string {
  if (!accessToken || !gitUrl.startsWith("https://")) return gitUrl;
  const hostPart = gitUrl.split("//", 2)[1]?.split("/", 1)[0] ?? "";
  if (hostPart.includes("@")) return gitUrl;
  return gitUrl.replace("https://", `https://oauth2:${encodeURIComponent(accessToken)}@`);
}

export async function syncRepo(repo: GitRepo, accessToken = ""): Promise<{ local_path: string; indexed_chunks: number }> {
  if (!repo.git_url?.trim()) {
    throw new Error("GitLab 地址不能为空");
  }

  const target = safeRepoDir(repo);
  const branch = repo.branch || "main";
  const cloneUrl = withGitToken(repo.git_url, accessToken || repo.access_token || "");

  if (fs.existsSync(path.join(target, ".git"))) {
    const git = simpleGit(target);
    await git.fetch(["--all", "--prune"]);
    await git.checkout(branch);
    await git.pull();
  } else {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await simpleGit().clone(cloneUrl, target, ["--branch", branch, "--depth", "1"]);
  }

  db.prepare("UPDATE git_repos SET local_path = ?, last_sync_at = ? WHERE id = ?").run(target, nowIso(), repo.id);
  db.prepare("DELETE FROM code_chunks WHERE repo_id = ?").run(repo.id);
  const indexed = indexRepo(repo.id, target);
  return { local_path: target, indexed_chunks: indexed };
}

function indexRepo(repoId: number, root: string): number {
  const insert = db.prepare(`
    INSERT INTO code_chunks(repo_id, file_path, language, content, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  const createdAt = nowIso();

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const rel = path.relative(root, fullPath);
      const parts = rel.split(path.sep);
      if (parts.some((part) => SKIP_DIRS.has(part))) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.isFile() || shouldSkipFile(fullPath)) continue;
      const text = readText(fullPath);
      if (!text) continue;

      const filePath = rel.split(path.sep).join("/");
      const language = path.extname(fullPath).slice(1);
      for (const chunk of splitContent(text)) {
        const hash = crypto.createHash("sha256").update(`${filePath}\n${chunk}`).digest("hex");
        insert.run(repoId, filePath, language, chunk, hash, createdAt);
        count += 1;
      }
    }
  };

  walk(root);
  return count;
}

function shouldSkipFile(filePath: string): boolean {
  const stat = fs.statSync(filePath);
  if (stat.size > 800_000) return true;
  return !TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function readText(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  for (const encoding of ["utf8", "latin1"] as BufferEncoding[]) {
    try {
      return buffer.toString(encoding);
    } catch {
      // Try next encoding.
    }
  }
  return "";
}

export function splitContent(text: string, maxChars = 3500): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of text.split(/\r?\n/)) {
    current.push(line);
    size += line.length + 1;
    if (size >= maxChars) {
      chunks.push(current.join("\n"));
      current = [];
      size = 0;
    }
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

export function searchCode(repoIds: number[], query: string, limit = 8): CodeChunk[] {
  const terms = extractTerms(query);
  if (!terms.length || !repoIds.length) return [];

  const placeholders = repoIds.map(() => "?").join(",");
  const candidates = db.prepare(`
    SELECT * FROM code_chunks
    WHERE repo_id IN (${placeholders})
    LIMIT 5000
  `).all(...repoIds) as CodeChunk[];

  const scored: Array<{ score: number; chunk: CodeChunk }> = [];
  for (const chunk of candidates) {
    const haystack = `${chunk.file_path}\n${chunk.content}`.toLowerCase();
    const score = terms.reduce((sum, term) => sum + countOccurrences(haystack, term.toLowerCase()), 0);
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
