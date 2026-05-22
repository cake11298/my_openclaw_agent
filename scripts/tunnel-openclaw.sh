#!/usr/bin/env bash
# 在「本機」執行：建立連到 RPi 的 SSH tunnel，讓你用 127.0.0.1:port 存取 OpenClaw。
#
# 用法:
#   ./scripts/tunnel-openclaw.sh <rpi-host>              # 預設 SSH user = 目前登入帳號
#   ./scripts/tunnel-openclaw.sh <rpi-host> <ssh-user>   # 指定 SSH user
#   ./scripts/tunnel-openclaw.sh <rpi-host> <ssh-user> <ssh-port>  # 另指定 SSH port
#
# 範例:
#   ./scripts/tunnel-openclaw.sh raspberrypi.local
#   ./scripts/tunnel-openclaw.sh 192.168.1.42 pi
#   ./scripts/tunnel-openclaw.sh mypi.example.com pi 2222
set -euo pipefail

# ---------- 參數 ----------
RPI_HOST="${1:-}"
SSH_USER="${2:-$(whoami)}"
SSH_PORT="${3:-22}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
CANVAS_PORT="${OPENCLAW_CANVAS_PORT:-18793}"

# ---------- 顏色輔助 ----------
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

if [[ -z "$RPI_HOST" ]]; then
  red "錯誤：請提供 RPi 的 hostname 或 IP"
  echo "用法: $0 <rpi-host> [ssh-user] [ssh-port]"
  exit 1
fi

# ---------- 檢查本機 port 是否已被佔用 ----------
check_local_port() {
  local port="$1"
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then
    yellow "警告：本機 port $port 已被佔用，tunnel 可能衝突"
    yellow "  清除方式: kill \$(lsof -ti :$port)"
  fi
}
check_local_port "$GATEWAY_PORT"
check_local_port "$CANVAS_PORT"

green "建立 SSH tunnel → ${SSH_USER}@${RPI_HOST}:${SSH_PORT}"
green "  本機 127.0.0.1:${GATEWAY_PORT}  →  RPi 127.0.0.1:${GATEWAY_PORT}  (Gateway WebSocket)"
green "  本機 127.0.0.1:${CANVAS_PORT}   →  RPi 127.0.0.1:${CANVAS_PORT}   (Canvas / Control UI)"
green ""
green "Tunnel 就緒後，用以下位址存取："
green "   Gateway WS  : ws://127.0.0.1:${GATEWAY_PORT}"
green "   Control UI  : http://127.0.0.1:${CANVAS_PORT}"
green ""
green "按 Ctrl+C 中斷 tunnel。"
green "---------------------------------------------------"

# AutoSSH 更穩定（斷線自動重連），若有安裝優先使用。
if command -v autossh &>/dev/null; then
  green "偵測到 autossh，使用自動重連模式..."
  exec autossh -M 0 -N \
    -o "ServerAliveInterval=30" \
    -o "ServerAliveCountMax=3" \
    -o "ExitOnForwardFailure=yes" \
    -p "$SSH_PORT" \
    -L "${GATEWAY_PORT}:127.0.0.1:${GATEWAY_PORT}" \
    -L "${CANVAS_PORT}:127.0.0.1:${CANVAS_PORT}" \
    "${SSH_USER}@${RPI_HOST}"
else
  exec ssh -N \
    -o "ServerAliveInterval=30" \
    -o "ServerAliveCountMax=3" \
    -o "ExitOnForwardFailure=yes" \
    -p "$SSH_PORT" \
    -L "${GATEWAY_PORT}:127.0.0.1:${GATEWAY_PORT}" \
    -L "${CANVAS_PORT}:127.0.0.1:${CANVAS_PORT}" \
    "${SSH_USER}@${RPI_HOST}"
fi
