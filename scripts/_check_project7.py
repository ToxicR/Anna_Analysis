#!/usr/bin/env python3
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

script = r"""
const Database = require('/opt/Anna_Analysis/node_modules/better-sqlite3');
const db = new Database('/opt/Anna_Analysis/data/anna_analysis.db', { readonly: true });
const project = db.prepare('SELECT id, name FROM projects WHERE id = 7').get();
const repos = db.prepare('SELECT id, project_id, name, repo_type, git_url, branch, enabled FROM git_repos WHERE project_id = 7').all();
console.log(JSON.stringify({ project, repos }, null, 2));
"""

_, out, err = client.exec_command(f"cd /opt/Anna_Analysis && node -e {repr(script)}")
print(out.read().decode())
if err.read().decode().strip():
    print("ERR:", err.read().decode())
client.close()
