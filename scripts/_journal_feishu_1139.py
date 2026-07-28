#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys
import paramiko
sys.stdout.reconfigure(encoding="utf-8")
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30)
cmd = "journalctl -u anna-analysis --since '2026-06-03 11:38:00' --until '2026-06-03 11:42:00' --no-pager -o cat | grep -E 'feishu|attachment|parent|messageType|hasAttachment' | tail -50"
_, o, _ = c.exec_command(cmd, timeout=90)
print(o.read().decode("utf-8", errors="replace"))
c.close()
