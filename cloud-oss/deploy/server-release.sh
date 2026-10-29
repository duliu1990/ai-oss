#!/usr/bin/env bash
set -euo pipefail

fail() { echo "ERROR: $*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail "Run with sudo."
[[ $# == 2 ]] || fail "Usage: server-release.sh deploy ARCHIVE | rollback RELEASE_ID"
[[ -f /etc/systemd/system/driver-oss.service && -f /etc/driver-oss.env ]] || fail "Run setup first."
exec 9>/run/lock/driver-oss-deploy.lock
flock -n 9 || fail "Another deployment is running."

base=/opt/driver-oss
export UV_PYTHON_INSTALL_DIR="$base/python"
export UV_CACHE_DIR=/var/cache/driver-oss-uv
export UV_LINK_MODE=copy
export UV_COMPILE_BYTECODE=0
export UV_CONCURRENT_BUILDS=1
export UV_CONCURRENT_INSTALLS=1
export UV_CONCURRENT_DOWNLOADS=2

case "$1" in
    deploy)
        [[ -f "$2" ]] || fail "Release archive not found."
        release=$(mktemp -d "$base/releases/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
        chmod 755 "$release"
        tar --extract --gzip --file "$2" --directory "$release" --no-same-owner
        [[ -s "$release/frontend/dist/index.html" ]] || fail "Frontend index is missing."
        (
            cd "$release"
            /usr/local/bin/uv sync --locked --no-dev --no-install-project --python 3.12
        )
        ln -s /etc/driver-oss.env "$release/.env"
        ;;
    rollback)
        [[ "$2" =~ ^[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9]{8}$ ]] || fail "Invalid release ID."
        release="$base/releases/$2"
        [[ -d "$release" && ! -L "$release" ]] || fail "Release directory not found."
        ;;
    *) fail "Unknown action: $1" ;;
esac

[[ -x "$release/.venv/bin/python" ]] || fail "Release Python environment is missing."
[[ -L "$release/.env" && -s "$release/frontend/dist/index.html" ]] || fail "Release is incomplete."
(
    cd "$release"
    runuser -u driver-oss -- env PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -c \
        'from config import settings; import sys; missing = settings.oss_missing; print("Missing OSS settings: " + ", ".join(missing)) if missing else None; sys.exit(bool(missing))'
)

old=
if [[ -L "$base/current" ]]; then
    old=$(readlink -f "$base/current") || fail "Cannot resolve the current release."
    [[ "$old" == "$base/releases/"* && -d "$old" ]] || fail "Current release link is invalid."
elif [[ -e "$base/current" ]]; then
    fail "Current release path must be a symbolic link."
fi

switch_release() {
    ln -s "$1" "$base/current.next"
    mv -Tf "$base/current.next" "$base/current"
}

healthy() {
    local attempt
    for attempt in {1..30}; do
        if systemctl is-active --quiet driver-oss \
            && curl --fail --silent --max-time 2 http://127.0.0.1:8700/healthz >/dev/null \
            && curl --fail --silent --max-time 2 http://127.0.0.1:8700/ >/dev/null \
            && curl --fail --silent --max-time 2 http://127.0.0.1:8700/api/config >/dev/null; then
            return 0
        fi
        sleep 1
    done
    return 1
}

[[ ! -e "$base/current.next" && ! -L "$base/current.next" ]] || fail "Stale current.next exists; inspect it first."
switch_release "$release"
if systemctl restart driver-oss && healthy; then
    systemctl enable driver-oss
    echo "Active release: $(basename "$release")"
    [[ -z "$old" ]] || echo "Previous release: $(basename "$old")"
    echo "HTTP checks passed. Verify an OSS directory listing through the SSH tunnel."
else
    echo "ERROR: Release failed. Recent service logs:" >&2
    if ! journalctl -u driver-oss -n 40 --no-pager >&2; then
        echo "WARNING: Could not read service logs." >&2
    fi
    if [[ -n "$old" ]]; then
        switch_release "$old"
        if systemctl restart driver-oss && healthy; then
            echo "Restored previous release: $(basename "$old")" >&2
        else
            echo "ERROR: Previous release also failed. Inspect journalctl." >&2
        fi
    else
        systemctl stop driver-oss
        rm -f "$base/current"
        echo "No previous release exists; service stopped." >&2
    fi
    exit 1
fi
