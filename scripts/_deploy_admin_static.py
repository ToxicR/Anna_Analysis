#!/usr/bin/env python3
import paramiko
from pathlib import Path

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"
ROOT = Path(__file__).resolve().parent.parent
FILES = ["static/admin.js", "static/admin.html", "static/styles.css", "static/app.js", "static/index.html"]

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30)
sftp = client.open_sftp()
for rel in FILES:
    local = ROOT / rel
    remote = f"/opt/Anna_Analysis/{rel}"
    sftp.put(str(local), remote)
    print("uploaded", rel)
sftp.close()
client.close()
print("deploy done")
