#!/usr/bin/env python3
import json
import sys
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"
ACCOUNT = sys.argv[1] if len(sys.argv) > 1 else "17600662353"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

node_script = f"""
const Database = require('/opt/Anna_Analysis/node_modules/better-sqlite3');
const {{ verifyPassword }} = require('/opt/Anna_Analysis/dist/password.js');
const db = new Database('/opt/Anna_Analysis/data/anna_analysis.db', {{ readonly: true }});
const account = {json.dumps(ACCOUNT)};
const row = db.prepare('SELECT id, account, display_name, enabled, must_change_password, created_at FROM app_users WHERE account = ?').get(account);
console.log('USER:', JSON.stringify(row || null));
if (row) {{
  const full = db.prepare('SELECT password_hash FROM app_users WHERE id = ?').get(row.id);
  console.log('PASSWORD_123456:', verifyPassword('123456', full.password_hash));
  const records = db.prepare('SELECT id, success, failure_reason, ip, created_at FROM app_user_login_records WHERE account = ? ORDER BY id DESC LIMIT 10').all(account);
  console.log('LOGIN_RECORDS:', JSON.stringify(records));
}}
"""

_, out, err = client.exec_command(f"cd /opt/Anna_Analysis && node -e {json.dumps(node_script)}")
print(out.read().decode())
if err.read().decode().strip():
    print("ERR:", err.read().decode())

login_payload = json.dumps({"account": ACCOUNT, "password": "123456"})
_, out2, _ = client.exec_command(
    f"curl -s -X POST http://127.0.0.1:8765/api/auth/login -H 'Content-Type: application/json' -d {json.dumps(login_payload)}"
)
print("LOGIN_TEST:", out2.read().decode())
client.close()
