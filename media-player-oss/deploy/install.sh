#!/usr/bin/env bash
# Deploy media-player-oss on the ECS from a git clone (Ubuntu 24.04, run as root):
#
#   git clone https://github.com/duliu1990/ai-oss.git && cd ai-oss/media-player-oss
#   sudo deploy/install.sh                 # deploy the checked-out commit (HEAD)
#   git pull && sudo deploy/install.sh     # update
#   sudo deploy/install.sh rollback | status | logs
#   deploy/install.sh hash-password        # bcrypt hash for AUTH_PASSWORD_HASH
#
# Only committed files are deployed (git archive of HEAD). The Web UI is the committed
# frontend/dist, so the server needs no Node.js; Python deps come from backend/requirements.txt.
#
# Layout:
#   /opt/media-player-oss/releases/<id>/{backend,venv,web,deploy}   one immutable release each
#   /opt/media-player-oss/current -> releases/<id>                    switched atomically
#   /var/www/media-player-oss -> /opt/media-player-oss/current/web    Nginx document root
#   /etc/media-player-oss/backend.env                                 secrets (root:media-player 0640)
#   /var/lib/media-player-oss/library.json                            persistent library (systemd StateDirectory)
set -euo pipefail
# Release files must stay readable by the service user and www-data whatever umask sudo passes on.
umask 022

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(dirname "$DEPLOY_DIR")"
APP=media-player-oss
SERVICE_USER=media-player
BASE=/opt/$APP
RELEASES=$BASE/releases
CURRENT=$BASE/current
WEB_ROOT=/var/www/$APP
CONF_DIR=/etc/$APP
ENV_FILE=$CONF_DIR/backend.env
STATE_DIR=/var/lib/$APP
UNIT=/etc/systemd/system/$APP.service
NGINX_SNIPPET=/etc/nginx/snippets/$APP-proxy.conf
BACKEND_URL=http://127.0.0.1:8767
KEEP_RELEASES=3
# Aliyun ECS instance metadata service (public IP when SERVER_NAME is not given).
METADATA=http://100.100.100.200/latest/meta-data

log() { echo "==> $*"; }
die() { echo "error: $*" >&2; exit 1; }
require_root() { [[ $EUID -eq 0 ]] || die "run as root: sudo $0 ${1:-}"; }

# Release directory being built (or a temp dir); removed on exit unless cleared after going live.
BUILDING=""
trap '[[ -z $BUILDING ]] || rm -rf -- "$BUILDING"' EXIT

ensure_packages() {
  local missing=()
  command -v nginx >/dev/null || missing+=(nginx)
  command -v git >/dev/null || missing+=(git)
  command -v curl >/dev/null || missing+=(curl)
  # Ubuntu ships python3 without ensurepip; venv creation needs python3-venv.
  python3 -c 'import ensurepip' >/dev/null 2>&1 || missing+=(python3-venv)
  if ((${#missing[@]})); then
    log "installing packages: ${missing[*]}"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    apt-get install -y -q "${missing[@]}"
  fi
  python3 -c 'import sys; sys.exit(sys.version_info[:2] != (3, 12))' \
    || die "python3 must be 3.12 (pyproject requires >=3.12,<3.13); found $(python3 -V 2>&1)"
}

ensure_user_and_dirs() {
  id -u "$SERVICE_USER" >/dev/null 2>&1 \
    || useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  install -d -o root -g root -m 0755 "$BASE" "$RELEASES"
  install -d -o root -g "$SERVICE_USER" -m 0750 "$CONF_DIR"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$STATE_DIR"
}

# Run git as the clone's owner: root refuses foreign-owned repositories, and running a
# user's repository config as root would be unsafe anyway.
repo_git() {
  local owner
  owner=$(stat -c %U "$PROJECT")
  if [[ $owner == root ]]; then
    git -C "$PROJECT" "$@"
  else
    runuser -u "$owner" -- env HOME="$(getent passwd "$owner" | cut -d: -f6)" git -C "$PROJECT" "$@"
  fi
}

# SERVER_NAME env > value saved by a previous deploy > ECS public IP from the metadata service.
resolve_server_name() {
  local name=${SERVER_NAME:-}
  [[ -n $name ]] || name=$(cat "$CONF_DIR/server_name" 2>/dev/null || true)
  [[ -n $name ]] || name=$(curl -fsS -m 3 "$METADATA/eipv4" 2>/dev/null || true)
  [[ -n $name ]] || name=$(curl -fsS -m 3 "$METADATA/public-ipv4" 2>/dev/null || true)
  [[ -n $name ]] || die "cannot detect the public IP; rerun with SERVER_NAME=<public IP or domain>"
  [[ $name =~ ^[a-z0-9.-]+$ ]] || die "SERVER_NAME must be a lowercase host name or IPv4 address: $name"
  printf '%s\n' "$name" > "$CONF_DIR/server_name"
  SERVER_NAME=$name
}

# First deploy: write a server env from .env.example with server paths, the public Host and a
# fresh JWT secret. OSS and login values still have to be filled in by hand.
ensure_env() {
  local release=$1 jwt
  [[ ! -f $ENV_FILE ]] || return 0
  jwt=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
  {
    grep -vE '^(ALLOWED_HOSTS|LIBRARY_FILE|FRONTEND_DIST|ENABLE_DEV_ORIGIN|JWT_SECRET_KEY)=' "$release/backend/.env.example"
    cat <<EOF

# --- server settings written by deploy/install.sh ---
ALLOWED_HOSTS='["$SERVER_NAME","127.0.0.1","localhost"]'
LIBRARY_FILE=$STATE_DIR/library.json
FRONTEND_DIST=$WEB_ROOT
ENABLE_DEV_ORIGIN=false
JWT_SECRET_KEY=$jwt
EOF
  } > "$ENV_FILE.new"
  chown root:"$SERVICE_USER" "$ENV_FILE.new"
  chmod 0640 "$ENV_FILE.new"
  mv -f "$ENV_FILE.new" "$ENV_FILE"
  log "created $ENV_FILE"
}

build_release() {
  local id=$1 release=$RELEASES/$1 prefix cdup
  [[ ! -e $release ]] || die "release already exists: $release"
  install -d -m 0755 "$release"
  BUILDING=$release

  # Archive this project's tree of HEAD from the repository top, so paths are project-relative.
  prefix=$(repo_git rev-parse --show-prefix)
  cdup=$(repo_git rev-parse --show-cdup)
  repo_git -C "${cdup:-.}" archive --format=tar "HEAD:$prefix" backend deploy frontend/dist \
    | tar -x -C "$release" --no-same-owner --no-same-permissions
  [[ -f $release/frontend/dist/index.html ]] \
    || die "frontend/dist is not committed; run ./run.sh release locally and commit it"
  [[ -f $release/backend/requirements.txt ]] \
    || die "backend/requirements.txt is not committed; run ./run.sh release locally and commit it"
  mv "$release/frontend/dist" "$release/web"
  rm -rf "$release/frontend" "$release/backend/tests"
  chown -R root:root "$release"
  chmod -R u=rwX,go=rX "$release"

  log "creating virtualenv (PIP_INDEX_URL=${PIP_INDEX_URL:-pip default})"
  python3 -m venv "$release/venv"
  # Hash-pinned requirements exported from uv.lock; a mirror cannot alter them.
  "$release/venv/bin/pip" install -q --no-cache-dir --disable-pip-version-check \
    --require-hashes -r "$release/backend/requirements.txt" \
    || die "pip install failed; if PyPI is slow, retry with a mirror, e.g.
  sudo PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ $0"
  ln -s "$ENV_FILE" "$release/backend/.env"
  # The service cannot write into the read-only release, so compile bytecode up front.
  "$release/venv/bin/python" -m compileall -q "$release/backend" >/dev/null
}

# Fail before switching if the env does not parse, login is unconfigured (the API would
# answer 503) or the public Host would be rejected.
check_config() {
  local release=$1
  (cd "$release/backend" && runuser -u "$SERVICE_USER" -- "$release/venv/bin/python" -c '
import sys
from config import settings
server = sys.argv[1]
if settings.auth_missing:
    sys.exit("missing: " + ", ".join(settings.auth_missing))
if server not in settings.allowed_hosts:
    sys.exit(f"ALLOWED_HOSTS does not include {server}")
if settings.oss_missing:
    print("warning: OSS settings missing: " + ", ".join(settings.oss_missing), file=sys.stderr)
' "$SERVER_NAME") && return 0
  cat >&2 <<EOF

Edit $ENV_FILE (e.g. sudo nano $ENV_FILE):
  - OSS_ENDPOINT / OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET
    (same region: OSS_ENDPOINT=https://oss-cn-chengdu-internal.aliyuncs.com)
  - AUTH_USERNAME and AUTH_PASSWORD_HASH (generate with: $0 hash-password)
  - ALLOWED_HOSTS must contain "$SERVER_NAME"
then run: sudo $0
EOF
  die "configuration check failed"
}

install_system_files() {
  local release=$1 site link
  # Ubuntu's nginx uses sites-enabled; nginx.org packages only include conf.d.
  if grep -qs 'sites-enabled' /etc/nginx/nginx.conf; then
    site=/etc/nginx/sites-available/$APP
    link=/etc/nginx/sites-enabled/$APP
  else
    site=/etc/nginx/conf.d/$APP.conf
    link=""
  fi
  install -m 0644 "$release/deploy/$APP.service" "$UNIT"
  install -d -m 0755 /etc/nginx/snippets
  install -m 0644 "$release/deploy/nginx-proxy.conf" "$NGINX_SNIPPET"
  sed "s/__SERVER_NAME__/$SERVER_NAME/" "$release/deploy/nginx.conf" > "$site.new"
  chmod 0644 "$site.new"
  mv -f "$site.new" "$site"
  [[ -z $link ]] || ln -sfn "$site" "$link"
  if [[ -e $WEB_ROOT && ! -L $WEB_ROOT ]]; then
    die "$WEB_ROOT exists and is not a symlink; move it away first"
  fi
  ln -sfn "$CURRENT/web" "$WEB_ROOT"
  nginx -t -q || die "nginx configuration test failed"
  systemctl daemon-reload
  systemctl enable -q "$APP"
}

switch_to() {
  ln -sfn "$RELEASES/$1" "$CURRENT.new"
  mv -Tf "$CURRENT.new" "$CURRENT"
}

current_id() { [[ -L $CURRENT ]] && basename "$(readlink "$CURRENT")" || true; }

wait_healthy() {
  local i
  for i in $(seq 1 30); do
    curl -fsS -o /dev/null "$BACKEND_URL/healthz" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# Through Nginx with the public Host: health, Web UI, and the login gate on the API.
restart_and_check() {
  local code
  systemctl restart "$APP"
  wait_healthy || return 1
  if systemctl is-active -q nginx; then systemctl reload nginx; else systemctl enable -q --now nginx; fi
  curl -fsS -o /dev/null -H "Host: $SERVER_NAME" http://127.0.0.1/healthz || return 1
  curl -fsS -o /dev/null -H "Host: $SERVER_NAME" http://127.0.0.1/ || return 1
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $SERVER_NAME" http://127.0.0.1/api/tracks)
  [[ $code == 401 ]] || { echo "expected 401 from unauthenticated /api/tracks, got $code" >&2; return 1; }
}

prune_releases() {
  local current old
  current=$(current_id)
  for old in $(ls -1 "$RELEASES" | sort -r | tail -n +"$((KEEP_RELEASES + 1))"); do
    [[ $old == "$current" ]] && continue
    rm -rf -- "${RELEASES:?}/$old"
    log "pruned release $old"
  done
}

cmd_deploy() {
  require_root
  local rev id previous
  ensure_packages
  ensure_user_and_dirs
  resolve_server_name

  rev=$(repo_git rev-parse --short HEAD)
  if [[ -n $(repo_git status --porcelain -- .) ]]; then
    echo "warning: uncommitted changes in $PROJECT are not deployed; deploying HEAD ($rev)"
  fi
  id="$(date +%Y%m%d-%H%M%S)-$rev"
  log "building release $id for http://$SERVER_NAME/"
  build_release "$id"
  ensure_env "$RELEASES/$id"
  check_config "$RELEASES/$id"

  previous=$(current_id)
  # Unit and Nginx files are release-independent; validate them before switching.
  install_system_files "$RELEASES/$id"
  switch_to "$id"
  if restart_and_check; then
    BUILDING=""
    log "release $id is live at http://$SERVER_NAME/ (previous: ${previous:-none})"
    prune_releases
    echo "Open http://$SERVER_NAME/ in a browser; if it does not load, allow inbound TCP 80 in the ECS security group."
    return 0
  fi
  journalctl -u "$APP" -n 30 --no-pager >&2 || true
  if [[ -n $previous ]]; then
    log "health check failed; rolling back to $previous"
    switch_to "$previous"
    systemctl restart "$APP" || true
    if wait_healthy; then
      log "rolled back: $previous is serving again"
    else
      echo "error: $previous is not healthy either; check: sudo $0 logs" >&2
    fi
  else
    # First deploy: nothing to fall back to, so do not leave a crash-looping service behind.
    systemctl stop "$APP" || true
    rm -f "$CURRENT"
  fi
  die "deployment of $id failed"
}

cmd_rollback() {
  require_root
  local current target
  current=$(current_id)
  # Release ids start with a timestamp, so the newest id below the current one is the previous release.
  target=$(ls -1 "$RELEASES" 2>/dev/null | sort -r | awk -v c="$current" '$0 < c' | head -n 1 || true)
  [[ -n $target ]] || die "no earlier release to roll back to"
  switch_to "$target"
  systemctl restart "$APP"
  wait_healthy || die "rolled back to $target but the backend is not healthy"
  log "rolled back $current -> $target"
}

cmd_status() {
  echo "current release: $(current_id)"
  echo "releases: $(ls -1 "$RELEASES" 2>/dev/null | sort -r | tr '\n' ' ')"
  echo "server name: $(cat "$CONF_DIR/server_name" 2>/dev/null || echo unset)"
  systemctl --no-pager --lines=10 status "$APP" || true
}

# Uses the live venv when there is one; otherwise installs the hash-pinned bcrypt into a temp venv.
cmd_hash_password() {
  local python=$CURRENT/venv/bin/python tmp
  if [[ ! -x $python ]]; then
    tmp=$(mktemp -d)
    # Reuse the EXIT trap's cleanup: a trap on a local would expand after the function returned.
    BUILDING=$tmp
    awk '/^bcrypt==/ {p=1} p {print} p && !/\\$/ {exit}' "$PROJECT/backend/requirements.txt" > "$tmp/req.txt"
    [[ -s $tmp/req.txt ]] || die "bcrypt not found in backend/requirements.txt"
    python3 -m venv "$tmp/venv"
    "$tmp/venv/bin/pip" install -q --disable-pip-version-check --require-hashes -r "$tmp/req.txt"
    python=$tmp/venv/bin/python
  fi
  "$python" -c '
import getpass, sys
import bcrypt
password = getpass.getpass("New password: ")
if not password or password != getpass.getpass("Repeat: "):
    sys.exit("passwords are empty or do not match")
print("AUTH_PASSWORD_HASH=" + bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode())
'
}

case "${1:-deploy}" in
  deploy) cmd_deploy ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  logs) require_root; journalctl -u "$APP" -f -n 100 ;;
  hash-password) cmd_hash_password ;;
  -h|--help|help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "usage: $0 [deploy|rollback|status|logs|hash-password]" ;;
esac
