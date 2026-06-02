#!/usr/bin/env python3
import paramiko
from pathlib import Path

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"
LOCAL = Path(__file__).resolve().parent / "_check_branch_remote.js"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)
sftp = client.open_sftp()
sftp.put(str(LOCAL), "/tmp/check_branch_remote.js")
sftp.close()
_, out, err = client.exec_command("node /tmp/check_branch_remote.js", timeout=90)
stdout = out.read().decode()
stderr = err.read().decode()
print(stdout)
if stderr.strip():
    print("ERR:", stderr)
client.close()
