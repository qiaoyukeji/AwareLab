// 账号域：管理员维护普通用户（管理员账号只能由启动种子产生，界面不提供互相提权）。
// 判定逻辑（用户名/手机号格式、口令哈希、最后一个管理员保护）全在 security/users.js，这里只挂路由并写审计。
// 任何响应都不回 password_hash；手机号一律掩码回传。
import express from 'express';
import { ok, badRequest, notFound } from '../platform/net/envelope.js';
import { requireAdmin } from '../security/session.js';
import { writeAudit } from '../security/audit.js';
import {
  listUsers,
  createUser,
  updateUser,
  resetPassword,
  deleteUser,
  findById,
  toUserView,
  usernameProblem,
  phoneProblem,
} from '../security/users.js';
import { passwordProblem } from '../security/password.js';

export const userApi = express.Router();

/** GET /users：账号清单（不含哈希，手机号掩码），附带管理员数量与短信开关状态供页面提示。 */
userApi.get('/users', requireAdmin, (_req, res) => {
  const rows = listUsers();
  ok(res, {
    items: rows.map(toUserView),
    total: rows.length,
    admins: rows.filter((row) => row.role === 'admin' && row.status === 'active').length,
  });
});

/** POST /users：管理员创建普通用户。role 只允许 user（管理员请走启动种子，避免界面互相提权）。 */
userApi.post('/users', requireAdmin, (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const problem = usernameProblem(username);
  if (problem) return badRequest(res, problem);
  if (String(b.role || 'user') !== 'user') return badRequest(res, '只能创建普通用户账号');
  const phone = String(b.phone || '').trim();
  const phoneIssue = phone ? phoneProblem(phone) : null;
  if (phoneIssue) return badRequest(res, phoneIssue);
  const pwdIssue = passwordProblem(String(b.password || ''));
  if (pwdIssue) return badRequest(res, pwdIssue);
  try {
    const created = createUser({
      username,
      password: String(b.password),
      role: 'user',
      phone,
      display_name: String(b.display_name || '').trim(),
    });
    if (created.error) return badRequest(res, created.error);
    const user = created.user;
    writeAudit(req, 'user.create', {
      targetKind: 'user',
      targetId: user.id,
      detail: { username: user.username, phone: user.phone ? 'set' : '' },
    });
    return ok(res, toUserView(user));
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) return badRequest(res, '用户名已存在');
    throw error;
  }
});

/** PUT /users/:id：改显示名 / 手机号 / 状态。role 不在可改字段里，界面也就没有提权入口。 */
userApi.put('/users/:id', requireAdmin, (req, res) => {
  const target = findById(req.params.id);
  if (!target) return notFound(res, '账号不存在');
  const b = req.body || {};
  const patch = {};
  if (b.display_name !== undefined) patch.display_name = String(b.display_name || '').trim();
  if (b.status !== undefined) {
    if (!['active', 'disabled'].includes(b.status)) return badRequest(res, '状态只能是启用或停用');
    patch.status = b.status;
  }
  if (b.phone !== undefined) {
    const phone = String(b.phone || '').trim();
    const issue = phone ? phoneProblem(phone) : null;
    if (issue) return badRequest(res, issue);
    patch.phone = phone;
  }
  try {
    const result = updateUser(target.id, patch, req.user.id);
    if (result.error) return badRequest(res, result.error);
    const user = result.user;
    writeAudit(req, 'user.update', {
      targetKind: 'user',
      targetId: user.id,
      detail: { fields: Object.keys(patch), status: user.status },
    });
    return ok(res, toUserView(user));
  } catch (error) {
    return badRequest(res, error.message);
  }
});

/** POST /users/:id/password：管理员重置普通用户口令（不要求旧口令），重置后清掉该用户全部会话。 */
userApi.post('/users/:id/password', requireAdmin, (req, res) => {
  const target = findById(req.params.id);
  if (!target) return notFound(res, '账号不存在');
  if (target.role === 'admin') return badRequest(res, '管理员口令请在「账号安全」里自行修改');
  const issue = passwordProblem(String(req.body?.password || ''));
  if (issue) return badRequest(res, issue);
  const result = resetPassword(target.id, String(req.body.password));
  if (result.error) return badRequest(res, result.error);
  writeAudit(req, 'user.password_reset', { targetKind: 'user', targetId: target.id, detail: { username: target.username } });
  ok(res, true);
});

/** DELETE /users/:id：删普通用户，连带清其会话；不能删自己、不能删管理员。 */
userApi.delete('/users/:id', requireAdmin, (req, res) => {
  const target = findById(req.params.id);
  if (!target) return notFound(res, '账号不存在');
  if (target.id === req.user.id) return badRequest(res, '不能删除当前登录的账号');
  if (target.role === 'admin') return badRequest(res, '管理员账号不能删除');
  const result = deleteUser(target.id, req.user.id);
  if (result.error) return badRequest(res, result.error);
  writeAudit(req, 'user.delete', { targetKind: 'user', targetId: target.id, detail: { username: target.username } });
  ok(res, true);
});
