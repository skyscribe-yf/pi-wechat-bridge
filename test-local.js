/**
 * 本地测试脚本 - 不需要企业微信配置，直接测试 pi RPC 交互
 *
 * 验证：
 *   A. 旧签名 prompt(message, timeoutNumber) 仍工作（向后兼容）
 *   B. 新签名 prompt(message, { timeout, onProgress }) 投递进度事件
 *   C. StreamBuffer 能消费进度事件并经 send 注入打印
 */
import dotenv from 'dotenv';
import { PiRpcClient } from './src/pi-rpc-client.js';
import { StreamBuffer } from './src/stream-buffer.js';

dotenv.config();

async function main() {
  console.log('🧪 pi-wechat-bridge 本地测试');
  console.log('================================\n');

  const client = new PiRpcClient({
    cwd: process.env.PI_CWD || process.cwd(),
    provider: process.env.PI_PROVIDER,
    model: process.env.PI_MODEL,
    thinking: process.env.PI_THINKING || 'low',
    tools: process.env.PI_TOOLS || 'read,bash,edit,write,grep,find,ls',
    noSession: true,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
  });

  process.on('SIGINT', () => { client.stop(); process.exit(0); });

  try {
    console.log('1. 启动 pi RPC...');
    await client.start();
    console.log('   ✅ 已启动\n');

    // ---- 测试 A: 旧签名（向后兼容） ----
    console.log('2. [backcompat] 旧签名 prompt(msg, 60000)...');
    const reply = await client.prompt('请用一句话介绍你自己', 60000);
    console.log('   ✅ 收到回复:', reply.slice(0, 200));
    console.log('   ─────────────────────────\n');

    // ---- 测试 B: onProgress 收事件 ----
    console.log('3. [onProgress] 收集所有事件类型...');
    const events = [];
    const r2 = await client.prompt(
      '列出当前目录下的文件（用 ls 命令），然后用一句话总结',
      {
        timeout: 90000,
        onProgress: (e) => {
          events.push(e.type);
          if (e.type === 'text_delta') {
            process.stdout.write(e.delta);
          } else if (e.type === 'thinking_delta') {
            // 思考增量只统计字符避免刷屏
            process.stdout.write(`[think+${e.delta.length}]`);
          } else {
            console.log(`\n   [event] ${e.type}`, JSON.stringify(e).slice(0, 200));
          }
        },
      },
    );
    console.log('\n   ─────────────────────────');
    console.log('   ✅ 最终文本长度:', r2.length);
    console.log('   ✅ 收到事件类型:', [...new Set(events)].join(', '), '\n');

    // ---- 测试 C: StreamBuffer 端到端 ----
    console.log('4. [StreamBuffer] 通过 buffer 发送...');
    const sent = [];
    const buffer = new StreamBuffer({
      send: async (text) => {
        sent.push(text);
        console.log('   --- SEND ---\n   ' + text.replace(/\n/g, '\n   ') + '\n   ------------');
      },
      textFlushThreshold: 200,    // 小阈值便于看到 flush
      thinkingFlushThreshold: 300,
      idleMs: 1500,
      interSendDelayMs: 100,
    });
    await client.prompt('简单介绍一下当前目录里有哪些文件', {
      timeout: 60000,
      onProgress: (e) => buffer.handle(e),
    });
    await buffer.finalize();
    console.log('   ✅ buffer 共发送', sent.length, '条消息\n');

    console.log('🎉 测试完成！');
  } catch (err) {
    console.error('❌ 测试失败:', err.message);
    process.exitCode = 1;
  } finally {
    client.stop();
  }
}

main();
