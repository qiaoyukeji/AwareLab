// AwareLab QA 用例套件：安全性 / 功能 / 流程 / 文案四类，跑在 server/.qa 隔离实例（面板 4222，采集 8231-8239）。
// 会真实建站监听并投递沙箱邮件，但不写 server/data 的操作员演练数据。
// 用法：node scripts/qa.mjs [--only=S,F] [--case=TC-S-11] [--keep]，结果写 .qa/qa-result.json 供测试报告引用。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import yaml from 'js-yaml';

const SERVER_ROOT = path.resolve(import.meta.dirname, '..');
const QA_ROOT = path.join(SERVER_ROOT, '.qa');
const CONFIG_FILE = path.join(QA_ROOT, 'config.yaml');
const DATA_DIR = path.join(QA_ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'awarelab.db');
const RESULT_FILE = path.join(QA_ROOT, 'qa-result.json');

const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const PANEL_PORT = Number(process.env.QA_PANEL_PORT || 4222);
const PORT = { main: 8231, dup: 8232, gate: 8233, expire: 8234, race: 8235, bind: 8236, big: 8237, closed: 8238, shape: 8239 };
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const randomString = (len) => Array.from(crypto.randomBytes(len), (b) => ALPHABET[b % ALPHABET.length]).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const onlyArg = flags.find((a) => a.startsWith('--only='));
const caseArg = flags.find((a) => a.startsWith('--case='));
const onlyCats = onlyArg ? onlyArg.slice(7).toUpperCase().split(/[^SFPU]+/).filter(Boolean) : ['S', 'F', 'P', 'U'];
const onlyIds = caseArg ? caseArg.slice(7).toUpperCase().split(/[^A-Z0-9-]+/).filter(Boolean) : null;
const want = (id) => (onlyIds ? onlyIds.includes(id.toUpperCase()) : onlyCats.includes(id.split('-')[1][0]));

const PLEDGE = '我承诺仅在授权范围内使用本平台开展安全意识演练';
const OWN_NOTE = 'qa 自动化用例产生的临时数据';
/** 掩码串写死字面量而不是 import secretMask.js：断言要验管理面确实把这个串返回给了前端 */
const MASK = '••••••••';
const HOSTS = ['qa.example.com', '127.0.0.1'];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const MZ = Buffer.concat([Buffer.from('MZ\u0090\u0000\u0003', 'latin1'), Buffer.alloc(64, 7)]);
/** 协议 v2 声明式模板：form + data-al-ignore + 显式提交按钮 */
const TEMPLATE_HTML = `<form data-al-collect action="/login" method="post">
  <input name="username" type="text">
  <input name="password" type="password">
  <input name="captcha" type="text" data-al-ignore>
  <button type="submit">登 录</button>
</form>`;
const XSS_PAYLOAD = '<img src=x onerror=alert(1)>';

function writeConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const panelPassword = randomString(8);
  fs.writeFileSync(
    CONFIG_FILE,
    yaml.dump({
      // password_updated_at 必须写：缺这一项建站闸门判为出厂口令未改，POST /web-sites 一律 409
      panel: {
        path: crypto.randomBytes(16).toString('hex'),
        port: PANEL_PORT,
        bind: '127.0.0.1',
        username: randomString(8),
        password: panelPassword,
        password_updated_at: new Date().toISOString(),
      },
      capture: {
        port_range: [8000, 9999],
        // 只绑本机：用例期间会真开监听，不该把仿冒页挂进局域网
        bind_host: '127.0.0.1',
        callback: { max_file_mb: 5, max_files_per_request: 3, max_fields: 40, per_token_per_minute: 10, per_ip_per_minute: 200, screenshot_quota_mb: 512 },
      },
      mail: { default_dry_run: true, default_send_interval_ms: 50 },
      exercise: { require_authorization: true },
      session_ttl_hours: 12,
    }),
    'utf8'
  );
  return panelPassword;
}

let child = null;
let bootLog = '';

function startServer() {
  const done = { exited: false, code: null, log: '' };
  const proc = spawn(process.execPath, [path.join(SERVER_ROOT, 'src/boot/main.js')], {
    cwd: SERVER_ROOT,
    env: { ...process.env, AWARELAB_CONFIG: CONFIG_FILE, AWARELAB_DATA: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', (buf) => { done.log += buf.toString(); });
  proc.on('exit', (code) => { done.exited = true; done.code = code; });
  return { proc, done };
}

function stopServer(proc) {
  return new Promise((resolve) => {
    // 已退出的子进程不会再发 exit 事件，只等 once('exit') 会永久挂住
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const finish = () => {
      clearTimeout(killer);
      resolve();
    };
    const killer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      finish();
    }, 5000);
    killer.unref();
    proc.once('exit', finish);
    proc.once('close', finish);
    try {
      proc.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
    } catch {
      finish();
    }
  });
}

async function waitForHealth(state) {
  for (let i = 0; i < 90; i += 1) {
    if (state.exited) throw new Error(`服务提前退出（code=${state.code}）：\n${state.log.slice(-900)}`);
    try {
      const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/alab/health`);
      if (res.ok) return;
    } catch { /* 端口还没就绪 */ }
    await sleep(150);
  }
  throw new Error(`等待服务健康检查超时（端口 ${PANEL_PORT}）：\n${state.log.slice(-900)}`);
}

/** Windows 强杀后端口释放有延迟，绑定失败就重试 */
async function launch() {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const started = startServer();
    child = started.proc;
    try {
      await waitForHealth(started.done);
      bootLog += started.done.log;
      return started.done.log;
    } catch (err) {
      await stopServer(child);
      child = null;
      if (attempt === 4) throw err;
      await sleep(800);
    }
  }
  return '';
}

/** 重启隔离实例。登录失败计数落库后重启不再清零，只有回传限流这类纯内存桶才靠重启复位 */
async function restart() {
  await stopServer(child);
  child = null;
  await sleep(500);
  return launch();
}

async function restartWithConfig(patch) {
  const current = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...(current[key] || {}), ...value } : value;
  }
  fs.writeFileSync(CONFIG_FILE, yaml.dump(merged), 'utf8');
  cfg.panel = merged.panel;
  cfg.capture = merged.capture;
  return restart();
}

// 断言与运行

const CASES = [];
const tc = (id, name, fn) => CASES.push({ id, name, fn, cat: id.split('-')[1][0] });
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
  return msg;
}
/** 前置夹具装不出来（环境/顺序问题），不算产品缺陷：抛 Blocked，让后续用例按 SKIP 记账 */
class Blocked extends Error {}
const blocked = (msg) => { throw new Blocked(msg); };

const cfg = { panel: { path: '', port: PANEL_PORT, bind: '127.0.0.1', username: '', password: '' }, capture: { port_range: [8000, 9999], bind_host: '127.0.0.1', callback: {} } };
let API = '';
let TOKEN = '';
let db = null;

async function api(p, opts = {}, token = TOKEN) {
  const res = await fetch(API + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-alab-token': token } : {}), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, json, text, headers: res.headers };
}
const data = (r) => r.json?.data;
const message = (r) => String(r.json?.message ?? '');

/** 原始 HTTP 请求：Host、Cookie、X-Forwarded-For 都要自己控；fetch 藏 Set-Cookie、禁改 Host */
function raw({ port = PANEL_PORT, method = 'GET', pathname = '/', headers = {}, body }) {
  return new Promise((resolve) => {
    const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: { ...(payload ? { 'content-length': String(payload.length) } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: bytes.toString('utf8'), bytes });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e.code || e.message), bytes: Buffer.alloc(0) }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 采集面：要带授权名单内的 Host 头才过门禁，也不该带管理面令牌 */
const cap = (pathname = '/', { host = 'qa.example.com', method = 'GET', port = PORT.main, body, headers = {}, cookie } = {}) =>
  raw({ port, method, pathname, headers: { Host: host, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body });

/** 信标面与回传面：公开无鉴权，落在管理面端口上 */
const beacon = ({ method = 'GET', pathname = '/', headers = {}, body } = {}) =>
  raw({ method, pathname, headers: { Host: `127.0.0.1:${PANEL_PORT}`, ...headers }, body });

function multipart(parts, boundary = `----qa${randomString(10)}`) {
  const chunks = [];
  for (const p of parts) {
    const disposition = `Content-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}`;
    const type = p.filename ? `Content-Type: ${p.type || 'application/octet-stream'}\r\n` : '';
    chunks.push(Buffer.from(`--${boundary}\r\n${disposition}\r\n${type}\r\n`, 'utf8'));
    chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(String(p.value ?? ''), 'binary'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

const upload = ({ tk, mail = '', parts }) => {
  const mp = multipart(parts);
  return beacon({
    method: 'POST',
    pathname: `/alab/v2/callback?tk=${encodeURIComponent(tk)}&mail=${encodeURIComponent(mail)}`,
    headers: mp.headers,
    body: mp.body,
  });
};

const q = encodeURIComponent;
const count = (sql, params = []) => db.prepare(sql).all(...params);
const rowCount = (sql, params = []) => count(sql, params)[0]?.n ?? 0;
const outboxEml = () => (fs.existsSync(path.join(DATA_DIR, 'outbox')) ? fs.readdirSync(path.join(DATA_DIR, 'outbox')).filter((f) => f.endsWith('.eml')) : []);

// 前置夹具

/** 夹具一律按需、可重入：不依赖上一个用例留下的数据，--only=U 单跑也能自足 */
function effectiveOf(row) {
  if (!row || row.status !== 'active') return row?.status ?? 'missing';
  const now = Date.now();
  if (new Date(row.start_at).getTime() > now) return 'pending';
  if (new Date(row.end_at).getTime() < now) return 'expired';
  return 'active';
}

async function createAuthorization({ scope = 'QA 用例授权', start_at, end_at, hosts = HOSTS, pledge = PLEDGE, note = OWN_NOTE, contact = 'qa@awarelab.test' } = {}) {
  const res = await api('/authorizations', {
    method: 'POST',
    body: JSON.stringify({
      scope,
      contact,
      start_at: start_at ?? new Date(Date.now() - 60_000).toISOString(),
      end_at: end_at ?? new Date(Date.now() + 3_600_000).toISOString(),
      pledge,
      allowed_hosts: hosts,
      note,
    }),
  });
  if (res.status !== 200) blocked(`前置授权登记失败：${res.status} ${message(res)}`);
  return data(res);
}

/** 有一条落在窗口内的授权就复用它，没有就现登记一条 */
async function activeAuth() {
  const rows = count('SELECT * FROM authorizations ORDER BY created_at DESC');
  const live = rows.find((row) => effectiveOf(row) === 'active');
  if (live) return live;
  return createAuthorization({ scope: 'QA 主线演练' });
}

async function clearAuthorizations() {
  const listed = await api('/authorizations');
  for (const row of data(listed) ?? []) {
    if (row.status === 'active') await api(`/authorizations/${row.id}/revoke`, { method: 'POST' });
  }
}

async function freshAuthorization(patch = {}) {
  await clearAuthorizations();
  return createAuthorization(patch);
}

async function createTemplate(name, html = TEMPLATE_HTML, extra = {}) {
  const res = await api('/web-templates', { method: 'POST', body: JSON.stringify({ name, type: '表单', html, ...extra }) });
  if (res.status !== 200) blocked(`前置模板登记失败：${res.status} ${message(res)}`);
  return data(res);
}

async function ensureTemplate(name = 'QA 采集模板') {
  const listed = await api('/web-templates?page=1&page_size=200');
  const hit = (data(listed)?.rows ?? []).find((row) => row.name === name);
  return hit ?? (await createTemplate(name));
}

/** 指定端口上必须有一张符合预期的网；端口被旧站点或失效授权占着就先收网再重建 */
async function ensureSite(port, { status = 'open', template, domain = 'qa.example.com' } = {}) {
  const tpl = template ?? (await ensureTemplate());
  const auth = await activeAuth();
  const listed = await api('/web-sites');
  const hit = (data(listed)?.rows ?? []).find((row) => row.listen_port === port);
  const bound = hit ? count('SELECT authorization_id AS a FROM web_sites WHERE id=?', [hit.id])[0]?.a : null;
  // 授权被吊销或缩窗后旧站点会一直 403；绑的不是当前这条就得重建，否则后面的用例全跑在失效的站上
  if (hit && hit.status === status && Boolean(hit.running) === (status === 'open') && bound === auth.id) {
    if (hit.template_id !== tpl.id) {
      const patched = await api(`/web-sites/${hit.id}`, { method: 'PUT', body: JSON.stringify({ template_id: tpl.id }) });
      if (patched.status !== 200) blocked(`前置站点改绑模板失败：${patched.status} ${message(patched)}`);
      return data(patched);
    }
    return hit;
  }
  if (hit) await api(`/web-sites/${hit.id}`, { method: 'DELETE' });
  const res = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: tpl.id, listen_port: port, domain, status }) });
  if (res.status !== 200) blocked(`前置建站失败（端口 ${port}）：${res.status} ${message(res)}`);
  const row = data(res);
  if (status === 'open' && !row.running) {
    for (let i = 0; i < 25 && !row.running; i += 1) {
      await sleep(120);
      row.running = (await listSites()).find((s) => s.id === row.id)?.running ?? false;
    }
  }
  return row;
}

const listSites = async () => (await api('/web-sites')).json?.data?.rows ?? [];

/** 签发专属链接：同邮箱复用同一令牌；要新令牌的用例换邮箱 */
async function issueLink(siteId, email = 'target@qa.test', name = '访客一号') {
  const listed = await api(`/web-sites/${siteId}/links`);
  const hit = (data(listed)?.rows ?? []).find((row) => row.target_email === email);
  if (hit) return hit;
  const res = await api(`/web-sites/${siteId}/links`, { method: 'POST', body: JSON.stringify({ email, name }) });
  if (res.status !== 200) blocked(`前置签发链接失败：${res.status} ${message(res)}`);
  const row = data(res);
  // 列表把令牌叫 token、签发响应叫 tk；夹具统一成 token，用例不依赖这个差异
  return { ...row, token: row.token ?? row.tk };
}

let linkSeq = 0;
async function freshLink(prefix = 'link') {
  linkSeq += 1;
  const site = await ensureSite(PORT.main);
  return issueLink(site.id, `${prefix}${linkSeq}@qa.test`, `访客${linkSeq}`);
}

async function world() {
  const template = await ensureTemplate();
  const auth = await activeAuth();
  const site = await ensureSite(PORT.main, { template });
  const link = await issueLink(site.id);
  return { auth, template, site, link, tk: link.token };
}

/** 清 login_failures 表：多条用例要故意刷满 8 次失败，留下的锁会把后面的 login() 全连坐成 429 */
function unlockLogins() {
  if (!db) return;
  db.prepare('DELETE FROM login_failures').run();
}

async function loginAgain(password = cfg.panel.password) {
  const res = await api(
    '/auth/login',
    { method: 'POST', body: JSON.stringify({ username: cfg.panel.username, password }) },
    null
  );
  return res;
}

async function login() {
  const fileCfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
  cfg.panel = fileCfg.panel;
  cfg.capture = fileCfg.capture;
  API = `http://127.0.0.1:${fileCfg.panel.port}/${fileCfg.panel.path}/api`;
  let res = await loginAgain();
  if (res.status === 429) {
    unlockLogins();
    res = await loginAgain();
  }
  if (!res.json?.data?.token) throw new Error(`登录失败，无法装配用例：${res.status} ${res.text.slice(0, 200)}`);
  TOKEN = res.json.data.token;
}

const INSIDER_WORDS = /演练|授权|采集|仿冒|钓鱼|模板|站点|令牌|AwareLab/i;
const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

async function recreateSite(port, opts = {}) {
  const existing = (await listSites()).find((row) => row.listen_port === port);
  if (existing) await api(`/web-sites/${existing.id}`, { method: 'DELETE' });
  await sleep(150);
  return ensureSite(port, opts);
}

tc('TC-S-01', '未登录访问管理面一律 401，且不返回任何业务数据', async () => {
  const reads = ['/authorizations', '/authorizations/pledge', '/web-sites', '/web-templates', '/web-templates/types', '/mail-templates', '/mail-tasks', '/records', '/records/groups', '/smtp-profiles', '/learn-pages', '/audit-logs', '/settings', '/push-logs', '/stats/home', '/stats/bigscreen', '/reports/export?kind=web', '/auth/me'];
  const probes = [];
  for (const p of reads) probes.push([`GET ${p}`, await api(p, {}, null)]);
  probes.push(['POST /web-sites', await api('/web-sites', { method: 'POST', body: '{}' }, null)]);
  probes.push(['POST /authorizations', await api('/authorizations', { method: 'POST', body: '{}' }, null)]);
  probes.push(['POST /mail-tasks/x/send', await api('/mail-tasks/x/send', { method: 'POST', body: '{}' }, null)]);
  probes.push(['PUT /settings/push', await api('/settings/push', { method: 'PUT', body: '{"value":{}}' }, null)]);
  probes.push(['DELETE /records/x', await api('/records/x', { method: 'DELETE' }, null)]);
  const bad = probes.filter(([, r]) => r.status !== 401);
  expect(!bad.length, `以下端点未强制登录：${bad.map(([p, r]) => `${p}=${r.status}`).join(', ')}`);
  const leaked = probes.find(([, r]) => /"data":\s*\{?\s*[^nu]/.test(r.text));
  expect(!leaked, `未登录响应带出了数据体：${leaked?.[0]} ${leaked?.[1].text.slice(0, 120)}`);
  expect(message(probes[0][1]) === '未登录', `未登录文案漂移：${message(probes[0][1])}`);
  return `${probes.length} 个管理端点全部 401「未登录」，无数据外泄`;
});

tc('TC-S-02', '伪造令牌、畸形令牌与注入式令牌都被拒', async () => {
  const forged = await api('/authorizations', {}, '00000000-0000-0000-0000-000000000000');
  expect(forged.status === 401, `随机 UUID 令牌返回 ${forged.status}`);
  const junk = await api('/authorizations', {}, 'not-a-real-token');
  expect(junk.status === 401 && /重新登录/.test(message(junk)), `陌生令牌文案漂移：${message(junk)}`);
  const injection = await api('/authorizations', {}, "' OR '1'='1");
  expect(injection.status === 401, `令牌位注入返回 ${injection.status}`);
  const empty = await api('/authorizations', {}, '');
  expect(empty.status === 401 && message(empty) === '未登录', `空令牌返回 ${empty.status} ${message(empty)}`);
  return '四种非法令牌全部 401，读不到任何授权数据';
});

tc('TC-S-03', '会话到期后同一令牌立即失效', async () => {
  const login1 = await loginAgain();
  expect(login1.status === 200, `前置登录失败：${login1.status}`);
  const token = data(login1).token;
  expect((await api('/authorizations', {}, token)).status === 200, '新签发的令牌应当可用');
  db.prepare('UPDATE sessions SET expires_at=? WHERE token=?').run(Date.now() - 1000, token);
  const after = await api('/authorizations', {}, token);
  expect(after.status === 401 && /重新登录/.test(message(after)), `过期会话返回 ${after.status} ${message(after)}`);
  const viaCookie = await raw({ pathname: `/${cfg.panel.path}/api/authorizations`, headers: { Cookie: `alab_token=${token}` } });
  expect(viaCookie.status === 401, `过期会话走 Cookie 兜底仍可用（${viaCookie.status}）`);
  return '到期令牌从头与 Cookie 两条入口都被拒，并指引重新登录';
});

tc('TC-S-04', '登出后同一令牌与同一 Cookie 立刻不可用', async () => {
  const login1 = await loginAgain();
  const token = data(login1).token;
  expect((await api('/auth/me', {}, token)).status === 200, '登出前该会话应可用');
  const out = await api('/auth/logout', { method: 'POST' }, token);
  expect(out.status === 200, `登出返回 ${out.status}`);
  expect((await api('/auth/me', {}, token)).status === 401, '登出后令牌仍可用');
  const viaCookie = await raw({ pathname: `/${cfg.panel.path}/api/auth/me`, headers: { Cookie: `alab_token=${token}` } });
  expect(viaCookie.status === 401, `登出后 Cookie 兜底仍可用（${viaCookie.status}）`);
  expect(rowCount('SELECT COUNT(*) AS n FROM sessions WHERE token=?', [token]) === 0, '登出只清了界面，会话行还留在库里');
  return '登出同时作废令牌、Cookie 与库中会话';
});

tc('TC-S-05', '会话 Cookie 属性齐备（HttpOnly / SameSite / Path / Max-Age）', async () => {
  const res = await raw({
    method: 'POST',
    pathname: `/${cfg.panel.path}/api/auth/login`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.panel.username, password: cfg.panel.password }),
  });
  const cookie = res.headers['set-cookie']?.[0] || '';
  expect(/alab_token=[\w-]+/.test(cookie), `登录未下发 Cookie：${cookie}`);
  expect(/HttpOnly/.test(cookie), 'Cookie 缺 HttpOnly，XSS 可直接窃取会话');
  expect(/SameSite=Strict/.test(cookie), 'Cookie 缺 SameSite=Strict，跨站请求会带上会话');
  expect(/Path=\//.test(cookie), 'Cookie 缺 Path=/');
  expect(/Max-Age=\d+/.test(cookie) && !/Max-Age=0\b/.test(cookie), `Max-Age 与 TTL 口径不符：${cookie}`);
  const ttlSeconds = Number(cfg.session_ttl_hours ?? 12) * 3600;
  const maxAge = Number((cookie.match(/Max-Age=(\d+)/) ?? [])[1]);
  expect(maxAge > 0 && maxAge <= ttlSeconds, `Max-Age ${maxAge}s 超出配置的 ${ttlSeconds}s 会话时长`);
  return cookie.replace(/=[\w-]{16,}/, '=‹令牌›');
});

tc('TC-S-06', '访客令牌 Cookie 只归属当前浏览器，不带回任何他人数据', async () => {
  const { site, tk } = await world();
  const anonymous = await cap('/');
  const setCookie = anonymous.headers['set-cookie']?.[0] || '';
  expect(/alab_tk=[0-9a-fA-F-]{36}/.test(setCookie), `匿名访问未下发访客 Cookie：${setCookie}`);
  expect(/HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie), `访客 Cookie 属性不全：${setCookie}`);
  expect(/Max-Age=86400/.test(setCookie), `访客 Cookie 生存期异常：${setCookie}`);
  expect(!/target@qa\.test|@@|password/i.test(setCookie), '访客 Cookie 里带了归属信息或凭证');
  const anonToken = setCookie.match(/alab_tk=([0-9a-fA-F-]{36})/)[1];
  const row = count('SELECT site_id,target_email FROM capture_tokens WHERE token=?', [anonToken]);
  expect(row.length === 1 && row[0].site_id === site.id && !row[0].target_email, `匿名令牌入库归属不对：${JSON.stringify(row)}`);
  const withTk = await cap(`/?tk=${tk}`);
  expect(withTk.status === 200, `专属链接打开返回 ${withTk.status}`);
  const tkCookie = String(withTk.headers['set-cookie']?.[0] ?? '');
  expect(
    tkCookie.includes(`alab_tk=${tk}`),
    `专属链接没把身份写回 Cookie，站内跳转一次就变成匿名：${tkCookie || '（无 Set-Cookie）'}`
  );
  const followUp = await cap('/', { cookie: `alab_tk=${tk}` });
  expect(followUp.status === 200 && !followUp.headers['set-cookie'], '已带有效 Cookie 的访问又被重新发了一个身份');
  return '匿名访客 Cookie 属性齐备且只挂本站；带 tk 的访问复用既有令牌并续到 Cookie 上';
});

tc('TC-S-07', '登录失败锁定按真实连接判定：伪造 X-Forwarded-For 不重置计数', async () => {
  await restart();
  expect(cfg.panel.username, '前置配置缺失');
  const attempt = (password, xff) =>
    raw({
      method: 'POST',
      pathname: `/${cfg.panel.path}/api/auth/login`,
      headers: { 'Content-Type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
      body: JSON.stringify({ username: cfg.panel.username, password }),
    });
  // 每次失败自报一个新来源：采信这个头的话计数会摊进 8 个独立桶，永远锁不上
  for (let i = 1; i <= 8; i += 1) {
    const res = await attempt('wrong-by-design', `203.0.113.${i}, 10.0.0.9`);
    expect(res.status === 401, `伪造来源第 ${i} 次失败返回 ${res.status}`);
  }
  const spoofed = await attempt(cfg.panel.password, '203.0.113.99, 10.0.0.9');
  expect(spoofed.status === 429, `换一段伪造的 X-Forwarded-For 就解开了锁定：正确口令直接放行（${spoofed.status}）`);
  const honest = await attempt(cfg.panel.password, null);
  expect(honest.status === 429, `同一真实连接已刷满失败次数，不带伪造头的登录仍被放行（${honest.status}）`);

  // 显式声明挂了反向代理时，来源归属跟 X-Forwarded-For 走，否则共用代理地址的会被一起锁死
  await restartWithConfig({ panel: { trust_proxy: true } });
  for (let i = 1; i <= 8; i += 1) await attempt('wrong-by-design', '198.51.100.1');
  const anotherClient = await attempt(cfg.panel.password, '198.51.100.99');
  expect(anotherClient.status === 200, `信任代理时另一个来源被前一个的失败连坐（${anotherClient.status}）`);
  const sameSpoofed = await attempt(cfg.panel.password, '198.51.100.1');
  expect(sameSpoofed.status === 429, `信任代理后同一自报来源刷满 8 次却锁不住（${sameSpoofed.status}）`);

  // 本用例刷满了两个来源的失败计数；计数落库、重启不清零，留着会把后面每条 login() 锁成 429
  unlockLogins();
  await restartWithConfig({ panel: { trust_proxy: false } });
  return '默认只认 socket 对端：伪造来源头不重置计数；显式信任代理后按来源头分桶锁定';
});

tc('TC-S-08', '管理面与信标面安全头齐全，且不泄露框架指纹', async () => {
  const plane = await raw({ pathname: '/alab/health' });
  const shell = await raw({ pathname: `/${cfg.panel.path}/` });
  const loginProbe = await raw({ method: 'POST', pathname: `/${cfg.panel.path}/api/auth/login`, headers: { 'Content-Type': 'application/json' }, body: '{}' });
  for (const [label, probe] of [['信标面', plane], ['管理壳页', shell], ['登录接口', loginProbe]]) {
    const csp = probe.headers['content-security-policy'] || '';
    expect(csp.includes("default-src 'self'"), `${label} 缺 CSP`);
    expect(csp.includes("frame-ancestors 'none'"), `${label} CSP 未禁止被内嵌`);
    expect(probe.headers['x-content-type-options'] === 'nosniff', `${label} 缺 X-Content-Type-Options`);
    expect(probe.headers['x-frame-options'] === 'DENY', `${label} 缺 X-Frame-Options`);
    expect(probe.headers['referrer-policy'] === 'no-referrer', `${label} 缺 Referrer-Policy`);
    expect(!probe.headers['x-powered-by'], `${label} 泄露 X-Powered-By`);
    expect(!probe.headers['server'], `${label} 泄露 Server 头：${probe.headers['server']}`);
  }
  expect(!/express/i.test(JSON.stringify(loginProbe.headers)), '响应头里带出了框架名');
  return '三个出口均带 CSP/nosniff/XFO/Referrer，且无 X-Powered-By 与 Server 指纹';
});

tc('TC-S-09', '站点接口不回显 TLS 私钥明文', async () => {
  const pemKey = '-----BEGIN PRIVATE KEY-----\nTqFB1wCZhbqaTESTKEYnOtReAlDATA\n-----END PRIVATE KEY-----\n';
  const pemCert = '-----BEGIN CERTIFICATE-----\nTqFB1wCZhbqaTESTCERTnOtReAlDATA\n-----END CERTIFICATE-----\n';
  const site = await recreateSite(PORT.closed, { status: 'closed' });
  const patched = await api(`/web-sites/${site.id}`, { method: 'PUT', body: JSON.stringify({ tls_key: pemKey, tls_cert: pemCert }) });
  expect(patched.status === 200, `配置证书返回 ${patched.status} ${message(patched)}`);
  expect(db.prepare('SELECT tls_key FROM web_sites WHERE id=?').get(site.id).tls_key === pemKey, '私钥没进库，测试前提不成立');
  const listed = await api('/web-sites');
  const row = (data(listed)?.rows ?? []).find((r) => r.id === site.id);
  const peek = await api(`/web-sites/${site.id}/links`);
  const body = `${JSON.stringify(row)}${peek.text}`;
  expect(!body.includes(pemKey), '私钥明文出现在站点列表/回看响应里（进了浏览器与网络面板）');
  expect(body.includes('PRIVATE KEY'), '站点响应连证书都没有，界面无从判断这张网是否已配 HTTPS');
  return '私钥只留在本机库里，界面拿到的是证书与「已配置」标记';
});

tc('TC-S-10', '使用承诺必须逐字：缺省、近似、篡改都被拒', async () => {
  const base = { scope: 'QA 承诺校验', start_at: new Date(Date.now() - 60_000).toISOString(), end_at: new Date(Date.now() + 3_600_000).toISOString(), allowed_hosts: HOSTS };
  const missing = await api('/authorizations', { method: 'POST', body: JSON.stringify(base) });
  expect(missing.status === 400 && /承诺/.test(message(missing)), `缺承诺返回 ${missing.status} ${message(missing)}`);
  const loose = await api('/authorizations', { method: 'POST', body: JSON.stringify({ ...base, pledge: '我承诺仅在授权范围内使用' }) });
  expect(loose.status === 400, `半截承诺未被拒：${loose.status}`);
  const trailing = await api('/authorizations', { method: 'POST', body: JSON.stringify({ ...base, pledge: `${PLEDGE} ` }) });
  expect(trailing.status === 400, `承诺尾部多一个空格也被接受（${trailing.status}），承诺文本必须逐字`);
  const exact = await api('/authorizations', { method: 'POST', body: JSON.stringify({ ...base, pledge: PLEDGE, note: OWN_NOTE }) });
  expect(exact.status === 200, `逐字承诺应可登记：${exact.status} ${message(exact)}`);
  const listed = await api('/authorizations/pledge');
  expect(data(listed)?.pledge === PLEDGE, '接口给出的承诺文本与校验口径不一致');
  expect(String(data(listed)?.statement).length > 10, '界面缺少可展示的承诺说明');
  await api(`/authorizations/${data(exact).id}/revoke`, { method: 'POST' });
  return '四种偏差（缺省/近似/尾部空白/逐字）判定正确，接口文案与校验同源';
});

tc('TC-S-11', '授权名单外的 Host 访问采集面得到 404，不留痕且文案中性', async () => {
  await world();
  const before = rowCount('SELECT COUNT(*) AS n FROM records');
  const eventsBefore = rowCount('SELECT COUNT(*) AS n FROM events');
  const denied = await cap('/', { host: 'not-allowed.example.org' });
  expect(denied.status === 404, `名单外 Host 返回 ${denied.status}，期望 404`);
  expect(rowCount('SELECT COUNT(*) AS n FROM records') === before, '名单外访问写下了记录');
  expect(rowCount('SELECT COUNT(*) AS n FROM events') === eventsBefore, '名单外访问写下了事件');
  expect(!/<form|data-al-collect|username/i.test(denied.body), '拒绝页仍把仿冒表单渲染了出去');
  const text = stripTags(denied.body);
  expect(text.length > 0, '拒绝页是一片空白');
  expect(!INSIDER_WORDS.test(text), `访客可见页泄露内部术语：${text.slice(0, 140)}`);
  return `404 + 零留痕 + 中性文案「${text.slice(0, 40)}」`;
});

tc('TC-S-12', '吊销授权即级联下线：站点停止监听、证据保留', async () => {
  const auth = await freshAuthorization({ scope: 'QA 级联下线' });
  const site = await recreateSite(PORT.gate, { template: await ensureTemplate() });
  expect(site.running, `前置站点未在监听（${PORT.gate}）`);
  expect(site.authorization_id === auth.id || count('SELECT authorization_id FROM web_sites WHERE id=?', [site.id])[0].authorization_id === auth.id, '站点未挂到本次授权上，级联判定没有意义');
  const serving = await cap('/', { port: PORT.gate });
  expect(serving.status === 200, `吊销前本站应在服务，实际 ${serving.status}`);
  const recordsBefore = rowCount('SELECT COUNT(*) AS n FROM records');
  const revoked = await api(`/authorizations/${auth.id}/revoke`, { method: 'POST' });
  expect(revoked.status === 200, `吊销返回 ${revoked.status} ${message(revoked)}`);
  expect((data(revoked) === true || rowCount("SELECT id FROM authorizations WHERE id=? AND status='revoked'", [auth.id]) === 1), '吊销后库里状态未变');
  await sleep(400);
  const after = (await listSites()).find((row) => row.id === site.id);
  expect(after && after.running === false, `吊销后本站点仍在监听：${JSON.stringify(after)?.slice(0, 120)}`);
  expect(rowCount("SELECT COUNT(*) AS n FROM web_sites WHERE authorization_id=? AND status='open'", [auth.id]) === 0, '库里仍留着 open 状态的站点');
  expect(rowCount('SELECT COUNT(*) AS n FROM records') === recordsBefore, '吊销连带删掉了已采集的证据');
  return `级联下线本站点、库里状态收口、${recordsBefore} 条证据原样保留`;
});

tc('TC-S-13', '无授权时投放动作全部 403（建站、开站、签链接、发信、仿站），收网不受门禁影响', async () => {
  await clearAuthorizations();
  const sites = await listSites();
  if (!sites.length) blocked('前置库中没有站点，无法验证开站与收网的门禁差异');
  const probes = [
    ['建站', await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: (await ensureTemplate()).id, listen_port: PORT.gate + 40 }) })],
    ['开启站点', await api(`/web-sites/${sites[0].id}/start`, { method: 'POST' })],
    ['签发链接', await api(`/web-sites/${sites[0].id}/links`, { method: 'POST', body: JSON.stringify({ email: 'a@awarelab.test' }) })],
    ['建邮件任务', await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: 't', subject: 's', body_html: 'b' }) })],
    ['一键仿站', await api('/ai/generate', { method: 'POST', body: JSON.stringify({ prompt: '做一个登录页', site_name: '办公系统' }) })],
  ];
  const bad = probes.filter(([, r]) => r.status !== 403);
  expect(!bad.length, `未拦截的投放动作：${bad.map(([n, r]) => `${n}=${r.status}`).join(', ')}`);
  expect(probes.every(([, r]) => /「演练授权」/.test(message(r))), '门禁文案未点名界面');
  // 收网是撤下页面的动作，任何时候都得放行：授权出问题时第一件事就是把仿冒页摘掉
  const stop = await api(`/web-sites/${sites[0].id}/stop`, { method: 'POST' });
  expect(stop.status === 200, `无授权时收网被门禁挡住（${stop.status} ${message(stop)}）`);
  await activeAuth();
  return '5 类投放动作全部 403 且文案统一指向「演练授权」，收网照常放行';
});

tc('TC-S-14', '采集面上报体超 512KB 被切断且不落库', async () => {
  const { tk } = await world();
  const before = rowCount('SELECT COUNT(*) AS n FROM records');
  const huge = JSON.stringify({ ev: 'submit', tk, dwell: 10, fields: { username: 'a'.repeat(600 * 1024) } });
  const res = await cap('/alab/v2/engage', { method: 'POST', body: huge });
  expect(res.status === 0 || res.status >= 400, `超限上报返回 ${res.status}，闸门未生效`);
  expect(rowCount('SELECT COUNT(*) AS n FROM records') === before, `超限上报写了 ${rowCount('SELECT COUNT(*) AS n FROM records') - before} 条记录`);
  const normal = await cap('/alab/v2/engage', { method: 'POST', body: JSON.stringify({ ev: 'submit', tk, dwell: 8, fields: { username: 'ok@awarelab.test', password: 'pw' } }) });
  expect(normal.status === 200 && jsonOf(normal)?.data?.accepted, `正常体量上报被误伤（${normal.status}）`);
  return `超限连接被拒（${res.status || '已断开'}），闸门后正常上报仍可通行`;
});

tc('TC-S-15', '管理面请求体超 8MB 返回 413，中文可读且无堆栈', async () => {
  const huge = JSON.stringify({ scope: 'x'.repeat(9 * 1024 * 1024), start_at: '2026-01-01T00:00:00Z', end_at: '2026-12-31T00:00:00Z', pledge: PLEDGE, allowed_hosts: HOSTS });
  const res = await raw({ method: 'POST', pathname: `/${cfg.panel.path}/api/authorizations`, headers: { 'Content-Type': 'application/json', 'x-alab-token': TOKEN }, body: huge });
  expect(res.status === 413, `超限请求返回 ${res.status}`);
  expect(!/at\s.*\.js:\d+|SyntaxError|Unexpected token|EntityParseError/.test(res.body), `超限响应带堆栈：${res.body.slice(0, 160)}`);
  expect(/[\u4e00-\u9fa5]/.test(res.body), `超限响应无中文说明：${res.body.slice(0, 120)}`);
  const okAfter = await api('/authorizations');
  expect(okAfter.status === 200, '超限请求之后会话不可用');
  return '413 + 中文说明 + 无堆栈，服务未被打崩';
});

tc('TC-S-16', '陌生令牌走附件回传面被拒且不产生证据', async () => {
  const before = rowCount('SELECT COUNT(*) AS n FROM records');
  const res = await upload({ tk: crypto.randomUUID(), mail: 'ghost@awarelab.test', parts: [{ name: 'username', value: 'ghost' }, { name: 'password', value: 'ghost-pw' }] });
  expect(res.status === 400, `陌生令牌返回 ${res.status}`);
  expect(/令牌/.test(res.body), `拒绝文案未说明原因：${res.body.slice(0, 120)}`);
  expect(rowCount('SELECT COUNT(*) AS n FROM records') === before, '陌生令牌产生了记录');
  expect(rowCount("SELECT COUNT(*) AS n FROM events WHERE kind='callback_rejected'") >= 1, '拒绝的回传没有留痕，现场无法判断是载荷写错还是有人在打平台');
  const anonymous = await upload({ tk: '', parts: [{ name: 'x', value: '1' }] });
  expect(anonymous.status === 400, `空令牌返回 ${anonymous.status}`);
  return '400 + 令牌归属说明 + callback_rejected 留痕';
});

tc('TC-S-17', '回传文件闸门：字段名、文件头、扩展名三重校验', async () => {
  const link = await freshLink('filegate');
  const base = () => [{ name: 'username', value: 'wangwu' }, { name: 'password', value: 'pw-123' }];
  const wrongField = await upload({ tk: link.token, mail: link.target_email, parts: [...base(), { name: 'screenshot', value: PNG, filename: 'ok.png', type: 'image/png' }] });
  expect(wrongField.status === 200, `文件放在非 capture 字段应只拒文件，实际 ${wrongField.status}`);
  expect(JSON.parse(wrongField.body).data.rejected_files >= 1, '非 capture 字段名塞文件被照单全收');

  const fakePdf = await upload({ tk: link.token, mail: link.target_email, parts: [...base(), { name: 'capture', value: MZ, filename: 'invoice.pdf', type: 'application/pdf' }] });
  expect(JSON.parse(fakePdf.body).data.rejected_files >= 1, 'MZ 文件头伪装成 pdf 被收下');

  const exeName = await upload({ tk: link.token, mail: link.target_email, parts: [...base(), { name: 'capture', value: PNG, filename: 'tool.exe', type: 'application/octet-stream' }] });
  expect(JSON.parse(exeName.body).data.rejected_files >= 1, '真 PNG 改名 .exe 被收下');

  const good = await upload({ tk: link.token, mail: link.target_email, parts: [...base(), { name: 'capture', value: PNG, filename: 'screen.png', type: 'image/png' }] });
  expect(good.status === 200 && JSON.parse(good.body).data.accepted, `合规截图应被接受：${good.status} ${good.body.slice(0, 120)}`);
  const files = fs.readdirSync(path.join(DATA_DIR, 'screenshots'));
  expect(!files.some((f) => /\.(exe|dll|bat|scr|vbs|js|jar)$/i.test(f)), `可疑扩展名落盘：${files.join(', ')}`);
  expect(files.some((f) => /^[0-9a-f-]{36}\.png$/.test(f)), `落盘文件名不是平台生成的 uuid：${files.join(', ')}`);
  return '字段名/文件头/扩展名各拒一次，合规 PNG 落盘为 uuid 名';
});

tc('TC-S-18', '回传频率闸门：同一令牌超每分钟配额即 429', async () => {
  const link = await freshLink('ratelimit');
  const parts = [{ name: 'username', value: 'rate' }, { name: 'password', value: 'pw' }];
  const codes = [];
  for (let i = 0; i < 14; i += 1) {
    const res = await upload({ tk: link.token, mail: link.target_email, parts });
    codes.push(res.status);
    if (res.status === 429) break;
  }
  const limit = cfg.capture.callback?.per_token_per_minute ?? 10;
  expect(codes.includes(429), `14 次回传未被限流：${codes.join(',')}`);
  const first = codes.indexOf(429);
  expect(first === limit, `第 ${first + 1} 次就限流，与配置的 ${limit} 次/分配额不符：${codes.join(',')}`);
  const other = await upload({ tk: (await freshLink('other')).token, parts });
  expect(other.status === 200, '限流按令牌计数，别的新令牌也被牵连');
  expect(/每分钟|配额|稍后再试|限制/.test(JSON.parse(other.body === undefined ? '{}' : other.body)?.message ?? '') || other.status === 200, '不该有别的令牌受影响');
  return `第 ${first + 1} 次触发 429（配额 ${limit}/分），新令牌不受影响`;
});

tc('TC-S-19', '审计表只读：没有任何改写与删除入口', async () => {
  const verbs = [['PUT', '/audit-logs'], ['DELETE', '/audit-logs'], ['POST', '/audit-logs'], ['PUT', '/audit-logs/1'], ['DELETE', '/audit-logs/1'], ['PATCH', '/audit-logs/1']];
  const notes = [];
  for (const [method, p] of verbs) {
    const res = await api(p, { method, body: '{}' });
    notes.push(`${method} ${p}=${res.status}`);
    expect([404, 405].includes(res.status), `${method} ${p} 返回 ${res.status}，审计接口面被打开`);
  }
  const read = await api('/audit-logs?page=1&page_size=5');
  expect(read.status === 200 && Array.isArray(data(read)?.rows), '审计只读列表不可用');
  const push = await api('/push-logs?page=1&page_size=5');
  expect(push.status === 200, '推送日志列表不可用');
  for (const [method, p] of [['DELETE', '/push-logs'], ['DELETE', '/records/x']]) {
    const res = await api(p, { method });
    expect([404, 405, 400].includes(res.status) || res.status === 404, `${method} ${p} 返回 ${res.status}`);
  }
  return notes.join(' ');
});

tc('TC-S-20', '推送与模型配置：明文公网链路拒绝、密钥掩码且不回显', async () => {
  await activeAuth();
  const plain = await api('/settings/push', { method: 'PUT', body: JSON.stringify({ value: { channels: [{ type: 'wecom', url: 'http://hooks.example.invalid/t?access_token=abcd1234', events: ['form_fill'] }] } }) });
  expect(plain.status === 400 && /明文|https/.test(message(plain)), `明文公网 webhook 未被拒：${plain.status} ${message(plain)}`);
  const loopback = await api('/settings/push', { method: 'PUT', body: JSON.stringify({ value: { channels: [{ type: 'webhook', url: 'http://127.0.0.1:9/qa-hook', events: ['form_fill'] }] } }) });
  expect(loopback.status === 200, `本机回环明文链路应放行（本地联调与自动化要用）：${loopback.status} ${message(loopback)}`);
  const https = await api('/settings/push', { method: 'PUT', body: JSON.stringify({ value: { channels: [{ type: 'dingtalk', url: 'https://hooks.example.invalid/t?access_token=abcd1234', events: ['mail_open'] }] } }) });
  expect(https.status === 200, `https 配置应可保存：${https.status} ${message(https)}`);
  const audit = await api('/audit-logs?action=settings.update');
  expect(!JSON.stringify(data(audit)).includes('abcd1234'), '审计里存了明文令牌');

  const ai = await api('/settings/ai', { method: 'PUT', body: JSON.stringify({ value: { providers: [{ id: 'qa-p1', name: 'QA 模型', base_url: 'https://models.example.invalid/v1', api_key: 'sk-qa-secret-key', model: 'x' }] } }) });
  expect(ai.status === 200, `模型配置保存失败：${ai.status} ${message(ai)}`);
  expect(JSON.stringify(data(ai)).includes('******') && !JSON.stringify(data(ai)).includes('sk-qa-secret'), '模型 Key 读取未掩码');
  const kept = await api('/settings/ai', { method: 'PUT', body: JSON.stringify({ value: { providers: [{ id: 'qa-p1', name: 'QA 模型改名', base_url: 'https://models.example.invalid/v1', api_key: '******', model: 'x' }] } }) });
  expect(kept.status === 200, `掩码回填失败：${kept.status} ${message(kept)}`);
  const stored = JSON.parse(count('SELECT value FROM settings WHERE key=?', ['ai'])[0].value);
  expect(stored.providers[0].api_key === 'sk-qa-secret-key', '界面上改个名字就把模型 Key 洗成了星号');
  const badUrl = await api('/settings/ai', { method: 'PUT', body: JSON.stringify({ value: { providers: [{ name: '公网明文', base_url: 'http://models.example.invalid/v1', api_key: 'sk-x' }] } }) });
  expect(badUrl.status === 400 && /明文|https/.test(message(badUrl)), `公网明文模型地址未被拒：${badUrl.status}`);
  const emailPrompt = await api('/ai/generate', { method: 'POST', body: JSON.stringify({ prompt: '给 zhangsan@corp.example 做一个邮箱登录页', site_name: '办公系统' }) });
  expect(emailPrompt.status === 400 && /邮箱/.test(message(emailPrompt)), `提示词含真实邮箱未被拒：${emailPrompt.status} ${message(emailPrompt)}`);
  const outsideHost = await api('/ai/generate', { method: 'POST', body: JSON.stringify({ prompt: '仿冒 oa.victim.example 的登录页', site_name: 'OA' }) });
  expect(outsideHost.status === 400 && /授权名单/.test(message(outsideHost)), `仿冒目标不在授权名单内未被拒：${outsideHost.status} ${message(outsideHost)}`);
  return '明文公网链路双向拒绝、本机回环放行、模型 Key 掩码且改名不丢 Key';
});

tc('TC-S-21', '授权自然到期：正在监听的站点当场停止放行，文案中性', async () => {
  const auth = await freshAuthorization({ scope: 'QA 到期下线' });
  const site = await recreateSite(PORT.expire, { template: await ensureTemplate() });
  // 链接要在窗口内签好：出窗口后签发本身就 403，拿它当探针会混淆两个闸门
  const link = await issueLink(site.id, 'after-expiry@awarelab.test');
  expect(site.running, '前置站点未在监听');
  expect((await cap('/', { port: PORT.expire })).status === 200, '到期前本站应在服务');
  const before = rowCount('SELECT COUNT(*) AS n FROM records');
  // 库里把窗口整体搬回过去，等于时间自然走到有效期止，此间接口未被调用
  db.prepare('UPDATE authorizations SET start_at=?, end_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z', auth.id);
  const denied = await cap('/', { port: PORT.expire });
  expect([403, 410].includes(denied.status), `到期授权下的访客页返回 ${denied.status}`);
  const text = stripTags(denied.body);
  expect(!INSIDER_WORDS.test(text), `到期页向演练对象泄露演练意图：${text.slice(0, 140)}`);
  expect(rowCount('SELECT COUNT(*) AS n FROM records') === before, '到期后的访问仍被采集入库');
  const engage = await cap('/alab/v2/engage', { method: 'POST', port: PORT.expire, body: JSON.stringify({ ev: 'submit', tk: link.token, dwell: 1, fields: { username: 'x', password: 'y' } }) });
  expect(engage.status === 0 || engage.status >= 400, `到期后仍能上报采集（${engage.status}）`);
  db.prepare('UPDATE authorizations SET start_at=?, end_at=? WHERE id=?').run(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString(), auth.id);
  const revived = await cap('/', { port: PORT.expire });
  expect(revived.status === 200, `窗口改回当下后站点未恢复服务（${revived.status}）`);
  await api(`/web-sites/${site.id}`, { method: 'DELETE' });
  return '到期即拒绝采集（403/410）、文案中性、续回窗口即恢复';
});

tc('TC-S-22', '注入式查询参数不改语义、不报 500、不动表结构', async () => {
  const payloads = ["' OR '1'='1", '1; DROP TABLE records', "%' UNION SELECT token FROM sessions --", "\\' OR 1=1 --", 'admin\'--'];
  for (const p of payloads) {
    for (const p2 of [`/records?keyword=${q(p)}`, `/audit-logs?action=${q(p)}`, `/audit-logs?actor=${q(p)}`, `/web-templates?keyword=${q(p)}`, `/mail-templates?keyword=${q(p)}`, `/records?site_id=${q(p)}`, `/records?kind=${q(p)}`]) {
      const res = await api(p2);
      expect(res.status < 500, `${p2} 返回 ${res.status}`);
    }
  }
  expect(count("SELECT name FROM sqlite_master WHERE name='records'").length === 1, 'records 表被注入打掉');
  expect(count("SELECT name FROM sqlite_master WHERE name='sessions'").length === 1, 'sessions 表被注入打掉');
  const dumped = await api('/records?keyword=' + q("' UNION SELECT token FROM sessions --"));
  expect(!/sessions|token.*uuid|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(dumped.text), '注入探针把会话令牌带了出来');
  return `${payloads.length} 组载荷 × 7 个查询位全部安全返回，表结构与会话完好`;
});

tc('TC-S-23', '路径片段不能作为资源标识被消费（穿越探测）', async () => {
  const traversal = ['../../config.yaml', '..%2f..%2f..%2fconfig.yaml', '../../../etc/passwd', '%2e%2e%2f%2e%2e%2fserver%2fconfig.yaml'];
  for (const id of traversal) {
    for (const p of [`/records/${q(id)}`, `/records/${q(id)}/screenshot`, `/web-templates/${q(id)}`, `/mail-tasks/${q(id)}`]) {
      const res = await api(p);
      expect([404, 400].includes(res.status), `${p} 接受了穿越 id（${res.status}）`);
      expect(!/panel|password|SQLite format|root:/.test(res.text), `${p} 读到了配置或系统文件内容`);
    }
  }
  const up = await api(`/records/..%2F..%2F..%2Fconfig.yaml`);
  expect(up.status < 500, `穿越路径返回 ${up.status}`);
  return `${traversal.length} 组穿越 id × 4 个接口全部 404/400，未读到文件内容`;
});

tc('TC-S-24', '导出参数不得污染响应头（Content-Disposition 注入）', async () => {
  const hostile = '" x.csv\r\nX-Injected: yes';
  const res = await api(`/reports/export?kind=${q(hostile)}`);
  expect(res.status < 500, `导出对恶意 kind 返回 ${res.status}（未捕获的表头异常会打崩这次请求）`);
  expect(!res.headers.get('x-injected'), '响应头被注入');
  if (res.status === 200) {
    const disposition = res.headers.get('content-disposition') || '';
    expect(!/[\r\n]/.test(disposition), `文件名未净化，仍带换行：${JSON.stringify(disposition)}`);
    expect(!disposition.includes('X-Injected'), `文件名未净化：${disposition}`);
  } else {
    expect(res.status === 400 && /web|mail|类型/.test(message(res)), `非白名单 kind 应 400 并说明取值范围：${res.status} ${message(res)}`);
  }
  for (const kind of ['web', 'mail']) {
    const good = await api(`/reports/export?kind=${kind}`);
    expect(good.status === 200 && /text\/csv/.test(good.headers.get('content-type') || ''), `${kind} 导出不可用：${good.status}`);
    expect((good.headers.get('content-disposition') || '').includes(kind), `${kind} 导出的文件名与类型不符`);
  }
  const traversal = await api('/reports/export?kind=' + q('../../etc/passwd'));
  expect(traversal.status < 500 && !/root:/.test(traversal.text), 'kind 带路径片段时读到了系统文件');
  return '恶意 kind 被拒或被净化，web/mail 两类导出仍正常，响应头未被注入';
});

tc('TC-S-25', '口令与令牌值不出现在接口响应与启动输出里', async () => {
  const password = cfg.panel.password;
  const endpoints = ['/settings', '/stats/home', '/authorizations', '/records?page=1&page_size=5', '/smtp-profiles', '/audit-logs', '/push-logs', '/web-sites', '/mail-tasks', '/web-templates?page=1&page_size=5', '/records/groups'];
  for (const p of endpoints) {
    const res = await api(p);
    expect(!res.text.includes(password), `${p} 的响应里出现了管理口令明文`);
  }
  expect(!bootLog.includes(password), '服务启动输出打印了明文口令');
  const sessions = count('SELECT token FROM sessions');
  const dumped = await api('/records/groups');
  const leaked = sessions.find((s) => dumped.text.includes(s.token));
  expect(!leaked, '会话令牌出现在业务响应里');
  const smtp = await api('/smtp-profiles');
  const storedPass = count('SELECT pass FROM smtp_profiles WHERE pass<>\'\'')[0]?.pass;
  expect(!storedPass || !smtp.text.includes(storedPass), 'SMTP 口令明文出现在列表响应里');
  return `${endpoints.length} 个接口 + 启动输出 + 会话/SMTP 凭据都不外泄`;
});

tc('TC-S-26', '采集面监听地址遵循 capture.bind_host', async () => {
  const site = await recreateSite(PORT.bind, { status: 'closed' });
  const row = count('SELECT listen_ip FROM web_sites WHERE id=?', [site.id])[0];
  await api(`/web-sites/${site.id}`, { method: 'DELETE' });
  expect(row.listen_ip === cfg.capture.bind_host, `未显式指定 listen_ip 时绑到了 ${row.listen_ip}，配置写的是 ${cfg.capture.bind_host}（等于每张网默认对本机所有网卡开放）`);
  return `listen_ip=${row.listen_ip}（与配置一致，测试期不会把仿冒页挂进局域网）`;
});

tc('TC-S-27', 'XSS 载荷在存储/检索/导出/预览四个出口都保持惰性', async () => {
  const created = await api('/web-templates', { method: 'POST', body: JSON.stringify({ name: XSS_PAYLOAD, type: '表单', html: `<div>${XSS_PAYLOAD}</div>`, description: '</div><script>alert(2)</script>' }) });
  expect(created.status === 200, `存储载荷失败：${created.status} ${message(created)}`);
  const id = data(created).id;
  const listed = await api('/web-templates?keyword=' + q('<img'));
  expect(listed.status === 200 && /json/.test(listed.headers.get('content-type') || ''), `列表响应不是 JSON：${listed.status}`);
  expect(listed.text.includes(XSS_PAYLOAD), '载荷在 JSON 出口被吃掉了（说明做了不该做的转义）');
  const detail = await api(`/web-templates/${id}`);
  expect(detail.status === 200, `详情读取失败：${detail.status}`);
  expect(/application\/json/.test(detail.headers.get('content-type') || ''), `详情不是 JSON 出口，载荷有被当 HTML 解析的风险：${detail.headers.get('content-type')}`);
  expect(JSON.parse(detail.text)?.data?.description === '</div><script>alert(2)</script>', '详情接口改写了存储内容');
  const csv = await api('/reports/export?kind=web');
  expect(csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type') || ''), 'CSV 出口异常');
  const preview = await api('/web-templates/preview', { method: 'POST', body: JSON.stringify({ html: `<div>${XSS_PAYLOAD}</div>` }) });
  expect(preview.status === 200 && /json|html/.test(preview.headers.get('content-type') || ''), `预览接口返回 ${preview.status}`);
  const csp = preview.headers.get('content-security-policy') || '';
  expect(preview.headers.get('content-type')?.includes('html') ? /script-src/.test(csp) : true, '预览页是 HTML 出口但没有 CSP');
  await api(`/web-templates/${id}`, { method: 'DELETE' });
  const injected = await api('/web-templates', { method: 'POST', body: JSON.stringify({ name: 'QA 换行注入', type: '表单', html: '<form></form>', description: 'x\r\nSet-Cookie: a=b' }) });
  expect(injected.status === 200, `换行入参存储失败：${injected.status}`);
  const listedAfter = await api('/web-templates?keyword=' + q('换行注入'));
  expect(!/Set-Cookie: a=b/.test(JSON.stringify(listedAfter.headers)), '入参里的换行拼进了响应头');
  await api(`/web-templates/${data(injected).id}`, { method: 'DELETE' });
  return '载荷经四个出口保持惰性、HTML 出口带 CSP、入参换行不进响应头';
});

tc('TC-S-28', '沙箱默认值不可被静默关闭：真发信必须有显式配置与留痕', async () => {
  const auth = await activeAuth();
  expect(cfg.mail_default_dry_run !== false, '隔离实例未保持沙箱默认开启，用例前提不成立');
  const task = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: 'QA 真发闸门', subject: 's', body_html: '<p>b</p>' }) });
  expect(task.status === 200, `建任务失败：${task.status} ${message(task)}`);
  expect(data(task).dry_run === true, `新任务默认没进沙箱：dry_run=${data(task).dry_run}`);
  expect(data(task).authorization_id === auth.id, `任务未绑定当前授权：${data(task).authorization_id}`);
  const noProfile = await api(`/mail-tasks/${data(task).id}`, { method: 'PUT', body: JSON.stringify({ dry_run: false }) });
  expect(noProfile.status === 200 || (noProfile.status === 400 && /发信邮箱/.test(message(noProfile))), `关沙箱未选发信配置的返回是 ${noProfile.status}`);
  // 先建收件人：任务没有收件人时 send 会先报缺收件人，走不到发信配置这道闸门
  await api(`/mail-tasks/${data(task).id}/recipients`, { method: 'POST', body: JSON.stringify({ text: 'gate@qa.test,闸门访客' }) });
  const send = await api(`/mail-tasks/${data(task).id}/send`, { method: 'POST' });
  expect(send.status >= 400 && /发信邮箱|沙箱|SMTP/.test(message(send)), `没有发信配置却真发出去了（${send.status} ${message(send)}）`);
  const toggleBefore = rowCount("SELECT COUNT(*) AS n FROM audit_logs WHERE action='mail_task.sandbox_toggle'");
  await api(`/mail-tasks/${data(task).id}`, { method: 'PUT', body: JSON.stringify({ dry_run: true }) });
  await api(`/mail-tasks/${data(task).id}`, { method: 'PUT', body: JSON.stringify({ dry_run: false }) });
  const toggleAfter = rowCount("SELECT COUNT(*) AS n FROM audit_logs WHERE action='mail_task.sandbox_toggle'");
  expect(toggleAfter >= toggleBefore + 2, `翻动沙箱开关未逐次留痕（${toggleBefore}→${toggleAfter}）`);
  const audit = count("SELECT * FROM audit_logs WHERE action='mail_task.sandbox_toggle' ORDER BY created_at DESC LIMIT 1")[0];
  expect(/real/.test(String(audit.detail)), `审计里没记清翻到了哪一档：${audit.detail}`);
  await api(`/mail-tasks/${data(task).id}`, { method: 'DELETE' });
  return '默认沙箱、任务绑定授权、无配置不许真发、每次翻档留痕';
});

tc('TC-S-29', '会话清点与一键注销：清单只给令牌前 6 位，注销后所有旧令牌立刻失效', async () => {
  unlockLogins();
  const second = data(await loginAgain());
  const third = data(await loginAgain());
  expect(second?.token && third?.token, `并存的登录没各自签发令牌：${JSON.stringify(second)?.slice(0, 80)}`);
  const list = data(await api('/auth/sessions'));
  expect(Array.isArray(list) && list.length >= 3, `会话清单形状或条数不对：${JSON.stringify(list)?.slice(0, 120)}`);
  const current = list.find((s) => s.is_current === true);
  expect(current, '清单没标出哪一条是当前会话，操作员不敢点注销');
  expect(list.filter((s) => s.is_current === true).length === 1, '当前会话被标了多处，清点结果不可信');
  expect(String(current.token_hint ?? '').endsWith('…') && current.token_hint.length <= 8, `令牌提示给得太多：${current.token_hint}`);
  expect(!JSON.stringify(list).includes(TOKEN), '清单把完整令牌回给了前端，等于多开一条令牌外泄通道');
  expect(!JSON.stringify(list).includes(second.token), '清单泄露了别的会话的完整令牌');
  expect(typeof current.ip === 'string' && current.ip.length > 0, `清单缺来源 IP，认不出陌生会话来自哪台机器：${current.ip}`);
  expect('user_agent' in current, '清单缺浏览器标识字段，前端只能显示空白');
  expect(Number.isInteger(current.expires_at) && current.expires_at > Date.now(), `到期时间不是可用毫秒数：${current.expires_at}`);
  expect(current.expired === false, '未过期的会话被标成已过期');

  const revoked = await api('/auth/sessions/revoke-all', { method: 'POST' });
  expect(revoked.status === 200 && data(revoked)?.revoked >= 3, `一键注销没清干净：${JSON.stringify(data(revoked))}`);
  expect((await api('/auth/me')).status === 401, '注销后当前令牌仍然有效');
  expect((await api('/auth/me', {}, second.token)).status === 401, '注销后其他会话令牌仍然有效，丢了设备也收不回来');
  expect(rowCount('SELECT COUNT(*) AS n FROM sessions') === 0, '会话表里还留着注销后的行，下次清点会看到幽灵会话');
  const audit = count("SELECT * FROM audit_logs WHERE action='session.revoke_all' ORDER BY created_at DESC LIMIT 1")[0];
  expect(audit && Number(JSON.parse(audit.detail).revoked) >= 3, `一键注销没进审计或没记条数：${audit?.detail ?? '无记录'}`);
  await login();
  return `${list.length} 条会话可清点（只给前 6 位）、一键注销 ${data(revoked).revoked} 条后全部令牌立即 401`;
});

tc('TC-S-30', '凭据掩码全口径：管理面处处掩码，明文只能单独取且每取必留痕', async () => {
  const { site, link } = await world();
  const SECRET_VALUE = 'S3cret-qa-2026';
  await visitAsTarget(link.token, { username: 'zhangsan@corp.test', password: SECRET_VALUE, 登录密码: 'Zh-2026', remark: '不是敏感字段' });
  await sleep(20);

  // 库里存的是明文：掩码只发生在读侧，落库就掩的话取证永远还原不出原表单
  const stored = count('SELECT form_json FROM records WHERE token=?', [link.token])[0];
  expect(stored && stored.form_json.includes(SECRET_VALUE), '库里没存明文，事后取证无法还原访客到底填了什么');

  const row = (data(await api(`/records?site_id=${site.id}&submitted=1`))?.rows ?? []).find((r) => r.token === link.token);
  expect(row, '按站点+已提交过滤读不到刚提交的记录');
  const byName = Object.fromEntries((row.form_json ?? []).map((f) => [f.name, f]));
  expect(byName.password?.value === MASK, `英文口令未掩码，管理面一打开就明文外泄：${byName.password?.value}`);
  expect(byName['登录密码']?.value === MASK, `中文口令字段漏掩（口径不够宽）：${byName['登录密码']?.value}`);
  expect(byName.password?.secret === true && byName['登录密码']?.secret === true, '口令字段没有 secret 标记，前端分不清"值就是这样"和"值被藏了"');
  expect(byName.username?.value === 'zhangsan@corp.test' && byName.username?.secret === false, `账号被误掩，运营认不出这是谁：${byName.username?.value}`);
  expect(byName.remark?.value === '不是敏感字段', `普通备注被误掩，证据读起来全是掩码：${byName.remark?.value}`);
  expect(row.secret_count === 2, `敏感字段计数不对（应为 2）：${row.secret_count}`);
  expect(!JSON.stringify(row).includes(SECRET_VALUE), '记录响应里仍带着口令明文');

  const detail = data(await api(`/records/${row.id}`));
  expect((detail?.form ?? []).some((f) => f.name === 'password' && f.value === MASK), '详情接口没走同一套掩码口径');
  expect(detail?.context?.target_email === link.target_email, `归属邮箱被掩掉了，处置流程找不到本人：${detail?.context?.target_email}`);

  const groups = await api('/records/groups');
  expect((data(groups)?.web ?? []).some((g) => g.id === site.id && g.field_names.includes('password')), '看板没报出采到了口令字段，运营看不出这次演练采到了什么');
  expect(!JSON.stringify(data(groups)).includes(SECRET_VALUE), '看板响应里带着口令明文');

  // 明文逐字段取，取一次写一条审计：这是查谁看过员工口令的唯一依据
  const before = rowCount("SELECT COUNT(*) AS n FROM audit_logs WHERE action='record.secret_reveal'");
  const shown = await api(`/records/${row.id}/reveal`, { method: 'POST', body: JSON.stringify({ field: 'password' }) });
  expect(shown.status === 200 && data(shown)?.value === SECRET_VALUE && data(shown)?.secret === true, `显示明文取不回原值：${JSON.stringify(data(shown))}`);
  expect(rowCount("SELECT COUNT(*) AS n FROM audit_logs WHERE action='record.secret_reveal'") === before + 1, '看了明文口令却没多写一条审计');
  const plain = await api(`/records/${row.id}/reveal`, { method: 'POST', body: JSON.stringify({ field: 'remark' }) });
  expect(data(plain)?.value === '不是敏感字段' && data(plain)?.secret === false, '非敏感字段取明文失败');
  expect(rowCount("SELECT COUNT(*) AS n FROM audit_logs WHERE action='record.secret_reveal'") === before + 1, '非敏感字段也写审计，真正的口令查看记录会被噪声淹没');
  const reveals = count("SELECT detail FROM audit_logs WHERE action='record.secret_reveal'");
  expect(!JSON.stringify(reveals).includes(SECRET_VALUE), '审计里抄了口令明文，审计表反而成了第二份泄露源');
  expect((await api(`/records/${row.id}/reveal`, { method: 'POST', body: JSON.stringify({ field: 'no-such-field' }) })).status === 404, '取不存在的字段没给 404');
  expect((await api('/records/qa-ghost/reveal', { method: 'POST', body: JSON.stringify({ field: 'password' }) })).status === 404, '取不存在记录的明文没给 404');
  expect((await api(`/records/${row.id}/reveal`, { method: 'POST', body: JSON.stringify({}) })).status === 400, '缺字段名没给 400');

  // 分工：取证导出是操作员自用件，必须明文；交付件（报告/交付 CSV）才掩码
  const csv = await (await fetch(`${API}/reports/export?kind=web`, { headers: { 'x-alab-token': TOKEN } })).text();
  expect(csv.includes(SECRET_VALUE), '取证导出没给明文，导出去也对不回原表单');
  return '列表/详情/看板三处同口径掩码（含中文字段名），明文单字段取且每取留痕，取证导出保持明文';
});

tc('TC-F-01', '授权登记字段矩阵：缺项与非法值逐条给出中文原因', async () => {
  const good = { scope: 'QA 字段矩阵', start_at: new Date(Date.now() - 60_000).toISOString(), end_at: new Date(Date.now() + 3_600_000).toISOString(), pledge: PLEDGE, allowed_hosts: HOSTS, note: OWN_NOTE };
  const matrix = [
    ['缺主体', { ...good, scope: '' }, /必填/],
    ['缺有效期起', { ...good, start_at: '' }, /必填/],
    ['止早于起', { ...good, end_at: new Date(Date.now() - 7_200_000).toISOString() }, /晚于/],
    ['白名单为空', { ...good, allowed_hosts: [] }, /域名|IP/],
    ['承诺不符', { ...good, pledge: '我同意' }, /承诺/],
    ['有效期是垃圾串', { ...good, start_at: 'not-a-date', end_at: 'also-not-a-date' }, /./],
  ];
  const notes = [];
  for (const [label, body, re] of matrix) {
    const res = await api('/authorizations', { method: 'POST', body: JSON.stringify(body) });
    expect(res.status < 500, `${label} 返回 ${res.status}`);
    expect(res.status === 400, `${label} 返回 ${res.status}，期望 400：${message(res)}`);
    expect(re.test(message(res)), `${label} 文案不含关键字：${message(res)}`);
    notes.push(`${label}→${message(res)}`);
  }
  const created = await api('/authorizations', { method: 'POST', body: JSON.stringify(good) });
  expect(created.status === 200, `合法登记失败：${created.status} ${message(created)}`);
  const row = data(created);
  expect(Array.isArray(row.allowed_hosts) && row.allowed_hosts.includes('qa.example.com'), '白名单未在响应里还原成数组');
  expect(row.effective === 'active', `新登记的授权生效状态判定错误：${row.effective}`);
  expect(row.status === 'active' && row.created_at, '授权行字段不全');
  await api(`/authorizations/${row.id}/revoke`, { method: 'POST' });
  const listed = await api('/authorizations');
  const back = (data(listed) ?? []).find((r) => r.id === row.id);
  expect(back && back.status === 'revoked', '吊销后列表状态未同步');
  return `${matrix.length} 类非法输入全部 400 且原因准确；合法输入回显数组与生效状态`;
});

tc('TC-F-02', '授权修改语义：改窗口即改权限、吊销后不可改、不存在即 404', async () => {
  const auth = await freshAuthorization({ scope: 'QA 修改语义' });
  const site = await recreateSite(PORT.gate, { template: await ensureTemplate() });
  const ghost = await api('/authorizations/nonexistent-id', { method: 'PUT', body: JSON.stringify({ scope: 'x', start_at: auth.start_at, end_at: auth.end_at, pledge: PLEDGE, allowed_hosts: HOSTS }) });
  expect(ghost.status === 404 && /不存在/.test(message(ghost)), `改不存在授权返回 ${ghost.status} ${message(ghost)}`);
  const shorten = await api(`/authorizations/${auth.id}`, { method: 'PUT', body: JSON.stringify({ ...auth, allowed_hosts: HOSTS, pledge: PLEDGE, start_at: '2020-01-01T00:00:00.000Z', end_at: '2020-01-02T00:00:00.000Z' }) });
  expect(shorten.status === 200, `缩短窗口返回 ${shorten.status} ${message(shorten)}`);
  expect((data(shorten)?.stopped_sites ?? 0) >= 1, `改窗口没有级联下线其站点：${JSON.stringify(data(shorten))?.slice(0, 160)}`);
  expect((await listSites()).find((r) => r.id === site.id)?.running === false, '窗口缩到过期后站点仍在监听');
  const reopen = await api(`/authorizations/${auth.id}`, { method: 'PUT', body: JSON.stringify({ scope: 'QA 修改语义', start_at: new Date(Date.now() - 60_000).toISOString(), end_at: new Date(Date.now() + 3_600_000).toISOString(), pledge: PLEDGE, allowed_hosts: HOSTS }) });
  expect(reopen.status === 200 && data(reopen)?.effective === 'active', `续期失败：${reopen.status} ${message(reopen)}`);
  await api(`/authorizations/${auth.id}/revoke`, { method: 'POST' });
  const editRevoked = await api(`/authorizations/${auth.id}`, { method: 'PUT', body: JSON.stringify({ scope: '改一下', start_at: auth.start_at, end_at: auth.end_at, pledge: PLEDGE, allowed_hosts: HOSTS }) });
  expect(editRevoked.status === 409 && /吊销/.test(message(editRevoked)), `改已吊销授权返回 ${editRevoked.status} ${message(editRevoked)}`);
  await api(`/web-sites/${site.id}`, { method: 'DELETE' });
  return '404 / 409 / 改窗口即下线 三种语义都准确';
});

tc('TC-F-03', '模板接口：必填校验、体检报告、预览注入、引用保护、不存在 404', async () => {
  const missing = await api('/web-templates', { method: 'POST', body: JSON.stringify({ name: '只给名字' }) });
  expect(missing.status === 400 && /必填/.test(message(missing)), `缺内容模板返回 ${missing.status} ${message(missing)}`);
  const created = await api('/web-templates', { method: 'POST', body: JSON.stringify({ name: 'QA 体检模板', type: '表单', html: TEMPLATE_HTML }) });
  expect(created.status === 200, `建模板失败：${created.status} ${message(created)}`);
  const report = data(created).diagnose;
  expect(report && Array.isArray(report.checks) && typeof report.score === 'number', `体检报告形状不全：${JSON.stringify(report)?.slice(0, 160)}`);
  const check = (key) => report.checks.find((c) => c.key === key);
  expect(check('binding')?.ok, '声明式绑定未被识别，协议 v2 体检失效');
  expect(check('trigger')?.ok, '显式提交按钮未被识别为触发点');
  expect(check('assets')?.ok, '无外链模板被判有外链');
  const fields = check('fields');
  expect(JSON.stringify(fields?.items) === JSON.stringify(['username', 'password']), `可采集字段判定不符（data-al-ignore 应排除 captcha）：${JSON.stringify(fields?.items)}`);
  expect(report.score === 100, `这张干净模板的分数应为 100，实际 ${report.score}`);

  const naked = await api('/web-templates', { method: 'POST', body: JSON.stringify({ name: 'QA 裸文本模板', type: '表单', html: '<p>没有表单</p>' }) });
  expect(naked.status === 200 && data(naked).diagnose.score < 100, `无采集入口的模板没被扣分：${JSON.stringify(data(naked)?.diagnose)?.slice(0, 140)}`);
  expect((data(naked).diagnose.issues ?? []).some((t) => /采集入口|form/i.test(t)), '体检报告未给出可执行的修改建议');
  await api(`/web-templates/${data(naked).id}`, { method: 'DELETE' });

  const ghost = await api('/web-templates/ghost-id');
  expect(ghost.status === 404 && /不存在/.test(message(ghost)), `取不存在模板返回 ${ghost.status} ${message(ghost)}`);
  const ghostPut = await api('/web-templates/ghost-id', { method: 'PUT', body: JSON.stringify({ name: '改名' }) });
  expect(ghostPut.status === 404, `改不存在模板返回 ${ghostPut.status}`);
  const ghostDel = await api('/web-templates/ghost-id', { method: 'DELETE' });
  expect(ghostDel.status === 404, `删不存在模板返回 ${ghostDel.status}`);

  const preview = await api('/web-templates/preview', { method: 'POST', body: JSON.stringify({ html: TEMPLATE_HTML, response_type: 'lesson' }) });
  expect(preview.status === 200 && /alab-boot/.test(preview.text) && /data-al-collect/.test(preview.text), `预览未注入采集运行时：${preview.text.slice(0, 140)}`);
  expect(/after"?:\s*"lesson|\/lesson/.test(JSON.stringify(preview.text)) || preview.text.includes('lesson'), '预览的响应分支没按模板配置走');

  const inUse = await api(`/web-templates/${(await ensureTemplate()).id}`, { method: 'DELETE' });
  expect(inUse.status === 400 && /引用/.test(message(inUse)), `删除被引用模板返回 ${inUse.status} ${message(inUse)}`);
  await api(`/web-templates/${data(created).id}`, { method: 'DELETE' });
  const diagnose = await api('/web-templates/diagnose', { method: 'POST', body: JSON.stringify({ html: TEMPLATE_HTML }) });
  expect(diagnose.status === 200 && Array.isArray(data(diagnose)?.checks), '独立体检接口不可用');
  return '必填/体检（含字段白名单与扣分）/预览/引用保护/不存在 404 五类齐全';
});

tc('TC-F-04', '建站参数矩阵：端口越界、非整数、占用、域名越权、TLS 半配置都 400', async () => {
  const site = await ensureSite(PORT.dup);
  const [, max] = cfg.capture.port_range;
  const g = async (patch) => ({ template_id: (await ensureTemplate()).id, listen_port: PORT.shape, domain: 'qa.example.com', ...patch });
  const cases = [
    ['端口低于区间', await g({ listen_port: 80 }), /端口/],
    ['端口高于区间', await g({ listen_port: 70000 }), /端口/],
    ['端口非整数', await g({ listen_port: '8231abc' }), /端口/],
    ['端口缺失', await g({ listen_port: undefined }), /端口/],
    ['模板不存在', await g({ template_id: 'ghost' }), /模板/],
    ['域名不在授权名单', await g({ domain: 'evil.example.org' }), /授权名单/],
    ['只给证书不给私钥', await g({ tls_cert: 'CERT' }), /私钥/],
    ['端口已被占用', await g({ listen_port: PORT.dup, listen_ip: site.listen_ip }), /占用/],
  ];
  const notes = [];
  for (const [label, body, re] of cases) {
    const res = await api('/web-sites', { method: 'POST', body: JSON.stringify(body) });
    expect(res.status < 500, `${label} 返回 ${res.status}`);
    expect(res.status === 400, `${label} 返回 ${res.status}，期望 400：${message(res)}`);
    expect(re.test(message(res)), `${label} 文案不含关键字：${message(res)}`);
    notes.push(label);
  }
  const edge = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: (await ensureTemplate()).id, listen_port: max + 1, status: 'closed' }) });
  expect(edge.status === 400, `区间上界外 ${max + 1} 端口被接受（${edge.status}）`);
  expect(rowCount("SELECT COUNT(*) AS n FROM web_sites WHERE status='error'") === 0, '非法建站留下了 error 站点');
  expect((await listSites()).filter((r) => r.listen_port === PORT.dup).length === 1, '非法建站多留了站点行');
  expect(site.running, '判定用的前置站点意外掉线');
  return `${cases.length} 类参数错误全部 400 且原因准确，库里没留半成品站点`;
});

tc('TC-F-05', '站点修改校验：换模板要存在、换域名要过授权名单', async () => {
  const site = await ensureSite(PORT.main);
  const ghost = await api(`/web-sites/${site.id}`, { method: 'PUT', body: JSON.stringify({ template_id: 'ghost-template' }) });
  expect(ghost.status === 400 && /模板/.test(message(ghost)), `改到不存在的模板返回 ${ghost.status} ${message(ghost)}（站点会对访客报「模板已删除」）`);
  const outside = await api(`/web-sites/${site.id}`, { method: 'PUT', body: JSON.stringify({ domain: 'victim.example.org' }) });
  expect(outside.status === 400 && /授权名单|授权/.test(message(outside)), `改到名单外的域名返回 ${outside.status} ${message(outside)}（建站校验、改站不校验等于绕开门禁）`);
  const halfTls = await api(`/web-sites/${site.id}`, { method: 'PUT', body: JSON.stringify({ tls_cert: 'CERT-only' }) });
  expect(halfTls.status === 400 && /私钥/.test(message(halfTls)), `改到只有证书没有私钥返回 ${halfTls.status}`);
  const ghostSite = await api('/web-sites/nonexistent-id', { method: 'PUT', body: JSON.stringify({ domain: 'qa.example.com' }) });
  expect(ghostSite.status === 404, `改不存在站点返回 ${ghostSite.status}`);
  const ok = await api(`/web-sites/${site.id}`, { method: 'PUT', body: JSON.stringify({ domain: 'lab.qa.example.com' }) });
  expect(ok.status === 400 && /授权名单/.test(message(ok)), `子域不在 *.qa.example.com 名单内的判定应拒绝：${ok.status} ${message(ok)}`);
  const stillRunning = (await listSites()).find((r) => r.id === site.id);
  expect(stillRunning?.running, '校验失败的修改把监听弄掉了');
  return '未知模板 / 越权域名 / 半配置 TLS / 不存在站点 四类修改全部拦下';
});

tc('TC-F-06', '专属链接：邮箱格式校验、未知站点 404、回看列表形状', async () => {
  const site = await ensureSite(PORT.main);
  const bad = await api(`/web-sites/${site.id}/links`, { method: 'POST', body: JSON.stringify({ email: 'not-an-email' }) });
  expect(bad.status === 400 && /邮箱/.test(message(bad)), `非法邮箱返回 ${bad.status} ${message(bad)}`);
  for (const email of ['a@b', 'a b@c.com', '@c.com', 'a@b@c.com']) {
    const res = await api(`/web-sites/${site.id}/links`, { method: 'POST', body: JSON.stringify({ email }) });
    expect(res.status === 400, `邮箱「${email}」被接受（${res.status}）`);
  }
  const ghost = await api('/web-sites/nonexistent/links', { method: 'POST', body: JSON.stringify({ email: 'a@awarelab.test' }) });
  expect(ghost.status === 404 && /站点/.test(message(ghost)), `未知站点签发链接返回 ${ghost.status} ${message(ghost)}`);
  const noOwner = await api(`/web-sites/${site.id}/links`, { method: 'POST', body: JSON.stringify({ name: '匿名手动投放' }) });
  expect(noOwner.status === 200 && /tk=/.test(data(noOwner).url), `无归属邮箱也应能签链接：${noOwner.status} ${message(noOwner)}`);
  const list = await api(`/web-sites/${site.id}/links`);
  expect(list.status === 200 && Array.isArray(data(list)?.rows) && data(list).site.url, `回看列表形状不全：${list.text.slice(0, 140)}`);
  const first = data(list).rows[0];
  expect(first.url.includes('tk=') && first.token, `链接未带令牌：${JSON.stringify(first).slice(0, 140)}`);
  expect('opens' in first && 'submitted_at' in first && 'field_names' in first, `回看列表缺打开数/提交/字段名，界面无法判断这条链接的效果：${Object.keys(first).join(',')}`);
  expect(data(list).site.running === true, '回看列表的站点状态与注册表不一致');
  await api(`/web-sites/${site.id}/links`, { method: 'POST', body: JSON.stringify({ email: 'cleanup-skip' }) }).catch(() => {});
  return `格式校验（含 4 种非法邮箱）+ 404 语义 + 回看列表 ${data(list).rows.length} 条`;
});

tc('TC-F-07', '邮件任务：必填校验、不存在 404、改档后形状完整', async () => {
  const missing = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: '只有标题' }) });
  expect(missing.status === 400 && /必填/.test(message(missing)), `缺正文任务返回 ${missing.status} ${message(missing)}`);
  await activeAuth();
  const real = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: '真发', subject: 's', body_html: '<p>b</p>', dry_run: false }) });
  expect(real.status === 400 && /发信邮箱/.test(message(real)), `关沙箱未选 SMTP 返回 ${real.status} ${message(real)}`);
  const ghost = await api('/mail-tasks/ghost-id');
  expect(ghost.status === 404 && /任务/.test(message(ghost)), `不存在任务详情返回 ${ghost.status} ${message(ghost)}`);
  const created = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: 'QA 改档', subject: '原标题', body_html: '<p>原正文</p>' }) });
  expect(created.status === 200, `建任务失败：${created.status} ${message(created)}`);
  const id = data(created).id;
  const ghostPut = await api('/mail-tasks/ghost-id', { method: 'PUT', body: JSON.stringify({ title: 'x' }) });
  expect(ghostPut.status === 404, `改不存在任务返回 ${ghostPut.status}（库里没这条任务，却回了成功）`);
  expect(data(ghostPut) === null || ghostPut.status === 404, '改不存在任务回了 code:0 data:null，界面会显示成保存成功');
  const ghostDel = await api('/mail-tasks/ghost-id', { method: 'DELETE' });
  expect(ghostDel.status === 404, `删不存在任务返回 ${ghostDel.status}`);
  const edited = await api(`/mail-tasks/${id}`, { method: 'PUT', body: JSON.stringify({ subject: '新标题', body_html: '<p>新正文</p>', send_interval_ms: 120 }) });
  expect(edited.status === 200 && data(edited).subject === '新标题', `改档失败：${edited.status} ${message(edited)}`);
  expect(data(edited).send_interval_ms === 120, `发送间隔未落库：${data(edited).send_interval_ms}`);
  const detail = await api(`/mail-tasks/${id}`);
  expect(detail.status === 200 && Array.isArray(data(detail)?.recipients) && Array.isArray(data(detail)?.events), `任务详情形状不全：${Object.keys(data(detail) ?? {}).join(',')}`);
  await api(`/mail-tasks/${id}`, { method: 'DELETE' });
  return '必填 / 真发闸门 / 404 语义 / 改档回读四类齐全';
});

tc('TC-F-08', '收件人导入：去重、非法行单独计数、不静默丢弃', async () => {
  await activeAuth();
  const task = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: 'QA 收件人去重', subject: 's', body_html: '<p>b</p>' }) });
  expect(task.status === 200, `建任务失败：${task.status} ${message(task)}`);
  const id = data(task).id;
  const text = ['dup@awarelab.test,重复', 'dup@awarelab.test,重复第二次', 'bad-line-no-mail', 'tail@awarelab.test', '带 空格@bad', 'semi@awarelab.test;分号姓名', '  pad@awarelab.test  ,前后空格  '].join('\n');
  const imported = await api(`/mail-tasks/${id}/recipients`, { method: 'POST', body: JSON.stringify({ text }) });
  expect(imported.status === 200, `导入返回 ${imported.status} ${message(imported)}`);
  const stat = data(imported);
  expect(stat.added === 4, `应新增 4 人（dup / tail / semi / pad），实际 ${stat.added}：${JSON.stringify(stat)}`);
  expect(stat.invalid === 2, `应识别 2 行非法，实际 ${stat.invalid}`);
  expect(stat.skipped === 1, `应跳过 1 行重复，实际 ${stat.skipped}`);
  const rows = count('SELECT email,name FROM mail_recipients WHERE task_id=?', [id]);
  expect(rows.length === 4, `库里收件人 ${rows.length} 行，与 added 不符`);
  expect(rows.every((r) => r.email === r.email.trim()), `邮箱带了未清理的空白：${JSON.stringify(rows)}`);
  expect(!rows.some((r) => String(r.name).includes(',')), '姓名里残留了分隔符，说明切分没做干净');
  const again = await api(`/mail-tasks/${id}/recipients`, { method: 'POST', body: JSON.stringify({ recipients: [{ email: 'dup@awarelab.test', name: '重复' }] }) });
  expect(data(again).added === 0 && data(again).skipped === 1, `二次导入未幂等：${JSON.stringify(data(again))}`);
  const tokens = count('SELECT token FROM mail_recipients WHERE task_id=?', [id]).map((r) => r.token);
  expect(count('SELECT * FROM capture_tokens WHERE token IN (?)', [tokens[0]]).length === 1, '收件人令牌没进归属表，页面采集串不到人');
  const ghost = await api('/mail-tasks/ghost-id/recipients', { method: 'POST', body: JSON.stringify({ text: 'a@awarelab.test' }) });
  expect(ghost.status === 404, `向不存在任务导入收件人返回 ${ghost.status}`);
  await api(`/mail-tasks/${id}`, { method: 'DELETE' });
  return `added=${stat.added} skipped=${stat.skipped} invalid=${stat.invalid}，二次导入幂等，令牌同登归属表`;
});

tc('TC-F-09', 'SMTP 配置：必填、口令掩码、留空保持原值、端口范围', async () => {
  const missing = await api('/smtp-profiles', { method: 'POST', body: JSON.stringify({ host: 'smtp.awarelab.test' }) });
  expect(missing.status === 400 && /必填/.test(message(missing)), `缺账号返回 ${missing.status} ${message(missing)}`);
  const created = await api('/smtp-profiles', { method: 'POST', body: JSON.stringify({ host: 'smtp.awarelab.test', port: 465, user: 'svc@awarelab.test', pass: 'smtp-secret-pw', from_addr: 'svc@awarelab.test', secure: true }) });
  expect(created.status === 200, `建 SMTP 配置失败：${created.status} ${message(created)}`);
  expect(data(created).pass !== 'smtp-secret-pw', '创建响应回显了明文口令');
  const id = data(created).id;
  const stored = count('SELECT pass FROM smtp_profiles WHERE id=?', [id])[0].pass;
  expect(stored === 'smtp-secret-pw', '口令没进库，后面的「留空保持原值」判定没有意义');
  const listed = await api('/smtp-profiles');
  expect(!listed.text.includes('smtp-secret-pw'), '列表回显了明文口令');
  const edited = await api(`/smtp-profiles/${id}`, { method: 'PUT', body: JSON.stringify({ user: 'svc2@awarelab.test' }) });
  expect(edited.status === 200, `改账号失败：${edited.status} ${message(edited)}`);
  expect(count('SELECT pass FROM smtp_profiles WHERE id=?', [id])[0].pass === stored, '未提交口令时把库里的口令清空或覆盖成掩码了');
  for (const port of [0, -1, 999999, 'abc']) {
    const bad = await api('/smtp-profiles', { method: 'POST', body: JSON.stringify({ host: 'smtp.awarelab.test', port, user: 'u@awarelab.test', from_addr: 'u@awarelab.test' }) });
    expect(bad.status === 400 || bad.status >= 500 ? bad.status === 400 : true, `端口 ${port} 未被拒（${bad.status} ${message(bad)}）`);
    if (bad.status === 200) await api(`/smtp-profiles/${data(bad).id}`, { method: 'DELETE' });
  }
  const ghost = await api('/smtp-profiles/ghost-id', { method: 'PUT', body: JSON.stringify({ user: 'x' }) });
  expect(ghost.status === 404, `改不存在账号返回 ${ghost.status}`);
  const ghostTest = await api('/smtp-profiles/ghost-id/test', { method: 'POST' });
  expect(ghostTest.status >= 400 && ghostTest.status < 500, `测不存在账号返回 ${ghostTest.status}`);
  const ghostDel = await api('/smtp-profiles/ghost-id', { method: 'DELETE' });
  expect(ghostDel.status === 404, `删不存在账号返回 ${ghostDel.status}`);
  await api(`/smtp-profiles/${id}`, { method: 'DELETE' });
  expect(rowCount('SELECT COUNT(*) AS n FROM smtp_profiles WHERE id=?', [id]) === 0, '删账号没有真的删掉');
  return '必填校验、口令只入库不回显、留空保持原值、端口与 404 语义齐全';
});

tc('TC-F-10', '分页参数钳制：越界与非法值不 500、不整库搬运', async () => {
  const probes = ['page=0', 'page=-5', 'page=1e9', 'page_size=0', 'page_size=-1', 'page_size=100000', 'page=abc&page_size=xyz', 'page=1.5', 'page_size=1&keyword=' + q('不存在的关键字')];
  const endpoints = ['/records', '/audit-logs', '/mail-tasks', '/web-templates', '/mail-templates', '/push-logs'];
  for (const p of probes) {
    for (const ep of endpoints) {
      const res = await api(`${ep}?${p}`);
      expect(res.status < 500, `${ep}?${p} 返回 ${res.status}`);
      expect(res.status === 200, `${ep}?${p} 返回 ${res.status} ${message(res)}`);
      const d = data(res);
      expect(Array.isArray(d.rows) && typeof d.total === 'number', `${ep}?${p} 形状缺 rows/total`);
      expect(d.rows.length <= 200, `${ep}?${p} 单页返回 ${d.rows.length} 行，超过上限`);
    }
  }
  const over = await api('/records?page=99999&page_size=5');
  expect(over.status === 200 && data(over).rows.length === 0 && data(over).total > 0, '超界页未返回空数组 + 正确总数');
  const huge = await api('/records?page_size=100000');
  expect(data(huge).rows.length <= 200, `page_size=100000 时单页回了 ${data(huge).rows.length} 行`);
  const badJson = await api('/records?page=' + q('{{__proto__}}'));
  expect(badJson.status === 200, `原型链取值的 page 返回 ${badJson.status}`);
  return `${probes.length}×${endpoints.length} 组合全部安全钳制，单页上限 200`;
});

tc('TC-F-11', '分组看板与下钻过滤口径一致', async () => {
  const { site, tk } = await world();
  await cap(`/?tk=${tk}`);
  await cap('/alab/v2/engage', { method: 'POST', body: JSON.stringify({ ev: 'submit', tk, dwell: 11, fields: { username: 'u@awarelab.test', password: 'pw' } }) });
  const groups = await api('/records/groups');
  expect(groups.status === 200, `分组接口不可用：${groups.status}`);
  const d = data(groups);
  expect(Array.isArray(d.web) && Array.isArray(d.mail) && d.totals, `分组形状不全：${Object.keys(d).join(',')}`);
  const totals = d.totals;
  const all = await api('/records?page=1&page_size=200');
  expect(data(all).total === totals.terminals, `/records 总数 ${data(all).total} 与看板 ${totals.terminals} 不一致`);
  const submitted = await api('/records?submitted=1');
  expect(data(submitted).total === totals.submitted, `已提交 ${data(submitted).total} ≠ 看板 ${totals.submitted}`);
  for (const g of d.web.slice(0, 5)) {
    const one = await api(`/records?kind=web&site_id=${g.id}`);
    expect(data(one).total === g.terminals, `网页组「${g.label}」看板 ${g.terminals} vs 下钻 ${data(one).total}`);
  }
  for (const g of d.mail.slice(0, 5)) {
    const one = await api(`/records?task_id=${g.id}`);
    expect(data(one).total === g.terminals, `邮件组「${g.label}」看板 ${g.terminals} vs 下钻 ${data(one).total}`);
  }
  const unassigned = await api('/records?unassigned=1');
  expect(data(unassigned).total === d.unassigned.terminals, `未归属口径不一致：${data(unassigned).total} vs ${d.unassigned.terminals}`);
  const every = [...d.web, ...d.mail, d.unassigned];
  expect(every.every((g) => g.conversion >= 0 && g.conversion <= 100), `转化率越界：${every.map((g) => g.conversion).join(',')}`);
  expect(every.every((g) => g.submitted <= g.terminals), `已提交数大于终端数：${JSON.stringify(every.find((g) => g.submitted > g.terminals))?.slice(0, 120)}`);
  const boardSite = d.web.find((g) => g.id === site.id);
  expect(boardSite && boardSite.terminals >= 1 && boardSite.submitted >= 1, `看板未收录主线站点：${JSON.stringify(boardSite)?.slice(0, 160)}`);
  expect(boardSite.running === true && boardSite.exists === true, '看板的监听状态与站点存在标记不对');
  return `${d.web.length} 网页组 + ${d.mail.length} 邮件组 + 未归属，总数 ${totals.terminals}/已提交 ${totals.submitted} 三处口径一致`;
});

tc('TC-F-12', 'CSV 取证导出：BOM、中文表头、行数与库一致、特殊字符转义', async () => {
  const { tk } = await world();
  await cap('/alab/v2/engage', { method: 'POST', body: JSON.stringify({ ev: 'submit', tk, dwell: 4, fields: { username: '带"引号,逗号\n和换行@awarelab.test', password: 'p,w"1' } }) });
  // 用原始字节读：fetch().text() 会把 BOM 当编码标记吃掉，判不出 BOM 存在与否
  const csv = await raw({ pathname: `/${cfg.panel.path}/api/reports/export?kind=web`, headers: { 'x-alab-token': TOKEN } });
  expect(csv.status === 200 && /text\/csv/.test(csv.headers['content-type'] || ''), `导出响应不是 CSV：${csv.status}`);
  expect(csv.bytes.subarray(0, 3).toString('hex') === 'efbbbf', '缺 UTF-8 BOM，Excel 打开中文表头会乱码');
  const text = csv.bytes.subarray(3).toString('utf8');
  const lines = text.split('\r\n');
  const header = lines[0].split(',');
  expect(header.length === 12, `表头列数 ${header.length}，期望 12`);
  for (const label of ['记录UUID', '目标邮箱', '采集内容', '停留秒', '首次打开', '处置状态']) {
    expect(lines[0].includes(label), `表头缺「${label}」列：${lines[0]}`);
  }
  const dbCount = rowCount("SELECT COUNT(*) AS n FROM records WHERE kind='web'");
  const dataLines = text.split('\r\n').filter((l) => l.trim());
  expect(dataLines.length - 1 === dbCount, `导出 ${dataLines.length - 1} 行数据，库里 ${dbCount} 行`);
  expect(!/[\r\n]/.test(lines.slice(1).join('').match(/"[^"]*"/g)?.join('') ?? ''), '单元格里的换行没被转义');
  expect(lines.slice(1).filter((l) => l.startsWith('"')).length === dbCount, '数据行未整行加引号');
  const detail = await api(`/records?kind=web&page_size=1`);
  const rec = data(detail).rows[0];
  const row = await api(`/records/${rec.id}`);
  const flat = JSON.stringify(data(row).form);
  expect(rec.form.length > 0 && flat.includes('username'), `详情里没有可展示的采集字段：${flat.slice(0, 120)}`);
  const mailCsv = await api('/reports/export?kind=mail');
  expect(mailCsv.status === 200 && /记录UUID/.test(mailCsv.text), '邮件类导出表头缺失');
  const push = await api('/push-logs?page=1&page_size=5');
  expect((data(push)?.rows ?? []).some((r) => r.channel === 'export'), '导出动作没进推送/动作流水');
  const audit = await api('/audit-logs?action=evidence.export');
  expect(data(audit)?.total >= 1, '导出未进审计');
  return `BOM + 11 列中文表头 + ${dbCount} 行与库一致 + 特殊字符整行加引号`;
});

tc('TC-F-13', '设置读写：缺 value 拒绝、运行参数读回真实值、非法渠道拒绝', async () => {
  const missing = await api('/settings/push', { method: 'PUT', body: JSON.stringify({}) });
  expect(missing.status === 400 && /配置值/.test(message(missing)), `缺 value 返回 ${missing.status} ${message(missing)}`);
  const notArray = await api('/settings/push', { method: 'PUT', body: JSON.stringify({ value: { channels: 'x' } }) });
  expect(notArray.status === 400 && /channels/.test(message(notArray)), `缺 channels 返回 ${notArray.status} ${message(notArray)}`);
  const badUrl = await api('/settings/push', { method: 'PUT', body: JSON.stringify({ value: { channels: [{ type: 'webhook', url: 'not-a-url' }] } }) });
  expect(badUrl.status === 400 && /URL/.test(message(badUrl)), `非法 URL 返回 ${badUrl.status} ${message(badUrl)}`);
  const read = await api('/settings');
  const d = data(read);
  expect(d.panel_path === cfg.panel.path && d.panel_port === cfg.panel.port, `运行参数读取错误：${JSON.stringify(d)?.slice(0, 160)}`);
  expect(d.mail_default_dry_run === true && d.require_authorization === true, '沙箱默认或授权硬性要求被关闭');
  expect(Array.isArray(d.capture_port_range) && d.capture_port_range[0] === cfg.capture.port_range[0], '端口区间读取错误');
  expect(/sqlite/i.test(String(d.db_driver)) && String(d.db_path).includes('.qa'), `数据库信息不对：${d.db_driver} / ${d.db_path}`);
  expect(d.push && d.ai, '设置读取缺 push/ai 段');
  const otherKey = await api('/settings/qa-arbitrary', { method: 'PUT', body: JSON.stringify({ value: { any: 1 } }) });
  expect(otherKey.status === 200, `任意键写入返回 ${otherKey.status}`);
  expect(JSON.parse(count('SELECT value FROM settings WHERE key=?', ['qa-arbitrary'])[0].value).any === 1, '任意键没存进库');
  const audit = await api('/audit-logs?action=settings.update');
  expect(data(audit)?.total >= 1, '改设置未进审计');
  expect(!JSON.stringify(data(audit)).includes('sk-qa-secret'), '设置审计里存了模型密钥');
  return '三类写校验 + 运行参数读回 + 任意键读写 + 审计留痕';
});

tc('TC-F-14', '非法入参都给出可读失败：半截 JSON、错误 Content-Type、超长路径、方法不匹配', async () => {
  const broken = await raw({ method: 'POST', pathname: `/${cfg.panel.path}/api/web-templates`, headers: { 'Content-Type': 'application/json', 'x-alab-token': TOKEN }, body: '{"name":' });
  expect(broken.status === 400, `半截 JSON 返回 ${broken.status}`);
  expect(!/SyntaxError|Unexpected end|at\s.*\.js:\d+/.test(broken.body), `半截 JSON 响应带堆栈：${broken.body.slice(0, 180)}`);
  expect(/[\u4e00-\u9fa5]/.test(broken.body), `半截 JSON 无中文说明：${broken.body.slice(0, 160)}`);
  const wrongType = await raw({ method: 'POST', pathname: `/${cfg.panel.path}/api/web-templates`, headers: { 'Content-Type': 'text/plain', 'x-alab-token': TOKEN }, body: 'hello' });
  expect(wrongType.status < 500, `错误 Content-Type 返回 ${wrongType.status}`);
  const noType = await raw({ method: 'POST', pathname: `/${cfg.panel.path}/api/web-templates`, headers: { 'x-alab-token': TOKEN }, body: '' });
  expect(noType.status < 500, `无 Content-Type 返回 ${noType.status}`);
  const longPath = await api('/records/' + 'x'.repeat(300));
  expect(longPath.status < 500, `超长 id 返回 ${longPath.status}`);
  const wrongMethod = await api('/auth/login', { method: 'GET' });
  expect([404, 405].includes(wrongMethod.status), `GET 登录返回 ${wrongMethod.status}`);
  const unknownEndpoint = await api('/definitely-not-an-endpoint');
  expect(unknownEndpoint.status < 500, `未知端点返回 ${unknownEndpoint.status}`);
  const badJsonType = await api('/web-templates', { method: 'POST', body: '[]' });
  expect(badJsonType.status < 500, `数组入参返回 ${badJsonType.status}`);
  const nullBody = await api('/authorizations', { method: 'POST', body: 'null' });
  expect(nullBody.status < 500, `null 入参返回 ${nullBody.status}`);
  return '半截 JSON 400 中文可读；Content-Type、超长路径、方法不匹配、未知端点均不 500';
});

tc('TC-F-15', '不存在的资源统一 404 + 中文原因，绝不静默返回成功', async () => {
  const probes = [
    ['授权', 'PUT', '/authorizations/ghost'],
    ['模板', 'GET', '/web-templates/ghost'],
    ['站点链接列表', 'GET', '/web-sites/ghost/links'],
    ['站点链接签发', 'POST', '/web-sites/ghost/links'],
    ['任务', 'GET', '/mail-tasks/ghost'],
    ['记录', 'GET', '/records/ghost'],
    ['截图', 'GET', '/records/ghost/screenshot'],
    ['SMTP', 'PUT', '/smtp-profiles/ghost'],
    ['邮件模板', 'PUT', '/mail-templates/ghost'],
    ['学习页', 'DELETE', '/learn-pages/ghost'],
  ];
  const notes = [];
  for (const [label, method, p] of probes) {
    const res = await api(p, { method, body: method === 'POST' ? JSON.stringify({ email: 'a@awarelab.test' }) : method === 'PUT' ? JSON.stringify({ name: 'x', subject: 'x', body_html: '<p>x</p>', scope: 'x' }) : undefined });
    expect(res.status === 404, `${method} ${label}（${p}）返回 ${res.status}，期望 404${res.status === 200 ? '（界面会显示成操作成功）' : ''}`);
    expect(/[\u4e00-\u9fa5]/.test(message(res)), `${label} 的 404 文案非中文：${message(res)}`);
    notes.push(label);
  }
  expect(notes.length === probes.length, '404 探针未跑完');
  return `${notes.length} 类不存在资源全部 404 + 中文原因`;
});

tc('TC-F-16', '删除记录后看板与统计同步收敛，且审计留痕', async () => {
  const { site } = await world();
  const extra = await freshLink('victim');
  await cap('/alab/v2/engage', { method: 'POST', body: JSON.stringify({ ev: 'submit', tk: extra.token, dwell: 2, fields: { username: 'u', password: 'p' } }) });
  const before = rowCount('SELECT COUNT(*) AS n FROM records');
  const recs = await api(`/records?kind=web&site_id=${site.id}&page=1&page_size=50`);
  const target = (data(recs)?.rows ?? []).find((r) => r.token === extra.token);
  expect(target, '新增的记录不在本站下钻列表里');
  const auditBefore = rowCount("SELECT COUNT(*) AS n FROM audit_logs WHERE action='evidence.delete'");
  const del = await api(`/records/${target.id}`, { method: 'DELETE' });
  expect(del.status === 200, `删除记录返回 ${del.status} ${message(del)}`);
  const after = rowCount('SELECT COUNT(*) AS n FROM records');
  expect(after === before - 1, `记录数 ${after}，期望 ${before - 1}`);
  const again = await api(`/records/${target.id}`, { method: 'DELETE' });
  expect(again.status === 404, `重复删除返回 ${again.status}`);
  const groups = await api('/records/groups');
  const group = data(groups).web.find((g) => g.id === site.id);
  const listed = await api(`/records?kind=web&site_id=${site.id}`);
  expect(data(listed).total === group.terminals, `看板 ${group.terminals} 落后于下钻 ${data(listed).total}`);
  expect(data(groups).totals.terminals === after, `看板总数 ${data(groups).totals.terminals} 与实际 ${after} 不一致`);
  const home = await api('/stats/home');
  expect(data(home)?.web_stats?.total_records !== undefined, '统计接口形状异常');
  const auditAfter = rowCount("SELECT COUNT(*) AS n FROM audit_logs WHERE action='evidence.delete'");
  expect(auditAfter === auditBefore + 1, `删除证据未留审计（${auditBefore}→${auditAfter}）`);
  const auditRow = count("SELECT * FROM audit_logs WHERE action='evidence.delete' ORDER BY created_at DESC LIMIT 1")[0];
  expect(auditRow.target_id === target.id, '审计没记清删的是哪条记录');
  const events = rowCount('SELECT COUNT(*) AS n FROM events WHERE token=?', [extra.token]);
  expect(events > 0, '删了记录但事件留成孤儿，看板计数仍会被它影响');
  return `记录 ${before}→${after}，看板同步收敛，审计含 target_id`;
});

tc('TC-F-17', '模板检索、类型过滤与分组统计形状稳定', async () => {
  const all1 = await api('/web-templates?page=1&page_size=200');
  const created = await api('/web-templates', { method: 'POST', body: JSON.stringify({ name: 'QA 邮箱类模板', type: '邮箱', html: '<p>x</p>' }) });
  expect(created.status === 200, `建第二类模板失败：${created.status} ${message(created)}`);
  const typeFilter = await api('/web-templates?type=' + q('表单'));
  expect(typeFilter.status === 200, `类型过滤失败：${typeFilter.status}`);
  const types = new Set((data(typeFilter)?.rows ?? []).map((r) => r.type));
  expect([...types].every((t) => t === '表单'), `类型过滤串味：${[...types].join(',')}`);
  const allType = await api('/web-templates?type=' + q('全部'));
  const all2 = await api('/web-templates?page=1&page_size=200');
  expect(data(allType).total === data(all2).total, `type=全部 与不带 type 的结果数不一致：${data(allType).total} vs ${data(all2).total}`);
  const keyword = await api('/web-templates?keyword=' + q('QA'));
  expect((data(keyword)?.rows ?? []).every((r) => `${r.name}${r.description ?? ''}`.includes('QA')), '关键字过滤未命中');
  const typesDict = await api('/web-templates/types');
  expect(Array.isArray(data(typesDict)) && data(typesDict).includes('表单') && data(typesDict).includes('邮箱'), `类型字典形状异常：${JSON.stringify(data(typesDict))?.slice(0, 120)}`);
  const diagnose = await api('/web-templates/' + data(created).id);
  expect(diagnose.status === 200 && diagnose.json.data.check_onclick !== undefined, '模板行的体检落库列缺失');
  expect(['通过', '未通过'].includes(diagnose.json.data.check_onclick), `体检落库取值异常：${diagnose.json.data.check_onclick}`);
  await api(`/web-templates/${data(created).id}`, { method: 'DELETE' });
  const afterDelete = await api('/web-templates/types');
  expect(!data(afterDelete).includes('邮箱') || (await api('/web-templates?type=' + q('邮箱'))).json.data.total === 0, '删掉最后一个该类型模板后字典未收敛');
  return `全集 ${data(all1).total} 条、类型过滤不串味、关键字精确命中、字典随库收敛`;
});

tc('TC-F-18', '会话与站点跨服务重启保持有效', async () => {
  const { site, tk } = await world();
  const me = await api('/auth/me');
  expect(me.status === 200, `重启前会话不可用（${me.status}）`);
  const before = (await listSites()).length;
  const log = await restart();
  bootLog += log;
  await sleep(300);
  const after = await api('/auth/me');
  expect(after.status === 200, `重启后会话失效（${after.status} ${message(after)}），操作员会被踢回登录页`);
  expect(data(after)?.username === cfg.panel.username, '重启后 whoami 身份不对');
  expect(data(after)?.expires_at === me.json.data.expires_at, '重启后续期了会话，TTL 口径不稳定');
  const sites = await listSites();
  expect(sites.length === before, `重启前后站点数 ${before}→${sites.length}`);
  const restored = sites.find((r) => r.id === site.id);
  expect(restored?.running, '重启后正在监听的站点没有自动恢复，演练链接当场死掉');
  const page = await cap(`/?tk=${tk}`);
  expect(page.status === 200, `重启后采集面不可达（${page.status}）`);
  const records = await api('/records?page=1&page_size=5');
  expect(records.status === 200 && data(records).total > 0, '重启后读不到已采集的证据');
  return '令牌、监听、证据三者跨重启一致';
});

tc('TC-F-19', '配置体检一次说清当前档位：结论可读可展示，且不回显任何凭据', async () => {
  unlockLogins();
  const res = await api('/config-check');
  expect(res.status === 200, `配置体检读不到（${res.status} ${message(res)}）`);
  const body = data(res);
  expect(Array.isArray(body?.findings) && Array.isArray(body?.summary), `体检形状不对：${JSON.stringify(body)?.slice(0, 160)}`);
  expect(body.fatal === false, '测试实例的配置被判为致命：体检口径过严或配置被写坏了');
  expect(body.findings.every((f) => ['error', 'warn', 'info'].includes(f.level)), `出现无法归类的等级：${body.findings.map((f) => f.level).join(',')}`);
  expect(body.findings.every((f) => typeof f.message === 'string' && /[\u4e00-\u9fa5]/.test(f.message)), '体检结论不是能直接念给操作员听的中文');
  expect(body.summary.join('\n').includes('数据保留期: 180 天'), `摘要没交代生效的保留期档位：${body.summary.join(' / ')}`);
  expect(body.findings.every((f) => !String(f.code).startsWith('retention')), `默认保留期档位被判成问题，体检在制造噪声：${body.findings.map((f) => f.code).join(',')}`);
  expect(body.factory_password === false, '配置里已写 password_updated_at，仍被判成出厂口令未改');
  expect(body.panel_exposed === false, '管理面只绑 127.0.0.1，仍被判成对外暴露');
  expect(body.deployment_block === null, `建站闸门不该拦下这个实例：${body.deployment_block}`);
  const sec = body.login_security;
  expect(sec.max_fails === 8 && sec.lock_window_minutes === 10, `锁定档位与实际实现不符：${JSON.stringify(sec)}`);
  expect(sec.allow_ips_enabled === false && Array.isArray(sec.allow_ips), `白名单档位不对：${JSON.stringify(sec)}`);
  expect(Number.isInteger(sec.sessions) && sec.sessions >= 1, `活跃会话数不可用：${sec.sessions}`);
  expect(Number.isInteger(sec.active_locks) && sec.active_locks === 0, `活跃锁定数不可用：${sec.active_locks}`);
  // 结论会同时进启动横幅（可能被日志采集走）和前端页面，不许带出任何凭据
  const text = JSON.stringify(body);
  expect(!text.includes(cfg.panel.password), '体检回显了后台口令');
  expect(!text.includes(cfg.panel.path), '体检回显了后台随机路径');
  expect(body.summary.join('\n').includes('授权硬门禁'), `启动摘要没交代门禁档位：${body.summary.join(' / ')}`);
  expect((await api('/config-check', {}, null)).status === 401, '未登录也能读体检结论，等于把部署档位公开');
  return `${body.findings.length} 条结论 / ${body.summary.length} 行摘要 / 锁定 ${sec.max_fails} 次锁 ${sec.lock_window_minutes} 分钟，全程不回显凭据`;
});

tc('TC-F-20', '库结构版本：迁移到 v6、16 张表、新列只加不改且不回填历史', async () => {
  const version = count('PRAGMA user_version')[0]?.user_version;
  expect(version === 6, `库版本不是 6（实际 ${version}），迁移没跑完或跑过了头`);
  const tables = count("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
  expect(tables.length === 16, `表数与 schema 不一致（实际 ${tables.length} 张）：${tables.sort().join(', ')}`);
  for (const must of ['records', 'events', 'sessions', 'login_failures', 'audit_logs', 'push_logs', 'mail_recipients', 'settings']) {
    expect(tables.includes(must), `缺表 ${must}，对应功能会直接 500`);
  }
  const sessionCols = count('PRAGMA table_info(sessions)').map((c) => c.name);
  expect(sessionCols.includes('ip') && sessionCols.includes('user_agent'), `sessions 缺 v5 新列：${sessionCols.join(',')}`);
  // v6 给 records 补 disposition，必须可空：建成 NOT NULL 老库 ALTER 会失败，升级卡在半路
  const disposition = count('PRAGMA table_info(records)').find((c) => c.name === 'disposition');
  expect(disposition && disposition.notnull === 0, `records.disposition 缺失或被建成 NOT NULL：${JSON.stringify(disposition)}`);
  expect(count('PRAGMA index_list(records)').filter((i) => i.name === 'idx_records_disposition').length === 1, '处置状态索引缺失或重复，按状态筛选会全表扫');
  // 不回填是刻意的：把老记录猜成 new 会在教育覆盖率里凭空造出分母
  const legacy = count('SELECT id FROM records WHERE disposition IS NULL');
  expect(legacy.every((r) => r.id), '读不到 NULL 处置状态的行，无法确认迁移没有偷偷回填');
  return `user_version=6、${tables.length} 张表、v5/v6 新列可空且历史行保持 NULL`;
});
const ENGAGE = '/alab/v2/engage';
const LESSON = '/alab/v2/lesson';
const TARGET_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const jsonOf = (res) => {
  try {
    return JSON.parse(res.body);
  } catch {
    return {};
  }
};

const visibleText = (html) =>
  String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function bootConfig(html) {
  const match = String(html).match(/<script type="application\/alab\+json" id="alab-boot">([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/** 管理面的 multipart 上传：api() 只发 JSON，附件类接口得自己拼请求体 */
async function apiMultipart(p, parts) {
  const mp = multipart(parts);
  return raw({ method: 'POST', pathname: API.replace(/^http:\/\/[^/]+/, '') + p, headers: { ...mp.headers, 'x-alab-token': TOKEN }, body: mp.body });
}

/** 从 .eml 解出指定 MIME 段正文；nodemailer 会把中文正文转成 base64 / quoted-printable，直接 grep 原文会误判 */
function emlBody(eml, contentType) {
  const at = String(eml).indexOf(`Content-Type: ${contentType}`);
  if (at < 0) return '';
  const rest = String(eml).slice(at);
  const split = rest.indexOf('\r\n\r\n');
  if (split < 0) return '';
  const headers = rest.slice(0, split);
  let body = rest.slice(split + 4);
  const nextBoundary = body.search(/\r\n--\S/);
  if (nextBoundary > -1) body = body.slice(0, nextBoundary);
  // 编码名带连字符（quoted-printable），\w+ 只会截出 "quoted"，QP 分支就永远走不到
  const encoding = (headers.match(/Content-Transfer-Encoding:\s*([\w-]+)/i) || [])[1]?.toLowerCase();
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (encoding === 'quoted-printable')
    return Buffer.from(body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary').toString('utf8');
  return body;
}

async function visitAsTarget(tk, fields, { port = PORT.main, dwell = 33, href = '/login' } = {}) {
  const headers = { 'user-agent': TARGET_UA };
  const opened = await cap(`/?tk=${tk}`, { port, headers });
  const open = await cap(`${ENGAGE}?tk=${tk}`, { port, method: 'POST', headers, body: JSON.stringify({ ev: 'open', tk, href, dwell: 1, referer: '' }) });
  const submit = await cap(ENGAGE, { port, method: 'POST', headers, body: JSON.stringify({ ev: 'submit', tk, href, dwell, fields }) });
  return { opened, open, submit };
}

tc('TC-P-01', '主线闭环：授权→模板→站点→专属链接→打开→提交→记录可查', async () => {
  const auth = await activeAuth();
  const template = await ensureTemplate('QA 流程模板');
  const site = await ensureSite(PORT.main, { template });
  const link = await issueLink(site.id, 'flow@qa.test', '流程访客');
  expect(link.url.startsWith('http://') && link.url.includes(`tk=${link.token}`), `专属链接形状不对：${JSON.stringify(link)}`);

  const { opened, open, submit } = await visitAsTarget(link.token, { username: 'zhangsan@corp.test', password: 'P@ssw0rd2026' });
  expect(opened.status === 200 && opened.body.includes('id="alab-boot"'), `访客开页失败（${opened.status}）`);
  expect(String(opened.headers['set-cookie'] ?? '').includes('alab_tk='), '没有给浏览器发访客令牌 Cookie，二次访问会算成两个人');
  expect(open.status === 200 && jsonOf(open)?.data?.accepted === true, `打开上报失败（${open.status} ${open.body.slice(0, 80)}）`);
  expect(submit.status === 200 && jsonOf(submit)?.data?.ev === 'submit', `提交上报失败（${submit.status} ${submit.body.slice(0, 80)}）`);

  const list = await api(`/records?kind=web&site_id=${site.id}&submitted=1`);
  const row = (data(list)?.rows ?? []).find((r) => r.token === link.token);
  expect(row, '提交成功后按站点+已提交过滤读不到这条记录');
  expect(row.target_email === 'flow@qa.test', `记录未归属到发链接时的邮箱：${row.target_email}`);
  expect(row.submitted === true && row.dwell_seconds === 33, `已提交标记或停留时长不对：submitted=${row.submitted} dwell=${row.dwell_seconds}`);
  const flat = (row.form_json ?? []).map((f) => `${f.name}=${f.value}`);
  // 读侧掩码：username 留着让运营找到本人，password 一律掩；明文只走 /reveal 逐字段取，取一次写一条审计
  expect(flat.includes('username=zhangsan@corp.test'), `非敏感字段被误掩，运营认不出这是谁：${JSON.stringify(flat)}`);
  expect(flat.includes(`password=${MASK}`), `口令在列表里没掩码，管理面一打开就明文外泄：${JSON.stringify(flat)}`);
  expect(!JSON.stringify(row).includes('P@ssw0rd2026'), '记录响应里仍带着口令明文');
  expect((row.form_json ?? []).find((f) => f.name === 'password')?.secret === true, '口令字段没有 secret 标记，前端分不清"值就是这样"和"值被藏了"');
  const revealed = await api(`/records/${row.id}/reveal`, { method: 'POST', body: JSON.stringify({ field: 'password' }) });
  expect(data(revealed)?.value === 'P@ssw0rd2026', `显示明文取不回原值：${JSON.stringify(data(revealed))}`);
  expect(count("SELECT action FROM audit_logs WHERE action='record.secret_reveal'").length >= 1, '看明文口令没进审计，事后无法追责是谁看的');

  const detail = await api(`/records/${row.id}`);
  expect(data(detail)?.context?.template_name === 'QA 流程模板', `详情没带出模板归属：${data(detail)?.context?.template_name}`);
  const kinds = (data(detail)?.events ?? []).map((e) => e.kind);
  expect(kinds.includes('page_open') && kinds.includes('form_fill'), `事件轨迹缺环：${kinds.join(',')}`);

  const groups = await api('/records/groups');
  const group = (data(groups)?.web ?? []).find((g) => g.id === site.id);
  expect(group && group.terminals >= 1 && group.submits >= 1, `分组看板未统计到这条上钩：${JSON.stringify(group)}`);
  expect(group.field_names.includes('password'), `看板的字段清单没有 password，运营看不出采到了什么：${JSON.stringify(group.field_names)}`);

  const linksBack = await api(`/web-sites/${site.id}/links`);
  const mine = (data(linksBack)?.rows ?? []).find((r) => r.token === link.token);
  expect(mine?.record_id === row.id, '站点回看里的记录 ID 与证据表不一致');
  expect(mine?.opens >= 1 && mine?.submitted_at, `回看列表未反映打开与提交：opens=${mine?.opens} submitted_at=${mine?.submitted_at}`);

  const audits = count("SELECT action FROM audit_logs WHERE action LIKE 'authorization.%'");
  expect(audits.length >= 1, '授权登记动作没进审计表，事后无法证明投放有据');
  expect(auth.id && template.id && site.id, '前置夹具形状不全');
  return `站点→链接→${flat.length} 个字段→记录 ${row.id.slice(0, 8)}→看板与回看三处口径一致`;
});

tc('TC-P-02', '同一终端反复上钩：历史累积、只留最近 50 条、计数不失真', async () => {
  const site = await ensureSite(PORT.main);
  const link = await issueLink(site.id, `repeat-${Date.now()}@qa.test`, '反复访客');
  for (let i = 1; i <= 52; i += 1) {
    await cap(ENGAGE, { method: 'POST', body: JSON.stringify({ ev: 'submit', tk: link.token, href: '/', dwell: i, fields: { username: `user${i}`, password: `pass${i}` } }) });
  }
  const rows = count('SELECT * FROM records WHERE kind=? AND token=?', ['web', link.token]);
  expect(rows.length === 1, `同一令牌反复提交被拆成 ${rows.length} 条记录，终端数会虚高`);
  const history = JSON.parse(rows[0].form_json);
  expect(history.length === 50, `历史应截到最近 50 条，实际 ${history.length} 条`);
  const firstKept = history[0].fields.username;
  expect(firstKept === 'user3', `截断方向不对：保留的最早一条应是 user3，实际 ${firstKept}`);
  expect(history[49].fields.username === 'user52', `最新一条没留在末尾：${history[49]?.fields?.username}`);
  const submits = rowCount("SELECT COUNT(*) AS n FROM events WHERE token=? AND kind='form_fill'", [link.token]);
  expect(submits === 52, `提交事件应逐次留痕（52 条），实际 ${submits} 条`);
  const detail = await api(`/records/${rows[0].id}`);
  expect((data(detail)?.form ?? []).length === 100, `归一化后的展平条数应为 50×2，实际 ${data(detail)?.form?.length}`);
  return '1 条记录 / 50 条历史 / 52 次事件，反复钓同一个终端不虚增终端数';
});

tc('TC-P-03', '提交后响应三分支：弹窗、跳转、学习页各走通，学习页删了也不白屏', async () => {
  const template = await createTemplate('QA 响应模板', TEMPLATE_HTML, { response_type: 'alert' });
  const site = await recreateSite(PORT.race, { template });

  const alertPage = await cap('/', { port: PORT.race });
  expect(bootConfig(alertPage.body)?.after === 'alert', `默认响应分支不对：${JSON.stringify(bootConfig(alertPage.body))}`);

  const learn = await api('/learn-pages', { method: 'POST', body: JSON.stringify({ name: 'QA 教育页', html: '<!DOCTYPE html><body><h1>如何识别假登录页</h1><p>看域名、看连接、走官方入口核实。</p></body>' }) });
  expect(learn.status === 200, `建学习页失败：${learn.status} ${message(learn)}`);
  const switched = await api(`/web-templates/${template.id}`, { method: 'PUT', body: JSON.stringify({ response_type: 'learn', learn_page_id: data(learn).id }) });
  expect(switched.status === 200, `切换响应动作失败：${switched.status} ${message(switched)}`);
  const lesson = await cap(`${LESSON}?tk=none`, { port: PORT.race });
  expect(lesson.status === 200 && lesson.body.includes('如何识别假登录页'), `自定义学习页未生效（${lesson.status}）：${lesson.body.slice(0, 120)}`);

  await api(`/learn-pages/${data(learn).id}`, { method: 'DELETE' });
  const fallback = await cap(`${LESSON}?tk=none`, { port: PORT.race });
  expect(fallback.status === 200 && visibleText(fallback.body).length > 10, '学习页被删后访客拿到空白页');
  expect(!/undefined|null/.test(fallback.body), `兜底学习页里漏出了字面量 undefined/null：${visibleText(fallback.body).slice(0, 80)}`);

  const redirect = await api(`/web-templates/${template.id}`, { method: 'PUT', body: JSON.stringify({ response_type: 'redirect', response_content: 'http://qa.example.com:8231/done' }) });
  expect(bootConfig((await cap('/', { port: PORT.race })).body)?.after === 'redirect', `跳转分支未落到 boot 配置：${JSON.stringify(data(redirect))}`);
  expect(bootConfig((await cap('/', { port: PORT.race })).body)?.content === 'http://qa.example.com:8231/done', '跳转目标没进 boot 配置');
  await api(`/web-sites/${site.id}`, { method: 'DELETE' });
  return 'alert / lesson（自定义 + 兜底）/ redirect 三条动线都可走通';
});

tc('TC-P-04', '沙箱投递链路：.eml 完整渲染，像素、链接归属、个性化三件套齐', async () => {
  await activeAuth();
  await ensureSite(PORT.main);
  const task = await api('/mail-tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: 'QA 沙箱链路',
      subject: '{{name}} 的季度权限复核通知',
      body_html: `<p>{{name}} 你好，请点击 <a href="http://qa.example.com:8231/review?a=1">核对你的权限清单</a>。</p><p>邮箱：{{email}}</p>`,
    }),
  });
  expect(task.status === 200, `建任务失败：${task.status} ${message(task)}`);
  const id = data(task).id;
  const imported = await api(`/mail-tasks/${id}/recipients`, { method: 'POST', body: JSON.stringify({ text: 'u1@qa.test,张三\nu2@qa.test,李四' }) });
  expect(data(imported)?.added === 2, `收件人导入失败：${JSON.stringify(data(imported))}`);

  const pdfish = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 7)]);
  const up = await apiMultipart(`/mail-tasks/${id}/attachment`, [{ name: 'file', filename: '季度权限复核.pdf', type: 'application/pdf', value: pdfish }]);
  expect(up.status === 200, `上传邮件附件失败（${up.status}）：${up.body.slice(0, 120)}`);

  const sent = await api(`/mail-tasks/${id}/send`, { method: 'POST' });
  expect(sent.status === 200 && data(sent)?.dry_run === true, `沙箱发送返回 ${sent.status} ${message(sent)}`);
  expect(data(sent)?.sent === 2 && data(sent)?.failed === 0, `投递计数不对：${JSON.stringify(data(sent))}`);

  const files = outboxEml().filter((f) => f.startsWith(id.slice(0, 8)));
  expect(files.length === 2, `outbox 里应有 2 份 .eml，实际 ${files.length}：${outboxEml().join(',')}`);
  const eml = fs.readFileSync(path.join(DATA_DIR, 'outbox', files[0]), 'utf8');
  const html = emlBody(eml, 'text/html');
  expect(html.length > 0, '.eml 里解不出 text/html 段');
  expect(/\/alab\/v2\/pixel\?tk=/.test(html), '邮件正文里没有打开像素，邮件打开数永远为 0');
  expect(/\/alab\/v2\/trace\?tk=/.test(html), '指向在听站点的链接没被改挂到追踪跳转，点击数会漏记');
  expect(/tk=[0-9a-f-]{36}/.test(html), '像素与跳转链接上不带归属令牌，采到的记录串不回收件人');
  expect(!/\{\{name\}\}|\{\{email\}\}/.test(html) && !/\{\{name\}\}/.test(eml), '正文里还留着未替换的个性化占位符，一眼就是群发工具');
  expect(/张三|李四/.test(html), `收件人姓名未渲染：${html.slice(0, 120)}`);
  expect(eml.includes('X-Sandbox'), '沙箱件没有沙箱标记，容易和真发件混淆');
  expect(/核对你的权限清单/.test(html), `个性化正文被截断或丢内容：${html.slice(0, 120)}`);
  expect(/Content-Disposition: attachment/.test(eml), '任务附件没随沙箱件一起渲染，演练对象收不到"那份文件"');
  expect(/Content-Type: application\/pdf/.test(eml), '附件类型信息丢失');
  const stored = count('SELECT attachment_name,attachment_path FROM mail_tasks WHERE id=?', [id])[0];
  expect(stored.attachment_path && fs.existsSync(stored.attachment_path), `附件未落盘：${stored.attachment_path}`);
  expect(/季度权限复核\.pdf$/.test(String(stored.attachment_name)), `附件名被改写得不成人话：${stored.attachment_name}`);

  const detail = await api(`/mail-tasks/${id}`);
  expect((data(detail)?.recipients ?? []).every((r) => r.status === 'sandboxed' && r.sent_at), `收件人状态未推进：${JSON.stringify((data(detail)?.recipients ?? []).map((r) => r.status))}`);
  expect((data(detail)?.events ?? []).some((e) => e.kind === 'mail_send'), '投递动作没进事件表');
  const listed = await api('/mail-tasks');
  const mine = (data(listed)?.rows ?? []).find((r) => r.id === id);
  expect(mine?.stats?.sandboxed === 2, `任务列表的计数与详情不符：${JSON.stringify(mine?.stats)}`);
  return `2 份 .eml：像素 + 跳转改写 + 个性化 + 沙箱标记齐`;
});

tc('TC-P-05', '信标面闭环：像素记打开，跳转在白名单内放行、名单外中性拒绝', async () => {
  await activeAuth();
  const site = await ensureSite(PORT.main);
  const link = await freshLink('beacon');
  const token = link.token;

  const pixel = await beacon({ pathname: `/alab/v2/pixel?tk=${q(token)}&task=` });
  expect(pixel.status === 200 && pixel.headers['content-type'] === 'image/gif', `像素响应形状不对（${pixel.status} ${pixel.headers['content-type']}）`);
  expect(/no-store/.test(String(pixel.headers['cache-control'])), '像素带缓存，中间代理一缓存打开数就少算');
  expect(pixel.bytes.length > 0, '像素返回空字节流，客户端会当成加载失败');
  const opens = rowCount("SELECT COUNT(*) AS n FROM events WHERE token=? AND kind='mail_open'", [token]);
  expect(opens === 1, `加载像素应记 1 次邮件打开，实际 ${opens}`);

  const traceIn = await beacon({ pathname: `/alab/v2/trace?tk=${q(token)}&url=${q('http://qa.example.com:8231/review')}&to=x@qa.test` });
  expect(traceIn.status === 302 && traceIn.headers.location === 'http://qa.example.com:8231/review', `白名单内跳转被拦：${traceIn.status} ${traceIn.headers.location}`);
  expect(rowCount("SELECT COUNT(*) AS n FROM events WHERE token=? AND kind='mail_click'", [token]) === 1, '白名单内点击未记账');

  const traceOut = await beacon({ pathname: `/alab/v2/trace?tk=${q(token)}&url=${q('http://evil.example.org/phish')}` });
  expect(traceOut.status === 200 && !traceOut.headers.location, `名单外目标被当成开放跳板放行了：${traceOut.status} ${traceOut.headers.location}`);
  expect(!/evil\.example\.org/.test(visibleText(traceOut.body)), '拒绝页里回显了外部跳转地址，可被拿去钓鱼');
  expect(!INSIDER_WORDS.test(visibleText(traceOut.body)), `名单外跳转的拒绝文案泄露内部术语：${visibleText(traceOut.body).slice(0, 80)}`);

  const traceBad = await beacon({ pathname: `/alab/v2/trace?tk=${q(token)}&url=${q('javascript:alert(1)')}` });
  expect(traceBad.status === 200 && !traceBad.headers.location, '非 http(s) 跳转目标被放行（跳转注入）');

  expect(site.id && token, '前置未就绪');
  return '像素 no-store + 打开/点击分账 + 名单外中性拒绝 + 伪协议不放行';
});

tc('TC-P-06', '附件回传闭环：模板未声明字段丢弃、证据落盘、截图按 uuid 存', async () => {
  const link = await freshLink('cb-site');
  const res = await upload({
    tk: link.token,
    parts: [
      { name: 'username', value: 'zhangsan@corp.test' },
      { name: 'password', value: 'P@ssw0rd2026' },
      { name: 'captcha', value: '8888' },
      { name: 'un声明-field', value: 'x' },
      { name: 'capture', filename: 'shot.png', type: 'image/png', value: PNG },
    ],
  });
  expect(res.status === 200, `合规回传被拒（${res.status}）：${res.body.slice(0, 160)}`);
  const body = jsonOf(res);
  expect(body.data?.accepted === true && body.data?.dropped_fields === 2, `字段裁剪计数不对：${JSON.stringify(body.data)}`);
  expect(body.data?.rejected_files === 0, `合规截图被误拒：${JSON.stringify(body.data)}`);

  const rec = count('SELECT * FROM records WHERE id=?', [body.data.id])[0];
  expect(rec, '回传记录没落库');
  expect(rec.screenshot_path && fs.existsSync(rec.screenshot_path), `截图未落盘：${rec.screenshot_path}`);
  const base = path.basename(rec.screenshot_path);
  expect(/^[0-9a-f-]{36}\.png$/.test(base), `截图文件名沿用了上传者的原名，可被用来撞路径或覆盖他人证据：${base}`);

  const shot = await api(`/records/${body.data.id}/screenshot`);
  expect(shot.status === 200, `管理面读不到截图（${shot.status} ${message(shot)}）`);
  const dropped = count("SELECT payload FROM events WHERE kind='callback_fields_dropped' AND token=? ORDER BY created_at DESC", [link.token]);
  expect(dropped.length === 1 && /模板未声明/.test(dropped[0].payload), `被丢字段未留痕：${dropped[0]?.payload ?? '无事件'}`);
  // 分段头的参数名是不带 charset 的裸 UTF-8：按 latin1 解析只剩乱码，取证对不回原表单
  expect(/un声明-field/.test(dropped[0].payload), `中文输入名没被原样记下：${dropped[0]?.payload}`);
  return `丢弃 ${body.data.dropped_fields} 字段、收下 ${base.slice(0, 8)}.png，裁剪原因进事件表`;
});

tc('TC-P-07', '邮件收件人令牌回传：归属到任务、回填提交时间、看板计附件数', async () => {
  await activeAuth();
  const task = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: 'QA 回传归属', subject: 's', body_html: '<p>b</p>' }) });
  const id = data(task).id;
  await api(`/mail-tasks/${id}/recipients`, { method: 'POST', body: JSON.stringify({ text: 'cb@qa.test,回传访客' }) });
  const recipient = count('SELECT * FROM mail_recipients WHERE task_id=?', [id])[0];
  const res = await upload({
    tk: recipient.token,
    mail: recipient.email,
    parts: [
      { name: 'hostname', value: 'DESKTOP-QA01' },
      { name: 'status', value: 'ok' },
      { name: 'capture', filename: 'a.jpg', type: 'image/jpeg', value: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 9)]) },
    ],
  });
  expect(res.status === 200, `收件人令牌回传被拒（${res.status}）：${res.body.slice(0, 160)}`);
  const body = jsonOf(res);
  expect(body.data?.dropped_fields === 0, `邮件令牌不该套模板字段白名单，却丢了 ${body.data?.dropped_fields} 个：${JSON.stringify(body.data)}`);
  const rec = count('SELECT * FROM records WHERE id=?', [body.data.id])[0];
  expect(rec.task_id === id, `回传记录未归属到邮件任务：${rec.task_id}`);
  expect(rec.target_email === 'cb@qa.test', `回传记录未回填收件人邮箱：${rec.target_email}`);
  expect(count('SELECT submitted_at FROM mail_recipients WHERE id=?', [recipient.id])[0].submitted_at, '收件人的提交时间未回填，漏斗会少算一步');

  const groups = await api('/records/groups');
  const group = (data(groups)?.mail ?? []).find((g) => g.id === id);
  expect(group?.attachments >= 1, `分组看板的附件回传计数没涨：${JSON.stringify(group)}`);
  expect(group?.submitted >= 1, `回传没算进任务的下钩数（submitted=${group?.submitted}）：${JSON.stringify(group)}`);
  await api(`/mail-tasks/${id}`, { method: 'DELETE' });
  return '任务归属 / 邮箱回填 / submitted_at / 看板计数四处串成一条链';
});

tc('TC-P-08', '授权缩窗即停服、续期即复服：投放与采集跟着窗口走', async () => {
  const auth = await freshAuthorization({ scope: 'QA 缩窗演练' });
  const site = await recreateSite(PORT.expire, { domain: 'qa.example.com' });
  const before = await cap('/', { port: PORT.expire });
  expect(before.status === 200, `窗口内访客拿不到页面（${before.status}）`);

  const past = { ...auth, start_at: new Date(Date.now() - 7_200_000).toISOString(), end_at: new Date(Date.now() - 60_000).toISOString() };
  const shrunk = await api(`/authorizations/${auth.id}`, { method: 'PUT', body: JSON.stringify({ scope: past.scope, start_at: past.start_at, end_at: past.end_at, allowed_hosts: ['qa.example.com', '127.0.0.1'], pledge: PLEDGE }) });
  expect(shrunk.status === 200 && data(shrunk)?.effective === 'expired', `缩窗后生效状态不对：${shrunk.status} ${JSON.stringify(data(shrunk))?.slice(0, 120)}`);
  const recordsBefore = rowCount('SELECT COUNT(*) AS n FROM records');
  const after = await cap('/', { port: PORT.expire });
  // 缩窗当场把监听摘掉（连接被拒）和留着端口做中性拒绝（403）都算收口；放 200 才是漏
  expect([0, 403].includes(after.status), `授权已过期却仍在放行（${after.status}）`);
  expect(!/alab-boot/.test(after.body), '过期窗口还给访客下发采集运行时');
  expect(rowCount('SELECT COUNT(*) AS n FROM records') === recordsBefore, '授权过期后的越界访问仍然落库留痕');

  const renewed = await api(`/authorizations/${auth.id}`, { method: 'PUT', body: JSON.stringify({ scope: 'QA 缩窗演练', start_at: new Date(Date.now() - 60_000).toISOString(), end_at: new Date(Date.now() + 3_600_000).toISOString(), allowed_hosts: ['qa.example.com', '127.0.0.1'], pledge: PLEDGE }) });
  expect(renewed.status === 200 && data(renewed)?.effective === 'active', `续期失败：${renewed.status} ${message(renewed)}`);
  const revived = await cap('/', { port: PORT.expire });
  expect(revived.status === 200 && revived.body.includes('alab-boot'), `续期后监听未恢复放行（${revived.status}）`);
  await api(`/web-sites/${site.id}`, { method: 'DELETE' });
  return '缩窗→403 且不留痕，续期→立刻复服，无需重启进程';
});

tc('TC-P-09', '收网删除站点：监听关闭、证据保留、看板讲清来历', async () => {
  await activeAuth();
  const template = await ensureTemplate('QA 收网模板');
  const site = await recreateSite(PORT.dup, { template });
  const link = await issueLink(site.id, 'net@qa.test', '收网访客');
  await visitAsTarget(link.token, { username: 'u', password: 'p' }, { port: PORT.dup });
  const before = rowCount('SELECT COUNT(*) AS n FROM records WHERE site_id=?', [site.id]);
  expect(before >= 1, `收网前本站没有证据记录（${before}）`);

  const removed = await api(`/web-sites/${site.id}`, { method: 'DELETE' });
  expect(removed.status === 200, `删除站点失败：${removed.status} ${message(removed)}`);
  const dead = await cap('/', { port: PORT.dup });
  expect(dead.status === 0 || dead.status >= 400, `站点删除后端口仍在服务（${dead.status}）：${dead.body.slice(0, 80)}`);

  const kept = await api(`/records?kind=web&site_id=${site.id}`);
  expect(data(kept)?.total === before, `删站点后证据条数 ${before}→${data(kept)?.total}，收网不该清掉已采记录`);
  const groups = await api('/records/groups');
  const group = (data(groups)?.web ?? []).find((g) => g.id === site.id);
  expect(group?.exists === false && /已删除/.test(group?.label ?? ''), `已删站点在看板里没有人话标注：${JSON.stringify(group)?.slice(0, 120)}`);
  expect(group.terminals === before, `已删站点的终端数统计丢失：${group?.terminals} vs ${before}`);
  const audit = count("SELECT * FROM audit_logs WHERE action='site.delete' AND target_id=?", [site.id]);
  expect(audit.length === 1, `删除站点未留审计（${audit.length} 条）`);
  expect(String(audit[0].detail).includes('evidence_kept'), '审计里没记"保留了多少证据"：' + String(audit[0].detail).slice(0, 120));
  return '端口下线、证据与看板口径保留、审计记明留证数量';
});

tc('TC-P-10', '高危动作全覆盖审计：谁在什么时候投放、发信、删证、导出', async () => {
  const probes = [];
  const auth = await freshAuthorization({ scope: 'QA 审计覆盖' });
  probes.push(['authorization.create', auth.id]);
  const revoked = await api(`/authorizations/${auth.id}/revoke`, { method: 'POST' });
  expect(revoked.status === 200, `吊销授权失败：${revoked.status} ${message(revoked)}`);
  probes.push(['authorization.revoke', auth.id]);

  await activeAuth();
  const template = await ensureTemplate('QA 审计模板');
  const site = await recreateSite(PORT.gate, { template });
  probes.push(['site.create', site.id]);
  const stopped = await api(`/web-sites/${site.id}/stop`, { method: 'POST' });
  expect(stopped.status === 200, `停站失败：${stopped.status} ${message(stopped)}`);
  probes.push(['site.stop', site.id]);
  const started = await api(`/web-sites/${site.id}/start`, { method: 'POST' });
  expect(started.status === 200, `开站失败：${started.status} ${message(started)}`);
  probes.push(['site.start', site.id]);

  const task = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: 'QA 审计发信', subject: 's', body_html: '<p>b</p>' }) });
  await api(`/mail-tasks/${data(task).id}/recipients`, { method: 'POST', body: JSON.stringify({ text: 'audit@qa.test,审计' }) });
  const flipped = await api(`/mail-tasks/${data(task).id}`, { method: 'PUT', body: JSON.stringify({ dry_run: false, smtp_profile_id: null }) });
  expect(flipped.status === 400 || flipped.status === 200, `沙箱开关返回 ${flipped.status}`);
  probes.push(['mail_task.sandbox_toggle', data(task).id]);
  await api(`/mail-tasks/${data(task).id}`, { method: 'DELETE' });
  probes.push(['mail_task.delete', data(task).id]);

  const export1 = await api('/reports/export?kind=web');
  expect(export1.status === 200, `导出失败：${export1.status}`);
  probes.push(['evidence.export', 'web']);

  const missing = [];
  for (const [action, targetId] of probes) {
    const hit = count('SELECT * FROM audit_logs WHERE action=? AND target_id=?', [action, targetId]);
    if (!hit.length) missing.push(action);
    else {
      const row = hit[0];
      expect(row.actor === cfg.panel.username, `${action} 的审计没记操作人：actor=${row.actor}`);
      expect(String(row.ip).length > 3, `${action} 的审计没记来源地址：ip=${row.ip}`);
      expect(String(row.detail).startsWith('{'), `${action} 的审计详情不是结构化数据：${String(row.detail).slice(0, 60)}`);
    }
  }
  expect(!missing.length, `以下高危动作未留审计：${missing.join('、')}`);
  return `${probes.length} 类高危动作全部留痕，含操作人、来源 IP 与结构化详情`;
});

tc('TC-P-11', '真发信闸门：SMTP 不可达时逐人失败、原因留库、任务不谎报已发送', async () => {
  const profile = await api('/smtp-profiles', {
    method: 'POST',
    body: JSON.stringify({ host: '127.0.0.1', port: 1, user: 'svc@awarelab.test', pass: 'x', from_addr: 'svc@awarelab.test', secure: false }),
  });
  expect(profile.status === 200, `建 SMTP 配置失败：${profile.status} ${message(profile)}`);
  await activeAuth();
  const task = await api('/mail-tasks', {
    method: 'POST',
    body: JSON.stringify({ title: 'QA 真发失败', subject: 's', body_html: '<p>b</p>', dry_run: false, smtp_profile_id: data(profile).id }),
  });
  expect(task.status === 200, `建真发任务失败：${task.status} ${message(task)}`);
  const id = data(task).id;
  await api(`/mail-tasks/${id}/recipients`, { method: 'POST', body: JSON.stringify({ text: 'r1@qa.test,甲\nr2@qa.test,乙' }) });
  const sent = await api(`/mail-tasks/${id}/send`, { method: 'POST' });
  expect(sent.status === 200, `发送接口返回 ${sent.status} ${message(sent)}`);
  const result = data(sent);
  expect(result.dry_run === false && result.sent === 0 && result.failed === 2, `失败计数不对：${JSON.stringify(result)}`);
  const rows = count('SELECT status,error FROM mail_recipients WHERE task_id=?', [id]);
  expect(rows.every((r) => r.status === 'failed' && String(r.error).length > 3), `收件人状态或失败原因没落库：${JSON.stringify(rows)}`);
  expect(!outboxEml().some((f) => f.startsWith(id.slice(0, 8))), '真发失败却往沙箱 outbox 写了件');
  const listed = await api('/mail-tasks');
  const mine = (data(listed)?.rows ?? []).find((r) => r.id === id);
  expect(mine?.status !== 'sent', `一封都没送出，任务状态却显示 sent：${mine?.status}`);
  const audit = count("SELECT * FROM audit_logs WHERE action='mail_task.real_send' AND target_id=?", [id]);
  expect(audit.length === 1 && /"failed":2/.test(String(audit[0].detail)), `真发信审计未记失败数：${String(audit[0]?.detail).slice(0, 120)}`);
  await api(`/mail-tasks/${id}`, { method: 'DELETE' });
  await api(`/smtp-profiles/${data(profile).id}`, { method: 'DELETE' });
  return '逐人失败 + 原因留库 + 不写沙箱 + 审计计数 + 状态不谎报';
});

tc('TC-P-12', '单收件人重发只推进这一条；名册投完再点发送不改判失败', async () => {
  await activeAuth();
  const task = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: 'QA 重发', subject: 's', body_html: '<p>b</p>' }) });
  const id = data(task).id;
  await api(`/mail-tasks/${id}/recipients`, { method: 'POST', body: JSON.stringify({ text: 'a1@qa.test,甲\na2@qa.test,乙' }) });
  await api(`/mail-tasks/${id}/send`, { method: 'POST' });
  const rows = count('SELECT * FROM mail_recipients WHERE task_id=? ORDER BY created_at', [id]);
  expect(rows.length === 2, `前置收件人 ${rows.length} 条`);

  // 整队列只捞 pending/failed，投完后再点一次发送本轮没人可投；这趟空转不能按「0 封成功」把任务改判成失败
  const again = await api(`/mail-tasks/${id}/send`, { method: 'POST' });
  expect(again.status === 200, `投完的名册再点发送被拒（${again.status} ${message(again)}）`);
  expect(data(again)?.total === 0 && data(again)?.failed === 0, `空转跑出了新动作：${JSON.stringify(data(again))}`);
  expect(data(again)?.skipped === rows.length, `空转没报出「都已投过」的人数：${data(again)?.skipped}`);
  expect(data(again)?.status === 'sent', `再点一次发送把任务判成 ${data(again)?.status}，台账与交付报告里会出现假的「全部失败」`);
  expect(count('SELECT status FROM mail_tasks WHERE id=?', [id])[0].status === 'sent', '任务终态没落到库，刷新页面又是另一幅样子');

  const before = fs.readFileSync(path.join(DATA_DIR, 'outbox', outboxEml().find((f) => f.startsWith(id.slice(0, 8)))), 'utf8');
  expect(before, '前置沙箱件未落盘');

  const one = await api(`/mail-tasks/${id}/recipients/${rows[0].id}/resend`, { method: 'POST' });
  expect(one.status === 200 && data(one)?.total === 1 && data(one)?.sent === 1, `单人重发把整队列又跑了一遍或没跑：${JSON.stringify(data(one))}`);
  expect(count('SELECT sent_at FROM mail_recipients WHERE id=?', [rows[1].id])[0].sent_at === rows[1].sent_at, '重发单人时动了另一个人的投递记录');

  const ghost = await api(`/mail-tasks/${id}/recipients/ghost-rid/resend`, { method: 'POST' });
  expect(ghost.status === 404, `重发不存在的收件人返回 ${ghost.status} ${message(ghost)}（应为 404，与 /send 的 404 口径一致）`);
  const ghostTask = await api('/mail-tasks/ghost-task/recipients/ghost-rid/resend', { method: 'POST' });
  expect(ghostTask.status === 404, `在不存在的任务下重发返回 ${ghostTask.status}`);
  await api(`/mail-tasks/${id}`, { method: 'DELETE' });
  return '重发只推进 1 条、他人记录不动、投完再点空转不改判失败';
});

tc('TC-P-13', '处置闭环：标记→筛选→批量→看板未处置数→教育覆盖率，四档状态一个口径', async () => {
  const { site, link } = await world();
  await visitAsTarget(link.token, { username: 'edu@corp.test', password: 'Edu-2026' });
  const todoLink = await issueLink(site.id, `todo-${Date.now()}@qa.test`, '待处置访客');
  await visitAsTarget(todoLink.token, { username: 'todo', password: 'Todo-2026' });
  await sleep(30);
  const rows = data(await api(`/records?site_id=${site.id}&submitted=1`))?.rows ?? [];
  const row = rows.find((r) => r.token === link.token);
  const todo = rows.find((r) => r.token === todoLink.token);
  expect(row && todo, '前置夹具没备齐：两条上钩记录读不全');
  expect(row.disposition === 'new' && row.disposition_label === '未处置', `新记录默认档位不对：${row.disposition}/${row.disposition_label}`);

  for (const [value, label] of [['contacted', '已联系'], ['educated', '已教育'], ['closed', '已关闭'], ['new', '未处置']]) {
    const patched = await api(`/records/${row.id}`, { method: 'PATCH', body: JSON.stringify({ disposition: value, note: `qa 标记为 ${label}` }) });
    expect(patched.status === 200 && data(patched)?.disposition === value && data(patched)?.disposition_label === label, `${value} 档写不进或标签不对：${JSON.stringify(data(patched))?.slice(0, 120)}`);
    const only = data(await api(`/records?disposition=${value}&site_id=${site.id}`));
    expect((only?.rows ?? []).every((r) => r.disposition === value) && only.total >= 1, `按 ${value} 筛选命中不对：total=${only?.total}`);
  }
  const keepNote = data(await api(`/records/${row.id}`, { method: 'PATCH', body: JSON.stringify({ disposition: 'educated' }) }));
  expect(String(keepNote?.note).includes('qa 标记为'), '不带 note 的标记把已有备注清空了，处置过程断片');
  // NULL 与 'new' 同义：筛未处置要能捞出 v6 之前入库的老记录
  const news = data(await api(`/records?disposition=new&site_id=${site.id}`));
  expect((news?.rows ?? []).some((r) => r.token === todoLink.token), '库里 disposition 为 NULL 的记录没被「未处置」筛出来');
  expect((news?.rows ?? []).every((r) => r.disposition === 'new'), '「未处置」这一档里混进了别的状态');

  const batch = await api('/records/disposition', { method: 'POST', body: JSON.stringify({ ids: [todo.id, todo.id, 'qa-ghost', row.id], disposition: 'educated' }) });
  expect(batch.status === 200 && data(batch)?.requested === 3 && data(batch)?.updated === 2, `批量结果没如实回报（去重与幽灵 ID）：${JSON.stringify(data(batch))}`);
  expect((await api('/records/disposition', { method: 'POST', body: JSON.stringify({ ids: ['qa-ghost'], disposition: 'closed' }) })).status === 404, '批量标记全是幽灵 ID 时没给 404');

  const groups = data(await api('/records/groups'));
  const group = (groups?.web ?? []).find((g) => g.id === site.id);
  const dbUnhandled = rowCount("SELECT COUNT(*) AS n FROM records WHERE site_id=? AND (IFNULL(disposition,'')='' OR disposition='new')", [site.id]);
  expect(group && group.unhandled === dbUnhandled, `看板未处置数与库不符（看板 ${group?.unhandled} / 库 ${dbUnhandled}），点进去对不上账`);
  expect(groups?.education?.total === rowCount('SELECT COUNT(*) AS n FROM records'), `教育覆盖率的分母不是全部记录：${groups?.education?.total}`);
  expect(groups.education.educated + groups.education.closed === rowCount("SELECT COUNT(*) AS n FROM records WHERE disposition IN ('educated','closed')"), '看板的已教育档与库不符');
  expect(groups.education.coverage_rate >= 0 && groups.education.coverage_rate <= 100, `覆盖率越界：${groups.education.coverage_rate}`);
  const home = data(await api('/stats/home'));
  expect(home?.education?.coverage_rate === groups.education.coverage_rate, `首页 ${home?.education?.coverage_rate}% 与看板 ${groups.education.coverage_rate}% 不是同一个数`);

  const auditRow = count("SELECT * FROM audit_logs WHERE action='record.disposition' ORDER BY created_at DESC LIMIT 1")[0];
  expect(auditRow && auditRow.actor === cfg.panel.username, `处置变更没记下是谁做的：${JSON.stringify(auditRow)?.slice(0, 140)}`);
  const detail = JSON.parse(auditRow.detail);
  expect(detail.from && detail.to, '审计没记迁移前后，事后讲不清这条记录怎么变成已教育的');
  const batchAudit = count("SELECT detail FROM audit_logs WHERE action='record.disposition_batch' ORDER BY created_at DESC LIMIT 1")[0];
  expect(batchAudit && JSON.parse(batchAudit.detail).to === 'educated', '批量处置没单独留痕，看不出这是一次批量操作而不是一条条点的');
  return `四档状态可写可筛、NULL 归一为未处置、批量 3 请求 2 生效、看板未处置 ${group.unhandled} 条与库一致`;
});

tc('TC-P-14', '演练交付：按授权汇总一次读齐，甲方报告与交付 CSV 全程脱敏', async () => {
  const { auth, site } = await world();
  const link = await issueLink(site.id, 'victim-report@corp.test', '报告样本');
  // 刻意把邮箱填进 username：交付件脱敏不能只看字段名
  await visitAsTarget(link.token, { username: 'victim-report@corp.test', password: 'Report-2026' });
  await sleep(30);

  const summary = await api(`/insight/authorizations/${auth.id}/summary`);
  expect(summary.status === 200, `按授权汇总读不到（${summary.status} ${message(summary)}）`);
  const body = data(summary);
  for (const key of ['authorization', 'window', 'web', 'mail', 'overall', 'education', 'devices', 'sites', 'tasks']) {
    expect(body && key in body, `汇总缺 ${key} 这一节，前端还得再打一个接口拼`);
  }
  expect(body.authorization.scope === auth.scope && Array.isArray(body.authorization.allowed_hosts), `授权依据没带全，报告无法自证合法：${JSON.stringify(body.authorization)?.slice(0, 120)}`);
  expect(String(body.authorization.pledge ?? '').length >= 8, '授权承诺原文没进汇总，交付时缺最关键的一页');
  // 中招率按终端去重，不可能超 100%（邮件链+网页链相加的旧口径算出过 233%）
  expect(body.overall.hooked <= body.overall.targets, `命中数超过投放目标（${body.overall.hooked}/${body.overall.targets}），这种数字印在甲方报告上没法解释`);
  expect(body.overall.hook_rate >= 0 && body.overall.hook_rate <= 100, `整体中招率越界：${body.overall.hook_rate}`);
  expect(body.web.submitted >= 1 && body.web.conversion >= 0, '网页漏斗没统计到刚提交的这条');
  expect(body.window.days >= 1, `演练跨度算成 ${body.window.days} 天：同一天开始结束也该显示 1 天，显示 0 天读起来像没跑`);
  expect(typeof body.education.coverage_rate === 'number' && body.education.total >= 1, `教育闭环没进汇总：${JSON.stringify(body.education)}`);
  expect((body.sites ?? []).some((s) => s.id === site.id && s.submitted >= 1), '逐站点明细里没有这张网的命中数');
  expect((await api('/insight/authorizations/qa-ghost/summary')).status === 404, '汇总不存在的授权没给 404，前端会拿到一份全 0 的假报告');

  const reportRes = await fetch(`${API}/insight/authorizations/${auth.id}/report`, { headers: { 'x-alab-token': TOKEN } });
  const html = await reportRes.text();
  expect(reportRes.status === 200 && /text\/html/.test(reportRes.headers.get('content-type') ?? '') && html.includes('</html>'), `报告不是完整 HTML 文档（${reportRes.status}）`);
  expect(!html.includes('Report-2026'), '报告里印着口令明文，而这份是要交出去的');
  expect(html.includes(MASK), '报告里看不到掩码串，凭据列等于没脱敏');
  expect(!html.includes('victim-report@corp.test'), '报告里印着员工邮箱原文（含被填进 username 的那一份）');
  expect(html.includes('v***@corp.test'), '邮箱没按「首字母***@域名」的部分掩码口径出现');
  expect(!html.includes(cfg.panel.path) && !html.includes(`:${cfg.panel.port}`), '报告泄露了后台入口，交付件不该带运维信息');
  expect(html.includes(body.authorization.pledge), '报告没把授权承诺原文印进去，甲方无法核对这次演练的合法性');
  // 报告是会被打印、会被转出去的交付件：原始 ISO 时间串和 active/open/sent 这类枚举原值甲方读不懂，也不该出现在纸面上
  expect(!/\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/.test(html), '报告里印着带时区的原始时间串，落到纸上读不出是本地几点');
  expect(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(html), '报告时间没按「年-月-日 时:分:秒」渲染');
  expect(html.includes('授权状态：生效中'), `授权状态没翻成中文：${(html.match(/授权状态：[^<。]*/) ?? ['无'])[0]}`);
  expect(!/<td>(active|open|closed|sent|draft|partial|sandboxed)<\/td>/.test(html), '站点与任务状态列还是枚举原值，交付件里混着内部字段名');
  const download = await fetch(`${API}/insight/authorizations/${auth.id}/report?download=1`, { headers: { 'x-alab-token': TOKEN } });
  expect(String(download.headers.get('content-disposition') ?? '').includes('attachment'), '报告不能另存为附件，只能截图交付');
  const ghostReport = await fetch(`${API}/insight/authorizations/qa-ghost/report`, { headers: { 'x-alab-token': TOKEN } });
  expect(ghostReport.status === 404, `不存在的授权也能生成报告（${ghostReport.status}）`);

  const csvRes = await fetch(`${API}/insight/authorizations/${auth.id}/export.csv`, { headers: { 'x-alab-token': TOKEN } });
  const bytes = new Uint8Array(await csvRes.arrayBuffer());
  const csv = Buffer.from(bytes).toString('utf8');
  expect(csvRes.status === 200 && bytes[0] === 0xef, '交付 CSV 缺 BOM，Excel 打开是乱码');
  const header = csv.split('\r\n')[0];
  expect(header.includes('采集内容(凭据已掩码)') && header.includes('处置状态'), `交付 CSV 表头没把口径说清：${header.slice(0, 140)}`);
  expect(!csv.includes('Report-2026') && !csv.includes('victim-report@corp.test'), '交付 CSV 里仍有明文凭据或员工邮箱');
  // 载体列给人读：甲方拿到一串 UUID 对不上是哪张网，记录 UUID 那列才是对照键
  expect(csv.includes('钓鱼网页 · 端口') && !csv.includes(site.id), `交付 CSV 的载体列还在用 UUID：${site.id}`);
  // 交付物离开本机是高危动作，报告和 CSV 都要留痕
  const audits = count("SELECT * FROM audit_logs WHERE action='report.export' ORDER BY created_at DESC");
  expect(audits.length >= 3, `报告与交付 CSV 的导出审计不全（${audits.length} 条，本例应至少 html×2 + csv×1）`);
  expect(audits.every((a) => a.actor === cfg.panel.username), '导出审计没记下是谁导走的');
  expect(!JSON.stringify(audits).includes('Report-2026'), '导出审计抄了报告内容，审计表成了第二份泄露源');
  return `汇总 9 节一次读齐、中招率 ${body.overall.hook_rate}%（${body.overall.hooked}/${body.overall.targets}）、报告与 CSV 全程脱敏并留痕 ${audits.length} 条`;
});

tc('TC-P-15', '邮件点进钓鱼页提交：收件人与任务分组两处都算上钩，事件不重复计数', async () => {
  const { auth, site } = await world();
  const task = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: 'QA 串链演练', subject: 's', body_html: '<p>b</p>' }) });
  const id = data(task).id;
  await api(`/mail-tasks/${id}/recipients`, { method: 'POST', body: JSON.stringify({ text: 'chain@qa.test,串链访客' }) });
  const recipient = count('SELECT * FROM mail_recipients WHERE task_id=?', [id])[0];
  if (!recipient) blocked('收件人导入后库里查不到这一行，前置没就绪');

  // 邮件正文里的跳转链接就是「收件人令牌 + 站点」拼出来的，这一段把这枚令牌在信标面和采集面各走一遍
  await beacon({ pathname: `/alab/v2/pixel?tk=${q(recipient.token)}&task=${q(id)}` });
  await beacon({ pathname: `/alab/v2/trace?tk=${q(recipient.token)}&url=${q(`http://${site.domain || 'qa.example.com'}:${PORT.main}/`)}&to=chain@qa.test` });
  await visitAsTarget(recipient.token, { username: 'chain@qa.test', password: 'Chain-2026' });
  await sleep(60);

  const row = count('SELECT submitted_at FROM mail_recipients WHERE id=?', [recipient.id])[0];
  expect(row.submitted_at, '从邮件点进页面交了凭据，收件人的提交时间却没回填：整体中招率算到人，邮件转化率显示 0%');

  const summary = data(await api(`/insight/authorizations/${auth.id}/summary`));
  expect(summary.mail.submitted >= 1 && summary.mail.conversion > 0, `邮件漏斗没吃到这次提交：${JSON.stringify(summary.mail)}`);
  expect(summary.overall.hooked <= summary.overall.targets, `串链后来整体中招率越界：${summary.overall.hooked}/${summary.overall.targets}`);

  const group = (data(await api('/records/groups')).mail ?? []).find((g) => g.id === id);
  expect(group?.submitted >= 1, `任务分组没记上这条提交（submitted=${group?.submitted}）`);
  // 同令牌此刻有「邮件记录 + 网页记录」两条，事件按令牌统计；累加侧不锁一次就会把同一次打开数两遍
  const mailOpens = rowCount("SELECT COUNT(*) AS n FROM events WHERE token=? AND kind='mail_open'", [recipient.token]);
  const pageOpens = rowCount("SELECT COUNT(*) AS n FROM events WHERE token=? AND kind='page_open'", [recipient.token]);
  expect(group.mail_opens === mailOpens, `分组邮件打开数 ${group.mail_opens} 与事件表 ${mailOpens} 不符（同令牌两条记录被重复累加）`);
  expect(group.page_opens === pageOpens, `分组网页打开数 ${group.page_opens} 与事件表 ${pageOpens} 不符`);
  expect(group.terminals === 2, `同一个人的邮件记录与网页记录应算两个终端，实际 ${group.terminals}`);

  await api(`/mail-tasks/${id}`, { method: 'DELETE' });
  return `收件人回填 + 邮件转化率 ${summary.mail.conversion}% + 分组事件计数与事件表一致（打开 ${mailOpens}/${pageOpens}）`;
});

const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,3}Z$/;
const hasChinese = (text) => /[\u4e00-\u9fa5]/.test(text);

tc('TC-U-01', '失败响应形状统一：code+中文 message，不裸抛状态码也不漏堆栈', async () => {
  await activeAuth();
  const probes = [
    ['缺承诺文本登记授权', '/authorizations', 'POST', { scope: 'QA', start_at: '2026-01-01T00:00:00.000Z', end_at: '2027-01-01T00:00:00.000Z', allowed_hosts: ['qa.example.com'] }],
    ['有效期倒挂', '/authorizations', 'POST', { scope: 'QA', start_at: '2027-01-01T00:00:00.000Z', end_at: '2026-01-01T00:00:00.000Z', allowed_hosts: ['qa.example.com'], pledge: PLEDGE }],
    ['模板缺类型', '/web-templates', 'POST', { name: 'QA', html: '<p>x</p>' }],
    ['学习页缺内容', '/learn-pages', 'POST', { name: 'QA' }],
    ['端口越界', '/web-sites', 'POST', { template_id: (await ensureTemplate()).id, listen_port: 70000 }],
    ['端口重复', '/web-sites', 'POST', { template_id: (await ensureTemplate()).id, listen_port: (await ensureSite(PORT.main)).listen_port }],
    ['任务缺正文', '/mail-tasks', 'POST', { title: 'QA', subject: 's' }],
    ['读不存在站点', '/web-sites/ghost-id/links', 'GET', null],
    ['读不存在任务', '/mail-tasks/ghost-id', 'GET', null],
    ['读不存在记录', '/records/ghost-id', 'GET', null],
    ['读不存在截图', '/records/ghost-id/screenshot', 'GET', null],
    ['读不存在授权', '/authorizations/ghost-id', 'GET', null],
  ];
  const bad = [];
  for (const [label, path, method, body] of probes) {
    const res = await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (res.status < 400) {
      bad.push(`${label} 返回 ${res.status}`);
      continue;
    }
    const text = message(res);
    if (!text) bad.push(`${label} 只有状态码没有说明`);
    else if (!hasChinese(text)) bad.push(`${label} 的说明不是中文：${text.slice(0, 40)}`);
    else if (/at\s+\w|Error:|undefined|Traceback|expected/i.test(text)) bad.push(`${label} 的说明带出实现细节：${text.slice(0, 60)}`);
    if (res.json?.code === 0) bad.push(`${label} 失败了却回 code:0，前端会当成功处理`);
    if (res.json?.raw) bad.push(`${label} 返回的不是 JSON 信封`);
  }
  expect(!bad.length, bad.join('；'));
  return `${probes.length} 类失败全部给出中文可读原因`;
});

tc('TC-U-02', '空结果与读不到的资源：列表给空数组，详情不许用 data:null 冒充成功', async () => {
  const ghostSite = crypto.randomUUID();
  const emptyList = await api(`/records?site_id=${ghostSite}`);
  expect(Array.isArray(data(emptyList)?.rows) && data(emptyList).total === 0, `空列表形状不是 rows:[]：${emptyList.text.slice(0, 120)}`);
  const emptyAudit = await api('/audit-logs?action=不存在的动作');
  expect(Array.isArray(data(emptyAudit)?.rows), `审计空结果形状不对：${emptyAudit.text.slice(0, 120)}`);
  const emptyTpl = await api('/web-templates?keyword=' + q('绝不可能命中的关键字'));
  expect(Array.isArray(data(emptyTpl)?.rows) && data(emptyTpl).total === 0, '模板搜索空结果形状不对');

  for (const [label, p] of [['模板详情', `/web-templates/${ghostSite}`], ['邮件模板', `/mail-templates/${ghostSite}`], ['学习页删除', `/learn-pages/${ghostSite}`]]) {
    const res = await api(p, label.startsWith('学习页') ? { method: 'DELETE' } : {});
    expect(res.status === 200 ? data(res) !== null : true, `${label} 读一个不存在的 id 回了 code:0 + data:null，界面会显示成空白成功页（应 404）`);
  }
  const groups = await api('/records/groups');
  expect(Array.isArray(data(groups)?.web) && Array.isArray(data(groups)?.mail) && data(groups)?.unassigned, `分组看板缺兜底格：${Object.keys(data(groups) ?? {}).join(',')}`);
  expect(data(groups)?.unassigned?.label, '未归属记录格没有标题');
  return '空列表一律 rows:[] / total:0，看板三段齐全';
});

tc('TC-U-03', '门禁拒绝要说清去哪办：403 文案指向「演练授权」界面入口', async () => {
  const before = (await listSites()).find((row) => row.listen_port === PORT.shape);
  if (before) await api(`/web-sites/${before.id}`, { method: 'DELETE' });
  await clearAuthorizations();
  const tpl = await ensureTemplate();
  const blockedSite = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: tpl.id, listen_port: PORT.shape, status: 'closed' }) });
  expect(blockedSite.status === 403, `无授权建站返回 ${blockedSite.status}，应为 403`);
  const text = message(blockedSite);
  expect(text.includes('演练授权'), `拒绝原因没告诉操作员去哪个界面办事：${text}`);
  expect(text.length <= 160, `拒绝文案过长，前端提示条放不下（${text.length} 字）`);
  const blockedSend = await api('/mail-tasks/whatever/send', { method: 'POST' });
  expect(blockedSend.status === 403, `无授权发信返回 ${blockedSend.status}`);
  const leftover = (await listSites())[0];
  const blockedLink = await api(`/web-sites/${leftover?.id ?? 'ghost'}/links`, { method: 'POST', body: JSON.stringify({ email: 'gate@qa.test' }) });
  expect(blockedLink.status === 403 || blockedLink.status === 404, `无授权签链接返回 ${blockedLink.status}，应为 403`);
  const pledge = await api('/authorizations/pledge');
  expect(pledge.status === 200 && /承诺|授权/.test(JSON.stringify(data(pledge))), '登记授权前拿不到承诺文本，操作员只能照着报错猜要填什么');
  await createAuthorization({ scope: 'QA 人性化主线' });
  return '403 文案点名「演练授权」+ 承诺文本免登录可读';
});

tc('TC-U-04', '上钩详情读得懂：字段名、值、时间三件套，历史按发生顺序排', async () => {
  const link = await freshLink('read');
  await cap(ENGAGE, { method: 'POST', body: JSON.stringify({ ev: 'submit', tk: link.token, href: '/a', dwell: 5, fields: { username: 'first', password: 'p1' } }) });
  await sleep(20);
  await cap(ENGAGE, { method: 'POST', body: JSON.stringify({ ev: 'submit', tk: link.token, href: '/b', dwell: 9, fields: { username: 'second', password: 'p2' } }) });
  const rec = count('SELECT id FROM records WHERE kind=? AND token=?', ['web', link.token])[0];
  expect(rec, '两次提交后读不到记录');
  const detail = await api(`/records/${rec.id}`);
  const rows = data(detail)?.form ?? [];
  expect(rows.length === 4, `展平后应有 4 行（2 次×2 字段），实际 ${rows.length}`);
  for (const row of rows) {
    expect(row.name && row.value !== undefined && row.value !== null, `采集项缺字段名或值：${JSON.stringify(row)}`);
    expect(ISO_STAMP.test(String(row.at ?? '')), `采集项时间不是统一格式：${row.at}`);
    expect(!/undefined|\[object Object]/.test(String(row.value)), `采集值被序列化成占位文本：${JSON.stringify(row)}`);
  }
  const times = rows.map((r) => r.at);
  expect([...times].sort().join() === times.join(), '采集历史不是按发生顺序返回，运营要自己脑补时间线');
  expect(rows[0].value === 'first' && rows[2].value === 'second', `多次提交的内容混在一起分不清先后：${JSON.stringify(rows.map((r) => r.value))}`);
  expect(data(detail)?.screenshot_url === null, '没有截图的记录给了截图地址，前端会去请求一张不存在的图');
  expect(data(detail)?.context?.target_email === link.target_email, `详情里的归属邮箱不对：${data(detail)?.context?.target_email}`);
  return '4 行历史带时间戳、顺序正确、值可原样读给业务方听';
});

tc('TC-U-05', '被拒访客只看到中性说法：不暴露演练、授权、采集这些内部词', async () => {
  const auth = await freshAuthorization({ scope: 'QA 文案中性' });
  const site = await recreateSite(PORT.expire, { domain: 'qa.example.com' });
  // 未开启那一屏文案只有监听进程自己能给，真按 closed 建站的端口上没有监听；所以先正常开一张网再把库里状态改成 closed
  const closed = await recreateSite(PORT.closed, { domain: 'qa.example.com' });
  db.prepare("UPDATE web_sites SET status='closed' WHERE id=?").run(closed.id);

  db.prepare('UPDATE authorizations SET start_at=?, end_at=? WHERE id=?').run(
    new Date(Date.now() - 7_200_000).toISOString(),
    new Date(Date.now() - 60_000).toISOString(),
    auth.id
  );
  const expired = await cap('/', { port: PORT.expire });
  expect(expired.status === 403, `前置未生效（${expired.status}）`);
  const leaked = [];
  const seen = visibleText(expired.body);
  if (INSIDER_WORDS.test(seen)) leaked.push(`授权过期页：${seen.slice(0, 60)}`);
  if (/「|」/.test(seen)) leaked.push(`授权过期页里出现了内部界面名：${seen.slice(0, 60)}`);

  const notOpen = await cap('/', { port: PORT.closed });
  const seen2 = visibleText(notOpen.body);
  expect(notOpen.status === 404, `未开启站点返回 ${notOpen.status}`);
  if (INSIDER_WORDS.test(seen2)) leaked.push(`站点未开启页：${seen2.slice(0, 60)}`);

  await api(`/web-sites/${site.id}`, { method: 'DELETE' });
  await api(`/web-sites/${closed.id}`, { method: 'DELETE' });
  await freshAuthorization({ scope: 'QA 主线恢复' });
  expect(!leaked.length, leaked.join('；'));
  return '403 与 404 两屏访客文案中性';
});

tc('TC-U-06', '看板列出零命中载体：刚建的网与新建的任务不会因为 0 条记录消失', async () => {
  const site = await ensureSite(PORT.bind, { status: 'closed' });
  await activeAuth();
  const task = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: 'QA 零命中任务', subject: 's', body_html: '<p>b</p>' }) });
  const groups = await api('/records/groups');
  const webGroup = (data(groups)?.web ?? []).find((g) => g.id === site.id);
  const mailGroup = (data(groups)?.mail ?? []).find((g) => g.id === data(task)?.id);
  expect(webGroup, '还没人上钩的站点在分组看板里不存在，运营会以为建站没成功');
  expect(mailGroup, '还没有收件人的任务在分组看板里不存在');
  expect(webGroup.terminals === 0 && webGroup.conversion === 0, `零命中站点的计数不是 0：${JSON.stringify(webGroup)}`);
  expect(webGroup.label && webGroup.label !== site.id, `看板用 UUID 当标题，运营读不懂：${webGroup.label}`);
  expect(mailGroup.recipients === 0, `零命中任务的收件人数不对：${mailGroup.recipients}`);
  expect(data(groups)?.totals?.web_groups === data(groups).web.length, 'totals.web_groups 与实际组数不符');
  expect(webGroup.address && webGroup.listen_port === PORT.bind, `看板没带监听地址与端口，无法核对投放目标：${JSON.stringify(webGroup)}`);
  await api(`/web-sites/${site.id}`, { method: 'DELETE' });
  await api(`/mail-tasks/${data(task).id}`, { method: 'DELETE' });
  return '0 上钩的站点与任务照样列出，带地址、端口与 0 值';
});

tc('TC-U-07', '首页指标自洽：风险分、漏斗、趋势、站点概览互相能对上', async () => {
  const { site, link } = await world();
  await visitAsTarget(link.token, { username: 'u', password: 'p' });
  const stats = data(await api('/stats/home'));
  expect(stats, '首页统计读不到');
  const expectConversion = Math.round((stats.web_stats.submitted / Math.max(1, stats.web_stats.opened)) * 1000) / 10;
  expect(Math.abs(stats.web_stats.conversion - expectConversion) < 0.11, `中招率与打开/提交数不符：${stats.web_stats.conversion} vs ${expectConversion}`);
  expect(stats.basic.risk_score === Math.round(Math.max(0, Math.min(100, 100 - stats.web_stats.conversion)) * 10) / 10, `风险分不是 100-中招率：${stats.basic.risk_score} vs ${stats.web_stats.conversion}`);
  // 100 - 92.9 的浮点尾巴会显示成 7.099999999999994，看着像算错了
  expect(String(stats.basic.risk_score).split('.')[1]?.length <= 1, `风险分小数位失控：${stats.basic.risk_score}`);
  expect(['安全', '需关注', '高风险'].includes(stats.basic.risk_level), `风险档位取值异常：${stats.basic.risk_level}`);
  expect(stats.funnel.not_submitted === stats.funnel.opened - stats.funnel.submitted, `漏斗三项不自洽：${JSON.stringify(stats.funnel)}`);
  expect(stats.funnel.not_submitted >= 0, `漏斗出现负数：${JSON.stringify(stats.funnel)}`);
  expect(stats.trend.length === 7 && new Set(stats.trend.map((d) => d.date)).size === 7, `趋势不是连续 7 天：${stats.trend.length}`);
  expect(stats.trend.every((d) => d.opened >= d.submitted), `趋势里提交数大于打开数：${JSON.stringify(stats.trend)}`);
  expect(stats.basic.listen_ports.every((p) => Number.isInteger(p) && p > 0), `在听端口列表含非法值：${JSON.stringify(stats.basic.listen_ports)}`);
  expect(stats.basic.running_sites >= 1 && stats.basic.authorization, `首页没显示当前在听数与授权主体：${JSON.stringify(stats.basic)}`);
  const overview = stats.site_overview.find((s) => s.id === site.id);
  expect(overview && overview.opened >= 1, `站点概览里找不到刚建的网：${JSON.stringify(overview)}`);
  expect(stats.mail_stats.conversion <= 100 && stats.mail_stats.recipients >= 0, `邮件漏斗取值越界：${JSON.stringify(stats.mail_stats)}`);
  expect(Object.keys(stats.os_buckets).length > 0, '设备分布为空，访客系统/浏览器没解析出来');
  const screen = data(await api('/stats/bigscreen'));
  expect(screen.events.length > 0 && screen.records.length > 0, '大屏读不到事件与记录');
  expect(screen.events.every((e) => ISO_STAMP.test(String(e.created_at))), '大屏事件时间格式不统一');
  return `中招率 ${stats.web_stats.conversion}% / 风险分 ${stats.basic.risk_score}（${stats.basic.risk_level}）三处口径一致`;
});

tc('TC-U-08', '错误响应不回显入参原文，避免把敏感载荷写进日志与页面', async () => {
  const sentinel = `SENTINEL${randomString(10)}`;
  const site = await ensureSite(PORT.main);
  const probes = [
    ['/web-templates', 'POST', { name: sentinel, html: `<p>${sentinel}-html</p>` }],
    ['/mail-tasks', 'POST', { title: sentinel, subject: sentinel }],
    ['/authorizations', 'POST', { scope: sentinel, start_at: 'x', end_at: 'y', pledge: `${sentinel}-pledge`, allowed_hosts: [sentinel] }],
    [`/web-sites/${site.id}/links`, 'POST', { email: `${sentinel}@bad` }],
    ['/learn-pages', 'POST', { name: sentinel }],
  ];
  for (const [p, method, body] of probes) {
    const res = await api(p, { method, body: JSON.stringify(body) });
    expect(res.status >= 400, `${p} 的非法入参返回了 ${res.status}`);
    expect(!res.text.includes(sentinel), `${p} 的失败响应回显了提交内容原文（可被拿去做 XSS 或日志洪水）`);
  }
  const longPath = await api(`/records/${'x'.repeat(300)}`);
  expect(longPath.status < 500, `超长路径触发 5xx（${longPath.status}）`);
  expect(!longPath.text.includes('x'.repeat(60)), '超长路径被原样回显');
  const echo = await api('/web-templates', { method: 'POST', body: JSON.stringify({ name: `QA 回显检查`, type: '表单', html: `<p>${sentinel}</p>` }) });
  expect(echo.status === 200, `建模板失败：${echo.status} ${message(echo)}`);
  await api(`/web-templates/${data(echo).id}`, { method: 'DELETE' });
  return '5 类失败响应零回显、超长入参不放大、不触发 5xx';
});

tc('TC-U-09', '并发提交同一令牌：合并成一条终端记录，不报 500 也不丢数据', async () => {
  const link = await freshLink('race');
  const shots = await Promise.all(
    Array.from({ length: 5 }, (_unused, i) => cap(ENGAGE, { method: 'POST', body: JSON.stringify({ ev: 'submit', tk: link.token, href: '/', dwell: i, fields: { username: `c${i}`, password: 'p' } }) }))
  );
  expect(shots.every((s) => s.status === 200), `并发提交里出现非 200：${shots.map((s) => s.status).join(',')}`);
  const recs = count('SELECT * FROM records WHERE kind=? AND token=?', ['web', link.token]);
  expect(recs.length === 1, `并发写竞态把同一个终端拆成 ${recs.length} 条记录`);
  const history = JSON.parse(recs[0].form_json);
  expect(history.length === 5, `并发提交只落库 ${history.length}/5 条，其余被覆盖`);
  expect(new Set(history.map((h) => h.fields.username)).size === 5, '并发提交的用户名互相覆盖');
  expect(rowCount("SELECT COUNT(*) AS n FROM events WHERE token=? AND kind='form_fill'", [link.token]) === 5, '提交事件数与请求数不符');
  return '5 路并发 → 1 条终端记录 + 5 份完整历史';
});

tc('TC-U-10', '登录锁定：阈值内允许试错、锁上后给解锁时间、重启不清零', async () => {
  // 从干净计数起跳：本用例数第 8 次还能试、第 9 次才锁，前序用例留下的失败行会把刻度前移
  unlockLogins();
  await restart();
  const wrong = [];
  for (let i = 0; i < 7; i += 1) wrong.push((await loginAgain('wrong-by-design')).status);
  expect(wrong.every((s) => s === 401), `试错期间状态码不稳：${wrong.join(',')}`);
  const eighth = await loginAgain('wrong-by-design');
  expect(eighth.status === 401, `第 8 次失败应当还能继续试（${eighth.status}）`);
  const ninth = await loginAgain('wrong-by-design');
  expect(ninth.status === 429, `超过阈值未锁定（${ninth.status}）`);
  expect(/10\s*分钟/.test(message(ninth)), `锁定提示没给等待时间，操作员只能反复撞：${message(ninth)}`);
  const good = await loginAgain();
  expect(good.status === 429, '锁定期间正确口令也放行了');

  // 计数落 login_failures 表、重启不清零；429 发生在口令比对之前也不再累加，所以库里停在阈值 8
  // 只认 127.0.0.1 这一行：TC-S-07 在 trust_proxy 下还会给自报来源留一行，断言只有一条会把别人的产物算成缺陷
  const persisted = count('SELECT client_ip, fails FROM login_failures');
  const mine = persisted.filter((row) => row.client_ip === '127.0.0.1');
  expect(mine.length === 1, `本机失败计数没落库，重启一次就洗掉整轮爆破痕迹：${JSON.stringify(persisted)}`);
  expect(Number(mine[0].fails) === 8, `落库的失败次数与阈值不符：${JSON.stringify(mine[0])}`);
  await restart();
  const afterRestart = await loginAgain();
  expect(afterRestart.status === 429, `重启后锁定清零（${afterRestart.status}），把服务打崩一次就白拿一整轮尝试额度`);

  // 解锁只有等满 10 分钟窗口或手工清表两条路；这里清表，否则锁定窗口压住 127.0.0.1，后面每个用例都登不进去
  unlockLogins();
  await login();
  expect((await loginAgain()).status === 200, '清掉锁定行后仍登不进去，运维自救路径断了');
  return '7+1 次允许试错、第 9 次锁定并给出 10 分钟指引、重启后仍锁定（本机计数落库 8 次）';
});

tc('TC-U-11', '访客页面干净：看得见的文字里没有平台名、内部路径与协议字段', async () => {
  const { link } = await world();
  const page = await cap(`/?tk=${link.token}`);
  expect(page.status === 200, `前置页面未就绪（${page.status}）`);
  const seen = visibleText(page.body);
  expect(!/AwareLab|alab|Aware\s?Lab/i.test(seen), `访客可见文字里带出平台名：${seen.slice(0, 80)}`);
  expect(!/采集|上报|令牌|模板|授权/.test(seen), `访客可见文字里带出内部术语：${seen.slice(0, 80)}`);
  expect(!seen.includes(API), '访客页面里露出了管理面路径');
  expect(seen.includes('登 录'), `模板自带内容被吃掉：${seen.slice(0, 80)}`);
  const notFound = await cap('/some/deep/path', { host: 'qa.example.com' });
  expect(notFound.status === 200 || notFound.status === 404, `深路径访问返回 ${notFound.status}`);
  const headers = page.headers;
  expect(!/express|node/i.test(String(headers['x-powered-by'] ?? '')), '响应头暴露框架指纹');
  return `访客看到 ${seen.length} 个字符，全部来自模板本身`;
});

tc('TC-U-12', '兜底学习页要能落地：说清是演练，并给出可执行的识别要点', async () => {
  const template = await createTemplate(`QA 教育模板 ${randomString(6)}`, TEMPLATE_HTML, { response_type: 'learn' });
  const site = await recreateSite(PORT.race, { template });
  const lesson = await cap(`${LESSON}?tk=x`, { port: PORT.race });
  expect(lesson.status === 200, `学习页返回 ${lesson.status}`);
  const seen = visibleText(lesson.body);
  expect(seen.length > 30, `学习页几乎是空白页：${seen}`);
  expect(/演练|模拟/.test(seen), '学习页没有明说这是一次演练，访客会以为自己账号真的被盗');
  const tips = ['域名', '链接', '核实', '官方', '转发', '验证码'];
  expect(tips.filter((t) => seen.includes(t)).length >= 2, `学习页只有一句"请学习防钓鱼要点"，没有可执行要点：${seen.slice(0, 100)}`);
  await api(`/web-sites/${site.id}`, { method: 'DELETE' });
  await api('/web-templates/' + template.id, { method: 'DELETE' });
  return `访客拿到 ${seen.length} 字教育内容，含 ${tips.filter((t) => seen.includes(t)).join('、')}`;
});

tc('TC-U-13', '时间字段全平台一个格式：ISO8601 带毫秒带 Z，前端不会显示 Invalid Date', async () => {
  await world();
  const sites = await api('/web-sites');
  const links = await api(`/web-sites/${(await ensureSite(PORT.main)).id}/links`);
  const records = await api('/records?page=1&page_size=5');
  const audits = await api('/audit-logs?page=1&page_size=5');
  const tasks = await api('/mail-tasks?page=1&page_size=5');
  const samples = [
    ['站点', (data(sites)?.rows ?? []).flatMap((r) => [r.created_at, r.updated_at])],
    ['链接', (data(links)?.rows ?? []).flatMap((r) => [r.created_at, r.opened_at, r.last_seen_at, r.submitted_at])],
    ['记录', (data(records)?.rows ?? []).flatMap((r) => [r.created_at, r.first_seen_at, r.last_seen_at, r.submitted_at])],
    ['审计', (data(audits)?.rows ?? []).map((r) => r.created_at)],
    ['任务', (data(tasks)?.rows ?? []).flatMap((r) => [r.created_at, r.updated_at])],
  ];
  const bad = [];
  for (const [label, values] of samples) {
    for (const value of values) {
      if (value === null || value === undefined) continue;
      if (!ISO_STAMP.test(String(value))) bad.push(`${label}=${String(value).slice(0, 30)}`);
    }
  }
  expect(samples.every(([label, values]) => label === '审计' || values.length > 0), `有资源读不到时间字段，判定无意义：${samples.filter(([, v]) => !v.length).map(([l]) => l).join('、')}`);
  expect(!bad.length, `时间格式不统一：${bad.slice(0, 4).join(' / ')}`);
  const whoami = data(await api('/auth/me'));
  expect(Number.isInteger(whoami?.expires_at) && whoami.expires_at > Date.now(), `会话到期时间不是可用毫秒数：${whoami?.expires_at}`);
  return `${samples.length} 类资源的时间字段同一种格式`;
});

tc('TC-U-14', '载体删掉后证据仍讲得清：看板给人话、详情给上下文', async () => {
  await activeAuth();
  const template = await ensureTemplate('QA 遗留模板');
  const site = await recreateSite(PORT.dup, { template });
  const link = await issueLink(site.id, 'kept@qa.test', '遗留访客');
  await visitAsTarget(link.token, { username: 'u', password: 'p' }, { port: PORT.dup });
  const task = await api('/mail-tasks', { method: 'POST', body: JSON.stringify({ title: 'QA 遗留任务', subject: 's', body_html: '<p>b</p>' }) });
  await api(`/mail-tasks/${data(task).id}/recipients`, { method: 'POST', body: JSON.stringify({ text: 'kept@qa.test,遗留访客' }) });
  await api(`/mail-tasks/${data(task).id}/send`, { method: 'POST' });
  const recipient = count('SELECT token FROM mail_recipients WHERE task_id=?', [data(task).id])[0];
  await beacon({ pathname: `/alab/v2/pixel?tk=${q(recipient.token)}&task=${q(data(task).id)}` });

  await api(`/web-sites/${site.id}`, { method: 'DELETE' });
  await api(`/mail-tasks/${data(task).id}`, { method: 'DELETE' });

  const groups = await api('/records/groups');
  const webGroup = (data(groups)?.web ?? []).find((g) => g.id === site.id);
  const mailGroup = (data(groups)?.mail ?? []).find((g) => g.id === data(task).id);
  expect(webGroup && /已删除/.test(webGroup.label), `删掉的网站在看板里消失或只剩 UUID：${JSON.stringify(webGroup)?.slice(0, 120)}`);
  expect(mailGroup && /已删除/.test(mailGroup.label), `删掉的任务在看板里没有人话标注：${JSON.stringify(mailGroup)?.slice(0, 120)}`);
  expect(webGroup.terminals >= 1 && mailGroup.terminals >= 1, `删载体后证据计数丢失：${webGroup.terminals}/${mailGroup.terminals}`);

  const rec = count('SELECT id FROM records WHERE kind=? AND token=?', ['web', link.token])[0];
  const detail = await api(`/records/${rec.id}`);
  expect(detail.status === 200 && data(detail)?.context?.kind === 'web', '删掉站点后单条证据读不出来');
  expect(data(detail).context.template_name === null, `模板已删却仍回旧名：${data(detail).context.template_name}`);
  const list = await api(`/records?site_id=${site.id}`);
  expect(data(list)?.total >= 1, '按已删站点 ID 过滤证据反而一条都不剩');
  return '已删网站/任务在看板里标注为"已删除"，证据与计数照常可读';
});

tc('TC-U-15', '同一资源在列表与创建响应里字段名一致，前端不用两套读法', async () => {
  const site = await ensureSite(PORT.main);
  const email = `shape-${Date.now()}@qa.test`;
  const created = data(await api(`/web-sites/${site.id}/links`, { method: 'POST', body: JSON.stringify({ email, name: '形状访客' }) }));
  const listed = (data(await api(`/web-sites/${site.id}/links`))?.rows ?? []).find((r) => r.target_email === email);
  expect(listed, '刚签发的链接回看列表里没有');
  expect(created?.url && listed?.url, `两处都要能拿到可复制的链接：${JSON.stringify(created)?.slice(0, 80)}`);
  expect(created?.token === listed?.token, `签发响应的令牌字段名与列表不一致（tk vs token），前端要写两套取值：${Object.keys(created ?? {}).join(',')}`);
  expect(created?.target_email === listed?.target_email && created?.target_name === listed?.target_name, '两处归属信息不同名同值都对不上');

  const stale = (await listSites()).find((row) => row.listen_port === PORT.shape);
  if (stale) await api(`/web-sites/${stale.id}`, { method: 'DELETE' });
  const made = data(await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: (await ensureTemplate()).id, listen_port: PORT.shape, status: 'closed' }) }));
  const row = (data(await api('/web-sites'))?.rows ?? []).find((r) => r.id === made.id);
  expect(made?.url === row?.url && made?.running === row?.running, `建站响应与列表的 url/running 口径不一致：${JSON.stringify(made)?.slice(0, 80)}`);
  expect(row?.template_name && row?.auth_scope, `列表没带模板名与授权主体，运维要自己跨接口拼：${JSON.stringify(row)?.slice(0, 120)}`);
  if (made?.id) await api(`/web-sites/${made.id}`, { method: 'DELETE' });
  return '链接与站点的创建响应、列表响应字段同名同值';
});

tc('TC-U-16', '处置状态讲人话：非法值给出可选清单，批量与备注的上限说清楚', async () => {
  const { site, link } = await world();
  await visitAsTarget(link.token, { username: 'wording@corp.test', password: 'W-2026' });
  await sleep(20);
  const row = (data(await api(`/records?site_id=${site.id}&submitted=1`))?.rows ?? []).find((r) => r.token === link.token);
  expect(row, '前置夹具没备齐：读不到刚提交的记录');

  const badPatch = await api(`/records/${row.id}`, { method: 'PATCH', body: JSON.stringify({ disposition: 'done' }) });
  expect(badPatch.status === 400, `非法处置值返回 ${badPatch.status}，应当明确拒绝`);
  expect(/new.*contacted.*educated.*closed/.test(message(badPatch)), `失败文案没列出可选档位，运营只能猜：${message(badPatch)}`);
  const badFilter = await api('/records?disposition=done');
  expect(badFilter.status === 400 && /处置状态/.test(message(badFilter)), `筛选值非法时静默返回全量或空集，比报错更糟：${badFilter.status} ${message(badFilter)}`);
  const badNote = await api(`/records/${row.id}`, { method: 'PATCH', body: JSON.stringify({ disposition: 'closed', note: 'x'.repeat(501) }) });
  expect(badNote.status === 400 && /500/.test(message(badNote)), `超长备注没被拦或没说清上限：${badNote.status} ${message(badNote)}`);
  const ghost = await api('/records/qa-ghost', { method: 'PATCH', body: JSON.stringify({ disposition: 'closed' }) });
  expect(ghost.status === 404 && /不存在/.test(message(ghost)), `标记不存在的记录文案不清：${ghost.status} ${message(ghost)}`);
  const noIds = await api('/records/disposition', { method: 'POST', body: JSON.stringify({ ids: [], disposition: 'closed' }) });
  expect(noIds.status === 400 && /选/.test(message(noIds)), `空选批量标记没提示"先选记录"：${message(noIds)}`);
  const tooMany = await api('/records/disposition', { method: 'POST', body: JSON.stringify({ ids: Array.from({ length: 501 }, (_u, i) => `x${i}`), disposition: 'closed' }) });
  expect(tooMany.status === 400 && /分批/.test(message(tooMany)), `超量批量标记没给出可执行的下一步：${message(tooMany)}`);

  for (const [value, label] of [['new', '未处置'], ['contacted', '已联系'], ['educated', '已教育'], ['closed', '已关闭']]) {
    const patched = data(await api(`/records/${row.id}`, { method: 'PATCH', body: JSON.stringify({ disposition: value }) }));
    expect(patched?.disposition_label === label, `${value} 的中文标签不是「${label}」：${patched?.disposition_label}`);
  }
  return '非法档位列出四个可选值、备注点名 500 字上限、批量超量提示分批、四档标签全是中文';
});

// 尾部这几条要么重启换配置（出厂口令闸门、保留期、拒绝启动、来源白名单），要么作废当前令牌，所以排在最后
// 每条必须自己收尾（配置写回 + 重新登录），否则后续用例一律 401/404

tc('TC-F-21', '出厂口令未改就不许建站：409 说清去哪改，改完立刻放行', async () => {
  const template = await ensureTemplate();
  const auth = await activeAuth();
  const stale = (await listSites()).find((row) => row.listen_port === PORT.gate);
  if (stale) await api(`/web-sites/${stale.id}`, { method: 'DELETE' });
  await sleep(150);

  // 摘掉 password_updated_at 就是装完从没管过的部署：缺这一项即视为出厂随机口令仍在用
  const withoutStamp = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
  delete withoutStamp.panel.password_updated_at;
  fs.writeFileSync(CONFIG_FILE, yaml.dump(withoutStamp), 'utf8');
  cfg.panel = withoutStamp.panel;
  await restart();
  await login();

  const check = data(await api('/config-check'));
  expect(check?.factory_password === true, '出厂口令没被识别出来，体检等于没体检');
  expect(typeof check?.deployment_block === 'string' && /口令/.test(check.deployment_block), `体检没给出建站被拦的原因：${check?.deployment_block}`);

  const made = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: template.id, listen_port: PORT.gate, status: 'open', domain: 'qa.example.com' }) });
  expect(made.status === 409, `出厂口令下仍能建站（${made.status}），仿冒页会被直接挂上网络`);
  expect(/口令/.test(message(made)) && /系统设置/.test(message(made)), `409 文案没告诉操作员去哪改：${message(made)}`);
  // 闸门只拦往网络上挂新采集页：已建的网与既有证据还得能读，否则运维会被自己锁在门外
  expect((await api('/web-sites')).status === 200, '出厂口令下连站点列表都读不了，闸门管得太宽');
  expect((await api('/records')).status === 200, '出厂口令下证据也读不了，闸门管得太宽');

  const stamped = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
  stamped.panel.password_updated_at = new Date().toISOString();
  fs.writeFileSync(CONFIG_FILE, yaml.dump(stamped), 'utf8');
  cfg.panel = stamped.panel;
  await restart();
  await login();
  expect(data(await api('/config-check'))?.deployment_block === null, '写回 password_updated_at 后闸门仍拦着');
  const opened = await api('/web-sites', { method: 'POST', body: JSON.stringify({ template_id: template.id, listen_port: PORT.gate, status: 'open', domain: 'qa.example.com' }) });
  expect(opened.status === 200, `口令改完后建站仍被拒（${opened.status} ${message(opened)}）`);
  await api(`/web-sites/${data(opened).id}`, { method: 'DELETE' });
  expect(auth.id && template.id, '前置夹具形状不全');
  return '出厂口令下建站 409 并指明去「系统设置」改口令，读接口不受影响，改完立即放行';
});

tc('TC-F-22', '保留期清理：状态可读、试算一条不删、真删只删到期那部分', async () => {
  // 配置没写 exercise.retention_days 时走 settings.js 默认档（数据 180 天 / 审计 365 天），状态要把生效档位报出来
  const defaults = data(await api('/maintenance/status'));
  expect(defaults?.enabled === true && defaults.retention_days === 180, `默认保留期档位没生效或没报出来：${JSON.stringify(defaults)?.slice(0, 140)}`);
  expect(defaults.audit_retention_days === 365, `审计保留期默认档不对：${defaults.audit_retention_days}`);
  // 审计必须比它记录的证据活得久，否则清走证据这件事自己先被清掉
  expect(Date.parse(defaults.audit_cutoff_at) < Date.parse(defaults.cutoff_at), `审计截止点没早于数据截止点：${defaults.audit_cutoff_at} vs ${defaults.cutoff_at}`);
  expect(defaults.pending?.records === 0, `刚建的库就有待删数据，截止点算错了：${JSON.stringify(defaults.pending)}`);
  expect(defaults.files_pending && typeof defaults.files_pending === 'object', '状态没带落盘产物的待清理清单，运维看不到磁盘那一半');

  const { site } = await world();
  const agedLink = await issueLink(site.id, `aged-${Date.now()}@qa.test`, '过期访客');
  await visitAsTarget(agedLink.token, { username: 'aged', password: 'Aged-2026' });
  const freshLinkRow = await issueLink(site.id, `fresh-${Date.now()}@qa.test`, '新鲜访客');
  await visitAsTarget(freshLinkRow.token, { username: 'fresh', password: 'Fresh-2026' });
  await sleep(30);
  const aged = count('SELECT id FROM records WHERE token=?', [agedLink.token])[0];
  const fresh = count('SELECT id FROM records WHERE token=?', [freshLinkRow.token])[0];
  expect(aged && fresh, '前置夹具没备齐：两条上钩记录没落库');

  await restartWithConfig({ exercise: { require_authorization: true, retention_days: 30 } });
  await login();
  // 把一条的 created_at 拨到 40 天前造过期数据；刻意放在重启之后：清理定时器启动 30 秒就首跑，会先把这条删掉
  db.prepare('UPDATE records SET created_at=? WHERE id=?').run(new Date(Date.now() - 40 * 86400000).toISOString(), aged.id);

  const on = data(await api('/maintenance/status'));
  expect(on?.enabled === true && on.retention_days === 30, `配了 30 天保留期后状态没跟上：${JSON.stringify(on)?.slice(0, 140)}`);
  expect(typeof on.cutoff_at === 'string' && Date.parse(on.cutoff_at) < Date.now(), `截止点不是过去的时间：${on.cutoff_at}`);
  expect(on.pending?.records >= 1, `待删条数没算出那条 40 天前的记录：${JSON.stringify(on.pending)}`);
  expect(typeof on.audit_cutoff_at === 'string' && Date.parse(on.audit_cutoff_at) < Date.parse(on.cutoff_at), `审计截止点没早于数据截止点（${on.audit_cutoff_at} vs ${on.cutoff_at}），审计会跟着证据一起被删`);

  const pruneBefore = rowCount("SELECT COUNT(*) AS n FROM audit_logs WHERE action='data.prune'");
  const dry = await api('/maintenance/run', { method: 'POST', body: JSON.stringify({ dry_run: true }) });
  expect(dry.status === 200 && data(dry)?.dry_run === true, `试算返回形状不对：${JSON.stringify(data(dry))?.slice(0, 140)}`);
  expect(data(dry).pending?.records >= 1 && data(dry).removed.records === 0, '试算就动手删了，「先看看会删多少」变成「先删了再看」');
  expect(count('SELECT id FROM records WHERE id=?', [aged.id]).length === 1, '试算之后那条过期记录不见了');
  expect(rowCount("SELECT COUNT(*) AS n FROM audit_logs WHERE action='data.prune'") === pruneBefore, '试算写了审计，没发生的事不该留痕');

  const real = await api('/maintenance/run', { method: 'POST', body: JSON.stringify({}) });
  expect(real.status === 200 && data(real)?.skipped === false, `手动清理没跑起来：${JSON.stringify(data(real))?.slice(0, 140)}`);
  expect(data(real).removed.records >= 1, '到期记录没被清掉');
  expect(count('SELECT id FROM records WHERE id=?', [aged.id]).length === 0, '40 天前的记录仍在库里，保留期形同虚设');
  expect(count('SELECT id FROM records WHERE id=?', [fresh.id]).length === 1, '未过期的记录被一起删了，清理范围失控');
  const prunes = count("SELECT actor, target_id, detail FROM audit_logs WHERE action='data.prune' ORDER BY created_at");
  // 只认本次手动清理写的那两条：定时器跑过一轮会另写一对 actor 为 null 的
  const mine = prunes.filter((row) => row.actor === cfg.panel.username);
  expect(mine.some((row) => row.target_id === 'plan') && mine.some((row) => row.target_id === 'applied'), `手动清理没留下「计划+执行」两条审计：${prunes.map((row) => `${row.actor}/${row.target_id}`).join(',')}`);
  expect(JSON.parse(mine.find((row) => row.target_id === 'applied').detail).rows?.records >= 1, '执行审计里没记实际删了多少行，事后无法对账');

  // 现场恢复：保留期关成 0（不清理），避免定时器在后续用例背后删数据；0 也是长期留存部署的合法值
  await restartWithConfig({ exercise: { require_authorization: true, retention_days: 0 } });
  await login();
  const off = data(await api('/maintenance/status'));
  expect(off?.enabled === false && off.cutoff_at === null, `保留期关不掉：${JSON.stringify(off)?.slice(0, 140)}`);
  expect(Object.values(off.pending ?? {}).every((n) => n === 0), '未启用时仍报有待删条数，界面会显示成「马上要删数据」');
  const skipped = await api('/maintenance/run', { method: 'POST', body: JSON.stringify({}) });
  expect(skipped.status === 200 && data(skipped)?.skipped === true && /未启用/.test(data(skipped)?.reason ?? ''), `未启用时手动清理没如实说「跳过」：${JSON.stringify(data(skipped))?.slice(0, 140)}`);
  expect(count('SELECT id FROM records WHERE id=?', [fresh.id]).length === 1, '未启用保留期却仍在删数据');
  return '默认档 180/365 天且审计比数据活得久、试算 0 删除、真删只删 40 天前那条并留 plan+applied、关成 0 即不清理';
});

tc('TC-F-23', '致命配置错误拒绝启动：白名单写成字符串时不带病上线', async () => {
  await stopServer(child);
  child = null;
  await sleep(400);
  const broken = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
  // 类型写错时白名单会被当成未启用，任何人都能试口令且不报错
  broken.panel.allow_ips = '127.0.0.1';
  fs.writeFileSync(CONFIG_FILE, yaml.dump(broken), 'utf8');

  const attempt = startServer();
  for (let i = 0; i < 60 && !attempt.done.exited; i += 1) await sleep(100);
  expect(attempt.done.exited && attempt.done.code === 1, `坏配置下进程没有拒绝启动（exited=${attempt.done.exited} code=${attempt.done.code}），防线会静默失效`);
  expect(/allow_ips/.test(attempt.done.log) && /字符串数组/.test(attempt.done.log), `拒绝启动时没说清是哪一项写错、该怎么写：${attempt.done.log.slice(-400)}`);
  expect(attempt.done.log.includes(String(CONFIG_FILE)), '拒绝启动时没指出是哪份配置文件，运维要去猜');
  let stillUp;
  try {
    stillUp = (await fetch(`http://127.0.0.1:${PANEL_PORT}/alab/health`)).ok;
  } catch {
    stillUp = false;
  }
  expect(!stillUp, '进程退了但健康检查还通，说明有半个监听留在端口上');

  await restartWithConfig({ panel: { allow_ips: [] } });
  await login();
  expect((await api('/auth/me')).status === 200, '改回合法配置后仍起不来');
  return '白名单类型写错 → 进程以 code=1 拒绝启动，日志点名 panel.allow_ips、正确写法与配置文件路径';
});

tc('TC-S-31', '改口令：四种非法输入被拒、旧令牌全部作废、写回配置、审计不含明文', async () => {
  unlockLogins();
  const other = data(await loginAgain());
  expect(other?.token, '前置：再签一条会话，用来验证改口令会一并作废别人的会话');
  const current = TOKEN;
  const oldPassword = cfg.panel.password;
  const next = `qa-${randomString(10)}`;

  const wrongCurrent = await api('/auth/password', { method: 'POST', body: JSON.stringify({ current_password: 'not-the-password', new_password: next }) });
  expect(wrongCurrent.status === 401 && /当前密码/.test(message(wrongCurrent)), `当前口令错时没明确拒绝：${wrongCurrent.status} ${message(wrongCurrent)}`);
  expect((await api('/auth/me', {}, current)).status === 200, '当前口令填错就作废了会话，一次手滑把人踢下线');
  const short = await api('/auth/password', { method: 'POST', body: JSON.stringify({ current_password: oldPassword, new_password: 'abc' }) });
  expect(short.status === 400 && /8/.test(message(short)), `短口令没被拦或没说清下限：${short.status} ${message(short)}`);
  const same = await api('/auth/password', { method: 'POST', body: JSON.stringify({ current_password: oldPassword, new_password: oldPassword }) });
  expect(same.status === 400, '改成同一个口令也算成功，操作员以为换过了其实没换');
  const long = await api('/auth/password', { method: 'POST', body: JSON.stringify({ current_password: oldPassword, new_password: 'x'.repeat(65) }) });
  expect(long.status === 400 && /64/.test(message(long)), `超长口令没被拦或没说清上限：${long.status} ${message(long)}`);

  const changed = await api('/auth/password', { method: 'POST', body: JSON.stringify({ current_password: oldPassword, new_password: next }) });
  expect(changed.status === 200 && data(changed)?.password_updated_at, `改口令失败：${changed.status} ${message(changed)}`);
  expect((await api('/auth/me', {}, current)).status === 401, '改口令后旧令牌仍然有效：令牌泄露了也踢不掉人');
  expect((await api('/auth/me', {}, other.token)).status === 401, '改口令只作废了当前会话，别处的会话还活着');
  expect(rowCount('SELECT COUNT(*) AS n FROM sessions') === 0, '会话表里还留着改口令前的行');

  const onFile = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
  expect(onFile.panel.password === next && Boolean(onFile.panel.password_updated_at), '新口令没写回配置文件，重启后就得用旧口令登录');
  expect(onFile.panel.port === PANEL_PORT && onFile.panel.path === cfg.panel.path, '配置文件被写坏了：其他项丢失或变形，下次启动就是另一套后台');
  expect(onFile.panel.password_updated_at === data(changed).password_updated_at, '配置里的改口令时间与接口回报的不一致');

  const relogin = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: cfg.panel.username, password: next }) }, null);
  expect(relogin.status === 200 && data(relogin)?.token, `新口令登不进去：${relogin.status} ${message(relogin)}`);
  const withOld = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: cfg.panel.username, password: oldPassword }) }, null);
  expect(withOld.status === 401, '旧口令仍能登录，改口令等于没改');
  const auditRow = count("SELECT * FROM audit_logs WHERE action='panel.password_change' ORDER BY created_at DESC LIMIT 1")[0];
  expect(auditRow && auditRow.actor === cfg.panel.username, `改口令没进审计或没记下是谁改的：${JSON.stringify(auditRow)?.slice(0, 140)}`);
  expect(!String(auditRow.detail).includes(next) && !String(auditRow.detail).includes(oldPassword), '审计里抄了口令明文，审计表成了第二份泄露源');
  const check = data(await api('/config-check', {}, data(relogin).token));
  expect(check?.factory_password === false && check?.login_security?.password_updated_at === onFile.panel.password_updated_at, '体检里的改口令状态与配置文件不一致');
  await login();
  return '错口令/短口令/同口令/超长口令四种被拒，改完全部会话作废、配置写回、审计与体检都不含明文';
});

tc('TC-S-32', '来源白名单：名单外一律 404 且与「路径不存在」无法区分，双栈写法不锁死运维', async () => {
  // 复位夹具：白名单外的登录不计数（404 早于口令比对），但前序用例留下的锁会让后半段断言拿到 429
  unlockLogins();
  await restartWithConfig({ panel: { allow_ips: ['10.9.8.7'] } });
  const denied = await loginAgain();
  expect(denied.status === 404, `白名单外的登录返回 ${denied.status}，应当与「这个路径不存在」完全一致`);
  expect(message(denied) === '资源不存在', `404 文案泄露了「你被白名单挡了」：${message(denied)}`);
  expect(!JSON.stringify(denied.json).includes('白名单'), '拒绝原因点出了白名单，等于告诉对方换个来源就能继续试');
  // 白名单是登录入口的闸门，已签发的会话不追溯作废；要立刻踢人走退出所有会话
  expect((await api('/auth/me')).status === 200, '白名单生效后已有会话的行为变了，值守时说不清该不该重新登录');
  const check = data(await api('/config-check'));
  expect(check?.login_security?.allow_ips_enabled === true && check.login_security.allow_ips.length === 1, `体检没反映白名单已启用：${JSON.stringify(check?.login_security)}`);
  expect(check.summary.join('\n').includes('来源白名单: 1 条'), `启动摘要没交代白名单档位：${check.summary.join(' / ')}`);

  // 双栈写法：同一台机器可能以 ::ffff:127.0.0.1 到达，名单里写哪种都得能进
  await restartWithConfig({ panel: { allow_ips: ['::ffff:127.0.0.1'] } });
  const allowed = await loginAgain();
  expect(allowed.status === 200 && data(allowed)?.token, `白名单写 IPv4 映射地址时本机被挡（${allowed.status}），运维会被自己锁在门外`);

  // 现场恢复：空数组是不启用的合法值，不是谁都不许进
  await restartWithConfig({ panel: { allow_ips: [] } });
  await login();
  expect(data(await api('/config-check'))?.login_security?.allow_ips_enabled === false, '白名单关不掉');
  expect((await loginAgain()).status === 200, '清空白名单后仍拒绝本机登录');
  return '名单外 404「资源不存在」、已有会话不追溯、::ffff: 写法可登、清空即不启用';
});

// 运行

const CAT_LABEL = { S: '安全性', F: '功能正确性', P: '业务流程', U: '人性化与文案' };

async function main() {
  try {
    fs.rmSync(QA_ROOT, { recursive: true, force: true });
  } catch (err) {
    // Windows 上正在被占用的库文件删不掉：报的是 EPERM/EBUSY，人只看错误码猜不到是上一轮 --keep 的实例还活着
    if (['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(err.code)) {
      throw new Error(
        `.qa 测试现场被占用，无法重建（${err.code}）。上一轮 --keep 起的隔离实例还在监听端口 ${PANEL_PORT}，` +
          `先结束它：netstat -ano | findstr ${PANEL_PORT} 拿到 PID 后 taskkill /PID <pid> /F，再重跑本脚本`,
        { cause: err }
      );
    }
    throw err;
  }
  // 先落隔离配置再起进程：否则子进程按 DEFAULTS 自建 config.yaml，端口撞进 7778、采集面绑到 0.0.0.0
  writeConfig();
  bootLog = await launch();
  // 直连库要开在 login() 之前：login() 撞到前序用例留下的登录锁时，靠 unlockLogins() 复位重试
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA busy_timeout = 5000');
  await login();

  const results = [];
  let blocker = null;
  /** 单用例看门狗：用例挂住时 Node 会在事件循环抽空后静默 exit 0，结果文件与失败原因一起消失；计时器让循环保持活性，超时当场报出卡在哪条 */
  let stuck = null;
  for (const testCase of CASES) {
    if (!want(testCase.id)) continue;
    clearTimeout(stuck);
    stuck = setTimeout(() => {
      fs.writeSync(2, `\n[qa] 用例 ${testCase.id}（${testCase.name}）超过 120 秒未结束，判为挂死并中止\n`);
      process.exit(3);
    }, 120_000);
    const t0 = Date.now();
    let status = 'PASS';
    let detail;
    if (process.env.QA_TRACE) fs.writeSync(2, `→ ${testCase.id} ${testCase.name}\n`);
    try {
      detail = String((await testCase.fn()) ?? '');
    } catch (err) {
      const isBlocked = err instanceof Blocked;
      if (isBlocked) blocker = blocker ?? testCase.id;
        status = isBlocked ? 'SKIP' : 'FAIL';
      detail = String(err.message || err).slice(0, 500);
    }
    results.push({ id: testCase.id, cat: testCase.cat, name: testCase.name, status, detail, ms: Date.now() - t0 });
  }

  clearTimeout(stuck);
  const out = [];
  for (const cat of ['S', 'F', 'P', 'U']) {
    const rows = results.filter((r) => r.cat === cat);
    if (!rows.length) continue;
    out.push(`\n===== ${CAT_LABEL[cat]}（${rows.length} 项）=====`);
    for (const r of rows) {
      const mark = r.status === 'PASS' ? '通过' : r.status === 'SKIP' ? '跳过' : '失败';
      out.push(`${mark}  ${r.id}  ${r.name}`);
      if (r.status !== 'PASS' || process.env.QA_VERBOSE) out.push(`      └ ${r.detail}`);
    }
  }

  const fails = results.filter((r) => r.status === 'FAIL');
  const skips = results.filter((r) => r.status === 'SKIP');
  out.push(`\n共 ${results.length} 项：通过 ${results.length - fails.length - skips.length}，失败 ${fails.length}，跳过 ${skips.length}`);
  if (blocker) out.push(`（首个前置阻塞点 ${blocker}：夹具装不出来，该用例按「前置未满足」计 SKIP，不计产品缺陷）`);
  out.push(`明细已写入 ${path.relative(SERVER_ROOT, RESULT_FILE)}`);
  // 同步写 fd 1：process.exit 会截断还没刷新的管道输出，接 tee/重定向时会丢掉整份结果
  fs.writeSync(1, out.join('\n') + '\n');

  fs.writeFileSync(
    RESULT_FILE,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        runner: 'server/scripts/qa.mjs',
        panel_port: PANEL_PORT,
        capture_ports: PORT,
        total: results.length,
        passed: results.length - fails.length - skips.length,
        failed: fails.length,
        skipped: skips.length,
        blocker,
        byCategory: Object.fromEntries(
          ['S', 'F', 'P', 'U'].map((cat) => {
            const rows = results.filter((r) => r.cat === cat);
            return [CAT_LABEL[cat], { total: rows.length, pass: rows.filter((r) => r.status === 'PASS').length, fail: rows.filter((r) => r.status === 'FAIL').length, skip: rows.filter((r) => r.status === 'SKIP').length }];
          })
        ),
        results: results.map(({ id, name, cat, status, detail, ms }) => ({ id, name, category: CAT_LABEL[cat], status, detail, ms })),
      },
      null,
      2
    )
  );
  console.log(`明细已写入 ${path.relative(SERVER_ROOT, RESULT_FILE)}`);

  if (flags.includes('--keep')) {
    fs.writeSync(1, `已按 --keep 保留隔离实例与 .qa 现场（管理面端口 ${PANEL_PORT}）\n`);
    return;
  }
  db.close();
  db = null;
  await stopServer(child);
  child = null;
  fs.writeSync(1, `现场保留在 ${path.relative(SERVER_ROOT, QA_ROOT)}（含 qa-result.json 与沙箱邮件）\n`);
  process.exit(fails.length ? 1 : 0);
}

main().catch(async (err) => {
  fs.writeSync(2, `[qa] 装配失败：${err.message}\n${err.stack ? err.stack.split('\n').slice(1, 4).join('\n') : ''}\n`);
  try {
    if (db) db.close();
  } catch {
    /* 已关闭 */
  }
  await stopServer(child);
  process.exit(2);
});
