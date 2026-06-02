#!/usr/bin/env python3
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

cmds = [
    "tail -30 /tmp/anna_deploy_rocky.log 2>/dev/null",
    "tail -15 /var/log/anna-post-migrate-deploy.log 2>/dev/null",
    "ps aux | grep -E 'anna|npm|node|deploy' | grep -v grep",
    "node -v 2>/dev/null || echo no-node",
    "systemctl status anna-analysis --no-pager 2>/dev/null | head -12",
    "test -d /opt/Anna_Analysis && ls -la /opt/Anna_Analysis | head -8 || echo no-repo",
]
for cmd in cmds:
    print(">>>", cmd)
    _, o, _ = client.exec_command(cmd)
    print(o.read().decode("utf-8", errors="replace"))
    print()

client.close()
