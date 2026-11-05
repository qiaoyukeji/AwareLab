// 会话域：登录 / 登出 / 我是谁 / 会话清单 / 全部注销 / 改口令。
// 判定逻辑（口令比对、爆破锁定、令牌读取、Cookie 属性、白名单）全在 security/session.js，这里只挂路由。
// 口令与完整令牌不进任何响应、审计 detail 或日志。
import express from 'express';
import {
  login,
  logout,
  whoami,
  requireSession,
  listSessions,
  revokeAllSessions,
  changePassword,
} from '../security/session.js';

export const sessionApi = express.Router();

/**
 * POST /auth/login：校验口令并签发会话（判定全在 security/session.js）。口令错回统一的
 * 「账号或密码错误」，不区分哪个字段错。失败按来源 IP 计数落 login_failures，重启不清零，
 * 10 分钟窗口内攒满 8 次直接 429 且不再比对口令（窗口非滑动）；allow_ips 非空时名单外来源直接 404。
 */
sessionApi.post('/auth/login', login);
/** POST /auth/logout：结束当前会话（幂等），按令牌删 sessions 行并清 Cookie，没带令牌也回 true。 */
sessionApi.post('/auth/logout', logout);
/** GET /auth/me：应用壳启动时探活；没令牌或过期由 requireSession 回 401，前端拦截器弹登录浮层。 */
sessionApi.get('/auth/me', requireSession, whoami);

/**
 * GET /auth/sessions：会话清单，谁在什么时候从哪台机器登录、什么时候到期。
 * 每条只给令牌前 6 位（token_hint），完整令牌不出接口；过期会话照实列 expired=true，读接口不写库。
 * ip/user_agent 对 v5 迁移前的老会话为 null（迁移只加列不回填）。
 */
sessionApi.get('/auth/sessions', requireSession, listSessions);

/** POST /auth/sessions/revoke-all：退出所有会话（含调用者自己），清空 sessions + 一条 session.revoke_all 审计。 */
sessionApi.post('/auth/sessions/revoke-all', requireSession, revokeAllSessions);

/**
 * POST /auth/password：改后台口令。current_password 比对不过回 401（不累加爆破计数，调用者已有会话）；
 * new_password 8~64 位且不得与当前相同。写回 config.yaml 的 panel.password（只换那一行）→ 内存同步生效 →
 * 清空全部会话 → panel.password_change 审计（新旧口令都不落库）。前端拿到后必须重新登录。
 */
sessionApi.post('/auth/password', requireSession, changePassword);
