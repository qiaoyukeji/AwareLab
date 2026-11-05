/**
 * 登录票据：账密通过后、短信验证码通过前，用它把「这个人是谁、这次要干什么」带到下一步。
 * 不落库（无状态），内容只有 uid/purpose/phone/exp，用本机随机密钥做 HMAC-SHA256 防篡改。
 * 密钥存 settings 表（首次启动生成），换密钥等于作废所有未完成的验证流程，重启不失效。
 */
import crypto from 'node:crypto';
import { getSetting, setSetting } from '../platform/storage/rows.js';

const SECRET_KEY = 'auth_ticket_secret';
export const TICKET_TTL_MS = 10 * 60 * 1000;

/** 首次启动生成票据密钥；已有则原样返回，重启后未完成的验证流程仍可继续。 */
export function ensureTicketSecret() {
  const existing = String(getSetting(SECRET_KEY, '') || '');
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString('hex');
  setSetting(SECRET_KEY, secret);
  return secret;
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/** 签票据：purpose 为 login（已绑号，只差验证码）或 bind（首次绑定手机号）。 */
export function issueTicket({ userId, purpose, phone = '' }, ttlMs = TICKET_TTL_MS) {
  const secret = ensureTicketSecret();
  const body = b64url(JSON.stringify({ u: userId, p: purpose, ph: phone, exp: Date.now() + ttlMs }));
  return `${body}.${sign(body, secret)}`;
}

/** 验票据：签名不符、结构不对、过期都返回 null，调用方统一回「验证已过期，请重新登录」。 */
export function readTicket(ticket) {
  const secret = ensureTicketSecret();
  const [body, signature] = String(ticket || '').split('.');
  if (!body || !signature) return null;
  const expected = sign(body, secret);
  // 长度不等时 timingSafeEqual 会抛，先比长度再恒时比较
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload?.u || !payload?.p || Number(payload.exp) < Date.now()) return null;
  return payload;
}
