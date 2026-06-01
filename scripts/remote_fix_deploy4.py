#!/usr/bin/env python3
import paramiko
import time

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

FIX4 = r"""#!/bin/bash
set -e
exec > /tmp/anna_deploy_fix4.log 2>&1
echo "=== fix4 start $(date) ==="

systemctl stop anna-post-migrate-deploy.timer 2>/dev/null || true
pkill -f 'anna-deploy' 2>/dev/null || true
pkill -f 'npm ' 2>/dev/null || true
pkill -f node-gyp 2>/dev/null || true
sleep 2

dnf install -y gcc-toolset-12 gcc-toolset-12-gcc-c++ python3
source /opt/rh/gcc-toolset-12/enable
gcc --version | head -1
g++ --version | head -1
node -v

cd /opt/Anna_Analysis
rm -rf node_modules
export MAKEFLAGS=-j1
npm install --registry=https://registry.npmmirror.com --jobs=1
npm run build
mkdir -p data

if [ ! -f .env ]; then
cat > .env <<'EOF'
HOST=0.0.0.0
PORT=8765
CURSOR_AGENT_RUNTIME=cloud
ADMIN_ACCOUNT=admin
ADMIN_PASSWORD=ChangeMeNow!
EOF
fi

cat > /etc/systemd/system/anna-analysis.service <<'EOF'
[Unit]
Description=Anna Analysis
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/Anna_Analysis
EnvironmentFile=/opt/Anna_Analysis/.env
Environment=PATH=/opt/rh/gcc-toolset-12/root/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable anna-analysis
systemctl restart anna-analysis

if systemctl is-active firewalld >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=8765/tcp 2>/dev/null || true
  firewall-cmd --reload 2>/dev/null || true
fi

sleep 3
systemctl is-active anna-analysis
curl -sI http://127.0.0.1:8765/ | head -5
touch /var/lib/anna-analysis-deployed
systemctl disable anna-post-migrate-deploy.timer 2>/dev/null || true
echo "=== deploy done $(date) ==="
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)
sftp = client.open_sftp()
with sftp.file("/tmp/anna_deploy_fix4.sh", "w") as f:
    f.write(FIX4)
sftp.chmod("/tmp/anna_deploy_fix4.sh", 0o755)
sftp.close()
client.exec_command("nohup bash /tmp/anna_deploy_fix4.sh >/dev/null 2>&1 &")
time.sleep(2)
client.close()
print("fix4 started with gcc-toolset-12")
