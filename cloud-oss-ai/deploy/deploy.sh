#!/usr/bin/env bash
# AI-Generated: Qoder Agent 2026-11-23
# Run on the Linux server: sudo bash /opt/ai-oss/cloud-oss-ai/deploy/deploy.sh
set -euo pipefail
umask 022

PROJECT_ROOT=/opt/ai-oss/cloud-oss-ai
DIST="$PROJECT_ROOT/frontend/dist"
BACKEND="$PROJECT_ROOT/backend"
BACKEND_SCRIPT="$PROJECT_ROOT/deploy/backend.sh"
WEB_ROOT=/var/www/cloud-oss-ai
NGINX_SOURCE="$PROJECT_ROOT/deploy/cloud-oss-ai.conf"
NGINX_DIR=/etc/nginx/conf.d
NGINX_TARGET="$NGINX_DIR/cloud-oss-ai.conf"
NGINX_BACKUP=""
BACKEND_USER=""

usage() {
    cat <<'EOF'
Usage: sudo bash /opt/ai-oss/cloud-oss-ai/deploy/deploy.sh

  1. Clear /var/www/cloud-oss-ai contents and copy frontend/dist there.
  2. Install cloud-oss-ai.conf in /etc/nginx/conf.d, validate and reload nginx.
  3. Restart the backend in the background through deploy/backend.sh.

Requires: Linux, nginx managed by systemd, a built frontend/dist,
backend/.env and backend/.venv. No build or dependency installation is performed.
The backend runs as the owner of /opt/ai-oss/cloud-oss-ai/backend.
EOF
}

die() { echo "error: $*" >&2; exit 1; }

preflight() {
    [[ "$(uname -s)" == Linux ]] || die "this script is for the Linux server only."
    [[ $EUID -eq 0 ]] || die "run with sudo: sudo bash $0"
    local command file unexpected
    for command in nginx systemctl curl flock realpath stat id runuser install cp find chmod rm mktemp bash; do
        command -v "$command" >/dev/null 2>&1 || die "required command not found: $command"
    done
    [[ "$(systemctl show --property=LoadState --value nginx)" == loaded ]] \
        || die "nginx must be installed as an available systemd service."
    [[ -d "$PROJECT_ROOT" ]] || die "project directory missing: $PROJECT_ROOT"
    [[ "$(realpath -e -- "$PROJECT_ROOT")" == "$PROJECT_ROOT" ]] \
        || die "project directory must not resolve through a symlink."
    for file in "$DIST/index.html" "$DIST/preview.html" "$NGINX_SOURCE" "$BACKEND_SCRIPT" "$BACKEND/app.py" "$BACKEND/.env"; do
        [[ -s "$file" ]] || die "required file missing or empty: $file"
    done
    [[ -d "$DIST/assets" ]] || die "frontend assets missing; rebuild frontend/dist first."
    [[ -x "$BACKEND/.venv/bin/python" ]] || die "backend dependencies missing; run deploy/backend.sh setup first."
    unexpected="$(find "$DIST" ! -type d ! -type f -print -quit)" \
        || die "could not inspect frontend/dist; deployment cancelled."
    [[ -z "$unexpected" ]] || die "frontend/dist must contain only regular files and directories."
    [[ ! -L "$WEB_ROOT" && "$(realpath -m -- "$WEB_ROOT")" == "$WEB_ROOT" ]] \
        || die "web root must be a real directory at $WEB_ROOT, not a symlink."
    [[ ! -e "$WEB_ROOT" || -d "$WEB_ROOT" ]] || die "web root is not a directory."
    [[ ! -L "$NGINX_TARGET" ]] || die "nginx target must not be a symlink."
    [[ ! -e "$NGINX_TARGET" || -f "$NGINX_TARGET" ]] || die "nginx target is not a file."

    # Reuse the checkout's backend owner instead of changing the service account on deployment.
    BACKEND_USER="$(stat -c %U -- "$BACKEND")"
    id "$BACKEND_USER" >/dev/null 2>&1 || die "backend owner is not a valid local user."
    runuser -u "$BACKEND_USER" -- test -r "$BACKEND/.env" \
        || die "backend owner cannot read backend/.env."
    runuser -u "$BACKEND_USER" -- test -x "$BACKEND/.venv/bin/python" \
        || die "backend owner cannot execute the virtualenv Python."
    [[ ! -L "$BACKEND/run" ]] || die "backend/run must not be a symlink."
    if [[ ! -d "$BACKEND/run" ]]; then
        install -d -o "$BACKEND_USER" -g "$(id -gn "$BACKEND_USER")" -m 0755 -- "$BACKEND/run"
    fi
    runuser -u "$BACKEND_USER" -- test -w "$BACKEND/run" \
        || die "backend owner cannot write backend/run."
    for file in "$BACKEND/run/backend.pid" "$BACKEND/run/backend.log"; do
        if [[ -e "$file" ]]; then
            runuser -u "$BACKEND_USER" -- test -w "$file" \
                || die "backend owner cannot write $file; fix ownership before deploying."
        fi
    done
}

deploy_frontend() {
    echo "[1/3] Replacing frontend files in $WEB_ROOT"
    install -d -m 0755 -- "$WEB_ROOT"
    # Preserve the root directory, include hidden files, and never follow child symlinks.
    # -xdev prevents traversal into a mounted filesystem during cleanup.
    find "$WEB_ROOT" -xdev -mindepth 1 -delete
    cp -a -- "$DIST/." "$WEB_ROOT/"
    # Git checkout permissions or a restrictive umask must not prevent nginx from reading assets.
    find "$WEB_ROOT" -type d -exec chmod 0755 {} +
    find "$WEB_ROOT" -type f -exec chmod 0644 {} +
}

install_nginx() {
    echo "[2/3] Installing and validating $NGINX_TARGET"
    install -d -m 0755 -- "$NGINX_DIR"
    if [[ -f "$NGINX_TARGET" ]]; then
        NGINX_BACKUP="$(mktemp "$NGINX_DIR/.cloud-oss-ai.backup.XXXXXX")"
        cp -p -- "$NGINX_TARGET" "$NGINX_BACKUP"
    fi
    if ! install -m 0644 -- "$NGINX_SOURCE" "$NGINX_TARGET" || ! nginx -t; then
        if [[ -n "$NGINX_BACKUP" ]]; then
            cp -p -- "$NGINX_BACKUP" "$NGINX_TARGET"
        else
            rm -f -- "$NGINX_TARGET"
        fi
        die "nginx installation/validation failed; the site config was restored (or removed on first deployment)."
    fi
    if systemctl is-active --quiet nginx; then
        systemctl reload nginx
    else
        systemctl start nginx
    fi
}

restart_backend() {
    echo "[3/3] Restarting the backend in the background as $BACKEND_USER"
    # backend.sh uses nohup, redirects stdin/stdout/stderr and saves the real Python PID.
    # Keep the launcher in the foreground so startup errors reach this deployment command.
    # Close the deployment lock in children so the long-lived server cannot retain it.
    runuser -u "$BACKEND_USER" -- bash "$BACKEND_SCRIPT" restart 9>&-
    runuser -u "$BACKEND_USER" -- bash "$BACKEND_SCRIPT" status 9>&-
}

cleanup() {
    if [[ -n "$NGINX_BACKUP" ]]; then
        rm -f -- "$NGINX_BACKUP"
    fi
}

main() {
    case "${1:-}" in
        --help|-h) usage; return 0 ;;
        "") [[ $# -eq 0 ]] || { usage >&2; return 2; } ;;
        *) usage >&2; return 2 ;;
    esac
    preflight
    exec 9>"$BACKEND/run/deploy.lock"
    flock -n 9 || die "another deployment is already running."
    trap cleanup EXIT
    deploy_frontend
    install_nginx
    restart_backend
    echo "Deployment complete. Backend PID and log: $BACKEND/run/backend.pid and backend.log"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
