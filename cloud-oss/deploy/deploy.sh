#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: bash deploy/deploy.sh {setup|deploy|tunnel} SSH_ALIAS"
    echo "       bash deploy/deploy.sh rollback SSH_ALIAS RELEASE_ID"
}

fail() { echo "ERROR: $*" >&2; exit 1; }

action=${1:-}
host=${2:-}
case "$action" in
    setup|deploy|tunnel) [[ $# == 2 ]] || { usage >&2; exit 1; } ;;
    rollback) [[ $# == 3 ]] || { usage >&2; exit 1; } ;;
    *) usage >&2; exit 1 ;;
esac
[[ "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || fail "Use a simple SSH config alias, e.g. driver-ecs."
if [[ "$action" == rollback ]]; then
    [[ "$3" =~ ^[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9]{8}$ ]] || fail "Invalid release ID."
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
command -v ssh >/dev/null || fail "ssh is required."
if [[ "$action" == tunnel ]]; then
    echo "Open http://127.0.0.1:18700 ; Ctrl+C closes the tunnel."
    exec ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
        -o ServerAliveCountMax=3 -L 127.0.0.1:18700:127.0.0.1:8700 "$host"
fi
command -v scp >/dev/null || fail "scp is required."
local_stage=$(mktemp -d "${TMPDIR:-/tmp}/driver-oss.XXXXXXXX")
remote_stage=
cleanup() {
    status=$?
    trap - EXIT
    # Only remove the exact temporary files created by this invocation.
    rm -f "$local_stage/release.tar.gz"
    rmdir "$local_stage"
    if [[ -n "$remote_stage" ]]; then
        ssh "$host" "rm -f '$remote_stage/release.tar.gz' '$remote_stage/server-setup.sh' '$remote_stage/server-release.sh' '$remote_stage/driver-oss.service' '$remote_stage/.env.example'; rmdir '$remote_stage'" \
            || echo "WARNING: Could not clean remote staging directory: $remote_stage" >&2
    fi
    exit "$status"
}
trap cleanup EXIT

if [[ "$action" == deploy ]]; then
    command -v npm >/dev/null || fail "Install Node.js >=22.12 and npm >=10 locally."
    (
        cd "$root/frontend"
        npm ci --no-audit --no-fund
        npm run build
    )
    [[ -s "$root/frontend/dist/index.html" ]] || fail "Frontend build is missing."
    # Explicit allowlist: never send .env, node_modules, or the macOS virtualenv.
    COPYFILE_DISABLE=1 tar -czf "$local_stage/release.tar.gz" -C "$root" \
        --exclude='__pycache__' --exclude='*.pyc' \
        app.py config.py oss_store.py routes pyproject.toml uv.lock frontend/dist
fi

remote_stage=$(ssh "$host" 'umask 077; mktemp -d /tmp/driver-oss.XXXXXXXXXX')
[[ "$remote_stage" =~ ^/tmp/driver-oss\.[a-zA-Z0-9]{10}$ ]] || {
    remote_stage=
    fail "Unexpected SSH output; check shell startup messages and mktemp."
}
case "$action" in
    setup)
        scp "$root/deploy/server-setup.sh" "$root/deploy/driver-oss.service" \
            "$root/.env.example" "$host:$remote_stage/"
        ssh -t "$host" "sudo bash '$remote_stage/server-setup.sh' '$remote_stage'"
        ;;
    deploy)
        scp "$root/deploy/server-release.sh" "$local_stage/release.tar.gz" "$host:$remote_stage/"
        ssh -t "$host" "sudo bash '$remote_stage/server-release.sh' deploy '$remote_stage/release.tar.gz'"
        ;;
    rollback)
        scp "$root/deploy/server-release.sh" "$host:$remote_stage/"
        ssh -t "$host" "sudo bash '$remote_stage/server-release.sh' rollback '$3'"
        ;;
esac
