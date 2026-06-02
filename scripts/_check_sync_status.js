const Database = require("/opt/Anna_Analysis/node_modules/better-sqlite3");
const fs = require("fs");
const path = require("path");
const db = new Database("/opt/Anna_Analysis/data/anna_analysis.db", { readonly: true });
const repo = db.prepare("SELECT id, branch, local_path, last_sync_at FROM git_repos WHERE id = 10").get();
const androidDir = "/opt/Anna_Analysis/data/workspaces/project_7/android";
const hasGit = fs.existsSync(path.join(androidDir, ".git"));
let fileCount = 0;
if (hasGit) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "target", "dist", "build"].includes(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) fileCount += 1;
    }
  };
  walk(androidDir);
}
console.log(JSON.stringify({ repo, hasGit, fileCount }, null, 2));
