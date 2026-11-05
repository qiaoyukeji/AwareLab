/**
 * 通知面：把演练事件推到群机器人并留下可审计的推送日志，是唯一对外发起 HTTP 的模块。
 * 推送是尽力而为的旁路，异常都在内部吞掉落 push_logs，绝不拖垮采集主链路。
 * 文案不得出现明文邮箱与明文令牌：收件人走 pushTarget 摘要，推送 URL 走 maskUrl 后才允许写库。
 */
import { createHash } from 'node:crypto';
import { run, nowIso, getSetting } from '../platform/storage/rows.js';

// 推送文案统一前缀，群里一眼认出是演练平台推送
const PREFIX = '[AwareLab 演练通知]';
// 掩码占位用固定星串而非随机字符，同一条请求重复落库时日志可读且可比对
const SECRET_MASK = '******';

/**
 * 群机器人把令牌挂在 URL query（?access_token=…&sign=…），推送日志会把整条请求存进库：
 * 不掩码等于把每枚令牌复制一份留在演练数据旁边。
 */
const SECRET_QUERY_KEY = /(token|key|sign|secret|webhook|password|passwd)/i;

/**
 * 把 URL query 里凭据类参数换成星串，供写日志前脱敏。解析失败退化前 120 字符原文。
 * 失败也返回点东西而非抛错：推送失败时仍想在库里留线索。
 */
export function maskUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    // 非绝对 URL（配置写坏）：截断原文，不把整串可疑内容塞满日志
    return String(raw || '').slice(0, 120);
  }
  // 先快照参数名再改值：set() 会把同名重复项合并，边遍历边改会跳过后面的参数
  for (const name of [...url.searchParams.keys()]) {
    // 只按参数名判定：群机器人参数名各家不同，命中 token/key/sign 即视为凭据
    if (SECRET_QUERY_KEY.test(name)) url.searchParams.set(name, SECRET_MASK);
  }
  return url.toString();
}

/** 脱敏推送默认开启：群里看到谁上钩了是演练事故 */
const redactOn = () => getSetting('push', { enabled: false, channels: [] })?.redact !== false;

/** 收件人标识：默认换成不可逆短摘要，同一邮箱每次得到同一代号，操作员仍能对上号。关闭脱敏时是明文邮箱 */
export function pushTarget(email) {
  if (!email) return '目标=未知';
  if (!redactOn()) return `目标=${email}`;
  // 先转小写再摘要：同一人邮箱大小写混写，不归一会出现两个代号对账对不上
  return `员工#${createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 8)}`;
}

/** 字段清单：默认只报数量，字段名本身就能说明这次钓的是银行卡还是 SSO */
export function pushFields(fields) {
  const names = Object.keys(fields || {});
  return redactOn() ? `${names.length} 项` : names.join(',');
}

// 各群机器人的报文构造器：只负责同一个文本三种包装，URL 与事件过滤统一在 post 里做
const CHANNEL_BUILDERS = {
  dingtalk: (url, text) => ({ url, body: { msgtype: 'text', text: { content: `${PREFIX} ${text}` } } }),
  wecom: (url, text) => ({ url, body: { msgtype: 'text', text: { content: `${PREFIX} ${text}` } } }),
  feishu: (url, text) => ({ url, body: { msg_type: 'text', content: { text: `${PREFIX} ${text}` } } }),
};

/**
 * 向单个通道推送一条文本，并把请求与响应落进 push_logs。永不抛错。
 * 静默跳过三种情况：type 不在 CHANNEL_BUILDERS、url 为空、events 没订阅这个 kind。
 */
async function post(channel, kind, text) {
  const builder = CHANNEL_BUILDERS[channel.type];
  if (!builder || !channel.url || !Array.isArray(channel.events) || !channel.events.includes(kind)) return;
  const { url, body } = builder(channel.url, text);
  const log = {
    id: crypto.randomUUID(),
    channel: channel.type,
    event_kind: kind,
    // 落库前掩码：request 给通知记录页看，令牌一旦进去就等于和演练数据放在一起
    request: JSON.stringify({ url: maskUrl(url), body }),
  };
  let response;
  // 1/0 而非布尔：push_logs.ok 是 INTEGER 列，表结构冻结不改
  let isOk = 0;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // 群机器人卡住不能拖慢采集链路，5 秒即断
      signal: AbortSignal.timeout(5000),
    });
    // 响应只留 500 字符：机器人偶尔回整页 HTML，日志表不该被塞爆
    response = (await res.text()).slice(0, 500);
    isOk = res.ok ? 1 : 0;
  } catch (err) {
    // 网络异常（超时/DNS/证书）走这里：错误文本当响应记下，ok 保持 0
    response = String(err.message).slice(0, 500);
  }
  // 无论成败都落库：推送失败本身就是要给操作员看到的信号
  run(
    'INSERT INTO push_logs (id,channel,event_kind,request,response,ok,created_at) VALUES (?,?,?,?,?,?,?)',
    [log.id, log.channel, log.event_kind, log.request, response, isOk, nowIso()]
  );
}

/**
 * 事件秒级推送：页面打开/表单提交/邮件打开/附件回调。内部已用超时兜底，采集链路最多多等 5 秒/通道。
 * 配置未开启、通道数组非法、单个通道异常时全部静默返回；推送失败只落日志，证据仍在上钩记录里，别用返回值判业务成败。
 */
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
