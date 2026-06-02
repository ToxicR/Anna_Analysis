#!/usr/bin/env python3
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

cmds = [
    "journalctl -u anna-analysis --since '3 hours ago' --no-pager | grep 'feishu/webhook' | tail -30",
    "sqlite3 /opt/Anna_Analysis/data/anna_analysis.db \".tables\"",
    "sqlite3 /opt/Anna_Analysis/data/anna_analysis.db \"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;\"",
    "journalctl -u anna-analysis --since '30 minutes ago' --no-pager | tail -60",
    "sqlite3 /opt/Anna_Analysis/data/anna_analysis.db \"SELECT key, length(value) AS len FROM app_settings WHERE key LIKE 'feishu_%' ORDER BY key;\"",
    "sqlite3 /opt/Anna_Analysis/data/anna_analysis.db \"SELECT open_id, app_user_id, enabled FROM feishu_users;\"",
    "sqlite3 /opt/Anna_Analysis/data/anna_analysis.db \"SELECT chat_id, enabled FROM feishu_chats;\"",
    "curl -s -w '\\nHTTP:%{http_code}\\n' -X POST http://127.0.0.1:8765/api/feishu/webhook -H 'Content-Type: application/json' -d '{\"type\":\"url_verification\",\"challenge\":\"test123\"}'",
    "curl -s -w '\\nHTTP:%{http_code}\\n' -X POST https://annalog.jpgk.cn/api/feishu/webhook -H 'Content-Type: application/json' -d '{\"type\":\"url_verification\",\"challenge\":\"test456\"}'",
    "grep -R annalog /etc/nginx 2>/dev/null | head -30",
    "ss -lntp | grep 8765 || netstat -lntp | grep 8765",
]

for cmd in cmds:
    print(">>>", cmd)
    _, stdout, stderr = client.exec_command(cmd, timeout=60)
    out = (stdout.read() + stderr.read()).decode("utf-8", errors="replace")
    print(out[:5000])
    print("---")

client.close()
