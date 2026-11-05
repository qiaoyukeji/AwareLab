// 管理面挂载表：把各业务域子路由拼成 apiRoot，交给 adminPlane 挂在 /{随机路径}/api 下。
// 顺序即权限边界：sessionApi 必须在 requireSession 之前（登录不能要求会话），之后每个域都默认带会话；
// 新加域一律挂到 requireSession 之后，兜底 404 必须是最后一个 use。
import express from 'express';
import { requireSession } from '../security/session.js';
import { notFound } from '../platform/net/envelope.js';
import { sessionApi } from './sessionApi.js';
import { mandateApi } from './mandateApi.js';
import { pageApi } from './pageApi.js';
import { lessonApi } from './lessonApi.js';
import { siteApi } from './siteApi.js';
import { emailApi } from './emailApi.js';
import { senderApi } from './senderApi.js';
import { campaignApi } from './campaignApi.js';
import { evidenceApi } from './evidenceApi.js';
import { insightApi } from './insightApi.js';
import { platformApi } from './platformApi.js';

/** 管理面挂载表：登录三接口先挂、不带会话守卫，其余域统一过一次 requireSession。 */
export const apiRoot = express.Router();

// 唯一豁免守卫的一段：POST /auth/login、/auth/logout（登录不可能要求已登录）。
// sessionApi 其余路由各自显式挂 requireSession，所以"谁不要会话"只看这一处。
apiRoot.use(sessionApi);

// 从这里起全部要会话：守卫失败直接回 401 信封，后面的域不会被执行
apiRoot.use(requireSession);
apiRoot.use(mandateApi);
apiRoot.use(pageApi);
apiRoot.use(lessonApi);
// 钓鱼网站：建/改/开关站过授权门禁，收网（停/删）不受门禁影响
apiRoot.use(siteApi);
apiRoot.use(emailApi);
// 发信邮箱（SMTP 凭据只进不出，读取一律掩码）
apiRoot.use(senderApi);
apiRoot.use(campaignApi);
// 上钩记录、取证与导出
apiRoot.use(evidenceApi);
apiRoot.use(insightApi);
// 运行参数、通知渠道、协议文档
apiRoot.use(platformApi);

/**
 * 管理面兜底 404，必须是最后一个 use（express 按顺序匹配，前面没命中才轮到它）。
 * 没有这段，拼错的路径会漏到外壳路由返回 200+HTML，前端拦截器当成功停在空白页。
 * 不回显请求路径：路径里可能带 id、令牌片段或搜索词，404 语义已足够定位。
 */
apiRoot.use((_req, res) => notFound(res, '该接口不存在'));
