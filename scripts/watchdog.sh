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

# watchdog 日志自身也做简单轮转（超过 10MB 时截断）
if [ -f "$WATCHDOG_LOG" ] && [ "$(stat -c%s "$WATCHDOG_LOG" 2>/dev/null || echo 0)" -gt 10485760 ]; then
  mv "$WATCHDOG_LOG" "$WATCHDOG_LOG.$(date +%Y%m%d%H%M%S).old"
fi

NEED_RESTART=false
REASON=""

# 1. bridge 进程是否存在
BRIDGE_PID=$(lsof -t -i:3100 2>/dev/null || true)
if [ -z "$BRIDGE_PID" ]; then
  NEED_RESTART=true
  REASON="bridge 进程不存在 (端口3100无人监听)"
fi

# 2. health 检查（含宽限期：bridge 刚启动 30s 内只做健康探测，不判断 pi 状态）
if [ "$NEED_RESTART" = false ]; then
  HEALTH=$(curl -s --connect-timeout 5 --max-time 10 http://localhost:3100/health 2>/dev/null)
  if [ -z "$HEALTH" ]; then
    NEED_RESTART=true
    REASON="health 检查无响应"
  elif ! echo "$HEALTH" | grep -q '"status":"ok"'; then
    NEED_RESTART=true
    REASON="health 检查返回异常: $HEALTH"
  fi

  # 宽限期检测：bridge 进程启动不足 30 秒 → 只做基本存活检查，跳过 pi 进程检测
  if [ "$NEED_RESTART" = false ] && [ -n "$BRIDGE_PID" ]; then
    BRIDGE_UPTIME=$(ps -o etimes= -p "$BRIDGE_PID" 2>/dev/null | awk '{print int($1)}')
    if [ -n "$BRIDGE_UPTIME" ] && [ "$BRIDGE_UPTIME" -lt 30 ]; then
      TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
      echo "[$TIMESTAMP] ℹ️ bridge 启动不足30s (uptime=${BRIDGE_UPTIME}s)，跳过 pi 进程检测" >> "$WATCHDOG_LOG"
      # 正常运行，静默退出
      exit 0
    fi
  fi
fi

# 3. 检查是否有活跃的 pi 会话
# （per-user 模式下不再有全局 pi 状态，而是看 sessions 数量）
if [ "$NEED_RESTART" = false ]; then
  # 检查是否有任何 busy 的会话卡住
  BUSY_USERS=$(echo "$HEALTH" | grep -o '"busy":true' || true)
  if [ -n "$BUSY_USERS" ]; then
    # 有 busy 用户，累加 stuck 计数
    COUNT=$(cat "$STUCK_FLAG" 2>/dev/null || echo "0")
    COUNT=$((COUNT + 1))
    echo "$COUNT" > "$STUCK_FLAG"
    if [ "$COUNT" -ge 10 ]; then
      # busy 卡住超过10分钟，尝试 /pi-restart 重启所有会话
      TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
      echo "[$TIMESTAMP] ⚠️ busy 卡住超过10min (stuck=$COUNT)，重启所有会话" >> "$WATCHDOG_LOG"
      RESTART_RESULT=$(curl -s --connect-timeout 5 --max-time 30 -X POST http://localhost:3100/pi-restart 2>/dev/null)
      if echo "$RESTART_RESULT" | grep -q '"status":"ok"'; then
        echo "[$TIMESTAMP] ✅ 会话重启成功" >> "$WATCHDOG_LOG"
        echo "0" > "$STUCK_FLAG" 2>/dev/null
      else
        NEED_RESTART=true
        REASON="busy 卡住且 /pi-restart 失败"
      fi
    fi
  else
    # 没有 busy 会话，清零计数
    echo "0" > "$STUCK_FLAG" 2>/dev/null
  fi
fi

# 正常运行，静默退出
if [ "$NEED_RESTART" = false ]; then
  exit 0
fi

# ===== 重启（仅 bridge 整体挂掉或 /pi-restart 失败时才走这里） =====
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
sleep 8

# 验证（给更多时间，因为 pi 启动也需要几秒）
NEW_HEALTH=$(curl -s --connect-timeout 5 http://localhost:3100/health 2>/dev/null)
if kill -0 $NEW_PID 2>/dev/null && echo "$NEW_HEALTH" | grep -q 'ok'; then
  echo "[$TIMESTAMP] ✅ 重启成功 (PID: $NEW_PID)" >> "$WATCHDOG_LOG"
  echo "0" > "$STUCK_FLAG" 2>/dev/null
else
  echo "[$TIMESTAMP] ❌ 重启失败" >> "$WATCHDOG_LOG"
fi