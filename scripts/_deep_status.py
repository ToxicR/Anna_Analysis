#!/usr/bin/env python3
import paramiko
c=paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
cmds = [
    "date",
    "ls -la /var/log/leapp/leapp-upgrade.log",
    "wc -l /var/log/leapp/leapp-upgrade.log",
    "ps aux | grep leapp | grep -v grep",
    "ps aux | grep dnf | grep -v grep",
    "ps aux | grep nspawn | grep -v grep",
    "tail -20 /var/log/leapp/leapp-upgrade.log",
]
for cmd in cmds:
    print(">>>", cmd)
    _, o, _ = c.exec_command(cmd)
    print(o.read().decode("utf-8", "replace"))
    print()
c.close()
