#!/bin/bash
# 监控 pi-wechat-bridge，失败自动重启
# crontab: * * * * * /home/skyscribe/srcs/pi-wechat-bridge/scripts/watchdog.sh

# 加载 nvm 环境（cron 里 PATH 不含 nvm 路径）
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"

LOG_DIR="$HOME/logs/pi-wechat-bridge"
mkdir -p "$LOG_DIR"
WATCHDOG_LOG="$LOG_DIR/watchdog.log"
BRIDGE_LOG="$LOG_DIR/bridge.log"
STUCK_FLAG="$LOG_DIR/.busy-stuck-count"

NEED_RESTART=false
REASON=""

# 1. bridge 进程是否存在
BRIDGE_PID=$(lsof -t -i:3100 2>/dev/null || true)
if [ -z "$BRIDGE_PID" ]; then
  NEED_RESTART=true
  REASON="bridge 进程不存在 (端口3100无人监听)"
fi

# 2. health 检查
if [ "$NEED_RESTART" = false ]; then
  HEALTH=$(curl -s --connect-timeout 5 --max-time 10 http://localhost:3100/health 2>/dev/null)
  if [ -z "$HEALTH" ]; then
    NEED_RESTART=true
    REASON="health 检查无响应"
  elif ! echo "$HEALTH" | grep -q 'ok'; then
    NEED_RESTART=true
    REASON="health 检查返回异常: $HEALTH"
  fi
fi

# 3. pi 进程是否存活
if [ "$NEED_RESTART" = false ]; then
  PI_PID=$(pgrep -f "pi --mode rpc" || true)
  if [ -z "$PI_PID" ]; then
    NEED_RESTART=true
    REASON="pi RPC 进程已死，但 bridge 还在"
  fi
fi

# 4. isPiBusy 卡住检测（连续 5 分钟 busy = 连续 5 次 cron 检查都 busy）
if [ "$NEED_RESTART" = false ]; then
  IS_BUSY=$(echo "$HEALTH" | grep -o '"isPiBusy":true' || true)
  if [ -n "$IS_BUSY" ]; then
    # 累加 stuck 计数
    COUNT=$(cat "$STUCK_FLAG" 2>/dev/null || echo "0")
    COUNT=$((COUNT + 1))
    echo "$COUNT" > "$STUCK_FLAG"
    if [ "$COUNT" -ge 5 ]; then
      NEED_RESTART=true
      REASON="isPiBusy 卡住超过5分钟 (stuck=$COUNT)"
    fi
  else
    # 不 busy，清零计数
    echo "0" > "$STUCK_FLAG" 2>/dev/null
  fi
fi

# 正常运行，静默退出
if [ "$NEED_RESTART" = false ]; then
  exit 0
fi

# ===== 重启 =====
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$TIMESTAMP] ⚠️ $REASON，正在重启..." >> "$WATCHDOG_LOG"

# 停旧进程
[ -n "$BRIDGE_PID" ] && kill $BRIDGE_PID 2>/dev/null
sleep 2
OLD_PID=$(lsof -t -i:3100 2>/dev/null || true)
[ -n "$OLD_PID" ] && kill -9 $OLD_PID 2>/dev/null

# 清理残留 pi 进程
pkill -9 -f "pi --mode rpc" 2>/dev/null || true
sleep 1

# 日志轮转（超过 50MB 时备份）
if [ -f "$BRIDGE_LOG" ] && [ "$(stat -c%s "$BRIDGE_LOG" 2>/dev/null || echo 0)" -gt 52428800 ]; then
  mv "$BRIDGE_LOG" "$BRIDGE_LOG.$(date +%Y%m%d%H%M%S).old"
fi

# 重启 bridge
cd /home/skyscribe/srcs/pi-wechat-bridge
nohup node src/server.js >> "$BRIDGE_LOG" 2>&1 &
NEW_PID=$!
sleep 6

# 验证
NEW_HEALTH=$(curl -s --connect-timeout 5 http://localhost:3100/health 2>/dev/null)
if kill -0 $NEW_PID 2>/dev/null && echo "$NEW_HEALTH" | grep -q 'ok'; then
  echo "[$TIMESTAMP] ✅ 重启成功 (PID: $NEW_PID)" >> "$WATCHDOG_LOG"
  echo "0" > "$STUCK_FLAG" 2>/dev/null
else
  echo "[$TIMESTAMP] ❌ 重启失败" >> "$WATCHDOG_LOG"
fi