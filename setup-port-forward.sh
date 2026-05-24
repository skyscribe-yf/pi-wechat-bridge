#!/bin/bash
# WSL2 端口转发设置脚本
# 在 WSL2 内运行此脚本，它会自动设置 Windows 侧的端口转发和防火墙规则
# 前提：需要在 Windows 侧配置 sudoers 让 netsh 不需要密码
# 或者直接在 Windows PowerShell (管理员) 中手动运行输出的命令

set -e

PORT=${1:-3100}

# 获取 WSL2 IP
WSL_IP=$(hostname -I | awk '{print $1}')
WIN_IP=$(cat /etc/resolv.conf | grep nameserver | awk '{print $2}')

echo "================================================"
echo "  pi-wechat-bridge WSL2 端口转发配置"
echo "================================================"
echo ""
echo "WSL2 IP:  $WSL_IP"
echo "Windows IP: $WIN_IP"
echo "端口:     $PORT"
echo ""

# 检查是否已有规则
EXISTING=$(powershell.exe -Command "netsh interface portproxy show all" 2>/dev/null | grep -c "$PORT" || echo "0")

if [ "$EXISTING" -gt 0 ]; then
  echo "⚠️  端口 $PORT 的转发规则已存在，跳过创建"
else
  echo "📋 请在 Windows PowerShell (管理员) 中运行以下命令："
  echo ""
  echo "  netsh interface portproxy add v4tov4 listenport=$PORT listenaddress=0.0.0.0 connectport=$PORT connectaddress=$WSL_IP"
  echo "  netsh advfirewall firewall add rule name=\"pi-wechat-bridge\" dir=in action=allow protocol=TCP localport=$PORT"
  echo ""
  echo "或者尝试自动设置（需要 Windows 管理员权限）："
  echo ""
fi

# 尝试用 powershell.exe 自动设置
echo "尝试自动设置..."
powershell.exe -Command "
  Start-Process powershell -Verb RunAs -ArgumentList '-Command', 'netsh interface portproxy add v4tov4 listenport=$PORT listenaddress=0.0.0.0 connectport=$PORT connectaddress=$WSL_IP; netsh advfirewall firewall add rule name=\"pi-wechat-bridge\" dir=in action=allow protocol=TCP localport=$PORT; echo Done!'
" 2>/dev/null && echo "✅ 已发送 UAC 提升请求，请在 Windows 弹窗中点'是'" || echo "❌ 自动设置失败，请手动运行上面的命令"

echo ""
echo "📋 验证转发规则："
echo "  powershell.exe -Command \"netsh interface portproxy show all\""
echo ""
echo "📋 你的公网 IP（企业微信回调地址需要用这个）："
curl -s https://api.ipify.org 2>/dev/null || echo "(无法获取，请手动查看)"
echo ""