#!/usr/bin/env python3
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

checks = [
    ("date", "date"),
    ("os", "cat /etc/redhat-release 2>/dev/null || cat /etc/os-release | head -3"),
    ("leapp_proc", "ps aux | grep leapp | grep -v grep | wc -l"),
    ("anna_service", "systemctl is-active anna-analysis 2>/dev/null || echo not-installed"),
    ("deploy_flag", "test -f /var/lib/anna-analysis-deployed && echo yes || echo no"),
    ("autodeploy_timer", "systemctl is-active anna-post-migrate-deploy.timer 2>/dev/null || echo n/a"),
    ("upgrade_log_tail", "tail -8 /var/log/leapp/leapp-upgrade.log 2>/dev/null || echo no-leapp-log"),
    ("deploy_log_tail", "tail -8 /tmp/anna_deploy_rocky.log 2>/dev/null || echo no-deploy-log"),
    ("watcher_log_tail", "tail -8 /var/log/anna-post-migrate-deploy.log 2>/dev/null || echo no-watcher-log"),
    ("download_progress", "grep -oE '\\([0-9]+/589\\)' /var/log/leapp/leapp-upgrade.log 2>/dev/null | tail -1 || echo n/a"),
    ("port_8765", "curl -sI --connect-timeout 3 http://127.0.0.1:8765/ 2>/dev/null | head -1 || echo unreachable"),
]

for name, cmd in checks:
    _, stdout, _ = client.exec_command(cmd)
    val = stdout.read().decode("utf-8", errors="replace").strip()
    print(f"{name}: {val}")

client.close()
