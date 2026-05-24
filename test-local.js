/**
 * 本地测试脚本 - 不需要企业微信配置，直接测试 pi RPC 交互
 */
import dotenv from 'dotenv';
import { PiRpcClient } from './src/pi-rpc-client.js';

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

  // 优雅退出
  process.on('SIGINT', () => {
    client.stop();
    process.exit(0);
  });

  try {
    console.log('1. 启动 pi RPC...');
    await client.start();
    console.log('   ✅ 已启动\n');

    // 测试 1: 简单对话
    console.log('2. 发送测试 prompt...');
    const reply = await client.prompt('请用一句话介绍你自己', 60000);
    console.log('   ✅ 收到回复:');
    console.log('   ─────────────────────────');
    console.log(`   ${reply.slice(0, 500)}`);
    console.log('   ─────────────────────────\n');

    // 测试 2: 代码操作
    console.log('3. 测试代码操作...');
    const reply2 = await client.prompt('列出当前目录下的文件（用 ls 命令），告诉我有哪些文件', 60000);
    console.log('   ✅ 收到回复:');
    console.log('   ─────────────────────────');
    console.log(`   ${reply2.slice(0, 500)}`);
    console.log('   ─────────────────────────\n');

    console.log('🎉 测试完成！pi RPC 桥接正常工作。');
  } catch (err) {
    console.error('❌ 测试失败:', err.message);
  } finally {
    client.stop();
  }
}

main();
