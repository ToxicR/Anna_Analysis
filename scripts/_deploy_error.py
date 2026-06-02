#!/usr/bin/env python3
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

cmds = [
    "tail -50 /tmp/anna_deploy_rocky.log",
    "tail -5 /tmp/anna_deploy_fix.sh 2>/dev/null || head -5 /tmp/anna_deploy_fix.sh 2>/dev/null",
    "ls -la /opt/Anna_Analysis/dist 2>/dev/null || echo no-dist",
    "pgrep -af 'npm|node-gyp|anna-deploy' | head -20",
]
for cmd in cmds:
    print(">>>", cmd)
    _, o, _ = client.exec_command(cmd)
    print(o.read().decode("utf-8", errors="replace")[:4000])
    print()

client.close()
