#!/usr/bin/env python3
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

cmds = [
    "grep -A5 -i inhibitor /var/log/leapp/leapp-report.txt | head -80",
    "grep -A10 'Missing required answers' /var/log/leapp/leapp-report.txt | head -40",
    "cat /var/log/leapp/answerfile 2>/dev/null | head -50",
    "tail -30 /tmp/elevate_migrate.log",
    "ps aux | grep leapp | grep -v grep",
]
for cmd in cmds:
    print(">>>", cmd)
    _, stdout, stderr = client.exec_command(cmd)
    print(stdout.read().decode("utf-8", errors="replace"))
    err = stderr.read().decode("utf-8", errors="replace")
    if err:
        print("ERR:", err)
    print()

client.close()
