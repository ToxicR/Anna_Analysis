import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, nowIso } from "../db.js";
import { clearRepoFts, indexChunkFts } from "./code-fts.js";

const TEXT_EXTENSIONS = new Set([
  ".java", ".kt", ".py", ".js", ".jsx", ".ts", ".tsx", ".vue", ".go", ".rs",
  ".cs", ".cpp", ".c", ".h", ".hpp", ".php", ".rb", ".sql", ".xml", ".yaml",
  ".yml", ".json", ".properties", ".gradle", ".md", ".txt", ".sh", ".bat",
]);

const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".idea", ".vscode", "__pycache__"]);

export function clearRepoSearchIndex(repoId: number): void {
  clearRepoFts(repoId);
  db.prepare("DELETE FROM code_chunks WHERE repo_id = ?").run(repoId);
}

export function indexRepo(repoId: number, root: string, pathPrefix = ""): number {
  const insert = db.prepare(`
    INSERT INTO code_chunks(repo_id, file_path, language, content, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  const createdAt = nowIso();
  const prefix = pathPrefix ? (pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`) : "";

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

      const filePath = `${prefix}${rel.split(path.sep).join("/")}`;
      const language = path.extname(fullPath).slice(1);
      for (const chunk of splitContent(text)) {
        const hash = crypto.createHash("sha256").update(`${filePath}\n${chunk}`).digest("hex");
        const result = insert.run(repoId, filePath, language, chunk, hash, createdAt);
        indexChunkFts(Number(result.lastInsertRowid), repoId, filePath, chunk);
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
