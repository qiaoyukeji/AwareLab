/**
 * AwareLab 端到端验证：管理面 → 钓鱼网站 → 信标面全链路。
 * 用法：用隔离的数据目录启动服务后执行 node scripts/e2e.mjs
 *   AWARELAB_CONFIG=... AWARELAB_DATA=... node src/boot/main.js
 *
 * 安全红线：脚本只回收自己登记（note 命中）的授权；
 * 一旦发现不是自己登记的有效授权（真实演练进行中），相关断言直接 SKIP，绝不吊销。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import yaml from 'js-yaml';

const SERVER_ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_FILE = process.env.AWARELAB_CONFIG ? path.resolve(process.env.AWARELAB_CONFIG) : path.join(SERVER_ROOT, '.selftest', 'config.yaml');
const DATA_DIR = process.env.AWARELAB_DATA ? path.resolve(process.env.AWARELAB_DATA) : path.join(SERVER_ROOT, '.selftest', 'data');

const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
const PANEL = cfg.panel.path;
const BASE = `http://127.0.0.1:${cfg.panel.port}`;
const API = `${BASE}/${PANEL}/api`;
const CAPTURE_PORT = Number(process.env.E2E_PORT) || 8000 + Math.floor(Math.random() * 1900);
const CAPTURE_BASE = `http://127.0.0.1:${CAPTURE_PORT}`;

/** 本脚本自建授权的标记，清理时只回收自己创建的那几条 */
const OWN_NOTE = 'e2e 自动化验证产生的临时授权';

const lines = [];
let failures = 0;
const ok = (name, cond, extra = '') => {
  lines.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  if (!cond) {
    failures++;
    process.exitCode = 1;
  }
};
const skip = (name, extra = '') => lines.push(`SKIP  ${name}${extra ? '  -> ' + extra : ''}`);

async function api(pathname, opts = {}, token) {
  const res = await fetch(API + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-alab-token': token } : {}), ...opts.headers },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json, text };
}

/** 伪造 Host 头只能用原始 http 客户端，fetch 不允许覆盖 Host */
function hostProbe(hostHeader, pathname = '/', port = CAPTURE_PORT) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { Host: hostHeader } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: err.code }));
    req.end();
  });
}

/** 邮件正文一律是 base64 或 quoted-printable，字符串直搜中文必然落空，先按段解码 */
function decodePart(head, body) {
  if (/Content-Transfer-Encoding:\s*base64/i.test(head)) return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
  const quoted = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(quoted, 'binary').toString('utf8');
}

/** .eml 正文（单段或多段的第一段）解码后的文本 */
function emlBody(raw) {
  return emlPartText(raw, () => true);
}

/** 头部编码字（=?UTF-8?B?…?= / ?Q?…?=）还原；长标题会被折成多个编码字，折行处不留空格 */
function decodeMimeHeader(raw) {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, '').replace(/\?=\s+=\?/g, '?==?');
  return unfolded.replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g, (_m, enc, data) =>
    enc.toUpperCase() === 'B'
      ? Buffer.from(data, 'base64').toString('utf8')
      : Buffer.from(
          data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_h, hex) => String.fromCharCode(parseInt(hex, 16))),
          'binary'
        ).toString('utf8')
  );
}

/** 取 multipart 里符合条件的那一段并解码正文，用来证明正文与附件内容没在沙箱发送里丢掉 */
function emlPartText(raw, matcher) {
  const boundary = (raw.match(/boundary="?([^"\r\n]+)"?/i) || [])[1];
  const parts = boundary ? raw.split(`--${boundary}`).slice(1) : [raw];
  const part = parts.find(matcher);
  if (!part) return '';
  const cut = part.search(/\r?\n\r?\n/);
  if (cut < 0) return '';
  const separator = (part.match(/\r?\n\r?\n/) || [''])[0];
  return decodePart(part.slice(0, cut), part.slice(cut + separator.length));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 回传面只认文件头，测试用例因此必须递真字节：这是一张合法的 1x1 PNG */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64'
);
/** 可执行文件头：演练证据不该包含它 */
const FAKE_BINARY = Buffer.from('MZ\u0090\u00000123456789', 'latin1');

/** 异步链路（推送）只给最终一致，轮询到条件成立或超时 */
async function poll(fn, done, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn();
    if (done(value)) return value;
    await sleep(150);
  }
  return fn();
}

// ---------- 0. 响应头与会话 Cookie 基线 ----------
/** fetch 读不到 Set-Cookie（规范里属于禁止暴露的响应头），登录这条要用原始 http */
function rawRequest({ pathname, method = 'GET', port = cfg.panel.port, body, headers = {} }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: String(err.code) }));
    if (body) req.write(body);
    req.end();
  });
}

const healthProbe = await rawRequest({ pathname: '/alab/health' });
const csp = healthProbe.headers['content-security-policy'] || '';
ok(
  '信标面响应带 CSP 且禁被内嵌',
  csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'") && csp.includes("connect-src 'self'"),
  csp.slice(0, 60)
);
ok('信标面响应带 nosniff 与 no-referrer', healthProbe.headers['x-content-type-options'] === 'nosniff' && healthProbe.headers['referrer-policy'] === 'no-referrer', JSON.stringify([healthProbe.headers['x-content-type-options'], healthProbe.headers['referrer-policy']]));
ok('响应不泄露框架指纹', !healthProbe.headers['x-powered-by'], String(healthProbe.headers['x-powered-by']));

const shellProbe = await rawRequest({ pathname: `/${PANEL}/` });
ok('管理面壳页面同样带安全头', (shellProbe.headers['content-security-policy'] || '').includes("frame-ancestors 'none'"), String(shellProbe.status));

const loginCookieProbe = await rawRequest({
  pathname: `/${PANEL}/api/auth/login`,
  method: 'POST',
  body: JSON.stringify({ username: cfg.panel.username, password: cfg.panel.password }),
  headers: { 'Content-Type': 'application/json' },
});
const setCookie = String((loginCookieProbe.headers['set-cookie'] || [])[0] || '');
ok('会话 Cookie 为 HttpOnly + SameSite=Strict', /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), setCookie.slice(0, 90));
ok('http 部署下不给 Secure 标记（避免 Cookie 直接失效）', !/Secure/.test(setCookie), setCookie.slice(0, 90));

// ---------- 1. 登录与授权 ----------
const login = await api('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username: cfg.panel.username, password: cfg.panel.password }),
});
const token = login.json?.data?.token;
ok('管理员登录', !!token, login.status + ' ' + (token ? `${token.slice(0, 8)}…` : JSON.stringify(login.json).slice(0, 120)));

const anonymous = await api('/authorizations');
ok('未带令牌访问管理接口被拒(401)', anonymous.status === 401, String(anonymous.status));

const me = await api('/auth/me', {}, token);
ok('/auth/me 回显账号', me.json?.data?.username === cfg.panel.username, JSON.stringify(me.json?.data));

// 只回收上一轮 e2e 自建的历史授权，保证断言可重复运行
const listed = await api('/authorizations', {}, token);
for (const auth of listed.json?.data || []) {
  if (auth.status === 'active' && auth.note === OWN_NOTE) await api(`/authorizations/${auth.id}/revoke`, { method: 'POST' }, token);
}

// 无生效授权时禁止建站；若存在别人登记的生效授权，授权 legitimately 放行，此断言无从验证
const activeOthers = (await api('/authorizations', {}, token)).json.data.filter((a) => a.effective === 'active' && a.note !== OWN_NOTE);
if (activeOthers.length) {
  skip('无授权时拒绝建站', `存在非本脚本登记的生效授权「${activeOthers[0].scope}」，跳过以免干扰真实演练`);
} else {
  const denied = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: 'x', listen_port: CAPTURE_PORT }) }, token);
  ok('无授权时拒绝建站', denied.status === 403, `${denied.status} ${denied.json?.message}`);
}

// ---------- 2. 授权登记与编辑 ----------
const pledge = await api('/authorizations/pledge', {}, token);
const authInput = {
  scope: '演示科技 信息安全部',
  contact: 'soc@example.com',
  start_at: new Date(Date.now() - 3600_000).toISOString(),
  end_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
  allowed_hosts: ['#ip', 'example.com', '*.demo.cn'],
  pledge: pledge.json.data.pledge,
  note: OWN_NOTE,
};
const auth = await api('/authorizations', { method: 'POST', body: JSON.stringify(authInput) }, token);
ok('登记演练授权', auth.status === 200 && auth.json?.data?.id, JSON.stringify(auth.json).slice(0, 120));
const authId = auth.json.data.id;

const editInput = { ...authInput, contact: 'soc-edited@example.com' };
const edited = await api(`/authorizations/${authId}`, { method: 'PUT', body: JSON.stringify(editInput) }, token);
ok(
  '修改授权并即时生效',
  edited.status === 200 && edited.json?.data?.effective === 'active' && edited.json?.data?.contact === 'soc-edited@example.com',
  `effective=${edited.json?.data?.effective} contact=${edited.json?.data?.contact}`
);

const badPledge = await api(`/authorizations/${authId}`, { method: 'PUT', body: JSON.stringify({ ...editInput, pledge: '随手填的承诺' }) }, token);
ok('修改时承诺不符被拒(400)', badPledge.status === 400, `${badPledge.status} ${badPledge.json?.message}`);

const badWindow = await api(`/authorizations/${authId}`, { method: 'PUT', body: JSON.stringify({ ...editInput, start_at: editInput.end_at, end_at: editInput.start_at }) }, token);
ok('修改时有效期倒挂被拒(400)', badWindow.status === 400, `${badWindow.status} ${badWindow.json?.message}`);

// ---------- 3. 网页模板与体检 ----------
const templateHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>账号安全核验</title>
<style>body{background:#f5f5f5;font-family:"Microsoft YaHei"}form{max-width:360px;margin:60px auto;background:#fff;padding:28px;border-radius:10px}input{width:100%;padding:10px;margin:8px 0;box-sizing:border-box}</style>
</head><body><form method="post"><h3>账号安全核验</h3>
<input name="username" placeholder="账号"><input name="password" type="password" placeholder="密码">
<input name="agree" type="checkbox" value="yes" data-al-ignore>
<button type="submit" data-al-collect>立即核验</button>
</form></body></html>`;

const template = await api(
  '/web-templates',
  {
    method: 'POST',
    body: JSON.stringify({ name: '账号安全核验', type: '信息登记', html: templateHtml, response_type: 'alert', response_content: '核验成功，您的账号已受保护' }),
  },
  token
);
const goodReport = template.json?.data?.diagnose;
const bindingCheck = (goodReport?.checks || []).find((c) => c.key === 'binding');
ok('创建网页模板（声明式绑定体检通过）', !!template.json?.data?.id && bindingCheck?.ok === true, JSON.stringify(bindingCheck));
ok(
  '体检输出约定形状',
  Number.isInteger(goodReport?.score) &&
    goodReport.score >= 0 &&
    goodReport.score <= 100 &&
    goodReport.checks?.map((c) => c.key).join(',') === 'binding,trigger,assets,scripts,fields' &&
    goodReport.checks?.every((c) => typeof c.label === 'string' && typeof c.detail === 'string' && typeof c.ok === 'boolean') &&
    Array.isArray(goodReport.issues),
  `score=${goodReport?.score}`
);
ok('可采集字段清单', (goodReport?.checks.find((c) => c.key === 'fields')?.items || []).join(',') === 'username,password', JSON.stringify(goodReport?.checks.find((c) => c.key === 'fields')));
ok('标记列沿用取值口径', template.json?.data?.check_onclick === '通过' && template.json?.data?.check_external === '无外链', `${template.json?.data?.check_onclick}/${template.json?.data?.check_external}`);

const badDiagnose = await api('/web-templates/diagnose', { method: 'POST', body: JSON.stringify({ html: '<html><body><script src="https://cdn.evil/x.js"></script><button>提交</button></body></html>' }) }, token);
const badReport = badDiagnose.json?.data;
ok(
  '体检发现缺失采集入口与外链',
  badReport?.checks.find((c) => c.key === 'binding')?.ok === false &&
    badReport?.checks.find((c) => c.key === 'assets')?.items?.length === 1 &&
    badReport?.checks.find((c) => c.key === 'scripts')?.ok === false &&
    badReport?.issues?.length === 4,
  `score=${badReport?.score} issues=${JSON.stringify(badReport?.issues)}`
);
const legacyHtml = `<form><input name="username"><input name="password" type="password"><input type="button" value="立即核验" onclick="login()"></form>`;
const legacyDiagnose = await api('/web-templates/diagnose', { method: 'POST', body: JSON.stringify({ html: legacyHtml }) }, token);
const legacyReport = legacyDiagnose.json?.data;
const legacyTrigger = legacyReport?.checks.find((c) => c.key === 'trigger');
ok(
  '体检认出只有动作按钮的老模板：绑定通过、提交触发点不过',
  legacyReport?.checks.find((c) => c.key === 'binding')?.ok === true &&
    legacyTrigger?.ok === false &&
    JSON.stringify(legacyTrigger?.items).includes('onclick=') &&
    legacyReport?.issues.some((i) => i.includes('兜底')),
  `score=${legacyReport?.score} trigger=${JSON.stringify(legacyTrigger)}`
);
const halfDone = await api('/web-templates', { method: 'POST', body: JSON.stringify({ name: '半成品', type: '信息登记', html: '<p>待补</p>' }) }, token);
ok('体检不阻断保存', halfDone.status === 200);

const preview = await api('/web-templates/preview', { method: 'POST', body: JSON.stringify({ html: templateHtml, response_type: 'alert' }) }, token);
ok('预览页注入 v2 运行时', preview.text.includes('application/alab+json') && preview.text.includes('window.AwareLab'), `${preview.text.length}B`);
ok(
  '运行时带表单按钮兜底与提交保活',
  preview.text.includes('hasSubmitControl') && preview.text.includes('keepalive'),
  '采集兜底在注入的运行时里，老模板不用改也能留痕'
);

const templates = await api('/web-templates?page=1&page_size=5', {}, token);
ok('模板分页列表', templates.json?.data?.rows?.length >= 2 && templates.json?.data?.page_size === 5, `total=${templates.json?.data?.total}`);
ok(
  '列表体检列形状合法（历史行为 null 不报错）',
  templates.json.data.rows.every((r) => r.diagnose_json === null || typeof JSON.parse(r.diagnose_json).score === 'number'),
  templates.json.data.rows.map((r) => (r.diagnose_json ? JSON.parse(r.diagnose_json).score : 'null')).join(' ')
);
const savedTemplate = await api(`/web-templates/${template.json.data.id}`, {}, token);
ok('新建模板把体检结论入库', JSON.parse(savedTemplate.json?.data?.diagnose_json ?? 'null')?.score === goodReport.score, `score=${JSON.parse(savedTemplate.json?.data?.diagnose_json ?? 'null')?.score}`);
const demotedHtml = '<p>仍然没有采集入口</p>';
const demoted = await api(`/web-templates/${halfDone.json.data.id}`, { method: 'PUT', body: JSON.stringify({ html: demotedHtml }) }, token);
const expectScore = (await api('/web-templates/diagnose', { method: 'POST', body: JSON.stringify({ html: demotedHtml }) }, token)).json?.data?.score;
ok(
  '编辑模板时同步刷新体检',
  JSON.parse(demoted.json?.data?.diagnose_json ?? 'null')?.score === expectScore && expectScore < goodReport.score,
  `入库=${JSON.parse(demoted.json?.data?.diagnose_json ?? 'null')?.score} 应=${expectScore}`
);
ok('模板类型枚举', (await api('/web-templates/types', {}, token)).json.data.includes('信息登记'));

// ---------- 4. 站点与钓鱼网站 ----------
const site = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: template.json.data.id, listen_port: CAPTURE_PORT, listen_ip: '0.0.0.0' }) }, token);
ok('创建并开启演练站点', !!site.json?.data?.id, site.json?.data?.url);
await sleep(600);

const badDomain = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: template.json.data.id, listen_port: CAPTURE_PORT + 1, domain: 'unauthorised.example.org' }) }, token);
ok('域名越界拒绝建站(400)', badDomain.status === 400 && badDomain.json?.message.includes('授权名单'), `${badDomain.status} ${badDomain.json?.message}`);

const badPort = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: template.json.data.id, listen_port: 70 }) }, token);
ok('端口越界拒绝建站(400)', badPort.status === 400 && badPort.json?.message.includes('监听端口'), `${badPort.status} ${badPort.json?.message}`);

const deniedHost = await hostProbe('not-allowed.example.org');
ok('非授权名单 Host 拒绝服务', deniedHost.status === 404 && deniedHost.body.includes('授权名单'), String(deniedHost.status));

const page = await fetch(`${CAPTURE_BASE}/`, { redirect: 'manual' });
const pageHtml = await page.text();
const visitorToken = (page.headers.getSetCookie?.()[0] || page.headers.get('set-cookie') || '').match(/alab_tk=([\w-]+)/)?.[1];
ok(
  '页面注入 JSON 配置块与运行时',
  pageHtml.includes('type="application/alab+json"') && pageHtml.includes('id="alab-boot"') && pageHtml.includes('window.AwareLab') && !pageHtml.includes('window.__AF'),
  `注入 ${pageHtml.length}B`
);
ok('配置块承载采集参数', /"token":"[\w-]+","site":"[\w-]+","after":"alert","content":"核验成功[^"]*","endpoint":"\/alab\/v2\/engage"/.test(pageHtml), 'boot json');
ok('运行时无需 onclick', !pageHtml.includes('onclick="login"') && !pageHtml.includes('window.__AF'), '声明式绑定');
ok('下发终端令牌 Cookie', !!visitorToken, visitorToken?.slice(0, 8) + '…');
ok('运行时注入在 </body> 前', pageHtml.indexOf('alab-boot') < pageHtml.lastIndexOf('</body>'), '注入位置');
ok(
  '运行时按 v2 约定绑定与上报',
  ['location.pathname', 'data-al-collect', 'data-al-ignore', "'alab.tk'", 'showModal', 'sendBeacon'].every((mark) => pageHtml.includes(mark)),
  'v2 运行时特征'
);

const openRes = await fetch(`${CAPTURE_BASE}/alab/v2/engage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ev: 'open', tk: visitorToken, dwell: 1, href: `${CAPTURE_BASE}/`, search: '', referer: '' }),
});
const openJson = await openRes.json();
ok('打开上报（ev=open）成功', openRes.status === 200 && openJson?.data?.accepted === true, JSON.stringify(openJson));

async function engageSubmit(fields, dwell) {
  const res = await fetch(`${CAPTURE_BASE}/alab/v2/engage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ev: 'submit', tk: visitorToken, dwell, href: `${CAPTURE_BASE}/`, search: '', referer: '', fields }),
  });
  return { status: res.status, json: await res.json() };
}
const first = await engageSubmit({ username: 'zhangsan', password: 'P@ssw0rd' }, 42);
const second = await engageSubmit({ username: 'zhangsan', password: 'Again123' }, 88);
ok('填写上报（ev=submit）成功', first.status === 200 && first.json?.data?.ev === 'submit', JSON.stringify(first.json));
ok('重复提交不去重', second.json?.data?.accepted === true, JSON.stringify(second.json));

const emptyFields = await fetch(`${CAPTURE_BASE}/alab/v2/engage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ev":"submit","tk":"unknown-token"}' });
ok('上报缺字段也不报错（fail-open）', emptyFields.status === 200, String(emptyFields.status));

// ---------- 5. 取证记录 ----------
const records = await api(`/records?kind=web&keyword=${visitorToken}`, {}, token);
const record = records.json.data.rows[0];
ok('上钩记录落库', records.json.data.total === 1 && record?.submitted === true, JSON.stringify(record?.form_json).slice(0, 200));
ok(
  '多次提交历史归一化保留',
  Array.isArray(record?.form_json) &&
    record.form_json.length === 4 &&
    record.form_json.every((f) => 'name' in f && 'value' in f && 'at' in f) &&
    record.form_json.map((f) => f.value).join(',') === 'zhangsan,P@ssw0rd,zhangsan,Again123',
  JSON.stringify(record?.form_json)
);

const detail = await api(`/records/${record.id}`, {}, token);
ok(
  '记录详情含特征与上下文',
  detail.json.data?.feature?.['user-agent'] !== undefined &&
    detail.json.data?.context?.template_name === '账号安全核验' &&
    detail.json.data?.events?.length >= 3,
  JSON.stringify(detail.json.data?.feature?.os)
);
ok('记录详情保留停留时长', detail.json.data?.dwell_seconds === 88, `dwell=${detail.json.data?.dwell_seconds}`);

// ---------- 5.5 系统设置与通知推送（推送到本地回收端口） ----------
const settings = await api('/settings', {}, token);
ok(
  '系统设置回显运行参数',
  settings.json.data?.panel_path === PANEL &&
    settings.json.data?.panel_port === cfg.panel.port &&
    String(settings.json.data?.db_path).startsWith(DATA_DIR) &&
    typeof settings.json.data?.require_authorization === 'boolean',
  JSON.stringify({ panel: settings.json.data?.panel_path, db: settings.json.data?.db_path })
);

const pushed = [];
const sink = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    pushed.push(raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"errcode":0}');
  });
});
await new Promise((r) => sink.listen(0, '127.0.0.1', r));
const savedPush = await api(
  '/settings/push',
  { method: 'PUT', body: JSON.stringify({ value: { enabled: true, channels: [{ type: 'wecom', url: `http://127.0.0.1:${sink.address().port}/hook`, events: ['page_open'] }] } }) },
  token
);
ok('保存推送配置', savedPush.json?.data?.enabled === true && savedPush.json?.data?.channels?.length === 1, JSON.stringify(savedPush.json?.data?.channels?.[0]?.type));

// 一次「打开」上报就该触发一条群机器人通知
await fetch(`${CAPTURE_BASE}/alab/v2/engage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ev: 'open', tk: visitorToken, dwell: 2, href: '/', search: '', referer: '' }),
});
// 只认自己刚触发的那条 page_open：push_logs 里可能留着上一轮的导出记录，按 rows[0] 取会串台
const pushLogs = await poll(() => api('/push-logs', {}, token), (r) => (r.json?.data?.rows || []).some((row) => row.event_kind === 'page_open'));
const pushRow = (pushLogs.json?.data?.rows || []).find((row) => row.event_kind === 'page_open');
ok(
  '通知文案只用本平台品牌',
  pushed.some((body) => body.includes('[AwareLab 演练通知]')) &&
    pushRow?.ok === 1 &&
    pushRow?.event_kind === 'page_open',
  `${pushRow?.channel}/${pushRow?.event_kind}/ok=${pushRow?.ok}`
);
await api('/settings/push', { method: 'PUT', body: JSON.stringify({ value: { enabled: false, channels: [] } }) }, token);
sink.close();

// 学习页分支：模板改 lesson 响应后走 /alab/v2/lesson
const learn = await api('/learn-pages', { method: 'POST', body: JSON.stringify({ name: '防钓鱼要点', html: '<h1>如何识别钓鱼邮件</h1>' }) }, token);
ok('创建警示学习页', !!learn.json?.data?.id);
await api(`/web-templates/${template.json.data.id}`, { method: 'PUT', body: JSON.stringify({ response_type: 'lesson', learn_page_id: learn.json.data.id }) }, token);
const lessonWithPage = await fetch(`${CAPTURE_BASE}/alab/v2/lesson?tk=${visitorToken}`);
ok('学习页跳转命中绑定页面', (await lessonWithPage.text()).includes('如何识别钓鱼邮件'));
await api(`/learn-pages/${learn.json.data.id}`, { method: 'DELETE' }, token);
const lessonFallback = await fetch(`${CAPTURE_BASE}/alab/v2/lesson?tk=${visitorToken}`);
ok('学习页被删后回落提示页', (await lessonFallback.text()).includes('安全意识提示'));
await api(`/web-templates/${template.json.data.id}`, { method: 'PUT', body: JSON.stringify({ response_type: 'alert', response_content: '核验成功，您的账号已受保护' }) }, token);

const stoppedByAdmin = await api(`/web-sites/${site.json.data.id}/stop`, { method: 'POST' }, token);
ok('手动下线站点', stoppedByAdmin.json?.data === true);
const afterStop = await hostProbe('127.0.0.1');
ok('下线后端口不再服务', afterStop.status === 0 || afterStop.status === 404, String(afterStop.status));
await api(`/web-sites/${site.json.data.id}/start`, { method: 'POST' }, token);
await sleep(300);

// ---------- 6. 邮件链路 ----------
const mailTemplate = await api(
  '/mail-templates',
  { method: 'POST', body: JSON.stringify({ name: '邮箱密码到期提醒', subject: '您的企业邮箱将于今日到期', body_html: `<html><body><p>{{name}} 您好，请点击 <a href="${CAPTURE_BASE}/">立即续期</a> 完成验证。</p></body></html>` }) },
  token
);
ok('创建邮箱模板', !!mailTemplate.json?.data?.id);

const task = await api(
  '/mail-tasks',
  { method: 'POST', body: JSON.stringify({ title: '2026Q4 邮箱到期演练', subject: '您的企业邮箱将于今日到期', body_html: `<html><body><p>{{name}} 您好，请点击 <a href="${CAPTURE_BASE}/">立即续期</a>。</p></body></html>`, send_interval_ms: 0 }) },
  token
);
ok('创建邮箱任务默认沙箱', task.json?.data?.dry_run === 1, 'dry_run=' + task.json?.data?.dry_run);

const importResult = await api(`/mail-tasks/${task.json.data.id}/recipients`, { method: 'POST', body: JSON.stringify({ text: 'lisi@corp.example,李四\nwangwu@corp.example,王五\nbad-email,' }) }, token);
ok('收件人导入与去噪', importResult.json.data.added === 2 && importResult.json.data.invalid === 1, JSON.stringify(importResult.json.data));

const send = await api(`/mail-tasks/${task.json.data.id}/send`, { method: 'POST' }, token);
ok('沙箱发送不真实发信', send.json?.data?.dry_run === true && send.json?.data?.sent === 2, JSON.stringify(send.json?.data));

const taskDetail = await api(`/mail-tasks/${task.json.data.id}`, {}, token);
const recipient = taskDetail.json.data.recipients[0];
ok('任务详情含收件人与事件', taskDetail.json.data.recipients.length === 2 && taskDetail.json.data.events.some((e) => e.kind === 'mail_send'), JSON.stringify(taskDetail.json.data.task.status));

const outbox = path.join(DATA_DIR, 'outbox');
const emlFile = path.join(outbox, `${task.json.data.id.slice(0, 8)}-${recipient.email}.eml`);
ok('沙箱产物落 .eml', fs.existsSync(emlFile), path.basename(emlFile));
const eml = fs.existsSync(emlFile) ? fs.readFileSync(emlFile, 'utf8') : '';
const renderedBody = emlBody(eml);
ok('正文像素迁到新路径', renderedBody.includes(`/alab/v2/pixel?tk=${recipient.token}&task=${task.json.data.id}`), renderedBody.slice(0, 160));
ok(
  '站点链接改挂 trace 且内层 url 自带归属令牌',
  renderedBody.includes(`/alab/v2/trace?tk=${recipient.token}`) &&
    renderedBody.includes(`to=${encodeURIComponent(recipient.email)}`) &&
    /url=http[^"&]*tk%3D/.test(renderedBody),
  'trace link'
);
ok('邮件文案出自 AwareLab 沙箱', /AwareLab/.test(eml), '品牌');
ok('沙箱标记写入邮件头', /X-Sandbox:\s*true/i.test(eml), 'header');

const profile = await api('/smtp-profiles', { method: 'POST', body: JSON.stringify({ name: '内部网关', host: 'smtp.corp.example', port: 465, secure: true, user: 'drill@corp.example', pass: 'sup3rsecret', from_addr: 'drill@corp.example' }) }, token);
ok('创建 SMTP 配置', !!profile.json?.data?.id);
const profiles = await api('/smtp-profiles', {}, token);
const masked = profiles.json.data.rows.find((p) => p.id === profile.json.data.id);
ok('SMTP 密码列表掩码', masked?.pass === '******' && !JSON.stringify(profiles.json).includes('sup3rsecret'), `pass=${masked?.pass}`);

// 编辑窗口只回显掩码，因此「不带 pass」必须理解为「不改口令」；
// 掩码一旦写回库里，下一次真实发送就会拿 ****** 去认证，属于必须守住的回归点。
const profileEdit = await api(
  `/smtp-profiles/${profile.json.data.id}`,
  { method: 'PUT', body: JSON.stringify({ name: '内部网关·改', port: 587, secure: false }) },
  token
);
const storedPass = (() => {
  try {
    const ro = new DatabaseSync(path.join(DATA_DIR, 'awarelab.db'), { readOnly: true });
    try {
      return ro.prepare('SELECT pass FROM smtp_profiles WHERE id=?').get(profile.json.data.id)?.pass;
    } finally {
      ro.close();
    }
  } catch {
    return null;
  }
})();
ok(
  '编辑发信邮箱可只改连接参数',
  profileEdit.status === 200 && profileEdit.json?.data?.name === '内部网关·改' && profileEdit.json?.data?.port === 587,
  JSON.stringify(profileEdit.json?.data ?? profileEdit.status)
);
ok('编辑不回显口令且原口令未被掩码覆盖', profileEdit.json?.data?.pass === '******' && storedPass === 'sup3rsecret', `库内=${storedPass}`);
const profileBroken = await api(`/smtp-profiles/${profile.json.data.id}`, { method: 'PUT', body: JSON.stringify({ host: '' }) }, token);
ok('清空 SMTP 主机被拒(400)', profileBroken.status === 400, `${profileBroken.status} ${profileBroken.json?.message}`);
const profileMissing = await api(`/smtp-profiles/${crypto.randomUUID()}`, { method: 'PUT', body: JSON.stringify({ name: 'x' }) }, token);
ok('未知发信邮箱返回 404', profileMissing.status === 404, String(profileMissing.status));

// ---------- 5.4 推送脱敏与机器人令牌掩码 ----------
const pushBodies = [];
const pushSink = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    pushBodies.push(raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"errcode":0}');
  });
});
await new Promise((r) => pushSink.listen(0, '127.0.0.1', r));
const ROBOT_TOKEN = 'ROBOT-TOKEN-LEAK-CHECK';
const loopbackHook = `http://127.0.0.1:${pushSink.address().port}/hook?access_token=${ROBOT_TOKEN}`;

const publicPlainPush = await api(
  '/settings/push',
  { method: 'PUT', body: JSON.stringify({ value: { enabled: true, channels: [{ type: 'wecom', url: 'http://robot.example.org/hook', events: ['mail_open'] }] } }) },
  token
);
ok(
  '公网明文 http 的机器人地址被拒(400)',
  publicPlainPush.status === 400 && /https/.test(publicPlainPush.json?.message || ''),
  `${publicPlainPush.status} ${publicPlainPush.json?.message}`
);

const loopbackPush = await api(
  '/settings/push',
  { method: 'PUT', body: JSON.stringify({ value: { enabled: true, channels: [{ type: 'wecom', url: loopbackHook, events: ['mail_open'] }] } }) },
  token
);
ok('本机回环 http 放行（本地联调与自动化验证要用）', loopbackPush.status === 200, `${loopbackPush.status} ${loopbackPush.json?.message}`);
ok('推送配置默认开启脱敏', loopbackPush.json?.data?.redact === true, `redact=${loopbackPush.json?.data?.redact}`);

const pixelForPush = async () => fetch(`${BASE}/alab/v2/pixel?tk=${recipient.token}&task=${task.json.data.id}`);
await pixelForPush();
const redactedLogs = await poll(
  () => api('/push-logs', {}, token),
  (r) => (r.json?.data?.rows || []).some((row) => row.event_kind === 'mail_open')
);
const redactedRow = (redactedLogs.json?.data?.rows || []).find((row) => row.event_kind === 'mail_open');
ok(
  '推送日志掩码机器人令牌',
  !String(redactedRow?.request || '').includes(ROBOT_TOKEN) && String(redactedRow?.request || '').includes('******'),
  String(redactedRow?.request || '').slice(0, 110)
);
ok(
  '脱敏开启时推送不含员工邮箱',
  !pushBodies.some((b) => b.includes(recipient.email)) && pushBodies.some((b) => /员工#[0-9a-f]{8}/.test(b)),
  String(pushBodies[0] || '').slice(0, 120)
);

await api(
  '/settings/push',
  { method: 'PUT', body: JSON.stringify({ value: { enabled: true, redact: false, channels: [{ type: 'wecom', url: loopbackHook, events: ['mail_open'] }] } }) },
  token
);
pushBodies.length = 0;
await pixelForPush();
await poll(
  () => api('/push-logs', {}, token),
  () => pushBodies.some((b) => b.includes(recipient.email))
);
ok(
  '关掉脱敏后按操作员意愿回原文（说明开关真的生效）',
  pushBodies.some((b) => b.includes(recipient.email)),
  String(pushBodies[0] || '').slice(0, 120)
);
await api('/settings/push', { method: 'PUT', body: JSON.stringify({ value: { enabled: false, redact: true, channels: [] } }) }, token);
pushSink.close();

const pixel = await fetch(`${BASE}/alab/v2/pixel?tk=${recipient.token}&task=${task.json.data.id}`);
const pixelBytes = Buffer.from(await pixel.arrayBuffer());
ok('打开追踪像素可用', pixel.status === 200 && pixelBytes.length > 0 && pixel.headers.get('content-type') === 'image/gif', `${pixelBytes.length}B`);

// 站点链接在发送时就改挂到信标面，内层 url 已带归属令牌，跳转只做记账 + 原样放行
const traceTarget = `${CAPTURE_BASE}/mail-check?tk=${recipient.token}`;
const trace = await fetch(`${BASE}/alab/v2/trace?tk=${recipient.token}&to=${encodeURIComponent(recipient.email)}&url=${encodeURIComponent(traceTarget)}`, { redirect: 'manual' });
const traceLocation = String(trace.headers.get('location') || '');
ok('点击跳转放行且目标原样', trace.status === 302 && traceLocation === traceTarget, `${trace.status} ${traceLocation}`);

const traceAbuse = await fetch(`${BASE}/alab/v2/trace?tk=${recipient.token}&url=${encodeURIComponent('http://evil.example.org/phish')}`, { redirect: 'manual' });
const traceAbuseBody = await traceAbuse.text();
ok('trace 拒绝越界跳转目标', traceAbuse.status === 200 && traceAbuseBody.includes('授权范围'), String(traceAbuse.status));

const form = new FormData();
form.append('username', 'lisi');
form.append('hostname', 'DESKTOP-LISI');
form.append('capture', new Blob([PNG_1X1], { type: 'image/png' }), 'screen.png');
const callback = await fetch(`${BASE}/alab/v2/callback?tk=${recipient.token}&mail=${recipient.email}`, { method: 'POST', body: form });
const callbackJson = await callback.json();
ok('附件运行回调', callbackJson.code === 0 && callbackJson.data?.accepted === true && !!callbackJson.data?.id, JSON.stringify(callbackJson));

const callbackRecord = await api(`/records/${callbackJson.data.id}`, {}, token);
ok(
  '回调截图与字段入库',
  !!callbackRecord.json.data?.screenshot_url && callbackRecord.json.data.form_json.some((f) => f.name === 'hostname' && f.value === 'DESKTOP-LISI'),
  callbackRecord.json.data?.screenshot_url
);
const shotUrl = callbackRecord.json.data.screenshot_url;
const screenshotFetch = await fetch(`${API}${shotUrl.replace(/^\/api/, '')}`, { headers: { 'x-alab-token': token } });
ok('截图可回读', screenshotFetch.status === 200 && shotUrl === `/api/records/${callbackJson.data.id}/screenshot`, `${screenshotFetch.status} ${shotUrl}`);

// ⑦ 回传面输入约束：令牌、字段、文件、频率四道闸门（SEC-02）
const recipientB = taskDetail.json.data.recipients[1];
const postCallback = async (tk, { fields = {}, fileName = 'x.png', fileBytes = PNG_1X1, fileField = 'capture' } = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (fileBytes) fd.append(fileField, new Blob([fileBytes], { type: 'application/octet-stream' }), fileName);
  const res = await fetch(`${BASE}/alab/v2/callback?tk=${tk}`, { method: 'POST', body: fd });
  let json = null;
  try {
    json = await res.clone().json();
  } catch {
    /* 非 JSON 响应按原样断言状态码 */
  }
  return { status: res.status, json, text: await res.text() };
};

const ghostToken = await postCallback('no-such-token-at-all', { fields: { username: 'x' } });
const ghostEvents = await api(`/records?kind=mail&keyword=no-such-token`, {}, token);
ok(
  '无令牌/陌生令牌的回传被拒且不留记录',
  ghostToken.status === 400 && /不属于本次演练/.test(ghostToken.json?.message || '') && ghostEvents.json?.data?.total === 0,
  `${ghostToken.status} ${ghostToken.json?.message}`
);

const binaryRun = await postCallback(recipientB.token, { fields: { hostname: 'DESKTOP-WANG' }, fileName: 'invoice.exe', fileBytes: FAKE_BINARY });
const binaryRecord = await api(`/records/${binaryRun.json?.data?.id}`, {}, token);
ok(
  '非证据形态的文件不落盘',
  binaryRun.status === 200 && binaryRun.json?.data?.rejected_files === 1 && !binaryRecord.json?.data?.screenshot_url,
  JSON.stringify({ rejected: binaryRun.json?.data?.rejected_files, shot: binaryRecord.json?.data?.screenshot_url })
);

const mismatchRun = await postCallback(recipientB.token, { fields: { hostname: 'DESKTOP-WANG' }, fileName: 'report.pdf', fileBytes: PNG_1X1 });
const mismatchRecord = await api(`/records/${mismatchRun.json?.data?.id}`, {}, token);
ok(
  '扩展名与真实文件头不符同样不落盘',
  mismatchRun.json?.data?.rejected_files === 1 && !mismatchRecord.json?.data?.screenshot_url,
  JSON.stringify({ rejected: mismatchRun.json?.data?.rejected_files, shot: mismatchRecord.json?.data?.screenshot_url })
);

const oversizedRun = await postCallback(recipientB.token, { fileBytes: Buffer.concat([PNG_1X1, Buffer.alloc(6 * 1024 * 1024, 1)]) });
ok(
  '超过 5MB 的单文件直接拒收(413)',
  oversizedRun.status === 413 && /5MB/.test(oversizedRun.json?.message || ''),
  `${oversizedRun.status} ${oversizedRun.json?.message}`
);

const flood = [];
for (let i = 0; i < 12; i += 1) flood.push((await postCallback(recipientB.token, { fields: { seq: String(i) } })).status);
ok(
  '同令牌刷到阈值后限流(429)',
  flood.filter((s) => s === 429).length >= 2 && flood.filter((s) => s === 200).length >= 1 && !flood.includes(400),
  flood.join(',')
);
const floodRecord = await api(`/records?kind=mail&keyword=${encodeURIComponent(recipientB.email)}`, {}, token);
ok(
  '限流只挡新回传，已入库证据不受影响',
  (floodRecord.json?.data?.rows || []).some((row) => row.target_email === recipientB.email && row.submitted === true),
  `该邮箱记录 ${floodRecord.json?.data?.total} 条`
);

const pageTokenProbe = await rawRequest({ pathname: '/', port: CAPTURE_PORT, headers: { Host: `127.0.0.1:${CAPTURE_PORT}` } });
const siteVisitorToken = String((pageTokenProbe.headers['set-cookie'] || []).join(';')).match(/alab_tk=([\w-]{36})/)?.[1];
const whitelistRun = await postCallback(siteVisitorToken, {
  fields: { username: 'kept', password: 'kept-too', ssid_of_home_wifi: 'dropped-by-template', 'bad name!': 'dropped-by-rule' },
  fileBytes: null,
});
const whitelistRecord = await api(`/records/${whitelistRun.json?.data?.id}`, {}, token);
const keptNames = (whitelistRecord.json?.data?.form_json || []).map((f) => f.name);
ok(
  '站点令牌的字段白名单只放模板声明过的名字',
  !!siteVisitorToken && whitelistRun.json?.data?.dropped_fields === 2 && keptNames.includes('username') && keptNames.includes('password') && !keptNames.includes('ssid_of_home_wifi'),
  JSON.stringify({ dropped: whitelistRun.json?.data?.dropped_fields, kept: keptNames })
);
await api(`/records/${whitelistRun.json?.data?.id}`, { method: 'DELETE' }, token);

const health = await fetch(`${BASE}/alab/health`);
ok('/alab/health 连通自检', (await health.text()) === 'ok');

const mailRecords = await api(`/records?kind=mail&keyword=${encodeURIComponent(recipient.email)}`, {}, token);
const mailRecord = mailRecords.json.data.rows[0];
ok(
  '邮件侧记录打开与提交计数',
  mailRecord?.submitted === true && taskDetail.json.data.recipients.length === 2,
  JSON.stringify({ opened: !!mailRecord?.first_seen_at })
);
const afterTrace = await api(`/mail-tasks/${task.json.data.id}`, {}, token);
ok('点击计数落到收件人', afterTrace.json.data.recipients.some((r) => r.clicked_at), JSON.stringify(afterTrace.json.data.recipients.map((r) => !!r.clicked_at)));

const resend = await api(`/mail-tasks/${task.json.data.id}/recipients/${recipient.id}/resend`, { method: 'POST' }, token);
ok('单收件人重发只推进这一条', resend.json?.data?.total === 1 && resend.json?.data?.sent === 1, JSON.stringify(resend.json?.data));

// ---------- 7. 统计与导出 ----------
const stats = await api('/stats/home', {}, token);
const s = stats.json.data;
ok(
  '统计口径正确',
  s.web_stats.opened >= 1 && s.web_stats.submitted >= 1 && s.basic.running_sites >= 1 && s.basic.listen_ports.includes(CAPTURE_PORT),
  `opened=${s.web_stats.opened} submitted=${s.web_stats.submitted} 转化率=${s.web_stats.conversion}% 风险分=${s.basic.risk_score}`
);
ok('统计含设备分布与漏斗', Object.keys(s.os_buckets).length >= 1 && s.funnel.opened === s.web_stats.opened && s.trend.length === 7, JSON.stringify(s.os_buckets));
ok('统计授权主体回填', typeof s.basic.authorization === 'string', String(s.basic.authorization));

const bigscreen = await api('/stats/bigscreen', {}, token);
ok('大屏数据可用', bigscreen.json.data.events.length >= 1 && bigscreen.json.data.sites.length >= 1, `events=${bigscreen.json.data.events.length}`);

const exportRes = await fetch(`${API}/reports/export?kind=web`, { headers: { 'x-alab-token': token } });
const disposition = exportRes.headers.get('content-disposition') || '';
const csv = await exportRes.text();
ok('导出文件名走新命名', disposition.includes('awarelab-web-evidence.csv'), disposition);
ok('导出含归一化采集内容', csv.includes('username=zhangsan') && csv.includes('password=P@ssw0rd') && csv.includes('Again123'), csv.split('\r\n')[1]?.slice(0, 80));

// ---------- 7.5 功能矩阵补测：鉴权边界 / 签发归属 / 非法载荷 / 设备分类 / 任务与配置 ----------

/** 钓鱼网站上报：允许指定端口与 UA，正文可传字符串以模拟非法载荷 */
async function engagePost(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/alab/v2/engage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const recordOf = async (tk) => (await api(`/records?kind=web&keyword=${encodeURIComponent(tk)}`, {}, token)).json?.data?.rows?.[0];

// ① 登录限速：锁定按来源算，测试只用 TEST-NET 地址，绝不锁掉本机后续登录
const LOCK_IP = '203.0.113.97';
async function loginWith(ip, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `${ip}, 10.0.0.9` },
    body: JSON.stringify({ username: cfg.panel.username, password }),
  });
  return res.status;
}
const brute = [];
for (let i = 0; i < 8; i += 1) brute.push(await loginWith(LOCK_IP, `wrong-pass-${i}`));
ok('口令错误逐次被拒(401)', brute.every((s) => s === 401), brute.join(','));
const lockedStatus = await loginWith(LOCK_IP, cfg.panel.password);
ok('连续失败后即便口令正确也锁定(429)', lockedStatus === 429, String(lockedStatus));
ok('锁定只按来源生效，别的来源照常登录', (await loginWith('203.0.113.98', cfg.panel.password)) === 200);

// 成功登录必须清零失败计数，否则一次误锁会让同一来源在窗口期内永远进不来
const RESET_IP = '203.0.113.99';
for (let i = 0; i < 3; i += 1) await loginWith(RESET_IP, 'wrong');
await loginWith(RESET_IP, cfg.panel.password);
const afterReset = [];
for (let i = 0; i < 7; i += 1) afterReset.push(await loginWith(RESET_IP, 'wrong'));
ok('成功登录后失败计数归零', afterReset.every((s) => s === 401), afterReset.join(','));

const spare = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: cfg.panel.username, password: cfg.panel.password }) });
const spareToken = spare.json?.data?.token;
ok('登出接口可用', (await api('/auth/logout', { method: 'POST' }, spareToken)).json?.data === true);
ok('登出后原令牌立即失效(401)', (await api('/auth/me', {}, spareToken)).status === 401, String((await api('/auth/me', {}, spareToken)).status));

try {
  const stale = `e2ewave-stale-${crypto.randomUUID().slice(0, 8)}`;
  const rw = new DatabaseSync(path.join(DATA_DIR, 'awarelab.db'));
  rw.prepare('INSERT INTO sessions (token,username,expires_at,created_at) VALUES (?,?,?,?)').run(stale, cfg.panel.username, Date.now() - 60_000, new Date().toISOString());
  rw.close();
  const staleCall = await api('/auth/me', {}, stale);
  ok('过期令牌被拒且提示重新登录(401)', staleCall.status === 401 && String(staleCall.json?.message).includes('过期'), `${staleCall.status} ${staleCall.json?.message}`);
} catch (err) {
  skip('过期令牌被拒', `无法并发写入隔离库：${err.message}`);
}

// ② 签发链接：非邮件渠道（IM、内网公告）也要能把打开与提交归到人身上
const issued = await api(`/web-sites/${site.json.data.id}/links`, { method: 'POST', body: JSON.stringify({ email: 'zhaoliu@corp.example', name: '赵六' }) }, token);
const issuedTk = issued.json?.data?.tk;
ok(
  '签发投放链接带回可访问地址',
  !!issuedTk && String(issued.json?.data?.url).endsWith(`/?tk=${issuedTk}`),
  issued.json?.data?.url
);
const issuedPage = await fetch(issued.json.data.url);
const issuedHtml = await issuedPage.text();
ok('签发链接的令牌进 boot 块', issuedHtml.includes(`"token":"${issuedTk}"`) && issuedHtml.includes('id="alab-boot"'), `${issuedHtml.length}B`);
const badIssue = await api(`/web-sites/${site.json.data.id}/links`, { method: 'POST', body: JSON.stringify({ email: 'not-an-email' }) }, token);
ok('签发时邮箱格式不合法被拒(400)', badIssue.status === 400, `${badIssue.status} ${badIssue.json?.message}`);
const missingSiteIssue = await api(`/web-sites/${crypto.randomUUID()}/links`, { method: 'POST', body: JSON.stringify({}) }, token);
ok('给不存在的站点签发链接返回 404', missingSiteIssue.status === 404, String(missingSiteIssue.status));

await engagePost(CAPTURE_PORT, { ev: 'submit', tk: issuedTk, dwell: 7, href: '/', search: '', referer: '', fields: { username: 'zhaoliu', password: 'Abc12345' } });
const attributed = await recordOf(issuedTk);
ok('签发链接采到的证据带目标邮箱', attributed?.target_email === 'zhaoliu@corp.example', String(attributed?.target_email));
const anonymousRecord = await recordOf('unknown-token');
ok('未登记令牌只记录不臆造归属', anonymousRecord && anonymousRecord.target_email === null, JSON.stringify(anonymousRecord?.target_email));

const siteLinks = await api(`/web-sites/${site.json.data.id}/links`, {}, token);
const linkRow = siteLinks.json?.data?.rows?.find((r) => r.token === issuedTk);
ok(
  '按站点回查专属链接：一行看完归属、打开、提交与采到的字段',
  siteLinks.status === 200 &&
    linkRow?.target_email === 'zhaoliu@corp.example' &&
    String(linkRow?.url).endsWith(`/?tk=${issuedTk}`) &&
    !!linkRow?.submitted_at &&
    linkRow?.field_names?.join(',') === 'username,password' &&
    linkRow?.submits === 1 &&
    siteLinks.json?.data?.site?.id === site.json.data.id,
  JSON.stringify(linkRow)
);
const missingSiteLinks = await api(`/web-sites/${crypto.randomUUID()}/links`, {}, token);
ok('回查不存在站点的链接返回 404', missingSiteLinks.status === 404, String(missingSiteLinks.status));

// ③ 非法载荷：钓鱼网站直接暴露给演练对象，任何畸形请求都不能让它停止服务
const junk = await engagePost(CAPTURE_PORT, '这不是 JSON');
ok('正文非 JSON 仍按 fail-open 记账', junk.status === 200 && junk.json?.data?.accepted === true, JSON.stringify(junk.json));
const oddEvent = await engagePost(CAPTURE_PORT, { ev: 'click', tk: 'e2ewave-oddevent' });
ok('未知事件类型回落成打开', oddEvent.json?.data?.ev === 'open', JSON.stringify(oddEvent.json));
let oversize = { status: 0, note: '' };
try {
  const big = await engagePost(CAPTURE_PORT, { ev: 'submit', tk: 'e2ewave-oversize', fields: { blob: 'x'.repeat(600 * 1024) } });
  oversize = { status: big.status, note: '不断连接' };
} catch (err) {
  oversize = { status: -1, note: String(err.message).slice(0, 40) };
}
const healthAfterAbuse = await fetch(`${BASE}/alab/health`);
ok('超大上报打不垮钓鱼网站', (await healthAfterAbuse.text()) === 'ok', `${oversize.status}/${oversize.note}`);
const oversizeRecord = await recordOf('e2ewave-oversize');
ok('超限载荷不落半成品记录', !oversizeRecord || !oversizeRecord.submitted, JSON.stringify(oversizeRecord?.submitted));

await engagePost(CAPTURE_PORT, { ev: 'submit', tk: 'e2ewave-merge', dwell: 3, fields: { tag: ['a', 'b'], profile: { level: 'vip' } } });
const mergedRecord = await recordOf('e2ewave-merge');
ok('同名多值摊平成多条记录', (mergedRecord?.form_json || []).filter((f) => f.name === 'tag').map((f) => f.value).join(',') === 'a,b', JSON.stringify(mergedRecord?.form_json));
ok('非标量值序列化后不丢字段', mergedRecord?.form_json?.find((f) => f.name === 'profile')?.value === '{"level":"vip"}');
await engagePost(CAPTURE_PORT, { ev: 'submit', tk: 'e2ewave-negdwell', dwell: -40, fields: { username: 'neg' } });
const negDwellRecord = await recordOf('e2ewave-negdwell');
ok('负数停留时长被归一化为非负', Number.isFinite(negDwellRecord?.dwell_seconds) && negDwellRecord.dwell_seconds >= 0, `dwell=${negDwellRecord?.dwell_seconds}`);

// ④ UA 判定：系统看括号内段、浏览器看产品令牌，两条通道各测一遍
const UA_CASES = [
  { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', os: '苹果', browser: 'Safari' },
  { ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', os: '安卓', browser: '谷歌' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', os: 'Windows', browser: '谷歌' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15', os: 'MacOS', browser: 'Safari' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0', os: 'Linux', browser: '火狐' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0', os: 'Windows', browser: 'Edge' },
  { ua: 'curl/8.4.0', os: '未知', browser: '其他' },
];
for (const c of UA_CASES) {
  const tk = `e2ewave-ua-${c.os}-${c.browser}`;
  await engagePost(CAPTURE_PORT, { ev: 'open', tk, dwell: 1, href: '/', search: '', referer: '' }, { 'user-agent': c.ua });
  const rec = await recordOf(tk);
  ok(`UA 判定 ${c.os}/${c.browser}`, rec?.feature?.os === c.os && rec?.feature?.browser === c.browser, `${rec?.feature?.os}/${rec?.feature?.browser}`);
}
const statsWithDevices = (await api('/stats/home', {}, token)).json.data;
ok('设备分布吃到多端真实 UA', ['苹果', '安卓', 'Windows'].every((k) => k in statsWithDevices.os_buckets), Object.keys(statsWithDevices.os_buckets).join(','));
ok('浏览器分布同样进统计', Object.keys(statsWithDevices.browser_buckets || {}).length >= 3, JSON.stringify(statsWithDevices.browser_buckets));

// ⑤ 取证列表的过滤与分页边界
const clamped = await api('/records?page=1&page_size=99999', {}, token);
ok('分页尺寸越界被夹到上限', clamped.json?.data?.page_size === 200, `page_size=${clamped.json?.data?.page_size}`);
const badPaging = await api('/records?page=0&page_size=0', {}, token);
ok('非法分页参数回落默认', badPaging.json?.data?.page === 1 && badPaging.json?.data?.page_size === 10, `page=${badPaging.json?.data?.page} size=${badPaging.json?.data?.page_size}`);
const onlySubmitted = await api('/records?submitted=1', {}, token);
ok('按是否提交过滤', onlySubmitted.json.data.rows.every((r) => r.submitted === true), `total=${onlySubmitted.json.data.total}`);
// 「看过但没交内容」是演练里最该被单独筛出来的一批，只支持 submitted=1 等于这个筛选是半残的
const onlyUnsubmitted = await api('/records?submitted=0', {}, token);
ok(
  '按未提交过滤',
  onlyUnsubmitted.json.data.rows.length >= 1 && onlyUnsubmitted.json.data.rows.every((r) => r.submitted === false),
  `total=${onlyUnsubmitted.json.data.total}`
);
const bySite = await api(`/records?site_id=${site.json.data.id}`, {}, token);
const byTask = await api(`/records?task_id=${task.json.data.id}`, {}, token);
ok('按站点与任务过滤互不串台', bySite.json.data.total >= 1 && byTask.json.data.rows.every((r) => r.kind === 'mail'), `站点=${bySite.json.data.total} 任务=${byTask.json.data.total}`);
const missingRecord = await api(`/records/${crypto.randomUUID()}`, {}, token);
ok('未知记录详情返回 404', missingRecord.status === 404, String(missingRecord.status));
const missingShot = await api(`/records/${crypto.randomUUID()}/screenshot`, {}, token);
ok('无截图记录返回 404', missingShot.status === 404, String(missingShot.status));

// ⑥ 发送任务边界：授权、变量渲染、附件、去重、编辑
const realSendNoProfile = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: '关沙箱但没选账号', subject: 's', body_html: '<p>b</p>', dry_run: false }) }, token);
ok('关闭沙箱必须选发信邮箱(400)', realSendNoProfile.status === 400, `${realSendNoProfile.status} ${realSendNoProfile.json?.message}`);
const shortTask = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: '', subject: 's', body_html: '<p>b</p>' }) }, token);
ok('任务必填项缺失被拒(400)', shortTask.status === 400, `${shortTask.status} ${shortTask.json?.message}`);

const task2 = (await api('/mail-tasks', {
  method: 'POST',
  body: JSON.stringify({
    title: '变量渲染与附件演练',
    subject: '{{name}} 的核验提醒',
    body_html: `<html><body><p>{{name}}（{{email}}）请点 <a href="${CAPTURE_BASE}/">立即核验</a></p></body></html>`,
  }),
}, token)).json.data;
ok('任务默认继承配置的发送间隔', task2.send_interval_ms === cfg.mail.default_send_interval_ms, `interval=${task2.send_interval_ms} 配置=${cfg.mail.default_send_interval_ms}`);
const emptySend = await api(`/mail-tasks/${task2.id}/send`, { method: 'POST' }, token);
ok('没有收件人时拒绝发送(400)', emptySend.status === 400 && String(emptySend.json?.message).includes('收件人'), `${emptySend.status} ${emptySend.json?.message}`);

const jsonImport = await api(`/mail-tasks/${task2.id}/recipients`, { method: 'POST', body: JSON.stringify({ recipients: [{ email: 'qianqi@corp.example', name: '钱七' }, { email: 'not-an-email', name: '坏数据' }] }) }, token);
ok('收件人也支持 JSON 数组导入', jsonImport.json.data.added === 1 && jsonImport.json.data.invalid === 1, JSON.stringify(jsonImport.json.data));
const dupImport = await api(`/mail-tasks/${task2.id}/recipients`, { method: 'POST', body: JSON.stringify({ text: 'qianqi@corp.example,钱七' }) }, token);
ok('同一任务内重复邮箱自动去重', dupImport.json.data.added === 0 && dupImport.json.data.skipped === 1, JSON.stringify(dupImport.json.data));

const attachmentUpload = await fetch(`${API}/mail-tasks/${task2.id}/attachment`, {
  method: 'POST',
  headers: { 'x-alab-token': token },
  body: (() => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('演练附件：核验清单', 'utf8')], { type: 'text/plain' }), 'checklist.txt');
    return form;
  })(),
});
const attachmentJson = await attachmentUpload.json();
ok('任务附件上传成功', attachmentJson.code === 0 && attachmentJson.data?.name === 'checklist.txt' && attachmentJson.data?.size > 0, JSON.stringify(attachmentJson.data));
const noFileUpload = await fetch(`${API}/mail-tasks/${task2.id}/attachment`, { method: 'POST', headers: { 'x-alab-token': token }, body: new FormData() });
ok('空附件请求被拒(400)', noFileUpload.status === 400, String(noFileUpload.status));

const send2 = await api(`/mail-tasks/${task2.id}/send`, { method: 'POST' }, token);
ok('第二个任务沙箱发送成功', send2.json?.data?.sent === 1 && send2.json?.data?.dry_run === true, JSON.stringify(send2.json?.data));
const task2Detail = (await api(`/mail-tasks/${task2.id}`, {}, token)).json.data;
const eml2File = path.join(DATA_DIR, 'outbox', `${task2.id.slice(0, 8)}-qianqi@corp.example.eml`);
const eml2 = fs.existsSync(eml2File) ? fs.readFileSync(eml2File, 'utf8') : '';
const body2 = emlPartText(eml2, (p) => /Content-Type:\s*text\/html/i.test(p));
ok('正文按收件人渲染姓名与邮箱', body2.includes('钱七') && body2.includes('qianqi@corp.example'), `正文=${body2.length}B ${path.basename(eml2File)}`);
const subject2 = decodeMimeHeader((eml2.match(/^Subject:[\s\S]*?(?=\r?\n[^ \t])/m) || [''])[0]).replace(/\s+/g, '');
ok('邮件标题同样吃变量', !eml2.includes('{{name}}') && subject2.includes('钱七的核验提醒'), subject2);
const attach2 = emlPartText(eml2, (p) => /Content-Disposition:\s*attachment/i.test(p));
ok('沙箱邮件带上任务附件', /Content-Disposition:\s*attachment/i.test(eml2) && eml2.includes('checklist.txt') && attach2 === '演练附件：核验清单', JSON.stringify(attach2));
ok('任务状态推进到已发送', task2Detail.task.status === 'sent' && task2Detail.recipients[0].status === 'sandboxed', `${task2Detail.task.status}/${task2Detail.recipients[0].status}`);
const task2Row = (await api('/mail-tasks?page=1&page_size=50', {}, token)).json.data.rows.find((r) => r.id === task2.id);
ok('任务列表带出收件人计数', task2Row?.stats?.total === 1 && task2Row.stats.sandboxed === 1, JSON.stringify(task2Row?.stats));
ok('任务列表把沙箱标志归一成布尔', task2Row?.dry_run === true, String(task2Row?.dry_run));
const taskEdit = await api(`/mail-tasks/${task2.id}`, { method: 'PUT', body: JSON.stringify({ title: '改名后的任务', send_interval_ms: 1234, attachment_reset: true }) }, token);
ok('编辑任务可改名并清附件', taskEdit.json?.data?.title === '改名后的任务' && taskEdit.json?.data?.send_interval_ms === 1234 && taskEdit.json?.data?.attachment_name === null, JSON.stringify(taskEdit.json?.data?.attachment_name));
const taskMissing = await api(`/mail-tasks/${crypto.randomUUID()}`, {}, token);
ok('未知任务返回 404', taskMissing.status === 404, String(taskMissing.status));

// ⑦ 模型服务与密钥：读取一律掩码，且掩码回填不能把真 key 洗成星号
const aiUnconfigured = await api('/ai/generate', { method: 'POST', body: JSON.stringify({ site_name: '测试页' }) }, token);
const seenAuth = [];
let failUpstream = false;
const modelSink = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    seenAuth.push(String(req.headers.authorization || ''));
    if (failUpstream) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"upstream boom"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '```html\n<form><input name="account"><button data-al-collect>登录</button></form>\n```' } }], usage: { total_tokens: 12 } }));
  });
});
await new Promise((r) => modelSink.listen(0, '127.0.0.1', r));
const modelPort = modelSink.address().port;
ok('未配置模型服务时给出可读指引(400)', aiUnconfigured.status === 400 && String(aiUnconfigured.json?.message).includes('模型服务'), `${aiUnconfigured.status} ${aiUnconfigured.json?.message}`);

const AI_KEY = 'sk-e2e-realsecret';
const aiSave = await api('/settings/ai', { method: 'PUT', body: JSON.stringify({ value: { providers: [{ id: 'local', name: '本地假模型', base_url: `http://127.0.0.1:${modelPort}/v1`, model: 'test-model', api_key: AI_KEY }] } }) }, token);
ok('保存后读取只回掩码', aiSave.json?.data?.providers?.[0]?.api_key === '******' && !JSON.stringify(aiSave.json).includes(AI_KEY), `api_key=${aiSave.json?.data?.providers?.[0]?.api_key}`);
const settingsRead = await api('/settings', {}, token);
ok('设置接口不泄露明文密钥', !JSON.stringify(settingsRead.json).includes(AI_KEY) && settingsRead.json?.data?.ai?.providers?.[0]?.api_key === '******');

// 界面把掩码原样回填再保存，等价于「不改这枚 key」
await api('/settings/ai', { method: 'PUT', body: JSON.stringify({ value: settingsRead.json.data.ai }) }, token);
const generated = await api('/ai/generate', { method: 'POST', body: JSON.stringify({ provider_id: 'local', site_name: '内网门户', fields: ['account'] }) }, token);
ok('掩码回填不覆盖真实密钥', seenAuth.includes(`Bearer ${AI_KEY}`), seenAuth.join('|'));
ok('AI 产出剥掉围栏并自带体检', generated.json?.data?.html?.startsWith('<form>') === true && generated.json?.data?.diagnose?.checks?.length === 5, JSON.stringify(generated.json?.data?.html?.slice(0, 20)));

// 仿站会把「要仿冒谁」交给外部模型，这一步必须站在授权门禁之后
const cloneOutScope = await api('/ai/generate', { method: 'POST', body: JSON.stringify({ provider_id: 'local', site_name: '内部门户 payroll.unapproved.example.net' }) }, token);
ok(
  '仿站目标越出授权名单被拒(400)',
  cloneOutScope.status === 400 && /授权名单/.test(cloneOutScope.json?.message || ''),
  `${cloneOutScope.status} ${cloneOutScope.json?.message}`
);
const cloneWithMail = await api('/ai/generate', { method: 'POST', body: JSON.stringify({ provider_id: 'local', prompt: '复刻 example.com 的登录页，先给 zhangsan@example.com 发提醒' }) }, token);
ok(
  '提示词里的员工邮箱被拦下不发外部模型(400)',
  cloneWithMail.status === 400 && /邮箱/.test(cloneWithMail.json?.message || ''),
  `${cloneWithMail.status} ${cloneWithMail.json?.message}`
);
const cloneInScope = await api('/ai/generate', { method: 'POST', body: JSON.stringify({ provider_id: 'local', site_name: '内部门户 portal.demo.cn index.html 版式' }) }, token);
ok('名单内目标照常生成，且文件名后缀不当作域名', cloneInScope.status === 200 && !!cloneInScope.json?.data?.html, `${cloneInScope.status} ${cloneInScope.json?.message}`);
const plainProvider = await api(
  '/settings/ai',
  { method: 'PUT', body: JSON.stringify({ value: { providers: [{ id: 'plain', name: '公网明文厂商', base_url: 'http://ai.example.org/v1', model: 'm', api_key: 'sk-plain' }] } }) },
  token
);
ok(
  '公网明文 http 的模型地址被拒(400)',
  plainProvider.status === 400 && /https/.test(plainProvider.json?.message || ''),
  `${plainProvider.status} ${plainProvider.json?.message}`
);

// 改名是设置界面里的正常操作：行身份由服务端补齐并随掩码一起回显，改名字不能把密钥当成新行丢掉
const legacySave = await api(
  '/settings/ai',
  { method: 'PUT', body: JSON.stringify({ value: { providers: [{ name: '本地假模型', base_url: `http://127.0.0.1:${modelPort}/v1`, model: 'test-model', api_key: AI_KEY }] } }) },
  token
);
const legacyId = legacySave.json?.data?.providers?.[0]?.id;
ok('不带 id 的保存会补齐行身份', typeof legacyId === 'string' && legacyId.length > 8, String(legacyId));
await api(
  '/settings/ai',
  { method: 'PUT', body: JSON.stringify({ value: { providers: [{ id: legacyId, name: '改名后的模型', base_url: `http://127.0.0.1:${modelPort}/v1`, model: 'test-model', api_key: '******' }] } }) },
  token
);
const renamedGen = await api('/ai/generate', { method: 'POST', body: JSON.stringify({ provider_id: legacyId, prompt: 'x' }) }, token);
ok('厂商改名后原密钥仍归这一行', renamedGen.status === 200 && seenAuth.includes(`Bearer ${AI_KEY}`), `${renamedGen.status} ${seenAuth.slice(-1).join('|')}`);
// 对不上号的掩码还原不出任何密钥，宁可留空让界面提示未设置，也不能把一串星号当密钥发给上游
const orphanSave = await api(
  '/settings/ai',
  { method: 'PUT', body: JSON.stringify({ value: { providers: [{ name: '凭空出现的厂商', base_url: `http://127.0.0.1:${modelPort}/v1`, model: 'test-model', api_key: '******' }] } }) },
  token
);
const orphanId = orphanSave.json?.data?.providers?.[0]?.id;
const orphanGen = await api('/ai/generate', { method: 'POST', body: JSON.stringify({ provider_id: orphanId, prompt: 'x' }) }, token);
ok('无法对应的掩码不会落成密钥', orphanGen.status === 400 && !seenAuth.includes('Bearer ******'), `${orphanGen.status} ${seenAuth.slice(-1).join('|')}`);
await api(
  '/settings/ai',
  { method: 'PUT', body: JSON.stringify({ value: { providers: [{ id: 'local', name: '本地假模型', base_url: `http://127.0.0.1:${modelPort}/v1`, model: 'test-model', api_key: AI_KEY }] } }) },
  token
);

failUpstream = true;
const upstreamDown = await api('/ai/generate', { method: 'POST', body: JSON.stringify({ provider_id: 'local', prompt: 'x' }) }, token);
ok('模型服务异常转成 502 且不吞原因', upstreamDown.status === 502 && String(upstreamDown.json?.message).includes('500'), `${upstreamDown.status} ${upstreamDown.json?.message}`);
modelSink.close();
await api('/settings/ai', { method: 'PUT', body: JSON.stringify({ value: { providers: [], api_key: '' } }) }, token);
const pushEcho = await api('/settings', {}, token);
ok('推送配置读回仍是保存的那份', pushEcho.json?.data?.push?.enabled === false && Array.isArray(pushEcho.json?.data?.push?.channels), JSON.stringify(pushEcho.json?.data?.push));
const unknownSetting = await api('/settings/ai', { method: 'PUT', body: '{}' }, token);
ok('缺少 value 的配置写入被拒(400)', unknownSetting.status === 400, String(unknownSetting.status));

// ⑧ 导出记录：数据出机器必须可追溯
const mailExport = await fetch(`${API}/reports/export?kind=mail`, { headers: { 'x-alab-token': token } });
// Response.text() 会吃掉 UTF-8 BOM，Excel 兼容用的前三个字节只能按字节断言
const mailCsvBytes = new Uint8Array(await mailExport.arrayBuffer());
const mailCsv = Buffer.from(mailCsvBytes).toString('utf8');
ok(
  '邮件侧导出换新命名且带 Excel 兼容 BOM',
  String(mailExport.headers.get('content-disposition')).includes('awarelab-mail-evidence.csv')
    && mailCsvBytes[0] === 0xef && mailCsvBytes[1] === 0xbb && mailCsvBytes[2] === 0xbf
    && Buffer.from(mailCsvBytes.slice(3)).toString('utf8').startsWith('"记录UUID"'),
  `${String(mailExport.headers.get('content-disposition'))} / ${Array.from(mailCsvBytes.slice(0, 3)).join(',')}`
);
const exportLogs = await poll(
  () => api('/push-logs?page=1&page_size=50', {}, token),
  (r) => (r.json?.data?.rows || []).some((row) => row.channel === 'export')
);
const exportLog = (exportLogs.json?.data?.rows || []).find((row) => row.channel === 'export');
ok(
  '导出动作在通知记录里记录',
  exportLog?.event_kind === 'csv_export' && JSON.parse(exportLog.request || '{}').kind === 'mail' && exportLog.ok === 1,
  exportLog ? `${exportLog.channel}/${exportLog.response}` : '无导出日志'
);

// ⑨ 站点生命周期：先建后开、改绑模板、删站不删证
const site2 = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: template.json.data.id, listen_port: CAPTURE_PORT + 3, status: 'closed' }) }, token);
ok('可按 closed 建站暂不监听', site2.json?.data?.status === 'closed' && site2.json?.data?.running === false, JSON.stringify({ status: site2.json?.data?.status, running: site2.json?.data?.running }));
const closedProbe = await hostProbe('127.0.0.1', '/', CAPTURE_PORT + 3);
ok('未开启的端口不服务', closedProbe.status === 0, String(closedProbe.status));
const startedSite = await api(`/web-sites/${site2.json.data.id}/start`, { method: 'POST' }, token);
await sleep(400);
ok('手动开启后回到监听中', startedSite.json?.data?.running === true && (await fetch(`http://127.0.0.1:${CAPTURE_PORT + 3}/`)).status === 200);
const rebind = await api(`/web-sites/${site2.json.data.id}`, { method: 'PUT', body: JSON.stringify({ template_id: halfDone.json.data.id }) }, token);
const reboundHtml = await (await fetch(`http://127.0.0.1:${CAPTURE_PORT + 3}/`)).text();
ok('改绑模板后监听当场换新内容', rebind.json?.data?.running === true && reboundHtml.includes('仍然没有采集入口'), `${reboundHtml.length}B`);
await engagePost(CAPTURE_PORT + 3, { ev: 'submit', tk: 'e2ewave-site2', dwell: 5, fields: { username: 'keepme' } });
const tlsHalf = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: template.json.data.id, listen_port: CAPTURE_PORT + 4, tls_cert: '-----BEGIN CERTIFICATE-----abc' }) }, token);
ok('只给证书不给私钥被拒(400)', tlsHalf.status === 400 && String(tlsHalf.json?.message).includes('私钥'), `${tlsHalf.status} ${tlsHalf.json?.message}`);
const badTemplateSite = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: 'no-such-template', listen_port: CAPTURE_PORT + 5 }) }, token);
ok('模板不存在时拒绝建站(400)', badTemplateSite.status === 400 && String(badTemplateSite.json?.message).includes('模板'), `${badTemplateSite.status} ${badTemplateSite.json?.message}`);
const deletedSite = await api(`/web-sites/${site2.json.data.id}`, { method: 'DELETE' }, token);
await sleep(200);
const orphanRecords = await api(`/records?site_id=${site2.json.data.id}`, {}, token);
ok('删站点停监听但不删证据', deletedSite.json?.data === true && (await hostProbe('127.0.0.1', '/', CAPTURE_PORT + 3)).status === 0 && orphanRecords.json.data.total === 1, `残留证据=${orphanRecords.json.data.total}`);
const orphanDetail = await api(`/records/${orphanRecords.json.data.rows[0].id}`, {}, token);
ok('站点已删的记录仍可读且不留假模板名', orphanDetail.json?.data?.context?.template_name === null, String(orphanDetail.json?.data?.context?.template_name));
const deleteMissingSite = await api(`/web-sites/${crypto.randomUUID()}`, { method: 'DELETE' }, token);
ok('删除不存在站点返回 404', deleteMissingSite.status === 404, String(deleteMissingSite.status));

// ⑩ 上钩记录按投放载体分组：每一个钓鱼网页、每一封钓鱼邮件各成一组，看板的数字必须等于点进去那一屏
const groups = (await api('/records/groups', {}, token)).json?.data;
const pageGroup = groups?.web?.find((g) => g.id === site.json.data.id);
const pageDrill = await api(`/records?kind=web&site_id=${site.json.data.id}&page_size=200`, {}, token);
ok(
  '钓鱼网页分组带模板名、监听端口与上钩计数',
  pageGroup?.label === template.json.data.name &&
    pageGroup?.listen_port === CAPTURE_PORT &&
    pageGroup?.exists === true &&
    pageGroup?.running === true &&
    pageGroup?.terminals >= 1 &&
    pageGroup?.submitted >= 1 &&
    pageGroup?.page_opens >= 1 &&
    pageGroup?.submits >= 1 &&
    pageGroup?.field_names?.includes('username'),
  JSON.stringify(pageGroup)
);
ok('网页看板的条数点进去就是这么多', pageDrill.json?.data?.total === pageGroup?.terminals, `看板=${pageGroup?.terminals} 下钻=${pageDrill.json?.data?.total}`);
ok(
  '转化率按已提交除以上钩终端',
  pageGroup?.conversion === Math.round((pageGroup.submitted / pageGroup.terminals) * 1000) / 10,
  `conversion=${pageGroup?.conversion}`
);

const mailGroup = groups?.mail?.find((g) => g.id === task.json.data.id);
const mailDrill = await api(`/records?task_id=${task.json.data.id}&page_size=200`, {}, token);
ok(
  '钓鱼邮件分组带任务标题、收件人数与邮件打开计数',
  mailGroup?.label === task.json.data.title &&
    mailGroup?.recipients >= 1 &&
    mailGroup?.mail_opens >= 1 &&
    mailGroup?.terminals >= 1,
  JSON.stringify(mailGroup)
);
ok('邮件看板的条数点进去就是这么多', mailDrill.json?.data?.total === mailGroup?.terminals, `看板=${mailGroup?.terminals} 下钻=${mailDrill.json?.data?.total}`);
ok(
  '一封邮件没钓到人也在看板挂着',
  groups?.mail?.some((g) => g.id === task2.id && g.terminals === 0 && g.exists === true),
  JSON.stringify(groups?.mail?.find((g) => g.id === task2.id))
);

const goneGroup = groups?.web?.find((g) => g.id === site2.json?.data?.id);
ok(
  '收网删站后它的证据仍自成一格',
  goneGroup?.exists === false && goneGroup?.terminals === 1 && String(goneGroup?.label).includes('已删除'),
  JSON.stringify(goneGroup)
);
const unassignedRows = await api('/records?unassigned=1&page_size=200', {}, token);
ok(
  '未归属一格与过滤结果一致，且不吞掉已归属的记录',
  unassignedRows.json?.data?.total === groups?.unassigned?.terminals &&
    !(unassignedRows.json?.data?.rows || []).some((r) => String(r.token).startsWith('e2ewave-')),
  `看板=${groups?.unassigned?.terminals} 下钻=${unassignedRows.json?.data?.total}`
);
ok('分组统计对上全库记录数', groups?.totals?.terminals === (await api('/records?page_size=1', {}, token)).json?.data?.total, JSON.stringify(groups?.totals));

// ---------- 8. 授权收口 ----------
const shortened = await api(
  `/authorizations/${authId}`,
  { method: 'PUT', body: JSON.stringify({ ...editInput, start_at: new Date(Date.now() - 2 * 86400_000).toISOString(), end_at: new Date(Date.now() - 3600_000).toISOString() }) },
  token
);
ok(
  '缩短有效期即停止站点监听',
  shortened.json?.data?.effective === 'expired' && shortened.json?.data?.stopped_sites >= 1,
  `effective=${shortened.json?.data?.effective} stopped=${shortened.json?.data?.stopped_sites}`
);
const afterShorten = await hostProbe('127.0.0.1');
ok('缩窗后端口不再服务', afterShorten.status === 0 || afterShorten.status === 404 || afterShorten.body.includes('演练'), String(afterShorten.status));

// 授权同样拦发送：若存在他人登记的生效授权，发送 legitimately 放行，此断言无从验证
if (activeOthers.length) {
  skip('无生效授权时拒绝发送', `存在非本脚本登记的生效授权「${activeOthers[0].scope}」，跳过以免干扰真实演练`);
} else {
  const blockedSend = await api(`/mail-tasks/${task.json.data.id}/send`, { method: 'POST' }, token);
  ok('无生效授权时拒绝发送(403)', blockedSend.status === 403, `${blockedSend.status} ${blockedSend.json?.message}`);
}

const restored = await api(`/authorizations/${authId}`, { method: 'PUT', body: JSON.stringify(editInput) }, token);
ok('有效期恢复后授权重新生效', restored.json?.data?.effective === 'active', `effective=${restored.json?.data?.effective}`);

const revoke1 = await api(`/authorizations/${authId}/revoke`, { method: 'POST' }, token);
ok('吊销授权', revoke1.json?.data === true);
await sleep(400);
let revokeState = 'connection_refused';
try {
  const afterRevoke = await fetch(`${CAPTURE_BASE}/`);
  revokeState = `${afterRevoke.status} ${((await afterRevoke.text()).includes('演练') ? '拦截页' : '仍在服务')}`;
} catch {
  /* 监听已关闭 */
}
ok('吊销授权后站点停止服务', revokeState === 'connection_refused' || revokeState.includes('拦截页'), revokeState);

// 授权一关，公开的附件回传通道也要跟着闭嘴：转发出去多年的令牌不该还能往库里写
const afterRevokeCallback = await fetch(`${BASE}/alab/v2/callback?tk=${recipient.token}`, {
  method: 'POST',
  body: (() => {
    const fd = new FormData();
    fd.append('hostname', 'STILL-SENDING');
    return fd;
  })(),
});
const revokeRun = await afterRevokeCallback.json();
ok(
  '授权吊销后同一令牌的回传被拒(410)',
  afterRevokeCallback.status === 410 && /授权/.test(revokeRun?.message || ''),
  `${afterRevokeCallback.status} ${revokeRun?.message}`
);

const editRevoked = await api(`/authorizations/${authId}`, { method: 'PUT', body: JSON.stringify(editInput) }, token);
ok('已吊销授权不可修改(409)', editRevoked.status === 409, `${editRevoked.status} ${editRevoked.json?.message}`);
const editMissing = await api(`/authorizations/${crypto.randomUUID()}`, { method: 'PUT', body: JSON.stringify(editInput) }, token);
ok('未知授权修改返回 404', editMissing.status === 404, `${editMissing.status} ${editMissing.json?.message}`);

// 沙箱开关翻页要当场留痕：这是"会不会真的寄到员工邮箱"的唯一人工闸门
await api(`/mail-tasks/${task.json.data.id}`, { method: 'PUT', body: JSON.stringify({ dry_run: false }) }, token);
const toggleBack = await api(`/mail-tasks/${task.json.data.id}`, { method: 'PUT', body: JSON.stringify({ dry_run: true }) }, token);
const toggleAudit = await api('/audit-logs?action=mail_task.sandbox_toggle&page=1&page_size=20', {}, token);
const toggleRows = (toggleAudit.json?.data?.rows || []).filter((r) => r.target_id === task.json.data.id);
ok(
  '沙箱开关每次翻动都留痕且记有前后状态',
  toggleBack.json?.data?.dry_run === 1 && toggleRows.length === 2 && toggleRows.some((r) => r.detail?.from === 'sandbox' && r.detail?.to === 'real') && toggleRows.some((r) => r.detail?.from === 'real' && r.detail?.to === 'sandbox'),
  `翻动 ${toggleRows.length} 次：${toggleRows.map((r) => `${r.detail?.from}->${r.detail?.to}`).join(' / ')}`
);

// 建站授权只看「当前是否存在生效授权」：有他人生效授权时建站是正当行为，
// 但绝不为验证授权而新建站点，否则会在真实演练进行中留下无人认领的监听端口。
if (activeOthers.length) {
  skip('吊销自建授权后仍拒绝建站', `存在非本脚本登记的生效授权「${activeOthers[0].scope}」，跳过以免干扰真实演练`);
} else {
  const gateAfterRevoke = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: template.json.data.id, listen_port: CAPTURE_PORT + 2 }) }, token);
  ok('无生效授权时再次拒绝建站(403)', gateAfterRevoke.status === 403, String(gateAfterRevoke.status));
  const gateAfterRevokeClone = await api('/ai/generate', { method: 'POST', body: JSON.stringify({ provider_id: 'local', site_name: '内网门户' }) }, token);
  ok(
    '无生效授权时拒绝一键仿站(403)',
    gateAfterRevokeClone.status === 403 && /演练授权/.test(gateAfterRevokeClone.json?.message || ''),
    `${gateAfterRevokeClone.status} ${gateAfterRevokeClone.json?.message}`
  );
}

// ---------- 9. 清理（只回收本脚本创建的演练资产） ----------
async function softDelete(pathname) {
  try {
    await api(pathname, { method: 'DELETE' }, token);
  } catch {
    /* 清理尽力而为 */
  }
}
async function allRecords(query) {
  const rows = [];
  for (let page = 1; page <= 20; page += 1) {
    const data = (await api(`/records?page=${page}&page_size=200&${query}`, {}, token)).json?.data;
    rows.push(...(data?.rows || []));
    if (!data?.rows?.length || rows.length >= data.total) break;
  }
  return rows;
}
for (const siteKey of [site.json.data.id, site2.json?.data?.id]) {
  if (!siteKey) continue;
  for (const row of await allRecords(`site_id=${siteKey}`)) await softDelete(`/records/${row.id}`);
}
await softDelete(`/mail-tasks/${task.json.data.id}`);
await softDelete(`/mail-tasks/${task2.id}`);
await softDelete(`/smtp-profiles/${profile.json.data.id}`);
for (const id of (await api('/mail-templates', {}, token)).json.data.rows.filter((r) => r.name === '邮箱密码到期提醒').map((r) => r.id)) await softDelete(`/mail-templates/${id}`);
await softDelete(`/web-sites/${site.json.data.id}`);
for (const id of (await api('/web-templates', {}, token)).json.data.rows.filter((r) => ['账号安全核验', '半成品'].includes(r.name)).map((r) => r.id)) await softDelete(`/web-templates/${id}`);
const leftovers = (await allRecords(`site_id=${site.json.data.id}`)).length + (await allRecords(`site_id=${site2.json?.data?.id}`)).length;
ok('清理自建演练资产', leftovers === 0, `残留记录=${leftovers}`);
const orphanTokens = (await allRecords('page_size=200')).filter((r) => String(r.token || '').startsWith('e2ewave-'));
ok('自建令牌不留孤儿证据', orphanTokens.length === 0, orphanTokens.map((r) => r.token).join(','));

// ---------- 10. 操作审计：这一轮跑过的每个高危动作都要能在库里对上人和时间 ----------
async function allAudit(query = '') {
  const rows = [];
  for (let page = 1; page <= 20; page += 1) {
    const data = (await api(`/audit-logs?page=${page}&page_size=200&${query}`, {}, token)).json?.data;
    rows.push(...(data?.rows || []));
    if (!data?.rows?.length || rows.length >= data.total) break;
  }
  return rows;
}
const REQUIRED_ACTIONS = [
  'authorization.create',
  'authorization.update',
  'authorization.revoke',
  'mail_task.sandbox_toggle',
  'mail_task.sandbox_send',
  'mail_task.delete',
  'evidence.export',
  'evidence.delete',
  'site.delete',
  'settings.update',
];
// 逐个动作查存在性，而不是只看最新一页：审计越跑越长，截页会假阴
const auditRows = await allAudit();
const missingActions = REQUIRED_ACTIONS.filter((action) => !auditRows.some((row) => row.action === action));
ok('六类高危动作全部留痕', missingActions.length === 0, `缺少：${missingActions.join(',') || '无'}｜共 ${auditRows.length} 条`);
ok(
  '每条审计都带操作人、来源地址和时间',
  auditRows.length > 0 && auditRows.every((row) => row.actor && row.ip && row.created_at && row.id),
  `${auditRows[0]?.actor}@${auditRows[0]?.ip}`
);
const settingsAudits = auditRows.filter((row) => row.action === 'settings.update');
ok(
  '审计详情掩码机器人令牌，不当第二份密码本',
  !JSON.stringify(settingsAudits).includes(ROBOT_TOKEN) && JSON.stringify(settingsAudits).includes('******'),
  String(JSON.stringify(settingsAudits.find((row) => row.detail?.channels?.length)?.detail?.channels?.[0]?.url || '')).slice(0, 90)
);
const auditFilter = await api('/audit-logs?action=authorization.revoke&page=1&page_size=50', {}, token);
const actorOnly = await api(`/audit-logs?actor=${encodeURIComponent(cfg.panel.username)}`, {}, token);
ok(
  '审计可按动作与操作人过滤',
  (auditFilter.json?.data?.rows || []).length >= 1
    && auditFilter.json.data.rows.every((row) => row.action === 'authorization.revoke')
    && actorOnly.json?.data?.total === auditRows.length,
  `吊销 ${auditFilter.json?.data?.total} 条 / 本人 ${actorOnly.json?.data?.total} 条`
);
ok(
  '审计记录的是被吊销的那条授权',
  auditRows.some((row) => row.action === 'authorization.revoke' && row.target_id === authId),
  String(auditRows.find((row) => row.action === 'authorization.revoke')?.target_id)
);

console.log(lines.join('\n'));
console.log(`\n共 ${lines.length} 项，失败 ${failures} 项，跳过 ${lines.filter((l) => l.startsWith('SKIP')).length} 项`);
