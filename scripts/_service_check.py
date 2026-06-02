#!/usr/bin/env python3
import paramiko
c=paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
cmds=[
 "systemctl status anna-analysis --no-pager",
 "journalctl -u anna-analysis -n 20 --no-pager",
 "tail -15 /tmp/anna_deploy_fix4.log",
 "test -f /opt/Anna_Analysis/dist/server.js && echo has-dist || echo no-dist",
 "grep deploy /tmp/anna_deploy_fix4.log | tail -3",
]
for cmd in cmds:
 print('>>>',cmd)
 _,o,_=c.exec_command(cmd)
 print(o.read().decode('utf-8','replace')[:2500])
 print()
c.close()
