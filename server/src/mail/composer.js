/**
 * 邮件组装：正文+收件人+在听站点拼成 nodemailer 消息；专属令牌 tk 必须同时出现在像素、跳转与站内链接上。
 *
 * 链接落在哪个端口是这里最要紧的一条：邮件里给收件人看的跳转必须指向仿冒站自己的 origin（8080 这类采集端口），
 * 用管理端地址（7778）拼出来的链接既和演练场景不符，也把管理面地址递给了演练对象。
 * 因此像素与跳转都优先取任务绑定的站点；链接重写按每条 href 命中的站点各自取 origin。
 * 产出的可见文案不许出现平台名与内部路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { all, get } from '../platform/storage/rows.js';
import { config } from '../platform/settings.js';
import { ENGAGE_BASE } from '../capture/engageScript.js';

// 邮箱地址里有 + @ 这类字符，进 query 前必须编码
const enc = encodeURIComponent;

/**
 * 收件人可见的兜底前缀：优先 config.panel.public_url（反代/对外域名），其次 x-forwarded-proto + Host。
 * 只在该邮件没有可绑定站点时才会被用到；正常演练应走站点 origin。
 */
export function publicBase(req) {
  const configured = String(config.panel.public_url || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

/** 站点对访客的地址前缀；端口无条件带上，attachTraceLinks 靠它与 href 逐字比前缀，省略默认端口就匹配不上 */
function originOf(site) {
  const proto = site.tls_key && site.tls_cert ? 'https' : 'http';
  const host = site.domain || (site.listen_ip === '0.0.0.0' ? '127.0.0.1' : site.listen_ip);
  return `${proto}://${host}:${site.listen_port}`;
}

/** 在听的站点；邮件任务绑定优先，其次全平台只有一个在听站点时直接用它，多于一个且没绑定就交给调用方兜底 */
function openSites() {
  return all("SELECT * FROM web_sites WHERE status='open'");
}

/** 这封邮件应该落在哪个站点 origin；返回 null 表示没有可用的仿冒站，调用方回退到管理端地址 */
export function taskSiteOrigin(task) {
  if (task?.site_id) {
    const bound = get("SELECT * FROM web_sites WHERE id=? AND status='open'", [task.site_id]);
    if (bound) return originOf(bound);
  }
  const sites = openSites();
  return sites.length === 1 ? originOf(sites[0]) : null;
}

/** 像素与 {{site_url}} 的基址：任务站点 → 唯一在听站点 → 管理端（仅兜底） */
export function mailBase(task, req) {
  return taskSiteOrigin(task) || publicBase(req);
}

/** 正文里是否用了站点占位符；发送前用它拦住"没绑站点还要发站点链接"的任务，避免把 7778 发出去 */
export function needsSite(task) {
  return /\{\{\s*site_url\s*\}\}/i.test(String(task?.body_html ?? ''));
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

/** href 是否落在 origin 下；必须看 origin 后一个字符，否则 http://a:8080 会误吃 http://a:80800 */
function underOrigin(href, origin) {
  if (!href.startsWith(origin)) return false;
  const next = href.charAt(origin.length);
  return next === '' || next === '/' || next === '?' || next === '#';
}

/**
 * 把指向在听站点的 href 改挂到"该站点自己"的信标路径，其余原样保留。
 * 每条链接按命中的站点取 origin，所以一封邮件里出现多个站点也各走各的端口；
 * 站点收网后 origins 为空，链接自然退回原地址（死链比丢一次点击计数严重）。
 */
export function attachTraceLinks(html, { token, to }) {
  const origins = openSites().map(originOf);
  if (!origins.length) return html;
  return html.replace(/href="(http[^"]+)"/gi, (full, href) => {
    const origin = origins.find((item) => underOrigin(href, item));
    if (!origin) return full;
    return `href="${traceUrl(origin, { token, to, url: appendToken(href, token) })}"`;
  });
}

/** 个性化占位符替换，标题与正文共用；只认 name 与 email 两个变量是刻意的窄口径 */
export function renderVars(text, recipient) {
  // 主题在库里可为 NULL，String(text ?? '') 避免 .replace 抛错；姓名缺省替成空串，标题露出 undefined 等于暴露群发工具
  return String(text ?? '')
    .replace(/\{\{name\}\}/g, recipient.name || '')
    .replace(/\{\{email\}\}/g, recipient.email);
}

/**
 * 正文渲染：先把 {{site_url}} 换成站点 origin，再改链接，最后替占位符。
 * 顺序不能反：attachTraceLinks 靠 href 的 http 前缀逐字比，占位符先替换才能被改写成带 tk 的跳转。
 */
export function renderMailBody(task, recipient, { base }) {
  const token = recipient.token;
  const siteBase = taskSiteOrigin(task) || base;
  const prepared = String(task.body_html ?? '').replace(/\{\{\s*site_url\s*\}\}/gi, siteBase);
  const html = renderVars(attachTraceLinks(prepared, { token, to: recipient.email }), recipient);
  const pixel = `<img src="${pixelUrl(siteBase, { token, taskId: task.id })}" width="1" height="1" alt="" style="display:none">`;
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
