#!/usr/bin/env bash
# Local launcher for cloud-oss (backend/ + frontend/). macOS bash 3.2 compatible.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
# Must match BACKEND_ORIGIN in frontend/vite.config.ts and PORT in backend/.env.
BACKEND_PORT=8700
VITE_PORT=5173

usage() {
  cat <<'EOF'
Usage: ./run.sh [command]

  dev       (default) Start backend API on 127.0.0.1:8700 and Vite on
            http://127.0.0.1:5173 (hot reload, proxies /api). Ctrl-C stops both.
  start     Build the Web UI if sources changed, then serve UI + API on
            http://127.0.0.1:8700 from one backend process.
  backend   Backend API only on 127.0.0.1:8700 (serves frontend/dist if built).
  frontend  Vite dev server only on 127.0.0.1:5173 (proxies /api to 8700).
  build     Typecheck and build frontend/dist.
  setup     Install backend (uv) and frontend (npm ci) dependencies;
            create backend/.env from the example if it is missing.
  test      Backend pytest + ruff, frontend vitest + typecheck.
EOF
}

die() { echo "error: $*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "$1 not found; install it first (see README.md)."; }

port_free() {
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $1 is already in use; stop the other process first (lsof -nP -iTCP:$1 -sTCP:LISTEN)."
  fi
}

check_backend() {
  require uv
  [[ -f "$BACKEND/.env" ]] || die "backend/.env missing; run ./run.sh setup, then fill in the OSS settings."
  [[ -d "$BACKEND/.venv" ]] || die "backend dependencies missing; run ./run.sh setup."
}

check_frontend() {
  require npm
  [[ -d "$FRONTEND/node_modules" ]] || die "frontend dependencies missing; run ./run.sh setup."
}

build_frontend() {
  check_frontend
  npm --prefix "$FRONTEND" run build
}

# Rebuild only when a source/config file is newer than the last build.
build_if_stale() {
  local index="$FRONTEND/dist/index.html"
  if [[ ! -f "$index" ]] || [[ -n "$(find "$FRONTEND/src" "$FRONTEND/index.html" "$FRONTEND/preview.html" \
      "$FRONTEND/vite.config.ts" "$FRONTEND/tsconfig.json" "$FRONTEND/package.json" \
      -newer "$index" -type f 2>/dev/null | head -n 1)" ]]; then
    echo "Frontend sources changed; rebuilding frontend/dist ..."
    build_frontend
  else
    echo "frontend/dist is up to date."
  fi
}

run_backend() {
  check_backend
  port_free "$BACKEND_PORT"
  cd "$BACKEND"
  exec uv run --locked python app.py
}

cmd_setup() {
  require uv
  require npm
  (cd "$BACKEND" && uv sync --locked --native-tls --python 3.12)
  npm --prefix "$FRONTEND" ci
  if [[ ! -f "$BACKEND/.env" ]]; then
    cp "$BACKEND/.env.example" "$BACKEND/.env"
    chmod 600 "$BACKEND/.env"
    echo "Created backend/.env from the example; fill in the OSS settings before starting."
  fi
}

cmd_start() {
  check_backend
  build_if_stale
  echo "Open http://127.0.0.1:$BACKEND_PORT"
  run_backend
}

cmd_dev() {
  check_backend
  check_frontend
  port_free "$BACKEND_PORT"
  port_free "$VITE_PORT"

  local backend_pid frontend_pid
  (cd "$BACKEND" && exec uv run --locked python app.py) &
  backend_pid=$!
  npm --prefix "$FRONTEND" run dev &
  frontend_pid=$!

  cleanup() {
    trap - EXIT
    kill "$backend_pid" "$frontend_pid" 2>/dev/null || true
    wait 2>/dev/null || true
  }
  trap cleanup EXIT
  trap 'exit 0' INT TERM

  echo "Dev mode: open http://127.0.0.1:$VITE_PORT (Ctrl-C stops both processes)"
  # bash 3.2 has no `wait -n`; stop everything as soon as either side exits.
  while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$frontend_pid" 2>/dev/null; do
    sleep 1
  done
}

cmd_test() {
  require uv
  require npm
  (cd "$BACKEND" && uv run --locked python -m pytest -q && uv run --locked python -m ruff check .)
  npm --prefix "$FRONTEND" run test
  npm --prefix "$FRONTEND" run typecheck
}

case "${1:-dev}" in
  dev) cmd_dev ;;
  start) cmd_start ;;
  backend) run_backend ;;
  frontend) check_frontend; port_free "$VITE_PORT"; exec npm --prefix "$FRONTEND" run dev ;;
  build) build_frontend ;;
  setup) cmd_setup ;;
  test) cmd_test ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
