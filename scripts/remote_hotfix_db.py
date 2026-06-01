#!/usr/bin/env python3
"""Upload db.ts fix and rebuild on server."""
import paramiko
from pathlib import Path

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"
ROOT = Path(__file__).resolve().parent.parent

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

sftp = client.open_sftp()
sftp.put(str(ROOT / "src" / "db.ts"), "/opt/Anna_Analysis/src/db.ts")
sftp.close()

_, stdout, stderr = client.exec_command(
    "cd /opt/Anna_Analysis && source /opt/rh/gcc-toolset-12/enable && npm run build && systemctl restart anna-analysis && sleep 2 && systemctl is-active anna-analysis && curl -sI http://127.0.0.1:8765/ | head -3",
    timeout=120,
)
out = stdout.read().decode("utf-8", errors="replace")
err = stderr.read().decode("utf-8", errors="replace")
print(out)
print(err)
client.close()
