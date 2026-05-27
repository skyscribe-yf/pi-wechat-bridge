# AGENTS.md — pi-wechat-bridge

本项目是一个桥接服务，将 [pi coding agent](https://pi.dev) 连接到**企业微信**（WeChat Work）。用户可以在企业微信 App 中直接与 pi 对话，让 pi 读取、编辑代码文件。

## 架构概览

```
企业微信 App → 企业微信服务器 → cloudflared → pi-wechat-bridge → pi (RPC mode, per-user)
                                                ↓
                                         目标代码目录 (PI_CWD)
```

每个用户拥有独立的 pi 进程和会话上下文，互不干扰。用户首次发消息时惰性创建 `UserSession`，空闲超过 30 分钟自动回收。

**cloudflared 与 bridge 进程独立**：cloudflared 作为独立的 systemd 服务运行，bridge 重启不影响 tunnel 连接。`scripts/cloudflared-watchdog.sh` 作为 cronjob 监控 cloudflared 存活状态，必要时自动重启并通知管理员。

数据流：
1. 用户在企业微信发消息 → 企业微信服务器推送加密 XML 到 `/wxwork/callback`
2. `server.js` 验签、解密，提取文本内容
3. 获取或创建该用户的 `UserSession`，通过 `PiRpcClient` 以 JSONL 协议将消息发送给 pi 子进程
4. pi 处理后在目标代码目录操作文件，返回文本结果
5. `server.js` 将 pi 的回复（优先 Markdown 格式）通过企业微信 API 发回给用户

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/server.js` | Express 主服务器。Per-User 会话管理、命令解析、活动感知超时、消息分段发送、Markdown 渲染。 |
| `src/wxwork-api.js` | 企业微信 API 客户端。`getAccessToken` 带缓存，`sendTextMessage` / `sendMarkdownMessage` 自动 token 过期重试。 |
| `src/wxwork-crypto.js` | 企业微信消息加解密。AES-256-CBC + PKCS#7 填充 + SHA1 签名。 |
| `src/pi-rpc-client.js` | pi Agent RPC 客户端。JSONL 协议通信；`prompt`、`abort`、`getState`、`setModel`、`setThinkingLevel` 等命令。 |
| `src/stream-buffer.js` | 流式进度批量化。文本/思考增量按阈值分段发送，工具/状态事件独立消息。 |
| `src/tunnel.js` | Cloudflared tunnel 管理模块（已从 bridge 解耦，仅被 `scripts/start-tunnel.sh` 使用）。 |
| `scripts/watchdog.sh` | Bridge 进程守护脚本，基于 /health 端点检测，per-user busy 卡住检测。 |
| `scripts/cloudflared-watchdog.sh` | cloudflared 守护脚本（cronjob），检测进程存活与 URL 可达性，自动重启并通知管理员。 |
| `scripts/start-tunnel.sh` | 手动启动 cloudflared 的辅助脚本（独立于 bridge 进程）。 |
| `cloudflared.service` | cloudflared 独立 systemd 服务单元。 |

## 技术栈

- **Runtime**: Node.js >= 18，ES Module (`"type": "module"`)
- **Framework**: Express 4
- **Dependencies**: `axios`, `xml2js`, `dotenv`
- **External CLI**: `pi`（`@earendil-works/pi-coding-agent`，需全局安装）

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `WXWORK_CORP_ID` | 是 | 企业微信 CorpID |
| `WXWORK_AGENT_ID` | 是 | 自建应用 AgentId |
| `WXWORK_SECRET` | 是 | 自建应用 Secret |
| `WXWORK_TOKEN` | 是 | 消息接收 Token |
| `WXWORK_ENCODING_AES_KEY` | 是 | 消息加密密钥 |
| `PI_CWD` | 否 | pi 工作目录，默认 `process.cwd()` |
| `PI_PROVIDER` | 否 | LLM provider |
| `PI_MODEL` | 否 | 模型 ID |
| `PI_THINKING` | 否 | 思考等级，默认 `medium` |
| `PI_TOOLS` | 否 | 允许的工具，默认 `read,bash,edit,write,grep,find,ls,subagent,advisor,ask_user_question,todo,analyze_image,get_goal,create_goal,update_goal` |
| `PI_NO_SESSION` | 否 | 设 `true` 关闭会话持久化，默认 `false`（开启） |
| `PI_APPEND_SYSTEM_PROMPT` | 否 | 追加 system prompt |
| `PI_SESSION_IDLE_MS` | 否 | 空闲回收阈值，默认 1800000（30min） |
| `PI_BIN_PATH` | 否 | pi 可执行文件绝对路径 |
| `BRIDGE_PORT` | 否 | 桥接服务器端口，默认 `3100` |
| `ALLOWED_USERS` | 否 | 允许的用户 UserID，逗号分隔，留空允许所有人 |
| `ADMIN_USER` | 否 | 管理员 UserID，默认取 ALLOWED_USERS 首项 |

> **安全提示**：`WXWORK_SECRET`、`TOKEN`、`ENCODING_AES_KEY` 不会传递给 pi 子进程（见 `safeEnv` 过滤）。

## 编码约定

- ES Module（`import`/`export`），不使用 `require`/`module.exports`
- 异步代码统一 `async/await`
- 日志前缀：`[模块名]`，如 `[wxwork]`、`[pi-rpc:userId]`、`[msg]`、`[callback]`
- 用户-facing 消息简洁（通过 `safeSend` 发送，优先 Markdown）
- 函数注释使用 JSDoc

## 核心逻辑

### 1. Per-User 会话管理（UserSession）

每个用户首次发消息时，`getUserSession(userId)` 惰性创建 `UserSession` 对象：

- `UserSession` 封装了 `PiRpcClient`、busy 锁、busyTimer、streamBuffer、pendingInterrupt
- 会话持久化：`noSession=false`（默认），同一用户多轮对话共享 pi 上下文
- `/clear`：停止 pi 进程并删除会话，下次消息自动重建
- `/restart`：重启 pi 进程但保留会话上下文（比 /clear 更轻量）
- `/restart-bridge`：管理员命令，重启桥接服务整体进程（先刷盘偏好，派生新进程后优雅退出）
- `/compact`：触发上下文压缩（当对话历史过长时节省 token）
- `/clear <userId>`、`/clear-all`：管理员命令，清除指定或全部会话
- `/sessions`：管理员查看所有活跃会话（PID、空闲时间、busy 状态）
- 空闲回收：每分钟检查，超过 `PI_SESSION_IDLE_MS` 的会话自动 stop
- 进程退出：`UserSession.client.on('exit', ...)` 监听，2 秒后自动重启
- 用户偏好持久化：模型/思考等级偏好保存到 `~/.pi/wechat-bridge/preferences.json`

### 2. 消息处理时序

企业微信要求 5 秒内响应：
1. 验签、解密
2. 立即 `res.send('')`
3. 异步 `handleMessage(msg)` 处理业务

### 3. 活动感知超时

纯空闲时间驱动，progress 事件持续到来时不触发任何超时：
- **静默超时**：pi 连续 2 分钟无产出（text_delta / tool_execution 等）→ 释放锁（pi 仍在运行）
- **空闲硬中止**：pi-rpc-client 级别：空闲超过 10 分钟（无任何 progress 事件）→ abort pi 并拒绝 Promise
- **续期机制**：任何 `onProgress` 事件同时更新 server.js `lastActivity` 和 pi-rpc-client `pending.lastActivity`，双重续期
- 非流式模式同样提供 `onProgress` 回调（仅更新 `lastActivity`，不输出流），防止工具调用期间被误判为静默
- 每 30 秒检查一次

### 4. Markdown 渲染

`safeSend` 优先使用 `sendMarkdownMessage`（代码块、粗体、diff 等友好显示）：
- 自动检测内容含 markdown 特征（`**`、``` ` ```、`>`、`-`、`#` 等）
- 检测到时用 Markdown 消息类型发送
- 发送失败回落到纯文本

### 5. 多段输入（/begin /end）

微信单条消息约 2048 字符限制。`composingUsers` Map 维护多段输入状态：
- `/begin`：开始收集
- 中间消息：追加到 buffer
- `/end`：合并所有段为一条完整 prompt，走 `handlePiPrompt`

### 6. pi RPC 协议

pi 以 `--mode rpc` 启动，JSONL 协议通信。

- `_dispatchProgress` 把进度事件投递给 `onProgress`
- `steer()` 命令：运行时插入用户消息，在当前工具调用完成后、下一次 LLM 调用前生效
- `compact()` 命令：触发上下文压缩
- `abort()` 命令：中止当前处理

### 7. 中间插话机制

当 pi 正在处理时用户发送新消息：
1. 通过 `steer` RPC 命令将新消息插入 pi 的下一个交互轮次
2. 同时将消息存入 `session.pendingInterrupt`
3. 当前处理完成后，`releaseBusy()` 检查 pendingInterrupt，如有则自动作为新 prompt 执行
4. 用户也可发 `/abort` 完全中止当前处理（会清除 pendingInterrupt）

### 7. 流式模式

每用户独立 opt-in（`/stream on|off`）。`StreamBuffer` 批量化：
- 文本 ≥ 1500 字符 / 思考 ≥ 1800 字符 / 空闲 3.5 秒 → flush
- 阶段切换保证"先思考 → 后正文"顺序
- 串行化发送 + 400ms inter-send 延迟

### 8. 模型切换

- 命令：`/model provider/modelId`
- 自然语言：`"切换到 deepseek"` 等
- 预置别名见 `modelAliases` 对象
- 用户偏好持久化：切换后自动保存到 `~/.pi/wechat-bridge/preferences.json`
- `/model default`：恢复全局默认模型并清除偏好
- 偏好只保存用户显式设置的字段，不回填全局默认值

### 9. 管理员命令

`ADMIN_USER` 指定的用户可执行：
- `/sessions`：查看所有活跃会话（含 PID、空闲时间、busy 状态）
- `/clear <userId>`：清除指定用户会话
- `/clear-all`：清除所有会话
- `/restart-bridge`：重启桥接服务整体进程

非管理员尝试执行时回复 `⛔ 此命令仅限管理员使用`。

## 开发调试

### 本地启动

```bash
npm install
npm run dev   # --watch 自动重启
```

### 本地测试

```bash
# 轻量测试（不需要 pi）
SKIP_PI_TESTS=true node test-local.js

# 完整测试（需要 pi 进程）
node test-local.js
```

### 健康检查

```bash
curl http://localhost:3100/health
```

返回 per-user 会话信息：
```json
{
  "status": "ok",
  "activeUsers": 2,
  "busyUsers": 1,
  "sessions": [
    { "userId": "YanFei", "alive": true, "busy": true, "idleMs": 3000, "pid": 12345 },
    { "userId": "user2", "alive": true, "busy": false, "idleMs": 600000, "pid": 12346 }
  ]
}
```

### 日志排查

| 前缀 | 含义 |
|------|------|
| `[callback]` | 企业微信回调验证 |
| `[msg]` | 收到/处理微信消息 |
| `[wxwork]` | 企业微信 API 调用 |
| `[pi-rpc:userId]` | 某用户的 pi 进程生命周期 |
| `[pi-rpc stderr]` | pi 进程 stderr |
| `[session]` | 会话创建/回收 |
| `[fatal]` | 未捕获异常 |

cloudflared watchdog 日志：`~/logs/pi-wechat-bridge/cloudflared-watchdog.log`

## 部署

### systemd

#### pi-wechat-bridge 服务

修改 `pi-wechat-bridge.service` 中的 `User`、`WorkingDirectory`、`ExecStart`、`EnvironmentFile`。

#### cloudflared 服务（独立运行）

1. 复制 `cloudflared.service` 到 systemd 目录：
   ```bash
   # 用户级服务
   mkdir -p ~/.config/systemd/user/
   cp cloudflared.service ~/.config/systemd/user/
   # 或系统级服务
   sudo cp cloudflared.service /etc/systemd/system/
   ```

2. 启用并启动：
   ```bash
   # 用户级
   systemctl --user enable --now cloudflared.service
   # 或系统级
   sudo systemctl enable --now cloudflared.service
   ```

3. cloudflared 日志：
   ```bash
   journalctl --user -u cloudflared -f
   ```

#### cloudflared watchdog（cronjob）

每分钟检测 cloudflared 是否存活、URL 是否可达，必要时自动重启并通知管理员：

```bash
crontab -e
# 添加：
* * * * * /home/skyscribe/srcs/pi-wechat-bridge/scripts/cloudflared-watchdog.sh
```

日志文件：`~/logs/pi-wechat-bridge/cloudflared-watchdog.log`

### WSL2 端口转发

Windows 侧 `netsh interface portproxy` 或 cloudflared/ngrok。详见 `README.md`。

### 云服务器

放行 `BRIDGE_PORT`，建议 nginx 反向代理 + HTTPS。

## 扩展建议

| 需求 | 修改位置 |
|------|----------|
| 支持更多消息类型 | `server.js` 的 `handleMessage`，解析 `msg.MsgType` |
| 添加新模型别名 | `server.js` 的 `modelAliases` |
| 修改超时时间 | `server.js` 的 `ACTIVITY_TIMEOUT` / `HARD_TIMEOUT` |
| 添加新 Bot 命令 | `server.js` 的 `handleMessage`（新增 /restart, /restart-bridge, /compact, steer 机制） |
| 更换消息推送通道 | 替换 `wxwork-api.js` |
| 修改 system prompt | `PI_APPEND_SYSTEM_PROMPT` 环境变量 |
| 修改空闲回收时间 | `PI_SESSION_IDLE_MS` 环境变量 |
| 修改 cloudflared 检测逻辑 | `scripts/cloudflared-watchdog.sh` |

## 安全红线

- **不要将 `.env` 提交到 Git**
- **ALLOWED_USERS** 生产环境必须配置
- **ADMIN_USER** 建议配置，否则管理员命令不可用
- pi 工具权限通过 `PI_TOOLS` 控制，默认开放安全工具和扩展工具（含 subagent、advisor 等）
- 企业微信凭据不会注入 pi 子进程