#!/usr/bin/env python3
import paramiko
c=paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
c.exec_command("touch /var/lib/anna-analysis-deployed; systemctl disable anna-post-migrate-deploy.timer 2>/dev/null")
c.close()
