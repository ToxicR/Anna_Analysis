#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys
import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"
DB = "/opt/Anna_Analysis/data/anna_analysis.db"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30)

cmds = [
    f'''sqlite3 -header -column "{DB}" "SELECT id, feishu_session_id, substr(question,1,160) q, length(log_text) lt, created_at FROM analysis_tasks WHERE source='feishu' ORDER BY id DESC LIMIT 10"''',
    f'''sqlite3 -header -column "{DB}" "SELECT id, role, substr(body,1,180) body, created_at FROM feishu_chat_messages WHERE session_id IN ('fs_91ac025bea08bbc6cdf78822','fs_c0c4eefa5748d49fa8aba200','fs_3f96c13ed9860977f349a3e1') ORDER BY id DESC LIMIT 25"''',
    "find /opt/Anna_Analysis/data/workspaces/project_3/uploads -type f -name '*.log' 2>/dev/null | tail -30",
    "find /opt/Anna_Analysis/data/workspaces/project_3/uploads -name '_feishu_uploads.json' 2>/dev/null | while read f; do echo MANIFEST:$f; head -c 600 \"$f\"; echo; done",
    f'''sqlite3 -header -column "{DB}" "SELECT chat_id, open_id, mode, session_id, updated_at FROM feishu_session_links ORDER BY updated_at DESC LIMIT 10"''',
    "journalctl -u anna-analysis --since '2026-06-03 11:35:00' --until '2026-06-03 11:45:00' --no-pager 2>/dev/null | grep -E 'feishu|attachment|session' | tail -40",
]

for cmd in cmds:
    print("\n>>>", cmd[:100])
    _, stdout, stderr = client.exec_command(cmd, timeout=120)
    print((stdout.read() + stderr.read()).decode("utf-8", errors="replace")[:12000])

client.close()
