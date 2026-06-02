#!/usr/bin/env python3
import paramiko
import time

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

for i in range(6):
    cmd = (
        "ps aux | grep elevate | grep -v grep; "
        "ps aux | grep leapp | grep -v grep; "
        "ps aux | grep '[y]um'; "
        "echo ---; "
        "wc -l /tmp/elevate_migrate.log; "
        "tail -50 /tmp/elevate_migrate.log"
    )
    _, stdout, _ = client.exec_command(cmd)
    print(f"=== poll {i + 1} ===")
    print(stdout.read().decode("utf-8", errors="replace"))
    time.sleep(20)

client.close()
