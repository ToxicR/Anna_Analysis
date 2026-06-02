#!/usr/bin/env python3
"""Simulate card.action.trigger for new_session command."""
import json
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

payload = {
    "schema": "2.0",
    "header": {
        "event_id": "test-card-action-1",
        "event_type": "card.action.trigger",
        "create_time": "1780329200000",
        "token": "",
        "app_id": "cli_aa97f959ec7b1bdf",
        "tenant_key": "test",
    },
    "event": {
        "operator": {
            "open_id": "ou_09da36813a878069be2548e92c128c4d",
        },
        "action": {
            "value": {
                "action": "run_command",
                "command": "new_session",
                "chat_type": "group",
            },
            "tag": "button",
        },
        "context": {
            "open_chat_id": "oc_0b69fbfe84abdbb1984b54b0575bb643",
        },
    },
}

script = f"""
curl -s -w '\\nHTTP:%{{http_code}}\\n' -X POST http://127.0.0.1:8765/api/feishu/webhook \\
  -H 'Content-Type: application/json' \\
  -d '{json.dumps(payload, ensure_ascii=False)}'
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)
_, stdout, stderr = client.exec_command(script, timeout=60)
print((stdout.read() + stderr.read()).decode("utf-8", errors="replace"))
client.close()
