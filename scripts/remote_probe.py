#!/usr/bin/env python3
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

cmds = [
    "yum repolist all 2>&1 | head -20",
    "yum install -y epel-release 2>&1 | tail -5",
    "yum install -y docker 2>&1 | tail -10",
    "which docker; docker -v 2>&1",
    "curl -sI --max-time 15 https://registry.npmmirror.com | head -2",
    "curl -sI --max-time 15 https://get.docker.com | head -2",
    "ls -la /opt/Anna_Analysis/package.json 2>&1",
    "/usr/local/bin/node -v 2>&1",
]
for cmd in cmds:
    print(">>>", cmd)
    i, o, e = client.exec_command(cmd, timeout=60)
    print((o.read() + e.read()).decode()[:1500])
    print("---")
client.close()
