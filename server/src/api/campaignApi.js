import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../platform/settings.js';
import { all, get, insert, nowIso, pagedRows, run, update } from '../platform/storage/rows.js';
import { ok, badRequest, notFound, paginate } from '../platform/net/envelope.js';
import { assertDeployment, findActive } from '../security/mandate.js';
import { writeAudit } from '../security/audit.js';
import { publicBase } from '../mail/composer.js';
import { deliverCampaign, resendRecipient } from '../mail/campaignRunner.js';

export const campaignApi = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const RECIPIENT_STATUSES = ['sent', 'sandboxed', 'failed', 'pending'];

function statusCounts(taskId) {
  const grouped = all('SELECT status, COUNT(*) AS n FROM mail_recipients WHERE task_id=? GROUP BY status', [taskId]);
  const count = (status) => grouped.find((row) => row.status === status)?.n ?? 0;
  return {
    total: grouped.reduce((sum, row) => sum + row.n, 0),
    ...Object.fromEntries(RECIPIENT_STATUSES.map((status) => [status, count(status)])),
  };
}

/** 「邮箱,姓名」按行导入：演练名单最常见的形态就是从表格粘一列出来 */
function parseRecipients(body) {
  if (Array.isArray(body.recipients)) {
    return body.recipients.map((r) => ({ email: r.email || r.address, name: r.name || '' }));
  }
  return String(body.text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [email, name] = line.split(/[,;\t]/).map((s) => (s || '').trim());
      return { email, name };
    });
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

campaignApi.get('/mail-tasks', (req, res) => {
  const { page, page_size } = paginate(req.query);
  const data = pagedRows('mail_tasks', '', [], page, page_size);
  ok(res, {
    ...data,
    rows: data.rows.map((task) => ({ ...task, dry_run: Boolean(task.dry_run), stats: statusCounts(task.id) })),
  });
});

campaignApi.get('/mail-tasks/:id', (req, res) => {
  const task = get('SELECT * FROM mail_tasks WHERE id=?', [req.params.id]);
  if (!task) return notFound(res, '任务不存在');
  ok(res, {
    task,
    recipients: all('SELECT * FROM mail_recipients WHERE task_id=? ORDER BY created_at', [task.id]),
    events: all(
      'SELECT * FROM events WHERE ref_id=? OR token IN (SELECT token FROM mail_recipients WHERE task_id=?) ORDER BY created_at',
      [task.id, task.id]
    ),
  });
});

campaignApi.post('/mail-tasks', (req, res) => {
  if (!assertDeployment(res)) return;
  const b = req.body || {};
  if (!b.title || !b.subject || !b.body_html) return badRequest(res, '任务标题、邮件标题、正文必填');
  const dryRun = b.dry_run === undefined ? config.mail.default_dry_run : Boolean(b.dry_run);
  if (!dryRun && !b.smtp_profile_id) return badRequest(res, '关闭沙箱后必须选择发信邮箱配置');
  const now = nowIso();
  const row = {
    id: crypto.randomUUID(),
    title: b.title,
    mail_template_id: b.mail_template_id || null,
    subject: b.subject,
    body_html: b.body_html,
    attachment_name: null,
    attachment_path: null,
    smtp_profile_id: b.smtp_profile_id || null,
    sender: b.sender || null,
    send_interval_ms: Number(b.send_interval_ms ?? config.mail.default_send_interval_ms),
    dry_run: dryRun ? 1 : 0,
    authorization_id: findActive().id,
    status: 'draft',
    created_at: now,
    updated_at: now,
  };
  insert('mail_tasks', row);
  ok(res, row);
});

campaignApi.put('/mail-tasks/:id', (req, res) => {
  const b = req.body || {};
  const before = get('SELECT dry_run FROM mail_tasks WHERE id=?', [req.params.id]);
  const patch = { updated_at: nowIso() };
  for (const key of ['title', 'subject', 'body_html', 'mail_template_id', 'smtp_profile_id', 'sender']) {
    if (b[key] !== undefined) patch[key] = b[key] || null;
  }
  if (b.send_interval_ms !== undefined) patch.send_interval_ms = Number(b.send_interval_ms) || 0;
  if (b.dry_run !== undefined) patch.dry_run = b.dry_run ? 1 : 0;
  if (b.attachment_reset) {
    patch.attachment_name = null;
    patch.attachment_path = null;
  }
  update('mail_tasks', req.params.id, patch);
  // 沙箱开关是"要不要真的寄出去"的分界线，谁翻的、什么时候翻的必须留在库里
  if (before && patch.dry_run !== undefined && Number(before.dry_run) !== patch.dry_run) {
    writeAudit(req, 'mail_task.sandbox_toggle', {
      targetKind: 'mail_task',
      targetId: req.params.id,
      detail: { from: Number(before.dry_run) === 1 ? 'sandbox' : 'real', to: patch.dry_run === 1 ? 'sandbox' : 'real' },
    });
  }
  ok(res, get('SELECT * FROM mail_tasks WHERE id=?', [req.params.id]));
});

campaignApi.post('/mail-tasks/:id/attachment', upload.single('file'), (req, res) => {
  if (!req.file) return badRequest(res, '未收到附件');
  const task = get('SELECT * FROM mail_tasks WHERE id=?', [req.params.id]);
  if (!task) return notFound(res, '任务不存在');
  const safe = path.basename(req.file.originalname).replace(/[^\w.\-一-龥]/g, '_');
  const file = path.join(config.paths.attachments, `${task.id}-${safe}`);
  fs.writeFileSync(file, req.file.buffer);
  update('mail_tasks', task.id, { attachment_name: safe, attachment_path: file, updated_at: nowIso() });
  ok(res, { name: safe, size: req.file.size });
});

/**
 * 收件人导入：同一任务内邮箱去重，每个收件人分配独立令牌，
 * 令牌同时写进 capture_tokens，页面采集与邮件归属才能串到同一个人。
 */
campaignApi.post('/mail-tasks/:id/recipients', (req, res) => {
  const task = get('SELECT * FROM mail_tasks WHERE id=?', [req.params.id]);
  if (!task) return notFound(res, '任务不存在');
  const list = parseRecipients(req.body || {});
  const valid = list.filter((r) => r.email && EMAIL_PATTERN.test(r.email));
  let added = 0;
  for (const r of valid) {
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

campaignApi.post('/mail-tasks/:id/send', async (req, res) => {
  if (!assertDeployment(res)) return;
  const task = get('SELECT * FROM mail_tasks WHERE id=?', [req.params.id]);
  if (!task) return notFound(res, '任务不存在');
  if (!get('SELECT COUNT(*) AS n FROM mail_recipients WHERE task_id=?', [task.id]).n) {
    return badRequest(res, '请先导入收件人');
  }
  try {
    const result = await deliverCampaign(task.id, { base: publicBase(req) });
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

campaignApi.post('/mail-tasks/:id/recipients/:rid/resend', async (req, res) => {
  try {
    ok(res, await resendRecipient(req.params.id, req.params.rid, { base: publicBase(req) }));
  } catch (err) {
    badRequest(res, err.message);
  }
});

campaignApi.delete('/mail-tasks/:id', (req, res) => {
  const recipients = get('SELECT COUNT(*) AS n FROM mail_recipients WHERE task_id=?', [req.params.id]).n;
  run('DELETE FROM mail_recipients WHERE task_id=?', [req.params.id]);
  run('DELETE FROM mail_tasks WHERE id=?', [req.params.id]);
  writeAudit(req, 'mail_task.delete', { targetKind: 'mail_task', targetId: req.params.id, detail: { recipients } });
  ok(res, true);
});
