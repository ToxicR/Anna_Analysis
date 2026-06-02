#!/usr/bin/env python3
"""Diagnose Feishu directory search on server."""
import json
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

NODE_SCRIPT = r'''
const Database = require("better-sqlite3");
const db = new Database("/opt/Anna_Analysis/data/anna_analysis.db", { readonly: true });
const appId = db.prepare("SELECT value FROM app_settings WHERE key='feishu_app_id'").get()?.value?.trim();
const appSecret = db.prepare("SELECT value FROM app_settings WHERE key='feishu_app_secret'").get()?.value?.trim();
if (!appId || !appSecret) {
  console.log(JSON.stringify({ error: "missing feishu credentials" }));
  process.exit(0);
}

async function main() {
  const base = "https://open.feishu.cn/open-apis";
  const tokenResp = await fetch(base + "/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const tokenData = await tokenResp.json();
  const token = tokenData.tenant_access_token;
  if (!token) {
    console.log(JSON.stringify({ error: "token failed", tokenData }));
    return;
  }

  async function api(path) {
    const resp = await fetch(base + path, { headers: { Authorization: "Bearer " + token } });
    const data = await resp.json();
    return { status: resp.status, data };
  }

  const scope = await api("/contact/v3/scopes?user_id_type=user_id&department_id_type=open_department_id&page_size=100");
  const deptIds = scope.data?.data?.department_ids || [];
  const userIds = scope.data?.data?.user_ids || [];

  const users = [];
  const errors = [];

  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const params = new URLSearchParams({ user_id_type: "user_id" });
    for (const id of chunk) params.append("user_ids", id);
    const batch = await api("/contact/v3/users/batch?" + params);
    if (batch.data?.code !== 0) errors.push({ step: "batch", msg: batch.data?.msg, code: batch.data?.code });
    for (const item of batch.data?.data?.items || []) users.push(item);
  }

  async function deptUsers(deptId) {
    let pageToken = "";
    const items = [];
    do {
      const params = new URLSearchParams({
        department_id: deptId,
        department_id_type: "open_department_id",
        user_id_type: "open_id",
        page_size: "50",
      });
      if (pageToken) params.set("page_token", pageToken);
      const resp = await api("/contact/v3/users/find_by_department?" + params);
      if (resp.data?.code !== 0) {
        errors.push({ step: "dept", deptId, msg: resp.data?.msg, code: resp.data?.code });
        break;
      }
      items.push(...(resp.data?.data?.items || []));
      pageToken = resp.data?.data?.has_more ? (resp.data?.data?.page_token || "") : "";
    } while (pageToken);
    return items;
  }

  for (const deptId of deptIds.slice(0, 20)) {
    const items = await deptUsers(deptId);
    for (const item of items) users.push(item);
  }

  const dedup = new Map();
  for (const u of users) {
    if (u.open_id) dedup.set(u.open_id, u);
  }
  const all = [...dedup.values()];
  const matches = all.filter((u) => (u.name || "").includes("韩") || (u.name || "").includes("日日") || (u.name || "").includes("韩日日"));
  const withName = all.filter((u) => u.name).length;
  const sample = all.slice(0, 10).map((u) => ({ name: u.name || null, open_id: u.open_id, user_id: u.user_id || null }));

  console.log(JSON.stringify({
    scopeCode: scope.data?.code,
    scopeMsg: scope.data?.msg,
    deptCount: deptIds.length,
    scopedUserCount: userIds.length,
    totalUsers: all.length,
    withName,
    matches: matches.map((u) => ({ name: u.name, open_id: u.open_id, user_id: u.user_id })),
    sample,
    errors,
  }, null, 2));
}

main().catch((err) => console.log(JSON.stringify({ error: String(err) })));
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)
cmd = f"cd /opt/Anna_Analysis && node -e {json.dumps(NODE_SCRIPT)}"
_, stdout, stderr = client.exec_command(cmd, timeout=120)
out = stdout.read().decode("utf-8", errors="replace")
err = stderr.read().decode("utf-8", errors="replace")
client.close()
print(out)
if err.strip():
    print("STDERR:", err)
