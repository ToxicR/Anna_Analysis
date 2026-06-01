#!/usr/bin/env python3
"""CentOS 7 -> Rocky 8 via ELevate, then deploy Anna Analysis."""
import sys
import time
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"


def connect(retries=5, wait=8):
    last = None
    for i in range(retries):
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)
            return client
        except Exception as error:
            last = error
            time.sleep(wait * (i + 1))
    raise last


def run(client, cmd, timeout=600):
    print(">>>", cmd[:120].replace("\n", " "))
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    text = (out + err).strip()
    if text:
        print(text[-8000:])
    print("exit", code, "\n")
    return code, out, err


ELEVATE_SCRIPT = r"""#!/bin/bash
set -e
exec > /tmp/elevate_migrate.log 2>&1
echo "=== elevate start $(date) ==="

yum-config-manager --disable centos-sclo-sclo centos-sclo-sclo-testing 2>/dev/null || true
yum clean all
yum makecache fast

yum install -y http://repo.almalinux.org/elevate/elevate-release-latest-el7.noarch.rpm
yum install -y leapp-upgrade leapp-data-rocky

# common leapp blockers on centos 7
systemctl stop anna-analysis 2>/dev/null || true
systemctl disable anna-analysis 2>/dev/null || true
rm -f /etc/systemd/system/anna-analysis.service
systemctl daemon-reload || true

cat > /etc/modprobe.d/disable-removed-drivers.conf <<'EOF'
blacklist pata_acpi
blacklist floppy
install pata_acpi /bin/false
install floppy /bin/false
EOF
rmmod floppy 2>/dev/null || true
rmmod pata_acpi 2>/dev/null || true

export LEAPP_UNSUPPORTED=1
export LEAPP_DEVEL_SKIP_RHSM=1

leapp answer --section remove_pam_pkcs11_module_check.confirm=True

leapp preupgrade || true
echo "=== preupgrade finished $(date) ==="
tail -30 /var/log/leapp/leapp-report.txt 2>/dev/null || true

if grep -qi '(inhibitor)' /var/log/leapp/leapp-report.txt; then
  echo "=== preupgrade has inhibitors, abort ==="
  grep -i inhibitor /var/log/leapp/leapp-report.txt || true
  exit 1
fi

leapp upgrade
echo "=== upgrade finished $(date), rebooting ==="
sleep 3
reboot
"""

DEPLOY_SCRIPT = r"""#!/bin/bash
set -e
exec > /tmp/anna_deploy_rocky.log 2>&1
echo "=== deploy start $(date) ==="
cat /etc/redhat-release || true

if command -v dnf >/dev/null 2>&1; then PKG=dnf; else PKG=yum; fi
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  $PKG install -y nodejs git gcc-c++ make python3
fi
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  $PKG install -y nodejs
fi
node -v
npm -v

if [ ! -d /opt/Anna_Analysis/.git ]; then
  rm -rf /opt/Anna_Analysis
  git clone --depth 1 -b Anna_Analysis_Cursor https://github.com/ToxicR/Anna_Analysis.git /opt/Anna_Analysis
fi

cd /opt/Anna_Analysis
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
sleep 3
systemctl is-active anna-analysis
curl -sI http://127.0.0.1:8765/ | head -5
echo "=== deploy done $(date) ==="
"""


def upload(client, path, content):
    sftp = client.open_sftp()
    with sftp.file(path, "w") as handle:
        handle.write(content)
    sftp.chmod(path, 0o755)
    sftp.close()


def wait_for_os(keyword="Rocky", max_wait=1800):
    print(f"Waiting for server (expect {keyword})...")
    for i in range(max_wait // 15):
        time.sleep(15)
        try:
            client = connect(retries=1, wait=2)
            _, out, _ = run(client, "cat /etc/redhat-release 2>/dev/null || true", 30)
            client.close()
            print("OS:", out.strip())
            if keyword.lower() in out.lower():
                return True
            if i > 5 and "CentOS Linux release 7" not in out:
                return True
        except Exception:
            print(f"  ... offline ({i+1})")
    return False


def main():
    phase = sys.argv[1] if len(sys.argv) > 1 else "all"

    if phase in ("all", "migrate"):
        client = connect()
        upload(client, "/tmp/elevate_migrate.sh", ELEVATE_SCRIPT)
        client.exec_command("nohup bash /tmp/elevate_migrate.sh >/dev/null 2>&1 &")
        time.sleep(2)
        client.close()
        print("ELevate migration started. Server will reboot when finished.")
        if phase == "migrate":
            return
        if not wait_for_os("Rocky", 2400):
            client = connect()
            run(client, "tail -50 /tmp/elevate_migrate.log 2>/dev/null; tail -30 /var/log/leapp/leapp-report.txt 2>/dev/null", 60)
            client.close()
            raise SystemExit("Migration did not complete in time")

    client = connect(retries=40, wait=15)
    _, release, _ = run(client, "cat /etc/redhat-release || cat /etc/os-release", 30)
    if "Rocky" not in release:
        print("Current OS:", release.strip())
        run(client, "tail -40 /tmp/anna_deploy_rocky.log 2>/dev/null; tail -40 /tmp/elevate_migrate.log 2>/dev/null", 60)
        client.close()
        raise SystemExit("Server is not Rocky Linux yet. Fresh OS reinstall may be required.")

    upload(client, "/tmp/anna_deploy_rocky.sh", DEPLOY_SCRIPT)
    code, out, _ = run(client, "bash /tmp/anna_deploy_rocky.sh", 2400)
    client.close()
    if code != 0 or "deploy done" not in out:
        raise SystemExit("Deploy failed")
    print("SUCCESS: http://192.168.1.89:8765")


if __name__ == "__main__":
    main()
