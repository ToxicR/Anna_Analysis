#!/usr/bin/env python3
"""Wait for Rocky 8, then deploy Anna Analysis."""
import subprocess
import sys
import time
from pathlib import Path
import paramiko

ROOT = Path(__file__).resolve().parent.parent

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"


def get_release():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=20, banner_timeout=30)
    _, stdout, _ = client.exec_command("cat /etc/redhat-release 2>/dev/null")
    release = stdout.read().decode("utf-8", errors="replace").strip()
    client.close()
    return release


def main():
    print("Waiting for Rocky Linux 8...")
    for i in range(360):
        try:
            release = get_release()
            print(f"[{i + 1}] {release}")
            if "Rocky Linux release 8" in release:
                print("Rocky 8 detected, starting deploy...")
                result = subprocess.run(
                    [sys.executable, str(ROOT / "scripts" / "remote_migrate_rocky_deploy.py"), "deploy"],
                    cwd=str(ROOT),
                    capture_output=True,
                    text=True,
                )
                print(result.stdout)
                print(result.stderr)
                return result.returncode
        except Exception as exc:
            print(f"[{i + 1}] offline: {exc}")
        time.sleep(60)
    print("Timed out waiting for Rocky 8")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
