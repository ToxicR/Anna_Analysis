#!/usr/bin/env python3
import paramiko
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
c=paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
_,o,_=c.exec_command("journalctl -u anna-analysis -n 15 --no-pager 2>&1; echo ---; cd /opt/Anna_Analysis && /usr/bin/node dist/server.js 2>&1 | head -20")
print(o.read().decode("utf-8", errors="replace"))
c.close()
