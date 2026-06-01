#!/usr/bin/env python3
import os
import time
import tarfile
import urllib.request
import paramiko

HOST = "192.168.1.89"
USER = "root"
PASSWORD = "jpgk@2026"
NODE_VERSION = "v16.20.2"
NODE_TAR = f"node-{NODE_VERSION}-linux-x64.tar.xz"
LOCAL_DIR = os.path.join(os.path.dirname(__file__), "..", ".deploy")
LOCAL_TAR = os.path.join(LOCAL_DIR, NODE_TAR)
REMOTE_TAR = f"/tmp/{NODE_TAR}"


def ensure_local_node_tar():
    os.makedirs(LOCAL_DIR, exist_ok=True)
    if os.path.exists(LOCAL_TAR) and os.path.getsize(LOCAL_TAR) > 20_000_000:
        return
    mirrors = [
        f"https://npmmirror.com/mirrors/node/{NODE_VERSION}/{NODE_TAR}",
        f"https://nodejs.org/dist/{NODE_VERSION}/{NODE_TAR}",
    ]
    last_error = None
    for url in mirrors:
        try:
            print(f"Downloading {url} ...")
            urllib.request.urlretrieve(url, LOCAL_TAR)
            if os.path.getsize(LOCAL_TAR) > 20_000_000:
                print(f"Downloaded {os.path.getsize(LOCAL_TAR)} bytes")
                return
        except Exception as error:
            last_error = error
            print(f"Mirror failed: {error}")
    raise RuntimeError(f"Unable to download Node tarball: {last_error}")


def ssh_run(client, cmd, timeout=120):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def main():
    ensure_local_node_tar()

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

    ssh_run(client, "pkill -f 'node-v16.20.2-linux-x64.tar.xz' || true", 30)
    ssh_run(client, "pkill -f anna_deploy.sh || true", 30)

    print("Uploading Node tarball...")
    sftp = client.open_sftp()
    sftp.put(LOCAL_TAR, REMOTE_TAR)
    sftp.close()

    install_node = f"""
set -e
mkdir -p /usr/local/lib/nodejs
tar -xJf {REMOTE_TAR} -C /usr/local/lib/nodejs
ln -sf /usr/local/lib/nodejs/node-{NODE_VERSION}-linux-x64/bin/node /usr/local/bin/node
ln -sf /usr/local/lib/nodejs/node-{NODE_VERSION}-linux-x64/bin/npm /usr/local/bin/npm
ln -sf /usr/local/lib/nodejs/node-{NODE_VERSION}-linux-x64/bin/npx /usr/local/bin/npx
node -v
npm -v
"""
    code, out, err = ssh_run(client, install_node, 120)
    print(out, err)
    if code != 0:
        raise SystemExit(f"Node install failed: {code}")

    deploy = r"""
set -e
if [ ! -d /opt/Anna_Analysis/.git ]; then
  git clone --depth 1 -b Anna_Analysis_Cursor https://github.com/ToxicR/Anna_Analysis.git /opt/Anna_Analysis
fi
cd /opt/Anna_Analysis
npm install --registry=https://registry.npmmirror.com
npm run build
mkdir -p data
if [ ! -f .env ]; then
cat > .env <<'EOF'
HOST=0.0.0.0
PORT=8765
CURSOR_AGENT_RUNTIME=cloud
ADMIN_ACCOUNT=admin
ADMIN_PASSWORD=ChangeMeNow!
EOF
fi
echo DEPLOY_OK
"""
    print("Deploying project (npm install may take several minutes)...")
    code, out, err = ssh_run(client, deploy, 900)
    print(out[-4000:])
    if err.strip():
        print("ERR:", err[-2000:])
    if code != 0 or "DEPLOY_OK" not in out:
        raise SystemExit(f"Deploy failed: {code}")

    systemd = r"""
cat > /etc/systemd/system/anna-analysis.service <<'EOF'
[Unit]
Description=Anna Analysis
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/Anna_Analysis
EnvironmentFile=/opt/Anna_Analysis/.env
ExecStart=/usr/local/bin/node dist/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable anna-analysis
systemctl restart anna-analysis
sleep 2
systemctl is-active anna-analysis
curl -sI http://127.0.0.1:8765/ | head -3
"""
    code, out, err = ssh_run(client, systemd, 60)
    print(out, err)

    client.close()
    print("Done. Visit http://192.168.1.89:8765")


if __name__ == "__main__":
    main()
