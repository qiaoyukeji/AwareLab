/**
 * 采集面：仿冒站点的请求处理器，访客看到的每一屏和所有表单提交都从这里走。
 * 由 siteRegistry 交给各站点自己的端口，不在管理端口上，访客碰不到管理面与鉴权中间件。
 * 协议 v2 冻结：<form> / [data-al-collect] 声明采集点，配置块 <script type="application/alab+json" id="alab-boot">，
 * Cookie alab_tk，事件 open/submit，上报字段 ev、tk、dwell、href、search、referer、fields。
 * 拒绝屏只能说访问不了或页面不存在，出现演练、授权、采集字样就等于当场承认这是仿冒页。
 */
import { Buffer } from 'node:buffer';
import { get, run, nowIso } from '../platform/storage/rows.js';
import { clientIp } from '../platform/net/clientIp.js';
import { gate, resolve } from '../security/mandate.js';
import { renderCapturePage, renderLessonFallbackPage, renderNoticePage } from './pageCompiler.js';
import { recordFormSubmit, recordPageOpen, resolveToken } from './evidenceStore.js';
import { ENGAGE_BASE, ENGAGE_ENDPOINT, LESSON_ENDPOINT, bootAfter } from './engageScript.js';
import { servePixel, serveTrace } from './trackEndpoints.js';

// 采集面直接对演练对象开放，没这道闸一个请求就能把内存打满；超这个量必然是在灌数据或塞文件
const MAX_BODY = 512 * 1024;
// 访客终端 Cookie 名（协议冻结项），与 URL 上的 ?tk= 双入口；HttpOnly + SameSite=Lax + 一天，
// 令牌不被页面脚本读走，也不长期留在公共终端上
const VISITOR_COOKIE = 'alab_tk';

/** 整段读进内存，超过 MAX_BODY 就 reject 并 destroy 连接，不等读完再判。异常只给 'body too large'，不带内部信息。 */
const readBody = (req) =>
  new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
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

/**
 * 回一屏 HTML。Cache-Control: no-store 是必须的：仿冒页常出现在公共终端上，
 * 缓存或被代理复用会让下一个人看到上一位的页面，拒绝屏也不能被缓存成"这个地址一直是这个提示"。
 */
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/** 给运行时回 JSON 回执。运行时会 .json() 解它，回一张 HTML 错误页会让浏览器侧留下未捕获异常。 */
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/** 超 512KB、半截 JSON、非 JSON 都吞掉给空对象：最多少记一条数据，不给演练对象看错误页，也不打断监听。 */
async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)).toString('utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * 终端归属令牌：?tk= 优先（带收件人身份），其次 Cookie，都没有就签一个匿名令牌入表，
 * 没有邮件投递的站内测试也能算出打开数。
 * 链接令牌要覆写回 Cookie：?tk= 只在那一次请求上，刷新或站内跳转丢了查询串会把同一个人算成两个终端。
 * Cookie 里的值只认 36 位 UUID 且必须在 capture_tokens 查得到才算身份，否则访客能自带 tk 冒充别人的收件人。
 */
function visitorToken(req, res, siteId, fromQuery) {
  const fromQueryToken = fromQuery && resolveToken(fromQuery) ? fromQuery : null;
  const cached = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${VISITOR_COOKIE}=([0-9a-fA-F-]{36})`));
  const cachedToken = cached && resolveToken(cached[1]) ? cached[1] : null;

  const token = fromQueryToken || cachedToken;
  if (!token) {
    const anonymous = crypto.randomUUID();
    // 匿名终端也入表：records 需要一个能挂住的令牌主键
    run(
      'INSERT INTO capture_tokens (token,site_id,task_id,target_email,target_name,created_at) VALUES (?,?,?,?,?,?)',
      [anonymous, siteId, null, null, null, nowIso()]
    );
    res.setHeader('Set-Cookie', `${VISITOR_COOKIE}=${anonymous}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`);
    return anonymous;
  }
  // 只在身份变化时重写 Cookie：每屏都发会把 Max-Age 续成会话常驻
  if (token !== cachedToken) res.setHeader('Set-Cookie', `${VISITOR_COOKIE}=${token}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`);
  return token;
}

/**
 * siteId 建监听时固化进闭包，一个端口一个 handler。门禁不过既不渲染模板也不写记录，越界请求不留痕。
 * 状态码：404=站点没开、模板被删或 Host 不在白名单；403=授权缺失、待生效或已吊销；410=已过有效期；
 * 405=非 GET/HEAD 且非上报路径；204=favicon。拒绝原因只在管理面和审计里给操作员。
 */
export function buildSiteHandler(siteId) {
  return async function handler(req, res) {
    // 假基址只为拿 pathname 和查询串，Host 是否被授权由门禁单独判
    const url = new URL(req.url, 'http://localhost');
    const ip = clientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const site = get('SELECT * FROM web_sites WHERE id=?', [siteId]);
    // 这一屏给演练对象看：说"站点未开启"等于当场告诉他这是仿冒页
    if (!site || site.status !== 'open') {
      return send(res, 404, renderNoticePage('页面不存在', '页面不存在或已下线，请确认访问地址是否正确。'));
    }
    const template = get('SELECT * FROM web_templates WHERE id=?', [site.template_id]);
    // 模板被删也是同一句"页面不存在"
    if (!template) {
      return send(res, 404, renderNoticePage('页面不存在', '页面不存在或已下线，请稍后重试。'));
    }

    // resolve 只在生效窗口内返回行，其它给 null 由 gate 换算 403/410；白名单外的 Host 不留任何记录
    const verdict = gate(resolve(site.authorization_id), { host: req.headers.host });
    if (!verdict.ok) return send(res, verdict.code, renderNoticePage('页面无法访问', verdict.reason));

    // 邮件像素与跳转也要在站点端口上应答：邮件正文里的链接由 composer 改写成站点自己的 origin，
    // 收件人点开时落在 8080 这类采集端口，而不是管理端 7778。两条都在门禁之后，授权失效时连像素也一起停
    if (req.method === 'GET' && url.pathname === `${ENGAGE_BASE}/pixel`) {
      return servePixel(req, res, url);
    }
    if (req.method === 'GET' && url.pathname === `${ENGAGE_BASE}/trace`) {
      return serveTrace(req, res, url);
    }

    if (req.method === 'POST' && url.pathname === ENGAGE_ENDPOINT) {
      const data = await readJson(req);
      // tk 有两个来源（sendBeacon 那条只能拼 URL），任一边认得到就算同一个终端；格式是冻结的，不要求必须带哪个
      const token = data.tk || url.searchParams.get('tk') || null;
      const href = typeof data.href === 'string' ? data.href : url.searchParams.get('href') || '';
      if (data.ev === 'submit') {
        // 数组或标量说明载荷不是这套表单发的；宁可记"提交了但没采到字段"，也不拿索引当字段名入库
        const fields = data.fields && typeof data.fields === 'object' && !Array.isArray(data.fields) ? data.fields : {};
        recordFormSubmit({
          siteId,
          token,
          ip,
          userAgent,
          fields,
          // 不可解析时由 evidenceStore 退回"首次见到此刻"的差值；这里预兜 0 会盖掉真实停留时长
          dwell: Number(data.dwell),
          referer: data.referer,
          // 只带 search 时作为补充：端口和令牌查询串不该成为取证记录里的页面标识
          href: href || data.search || '',
        });
        return sendJson(res, 200, { code: 0, data: { accepted: true, ev: 'submit' } });
      }
      recordPageOpen({ siteId, token, ip, userAgent, referer: data.referer, href });
      // open 的回执与 submit 同形状，不能给 HTML
      return sendJson(res, 200, { code: 0, data: { accepted: true, ev: 'open' } });
    }

    if (req.method === 'GET' && url.pathname === LESSON_ENDPOINT) {
      // 运行时的 after=lesson 跳到这里；模板没挂学习页或学习页被删时给兜底页
      const learn = template.learn_page_id ? get('SELECT * FROM learn_pages WHERE id=?', [template.learn_page_id]) : null;
      const html = learn?.html || renderLessonFallbackPage();
      return send(res, 200, html);
    }

    // 浏览器会自动请求 favicon：走正常渲染会为一个小图标多签一枚令牌、多记一条 page_open，把打开数灌水
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    // 除上报外只认 GET/HEAD：仿冒页不是通用 Web 服务，多一种方法就多一处可被试探的行为
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed');
    }

    // 先定身份再把采集运行时注入模板；POST 上报不签身份也不发 Cookie
    const token = visitorToken(req, res, siteId, url.searchParams.get('tk'));
    const html = renderCapturePage(template.html, {
      site: siteId,
      token,
      // 库值 learn 在这唯一一处翻译成协议值 lesson；response_content 会原样出现在访客屏上，中性由素材侧把关
      after: bootAfter(template.response_type),
      content: template.response_content || '',
      // 同源打到本站这个路径：访客在哪个端口打开就报回哪个端口
      endpoint: ENGAGE_ENDPOINT,
    });
    return send(res, 200, html);
  };
}
