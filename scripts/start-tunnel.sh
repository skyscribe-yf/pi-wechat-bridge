#!/bin/bash
# 启动 cloudflared quick tunnel，自动捕获 URL 并更新企业微信回调配置
# 用法: ./scripts/start-tunnel.sh

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"

BRIDGE_PORT="${BRIDGE_PORT:-3100}"
LOG_DIR="$HOME/logs/pi-wechat-bridge"
mkdir -p "$LOG_DIR"

TUNNEL_LOG="$LOG_DIR/cloudflared.log"
URL_FILE="$LOG_DIR/tunnel-url.txt"

echo "[tunnel] 启动 cloudflared quick tunnel → localhost:$BRIDGE_PORT ..."

# 启动 cloudflared，日志写到文件
cloudflared tunnel --url "http://localhost:$BRIDGE_PORT" > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
echo "[tunnel] cloudflared PID: $TUNNEL_PID"

# 等待 URL 出现（最多 30 秒）
TIMEOUT=30
ELAPSED=0
TUNNEL_URL=""

while [ $ELAPSED -lt $TIMEOUT ]; do
  TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ -z "$TUNNEL_URL" ]; then
  echo "❌ [tunnel] 30秒内未获取到 tunnel URL，查看日志: $TUNNEL_LOG"
  kill $TUNNEL_PID 2>/dev/null
  exit 1
fi

# 保存 URL 到文件
echo "$TUNNEL_URL" > "$URL_FILE"
echo "✅ [tunnel] URL: $TUNNEL_URL"

# 调用 bridge 的 /update-callback 端点更新企业微信回调
CALLBACK_URL="${TUNNEL_URL}/wxwork/callback"
echo "[tunnel] 更新企业微信回调 URL: $CALLBACK_URL"

RESULT=$(curl -s --connect-timeout 5 --max-time 15 \
  -X POST "http://localhost:$BRIDGE_PORT/update-callback" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"$CALLBACK_URL\"}" 2>/dev/null)

if echo "$RESULT" | grep -q '"ok"'; then
  echo "✅ [tunnel] 企业微信回调已更新"
else
  echo "⚠️ [tunnel] 更新回调可能失败: $RESULT"
  echo "   请手动在管理后台设置回调 URL: $CALLBACK_URL"
fi

echo ""
echo "📌 Tunnel URL: $TUNNEL_URL"
echo "📌 回调地址:   $CALLBACK_URL"
echo "📌 日志:       $TUNNEL_LOG"
echo "📌 URL 文件:    $URL_FILE"
echo ""
echo "按 Ctrl+C 停止 tunnel"
wait $TUNNEL_PID