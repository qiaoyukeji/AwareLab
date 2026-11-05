/** 邮件组装：正文+收件人+在听站点拼成 nodemailer 消息；专属令牌 tk 必须同时出现在像素、跳转与站内链接上；产出的可见文案不许出现平台名与内部路径 */
import fs from 'node:fs';
import path from 'node:path';
import { all } from '../platform/storage/rows.js';
import { ENGAGE_BASE } from '../capture/engageScript.js';

// 邮箱地址里有 + @ 这类字符，进 query 前必须编码
const enc = encodeURIComponent;

/** 收件人可见的回调前缀；优先 x-forwarded-proto，反代终结 TLS 时 req.secure 是 false，照它拼演练对象会拿到明文链接 */
export function publicBase(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

/** 站点对访客的地址前缀；端口无条件带上，attachTraceLinks 靠它与 href 逐字比前缀，省略默认端口就匹配不上 */
function originOf(site) {
  const proto = site.tls_key && site.tls_cert ? 'https' : 'http';
  const host = site.domain || (site.listen_ip === '0.0.0.0' ? '127.0.0.1' : site.listen_ip);
  return `${proto}://${host}:${site.listen_port}`;
}

/** 像素地址：邮件客户端加载图片即计入打开；taskId 缺省编码成空串，协议冻结字段不能省参数名 */
export function pixelUrl(base, { token, taskId }) {
  return `${base}${ENGAGE_BASE}/pixel?tk=${enc(token)}&task=${enc(taskId ?? '')}`;
}

/** 跳转地址：信标面先记 clicked_at 再放行，这个顺序是点击统计对得上号的前提；手动投放的链接没有邮箱，to 留空按令牌归属 */
export function traceUrl(base, { token, to, url }) {
  const params = new URLSearchParams({ tk: token, url });
  if (to) params.set('to', to);
  return `${base}${ENGAGE_BASE}/trace?${params.toString()}`;
}

/** 给链接补 ?tk= 参数；已带 tk 的原样返回，重复令牌会让信标面取第一个值认错人 */
export function appendToken(url, token) {
  const separator = url.includes('?') ? '&' : '?';
  if (/[?&]tk=/.test(url)) return url;
  return `${url}${separator}tk=${enc(token)}`;
}

/** 把指向在听（status='open'）站点的 href 改挂信标面，其余原样保留：死链比丢一次点击计数严重；站点收网后 origins 为空，链接自然退回原地址 */
export function attachTraceLinks(html, { token, to, base }) {
  const origins = all("SELECT * FROM web_sites WHERE status='open'").map(originOf);
  if (!origins.length) return html;
  return html.replace(/href="(http[^"]+)"/gi, (full, href) => {
    if (!origins.some((origin) => href.startsWith(origin))) return full;
    return `href="${traceUrl(base, { token, to, url: appendToken(href, token) })}"`;
  });
}

/** 个性化占位符替换，标题与正文共用；只认 name 与 email 两个变量是刻意的窄口径 */
export function renderVars(text, recipient) {
  // 主题在库里可为 NULL，String(text ?? '') 避免 .replace 抛错；姓名缺省替成空串，标题露出 undefined 等于暴露群发工具
  return String(text ?? '')
    .replace(/\{\{name\}\}/g, recipient.name || '')
    .replace(/\{\{email\}\}/g, recipient.email);
}

/** 正文渲染：先改链接再替占位符，反过来 {{email}} 编码后会对不上 href 字面前缀 */
export function renderMailBody(task, recipient, { base }) {
  const token = recipient.token;
  const html = renderVars(attachTraceLinks(task.body_html, { token, to: recipient.email, base }), recipient);
  const pixel = `<img src="${pixelUrl(base, { token, taskId: task.id })}" width="1" height="1" alt="" style="display:none">`;
  // 片段正文可能没有 </body>，没有就直接尾追否则像素漏掉；替换用回调形式，防 pixel 里的 $ 序列被当特殊替换符
  return html.includes('</body>') ? html.replace(/<\/body>/i, () => pixel + '</body>') : html + pixel;
}

/** 组装 nodemailer 消息，不写库不碰网络；沙箱用假 from 防 .eml 被误读成已寄出；附件只在文件真在盘上时才挂，缺文件硬挂会中断整批 */
export function buildMessage({ task, recipient, html, profile }) {
  const message = {
    from: profile ? `"${profile.from_name || ''}" <${profile.from_addr}>` : '"AwareLab 沙箱" <sandbox@localhost>',
    to: recipient.email,
    subject: renderVars(task.subject, recipient),
    html,
  };
  if (task.attachment_path && fs.existsSync(task.attachment_path)) {
    message.attachments = [
      { filename: task.attachment_name || path.basename(task.attachment_path), path: task.attachment_path },
    ];
  }
  return message;
}
