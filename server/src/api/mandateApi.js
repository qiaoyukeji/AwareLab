// 演练授权管理域（authorizations）：放行采集与投放的总开关，在这里签发、改窗口、吊销。
// 本文件自己不调 assertDeployment：它是门禁的数据源，投放侧经 mandate.js 读取这里的写入结果放行。
// 授权一举一动都落审计，但审计只记范围/窗口/域名白名单，不落敏感凭据。
// 改窗口级联不对称：离开窗口→名下在听站点强制下线（close_reason='authorization'），续期只恢复这一类，
// 操作员主动收网（close_reason='manual'）的那张网不会被别人的续期重新掀开。
import express from 'express';
import {
  REQUIRED_PLEDGE,
  PLEDGE_STATEMENT,
  effectiveStatus,
  findById,
  hostWhitelist,
  register,
  revoke,
  revise,
  toView,
} from '../security/mandate.js';
import { writeAudit } from '../security/audit.js';
import { all } from '../platform/storage/rows.js';
import { ok, fail, notFound } from '../platform/net/envelope.js';
import { closeSitesOfAuthorization, reopenSitesOfAuthorization } from '../capture/siteRegistry.js';

export const mandateApi = express.Router();

/** 校验失败统一出口：mandate 层返回 {error,status?}，这里替它把信封发出。true=已回话，调用方须立刻 return。 */
function reject(res, result) {
  if (!result.error) return false;
  fail(res, result.status ?? 400, result.error);
  return true;
}

/** 下发必须逐字输入的承诺文本与使用声明，供登记表单展示。文案只在代码里定稿，前端从接口取就不会有过期副本。 */
mandateApi.get('/authorizations/pledge', (_req, res) => {
  ok(res, { pledge: REQUIRED_PLEDGE, statement: PLEDGE_STATEMENT });
});

/**
 * 授权全量列表（含已吊销/过期的），按创建时间倒序，每行过 toView。
 * effective 按此刻重算：库里 status 只表达有没有被吊销，是否在窗口内必须由当前时间判定，否则过期授权会继续误导界面。
 */
mandateApi.get('/authorizations', (_req, res) => {
  ok(res, all('SELECT * FROM authorizations ORDER BY created_at DESC').map(toView));
});

/** 单条授权详情：改窗口前读回它现在管到哪一天。与列表同一份 toView 形状，id 不存在回 404。 */
mandateApi.get('/authorizations/:id', (req, res) => {
  const row = findById(req.params.id);
  if (!row) return notFound(res, '授权记录不存在');
  ok(res, toView(row));
});

/**
 * 登记一份演练授权：给整个平台的采集与投放开绿灯，门槛必须最高。
 * start_at/end_at 必须可 Date.parse：不可解析会留 NaN，NaN 比不过任何比较被一路判成 active，等于发了张永久授权。
 * allowed_hosts 空名单拒绝（没有白名单的授权等于随便打）；pledge 必须逐字等于 REQUIRED_PLEDGE，
 * 防"勾选同意"糊弄出空白支票。校验全在 mandate.register 内做，原因经 reject 透出（400）。
 */
mandateApi.post('/authorizations', (req, res) => {
  const result = register(req.body || {});
  if (reject(res, result)) return;
  writeAudit(req, 'authorization.create', {
    targetKind: 'authorization',
    targetId: result.row.id,
    detail: { scope: result.row.scope, start_at: result.row.start_at, end_at: result.row.end_at, allowed_hosts: hostWhitelist(result.row) },
  });
  ok(res, toView(result.row));
});

/**
 * 修改授权（续期 / 缩窗口 / 换白名单），本域最危险的端点：改的就是门禁判定输入，级联直接落在站点监听上。
 * body 是整条替换（非 patch），mandate.revise 整套重跑校验、承诺文本依旧必须逐字。
 * id 不存在 404；已吊销的不可改 409（吊销要留不可撤销的痕迹，想恢复只能重新登记）。
 * 按 effectiveStatus 级联停/复站，审计 authorization.update 记改前改后窗口对照 + 停/复数量。
 */
mandateApi.put('/authorizations/:id', (req, res) => {
  // 先留改前快照给审计的 from 窗口：revise 会整行覆写，事后再也拼不出旧边界
  const before = findById(req.params.id);
  const result = revise(req.params.id, req.body || {});
  if (reject(res, result)) return;
  // 改窗口即改权限：判级联用 effectiveStatus 而非 status，因为 status='active' 只表示未吊销，
  // 是否真在窗口内要拿当前时间算，续期到未来或改成过期都在这一步现形
  const active = effectiveStatus(result.row) === 'active';
  let stopped = 0;
  let reopened = 0;
  if (active) {
    // 续期回窗口内：复服当初被平台强制下线的站点，恢复白名单只认 close_reason='authorization'，manual 的不掀开
    reopened = reopenSitesOfAuthorization(result.row.id);
  } else {
    // 不止缩到过期：窗口起点挪到未来（pending）同样停站。授权暂不生效，在听的站多一秒都越界
    stopped = closeSitesOfAuthorization(result.row.id);
  }
  // 审计写 from→to 窗口对照 + 停/复站数量：追查"谁动了授权、顺手下线了哪些站"的现场
  writeAudit(req, 'authorization.update', {
    targetKind: 'authorization',
    targetId: result.row.id,
    detail: {
      scope: result.row.scope,
      from: { start_at: before?.start_at ?? null, end_at: before?.end_at ?? null },
      to: { start_at: result.row.start_at, end_at: result.row.end_at, allowed_hosts: hostWhitelist(result.row) },
      stopped_sites: stopped,
      reopened_sites: reopened,
    },
  });
  ok(res, { ...toView(result.row), stopped_sites: stopped, reopened_sites: reopened });
});

/**
 * 吊销授权（拉闸）：status 置 'revoked' 的软删除，记录、站点配置、取证数据全保留，
 * 但门禁立刻断粮（findActive 不再认它，投放与采集端点当场拒绝）。
 * 存在性前置校验：revoke 底层是 update，不存在的 id 改 0 行静默成功，不先判就会谎报吊销成功。
 * 吊销不可逆：revise 拒绝改已吊销记录，防"误吊销→悄悄改回来"抹掉撤销留痕。级联下线名下全部在听站点。
 */
mandateApi.post('/authorizations/:id/revoke', (req, res) => {
  const current = findById(req.params.id);
  if (!current) return notFound(res, '授权记录不存在');
  const row = revoke(req.params.id);
  // 吊销的级联与"窗口缩到过期"完全同一动作：授权死了，它名下的站一秒都不该再多听
  const stopped = closeSitesOfAuthorization(row.id);
  writeAudit(req, 'authorization.revoke', {
    targetKind: 'authorization',
    targetId: row.id,
    detail: { scope: row.scope, stopped_sites: stopped },
  });
  ok(res, true);
});
