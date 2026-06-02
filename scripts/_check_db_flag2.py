#!/usr/bin/env python3
import paramiko
c=paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
cmd = """
find /opt/Anna_Analysis -name '*.db' 2>/dev/null
ls -la /opt/Anna_Analysis/data/ 2>/dev/null
node -e "
const Database=require('better-sqlite3');
const paths=['/opt/Anna_Analysis/data/app.db','/opt/Anna_Analysis/data/anna.db','/opt/Anna_Analysis/data/database.db'];
for (const p of paths) {
  try {
    const db=new Database(p);
    const cols=db.prepare('PRAGMA table_info(app_users)').all();
    const users=db.prepare('SELECT id,account,must_change_password FROM app_users').all();
    console.log('DB', p, JSON.stringify({cols,users}));
    db.close();
  } catch(e) {}
}
"
"""
_,o,e=c.exec_command(f"cd /opt/Anna_Analysis && {cmd}")
print(o.read().decode('utf-8','replace'))
print(e.read().decode('utf-8','replace'))
c.close()
