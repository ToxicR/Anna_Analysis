const { execSync } = require("child_process");
const Database = require("/opt/Anna_Analysis/node_modules/better-sqlite3");
const db = new Database("/opt/Anna_Analysis/data/anna_analysis.db", { readonly: true });
const row = db.prepare("SELECT value FROM app_settings WHERE key = 'gitlab_access_token'").get();
const token = row?.value || "";
const baseUrl = "https://git.jpgk.com.cn/retail-group/vending-retail-2018/terminal/vendingmachine.git";
const url = token
  ? baseUrl.replace("https://", `https://oauth2:${encodeURIComponent(token)}@`)
  : baseUrl;
try {
  const out = execSync(`git ls-remote --heads "${url}"`, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const branches = out.split("\n").filter(Boolean).map((line) => line.split("\t")[1]?.replace("refs/heads/", "")).filter(Boolean);
  const matched = branches.filter((b) => /freshup|saimahui|main|master|develop/i.test(b));
  console.log("TOKEN_CONFIGURED:", Boolean(token));
  console.log("MATCHED_BRANCHES:", JSON.stringify(matched, null, 2));
  console.log("HAS_freshup_saimahui:", branches.includes("freshup_saimahui"));
} catch (error) {
  console.log("ERROR:", error.stderr || error.message || String(error));
}
