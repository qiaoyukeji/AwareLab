// 邮件文案模板（mail_templates）：钓鱼邮件的标题与正文素材，只是素材、不做投递门禁。
// subject/body_html 原样存取，专属链接与令牌由任务侧渲染时注入。
// PUT/DELETE 先判 id 存在：SQLite 改 0 行不报错，缺校验会谎报成功。
import express from 'express';
import { get, insert, nowIso, pagedRows, run, update } from '../platform/storage/rows.js';
import { ok, badRequest, notFound, paginate } from '../platform/net/envelope.js';

export const emailApi = express.Router();

/** 模板列表（分页）：keyword 对 name/subject/description 三列 LIKE 模糊（参数化，无注入面），created_at 倒序。 */
emailApi.get('/mail-templates', (req, res) => {
  const params = [];
  let where = '';
  if (req.query.keyword) {
    const like = `%${req.query.keyword}%`;
    where = 'WHERE (name LIKE ? OR subject LIKE ? OR description LIKE ?)';
    params.push(like, like, like);
  }
  const { page, page_size } = paginate(req.query);
  ok(res, pagedRows('mail_templates', where, params, page, page_size));
});

/** 新建模板：name/body_html 必填缺一回 400，subject 可空（建任务时前端预填标题，真发标题以任务行为准）。 */
emailApi.post('/mail-templates', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.body_html) return badRequest(res, '模板名称与正文必填');
  const now = nowIso();
  const row = {
    id: crypto.randomUUID(),
    name: b.name,
    subject: b.subject || null,
    body_html: b.body_html,
    description: b.description || null,
    created_at: now,
    updated_at: now,
  };
  insert('mail_templates', row);
  ok(res, row);
});

/** 单条模板详情：编辑弹窗读回完整正文。id 不存在回 404。 */
emailApi.get('/mail-templates/:id', (req, res) => {
  const row = get('SELECT * FROM mail_templates WHERE id=?', [req.params.id]);
  if (!row) return notFound(res, '邮件模板不存在');
  ok(res, row);
});

/** 编辑模板：只覆盖请求里带的字段，updated_at 无条件推进。改素材不影响任务行里已抄走的快照。 */
emailApi.put('/mail-templates/:id', (req, res) => {
  if (!get('SELECT 1 AS x FROM mail_templates WHERE id=?', [req.params.id])) return notFound(res, '邮件模板不存在');
  const b = req.body || {};
  const patch = { updated_at: nowIso() };
  // 字段白名单：id/created_at 无法被请求体覆写
  for (const key of ['name', 'subject', 'body_html', 'description']) {
    if (b[key] !== undefined) patch[key] = b[key];
  }
  update('mail_templates', req.params.id, patch);
  ok(res, get('SELECT * FROM mail_templates WHERE id=?', [req.params.id]));
});

/** 删除模板（物理删除，不查任务引用）：建任务时正文已抄进任务行快照，删素材不影响已发邮件。id 不存在回 404。 */
emailApi.delete('/mail-templates/:id', (req, res) => {
  if (!get('SELECT 1 AS x FROM mail_templates WHERE id=?', [req.params.id])) return notFound(res, '邮件模板不存在');
  run('DELETE FROM mail_templates WHERE id=?', [req.params.id]);
  ok(res, true);
});
