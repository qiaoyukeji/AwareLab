import express from 'express';
import { get, insert, nowIso, pagedRows, run, update } from '../platform/storage/rows.js';
import { ok, badRequest, paginate } from '../platform/net/envelope.js';

export const emailApi = express.Router();

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

emailApi.put('/mail-templates/:id', (req, res) => {
  const b = req.body || {};
  const patch = { updated_at: nowIso() };
  for (const key of ['name', 'subject', 'body_html', 'description']) {
    if (b[key] !== undefined) patch[key] = b[key];
  }
  update('mail_templates', req.params.id, patch);
  ok(res, get('SELECT * FROM mail_templates WHERE id=?', [req.params.id]));
});

emailApi.delete('/mail-templates/:id', (req, res) => {
  run('DELETE FROM mail_templates WHERE id=?', [req.params.id]);
  ok(res, true);
});
