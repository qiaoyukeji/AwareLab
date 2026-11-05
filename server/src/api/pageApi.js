// 钓鱼网站模板管理域（web_templates）：仿冒登录页的增删改查、体检与预览。
// 素材层不过授权门禁（本身不监听不采集）；真正要授权的是拿它建站点监听与访客侧采集。
// 预览绝不往取证库灌记录；PUT/DELETE 先按 id 判存在，否则 SQLite 改 0 行不报错会谎报成功。
import express from 'express';
import { all, get, insert, nowIso, pagedRows, run, update } from '../platform/storage/rows.js';
import { ok, badRequest, notFound, paginate } from '../platform/net/envelope.js';
import { inspectTemplate } from '../capture/diagnostics.js';
import { renderCapturePage } from '../capture/pageCompiler.js';
import { ENGAGE_ENDPOINT, bootAfter } from '../capture/engageScript.js';

export const pageApi = express.Router();

/**
 * 体检结论落库：check_onclick/check_external 沿用历史列名当列表摘要，完整报告另存 diagnose_json。
 * 个别检查项缺失按"未通过"兜底、不抛错：体检只提示不阻断保存（现场常有半成品模板）。
 */
function diagnoseColumns(report) {
  const binding = report.checks.find((c) => c.key === 'binding');
  const trigger = report.checks.find((c) => c.key === 'trigger');
  const assets = report.checks.find((c) => c.key === 'assets');
  return {
    // 回答"点了到底采不采得到"：只看 form 不够，没有提交触发点的页面照样漏采
    check_onclick: binding?.ok && trigger?.ok ? '通过' : '未通过',
    check_external: assets?.detail ?? '无外链',
    diagnose_json: JSON.stringify(report),
  };
}

/**
 * 模板列表（分页 + 可筛）：type 按类型过滤（'全部' 按空处理），keyword 对 name/description LIKE 模糊（参数化，无注入面）。
 * created_at 倒序，page_size 由 paginate 夹到上限 200，超大分页拖不垮库。只读无副作用。
 */
pageApi.get('/web-templates', (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.type && req.query.type !== '全部') {
    cond.push('type=?');
    params.push(req.query.type);
  }
  if (req.query.keyword) {
    cond.push('(name LIKE ? OR description LIKE ?)');
    const like = `%${req.query.keyword}%`;
    params.push(like, like);
  }
  const { page, page_size } = paginate(req.query);
  ok(res, pagedRows('web_templates', cond.length ? 'WHERE ' + cond.join(' AND ') : '', params, page, page_size));
});

/** 类型下拉选项：非 NULL 的 DISTINCT type 字符串数组（历史数据可能没填类型），列表筛选与建站下拉共用 */
pageApi.get('/web-templates/types', (_req, res) => {
  ok(res, all('SELECT DISTINCT type FROM web_templates WHERE type IS NOT NULL ORDER BY type').map((r) => r.type));
});

/** 对未保存的 HTML 做实时体检：html 缺省按空串处理，低分照样回 200，体检不拦保存，不落库。 */
pageApi.post('/web-templates/diagnose', (req, res) => {
  ok(res, inspectTemplate(req.body?.html || ''));
});

/**
 * 预览页与真实采集页共用同一份运行时，但管理面这端口没有采集面处理器：上报只落到空端点被忽略，
 * 排版演练不往取证库灌噪声。token 打成 preview-<uuid>，即使错路到真实采集端也匹配不到授权记录。
 * response_type 库里历史值 learn 即协议里的 lesson，由 bootAfter 统一翻译。返回 text/html 供 iframe srcdoc。
 */
pageApi.post('/web-templates/preview', (req, res) => {
  const html = req.body?.html || '';
  res.type('html').send(
    renderCapturePage(html, {
      site: 'preview',
      token: `preview-${crypto.randomUUID()}`,
      after: bootAfter(req.body?.response_type || 'alert'),
      content: req.body?.response_content || '登录成功',
      endpoint: ENGAGE_ENDPOINT,
    })
  );
});

/** 单条模板全量信息（含 html 原文与三列体检结果）：编辑弹窗读回完整行。id 不存在回 404，不回 null。 */
pageApi.get('/web-templates/:id', (req, res) => {
  const row = get('SELECT * FROM web_templates WHERE id=?', [req.params.id]);
  if (!row) return notFound(res, '模板不存在');
  ok(res, row);
});

/**
 * 新建钓鱼网站模板：向导保存与一键仿站存为模板都走这里。name/type/html 必填缺任一回 400。
 * learn_page_id 指向 learn_pages，可空、引用悬空由采集面回落内置提示页兜底。保存时同步体检，返回新行 + 报告。
 */
pageApi.post('/web-templates', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.type || !b.html) return badRequest(res, '模板类型、名称、内容必填');
  // 保存即体检：结论固化进摘要列+diagnose_json，列表与编辑页不再逐条重解析 html
  const report = inspectTemplate(b.html);
  const now = nowIso();
  const row = {
    id: crypto.randomUUID(),
    name: b.name,
    type: b.type,
    description: b.description || null,
    html: b.html,
    response_type: b.response_type || 'alert',
    response_content: b.response_content || null,
    learn_page_id: b.learn_page_id || null,
    ...diagnoseColumns(report),
    created_at: now,
    updated_at: now,
  };
  insert('web_templates', row);
  ok(res, { ...row, diagnose: report });
});

/**
 * 编辑模板：只覆盖请求里带的字段（undefined=不动），支持抽屉局部提交。
 * 先判 id 存在，否则 SQLite update 改 0 行不报错会谎报成功。html 变了时同步刷新体检列。
 */
pageApi.put('/web-templates/:id', (req, res) => {
  if (!get('SELECT 1 AS x FROM web_templates WHERE id=?', [req.params.id])) return notFound(res, '模板不存在');
  const b = req.body || {};
  const patch = { updated_at: nowIso() };
  // 字段白名单：id、created_at 与三列体检结果不在名单里，请求体永远无法直接覆写它们
  for (const key of ['name', 'type', 'description', 'html', 'response_type', 'response_content', 'learn_page_id']) {
    if (b[key] !== undefined) patch[key] = b[key];
  }
  // 只在 html 变了时重跑体检：摘要列和完整报告必须跟着内容走，否则列表分数与实物脱节
  if (b.html !== undefined) Object.assign(patch, diagnoseColumns(inspectTemplate(b.html)));
  update('web_templates', req.params.id, patch);
  ok(res, get('SELECT * FROM web_templates WHERE id=?', [req.params.id]));
});

/**
 * 删除模板（比邮件文案严）：仍被演练站点（web_sites.template_id）引用就 400 拒删，要求先下线站点。
 * 否则在听的站点丢了模板、访客只看兜底页、采集链路静默断掉。records 挂在站点与令牌上不引用模板，删模板不清证据。
 */
pageApi.delete('/web-templates/:id', (req, res) => {
  if (!get('SELECT 1 AS x FROM web_templates WHERE id=?', [req.params.id])) return notFound(res, '模板不存在');
  // 引用计数现查 web_sites、不维护反向索引：模板量少，一条 COUNT 就是最可靠的实况
  const used = get('SELECT COUNT(*) AS n FROM web_sites WHERE template_id=?', [req.params.id]).n;
  if (used) return badRequest(res, '该模板仍被演练站点引用，请先下线站点');
  run('DELETE FROM web_templates WHERE id=?', [req.params.id]);
  ok(res, true);
});
