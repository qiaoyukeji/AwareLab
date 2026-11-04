import { config } from '../platform/settings.js';
import { get, run, nowIso } from '../platform/storage/rows.js';
import { clientIp } from '../platform/net/clientIp.js';
import { ok, unauthorized, tooManyRequests } from '../platform/net/envelope.js';

export const TOKEN_HEADER = 'x-alab-token';
export const TOKEN_COOKIE = 'alab_token';

const LOCK_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 8;

/**
 * 登录失败计数只在内存里：管理面是单进程部署，重启即清零可以接受。
 * 需要留痕的是"改过什么"，那归 audit_logs 管；爆破尝试属于运行期状态，落库反而拖慢每一次校验。
 */
const failures = new Map();

function blocked(ip) {
  const record = failures.get(ip);
  if (!record) return false;
  if (Date.now() - record.since > LOCK_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return record.fails >= MAX_FAILS;
}

function noteFailure(ip) {
  const record = failures.get(ip);
  if (!record || Date.now() - record.since > LOCK_WINDOW_MS) failures.set(ip, { since: Date.now(), fails: 1 });
  else record.fails++;
}

function readToken(req) {
  const header = req.headers[TOKEN_HEADER];
  if (header) return String(Array.isArray(header) ? header[0] : header);
  const cookie = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${TOKEN_COOKIE}=([\\w-]+)`));
  return cookie ? cookie[1] : null;
}

function cookieHeader(token, maxAgeMs, tls) {
  // 业务层一直带 x-alab-token 头，cookie 只是兜底，所以 SameSite 用最严的一档
  const secure = tls ? '; Secure' : '';
  return `${TOKEN_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Strict${secure}`;
}

const isTls = (req) => Boolean(req.secure) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

export function login(req, res) {
  const ip = clientIp(req);
  if (blocked(ip)) {
    return tooManyRequests(res, '登录失败次数过多，请 10 分钟后再试');
  }
  const { username, password } = req.body || {};
  if (username !== config.panel.username || password !== config.panel.password) {
    noteFailure(ip);
    return unauthorized(res, '账号或密码错误');
  }
  failures.delete(ip);
  const token = crypto.randomUUID();
  const ttl = Number(config.session_ttl_hours || 12) * 3600 * 1000;
  const expiresAt = Date.now() + ttl;
  run('INSERT INTO sessions (token, username, expires_at, created_at) VALUES (?,?,?,?)', [token, username, expiresAt, nowIso()]);
  res.setHeader('Set-Cookie', cookieHeader(token, ttl, isTls(req)));
  return ok(res, { token, username, expires_at: expiresAt });
}

export function logout(req, res) {
  const token = readToken(req);
  if (token) run('DELETE FROM sessions WHERE token=?', [token]);
  res.setHeader('Set-Cookie', cookieHeader('', 0, isTls(req)));
  return ok(res, true);
}

export function requireSession(req, res, next) {
  const token = readToken(req);
  if (!token) return unauthorized(res, '未登录');
  const session = get('SELECT * FROM sessions WHERE token=?', [token]);
  if (!session || Number(session.expires_at) < Date.now()) {
    return unauthorized(res, '登录已过期，请重新登录');
  }
  req.session = session;
  return next();
}

export function whoami(req, res) {
  return ok(res, { username: req.session.username, expires_at: Number(req.session.expires_at) });
}
