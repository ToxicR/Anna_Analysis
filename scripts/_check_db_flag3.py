#!/usr/bin/env python3
import paramiko
c=paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
script = r"""
const Database = require('/opt/Anna_Analysis/node_modules/better-sqlite3');
const db = new Database('/opt/Anna_Analysis/data/anna_analysis.db');
console.log('cols', JSON.stringify(db.prepare('PRAGMA table_info(app_users)').all()));
console.log('users', JSON.stringify(db.prepare('SELECT id, account, must_change_password, typeof(must_change_password) as t FROM app_users').all()));
db.close();
"""
_, o, e = c.exec_command(f"node -e {repr(script)}")
print(o.read().decode("utf-8", errors="replace"))
print(e.read().decode("utf-8", errors="replace"))
c.close()
