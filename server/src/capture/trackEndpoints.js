/**
 * 邮件打开像素与链接跳转的共用实现，管理端信标面（7778）和每个仿冒站（8000-9999）都挂同一份。
 * 之所以要在站点侧也挂：邮件里可见的跳转链接必须写成收件人实际能打开的仿冒站地址，
 * 只挂在管理端口上会让邮件正文里露出 7778，既和演练站点不一致，也会把管理面地址递给演练对象。
 * 这两条路由只用公开参数（tk / url），不读会话；响应是图片或跳转，不回任何业务数据。
 * 参数用 WHATWG URL 而不是 req.query：采集面是原生 http，没有 Express 的 query 解析。
 */
import { Buffer } from 'node:buffer';
import { clientIp } from '../platform/net/clientIp.js';
import { findActive, isHostAuthorized } from '../security/mandate.js';
import { recordMailClick, recordMailOpen, resolveToken } from './evidenceStore.js';
import { renderNoticePage } from './pageCompiler.js';
import { rateAllowed } from './rateGate.js';

// 透明 1x1：打开像素不论令牌真假都回这张图，状态码与体积不泄漏 tk 是否有效
export const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// 跳转目标长度上限：URL 参数由邮件客户端拼出，超长串既没有合法站点会长成那样，也不该让一次请求吃满 CPU
const MAX_TARGET_LENGTH = 4096;

// 本平台签发的令牌是 crypto.randomUUID()；形状不对的直接当匿名，不让任意字符串占一条记录
// 令牌形状：拒绝任意长串与非常规字符，真实令牌是 36 位 UUID
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{6,64}$/;

// 像素与跳转各自限速：一条邮件最多被几十个人点开，同一来源地址每分钟几百次已经是异常回放
const PIXEL_PER_IP_MINUTE = 300;
const PIXEL_PER_TOKEN_MINUTE = 60;
const TRACE_PER_IP_MINUTE = 120;
const TRACE_PER_TOKEN_MINUTE = 60;

/** 收件人令牌 → 任务归属；令牌不认识就给 null，像素照常回图，点击照常不计数 */
function visitorOf(token) {
  if (!token || !TOKEN_SHAPE.test(token)) return null;
  try {
    return resolveToken(token) || null;
  } catch {
    return null;
  }
}

/**
 * 邮件打开像素：令牌是平台签发且未超速才记一次 mail_open，其余情况只回图。
 * Cache-Control 必须 no-store：缓存过的像素在重开邮件时不再回源，打开数会少算。
 */
export function servePixel(req, res, url) {
  const token = url.searchParams.get('tk');
  const ip = clientIp(req);
  // probe=1 是管理端「真发前自检」走的：只验证这一条通不通，不写命中记录
  const probe = url.searchParams.get('probe') === '1';
  if (
    !probe &&
    token &&
    rateAllowed(`p:i:${ip}`, PIXEL_PER_IP_MINUTE) &&
    rateAllowed(`p:t:${token}`, PIXEL_PER_TOKEN_MINUTE)
  ) {
    // 归属只认服务端签发的令牌：query 里的 task 谁都能写，拿它建记录等于给外人一个造数据的口子
    const visitor = visitorOf(token);
    if (visitor) {
      recordMailOpen({ taskId: visitor.task_id ?? null, token, ip, userAgent: req.headers['user-agent'] || '' });
    }
  }
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': GIF_1X1.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(GIF_1X1);
}

/**
 * 邮件链接点击：先记账再放行。有 tk 时记 mail_open（点开链接本身就算打开）与 mail_click。
 * 目标必须是当下生效授权白名单内的主机，否则这条路由就成了公共跳板；不合法只回中性提示屏。
 * 只认 http/https，javascript:/data: 进不了判断，信标通道不能变成送脚本的入口。
 */
export function serveTrace(req, res, url) {
  const token = url.searchParams.get('tk');
  const target = url.searchParams.get('url');
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  // 同上：自检点击只验证跳转通不通，不记打开也不记点击，免得演练数据被自己人污染
  const probe = url.searchParams.get('probe') === '1';

  if (!probe && token && rateAllowed(`tr:i:${ip}`, TRACE_PER_IP_MINUTE) && rateAllowed(`tr:t:${token}`, TRACE_PER_TOKEN_MINUTE)) {
    const visitor = visitorOf(token);
    if (visitor) {
      recordMailOpen({ taskId: visitor.task_id ?? null, token, ip, userAgent });
      recordMailClick({ taskId: visitor.task_id ?? null, token, ip, userAgent, url: target });
    }
  }

  if (typeof target === 'string' && target.length <= MAX_TARGET_LENGTH && /^https?:\/\//i.test(target)) {
    const auth = findActive();
    // 每次点击都按此刻的授权重判，不看签发链接时那张：窗口一关，已发出的链接立刻失效
    let host;
    try {
      host = new URL(target).host;
    } catch {
      host = null;
    }
    if (auth && host && isHostAuthorized(auth, host)) {
      res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
      return res.end();
    }
    // 这一屏给点开邮件的人看：出现"演练/授权"字样等于承认这是钓鱼邮件
    return sendNotice(res, '链接已失效', '该链接已失效，或指向的地址不再可用。请向发送方确认后再试。');
  }
  sendNotice(res, '已打开', '链接已在新窗口打开。');
}

/** 中性提示页；与采集面的拒绝屏同一套版式 */
function sendNotice(res, title, message) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(renderNoticePage(title, message));
}
