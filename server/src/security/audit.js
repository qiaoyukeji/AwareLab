import { run, nowIso } from '../platform/storage/rows.js';
import { clientIp } from '../platform/net/clientIp.js';

/**
 * 高危动作留痕。
 * 覆盖六类：授权登记/续期/吊销、沙箱开关、真实发送、证据导出、证据与站点删除、运行参数变更。
 *
 * 审计是"事后说得清"的最后一环，但它绝不能反过来打断演练链路：
 * 库被锁、字段过长都只该留下一条控制台告警，采集与发信照常。
 */
export function writeAudit(req, action, { targetKind = null, targetId = null, detail = null } = {}) {
  try {
    run(
      'INSERT INTO audit_logs (id,actor,action,target_kind,target_id,detail,ip,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [
        crypto.randomUUID(),
        req?.session?.username ?? null,
        action,
        targetKind,
        targetId,
        detail === null || detail === undefined ? null : JSON.stringify(detail).slice(0, 4000),
        req ? clientIp(req) : null,
        nowIso(),
      ]
    );
  } catch (err) {
    console.error('[audit] 审计写入失败：', err.message);
  }
}
