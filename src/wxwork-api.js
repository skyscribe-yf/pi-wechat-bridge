/**
 * 企业微信 API 客户端
 * 负责获取 access_token 和发送消息
 */
import axios from 'axios';

const BASE_URL = 'https://qyapi.weixin.qq.com/cgi-bin';

let accessTokenCache = {
  token: null,
  expiresAt: 0,
};

/**
 * 强制清空 access_token 缓存（用于 token 过期时主动刷新）
 */
export function clearAccessTokenCache() {
  accessTokenCache = { token: null, expiresAt: 0 };
}

/**
 * 获取企业微信 access_token
 * 有效期 7200 秒，提前 300 秒刷新
 */
export async function getAccessToken(corpId, secret) {
  const now = Date.now();
  if (accessTokenCache.token && accessTokenCache.expiresAt > now) {
    return accessTokenCache.token;
  }

  const url = `${BASE_URL}/gettoken`;
  const resp = await axios.get(url, {
    params: { corpid: corpId, corpsecret: secret },
    timeout: 15000,
  });

  if (resp.data.errcode !== 0) {
    throw new Error(`获取 access_token 失败: ${resp.data.errmsg} (errcode: ${resp.data.errcode})`);
  }

  accessTokenCache = {
    token: resp.data.access_token,
    // 提前 5 分钟过期
    expiresAt: now + (resp.data.expires_in - 300) * 1000,
  };

  console.log('[wxwork] access_token 已获取，有效期至',
    new Date(accessTokenCache.expiresAt).toLocaleTimeString());
  return accessTokenCache.token;
}

/**
 * 发送文本消息
 * @param {object} config - { corpId, secret, agentId }
 * @param {string} userId - 接收人的企业微信 UserID
 * @param {string} content - 消息内容
 */
export async function sendTextMessage(config, userId, content) {
  const token = await getAccessToken(config.corpId, config.secret);

  const url = `${BASE_URL}/message/send`;
  const resp = await axios.post(url, {
    touser: userId,
    msgtype: 'text',
    agentid: Number(config.agentId),
    text: { content },
  }, {
    params: { access_token: token },
    timeout: 15000,
  });

  // 自动处理 token 过期（42001=已过期 40014=不合法）
  if (resp.data.errcode === 42001 || resp.data.errcode === 40014) {
    console.warn('[wxwork] access_token 过期，自动刷新并重试...');
    clearAccessTokenCache();
    const newToken = await getAccessToken(config.corpId, config.secret);
    const retryResp = await axios.post(url, {
      touser: userId,
      msgtype: 'text',
      agentid: Number(config.agentId),
      text: { content },
    }, {
      params: { access_token: newToken },
      timeout: 15000,
    });
    if (retryResp.data.errcode !== 0) {
      console.error('[wxwork] 重试发送消息失败:', retryResp.data);
      throw new Error(`发送消息失败: ${retryResp.data.errmsg}`);
    }
    console.log(`[wxwork] 消息已发送给 ${userId} (重试)`);
    return retryResp.data;
  }

  if (resp.data.errcode !== 0) {
    console.error('[wxwork] 发送消息失败:', resp.data);
    throw new Error(`发送消息失败: ${resp.data.errmsg}`);
  }

  console.log(`[wxwork] 消息已发送给 ${userId}`);
  return resp.data;
}

/**
 * 发送 Markdown 消息（企业微信支持简单的 markdown）
 */
export async function sendMarkdownMessage(config, userId, content) {
  const token = await getAccessToken(config.corpId, config.secret);

  const url = `${BASE_URL}/message/send`;
  const resp = await axios.post(url, {
    touser: userId,
    msgtype: 'markdown',
    agentid: Number(config.agentId),
    markdown: { content },
  }, {
    params: { access_token: token },
    timeout: 15000,
  });

  // 自动处理 token 过期（42001=已过期 40014=不合法）
  if (resp.data.errcode === 42001 || resp.data.errcode === 40014) {
    console.warn('[wxwork] access_token 过期，自动刷新并重试...');
    clearAccessTokenCache();
    const newToken = await getAccessToken(config.corpId, config.secret);
    const retryResp = await axios.post(url, {
      touser: userId,
      msgtype: 'markdown',
      agentid: Number(config.agentId),
      markdown: { content },
    }, {
      params: { access_token: newToken },
      timeout: 15000,
    });
    if (retryResp.data.errcode !== 0) {
      console.error('[wxwork] 重试发送 Markdown 消息失败:', retryResp.data);
      throw new Error(`发送消息失败: ${retryResp.data.errmsg}`);
    }
    console.log(`[wxwork] Markdown 消息已发送给 ${userId} (重试)`);
    return retryResp.data;
  }

  if (resp.data.errcode !== 0) {
    console.error('[wxwork] 发送 Markdown 消息失败:', resp.data);
    throw new Error(`发送消息失败: ${resp.data.errmsg}`);
  }

  console.log(`[wxwork] Markdown 消息已发送给 ${userId}`);
  return resp.data;
}
