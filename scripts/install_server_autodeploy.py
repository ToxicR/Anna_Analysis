#!/usr/bin/env python3
"""Install server-side auto-deploy: runs on boot after Rocky 8 migration."""
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

DEPLOY_BODY = r"""#!/bin/bash
set -e
exec > /tmp/anna_deploy_rocky.log 2>&1
echo "=== deploy start $(date) ==="
cat /etc/redhat-release || true

if command -v dnf >/dev/null 2>&1; then PKG=dnf; else PKG=yum; fi
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  $PKG install -y nodejs git gcc-c++ make python3 firewalld
fi
node -v
npm -v

if [ ! -d /opt/Anna_Analysis/.git ]; then
  rm -rf /opt/Anna_Analysis
  git clone --depth 1 -b Anna_Analysis_Cursor https://github.com/ToxicR/Anna_Analysis.git /opt/Anna_Analysis
fi

cd /opt/Anna_Analysis
git fetch origin Anna_Analysis_Cursor 2>/dev/null || true
git checkout Anna_Analysis_Cursor 2>/dev/null || true
git pull --ff-only 2>/dev/null || true
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
echo "=== deploy done $(date) ==="
"""

WATCHER_SCRIPT = r"""#!/bin/bash
LOG=/var/log/anna-post-migrate-deploy.log
FLAG=/var/lib/anna-analysis-deployed
DEPLOY=/usr/local/sbin/anna-deploy-rocky.sh

exec >> "$LOG" 2>&1
echo "=== watcher start $(date) ==="

if [ -f "$FLAG" ]; then
  echo "already deployed"
  exit 0
fi

if pgrep -x leapp >/dev/null 2>&1 || pgrep -f 'leapp upgrade' >/dev/null 2>&1; then
  echo "leapp upgrade still running, skip"
  exit 0
fi

RELEASE=$(cat /etc/redhat-release 2>/dev/null || echo unknown)
echo "release: $RELEASE"
echo "$RELEASE" | grep -qi 'Rocky Linux release 8' || exit 0

echo "Rocky 8 detected, deploying..."
if bash "$DEPLOY" && grep -q 'deploy done' /tmp/anna_deploy_rocky.log; then
  touch "$FLAG"
  systemctl disable anna-post-migrate-deploy.service 2>/dev/null || true
  systemctl disable anna-post-migrate-deploy.timer 2>/dev/null || true
  echo "deploy success $(date)"
else
  echo "deploy failed $(date)"
  exit 1
fi
"""

SYSTEMD_SERVICE = """[Unit]
Description=Anna Analysis auto deploy after Rocky migration
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/var/lib/anna-analysis-deployed

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/anna-post-migrate-deploy.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
"""

SYSTEMD_TIMER = """[Unit]
Description=Retry Anna auto deploy until Rocky 8 is ready
Requires=anna-post-migrate-deploy.service

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
"""


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)
    sftp = client.open_sftp()

    for path, content, mode in (
        ("/usr/local/sbin/anna-deploy-rocky.sh", DEPLOY_BODY, 0o755),
        ("/usr/local/sbin/anna-post-migrate-deploy.sh", WATCHER_SCRIPT, 0o755),
        ("/etc/systemd/system/anna-post-migrate-deploy.service", SYSTEMD_SERVICE, 0o644),
        ("/etc/systemd/system/anna-post-migrate-deploy.timer", SYSTEMD_TIMER, 0o644),
    ):
        with sftp.file(path, "w") as handle:
            handle.write(content)
        sftp.chmod(path, mode)

    sftp.close()

    cmds = [
        "systemctl daemon-reload",
        "systemctl enable anna-post-migrate-deploy.service",
        "systemctl enable anna-post-migrate-deploy.timer",
        "systemctl start anna-post-migrate-deploy.timer",
        "systemctl is-enabled anna-post-migrate-deploy.timer",
        "systemctl list-timers anna-post-migrate-deploy.timer --no-pager",
    ]
    for cmd in cmds:
        _, stdout, stderr = client.exec_command(cmd)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        print(">>>", cmd)
        print((out + err).strip())

    client.close()
    print("\nOK: server will auto-deploy after Rocky 8 reboot (no local PC needed).")


if __name__ == "__main__":
    main()
