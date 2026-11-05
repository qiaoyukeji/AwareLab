/** 邮件投递层：唯一对外连 SMTP、唯一写 data/outbox/*.eml 的地方；pass 明文只在本层交给 nodemailer，不进返回值、不进 .eml、不进日志 */
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from '../platform/settings.js';
import { get } from '../platform/storage/rows.js';

/** 按 smtp_profiles 行构造 transport，不建连接，握手在首次 sendMail/verify；无缓存每次新建，改配置立即生效 */
function connector(profile) {
  return nodemailer.createTransport({
    host: profile.host,
    port: profile.port,
    // 库里是 0/1，不显式转布尔会被 nodemailer 按端口猜测的默认覆盖操作者的选择
    secure: Boolean(profile.secure),
    auth: { user: profile.user, pass: profile.pass },
    // 内网自签证书邮件网关需要；对外部公网 SMTP 有中间人风险，是已知取舍
    tls: { rejectUnauthorized: false },
  });
}

/** 连通性测试：verify() 只登录，不投递不写库；失败一律抛，测试失败却显示成功比报错更糟；返回字段白名单不含口令 */
export async function testProfile(profileId) {
  const profile = get('SELECT * FROM smtp_profiles WHERE id=?', [profileId]);
  if (!profile) throw new Error('SMTP 配置不存在');
  await connector(profile).verify();
  return { ok: true, host: profile.host, port: profile.port, user: profile.user };
}

/** 真发一封：邮件真实进对方收件箱，上游必须已留 mail_task.real_send 审计；不重试不吞异常，抛给 runner 的逐收件人 try/catch */
export async function sendViaSmtp(profile, message) {
  return connector(profile).sendMail(message);
}

const sandbox = nodemailer.createTransport({ streamTransport: true, buffer: true });

/** 沙箱投递：完整 MIME 以 .eml 写到 data/outbox，零网络、不改正文只加 X-Sandbox 头；返回路径未入库，事后按 任务id前8位-邮箱 找回；磁盘错误直接抛不兜底 */
export async function writeSandboxMail({ task, recipient, message }) {
  const dir = path.join(config.paths.outbox);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${task.id.slice(0, 8)}-${String(recipient.email).replace(/[^\w.@-]/g, '_')}.eml`);
  const info = await sandbox.sendMail({ ...message, headers: { ...message.headers, 'X-Sandbox': 'true' } });
  fs.writeFileSync(file, info.message);
  return file;
}
