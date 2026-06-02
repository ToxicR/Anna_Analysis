#!/usr/bin/env python3
import paramiko
import time

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

def connect():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=20, banner_timeout=30)
    return client

for i in range(180):
    try:
        client = connect()
        _, stdout, _ = client.exec_command(
            "cat /etc/redhat-release 2>/dev/null; echo ---; "
            "ps aux | grep leapp | grep -v grep | wc -l; "
            "ps aux | grep leapp | grep -v grep | tail -2; echo ---; "
            "tail -15 /var/log/leapp/leapp-upgrade.log 2>/dev/null; echo ---; "
            "grep 'upgrade finished' /tmp/elevate_migrate.log | tail -1"
        )
        text = stdout.read().decode("utf-8", errors="replace")
        client.close()
        print(f"=== poll {i + 1} ===")
        print(text)
        if "Rocky Linux" in text:
            print("MIGRATION COMPLETE")
            break
    except Exception as exc:
        print(f"=== poll {i + 1} offline === {exc}")
    time.sleep(60)
