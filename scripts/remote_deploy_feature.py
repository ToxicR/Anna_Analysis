#!/usr/bin/env python3
"""Deploy first-login password change feature to server."""
import os
import paramiko
from pathlib import Path

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"
ROOT = Path(__file__).resolve().parent.parent
REMOTE = "/opt/Anna_Analysis"

FILES = [
    "src/db.ts",
    "src/types.ts",
    "src/server.ts",
    "src/services/analysis-runner.ts",
    "src/services/app-users.ts",
    "src/services/ai.ts",
    "static/app.js",
    "static/index.html",
    "static/styles.css",
    "static/admin.js",
    "static/admin.html",
]

def upload_tree(sftp, local_dir: Path, remote_dir: str):
    for path in local_dir.rglob("*"):
        if path.is_dir():
            continue
        rel = path.relative_to(local_dir).as_posix()
        remote_path = f"{remote_dir}/{rel}"
        remote_parent = os.path.dirname(remote_path)
        try:
            sftp.stat(remote_parent)
        except OSError:
            parts = remote_parent.split("/")
            cur = ""
            for part in parts:
                if not part:
                    continue
                cur += f"/{part}"
                try:
                    sftp.stat(cur)
                except OSError:
                    sftp.mkdir(cur)
        sftp.put(str(path), remote_path)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)
sftp = client.open_sftp()

for rel in FILES:
    local = ROOT / rel
    remote = f"{REMOTE}/{rel.replace(chr(92), '/')}"
    sftp.put(str(local), remote)
    print("uploaded", rel)

upload_tree(sftp, ROOT / "src/services/feishu", f"{REMOTE}/src/services/feishu")
upload_tree(sftp, ROOT / "dist", f"{REMOTE}/dist")
sftp.close()

cmd = (
    "source /opt/rh/gcc-toolset-12/enable && "
    "cd /opt/Anna_Analysis && npm run build && "
    "systemctl restart anna-analysis && sleep 2 && systemctl is-active anna-analysis"
)
_, stdout, stderr = client.exec_command(cmd, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
print(stderr.read().decode("utf-8", errors="replace"))
client.close()
print("deploy done")
