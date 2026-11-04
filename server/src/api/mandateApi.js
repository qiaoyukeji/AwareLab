import express from 'express';
import {
  REQUIRED_PLEDGE,
  PLEDGE_STATEMENT,
  findById,
  hostWhitelist,
  register,
  revoke,
  revise,
  toView,
} from '../security/mandate.js';
import { writeAudit } from '../security/audit.js';
import { all } from '../platform/storage/rows.js';
import { ok, fail } from '../platform/net/envelope.js';
import { closeSitesOfAuthorization } from '../capture/siteRegistry.js';

export const mandateApi = express.Router();

/** 校验失败统一按 mandate 层给出的状态码回话，缺省 400 */
function reject(res, result) {
  if (!result.error) return false;
  fail(res, result.status ?? 400, result.error);
  return true;
}

mandateApi.get('/authorizations/pledge', (_req, res) => {
  ok(res, { pledge: REQUIRED_PLEDGE, statement: PLEDGE_STATEMENT });
});

mandateApi.get('/authorizations', (_req, res) => {
  ok(res, all('SELECT * FROM authorizations ORDER BY created_at DESC').map(toView));
});

mandateApi.post('/authorizations', (req, res) => {
  const result = register(req.body || {});
  if (reject(res, result)) return;
  writeAudit(req, 'authorization.create', {
    targetKind: 'authorization',
    targetId: result.row.id,
    detail: { scope: result.row.scope, start_at: result.row.start_at, end_at: result.row.end_at, allowed_hosts: hostWhitelist(result.row) },
  });
  ok(res, result.row);
});

mandateApi.put('/authorizations/:id', (req, res) => {
  const before = findById(req.params.id);
  const result = revise(req.params.id, req.body || {});
  if (reject(res, result)) return;
  // 改窗口即改权限：缩短到已过期或推到未来生效时，其下正在监听的站点当场下线
  const stopped = closeSitesOfAuthorization(result.row.id);
  writeAudit(req, 'authorization.update', {
    targetKind: 'authorization',
    targetId: result.row.id,
    detail: {
      scope: result.row.scope,
      from: { start_at: before?.start_at ?? null, end_at: before?.end_at ?? null },
      to: { start_at: result.row.start_at, end_at: result.row.end_at, allowed_hosts: hostWhitelist(result.row) },
      stopped_sites: stopped,
    },
  });
  ok(res, { ...toView(result.row), stopped_sites: stopped });
});

mandateApi.post('/authorizations/:id/revoke', (req, res) => {
  const row = revoke(req.params.id);
  const stopped = closeSitesOfAuthorization(row.id);
  writeAudit(req, 'authorization.revoke', {
    targetKind: 'authorization',
    targetId: row.id,
    detail: { scope: row.scope, stopped_sites: stopped },
  });
  ok(res, true);
});
