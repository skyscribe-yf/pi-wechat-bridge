#!/bin/bash
# 启动 pi-wechat-bridge，日志追加保存到 ~/logs/pi-wechat-bridge/
set -e

# 加载 nvm 环境
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"

LOG_DIR="$HOME/logs/pi-wechat-bridge"
mkdir -p "$LOG_DIR"

# 检查 .env 是否存在
if [ ! -f .env ]; then
  echo "❌ .env 文件不存在！"
  echo "   请先复制 .env.example 为 .env 并填写配置："
  echo "   cp .env.example .env && nano .env"
  exit 1
fi

# 检查必需的配置
source .env 2>/dev/null || true
REQUIRED_VARS="WXWORK_CORP_ID WXWORK_AGENT_ID WXWORK_SECRET WXWORK_TOKEN WXWORK_ENCODING_AES_KEY"
MISSING=""
for var in $REQUIRED_VARS; do
  if [ -z "${!var}" ]; then
    MISSING="$MISSING $var"
  fi
done

if [ -n "$MISSING" ]; then
  echo "❌ 缺少必需配置:$MISSING"
  echo "   请编辑 .env 文件填写这些值"
  exit 1
fi

# 检查 node_modules
if [ ! -d node_modules ]; then
  echo "📦 安装依赖..."
  npm install
fi

# 检查 pi 是否可用
if ! command -v pi &>/dev/null; then
  echo "❌ pi 未安装！请运行: npm install -g @earendil-works/pi-coding-agent"
  exit 1
fi

# 如果已有进程在跑，先优雅停止，不响应则强制结束
OLD_PID=$(lsof -t -i:3100 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  echo "🛑 发现已有进程 (PID: $OLD_PID)，正在停止..."
  kill $OLD_PID 2>/dev/null || true
  sleep 2
  # 如果还在，强制结束（防止 graceful shutdown 超时导致端口冲突）
  STILL_PID=$(lsof -t -i:3100 2>/dev/null || true)
  if [ -n "$STILL_PID" ]; then
    echo "   ⚠️ 进程未退出，强制结束..."
    kill -9 $STILL_PID 2>/dev/null || true
    sleep 1
  fi
fi

# 日志轮转（超过 50MB 时备份）
LOG_FILE="$LOG_DIR/bridge.log"
if [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt 52428800 ]; then
  mv "$LOG_FILE" "$LOG_FILE.$(date +%Y%m%d%H%M%S).old"
fi

echo "🚀 启动 pi-wechat-bridge..."
echo "   日志文件: $LOG_FILE (追加模式)"
echo ""

# 启动，日志追加写入（>> 确保重启不覆盖）
nohup node src/server.js >> "$LOG_FILE" 2>&1 &
BRIDGE_PID=$!
echo "   PID: $BRIDGE_PID"

# 等待启动
sleep 5

# 检查是否成功
if kill -0 $BRIDGE_PID 2>/dev/null; then
  echo "✅ 已启动！"
  echo ""
  echo "📋 查看日志: tail -f $LOG_DIR/bridge.log"
  echo "💡 健康检查: curl http://localhost:3100/health"
else
  echo "❌ 启动失败，查看日志: cat $LOG_DIR/bridge.log"
  exit 1
fi