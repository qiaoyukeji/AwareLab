/**
 * 短信验证码：走阿里云「号码认证服务」Dypnsapi（2017-05-25）的 SendSmsVerifyCode / CheckSmsVerifyCode。
 * 选它而不是普通短信 SendSms：验证码的生成、有效期、一次性校验都在云端，本地不存码，少一张会泄密的表。
 *
 * 签名用 RPC 风格 V1（HMAC-SHA1），不引 SDK：一个请求只有十几个参数，SDK 会带进一堆依赖与凭据落盘逻辑。
 * 密钥只存在本机 settings 表，读取一律掩码；endpoint 可配（默认 dypnsapi.aliyuncs.com），
 * 允许 http://127.0.0.1:port 只为隔离验证能起假网关，公网地址必须是 https。
 */
import crypto from 'node:crypto';
import { getSetting, setSetting, get, run, nowIso } from '../platform/storage/rows.js';

const SECRET_MASK = '******';

export const SMS_DEFAULT = {
  enabled: false,
  access_key_id: '',
  access_key_secret: '',
  sign_name: '',
  template_code: '',
  // 模板变量名固定 code：阿里云按 ##code## 占位注入随机码，模板里写 ${code} 即可
  template_param: '{"code":"##code##"}',
  code_length: 6,
  valid_time: 300,
  // 同号 60 秒内重复请求直接拒绝（阿里云侧也有 Interval，这里先挡一层，省一次外呼）
  interval_seconds: 60,
  endpoint: 'dypnsapi.aliyuncs.com',
  scheme_name: '',
};

/** 合并默认值：老配置缺字段时补默认，避免界面读到 undefined。 */
export function smsConfig() {
  const stored = getSetting('sms', SMS_DEFAULT) || {};
  return { ...SMS_DEFAULT, ...stored };
}

/** 读给前端：密钥、AccessKeyId 一律掩码，只保留「有没有配」的信息。 */
export function maskedSmsConfig() {
  const cfg = smsConfig();
  return {
    ...cfg,
    access_key_id: cfg.access_key_id ? `${String(cfg.access_key_id).slice(0, 4)}${SECRET_MASK}` : '',
    access_key_secret: cfg.access_key_secret ? SECRET_MASK : '',
    has_access_key_id: Boolean(cfg.access_key_id),
    has_access_key_secret: Boolean(cfg.access_key_secret),
  };
}

/**
 * 保存配置：空串或掩码视为「不修改已有密钥」，避免前端拿到星号回存把真密钥洗掉。
 * 开启短信认证前必须配置齐全，这里只做形状校验，能不能真发由「发送测试」验证。
 */
export function saveSmsConfig(incoming) {
  const prev = smsConfig();
  const next = { ...prev };
  for (const key of ['sign_name', 'template_code', 'template_param', 'endpoint', 'scheme_name']) {
    if (incoming[key] !== undefined) next[key] = String(incoming[key] ?? '').trim();
  }
  for (const key of ['code_length', 'valid_time', 'interval_seconds']) {
    if (incoming[key] !== undefined) next[key] = Number(incoming[key]);
  }
  if (incoming.access_key_id !== undefined) {
    const value = String(incoming.access_key_id || '').trim();
    if (value && !value.endsWith(SECRET_MASK)) next.access_key_id = value;
  }
  if (incoming.access_key_secret !== undefined) {
    const value = String(incoming.access_key_secret || '').trim();
    if (value && value !== SECRET_MASK) next.access_key_secret = value;
  }
  if (incoming.enabled !== undefined) next.enabled = Boolean(incoming.enabled);
  // 数值兜底：码长只允许 4~8，有效期 60~1800 秒，间隔 30~600 秒，越界回默认而不是存进去
  next.code_length = Math.min(8, Math.max(4, Number(next.code_length) || SMS_DEFAULT.code_length));
  next.valid_time = Math.min(1800, Math.max(60, Number(next.valid_time) || SMS_DEFAULT.valid_time));
  next.interval_seconds = Math.min(600, Math.max(30, Number(next.interval_seconds) || SMS_DEFAULT.interval_seconds));
  if (!next.endpoint) next.endpoint = SMS_DEFAULT.endpoint;
  setSetting('sms', next);
  return next;
}

/** 能否真正开启：返回中文原因或 null。管理员点「开启」与每次发码前都过这一关。 */
export function smsReadyProblem(cfg = smsConfig()) {
  if (!cfg.access_key_id) return '未填写 AccessKey ID';
  if (!cfg.access_key_secret) return '未填写 AccessKey Secret';
  if (!cfg.sign_name) return '未填写短信签名';
  if (!cfg.template_code) return '未填写模板 Code';
  return null;
}

/** 发码入口的开关：总开关 + 配置齐全，缺一不可。 */
export function smsEnabled() {
  const cfg = smsConfig();
  return Boolean(cfg.enabled) && !smsReadyProblem(cfg);
}

/* ---------------------------------- 签名与请求 ---------------------------------- */

/** RFC 3986 编码：encodeURIComponent 不编码 !'()*，阿里云签名要求一并转义，否则签名对不上。 */
function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, '~');
}

/** RPC V1 签名串：GET&%2F&<规范化查询串>，key 按字典序、值与键都要百分号编码。 */
function signV1(params, accessKeySecret, method = 'GET') {
  const canonical = Object.keys(params)
    .filter((key) => key !== 'Signature')
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonical)}`;
  const signature = crypto.createHmac('sha1', `${accessKeySecret}&`).update(stringToSign, 'utf8').digest('base64');
  return `${canonical}&Signature=${percentEncode(signature)}`;
}

function endpointUrl(endpoint) {
  const raw = String(endpoint || SMS_DEFAULT.endpoint).trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  // 出站只放行 https 或本机回环 http：明文公网会让 AccessKey 与验证码一起裸奔
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('短信网关地址必须是 https（本机回环可用 http 便于联调）');
  }
  if (!url.pathname || url.pathname === '/') url.pathname = '/';
  return url;
}

/** 统一发一次 RPC：拼公共参数 → 签名 → fetch → 解析 JSON，网络错误与业务错误都收敛成中文 Error。 */
async function callRpc(action, bizParams, cfg) {
  const params = {
    Action: action,
    Version: '2017-05-25',
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    AccessKeyId: cfg.access_key_id,
    ...bizParams,
  };
  const query = signV1(params, cfg.access_key_secret);
  const url = endpointUrl(cfg.endpoint);
  url.search = query;
  let response;
  try {
    response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(12000) });
  } catch (error) {
    // 保留 cause 便于排查 DNS/证书/超时；对外只暴露这一句中文
    throw new Error(`短信网关不可达：${error.message}`, { cause: error });
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`短信网关返回非 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`);
  }
  if (!response.ok || (body.Code && body.Code !== 'OK')) {
    throw new Error(body.Message || `短信网关返回 HTTP ${response.status}`);
  }
  return body;
}

/**
 * 发验证码：返回 { request_id, verify_code? }。ReturnVerifyCode 只在联调时应开，
 * 正式流程不请求回显码；这里不把它透给前端，测试网关可自行回固定码。
 */
export async function sendVerifyCode(phone, cfg = smsConfig()) {
  const problem = smsReadyProblem(cfg);
  if (problem) throw new Error(`短信认证未配置完整：${problem}`);
  const body = await callRpc(
    'SendSmsVerifyCode',
    {
      PhoneNumber: phone,
      SignName: cfg.sign_name,
      TemplateCode: cfg.template_code,
      TemplateParam: cfg.template_param || SMS_DEFAULT.template_param,
      CodeLength: String(cfg.code_length),
      ValidTime: String(cfg.valid_time),
      Interval: String(cfg.interval_seconds),
    },
    cfg
  );
  return { request_id: body.RequestId || body.Model?.RequestId || '', model: body.Model || {} };
}

/** 校验验证码：云端回 Model.VerifyResult，PASS 才算过；其他值（FAIL/UNKNOWN）统一按不通过。 */
export async function checkVerifyCode(phone, code, cfg = smsConfig()) {
  const body = await callRpc(
    'CheckSmsVerifyCode',
    { PhoneNumber: phone, VerifyCode: String(code), SchemeName: cfg.scheme_name || undefined },
    cfg
  );
  const result = String(body.Model?.VerifyResult || body.VerifyResult || '').toUpperCase();
  return { pass: result === 'PASS', result };
}

/* ---------------------------------- 频控与流水 ---------------------------------- */

/** 每次尝试都落 sms_send_log：既做频控依据，也留「谁在什么时候给哪个号发过码」的凭据。 */
export function noteSend({ phone, purpose, userId, ip, ok, message, requestId }) {
  run(
    `INSERT INTO sms_send_log (id, phone, purpose, user_id, client_ip, provider_request_id, ok, message, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [crypto.randomUUID(), phone, purpose, userId || null, ip || null, requestId || null, ok ? 1 : 0, String(message || '').slice(0, 300), nowIso()]
  );
}

/**
 * 发送前的本地频控：同号 60 秒一次、同号每小时 5 次、同 IP 每小时 20 次。
 * 计数只算成功的发送（ok=1），失败请求不该把用户锁在门外；但失败也落流水便于排查。
 */
export function sendThrottle(phone, ip, cfg = smsConfig()) {
  const since = new Date(Date.now() - 60 * 1000).toISOString();
  const recent = get('SELECT created_at FROM sms_send_log WHERE phone=? AND ok=1 AND created_at>? ORDER BY created_at DESC LIMIT 1', [phone, since]);
  if (recent) return `发送过于频繁，请 ${cfg.interval_seconds || 60} 秒后再试`;
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const phoneCount = get('SELECT COUNT(*) AS n FROM sms_send_log WHERE phone=? AND ok=1 AND created_at>?', [phone, hourAgo]);
  if (Number(phoneCount?.n || 0) >= 5) return '该手机号一小时内发送次数过多，请稍后再试';
  if (ip) {
    const ipCount = get('SELECT COUNT(*) AS n FROM sms_send_log WHERE client_ip=? AND ok=1 AND created_at>?', [ip, hourAgo]);
    if (Number(ipCount?.n || 0) >= 20) return '当前来源发送次数过多，请稍后再试';
  }
  return null;
}
