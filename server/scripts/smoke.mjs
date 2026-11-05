/**
 * 只读体检：对着已经在跑的服务发只读请求，不建站点、不发信、不写库。完整闭环在 selftest.mjs。
 * 用法：先起服务，再 node scripts/smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import yaml from 'js-yaml';

/** 与 src/security/session.js 的 TOKEN_HEADER 一致；不 import 源码，免得自检脚本另开一条库连接 */
const SESSION_HEADER = 'x-alab-token';

const cfg = yaml.load(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'config.yaml'), 'utf8'));
const PANEL = cfg.panel.path;
const BASE = 'http://127.0.0.1:' + cfg.panel.port;
const API = BASE + '/' + PANEL + '/api';
const PORT_RANGE = cfg.capture.port_range || [];

const out = [];
const ok = (name, cond, extra = '') => {
  out.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -> ' + extra : ''));
  if (!cond) process.exitCode = 1;
};
const skip = (name, extra = '') => out.push('SKIP  ' + name + (extra ? '  -> ' + extra : ''));

async function api(p, opts, token) {
  const res = await fetch(API + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { [SESSION_HEADER]: token } : {}), ...(opts && opts.headers) },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

/** 列表接口两种返回（数组 / {rows,total}），统一成条数 */
const countOf = (data) =>
  Array.isArray(data) ? data.length : Array.isArray(data && data.rows) ? (data.total != null ? data.total : data.rows.length) : null;

/** 用原始 http 打钓鱼网站：fetch 不允许覆盖 Host 头 */
function probeCapture(port, hostHeader) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', headers: { Host: hostHeader } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.code) }));
    req.end();
  });
}

const root = await fetch(BASE + '/', { redirect: 'manual' });
ok(
  '根路径跳转管理面入口',
  [301, 302, 307, 308].indexOf(root.status) >= 0 && (root.headers.get('location') || '').indexOf(PANEL) >= 0,
  root.status + ' ' + root.headers.get('location')
);

const healthRes = await fetch(BASE + '/alab/health');
ok('信标面自检 /alab/health', healthRes.status === 200 && (await healthRes.text()) === 'ok');

// 废弃端点必须已下线：多一个可枚举的公开入口就多一分暴露面
for (const legacy of ['/status', '/beacon/open.gif', '/api/mail_login']) {
  const dead = await fetch(BASE + legacy);
  ok('废弃约定端点不再服务 ' + legacy, dead.status === 404, String(dead.status));
}

const login = await api('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username: cfg.panel.username, password: cfg.panel.password }),
});
const token = login.json && login.json.data ? login.json.data.token : null;
ok(
  '管理员登录',
  !!token,
  token ? login.status + ' ' + token.slice(0, 8) + '…' : login.status + ' ' + JSON.stringify(login.json).slice(0, 120)
);
if (!token) {
  console.log(out.join('\n'));
  process.exit(1);
}
const me = await api('/auth/me', {}, token);
ok('会话头鉴权可用', me.status === 200 && me.json.data.username === cfg.panel.username, me.json.data && me.json.data.username);
const badToken = await api('/auth/me', {}, 'not-a-real-token');
ok('无效令牌被拒(401)', badToken.status === 401, String(badToken.status));

const LISTINGS = [
  ['演练授权', '/authorizations'],
  ['钓鱼网站', '/web-sites'],
  ['假登录页', '/web-templates'],
  ['邮件文案', '/mail-templates'],
  ['发送任务', '/mail-tasks'],
  ['学习页', '/learn-pages'],
  ['上钩记录', '/records?page=1&page_size=1'],
  ['发信邮箱', '/smtp-profiles'],
];
for (const item of LISTINGS) {
  const res = await api(item[1], {}, token);
  const count = countOf(res.json && res.json.data);
  ok(item[0] + '列表可读', res.status === 200 && res.json.code === 0 && count !== null, res.status + ' ' + count);
}

// 发信口令只以掩码出网，列表回明文会把凭据带进浏览器与网络面板
const profileRows = ((await api('/smtp-profiles', {}, token)).json.data || {}).rows || [];
if (profileRows.length) {
  ok('发信邮箱口令掩码回显', profileRows.every((p) => p.pass === '******'), profileRows.length + ' 个账号');
} else {
  skip('发信邮箱口令掩码回显', '尚未登记发信邮箱');
}

const settings = (await api('/settings', {}, token)).json.data || {};
ok(
  '运行参数读取正确',
  settings.panel_path === PANEL &&
    settings.panel_port === cfg.panel.port &&
    Array.isArray(settings.capture_port_range) &&
    settings.mail_default_dry_run === cfg.mail.default_dry_run,
  '端口区间=' + settings.capture_port_range + ' 沙箱=' + settings.mail_default_dry_run + ' 授权硬性要求=' + settings.require_authorization
);
ok('邮件默认沙箱发送', settings.mail_default_dry_run === true, String(settings.mail_default_dry_run));
ok('授权硬性要求开启', settings.require_authorization === true, String(settings.require_authorization));

const home = (await api('/stats/home', {}, token)).json.data || {};
ok(
  '统计接口形状完整',
  !!home.basic && !!home.web_stats && !!home.mail_stats && !!home.funnel && Array.isArray(home.site_overview),
  '监听中=' + home.basic.running_sites + ' 打开=' + home.web_stats.opened + ' 提交=' + home.web_stats.submitted +
    ' 转化率=' + home.web_stats.conversion + '% 风险分=' + home.basic.risk_score
);
const ports = home.basic.listen_ports || [];
ok(
  '监听端口都在配置区间内',
  ports.every((p) => p >= PORT_RANGE[0] && p <= PORT_RANGE[1]),
  ports.length ? ports.join(',') : '当前无监听；区间 ' + PORT_RANGE.join('-')
);

const openSites = (home.site_overview || []).filter((x) => x.status === 'open');
if (openSites.length) {
  for (const site of openSites) {
    const denied = await probeCapture(site.port, 'not-allowed.example.org');
    ok(
      '站点 :' + site.port + ' 拒绝授权名单外的域名且不泄露内部词',
      denied.status === 404 &&
        /页面不存在|无法访问/.test(denied.body) &&
        !/授权|演练|采集/.test(denied.body) &&
        denied.body.indexOf('alab-boot') < 0,
      denied.status + ' ' + denied.body.slice(0, 40)
    );
  }
} else {
  skip('钓鱼网站域名准入', '当前没有开启中的钓鱼网站');
}

// 无生效授权时建站与发送会被拒，属预期
const authRows = (await api('/authorizations', {}, token)).json.data || [];
const live = authRows.find((a) => a.effective === 'active');
if (live) {
  ok('存在生效授权', !!live.scope, '「' + live.scope + '」至 ' + live.end_at);
} else {
  skip('存在生效授权', '已登记 ' + authRows.length + ' 份，无生效中的授权；此时建站与发送会被拒绝，属授权预期');
}

console.log(out.join('\n'));
console.log('\n共 ' + out.length + ' 项，失败 ' + out.filter((l) => l.indexOf('FAIL') === 0).length + ' 项');
