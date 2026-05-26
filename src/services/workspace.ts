import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { db, nowIso } from "../db.js";
import { WORKSPACE_DIR } from "../paths.js";
import type { GitRepo, RepoValidationIssue, RepoValidationResult, SyncRepoResult } from "../types.js";
import { clearRepoSearchIndex, indexRepo } from "./code-index.js";

export function repoWorkspaceSlot(repo: GitRepo): string {
  const name = repo.name.toLowerCase();
  if (name.includes("android")) return "android";
  if (name.includes("c++") || name.includes("cpp") || name.includes("native")) return "cpp";
  return `repo_${repo.id}`;
}

export function projectWorkspaceRoot(projectId: number): string {
  return path.join(WORKSPACE_DIR, `project_${projectId}`);
}

export function sessionUploadsDir(projectId: number, chatSessionId: string): string {
  const safeSession = chatSessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "default";
  return path.join(projectWorkspaceRoot(projectId), "uploads", safeSession);
}

function withGitToken(gitUrl: string, accessToken = ""): string {
  if (!accessToken || !gitUrl.startsWith("https://")) return gitUrl;
  const hostPart = gitUrl.split("//", 2)[1]?.split("/", 1)[0] ?? "";
  if (hostPart.includes("@")) return gitUrl;
  return gitUrl.replace("https://", `https://oauth2:${encodeURIComponent(accessToken)}@`);
}

async function cloneOrPullRepo(targetDir: string, repo: GitRepo, cloneUrl: string): Promise<void> {
  const branch = repo.branch || "main";
  if (fs.existsSync(path.join(targetDir, ".git"))) {
    const git = simpleGit(targetDir);
    await git.fetch(["--all", "--prune"]);
    await git.checkout(branch);
    await git.pull();
  } else {
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    await simpleGit().clone(cloneUrl, targetDir, ["--branch", branch]);
  }

  try {
    const git = simpleGit(targetDir);
    await git.submoduleUpdate(["--init", "--recursive"]);
  } catch {
    // Submodule failures should not block the main sync.
  }
}

function countWorkspaceFiles(root: string): number {
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "target", "dist", "build"].includes(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (entry.isFile()) count += 1;
    }
  };
  if (!fs.existsSync(root)) return 0;
  walk(root);
  return count;
}

function hasProjectRules(repoPath: string): boolean {
  const candidates = [".cursor/rules", ".cursorrules", "AGENTS.md", ".cursor/AGENTS.md"];
  return candidates.some((candidate) => fs.existsSync(path.join(repoPath, candidate)));
}

function writeWorkspaceManifest(workspaceRoot: string, repos: GitRepo[]): void {
  const lines = [
    "# Anna Analysis Workspace",
    "",
    "本目录是分析助手的统一工作区，结构类似 Cursor IDE 打开的多模块工程。",
    "",
    "## 目录说明",
    ...repos.map((repo) => {
      const slot = repoWorkspaceSlot(repo);
      return `- \`${slot}/\` — ${repo.name}（分支 ${repo.branch || "main"}）`;
    }),
    "- `uploads/` — 用户上传的日志、截图等附件（分析前请优先读取）",
    "",
    "## 分析要求",
    "- 在给出结论前，必须搜索并打开仓库中的实际文件。",
    "- 跨 Android / C++ 问题时，请同时检查相关子目录。",
  ];
  fs.writeFileSync(path.join(workspaceRoot, "WORKSPACE.md"), lines.join("\n"), "utf8");
}

export async function syncReposToWorkspace(
  projectId: number,
  repos: GitRepo[],
  accessToken = "",
): Promise<SyncRepoResult[]> {
  const workspaceRoot = projectWorkspaceRoot(projectId);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "uploads"), { recursive: true });

  const results: SyncRepoResult[] = [];
  for (const repo of repos) {
    if (!repo.git_url?.trim()) {
      throw new Error(`${repo.name} 的 GitLab 地址不能为空`);
    }

    const slot = repoWorkspaceSlot(repo);
    const targetDir = path.join(workspaceRoot, slot);
    const cloneUrl = withGitToken(repo.git_url, accessToken || repo.access_token || "");
    await cloneOrPullRepo(targetDir, repo, cloneUrl);

    db.prepare("UPDATE git_repos SET local_path = ?, last_sync_at = ? WHERE id = ?").run(targetDir, nowIso(), repo.id);
    clearRepoSearchIndex(repo.id);
    const indexed = indexRepo(repo.id, targetDir, `${slot}/`);
    const fileCount = countWorkspaceFiles(targetDir);

    results.push({
      repo_id: repo.id,
      repo_name: repo.name,
      local_path: targetDir,
      workspace_slot: slot,
      indexed_chunks: indexed,
      file_count: fileCount,
    });
  }

  writeWorkspaceManifest(workspaceRoot, repos);
  return results;
}

export function validateReposForAnalysis(projectId: number, repos: GitRepo[]): RepoValidationResult {
  const workspaceRoot = projectWorkspaceRoot(projectId);
  const issues: RepoValidationIssue[] = [];
  let totalFiles = 0;

  if (!repos.length) {
    return {
      ok: false,
      workspace_path: workspaceRoot,
      file_count: 0,
      issues: [{ repo_id: 0, repo_name: "", level: "error", message: "请至少选择一个仓库" }],
    };
  }

  for (const repo of repos) {
    const slot = repoWorkspaceSlot(repo);
    const repoPath = repo.local_path || path.join(workspaceRoot, slot);
    if (!fs.existsSync(repoPath)) {
      issues.push({
        repo_id: repo.id,
        repo_name: repo.name,
        level: "error",
        message: `${repo.name} 尚未同步，请先获取最新代码`,
      });
      continue;
    }
    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      issues.push({
        repo_id: repo.id,
        repo_name: repo.name,
        level: "error",
        message: `${repo.name} 本地目录不是有效的 Git 仓库`,
      });
      continue;
    }

    const fileCount = countWorkspaceFiles(repoPath);
    totalFiles += fileCount;
    if (fileCount < 10) {
      issues.push({
        repo_id: repo.id,
        repo_name: repo.name,
        level: "error",
        message: `${repo.name} 同步后的代码文件过少（${fileCount} 个），请检查分支或 GitLab Token`,
      });
    }
    if (!hasProjectRules(repoPath)) {
      issues.push({
        repo_id: repo.id,
        repo_name: repo.name,
        level: "warning",
        message: `${repo.name} 未配置 .cursor/rules 或 AGENTS.md，分析准确度可能低于 Cursor IDE`,
      });
    }
  }

  const errors = issues.filter((issue) => issue.level === "error");
  return {
    ok: errors.length === 0,
    workspace_path: workspaceRoot,
    file_count: totalFiles,
    issues,
  };
}

export function resolveAnalysisCwd(projectId: number, chatSessionId: string): string {
  const workspaceRoot = projectWorkspaceRoot(projectId);
  const uploads = sessionUploadsDir(projectId, chatSessionId);
  fs.mkdirSync(uploads, { recursive: true });
  return workspaceRoot;
}

export function copyAttachmentsToWorkspace(
  projectId: number,
  chatSessionId: string,
  files: Array<{ stored_name: string; source_path: string }>,
): Array<{ stored_name: string; workspace_path: string; relative_path: string }> {
  const uploadsDir = sessionUploadsDir(projectId, chatSessionId);
  fs.mkdirSync(uploadsDir, { recursive: true });
  return files.map((file) => {
    const workspacePath = path.join(uploadsDir, file.stored_name);
    fs.copyFileSync(file.source_path, workspacePath);
    const relativePath = path.relative(projectWorkspaceRoot(projectId), workspacePath).split(path.sep).join("/");
    return {
      stored_name: file.stored_name,
      workspace_path: workspacePath,
      relative_path: relativePath,
    };
  });
}
