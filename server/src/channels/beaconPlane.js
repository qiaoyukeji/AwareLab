/**
 * 信标面：邮件与载荷这一侧的公开入口，/alab/health 与 /alab/v2/pixel|trace|callback。
 * 挂在与管理面同一个应用和端口上；访客上报 /alab/v2/engage|lesson 在各仿冒站点自己的监听那里。
 * 本层公开无鉴权，唯一凭据是 ?tk=，文件、字段、频率、落盘配额四类闸门都压在这里；速率表在进程内存里，重启清零。
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../platform/settings.js';
import { clientIp } from '../platform/net/clientIp.js';
import { get, run, nowIso } from '../platform/storage/rows.js';
import { fail, tooManyRequests } from '../platform/net/envelope.js';
import { effectiveStatus, findById } from '../security/mandate.js';
import { collectableFields } from '../capture/diagnostics.js';
import { logEvent, recordAttachmentRun, resolveToken } from '../capture/evidenceStore.js';
import { ENGAGE_BASE } from '../capture/engageScript.js';
import { servePixel, serveTrace } from '../capture/trackEndpoints.js';
import { rateAllowed } from '../capture/rateGate.js';

// 拼在冻结的 ENGAGE_BASE 后面；端点集合由协议文档锁定，改名等于毁掉已经发出去的邮件
const PIXEL = 'pixel';
const TRACE = 'trace';
const CALLBACK = 'callback';

/** 阈值来自 config.capture.callback，可被 config.yaml 覆盖，提示文案直接引用这些数字。screenshot_quota_mb 是整个目录的总量上限，不是单次请求的上限。 */
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
// 字段名最长 64 字符，与运行时 collect() 采到的输入名同量级，超长的当成载荷载体
const MAX_FIELD_NAME = 64;
// 字段值截到 4096 字符：采集点该装账号、口令、验证码，不是整篇文档
const MAX_FIELD_VALUE = 4096;
// 落盘总配额按目录已用字节算，打满就只记事件不再存文件
const QUOTA_BYTES = LIMITS.screenshot_quota_mb * 1024 * 1024;

/** 按演练协议收表单：单文件 5MB、单次 3 个文件、40 个字段，越界的连解析都不做 */
const upload = multer({
  storage: multer.memoryStorage(),
  // 分段头不带 charset，busboy 默认按 latin1 解码，中文名会解成一串下划线；显式声明 utf8 后留下的才是访客真正写下的名字
  defParamCharset: 'utf8',
  // 单个字段值 64KB，超限由 multer 直接抛错，不进业务代码
  limits: { fileSize: MAX_FILE_BYTES, files: LIMITS.max_files_per_request, fields: LIMITS.max_fields, fieldSize: 64 * 1024 },
});

// 打开像素响应（1x1 GIF、no-store）在 capture/trackEndpoints.js 里，站点端口与管理端口共用同一份

/** 允许落盘的证据形态，认文件头不认自称的 MIME。白名单外一律不收，否则这个入口就成了别人手里的文件落地点。 */
const EVIDENCE_KINDS = [
  // PNG：载荷截图的主力形态，签名固定 8 字节
  { kind: 'png', exts: ['png'], test: (b) => b.length > 8 && b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' },
  // JPEG：只认前两字节会放过任意 0xFFD8 开头的东西，第三字节也得是 0xFF
  { kind: 'jpeg', exts: ['jpg', 'jpeg'], test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'pdf', exts: ['pdf'], test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  // docx/xlsx 虽是 zip 容器但没列进扩展名表：这里收的是演练证据，宁可少收也别变成通用落地能力
  { kind: 'zip', exts: ['zip'], test: (b) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 },
];

// \p{L} 让中文命名的输入框原样收进字段名；白名单式字符集同时挡掉 < > " ' 与换行，字段名会进取证页和导出
const FIELD_NAME = /^[\p{L}\p{N}_.-]{1,64}$/u;

/** 把 multipart 请求体收敛成采集字段映射，declared 是模板声明的可采集字段名集合或 null；dropped 由调用方落成事件，现场靠它判断是载荷写错了还是在打平台。 */
function fieldMap(body, declared) {
  const fields = {};
  const dropped = [];
  for (const [rawName, rawValue] of Object.entries(body || {})) {
    const name = String(rawName);
    // tk 和 mail 是归属信息，落在 URL 与 records 的专用列里，不进 fields，否则同一个邮箱在两处漂移
    if (name === 'tk' || name === 'mail') continue;
    // multer 的 fields 上限拦过一次，这里再拦一次是给靠脚本堆字段的载荷留一条可解释的丢弃记录
    if (Object.keys(fields).length >= LIMITS.max_fields) {
      dropped.push(`${name.slice(0, 24)}（超过 ${LIMITS.max_fields} 个字段）`);
      continue;
    }
    if (name.length > MAX_FIELD_NAME || !FIELD_NAME.test(name)) {
      dropped.push(`${name.slice(0, 24)}（字段名不合规）`);
      continue;
    }
    // 白名单就是这张模板声明的输入名：乱报字段说明载荷已经不是这套表单
    if (declared && !declared.has(name)) {
      dropped.push(`${name}（模板未声明）`);
      continue;
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    // 单值给字符串、多值给数组，与运行时 collect() 的形状一致，否则证据页对同一字段名会看到两种类型
    fields[name] =
      values.length === 1 ? String(values[0]).slice(0, MAX_FIELD_VALUE) : values.map((v) => String(v).slice(0, MAX_FIELD_VALUE));
  }
  return { fields, dropped };
}

/** 两次只读 SELECT，返回模板声明的可采集字段名集合。null 表示终端没有站点归属，调用方据此只做形状与数量限制，不能当成白名单为空拒收全部字段。 */
function declaredFieldSet(visitor) {
  if (!visitor?.site_id) return null;
  const site = get('SELECT template_id FROM web_sites WHERE id=?', [visitor.site_id]);
  const template = site?.template_id ? get('SELECT html FROM web_templates WHERE id=?', [site.template_id]) : null;
  return template ? new Set(collectableFields(template.html)) : null;
}

/** 判定这次回传所属授权的实时状态，不是 active 时调用方给 410。查不到归属返回 null 按照单收下：历史任务确有未绑定授权的，关掉通道会丢掉证据。 */
function authorizationStatus({ taskId, visitor }) {
  // 归属顺序：显式任务 → 令牌所属站点 → 令牌自带任务，取到第一个就算，别让载荷自己声明属于哪张授权
  const authId =
    (taskId && get('SELECT authorization_id FROM mail_tasks WHERE id=?', [taskId])?.authorization_id) ||
    (visitor?.site_id && get('SELECT authorization_id FROM web_sites WHERE id=?', [visitor.site_id])?.authorization_id) ||
    (visitor?.task_id && get('SELECT authorization_id FROM mail_tasks WHERE id=?', [visitor.task_id])?.authorization_id) ||
    null;
  // fail-open：这条通道本来就先过令牌与闸门，关掉只会让真实演练证据丢掉
  if (!authId) return null;
  return effectiveStatus(findById(authId));
}

// 目录大小 30 秒量一次，不为每个请求重扫磁盘
let quota = { at: 0, bytes: 0 };

/** data/screenshots 已用字节数，带时间戳缓存在模块级 quota 里，这条判定挂在每个回传请求上。目录读不到返回 0，配额统计失败不该关掉证据入口。 */
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

/**
 * 文件头与扩展名都要自洽，落盘前还要有配额余量，不合格返回 null。
 * 三种原因（文件头不在白名单、扩展名与内容不符、配额已满）由调用方写成一句中文理由落事件，不给访客回显。
 */
function saveEvidence(file) {
  if (!file) return null;
  const kind = EVIDENCE_KINDS.find((k) => k.test(file.buffer));
  if (!kind) return null;
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  // 自称 report.pdf 却带 zip 头的不收，否则证据目录会被拿成任意文件的藏身处
  if (ext && !kind.exts.includes(ext)) return null;
  if (usedQuotaBytes() + file.size > QUOTA_BYTES) return null;
  // 落盘名一律用随机 UUID 加判定出的真实扩展名：originalname 由客户端控制，可能带路径分隔符或覆盖别人的证据
  const target = path.join(config.paths.screenshots, `${crypto.randomUUID()}.${kind.exts[0]}`);
  fs.writeFileSync(target, file.buffer);
  // 立刻在缓存上补一笔：同一窗口内的连续请求都按旧值判断会把配额击穿
  quota.bytes += file.size;
  return target;
}

/** 被拒的回传也写一条 events 留痕，否则等于平台偷偷不吃数据；reason 是内部短码，不回显给载荷。 */
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
 * 公开无鉴权，只接受令牌换证，都不返回业务数据；只挂路由，不起新监听。
 * 429=同令牌或同地址超每分钟配额；413=单文件超 5MB 或超出 3 文件/40 字段；400=multipart 不合法或令牌不认识；410=授权已离开生效窗口。
 */
export function mountBeaconPlane(app) {
  const router = express.Router();

  /** 部署自检，公开无鉴权：外部拿到 ok 就说明信标面可达，邮件里的像素才有意义 */
  router.get('/alab/health', (_req, res) => res.type('text/plain').send('ok'));

  /**
   * 邮件打开像素。无 tk 也照样回 1x1：网关预览和图片代理重试都会打到这里，报错等于把打开数算少。
   * 实现在 capture/trackEndpoints.js，与各仿冒站端口共用一份，避免两边统计口径与响应头漂移。
   */
  router.get(`${ENGAGE_BASE}/${PIXEL}`, (req, res) => {
    const url = new URL(req.originalUrl, 'http://localhost');
    servePixel(req, res, url);
  });

  /**
   * 邮件链接点击，先记账再放行：有 tk 时记一次 mail_open（点链接本身就是打开）加 mail_click，放行成功回 302。
   * 目标必须是当前生效授权白名单内的主机，否则这里退化成公共跳板；不合法时只回中性提示屏，读者是演练对象。
   * 实现与仿冒站端口上的 /trace 共用，邮件链接因此可以整条落在站点端口上。
   */
  router.get(`${ENGAGE_BASE}/${TRACE}`, (req, res) => {
    const url = new URL(req.originalUrl, 'http://localhost');
    serveTrace(req, res, url);
  });

  /**
   * 附件运行回调：只接受令牌属于本次演练、字段合规、文件是证据形态的回传，其余丢弃并记事件。
   * 三段中间件依次是配额判定、multipart 解析（带阈值）、归属校验与落库；副作用写 records(kind=mail) / events / mail_recipients.submitted_at，可能落盘截图。
   */
  router.post(
    `${ENGAGE_BASE}/${CALLBACK}`,
    (req, res, next) => {
      // 两个维度都要过：每次换一个随机 tk 能摊薄令牌桶，兜底是同一来源地址每分钟那道闸
      if (!rateAllowed(`t:${String(req.query.tk || 'anonymous')}`, LIMITS.per_token_per_minute)) {
        return tooManyRequests(res, `同一令牌每分钟最多回传 ${LIMITS.per_token_per_minute} 次`);
      }
      if (!rateAllowed(`i:${clientIp(req)}`, LIMITS.per_ip_per_minute)) {
        return tooManyRequests(res, `同一来源地址每分钟最多回传 ${LIMITS.per_ip_per_minute} 次`);
      }
      return next();
    },
    (req, res, next) => {
      // 解析放在配额之后、业务之前：闸门要在字节进内存之前生效
      upload.any()(req, res, (err) => {
        if (!err) return next();
        // multer 的越界以异常落到这里，按错误码翻成 413/400 的中文信封，不让它冒到 adminPlane 的 500 分支把 err.message 带回浏览器
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

      // tk 可能是收件人令牌、任务 ID 或页面签发的终端令牌，三次查询都认一遍，全不认识才判 400
      const recipient = get('SELECT * FROM mail_recipients WHERE token=?', [rawToken]);
      const taskById = get('SELECT * FROM mail_tasks WHERE id=?', [rawToken]);
      const visitor = resolveToken(rawToken);
      if (!recipient && !taskById && !visitor) {
        return rejectCallback(req, res, 400, '回传令牌不属于本次演练', 'unknown_token');
      }

      // 优先取收件人行（最可信），其次才认 tk 本身就是任务 ID 的载荷
      let taskId = recipient?.task_id ?? (taskById ? taskById.id : null);
      let token = rawToken;
      if (taskById && !recipient) {
        // 载荷只带任务 ID 时，用回信邮箱把收件人对出来
        const byMail = get('SELECT * FROM mail_recipients WHERE task_id=? AND email=?', [taskId, mail]);
        if (byMail) token = byMail.token;
      }
      // token 可能已被换成收件人那枚，归属要再解析一次；解析不到退回最初结果，白名单宁可宽也不误杀真实提交
      const holder = resolveToken(token) || visitor;

      const status = authorizationStatus({ taskId, visitor: holder });
      if (status && status !== 'active') {
        return rejectCallback(req, res, 410, '本次演练授权已不在有效期内，回传通道已关闭', `authorization_${status}`);
      }

      // 白名单来自这张模板声明的采集点；被丢弃的字段仍留一条事件，否则操作员只看到少了一个框
      const { fields, dropped } = fieldMap(req.body, declaredFieldSet(holder));
      if (dropped.length) {
        logEvent('callback_fields_dropped', { token, ip, user_agent: userAgent, payload: { dropped } });
      }

      let screenshotPath = null;
      const rejectedFiles = [];
      for (const file of req.files || []) {
        // 协议约定只有 capture 这一个字段能带文件：放开就等于把表单字段名变成上传通道
        if (file.fieldname !== 'capture') {
          rejectedFiles.push(`${file.originalname || '未命名'}：只收 capture 字段，字段 ${file.fieldname} 不放文件`);
          continue;
        }
        const saved = saveEvidence(file);
        if (!saved) {
          rejectedFiles.push(`${file.originalname || '未命名'}：文件头不在证据类型内、扩展名与内容不符或落盘配额已满`);
          continue;
        }
        // 一条记录只挂一张主截图：后续合格文件同样落盘，但只有第一个路径进 screenshot_path
        screenshotPath = screenshotPath || saved;
      }
      if (rejectedFiles.length) {
        logEvent('callback_files_dropped', { token, ip, user_agent: userAgent, payload: { rejected: rejectedFiles } });
      }
      // 只在服务日志里喊，不给访客侧任何响应差异：让外部知道这台存不下了只会招来更有针对性的灌写
      if (usedQuotaBytes() > QUOTA_BYTES) {
        console.warn(
          `[beacon] 截图落盘已用 ${Math.round((usedQuotaBytes() / 1048576) * 10) / 10}MB / ${LIMITS.screenshot_quota_mb}MB 配额，新截图暂不保存，请清理 data/screenshots`
        );
      }

      // 回传字段进的就是页面采集那同一个 form_json 历史数组，截图路径进 screenshot_path
      const { record } = recordAttachmentRun({
        taskId,
        token,
        mail,
        fields,
        screenshotPath,
        ip,
        userAgent,
      });
      // 任务与收件人令牌都对得上才标 submitted_at：这一步在看板上把人从"打开了邮件"挪到"已经上钩"，宁可少标不能错标
      if (taskId && token) {
        run('UPDATE mail_recipients SET submitted_at=? WHERE task_id=? AND token=?', [nowIso(), taskId, token]);
      }
      // 回执只报计数：响应会被载荷读到，把凭据或字段名吐回去等于多一处泄露面
      res.json({
        code: 0,
        data: { accepted: true, id: record.id, dropped_fields: dropped.length, rejected_files: rejectedFiles.length },
      });
    }
  );

  // 这几条路径不带管理面鉴权、也不受随机后台路径保护，必须先于 mountAdminPlane 的静态与兜底路由生效
  app.use(router);
}
