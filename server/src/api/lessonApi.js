import express from 'express';
import { all, insert, nowIso, run } from '../platform/storage/rows.js';
import { ok, badRequest } from '../platform/net/envelope.js';

export const lessonApi = express.Router();

lessonApi.get('/learn-pages', (_req, res) => {
  ok(res, all('SELECT * FROM learn_pages ORDER BY created_at DESC'));
});

lessonApi.post('/learn-pages', (req, res) => {
  const { name, html } = req.body || {};
  if (!name || !html) return badRequest(res, '学习页名称与内容必填');
  const row = { id: crypto.randomUUID(), name, html, created_at: nowIso() };
  insert('learn_pages', row);
  ok(res, row);
});

/**
 * 删除学习页不动模板上的引用：采集面按 id 取不到页面时会回落到内置提示页，
 * 演练现场不会出现空白页，也不需要额外维护级联关系。
 */
lessonApi.delete('/learn-pages/:id', (req, res) => {
  run('DELETE FROM learn_pages WHERE id=?', [req.params.id]);
  ok(res, true);
});
