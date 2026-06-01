#!/usr/bin/env python3
import time
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

def q(cmd, t=30):
    i,o,e = client.exec_command(cmd, timeout=t)
    return (o.read()+e.read()).decode()

print("gcc8:", q("test -f /opt/rh/devtoolset-8/enable && echo YES || echo NO"))
print("yum proc:", q("pgrep -a yum || echo none"))
print("tail log:", q("tail -5 /tmp/build.log 2>/dev/null || echo no_log"))

# kick off background build if not running
script = r"""#!/bin/bash
exec > /tmp/build.log 2>&1
set -e
if [ -f /opt/rh/devtoolset-8/enable ]; then source /opt/rh/devtoolset-8/enable; fi
gcc --version | head -1 || true
cd /opt/Anna_Analysis
rm -rf node_modules
npm install --registry=https://registry.npmmirror.com
npm run build
echo BUILD_OK
"""
sftp = client.open_sftp()
with sftp.file("/tmp/build.sh", "w") as f:
    f.write(script)
sftp.chmod("/tmp/build.sh", 0o755)
sftp.close()

if "build.sh" not in q("pgrep -af build.sh || true"):
    q("nohup bash /tmp/build.sh >/dev/null 2>&1 & echo started")

for i in range(90):
    time.sleep(10)
    log = q("tail -8 /tmp/build.log 2>/dev/null")
    print(f"--- poll {i+1} ---")
    print(log)
    if "BUILD_OK" in log:
        print("BUILD SUCCESS")
        break
    if "npm ERR" in log and "BUILD_OK" not in log:
        print("BUILD FAILED")
        break
else:
    print("BUILD TIMEOUT")

print("FINAL:", q("test -f /opt/Anna_Analysis/dist/server.js && echo HAS_DIST || echo NO_DIST"))
client.close()
