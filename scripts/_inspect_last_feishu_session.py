#!/usr/bin/env python3
import json
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"
DB = "/opt/Anna_Analysis/data/anna_analysis.db"

QUERIES = [
    ("latest sessions", "SELECT id, project_id, mode, updated_at FROM feishu_chat_sessions ORDER BY updated_at DESC LIMIT 3"),
    ("link", "SELECT chat_id, mode, session_id, current_project_id FROM feishu_session_links ORDER BY updated_at DESC LIMIT 3"),
    ("messages", """
      SELECT id, role, substr(body,1,140), created_at FROM feishu_chat_messages
      WHERE session_id = (SELECT id FROM feishu_chat_sessions ORDER BY updated_at DESC LIMIT 1)
      ORDER BY id DESC LIMIT 15
    """),
    ("tasks", """
      SELECT id, feishu_session_id, substr(question,1,120), substr(log_text,1,500), substr(result,1,180), chat_session_id, created_at
      FROM analysis_tasks WHERE source='feishu' OR feishu_session_id != '' ORDER BY id DESC LIMIT 5
    """),
    ("cursor keys", "SELECT session_key, updated_at FROM cursor_agent_sessions WHERE session_key LIKE 'feishu:%' ORDER BY updated_at DESC LIMIT 10"),
]

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

for title, sql in QUERIES:
    print(f"\n=== {title} ===")
    cmd = f'sqlite3 -header -column "{DB}" "{sql.strip().replace(chr(10), " ")}"'
    _, stdout, stderr = client.exec_command(cmd, timeout=60)
    print(stdout.read().decode("utf-8", errors="replace"))
    err = stderr.read().decode("utf-8", errors="replace").strip()
    if err:
        print("ERR:", err)

inspect_py = r"""
import json, os, sqlite3
db = sqlite3.connect("/opt/Anna_Analysis/data/anna_analysis.db")
row = db.execute("SELECT id, project_id FROM feishu_chat_sessions ORDER BY updated_at DESC LIMIT 1").fetchone()
if not row:
    print("no session"); raise SystemExit(0)
sid, pid = row
print("LATEST_SESSION", sid, "project", pid)
base = f"/opt/Anna_Analysis/data/workspaces/project_{pid}/uploads/feishu:{sid}"
print("UPLOADS_DIR", base, "exists=", os.path.isdir(base))
if os.path.isdir(base):
    mf = os.path.join(base, "_feishu_uploads.json")
    if os.path.isfile(mf):
        entries = json.load(open(mf, encoding="utf-8"))
        print("MANIFEST_COUNT", len(entries))
        for e in entries:
            print("ENTRY", e.get("display_name"), "|", e.get("stored_name"), "|", e.get("uploaded_at"))
    for f in sorted(os.listdir(base)):
        if f == "_feishu_uploads.json": continue
        fp = os.path.join(base, f)
        if os.path.isfile(fp):
            print("FILE", f, os.path.getsize(fp))
dist = "/opt/Anna_Analysis/dist/services/feishu/files.js"
if os.path.isfile(dist):
    t = open(dist, encoding="utf-8", errors="replace").read()
    print("FIX_ONLY_NAMED_LOG", "仅分析指定日志" in t)
    print("FIX_CURRENT_TURN", "仅分析本轮附件" in t)
"""
_, stdout, _ = client.exec_command("python3 -c " + repr(inspect_py), timeout=60)
print("\n=== uploads & deploy marker ===")
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
