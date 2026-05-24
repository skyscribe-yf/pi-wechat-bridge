/**
 * pi Agent RPC 客户端
 * 通过 pi 的 RPC 模式 (stdin/stdout JSONL) 与 pi 交互
 *
 * pi RPC 事件类型:
 *   - extension_ui_request: 初始连接时请求 UI 配置
 *   - response: 命令响应 (id 匹配)
 *   - agent_start: agent 开始处理
 *   - message_update (assistantMessageEvent.type=text_delta): 增量文本
 *   - agent_end: agent 完成响应，包含最终文本
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export class PiRpcClient {
  constructor(options = {}) {
    this.piBin = options.piBin || 'pi';
    this.cwd = options.cwd || process.cwd();
    this.provider = options.provider;
    this.model = options.model;
    this.thinking = options.thinking;
    this.tools = options.tools;
    this.noSession = options.noSession !== false; // 默认 true
    this.noExtensions = options.noExtensions || false;
    this.noSkills = options.noSkills || false;
    this.noContextFiles = options.noContextFiles || false;
    this.proc = null;
    this.pendingRequests = new Map(); // id -> { resolve, reject, text, timer }
    this.eventHandlers = new Map(); // eventType -> handler[]
    this.nextId = 1;
    this.ready = false;
  }

  /**
   * 启动 pi RPC 进程
   */
  async start() {
    return new Promise((resolve, reject) => {
      const args = ['--mode', 'rpc'];
      if (this.noSession) args.push('--no-session');
      if (this.noExtensions) args.push('--no-extensions');
      if (this.noSkills) args.push('--no-skills');
      if (this.noContextFiles) args.push('--no-context-files');
      if (this.provider) args.push('--provider', this.provider);
      if (this.model) args.push('--model', this.model);
      if (this.thinking) args.push('--thinking', this.thinking);
      if (this.tools) args.push('--tools', this.tools);

      console.log(`[pi-rpc] 启动: ${this.piBin} ${args.join(' ')}`);
      console.log(`[pi-rpc] 工作目录: ${this.cwd}`);

      this.proc = spawn(this.piBin, args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      this.proc.stdin.on('error', (err) => {
        console.error('[pi-rpc] stdin 错误:', err.message);
      });

      // 读取 stdout 的 JSONL 事件流
      this._attachJsonlReader(this.proc.stdout, (line) => {
        try {
          const msg = JSON.parse(line);
          this._handleMessage(msg);
        } catch (e) {
          console.warn('[pi-rpc] 解析 JSON 失败:', line.slice(0, 100));
        }
      });

      // 读取 stderr 日志
      let stderrBuf = '';
      this.proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop();
        for (const l of lines) {
          if (l.trim()) console.log(`[pi-rpc stderr] ${l}`);
        }
      });
      this.proc.stderr.on('error', (err) => {
        console.error('[pi-rpc] stderr 错误:', err.message);
      });

      this.proc.on('error', (err) => {
        console.error('[pi-rpc] 进程启动失败:', err);
        reject(err);
      });

      this.proc.on('exit', (code, signal) => {
        console.log(`[pi-rpc] 进程退出: code=${code}, signal=${signal}`);
        this.proc = null;
        this.ready = false;
        // 拒绝所有等待中的请求
        for (const [, pending] of this.pendingRequests) {
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(new Error('pi 进程已退出'));
        }
        this.pendingRequests.clear();
        // 通知外部监听器
        this._emit('exit', { code, signal });
      });

      // 等待 pi 就绪（收到第一个 extension_ui_request 或 2 秒超时）
      const readyTimeout = setTimeout(() => {
        if (!this.ready && this.proc?.pid) {
          console.log('[pi-rpc] 超时等待就绪信号，假设已就绪');
          this.ready = true;
          resolve();
        }
      }, 3000);

      this.onceReady = () => {
        clearTimeout(readyTimeout);
        if (!this.ready) {
          this.ready = true;
          console.log('[pi-rpc] pi RPC 进程已就绪 (PID:', this.proc?.pid, ')');
          resolve();
        }
      };
    });
  }

  /**
   * 处理来自 pi 的消息
   */
  _handleMessage(msg) {
    // 初始就绪信号: extension_ui_request
    if (msg.type === 'extension_ui_request') {
      // 回复空的 UI 配置
      this._sendCommand({
        id: msg.id,
        type: 'extension_ui_response',
        ui: {},
      });
      if (this.onceReady) this.onceReady();
      return;
    }

    // 命令响应
    if (msg.type === 'response' && msg.id) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending && pending.text === undefined) {
        // 非 prompt 的响应（如 get_state）
        this.pendingRequests.delete(msg.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.success !== false) {
          pending.resolve(msg.data || msg);
        } else {
          pending.reject(new Error(msg.error || '未知错误'));
        }
      }
      return;
    }

    // agent 开始
    if (msg.type === 'agent_start') {
      console.log('[pi-rpc] agent 开始处理...');
      return;
    }

    // 增量文本
    if (msg.type === 'message_update') {
      const evt = msg.assistantMessageEvent;
      if (evt?.type === 'text_delta' && evt.delta) {
        for (const [, pending] of this.pendingRequests) {
          if (pending.text !== undefined) {
            pending.text += evt.delta;
          }
        }
      }
      return;
    }

    // agent 完成
    if (msg.type === 'agent_end') {
      const text = msg.assistantMessage?.text || '';
      console.log('[pi-rpc] agent 完成响应, 文本长度:', text.length);

      for (const [id, pending] of this.pendingRequests) {
        if (pending.text !== undefined) {
          this.pendingRequests.delete(id);
          if (pending.timer) clearTimeout(pending.timer);
          // 优先使用累积的增量文本，fallback 到 agent_end 中的文本
          const result = pending.text || text || '(无回复)';
          pending.resolve(result);
        }
      }
      return;
    }

    // 未知事件 - 通知注册的处理器
    const handlers = this.eventHandlers.get(msg.type);
    if (handlers) {
      for (const h of handlers) {
        try { h(msg); } catch (e) { console.error('[pi-rpc] 事件处理器错误:', e); }
      }
    }
  }

  /**
   * 发送命令到 pi
   */
  _sendCommand(cmd) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('pi RPC 进程未运行');
    }
    const json = JSON.stringify(cmd) + '\n';
    this.proc.stdin.write(json);
  }

  /**
   * 发送 prompt 并等待 agent 完成响应
   * @param {string} message - 用户消息
   * @param {number} [timeout=300000] - 超时时间（毫秒），默认 5 分钟
   * @returns {Promise<string>} 助手回复文本
   */
  async prompt(message, timeout = 300000) {
    if (!this.proc) throw new Error('pi RPC 未启动');

    const id = `req-${this.nextId++}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`pi 响应超时 (${timeout / 1000}s)`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timer, text: '' });

      try {
        this._sendCommand({ id, type: 'prompt', message });
        console.log(`[pi-rpc] 已发送 prompt: ${message.slice(0, 80)}...`);
      } catch (err) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * 中止当前操作
   */
  abort() {
    if (!this.proc || !this.proc.stdin.writable) {
      console.warn('[pi-rpc] abort 被忽略：进程未运行');
      return;
    }
    this._sendCommand({ type: 'abort' });
  }

  /**
   * 获取当前状态
   */
  async getState() {
    const id = `req-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('获取状态超时'));
      }, 10000);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this._sendCommand({ id, type: 'get_state' });
    });
  }

  /**
   * 切换模型
   * @param {string} provider - provider 名称，如 "xunfei", "opencode-go"
   * @param {string} modelId - 模型 ID，如 "astron-code-latest", "deepseek-v4-pro"
   * @returns {Promise<object>} 模型信息
   */
  async setModel(provider, modelId) {
    const id = `req-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('切换模型超时'));
      }, 15000);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this._sendCommand({ id, type: 'set_model', provider, modelId });
      console.log(`[pi-rpc] 切换模型: ${provider}/${modelId}`);
    });
  }

  /**
   * 获取可用模型列表
   * @returns {Promise<Array>}
   */
  async getAvailableModels() {
    const id = `req-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('获取模型列表超时'));
      }, 15000);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this._sendCommand({ id, type: 'get_available_models' });
    });
  }

  /**
   * 设置思考等级
   * @param {string} level - off, minimal, low, medium, high, xhigh
   */
  async setThinkingLevel(level) {
    const id = `req-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('设置思考等级超时'));
      }, 10000);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this._sendCommand({ id, type: 'set_thinking_level', level });
    });
  }

  /**
   * 注册事件处理器
   */
  on(eventType, handler) {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    this.eventHandlers.get(eventType).push(handler);
  }

  /**
   * 触发事件
   */
  _emit(eventType, data) {
    const handlers = this.eventHandlers.get(eventType);
    if (handlers) {
      for (const h of handlers) h(data);
    }
  }

  /**
   * JSONL 读取器
   */
  _attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    stream.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      while (true) {
        const nlIdx = buffer.indexOf('\n');
        if (nlIdx === -1) break;
        let line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.trim()) onLine(line);
      }
    });

    stream.on('end', () => {
      buffer += decoder.end();
      if (buffer.trim()) onLine(buffer);
    });

    stream.on('error', (err) => {
      console.error('[pi-rpc] stdout stream 错误:', err.message);
    });
  }

  /**
   * 停止 pi 进程
   */
  stop() {
    if (this.proc) {
      console.log('[pi-rpc] 正在停止 pi 进程...');
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.ready = false;
    for (const [, pending] of this.pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('pi 进程已停止'));
    }
    this.pendingRequests.clear();
  }
}
