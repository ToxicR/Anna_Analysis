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
    f'''sqlite3 -header -column "{DB}" "SELECT id, role, body, created_at FROM feishu_chat_messages ORDER BY id DESC LIMIT 8"''',
    f'''sqlite3 -header -column "{DB}" "SELECT id, feishu_session_id, substr(question,1,200) q, length(log_text) lt, substr(result,1,300) r, created_at FROM analysis_tasks WHERE source='feishu' ORDER BY id DESC LIMIT 5"''',
    "journalctl -u anna-analysis --since '30 min ago' --no-pager 2>/dev/null | grep -iE 'feishu parent|attachment|hasAttachment|parentMessage|staging|quote' | tail -40",
    "find /opt/Anna_Analysis/data/workspaces -path '*feishu:*' -name '_feishu_uploads.json' 2>/dev/null | head -5 | while read f; do echo MANIFEST:$f; cat \"$f\"; echo; done",
]

for cmd in cmds:
    print("\n>>>", cmd[:100])
    _, stdout, stderr = client.exec_command(cmd, timeout=90)
    print((stdout.read() + stderr.read()).decode("utf-8", errors="replace")[:10000])

client.close()
