#!/usr/bin/env python3
import paramiko

script = r"""
const http = require('http');
const Database = require('/opt/Anna_Analysis/node_modules/better-sqlite3');
const { hashPassword } = require('/opt/Anna_Analysis/dist/password.js');

const db = new Database('/opt/Anna_Analysis/data/anna_analysis.db');
const account = 'test_pw_flow';
db.prepare('DELETE FROM app_users WHERE account = ?').run(account);
db.prepare(`INSERT INTO app_users(account, password_hash, display_name, enabled, must_change_password, created_at)
  VALUES (?, ?, ?, 1, 1, datetime('now'))`).run(account, hashPassword('123456'), account);

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: 8765, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie.split(';')[0] } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login1 = await req('POST', '/api/auth/login', { account, password: '123456' });
  console.log('login1', login1.status, login1.body);
  const cookie = (login1.headers['set-cookie'] || [])[0] || '';
  const me1 = await req('GET', '/api/auth/me', null, cookie);
  console.log('me1', me1.status, me1.body);
  const change = await req('POST', '/api/auth/change-password', { new_password: 'abc12345' }, cookie);
  console.log('change', change.status, change.body);
  const me2 = await req('GET', '/api/auth/me', null, cookie);
  console.log('me2', me2.status, me2.body);
  const projects = await req('GET', '/api/projects', null, cookie);
  console.log('projects', projects.status, projects.body.slice(0, 120));
  const login2 = await req('POST', '/api/auth/login', { account, password: 'abc12345' });
  console.log('login2', login2.status, login2.body);
  const row = db.prepare('SELECT must_change_password FROM app_users WHERE account = ?').get(account);
  console.log('db flag', row);
  db.prepare('DELETE FROM app_users WHERE account = ?').run(account);
  db.close();
})();
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30, banner_timeout=60)
sftp = client.open_sftp()
with sftp.file("/tmp/test_pw_flow.js", "w") as f:
    f.write(script)
sftp.close()
_, o, e = client.exec_command("node /tmp/test_pw_flow.js")
print(o.read().decode("utf-8", errors="replace"))
print(e.read().decode("utf-8", errors="replace"))
client.close()
