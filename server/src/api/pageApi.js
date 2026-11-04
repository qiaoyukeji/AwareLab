import express from 'express';
import { all, get, insert, nowIso, pagedRows, run, update } from '../platform/storage/rows.js';
import { ok, badRequest, paginate } from '../platform/net/envelope.js';
import { inspectTemplate } from '../capture/diagnostics.js';
import { renderCapturePage } from '../capture/pageCompiler.js';
import { ENGAGE_ENDPOINT, bootAfter } from '../capture/engageScript.js';

export const pageApi = express.Router();

/**
 * 体检结论落库：两个摘要标记列沿用历史列名与取值口径（判定对象已从按钮上的 onclick
 * 变成声明式采集入口），完整报告另存 diagnose_json，列表页直接读分数，不必逐条重新体检。
 */
function diagnoseColumns(report) {
  const binding = report.checks.find((c) => c.key === 'binding');
  const trigger = report.checks.find((c) => c.key === 'trigger');
  const assets = report.checks.find((c) => c.key === 'assets');
  return {
    // 这一列回答的是「点了到底采不采得到」，只看 form 不够：没有提交触发点的页面照样漏采
    check_onclick: binding?.ok && trigger?.ok ? '通过' : '未通过',
    check_external: assets?.detail ?? '无外链',
    diagnose_json: JSON.stringify(report),
  };
}

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

pageApi.get('/web-templates/types', (_req, res) => {
  ok(res, all('SELECT DISTINCT type FROM web_templates WHERE type IS NOT NULL ORDER BY type').map((r) => r.type));
});

pageApi.post('/web-templates/diagnose', (req, res) => {
  ok(res, inspectTemplate(req.body?.html || ''));
});

/**
 * 预览页与真实采集页共用同一份运行时：管理面这个端口上没有采集面处理器，
 * 上报只会落到空端点并被运行时兜底忽略，排版演练因此不会往取证库里灌噪声记录，
 * 而弹窗、跳转、学习页三个响应分支都能照常演示（上报失败也必须给出响应）。
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

pageApi.get('/web-templates/:id', (req, res) => {
  ok(res, get('SELECT * FROM web_templates WHERE id=?', [req.params.id]));
});

pageApi.post('/web-templates', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.type || !b.html) return badRequest(res, '模板类型、名称、内容必填');
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

pageApi.put('/web-templates/:id', (req, res) => {
  const b = req.body || {};
  const patch = { updated_at: nowIso() };
  for (const key of ['name', 'type', 'description', 'html', 'response_type', 'response_content', 'learn_page_id']) {
    if (b[key] !== undefined) patch[key] = b[key];
  }
  if (b.html !== undefined) Object.assign(patch, diagnoseColumns(inspectTemplate(b.html)));
  update('web_templates', req.params.id, patch);
  ok(res, get('SELECT * FROM web_templates WHERE id=?', [req.params.id]));
});

pageApi.delete('/web-templates/:id', (req, res) => {
  const used = get('SELECT COUNT(*) AS n FROM web_sites WHERE template_id=?', [req.params.id]).n;
  if (used) return badRequest(res, '该模板仍被演练站点引用，请先下线站点');
  run('DELETE FROM web_templates WHERE id=?', [req.params.id]);
  ok(res, true);
});
