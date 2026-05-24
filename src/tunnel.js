/**
 * cloudflared quick tunnel 管理模块
 * 自动启动 tunnel、捕获 URL、检测重启
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class TunnelManager {
  /**
   * @param {object} options
   * @param {number} [options.bridgePort=3100] - bridge 监听端口
   * @param {string} [options.logDir] - 日志目录
   * @param {function} [options.onUrlChange] - URL 变化回调 (newUrl) => void
   */
  constructor(options = {}) {
    this.bridgePort = options.bridgePort || 3100;
    this.logDir = options.logDir || '/tmp';
    this.onUrlChange = options.onUrlChange || null;

    this.proc = null;
    this.url = null;
    this.urlFile = `${this.logDir}/tunnel-url.txt`;
    this.restartTimer = null;
    this._stopped = false;
  }

  /**
   * 启动 cloudflared quick tunnel
   * @returns {Promise<string>} tunnel URL
   */
  async start() {
    this._stopped = false;

    if (this.proc && !this.proc.killed) {
      return this.url;
    }

    // 尝试读取上次保存的 URL（仅用于日志）
    let prevUrl = null;
    try {
      prevUrl = (await readFile(this.urlFile, 'utf8')).trim();
    } catch { /* ignore */ }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('cloudflared 30 秒内未返回 tunnel URL'));
      }, 30000);

      console.log('[tunnel] 启动 cloudflared quick tunnel → localhost:' + this.bridgePort);

      this.proc = spawn('cloudflared', [
        'tunnel', '--url', `http://localhost:${this.bridgePort}`,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const decoder = new StringDecoder('utf8');
      let stderrBuf = '';
      let resolved = false;

      this.proc.stdout.on('data', (chunk) => {
        // cloudflared 输出 URL 到 stderr，但以防万一也监听 stdout
        this._parseChunk(chunk, decoder, (url) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(url);
          }
        });
      });

      this.proc.stderr.on('data', (chunk) => {
        // cloudflared 输出 tunnel URL 到 stderr
        this._parseChunk(chunk, decoder, (url) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(url);
          }
        });

        // 也记录日志
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        stderrBuf += text;
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() || '';
        for (const line of lines) {
          if (line.trim() && !line.includes('INF Registered tunnel connection')) {
            // 只记录有意义的日志，忽略频繁的连接注册信息
          }
        }
      });

      this.proc.on('exit', (code, signal) => {
        this.proc = null;
        console.log(`[tunnel] cloudflared 退出 (code=${code}, signal=${signal})`);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`cloudflared 异常退出: code=${code}, signal=${signal}`));
        }
        // 自动重启（除非是主动 stop）
        if (!this._stopped) {
          console.log('[tunnel] 5 秒后自动重启...');
          this.restartTimer = setTimeout(async () => {
            try {
              const newUrl = await this.start();
              console.log('✅ [tunnel] 已自动重启, URL:', newUrl);
            } catch (err) {
              console.error('❌ [tunnel] 自动重启失败:', err.message);
            }
          }, 5000);
        }
      });
    }).then(async (url) => {
      this.url = url;
      // 保存 URL 到文件
      await mkdir(dirname(this.urlFile), { recursive: true });
      await writeFile(this.urlFile, url);
      console.log('✅ [tunnel] URL:', url);

      if (this.onUrlChange) {
        this.onUrlChange(url);
      }

      return url;
    });
  }

  /**
   * 解析 chunk 中的 tunnel URL
   */
  _parseChunk(chunk, decoder, onUrl) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      onUrl(match[0]);
    }
  }

  /**
   * 停止 tunnel
   */
  stop() {
    this._stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc && !this.proc.killed) {
      console.log('[tunnel] 停止 cloudflared...');
      this.proc.kill();
      this.proc = null;
    }
    this.url = null;
  }

  /**
   * 获取当前 tunnel URL
   * @returns {string|null}
   */
  getUrl() {
    return this.url;
  }

  /**
   * 获取回调 URL
   * @returns {string|null}
   */
  getCallbackUrl() {
    return this.url ? `${this.url}/wxwork/callback` : null;
  }
}
