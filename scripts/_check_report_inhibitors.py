#!/usr/bin/env python3
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)
_, stdout, _ = client.exec_command("grep -c inhibitor /var/log/leapp/leapp-report.txt; head -30 /var/log/leapp/leapp-report.txt")
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
