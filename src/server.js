/**
 * pi-wechat-bridge 主服务器
 * 将企业微信消息转发给 pi agent，并将 pi 的回复发回微信
 */
import express from 'express';
import { parseStringPromise } from 'xml2js';
import dotenv from 'dotenv';
import { encrypt, decrypt, verifySignature } from './wxwork-crypto.js';
import { sendTextMessage, sendMarkdownMessage } from './wxwork-api.js';

// 安全发送消息：失败时记录日志但不抛异常，避免影响主流程
async function safeSend(config, userId, text) {
  try {
    await sendTextMessage(config, userId, text);
  } catch (err) {
    console.error('[msg] 发送消息失败:', err.message);
  }
}
import { PiRpcClient } from './pi-rpc-client.js';

dotenv.config();

// ===== 全局错误处理 =====
process.on('uncaughtException', (err) => {
  console.error('[fatal] 未捕获的异常:', err);
  // 给日志 flush 一点时间，然后退出
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason, promise) => {
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
  piProvider: process.env.PI_PROVIDER,
  piModel: process.env.PI_MODEL,
  piThinking: process.env.PI_THINKING || 'medium',
  piTools: process.env.PI_TOOLS || 'read,bash,edit,write,grep,find,ls',
  piCwd: process.env.PI_CWD || process.cwd(),
  piNoSession: process.env.PI_NO_SESSION !== 'false',
  piNoExtensions: process.env.PI_NO_EXTENSIONS === 'true',
  piNoSkills: process.env.PI_NO_SKILLS === 'true',
  piNoContextFiles: process.env.PI_NO_CONTEXT_FILES === 'true',
};

// ===== 验证必需配置 =====
const required = ['WXWORK_CORP_ID', 'WXWORK_AGENT_ID', 'WXWORK_SECRET', 'WXWORK_TOKEN', 'WXWORK_ENCODING_AES_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ 缺少必需配置: ${missing.join(', ')}`);
  console.error('请复制 .env.example 为 .env 并填写企业微信应用配置');
  console.error('参考 README.md 中的"企业微信配置步骤"');
  process.exit(1);
}

// ===== pi RPC 客户端 =====
let piClient = null;
let isPiBusy = false;
let busyTimer = null;

async function startPi({ isRestart = false } = {}) {
  const createClient = () => {
    const client = new PiRpcClient({
      cwd: config.piCwd,
      provider: config.piProvider,
      model: config.piModel,
      thinking: config.piThinking,
      tools: config.piTools,
      noSession: config.piNoSession,
      noExtensions: config.piNoExtensions,
      noSkills: config.piNoSkills,
      noContextFiles: config.piNoContextFiles,
    });

    // 监听进程退出，自动重启
    client.on('exit', async ({ code }) => {
      console.warn(`[pi-rpc] 进程退出 (code=${code})，5 秒后自动重启...`);
      isPiBusy = false;
      if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
      await new Promise(r => setTimeout(r, 5000));
      try {
        await startPi({ isRestart: true });
        console.log('✅ pi RPC 已自动重启');
      } catch (err) {
        console.error('❌ pi RPC 自动重启失败:', err.message);
        // 重启失败不退出进程，保持运行等待下次重试或 watchdog
      }
    });

    return client;
  };

  piClient = createClient();

  try {
    await piClient.start();
    console.log('✅ pi RPC 客户端已启动');
  } catch (err) {
    console.error('❌ pi RPC 启动失败:', err.message);
    console.error('请确保 pi 已安装 (npm install -g @earendil-works/pi-coding-agent)');
    console.error('并且 ANTHROPIC_API_KEY 或其他 provider 的 API key 已设置');
    if (!isRestart) {
      process.exit(1);
    }
    throw err; // 让调用方（exit handler）的 catch 能捕获到
  }
}

// ===== Express 服务器 =====
const app = express();

// 微信回调 URL 验证 (GET)
app.get('/wxwork/callback', async (req, res) => {
  try {
    const { msg_signature, timestamp, nonce, echostr } = req.query;

    // 验证签名
    const valid = verifySignature(config.token, timestamp, nonce, echostr, msg_signature);
    if (!valid) {
      console.warn('[callback] 签名验证失败');
      return res.status(403).send('签名验证失败');
    }

    // 解密 echostr
    const reply = decrypt(config.corpId, config.encodingAesKey, echostr);
    console.log('[callback] 验证成功，回显 echostr');
    res.send(reply);
  } catch (err) {
    console.error('[callback] 验证错误:', err);
    res.status(500).send('内部错误');
  }
});

// 微信消息接收 (POST)
app.post('/wxwork/callback', express.text({ type: 'text/xml' }), async (req, res) => {
  // 标记是否已回复，防止重复 send
  let replied = false;
  function safeReply() {
    if (!replied) { replied = true; res.send(''); }
  }

  try {
    // 签名参数在 URL query 里（跟 GET 一样），不在 XML body 里
    const { msg_signature, timestamp, nonce } = req.query;

    // 解析 XML body，只有 Encrypt 字段
    const xmlResult = await parseStringPromise(req.body, { explicitArray: false });
    const wxMsg = xmlResult.xml;
    const encryptContent = wxMsg.Encrypt;

    // 验证签名
    const valid = verifySignature(config.token, timestamp, nonce, encryptContent, msg_signature);
    if (!valid) {
      console.warn('[msg] 签名验证失败', { msg_signature, timestamp, nonce, encryptContent: encryptContent?.slice(0, 20) });
      return res.status(403).send('');
    }

    // 解密消息
    const plainText = decrypt(config.corpId, config.encodingAesKey, encryptContent);
    const msgData = await parseStringPromise(plainText, { explicitArray: false });
    const msg = msgData.xml;

    console.log(`[msg] 收到消息: From=${msg.FromUserName}, MsgType=${msg.MsgType}, Content=${msg.Content?.slice(0, 100)}`);

    // 立即回复空消息（企业微信要求在5秒内响应）
    safeReply();

    // 异步处理消息（不阻塞响应）
    handleMessage(msg).catch(err => {
      console.error('[msg] 异步处理错误:', err);
    });
  } catch (err) {
    console.error('[msg] 请求处理错误:', err);
    safeReply();
  }
});

// ===== 消息处理 =====
async function handleMessage(msg) {
  const userId = msg.FromUserName; // 企业微信 UserID
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

  // 特殊命令（不占用 pi 的并发锁）
  if (content === '/help') {
    await sendTextMessage(config, userId,
      '🤖 pi Agent 微信 Bot 命令\n\n' +
      '🎤 语音切换模型:\n' +
      '  "切换到 deepseek"\n' +
      '  "用 kimi"\n' +
      '  "换讯飞"\n' +
      '  "切到 mimo"\n' +
      '  "用 claude"\n' +
      '\n' +
      '⌨️ 文字命令:\n' +
      '  /model deepseek     切换模型\n' +
      '  /thinking high      思考等级\n' +
      '  /status             查看状态\n' +
      '  /models             列出模型\n' +
      '  /abort              中止操作\n' +
      '  /reset              强制重置(卡住时用)\n' +
      '  /help               帮助');
    return;
  }

  // /reset 命令 - 强制重置繁忙状态（任何时候都可执行）
  if (content === '/reset') {
    isPiBusy = false;
    if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
    if (piClient && !piClient.proc) {
      // pi 进程挂了，重启
      await safeSend(config, userId, '🔄 pi 进程已退出，正在重启...');
      try {
        await startPi({ isRestart: true });
        await safeSend(config, userId, '✅ pi 已重启，状态已重置');
      } catch (err) {
        await safeSend(config, userId, `❌ 重启失败: ${err.message}`);
      }
    } else {
      await safeSend(config, userId, '✅ 状态已重置，可以继续发消息了');
    }
    return;
  }

  // /abort 命令 - 任何时候都可执行
  if (content === '/abort') {
    if (piClient && piClient.proc) piClient.abort();
    isPiBusy = false;
    if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
    await safeSend(config, userId, '✅ 已中止当前操作。');
    return;
  }

  // 检查 pi 是否繁忙（在可能占用 pi 的操作之前统一检查）
  if (isPiBusy) {
    await sendTextMessage(config, userId, '⏳ pi 正在处理之前的请求，请稍后再发送新消息。');
    return;
  }

  // 从这一刻起占用并发锁，防止后续命令与 pi prompt 发生竞态
  isPiBusy = true;

  if (content === '/status') {
    try {
      const state = await piClient.getState();
      await sendTextMessage(config, userId,
        `📊 pi 状态:\n` +
        `- 模型: ${state?.model?.name || '未知'} (${state?.model?.provider || '?'})\n` +
        `- 模型ID: ${state?.model?.id || '未知'}\n` +
        `- 思考等级: ${state?.thinkingLevel || '未知'}\n` +
        `- 是否正在处理: ${state?.isStreaming ? '是' : '否'}\n` +
        `- 会话消息数: ${state?.messageCount || 0}`);
    } catch (err) {
      await safeSend(config, userId, `❌ 获取状态失败: ${err.message}`);
    } finally {
      isPiBusy = false;
    }
    return;
  }

  // ---- 智能模型切换 - 自然语言 ----
  // 支持: "切换到 deepseek" "用 kimi" "换讯飞" "切到 mimo" 等
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

  // 检查是否是模型切换指令（自然语言 + /model 命令）
  let modelMatch = null;

  // /model provider/modelId 格式
  if (content.startsWith('/model ')) {
    const modelStr = content.slice(7).trim();
    const parts = modelStr.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      modelMatch = { provider: parts[0], modelId: parts[1], name: modelStr };
    } else {
      // 试试别名
      const key = Object.keys(modelAliases).find(k => modelStr.includes(k));
      if (key) modelMatch = modelAliases[key];
    }
  } else {
    // 自然语言: "切换到xxx" "用xxx" "换xxx" "切到xxx"
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
        if (key) {
          modelMatch = modelAliases[key];
          break;
        }
      }
    }
  }

  if (modelMatch) {
    try {
      const result = await piClient.setModel(modelMatch.provider, modelMatch.modelId);
      const modelName = result?.name || modelMatch.name;
      const listLink = content.startsWith('/model') ? '' : '\n💡 发 /models 看全部模型';
      await safeSend(config, userId, `✅ 已切换到 ${modelName}${listLink}`);
    } catch (err) {
      await safeSend(config, userId, `❌ 切换失败: ${err.message}\n试试发 /models 查看可用模型`);
    } finally {
      isPiBusy = false;
    }
    return;
  }

  // 列出可用模型
  if (content === '/models') {
    try {
      const result = await piClient.getAvailableModels();
      const models = result?.models || [];
      if (models.length === 0) {
        await sendTextMessage(config, userId, '⚠️ 没有获取到可用模型列表');
        return;
      }
      // 按 provider 分组显示前 20 个
      const grouped = {};
      for (const m of models) {
        if (!grouped[m.provider]) grouped[m.provider] = [];
        if (grouped[m.provider].length < 5) {
          grouped[m.provider].push(m.id);
        }
      }
      let text = '📋 可用模型:\n';
      for (const [provider, ids] of Object.entries(grouped)) {
        text += `\n【${provider}】\n`;
        for (const id of ids) {
          text += `  ${provider}/${id}\n`;
        }
      }
      await safeSend(config, userId, text);
    } catch (err) {
      await safeSend(config, userId, `❌ 获取列表失败: ${err.message}`);
    } finally {
      isPiBusy = false;
    }
    return;
  }

  // 设置思考等级: /thinking low|medium|high
  if (content.startsWith('/thinking ')) {
    const level = content.slice(10).trim();
    const validLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    if (!validLevels.includes(level)) {
      isPiBusy = false;
      await sendTextMessage(config, userId,
        '⚠️ 等级: off, minimal, low, medium, high, xhigh');
      return;
    }
    try {
      await piClient.setThinkingLevel(level);
      await safeSend(config, userId, `✅ 思考等级已设为: ${level}`);
    } catch (err) {
      await safeSend(config, userId, `❌ 设置失败: ${err.message}`);
    } finally {
      isPiBusy = false;
    }
    return;
  }

  // 发送给 pi 处理
  // 安全超时：5 分钟后自动解除繁忙状态
  busyTimer = setTimeout(() => {
    if (isPiBusy) {
      console.warn('[msg] ⚠️ pi 处理超时 (5min)，自动重置繁忙状态');
      isPiBusy = false;
      busyTimer = null;
    }
  }, 300000);
  try {
    // 先回复"正在处理"
    await safeSend(config, userId, '🤔 正在思考中...');

    const reply = await piClient.prompt(content, 300000);

    // pi 有时返回空响应，给用户友好提示
    if (!reply || reply === '(无回复)') {
      await safeSend(config, userId, '🤔 pi 没有返回内容，可能是当前任务不需要文字回复，或者处理中遇到了问题。你可以继续发送消息。');
      return;
    }

    // pi 的回复可能很长，企业微信单条消息有长度限制 (2048 字符)
    // 如果超过限制，分段发送
    const MAX_LEN = 2000;
    if (reply.length <= MAX_LEN) {
      await safeSend(config, userId, reply);
    } else {
      // 分段发送
      const chunks = [];
      let remaining = reply;
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, MAX_LEN));
        remaining = remaining.slice(MAX_LEN);
      }

      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : '';
        await safeSend(config, userId, prefix + chunks[i]);
        // 避免发送太快被限流
        if (i < chunks.length - 1) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }
  } catch (err) {
    console.error('[msg] pi 处理失败:', err);
    await safeSend(config, userId, `❌ 处理失败: ${err.message}`);
  } finally {
    isPiBusy = false;
    if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
  }
}

// ===== 健康检查 =====
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    pi: piClient?.proc ? 'running' : 'stopped',
    isPiBusy,
    timestamp: new Date().toISOString(),
  });
});

// ===== 启动 =====
async function main() {
  console.log('🚀 pi-wechat-bridge 启动中...');
  console.log(`   端口: ${config.bridgePort}`);
  console.log(`   CorpID: ${config.corpId}`);
  console.log(`   AgentID: ${config.agentId}`);
  console.log(`   pi 工作目录: ${config.piCwd}`);
  if (config.allowedUsers.length > 0) {
    console.log(`   允许的用户: ${config.allowedUsers.join(', ')}`);
  } else {
    console.log('   允许所有用户');
  }

  await startPi();

  app.listen(config.bridgePort, () => {
    console.log(`\n✅ 桥接服务器已启动: http://localhost:${config.bridgePort}`);
    console.log(`\n📋 企业微信配置回调 URL:`);
    console.log(`   URL: http://<你的服务器IP>:${config.bridgePort}/wxwork/callback`);
    console.log(`   Token: ${config.token}`);
    console.log(`   EncodingAESKey: ${config.encodingAesKey}`);
    console.log(`\n💡 健康检查: http://localhost:${config.bridgePort}/health`);
  });
}

// 优雅退出（带超时保护，防止无限挂起）
function gracefulShutdown(signal) {
  console.log(`\n🛑 收到 ${signal}，正在关闭...`);
  const timer = setTimeout(() => {
    console.error('[shutdown] 强制退出');
    process.exit(1);
  }, 10000);
  timer.unref?.();
  if (piClient) piClient.stop();
  // 给 stop 一点时间，然后退出
  setTimeout(() => {
    clearTimeout(timer);
    process.exit(0);
  }, 500);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

main().catch(err => {
  console.error('💥 启动失败:', err);
  process.exit(1);
});