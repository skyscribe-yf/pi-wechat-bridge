# pi-wechat-bridge

将 [pi coding agent](https://pi.dev) 连接到企业微信，让你可以在微信中直接与 pi 对话、控制代码编辑等。

## 架构

```
微信 App ←→ 企业微信服务器 ←→ pi-wechat-bridge ←→ pi (RPC mode)
                                      ↓
                               你的代码项目目录
```

## 前置条件

- Node.js >= 18
- pi coding agent 已安装 (`npm install -g @earendil-works/pi-coding-agent`)
- 至少一个 LLM provider 的 API key (如 `ANTHROPIC_API_KEY`)
- 企业微信管理员权限（用于创建自建应用）

## 安装

```bash
cd pi-wechat-bridge
npm install
cp .env.example .env
# 编辑 .env 填入你的配置
```

## 企业微信配置步骤

### 第 1 步：创建企业微信自建应用

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame#apps)
2. 进入 **应用管理** → **自建** → **创建应用**
3. 填写应用名称（如 "pi Agent"）、logo、可见范围
4. 创建完成后记录 **AgentId** 和 **Secret**

### 第 2 步：获取 CorpID

1. 进入 **我的企业** → **企业信息**
2. 复制 **企业ID** (CorpID)

### 第 3 步：配置消息接收

1. 在应用详情页，找到 **接收消息** → **设置API接收**
2. 填写：
   - **URL**: `http://<你的服务器IP>:3100/wxwork/callback`
   - **Token**: 随便填一个字符串（如 `pi-wechat-bridge-token-2026`）
   - **EncodingAESKey**: 点"随机获取"
3. 先**不要点保存**，先启动 bridge 服务器

### 第 4 步：配置 .env

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# 企业微信配置（从上面的步骤获取）
WXWORK_CORP_ID=ww1234567890abcdef
WXWORK_AGENT_ID=1000002
WXWORK_SECRET=你的应用Secret
WXWORK_TOKEN=你设置的Token
WXWORK_ENCODING_AES_KEY=你获取的EncodingAESKey

# pi 配置
PI_CWD=/home/user/my-project     # pi 工作目录
PI_PROVIDER=anthropic             # 可选，指定 provider
PI_MODEL=claude-sonnet-4          # 可选，指定模型
PI_THINKING=medium                # 思考等级
```

### 第 5 步：启动服务器

```bash
npm start
```

服务器启动后，回到企业微信管理后台点"保存"，验证会通过。

### 第 6 步：开始使用

在企业微信 App 中找到你创建的应用，直接发消息即可！

## 使用方法

在微信中直接发送任何文本，pi 会处理你的请求并回复。

### 特殊命令

| 命令 | 说明 |
|------|------|
| `/stream on\|off\|status` | 流式模式开关（实时推送 pi 中间产出，默认关闭） |
| `/abort` | 中止 pi 当前操作 |
| `/status` | 查看 pi 当前状态 |

### 示例对话

```
你: 在 src/utils.ts 中添加一个日期格式化函数

pi: 我来帮你在 src/utils.ts 中添加日期格式化函数...

  1. 读取了 src/utils.ts 文件
  2. 在文件末尾添加了 formatDate 函数
  3. 确认函数导出正常

  添加的函数如下:
  export function formatDate(date: Date, format: string = 'YYYY-MM-DD'): string {
    // ... 实现
  }
```

## WSL2 网络穿透

如果你的 bridge 运行在 WSL2 中，企业微信服务器无法直接访问 WSL2 内部的端口。解决方案：

### 方案 A：Windows 端口转发（推荐）

在 Windows PowerShell（管理员）中运行：

```powershell
# 获取 WSL2 的 IP
wsl hostname -I

# 添加端口转发（替换 WSL_IP 为上一步的输出）
netsh interface portproxy add v4tov4 listenport=3100 listenaddress=0.0.0.0 connectport=3100 connectaddress=WSL_IP

# 添加防火墙规则
netsh advfirewall firewall add rule name="pi-wechat-bridge" dir=in action=allow protocol=TCP localport=3100

# 查看已添加的规则
netsh interface portproxy show all
```

> ⚠️ WSL2 重启后 IP 可能变化，需要更新端口转发规则。

### 方案 B：使用 ngrok / cloudflared

```bash
# 使用 cloudflared
cloudflared tunnel --url http://localhost:3100

# 使用 ngrok
ngrok http 3100
```

然后把生成的公网 URL 配置到企业微信回调地址中。

### 方案 C：systemd 服务（开机自启）

```bash
# 创建 systemd 服务文件
sudo tee /etc/systemd/system/pi-wechat-bridge.service << 'EOF'
[Unit]
Description=pi-wechat-bridge
After=network.target

[Service]
Type=simple
User=skyscribe
WorkingDirectory=/home/skyscribe/srcs/pi-wechat-bridge
ExecStart=/home/skyscribe/.nvm/versions/node/v24.15.0/bin/node src/server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/home/skyscribe/srcs/pi-wechat-bridge/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable pi-wechat-bridge
sudo systemctl start pi-wechat-bridge
```

## 安全建议

1. **设置 ALLOWED_USERS**：限制可以使用 Bot 的企业微信用户
2. **pi 工具权限**：默认只启用安全工具（read, bash, edit, write），根据需要调整 PI_TOOLS
3. **不要暴露 Secret**：.env 文件不要提交到 Git
4. **网络隔离**：建议通过反向代理（nginx）暴露服务，添加 HTTPS

## 故障排除

| 问题 | 解决方案 |
|------|---------|
| 回调验证失败 | 检查 Token 和 EncodingAESKey 是否与 .env 一致 |
| pi 启动失败 | 确保设置了 API key (如 ANTHROPIC_API_KEY) |
| 企业微信收不到回复 | 检查 access_token 是否正常获取，查看服务器日志 |
| WSL2 外部无法访问 | 检查端口转发和防火墙规则 |
| pi 响应超时 | 默认超时 5 分钟，可在代码中调整 |