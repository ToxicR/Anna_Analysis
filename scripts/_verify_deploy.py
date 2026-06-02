#!/usr/bin/env python3
import re
import urllib.request

checks = [
    ("https://annalog.jpgk.cn/static/admin.html", ["feishu-chat-lookup", "fetchFeishuChatInfo", "获取群信息"]),
    ("https://annalog.jpgk.cn/static/admin.js", ["lookupFeishuChatInfo", "/info"]),
]

for url, needles in checks:
    body = urllib.request.urlopen(url, timeout=15).read().decode("utf-8", "replace")
    print(url, "OK")
    for needle in needles:
        print(f"  {needle}:", needle in body)
