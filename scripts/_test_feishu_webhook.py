#!/usr/bin/env python3
"""Simulate Feishu im.message.receive_v1 and test reply API."""
import json
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"

payload = {
    "schema": "2.0",
    "header": {
        "event_id": "test-event-1",
        "event_type": "im.message.receive_v1",
        "create_time": "1780304000000",
        "token": "",
        "app_id": "cli_test",
        "tenant_key": "test",
    },
    "event": {
        "sender": {
            "sender_id": {
                "open_id": "ou_test_user",
                "union_id": "on_test_user",
            },
            "sender_type": "user",
        },
        "message": {
            "message_id": "om_test_msg",
            "chat_id": "oc_test_chat",
            "chat_type": "group",
            "message_type": "text",
            "content": json.dumps({"text": "/帮助"}, ensure_ascii=False),
        },
    },
}

script = f"""
curl -s -w '\\nHTTP:%{{http_code}}\\n' -X POST http://127.0.0.1:8765/api/feishu/webhook \\
  -H 'Content-Type: application/json' \\
  -d '{json.dumps(payload, ensure_ascii=False)}'
sleep 1
journalctl -u anna-analysis --since '1 minute ago' --no-pager | tail -20
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)
_, stdout, stderr = client.exec_command(script, timeout=60)
print((stdout.read() + stderr.read()).decode("utf-8", errors="replace"))
client.close()
