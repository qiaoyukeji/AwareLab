import { createHash } from 'node:crypto';
import { run, nowIso, getSetting } from '../platform/storage/rows.js';

const PREFIX = '[AwareLab 演练通知]';
const SECRET_MASK = '******';

/**
 * 群机器人把令牌挂在 URL query 上（?access_token=…&sign=…），
 * 而推送日志会把请求整条存进库：不掩码就等于把每枚令牌复制一份留在演练数据旁边。
 */
const SECRET_QUERY_KEY = /(token|key|sign|secret|webhook|password|passwd)/i;

export function maskUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return String(raw || '').slice(0, 120);
  }
  for (const [name, value] of url.searchParams.entries()) {
    if (SECRET_QUERY_KEY.test(name)) url.searchParams.set(name, SECRET_MASK);
  }
  return url.toString();
}

/** 脱敏推送默认开启：群里看到"谁上钩了"是演练事故，不是便利 */
const redactOn = () => getSetting('push', { enabled: false, channels: [] })?.redact !== false;

/** 收件人标识：默认换成不可逆短摘要，同一邮箱每次得到同一个代号，操作员仍能对上号 */
export function pushTarget(email) {
  if (!email) return '目标=未知';
  if (!redactOn()) return `目标=${email}`;
  return `员工#${createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 8)}`;
}

/** 字段清单：默认只报数量，字段名本身就能说明这次钓的是银行卡还是 SSO */
export function pushFields(fields) {
  const names = Object.keys(fields || {});
  return redactOn() ? `${names.length} 项` : names.join(',');
}

const CHANNEL_BUILDERS = {
  dingtalk: (url, text) => ({ url, body: { msgtype: 'text', text: { content: `${PREFIX} ${text}` } } }),
  wecom: (url, text) => ({ url, body: { msgtype: 'text', text: { content: `${PREFIX} ${text}` } } }),
  feishu: (url, text) => ({ url, body: { msg_type: 'text', content: { text: `${PREFIX} ${text}` } } }),
};

async function post(channel, kind, text) {
  const builder = CHANNEL_BUILDERS[channel.type];
  if (!builder || !channel.url || !Array.isArray(channel.events) || !channel.events.includes(kind)) return;
  const { url, body } = builder(channel.url, text);
  const log = {
    id: crypto.randomUUID(),
    channel: channel.type,
    event_kind: kind,
    request: JSON.stringify({ url: maskUrl(url), body }),
  };
  let response;
  let isOk = 0;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // 群机器人卡住不能拖慢采集链路，5 秒即断
      signal: AbortSignal.timeout(5000),
    });
    response = (await res.text()).slice(0, 500);
    isOk = res.ok ? 1 : 0;
  } catch (err) {
    response = String(err.message).slice(0, 500);
  }
  run(
    'INSERT INTO push_logs (id,channel,event_kind,request,response,ok,created_at) VALUES (?,?,?,?,?,?,?)',
    [log.id, log.channel, log.event_kind, log.request, response, isOk, nowIso()]
  );
}

/** 事件秒级推送：页面打开/表单提交/邮件打开/附件回调。推送失败只落日志，不影响主链路。 */
export async function pushEvent(kind, text) {
  const cfg = getSetting('push', { enabled: false, channels: [] });
  if (!cfg?.enabled || !Array.isArray(cfg.channels)) return;
  for (const channel of cfg.channels) {
    try {
      await post(channel, kind, text);
    } catch {
      /* 记账已尽力，推送异常不外溢 */
    }
  }
}
