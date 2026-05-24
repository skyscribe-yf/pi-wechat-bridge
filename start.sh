#!/bin/bash
# 启动 pi-wechat-bridge
set -e

cd "$(dirname "$0")"

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

echo "🚀 启动 pi-wechat-bridge..."
exec node src/server.js
