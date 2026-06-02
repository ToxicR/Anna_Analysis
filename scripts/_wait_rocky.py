#!/usr/bin/env python3
import paramiko
import time
import sys

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"


def connect():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=20, banner_timeout=30)
    return client


def get_release(client):
    _, stdout, _ = client.exec_command("cat /etc/redhat-release 2>/dev/null")
    return stdout.read().decode("utf-8", errors="replace").strip()


def main():
    for i in range(360):
        try:
            client = connect()
            release = get_release(client)
            _, stdout, _ = client.exec_command(
                "ps aux | grep '[l]eapp upgrade' | wc -l; "
                "tail -3 /var/log/leapp/leapp-upgrade.log 2>/dev/null; "
                "grep 'upgrade finished' /tmp/elevate_migrate.log | tail -1"
            )
            extra = stdout.read().decode("utf-8", errors="replace")
            client.close()
            print(f"[{i+1}] {release}")
            if "Rocky Linux release 8" in release:
                print("DONE: Rocky 8")
                return 0
            if i % 5 == 0:
                print(extra)
        except Exception as exc:
            print(f"[{i+1}] offline: {exc}")
        time.sleep(60)
    return 1


if __name__ == "__main__":
    sys.exit(main())
