#!/usr/bin/env python3
import json
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

script = r"""
const http = require('http');

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: 8765, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
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
  const login = await req('POST', '/api/auth/login', { account: '13473458864', password: '123456' });
  console.log('login status', login.status);
  console.log('login body', login.body);
  const cookie = (login.headers['set-cookie'] || [])[0];
  const me = await req('GET', '/api/auth/me', null, cookie);
  console.log('me status', me.status);
  console.log('me body', me.body);
})();
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)
sftp = client.open_sftp()
with sftp.file("/tmp/test_auth.js", "w") as f:
    f.write(script)
sftp.close()
_, o, e = client.exec_command("node /tmp/test_auth.js")
print(o.read().decode("utf-8", errors="replace"))
print(e.read().decode("utf-8", errors="replace"))
client.close()
