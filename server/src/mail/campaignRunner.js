import { get, all, run, nowIso } from '../platform/storage/rows.js';
import { effectiveStatus } from '../security/mandate.js';
import { buildMessage, renderMailBody } from './composer.js';
import { sendViaSmtp, writeSandboxMail } from './transport.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadTask(taskId) {
  const task = get('SELECT * FROM mail_tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在');
  // 任务绑定的授权必须是当前生效的那一份：吊销或缩窗之后，即使另有授权存在也不能继续投递
  const authorization = get('SELECT * FROM authorizations WHERE id=?', [task.authorization_id]);
  if (effectiveStatus(authorization) !== 'active') {
    throw new Error('演练授权无效或已过期，任务拒绝发送。');
  }
  return task;
}

function pendingRecipients(taskId, recipientIds) {
  if (recipientIds?.length) {
    return all(
      `SELECT * FROM mail_recipients WHERE task_id=? AND id IN (${recipientIds.map(() => '?').join(',')}) ORDER BY created_at`,
      [taskId, ...recipientIds]
    );
  }
  return all("SELECT * FROM mail_recipients WHERE task_id=? AND status IN ('pending','failed') ORDER BY created_at", [taskId]);
}

async function deliverOne(task, recipient, { base, profile, dryRun }) {
  const message = buildMessage({ task, recipient, html: renderMailBody(task, recipient, { base }), profile });
  if (dryRun) {
    await writeSandboxMail({ task, recipient, message });
    run("UPDATE mail_recipients SET status='sandboxed', sent_at=?, error=NULL WHERE id=?", [nowIso(), recipient.id]);
    return;
  }
  await sendViaSmtp(profile, message);
  run("UPDATE mail_recipients SET status='sent', sent_at=?, error=NULL WHERE id=?", [nowIso(), recipient.id]);
}

/**
 * 投递任务状态机：draft/sending → sent。
 * dry_run=1 时只渲染、记账、落 .eml 文件，不做任何真实投递；
 * 真实投递要求授权有效，且必须显式关闭沙箱开关并绑定发信配置。
 */
export async function deliverCampaign(taskId, { base, recipientIds = null } = {}) {
  const task = loadTask(taskId);
  const recipients = pendingRecipients(taskId, recipientIds);
  const profile = task.smtp_profile_id ? get('SELECT * FROM smtp_profiles WHERE id=?', [task.smtp_profile_id]) : null;
  const dryRun = Boolean(task.dry_run);
  if (!dryRun && !profile) throw new Error('未配置发信邮箱，无法真实发信。');

  run("UPDATE mail_tasks SET status='sending', updated_at=? WHERE id=?", [nowIso(), taskId]);

  let sent = 0;
  let failed = 0;
  for (const [index, recipient] of recipients.entries()) {
    // 限速只压投递节奏，不压记账：演练对象的工作日窗口内批量发信最容易触发风控
    if (index > 0 && task.send_interval_ms > 0 && recipients.length > 1) {
      await sleep(task.send_interval_ms);
    }
    try {
      await deliverOne(task, recipient, { base, profile, dryRun });
      sent++;
      run(
        'INSERT INTO events (id,kind,ref_id,token,ip,user_agent,payload,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [
          crypto.randomUUID(),
          'mail_send',
          taskId,
          recipient.token,
          null,
          null,
          JSON.stringify({ to: recipient.email, dry_run: dryRun }),
          nowIso(),
        ]
      );
    } catch (err) {
      failed++;
      run("UPDATE mail_recipients SET status='failed', error=? WHERE id=?", [String(err.message).slice(0, 300), recipient.id]);
    }
  }

  run("UPDATE mail_tasks SET status='sent', updated_at=? WHERE id=?", [nowIso(), taskId]);
  return { total: recipients.length, sent, failed, dry_run: dryRun };
}

/** 单个收件人重发：只推进这一条，不把整张待发送队列重新过一遍 */
export async function resendRecipient(taskId, recipientId, { base } = {}) {
  const task = loadTask(taskId);
  const recipient = get('SELECT * FROM mail_recipients WHERE id=? AND task_id=?', [recipientId, task.id]);
  if (!recipient) throw new Error('收件人不存在');
  run("UPDATE mail_recipients SET status='pending', error=NULL WHERE id=?", [recipient.id]);
  return deliverCampaign(task.id, { base, recipientIds: [recipient.id] });
}
