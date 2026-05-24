#!/usr/bin/env node
/**
 * 检测当前公网 IP 并比对白名单
 *
 * 如果 IP 变了，会输出提示信息，方便添加到企业微信可信 IP。
 * 建议配合 cron 每 30 分钟运行一次。
 *
 * 用法:
 *   node scripts/check-public-ip.js
 *
 * 定时执行 (crontab):
 *   */30 * * * * cd /home/skyscribe/srcs/pi-wechat-bridge && node scripts/check-public-ip.js
 */

import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SAVED_IP_FILE = path.join(os.tmpdir(), 'pi-bridge-last-ip.txt');

async function getPublicIp() {
  const services = [
    'https://api.ipify.org',
    'https://ip.sb',
    'https://ifconfig.me',
  ];

  for (const service of services) {
    try {
      const resp = await axios.get(service, { timeout: 8000 });
      const ip = resp.data.trim();
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    } catch {}
  }
  return null;
}

async function main() {
  const ip = await getPublicIp();
  if (!ip) {
    console.log('[check-ip] ❌ 无法获取公网 IP');
    return;
  }

  // 读取上次保存的 IP
  let lastIp = '';
  try { lastIp = fs.readFileSync(SAVED_IP_FILE, 'utf-8').trim(); } catch {}

  if (ip === lastIp) {
    // IP 没变，静默退出（cron 模式下不输出日志）
    return;
  }

  // IP 变了！
  fs.writeFileSync(SAVED_IP_FILE, ip);

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   🌐 公网 IP 已变更                      ║');
  console.log(`║   旧 IP: ${(lastIp || '无').padEnd(26)}║`);
  console.log(`║   新 IP: ${ip.padEnd(26)}║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  请在企业微信管理后台更新可信IP：          ║');
  console.log('║                                          ║');
  console.log('║   应用管理 → 你的应用 → 企业可信IP        ║');
  console.log(`║   添加: ${ip.padEnd(31)}║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
}

main();
