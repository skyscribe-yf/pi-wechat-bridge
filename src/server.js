/**
 * pi-wechat-bridge 主服务器
 * 将企业微信消息转发给 pi agent，并将 pi 的回复发回微信
 *
 * 架构：per-user pi 进程 + 会话持久化 + 活动感知超时
 */
import express from 'express';
import { parseStringPromise } from 'xml2js';
import dotenv from 'dotenv';
import { encrypt, decrypt, verifySignature } from './wxwork-crypto.js';
import { sendTextMessage, sendMarkdownMessage, updateCallbackUrl } from './wxwork-api.js';
import { TunnelManager } from './tunnel.js';
import { PiRpcClient } from './pi-rpc-client.js';
import { StreamBuffer } from './stream-buffer.js';

dotenv.config();

// ===== 全局错误处理 =====
process.on('uncaughtException', (err) => {
  console.error('[fatal] 未捕获的异常:', err);
  setTimeout(() => process.exit(1), 500);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] 未处理的 Promise 拒绝:', reason);
});

// ===== 配置 =====
const config = {
  corpId: process.env.WXWORK_CORP_ID,
  agentId: process.env.WXWORK_AGENT_ID,
  secret: process.env.WXWORK_SECRET,
  token: process.env.WXWORK_TOKEN,
  encodingAesKey: process.env.WXWORK_ENCODING_AES_KEY,
  bridgePort: Number(process.env.BRIDGE_PORT) || 3100,
  allowedUsers: process.env.ALLOWED_USERS?.split(',').filter(Boolean) || [],
  piBin: process.env.PI_BIN_PATH || 'pi',
  piProvider: process.env.PI_PROVIDER,
  piModel: process.env.PI_MODEL,
  piThinking: process.env.PI_THINKING || 'medium',
  piTools: process.env.PI_TOOLS || 'read,bash,edit,write,grep,find,ls',
  piCwd: process.env.PI_CWD || process.cwd(),
  // 默认 false — 开启会话持久化，同一用户多轮对话共享上下文
  piNoSession: process.env.PI_NO_SESSION === 'true',
  piNoExtensions: process.env.PI_NO_EXTENSIONS === 'true',
  piNoSkills: process.env.PI_NO_SKILLS === 'true',
  piNoContextFiles: process.env.PI_NO_CONTEXT_FILES === 'true',
  piSessionIdleMs: Number(process.env.PI_SESSION_IDLE_MS) || 30 * 60 * 1000,
  piAppendSystemPrompt: process.env.PI_APPEND_SYSTEM_PROMPT || '',
  adminUser: process.env.ADMIN_USER || process.env.ALLOWED_USERS?.split(',')[0]?.trim() || '',
};

// ===== 验证必需配置 =====
const required = ['WXWORK_CORP_ID', 'WXWORK_AGENT_ID', 'WXWORK_SECRET', 'WXWORK_TOKEN', 'WXWORK_ENCODING_AES_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ 缺少必需配置: ${missing.join(', ')}`);
  console.error('请复制 .env.example 为 .env 并填写企业微信应用配置');
  process.exit(1);
}

// ===== Per-User Session 管理 =====
/** @type {Map<string, UserSession>} */
const userSessions = new Map();
let idleEvictTimer = null;

// ===== 流式状态（按用户 opt-in） =====
/** @type {Map<string, boolean>} */
const userStreamEnabled = new Map();

// ===== 多段输入状态 =====
/** @type {Map<string, string[]>} */
const composingUsers = new Map();

function isStreamingEnabledFor(userId) {
  return userStreamEnabled.get(userId) === true;
}
function setStreamingEnabledFor(userId, enabled) {
  if (enabled) userStreamEnabled.set(userId, true);
  else userStreamEnabled.delete(userId);
}

// ===== 模型别名 =====
const modelAliases = {
  '讯飞': { provider: 'xunfei', modelId: 'astron-code-latest', name: '讯飞 Astron' },
  'xunfei': { provider: 'xunfei', modelId: 'astron-code-latest', name: '讯飞 Astron' },
  'astron': { provider: 'xunfei', modelId: 'astron-code-latest', name: '讯飞 Astron' },
  'deepseek': { provider: 'opencode-go', modelId: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  'deepseek闪': { provider: 'opencode-go', modelId: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  'deepseek-flash': { provider: 'opencode-go', modelId: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  'deepseek-pro': { provider: 'opencode-go', modelId: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  'kimi': { provider: 'kimi-coding', modelId: 'kimi-k2.6', name: 'Kimi K2.6' },
  'kimi-k2.6': { provider: 'kimi-coding', modelId: 'kimi-k2.6', name: 'Kimi K2.6' },
  'mimo': { provider: 'opencode-go', modelId: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
  'mimo-pro': { provider: 'opencode-go', modelId: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
  'mimo-flash': { provider: 'xiaomi-mimo', modelId: 'mimo-v2-flash', name: 'MiMo V2 Flash' },
  'xiaomi': { provider: 'xiaomi-mimo', modelId: 'mimo-v2-flash', name: '小米 MiMo' },
  'claude': { provider: 'anthropic', modelId: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
  'sonnet': { provider: 'anthropic', modelId: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
  'claude-sonnet': { provider: 'anthropic', modelId: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
  'gpt': { provider: 'opencode-go', modelId: 'gpt-5', name: 'GPT-5' },
  'gpt-5': { provider: 'opencode-go', modelId: 'gpt-5', name: 'GPT-5' },
  '可灵': { provider: 'kimi-coding', modelId: 'kimi-k2.6', name: 'Kimi K2.6' },
};

// ===== UserSession 类 =====
class UserSession {
  constructor(userId) {
    this.userId = userId;
    this.client = new PiRpcClient({
      piBin: config.piBin,
      cwd: config.piCwd,
      provider: config.piProvider,
      model: config.piModel,
      thinking: config.piThinking,
      tools: config.piTools,
      noSession: config.piNoSession,
      noExtensions: config.piNoExtensions,
      noSkills: config.piNoSkills,
      noContextFiles: config.piNoContextFiles,
      appendSystemPrompt: config.piAppendSystemPrompt,
    });
    this.busy = false;
    this.busyTimer = null;
    this.lastActive = Date.now();
    this.streamBuffer = null;
    this.starting = false;

    this.client.on('exit', async ({ code }) => {
      console.warn(`[pi-rpc:${userId}] 进程退出 (code=${code})，2s 后重启...`);
      this.busy = false;
      this._clearBusyTimer();
      this.streamBuffer = null;
      await new Promise(r => setTimeout(r, 2000));
      try {
        await this.start();
        console.log(`✅ [pi-rpc:${userId}] 已自动重启`);
      } catch (err) {
        console.error(`❌ [pi-rpc:${userId}] 自动重启失败:`, err.message);
      }
    });
  }

  async start() {
    this.starting = true;
    try {
      await this.client.start();
      this.lastActive = Date.now();
      console.log(`✅ [pi-rpc:${this.userId}] 客户端已启动 (PID: ${this.client.proc?.pid})`);
    } catch (err) {
      console.error(`❌ [pi-rpc:${this.userId}] 启动失败:`, err.message);
      throw err;
    } finally {
      this.starting = false;
    }
  }

  stop() {
    this.client.stop();
    this.busy = false;
    this._clearBusyTimer();
    this.streamBuffer = null;
  }

  isAlive() {
    if (!this.client?.proc?.pid || this.client.proc.killed) return false;
    try { return process.kill(this.client.proc.pid, 0); } catch { return false; }
  }

  releaseBusy() {
    this.busy = false;
    this._clearBusyTimer();
    this.streamBuffer = null;
  }

  _clearBusyTimer() {
    if (this.busyTimer) { clearTimeout(this.busyTimer); this.busyTimer = null; }
  }
}

/**
 * 获取或创建用户会话（惰性启动）
 */
async function getUserSession(userId) {
  if (!userSessions.has(userId)) {
    const session = new UserSession(userId);
    userSessions.set(userId, session);
    await session.start();
    scheduleIdleEviction();
  }
  const session = userSessions.get(userId);
  session.lastActive = Date.now();
  // pi 进程挂了但 session 对象还在 → 重启
  if (!session.isAlive() && !session.starting) {
    console.log(`[pi-rpc:${userId}] 进程已死，重启中...`);
    await session.start();
  }
  return session;
}

/**
 * 定期清理空闲超过 piSessionIdleMs 的用户会话
 */
function scheduleIdleEviction() {
  if (idleEvictTimer) return;
  idleEvictTimer = setInterval(() => {
    const now = Date.now();
    for (const [userId, session] of userSessions) {
      if (!session.busy && now - session.lastActive > config.piSessionIdleMs) {
        console.log(`[session] 回收空闲会话: ${userId} (${Math.round((now - session.lastActive) / 60000)}min)`);
        session.stop();
        userSessions.delete(userId);
      }
    }
    if (userSessions.size === 0) {
      clearInterval(idleEvictTimer);
      idleEvictTimer = null;
    }
  }, 60_000);
  idleEvictTimer.unref?.();
}

// ===== 安全发送消息：优先 Markdown，回落纯文本 =====
async function safeSend(config, userId, text) {
  try {
    const isMarkdown = /`{1,3}[\s\S]*?`{1,3}|\*\*|^[>\-*#]/m.test(text);
    if (isMarkdown) {
      await sendMarkdownMessage(config, userId, text);
    } else {
      await sendTextMessage(config, userId, text);
    }
  } catch (err) {
    try { await sendTextMessage(config, userId, text); } catch (e) { console.error('[msg] 发送消息失败:', e.message); }
  }
}

// ===== Express 服务器 =====
const app = express();

// 微信回调 URL 验证 (GET)
app.get('/wxwork/callback', async (req, res) => {
  try {
    const { msg_signature, timestamp, nonce, echostr } = req.query;
    if (!verifySignature(config.token, timestamp, nonce, echostr, msg_signature)) {
      return res.status(403).send('签名验证失败');
    }
    const reply = decrypt(config.corpId, config.encodingAesKey, echostr);
    res.send(reply);
  } catch (err) {
    console.error('[callback] 验证错误:', err);
    res.status(500).send('内部错误');
  }
});

// 微信消息接收 (POST)
app.post('/wxwork/callback', express.text({ type: 'text/xml' }), async (req, res) => {
  let replied = false;
  function safeReply() { if (!replied) { replied = true; res.send(''); } }

  try {
    const { msg_signature, timestamp, nonce } = req.query;
    const xmlResult = await parseStringPromise(req.body, { explicitArray: false });
    const encryptContent = xmlResult.xml.Encrypt;

    if (!verifySignature(config.token, timestamp, nonce, encryptContent, msg_signature)) {
      return res.status(403).send('');
    }

    const plainText = decrypt(config.corpId, config.encodingAesKey, encryptContent);
    const msgData = await parseStringPromise(plainText, { explicitArray: false });
    const msg = msgData.xml;

    console.log(`[msg] 收到消息: From=${msg.FromUserName}, Content=${msg.Content?.slice(0, 100)}`);
    safeReply();

    handleMessage(msg).catch(err => console.error('[msg] 异步处理错误:', err));
  } catch (err) {
    console.error('[msg] 请求处理错误:', err);
    safeReply();
  }
});

// ===== 消息处理 =====
async function handleMessage(msg) {
  const userId = msg.FromUserName;
  const msgType = msg.MsgType;
  const content = msg.Content?.trim();

  // 用户权限检查
  if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(userId)) {
    console.log(`[msg] 用户 ${userId} 不在允许列表中`);
    await safeSend(config, userId, '⚠️ 你没有使用此 Bot 的权限。请联系管理员配置 ALLOWED_USERS。');
    return;
  }

  // 只处理文本消息
  if (msgType !== 'text' || !content) {
    await safeSend(config, userId, '⚠️ 目前只支持文本消息。');
    return;
  }

  // ===== /help =====
  if (content === '/help') {
    const isAdmin = config.adminUser && userId === config.adminUser;
    let helpText =
      '🤖 pi Agent 微信 Bot 命令\n\n' +
      '💬 直接发消息 → pi 处理并回复（上下文连续）\n\n' +
      '📝 多段输入:\n' +
      '  /begin ... /end → 合并长消息\n\n' +
      '🎤 语音切换模型:\n' +
      '  "切换到 deepseek"\n' +
      '  "用 kimi"\n' +
      '  "换讯飞"\n\n' +
      '⌨️ 文字命令:\n' +
      '  /model deepseek     切换模型\n' +
      '  /thinking high      思考等级\n' +
      '  /stream on|off      流式模式开关\n' +
      '  /clear              清除自己的会话\n' +
      '  /status             查看自己的状态\n' +
      '  /models             列出模型\n' +
      '  /abort              中止操作\n' +
      '  /help               帮助';
    if (isAdmin) {
      helpText +=
        '\n\n👑 管理员命令:\n' +
        '  /sessions           查看所有活跃会话\n' +
        '  /clear <userId>     清除指定用户会话\n' +
        '  /clear-all          清除所有会话';
    }
    await safeSend(config, userId, helpText);
    return;
  }

  // ===== 多段输入 /begin /end =====
  if (content === '/begin') {
    composingUsers.set(userId, []);
    await safeSend(config, userId, '📝 开始多段输入，以 /end 结束');
    return;
  }

  if (content === '/end') {
    const parts = composingUsers.get(userId);
    composingUsers.delete(userId);
    if (!parts || parts.length === 0) {
      await safeSend(config, userId, '⚠️ 没有输入内容');
      return;
    }
    const fullMessage = parts.join('\n');
    await safeSend(config, userId, `📝 已合并 ${parts.length} 段输入，开始处理...`);
    return handlePiPrompt(userId, fullMessage);
  }

  if (composingUsers.has(userId)) {
    composingUsers.get(userId).push(content);
    await safeSend(config, userId, `📝 已追加 (${composingUsers.get(userId).length} 段)，继续输入或发 /end`);
    return;
  }

  // ===== /stream on|off|status =====
  if (content === '/stream' || content.startsWith('/stream ')) {
    const arg = content === '/stream' ? 'status' : content.slice(8).trim().toLowerCase();
    if (arg === 'on') {
      setStreamingEnabledFor(userId, true);
      await safeSend(config, userId, '✅ 流式模式已开启 (实时推送 pi 的中间产出)');
    } else if (arg === 'off') {
      setStreamingEnabledFor(userId, false);
      await safeSend(config, userId, '✅ 流式模式已关闭');
    } else {
      await safeSend(config, userId,
        `📡 流式模式: ${isStreamingEnabledFor(userId) ? '开启' : '关闭'}\n` +
        '用法: /stream on | /stream off | /stream status');
    }
    return;
  }

  // ===== /clear — 清除当前会话上下文 =====
  if (content === '/clear') {
    const session = userSessions.get(userId);
    if (session) {
      session.stop();
      userSessions.delete(userId);
      await safeSend(config, userId, '🧹 会话已清除，下次发消息将创建新会话');
    } else {
      await safeSend(config, userId, 'ℹ️ 当前没有活跃会话');
    }
    return;
  }

  // 非管理员尝试管理员命令
  const isAdmin = config.adminUser && userId === config.adminUser;
  const clearUserMatch = content.match(/^\/clear\s+(\S+)$/);
  if (!isAdmin && (content === '/sessions' || content === '/clear-all' || clearUserMatch)) {
    await safeSend(config, userId, '⛔ 此命令仅限管理员使用');
    return;
  }

  // /sessions — 查看所有活跃会话
  if (content === '/sessions' && isAdmin) {
    if (userSessions.size === 0) {
      await safeSend(config, userId, '📋 当前没有活跃会话');
      return;
    }
    const lines = [`📋 活跃会话 (${userSessions.size}):`];
    let i = 0;
    for (const [uid, session] of userSessions) {
      i++;
      const alive = session.isAlive() ? '✅' : '❌';
      const busy = session.busy ? '⏳' : '💤';
      const idleMin = Math.round((Date.now() - session.lastActive) / 60000);
      const pid = session.client?.proc?.pid || '-';
      lines.push(`${i}. \`${uid}\` ${alive}${busy} PID:${pid} 空闲:${idleMin}min`);
    }
    lines.push('', '管理员命令:');
    lines.push('  `/clear <userId>` 清除指定用户会话');
    lines.push('  `/clear-all`      清除所有会话');
    await safeSend(config, userId, lines.join('\n'));
    return;
  }

  // /clear <userId> — 管理员清除指定用户会话
  if (clearUserMatch && isAdmin) {
    const targetUserId = clearUserMatch[1];
    const session = userSessions.get(targetUserId);
    if (session) {
      session.stop();
      userSessions.delete(targetUserId);
      await safeSend(config, userId, `🧹 已清除用户 \`${targetUserId}\` 的会话`);
    } else {
      await safeSend(config, userId, `ℹ️ 用户 \`${targetUserId}\` 没有活跃会话`);
    }
    return;
  }

  // /clear-all — 管理员清除所有会话
  if (content === '/clear-all' && isAdmin) {
    const count = userSessions.size;
    if (count === 0) {
      await safeSend(config, userId, 'ℹ️ 当前没有活跃会话');
      return;
    }
    for (const [, session] of userSessions) session.stop();
    userSessions.clear();
    if (idleEvictTimer) { clearInterval(idleEvictTimer); idleEvictTimer = null; }
    await safeSend(config, userId, `🧹 已清除所有 ${count} 个会话`);
    return;
  }

  // ===== /abort =====
  if (content === '/abort') {
    const session = userSessions.get(userId);
    if (session?.busy) {
      session.client.abort();
      if (session.streamBuffer) {
        try { await session.streamBuffer.abort(); } catch {}
      }
      session.releaseBusy();
      await safeSend(config, userId, '✅ 已中止当前操作');
    } else {
      await safeSend(config, userId, 'ℹ️ 当前没有正在执行的操作');
    }
    return;
  }

  // ===== /status =====
  if (content === '/status') {
    const session = userSessions.get(userId);
    const parts = [
      `📊 会话状态:`,
      `- pi 进程: ${session?.isAlive() ? 'running' : 'not started'}`,
      `- 忙碌: ${session?.busy ?? false}`,
      `- 流式: ${isStreamingEnabledFor(userId) ? '开启' : '关闭'}`,
      `- 多段输入: ${composingUsers.has(userId) ? `进行中 (${composingUsers.get(userId)?.length} 段)` : '无'}`,
    ];
    if (session?.lastActive) {
      const idleMin = Math.round((Date.now() - session.lastActive) / 60000);
      parts.push(`- 空闲: ${idleMin}min`);
    }
    if (session?.isAlive()) {
      try {
        const state = await session.client.getState();
        if (state?.model) {
          parts.push(`- 模型: ${state.model.name || state.model.id} (${state.model.provider})`);
        }
        if (state?.messageCount !== undefined) {
          parts.push(`- 会话消息数: ${state.messageCount}`);
        }
      } catch {}
    }
    await safeSend(config, userId, parts.join('\n'));
    return;
  }

  // ===== /model 切换 =====
  let modelMatch = null;
  if (content.startsWith('/model ')) {
    const modelStr = content.slice(7).trim();
    const parts = modelStr.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      modelMatch = { provider: parts[0], modelId: parts[1], name: modelStr };
    } else {
      const key = Object.keys(modelAliases).find(k => modelStr.toLowerCase().includes(k));
      if (key) modelMatch = modelAliases[key];
    }
  } else {
    // 自然语言切换
    const switchPatterns = [
      /^(切换|换|转到|切到|用|我想用|改用|帮我切换到)\s*(.+)$/,
      /^(切换|换|转到|切到|用|我想用|改用|帮我切换到)模型\s*(.+)$/,
      /^(.+?)(模型|试试|看看)$/,
    ];
    for (const pattern of switchPatterns) {
      const m = content.match(pattern);
      if (m) {
        const target = (m[2] || m[1] || '').toLowerCase().trim();
        const key = Object.keys(modelAliases).find(k => target.includes(k));
        if (key) { modelMatch = modelAliases[key]; break; }
      }
    }
  }

  if (modelMatch) {
    try {
      const session = await getUserSession(userId);
      const result = await session.client.setModel(modelMatch.provider, modelMatch.modelId);
      const modelName = result?.name || modelMatch.name;
      const listLink = content.startsWith('/model') ? '' : '\n💡 发 /models 看全部模型';
      await safeSend(config, userId, `✅ 已切换到 ${modelName}${listLink}`);
    } catch (err) {
      await safeSend(config, userId, `❌ 切换失败: ${err.message}\n试试发 /models 查看可用模型`);
    }
    return;
  }

  // ===== /models =====
  if (content === '/models') {
    try {
      const session = await getUserSession(userId);
      const result = await session.client.getAvailableModels();
      const models = result?.models || [];
      if (models.length === 0) {
        await safeSend(config, userId, '⚠️ 没有获取到可用模型列表');
        return;
      }
      const grouped = {};
      for (const m of models) {
        if (!grouped[m.provider]) grouped[m.provider] = [];
        if (grouped[m.provider].length < 5) grouped[m.provider].push(m.id);
      }
      let text = '📋 可用模型:\n';
      for (const [provider, ids] of Object.entries(grouped)) {
        text += `\n【${provider}】\n`;
        for (const id of ids) text += `  \`${provider}/${id}\`\n`;
      }
      await safeSend(config, userId, text);
    } catch (err) {
      await safeSend(config, userId, `❌ 获取列表失败: ${err.message}`);
    }
    return;
  }

  // ===== /thinking =====
  if (content.startsWith('/thinking ')) {
    const level = content.slice(10).trim();
    const validLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    if (!validLevels.includes(level)) {
      await safeSend(config, userId, '⚠️ 等级: off, minimal, low, medium, high, xhigh');
      return;
    }
    try {
      const session = await getUserSession(userId);
      await session.client.setThinkingLevel(level);
      await safeSend(config, userId, `✅ 思考等级已设为: ${level}`);
    } catch (err) {
      await safeSend(config, userId, `❌ 设置失败: ${err.message}`);
    }
    return;
  }

  // ===== 默认：作为 pi prompt 处理 =====
  return handlePiPrompt(userId, content);
}

// ===== pi prompt 处理（含活动感知超时 + 流式） =====
async function handlePiPrompt(userId, content) {
  // 获取或创建用户会话
  let session;
  try {
    session = await getUserSession(userId);
  } catch (err) {
    console.error(`[pi-rpc:${userId}] 启动失败:`, err.message);
    await safeSend(config, userId, '❌ pi 启动失败，请稍后重试');
    return;
  }

  // 检查是否忙碌
  if (session.busy) {
    await safeSend(config, userId, '⏳ 正在处理中，请稍等或发 /abort 中止');
    return;
  }

  session.busy = true;
  session.lastActive = Date.now();

  // ===== 活动感知超时 =====
  let lastActivity = Date.now();
  const ACTIVITY_TIMEOUT = 120_000;  // 真正静默 2 分钟
  const HARD_TIMEOUT = 600_000;      // 硬上限 10 分钟
  const CHECK_INTERVAL = 30_000;     // 每 30 秒检查

  const promptStart = Date.now();

  function startActivityMonitor() {
    session._clearBusyTimer();
    session.busyTimer = setTimeout(() => {
      const idle = Date.now() - lastActivity;
      const elapsed = Date.now() - promptStart;
      if (elapsed > HARD_TIMEOUT) {
        console.warn(`[pi-rpc:${userId}] 硬超时 (${Math.round(HARD_TIMEOUT / 1000)}s)`);
        session.client.abort();
        session.releaseBusy();
        safeSend(config, userId, '⏰ 处理超时（硬上限 10min），已中止');
      } else if (idle > ACTIVITY_TIMEOUT) {
        console.warn(`[pi-rpc:${userId}] 静默超时 (${Math.round(idle / 1000)}s)`);
        session.releaseBusy();
        safeSend(config, userId, '⏰ pi 长时间无响应（2min），锁已释放。可用 /abort 强制中止');
      } else {
        startActivityMonitor();
      }
    }, CHECK_INTERVAL);
  }

  startActivityMonitor();

  const streaming = isStreamingEnabledFor(userId);
  let buffer = null;
  let streamedAnyText = false;

  try {
    // 先回复"正在处理"
    await safeSend(config, userId, streaming ? '🤔 思考中... (流式)' : '🤔 正在思考中...');

    let promptArg;
    if (streaming) {
      buffer = new StreamBuffer({
        send: (text) => safeSend(config, userId, text),
        logger: console.log,
      });
      session.streamBuffer = buffer;
      promptArg = {
        timeout: HARD_TIMEOUT,
        onProgress: (event) => {
          lastActivity = Date.now();
          if (event.type === 'text_delta') streamedAnyText = true;
          buffer.handle(event);
        },
      };
    } else {
      promptArg = { timeout: HARD_TIMEOUT };
    }

    const reply = await session.client.prompt(content, promptArg);

    if (streaming) {
      await buffer.finalize();
      session.streamBuffer = null;
      if (!streamedAnyText) {
        if (!reply || reply === '(无回复)') {
          await safeSend(config, userId, '🤔 pi 没有返回内容。你可以继续发送消息或发 /status 查看。');
        } else {
          await sendChunked(config, userId, reply);
        }
      }
      return;
    }

    // 非流式路径
    if (!reply || reply === '(无回复)') {
      await safeSend(config, userId, '🤔 pi 没有返回内容。你可以继续发送消息或发 /status 查看。');
      return;
    }
    await sendChunked(config, userId, reply);
  } catch (err) {
    console.error(`[pi-rpc:${userId}] prompt 失败:`, err.message);
    if (buffer) {
      try { await buffer.finalize(); } catch {}
      session.streamBuffer = null;
    }
    if (!err.message?.includes('aborted') && !err.message?.includes('中止')) {
      await safeSend(config, userId, `❌ 处理失败: ${err.message.substring(0, 100)}`);
    }
  } finally {
    session.releaseBusy();
  }
}

/**
 * 把过长的回复分段发出。企业微信单条文本约 2048 字符；超过 MAX_LEN 自动切片。
 */
async function sendChunked(config, userId, reply) {
  const MAX_LEN = 2000;
  if (reply.length <= MAX_LEN) {
    await safeSend(config, userId, reply);
    return;
  }
  const chunks = [];
  let remaining = reply;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, MAX_LEN));
    remaining = remaining.slice(MAX_LEN);
  }
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : '';
    await safeSend(config, userId, prefix + chunks[i]);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

// ===== 健康检查 =====
app.get('/health', (req, res) => {
  const activeSessions = [];
  let totalBusy = 0;
  for (const [userId, session] of userSessions) {
    activeSessions.push({
      userId,
      alive: session.isAlive(),
      busy: session.busy,
      idleMs: Date.now() - session.lastActive,
      pid: session.client?.proc?.pid || null,
    });
    if (session.busy) totalBusy++;
  }
  res.json({
    status: 'ok',
    activeUsers: userSessions.size,
    busyUsers: totalBusy,
    sessions: activeSessions,
    timestamp: new Date().toISOString(),
  });
});

// ===== 更新企业微信回调 URL =====
app.post('/update-callback', express.json(), async (req, res) => {
  const { url } = req.body;
  if (!url) return res.json({ status: 'error', message: '缺少 url 参数' });
  try {
    await updateCallbackUrl(config, url, config.token, config.encodingAesKey);
    res.json({ status: 'ok', message: '回调 URL 已更新', url });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  }
});

// ===== pi 强制重启端点（watchdog 调用） =====
app.post('/pi-restart', express.json(), async (req, res) => {
  const { userId } = req.body || {};
  // 如果指定了 userId，只重启该用户的 pi
  if (userId) {
    const session = userSessions.get(userId);
    if (session) {
      session.stop();
      try {
        await session.start();
        res.json({ status: 'ok', message: `pi for ${userId} 已重启`, pid: session.client?.proc?.pid });
      } catch (err) {
        res.json({ status: 'error', message: err.message });
      }
      return;
    }
  }
  // 否则重启所有用户会话
  let count = 0;
  for (const [uid, session] of userSessions) {
    if (session.starting) continue;
    session.stop();
    try {
      await session.start();
      count++;
    } catch {}
  }
  res.json({ status: 'ok', message: `已重启 ${count}/${userSessions.size} 个会话` });
});

// ===== Tunnel 管理 =====
let tunnelManager = null;

// ===== 启动 =====
async function main() {
  console.log('🚀 pi-wechat-bridge 启动中...');
  console.log(`   端口: ${config.bridgePort}`);
  console.log(`   CorpID: ${config.corpId}`);
  console.log(`   AgentID: ${config.agentId}`);
  console.log(`   pi 工作目录: ${config.piCwd}`);
  console.log(`   会话持久化: ${config.piNoSession ? '关闭' : '开启'}`);
  console.log(`   空闲回收: ${config.piSessionIdleMs / 60000}min`);
  if (config.allowedUsers.length > 0) {
    console.log(`   允许的用户: ${config.allowedUsers.join(', ')}`);
  } else {
    console.log('   允许所有用户');
  }
  if (config.adminUser) {
    console.log(`   管理员: ${config.adminUser}`);
  }

  // 不再全局启动 pi — 改为 per-user 惰性启动

  app.listen(config.bridgePort, async () => {
    console.log(`\n✅ 桥接服务器已启动: http://localhost:${config.bridgePort}`);
    console.log(`\n📋 企业微信配置回调 URL:`);
    console.log(`   URL: http://<你的服务器IP>:${config.bridgePort}/wxwork/callback`);
    console.log(`   Token: ${config.token}`);
    console.log(`   EncodingAESKey: ${config.encodingAesKey}`);
    console.log(`\n💡 健康检查: http://localhost:${config.bridgePort}/health`);

    if (process.env.TUNNEL !== 'false') {
      try {
        await startTunnel();
      } catch (err) {
        console.error('⚠️ [tunnel] 启动失败:', err.message);
      }
    }
  });
}

async function startTunnel() {
  const logDir = process.env.TUNNEL_LOG_DIR || `${process.env.HOME}/logs/pi-wechat-bridge`;

  tunnelManager = new TunnelManager({
    bridgePort: config.bridgePort,
    logDir,
    onUrlChange: async (newUrl) => {
      const callbackUrl = `${newUrl}/wxwork/callback`;
      console.log(`\n🔗 Tunnel URL: ${newUrl}`);
      console.log(`   回调地址: ${callbackUrl}`);

      if (config.adminUser) {
        try {
          await sendMarkdownMessage(config, config.adminUser,
            `## 🔧 Tunnel URL 已更新\n` +
            `**回调地址:**\n\`${callbackUrl}\`\n\n` +
            `请前往[企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame#apps)修改接收消息的 URL\n\n` +
            `> Token: \`${config.token}\`\n> EncodingAESKey: \`${config.encodingAesKey}\``
          );
        } catch (err) {
          console.error('[tunnel] 通知管理员失败:', err.message);
        }
      }
    },
  });

  await tunnelManager.start();
}

function gracefulShutdown(signal) {
  console.log(`\n🛑 收到 ${signal}，正在关闭...`);
  const timer = setTimeout(() => { process.exit(1); }, 10000);
  timer.unref?.();

  // 停止所有用户会话
  for (const [, session] of userSessions) session.stop();
  userSessions.clear();
  if (idleEvictTimer) { clearInterval(idleEvictTimer); idleEvictTimer = null; }
  if (tunnelManager) tunnelManager.stop();

  setTimeout(() => { clearTimeout(timer); process.exit(0); }, 500);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

main().catch(err => {
  console.error('💥 启动失败:', err);
  process.exit(1);
});