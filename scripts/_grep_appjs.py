#!/usr/bin/env python3
import paramiko
c=paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
_, o, _ = c.exec_command("grep -n changePasswordScreen /opt/Anna_Analysis/static/app.js | head -15")
print(o.read().decode("utf-8", errors="replace"))
c.close()
