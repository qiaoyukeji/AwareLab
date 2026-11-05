// 钓鱼邮件任务域（/mail-tasks*）：任务的增删改、附件上传、收件人导入、发送与重发。
// 建任务与发送过授权门禁（403），沙箱开关 dry_run 谁翻的要进审计。
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../platform/settings.js';
import { all, get, insert, nowIso, pagedRows, run, update } from '../platform/storage/rows.js';
import { ok, badRequest, notFound, paginate } from '../platform/net/envelope.js';
import { assertDeployment, findActive } from '../security/mandate.js';
import { writeAudit } from '../security/audit.js';
import { mailBase, needsSite, taskSiteOrigin } from '../mail/composer.js';
import { deliverCampaign, resendRecipient } from '../mail/campaignRunner.js';

export const campaignApi = express.Router();

// filename 是不带 charset 的裸 UTF-8 字节，multer 默认按 latin1 解会乱码，故显式 utf8。
// 操作员上传整文件进内存（25MB 上限）再落盘，和访客回传面的 5MB/3 文件是两条闸。
const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8', limits: { fileSize: 25 * 1024 * 1024 } });

// 收件人状态的固定四口径：库里没出现过的状态也给 0，前端不必防 undefined
const RECIPIENT_STATUSES = ['sent', 'sandboxed', 'failed', 'pending'];

/** 本任务各状态收件人计数，total 为求和即收件人总数（邮件侧转化率分母）。WHERE 锁 task_id，跨任务串统计会污染取证。 */
function statusCounts(taskId) {
  const grouped = all('SELECT status, COUNT(*) AS n FROM mail_recipients WHERE task_id=? GROUP BY status', [taskId]);
  const count = (status) => grouped.find((row) => row.status === status)?.n ?? 0;
  return {
    total: grouped.reduce((sum, row) => sum + row.n, 0),
    ...Object.fromEntries(RECIPIENT_STATUSES.map((status) => [status, count(status)])),
  };
}

// 收件人按行导入，支持 recipients 数组或 text 多行串；行切分认 \r\n 与 \n（Windows 剪贴板带 \r），
// 列认逗号/分号/制表符/空白（界面上写的「邮箱 姓名」是空格分隔，从表格里粘出来往往是制表符）。
function parseRecipients(body) {
  if (Array.isArray(body.recipients)) {
    return body.recipients.map((r) => ({ email: r.email || r.address, name: r.name || '' }));
  }
  return String(body.text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let parts = line.split(/[,;\t]/);
      // 没有逗号/分号/制表符时按空白切：邮箱本身不含空格，第一段必然是邮箱，其余拼回姓名（姓名里常有空格）
      if (parts.length === 1) {
        const spaceAt = line.search(/\s/);
        parts = spaceAt < 0 ? [line] : [line.slice(0, spaceAt), line.slice(spaceAt).trim()];
      }
      const [email, name] = parts.map((s) => (s || '').trim());
      // 只取前两段：粘贴里多带的第三列（部门之类）静默丢掉，不因此报废整行
      return { email, name };
    });
}

// 邮箱形状闸：不合格计入 invalid 不落库，错格式的地址真发时必失败
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** 任务出参归一：dry_run 库里是 0/1，接口一律给布尔，否则前端要为同一字段写两套判断。 */
const taskView = (task) => (task ? { ...task, dry_run: Boolean(task.dry_run) } : task);

/** GET /mail-tasks — 任务列表分页倒序，每行附加 stats（收件人状态计数，N+1 但量级小可接受）。 */
campaignApi.get('/mail-tasks', (req, res) => {
  const { page, page_size } = paginate(req.query);
  const data = pagedRows('mail_tasks', '', [], page, page_size);
  ok(res, {
    ...data,
    rows: data.rows.map((task) => ({ ...taskView(task), stats: statusCounts(task.id) })),
  });
});

// GET /mail-tasks/:id — 任务详情 {task, recipients, events}，id 不存在回 404。
// events 并两条线：任务级按 ref_id，访客侧只带令牌、靠 token IN 本任务收件人令牌集认领。
campaignApi.get('/mail-tasks/:id', (req, res) => {
  const task = get('SELECT * FROM mail_tasks WHERE id=?', [req.params.id]);
  if (!task) return notFound(res, '任务不存在');
  ok(res, {
    task: taskView(task),
    recipients: all('SELECT * FROM mail_recipients WHERE task_id=? ORDER BY created_at', [task.id]),
    events: all(
      'SELECT * FROM events WHERE ref_id=? OR token IN (SELECT token FROM mail_recipients WHERE task_id=?) ORDER BY created_at',
      [task.id, task.id]
    ),
  });
});

// POST /mail-tasks — 新建草稿不发信；无生效授权 403 且不碰库。
// dry_run 缺省跟 config.mail.default_dry_run，关沙箱却没选发信邮箱 400；authorization_id 绑当下生效那份，runner 之后校验任务自己绑的这张（吊销即断供）。
campaignApi.post('/mail-tasks', (req, res) => {
  if (!assertDeployment(res)) return;
  const b = req.body || {};
  if (!b.title || !b.subject || !b.body_html) return badRequest(res, '任务标题、邮件标题、正文必填');
  // undefined 才落配置默认；显式传 false/0 视为操作员要真发，必须配好 SMTP
  const dryRun = b.dry_run === undefined ? config.mail.default_dry_run : Boolean(b.dry_run);
  if (!dryRun && !b.smtp_profile_id) return badRequest(res, '关闭沙箱后必须选择发信邮箱配置');
  const now = nowIso();
  const row = {
    id: crypto.randomUUID(),
    title: b.title,
    mail_template_id: b.mail_template_id || null,
    // 绑定的仿冒站决定邮件里像素、{{site_url}} 与跳转落在哪个端口；不绑时由 composer 取唯一在听站点兜底
    site_id: b.site_id || null,
    subject: b.subject,
    body_html: b.body_html,
    attachment_name: null,
    attachment_path: null,
    smtp_profile_id: b.smtp_profile_id || null,
    sender: b.sender || null,
    // 限速缺省跟配置（3000ms）：演练对象的工作日窗口内秒级群发最容易触发邮箱风控
    send_interval_ms: Number(b.send_interval_ms ?? config.mail.default_send_interval_ms),
    // 库里 0/1 落形（node:sqlite 不收布尔），出参由 taskView 翻回布尔
    dry_run: dryRun ? 1 : 0,
    authorization_id: findActive().id,
    status: 'draft',
    created_at: now,
    updated_at: now,
  };
  insert('mail_tasks', row);
  ok(res, taskView(row));
});

// PUT /mail-tasks/:id — 白名单字段补丁（undefined=不动，空值=清 NULL）；先 notFound 再 UPDATE，否则改 0 行不报错照样回成功。
// 沙箱开关翻转时写 sandbox_toggle 审计；编辑不过授权门禁，真发的闸门在 /send 与 runner。
campaignApi.put('/mail-tasks/:id', (req, res) => {
  if (!get('SELECT 1 AS x FROM mail_tasks WHERE id=?', [req.params.id])) return notFound(res, '任务不存在');
  const b = req.body || {};
  // 先留 dry_run 旧值：翻转判定要拿"改前 vs 改后"对比，改完再查就看不出来过
  const before = get('SELECT dry_run FROM mail_tasks WHERE id=?', [req.params.id]);
  const patch = { updated_at: nowIso() };
  // 只收白名单这几列：授权绑定、状态这类字段不接受从这里改，防止绕过创建路径换授权
  for (const key of ['title', 'subject', 'body_html', 'mail_template_id', 'smtp_profile_id', 'sender', 'site_id']) {
    if (b[key] !== undefined) patch[key] = b[key] || null;
  }
  if (b.send_interval_ms !== undefined) patch.send_interval_ms = Number(b.send_interval_ms) || 0;
  if (b.dry_run !== undefined) patch.dry_run = b.dry_run ? 1 : 0;
  // 前端"移除附件"只发这个标志：摘库里的引用，磁盘文件不回收（删错不可逆）
  if (b.attachment_reset) {
    patch.attachment_name = null;
    patch.attachment_path = null;
  }
  update('mail_tasks', req.params.id, patch);
  if (before && patch.dry_run !== undefined && Number(before.dry_run) !== patch.dry_run) {
    writeAudit(req, 'mail_task.sandbox_toggle', {
      targetKind: 'mail_task',
      targetId: req.params.id,
      detail: { from: Number(before.dry_run) === 1 ? 'sandbox' : 'real', to: patch.dry_run === 1 ? 'sandbox' : 'real' },
    });
  }
  ok(res, taskView(get('SELECT * FROM mail_tasks WHERE id=?', [req.params.id])));
});

// POST /mail-tasks/:id/attachment — 上传单个附件（字段 'file'），先查文件再查任务，400/404。
// 文件名净化：path.basename 斩目录段防 ../，非 [\w . - 汉字] 换下划线（靠 multer 的 utf8 才有中文）；落 attachments/<任务id>-<净化名>，前缀防跨任务撞名，旧文件不删。
campaignApi.post('/mail-tasks/:id/attachment', upload.single('file'), (req, res) => {
  if (!req.file) return badRequest(res, '未收到附件');
  const task = get('SELECT * FROM mail_tasks WHERE id=?', [req.params.id]);
  if (!task) return notFound(res, '任务不存在');
  const safe = path.basename(req.file.originalname).replace(/[^\w.\-一-龥]/g, '_');
  const file = path.join(config.paths.attachments, `${task.id}-${safe}`);
  // 内存缓冲直写磁盘（25MB 封顶）：附件只认这一条进库路
  fs.writeFileSync(file, req.file.buffer);
  update('mail_tasks', task.id, { attachment_name: safe, attachment_path: file, updated_at: nowIso() });
  ok(res, { name: safe, size: req.file.size });
});

// POST /mail-tasks/:id/recipients — 收件人导入，同任务邮箱去重，返回 {added, skipped, invalid}，404 若任务不存在。
// 每人一个令牌并同写 capture_tokens，页面采集与邮件归属才能串到同一人。
campaignApi.post('/mail-tasks/:id/recipients', (req, res) => {
  const task = get('SELECT * FROM mail_tasks WHERE id=?', [req.params.id]);
  if (!task) return notFound(res, '任务不存在');
  const list = parseRecipients(req.body || {});
  const valid = list.filter((r) => r.email && EMAIL_PATTERN.test(r.email));
  let added = 0;
  for (const r of valid) {
    // 重复地址会真发两遍、上钩还算两个人，必须掐掉（计入 skipped）
    if (get('SELECT 1 AS x FROM mail_recipients WHERE task_id=? AND email=?', [task.id, r.email])) continue;
    const token = crypto.randomUUID();
    insert('mail_recipients', {
      id: crypto.randomUUID(),
      task_id: task.id,
      email: r.email,
      name: r.name || null,
      token,
      status: 'pending',
      created_at: nowIso(),
    });
    insert('capture_tokens', {
      // 令牌双表登记（值同一个）：采集面只认 capture_tokens，访客带 ?tk= 进页面时靠这张表认领到人
      token,
      site_id: null,
      task_id: task.id,
      target_email: r.email,
      target_name: r.name || null,
      created_at: nowIso(),
      first_seen_at: null,
      submitted_at: null,
    });
    added++;
  }
  ok(res, { added, skipped: valid.length - added, invalid: list.length - valid.length });
});

// POST /mail-tasks/:id/send — 执行投递，沙箱还是真发看任务自己的 dry_run。闸门按序：无授权 403 → 无任务 404 → 无收件人 400，再交 deliverCampaign 复验授权与发信配置。
// 审计按 dry_run 分流 sandbox_send / real_send；status 讲真话（投了却一封没成=failed、部分=partial、全成=sent；名册全都投过则原样返回不改判失败）。
campaignApi.post('/mail-tasks/:id/send', async (req, res) => {
  if (!assertDeployment(res)) return;
  const task = get('SELECT * FROM mail_tasks WHERE id=?', [req.params.id]);
  if (!task) return notFound(res, '任务不存在');
  // 没收件人就报"先导入"：这是投放动作，不该走到 runner
  if (!get('SELECT COUNT(*) AS n FROM mail_recipients WHERE task_id=?', [task.id]).n) {
    return badRequest(res, '请先导入收件人');
  }
  // 正文里写了 {{site_url}} 却没绑站点时，发出去会退回管理端地址（也就是操作员报的 7778 问题），在这里直接拦下
  if (needsSite(task) && !taskSiteOrigin(task)) {
    return badRequest(res, '正文使用了 {{site_url}}，请先给任务绑定一个开启中的钓鱼网站，或直接保存为草稿稍后再发');
  }
  try {
    const result = await deliverCampaign(task.id, { base: mailBase(task, req) });
    writeAudit(req, result.dry_run ? 'mail_task.sandbox_send' : 'mail_task.real_send', {
      targetKind: 'mail_task',
      targetId: task.id,
      detail: { dry_run: Boolean(result.dry_run), sent: result.sent ?? null, failed: result.failed ?? null, skipped: result.skipped ?? null },
    });
    ok(res, result);
  } catch (err) {
    badRequest(res, err.message);
  }
});

// POST /mail-tasks/:id/recipients/:rid/resend — 只补发这一个收件人，不重过整张队列。收件人按 id AND task_id 查，别家 rid 冒不了本任务的名（错位会发错人）。
// 不过授权门禁，真发判定由 runner 兜底；此路径不写审计，real_send 只在 /send 落。
campaignApi.post('/mail-tasks/:id/recipients/:rid/resend', async (req, res) => {
  if (!get('SELECT 1 AS x FROM mail_tasks WHERE id=?', [req.params.id])) return notFound(res, '任务不存在');
  if (!get('SELECT 1 AS x FROM mail_recipients WHERE id=? AND task_id=?', [req.params.rid, req.params.id])) {
    return notFound(res, '收件人不存在');
  }
  const task = get('SELECT * FROM mail_tasks WHERE id=?', [req.params.id]);
  if (!task) return notFound(res, '任务不存在');
  try {
    ok(res, await resendRecipient(req.params.id, req.params.rid, { base: mailBase(task, req) }));
  } catch (err) {
    badRequest(res, err.message);
  }
});

// DELETE /mail-tasks/:id — 删任务与其收件人名册，不设门禁。mail_recipients 无外键级联，须先按 task_id 显式删子表，否则孤儿收件人咬住看板与重发。
// 磁盘附件、events、capture_tokens 与已采记录都留着：任务没了证据还在；审计记下删掉的收件人数。
campaignApi.delete('/mail-tasks/:id', (req, res) => {
  const task = get('SELECT 1 AS x FROM mail_tasks WHERE id=?', [req.params.id]);
  if (!task) return notFound(res, '任务不存在');
  // 删之前先数收件人：审计里这个数是"删了多少人名册"的唯一凭证，删完再数永远是 0
  const recipients = get('SELECT COUNT(*) AS n FROM mail_recipients WHERE task_id=?', [req.params.id]).n;
  run('DELETE FROM mail_recipients WHERE task_id=?', [req.params.id]);
  run('DELETE FROM mail_tasks WHERE id=?', [req.params.id]);
  writeAudit(req, 'mail_task.delete', { targetKind: 'mail_task', targetId: req.params.id, detail: { recipients } });
  ok(res, true);
});
