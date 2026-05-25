/**
 * StreamBuffer
 *
 * 把 PiRpcClient.prompt 的 onProgress 事件流批量化为企业微信消息：
 *   - 文本/思考增量按阈值或空闲计时器分段发送
 *   - 工具调用、状态事件作为独立消息插入（先 flush 当前累积，再发事件）
 *   - 所有发送通过单一 Promise 链串行化，附加 inter-send 延迟规避限流
 *
 * 不直接调用 wxwork-api；通过构造时注入的 `send(text)` 投递。
 */
export class StreamBuffer {
  /**
   * @param {object} opts
   * @param {(text: string) => Promise<void>} opts.send - 实际发送回调（如 safeSend 绑定）
   * @param {number} [opts.textFlushThreshold=1500]
   * @param {number} [opts.thinkingFlushThreshold=1800]
   * @param {number} [opts.idleMs=3500]
   * @param {number} [opts.interSendDelayMs=400]
   * @param {(...args: any[]) => void} [opts.logger]
   */
  constructor({
    send,
    textFlushThreshold = 1500,
    thinkingFlushThreshold = 1800,
    idleMs = 3500,
    interSendDelayMs = 400,
    logger = () => {},
  }) {
    if (typeof send !== 'function') throw new Error('StreamBuffer: send 函数必填');
    this.send = send;
    this.textFlushThreshold = textFlushThreshold;
    this.thinkingFlushThreshold = thinkingFlushThreshold;
    this.idleMs = idleMs;
    this.interSendDelayMs = interSendDelayMs;
    this.log = (...args) => logger('[stream]', ...args);

    this.textBuf = '';
    this.thinkingBuf = '';
    this.idleTimer = null;
    this.sendQueue = Promise.resolve();
    this.aborted = false;
  }

  /**
   * 入口：处理一个 ProgressEvent
   */
  handle(event) {
    if (this.aborted) return;
    switch (event.type) {
      case 'text_delta':
        this._appendText(event.delta);
        break;
      case 'thinking_delta':
        this._appendThinking(event.delta);
        break;
      case 'tool_start':
        this._enqueueEventMessage(formatToolStart(event));
        break;
      case 'tool_end':
        if (event.isError) this._enqueueEventMessage(formatToolError(event));
        break;
      case 'auto_retry_start':
        this._enqueueEventMessage(formatAutoRetryStart(event));
        break;
      case 'auto_retry_end':
        // 仅最终失败时通知；成功的 retry_end 不打扰用户
        if (!event.success) this._enqueueEventMessage(formatAutoRetryFail(event));
        break;
      case 'compaction_start':
        this._enqueueEventMessage('📦 上下文压缩中...');
        break;
      case 'compaction_end':
        this._enqueueEventMessage(
          event.aborted
            ? '⚠️ 压缩已中止'
            : event.errorMessage
              ? `❌ 压缩失败: ${truncate(event.errorMessage, 200)}`
              : '✅ 压缩完成',
        );
        break;
      // extension_ui_request 不在此处理 — server.js 的 handleExtensionUIRequest
      // 会发送完整的交互提示消息给用户，此处不再重复通知。
      default:
        this.log('未处理的进度事件:', event.type);
    }
  }

  _appendText(delta) {
    if (!delta) return;
    // 阶段切换：若刚才在累思考，先把思考送出，保持"先思考 → 后正文"的顺序
    if (this.thinkingBuf) this._flushThinking();
    this.textBuf += delta;
    this._resetIdleTimer();
    if (this.textBuf.length >= this.textFlushThreshold) this._flushText();
  }

  _appendThinking(delta) {
    if (!delta) return;
    // 阶段切换：若刚才在写正文，先把正文送出
    if (this.textBuf) this._flushText();
    this.thinkingBuf += delta;
    this._resetIdleTimer();
    if (this.thinkingBuf.length >= this.thinkingFlushThreshold) this._flushThinking();
  }

  _resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // idle 时优先 flush 文本（更值得用户关注），再 thinking
      this._flushText();
      this._flushThinking();
    }, this.idleMs);
  }

  _flushText() {
    if (!this.textBuf) return;
    const text = this.textBuf;
    this.textBuf = '';
    this._enqueueMessage(text);
  }

  _flushThinking() {
    if (!this.thinkingBuf) return;
    const text = `💭 ${this.thinkingBuf}`;
    this.thinkingBuf = '';
    this._enqueueMessage(text);
  }

  /**
   * 工具/状态事件：先 flush 当前累积的文本/思考，再追加事件消息，
   * 避免事件提示插在错位的位置。
   */
  _enqueueEventMessage(text) {
    this._flushText();
    this._flushThinking();
    this._enqueueMessage(text);
  }

  /**
   * 串行化发送：所有 enqueue 通过单一 Promise 链，并在每次发送后等待
   * interSendDelayMs 缓解限流。超长消息按 MAX_CHUNK 字符切片。
   */
  _enqueueMessage(text) {
    if (!text) return;
    const chunks = chunkForWeChat(text);
    for (const chunk of chunks) {
      this.sendQueue = this.sendQueue
        .then(() => this.send(chunk))
        .catch((err) => this.log('发送失败:', err?.message || err))
        .then(() => sleep(this.interSendDelayMs));
    }
  }

  /**
   * 在 pi 完成（agent_end 后）或正常结束时调用：flush 剩余、等队列排空。
   */
  async finalize() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this._flushText();
    this._flushThinking();
    await this.sendQueue;
  }

  /**
   * 中止：flush 剩余 + 追加 [已中止] 标记，然后等待队列排空。
   */
  async abort() {
    if (this.aborted) return;
    this.aborted = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this._flushText();
    this._flushThinking();
    this._enqueueMessage('⛔ [已中止]');
    await this.sendQueue;
  }

  /**
   * 等待发送队列排空（测试辅助）
   */
  async drain() {
    await this.sendQueue;
  }
}

// ---------- helpers ----------

const MAX_CHUNK = 2000;

function chunkForWeChat(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, MAX_CHUNK));
    remaining = remaining.slice(MAX_CHUNK);
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * tool_start 格式化：根据已知工具名挑出最有信息量的参数摘要
 */
function formatToolStart(event) {
  const name = event.toolName || 'tool';
  const args = event.args || {};
  const summary = summarizeToolArgs(name, args);
  const emoji = name === 'bash'
    ? '🔨'
    : (['read', 'edit', 'write', 'grep', 'find', 'ls'].includes(name) ? '🔧' : '🛠');
  return summary ? `${emoji} ${name}: ${summary}` : `${emoji} ${name}`;
}

function formatToolError(event) {
  return `❌ ${event.toolName || 'tool'} 失败`;
}

function formatAutoRetryStart(event) {
  const delaySec = event.delayMs ? Math.round(event.delayMs / 1000) : 0;
  return `🔄 重试 ${event.attempt}/${event.maxAttempts}` + (delaySec ? ` (${delaySec}s 后)` : '') + '...';
}

function formatAutoRetryFail(event) {
  return `❌ 重试失败 (第 ${event.attempt} 次)` + (event.finalError ? `: ${truncate(event.finalError, 150)}` : '');
}

/**
 * 工具参数摘要 — 对常见工具特化展示，其它走 JSON.stringify 截断兜底
 */
function summarizeToolArgs(name, args) {
  try {
    switch (name) {
      case 'read':
      case 'edit':
      case 'write':
        return truncate(args.path || args.file_path || '', 120);
      case 'bash':
        return truncate(args.command || '', 200);
      case 'grep':
        return truncate([args.pattern, args.path].filter(Boolean).join(' @ '), 160);
      case 'find':
        return truncate(args.pattern || args.path || '', 160);
      case 'ls':
        return truncate(args.path || '.', 120);
      default:
        return truncate(JSON.stringify(args), 160);
    }
  } catch {
    return '';
  }
}
