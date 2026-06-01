#!/usr/bin/env python3
"""Full end-to-end diagnosis of first-login password change flow."""
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

NODE_SCRIPT = r"""
const http = require('http');
const Database = require('/opt/Anna_Analysis/node_modules/better-sqlite3');
const { hashPassword } = require('/opt/Anna_Analysis/dist/password.js');

const db = new Database('/opt/Anna_Analysis/data/anna_analysis.db');
const account = 'diag_test_user';

db.prepare('DELETE FROM app_users WHERE account = ?').run(account);
db.prepare(`INSERT INTO app_users(account, password_hash, display_name, enabled, must_change_password, created_at)
  VALUES (?, ?, ?, 1, 1, datetime('now'))`).run(account, hashPassword('123456'), account);

console.log('[setup] inserted new user with must_change_password=1');

function dumpUser(label) {
  const row = db.prepare(
    'SELECT id, account, must_change_password, typeof(must_change_password) AS t FROM app_users WHERE account = ?'
  ).get(account);
  console.log(`[db ${label}]`, JSON.stringify(row));
}

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
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  dumpUser('initial');

  console.log('\n=== Step 1: login with initial password 123456 ===');
  const login = await req('POST', '/api/auth/login', { account, password: '123456' });
  console.log('login status:', login.status);
  console.log('login body:', login.body);
  const cookie = (login.headers['set-cookie'] || [])[0] || '';
  console.log('cookie:', cookie ? cookie.split(';')[0] : '(none)');

  console.log('\n=== Step 2: /api/auth/me ===');
  const me1 = await req('GET', '/api/auth/me', null, cookie);
  console.log('me status:', me1.status);
  console.log('me body:', me1.body);

  console.log('\n=== Step 3: try a normal API while still must_change ===');
  const projectsBlocked = await req('GET', '/api/projects', null, cookie);
  console.log('projects blocked status:', projectsBlocked.status);
  console.log('projects blocked body:', projectsBlocked.body);

  console.log('\n=== Step 4: change password to "newpass2026" ===');
  const change = await req('POST', '/api/auth/change-password', { new_password: 'newpass2026' }, cookie);
  console.log('change status:', change.status);
  console.log('change body:', change.body);

  dumpUser('after change');

  console.log('\n=== Step 5: /api/auth/me again (same session) ===');
  const me2 = await req('GET', '/api/auth/me', null, cookie);
  console.log('me2 status:', me2.status);
  console.log('me2 body:', me2.body);

  console.log('\n=== Step 6: /api/projects with same session ===');
  const projects = await req('GET', '/api/projects', null, cookie);
  console.log('projects status:', projects.status);
  console.log('projects body (truncated):', projects.body.slice(0, 200));

  console.log('\n=== Step 7: logout and re-login with new password ===');
  await req('POST', '/api/auth/logout', null, cookie);

  const login2 = await req('POST', '/api/auth/login', { account, password: 'newpass2026' });
  console.log('login2 status:', login2.status);
  console.log('login2 body:', login2.body);
  const cookie2 = (login2.headers['set-cookie'] || [])[0] || '';
  const me3 = await req('GET', '/api/auth/me', null, cookie2);
  console.log('me3 status:', me3.status);
  console.log('me3 body:', me3.body);

  dumpUser('final');
  db.prepare('DELETE FROM app_users WHERE account = ?').run(account);
  db.close();
})();
"""


def main() -> None:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)
    sftp = client.open_sftp()
    with sftp.file("/tmp/diag_full_flow.js", "w") as handle:
        handle.write(NODE_SCRIPT)
    sftp.close()
    _, stdout, stderr = client.exec_command("node /tmp/diag_full_flow.js", timeout=60)
    print(stdout.read().decode("utf-8", errors="replace"))
    err = stderr.read().decode("utf-8", errors="replace")
    if err:
        print("STDERR:", err)
    client.close()


if __name__ == "__main__":
    main()
