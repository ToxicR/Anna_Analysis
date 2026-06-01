#!/usr/bin/env python3
"""Diagnose first-login password change flow purely via HTTP.

This avoids SSH and tests against the live deployment as the browser sees it.
"""
import json
import urllib.request
import urllib.error

BASE_URL = "https://annalog.jpgk.cn"
ACCOUNT = input("Account to test (will not change password): ").strip()
PASSWORD = input("Current password for this account: ").strip()


def request(method, path, body=None, cookie=None):
    headers = {"Content-Type": "application/json", "Cache-Control": "no-cache"}
    if cookie:
        headers["Cookie"] = cookie.split(";")[0]
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"{BASE_URL}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body_text = resp.read().decode("utf-8", errors="replace")
            return resp.status, dict(resp.headers), body_text
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        return e.code, dict(e.headers or {}), body_text


def main() -> None:
    print(f"\n=== 1. POST /api/auth/login as {ACCOUNT} ===")
    status, headers, body = request("POST", "/api/auth/login", {"account": ACCOUNT, "password": PASSWORD})
    print("status:", status)
    print("body:  ", body)
    cookie = headers.get("Set-Cookie") or headers.get("set-cookie") or ""
    print("cookie:", cookie.split(";")[0] if cookie else "(none)")
    if status != 200:
        return

    print("\n=== 2. GET /api/auth/me ===")
    status, _, body = request("GET", "/api/auth/me", None, cookie)
    print("status:", status)
    print("body:  ", body)

    print("\n=== 3. GET /api/projects (should be 200 if not must_change, 403 otherwise) ===")
    status, _, body = request("GET", "/api/projects", None, cookie)
    print("status:", status)
    print("body:  ", body[:200])

    print("\nDone. Inspect must_change_password in step 2 body.")
    print("If it is false but you still see the change-password page, the issue is in the frontend cache.")
    print("If it is true, the database row for this account was reset to require change again.")


if __name__ == "__main__":
    main()
