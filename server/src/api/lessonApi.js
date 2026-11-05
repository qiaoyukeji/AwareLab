// 学习页管理域（learn_pages）：上钩访客被引导过去的安全教育页面素材，只存文案不过授权门禁。
// 删除不清模板上的悬空 learn_page_id，靠采集面回落内置提示页兜底；列表不分页（数量撑死两位数，下拉要完整映射）。
import express from 'express';
import { all, get, insert, nowIso, run } from '../platform/storage/rows.js';
import { ok, badRequest, notFound } from '../platform/net/envelope.js';

export const lessonApi = express.Router();

/** 学习页全量列表（created_at 倒序，含 html 正文）：编辑弹窗与"跳学习页"下拉共用，不分页。 */
lessonApi.get('/learn-pages', (_req, res) => {
  ok(res, all('SELECT * FROM learn_pages ORDER BY created_at DESC'));
});

/** 保存一个学习页：name/html 必填缺一回 400；只写 learn_pages，引用关系由模板侧 learn_page_id 单向指过来。 */
lessonApi.post('/learn-pages', (req, res) => {
  const { name, html } = req.body || {};
  if (!name || !html) return badRequest(res, '学习页名称与内容必填');
  const row = { id: crypto.randomUUID(), name, html, created_at: nowIso() };
  insert('learn_pages', row);
  ok(res, row);
});

/** 删除学习页（物理删除）不动模板上的引用：采集面按 id 取不到页面时回落内置提示页，现场不会出现空白页。 */
lessonApi.delete('/learn-pages/:id', (req, res) => {
  // 存在性前置校验：run() 删 0 行静默无错，缺这一步就是"删了个空气"也回成功
  if (!get('SELECT 1 AS x FROM learn_pages WHERE id=?', [req.params.id])) return notFound(res, '学习页不存在');
  run('DELETE FROM learn_pages WHERE id=?', [req.params.id]);
  ok(res, true);
});
