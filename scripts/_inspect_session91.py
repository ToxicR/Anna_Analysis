#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"
DB = "/opt/Anna_Analysis/data/anna_analysis.db"
SID = "fs_91ac025bea08bbc6cdf78822"
PID = 3

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30)

cmds = [
    f'''sqlite3 -header -column "{DB}" "SELECT id, role, substr(body,1,200) body, created_at FROM feishu_chat_messages WHERE session_id='{SID}' ORDER BY id"''',
    f'''sqlite3 -header -column "{DB}" "SELECT id, feishu_session_id, substr(question,1,200) q, length(log_text) lt_len, chat_session_id, created_at FROM analysis_tasks WHERE feishu_session_id='{SID}' ORDER BY id DESC LIMIT 5"''',
    f'''sqlite3 "{DB}" "SELECT log_text FROM analysis_tasks WHERE feishu_session_id='{SID}' ORDER BY id DESC LIMIT 1" > /tmp/lt.txt; head -c 2500 /tmp/lt.txt; echo; echo '---'; tail -c 800 /tmp/lt.txt"''',
    f'''sqlite3 "{DB}" "SELECT result FROM analysis_tasks WHERE feishu_session_id='{SID}' ORDER BY id DESC LIMIT 1" > /tmp/res.txt; head -c 1200 /tmp/res.txt"''',
    f"ls -la /opt/Anna_Analysis/data/workspaces/project_{PID}/uploads/feishu:{SID}/ 2>&1",
    f"cat /opt/Anna_Analysis/data/workspaces/project_{PID}/uploads/feishu:{SID}/_feishu_uploads.json 2>&1",
    "grep -c '仅分析指定日志' /opt/Anna_Analysis/dist/services/feishu/files.js; grep -c '仅分析本轮附件' /opt/Anna_Analysis/dist/services/feishu/files.js",
    f'''sqlite3 -header -column "{DB}" "SELECT session_key, updated_at FROM cursor_agent_sessions WHERE session_key LIKE 'feishu:{SID}%' ORDER BY updated_at DESC"''',
]

for cmd in cmds:
    print("\n>>>", cmd[:120], "...")
    _, stdout, stderr = client.exec_command(cmd, timeout=90)
    out = (stdout.read() + stderr.read()).decode("utf-8", errors="replace")
    print(out[:8000])

client.close()
