import express from 'express';
import fs from 'node:fs';
import { all, get, nowIso, parseJson, pagedRows, run } from '../platform/storage/rows.js';
import { ok, notFound, paginate } from '../platform/net/envelope.js';
import { clientIp } from '../platform/net/clientIp.js';
import { flattenHistory } from '../capture/evidenceStore.js';
import { isRunning } from '../capture/siteRegistry.js';
import { writeAudit } from '../security/audit.js';

export const evidenceApi = express.Router();

/**
 * 列表与详情都只暴露归一化后的采集历史：[{name, value, at}]。
 * 老库里的 record_content 数组与新库的 fields 映射在这里汇成同一种形状，
 * 历史演练数据不会因为协议升级而读不出来。
 * form_json 是协议 v2 约定的归一化键；form 是记录响应一直就有的键，两者同一份数据，
 * 消费端无论读哪个都拿到扁平数组。
 */
function toView(row) {
  const history = flattenHistory(row.form_json);
  return {
    ...row,
    form_json: history,
    form: history,
    feature: parseJson(row.feature_json),
    submitted: Boolean(row.submitted_at),
  };
}

function buildFilter(query) {
  const cond = [];
  const params = [];
  if (query.kind) {
    cond.push('kind=?');
    params.push(query.kind);
  }
  if (query.site_id) {
    cond.push('site_id=?');
    params.push(query.site_id);
  }
  if (query.task_id) {
    cond.push('task_id=?');
    params.push(query.task_id);
  }
  // 未归属：既没挂在某个钓鱼网站下、也没挂在某个邮件任务下的历史证据， grouped 视图里单独一格
  if (query.unassigned === '1') {
    cond.push("IFNULL(task_id,'')='' AND NOT (kind='web' AND IFNULL(site_id,'')<>'')");
  }
  if (query.submitted === '1') cond.push('submitted_at IS NOT NULL');
  if (query.submitted === '0') cond.push('submitted_at IS NULL');
  if (query.keyword) {
    cond.push('(target_email LIKE ? OR token LIKE ?)');
    const like = `%${query.keyword}%`;
    params.push(like, like);
  }
  return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', params };
}

evidenceApi.get('/records', (req, res) => {
  const { where, params } = buildFilter(req.query);
  const { page, page_size } = paginate(req.query);
  const data = pagedRows('records', where, params, page, page_size);
  ok(res, { ...data, rows: data.rows.map(toView) });
});

const EVENT_TALLY = `SELECT token,kind,COUNT(*) AS n FROM events
   WHERE token IS NOT NULL AND kind IN ('page_open','mail_open','form_fill','attachment_run')
   GROUP BY token,kind`;

function newGroup(meta) {
  return {
    ...meta,
    terminals: 0,
    submitted: 0,
    page_opens: 0,
    mail_opens: 0,
    submits: 0,
    attachments: 0,
    field_names: [],
    last_seen_at: null,
    _names: new Set(),
  };
}

function accumulate(group, record, tally) {
  group.terminals += 1;
  if (record.submitted_at) group.submitted += 1;
  const counts = tally.get(record.token) ?? {};
  group.page_opens += counts.page_open ?? 0;
  group.mail_opens += counts.mail_open ?? 0;
  group.submits += counts.form_fill ?? 0;
  group.attachments += counts.attachment_run ?? 0;
  if (record.last_seen_at && record.last_seen_at > (group.last_seen_at ?? '')) group.last_seen_at = record.last_seen_at;
  for (const field of flattenHistory(record.form_json)) group._names.add(field.name);
}

/** 有上钩的排前面，同热度按最近活动、再按建好的时间倒序 */
function byHot(a, b) {
  return (
    b.submitted - a.submitted ||
    b.terminals - a.terminals ||
    String(b.last_seen_at ?? '').localeCompare(String(a.last_seen_at ?? '')) ||
    String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  );
}

function seal(group) {
  const { _names, ...rest } = group;
  return { ...rest, field_names: [..._names].slice(0, 8), conversion: group.terminals ? Math.round((group.submitted / group.terminals) * 1000) / 10 : 0 };
}

/**
 * 上钩证据按投放载体分组：每一个钓鱼网页、每一个钓鱼邮件任务各成一组。
 * 口径与下钻用的 /records 过滤完全一致，看板的数字点进去就是那一屏：
 * 网页组 = kind='web' 且 site_id 命中；邮件组 = task_id 命中（邮件打开与后续网页提交同属一条链）。
 * 已删除的站点与任务也照样列出——收网删的是监听配置，不是已经采到的证据。
 */
evidenceApi.get('/records/groups', (_req, res) => {
  const tally = new Map();
  for (const row of all(EVENT_TALLY)) {
    const bucket = tally.get(row.token) ?? {};
    bucket[row.kind] = row.n;
    tally.set(row.token, bucket);
  }
  const records = all('SELECT kind,site_id,task_id,token,submitted_at,last_seen_at,created_at,form_json FROM records');

  const sites = all('SELECT s.*, t.name AS template_name FROM web_sites s LEFT JOIN web_templates t ON t.id=s.template_id ORDER BY s.created_at DESC');
  const tasks = all('SELECT * FROM mail_tasks ORDER BY created_at DESC');
  const recipients = new Map(all('SELECT task_id,COUNT(*) AS n FROM mail_recipients GROUP BY task_id').map((r) => [r.task_id, r.n]));

  const webGroups = new Map(
    sites.map((site) => [
      site.id,
      newGroup({
        group: 'web',
        id: site.id,
        label: site.template_name || '（假登录页已删除）',
        address: site.domain || `${site.listen_ip}:${site.listen_port}`,
        listen_port: site.listen_port,
        status: site.status,
        // 看板要说"现在还在不在服务"，库里的 status 只是意图，真实监听状态取注册表
        running: isRunning(site.id),
        exists: true,
        created_at: site.created_at,
      }),
    ])
  );
  const mailGroups = new Map(
    tasks.map((task) => [
      task.id,
      newGroup({
        group: 'mail',
        id: task.id,
        label: task.title,
        subject: task.subject,
        status: task.status,
        dry_run: task.dry_run,
        recipients: recipients.get(task.id) ?? 0,
        exists: true,
        created_at: task.created_at,
      }),
    ])
  );
  const unassigned = newGroup({ group: 'none', id: null, label: '未归属记录', exists: false, created_at: null });

  for (const record of records) {
    const isWebPage = record.kind === 'web' && record.site_id;
    if (record.task_id) {
      let group = mailGroups.get(record.task_id);
      if (!group) {
        group = newGroup({
          group: 'mail',
          id: record.task_id,
          label: '（钓鱼邮件任务已删除）',
          subject: null,
          status: 'deleted',
          dry_run: null,
          recipients: 0,
          exists: false,
          created_at: record.created_at,
        });
        mailGroups.set(record.task_id, group);
      }
      accumulate(group, record, tally);
    }
    if (isWebPage) {
      let group = webGroups.get(record.site_id);
      if (!group) {
        group = newGroup({
          group: 'web',
          id: record.site_id,
          label: '（钓鱼网站已删除）',
          address: null,
          listen_port: null,
          status: 'deleted',
          exists: false,
          created_at: record.created_at,
        });
        webGroups.set(record.site_id, group);
      }
      accumulate(group, record, tally);
    }
    // 一条记录只要归进过任何一个载体就不再算无主
    if (!record.task_id && !isWebPage) accumulate(unassigned, record, tally);
  }

  const web = [...webGroups.values()].sort(byHot).map(seal);
  const mail = [...mailGroups.values()].sort(byHot).map(seal);
  ok(res, {
    web,
    mail,
    unassigned: seal(unassigned),
    totals: {
      web_groups: web.length,
      mail_groups: mail.length,
      terminals: records.length,
      submitted: records.filter((r) => r.submitted_at).length,
    },
  });
});

evidenceApi.get('/records/:id/screenshot', (req, res) => {
  const row = get('SELECT * FROM records WHERE id=?', [req.params.id]);
  if (!row?.screenshot_path || !fs.existsSync(row.screenshot_path)) return notFound(res, '截图不存在');
  return res.sendFile(row.screenshot_path);
});

evidenceApi.get('/records/:id', (req, res) => {
  const row = get('SELECT * FROM records WHERE id=?', [req.params.id]);
  if (!row) return notFound(res, '记录不存在');
  const site = row.site_id ? get('SELECT * FROM web_sites WHERE id=?', [row.site_id]) : null;
  const task = row.task_id ? get('SELECT * FROM mail_tasks WHERE id=?', [row.task_id]) : null;
  const template = site ? get('SELECT name FROM web_templates WHERE id=?', [site.template_id]) : null;
  ok(res, {
    ...toView(row),
    context: {
      kind: row.kind,
      site_id: row.site_id,
      task_id: row.task_id,
      task_title: task?.title ?? null,
      template_name: template?.name ?? null,
      token: row.token,
    },
    events: all('SELECT * FROM events WHERE token=? ORDER BY created_at', [row.token]),
    screenshot_url: row.screenshot_path ? `/api/records/${row.id}/screenshot` : null,
  });
});

evidenceApi.delete('/records/:id', (req, res) => {
  const row = get('SELECT * FROM records WHERE id=?', [req.params.id]);
  if (!row) return notFound(res, '记录不存在');
  run('DELETE FROM records WHERE id=?', [req.params.id]);
  writeAudit(req, 'evidence.delete', {
    targetKind: 'record',
    targetId: row.id,
    // 删的是证据本身，留一份足够复原说明的摘要：类型、归属、有没有已提交
    detail: { kind: row.kind, target_email: row.target_email, site_id: row.site_id, task_id: row.task_id, submitted: Boolean(row.submitted_at) },
  });
  ok(res, true);
});

const CSV_HEADER = ['记录UUID', '令牌', '目标邮箱', '站点/任务', '首次打开', '提交时间', '停留秒', 'IP', '系统', '浏览器', '采集内容'];
const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

/** 取证导出：一次导出的每行就是一个终端的完整上钩轨迹 */
evidenceApi.get('/reports/export', (req, res) => {
  const kind = req.query.kind || 'web';
  const rows = all('SELECT * FROM records WHERE kind=? ORDER BY created_at DESC', [kind]);
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const row of rows) {
    const feature = parseJson(row.feature_json) || {};
    const flat = flattenHistory(row.form_json).map((f) => `${f.name}=${f.value}`).join(' | ');
    lines.push(
      [
        row.id,
        row.token,
        row.target_email,
        row.site_id || row.task_id,
        row.first_seen_at,
        row.submitted_at,
        row.dwell_seconds,
        feature.ipv4,
        feature.os,
        feature.browser,
        flat,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="awarelab-${kind}-evidence.csv"`);
  // 导出等于把本机敏感数据交出去：通知记录里留一条动作流水，审计表里留一条"谁导的"
  run(
    'INSERT INTO push_logs (id,channel,event_kind,request,response,ok,created_at) VALUES (?,?,?,?,?,?,?)',
    [crypto.randomUUID(), 'export', 'csv_export', JSON.stringify({ kind, rows: rows.length, ip: clientIp(req) }), `awarelab-${kind}-evidence.csv`, 1, nowIso()]
  );
  writeAudit(req, 'evidence.export', { targetKind: 'report', targetId: kind, detail: { kind, rows: rows.length } });
  res.send('﻿' + lines.join('\r\n'));
});

/**
 * 操作审计：只读，按时间倒序。
 * 这张表没有更新与删除接口是刻意的——审计一旦可以事后修饰就不再是审计。
 */
evidenceApi.get('/audit-logs', (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.action) {
    cond.push('action=?');
    params.push(req.query.action);
  }
  if (req.query.actor) {
    cond.push('actor=?');
    params.push(req.query.actor);
  }
  const { page, page_size } = paginate(req.query);
  const data = pagedRows('audit_logs', cond.length ? 'WHERE ' + cond.join(' AND ') : '', params, page, page_size);
  ok(res, { ...data, rows: data.rows.map((row) => ({ ...row, detail: parseJson(row.detail) })) });
});
