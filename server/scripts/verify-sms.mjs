/**
 * 短信认证 + 多账号回归：起一个隔离实例与一个本地假网关，走完「管理员登录 → 开启短信 → 建普通用户 → 绑定手机号 → 短信登录
 * → 权限隔离 → 关闭短信 → 管理员改口令」，断言每一步的响应形状与门禁结果。
 *
 * 用法：node scripts/verify-sms.mjs
 * 隔离目录 .verify-sms（config/data 都在里面），不碰 server/data 与 server/config.yaml，也不访问真实阿里云。
 * 假网关只做两件事：SendSmsVerifyCode 回 OK 并记下号码，CheckSmsVerifyCode 按固定码回 PASS/NOT_PASS。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';

const SERVER_ROOT = path.resolve(import.meta.dirname, '..');
const WORK = path.join(SERVER_ROOT, '.verify-sms');
const CONFIG_FILE = path.join(WORK, 'config.yaml');
const DATA_DIR = path.join(WORK, 'data');
const PANEL_PORT = 4321;
const GATEWAY_PORT = 4399;
const PANEL_PATH = 'smscheck';
const ADMIN = 'adminroot';
const ADMIN_PASS = 'adminpass123';
const ADMIN_PASS2 = 'adminpass456';
const BASE = `http://127.0.0.1:${PANEL_PORT}/${PANEL_PATH}/api`;
const FIXED_CODE = '246810';
const PHONE = '13800138000';

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
        username: ADMIN,
        password: ADMIN_PASS,
        // 当作「已经改过口令」：否则建站会被首登强制改口令拦住，而这轮只验证账号与短信
        password_updated_at: new Date().toISOString(),
      },
      capture: { port_range: [8200, 8299], bind_host: '127.0.0.1' },
      mail: { default_dry_run: true, default_send_interval_ms: 0 },
      exercise: { require_authorization: false },
    }),
    'utf8'
  );
}

/** 假阿里云号码认证网关：只认这两个 Action，签名不校验（签名算法本身在 selftest 里单测）。 */
function startGateway() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const action = url.searchParams.get('Action');
    calls.push({ action, query: Object.fromEntries(url.searchParams) });
    res.setHeader('content-type', 'application/json');
    if (action === 'SendSmsVerifyCode') {
      res.end(JSON.stringify({ Code: 'OK', RequestId: `fake-${calls.length}`, Model: { BizId: 'fake-biz' } }));
    } else if (action === 'CheckSmsVerifyCode') {
      const verify = url.searchParams.get('VerifyCode');
      res.end(JSON.stringify({ Code: 'OK', RequestId: `fake-${calls.length}`, Model: { VerifyResult: verify === FIXED_CODE ? 'PASS' : 'NOT_PASS' } }));
    } else {
      res.statusCode = 400;
      res.end(JSON.stringify({ Code: 'InvalidAction', Message: 'unsupported action' }));
    }
  });
  return new Promise((resolve) => {
    server.listen(GATEWAY_PORT, '127.0.0.1', () => resolve({ server, calls }));
  });
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

async function api(method, url, body, token, expectCode = 0) {
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
    /* 非 JSON 留给断言报错 */
  }
  if (expectCode !== null && json?.code !== expectCode) {
    throw new Error(`${method} ${url} 期望 code=${expectCode}，实际 ${res.status} ${text.slice(0, 300)}`);
  }
  return { status: res.status, json, data: json?.data };
}

async function main() {
  prepare();
  const gateway = await startGateway();
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

    // 1) 管理员登录：没有手机号也直接拿令牌，role=admin
    const adminLogin = await api('POST', '/auth/login', { username: ADMIN, password: ADMIN_PASS });
    const adminToken = adminLogin.data.token;
    check('管理员登录直接返回令牌', Boolean(adminToken) && adminLogin.data.role === 'admin', `role=${adminLogin.data.role}`);

    const users0 = await api('GET', '/users', undefined, adminToken);
    check('启动时自动种入管理员账号', users0.data.items.length === 1 && users0.data.admins === 1, `items=${users0.data.items.length}`);

    // 2) 默认短信关闭；密钥为空，所以「能否启用」仍是否（sms_ready 描述配置是否齐全，与开关状态无关）
    const settings0 = await api('GET', '/settings', undefined, adminToken);
    check('默认短信认证关闭', settings0.data.sms?.enabled === false);
    check('密钥为空时 sms_ready 为 false', settings0.data.sms_ready === false);

    // 3) 先不带密钥直接开：应存下来但回 warning，且 sms_ready 变 false
    const half = await api('PUT', '/settings/sms', { value: { enabled: true } }, adminToken);
    check('缺密钥开启时给出警告', Boolean(half.data?.warning), half.data?.warning || 'no warning');
    const settingsHalf = await api('GET', '/settings', undefined, adminToken);
    check('缺密钥时 sms_ready 为 false', settingsHalf.data.sms_ready === false);

    // 3) 开启短信：配置指向本地假网关
    const saved = await api(
      'PUT',
      '/settings/sms',
      {
        value: {
          enabled: true,
          access_key_id: 'LTAI5tFakeKeyId0001',
          access_key_secret: 'fake-secret-value',
          sign_name: '远山科技',
          template_code: '100001',
          template_param: '{"code":"##code##"}',
          code_length: 6,
          valid_time: 300,
          interval_seconds: 30,
          endpoint: `http://127.0.0.1:${GATEWAY_PORT}/`,
        },
      },
      adminToken
    );
    check('保存短信配置成功', saved.data?.enabled === true);
    check('配置不全时不给 warning', !saved.data?.warning, saved.data?.warning || 'no warning');
    const settings1 = await api('GET', '/settings', undefined, adminToken);
    check('AccessKey 以掩码回显', String(settings1.data.sms.access_key_id).endsWith('******'), settings1.data.sms.access_key_id);
    check('Secret 不回传明文', settings1.data.sms.access_key_secret === '******');
    check('配置齐全后 sms_ready 为 true', settings1.data.sms_ready === true);

    // 4) 管理员建普通用户（预填手机号但未验证）
    const created = await api('POST', '/users', { username: 'zhangsan', password: 'userspass1', display_name: '张三', phone: PHONE }, adminToken);
    check('管理员创建普通用户', created.data?.username === 'zhangsan' && created.data?.role === 'user');
    check('预填手机号默认未验证', created.data?.phone_verified === false);

    const dup = await api('POST', '/users', { username: 'zhangsan', password: 'userspass2' }, adminToken, null);
    check('重复账号被拒绝', dup.json.code === 400, dup.json.message);

    // 5) 普通用户首次登录：短信开启 + 手机号未验证 → purpose=bind
    const bindStep = await api('POST', '/auth/login', { username: 'zhangsan', password: 'userspass1' });
    check('普通用户登录要求短信', bindStep.data.sms_required === true && bindStep.data.purpose === 'bind', `purpose=${bindStep.data.purpose}`);
    check('手机号掩码回显', bindStep.data.phone_masked === '138****8000', bindStep.data.phone_masked);
    const bindTicket = bindStep.data.ticket;

    // 6) 发码：走假网关，且 30 秒内重发被限流
    const sent = await api('POST', '/auth/sms/send', { ticket: bindTicket, phone: PHONE });
    check('发送绑定验证码', sent.data?.sent === true);
    const lastSend = gateway.calls.filter((c) => c.action === 'SendSmsVerifyCode').at(-1);
    check('网关收到 SendSmsVerifyCode', lastSend?.query.PhoneNumber === PHONE, lastSend?.query.PhoneNumber);
    check('请求带签名与版本', Boolean(lastSend?.query.Signature) && lastSend?.query.Version === '2017-05-25');
    const throttled = await api('POST', '/auth/sms/send', { ticket: bindTicket, phone: PHONE }, undefined, null);
    check('重发被限流', throttled.json.code === 429, throttled.json.message);

    // 7) 错码不通过、对码通过并绑定
    const wrong = await api('POST', '/auth/sms/verify', { ticket: bindTicket, code: '000000' }, undefined, null);
    check('错误验证码被拒绝', wrong.json.code === 400, wrong.json.message);
    const okBind = await api('POST', '/auth/sms/verify', { ticket: bindTicket, code: FIXED_CODE });
    check('验证码通过后拿到会话', Boolean(okBind.data?.token) && okBind.data.role === 'user');
    const userToken = okBind.data.token;
    const me = await api('GET', '/auth/me', undefined, userToken);
    check('手机号已标记为已验证', me.data.phone_verified === true && me.data.phone === '138****8000');

    // 8) 再次登录：purpose 变成 login；同号 30 秒内不能重发，这里直接验码（假网关固定回 PASS）
    const loginStep = await api('POST', '/auth/login', { username: 'zhangsan', password: 'userspass1' });
    check('已绑定用户走短信登录', loginStep.data.sms_required === true && loginStep.data.purpose === 'login', loginStep.data.purpose);
    const okLogin = await api('POST', '/auth/sms/verify', { ticket: loginStep.data.ticket, code: FIXED_CODE });
    check('短信登录成功', Boolean(okLogin.data?.token));

    // 9) 权限隔离：普通用户碰不到账号与设置，但业务接口正常
    const deniedUsers = await api('GET', '/users', undefined, userToken, null);
    check('普通用户读账号列表被拒', deniedUsers.json.code === 403, deniedUsers.json.message);
    const deniedSettings = await api('GET', '/settings', undefined, userToken, null);
    check('普通用户读系统设置被拒', deniedSettings.json.code === 403, deniedSettings.json.message);
    const mailOk = await api('GET', '/mail-tasks', undefined, userToken, null);
    check('普通用户仍可用业务接口', mailOk.json.code === 0);

    // 10) 普通用户改自己的口令：旧口令错 401、新口令生效后仍要短信
    const badPwd = await api('POST', '/auth/password', { current_password: 'wrong-pass', new_password: 'userspass9' }, userToken, null);
    check('改口令时校验当前口令', badPwd.json.code === 401, badPwd.json.message);
    await api('POST', '/auth/password', { current_password: 'userspass1', new_password: 'userspass9' }, userToken);
    const oldLogin = await api('POST', '/auth/login', { username: 'zhangsan', password: 'userspass1' }, undefined, null);
    check('旧口令登录失败', oldLogin.json.code === 401, oldLogin.json.message);

    // 11) 管理员关闭短信：普通用户只凭口令即可登录
    await api('PUT', '/settings/sms', { value: { ...settings1.data.sms, enabled: false } }, adminToken);
    const plain = await api('POST', '/auth/login', { username: 'zhangsan', password: 'userspass9' });
    check('关闭短信后直接登录', Boolean(plain.data?.token) && !plain.data.sms_required);

    // 12) 管理员改口令：写回配置、清空会话、旧口令失效
    await api('POST', '/auth/password', { current_password: ADMIN_PASS, new_password: ADMIN_PASS2 }, adminToken);
    const adminOld = await api('POST', '/auth/login', { username: ADMIN, password: ADMIN_PASS }, undefined, null);
    check('管理员旧口令失效', adminOld.json.code === 401, adminOld.json.message);
    const adminNew = await api('POST', '/auth/login', { username: ADMIN, password: ADMIN_PASS2 });
    check('管理员新口令可登录', Boolean(adminNew.data?.token));
    const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
    check('新口令已写回 config.yaml', cfg.panel.password === ADMIN_PASS2);

    // 13) 校验留痕：发码确实打到了网关（同号限流挡住的那次不该重复打到）
    check('发码请求落到网关', gateway.calls.filter((c) => c.action === 'SendSmsVerifyCode').length === 1);

    console.log(`\n共 ${failures === 0 ? '全部' : failures} 项断言${failures === 0 ? '通过' : '失败'}`);
    if (failures > 0) process.exitCode = 1;
  } catch (error) {
    console.error('回归中断：', error.message);
    console.error(logs.join('').slice(-2000));
    process.exitCode = 1;
  } finally {
    child.kill();
    gateway.server.close();
  }
}

main();
