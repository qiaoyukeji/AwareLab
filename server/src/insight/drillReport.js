/**
 * 一次演练的汇总与交付报告（insight 层）：以 authorizations 的一行为锚点，聚合站点、任务、记录、教育处置成甲方能看的结论。
 * 读者是甲方，采集到的口令一律掩码、邮箱部分掩码；报告不出现后台随机路径、管理端口、SMTP 凭据、机器人令牌。
 * 所有插值过 escapeHtml。分母为 0 一律回 0；records.kind='mail' 按站点或任务取并集；历史行 disposition=NULL 与 'new' 同档。
 */
import { all, get, parseJson } from '../platform/storage/rows.js';
import { flattenHistory } from '../capture/evidenceStore.js';
import { probe } from '../capture/uaProbe.js';
import { effectiveStatus } from '../security/mandate.js';
import { countSecretFields, maskEmail, maskHistory } from '../security/secretMask.js';

/** 处置状态中文标签：报告、CSV 与前端筛选共用同一套词 */
export const DISPOSITION_LABEL = {
  new: '未处置',
  contacted: '已联系',
  educated: '已教育',
  closed: '已关闭',
};

/** 比率口径与 insightApi 一致：百分数、一位小数、分母 0 回 0 */
const rate = (numerator, denominator) => (denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0);

/** HTML 转义：报告是会被浏览器打开的文件，库里来的文本先过这一道 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 报告里印出来的时间：本地时区、到秒。
 * 库里存的是带 Z 的 UTC，直接印到纸上甲方会问「02:13 是几点」，尤其演练窗口本身是按本地时间登记的。
 * CSV 仍留原始 ISO（要排序、要进 Excel），只有这份会被打印的报告做成人话。
 */
function stamp(value) {
  const ms = Date.parse(value ?? '');
  if (!Number.isFinite(ms)) return value ? String(value) : '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 交付件里出现 active / open / sent 这种枚举原值，甲方读不懂还要回头问；与管理界面 STATUS_LABEL 同一套词
const AUTH_STATE_LABEL = { active: '生效中', pending: '未开始', expired: '已过期', revoked: '已吊销', missing: '无' };
const SITE_STATE_LABEL = { open: '已开启', closed: '已关闭' };
const TASK_STATE_LABEL = { draft: '草稿', sending: '发送中', sent: '已发送', partial: '部分失败', failed: '全部失败' };
const label = (map, value) => map[value] ?? String(value ?? '—');

/**
 * 处置状态归一：NULL/空串/脏值一律按 new，与 v6 迁移语义一致。
 * 导出给 evidenceApi 的读侧与筛选侧共用：两处各写一遍会出现看板算未处置、下钻筛不出来的差 1 事故。
 */
export function dispositionOf(row) {
  const value = row?.disposition;
  return DISPOSITION_LABEL[value] ? value : 'new';
}

/**
 * 教育覆盖率：一次演练结束时能拿出教了多少人。
 * coverage_rate=(educated+closed)/total（closed 是教育完成且归档，算进覆盖率）；
 * handled_rate=(contacted+educated+closed)/total 只回答有没有人管过。total=0 时两个比率都是 0。
 */
export function educationCoverage(records) {
  const buckets = { total: records.length, new: 0, contacted: 0, educated: 0, closed: 0 };
  for (const row of records) buckets[dispositionOf(row)] += 1;
  return {
    ...buckets,
    coverage_rate: rate(buckets.educated + buckets.closed, buckets.total),
    handled_rate: rate(buckets.contacted + buckets.educated + buckets.closed, buckets.total),
  };
}

/**
 * 把一次授权的原始数据一次捞齐（内部用）：站点、模板、任务、收件人、记录；授权不存在返回 null。
 * 记录取并集（site_id 在站点集合 OR task_id 在任务集合）；整表捞内存过滤是为了同一套口径只写一遍，避免两处统计差 1。
 */
function collect(authorizationId) {
  const auth = get('SELECT * FROM authorizations WHERE id=?', [authorizationId]);
  if (!auth) return null;
  const sites = all('SELECT * FROM web_sites WHERE authorization_id=? ORDER BY created_at', [authorizationId]);
  const tasks = all('SELECT * FROM mail_tasks WHERE authorization_id=? ORDER BY created_at', [authorizationId]);
  const templates = all('SELECT id, name, type FROM web_templates');
  const siteIds = new Set(sites.map((s) => s.id));
  const taskIds = new Set(tasks.map((t) => t.id));

  // 收件人按任务 id 过滤：IN 列表来自本函数捞出的主键，不是外部输入，参数化后无注入面
  const recipients = taskIds.size
    ? all(`SELECT * FROM mail_recipients WHERE task_id IN (${[...taskIds].map(() => '?').join(',')})`, [...taskIds])
    : [];
  const records = all('SELECT * FROM records ORDER BY created_at').filter(
    (row) => (row.site_id && siteIds.has(row.site_id)) || (row.task_id && taskIds.has(row.task_id))
  );

  return { auth, sites, tasks, templates, recipients, records, siteIds, taskIds };
}

/**
 * 一次演练的汇总（JSON）：/insight/authorizations/:id/summary 的返回体，也是报告 HTML 的数据源。
 * 只读、无副作用、恒可计算，空授权返回全 0 不抛错。
 */
export function authorizationSummary(authorizationId) {
  const data = collect(authorizationId);
  if (!data) return null;
  const { auth, sites, tasks, templates, recipients, records } = data;

  const webRecords = records.filter((r) => r.kind === 'web');
  const mailRecords = records.filter((r) => r.kind === 'mail');
  const opened = webRecords.filter((r) => r.first_seen_at).length;
  const submitted = webRecords.filter((r) => r.submitted_at).length;

  const mailOpened = recipients.filter((r) => r.opened_at).length;
  const mailSubmitted = recipients.filter((r) => r.submitted_at).length;
  const mailSent = recipients.filter((r) => r.sent_at).length;

  // 时间跨度取记录+收件人两侧 created_at 极值：只看记录会漏掉发了信但没人点的那段时间
  const stamps = [
    ...records.map((r) => r.created_at),
    ...recipients.map((r) => r.created_at),
  ].filter(Boolean).sort();

  const fingerprints = webRecords.map((row) => {
    const feature = parseJson(row.feature_json) || {};
    return feature.os ? { os: feature.os, browser: feature.browser } : probe(feature['user-agent'] || '');
  });
  const countBy = (pick) => {
    const buckets = {};
    for (const item of fingerprints) {
      const key = pick(item);
      buckets[key] = (buckets[key] || 0) + 1;
    }
    return buckets;
  };

  // 总目标数与总中招数按终端去重（对外口径，别改回简单相加）。
  // 一次演练常同时有邮件链与网页链，同一个人从邮件点进钓鱼站时 mail_recipients 与 records 各留一行，
  // 直接相加会出 3 个目标、7 人中招、233% 这种没法解释的数字。
  // 身份键优先用 token：收件人令牌会带到采集记录上，同一个人两侧算出同一个键；没 token 才退回邮箱。
  const identityOf = (row) => row.token || `email:${row.email ?? row.target_email ?? ''}`;
  // 分母：登记过的收件人 + 打开过钓鱼页的网页侧终端（没有投递环节那部分人）
  const targetIds = new Set([...recipients.map(identityOf), ...webRecords.filter((r) => r.first_seen_at).map(identityOf)]);
  // 分子：两侧各自真提交过的终端，合到一个集合去重
  const hookedIds = new Set([
    ...recipients.filter((r) => r.submitted_at).map(identityOf),
    ...webRecords.filter((r) => r.submitted_at).map(identityOf),
  ]);
  const targets = targetIds.size;
  const hooked = hookedIds.size;

  return {
    authorization: {
      id: auth.id,
      scope: auth.scope,
      contact: auth.contact,
      start_at: auth.start_at,
      end_at: auth.end_at,
      status: auth.status,
      // 库里 status 只说有没有被吊销；报告要说「此刻还算不算有效」，那一档由时间窗口现算
      effective: effectiveStatus(auth),
      // 授权名单是数组还是 JSON 串看写入侧，这里统一成数组
      allowed_hosts: parseJson(auth.allowed_hosts, []) || [],
      pledge: auth.pledge,
      note: auth.note,
      created_at: auth.created_at,
    },
    window: {
      first_at: stamps[0] || null,
      last_at: stamps[stamps.length - 1] || null,
      // 跨度按极值差算天数向上取整：同一天开始结束也显示 1 天
      days: stamps.length ? Math.max(1, Math.ceil((Date.parse(stamps[stamps.length - 1]) - Date.parse(stamps[0])) / 86400000)) : 0,
    },
    web: {
      sites: sites.length,
      opened,
      not_submitted: Math.max(0, opened - submitted),
      submitted,
      // 网页侧转化率分母是打开数：没有投递环节，与 insightApi 同口径
      conversion: rate(submitted, opened),
      records: webRecords.length,
      mail_records: mailRecords.length,
    },
    mail: {
      tasks: tasks.length,
      recipients: recipients.length,
      sent: mailSent,
      opened: mailOpened,
      submitted: mailSubmitted,
      // 邮件侧分母是登记收件人数：打开依赖图片信标不可靠，用投递数得保守中招率
      conversion: rate(mailSubmitted, recipients.length),
      real_send_tasks: tasks.filter((t) => t.dry_run === 0).length,
    },
    overall: {
      targets,
      hooked,
      // 夹到 100：去重后正常不会超，脏数据（有 submitted_at 无 first_seen_at 的历史行）能让分子多出一个不在分母的终端
      hook_rate: Math.min(100, rate(hooked, targets)),
      record_total: records.length,
    },
    education: educationCoverage(records),
    devices: { os_buckets: countBy((f) => f.os), browser_buckets: countBy((f) => f.browser) },
    sites: sites.map((site) => {
      const ofSite = webRecords.filter((r) => r.site_id === site.id);
      return {
        id: site.id,
        listen_port: site.listen_port,
        domain: site.domain,
        status: site.status,
        template_name: templates.find((t) => t.id === site.template_id)?.name ?? '',
        opened: ofSite.filter((r) => r.first_seen_at).length,
        submitted: ofSite.filter((r) => r.submitted_at).length,
      };
    }),
    tasks: tasks.map((task) => {
      const ofTask = recipients.filter((r) => r.task_id === task.id);
      return {
        id: task.id,
        title: task.title,
        subject: task.subject,
        status: task.status,
        dry_run: Boolean(task.dry_run),
        recipients: ofTask.length,
        sent: ofTask.filter((r) => r.sent_at).length,
        opened: ofTask.filter((r) => r.opened_at).length,
        submitted: ofTask.filter((r) => r.submitted_at).length,
      };
    }),
  };
}

/**
 * 把值里像邮箱的片段也部分掩码，只用于交付件（报告与交付 CSV）。
 * 掩码判定看字段名，而访客常把邮箱填进 username/账号这类非敏感字段名里，只看 target_email 一列红线只盖住半边。
 * 口径与 maskEmail 一致（宁宽勿窄）；管理面读侧与取证导出仍按字段名判定，操作员要靠原文找本人做教育。
 */
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function maskEmailInValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(EMAIL_LIKE, (hit) => maskEmail(hit));
}

/**
 * 典型样本（报告用）：挑几条最有代表性的上钩记录，口令掩码、邮箱部分掩码。
 * 选样优先已提交的行、按提交时间倒序取最新几条；刻意不随机抽样，报告要能复现，随机样本每次导出不一样。
 * fields 里 secret=true 的值已是掩码；secret_count 只报凭据字段个数不报字段名（字段名本身就能说明钓的是口令还是银行卡）。
 */
export function reportSamples(authorizationId, limit = 5) {
  const data = collect(authorizationId);
  if (!data) return [];
  const picked = data.records
    .filter((row) => row.submitted_at)
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)))
    .slice(0, Math.max(1, Number(limit) || 5));

  return picked.map((row) => {
    // 同名字段可能多次提交，只展示最后一次的值
    const latest = new Map();
    for (const item of maskHistory(flattenHistory(row.form_json))) latest.set(item.name, item);
    const fields = [...latest.values()].map(({ name, value, secret }) => ({ name, value: secret ? value : maskEmailInValue(value), secret }));
    return {
      at: row.submitted_at,
      channel: row.kind === 'mail' ? '钓鱼邮件' : '钓鱼网页',
      target: maskEmail(row.target_email),
      dwell: row.dwell_seconds ?? null,
      fields,
      secret_count: countSecretFields(Object.fromEntries(latest)),
    };
  });
}

/**
 * 演练报告 CSV（按授权导出）：一行一个终端，凭据列一律掩码。授权不存在返回 null。
 * 与 /reports/export 分工：那份是取证导出（操作员自用、明文、双留痕），这份是交付导出（给甲方、可能进附件），所以口令掩码、邮箱部分掩码。
 * 两份都存在是刻意的：把交付物做成明文等于让最容易被转发的那一份带上全部凭据。
 */
export function buildReportCsv(authorizationId) {
  const data = collect(authorizationId);
  if (!data) return null;
  const header = ['记录UUID', '渠道', '终端标识(掩码)', '站点/任务', '首次打开', '提交时间', '停留秒', '处置状态', '采集字段数', '采集内容(凭据已掩码)'];
  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  // 载体要写成甲方读得懂的话：给一串 UUID 时对不上是哪张网、哪封信，第一列的记录 UUID 已经够做对照键
  const carrierName = new Map();
  for (const site of data.sites) carrierName.set(site.id, `钓鱼网页 · 端口 ${site.listen_port}${site.domain ? ` · ${site.domain}` : ''}`);
  for (const task of data.tasks) carrierName.set(task.id, `钓鱼邮件 · ${task.title}`);
  // 从邮件点进网页的那条两个归属都有，两段都印才讲得清这条链；载体已删就退回原 id，不编一个名字出来
  const carrierOf = (row) =>
    [carrierName.get(row.site_id), carrierName.get(row.task_id)].filter(Boolean).join(' + ') || row.site_id || row.task_id || '';
  const lines = [header.map(cell).join(',')];
  for (const row of data.records) {
    const flat = maskHistory(flattenHistory(row.form_json));
    const latest = new Map();
    for (const item of flat) latest.set(item.name, item);
    // 值已在 maskHistory 换过掩码，这里再掩一遍邮箱形状片段（访客常把邮箱填进 username 一类字段名），拼成名=值横向一格
    const rendered = [...latest.values()].map((item) => `${item.name}=${item.secret ? item.value : maskEmailInValue(item.value)}`).join(' | ');
    lines.push(
      [
        row.id,
        row.kind === 'mail' ? '钓鱼邮件' : '钓鱼网页',
        maskEmail(row.target_email),
        carrierOf(row),
        row.first_seen_at || '',
        row.submitted_at || '',
        row.dwell_seconds ?? '',
        DISPOSITION_LABEL[dispositionOf(row)],
        latest.size,
        rendered,
      ]
        .map(cell)
        .join(',')
    );
  }
  // 行首 \ufeff 是 BOM（防 Excel 中文乱码），行尾 \r\n 是 RFC 4180 口径，与 /reports/export 完全一致
  return '\ufeff' + lines.join('\r\n');
}

/**
 * 甲方级演练报告（HTML，可直接打印/另存 PDF）：授权不存在返回 null。
 * 样式全内联不引外部 CSS/字体/CDN：这份文件要在甲方内网离线打开，外部引用在断网环境会变空白页。
 * @media print 去掉背景色、把分页断在章节标题前，另存 PDF 不把表格切成两半。
 */
export function buildReportHtml(authorizationId, options = {}) {
  const summary = authorizationSummary(authorizationId);
  if (!summary) return null;
  const samples = reportSamples(authorizationId, options.samples ?? 5);
  const a = summary.authorization;
  const hosts = Array.isArray(a.allowed_hosts) ? a.allowed_hosts : [];

  // 结论建议按数字套话术而非模型生成：报告要可复现，同一份数据两次导出必须一字不差
  const conclusions = [];
  if (summary.overall.hook_rate >= 30) {
    conclusions.push(`整体中招率 ${summary.overall.hook_rate}%，明显偏高：建议把钓鱼识别纳入下一轮全员必修，并对已中招部门做定向复训。`);
  } else if (summary.overall.hook_rate >= 10) {
    conclusions.push(`整体中招率 ${summary.overall.hook_rate}%，处于常见区间：建议保持季度演练节奏，重点关注新入职与外包人员。`);
  } else if (summary.overall.targets > 0) {
    conclusions.push(`整体中招率 ${summary.overall.hook_rate}%，处于较低水平：现有意识培训有效，建议维持并按年度复演。`);
  } else {
    conclusions.push('本轮尚无终端命中，请确认专属链接是否已实际投放、演练窗口是否已开始。');
  }
  if (summary.education.coverage_rate < 100 && summary.education.total > 0) {
    conclusions.push(
      `教育覆盖率 ${summary.education.coverage_rate}%（已完成教育 ${summary.education.educated + summary.education.closed} / 上钩 ${summary.education.total}），尚有 ${summary.education.new + summary.education.contacted} 条未完成闭环，建议在结案前补齐。`
    );
  }
  if (summary.mail.real_send_tasks > 0) {
    conclusions.push(`本轮包含 ${summary.mail.real_send_tasks} 个真实外发任务（已关闭沙箱），发信范围与授权名单的对应关系请一并归档。`);
  }
  conclusions.push('本报告中所有采集到的凭据均已掩码，明文仅保存在演练方本地取证库中，并按配置的保留期到期清理。');

  const rowsOf = (items, cols) =>
    items.length
      ? `<table><thead><tr>${cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead><tbody>${items
          .map((item) => `<tr>${cols.map((c) => `<td>${escapeHtml(c.pick(item))}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`
      : '<p class="empty">本轮无数据。</p>';

  const bucketsOf = (buckets) =>
    Object.entries(buckets || {})
      .sort((x, y) => y[1] - x[1])
      .map(([name, n]) => `<li>${escapeHtml(name)}：<b>${n}</b></li>`)
      .join('') || '<li class="empty">无</li>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>安全意识演练报告 · ${escapeHtml(a.scope)}</title>
<style>
  body { font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif; margin: 0; padding: 32px 40px; color: #1f2933; background: #fff; line-height: 1.7; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #2f6f4e; }
  .sub { color: #616e7c; font-size: 13px; margin-bottom: 20px; }
  .grid { display: flex; flex-wrap: wrap; gap: 12px; }
  .card { flex: 1 1 150px; border: 1px solid #e4e7eb; border-radius: 8px; padding: 12px 14px; }
  .card .k { font-size: 12px; color: #7b8794; }
  .card .v { font-size: 22px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
  th, td { border: 1px solid #e4e7eb; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f5f7fa; font-weight: 600; }
  ul { margin: 6px 0 6px 20px; padding: 0; }
  .empty { color: #9aa5b1; font-size: 13px; }
  .note { background: #f5f7fa; border-left: 3px solid #2f6f4e; padding: 10px 14px; font-size: 13px; }
  .mask { font-family: monospace; letter-spacing: 1px; }
  footer { margin-top: 32px; font-size: 12px; color: #7b8794; border-top: 1px solid #e4e7eb; padding-top: 12px; }
  @media print {
    body { padding: 0; }
    h2 { page-break-after: avoid; }
    table, .card { page-break-inside: avoid; }
    .card { background: #fff !important; }
  }
</style>
</head>
<body>
<h1>安全意识演练报告</h1>
<div class="sub">演练范围：${escapeHtml(a.scope)}　|　授权窗口：${escapeHtml(stamp(a.start_at))} ~ ${escapeHtml(stamp(a.end_at))}　|　报告生成时间：${escapeHtml(stamp(new Date().toISOString()))}</div>

<h2>一、授权依据</h2>
<div class="note">
  本次演练在登记编号 <b>${escapeHtml(a.id)}</b> 的授权下开展，授权状态：${escapeHtml(label(AUTH_STATE_LABEL, a.effective))}。<br>
  授权方联系人：${escapeHtml(a.contact || '—')}<br>
  授权承诺原文：<i>${escapeHtml(a.pledge || '—')}</i><br>
  允许仿冒的域名/主机：${hosts.length ? hosts.map((h) => `<b>${escapeHtml(h)}</b>`).join('、') : '（未登记）'}
</div>

<h2>二、总体结果</h2>
<div class="grid">
  <div class="card"><div class="k">投放目标</div><div class="v">${summary.overall.targets}</div></div>
  <div class="card"><div class="k">命中终端</div><div class="v">${summary.overall.hooked}</div></div>
  <div class="card"><div class="k">整体中招率</div><div class="v">${summary.overall.hook_rate}%</div></div>
  <div class="card"><div class="k">教育覆盖率</div><div class="v">${summary.education.coverage_rate}%</div></div>
  <div class="card"><div class="k">演练跨度</div><div class="v">${summary.window.days} 天</div></div>
</div>
<p class="sub">投放目标口径：登记过的邮件收件人 + 打开过钓鱼网页的终端，按终端令牌去重（同一个人从邮件点进钓鱼网页只算一个）；命中终端为其中真正提交过凭据的数量，因此整体中招率不会超过 100%。</p>

<h2>三、钓鱼网页漏斗</h2>
<div class="grid">
  <div class="card"><div class="k">钓鱼网页数</div><div class="v">${summary.web.sites}</div></div>
  <div class="card"><div class="k">打开</div><div class="v">${summary.web.opened}</div></div>
  <div class="card"><div class="k">打开未提交</div><div class="v">${summary.web.not_submitted}</div></div>
  <div class="card"><div class="k">提交凭据</div><div class="v">${summary.web.submitted}</div></div>
  <div class="card"><div class="k">网页转化率</div><div class="v">${summary.web.conversion}%</div></div>
</div>
${rowsOf(summary.sites, [
  { label: '端口', pick: (s) => s.listen_port },
  { label: '仿冒域名', pick: (s) => s.domain || '（未绑定域名）' },
  { label: '页面素材', pick: (s) => s.template_name || '（素材已删除）' },
  // 这一列是站点配置档（开/关），不是监听器此刻活着没：授权一吊销监听就停，写「当前状态」会读成谎话
  { label: '配置状态', pick: (s) => label(SITE_STATE_LABEL, s.status) },
  { label: '打开', pick: (s) => s.opened },
  { label: '提交', pick: (s) => s.submitted },
])}

<h2>四、钓鱼邮件漏斗</h2>
<div class="grid">
  <div class="card"><div class="k">发送任务</div><div class="v">${summary.mail.tasks}</div></div>
  <div class="card"><div class="k">登记收件人</div><div class="v">${summary.mail.recipients}</div></div>
  <div class="card"><div class="k">已投递</div><div class="v">${summary.mail.sent}</div></div>
  <div class="card"><div class="k">已打开</div><div class="v">${summary.mail.opened}</div></div>
  <div class="card"><div class="k">提交凭据</div><div class="v">${summary.mail.submitted}</div></div>
  <div class="card"><div class="k">邮件转化率</div><div class="v">${summary.mail.conversion}%</div></div>
</div>
${rowsOf(summary.tasks, [
  { label: '任务', pick: (t) => t.title },
  { label: '主题', pick: (t) => t.subject },
  { label: '沙箱', pick: (t) => (t.dry_run ? '开启（未真实外发）' : '已关闭（真实外发）') },
  { label: '状态', pick: (t) => label(TASK_STATE_LABEL, t.status) },
  { label: '收件人', pick: (t) => t.recipients },
  { label: '打开', pick: (t) => t.opened },
  { label: '提交', pick: (t) => t.submitted },
])}
<p class="sub">邮件打开依赖图片信标，被邮件客户端或隐私代理拦截时不会记为打开，因此邮件转化率以登记收件人为分母，属保守估计。</p>

<h2>五、典型样本</h2>
${
  samples.length
    ? samples
        .map(
          (s, i) => `<p><b>样本 ${i + 1}</b>　${escapeHtml(stamp(s.at))}　${escapeHtml(s.channel)}　终端：<span class="mask">${escapeHtml(s.target)}</span>　停留 ${escapeHtml(s.dwell ?? '—')} 秒　凭据字段 ${s.secret_count} 个</p>
${rowsOf(s.fields, [
  { label: '字段', pick: (f) => f.name },
  { label: '采集值', pick: (f) => (f.secret ? '••••••••（已掩码）' : f.value) },
])}`
        )
        .join('')
    : '<p class="empty">本轮没有已提交凭据的样本。</p>'
}
<p class="sub">样本按提交时间倒序取最新若干条；凭据字段的值一律掩码，明文仅保存在演练方本地取证库中。</p>

<h2>六、终端环境分布</h2>
<div class="grid">
  <div class="card"><div class="k">操作系统</div><ul>${bucketsOf(summary.devices.os_buckets)}</ul></div>
  <div class="card"><div class="k">浏览器</div><ul>${bucketsOf(summary.devices.browser_buckets)}</ul></div>
</div>

<h2>七、教育闭环</h2>
<div class="grid">
  <div class="card"><div class="k">上钩记录</div><div class="v">${summary.education.total}</div></div>
  <div class="card"><div class="k">未处置</div><div class="v">${summary.education.new}</div></div>
  <div class="card"><div class="k">已联系</div><div class="v">${summary.education.contacted}</div></div>
  <div class="card"><div class="k">已教育</div><div class="v">${summary.education.educated}</div></div>
  <div class="card"><div class="k">已关闭</div><div class="v">${summary.education.closed}</div></div>
  <div class="card"><div class="k">教育覆盖率</div><div class="v">${summary.education.coverage_rate}%</div></div>
</div>
<p class="sub">教育覆盖率 =（已教育 + 已关闭）/ 上钩记录总数；「已联系但未完成教育」计入处置率（${summary.education.handled_rate}%）而不计入覆盖率。</p>

<h2>八、结论与建议</h2>
<ul>${conclusions.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>

<footer>
  本报告由 AwareLab 安全意识演练平台按授权 ${escapeHtml(a.id)} 的数据自动生成。<br>
  平台仅用于授权范围内的安全意识演练：不做反溯源与免杀、不把采集到的凭据转发给任何第三方。<br>
  报告内含员工邮箱的部分掩码形式与终端环境信息，请按授权方的数据管理要求流转与销毁。
</footer>
</body>
</html>`;
}
