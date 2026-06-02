#!/usr/bin/env python3
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
cmd = "ls -la /opt/Anna_Analysis/data/workspaces/project_7/android | head -20; du -sh /opt/Anna_Analysis/data/workspaces/project_7/android; ps aux | grep git | grep -v grep | head -5"
_, out, err = client.exec_command(cmd, timeout=60)
print(out.read().decode())
print(err.read().decode())
client.close()
