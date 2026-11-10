// 统计与演练报告域：/stats/* 看板与大屏指标，/insight/authorizations/:id/* 单次演练的汇总与交付物。
// 读历史不是投放动作，不过授权门禁；交付物口令全掩码、邮箱部分掩码，看明文只走后台 reveal。
import express from 'express';
import { all, get, nowIso, parseJson } from '../platform/storage/rows.js';
import { ok, badRequest, notFound } from '../platform/net/envelope.js';
import { findActive } from '../security/mandate.js';
import { probe } from '../capture/uaProbe.js';
import { siteUrl } from '../capture/siteRegistry.js';
import { writeAudit } from '../security/audit.js';
import { requireAdmin } from '../security/session.js';
import { ownerClause, recordScopeClause } from '../security/scope.js';
import { authorizationSummary, buildReportCsv, buildReportHtml, educationCoverage } from '../insight/drillReport.js';

export const insightApi = express.Router();

const DAY_MS = 86400000; // 趋势曲线按日历日往前倒推的步长
const TREND_DAYS = 7; // 趋势窗口固定含今天的 7 天，看板与大屏曲线才可比
const BIGSCREEN_EVENT_LIMIT = 50; // 大屏滚动窗口条数，再多刷新画面发沉且统计意义不变

/** 报告样本条数钳位：默认 5、范围 1-20；每条都要读 form_json 再掩码，上限限制明文在本进程停留的时间。 */
function clampSamples(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(20, Math.round(n)));
}

/** 报告文件名只留 [A-Za-z0-9._-]；不用 scope 原文，它是操作员填的自由文本，带引号/分号直接拼进响应头会注入。 */
function reportFilename(req, ext) {
  const auth = get('SELECT scope FROM authorizations WHERE id=?', [req.params.id]);
  const safe = String(auth?.scope || req.params.id)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || String(req.params.id).slice(0, 8);
  return `awarelab-report-${safe}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

/** 通用分桶计数：按 pick(row) 取分组键累计条数，设备分布（系统/浏览器）都靠它 */
function countBy(rows, pick) {
  const buckets = {};
  for (const row of rows) {
    const key = pick(row);
    buckets[key] = (buckets[key] || 0) + 1;
  }
  return buckets;
}

/** 比率统一口径：百分数、保留一位小数（乘 1000 取整再除 10），浮点尾巴不出文件；分母 0 回 0，免得 NaN 污染整个首页 JSON。 */
const rate = (numerator, denominator) => (denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0);

/** 网页采集漏斗：opened=first_seen_at 有值、submitted=submitted_at 有值；not_submitted 用减法推出，三个数永远自洽。 */
function webStats(webRecords) {
  const opened = webRecords.filter((r) => r.first_seen_at).length;
  const submitted = webRecords.filter((r) => r.submitted_at).length;
  return { opened, not_submitted: opened - submitted, submitted };
}

/** 设备分布：os/browser 独立计数，识别不出落未知桶，两组总和都等于行数否则与上钩数对不上；特征列已带系统/浏览器就直读，历史数据只有 UA 原文时按现规则补算。 */
function deviceBuckets(webRecords) {
  const fingerprints = webRecords.map((r) => {
    const feature = parseJson(r.feature_json) || {};
    return feature.os ? { os: feature.os, browser: feature.browser } : probe(feature['user-agent'] || '');
  });
  return { os_buckets: countBy(fingerprints, (f) => f.os), browser_buckets: countBy(fingerprints, (f) => f.browser) };
}

// 7 天趋势按 first_seen_at 的 UTC 日历日（ISO 串前 10 位）分桶，从 6 天前排到今天；平台一律 UTC 存，转本机时区是前端的事。
// first_seen_at 为空的脏行匹配不上 day 串，只进总数不进曲线。
function trend(webRecords) {
  return trendOf(webRecords, 'first_seen_at', 'submitted_at');
}

/** 通用 7 日趋势：dateField 记"打开"、submitField 记"提交"；空日期补 0 行，曲线不断档。 */
function trendOf(rows, dateField, submitField) {
  const days = [];
  for (let offset = TREND_DAYS - 1; offset >= 0; offset--) {
    // 逐日生成日期串而不是聚合 GROUP BY：保证没有数据的日子里也补 0，曲线不断档
    const day = new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
    const ofDay = rows.filter((r) => String(r[dateField] || '').slice(0, 10) === day);
    days.push({
      date: day,
      opened: ofDay.length,
      submitted: ofDay.filter((r) => r[submitField]).length,
      not_submitted: ofDay.filter((r) => !r[submitField]).length,
    });
  }
  return days;
}

// ── 归属裁剪：看板、大屏、分屏读的都是站点/任务/记录三张表，普通用户只该看到自己建的那部分 ──────
// 三张表以前是整库读，等于把别人的钓到的东西一起摊在看板上；这里统一加 owner 条件，管理员不加。

/** 当前请求可见的站点；columns 用来只挑需要的列（大屏不下发 tls_key/tls_cert）。 */
function scopedSites(req, columns = '*') {
  const scope = ownerClause(req, 'web_sites');
  return all(`SELECT ${columns} FROM web_sites WHERE 1=1${scope.sql}`, scope.params);
}

/** 当前请求可见的邮件任务（新的在前，与列表页一致）。 */
function scopedTasks(req, columns = '*') {
  const scope = ownerClause(req, 'mail_tasks');
  return all(`SELECT ${columns} FROM mail_tasks WHERE 1=1${scope.sql} ORDER BY created_at DESC`, scope.params);
}

/** 当前请求可见的上钩记录；extra 拼在归属条件之后（如 " AND kind='web'"），值由调用方用常量给。 */
function scopedRecords(req, columns = '*', extra = '') {
  const scope = recordScopeClause(req, 'records');
  return all(`SELECT ${columns} FROM records WHERE 1=1${scope.sql}${extra}`, scope.params);
}

/**
 * 邮件漏斗。转化率分母用登记收件人数而非打开数：打开依赖图片信标，容易被邮件客户端拦截，
 * 用投递数算出来的是保守值。网页侧没有投递环节，分母是打开数，两边口径不可混用。
 */
function mailStats(req) {
  const taskIds = scopedTasks(req, 'id').map((t) => t.id);
  // 收件人按所有任务 id IN 查询（占位符参数化）；没有任务时空集，不发 SQL
  const recipients = taskIds.length
    ? all(`SELECT * FROM mail_recipients WHERE task_id IN (${taskIds.map(() => '?').join(',')})`, taskIds)
    : [];
  const opened = recipients.filter((r) => r.opened_at).length;
  const clicked = recipients.filter((r) => r.clicked_at).length;
  const submitted = recipients.filter((r) => r.submitted_at).length;
  return { recipients: recipients.length, opened, clicked, submitted, conversion: rate(submitted, recipients.length) };
}

// 首页/看板一次读齐：整屏指标从一个端点出，只读、无参数、恒 200。
// risk_score=100-网页转化率、夹到 0-100、一位小数；risk_level 红黄绿映射（>=90 安全 / >=70 需关注 / 否则高风险）；authorization 为 null 时顶栏提示先去登记授权。
// web_stats.conversion 分母是打开数，mail_stats 分母是登记收件人，口径不同不可混；education 是全库教育覆盖率。
insightApi.get('/stats/home', (req, res) => {
  // 三张表整捞后内存过滤：演练库量级（千行内）离慢查询还远，换口径只写一遍、不打一堆聚合 SQL
  const sites = scopedSites(req);
  const templates = all('SELECT id, name, type FROM web_templates');
  const webRecords = scopedRecords(req, '*', " AND kind='web'");
  const { opened, not_submitted, submitted } = webStats(webRecords);
  const conversion = rate(submitted, opened);
  // 100-92.9 在浮点里是 7.099...94，首页大屏会把尾巴显出来，过 rate 抹平；夹到 0-100 防脏行让转化率破 100、风险分变负
  const riskScore = Math.round(Math.max(0, Math.min(100, 100 - conversion)) * 10) / 10;

  ok(res, {
    basic: {
      running_sites: sites.filter((s) => s.status === 'open').length,
      listen_ports: [...new Set(sites.filter((s) => s.status === 'open').map((s) => s.listen_port))],
      web_template_count: templates.length,
      template_types: [...new Set(templates.map((t) => t.type))],
      risk_score: riskScore,
      risk_level: riskScore >= 90 ? '安全' : riskScore >= 70 ? '需关注' : '高风险',
      authorization: findActive()?.scope ?? null,
    },
    web_stats: { opened, not_submitted, submitted, conversion, total_records: webRecords.length },
    mail_stats: mailStats(req),
    education: educationOverview(req),
    ...deviceBuckets(webRecords),
    funnel: { opened, not_submitted, submitted },
    trend: trend(webRecords),
    site_overview: sites.map((site) => {
      const ofSite = webRecords.filter((r) => r.site_id === site.id);
      return {
        id: site.id,
        port: site.listen_port,
        status: site.status,
        // 模板被删后名字退空串：站点照样上看板（取证还在），历史站点不因素材缺失而消失
        template_name: templates.find((t) => t.id === site.template_id)?.name ?? '',
        opened: ofSite.length,
        submitted: ofSite.filter((r) => r.submitted_at).length,
      };
    }),
  });
});

// 大屏数据流：投屏轮询、给原始流水（与 /stats/home 的聚合分工不同）。sites 只挑 id/端口/域名/状态、不带 tls_key/tls_cert，records 不含 form_json。
// token/target_email 仍明文，本端点只在操作员本机/受控内网看、绝不对外暴露；LIMIT 拼的是代码常量、非用户输入。
insightApi.get('/stats/bigscreen', (req, res) => {
  const scope = recordScopeClause(req, 'records');
  ok(res, {
    events: all('SELECT * FROM events ORDER BY created_at DESC LIMIT ' + BIGSCREEN_EVENT_LIMIT),
    sites: scopedSites(req, 'id, listen_port, domain, status'),
    records: all(
      'SELECT id, kind, token, target_email, first_seen_at, submitted_at, dwell_seconds FROM records WHERE 1=1' +
        scope.sql +
        ' ORDER BY created_at DESC LIMIT ' +
        BIGSCREEN_EVENT_LIMIT,
      scope.params
    ),
  });
});

// 教育闭环概览：全部上钩记录的处置分布与教育覆盖率，看板与报告共用一套口径。
// 全库口径不按授权过滤，按授权维度的在 summary 里。
function educationOverview(req) {
  // 只取 disposition 一列：这张表带 form_json（凭据明文），算覆盖率不需要它，少捞一列就少一次把明文读进内存
  const rows = scopedRecords(req, 'disposition');
  return educationCoverage(rows);
}

// ── 观测大屏：一块总屏 + 每个钓鱼网站、每个发送任务各一块 ────────────────────────────
// 分屏与总屏共用同一批口径函数，"站点屏已提交之和 ≤ 总屏已提交"这类关系必须始终成立。

const SCREEN_FEED_LIMIT = 24; // 每块屏的实时流水窗口；投屏上再多也滚不过来

/** 站点在屏上的标题：素材名优先、其次域名、最后监听地址；素材被删也不让标题空着。 */
function siteTitleOf(site, templates) {
  const name = templates.find((t) => t.id === site.template_id)?.name;
  const host = site.domain || (site.listen_ip === '0.0.0.0' ? '127.0.0.1' : site.listen_ip);
  return name || `${host}:${site.listen_port}`;
}

/** 单个发送任务的邮件漏斗；分母是登记收件人数，与总屏 mail_stats 同一口径。 */
function taskMailStats(taskId) {
  const rows = all('SELECT sent_at, opened_at, clicked_at, submitted_at FROM mail_recipients WHERE task_id=?', [taskId]);
  const opened = rows.filter((r) => r.opened_at).length;
  const submitted = rows.filter((r) => r.submitted_at).length;
  return {
    recipients: rows.length,
    sent: rows.filter((r) => r.sent_at).length,
    opened,
    clicked: rows.filter((r) => r.clicked_at).length,
    submitted,
    conversion: rate(submitted, rows.length),
  };
}

/**
 * 组装一块屏。kind=all 取全库、site 只取该站点网页记录、task 只取该任务邮件与落地页记录。
 * 不返回 form_json / feature_json：投屏上只该出现"多少人、什么终端"，字段内容留在取证工作区。
 * 对象不存在返回 null，由路由回 404——空屏会让投屏的人以为"这条线没人上钩"。
 */
function buildScreen(kind, id, req) {
  const sites = scopedSites(req);
  const templates = all('SELECT id, name FROM web_templates');
  const site = kind === 'site' ? sites.find((s) => s.id === id) : null;
  if (kind === 'site' && !site) return null;
  // 任务屏也要按归属取：直接 get 全表会把别人的任务投到自己的大屏上
  const task = kind === 'task' ? scopedTasks(req).find((t) => t.id === id) : null;
  if (kind === 'task' && !task) return null;

  const recScope = recordScopeClause(req, 'records');
  const records =
    kind === 'site'
      ? all(`SELECT * FROM records WHERE 1=1${recScope.sql} AND site_id=? ORDER BY created_at DESC`, [...recScope.params, id])
      : kind === 'task'
        ? all(`SELECT * FROM records WHERE 1=1${recScope.sql} AND task_id=? ORDER BY created_at DESC`, [...recScope.params, id])
        : all(`SELECT * FROM records WHERE 1=1${recScope.sql} ORDER BY created_at DESC`, recScope.params);

  const webRecords = records.filter((r) => r.kind === 'web');
  const { opened, submitted, not_submitted } = webStats(webRecords);
  const conversion = rate(submitted, opened);
  const riskScore = Math.round(Math.max(0, Math.min(100, 100 - conversion)) * 10) / 10;
  const mail = kind === 'task' ? taskMailStats(id) : kind === 'all' ? mailStats(req) : null;
  // 任务屏的曲线看邮件侧：收件人按打开/提交时间落桶，才能解释"发出去之后第几天开始有人点"
  const mailTrendRows = kind === 'task' ? all('SELECT opened_at, submitted_at FROM mail_recipients WHERE task_id=?', [id]) : null;
  // 平均停留只统计真正交过内容的记录：只打开没填的行 dwell 为空或 0，混进来会把均值拉平
  const dwell = webRecords.filter((r) => r.submitted_at && Number.isFinite(r.dwell_seconds)).map((r) => r.dwell_seconds);
  const avgDwell = dwell.length ? Math.round(dwell.reduce((a, b) => a + b, 0) / dwell.length) : 0;

  const title = kind === 'site' ? siteTitleOf(site, templates) : kind === 'task' ? task.title : '全局观测';
  const subtitle =
    kind === 'site'
      ? `${site.domain || (site.listen_ip === '0.0.0.0' ? '127.0.0.1' : site.listen_ip)}:${site.listen_port} · ${site.status === 'open' ? '监听中' : '已停止'}`
      : kind === 'task'
        ? `${task.subject || '（无主题）'} · ${task.dry_run ? '沙箱发送' : '真实发送'}`
        : '全部钓鱼网站与发送任务';

  // 总屏底部的"网站墙 / 任务墙"：点一下就能进各自的分屏，不用回控制台再找
  const boards =
    kind === 'all'
      ? {
          sites: sites.map((s) => {
            const of = webRecords.filter((r) => r.site_id === s.id);
            return {
              id: s.id,
              title: siteTitleOf(s, templates),
              status: s.status,
              port: s.listen_port,
              opened: of.length,
              submitted: of.filter((r) => r.submitted_at).length,
            };
          }),
          tasks: scopedTasks(req).map((t) => {
            const m = taskMailStats(t.id);
            return {
              id: t.id,
              title: t.title,
              status: t.status,
              dry_run: !!t.dry_run,
              recipients: m.recipients,
              opened: m.opened,
              submitted: m.submitted,
            };
          }),
        }
      : null;

  return {
    meta: {
      kind,
      id: kind === 'all' ? 'all' : id,
      title,
      subtitle,
      status: kind === 'task' ? task.status : kind === 'site' ? site.status : 'open',
      authorization: findActive()?.scope ?? null,
      generated_at: nowIso(),
    },
    basic: {
      running_sites: sites.filter((s) => s.status === 'open').length,
      risk_score: riskScore,
      risk_level: riskScore >= 90 ? '安全' : riskScore >= 70 ? '需关注' : '高风险',
      authorization: findActive()?.scope ?? null,
      template_count: templates.length,
    },
    web_stats: {
      opened,
      not_submitted,
      submitted,
      conversion,
      total_records: webRecords.length,
      avg_dwell: avgDwell,
      // 从邮件点进来的落地访问数：站点屏用它回答"这批人是不是邮件导流来的"
      mail_source: webRecords.filter((r) => r.task_id).length,
    },
    mail_stats: mail,
    funnel: { opened, not_submitted, submitted },
    trend: kind === 'task' ? trendOf(mailTrendRows, 'opened_at', 'submitted_at') : trend(webRecords),
    ...deviceBuckets(webRecords),
    records: records.slice(0, SCREEN_FEED_LIMIT).map((r) => ({
      id: r.id,
      kind: r.kind,
      site_id: r.site_id,
      task_id: r.task_id,
      token: r.token,
      target_email: r.target_email,
      first_seen_at: r.first_seen_at,
      submitted_at: r.submitted_at,
      dwell_seconds: r.dwell_seconds,
    })),
    site: site
      ? {
          id: site.id,
          template_name: templates.find((t) => t.id === site.template_id)?.name || '',
          domain: site.domain || '',
          listen_ip: site.listen_ip,
          listen_port: site.listen_port,
          status: site.status,
          url: siteUrl(site),
        }
      : null,
    task: task
      ? {
          id: task.id,
          title: task.title,
          subject: task.subject || '',
          sender: task.sender || '',
          status: task.status,
          dry_run: !!task.dry_run,
          attachment_name: task.attachment_name || '',
        }
      : null,
    boards,
  };
}

// 大屏目录：前端选择器用它列出"总屏 + 每个站点 + 每个任务"，一次拿齐，切屏不用再试探。
insightApi.get('/stats/screens', (req, res) => {
  const sites = scopedSites(req);
  const templates = all('SELECT id, name FROM web_templates');
  const webRecords = scopedRecords(req, '*', " AND kind='web'");
  const mails = mailStats(req);
  ok(res, {
    overall: {
      kind: 'all',
      id: 'all',
      title: '全局观测',
      subtitle: '全部钓鱼网站与发送任务',
      opened: webRecords.filter((r) => r.first_seen_at).length,
      submitted: webRecords.filter((r) => r.submitted_at).length,
      recipients: mails.recipients,
    },
    sites: sites.map((s) => {
      const of = webRecords.filter((r) => r.site_id === s.id);
      return {
        kind: 'site',
        id: s.id,
        title: siteTitleOf(s, templates),
        subtitle: `${s.domain || s.listen_ip}:${s.listen_port}`,
        status: s.status,
        opened: of.length,
        submitted: of.filter((r) => r.submitted_at).length,
      };
    }),
    tasks: scopedTasks(req).map((t) => {
      const m = taskMailStats(t.id);
      return {
        kind: 'task',
        id: t.id,
        title: t.title,
        subtitle: t.subject || '',
        status: t.status,
        recipients: m.recipients,
        opened: m.opened,
        submitted: m.submitted,
      };
    }),
  });
});

// 单块屏：kind=all|site|task，all 可省略 id。只读；对象不存在 404，不返回空屏。
insightApi.get('/stats/screen', (req, res) => {
  const kind = String(req.query.kind || 'all');
  if (!['all', 'site', 'task'].includes(kind)) return badRequest(res, 'kind 只能是 all / site / task');
  const id = String(req.query.id || '');
  if (kind !== 'all' && !id) return badRequest(res, '分屏必须指定 id');
  const payload = buildScreen(kind, kind === 'all' ? null : id, req);
  if (!payload) return notFound(res, '观测对象不存在');
  ok(res, payload);
});

// GET /insight/authorizations/:id/summary — 一次演练（= 一条授权）的汇总 JSON：范围、时间跨度、双漏斗、教育覆盖率、逐站点逐任务明细。纯读。
// 不存在的授权回 404，而不是全 0 JSON 让操作员以为没人上钩。
insightApi.get('/insight/authorizations/:id/summary', requireAdmin, (req, res) => {
  const summary = authorizationSummary(req.params.id);
  if (!summary) return notFound(res, '授权记录不存在');
  ok(res, summary);
});

// GET /insight/authorizations/:id/report — 甲方级演练报告（HTML，可打印/另存 PDF）。download=1 带 attachment 头缺省 inline，返回完整 HTML 不走信封。
// samples 钳到 1-20：样本越多、掩码前的明文读取面越大。
// 报告内容口令全掩码、邮箱部分掩码，不出现后台随机路径与管理面端口；导出写一条 report.export 审计，交付物离开本机要追得到人。
insightApi.get('/insight/authorizations/:id/report', requireAdmin, (req, res) => {
  const html = buildReportHtml(req.params.id, { samples: clampSamples(req.query.samples) });
  if (html === null) return notFound(res, '授权记录不存在');
  writeAudit(req, 'report.export', {
    targetKind: 'authorization',
    targetId: req.params.id,
    // detail 只记形态与规模：报告内容本身就是敏感数据，审计里再抄一份等于多一处泄露点
    detail: { format: 'html', samples: clampSamples(req.query.samples), download: req.query.download === '1' },
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${reportFilename(req, 'html')}"`);
  }
  res.send(html);
});

// GET /insight/authorizations/:id/export.csv — 交付用 CSV，凭据掩码版：口令全掩码、邮箱部分掩码。与 /reports/export 分工：那份是操作员自用的取证导出（明文），这份给甲方，两份刻意并存。
// text/csv + UTF-8 BOM + \r\n 不走信封；写一条 report.export 审计（format=csv、行数），授权不存在 404。
insightApi.get('/insight/authorizations/:id/export.csv', requireAdmin, (req, res) => {
  const csv = buildReportCsv(req.params.id);
  if (csv === null) return notFound(res, '授权记录不存在');
  // 行数 = CSV 行减表头那一行；用 \r\n 计数，buildReportCsv 固定用它做行尾
  const rowCount = Math.max(0, csv.split('\r\n').length - 1);
  writeAudit(req, 'report.export', {
    targetKind: 'authorization',
    targetId: req.params.id,
    detail: { format: 'csv', rows: rowCount },
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${reportFilename(req, 'csv')}"`);
  res.send(csv);
});
