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

    prep = r"""
yum-config-manager --disable centos-sclo-sclo centos-sclo-sclo-testing 2>/dev/null || true
for f in /etc/yum.repos.d/CentOS-SCLo-*.repo; do
  [ -f "$f" ] || continue
  sed -i 's/^enabled=1/enabled=0/g' "$f"
done
sed -i 's/^enabled=0/enabled=1/g' /etc/yum.repos.d/CentOS-SCLo-scl-rh.repo
sed -i 's/^mirrorlist=/#mirrorlist=/g' /etc/yum.repos.d/CentOS-SCLo-scl-rh.repo
sed -i 's|^#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|g' /etc/yum.repos.d/CentOS-SCLo-scl-rh.repo
yum clean all
yum makecache fast 2>&1 | tail -5
"""
    run(client, prep, 300)
    run(client, "yum install -y devtoolset-8-gcc devtoolset-8-gcc-c++ 2>&1 | tail -15", 600)

    build = r"""
source /opt/rh/devtoolset-8/enable
gcc --version | head -1
cd /opt/Anna_Analysis
rm -rf node_modules
npm install --registry=https://registry.npmmirror.com
npm run build
test -f dist/server.js && echo BUILD_OK
"""
    code, out, _ = run(client, build, 1800)
    if code != 0 or "BUILD_OK" not in out:
        client.close()
        raise SystemExit("Build failed")

    run(client, "systemctl stop anna-analysis 2>/dev/null; systemctl disable anna-analysis 2>/dev/null; true", 30)

    start = r"""
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
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable anna-analysis
systemctl restart anna-analysis
sleep 3
systemctl is-active anna-analysis
curl -sI http://127.0.0.1:8765/ | head -5
"""
    code, out, _ = run(client, start, 60)
    client.close()
    if "active" in out and "HTTP/" in out:
        print("SUCCESS: http://192.168.1.89:8765")
    else:
        raise SystemExit("Service failed to start")


if __name__ == "__main__":
    main()
