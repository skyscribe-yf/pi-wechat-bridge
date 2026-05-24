/**
 * 企业微信消息加解密工具
 * 基于 AES-256-CBC 算法，遵循企业微信官方加解密规范
 * 参考: https://developer.work.weixin.qq.com/document/path/90930
 */
import crypto from 'node:crypto';

const BLOCK_SIZE = 32;

/**
 * PKCS#7 填充
 */
function pkcs7Pad(buf) {
  const pad = BLOCK_SIZE - (buf.length % BLOCK_SIZE);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

/**
 * PKCS#7 去填充
 */
function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > BLOCK_SIZE) return buf;
  // 验证所有填充字节
  for (let i = buf.length - pad; i < buf.length; i++) {
    if (buf[i] !== pad) return buf;
  }
  return buf.subarray(0, buf.length - pad);
}

/**
 * 对消息明文进行加密
 * @param {string} appId - 企业微信 CorpID
 * @param {string} encodingAesKey - Base64 编码的 AES Key
 * @param {string} plainText - 待加密明文
 * @param {string} [nonce] - 随机串
 * @returns {{Encrypt: string, Nonce: string, TimeStamp: string}}
 */
export function encrypt(appId, encodingAesKey, plainText, nonce) {
  if (!nonce) nonce = crypto.randomBytes(6).toString('hex');
  const timeStamp = String(Math.floor(Date.now() / 1000));

  // AES Key: Base64 解码后就是 32 字节密钥
  const aesKey = Buffer.from(encodingAesKey + '=', 'base64');

  // 初始 IV 为 AES Key 的前 16 字节
  const iv = aesKey.subarray(0, 16);

  // 明文结构: 16字节随机串 + 4字节网络序消息长度 + 消息明文 + appId
  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(plainText, 'utf8');
  const appIdBuf = Buffer.from(appId, 'utf8');
  const msgLen = Buffer.alloc(4);
  msgLen.writeUInt32BE(msgBuf.length, 0);

  const raw = Buffer.concat([random, msgLen, msgBuf, appIdBuf]);
  const padded = pkcs7Pad(raw);

  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

  return {
    Encrypt: encrypted.toString('base64'),
    Nonce: nonce,
    TimeStamp: timeStamp,
  };
}

/**
 * 对消息密文进行解密
 * @param {string} appId - 期望的 CorpID
 * @param {string} encodingAesKey - Base64 编码的 AES Key
 * @param {string} encryptedText - 待解密密文 (Base64)
 * @returns {string} 解密后的消息明文
 * @throws {Error} 如果 appId 不匹配
 */
export function decrypt(appId, encodingAesKey, encryptedText) {
  const aesKey = Buffer.from(encodingAesKey + '=', 'base64');
  const iv = aesKey.subarray(0, 16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final(),
  ]);
  const unpadded = pkcs7Unpad(decrypted);

  // 去掉前 16 字节随机串
  const content = unpadded.subarray(16);
  // 4 字节消息长度
  const msgLen = content.readUInt32BE(0);
  if (msgLen > content.length - 4 || msgLen < 0) {
    throw new Error('Invalid message length');
  }
  // 提取消息明文
  const msg = content.subarray(4, 4 + msgLen).toString('utf8');
  // 提取 appId
  const fromAppId = content.subarray(4 + msgLen).toString('utf8');

  if (fromAppId !== appId) {
    throw new Error(`AppID mismatch: expected ${appId}, got ${fromAppId}`);
  }

  return msg;
}

/**
 * 生成签名
 * @param {string} token - 消息 Token
 * @param {string} timestamp - 时间戳
 * @param {string} nonce - 随机串
 * @param {string} encrypt - 加密消息体
 * @returns {string} SHA1 签名
 */
export function generateSignature(token, timestamp, nonce, encrypt) {
  const parts = [token, timestamp, nonce, encrypt].sort();
  const sha1 = crypto.createHash('sha1');
  sha1.update(parts.join(''));
  return sha1.digest('hex');
}

/**
 * 验证签名
 */
export function verifySignature(token, timestamp, nonce, encrypt, signature) {
  return generateSignature(token, timestamp, nonce, encrypt) === signature;
}