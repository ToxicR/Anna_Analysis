#!/usr/bin/env python3
"""Resume ELevate migration after fixing leapp inhibitors."""
import time
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

RESUME_SCRIPT = r"""#!/bin/bash
set -e
exec >> /tmp/elevate_migrate.log 2>&1
echo "=== resume $(date) ==="

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

leapp preupgrade
echo "=== preupgrade retry finished $(date) ==="

if grep -qi '(inhibitor)' /var/log/leapp/leapp-report.txt; then
  echo "=== still has inhibitors, abort ==="
  grep -i inhibitor /var/log/leapp/leapp-report.txt || true
  exit 1
fi

leapp upgrade
"""


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

    sftp = client.open_sftp()
    with sftp.file("/tmp/elevate_resume.sh", "w") as handle:
        handle.write(RESUME_SCRIPT)
    sftp.chmod("/tmp/elevate_resume.sh", 0o755)
    sftp.close()

    client.exec_command("nohup bash /tmp/elevate_resume.sh >/dev/null 2>&1 &")
    time.sleep(2)
    client.close()
    print("Resume migration started.")


if __name__ == "__main__":
    main()
