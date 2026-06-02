#!/usr/bin/env python3
import paramiko
c=paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
_,o,_=c.exec_command("tail -25 /tmp/anna_deploy_fix2.log 2>/dev/null; echo ---; node -v 2>/dev/null; pgrep -af 'npm|fix2' | head -8")
print(o.read().decode("utf-8","replace"))
c.close()
