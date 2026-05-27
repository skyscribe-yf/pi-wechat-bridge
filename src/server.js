/**
 * pi-wechat-bridge 主服务器
 * 将企业微信消息转发给 pi agent，并将 pi 的回复发回微信
 *
 * 架构：per-user pi 进程 + 会话持久化 + 活动感知超时
 */
import express from 'express';
import { parseStringPromise } from 'xml2js';
import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { encrypt, decrypt, verifySignature } from './wxwork-crypto.js';
import { sendTextMessage, sendMarkdownMessage, updateCallbackUrl } from './wxwork-api.js';
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

// ===== 模块级 HTTP 服务器引用（gracefulShutdown 需要） =====
let _httpServer = null;

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
  piTools: process.env.PI_TOOLS || 'read,bash,edit,write,grep,find,ls,subagent,advisor,ask_user_question,todo,analyze_image,get_goal,create_goal,update_goal',
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

// ===== 用户偏好持久化（跨会话回收 / 进程重启保留） =====
/** @type {Map<string, {provider?: string, modelId?: string, thinking?: string}>} */
const userPreferences = new Map();

const PREF_DIR = path.join(os.homedir(), '.pi', 'wechat-bridge');
const PREF_FILE = path.join(PREF_DIR, 'preferences.json');
let prefSaveTimer = null;

/** 从磁盘加载偏好（启动时调用） */
async function loadPreferences() {
  try {
    const raw = await fs.readFile(PREF_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      for (const [uid, pref] of Object.entries(data)) {
        if (pref && typeof pref === 'object') userPreferences.set(uid, pref);
      }
      console.log(`📋 [pref] 已加载 ${userPreferences.size} 个用户偏好`);
    }
  } catch {
    // 文件不存在或解析失败 → 空偏好，正常
  }
}

/** 异步持久化偏好到磁盘（写入临时文件后 rename，防止写半截断电丢数据） */
async function savePreferences() {
  const obj = Object.fromEntries(userPreferences);
  try {
    await fs.mkdir(PREF_DIR, { recursive: true });
    const tmpFile = PREF_FILE + '.tmp';
    await fs.writeFile(tmpFile, JSON.stringify(obj, null, 2), 'utf8');
    await fs.rename(tmpFile, PREF_FILE);
  } catch (e) {
    console.error('[pref] 保存偏好文件失败:', e.message);
  }
}

/** 防抖持久化（500ms 内多次 setUserPref 只触发一次写盘） */
function schedulePrefSave() {
  if (prefSaveTimer) clearTimeout(prefSaveTimer);
  prefSaveTimer = setTimeout(() => { prefSaveTimer = null; savePreferences(); }, 500);
  prefSaveTimer.unref?.();
}

/** 获取用户偏好，未设置的字段回退到全局默认 */
function getUserPref(userId) {
  const pref = userPreferences.get(userId) || {};
  return {
    provider: pref.provider || config.piProvider,
    modelId: pref.modelId || config.piModel,
    thinking: pref.thinking || config.piThinking,
    // 标记是否有用户自定义（区别于全局默认回退）
    hasCustomModel: !!(pref.provider && pref.modelId),
    hasCustomThinking: !!pref.thinking,
  };
}

/** 更新用户偏好字段（内存 + 防抖写盘） */
function setUserPref(userId, updates) {
  const pref = userPreferences.get(userId) || {};
  Object.assign(pref, updates);
  userPreferences.set(userId, pref);
  schedulePrefSave();
}

/** 恢复用户偏好到运行中的 pi 进程（重启后调用）
 *  只 reapply 用户自定义的偏好，避免向 pi 发送冗余的 setModel/setThinkingLevel
 */
async function reapplyUserPref(userId, client) {
  const rawPref = userPreferences.get(userId);
  if (!rawPref) return;  // 没有用户自定义，无需 reapply
  // 只 reapply 用户显式设置的字段
  if (rawPref.provider && rawPref.modelId) {
    try {
      await client.setModel(rawPref.provider, rawPref.modelId);
      console.log(`✅ [pi-rpc:${userId}] 恢复模型: ${rawPref.provider}/${rawPref.modelId}`);
    } catch (e) { console.warn(`⚠️ [pi-rpc:${userId}] 恢复模型失败:`, e.message); }
  }
  if (rawPref.thinking) {
    try {
      await client.setThinkingLevel(rawPref.thinking);
      console.log(`✅ [pi-rpc:${userId}] 恢复思考等级: ${rawPref.thinking}`);
    } catch (e) { console.warn(`⚠️ [pi-rpc:${userId}] 恢复思考等级失败:`, e.message); }
  }
}

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
  'deepseek': { provider: 'commandcode', modelId: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  'deepseek闪': { provider: 'commandcode', modelId: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  'deepseek-flash': { provider: 'commandcode', modelId: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  'deepseek-pro': { provider: 'commandcode', modelId: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  'kimi': { provider: 'kimi-coding', modelId: 'kimi-k2.6', name: 'Kimi K2.6' },
  'kimi-k2.6': { provider: 'kimi-coding', modelId: 'kimi-k2.6', name: 'Kimi K2.6' },
  'mimo': { provider: 'commandcode', modelId: 'xiaomi/mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
  'mimo-pro': { provider: 'commandcode', modelId: 'xiaomi/mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
  'mimo-flash': { provider: 'xiaomi-mimo', modelId: 'mimo-v2-flash', name: 'MiMo V2 Flash' },
  'xiaomi': { provider: 'xiaomi-mimo', modelId: 'mimo-v2-flash', name: '小米 MiMo' },
  'claude': { provider: 'anthropic', modelId: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
  'sonnet': { provider: 'anthropic', modelId: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
  'claude-sonnet': { provider: 'anthropic', modelId: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
  'gpt': { provider: 'commandcode', modelId: 'gpt-5.4', name: 'GPT-5.4' },
  'gpt-5': { provider: 'commandcode', modelId: 'gpt-5.4', name: 'GPT-5.4' },
  '可灵': { provider: 'kimi-coding', modelId: 'kimi-k2.6', name: 'Kimi K2.6' },
};

// ===== UserSession 类 =====
class UserSession {
  constructor(userId) {
    this.userId = userId;
    // 每个用户独立的 session 目录，便于 /clear 时彻底删除
    const sanitizedUserId = userId.replace(/[^a-zA-Z0-9_.@-]/g, '_');
    this.sessionDir = path.join(os.homedir(), '.pi', 'agent', 'sessions', 'pi-wechat-bridge', sanitizedUserId);
    // 用用户偏好初始化 pi 客户端（内存级 + 磁盘持久化）
    const pref = getUserPref(userId);
    this.client = new PiRpcClient({
      piBin: config.piBin,
      cwd: config.piCwd,
      provider: pref.provider,
      model: pref.modelId,
      thinking: pref.thinking,
      tools: config.piTools,
      noSession: config.piNoSession,
      sessionDir: config.piNoSession ? undefined : this.sessionDir,
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
    this.pendingInterrupts = [];  // 用户打断时暂存的新消息列表
    this._intentionalRestart = false;  // 标记是否为主动重启，防止 exit handler 重复重启

    // ===== 运行时 extension_ui_request 交互状态 =====
    /** @type {{ id: string, method: string, title?: string, options?: string[], message?: string, placeholder?: string, prefill?: string, timeout?: number } | null} */
    this.pendingUIRequest = null;
    /** @type {NodeJS.Timeout | null} */
    this.uiRequestTimer = null;

    this.client.on('extension_ui_request', (req) => {
      handleExtensionUIRequest(this.userId, req);
    });

    this.client.on('exit', async ({ code }) => {
      console.warn(`[pi-rpc:${userId}] 进程退出 (code=${code})`);
      this.busy = false;
      this._clearBusyTimer();
      this.streamBuffer = null;
      // 清理 pending UI 请求（pi 已死，无法再 respondExtensionUI）
      this._clearUIRequestTimer();
      this.pendingUIRequest = null;
      // 如果是主动重启（/restart 命令），跳过自动重启
      if (this._intentionalRestart) {
        this._intentionalRestart = false;
        console.log(`[pi-rpc:${userId}] 主动重启，跳过自动重启`);
        return;
      }
      console.warn(`[pi-rpc:${userId}] 非主动退出，2s 后自动重启...`);
      await new Promise(r => setTimeout(r, 2000));
      try {
        await this.start();
        // 重启后恢复用户偏好（模型 / 思考等级）
        await reapplyUserPref(userId, this.client);
        console.log(`✅ [pi-rpc:${userId}] 已自动重启`);
        // 如果用户之前有排队的中断消息，执行最新的一条
        if (this.pendingInterrupts.length > 0) {
          const pending = this.pendingInterrupts.pop();  // LIFO：只执行最新的一条
          this.pendingInterrupts = [];  // 清空其余的
          console.log(`[pi-rpc:${userId}] 执行排队的中断消息: ${pending.slice(0, 80)}`);
          setImmediate(() => handlePiPrompt(userId, pending));
        }
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
    this._clearUIRequestTimer();
    this.pendingUIRequest = null;
  }

  isAlive() {
    if (!this.client?.proc?.pid || this.client.proc.killed) return false;
    try { return process.kill(this.client.proc.pid, 0); } catch { return false; }
  }

  releaseBusy() {
    this.busy = false;
    this._clearBusyTimer();
    this.streamBuffer = null;
    // 处理用户打断时排队的新消息（最多执行最后一个，避免重复）
    if (this.pendingInterrupts.length > 0) {
      const pending = this.pendingInterrupts.pop();  // 只执行最新的一条
      this.pendingInterrupts = [];  // 清空其余的
      console.log(`[pi-rpc:${this.userId}] 执行排队的中断消息: ${pending.slice(0, 80)}`);
      setImmediate(() => handlePiPrompt(this.userId, pending));
    }
  }

  _clearBusyTimer() {
    if (this.busyTimer) { clearTimeout(this.busyTimer); this.busyTimer = null; }
  }

  _clearUIRequestTimer() {
    if (this.uiRequestTimer) { clearTimeout(this.uiRequestTimer); this.uiRequestTimer = null; }
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
  // pi 进程挂了但 session 对象还在 → 重启并恢复偏好
  if (!session.isAlive() && !session.starting) {
    console.log(`[pi-rpc:${userId}] 进程已死，重启中...`);
    await session.start();
    await reapplyUserPref(userId, session.client);
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

// ===== Extension UI 交互处理 =====
// 当 pi agent 运行时发起 extension_ui_request（select/confirm/input/editor 等），
// 将请求格式化为微信消息发给用户，等待用户回复后通过 respondExtensionUI 回传给 pi。

/** 对话式 UI 方法（需要用户回复） */
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

/** 即发即弃 UI 方法（仅需展示，不需要回复） */
const FIREFORGET_METHODS = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']);

/**
 * Sanitize pi 扩展传入的文本，防止在微信 Markdown 上下文中注入仿冒系统消息
 * 或钓鱼链接。
 *
 * 策略：
 * - 去除 Markdown 格式标记（**、>、#、[链接](url)）— 防止扩展伪造加粗/引用/标题/链接
 * - 截断过长文本 — 防止信息淹没
 * - 不做 HTML 清理 — 企业微信不支持 HTML，风险面有限
 *
 * @param {string} text - 来自 pi 扩展的原始文本
 * @param {number} [maxLen=500] - 截断长度
 * @returns {string} 清洗后的安全文本
 */
function sanitizeUIText(text, maxLen = 500) {
  if (!text) return '';
  // 去除 Markdown 链接 [text](url) → text（括号捕获用于 $1 替换）
  let safe = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 去除 Markdown 加粗/斜体标记
  safe = safe.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  // 去除 Markdown 引用标记 >
  safe = safe.replace(/^\s*>\s*/gm, '');
  // 去除 Markdown 标题标记 #
  safe = safe.replace(/^\s*#{1,6}\s*/gm, '');
  // 截断
  if (safe.length > maxLen) safe = safe.slice(0, maxLen) + '…';
  return safe;
}

/**
 * 将 extension_ui_request 格式化为微信用户可读的消息并发送
 * @param {string} userId
 * @param {object} req - pi RPC 的 extension_ui_request 消息
 */
async function handleExtensionUIRequest(userId, req) {
  const { id, method } = req;
  console.log(`[ui-req:${userId}] method=${method}, id=${id}, title=${req.title || '(none)'}`);

  // ---- 即发即弃方法：仅展示 ----
  if (FIREFORGET_METHODS.has(method)) {
    const text = formatFireAndForget(req);
    if (text) await safeSend(config, userId, text);
    return;
  }

  // ---- 对话式方法：展示 + 等待用户回复 ----
  if (!DIALOG_METHODS.has(method)) {
    console.warn(`[ui-req:${userId}] 未知 UI method: ${method}`);
    return;
  }

  const session = userSessions.get(userId);
  if (!session || !session.isAlive()) {
    console.warn(`[ui-req:${userId}] 会话不存在或 pi 已死，忽略 UI 请求`);
    return;
  }

  // 如果已有一个 pending 请求，先取消（响应 cancelled）
  if (session.pendingUIRequest) {
    console.warn(`[ui-req:${userId}] 已有 pending UI 请求 ${session.pendingUIRequest.id}，自动取消`);
    try {
      session.client.respondExtensionUI(session.pendingUIRequest.id, { cancelled: true });
    } catch {}
    session._clearUIRequestTimer();
    session.pendingUIRequest = null;
  }

  // 格式化用户消息
  const text = formatDialogRequest(req);
  await safeSend(config, userId, text);

  // 设为 pending
  session.pendingUIRequest = req;

  // 设置超时（pi 端也会超时，但我们在 bridge 端也设一个兜底）
  const timeoutMs = req.timeout || 5 * 60 * 1000; // 默认 5 分钟
  session.uiRequestTimer = setTimeout(() => {
    session.uiRequestTimer = null;
    if (session.pendingUIRequest && session.pendingUIRequest.id === id) {
      console.warn(`[ui-req:${userId}] UI 请求超时 id=${id}`);
      session.pendingUIRequest = null;
      safeSend(config, userId, '⏰ 交互请求已超时，pi 将使用默认值继续');
    }
  }, timeoutMs);
  session.uiRequestTimer.unref?.();
}

/**
 * 处理用户对 pending UI 请求的回复
 * @param {string} userId
 * @param {string} content - 用户消息原文
 * @returns {boolean} true 表示已处理（是 UI 回复），false 表示不是
 */
async function handleUIResponse(userId, content) {
  const session = userSessions.get(userId);
  if (!session || !session.pendingUIRequest) return false;

  // 核心命令豁免 — 这些命令即使在有 pending UI 请求时也应正常执行
  // /cancel 不豁免 — 有 pending UI 时作为取消 UI 请求处理
  const COMMAND_EXEMPTIONS = ['/help', '/status', '/abort', '/restart', '/restart-bridge'];
  const trimmedLower = content.trim().toLowerCase();
  if (COMMAND_EXEMPTIONS.includes(trimmedLower)) {
    return false;  // 让这些命令走正常的 handleMessage 流程
  }

  const req = session.pendingUIRequest;
  const { id, method } = req;

  // 清理状态
  session.pendingUIRequest = null;
  session._clearUIRequestTimer();

  // 用户取消
  const trimmed = content.trim().toLowerCase();
  if (trimmed === '/cancel' || trimmed === '取消' || trimmed === 'cancel') {
    try {
      session.client.respondExtensionUI(id, { cancelled: true });
    } catch (err) {
      console.error(`[ui-req:${userId}] 回复取消失败:`, err.message);
    }
    await safeSend(config, userId, '❌ 已取消交互请求');
    return true;
  }

  // 根据方法解析用户回复
  let response;
  try {
    response = parseUIResponse(method, req, content);
  } catch (err) {
    // 解析失败 → 提示用户重新输入
    session.pendingUIRequest = req; // 恢复 pending 让用户重试
    await safeSend(config, userId, `⚠️ 无法解析回复: ${err.message}\n请重新输入或发 /cancel 取消`);
    return true;
  }

  try {
    session.client.respondExtensionUI(id, response);
    console.log(`[ui-req:${userId}] 已回复 id=${id}:`, JSON.stringify(response));
  } catch (err) {
    console.error(`[ui-req:${userId}] respondExtensionUI 失败:`, err.message);
    await safeSend(config, userId, `❌ 回复发送失败: ${err.message}`);
  }

  return true;
}

/**
 * 根据方法解析用户的文本回复为 extension_ui_response 的 payload
 */
function parseUIResponse(method, req, content) {
  switch (method) {
    case 'select': {
      const options = req.options || [];
      const trimmed = content.trim();
      // 优先按序号匹配
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= options.length) {
        return { value: options[num - 1] };
      }
      // 精确匹配选项内容（不区分大小写）
      const idx = options.findIndex(o => o.toLowerCase() === trimmed.toLowerCase());
      if (idx !== -1) {
        return { value: options[idx] };
      }
      // 不做部分匹配 — 防止恶意选项列表利用模糊匹配误导用户意图
      throw new Error(`无效选项 "${trimmed}"，请输入 1-${options.length} 的序号或选项完整文本`);
    }
    case 'confirm': {
      const yes = ['yes', 'y', '是', '确认', '确认执行', 'ok', '允许', '同意', '好的', '好'];
      const no = ['no', 'n', '否', '拒绝', '取消执行', 'deny', '不行'];
      const lower = content.trim().toLowerCase();
      if (yes.some(k => lower === k || lower.startsWith(k))) {
        return { confirmed: true };
      }
      if (no.some(k => lower === k || lower.startsWith(k))) {
        return { confirmed: false };
      }
      // 无法判断时默认否
      return { confirmed: false };
    }
    case 'input':
    case 'editor': {
      // /keep = 保留原内容（仅 editor）
      if (method === 'editor' && content.trim().toLowerCase() === '/keep') {
        return { value: req.prefill || '' };
      }
      return { value: content };
    }
    default:
      throw new Error(`未知的 UI 方法: ${method}`);
  }
}

/** 格式化对话式 UI 请求为微信消息 */
function formatDialogRequest(req) {
  const { method, title, message, options, placeholder, prefill } = req;
  const lines = [];

  switch (method) {
    case 'select': {
      lines.push(`❓ **${title || '请选择'}**`);
      if (message) lines.push(message);
      lines.push('');
      for (let i = 0; i < (options || []).length; i++) {
        lines.push(`${i + 1}. ${options[i]}`);
      }
      lines.push('');
      lines.push('💡 回复序号或选项内容，或发 /cancel 取消');
      break;
    }
    case 'confirm': {
      lines.push(`❓ **${title || '请确认'}**`);
      if (message) lines.push(message);
      lines.push('');
      lines.push('💡 回复 是/否 或 yes/no，或发 /cancel 取消');
      break;
    }
    case 'input': {
      lines.push(`❓ **${title || '请输入'}**`);
      if (message) lines.push(message);
      if (placeholder) lines.push(`(提示: ${placeholder})`);
      lines.push('');
      lines.push('💡 直接输入内容，或发 /cancel 取消');
      break;
    }
    case 'editor': {
      lines.push(`❓ **${title || '请编辑'}**`);
      if (message) lines.push(message);
      if (prefill) {
        lines.push('');
        // 截断显示预填内容
        const display = prefill.length > 300 ? prefill.slice(0, 300) + '…' : prefill;
        lines.push(`已有内容:`);
        lines.push('```');
        lines.push(display);
        lines.push('```');
        lines.push('');
        lines.push('💡 直接输入新内容，或发 /keep 保留原内容，或发 /cancel 取消');
      } else {
        lines.push('');
        lines.push('💡 直接输入内容，或发 /cancel 取消');
      }
      break;
    }
  }

  return lines.join('\n');
}

/** 格式化即发即忘 UI 请求为微信消息 */
function formatFireAndForget(req) {
  const { method, message, notifyType } = req;
  switch (method) {
    case 'notify': {
      // 仅保留通知类事件（error / warning / info）
      const emoji = notifyType === 'error' ? '❌' : notifyType === 'warning' ? '⚠️' : '📢';
      return `${emoji} ${message || ''}`;
    }
    // setStatus / setWidget / setTitle / set_editor_text 均为 pi CLI 状态栏装饰元素，
    // 在终端 UI 显示有意义，但在微信上只是噪声，一律静默丢弃。
    case 'setStatus':
    case 'setWidget':
    case 'setTitle':
    case 'set_editor_text':
    default:
      return '';
  }
}

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

  // ===== 优先处理 pending UI 请求 =====
  // 如果用户有未回复的交互式请求（select/confirm/input/editor），用户的下一条消息
  // 应作为对该请求的回复，而非新的 pi prompt。
  if (await handleUIResponse(userId, content)) {
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
      '  /model default       恢复默认模型\n' +
      '  /thinking high      思考等级\n' +
      '  /stream on|off      流式模式开关\n' +
      '  /restart             重启 pi 进程\n' +
      '  /restart-bridge      重启桥接服务 (管理员)\n' +
      '  /compact             压缩上下文\n' +
      '  /clear              清除自己的会话\n' +
      '  /status             查看自己的状态\n' +
      '  /models             列出模型\n' +
      '  /abort              中止操作\n' +
      '  /cancel              取消交互请求\n' +
      '  /help               帮助';
    if (isAdmin) {
      helpText +=
        '\n\n👑 管理员命令:\n' +
        '  /sessions           查看所有活跃会话\n' +
        '  /clear <userId>     清除指定用户会话\n' +
        '  /clear-all          清除所有会话\n' +
        '  /restart-bridge     重启桥接服务';
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

  // ===== /cancel — 取消交互请求 =====
  if (content === '/cancel') {
    // handleUIResponse 已经在有 pendingUIRequest 时处理了 /cancel
    // 到这里说明没有 pending UI 请求
    await safeSend(config, userId, 'ℹ️ 当前没有交互请求需要取消');
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
      // ⚠️ /clear 只清除对话上下文，不清除用户偏好（模型/思考等级）
      // 用户可发 /model default 回退全局默认模型
      if (session.sessionDir) {
        try {
          await fs.rm(session.sessionDir, { recursive: true, force: true });
          console.log(`[session] 已删除会话目录: ${session.sessionDir}`);
        } catch (err) {
          console.error(`[session] 删除会话目录失败: ${err.message}`);
        }
      }
      await safeSend(config, userId, '🧹 会话已清除，下次发消息将创建新会话');
    } else {
      await safeSend(config, userId, 'ℹ️ 当前没有活跃会话');
    }
    return;
  }

  // 非管理员尝试管理员命令
  const isAdmin = config.adminUser && userId === config.adminUser;
  const clearUserMatch = content.match(/^\/clear\s+(\S+)$/);
  if (!isAdmin && (content === '/sessions' || content === '/clear-all' || clearUserMatch || content === '/restart-bridge')) {
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
      // 删除磁盘会话文件
      if (session.sessionDir) {
        try {
          await fs.rm(session.sessionDir, { recursive: true, force: true });
        } catch (err) {
          console.error(`[session] 删除会话目录失败: ${err.message}`);
        }
      }
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
    for (const [, session] of userSessions) {
      session.stop();
      // 删除磁盘会话文件
      if (session.sessionDir) {
        try {
          await fs.rm(session.sessionDir, { recursive: true, force: true });
        } catch (err) {
          console.error(`[session] 删除会话目录失败: ${err.message}`);
        }
      }
    }
    userSessions.clear();
    if (idleEvictTimer) { clearInterval(idleEvictTimer); idleEvictTimer = null; }
    await safeSend(config, userId, `🧹 已清除所有 ${count} 个会话`);
    return;
  }

  // ===== /restart-bridge — 重启桥接服务（管理员） =====
  if (content === '/restart-bridge' && isAdmin) {
    await safeSend(config, userId, '🔄 正在重启桥接服务...');
    // 标记所有 session 为主动关闭，防止 pi exit handler 试图自动重启拖慢关闭
    for (const [, session] of userSessions) {
      session._intentionalRestart = true;
    }
    // 先刷盘偏好，确保不丢数据
    if (prefSaveTimer) { clearTimeout(prefSaveTimer); prefSaveTimer = null; }
    await savePreferences();
    // 写入重启标记文件，新进程启动后将通知管理员
    const RESTART_FLAG_FILE = path.join(os.homedir(), '.pi', 'wechat-bridge', '.restart-bridge-flag');
    await fs.mkdir(path.dirname(RESTART_FLAG_FILE), { recursive: true });
    await fs.writeFile(RESTART_FLAG_FILE, JSON.stringify({ userId, ts: Date.now() }));
    // 先优雅关闭当前进程（释放端口、停 pi），关闭后再 spawn 新进程
    // gracefulShutdown 支持 onShutdownDone 回调，用于在进程退出前 spawn 新进程
    gracefulShutdown('/restart-bridge', async () => {
      try {
        const bridgeArgs = [path.join(import.meta.dirname, 'server.js')];
        const logDir = process.env.TUNNEL_LOG_DIR || path.join(os.homedir(), 'logs', 'pi-wechat-bridge');
        await fs.mkdir(logDir, { recursive: true });
        const logFile = path.join(logDir, 'bridge.log');
        const logFd = await fs.open(logFile, 'a');
        const child = spawn(process.execPath, bridgeArgs, {
          detached: true,
          stdio: ['ignore', logFd, logFd],  // stdout/stderr 追加到日志文件
          env: { ...process.env },  // 继承当前环境变量（含 .env）
          cwd: process.cwd(),
        });
        child.unref();
        logFd.close();  // 父进程关闭 fd，子进程已继承
        console.log(`[bridge] 已派生新进程 PID=${child.pid}`);
      } catch (err) {
        console.error('[bridge] 派生新进程失败:', err.message);
      }
    });
    return;
  }

  // ===== /restart — 重启 pi 进程（保留会话上下文） =====
  if (content === '/restart') {
    const session = userSessions.get(userId);
    if (session) {
      const wasBusy = session.busy;
      if (wasBusy) {
        session.client.abort();
        if (session.streamBuffer) {
          try { await session.streamBuffer.abort(); } catch {}
        }
      }
      session.pendingInterrupts = [];  // 清除排队消息
      session._intentionalRestart = true;  // 标记为主动重启，防止 exit handler 重复重启
      session.stop();
      try {
        await session.start();
        await reapplyUserPref(userId, session.client);
        await safeSend(config, userId, `✅ pi 进程已重启 (PID: ${session.client?.proc?.pid})${wasBusy ? '\n⚠️ 之前有任务在运行，已被中止' : ''}`);
      } catch (err) {
        // 重启失败：删除会话，下次消息自动重建
        userSessions.delete(userId);
        await safeSend(config, userId, `❌ 重启失败: ${err.message}\n💡 下次发消息将自动创建新会话`);
      }
    } else {
      try {
        await getUserSession(userId);
        await safeSend(config, userId, '✅ pi 会话已创建');
      } catch (err) {
        await safeSend(config, userId, `❌ 启动失败: ${err.message}`);
      }
    }
    return;
  }

  // ===== /compact — 压缩上下文 =====
  if (content === '/compact') {
    const session = userSessions.get(userId);
    if (!session?.isAlive()) {
      await safeSend(config, userId, 'ℹ️ 当前没有活跃的 pi 进程');
      return;
    }
    if (session.busy) {
      await safeSend(config, userId, '⏳ 正在处理中，请等待当前任务完成后再压缩，或先 /abort');
      return;
    }
    try {
      session.client.compact();
      await safeSend(config, userId, '📦 已触发上下文压缩...');
    } catch (err) {
      await safeSend(config, userId, `❌ 压缩请求失败: ${err.message}`);
    }
    return;
  }

  // ===== /abort =====
  if (content === '/abort') {
    const session = userSessions.get(userId);
    if (session?.busy) {
      // 如果有 pending UI 请求，先取消
      if (session.pendingUIRequest) {
        try {
          session.client.respondExtensionUI(session.pendingUIRequest.id, { cancelled: true });
        } catch {}
        session.pendingUIRequest = null;
        session._clearUIRequestTimer();
      }
      session.client.abort();
      if (session.streamBuffer) {
        try { await session.streamBuffer.abort(); } catch {}
      }
      session.pendingInterrupts = [];  // /abort 清除所有排队消息
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
    const pref = getUserPref(userId);
    const parts = [
      `📊 会话状态:`,
      `- pi 进程: ${session?.isAlive() ? 'running' : 'not started'}`,
      `- 忙碌: ${session?.busy ?? false}`,
      `- 流式: ${isStreamingEnabledFor(userId) ? '开启' : '关闭'}`,
      `- 多段输入: ${composingUsers.has(userId) ? `进行中 (${composingUsers.get(userId)?.length} 段)` : '无'}`,
    ];
    if (session?.pendingUIRequest) {
      // 只显示 method，不显示 title（title 来自 pi 扩展，可能含注入内容）
      parts.push(`- 交互请求: ${session.pendingUIRequest.method} (等待回复)`);
    }
    if (pref.hasCustomModel) {
      parts.push(`- 偏好模型: ${pref.provider}/${pref.modelId}`);
    }
    if (pref.hasCustomThinking) {
      parts.push(`- 偏好思考: ${pref.thinking}`);
    }
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
    // /model default / /model 默认 → 清除偏好，回退全局默认
    if (modelStr === 'default' || modelStr === '默认') {
      const session = userSessions.get(userId);
      const rawPref = userPreferences.get(userId);
      // 只有用户有自定义偏好时才需要 apply 全局默认
      if (rawPref) {
        if (session?.isAlive() && session.client) {
          try { await session.client.setModel(config.piProvider, config.piModel); } catch {}
        }
        // 重置 PiRpcClient 内部属性，确保后续 start() 用全局默认
        if (session?.client) {
          session.client.provider = config.piProvider;
          session.client.model = config.piModel;
        }
        if (rawPref.thinking && rawPref.thinking !== config.piThinking) {
          if (session?.isAlive() && session.client) {
            try { await session.client.setThinkingLevel(config.piThinking); } catch {}
          }
          if (session?.client) session.client.thinking = config.piThinking;
        }
        // 删除该用户偏好
        userPreferences.delete(userId);
        schedulePrefSave();
      }
      await safeSend(config, userId, `✅ 已恢复默认模型: ${config.piProvider || '(auto)'}/${config.piModel || '(auto)'}`);
      return;
    }
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
      // 持久化用户偏好，跨会话回收 / 进程重启保留
      setUserPref(userId, { provider: modelMatch.provider, modelId: modelMatch.modelId });
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
      // 持久化用户偏好
      setUserPref(userId, { thinking: level });
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

  // 检查是否忙碌 — 使用 steer 进行中间插话
  if (session.busy || session.starting) {
    if (session.starting) {
      await safeSend(config, userId, '⏳ pi 进程正在启动，请稍后重试...');
      return;
    }
    // 通过 steer 命令将新消息插入下一个交互轮次
    try {
      session.client.steer(content);
      session.pendingInterrupts.push(content);  // 排队，作为 fallback
      console.log(`[pi-rpc:${userId}] 用户打断，steer 已发送: ${content.slice(0, 80)}`);
      await safeSend(config, userId, '🔄 已将新指令插入当前处理，将在下一轮执行...');
    } catch (err) {
      console.error(`[pi-rpc:${userId}] steer 发送失败:`, err.message);
      await safeSend(config, userId, '⏳ 正在处理中，steer 失败。请稍等或发 /abort 中止');
    }
    return;
  }

  session.busy = true;
  session.lastActive = Date.now();

  // ===== 活动感知超时 =====
  // 仅基于空闲时间判断，progress 事件持续到来时不触发任何超时。
  let lastActivity = Date.now();
  const ACTIVITY_TIMEOUT = 120_000;  // 静默 2 分钟 → 释放锁（pi 仍运行）
  const HARD_TIMEOUT = 600_000;      // pi-rpc-client 空闲超时阈值（传递给 prompt()）
  const CHECK_INTERVAL = 30_000;     // 每 30 秒检查

  function startActivityMonitor() {
    session._clearBusyTimer();
    session.busyTimer = setTimeout(() => {
      const idle = Date.now() - lastActivity;
      if (idle > ACTIVITY_TIMEOUT) {
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
      // 非流式也需要更新 lastActivity，避免 pi 执行工具时被误判为静默超时
      promptArg = {
        timeout: HARD_TIMEOUT,
        onProgress: () => { lastActivity = Date.now(); },
      };
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
      pendingUIRequest: session.pendingUIRequest ? { method: session.pendingUIRequest.method, id: session.pendingUIRequest.id } : null,
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
        await reapplyUserPref(userId, session.client);
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
      await reapplyUserPref(uid, session.client);
      count++;
    } catch {}
  }
  res.json({ status: 'ok', message: `已重启 ${count}/${userSessions.size} 个会话` });
});

// ===== 管理员通知端点（cloudflared watchdog 调用） =====
app.post('/notify-admin', express.json(), async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.json({ status: 'error', message: '缺少 message 参数' });
  if (!config.adminUser) return res.json({ status: 'error', message: '未配置 ADMIN_USER' });
  try {
    await safeSend(config, config.adminUser, message);
    res.json({ status: 'ok', message: '已通知管理员' });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  }
});

// ===== Tunnel 状态端点 =====
app.get('/tunnel-status', async (req, res) => {
  const logDir = process.env.TUNNEL_LOG_DIR || `${process.env.HOME}/logs/pi-wechat-bridge`;
  const urlFile = `${logDir}/tunnel-url.txt`;
  try {
    const url = (await fs.readFile(urlFile, 'utf8')).trim();
    res.json({
      status: 'ok',
      tunnelUrl: url || null,
      callbackUrl: url ? `${url}/wxwork/callback` : null,
      managedBy: 'independent',
    });
  } catch {
    res.json({ status: 'ok', tunnelUrl: null, callbackUrl: null, managedBy: 'independent' });
  }
});


// ===== 启动 =====
async function main() {
  // 加载用户偏好（磁盘持久化）
  await loadPreferences();
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

  // 将 server 暴露给模块级 gracefulShutdown
  _httpServer = app.listen(config.bridgePort, async () => {
    console.log(`\n✅ 桥接服务器已启动: http://localhost:${config.bridgePort}`);
    console.log(`\n📋 企业微信配置回调 URL:`);
    console.log(`   URL: http://<你的服务器IP>:${config.bridgePort}/wxwork/callback`);
    console.log(`   Token: ${config.token}`);
    console.log(`   EncodingAESKey: ${config.encodingAesKey}`);
    console.log(`\n💡 健康检查: http://localhost:${config.bridgePort}/health`);

    // 检查重启标记：如果是由 /restart-bridge 触发的重启，通知管理员
    const RESTART_FLAG_FILE = path.join(os.homedir(), '.pi', 'wechat-bridge', '.restart-bridge-flag');
    try {
      const flagData = await fs.readFile(RESTART_FLAG_FILE, 'utf8');
      const flag = JSON.parse(flagData);
      await fs.unlink(RESTART_FLAG_FILE);  // 删除标记
      if (flag.userId && config.adminUser === flag.userId) {
        const uptime = Math.round((Date.now() - flag.ts) / 1000);
        await safeSend(config, flag.userId, `✅ 桥接服务已重启完成 (${uptime}s)`);
        console.log(`[bridge] 已通知管理员 ${flag.userId} 重启完成`);
      }
    } catch {
      // 标记文件不存在 → 正常启动，不是重启场景
    }
  });
  // 端口占用时给出明确错误而非 crash
  _httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[bridge] ❌ 端口 ${config.bridgePort} 已被占用，请检查是否有其他实例在运行`);
      process.exit(1);
    }
    throw err;
  });
}

async function gracefulShutdown(signal, onShutdownDone) {
  console.log(`\n🛑 收到 ${signal}，正在关闭...`);
  const timer = setTimeout(() => {
    console.error('[bridge] ⚠️ 关闭超时 (10s)，强制退出');
    process.exit(1);
  }, 10000);

  try {
    // 停止所有用户会话
    for (const [, session] of userSessions) session.stop();
    userSessions.clear();
    if (idleEvictTimer) { clearInterval(idleEvictTimer); idleEvictTimer = null; }

    // 刷盘偏好（确保退出前不丢数据）
    if (prefSaveTimer) { clearTimeout(prefSaveTimer); prefSaveTimer = null; }
    await savePreferences();

    // 关闭 HTTP 服务器（释放端口）— 先强制关闭所有活跃连接（如 cloudflared keep-alive），
    // 再等待 close 回调，否则 keep-alive 连接会导致 close() 永远不回调
    if (_httpServer) {
      _httpServer.closeAllConnections?.();
      await new Promise(resolve => _httpServer.close(resolve));
    }

    // 如果有回调（如 /restart-bridge 需要在关闭后 spawn 新进程），先执行
    if (onShutdownDone) {
      try { await onShutdownDone(); } catch (err) { console.error('[bridge] 关闭回调失败:', err.message); }
    }
  } catch (err) {
    console.error('[bridge] 关闭过程中出错:', err.message);
  }

  clearTimeout(timer);
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

main().catch(err => {
  console.error('💥 启动失败:', err);
  process.exit(1);
});