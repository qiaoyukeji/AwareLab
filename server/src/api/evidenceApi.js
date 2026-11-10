/**
 * 取证管理面：上钩记录、终端事件、操作审计、外发流水，挂在 requireSession 下全部要会话。
 * 凭据字段默认掩码，明文只走 POST /records/:id/reveal；/records/groups 的分组口径必须与 /records 的过滤一致。
 */
import express from 'express';
import fs from 'node:fs';
import { all, get, nowIso, parseJson, pagedRows, run } from '../platform/storage/rows.js';
import { ok, badRequest, notFound, paginate } from '../platform/net/envelope.js';
import { clientIp } from '../platform/net/clientIp.js';
import { flattenHistory } from '../capture/evidenceStore.js';
import { isRunning } from '../capture/siteRegistry.js';
import { writeAudit } from '../security/audit.js';
import { isSecretField, maskHistory } from '../security/secretMask.js';
import { isAdmin, ownerClause, ownsRecord, viewerId } from '../security/scope.js';
import { requireAdmin } from '../security/session.js';
import { DISPOSITION_LABEL, dispositionOf, educationCoverage } from '../insight/drillReport.js';

export const evidenceApi = express.Router();

/**
 * 列表与详情只暴露归一化采集历史 [{name, value, at, secret}]：老库 record_content 与新库 fields 在这里汇成同一形状，form_json 与 form 是协议 v2 的同一份数据。
 * 凭据字段在这里就换成掩码，看明文只走 POST /records/:id/reveal 并写 record.secret_reveal 审计；目标邮箱不掩，处置流程要靠它找到本人。
 */
function toView(row) {
  const history = maskHistory(flattenHistory(row.form_json));
  const disposition = dispositionOf(row);
  return {
    ...row,
    form_json: history,
    form: history,
    feature: parseJson(row.feature_json),
    submitted: Boolean(row.submitted_at),
    disposition,
    disposition_label: DISPOSITION_LABEL[disposition],
    secret_count: new Set(history.filter((f) => f.secret).map((f) => f.name)).size,
  };
}

/**
 * 记录归属条件：records 没有 owner_id，归属沿 site_id / task_id 追到站点与邮件任务。
 * 管理员不加条件；普通用户只认自己名下站点或任务产生的记录；会话缺 user_id 时一条都不给。
 */
function recordScope(req) {
  if (isAdmin(req)) return { cond: null, params: [] };
  const uid = viewerId(req);
  if (!uid) return { cond: '1=0', params: [] };
  return {
    cond: "(site_id IN (SELECT id FROM web_sites WHERE owner_id=?) OR task_id IN (SELECT id FROM mail_tasks WHERE owner_id=?))",
    params: [uid, uid],
  };
}

/** 按 id 取记录并判归属；别人的记录按"不存在"回 404，避免用 403 泄漏 id 是否真实存在。 */
function ownedRecord(req, res, id = req.params.id) {
  const row = get('SELECT * FROM records WHERE id=?', [id]);
  if (!row || !ownsRecord(req, row, get)) {
    notFound(res, '记录不存在');
    return null;
  }
  return row;
}

/** 拼 /records 的过滤条件（WHERE 片段 + 占位参数 + 错误原因）；值一律走 ? 占位符绑定，LIKE 只给值包 %，error 非空时调用方直接 400 */
function buildFilter(query, req) {
  const cond = [];
  const params = [];
  // 归属条件放在最前：普通用户只能看到自己名下站点/任务产生的记录，管理员不加这一条
  const scope = recordScope(req);
  if (scope.cond) {
    cond.push(scope.cond);
    params.push(...scope.params);
  }
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
  // 未归属=既没挂钓鱼网站也没挂邮件任务的历史证据
  if (query.unassigned === '1') {
    cond.push("IFNULL(task_id,'')='' AND NOT (kind='web' AND IFNULL(site_id,'')<>'')");
  }
  if (query.submitted === '1') cond.push('submitted_at IS NOT NULL');
  if (query.submitted === '0') cond.push('submitted_at IS NULL');
  // 处置筛选的口径必须与 dispositionOf 一致：v6 之前老行的 disposition 是 NULL，'new' 要能把它们归一命中；不认识的枚举值直接 400，静默忽略会被当成筛出了空结果
  if (query.disposition) {
    if (!DISPOSITION_LABEL[query.disposition]) {
      return { where: '', params: [], error: `处置状态只支持 ${Object.keys(DISPOSITION_LABEL).join(' / ')}` };
    }
    cond.push(query.disposition === 'new' ? "(IFNULL(disposition,'')='' OR disposition='new')" : 'disposition=?');
    if (query.disposition !== 'new') params.push(query.disposition);
  }
  if (query.keyword) {
    cond.push('(target_email LIKE ? OR token LIKE ?)');
    const like = `%${query.keyword}%`;
    params.push(like, like);
  }
  return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', params, error: null };
}

/** GET /records — 上钩记录分页列表，过滤见 buildFilter；每行过 toView，凭据字段已是掩码，原始 JSON 串不外抛 */
evidenceApi.get('/records', (req, res) => {
  const { where, params, error } = buildFilter(req.query, req);
  if (error) return badRequest(res, error);
  const { page, page_size } = paginate(req.query);
  const data = pagedRows('records', where, params, page, page_size);
  ok(res, { ...data, rows: data.rows.map((row) => toView(row)) });
});

/** 聚合每个令牌的各类动作次数，供 /records/groups 当计数料；token IS NOT NULL 让匿名事件不进分组，form_fill 是次数口径、与 submitted_at 那个比特不同 */
const EVENT_TALLY = `SELECT token,kind,COUNT(*) AS n FROM events
   WHERE token IS NOT NULL AND kind IN ('page_open','mail_open','form_fill','attachment_run')
   GROUP BY token,kind`;

/** 分组的空指标桶；_names 只在累加时去重字段名，_events 只让一个令牌的事件次数进组一次，出库前由 seal 一起摘掉 */
function newGroup(meta) {
  return {
    ...meta,
    terminals: 0,
    submitted: 0,
    unhandled: 0,
    page_opens: 0,
    mail_opens: 0,
    submits: 0,
    attachments: 0,
    field_names: [],
    last_seen_at: null,
    _names: new Set(),
    _events: new Set(),
  };
}

/** 把采集记录连同事件计数累进载体分组。submitted 数提交过的人数（记录上的比特），submits 数 form_fill 次数，反复上交时两者分开
 *  同一令牌在邮件链上可以同时有「邮件记录」和「网页记录」两条，事件是按令牌统计的，不锁一次就会把同一次打开数遍 */
function accumulate(group, record, tally) {
  group.terminals += 1;
  if (record.submitted_at) group.submitted += 1;
  if (dispositionOf(record) === 'new') group.unhandled += 1;
  if (!group._events.has(record.token)) {
    group._events.add(record.token);
    const counts = tally.get(record.token) ?? {};
    group.page_opens += counts.page_open ?? 0;
    group.mail_opens += counts.mail_open ?? 0;
    group.submits += counts.form_fill ?? 0;
    group.attachments += counts.attachment_run ?? 0;
  }
  // ISO-8601 UTC 串的字典序即时间序，直接比串省掉 Date 解析
  if (record.last_seen_at && record.last_seen_at > (group.last_seen_at ?? '')) group.last_seen_at = record.last_seen_at;
  for (const field of flattenHistory(record.form_json)) group._names.add(field.name);
}

/** 有上钩的排前面，同热度按最近活动、再按创建时间倒序 */
function byHot(a, b) {
  return (
    b.submitted - a.submitted ||
    b.terminals - a.terminals ||
    String(b.last_seen_at ?? '').localeCompare(String(a.last_seen_at ?? '')) ||
    String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  );
}

/** 封桶出库：摘掉聚合期的两个 Set，field_names 截前 8 个；conversion 是提交人数/终端数的百分数，保一位小数免得浮点尾巴上界面 */
function seal(group) {
  const rest = { ...group };
  const names = rest._names;
  delete rest._names;
  delete rest._events;
  return { ...rest, field_names: [...names].slice(0, 8), conversion: group.terminals ? Math.round((group.submitted / group.terminals) * 1000) / 10 : 0 };
}

/**
 * GET /records/groups — 按载体分组的全量看板：网页组=kind='web' 且 site_id 命中，邮件组=task_id 命中（邮件打开与后续网页提交同属一条链）。
 * 分组口径必须与 /records 的过滤一致，看板上的数字点进去就是那一屏；已删除的站点与任务也照样列组，收网删的是监听配置不是已采到的证据。
 */
evidenceApi.get('/records/groups', (req, res) => {
  const scope = recordScope(req);
  // 长表先聚成 {token:{kind:n}}，后面按令牌查计数 O(1)
  const tally = new Map();
  for (const row of all(EVENT_TALLY)) {
    const bucket = tally.get(row.token) ?? {};
    bucket[row.kind] = row.n;
    tally.set(row.token, bucket);
  }
  // 只取聚合要的列，整行会把 feature_json 等大字段一起背回来；归属条件与 /records 同一口径，
  // 否则看板会把别人的站点列成零组、点进去却是空的
  const records = all(
    `SELECT kind,site_id,task_id,token,submitted_at,last_seen_at,created_at,disposition,form_json FROM records${scope.cond ? ` WHERE ${scope.cond}` : ''}`,
    scope.params
  );

  // 站点 LEFT JOIN 模板：模板可能已删，删了也要列组；任务全列。两者都按归属裁一遍
  const siteScope = ownerClause(req, 's');
  const taskScope = ownerClause(req, 'mail_tasks');
  const sites = all(
    `SELECT s.*, t.name AS template_name FROM web_sites s LEFT JOIN web_templates t ON t.id=s.template_id WHERE 1=1${siteScope.sql} ORDER BY s.created_at DESC`,
    siteScope.params
  );
  const tasks = all(`SELECT * FROM mail_tasks WHERE 1=1${taskScope.sql} ORDER BY created_at DESC`, taskScope.params);
  // 收件人总数按任务 GROUP BY：邮件组的分母，与上钩数两码事
  const recipients = new Map(all('SELECT task_id,COUNT(*) AS n FROM mail_recipients GROUP BY task_id').map((r) => [r.task_id, r.n]));

  // 现存载体先各开一个零组：没人上钩的网也要在看板上和"没这个载体"分得开
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
        // 库里的 status 只是运维意图，是否还在监听取注册表
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

  // 跨链双计是刻意的：带 task_id 的 kind='web' 记录（邮件点开后又进了网页）同时进邮件组和网页组，
  // 邮件打开到网站提交是同一条链；所以 totals.terminals 是记录数口径，同一人在两组里各占一个终端。
  for (const record of records) {
    const isWebPage = record.kind === 'web' && record.site_id;
    if (record.task_id) {
      let group = mailGroups.get(record.task_id);
      // 任务已删但证据还在：现开一个幽灵组接住，status='deleted'、exists=false
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
      // 同上：站点删了不抹证据，开幽灵组接住
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
    if (!record.task_id && !isWebPage) accumulate(unassigned, record, tally);
  }

  const web = [...webGroups.values()].sort(byHot).map(seal);
  const mail = [...mailGroups.values()].sort(byHot).map(seal);
  ok(res, {
    web,
    mail,
    unassigned: seal(unassigned),
    // totals 是全库口径（含跨链双计），不等于三块 terminals 相加
    totals: {
      web_groups: web.length,
      mail_groups: mail.length,
      terminals: records.length,
      submitted: records.filter((r) => r.submitted_at).length,
    },
    // 教育覆盖率与首页 /stats/home、演练报告同一个函数，三处数字必然对得上
    education: educationCoverage(records),
  });
});

/**
 * GET /records/:id/screenshot — 截图文件体出口，给 <img> 直接用；screenshot_path 取自库里落盘后写的本地路径，不是用户传的参数。
 * 先 fs.existsSync 再 sendFile，文件可能被手工清理；缺文件与记录不存在回同一句 404，不给枚举 id 留信号。
 */
evidenceApi.get('/records/:id/screenshot', (req, res) => {
  const row = ownedRecord(req, res);
  if (!row) return;
  if (!row.screenshot_path || !fs.existsSync(row.screenshot_path)) return notFound(res, '截图不存在');
  return res.sendFile(row.screenshot_path);
});

/**
 * GET /records/:id — 单条上钩记录全貌：toView 行 + 归属上下文 + 行为时间线 + 截图地址，只读。
 * context 里重复给一份 site_label 与 target_email；id 不存在回 404，不拿空对象谎报成功。
 */
evidenceApi.get('/records/:id', (req, res) => {
  const row = ownedRecord(req, res);
  if (!row) return;
  // 归属链逐跳回查：记录→站点/任务→模板；站点与任务都可能已删，查不到给 null 而不是报错
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
      site_label: site ? site.domain || `${site.listen_ip}:${site.listen_port}` : null,
      target_email: row.target_email ?? null,
      token: row.token,
    },
    // 时间线按令牌而非记录 id 取、时间正序：一次上钩的打开、填写、附件运行要串成完整轨迹
    events: all('SELECT * FROM events WHERE token=? ORDER BY created_at', [row.token]),
    screenshot_url: row.screenshot_path ? `/api/records/${row.id}/screenshot` : null,
  });
});

/**
 * DELETE /records/:id — 唯一会真删数据的写接口，只删 records 这一行，同令牌的事件行与截图文件不级联清理。
 * 先查再删，删不存在的 id 回 404；evidence.delete 进 audit_logs。
 */
evidenceApi.delete('/records/:id', (req, res) => {
  const row = ownedRecord(req, res);
  if (!row) return;
  run('DELETE FROM records WHERE id=?', [req.params.id]);
  writeAudit(req, 'evidence.delete', {
    targetKind: 'record',
    targetId: row.id,
    detail: { kind: row.kind, target_email: row.target_email, site_id: row.site_id, task_id: row.task_id, submitted: Boolean(row.submitted_at) },
  });
  ok(res, true);
});

/** 处置状态的四个合法值取自 insight/drillReport.js 的 DISPOSITION_LABEL */
const DISPOSITIONS = Object.keys(DISPOSITION_LABEL);
/** 处置备注是给自己看的短句，不是整份教育记录 */
const NOTE_LIMIT = 500;
/** 批量标记一次最多几条，挡住一次性 UPDATE 拖库 */
const BATCH_LIMIT = 500;

/** 处置写入请求体的形状检查，有问题返回给操作员直接看的中文原因（调用方包成 400）；note 只在给了时校验，不给是不动备注、给空串是清空备注 */
function dispositionProblem(body) {
  if (!DISPOSITION_LABEL[body?.disposition]) return `处置状态只支持 ${DISPOSITIONS.join(' / ')}`;
  if (body.note === undefined || body.note === null) return null;
  if (typeof body.note !== 'string') return '备注必须是字符串';
  if (body.note.length > NOTE_LIMIT) return `备注最多 ${NOTE_LIMIT} 字`;
  return null;
}

/**
 * PATCH /records/:id — 标记处置状态，回改完后的 toView（凭据仍是掩码）；UPDATE 只有 disposition/note 两列。
 * audit_logs 记 record.disposition 的 from→to；400 枚举或备注不合法，404 记录不存在，先查再改。
 */
evidenceApi.patch('/records/:id', (req, res) => {
  const problem = dispositionProblem(req.body);
  if (problem) return badRequest(res, problem);
  const row = ownedRecord(req, res);
  if (!row) return;
  const from = dispositionOf(row);
  // 备注没给就保留原值，单条标记只改状态不清说明
  const note = req.body.note == null ? (row.note ?? null) : req.body.note;
  run('UPDATE records SET disposition=?, note=? WHERE id=?', [req.body.disposition, note, req.params.id]);
  writeAudit(req, 'record.disposition', {
    targetKind: 'record',
    targetId: row.id,
    // 只记状态迁移与备注有没有动：备注里可能写着员工姓名与谈话内容
    detail: { from, to: req.body.disposition, note_changed: req.body.note != null, kind: row.kind },
  });
  ok(res, toView(get('SELECT * FROM records WHERE id=?', [req.params.id])));
});

/**
 * POST /records/disposition — 批量标记处置状态，ids 去重后最多 BATCH_LIMIT 条；updated < requested 说明选到了已删记录。
 * IN 子句用占位符参数化；audit_logs 的 record.disposition_batch 要带迁移前的状态分布，批量没有逐条留痕，这是唯一可还原的信息。
 */
evidenceApi.post('/records/disposition', (req, res) => {
  const problem = dispositionProblem(req.body);
  if (problem) return badRequest(res, problem);
  const ids = req.body.ids;
  if (!Array.isArray(ids) || !ids.length) return badRequest(res, '请至少选择一条记录');
  if (ids.length > BATCH_LIMIT) return badRequest(res, `一次最多标记 ${BATCH_LIMIT} 条，请分批操作`);
  // 去重：跨页全选时同一个 id 可能被塞两次，IN 里重复值不出错但审计条数会虚高
  const unique = [...new Set(ids.map((id) => String(id)))];
  const placeholders = unique.map(() => '?').join(',');
  // 先查真实存在的行：既拿改前的状态分布，也能如实报告 updated < requested
  const found = all(`SELECT id, disposition FROM records WHERE id IN (${placeholders})`, unique);
  if (!found.length) return notFound(res, '所选记录都不存在');
  run(`UPDATE records SET disposition=? WHERE id IN (${placeholders})`, [req.body.disposition, ...found.map((r) => r.id)]);
  const from = {};
  for (const row of found) {
    const key = dispositionOf(row);
    from[key] = (from[key] ?? 0) + 1;
  }
  writeAudit(req, 'record.disposition_batch', {
    targetKind: 'record',
    targetId: req.body.disposition,
    detail: { to: req.body.disposition, requested: unique.length, updated: found.length, from },
  });
  ok(res, { requested: unique.length, updated: found.length, disposition: req.body.disposition });
});

/**
 * POST /records/:id/reveal — 查看已掩码字段明文的唯一放行口，明文只出现在这一次响应里，绝不回写库。
 * 凭据字段每次查看都写 audit_logs 的 record.secret_reveal，detail 带字段名供本机台账追责，与对外报告只报数量不报字段名（secretMask.js）不冲突。同名字段多次提交取最后一次的值。
 */
evidenceApi.post('/records/:id/reveal', (req, res) => {
  // 先认归属再谈字段：不是自己名下的记录，连"有没有这个字段"都不该回
  const row = ownedRecord(req, res);
  if (!row) return;
  const field = String(req.body?.field ?? '').trim();
  if (!field) return badRequest(res, '请指定要查看明文的字段名');
  // 读库里的原始 form_json 而不是 toView 的掩码副本，reveal 要的就是原值
  const hit = flattenHistory(row.form_json)
    .filter((item) => item.name === field)
    .pop();
  if (!hit) return notFound(res, '该记录没有这个字段');
  const secret = isSecretField(field);
  // 非凭据字段在列表里本就明文显示，为它写审计只是噪音
  if (secret) {
    writeAudit(req, 'record.secret_reveal', { targetKind: 'record', targetId: row.id, detail: { field, kind: row.kind } });
  }
  ok(res, { name: field, value: hit.value, secret });
});

// 列序与下面导出循环里拼的字段一一对应，改一处要改另一处
const CSV_HEADER = ['记录UUID', '令牌', '目标邮箱', '站点/任务', '首次打开', '提交时间', '停留秒', 'IP', '系统', '浏览器', '处置状态', '采集内容'];
/**
 * CSV 单元格转义：整体加引号、内部双引号翻倍、换行压成空格，免得值里的逗号冲散行结构；
 * 以 = + - @ 或制表符开头的值再前置一个单引号——Excel 会把这类单元格当公式执行，
 * 攻击者只要把「=HYPERLINK(...)」填进表单就能在操作员打开 CSV 时外带数据。
 */
const csvCell = (value) => {
  let text = String(value ?? '').replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

/**
 * GET /reports/export?kind=web|mail — 全量证据 CSV，每行一个终端的上钩轨迹，不分页；
 * text/csv + UTF-8 BOM + \r\n 行尾，不走 {code,data} 信封。
 * 凭据列保持明文：取证件是操作员自用、留在本机的，给甲方的交付导出（insight/drillReport.js）才掩码。
 * 明文导出因此双留痕：push_logs 记行数与操作 IP，audit_logs 记 evidence.export；kind 枚举校验挡住 Content-Disposition 注入。
 */
evidenceApi.get('/reports/export', (req, res) => {
  // 文件名直接由 kind 拼出，任意值能把字符塞进 Content-Disposition
  const kind = req.query.kind || 'web';
  if (kind !== 'web' && kind !== 'mail') return badRequest(res, '导出类型只支持 web（网页）或 mail（邮件）');
  // 导出同样按归属裁剪：普通用户只能导出自己名下站点/任务产生的记录，不能整库带走
  const scope = recordScope(req);
  const rows = all(
    `SELECT * FROM records WHERE kind=?${scope.cond ? ` AND ${scope.cond}` : ''} ORDER BY created_at DESC`,
    [kind, ...scope.params]
  );
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const row of rows) {
    // 特征列取三个已分类字段，UA 归类在采集落库时做过，导出不重算
    const feature = parseJson(row.feature_json) || {};
    // 同一终端反复上交的历史压平成"名=值"一格（竖线分隔），CSV 一行一终端
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
        DISPOSITION_LABEL[dispositionOf(row)],
        flat,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="awarelab-${kind}-evidence.csv"`);
  // push_logs 复用成外发行动流水：request 存导出参数与操作 IP，response 存文件名；此时 CSV 已成型，没有部分失败的语义，ok 写死 1
  run(
    'INSERT INTO push_logs (id,channel,event_kind,request,response,ok,created_at) VALUES (?,?,?,?,?,?,?)',
    [crypto.randomUUID(), 'export', 'csv_export', JSON.stringify({ kind, rows: rows.length, ip: clientIp(req) }), `awarelab-${kind}-evidence.csv`, 1, nowIso()]
  );
  writeAudit(req, 'evidence.export', { targetKind: 'report', targetId: kind, detail: { kind, rows: rows.length } });
  // 行首 \ufeff 是 BOM，防 Excel 把中文表头解成乱码；\r\n 是 CSV 约定，Windows Excel 按 LF 分行会糊成一坨
  res.send('﻿' + lines.join('\r\n'));
});

/**
 * GET /audit-logs — 操作审计只读、时间倒序；没有更新与删除接口是刻意的，事后能改的不叫审计。
 * action 精确匹配动作类别，actor 按操作人账号，page_size 由 paginate 钳到 200，detail 解成对象再回。
 */
evidenceApi.get('/audit-logs', requireAdmin, (req, res) => {
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
