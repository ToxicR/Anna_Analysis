#!/usr/bin/env python3
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
_, o, _ = c.exec_command(
    "tail -12 /tmp/anna_deploy_fix4.log 2>/dev/null || echo no-log; echo ---; "
    "systemctl is-active anna-analysis 2>/dev/null; "
    "grep 'deploy done' /tmp/anna_deploy_fix4.log 2>/dev/null | tail -1; "
    "pgrep -af 'fix4|npm install|gcc-toolset' | head -5"
)
print(o.read().decode("utf-8", errors="replace"))
c.close()
