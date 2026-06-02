#!/usr/bin/env python3
import paramiko
c=paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
cmds=[
 "sqlite3 /opt/Anna_Analysis/data/app.db \"PRAGMA table_info(app_users);\"",
 "sqlite3 /opt/Anna_Analysis/data/app.db \"SELECT id, account, must_change_password, typeof(must_change_password) FROM app_users;\"",
 "tail -20 /tmp/anna_deploy_fix4.log 2>/dev/null; journalctl -u anna-analysis -n 5 --no-pager",
]
for cmd in cmds:
 print('>>>', cmd)
 _,o,e=c.exec_command(cmd)
 print(o.read().decode('utf-8','replace'))
 print(e.read().decode('utf-8','replace'))
c.close()
