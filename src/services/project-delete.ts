import fs from "node:fs";
import { db } from "../db.js";
import { clearRepoSearchIndex } from "./code-index.js";
import { projectWorkspaceRoot } from "./workspace.js";

function deleteReposForProject(projectId: number): void {
  const repoRows = db.prepare("SELECT id FROM git_repos WHERE project_id = ?").all(projectId) as Array<{ id: number }>;
  for (const row of repoRows) {
    clearRepoSearchIndex(row.id);
  }
  db.prepare("DELETE FROM git_repos WHERE project_id = ?").run(projectId);
}

export function deleteRepoCascade(repoId: number): void {
  const tx = db.transaction(() => {
    clearRepoSearchIndex(repoId);
    db.prepare("DELETE FROM git_repos WHERE id = ?").run(repoId);
  });
  tx();
}

export function deleteProjectCascade(projectId: number): void {
  const tx = db.transaction(() => {
    deleteReposForProject(projectId);
    db.prepare("DELETE FROM analysis_tasks WHERE project_id = ?").run(projectId);
    db.prepare(`
      DELETE FROM chat_messages
      WHERE session_id IN (SELECT id FROM chat_sessions WHERE project_id = ?)
    `).run(projectId);
    db.prepare("DELETE FROM chat_sessions WHERE project_id = ?").run(projectId);
    const result = db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    if (result.changes === 0) throw new Error("项目不存在");
  });
  tx();

  const workspaceRoot = projectWorkspaceRoot(projectId);
  if (fs.existsSync(workspaceRoot)) {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}
