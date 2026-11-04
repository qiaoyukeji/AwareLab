import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from '../platform/settings.js';
import { get } from '../platform/storage/rows.js';

function connector(profile) {
  return nodemailer.createTransport({
    host: profile.host,
    port: profile.port,
    secure: Boolean(profile.secure),
    auth: { user: profile.user, pass: profile.pass },
    // 演练内网常用自签证书的内部邮件网关，证书校验在此关闭
    tls: { rejectUnauthorized: false },
  });
}

export async function testProfile(profileId) {
  const profile = get('SELECT * FROM smtp_profiles WHERE id=?', [profileId]);
  if (!profile) throw new Error('SMTP 配置不存在');
  await connector(profile).verify();
  return { ok: true, host: profile.host, port: profile.port, user: profile.user };
}

export async function sendViaSmtp(profile, message) {
  return connector(profile).sendMail(message);
}

/**
 * 沙箱投递：用 nodemailer 的 streamTransport 生成完整 MIME 落到 outbox，
 * 全程不建立任何网络连接。产出的 .eml 可以直接被邮件客户端打开，
 * 演练前的自查（渲染、像素、链接归属、附件）在离线状态下就能走完。
 */
const sandbox = nodemailer.createTransport({ streamTransport: true, buffer: true });

export async function writeSandboxMail({ task, recipient, message }) {
  const dir = path.join(config.paths.outbox);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${task.id.slice(0, 8)}-${String(recipient.email).replace(/[^\w.@-]/g, '_')}.eml`);
  const info = await sandbox.sendMail({ ...message, headers: { ...message.headers, 'X-Sandbox': 'true' } });
  fs.writeFileSync(file, info.message);
  return file;
}
