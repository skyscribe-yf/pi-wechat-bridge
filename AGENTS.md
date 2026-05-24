# AGENTS.md — pi-wechat-bridge

本项目是一个桥接服务，将 [pi coding agent](https://pi.dev) 连接到**企业微信**（WeChat Work）。用户可以在企业微信 App 中直接与 pi 对话，让 pi 读取、编辑代码文件。

## 架构概览

```
企业微信 App → 企业微信服务器 → pi-wechat-bridge → pi (RPC mode)
                                            ↓
                                     目标代码目录 (PI_CWD)
```

数据流：
1. 用户在企业微信发消息 → 企业微信服务器推送加密 XML 到 `/wxwork/callback`
2. `server.js` 验签、解密，提取文本内容
3. 通过 `PiRpcClient` 以 JSONL 协议将消息发送给 pi 子进程
4. pi 处理后在目标代码目录操作文件，返回文本结果
5. `server.js` 将 pi 的回复通过企业微信 API 发回给用户

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/server.js` | Express 主服务器。处理企业微信回调（GET 验证 / POST 消息）、用户命令解析、消息分段发送、pi 生命周期管理。 |
| `src/wxwork-api.js` | 企业微信 API 客户端。`getAccessToken` 带缓存（提前 5 分钟刷新），`sendTextMessage` / `sendMarkdownMessage` 自动处理 token 过期重试。 |
| `src/wxwork-crypto.js` | 企业微信消息加解密。AES-256-CBC + PKCS#7 填充 + SHA1 签名，严格遵循官方规范。 |
| `src/pi-rpc-client.js` | pi Agent RPC 客户端。通过 `stdin/stdout` 以 JSONL 协议与 pi 通信；封装了 `prompt`、`abort`、`getState`、`setModel`、`setThinkingLevel` 等命令。 |
| `scripts/check-public-ip.js` | 检查并打印公网 IP（调试网络穿透时使用）。 |
| `scripts/update-trusted-ip.js` | 更新企业微信可信 IP 列表（可选脚本）。 |
| `scripts/watchdog.sh` | 进程守护脚本，用于 systemd 或 cron 监控。 |
| `pi-wechat-bridge.service` | systemd 服务模板。 |

## 技术栈

- **Runtime**: Node.js >= 18，ES Module (`"type": "module"`)
- **Framework**: Express 4
- **Dependencies**: `axios`, `xml2js`, `dotenv`
- **External CLI**: `pi`（`@earendil-works/pi-coding-agent`，需全局安装）

## 环境变量

复制 `.env.example` 为 `.env` 并填写：

| 变量 | 必填 | 说明 |
|------|------|------|
| `WXWORK_CORP_ID` | 是 | 企业微信 CorpID |
| `WXWORK_AGENT_ID` | 是 | 自建应用 AgentId |
| `WXWORK_SECRET` | 是 | 自建应用 Secret |
| `WXWORK_TOKEN` | 是 | 消息接收 Token |
| `WXWORK_ENCODING_AES_KEY` | 是 | 消息加密密钥（43 字符 Base64，不带末尾 `=`，代码里会自动补） |
| `PI_CWD` | 否 | pi 的工作目录，默认 `process.cwd()` |
| `PI_PROVIDER` | 否 | LLM provider，如 `anthropic`、`xunfei`、`kimi-coding` |
| `PI_MODEL` | 否 | 模型 ID |
| `PI_THINKING` | 否 | 思考等级：`off`/`minimal`/`low`/`medium`/`high`/`xhigh`，默认 `medium` |
| `PI_TOOLS` | 否 | 允许的工具列表，默认 `read,bash,edit,write,grep,find,ls` |
| `PI_NO_SESSION` | 否 | 设 `true` 关闭会话持久化，默认 `false`（开启） |
| `PI_APPEND_SYSTEM_PROMPT` | 否 | 追加 system prompt，引导 pi 输出格式 |
| `PI_SESSION_IDLE_MS` | 否 | 空闲回收阈值（毫秒），默认 1800000（30min） |
| `PI_BIN_PATH` | 否 | pi 可执行文件绝对路径 |
| `BRIDGE_PORT` | 否 | 桥接服务器端口，默认 `3100` |
| `ALLOWED_USERS` | 否 | 允许的用户 UserID，逗号分隔，留空则允许所有人 |

> **安全提示**：`WXWORK_SECRET`、`TOKEN`、`ENCODING_AES_KEY` 不会传递给 pi 子进程（见 `pi-rpc-client.js` 的 `safeEnv` 过滤），防止企业微信凭据被意外泄露。

## 编码约定

- 使用 ES Module（`import`/`export`），不使用 `require`/`module.exports`
- 异步代码统一使用 `async/await`，避免裸 Promise 链
- 日志前缀约定：`[模块名] 消息`，如 `[wxwork]`, `[pi-rpc]`, `[msg]`, `[callback]`
- 错误处理：打印完整错误，用户-facing 消息尽量简洁（通过 `safeSend` 发送）
- 函数注释使用 JSDoc，标明参数类型和返回值

## 核心逻辑与注意事项

### 1. Per-User 会话管理

每个用户拥有独立的 pi 进程和会话上下文。用户首次发消息时惰性创建 `UserSession`，空闲超过 30 分钟自动回收。

- `UserSession` 类封装了 `PiRpcClient`、busy 锁、streamBuffer 等
- 会话持久化：默认 `PI_NO_SESSION=false`，同一用户多轮对话共享 pi 上下文
- `/clear` 命令：停止当前 pi 进程并删除会话，下次发消息时重新创建
- 空闲回收：每分钟检查一次，超过 `PI_SESSION_IDLE_MS`（默认 30min）的空闲会话自动 stop
- 进程退出自动重启：`UserSession` 监听 pi 进程 exit 事件，2 秒后自动重启

### 2. 消息处理时序

企业微信要求 **5 秒内响应**，POST `/wxwork/callback` 的处理：
1. 验签、解密
2. 立即 `res.send('')`
3. 异步 `handleMessage(msg)` 处理业务

### 3. 活动感知超时

- **静默超时**：pi 连续 2 分钟无产出 → 释放锁
- **硬上限**：单次 prompt 最多 10 分钟 → 中止
- **续期**：任何 `onProgress` 事件重置静默计时器
- 每 30 秒检查一次

### 3. pi RPC 协议（pi-rpc-client.js）

pi 以 `--mode rpc` 启动，通过 `stdin` 接收 JSONL 命令，通过 `stdout` 输出 JSONL 事件：

| 事件类型 | 方向 | 说明 |
|----------|------|------|
| `extension_ui_request` | pi → bridge | 就绪信号，bridge 回复空 UI 配置 |
| `prompt` | bridge → pi | 发送用户消息 |
| `agent_start` | pi → bridge | 开始处理 |
| `message_update` (text_delta) | pi → bridge | 增量文本 |
| `message_update` (thinking_delta) | pi → bridge | 增量思考（仅流式模式转发） |
| `tool_execution_start` / `tool_execution_end` | pi → bridge | 工具调用开始/结束（仅流式模式转发） |
| `auto_retry_start` / `auto_retry_end` | pi → bridge | 自动重试（仅流式模式转发） |
| `compaction_start` / `compaction_end` | pi → bridge | 上下文压缩（仅流式模式转发） |
| `agent_end` | pi → bridge | 完成，含最终文本 |
| `response` | pi → bridge | 命令响应（如 `get_state`、`set_model`） |
| `abort` | bridge → pi | 中止当前操作 |

`_attachJsonlReader` 负责将 stdout 流拆分为完整的 JSON 行。`_dispatchProgress` 将进度事件投递给 `pendingRequests` 中带 `onProgress` 的请求（详见 §5 流式模式）。

### 4. 消息分段发送

企业微信单条文本消息限制约 2048 字符。`server.js` 中如果 pi 回复超过 2000 字符，会自动分段发送，每段间隔 500ms 避免限流。`sendChunked(userId, reply)` 是抽出的复用函数。

### 5. 流式模式 (streaming)

默认行为是"等 pi 跑完整段 → 一次性发回微信"。流式模式让 pi 的中间产出实时推到微信，包括：

- 助手文本增量（`message_update` → `text_delta`）
- 思考增量（`thinking_delta`），带 `💭` 前缀
- 工具调用开始（`tool_execution_start`），如 `🔨 bash: ls -la`、`🔧 read: src/server.js`
- 工具失败（`tool_execution_end` 且 `isError`），如 `❌ bash 失败`
- 自动重试（`auto_retry_start`、最终失败时的 `auto_retry_end`）
- 上下文压缩（`compaction_start` / `compaction_end`）

每个用户独立 opt-in（默认关闭）：

- `/stream on` 开启
- `/stream off` 关闭
- `/stream status` 查看当前状态

状态保存在内存 `Map<userId, boolean>`，进程重启会清空。

实现要点：

- `src/pi-rpc-client.js` 的 `prompt(message, { timeout, onProgress })` 选项把进度事件投递给 `onProgress(event)`。`text_delta` 仍会累积进最终返回字符串；`thinking_delta` **不会**（避免污染最终回复）。
- 旧签名 `prompt(message, timeoutNumber)` 保持兼容（typeof 分支）。
- `src/stream-buffer.js` 的 `StreamBuffer` 负责批量化：
  - 文本 buffer ≥ 1500 字符 / 思考 buffer ≥ 1800 字符 / 空闲 3.5 秒 → flush
  - 阶段切换（text↔thinking）会先 flush 上一阶段，保证"先思考 → 后正文"顺序
  - 工具/状态事件先 flush 文本和思考，再独立成消息
  - 所有发送通过 Promise 链串行化，inter-send 间隔 400ms 缓解限流
- `src/server.js` 在 `isStreamingEnabledFor(userId)` 为 true 时构建 buffer 并把 `onProgress` 接入 `prompt`，`agent_end` 后 `await buffer.finalize()` flush 残留；若整次都没有 `text_delta`（边界情况），回落到原 `sendChunked` 路径。
- `/abort` 会调用 `activeStreamBuffer.abort()` flush 残留并追加 `⛔ [已中止]`。

注意：`tool_execution_update`（bash 部分输出流）刻意**不**转发——噪声过大且会触发限流。

### 6. 模型切换（server.js）

支持自然语言切换和命令切换：
- 自然语言：`"切换到 deepseek"`、`"用 kimi"` 等
- 命令：`/model provider/modelId`

预置别名见 `modelAliases` 对象。如需添加新模型，在该对象中增加条目即可。

## 开发调试

### 本地启动

```bash
npm install
npm run dev   # 使用 --watch 自动重启
```

### 测试企业微信回调（无微信环境）

可以用 curl 模拟 GET 验证（需要自己算签名）：
```bash
# 见 wxwork-crypto.js 的 generateSignature 逻辑
# 或直接启动服务器后看日志输出的回调 URL
```

### 查看健康状态

```bash
curl http://localhost:3100/health
```

返回 JSON：
```json
{
  "status": "ok",
  "pi": "running",
  "isPiBusy": false,
  "timestamp": "..."
}
```

### 日志排查

| 日志前缀 | 含义 |
|----------|------|
| `[callback]` | 企业微信回调验证 |
| `[msg]` | 收到/处理微信消息 |
| `[wxwork]` | 企业微信 API 调用（access_token、发消息） |
| `[pi-rpc]` | pi 进程生命周期和 JSONL 通信 |
| `[pi-rpc stderr]` | pi 进程的标准错误输出 |
| `[fatal]` | 未捕获的异常或 Promise 拒绝 |

## 部署

### systemd（推荐用于 Linux 服务器）

已提供 `pi-wechat-bridge.service` 模板，注意修改：
- `User`
- `WorkingDirectory`
- `ExecStart`（使用正确的 node 绝对路径）
- `EnvironmentFile`（.env 文件绝对路径）

### WSL2 端口转发

如果运行在 WSL2 中，企业微信服务器无法直接访问 WSL2 内部端口。需要在 Windows 侧配置 `netsh interface portproxy` 或改用 cloudflared/ngrok。详见 `README.md`。

### 云服务器

确保服务器安全组/防火墙放行 `BRIDGE_PORT`（默认 3100）。建议前面加 nginx 反向代理并配置 HTTPS。

## 扩展建议

| 需求 | 修改位置 |
|------|----------|
| 支持更多消息类型（图片、文件） | `server.js` 的 `handleMessage`，解析 `msg.MsgType` |
| 添加新模型别名 | `server.js` 的 `modelAliases` |
| 修改超时时间 | `server.js` 的 `ACTIVITY_TIMEOUT` / `HARD_TIMEOUT` |
| 添加新 Bot 命令 | `server.js` 的 `handleMessage` |
| 更换消息推送通道 | 替换 `wxwork-api.js` |
| 修改 system prompt | `PI_APPEND_SYSTEM_PROMPT` 环境变量 |
| 修改空闲回收时间 | `PI_SESSION_IDLE_MS` 环境变量 |

## 安全红线

- **不要将 `.env` 提交到 Git**（已包含在 `.gitignore`）
- **ALLOWED_USERS** 强烈建议在生产环境配置，防止未授权使用
- pi 的工具权限通过 `PI_TOOLS` 控制，默认只开放安全工具
- 企业微信凭据不会注入 pi 子进程环境变量
