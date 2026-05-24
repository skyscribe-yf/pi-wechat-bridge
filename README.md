# pi-wechat-bridge

将 [pi coding agent](https://pi.dev) 连接到企业微信，让你可以在微信中直接与 pi 对话、远程指挥代码编辑。

## 架构

```
微信 App ←→ 企业微信服务器 ←→ pi-wechat-bridge ←→ pi (RPC mode, per-user)
                                      ↓
                               你的代码项目目录
```

**核心特性：**

- **Per-User 会话** — 每个用户独立 pi 进程，互不干扰
- **会话持久化** — 同一用户多轮对话共享上下文，pi 记得你说过什么
- **活动感知超时** — pi 有产出就续期，不会提前杀掉长任务
- **Markdown 渲染** — 代码块、diff、粗体等在企业微信中友好显示
- **多段输入** — `/begin` / `/end` 合并长消息，突破微信单条字数限制
- **流式输出** — 实时推送 pi 的思考、工具调用、文本增量

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
# PI_PROVIDER=anthropic          # 可选，指定 provider
# PI_MODEL=claude-sonnet-4       # 可选，指定模型
PI_THINKING=medium               # 思考等级

# 会话管理（可选）
# PI_NO_SESSION=true             # 设 true 关闭会话持久化
# PI_SESSION_IDLE_MS=1800000     # 空闲回收阈值（默认 30min）
# PI_APPEND_SYSTEM_PROMPT=当修改代码时，请用 diff 格式展示变更

# 管理员（可选，用于管理员命令）
# ADMIN_USER=your-user-id

# 安全
# ALLOWED_USERS=user1,user2      # 允许的用户 UserID
```

### 第 5 步：启动服务器

```bash
npm start
```

服务器启动后，回到企业微信管理后台点"保存"，验证会通过。

### 第 6 步：开始使用

在企业微信 App 中找到你创建的应用，直接发消息即可！

## Bot 命令

### 普通用户命令

| 命令 | 说明 |
|------|------|
| 直接发消息 | pi 处理并回复（上下文连续，pi 记得之前对话） |
| `/begin` ... `/end` | 多段输入合并为一条长 prompt |
| `/model <名称>` | 切换模型（支持别名和 `provider/id` 格式） |
| `/thinking <等级>` | 设置思考等级：off / minimal / low / medium / high / xhigh |
| `/stream on\|off\|status` | 流式模式（实时推送 pi 中间产出） |
| `/clear` | 清除自己的会话上下文 |
| `/status` | 查看自己的会话状态 |
| `/models` | 列出可用模型 |
| `/abort` | 中止自己的当前操作 |
| `/help` | 显示帮助 |

### 管理员命令

管理员是 `.env` 中 `ADMIN_USER` 指定的用户（默认取 `ALLOWED_USERS` 的第一个）。

| 命令 | 说明 |
|------|------|
| `/sessions` | 查看所有活跃会话（含 PID、空闲时间、busy 状态） |
| `/clear <userId>` | 清除指定用户的会话 |
| `/clear-all` | 清除所有会话 |

### 自然语言模型切换

除了 `/model` 命令，还支持中文自然语言：

- "切换到 deepseek"
- "用 kimi"
- "换讯飞"
- "切到 mimo"
- "用 claude"

### 多段输入示例

微信单条消息约 2048 字符，长代码或复杂指令可以用多段输入：

```
你: /begin
Bot: 📝 开始多段输入，以 /end 结束
你: 把 server.js 里的端口改成 3200，
你: 并且在 health 端点加上内存使用信息，
你: 最后更新 AGENTS.md 里的端口说明
你: /end
Bot: 📝 已合并 3 段输入，开始处理...
```

### 流式模式

开启后实时推送 pi 的中间产出：

```
你: /stream on
Bot: ✅ 流式模式已开启

你: 看看 src/server.js 有什么问题
Bot: 🤔 思考中... (流式)
Bot: 💭 让我检查一下这个文件的结构...
Bot: 🔧 read: src/server.js
Bot: 发现几个可以改进的地方：
Bot: 1. 端口硬编码 → 应该用环境变量
Bot: 2. 缺少错误处理中间件
Bot: ...
```

## 会话管理

### 上下文连续

默认 `PI_NO_SESSION=false`，同一用户的多轮对话共享 pi 进程上下文。pi 能记住你之前让它做的事情：

```
你: 在 utils.ts 里加一个 formatDate 函数
Bot: ✅ 已添加 formatDate 函数...

你: 现在让它支持中文日期格式
Bot: ✅ 已更新 formatDate 函数，添加了中文日期支持...
    (pi 记得上面加的函数，无需重新描述)
```

### 清除会话

```
你: /clear
Bot: 🧹 会话已清除，下次发消息将创建新会话
```

这会杀掉当前 pi 进程，下次发消息时自动创建新的。

### 自动回收

空闲超过 30 分钟（`PI_SESSION_IDLE_MS`）的会话自动回收，释放 pi 进程占用的资源。下次发消息时自动重建。

### 进程崩溃

pi 进程意外退出时自动重启（2 秒后），会话上下文不保留。

## 环境变量参考

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `WXWORK_CORP_ID` | ✅ | — | 企业微信 CorpID |
| `WXWORK_AGENT_ID` | ✅ | — | 自建应用 AgentId |
| `WXWORK_SECRET` | ✅ | — | 自建应用 Secret |
| `WXWORK_TOKEN` | ✅ | — | 消息接收 Token |
| `WXWORK_ENCODING_AES_KEY` | ✅ | — | 消息加密密钥 |
| `PI_CWD` | ❌ | `process.cwd()` | pi 工作目录 |
| `PI_PROVIDER` | ❌ | pi 默认 | LLM provider |
| `PI_MODEL` | ❌ | pi 默认 | 模型 ID |
| `PI_THINKING` | ❌ | `medium` | 思考等级 |
| `PI_TOOLS` | ❌ | `read,bash,edit,write,grep,find,ls` | 允许的工具列表 |
| `PI_NO_SESSION` | ❌ | `false` | 设 `true` 关闭会话持久化 |
| `PI_APPEND_SYSTEM_PROMPT` | ❌ | — | 追加 system prompt |
| `PI_SESSION_IDLE_MS` | ❌ | `1800000` | 空闲回收阈值（30min） |
| `PI_BIN_PATH` | ❌ | `pi` | pi 可执行文件路径 |
| `BRIDGE_PORT` | ❌ | `3100` | 桥接服务器端口 |
| `ALLOWED_USERS` | ❌ | 全部允许 | 允许的用户 UserID（逗号分隔） |
| `ADMIN_USER` | ❌ | ALLOWED_USERS 首项 | 管理员用户 ID |
| `TUNNEL` | ❌ | `true` | 设 `false` 不自动启动 cloudflared |

## WSL2 网络穿透

如果你的 bridge 运行在 WSL2 中，企业微信服务器无法直接访问 WSL2 内部端口：

### 方案 A：Windows 端口转发

```powershell
# PowerShell (管理员)
wsl hostname -I
netsh interface portproxy add v4tov4 listenport=3100 listenaddress=0.0.0.0 connectport=3100 connectaddress=WSL_IP
netsh advfirewall firewall add rule name="pi-wechat-bridge" dir=in action=allow protocol=TCP localport=3100
```

### 方案 B：cloudflared / ngrok

```bash
cloudflared tunnel --url http://localhost:3100
# 或
ngrok http 3100
```

bridge 启动时会自动尝试 cloudflared tunnel（`TUNNEL=false` 可关闭）。

### 方案 C：systemd 服务

```bash
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

1. **设置 ALLOWED_USERS** — 限制可使用 Bot 的用户
2. **设置 ADMIN_USER** — 管理员可执行特权命令
3. **pi 工具权限** — 默认只启用安全工具，按需调整 `PI_TOOLS`
4. **不要提交 .env** — 已包含在 `.gitignore`
5. **企业微信凭据隔离** — Secret/Token/AESKey 不会注入 pi 子进程
6. **HTTPS** — 生产环境建议 nginx 反向代理 + TLS

## 故障排除

| 问题 | 解决方案 |
|------|---------|
| 回调验证失败 | 检查 Token 和 EncodingAESKey 是否与 .env 一致 |
| pi 启动失败 | 确保设置了 API key，检查 `PI_BIN_PATH` 是否正确 |
| 企业微信收不到回复 | 检查 access_token 日志，确认网络可达 |
| WSL2 外部无法访问 | 检查端口转发和防火墙规则 |
| pi 响应超时 | 活动感知超时：2 分钟静默释放锁，10 分钟硬上限 |
| 会话卡住 | 发 `/abort` 或 `/clear`，管理员可用 `/clear <userId>` |
| 多用户同时用不了 | 每用户独立 pi 进程，不应互相阻塞（如遇问题报 bug） |