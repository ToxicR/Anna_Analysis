#!/usr/bin/env python3
"""Run leapp upgrade after preupgrade passed."""
import time
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

UPGRADE_SCRIPT = r"""#!/bin/bash
set -e
exec >> /tmp/elevate_migrate.log 2>&1
echo "=== leapp upgrade start $(date) ==="

export LEAPP_UNSUPPORTED=1
export LEAPP_DEVEL_SKIP_RHSM=1

if grep -qi '(inhibitor)' /var/log/leapp/leapp-report.txt; then
  echo "=== inhibitors still present, abort ==="
  grep -i inhibitor /var/log/leapp/leapp-report.txt
  exit 1
fi

leapp upgrade
echo "=== upgrade finished $(date), rebooting ==="
sleep 3
reboot
"""


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

    sftp = client.open_sftp()
    with sftp.file("/tmp/elevate_upgrade.sh", "w") as handle:
        handle.write(UPGRADE_SCRIPT)
    sftp.chmod("/tmp/elevate_upgrade.sh", 0o755)
    sftp.close()

    client.exec_command("nohup bash /tmp/elevate_upgrade.sh >/dev/null 2>&1 &")
    time.sleep(2)
    client.close()
    print("leapp upgrade started.")


if __name__ == "__main__":
    main()
