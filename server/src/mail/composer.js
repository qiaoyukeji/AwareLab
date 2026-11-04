import fs from 'node:fs';
import path from 'node:path';
import { all } from '../platform/storage/rows.js';
import { ENGAGE_BASE } from '../capture/engageScript.js';

const enc = encodeURIComponent;

/** 收件人可见的回调域名：优先反向代理声明的协议，否则用请求自身的信息 */
export function publicBase(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

function originOf(site) {
  const proto = site.tls_key && site.tls_cert ? 'https' : 'http';
  const host = site.domain || (site.listen_ip === '0.0.0.0' ? '127.0.0.1' : site.listen_ip);
  return `${proto}://${host}:${site.listen_port}`;
}

/** 像素地址：邮件客户端加载即计入打开 */
export function pixelUrl(base, { token, taskId }) {
  return `${base}${ENGAGE_BASE}/pixel?tk=${enc(token)}&task=${enc(taskId ?? '')}`;
}

/** 跳转地址：先记账再放行到演练站点，令牌在改写 href 时已拼进内层 url */
export function traceUrl(base, { token, to, url }) {
  const params = new URLSearchParams({ tk: token, url });
  if (to) params.set('to', to);
  return `${base}${ENGAGE_BASE}/trace?${params.toString()}`;
}

export function appendToken(url, token) {
  const separator = url.includes('?') ? '&' : '?';
  if (/[?&]tk=/.test(url)) return url;
  return `${url}${separator}tk=${enc(token)}`;
}

/**
 * 把指向在听站点的链接改挂到信标面。
 * 只改白名单内、且当前处于 open 状态的站点，其余链接原样保留：
 * 演练邮件里出现死链比少一个点击计数更致命。
 */
export function attachTraceLinks(html, { token, to, base }) {
  const origins = all("SELECT * FROM web_sites WHERE status='open'").map(originOf);
  if (!origins.length) return html;
  return html.replace(/href="(http[^"]+)"/gi, (full, href) => {
    if (!origins.some((origin) => href.startsWith(origin))) return full;
    return `href="${traceUrl(base, { token, to, url: appendToken(href, token) })}"`;
  });
}

/**
 * 个性化占位符替换：标题与正文用同一套变量，
 * 只替一处会让邮件标题里露出字面的 {{name}}，一眼就是群发工具发出来的。
 */
export function renderVars(text, recipient) {
  return String(text ?? '')
    .replace(/\{\{name\}\}/g, recipient.name || '')
    .replace(/\{\{email\}\}/g, recipient.email);
}

/** 正文渲染：个性化占位符、链接归属、末尾像素 */
export function renderMailBody(task, recipient, { base }) {
  const token = recipient.token;
  const html = renderVars(attachTraceLinks(task.body_html, { token, to: recipient.email, base }), recipient);
  const pixel = `<img src="${pixelUrl(base, { token, taskId: task.id })}" width="1" height="1" alt="" style="display:none">`;
  return html.includes('</body>') ? html.replace(/<\/body>/i, () => pixel + '</body>') : html + pixel;
}

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
