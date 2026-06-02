#!/usr/bin/env python3
import paramiko
import time

for i in range(8):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
    _, o, _ = c.exec_command(
        "tail -10 /tmp/anna_deploy_fix3.log 2>/dev/null; echo ---; "
        "systemctl is-active anna-analysis 2>/dev/null || echo inactive; "
        "grep 'deploy done' /tmp/anna_deploy_fix3.log 2>/dev/null | tail -1"
    )
    print(f"=== poll {i+1} ===")
    print(o.read().decode("utf-8", errors="replace"))
    c.close()
    time.sleep(30)
