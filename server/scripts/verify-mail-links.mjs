/**
 * 邮件跳转端口回归：起一个隔离实例，走完「授权 → 复制内置页面/邮件 → 建站 → 建任务绑站 → 加收件人 → 沙箱发送」，
 * 然后直接读 outbox 里的 .eml，断言里面的追踪链接与信标都指向钓鱼站端口，而不是后台面板端口。
 *
 * 用法：node scripts/verify-mail-links.mjs
 * 隔离目录 .verify-mail（config/data/outbox 都在里面），不碰 server/data 与 server/config.yaml。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';

const SERVER_ROOT = path.resolve(import.meta.dirname, '..');
const WORK = path.join(SERVER_ROOT, '.verify-mail');
const CONFIG_FILE = path.join(WORK, 'config.yaml');
const DATA_DIR = path.join(WORK, 'data');
const PANEL_PORT = 4311;
const SITE_PORT = 8201;
const PANEL_PATH = 'authcheck';
const USER = 'checker';
const PASS = 'checkpass123';
const BASE = `http://127.0.0.1:${PANEL_PORT}/${PANEL_PATH}/api`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

let failures = 0;
function check(label, cond, extra = '') {
  const mark = cond ? '  ok ' : 'FAIL ';
  if (!cond) failures += 1;
  console.log(`${mark}${label}${extra ? `  (${extra})` : ''}`);
}

function prepare() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    CONFIG_FILE,
    yaml.dump({
      panel: {
        path: PANEL_PATH,
        port: PANEL_PORT,
        bind: '127.0.0.1',
        username: USER,
        password: PASS,
        password_updated_at: new Date().toISOString(),
      },
      capture: { port_range: [8200, 8299], bind_host: '127.0.0.1' },
      mail: { default_dry_run: true, default_send_interval_ms: 0 },
      exercise: { require_authorization: true },
    }),
    'utf8'
  );
}

async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/alab/health`);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('面板未在 15 秒内就绪');
}

async function api(method, url, body, token) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-alab-token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应留给下面的断言报错 */
  }
  // 信封是 {code:0,data}，业务失败 code 非 0；不按 HTTP 状态判断是因为部分门禁也用 200 回业务错误
  if (!res.ok || json?.code !== 0) {
    throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
  }
  return json.data;
}

/** 从 outbox 里找最新一封 .eml：沙箱模式只落盘不外发，正好拿来读原始报文。 */
function latestEml() {
  const root = path.join(DATA_DIR, 'outbox');
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith('.eml')) files.push({ full, mtime: stat.mtimeMs });
    }
  };
  walk(root);
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0]?.full || null;
}

async function main() {
  prepare();
  const child = spawn(process.execPath, ['src/boot/main.js'], {
    cwd: SERVER_ROOT,
    env: { ...process.env, AWARELAB_CONFIG: CONFIG_FILE, AWARELAB_DATA: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  try {
    await waitReady();
    const { token } = await api('POST', '/auth/login', { username: USER, password: PASS });

    // 1) 授权（承诺原文由后端下发，与前端弹窗写回的是同一句）
    const pledge = await api('GET', '/authorizations/pledge', undefined, token);
    const now = Date.now();
    await api(
      'POST',
      '/authorizations',
      {
        scope: '端口回归演练',
        contact: 'QA',
        start_at: new Date(now - 3600_000).toISOString(),
        end_at: new Date(now + 7 * 86400_000).toISOString(),
        allowed_hosts: ['#ip', '127.0.0.1'],
        pledge: pledge.pledge,
      },
      token
    );

    // 2) 从内置模板库各复制一份：证明升级后的数据确实可用，而不是只存在于 seed 里
    const lib = await api('GET', '/library', undefined, token);
    check('内置模板库可读', lib.pages.length > 0 && lib.mails.length > 0, `页面 ${lib.pages.length} / 邮件 ${lib.mails.length}`);
    const page = await api('POST', '/library/use', { kind: 'page', key: lib.pages[0].key }, token);
    const mail = await api('POST', '/library/use', { kind: 'mail', key: lib.mails[0].key }, token);
    check('内置页面可复制', !!page.id);
    check('内置邮件可复制', !!mail.id);

    // 3) 建站：监听 8201，模拟真实部署里的"钓鱼站在 8080、面板在 7778"
    const site = await api(
      'POST',
      '/web-sites',
      { name: '端口回归站', template_id: page.id, listen_ip: '127.0.0.1', listen_port: SITE_PORT },
      token
    );
    check('站点已创建', site.listen_port === SITE_PORT);

    // 4) 邮件任务显式绑定该站点，正文同时用 {{site_url}} 与站点的绝对地址
    const body = [
      '<p>请点击 <a href="{{site_url}}/login">这里登录</a> 查看。</p>',
      `<p>备用地址 <a href="${SITE}/notice">备用入口</a>。</p>`,
    ].join('');
    const task = await api(
      'POST',
      '/mail-tasks',
      { title: '端口回归任务', subject: '账号异常提醒', body_html: body, mail_template_id: null, site_id: site.id },
      token
    );
    await api('POST', `/mail-tasks/${task.id}/recipients`, { text: 'victim@example.com' }, token);
    const sent = await api('POST', `/mail-tasks/${task.id}/send`, {}, token);
    check('沙箱发送成功', sent.total === 1 && sent.sent === 1, JSON.stringify(sent));

    // 5) 读原始报文：链接主机必须是 8201，不能出现面板的 4311
    const eml = latestEml();
    check('找到沙箱 .eml', !!eml, eml || '');
    const raw = eml ? fs.readFileSync(eml, 'utf8') : '';
    const decoded = raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
    const hrefs = [...decoded.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
    const siteLinks = hrefs.filter((h) => h.includes(`:${SITE_PORT}/alab/v2/`));
    check('报文中含站点端口的追踪链接', siteLinks.length >= 2, `命中 ${siteLinks.length} 条`);
    check('报文中不含面板端口', !hrefs.some((h) => h.includes(`:${PANEL_PORT}/`)), hrefs.slice(0, 3).join(' | '));
    check('链接指向 trace 端点', siteLinks.some((h) => h.includes('/alab/v2/trace')));
    check('信标指向 pixel 端点', siteLinks.some((h) => h.includes('/alab/v2/pixel')));

    // 6) 真访问这两个端点：trace 应 302 回钓鱼页，pixel 应回 1×1 GIF
    const trace = siteLinks.find((h) => h.includes('/alab/v2/trace'));
    if (trace) {
      const res = await fetch(trace, { redirect: 'manual' });
      check('站点端口上的 trace 可用', res.status === 302, `HTTP ${res.status}`);
      const loc = res.headers.get('location') || '';
      check('trace 跳回钓鱼页', loc.startsWith(SITE), loc);
    }
    const pixel = siteLinks.find((h) => h.includes('/alab/v2/pixel'));
    if (pixel) {
      const res = await fetch(pixel);
      check('站点端口上的 pixel 可用', res.ok && /image\/gif/.test(res.headers.get('content-type') || ''), `HTTP ${res.status}`);
    }

    // 7) 平台里只有一台开启中的站点时，未绑定的任务也能落到它上面（只传一台就没有歧义）
    const loose = await api(
      'POST',
      '/mail-tasks',
      { title: '未绑定站点的任务', subject: 'x', body_html: '<a href="{{site_url}}/login">登录</a>', site_id: null },
      token
    );
    check('未绑定站点的任务已创建', !!loose.id);
    await api('POST', `/mail-tasks/${loose.id}/recipients`, { text: 'victim2@example.com' }, token);
    const looseSent = await api('POST', `/mail-tasks/${loose.id}/send`, {}, token);
    check('唯一开启站点可作为兜底', looseSent.sent === 1, JSON.stringify(looseSent));

    // 8) 把站点全停了再发：{{site_url}} 无站可指，必须 400 并提示先绑定，而不是悄悄回落到面板端口
    await api('POST', `/web-sites/${site.id}/stop`, {}, token);
    const loose2 = await api(
      'POST',
      '/mail-tasks',
      { title: '无站可指的任务', subject: 'x', body_html: '<a href="{{site_url}}/login">登录</a>', site_id: null },
      token
    );
    // 先补一个收件人：否则 400 可能来自"没有待发送收件人"，把真正要验的门禁挡在后面
    await api('POST', `/mail-tasks/${loose2.id}/recipients`, { text: 'victim3@example.com' }, token);
    let blocked = false;
    let message = '';
    try {
      await api('POST', `/mail-tasks/${loose2.id}/send`, {}, token);
    } catch (err) {
      blocked = true;
      message = err.message;
    }
    check('无开启站点时 {{site_url}} 被拦下', blocked && /site_url|绑定/.test(message), message.slice(0, 160));

    // 9) 钓鱼页在停站前可访问（tk 令牌走通）；先开回来再访问
    await api('POST', `/web-sites/${site.id}/start`, {}, token);
    const pageRes = await fetch(`${SITE}/`);
    const pageHtml = await pageRes.text();
    check('钓鱼页可访问', pageRes.ok && /<form|<input/.test(pageHtml), `HTTP ${pageRes.status}`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    if (failures) {
      console.log('\n--- 服务器日志尾部 ---');
      console.log(logs.join('').slice(-3000));
    }
  }

  console.log(failures ? `\n共 ${failures} 项断言失败` : '\n全部断言通过');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
