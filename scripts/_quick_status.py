#!/usr/bin/env python3
import paramiko
c=paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
_, o, _ = c.exec_command(
    "cat /etc/redhat-release; echo ---; "
    "ps aux | grep leapp | grep upgrade | grep -v grep | wc -l; echo ---; "
    "tail -8 /var/log/leapp/leapp-upgrade.log"
)
print(o.read().decode("utf-8", "replace"))
c.close()
