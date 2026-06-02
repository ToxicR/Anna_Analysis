#!/usr/bin/env python3
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

cmds = [
    "grep resume /tmp/elevate_migrate.log | tail -5",
    "grep 'preupgrade retry' /tmp/elevate_migrate.log | tail -5",
    "grep 'still has' /tmp/elevate_migrate.log | tail -5",
    "grep 'upgrade finished' /tmp/elevate_migrate.log | tail -5",
    "grep Inhibitors /tmp/elevate_migrate.log | tail -5",
    "grep -i inhibitor /var/log/leapp/leapp-report.txt | head -10",
    "ps aux | grep leapp | grep -v grep",
    "ls -la /var/log/leapp/",
    "tail -20 /var/log/leapp/leapp-upgrade.log 2>/dev/null || echo no upgrade log",
    "tail -30 /tmp/elevate_migrate.log",
]
for cmd in cmds:
    print(">>>", cmd)
    _, stdout, _ = client.exec_command(cmd)
    print(stdout.read().decode("utf-8", errors="replace"))
    print()

client.close()
