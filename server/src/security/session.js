/**
 * 管理面会话与安全：口令校验、爆破锁定、来源白名单、令牌签发/校验/注销、改口令。判定逻辑只在这一份实现里，别再在路由重抄。
 * 令牌载体 x-alab-token 头与 alab_token Cookie 属冻结协议，改名会砸前端拦截器与 e2e 断言；口令只从 config 读，绝不写进响应、审计或日志；会话列表只回令牌前 6 位。
 * 锁定计数落 login_failures 表（只在内存会重启清零），allow_ips 非空时名单外来源回 404 而不是 403，避免把后台入口存在性告诉扫描器。
 */
import { config, persistConfigValue, randomString } from '../platform/settings.js';
import { get, all, run, nowIso } from '../platform/storage/rows.js';
import { clientIp } from '../platform/net/clientIp.js';
import { ok, unauthorized, badRequest, forbidden, notFound, tooManyRequests } from '../platform/net/envelope.js';
import { writeAudit } from './audit.js';
import { checkCredentials, findById, maskPhone, touchLogin, bindVerifiedPhone, phoneProblem } from './users.js';
import { passwordProblem, hashPassword, verifyPassword } from './password.js';
import { issueTicket, readTicket } from './ticket.js';
import {
  smsConfig,
  smsEnabled,
  smsReadyProblem,
  sendVerifyCode,
  checkVerifyCode,
  sendThrottle,
  noteSend,
} from '../sms/sms.js';

// 令牌两个载体：头优先、Cookie 兜底。名字由前端拦截器与端到端断言锁定，属冻结协议，只许加别名不许改原值
export const TOKEN_HEADER = 'x-alab-token';
export const TOKEN_COOKIE = 'alab_token';

// 爆破锁定窗口 10 分钟：让脚本化猜口令性价比低于人工输错；login 的提示语与此耦合，改常量要同步文案
const LOCK_WINDOW_MS = 10 * 60 * 1000;
// 窗口内允许 8 次失败：留够手打输错空间，同时压住常见字典攻击
const MAX_FAILS = 8;

/**
 * 登录失败计数落 login_failures 表（client_ip 主键 + fails + 窗口起点 + 最近一次，见 storage/schema.js 的 v5 迁移）。
 * 之前是内存 Map，进程重启就清零、攻击者崩一次服务就白拿一轮尝试额度；落库后重启不清零，也留得下撞库痕迹，代价只是失败时多一次写库。
 */

/**
 * 归一化来源地址，去掉 ::ffff: 前缀，让白名单比对不受 IPv4/IPv6 双栈写法影响。
 * 同一台机器可能以 127.0.0.1 或 ::ffff:127.0.0.1 过来，不归一会出现白名单写了却把本地挡在门外的故障。
 */
function normalizeIp(ip) {
  const raw = String(ip || '');
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * 当前来源是否在 panel.allow_ips 白名单内；白名单为空（默认）时恒为 true。
 * 空数组是不启用这项限制、不是谁都不许进，理解反了会默认锁死后台。
 */
function ipAllowed(ip) {
  const list = Array.isArray(config.panel.allow_ips) ? config.panel.allow_ips : [];
  if (!list.length) return true;
  const from = normalizeIp(ip);
  return list.some((entry) => normalizeIp(entry) === from);
}

/**
 * 这个 IP 当前是否在登录锁定中；true 直接回 429 连口令都不比对。窗口从第一次失败起算且不滑动，锁定就是自首次失败起的 10 分钟，未到 8 次返回 false 放行（手打输错不该当爆破）。
 * 窗口已过或 window_started_at 解析不出时顺手删记录放行，既让表不随失败次数无限增长，也不让一条坏数据把 IP 永久钉死在 429。
 */
function blocked(ip) {
  const row = get('SELECT fails, window_started_at FROM login_failures WHERE client_ip=?', [ip]);
  if (!row) return false;
  const since = Date.parse(row.window_started_at || '');
  if (!Number.isFinite(since) || Date.now() - since > LOCK_WINDOW_MS) {
    // 窗口已过：清掉旧计数再放行，否则上一次演练的失败会一直压着这个 IP
    run('DELETE FROM login_failures WHERE client_ip=?', [ip]);
    return false;
  }
  return Number(row.fails) >= MAX_FAILS;
}

/**
 * 记一次登录失败，键与 blocked() 同为 clientIp()。窗口已过期时重新起算（覆盖成 fails=1 而非累加），免得挂着的老记录让第 9 次立刻锁定。
 * 用 UPSERT 而非先查再插：并发失败时两条都判定没有记录，先查再插会撞主键把正常 401 变成 500。
 */
function noteFailure(ip) {
  const row = get('SELECT window_started_at FROM login_failures WHERE client_ip=?', [ip]);
  const since = row ? Date.parse(row.window_started_at || '') : NaN;
  const fresh = !row || !Number.isFinite(since) || Date.now() - since > LOCK_WINDOW_MS;
  const now = nowIso();
  if (fresh) {
    run(
      `INSERT INTO login_failures (client_ip, fails, window_started_at, last_at) VALUES (?,?,?,?)
       ON CONFLICT(client_ip) DO UPDATE SET fails=1, window_started_at=excluded.window_started_at, last_at=excluded.last_at`,
      [ip, 1, now, now]
    );
    return;
  }
  run('UPDATE login_failures SET fails=fails+1, last_at=? WHERE client_ip=?', [now, ip]);
}

/** 登录成功时清掉该来源的失败计数：不清零的话输错 7 次后登对、下次再输错会立刻被锁。 */
function clearFailures(ip) {
  run('DELETE FROM login_failures WHERE client_ip=?', [ip]);
}

/**
 * 从请求取会话令牌：先 x-alab-token 头，头没有再从 Cookie 兜底（Cookie 只给直接开网页没跑 JS 的场景）。拿不到返回 null。
 * Node 允许同名多头，req.headers[k] 可能是数组，取第一个是 Express 既有口径。
 */
function readToken(req) {
  const header = req.headers[TOKEN_HEADER];
  if (header) return String(Array.isArray(header) ? header[0] : header);
  // Cookie 只认 [字母数字-] 组成的 UUID 形状，避免把用户可控的整段 Cookie 值当令牌查库
  const cookie = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${TOKEN_COOKIE}=([\\w-]+)`));
  return cookie ? cookie[1] : null;
}

/**
 * 拼 Set-Cookie 头；登出传空串 + maxAge 0 让浏览器删掉它，maxAgeMs 内部换算成秒写进 Max-Age。
 * HttpOnly 挡 XSS 读令牌；Path=/ 因为管理面在随机路径下也要带；Secure 只在 TLS 时加，http 下加了浏览器会直接丢弃 Cookie 像登录态坏了。
 */
function cookieHeader(token, maxAgeMs, tls) {
  // 业务层一直带 x-alab-token 头，cookie 只是兜底，所以 SameSite 用最严的一档
  const secure = tls ? '; Secure' : '';
  return `${TOKEN_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Strict${secure}`;
}

// 是否 https：req.secure 或 x-forwarded-proto 的第一跳。这里没有 trust_proxy 闸门：伪造这个头只会让 Cookie 多带 Secure（明文链路上等于失效），拿不到会话；若将来用它放行敏感操作，必须先接闸门。
const isTls = (req) => Boolean(req.secure) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

// 会话里记的 UA 只做人眼辨认、不参与判定，既不解析也不校验，截断到 200 字符防止超长头撑库
const UA_LIMIT = 200;
const userAgentOf = (req) => String(req.headers['user-agent'] || '').slice(0, UA_LIMIT);

/**
 * 登录（第一步：账密）：口令比对 + 爆破锁定 + 短信二次验证。404 来源不在白名单 / 429 锁定中 / 401 账号或密码错 /
 * 403 账号停用 / 200 直接发会话，或 200 带 sms 票据要求继续验码。
 * 优先级：白名单先于锁定先于口令比对；账号错与密码错回同一个 401 不给枚举留差异。
 * 短信策略：只对普通用户生效（管理员是后台兜底入口，短信服务挂了也必须进得去）；
 * 已绑定并验证过的手机号走 login 票据，未绑定走 bind 票据先绑号再发会话。
 */
export function login(req, res) {
  // 锁定键取 clientIp()：默认走 socket 对端地址、不可伪造；换成直读 X-Forwarded-For 的话攻击者每次换头就是新 IP，计数永远到不了 8 次
  const ip = clientIp(req);
  // 来源白名单先于一切判定：名单外来源连口令对不对都不该问，回 404 而不是 403，让它与随机路径不存在的响应无法区分
  if (!ipAllowed(ip)) return notFound(res, '资源不存在');
  if (blocked(ip)) {
    return tooManyRequests(res, '登录失败次数过多，请 10 分钟后再试');
  }
  // req.body 可能整个不存在（没走 json 中间件或被非 JSON 请求打到），兜成空对象再解构
  const { username, password } = req.body || {};
  const check = checkCredentials(username, password);
  if (!check.user) {
    noteFailure(ip);
    // 不写审计：爆破是运行期噪声，把用户名带进 detail 有泄露口令线索的风险；失败计数已落 login_failures，事后仍能查哪个 IP 撞过多少次
    return check.disabled ? forbidden(res, '账号已停用，请联系管理员') : unauthorized(res, check.error);
  }
  const user = check.user;
  clearFailures(ip);

  // 短信认证只拦普通用户：管理员账号是平台的最后一把钥匙，不能因为阿里云欠费或密钥过期就整体锁死
  if (user.role === 'user' && smsEnabled()) {
    const purpose = user.phone && user.phone_verified_at ? 'login' : 'bind';
    const ticket = issueTicket({ userId: user.id, purpose, phone: user.phone || '' });
    return ok(res, {
      sms_required: true,
      purpose,
      ticket,
      // 号段掩码只是给界面显示「发到哪个号」，完整号码不回浏览器
      phone_masked: maskPhone(user.phone),
      interval_seconds: smsConfig().interval_seconds,
    });
  }
  return issueSession(req, res, user);
}

/** 建会话：token + Cookie + sessions 行（记 user_id/role，后续权限判定只读这张表）。 */
function issueSession(req, res, user) {
  const ip = clientIp(req);
  // 令牌用 UUID：不可猜、不含任何用户信息，泄露到日志里也不能反推出账号（掩码口径见 audit.js）
  const token = crypto.randomUUID();
  // 会话时长来自 config.session_ttl_hours，缺省 12 小时：够一个工作日，又不至于跨天还有效
  // Number(x || 12) 只兜住没填/填 0，写成不可解析文本会得到 NaN、比不过过期判断，结果这张会话永不过期；configCheck 会就此项报错，别绕过它
  const ttl = Number(config.session_ttl_hours || 12) * 3600 * 1000;
  const expiresAt = Date.now() + ttl;
  run(
    'INSERT INTO sessions (token, username, user_id, role, expires_at, created_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)',
    [token, user.username, user.id, user.role, expiresAt, nowIso(), normalizeIp(ip), userAgentOf(req)]
  );
  touchLogin(user.id);
  writeAudit(req, 'auth.login', {
    targetKind: 'user',
    targetId: user.id,
    actor: user.username,
    detail: { username: user.username, role: user.role },
  });
  res.setHeader('Set-Cookie', cookieHeader(token, ttl, isTls(req)));
  return ok(res, {
    token,
    username: user.username,
    role: user.role,
    display_name: user.display_name || user.username,
    expires_at: expiresAt,
  });
}

/**
 * 发登录/绑定验证码：body {ticket, phone?}。ticket 是登录第一步签的短期票据。
 * - purpose=bind：手机号取 body.phone（管理员预填的号仅在没传时兜底），必须是合法 11 位号；
 * - purpose=login：只用票据里的号，不接受前端换号，避免拿别人的手机号收码。
 * 频控在本地做（60 秒/号，5 次/小时/号，20 次/小时/IP），过了才调用阿里云，失败也落流水。
 */
export async function sendSmsCode(req, res) {
  const payload = readTicket(req.body?.ticket);
  if (!payload) return badRequest(res, '验证已过期，请重新登录');
  const user = findById(payload.u);
  if (!user || user.status !== 'active') return unauthorized(res, '账号不可用，请联系管理员');
  if (user.role === 'admin') return badRequest(res, '管理员账号不启用短信验证');
  if (!smsEnabled()) return badRequest(res, '短信验证服务未开启');

  let phone = payload.ph;
  if (payload.p === 'bind') {
    phone = String(req.body?.phone || payload.ph || '').trim();
    const problem = phoneProblem(phone);
    if (problem) return badRequest(res, problem);
  }
  if (!phone) return badRequest(res, '未绑定手机号，请先填写手机号');

  const ip = clientIp(req);
  const throttle = sendThrottle(phone, ip);
  if (throttle) return tooManyRequests(res, throttle);
  try {
    const result = await sendVerifyCode(phone);
    noteSend({ phone, purpose: payload.p, userId: user.id, ip, ok: true, message: 'sent', requestId: result.request_id });
    return ok(res, {
      sent: true,
      phone_masked: maskPhone(phone),
      interval_seconds: Number(smsConfig().interval_seconds || 60),
      valid_time: Number(smsConfig().valid_time || 300),
    });
  } catch (error) {
    noteSend({ phone, purpose: payload.p, userId: user.id, ip, ok: false, message: error.message });
    return badRequest(res, error.message);
  }
}

/**
 * 校验验证码并完成登录：body {ticket, code, phone?}。
 * 云端 PASS 之后：bind 票据写号并标已验证，再发会话；login 票据直接发会话。
 * 失败统一 400「验证码错误或已过期」，不暴露是哪一步错。
 */
export async function verifySmsLogin(req, res) {
  const payload = readTicket(req.body?.ticket);
  if (!payload) return badRequest(res, '验证已过期，请重新登录');
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (code.length < 4) return badRequest(res, '请输入短信验证码');
  const user = findById(payload.u);
  if (!user || user.status !== 'active') return unauthorized(res, '账号不可用，请联系管理员');

  let phone = payload.ph;
  if (payload.p === 'bind') {
    phone = String(req.body?.phone || payload.ph || '').trim();
    const problem = phoneProblem(phone);
    if (problem) return badRequest(res, problem);
  }
  if (!phone) return badRequest(res, '未绑定手机号，请先填写手机号');

  let result;
  try {
    result = await checkVerifyCode(phone, code);
  } catch (error) {
    return badRequest(res, error.message);
  }
  if (!result.pass) {
    writeAudit(req, 'auth.sms_fail', { targetKind: 'user', targetId: user.id, actor: user.username, detail: { result: result.result } });
    return badRequest(res, '验证码错误或已过期');
  }

  let nextUser = user;
  if (payload.p === 'bind') {
    nextUser = bindVerifiedPhone(user.id, phone) || user;
    writeAudit(req, 'auth.phone_bind', { targetKind: 'user', targetId: user.id, actor: user.username, detail: { phone: maskPhone(phone) } });
  }
  writeAudit(req, 'auth.sms_pass', { targetKind: 'user', targetId: user.id, actor: user.username, detail: { purpose: payload.p } });
  return issueSession(req, res, nextUser);
}

/**
 * 登出：删该令牌会话行 + Set-Cookie Max-Age=0 让浏览器丢掉 Cookie。没有令牌或早已过期都静默回成功，这是刻意的：报错只会让前端陷入退不出去的死循环。
 */
export function logout(req, res) {
  const token = readToken(req);
  if (token) run('DELETE FROM sessions WHERE token=?', [token]);
  // 传空令牌 + 0 存活：把旧 Cookie 顶掉，免得浏览器还留着上一位操作员的令牌
  res.setHeader('Set-Cookie', cookieHeader('', 0, isTls(req)));
  return ok(res, true);
}

/**
 * 管理面会话守卫（中间件）：校验通过后挂上 req.session 与 req.user 供审计、权限与 whoami 读；
 * 没带令牌、令牌查不到/过期、账号被停用都回 401，前端据此统一跳登录页。
 * expires_at 是毫秒整数，历史/迁移给成字符串必须靠 Number() 归一再比。会话不做滑动续期。
 * 每次请求回查 users：停用账号立即失效，不必等「退出所有会话」，也防住 v8 之前的老会话（user_id 为空）。
 */
export function requireSession(req, res, next) {
  const token = readToken(req);
  if (!token) return unauthorized(res, '未登录');
  const session = get('SELECT * FROM sessions WHERE token=?', [token]);
  if (!session || Number(session.expires_at) < Date.now()) {
    return unauthorized(res, '登录已过期，请重新登录');
  }
  const user = session.user_id ? findById(session.user_id) : null;
  if (!user) return unauthorized(res, '登录已过期，请重新登录');
  if (user.status !== 'active') return unauthorized(res, '账号已停用，请联系管理员');
  req.session = session;
  req.user = user;
  return next();
}

/**
 * 管理员守卫：必须已过 requireSession。普通用户访问账号管理、短信配置、运行参数时回 403。
 * 权限只认库里的 role，不认前端传来的任何字段；会话里那份 role 只用于列表展示。
 */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return forbidden(res, '仅管理员可执行此操作');
  return next();
}

/**
 * 当前登录身份：必须已过 requireSession，200 回 {username, role, display_name, phone, phone_verified, expires_at}。
 * 口令与令牌都不出现；手机号掩码，前端只用来显示「已绑定 138****8000」。
 */
export function whoami(req, res) {
  const user = req.user;
  const cfg = smsConfig();
  return ok(res, {
    username: user.username,
    role: user.role,
    display_name: user.display_name || user.username,
    phone: maskPhone(user.phone),
    phone_verified: Boolean(user.phone_verified_at),
    // 普通用户看到的是「本平台是否要求验码」，管理员据此决定是否显示账号管理入口
    sms_enabled: Boolean(cfg.enabled) && !smsReadyProblem(cfg),
    expires_at: Number(req.session.expires_at),
  });
}

/**
 * 会话清单：谁在什么时候从哪台机器登录、什么时候到期；必须已过 requireSession（读 req.session.token 标出是自己）。只回令牌前 6 位，完整令牌绝不出现在响应里。用途是清点有没有陌生会话，不是把别人的登录态发给当前用户。
 * 过期会话不删、照实列出标 expired=true，清理由 platform/maintenance.js 的保留期任务负责，读接口不写库；ip/user_agent 可能为 null（v5 迁移前签发的老会话），前端按来源未知显示。
 */
export function listSessions(req, res) {
  const rows = all(
    'SELECT token, username, expires_at, created_at, ip, user_agent FROM sessions ORDER BY created_at DESC'
  );
  const current = req.session?.token;
  const now = Date.now();
  return ok(
    res,
    rows.map((row) => ({
      token_hint: `${String(row.token).slice(0, 6)}…`,
      is_current: row.token === current,
      username: row.username,
      expires_at: Number(row.expires_at),
      created_at: row.created_at,
      ip: row.ip || null,
      user_agent: row.user_agent || null,
      expired: Number(row.expires_at) < now,
    }))
  );
}

/**
 * 一键退出所有会话：清空 sessions 表，连调用者自己这条一起清（语义是我怀疑令牌泄露了全部作废），代价是自己要重登。返回 {revoked: 被清条数}。
 * DELETE 全表 + 一条 session.revoke_all 审计（记条数不记令牌）；writeAudit 读内存里的 req.session 不查库，所以删除后仍能写成功。不做只清别人的变体，要精确处理可先看清单再改口令。
 */
export function revokeAllSessions(req, res) {
  const before = get('SELECT COUNT(*) AS n FROM sessions');
  run('DELETE FROM sessions');
  const revoked = Number(before?.n || 0);
  writeAudit(req, 'session.revoke_all', {
    targetKind: 'session',
    detail: { revoked },
  });
  res.setHeader('Set-Cookie', cookieHeader('', 0, isTls(req)));
  return ok(res, { revoked });
}

// 最短 8 位：口令是随机路径+口令两道门的第二道，与首次生成的随机口令等长，低于它等于允许把安全水位往下调
const MIN_PASSWORD = 8;

/**
 * 修改后台口令：写回 config.yaml（只换那一行，保留操作员注释）+ 内存同步立即生效 + 清空全部会话（旧令牌一律作废，改口令即有效撤销）+ 一条 panel.password_change 审计。
 * 审计 detail 只有操作者与时间戳，新旧口令一个字符都不落库，响应也不回口令，改完必须重登。当前口令错回 401、新口令不合规回 400；当前口令错不累加 login_failures（调用者已持有有效会话，当爆破锁会把自己锁在门外）。
 */
export function changePassword(req, res) {
  const { current_password: currentPassword, new_password: newPassword } = req.body || {};
  const user = req.user;
  if (!user) return unauthorized(res, '未登录');
  const current = String(currentPassword == null ? '' : currentPassword);
  const currentOk = user.password_hash
    ? verifyPassword(current, user.password_hash)
    : current === config.panel.password;
  if (!currentOk) return unauthorized(res, '当前密码不正确');
  const next = String(newPassword == null ? '' : newPassword);
  const problem = passwordProblem(next);
  if (problem) return badRequest(res, problem);
  if (user.password_hash && verifyPassword(next, user.password_hash)) return badRequest(res, '新密码不能与当前密码相同');

  const updatedAt = nowIso();
  run('UPDATE users SET password_hash=?, updated_at=? WHERE id=?', [hashPassword(next), updatedAt, user.id]);
  if (user.role === 'admin') {
    // 先落盘再改内存：写文件失败时抛出由错误中间件回 500，内存 config 不变，不会出现这次能登重启后登不上的半截状态
    persistConfigValue('panel', 'password', next);
    persistConfigValue('panel', 'password_updated_at', updatedAt);
  }
  // 只作废这个账号自己的会话：多账号后若清整表，普通用户改一次口令会把正在值守的管理员一起踢下线
  run('DELETE FROM sessions WHERE user_id=?', [user.id]);
  writeAudit(req, 'panel.password_change', {
    targetKind: 'user',
    targetId: user.id,
    detail: { username: user.username, password_updated_at: updatedAt },
  });
  res.setHeader('Set-Cookie', cookieHeader('', 0, isTls(req)));
  return ok(res, { username: user.username, password_updated_at: updatedAt });
}

/**
 * 生成一条建议口令：8 位随机串，与首次启动口令同一张字符表、同一种随机度。
 * 单独导出而不是让前端调 Math.random：这是访问凭据必须密码学随机，字符表要与 settings.js 一致（去掉易混淆的 l/o/0/1 因为要人手抄）。
 */
export function suggestPassword() {
  return randomString(MIN_PASSWORD);
}

/**
 * 当前登录安全态势，启动摘要与系统设置页都读它：active_locks 是此刻正被锁定的来源数，sessions 是未过期会话数。
 * 只回统计量不回 IP 明细与令牌，因为它会被打进启动横幅（可能被日志采集走），明细留在库里由会话清单接口按需查。
 */
export function loginSecurityStatus() {
  const list = Array.isArray(config.panel.allow_ips) ? config.panel.allow_ips.map(String) : [];
  const rows = all('SELECT fails, window_started_at FROM login_failures');
  const now = Date.now();
  // 只数窗口未过且攒够次数的，与 blocked() 同一口径；过期行不删，读接口不写库
  const activeLocks = rows.filter((row) => {
    const since = Date.parse(row.window_started_at || '');
    return Number.isFinite(since) && now - since <= LOCK_WINDOW_MS && Number(row.fails) >= MAX_FAILS;
  }).length;
  const sessions = Number(
    get('SELECT COUNT(*) AS n FROM sessions WHERE expires_at >= ?', [now])?.n || 0
  );
  return {
    allow_ips: list,
    allow_ips_enabled: list.length > 0,
    lock_window_minutes: Math.round(LOCK_WINDOW_MS / 60000),
    max_fails: MAX_FAILS,
    active_locks: activeLocks,
    sessions,
    password_updated_at: config.panel.password_updated_at || null,
  };
}
