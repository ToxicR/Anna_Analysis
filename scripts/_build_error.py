#!/usr/bin/env python3
import paramiko
c=paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
cmds=[
 "df -h / /tmp",
 "gcc --version | head -1",
 "tail -40 /root/.npm/_logs/2026-05-28T00_50_37_710Z-debug-0.log 2>/dev/null | head -40",
 "grep -E 'fatal error|error:' /tmp/anna_deploy_fix3.log | tail -10",
]
for cmd in cmds:
 print('>>>',cmd)
 _,o,_=c.exec_command(cmd)
 print(o.read().decode('utf-8','replace')[:3000])
 print()
c.close()
