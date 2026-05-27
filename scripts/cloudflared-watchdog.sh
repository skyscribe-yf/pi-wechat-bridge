#!/bin/bash
# cloudflared tunnel 守护脚本
# 检测 cloudflared 是否存活、URL 是否有效，必要时重启并通知管理员
#
# crontab (每分钟):
#   * * * * * /home/skyscribe/srcs/pi-wechat-bridge/scripts/cloudflared-watchdog.sh
#
# 环境变量（可选）:
#   BRIDGE_PORT   - bridge 端口，默认 3100
#   CF_LOG_DIR    - 日志目录，默认 $HOME/logs/pi-wechat-bridge

# 加载 nvm 环境（cron 里 PATH 不含 nvm 路径）
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"

BRIDGE_PORT="${BRIDGE_PORT:-3100}"
LOG_DIR="${CF_LOG_DIR:-$HOME/logs/pi-wechat-bridge}"
mkdir -p "$LOG_DIR"

CF_LOG="$LOG_DIR/cloudflared.log"
URL_FILE="$LOG_DIR/tunnel-url.txt"
WATCHDOG_LOG="$LOG_DIR/cloudflared-watchdog.log"
PID_FILE="$LOG_DIR/cloudflared.pid"

# watchdog 日志轮转（超过 10MB 时截断）
if [ -f "$WATCHDOG_LOG" ] && [ "$(stat -c%s "$WATCHDOG_LOG" 2>/dev/null || echo 0)" -gt 10485760 ]; then
  mv "$WATCHDOG_LOG" "$WATCHDOG_LOG.$(date +%Y%m%d%H%M%S).old"
fi

log() {
  local TIMESTAMP
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$TIMESTAMP] $*" >> "$WATCHDOG_LOG"
}

# ===== 1. 检查 cloudflared 进程是否存活 =====
CF_PID=""
NEED_START=false
REASON=""

# 先尝试从 systemd 获取 PID
if systemctl --user is-active --quiet cloudflared.service 2>/dev/null; then
  CF_PID=$(systemctl --user show cloudflared.service --property=MainPID --value 2>/dev/null)
fi

# 如果 systemd 不可用，尝试从 PID 文件或进程查找
if [ -z "$CF_PID" ] || [ "$CF_PID" = "0" ]; then
  # 从 PID 文件读取（如果以 start-tunnel.sh 方式启动）
  if [ -f "$PID_FILE" ]; then
    CF_PID=$(cat "$PID_FILE" 2>/dev/null)
  fi
fi

# 仍然没有 PID，通过进程名查找
if [ -z "$CF_PID" ] || [ "$CF_PID" = "0" ]; then
  CF_PID=$(pgrep -f "cloudflared tunnel" 2>/dev/null | head -1)
fi

# 验证 PID 是否存活
if [ -n "$CF_PID" ] && [ "$CF_PID" != "0" ] && kill -0 "$CF_PID" 2>/dev/null; then
  # 进程存活，继续检查 URL
  :
else
  NEED_START=true
  REASON="cloudflared 进程不存在或已死"
fi

# ===== 2. 检查 tunnel URL 是否有效 =====
CURRENT_URL=""
if [ "$NEED_START" = false ]; then
  if [ -f "$URL_FILE" ]; then
    CURRENT_URL=$(cat "$URL_FILE" 2>/dev/null | tr -d '[:space:]')
  fi

  if [ -z "$CURRENT_URL" ]; then
    # URL 文件为空，尝试从日志中提取
    if [ -f "$CF_LOG" ]; then
      CURRENT_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | tail -1)
    fi
  fi

  # 验证 URL 可达性（简单的 HTTP 检查）
  if [ -n "$CURRENT_URL" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 "$CURRENT_URL" 2>/dev/null)
    if [ "$HTTP_CODE" = "000" ]; then
      # 完全无法连接，tunnel 可能已经失效
      NEED_START=true
      REASON="tunnel URL 不可达 (HTTP $HTTP_CODE): $CURRENT_URL"
    fi
    # 其他 HTTP 码（如 404、502 等）说明 tunnel 本身是通的，只是后端可能有问题
  else
    NEED_START=true
    REASON="无法获取 tunnel URL"
  fi
fi

# ===== 正常运行，静默退出 =====
if [ "$NEED_START" = false ]; then
  exit 0
fi

# ===== 3. 需要重启 cloudflared =====
log "⚠️ $REASON，正在重启..."

# 停止旧进程
if [ -n "$CF_PID" ] && [ "$CF_PID" != "0" ]; then
  kill "$CF_PID" 2>/dev/null
  sleep 2
  # 如果还没停，强制杀
  if kill -0 "$CF_PID" 2>/dev/null; then
    kill -9 "$CF_PID" 2>/dev/null
  fi
fi

# 也尝试通过 systemd 停止
if systemctl --user is-active --quiet cloudflared.service 2>/dev/null; then
  systemctl --user stop cloudflared.service 2>/dev/null
fi

# 清理残留
pkill -9 -f "cloudflared tunnel" 2>/dev/null || true
sleep 2

# 日志轮转（超过 50MB 时备份）
if [ -f "$CF_LOG" ] && [ "$(stat -c%s "$CF_LOG" 2>/dev/null || echo 0)" -gt 52428800 ]; then
  mv "$CF_LOG" "$CF_LOG.$(date +%Y%m%d%H%M%S).old"
fi

# 保存旧 URL 用于对比
OLD_URL=""
[ -f "$URL_FILE" ] && OLD_URL=$(cat "$URL_FILE" 2>/dev/null | tr -d '[:space:]')

# ===== 4. 启动 cloudflared =====
# 优先使用 systemd 启动
if [ -f "$HOME/.config/systemd/user/cloudflared.service" ] || \
   [ -f "/etc/systemd/system/cloudflared.service" ]; then
  # systemd 服务存在，用 systemctl 启动
  if systemctl --user is-active --quiet cloudflared.service 2>/dev/null; then
    systemctl --user restart cloudflared.service 2>/dev/null
  elif [ -f "$HOME/.config/systemd/user/cloudflared.service" ]; then
    systemctl --user start cloudflared.service 2>/dev/null
  else
    sudo systemctl start cloudflared.service 2>/dev/null
  fi
else
  # 没有 systemd 服务，直接启动进程
  nohup cloudflared tunnel --url "http://localhost:$BRIDGE_PORT" >> "$CF_LOG" 2>&1 &
  NEW_PID=$!
  echo "$NEW_PID" > "$PID_FILE"
fi

# ===== 5. 等待新 URL =====
TIMEOUT=45
ELAPSED=0
NEW_URL=""

while [ $ELAPSED -lt $TIMEOUT ]; do
  # 从日志中提取 URL
  if [ -f "$CF_LOG" ]; then
    NEW_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | tail -1)
  fi
  if [ -n "$NEW_URL" ]; then
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [ -z "$NEW_URL" ]; then
  log "❌ 重启失败：45秒内未获取到 tunnel URL"
  exit 1
fi

# 保存新 URL
echo "$NEW_URL" > "$URL_FILE"

# ===== 6. 验证 =====
# 等待几秒让 tunnel 建立连接
sleep 3
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 "$NEW_URL" 2>/dev/null)

if [ "$HTTP_CODE" = "000" ]; then
  log "⚠️ tunnel 已启动但 URL 不可达 (HTTP $HTTP_CODE): $NEW_URL"
else
  log "✅ cloudflared 已重启, URL: $NEW_URL (HTTP $HTTP_CODE)"
fi

# ===== 7. URL 变化时通知管理员 =====
if [ -n "$OLD_URL" ] && [ "$OLD_URL" != "$NEW_URL" ]; then
  log "🔗 URL 已变更: $OLD_URL → $NEW_URL"

  # 通过 bridge 的通知接口发送（如果 bridge 在运行）
  BRIDGE_HEALTH=$(curl -s --connect-timeout 5 --max-time 10 http://localhost:$BRIDGE_PORT/health 2>/dev/null)
  if echo "$BRIDGE_HEALTH" | grep -q '"status":"ok"'; then
    CALLBACK_URL="${NEW_URL}/wxwork/callback"
    # 调用 bridge 的 /notify-admin 端点
    curl -s --connect-timeout 5 --max-time 15 \
      -X POST "http://localhost:$BRIDGE_PORT/notify-admin" \
      -H "Content-Type: application/json" \
      -d "{\"message\": \"🔧 Tunnel URL 已变更\\n旧: ${OLD_URL}\\n新: ${NEW_URL}\\n回调: ${CALLBACK_URL}\\n\\n请前往企业微信管理后台更新回调 URL\"}" \
      2>/dev/null || true
  fi
fi

exit 0
