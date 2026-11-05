/** 邮件投递编排：逐收件人渲染投递并如实回写状态；dry_run=1 是默认路径，真发必须显式关沙箱且绑定 smtp_profiles，否则直接拒绝。 */
import { get, all, run, nowIso } from '../platform/storage/rows.js';
import { effectiveStatus } from '../security/mandate.js';
import { buildMessage, renderMailBody } from './composer.js';
import { sendViaSmtp, writeSandboxMail } from './transport.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 取任务并校验前置：授权每次重读，发信那一刻的窗口才算数，任务不存在或失效直接抛中文错误。 */
function loadTask(taskId) {
  const task = get('SELECT * FROM mail_tasks WHERE id=?', [taskId]);
  if (!task) throw new Error('任务不存在');
  const authorization = get('SELECT * FROM authorizations WHERE id=?', [task.authorization_id]);
  // 用 effectiveStatus 判此刻状态：库里写着 active 但窗口已过一样要拦
  if (effectiveStatus(authorization) !== 'active') {
    throw new Error('演练授权无效或已过期，任务拒绝发送。');
  }
  return task;
}

/** 本轮待投集合，按 created_at 升序：整任务只捞 pending/failed（已成功的不再重投），点名重发分支不过滤状态。 */
function pendingRecipients(taskId, recipientIds) {
  if (recipientIds?.length) {
    return all(
      `SELECT * FROM mail_recipients WHERE task_id=? AND id IN (${recipientIds.map(() => '?').join(',')}) ORDER BY created_at`,
      [taskId, ...recipientIds]
    );
  }
  return all("SELECT * FROM mail_recipients WHERE task_id=? AND status IN ('pending','failed') ORDER BY created_at", [taskId]);
}

/** 单收件人投递：渲染先于沙箱/真发分流，两条分支共用同一份 message，失败原样上抛由上层记账。 */
async function deliverOne(task, recipient, { base, profile, dryRun }) {
  // 每收件人单独渲染：专属令牌与个性化变量因人而异，复用同一份 HTML 归属链会断
  const message = buildMessage({ task, recipient, html: renderMailBody(task, recipient, { base }), profile });
  if (dryRun) {
    await writeSandboxMail({ task, recipient, message });
    // 沙箱分支也写 sent_at（这一封的产出时间，前端按它排序）；error=NULL 清掉上一轮的失败原因
    run("UPDATE mail_recipients SET status='sandboxed', sent_at=?, error=NULL WHERE id=?", [nowIso(), recipient.id]);
    return;
  }
  await sendViaSmtp(profile, message);
  run("UPDATE mail_recipients SET status='sent', sent_at=?, error=NULL WHERE id=?", [nowIso(), recipient.id]);
}

/** 整任务投递：前置失败（任务/授权/发信配置缺失）直接抛给 api 层；循环内单收件人失败只计数并写该行 error，不影响后续收件人；名册全投过时按现有终态原样返回，不改判失败。 */
export async function deliverCampaign(taskId, { base, recipientIds = null } = {}) {
  const task = loadTask(taskId);
  const recipients = pendingRecipients(taskId, recipientIds);
  const profile = task.smtp_profile_id ? get('SELECT * FROM smtp_profiles WHERE id=?', [task.smtp_profile_id]) : null;
  // dry_run 在库里是 0/1 整数，显式转布尔再回传，避免前端拿到数字
  const dryRun = Boolean(task.dry_run);
  // 关了沙箱却没有可用发信配置时直接拒绝，不静默空发再标已发送
  if (!dryRun && !profile) throw new Error('未配置发信邮箱，无法真实发信。');

  // 整任务只捞 pending/failed，名册全都投过时的第二次点击会空转落到这条分支。
  // 空转不能按「0 封成功」判成全部失败，否则点两下发送就把投成功的任务标红，台账与交付报告一起失真。
  if (!recipients.length) {
    const roster = all('SELECT status FROM mail_recipients WHERE task_id=?', [taskId]);
    const delivered = roster.filter((r) => r.status === 'sent' || r.status === 'sandboxed').length;
    const status = roster.length && delivered === roster.length ? 'sent' : task.status;
    if (status !== task.status) run('UPDATE mail_tasks SET status=?, updated_at=? WHERE id=?', [status, nowIso(), taskId]);
    return { total: 0, sent: 0, failed: 0, skipped: roster.length, dry_run: dryRun, status };
  }

  // 一批几十封要按间隔磨几分钟，先置 sending 让界面能看出这单正在跑
  run("UPDATE mail_tasks SET status='sending', updated_at=? WHERE id=?", [nowIso(), taskId]);

  let sent = 0;
  let failed = 0;
  for (const [index, recipient] of recipients.entries()) {
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
          // payload 只带收件地址与沙箱标记：正文与凭据不进流水，events 会被证据页整表翻出
          JSON.stringify({ to: recipient.email, dry_run: dryRun }),
          nowIso(),
        ]
      );
    } catch (err) {
      // 就地记账继续下一个：单收件人失败只算这一行，但也不因后面有人成功就抹掉前面的失败
      failed++;
      run("UPDATE mail_recipients SET status='failed', error=? WHERE id=?", [String(err.message).slice(0, 300), recipient.id]);
    }
  }

  // 先判 sent===0：一封都没成落 failed 而不是 partial，终态不说谎
  const outcome = sent === 0 ? 'failed' : failed > 0 ? 'partial' : 'sent';
  run('UPDATE mail_tasks SET status=?, updated_at=? WHERE id=?', [outcome, nowIso(), taskId]);
  // skipped 是本轮没进队列的名册人数：整任务重投时已成功的不会再发，界面要说清这是「投过了」而不是漏发
  const rosterTotal = get('SELECT COUNT(*) AS n FROM mail_recipients WHERE task_id=?', [taskId]).n;
  const skipped = recipientIds?.length ? 0 : Math.max(0, rosterTotal - recipients.length);
  return { total: recipients.length, sent, failed, skipped, dry_run: dryRun, status: outcome };
}

/** 单个收件人重发：拨回 pending 后复用整条 runner，口径与整任务投递一致，total 恒为 1。 */
export async function resendRecipient(taskId, recipientId, { base } = {}) {
  const task = loadTask(taskId);
  // id 与 task_id 必须同时命中，否则就是拿 A 任务的收件人行发 B 任务的邮件
  const recipient = get('SELECT * FROM mail_recipients WHERE id=? AND task_id=?', [recipientId, task.id]);
  if (!recipient) throw new Error('收件人不存在');
  run("UPDATE mail_recipients SET status='pending', error=NULL WHERE id=?", [recipient.id]);
  return deliverCampaign(task.id, { base, recipientIds: [recipient.id] });
}
