#!/usr/bin/env python3
"""Fix stuck deploy: upgrade to Node 20 and complete deployment."""
import paramiko
import time

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

FIX_SCRIPT = r"""#!/bin/bash
set -e
exec > /tmp/anna_deploy_fix2.log 2>&1
echo "=== fix deploy start $(date) ==="

pkill -f 'anna-deploy-rocky.sh' 2>/dev/null || true
pkill -f 'npm install' 2>/dev/null || true
pkill -f 'npm rebuild' 2>/dev/null || true
pkill -f node-gyp 2>/dev/null || true
sleep 2

curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs git gcc-c++ make python3 firewalld
node -v
npm -v

cd /opt/Anna_Analysis
rm -rf node_modules
npm install --registry=https://registry.npmmirror.com
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


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

    sftp = client.open_sftp()
    with sftp.file("/tmp/anna_deploy_fix2.sh", "w") as f:
        f.write(FIX_SCRIPT)
    sftp.chmod("/tmp/anna_deploy_fix2.sh", 0o755)
    sftp.close()

    client.exec_command("nohup bash /tmp/anna_deploy_fix2.sh >/dev/null 2>&1 &")
    time.sleep(2)
    client.close()
    print("Fix deploy started (Node 20 upgrade + rebuild).")


if __name__ == "__main__":
    main()
