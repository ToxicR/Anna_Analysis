#!/usr/bin/env python3
"""Local integration test for app-user project access restrictions."""
import argparse
import json
import time
import urllib.error
import urllib.request


ADMIN_ACCOUNT = "13473458864"
ADMIN_PASSWORD = "1qaz2wsx"
DEFAULT_USER_PASSWORD = "123456"


def request(base_url, method, path, body=None, cookie=None):
    headers = {"Content-Type": "application/json", "Cache-Control": "no-cache"}
    if cookie:
        headers["Cookie"] = cookie
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"{base_url}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            parsed = json.loads(text) if text else None
            return resp.status, dict(resp.headers), parsed
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", errors="replace") if error.fp else ""
        try:
            parsed = json.loads(text) if text else None
        except json.JSONDecodeError:
            parsed = text
        return error.code, dict(error.headers or {}), parsed


def assert_status(status, expected, label, body):
    if status != expected:
        raise AssertionError(f"{label}: expected {expected}, got {status}, body={body!r}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8765")
    parser.add_argument("--keep", action="store_true", help="Keep test records for browser testing")
    args = parser.parse_args()

    suffix = str(int(time.time()))
    project_a_id = None
    project_b_id = None
    user_id = None
    account = f"access_ui_{suffix}"
    new_password = f"accessPass{suffix}"
    admin_cookie = ""

    try:
      status, headers, body = request(
          args.base_url,
          "POST",
          "/api/admin/login",
          {"account": ADMIN_ACCOUNT, "password": ADMIN_PASSWORD},
      )
      assert_status(status, 200, "admin login", body)
      admin_cookie = headers.get("Set-Cookie") or headers.get("set-cookie") or ""
      if not admin_cookie:
          raise AssertionError("admin login did not return a session cookie")

      status, _, project_a = request(
          args.base_url,
          "POST",
          "/api/projects",
          {"name": f"权限测试项目A-{suffix}", "description": "allowed", "enabled": True},
          admin_cookie,
      )
      assert_status(status, 200, "create project A", project_a)
      project_a_id = int(project_a["id"])

      status, _, project_b = request(
          args.base_url,
          "POST",
          "/api/projects",
          {"name": f"权限测试项目B-{suffix}", "description": "denied", "enabled": True},
          admin_cookie,
      )
      assert_status(status, 200, "create project B", project_b)
      project_b_id = int(project_b["id"])

      status, _, user = request(
          args.base_url,
          "POST",
          "/api/admin/users",
          {
              "account": account,
              "display_name": "项目权限测试用户",
              "enabled": True,
              "project_access_all": False,
              "allowed_project_ids": [project_a_id],
          },
          admin_cookie,
      )
      assert_status(status, 200, "create restricted user", user)
      user_id = int(user["id"])
      if user.get("project_access_all") is not False or user.get("allowed_project_ids") != [project_a_id]:
          raise AssertionError(f"created user access mismatch: {user}")

      status, headers, login_body = request(
          args.base_url,
          "POST",
          "/api/auth/login",
          {"account": account, "password": DEFAULT_USER_PASSWORD},
      )
      assert_status(status, 200, "restricted user login", login_body)
      user_cookie = headers.get("Set-Cookie") or headers.get("set-cookie") or ""
      if not user_cookie:
          raise AssertionError("user login did not return a session cookie")

      status, _, change_body = request(
          args.base_url,
          "POST",
          "/api/auth/change-password",
          {"new_password": new_password},
          user_cookie,
      )
      assert_status(status, 200, "restricted user first password change", change_body)

      status, _, projects = request(args.base_url, "GET", "/api/projects", None, user_cookie)
      assert_status(status, 200, "restricted user project list", projects)
      project_ids = [int(project["id"]) for project in projects]
      if project_ids != [project_a_id]:
          raise AssertionError(f"restricted user should only see project A, got {project_ids}")

      combined_cookie = f"{admin_cookie.split(';')[0]}; {user_cookie.split(';')[0]}"
      status, _, scoped_projects = request(args.base_url, "GET", "/api/projects?scope=user", None, combined_cookie)
      assert_status(status, 200, "restricted user project list with admin cookie present", scoped_projects)
      scoped_project_ids = [int(project["id"]) for project in scoped_projects]
      if scoped_project_ids != [project_a_id]:
          raise AssertionError(f"scope=user should only see project A even with admin cookie, got {scoped_project_ids}")

      status, _, denied = request(
          args.base_url,
          "POST",
          "/api/chat/sessions",
          {"project_id": project_b_id, "repo_ids": []},
          user_cookie,
      )
      assert_status(status, 403, "create session for denied project", denied)

      print("project access API test passed")
      print(json.dumps({
          "account": account,
          "password": new_password,
          "allowed_project_id": project_a_id,
          "denied_project_id": project_b_id,
          "kept": args.keep,
      }, ensure_ascii=False))
    finally:
      if not args.keep and admin_cookie:
          if user_id:
              request(args.base_url, "DELETE", f"/api/admin/users/{user_id}", None, admin_cookie)
          if project_a_id:
              request(args.base_url, "DELETE", f"/api/projects/{project_a_id}", None, admin_cookie)
          if project_b_id:
              request(args.base_url, "DELETE", f"/api/projects/{project_b_id}", None, admin_cookie)


if __name__ == "__main__":
    main()
