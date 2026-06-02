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

for i in range(60):
    try:
        client = connect()
        _, stdout, _ = client.exec_command(
            "cat /etc/redhat-release 2>/dev/null; echo ---; "
            "ps aux | grep -E 'elevate|leapp' | grep -v grep; echo ---; "
            "wc -l /tmp/elevate_migrate.log; tail -25 /tmp/elevate_migrate.log"
        )
        text = stdout.read().decode("utf-8", errors="replace")
        client.close()
        print(f"=== poll {i + 1} ===")
        print(text)
        if "Rocky Linux" in text:
            print("MIGRATION COMPLETE")
            break
        if "rebooting" in text.lower():
            print("REBOOT PENDING")
    except Exception as exc:
        print(f"=== poll {i + 1} offline === {exc}")
    time.sleep(30)
