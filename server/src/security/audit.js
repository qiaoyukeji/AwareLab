/**
 * 操作审计：把谁在什么时候改过什么写进 audit_logs 表，只追加不改写，事后能改的不叫审计。
 * 审计内容不含口令、SMTP 密码、webhook 密钥与完整令牌，只记是否更换或掩码后的值，调用方传 detail 前先脱敏。
 * 本函数永不抛错也不返回成败，写失败只留一行控制台告警；detail 会被 JSON 化并截到 4000 字符，截断后可能不是合法 JSON。
 */
import { run, nowIso } from '../platform/storage/rows.js';
import { clientIp } from '../platform/net/clientIp.js';

/**
 * 高危动作留痕：授权登记/续期/吊销、沙箱开关、真实发送、证据导出、证据与站点删除、运行参数变更。
 * action 用 名词.动词 小写，是证据页筛选与 idx_audit_action 的键，改名要同步前端字典；detail 传对象或 null，传字符串会被再 JSON.stringify 一次。
 */
export function writeAudit(req, action, { targetKind = null, targetId = null, detail = null } = {}) {
  try {
    run(
      'INSERT INTO audit_logs (id,actor,action,target_kind,target_id,detail,ip,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [
        crypto.randomUUID(),
        // 未登录（定时任务、启动期）actor 留 null，好区分是不是人在后台点的
        req?.session?.username ?? null,
        action,
        targetKind,
        targetId,
        // detail 截到 4000 字符，防无界写入撑爆审计表；null/undefined 归一成 null，空串照样落库
        detail === null || detail === undefined ? null : JSON.stringify(detail).slice(0, 4000),
        req ? clientIp(req) : null,
        nowIso(),
      ]
    );
  } catch (err) {
    // 只打印不上抛，审计不能打断演练链路；不打印 req/params，免得未脱敏的 detail 二次进日志
    console.error('[audit] 审计写入失败：', err.message);
  }
}
