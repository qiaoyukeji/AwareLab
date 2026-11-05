/**
 * 观测大屏回归：起一个隔离实例，走完「授权 → 建站 → 建任务 → 沙箱发送 → 制造一次打开/提交」，
 * 再逐个打 /stats/screens 与 /stats/screen?kind=all|site|task，断言三块屏的数据口径与字段齐全。
 *
 * 用法：node scripts/verify-screens.mjs
 * 隔离目录 .verify-screens（config/data/outbox 都在里面），不碰 server/data 与 server/config.yaml。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';

const SERVER_ROOT = path.resolve(import.meta.dirname, '..');
const WORK = path.join(SERVER_ROOT, '.verify-screens');
const CONFIG_FILE = path.join(WORK, 'config.yaml');
const DATA_DIR = path.join(WORK, 'data');
const PANEL_PORT = 4312;
const SITE_PORT = 8202;
const PANEL_PATH = 'screencheck';
const USER = 'screenchecker';
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
  if (!res.ok || json?.code !== 0) {
    throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
  }
  return json.data;
}

/** 业务失败也走 200 的接口（大屏 400/404），单独要状态码与信封。 */
async function rawApi(url, token) {
  const res = await fetch(`${BASE}${url}`, { headers: { 'x-alab-token': token } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
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

    // 1) 授权：大屏的 meta.authorization 要靠它，没授权时投屏页也要能显示"未登记"
    const pledge = await api('GET', '/authorizations/pledge', undefined, token);
    const now = Date.now();
    await api(
      'POST',
      '/authorizations',
      {
        scope: '大屏回归演练',
        contact: 'QA',
        start_at: new Date(now - 3600_000).toISOString(),
        end_at: new Date(now + 7 * 86400_000).toISOString(),
        allowed_hosts: ['#ip', '127.0.0.1'],
        pledge: pledge.pledge,
      },
      token
    );

    // 2) 内置页面 → 站点 8202；内置邮件 → 绑定该站点的任务
    const lib = await api('GET', '/library', undefined, token);
    const page = await api('POST', '/library/use', { kind: 'page', key: lib.pages[0].key }, token);
    const site = await api(
      'POST',
      '/web-sites',
      { name: '大屏回归站', template_id: page.id, listen_ip: '127.0.0.1', listen_port: SITE_PORT },
      token
    );
    const task = await api(
      'POST',
      '/mail-tasks',
      {
        title: '大屏回归任务',
        subject: '会议邀请确认',
        body_html: '<p><a href="{{site_url}}/login">查看邀请</a></p>',
        site_id: site.id,
      },
      token
    );
    await api('POST', `/mail-tasks/${task.id}/recipients`, { text: 'a@example.com\nb@example.com' }, token);
    const sent = await api('POST', `/mail-tasks/${task.id}/send`, {}, token);
    check('沙箱发送成功', sent.sent === 2, JSON.stringify(sent));

    // 3) 制造一条"邮件打开 + 网页打开 + 提交"的完整链路
    const detail = await api('GET', `/mail-tasks/${task.id}`, undefined, token);
    const recipient = detail.recipients.find((r) => r.token);
    check('收件人拿到专属令牌', !!recipient?.token);
    await fetch(`${SITE}/alab/v2/pixel?tk=${recipient.token}&task=${task.id}`);
    await fetch(`${SITE}/alab/v2/trace?tk=${recipient.token}&url=${encodeURIComponent(`${SITE}/login`)}`, {
      redirect: 'manual',
    });
    const pageRes = await fetch(`${SITE}/login?tk=${recipient.token}`);
    check('钓鱼页带令牌可访问', pageRes.ok, `HTTP ${pageRes.status}`);
    const engage = await fetch(`${SITE}/alab/v2/engage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ev: 'submit', tk: recipient.token, fields: { username: 'zhangsan', password: 'Passw0rd!' } }),
    });
    check('提交事件被接收', engage.ok, `HTTP ${engage.status}`);

    // 4) 目录：总屏 + 1 个站点 + 1 个任务
    const screens = await api('GET', '/stats/screens', undefined, token);
    check('总屏存在', screens.overall?.kind === 'all');
    check('站点目录含本站', screens.sites.some((s) => s.id === site.id && s.opened >= 1), JSON.stringify(screens.sites));
    check('任务目录含本任务', screens.tasks.some((t) => t.id === task.id && t.recipients === 2), JSON.stringify(screens.tasks));

    // 5) 总屏：网站墙 + 任务墙都要有，且嵌套数据可点
    const overall = await api('GET', '/stats/screen?kind=all', undefined, token);
    check('总屏 meta 正确', overall.meta.kind === 'all' && overall.meta.id === 'all');
    check('总屏含网站墙', Array.isArray(overall.boards?.sites) && overall.boards.sites.length === 1);
    check('总屏含任务墙', Array.isArray(overall.boards?.tasks) && overall.boards.tasks.length === 1);
    check('总屏记录流非空', overall.records.length >= 1, `${overall.records.length} 条`);
    check('总屏已提交数 >= 1', overall.web_stats.submitted >= 1, JSON.stringify(overall.web_stats));
    check('总屏邮件漏斗可读', overall.mail_stats?.recipients === 2, JSON.stringify(overall.mail_stats));
    check('总屏不含明文表单', !('form_json' in (overall.records[0] || {})));

    // 6) 站点屏：标题用素材名、records 只含本站、boards 应为 null
    const siteScreen = await api('GET', `/stats/screen?kind=site&id=${site.id}`, undefined, token);
    check('站点屏 meta 正确', siteScreen.meta.kind === 'site' && siteScreen.meta.id === site.id);
    check('站点屏标题取素材名', siteScreen.meta.title.includes('企业邮箱'), siteScreen.meta.title);
    check('站点屏含对外地址', !!siteScreen.site?.url, siteScreen.site?.url);
    check('站点屏记录只含本站', siteScreen.records.every((r) => r.site_id === site.id), `${siteScreen.records.length} 条`);
    check('站点屏无网站墙', siteScreen.boards === null);
    check('站点屏统计邮件导流', siteScreen.web_stats.mail_source >= 1, JSON.stringify(siteScreen.web_stats));
    check('站点屏平均停留为数字', Number.isFinite(siteScreen.web_stats.avg_dwell));

    // 7) 任务屏：曲线走邮件侧、漏斗用收件人做分母
    const taskScreen = await api('GET', `/stats/screen?kind=task&id=${task.id}`, undefined, token);
    check('任务屏 meta 正确', taskScreen.meta.kind === 'task' && taskScreen.meta.id === task.id);
    check('任务屏含任务信息', taskScreen.task?.id === task.id && !!taskScreen.task?.subject);
    check('任务屏收件人为 2', taskScreen.mail_stats?.recipients === 2, JSON.stringify(taskScreen.mail_stats));
    check('任务屏已打开 >= 1', taskScreen.mail_stats?.opened >= 1, JSON.stringify(taskScreen.mail_stats));
    check('任务屏趋势 7 天', taskScreen.trend.length === 7);

    // 8) 错误分支：非法 kind 400、缺 id 400、对象不存在 404
    const badKind = await rawApi('/stats/screen?kind=robot', token);
    check('非法 kind 回 400', badKind.status === 400 && /all/.test(badKind.json?.message || ''));
    const noId = await rawApi('/stats/screen?kind=site', token);
    check('分屏缺 id 回 400', noId.status === 400);
    const missing = await rawApi('/stats/screen?kind=task&id=not-exist', token);
    check('对象不存在回 404', missing.status === 404, `HTTP ${missing.status}`);
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
