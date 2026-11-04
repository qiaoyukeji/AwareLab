import express from 'express';
import { requireSession } from '../security/session.js';
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

/**
 * 管理面挂载表。
 * 登录三接口先挂、不带会话守卫，其余域统一过一次 requireSession，
 * 新接一个域只需要在这里多挂一个 router。
 */
export const apiRoot = express.Router();

apiRoot.use(sessionApi);
apiRoot.use(requireSession);
apiRoot.use(mandateApi);
apiRoot.use(pageApi);
apiRoot.use(lessonApi);
apiRoot.use(siteApi);
apiRoot.use(emailApi);
apiRoot.use(senderApi);
apiRoot.use(campaignApi);
apiRoot.use(evidenceApi);
apiRoot.use(insightApi);
apiRoot.use(platformApi);
