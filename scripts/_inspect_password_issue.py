#!/usr/bin/env python3
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)

cmd = r"""
echo '--- recent auth logs ---'
journalctl -u anna-analysis --since '30 minutes ago' --no-pager \
  | grep -E 'api/auth/(login|me|change-password)|api/projects|api/repos|api/models|statusCode' \
  | tail -160 || true
echo '--- users ---'
python3 - <<'PY'
import sqlite3
db = sqlite3.connect('/opt/Anna_Analysis/data/anna_analysis.db')
db.row_factory = sqlite3.Row
for row in db.execute('SELECT id, account, display_name, enabled, must_change_password, typeof(must_change_password) AS type FROM app_users ORDER BY id'):
    print(dict(row))
PY
"""

_, stdout, stderr = client.exec_command(cmd, timeout=60)
print(stdout.read().decode("utf-8", errors="replace"))
print(stderr.read().decode("utf-8", errors="replace"))
client.close()
