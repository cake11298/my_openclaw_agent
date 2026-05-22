#!/usr/bin/env bash
# 在 RPi 上啟動 OpenClaw gateway。
# 用法: ./scripts/start-openclaw-rpi.sh [--watch]
#
# --watch  使用 tmux 管理的 watch 模式（開發中重啟更方便）
# 預設    使用 dev 模式，背景執行，log 寫入 /tmp/openclaw-gateway.log
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
CANVAS_PORT="${OPENCLAW_CANVAS_PORT:-18793}"
LOG_FILE="/tmp/openclaw-gateway.log"
PID_FILE="/tmp/openclaw-gateway.pid"

# ---------- 顏色輔助 ----------
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

# ---------- 停掉舊的 gateway ----------
stop_existing() {
  if [[ -f "$PID_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$PID_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      yellow "停止舊的 gateway (PID $old_pid)..."
      kill "$old_pid" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$PID_FILE"
  fi
  # 以防萬一，用 port 再掃一次
  local port_pid
  port_pid=$(lsof -ti :"$GATEWAY_PORT" 2>/dev/null || true)
  if [[ -n "$port_pid" ]]; then
    yellow "Port $GATEWAY_PORT 仍被 PID $port_pid 佔用，強制終止..."
    kill -9 "$port_pid" 2>/dev/null || true
    sleep 1
  fi
}

# ---------- 等待 port 就緒 ----------
wait_for_port() {
  local port="$1"
  local label="$2"
  local tries=0
  local max=30
  printf "等待 %s (port %d) 就緒" "$label" "$port"
  while ! nc -z 127.0.0.1 "$port" 2>/dev/null; do
    if (( tries >= max )); then
      echo ""
      red "逾時：$label 在 ${max}s 內未啟動，請查看 $LOG_FILE"
      exit 1
    fi
    printf "."
    sleep 1
    (( tries++ ))
  done
  echo ""
}

cd "$REPO_ROOT"

# ---------- watch 模式 ----------
if [[ "${1:-}" == "--watch" ]]; then
  green "以 watch 模式啟動（tmux session: openclaw-gateway-watch-main）..."
  OPENCLAW_GATEWAY_WATCH_ATTACH=0 pnpm gateway:watch
  green "Watch 模式已在背景啟動。"
  green "  附加終端機: tmux attach -t openclaw-gateway-watch-main"
  green "  停止:       tmux kill-session -t openclaw-gateway-watch-main"
  exit 0
fi

# ---------- 標準 dev 模式（背景） ----------
stop_existing

green "啟動 OpenClaw gateway（dev 模式）..."
green "  Log: $LOG_FILE"

nohup env OPENCLAW_SKIP_CHANNELS=1 \
  node scripts/run-node.mjs --dev gateway \
  >"$LOG_FILE" 2>&1 &
GATEWAY_PID=$!
echo "$GATEWAY_PID" > "$PID_FILE"

green "Gateway PID: $GATEWAY_PID"

wait_for_port "$GATEWAY_PORT" "Gateway WebSocket"
wait_for_port "$CANVAS_PORT"  "Canvas / Control UI"

green ""
green "✅ OpenClaw 已就緒！"
green "   Gateway WS  : ws://127.0.0.1:${GATEWAY_PORT}"
green "   Control UI  : http://127.0.0.1:${CANVAS_PORT}"
green ""
green "從外部機器建立 SSH tunnel 請執行："
green "   ./scripts/tunnel-openclaw.sh <rpi-host-or-ip>"
green ""
green "查看 log: tail -f $LOG_FILE"
green "停止服務: kill \$(cat $PID_FILE)"
