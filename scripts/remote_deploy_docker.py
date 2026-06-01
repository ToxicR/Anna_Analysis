#!/usr/bin/env python3
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"


def run(client, cmd, timeout=600):
    print(">>>", cmd[:120].replace("\n", " "))
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    text = (out + err).strip()
    if text:
        print(text[-5000:])
    print("exit", code, "\n")
    return code, out, err


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

    install_docker = r"""
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi
docker -v
"""
    code, _, _ = run(client, install_docker, 900)
    if code != 0:
        client.close()
        raise SystemExit("Docker install failed")

    env_setup = r"""
mkdir -p /opt/Anna_Analysis/data
if [ ! -f /opt/Anna_Analysis/.env ]; then
cat > /opt/Anna_Analysis/.env <<'EOF'
HOST=0.0.0.0
PORT=8765
CURSOR_AGENT_RUNTIME=cloud
ADMIN_ACCOUNT=admin
ADMIN_PASSWORD=ChangeMeNow!
EOF
fi
"""
    run(client, env_setup, 60)

    build = r"""
cd /opt/Anna_Analysis
docker run --rm -v "$PWD":/app -w /app node:18-bookworm bash -lc \
  "npm install --registry=https://registry.npmmirror.com && npm run build"
echo BUILD_OK
"""
    code, out, _ = run(client, build, 1800)
    if code != 0 or "BUILD_OK" not in out:
        client.close()
        raise SystemExit("Docker build failed")

    run_app = r"""
docker rm -f anna-analysis 2>/dev/null || true
docker run -d --name anna-analysis --restart unless-stopped \
  -p 8765:8765 \
  -v /opt/Anna_Analysis:/app \
  -v /opt/Anna_Analysis/data:/app/data \
  --env-file /opt/Anna_Analysis/.env \
  -w /app \
  node:18-bookworm \
  node dist/server.js
sleep 3
docker ps --filter name=anna-analysis
curl -sI http://127.0.0.1:8765/ | head -5
"""
    code, out, _ = run(client, run_app, 120)
    client.close()
    if code != 0 or "HTTP/" not in out:
        raise SystemExit("Service start failed")
    print("SUCCESS: http://192.168.1.89:8765")


if __name__ == "__main__":
    main()
