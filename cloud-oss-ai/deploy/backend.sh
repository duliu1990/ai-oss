#!/usr/bin/env bash
# Background launcher for the cloud-oss-ai backend on a Linux server (no systemd required).
# The API listens on 127.0.0.1:$PORT only; put deploy/cloud-oss-ai.conf (nginx) in front of it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
RUN_DIR="$BACKEND/run"
PID_FILE="$RUN_DIR/backend.pid"
LOG_FILE="$RUN_DIR/backend.log"
PYTHON="$BACKEND/.venv/bin/python"

usage() {
  cat <<'EOF'
Usage: deploy/backend.sh <command>

  setup     Install backend dependencies with uv (backend/.venv) and create
            backend/.env from the example if it is missing.
  start     Start the backend in the background (nohup); logs go to backend/run/backend.log.
  stop      Stop the background backend.
  restart   stop, then start (needed after editing backend/.env).
  status    Show whether the backend is running and answering /healthz.
  logs      Follow the backend log (Ctrl-C to stop following).
EOF
}

die() { echo "error: $*" >&2; exit 1; }

# PORT comes from backend/.env, like the backend itself; 8790 is its default.
backend_port() {
  local port=""
  [[ -f "$BACKEND/.env" ]] && port="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*["'\'']\{0,1\}\([0-9]*\).*/\1/p' "$BACKEND/.env" | tail -n 1)"
  echo "${port:-8790}"
}

running_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

healthy() {
  command -v curl >/dev/null 2>&1 || return 0
  curl -fsS --max-time 2 "http://127.0.0.1:$(backend_port)/healthz" >/dev/null 2>&1
}

cmd_setup() {
  command -v uv >/dev/null 2>&1 || die "uv not found; install it first: curl -LsSf https://astral.sh/uv/install.sh | sh"
  (cd "$BACKEND" && uv sync --locked --no-dev --python 3.12)
  if [[ ! -f "$BACKEND/.env" ]]; then
    cp "$BACKEND/.env.example" "$BACKEND/.env"
    chmod 600 "$BACKEND/.env"
    echo "Created backend/.env from the example; fill in the OSS and login settings before starting."
  fi
}

cmd_start() {
  local pid
  if pid="$(running_pid)"; then
    echo "Backend already running (pid $pid)."
    return 0
  fi
  [[ -x "$PYTHON" ]] || die "backend/.venv missing; run deploy/backend.sh setup first."
  [[ -f "$BACKEND/.env" ]] || die "backend/.env missing; run deploy/backend.sh setup, then fill it in."
  mkdir -p "$RUN_DIR"
  # Run the venv interpreter directly so the saved PID is the server process itself.
  cd "$BACKEND"
  nohup "$PYTHON" app.py >>"$LOG_FILE" 2>&1 </dev/null &
  echo $! >"$PID_FILE"
  local port
  port="$(backend_port)"
  for _ in $(seq 1 20); do
    if ! running_pid >/dev/null; then
      rm -f "$PID_FILE"
      tail -n 20 "$LOG_FILE" >&2
      die "backend exited during startup; see $LOG_FILE"
    fi
    if healthy; then
      echo "Backend started (pid $(cat "$PID_FILE")) on http://127.0.0.1:$port; log: $LOG_FILE"
      return 0
    fi
    sleep 0.5
  done
  echo "Backend is running (pid $(cat "$PID_FILE")) but /healthz did not answer yet; check $LOG_FILE" >&2
}

cmd_stop() {
  local pid
  if ! pid="$(running_pid)"; then
    rm -f "$PID_FILE"
    echo "Backend is not running."
    return 0
  fi
  kill "$pid"
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || { rm -f "$PID_FILE"; echo "Backend stopped."; return 0; }
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "Backend did not exit in 10s and was killed."
}

cmd_status() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "Backend is not running."
    return 1
  fi
  if healthy; then
    echo "Backend running (pid $pid), /healthz OK on 127.0.0.1:$(backend_port)."
  else
    echo "Backend running (pid $pid) but /healthz is not answering on 127.0.0.1:$(backend_port)."
    return 1
  fi
}

case "${1:-}" in
  setup) cmd_setup ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  logs) [[ -f "$LOG_FILE" ]] || die "no log yet: $LOG_FILE"; exec tail -n 100 -f "$LOG_FILE" ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
