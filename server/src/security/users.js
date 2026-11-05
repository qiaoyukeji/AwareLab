/**
 * 账号域：管理员与普通用户同表（users），role 区分。只在服务端判权限，前端隐藏入口不算权限控制。
 * 规则：
 *  - 用户名 3~32 位字母数字与 _ . -，建后不可改（审计、令牌与外部对接都按用户名认人）。
 *  - 至少保留一个启用中的管理员：删最后一个管理员或把唯一管理员降级/停用都要拒绝，否则后台再也进不去。
 *  - 手机号只在管理员录入或本人绑定短信时写入；换号必须重新验证（phone_verified_at 清空），
 *    否则「已绑定」会变成一句空话——换个号不用验码也能过登录。
 */
import crypto from 'node:crypto';
import { all, get, run, nowIso } from '../platform/storage/rows.js';
import { config } from '../platform/settings.js';
import { hashPassword, verifyPassword, passwordProblem } from './password.js';

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const PHONE_PATTERN = /^1[3-9]\d{9}$/;
export const ROLES = ['admin', 'user'];
export const ROLE_LABEL = { admin: '管理员', user: '普通用户' };

/** 用户名合规性；返回中文原因或 null。 */
export function usernameProblem(raw) {
  const value = String(raw || '').trim();
  if (!USERNAME_PATTERN.test(value)) return '用户名需 3~32 位，仅限字母、数字、下划线、点与短横线';
  return null;
}

/** 手机号合规性（中国大陆 11 位）；返回中文原因或 null。 */
export function phoneProblem(raw) {
  const value = String(raw || '').trim();
  if (!PHONE_PATTERN.test(value)) return '手机号需为 11 位中国大陆号码';
  return null;
}

export function findByUsername(username) {
  return get('SELECT * FROM users WHERE lower(username)=lower(?)', [String(username || '').trim()]);
}

export function findById(id) {
  return get('SELECT * FROM users WHERE id=?', [id]);
}

export function listUsers() {
  return all('SELECT * FROM users ORDER BY role ASC, created_at ASC');
}

/** 对外视图：绝不带 password_hash；手机号对管理员也打码到 138****8000，真要改号就整号重填。 */
export function toUserView(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name || '',
    role: row.role,
    status: row.status,
    phone: maskPhone(row.phone),
    phone_verified: Boolean(row.phone_verified_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at || null,
  };
}

/** 138****8000：列表要能核对是谁，又不能整号外泄。 */
export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return phone ? '已设置' : '';
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

/** 建号；用户名重复回 409 语义由调用方处理，这里返回 { error } 或 { user }。 */
export function createUser({ username, password, role = 'user', phone = '', display_name = '' } = {}) {
  const nameProblem = usernameProblem(username);
  if (nameProblem) return { error: nameProblem };
  if (findByUsername(username)) return { error: '用户名已存在' };
  if (!ROLES.includes(role)) return { error: '角色只能是管理员或普通用户' };
  const pwdProblem = passwordProblem(password);
  if (pwdProblem) return { error: pwdProblem };
  const cleanPhone = String(phone || '').trim();
  if (cleanPhone) {
    const phoneErr = phoneProblem(cleanPhone);
    if (phoneErr) return { error: phoneErr };
  }
  const now = nowIso();
  const row = {
    id: crypto.randomUUID(),
    username: String(username).trim(),
    display_name: String(display_name || '').trim().slice(0, 40),
    password_hash: hashPassword(password),
    role,
    status: 'active',
    phone: cleanPhone || null,
    // 管理员代填的号码尚未经短信验证：标记为空，等本人首次登录走绑定流程验一次
    phone_verified_at: null,
    created_at: now,
    updated_at: now,
    last_login_at: null,
  };
  run(
    `INSERT INTO users (id, username, display_name, password_hash, role, status, phone, phone_verified_at, created_at, updated_at, last_login_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id, row.username, row.display_name, row.password_hash, row.role, row.status,
      row.phone, row.phone_verified_at, row.created_at, row.updated_at, row.last_login_at,
    ]
  );
  return { user: findById(row.id) };
}

/** 启用中的管理员数量，用于「最后一个管理员」保护。 */
function activeAdminCount() {
  const row = get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'");
  return Number(row?.n || 0);
}

/**
 * 改账号：display_name / role / status / phone 四个字段，密码走 resetPassword。
 * 降级、停用最后一个启用管理员一律拒绝；自己停用自己同样拒绝（否则当前会话下次校验就掉线）。
 */
export function updateUser(id, patch, actorId) {
  const row = findById(id);
  if (!row) return { error: '账号不存在' };
  const next = { ...row };
  if (patch.display_name !== undefined) next.display_name = String(patch.display_name || '').trim().slice(0, 40);
  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role)) return { error: '角色只能是管理员或普通用户' };
    next.role = patch.role;
  }
  if (patch.status !== undefined) {
    if (!['active', 'disabled'].includes(patch.status)) return { error: '状态只能是启用或停用' };
    next.status = patch.status;
  }
  if (patch.phone !== undefined) {
    const cleanPhone = String(patch.phone || '').trim();
    if (cleanPhone) {
      const phoneErr = phoneProblem(cleanPhone);
      if (phoneErr) return { error: phoneErr };
    }
    // 换号或清号都清零验证标记；同号重填不清，否则管理员改个昵称就把已验证的号打回未验证
    if ((cleanPhone || null) !== (row.phone || null)) {
      next.phone = cleanPhone || null;
      next.phone_verified_at = null;
    }
  }
  const losingAdmin = row.role === 'admin' && (next.role !== 'admin' || next.status !== 'active');
  if (losingAdmin && activeAdminCount() <= 1) return { error: '至少要保留一个启用中的管理员账号' };
  if (id === actorId && next.status !== 'active') return { error: '不能停用当前登录的账号' };
  next.updated_at = nowIso();
  run(
    'UPDATE users SET display_name=?, role=?, status=?, phone=?, phone_verified_at=?, updated_at=? WHERE id=?',
    [next.display_name, next.role, next.status, next.phone, next.phone_verified_at, next.updated_at, id]
  );
  return { user: findById(id) };
}

/** 重置口令：只改哈希，不动会话（旧会话仍有效是既有口径，怀疑泄露时用「退出所有会话」）。 */
export function resetPassword(id, password) {
  const row = findById(id);
  if (!row) return { error: '账号不存在' };
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  run('UPDATE users SET password_hash=?, updated_at=? WHERE id=?', [hashPassword(password), nowIso(), id]);
  return { user: findById(id) };
}

/** 删除账号：不能删自己，不能删最后一个启用管理员；其历史会话一并清掉。 */
export function deleteUser(id, actorId) {
  const row = findById(id);
  if (!row) return { error: '账号不存在' };
  if (id === actorId) return { error: '不能删除当前登录的账号' };
  if (row.role === 'admin' && row.status === 'active' && activeAdminCount() <= 1) {
    return { error: '至少要保留一个启用中的管理员账号' };
  }
  run('DELETE FROM sessions WHERE user_id=?', [id]);
  run('DELETE FROM users WHERE id=?', [id]);
  return { user: row };
}

/**
 * 校验账密：成功回 { user }，失败回 { error }（调用方统一 401，不区分账号不存在与口令错）。
 * 停用账号单独回 { disabled: true }：这是管理员主动处置，明说比让用户以为记错口令好。
 */
export function checkCredentials(username, password) {
  const row = findByUsername(username);
  if (!row || !verifyPassword(password, row.password_hash)) return { error: '账号或密码错误' };
  if (row.status !== 'active') return { disabled: true, error: '账号已停用，请联系管理员' };
  return { user: row };
}

export function touchLogin(id) {
  run('UPDATE users SET last_login_at=? WHERE id=?', [nowIso(), id]);
}

/** 绑定/换绑手机号：只有短信验证通过后才调用，写号同时写验证时间。 */
export function bindVerifiedPhone(id, phone) {
  const now = nowIso();
  run('UPDATE users SET phone=?, phone_verified_at=?, updated_at=? WHERE id=?', [phone, now, now, id]);
  return findById(id);
}

/**
 * 首次启动种子管理员：users 表为空时，用 config.yaml 里的随机账号口令建一个管理员。
 * 老库升级上来（users 为空）也走这条，操作员原来的账号口令继续可用，不需要重新记一套。
 * 已有管理员则不动：避免每次重启把操作员改过的口令又覆盖回 config 里的旧值。
 */
export function ensureAdminUser() {
  const existing = get("SELECT COUNT(*) AS n FROM users WHERE role='admin'");
  if (Number(existing?.n || 0) > 0) return null;
  const username = config.panel.username;
  const password = config.panel.password;
  const created = createUser({ username, password, role: 'admin', display_name: '超级管理员' });
  return created.user || null;
}

/** 管理员改口令时同步 users 行（config 里的口令另由 session.changePassword 写，供部署者查档）。 */
export function syncAdminPassword(username, password) {
  const row = findByUsername(username);
  if (!row) return false;
  run('UPDATE users SET password_hash=?, updated_at=? WHERE id=?', [hashPassword(password), nowIso(), row.id]);
  return true;
}
