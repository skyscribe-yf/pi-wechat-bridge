/**
 * 本地测试脚本 — 验证 pi-wechat-bridge 核心功能
 *
 * 用法: node test-local.js
 */
import { PiRpcClient } from './src/pi-rpc-client.js';
import { StreamBuffer } from './src/stream-buffer.js';

const TIMEOUT = 120_000;
const PI_CWD = process.env.PI_CWD || process.cwd();

// ===== 测试 Per-User Session =====
async function testPerUserSession() {
  console.log('\n📋 测试 1: Per-User 会话持久化');
  console.log('─'.repeat(40));

  // 用户 A 的会话
  const clientA = new PiRpcClient({
    piBin: process.env.PI_BIN_PATH || 'pi',
    cwd: PI_CWD,
    noSession: false,  // 开启会话持久化
  });
  await clientA.start();
  console.log('  ✅ 用户 A 的 pi 进程已启动');

  // 第一轮：让 pi 记住一个数字
  const reply1 = await clientA.prompt('记住数字 42，只回复"记住了"', { timeout: TIMEOUT });
  console.log(`  📝 第一轮回复: ${reply1?.substring(0, 50)}`);

  // 第二轮：验证 pi 记住了
  const reply2 = await clientA.prompt('我刚才让你记住什么数字？只回复数字', { timeout: TIMEOUT });
  const has42 = reply2?.includes('42');
  console.log(`  📝 第二轮回复: ${reply2?.substring(0, 50)}`);
  console.log(`  ${has42 ? '✅' : '❌'} 会话上下文${has42 ? '' : '不'}保持`);

  clientA.stop();
  return has42;
}

// ===== 测试 Multi-Part 输入 =====
async function testMultiPartInput() {
  console.log('\n📋 测试 2: 多段输入合并');
  console.log('─'.repeat(40));

  const parts = ['把 hello world', '改成大写', '只输出结果'];
  const fullMessage = parts.join('\n');

  const client = new PiRpcClient({
    piBin: process.env.PI_BIN_PATH || 'pi',
    cwd: PI_CWD,
    noSession: true,
  });
  await client.start();

  const reply = await client.prompt(fullMessage, { timeout: TIMEOUT });
  const hasHello = reply?.toUpperCase().includes('HELLO');
  console.log(`  📝 合并后 prompt: "${fullMessage}"`);
  console.log(`  📝 回复: ${reply?.substring(0, 80)}`);
  console.log(`  ${hasHello ? '✅' : '❌'} 多段输入合并${hasHello ? '' : '不'}成功`);

  client.stop();
  return hasHello;
}

// ===== 测试 StreamBuffer =====
async function testStreamBuffer() {
  console.log('\n📋 测试 3: StreamBuffer 批量化');
  console.log('─'.repeat(40));

  const messages = [];
  const buffer = new StreamBuffer({
    send: (text) => { messages.push(text); return Promise.resolve(); },
    textFlushThreshold: 20,
    thinkingFlushThreshold: 30,
    idleMs: 500,
    interSendDelayMs: 50,
  });

  // 模拟进度事件（与 PiRpcClient onProgress 格式一致）
  buffer.handle({ type: 'text_delta', delta: 'Hello ' });
  buffer.handle({ type: 'text_delta', delta: 'World! ' });
  buffer.handle({ type: 'text_delta', delta: 'This is a test. ' });
  buffer.handle({ type: 'thinking_delta', delta: 'hmm... ' });
  buffer.handle({ type: 'thinking_delta', delta: 'thinking... ' });
  buffer.handle({ type: 'tool_start', toolName: 'bash', args: { command: 'ls' } });
  buffer.handle({ type: 'tool_end', toolName: 'bash', isError: false });

  await buffer.finalize();
  console.log(`  📝 发送了 ${messages.length} 条消息:`);
  messages.forEach((m, i) => console.log(`    [${i + 1}] ${m.substring(0, 60)}${m.length > 60 ? '...' : ''}`));
  console.log(`  ${messages.length >= 2 ? '✅' : '❌'} StreamBuffer 批量化${messages.length >= 2 ? '' : '不'}正常`);

  return messages.length >= 2;
}

// ===== 测试 Markdown 检测 =====
async function testMarkdownDetection() {
  console.log('\n📋 测试 4: Markdown 特征检测');
  console.log('─'.repeat(40));

  const cases = [
    { text: 'Hello world', expected: false },
    { text: '**bold** text', expected: true },
    { text: '```js\ncode\n```', expected: true },
    { text: '`inline code`', expected: true },
    { text: '> quote', expected: true },
    { text: '- list item', expected: true },
    { text: '# heading', expected: true },
  ];

  const regex = /`{1,3}[\s\S]*?`{1,3}|\*\*|^[>\-*#]/m;
  let passed = 0;
  for (const { text, expected } of cases) {
    const result = regex.test(text);
    const ok = result === expected;
    if (ok) passed++;
    console.log(`  ${ok ? '✅' : '❌'} "${text.substring(0, 30)}" → ${result} (期望 ${expected})`);
  }
  console.log(`  ${passed === cases.length ? '✅' : '❌'} ${passed}/${cases.length} 通过`);
  return passed === cases.length;
}

// ===== 运行 =====
async function main() {
  console.log('🧪 pi-wechat-bridge 本地测试');
  console.log('='.repeat(40));

  const results = {};

  // 轻量测试（不需要 pi）
  results.streamBuffer = await testStreamBuffer();
  results.markdown = await testMarkdownDetection();

  // 需要 pi 的测试
  if (process.env.SKIP_PI_TESTS !== 'true') {
    try {
      results.perUserSession = await testPerUserSession();
    } catch (err) {
      console.error('  ❌ Per-User 会话测试失败:', err.message);
      results.perUserSession = false;
    }
    try {
      results.multiPartInput = await testMultiPartInput();
    } catch (err) {
      console.error('  ❌ 多段输入测试失败:', err.message);
      results.multiPartInput = false;
    }
  } else {
    console.log('\n⏭️  跳过 pi 相关测试 (SKIP_PI_TESTS=true)');
  }

  console.log('\n' + '='.repeat(40));
  console.log('📊 测试结果:');
  for (const [name, passed] of Object.entries(results)) {
    console.log(`  ${passed ? '✅' : '❌'} ${name}`);
  }

  const total = Object.keys(results).length;
  const passed = Object.values(results).filter(Boolean).length;
  console.log(`\n${passed}/${total} 通过`);

  process.exit(passed === total ? 0 : 1);
}

main().catch(err => {
  console.error('💥 测试出错:', err);
  process.exit(1);
});