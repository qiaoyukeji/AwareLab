import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../platform/settings.js';
import { clientIp } from '../platform/net/clientIp.js';
import { get, run, nowIso } from '../platform/storage/rows.js';
import { fail, tooManyRequests } from '../platform/net/envelope.js';
import { effectiveStatus, findById, findActive, isHostAuthorized } from '../security/mandate.js';
import { renderNoticePage } from '../capture/pageCompiler.js';
import { collectableFields } from '../capture/diagnostics.js';
import { logEvent, recordAttachmentRun, recordMailClick, recordMailOpen, resolveToken } from '../capture/evidenceStore.js';
import { ENGAGE_BASE } from '../capture/engageScript.js';

const PIXEL = 'pixel';
const TRACE = 'trace';
const CALLBACK = 'callback';

/** 回传面公开无鉴权，文件与频率的闸门只能在这一层设 */
const LIMITS = {
  max_file_mb: 5,
  max_files_per_request: 3,
  max_fields: 40,
  per_token_per_minute: 10,
  per_ip_per_minute: 200,
  screenshot_quota_mb: 512,
  ...(config.capture.callback || {}),
};

const MAX_FILE_BYTES = LIMITS.max_file_mb * 1024 * 1024;
const MAX_FIELD_NAME = 64;
const MAX_FIELD_VALUE = 4096;
const QUOTA_BYTES = LIMITS.screenshot_quota_mb * 1024 * 1024;

/** 按演练协议收表单：单文件 5MB、单次 3 个文件、40 个字段，越界的连解析都不做 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: LIMITS.max_files_per_request, fields: LIMITS.max_fields, fieldSize: 64 * 1024 },
});

const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * 允许落盘的证据形态：截图与办公文档，认文件头不认自称的 MIME。
 * 白名单之外一律不收——回传面一旦能存任意字节，平台就成了别人手里的文件落地点。
 */
const EVIDENCE_KINDS = [
  { kind: 'png', exts: ['png'], test: (b) => b.length > 8 && b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' },
  { kind: 'jpeg', exts: ['jpg', 'jpeg'], test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'pdf', exts: ['pdf'], test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { kind: 'zip', exts: ['zip'], test: (b) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 },
];

const FIELD_NAME = /^[\p{L}\p{N}_.-]{1,64}$/u;

/** multipart 的同名字段合并成数组，与页面采集的映射口径保持一致；越界字段丢弃并回传给调用方记事件 */
function fieldMap(body, declared) {
  const fields = {};
  const dropped = [];
  for (const [rawName, rawValue] of Object.entries(body || {})) {
    const name = String(rawName);
    if (name === 'tk' || name === 'mail') continue;
    if (Object.keys(fields).length >= LIMITS.max_fields) {
      dropped.push(`${name.slice(0, 24)}（超过 ${LIMITS.max_fields} 个字段）`);
      continue;
    }
    if (name.length > MAX_FIELD_NAME || !FIELD_NAME.test(name)) {
      dropped.push(`${name.slice(0, 24)}（字段名不合规）`);
      continue;
    }
    // 令牌绑定了站点时，白名单就是这张模板自己声明的输入名：载荷乱报字段说明它已经不是这套表单
    if (declared && !declared.has(name)) {
      dropped.push(`${name}（模板未声明）`);
      continue;
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    fields[name] =
      values.length === 1 ? String(values[0]).slice(0, MAX_FIELD_VALUE) : values.map((v) => String(v).slice(0, MAX_FIELD_VALUE));
  }
  return { fields, dropped };
}

/** 站点模板声明的可采集字段名；令牌没有站点归属时返回 null，只做形状限制 */
function declaredFieldSet(visitor) {
  if (!visitor?.site_id) return null;
  const site = get('SELECT template_id FROM web_sites WHERE id=?', [visitor.site_id]);
  const template = site?.template_id ? get('SELECT html FROM web_templates WHERE id=?', [site.template_id]) : null;
  return template ? new Set(collectableFields(template.html)) : null;
}

/**
 * 演练还开着吗：任务与站点都记着当初的授权，窗口一关这条公开写入通道就得闭上。
 * 查不到授权归属时放行——历史任务确有未绑定授权的，宁可收下证据也不要弄丢它。
 */
function authorizationStatus({ taskId, visitor }) {
  const authId =
    (taskId && get('SELECT authorization_id FROM mail_tasks WHERE id=?', [taskId])?.authorization_id) ||
    (visitor?.site_id && get('SELECT authorization_id FROM web_sites WHERE id=?', [visitor.site_id])?.authorization_id) ||
    (visitor?.task_id && get('SELECT authorization_id FROM mail_tasks WHERE id=?', [visitor.task_id])?.authorization_id) ||
    null;
  if (!authId) return null;
  return effectiveStatus(findById(authId));
}

// 速率按令牌与来源地址双维度：转发出去的邮件令牌不该长期有效到能拿来刷库
const RATE_WINDOW_MS = 60_000;
const rateHits = new Map();

function rateAllowed(key, limit) {
  const now = Date.now();
  const bucket = rateHits.get(key);
  if (!bucket || now - bucket.since > RATE_WINDOW_MS) {
    rateHits.set(key, { since: now, hits: 1 });
    if (rateHits.size > 2000) {
      for (const [k, v] of rateHits) if (now - v.since > RATE_WINDOW_MS) rateHits.delete(k);
    }
    return true;
  }
  bucket.hits += 1;
  return bucket.hits <= limit;
}

// 落盘配额巡检：目录大小 30 秒量一次，不为每个请求重扫磁盘
let quota = { at: 0, bytes: 0 };

function usedQuotaBytes() {
  const now = Date.now();
  if (now - quota.at > 30_000) {
    let bytes = 0;
    try {
      for (const name of fs.readdirSync(config.paths.screenshots)) {
        try {
          bytes += fs.statSync(path.join(config.paths.screenshots, name)).size;
        } catch {
          /* 巡检途中文件被清理，跳过 */
        }
      }
    } catch {
      return 0;
    }
    quota = { at: now, bytes };
  }
  return quota.bytes;
}

/** 收下证据文件：文件头与扩展名都要自洽，且落盘前必须有配额余量；不合格返回 null */
function saveEvidence(file) {
  if (!file) return null;
  const kind = EVIDENCE_KINDS.find((k) => k.test(file.buffer));
  if (!kind) return null;
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  if (ext && !kind.exts.includes(ext)) return null;
  if (usedQuotaBytes() + file.size > QUOTA_BYTES) return null;
  const target = path.join(config.paths.screenshots, `${crypto.randomUUID()}.${kind.exts[0]}`);
  fs.writeFileSync(target, file.buffer);
  quota.bytes += file.size;
  return target;
}

/** 被拒的回传也要在事件里留痕：演练现场要靠它判断是载荷写错了还是有人在打平台 */
function rejectCallback(req, res, status, message, reason) {
  logEvent('callback_rejected', {
    token: String(req.query.tk || '') || null,
    ip: clientIp(req),
    user_agent: req.headers['user-agent'] || '',
    payload: { reason },
  });
  return fail(res, status, message);
}

/**
 * 信标面：公开、无鉴权，只接受令牌换证。
 * 任何一条信标都不返回业务数据，最坏情况只是记多一条事件。
 */
export function mountBeaconPlane(app) {
  const router = express.Router();

  /** 部署自检：从外部访问得到 ok 就说明信标面可达，邮件里的像素才有意义 */
  router.get('/alab/health', (_req, res) => res.type('text/plain').send('ok'));

  /** 邮件打开像素 */
  router.get(`${ENGAGE_BASE}/${PIXEL}`, (req, res) => {
    const token = req.query.tk;
    if (token) recordMailOpen({ taskId: req.query.task, token, ip: clientIp(req), userAgent: req.headers['user-agent'] || '' });
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': GIF_1X1.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(GIF_1X1);
  });

  /**
   * 邮件链接点击：先记账再放行。
   * 放行目标必须是当前授权白名单内的主机，否则信标面就退化成公共跳板。
   */
  router.get(`${ENGAGE_BASE}/${TRACE}`, (req, res) => {
    const token = req.query.tk;
    const target = req.query.url;
    const ip = clientIp(req);
    const userAgent = req.headers['user-agent'] || '';
    if (token) {
      const visitor = resolveToken(token);
      const taskId = visitor?.task_id ?? null;
      recordMailOpen({ taskId, token, ip, userAgent });
      recordMailClick({ taskId, token, ip, userAgent, url: target });
    }
    if (typeof target === 'string' && /^https?:\/\//i.test(target)) {
      const auth = findActive();
      const host = new URL(target).host;
      if (auth && isHostAuthorized(auth, host)) return res.redirect(target);
      return res.type('html').send(renderNoticePage('链接已失效', '该跳转目标不在本次演练的授权范围内。'));
    }
    res.type('html').send(renderNoticePage('已打开', '链接已在新窗口打开。'));
  });

  /**
   * 附件运行回调：POST /alab/v2/callback?tk=&mail=
   * 只接受"令牌属于本次演练、字段合规、文件是证据形态"的回传；
   * 其余丢弃并记事件，速率超限直接 429——转发出去的邮件令牌不该成为长期写入凭证。
   */
  router.post(
    `${ENGAGE_BASE}/${CALLBACK}`,
    (req, res, next) => {
      if (!rateAllowed(`t:${String(req.query.tk || 'anonymous')}`, LIMITS.per_token_per_minute)) {
        return tooManyRequests(res, `同一令牌每分钟最多回传 ${LIMITS.per_token_per_minute} 次`);
      }
      if (!rateAllowed(`i:${clientIp(req)}`, LIMITS.per_ip_per_minute)) {
        return tooManyRequests(res, `同一来源地址每分钟最多回传 ${LIMITS.per_ip_per_minute} 次`);
      }
      return next();
    },
    (req, res, next) => {
      upload.any()(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
          return rejectCallback(req, res, 413, `单个回传文件不得超过 ${LIMITS.max_file_mb}MB`, err.code);
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_FIELD_COUNT') {
          return rejectCallback(
            req,
            res,
            413,
            `单次回传不得超过 ${LIMITS.max_files_per_request} 个文件、${LIMITS.max_fields} 个字段`,
            err.code
          );
        }
        return rejectCallback(req, res, 400, '回传请求不是合法的 multipart 表单', err.code || 'bad_multipart');
      });
    },
    (req, res) => {
      const rawToken = String(req.query.tk || req.body?.tk || '');
      const mail = String(req.query.mail || req.body?.mail || '');
      const ip = clientIp(req);
      const userAgent = req.headers['user-agent'] || '';

      const recipient = get('SELECT * FROM mail_recipients WHERE token=?', [rawToken]);
      const taskById = get('SELECT * FROM mail_tasks WHERE id=?', [rawToken]);
      const visitor = resolveToken(rawToken);
      if (!recipient && !taskById && !visitor) {
        return rejectCallback(req, res, 400, '回传令牌不属于本次演练', 'unknown_token');
      }

      let taskId = recipient?.task_id ?? (taskById ? taskById.id : null);
      let token = rawToken;
      if (taskById && !recipient) {
        // 载荷只带得动任务 ID 时，用回信邮箱把收件人对出来
        const byMail = get('SELECT * FROM mail_recipients WHERE task_id=? AND email=?', [taskId, mail]);
        if (byMail) token = byMail.token;
      }
      const holder = resolveToken(token) || visitor;

      const status = authorizationStatus({ taskId, visitor: holder });
      if (status && status !== 'active') {
        return rejectCallback(req, res, 410, '本次演练授权已不在有效期内，回传通道已关闭', `authorization_${status}`);
      }

      const { fields, dropped } = fieldMap(req.body, declaredFieldSet(holder));
      if (dropped.length) {
        logEvent('callback_fields_dropped', { token, ip, user_agent: userAgent, payload: { dropped } });
      }

      let screenshotPath = null;
      const rejectedFiles = [];
      for (const file of req.files || []) {
        if (file.fieldname !== 'capture') {
          rejectedFiles.push(`${file.originalname || '未命名'}：只收 capture 字段，字段 ${file.fieldname} 不放文件`);
          continue;
        }
        const saved = saveEvidence(file);
        if (!saved) {
          rejectedFiles.push(`${file.originalname || '未命名'}：文件头不在证据类型内、扩展名与内容不符或落盘配额已满`);
          continue;
        }
        screenshotPath = screenshotPath || saved;
      }
      if (rejectedFiles.length) {
        logEvent('callback_files_dropped', { token, ip, user_agent: userAgent, payload: { rejected: rejectedFiles } });
      }
      if (usedQuotaBytes() > QUOTA_BYTES) {
        console.warn(
          `[beacon] 截图落盘已用 ${Math.round((usedQuotaBytes() / 1048576) * 10) / 10}MB / ${LIMITS.screenshot_quota_mb}MB 配额，新截图暂不保存，请清理 data/screenshots`
        );
      }

      const { record } = recordAttachmentRun({
        taskId,
        token,
        mail,
        fields,
        screenshotPath,
        ip,
        userAgent,
      });
      if (taskId && token) {
        run('UPDATE mail_recipients SET submitted_at=? WHERE task_id=? AND token=?', [nowIso(), taskId, token]);
      }
      res.json({
        code: 0,
        data: { accepted: true, id: record.id, dropped_fields: dropped.length, rejected_files: rejectedFiles.length },
      });
    }
  );

  app.use(router);
}
