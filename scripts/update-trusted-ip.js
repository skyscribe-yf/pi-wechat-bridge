#!/usr/bin/env node
/**
 * 自动更新企业微信可信 IP 白名单
 * 
 * 家庭宽带的公网 IP 会变化，本脚本自动获取当前公网 IP 并更新到企业微信白名单。
 * 可以配合 cron 定期运行（比如每 30 分钟检查一次）。
 * 
 * 用法:
 *   node scripts/update-trusted-ip.js
 * 
 * 定时执行 (crontab):
 *   0,30 * * * * cd /home/skyscribe/srcs/pi-wechat-bridge && node scripts/update-trusted-ip.js >> /tmp/ip-update.log 2>&1
 */

import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '..', '.env');

// 读取 .env 配置
function loadEnv() {
  const content = fs.readFileSync(envPath, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return env;
}

async function main() {
  const env = loadEnv();
  const corpId = env.WXWORK_CORP_ID;
  const secret = env.WXWORK_SECRET;
  const agentId = env.WXWORK_AGENT_ID;

  if (!corpId || !secret || !agentId) {
    console.error('❌ 无法读取 .env 中的 WXWORK_CORP_ID / WXWORK_SECRET / WXWORK_AGENT_ID');
    process.exit(1);
  }

  // 1. 获取当前公网 IP
  console.log('📡 获取当前公网 IP...');
  let publicIp;
  const ipServices = [
    'https://api.ipify.org',
    'https://ip.sb',
    'https://ifconfig.me',
    'https://icanhazip.com',
    'https://checkip.amazonaws.com',
  ];

  for (const service of ipServices) {
    try {
      const resp = await axios.get(service, { timeout: 8000 });
      publicIp = resp.data.trim();
      if (publicIp) {
        console.log(`   ✅ 当前公网 IP: ${publicIp} (${service})`);
        break;
      }
    } catch {}
  }

  if (!publicIp) {
    console.error('❌ 无法获取公网 IP');
    process.exit(1);
  }

  // 2. 获取 access_token
  console.log('🔑 获取 access_token...');
  const tokenResp = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
    params: { corpid: corpId, corpsecret: secret },
    timeout: 15000,
  });

  if (tokenResp.data.errcode !== 0) {
    console.error('❌ 获取 access_token 失败:', tokenResp.data.errmsg);
    process.exit(1);
  }

  const token = tokenResp.data.access_token;
  console.log('   ✅ access_token 已获取');

  // 3. 获取当前白名单 IP 列表
  console.log('📋 获取当前 IP 白名单...');
  const getResp = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/get_allow_ips', {
    params: { access_token: token },
    timeout: 15000,
  });

  if (getResp.data.errcode !== 0) {
    console.error('❌ 获取 IP 白名单失败:', getResp.data.errmsg);
    // 可能没有权限，继续尝试更新
  }

  // 4. 更新白名单
  // 企业微信需要通过修改应用设置来更新IP白名单
  // 使用 update_agent API
  console.log('🔄 更新 IP 白名单...');

  // 先获取当前应用设置
  const agentResp = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/agent/get', {
    params: { access_token: token, agentid: Number(agentId) },
    timeout: 15000,
  });

  if (agentResp.data.errcode !== 0) {
    console.error('❌ 获取应用信息失败:', agentResp.data.errmsg);
    process.exit(1);
  }

  const currentAllowIps = agentResp.data.allow_userip || '';
  const ips = currentAllowIps
    .split(';')
    .map(ip => ip.trim())
    .filter(Boolean);

  // 如果 IP 已在白名单中，不重复添加
  if (ips.includes(publicIp)) {
    console.log(`   ✅ IP ${publicIp} 已经在白名单中，无需更新`);
    return;
  }

  // 添加新 IP，保留旧的
  ips.push(publicIp);
  const newAllowIps = ips.join(';');

  const updateResp = await axios.post(
    `https://qyapi.weixin.qq.com/cgi-bin/agent/set?access_token=${token}`,
    {
      agentid: Number(agentId),
      allow_userip: newAllowIps,
    },
    { timeout: 15000 }
  );

  if (updateResp.data.errcode === 0) {
    console.log(`   ✅ IP 白名单已更新！添加了 ${publicIp}`);
    console.log(`   📋 当前白名单: ${newAllowIps}`);
  } else {
    console.error(`   ❌ 更新失败: ${updateResp.data.errmsg} (errcode: ${updateResp.data.errcode})`);
    
    // 如果 API 方式不行，提示手动操作
    console.log('');
    console.log('⚠️  请手动在企业微信管理后台添加 IP 白名单：');
    console.log(`   应用管理 → 你的应用 → 企业可信IP → 添加 ${publicIp}`);
  }
}

main().catch(err => {
  console.error('💥 脚本出错:', err.message);
  process.exit(1);
});
