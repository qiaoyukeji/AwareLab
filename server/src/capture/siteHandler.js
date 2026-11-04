import { Buffer } from 'node:buffer';
import { get, run, nowIso } from '../platform/storage/rows.js';
import { clientIp } from '../platform/net/clientIp.js';
import { gate, resolve } from '../security/mandate.js';
import { renderCapturePage, renderNoticePage } from './pageCompiler.js';
import { recordFormSubmit, recordPageOpen, resolveToken } from './evidenceStore.js';
import { ENGAGE_ENDPOINT, LESSON_ENDPOINT, bootAfter } from './engageScript.js';

const MAX_BODY = 512 * 1024;
const VISITOR_COOKIE = 'alab_tk';

const readBody = (req) =>
  new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      // 采集面直接暴露给演练对象，必须给单次上报设上限，否则一个请求就能打满内存
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)).toString('utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * 终端归属令牌：链接带 ?tk= 时沿用（邮件溯源），否则发一个匿名令牌给这个浏览器。
 * 匿名令牌同样入表，没有邮件投递的站内测试也能算出「打开数」。
 */
function visitorToken(req, res, siteId, fromQuery) {
  if (fromQuery && resolveToken(fromQuery)) return fromQuery;

  const cached = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${VISITOR_COOKIE}=([0-9a-fA-F-]{36})`));
  if (cached && resolveToken(cached[1])) return cached[1];

  const token = crypto.randomUUID();
  run(
    'INSERT INTO capture_tokens (token,site_id,task_id,target_email,target_name,created_at) VALUES (?,?,?,?,?,?)',
    [token, siteId, null, null, null, nowIso()]
  );
  res.setHeader('Set-Cookie', `${VISITOR_COOKIE}=${token}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`);
  return token;
}

/**
 * 采集面请求处理：门禁 → 渲染 / 上报。
 * 门禁不过直接返回提示页，既不渲染模板也不写任何记录，越界请求在库里不留痕。
 */
export function buildSiteHandler(siteId) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const ip = clientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const site = get('SELECT * FROM web_sites WHERE id=?', [siteId]);
    if (!site || site.status !== 'open') {
      return send(res, 404, renderNoticePage('页面不存在', '该演练站点未处于开启状态。'));
    }
    const template = get('SELECT * FROM web_templates WHERE id=?', [site.template_id]);
    if (!template) {
      return send(res, 404, renderNoticePage('页面不存在', '演练模板已被删除。'));
    }

    const verdict = gate(resolve(site.authorization_id), { host: req.headers.host });
    if (!verdict.ok) return send(res, verdict.code, renderNoticePage('演练不可用', verdict.reason));

    if (req.method === 'POST' && url.pathname === ENGAGE_ENDPOINT) {
      const data = await readJson(req);
      const token = data.tk || url.searchParams.get('tk') || null;
      const href = typeof data.href === 'string' ? data.href : url.searchParams.get('href') || '';
      if (data.ev === 'submit') {
        const fields = data.fields && typeof data.fields === 'object' && !Array.isArray(data.fields) ? data.fields : {};
        recordFormSubmit({
          siteId,
          token,
          ip,
          userAgent,
          fields,
          dwell: Number(data.dwell),
          referer: data.referer,
          href: href || data.search || '',
        });
        return sendJson(res, 200, { code: 0, data: { accepted: true, ev: 'submit' } });
      }
      recordPageOpen({ siteId, token, ip, userAgent, referer: data.referer, href });
      return sendJson(res, 200, { code: 0, data: { accepted: true, ev: 'open' } });
    }

    if (req.method === 'GET' && url.pathname === LESSON_ENDPOINT) {
      const learn = template.learn_page_id ? get('SELECT * FROM learn_pages WHERE id=?', [template.learn_page_id]) : null;
      const html = learn?.html || renderNoticePage('安全意识提示', '您刚才提交的敏感信息已被演练平台记录，请学习防钓鱼要点后再继续操作。');
      return send(res, 200, html);
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed');
    }

    const token = visitorToken(req, res, siteId, url.searchParams.get('tk'));
    const html = renderCapturePage(template.html, {
      site: siteId,
      token,
      after: bootAfter(template.response_type),
      content: template.response_content || '',
      endpoint: ENGAGE_ENDPOINT,
    });
    return send(res, 200, html);
  };
}
