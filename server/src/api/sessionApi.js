// 会话域：登录 / 短信验证码 / 登出 / 我是谁 / 会话清单 / 全部注销 / 改口令。
// 判定逻辑（口令比对、短信验码、爆破锁定、令牌读取、Cookie 属性、白名单、角色）全在 security/session.js，这里只挂路由。
// 口令、验证码与完整令牌不进任何响应、审计 detail 或日志。
import express from 'express';
import {
  login,
  logout,
  whoami,
  requireSession,
  requireAdmin,
  listSessions,
  revokeAllSessions,
  changePassword,
  sendSmsCode,
  verifySmsLogin,
} from '../security/session.js';

export const sessionApi = express.Router();

/**
 * POST /auth/login：第一步，校验账号口令。口令错回统一的「账号或密码错误」，不区分哪个字段错。
 * 失败按来源 IP 计数落 login_failures，10 分钟窗口内攒满 8 次直接 429 且不再比对口令（窗口非滑动）。
 * 开启短信认证后，普通用户回 `{sms_required:true, purpose, ticket, phone_masked}`，进入第二步验码；管理员直接发会话。
 */
sessionApi.post('/auth/login', login);

/**
 * POST /auth/sms/send：第二步发码。body {ticket, phone?}，ticket 来自第一步响应的短期票据（10 分钟）。
 * 普通用户未绑号时 purpose=bind，必须带 phone 且格式合法；已绑号时只认票据里的号。
 * 频控：同号 60 秒、同号 5 次/小时、同 IP 20 次/小时；阿里云失败原样回 400 中文原因。
 */
sessionApi.post('/auth/sms/send', sendSmsCode);

/** POST /auth/sms/verify：第二步验码。body {ticket, code, phone?}；PASS 后 bind 票据先落号绑定再签发会话。 */
sessionApi.post('/auth/sms/verify', verifySmsLogin);

/** POST /auth/logout：结束当前会话（幂等），按令牌删 sessions 行并清 Cookie，没带令牌也回 true。 */
sessionApi.post('/auth/logout', logout);
/** GET /auth/me：应用壳启动时探活；没令牌或过期由 requireSession 回 401，前端拦截器弹登录浮层。 */
sessionApi.get('/auth/me', requireSession, whoami);

/**
 * GET /auth/sessions：会话清单，谁在什么时候从哪台机器登录、什么时候到期。
 * 每条只给令牌前 6 位（token_hint），完整令牌不出接口；过期会话照实列 expired=true，读接口不写库。
 * 会话清单包含所有账号，只给管理员看；普通用户看自己的登录态没有运维意义，徒增越权面。
 */
sessionApi.get('/auth/sessions', requireSession, requireAdmin, listSessions);

/** POST /auth/sessions/revoke-all：退出所有会话（含调用者自己），清空 sessions + 一条 session.revoke_all 审计。管理员专属。 */
sessionApi.post('/auth/sessions/revoke-all', requireSession, requireAdmin, revokeAllSessions);

/**
 * POST /auth/password：改自己的口令。current_password 比对不过回 401（不累加爆破计数，调用者已有会话）；
 * new_password 8~64 位且不得与当前相同。管理员同步写 config.yaml 的 panel.password → 清空全部会话 →
 * panel.password_change 审计（新旧口令都不落库）。前端拿到后必须重新登录。
 */
sessionApi.post('/auth/password', requireSession, changePassword);
