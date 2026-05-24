#!/bin/bash
# 快速配置 .env 脚本 - 交互式引导
set -e

cd "$(dirname "$0")"

if [ -f .env ]; then
  echo "⚠️  .env 已存在，备份为 .env.bak"
  cp .env .env.bak
fi

echo ""
echo "========================================="
echo "  pi-wechat-bridge 配置向导"
echo "========================================="
echo ""

# CorpID
read -p "请输入企业微信 CorpID (ww...): " CORP_ID
if [ -z "$CORP_ID" ]; then
  echo "❌ CorpID 不能为空"
  exit 1
fi

# AgentID
echo ""
echo "AgentID 默认为 1000002，按 Enter 确认或输入新值"
read -p "AgentID [1000002]: " AGENT_ID
AGENT_ID=${AGENT_ID:-1000002}

# Secret
echo ""
read -sp "请输入应用 Secret: " SECRET
echo ""
if [ -z "$SECRET" ]; then
  echo "❌ Secret 不能为空"
  exit 1
fi

# Token
echo ""
echo "Token 是你在「设置 API 接收」时自定义的字符串"
read -p "请输入 Token: " TOKEN
if [ -z "$TOKEN" ]; then
  echo "❌ Token 不能为空"
  exit 1
fi

# EncodingAESKey
echo ""
echo "EncodingAESKey 是你在「设置 API 接收」时点随机获取的 43 位字符串"
read -p "请输入 EncodingAESKey: " AES_KEY
if [ -z "$AES_KEY" ]; then
  echo "❌ EncodingAESKey 不能为空"
  exit 1
fi

# pi 工作目录
echo ""
echo "pi 的工作目录（pi 会在这个目录下操作文件）"
read -p "PI_CWD [$(pwd)]: " PI_CWD
PI_CWD=${PI_CWD:-$(pwd)}

# 写入 .env
cat > .env << EOF
# ===== 企业微信应用配置 =====
WXWORK_CORP_ID=${CORP_ID}
WXWORK_AGENT_ID=${AGENT_ID}
WXWORK_SECRET=${SECRET}
WXWORK_TOKEN=${TOKEN}
WXWORK_ENCODING_AES_KEY=${AES_KEY}

# ===== 服务器配置 =====
BRIDGE_PORT=3100

# ===== pi Agent 配置 =====
PI_CWD=${PI_CWD}
PI_THINKING=medium
PI_TOOLS=read,bash,edit,write,grep,find,ls
EOF

echo ""
echo "✅ .env 配置已写入！"
echo ""
echo "下一步：运行 ./start.sh 启动服务器"
