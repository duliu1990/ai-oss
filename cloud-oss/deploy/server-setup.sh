#!/usr/bin/env bash
set -euo pipefail

[[ $EUID == 0 ]] || { echo "Run with sudo." >&2; exit 1; }
[[ $# == 1 && -f "$1/driver-oss.service" && -f "$1/.env.example" ]] || {
    echo "Usage: sudo bash server-setup.sh STAGING_DIRECTORY" >&2
    exit 1
}
. /etc/os-release
[[ "$ID" == ubuntu ]] || { echo "This setup script supports Ubuntu only." >&2; exit 1; }
command -v systemctl >/dev/null

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl build-essential util-linux

if ! id driver-oss >/dev/null 2>&1; then
    useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin driver-oss
fi
install -d -m 755 /opt/driver-oss /opt/driver-oss/releases /opt/driver-oss/python
install -d -m 700 /var/cache/driver-oss-uv

if [[ ! -x /usr/local/bin/uv ]]; then
    installer=$(mktemp /tmp/driver-oss-uv.XXXXXXXX)
    trap 'rm -f "$installer"' EXIT
    curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
        https://astral.sh/uv/install.sh -o "$installer"
    UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh "$installer"
fi
/usr/local/bin/uv --version
if [[ ! -e /etc/driver-oss.env ]]; then
    install -o root -g driver-oss -m 640 "$1/.env.example" /etc/driver-oss.env
fi
chown root:driver-oss /etc/driver-oss.env
chmod 640 /etc/driver-oss.env
install -o root -g root -m 644 "$1/driver-oss.service" /etc/systemd/system/driver-oss.service
systemctl daemon-reload
echo "Setup complete. Edit /etc/driver-oss.env with sudoedit, then run deploy locally."
echo "No firewall rules were changed. Do NOT expose port 8700."
