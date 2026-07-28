#!/usr/bin/env python3
import paramiko
import sys
sys.stdout.reconfigure(encoding="utf-8")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("192.168.1.89", username="root", password="jpgk@2026", timeout=30)
cmds = [
    "systemctl is-active anna-analysis",
    "grep -c ingestFeishuIncomingAttachments /opt/Anna_Analysis/dist/services/feishu/files.js",
    "grep -c stageAttachments /opt/Anna_Analysis/dist/services/feishu/webhook.js",
    "grep -c 'im:message.group_msg' /opt/Anna_Analysis/dist/services/feishu/deliver.js",
]
for cmd in cmds:
    _, stdout, stderr = client.exec_command(cmd, timeout=30)
    out = (stdout.read() + stderr.read()).decode("utf-8", errors="replace").strip()
    print(f"{cmd} -> {out}")
client.close()
