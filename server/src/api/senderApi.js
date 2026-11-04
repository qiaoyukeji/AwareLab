import express from 'express';
import { all, get, insert, nowIso, run, update } from '../platform/storage/rows.js';
import { ok, badRequest, notFound } from '../platform/net/envelope.js';
import { testProfile } from '../mail/transport.js';

export const senderApi = express.Router();

const MASK = '******';

senderApi.get('/smtp-profiles', (_req, res) => {
  // 列表只回掩码：SMTP 口令不进前端状态，避免在浏览器内存与网络面板里二次泄露
  const rows = all('SELECT * FROM smtp_profiles ORDER BY created_at DESC').map((r) => ({ ...r, pass: MASK }));
  ok(res, { rows, total: rows.length });
});

senderApi.post('/smtp-profiles', (req, res) => {
  const b = req.body || {};
  if (!b.host || !b.user || !b.from_addr) return badRequest(res, 'SMTP 主机、账号、发信地址必填');
  const row = {
    id: crypto.randomUUID(),
    name: b.name || b.from_addr,
    host: b.host,
    port: Number(b.port) || 465,
    secure: b.secure ? 1 : 0,
    user: b.user,
    pass: b.pass || '',
    from_addr: b.from_addr,
    from_name: b.from_name || null,
    created_at: nowIso(),
  };
  insert('smtp_profiles', row);
  ok(res, { ...row, pass: MASK });
});

/**
 * 编辑只覆盖提交的字段：列表里 pass 是掩码，前端拿不到原口令，
 * 因此「不带 pass」必须理解为「不改口令」，否则一次编辑就把凭据洗成星号。
 */
senderApi.put('/smtp-profiles/:id', (req, res) => {
  const current = get('SELECT * FROM smtp_profiles WHERE id=?', [req.params.id]);
  if (!current) return notFound(res, '发信账号不存在');
  const b = req.body || {};
  const patch = {};
  for (const key of ['name', 'host', 'user', 'from_addr', 'from_name']) {
    if (b[key] !== undefined) patch[key] = b[key];
  }
  if (b.port !== undefined) patch.port = Number(b.port) || current.port;
  if (b.secure !== undefined) patch.secure = b.secure ? 1 : 0;
  if (b.pass) patch.pass = b.pass;
  if (b.pass) patch.pass = b.pass;
  const merged = { ...current, ...patch };
  if (!merged.host || !merged.user || !merged.from_addr) return badRequest(res, 'SMTP 主机、账号、发信地址必填');
  update('smtp_profiles', current.id, patch);
  ok(res, { ...get('SELECT * FROM smtp_profiles WHERE id=?', [current.id]), pass: MASK });
});

senderApi.post('/smtp-profiles/:id/test', async (req, res) => {
  try {
    ok(res, await testProfile(req.params.id));
  } catch (err) {
    badRequest(res, `SMTP 测试失败：${err.message}`);
  }
});

senderApi.delete('/smtp-profiles/:id', (req, res) => {
  run('DELETE FROM smtp_profiles WHERE id=?', [req.params.id]);
  ok(res, true);
});
