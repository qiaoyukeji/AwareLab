import { get, all, insert, update, nowIso } from '../platform/storage/rows.js';
import { config } from '../platform/settings.js';
import { forbidden } from '../platform/net/envelope.js';

export const REQUIRED_PLEDGE = '我承诺仅在授权范围内使用本平台开展安全意识演练';

export const PLEDGE_STATEMENT =
  '本平台仅用于授权范围内的安全意识演练，禁止用于任何未授权攻击或侵犯第三方权益的行为。';

/**
 * 授权行的实时状态。库里存的 status 只表达「有没有被吊销」，
 * 是否落在有效期窗口内必须由当前时间判定，否则过期授权会继续放行采集与投递。
 */
export function effectiveStatus(auth) {
  if (!auth) return 'missing';
  if (auth.status !== 'active') return auth.status;
  const now = Date.now();
  if (new Date(auth.start_at).getTime() > now) return 'pending';
  if (new Date(auth.end_at).getTime() < now) return 'expired';
  return 'active';
}

/** 最近一条仍在窗口内的授权：平台一次演练只认一个授权主体，避免多份授权互相越权 */
export function findActive() {
  const rows = all("SELECT * FROM authorizations WHERE status='active' ORDER BY created_at DESC");
  return rows.find((r) => effectiveStatus(r) === 'active') ?? null;
}

export function resolve(id) {
  if (!id) return null;
  const auth = get('SELECT * FROM authorizations WHERE id=?', [id]);
  return auth && effectiveStatus(auth) === 'active' ? auth : null;
}

export function findById(id) {
  return get('SELECT * FROM authorizations WHERE id=?', [id]);
}

/** 白名单历史上可能是 JSON 数组，也可能是逗号/换行分隔的文本，两种都要能读 */
export function hostWhitelist(auth) {
  const raw = auth?.allowed_hosts;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((s) => String(s));
  } catch {
    /* 落到分隔符解析 */
  }
  return String(raw)
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hostMatches(pattern, host) {
  const p = String(pattern).toLowerCase().trim();
  if (!p) return false;
  // #ip 表示只允许直接以 IP 访问，防止把授权范围扩到整段域名
  if (p === '#ip') return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost';
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) || host === p.slice(2);
  return host === p;
}

export function isHostAuthorized(auth, hostHeader) {
  const header = String(hostHeader || '').toLowerCase();
  const host = header.split(':')[0];
  if (!host) return false;
  // 带端口的 Host 头按整串再比一次，兼容登记时就写了端口的情形
  return hostWhitelist(auth).some((p) => hostMatches(p, host) || hostMatches(p, header));
}

/**
 * 采集面与投递链路的统一门禁。
 * 无授权/已吊销/不在窗口内一律拒绝，白名单外的 Host 直接 404，
 * 让越界请求既拿不到页面也留不下记录。
 */
export function gate(auth, { host } = {}) {
  const status = effectiveStatus(auth);
  if (status !== 'active') {
    return {
      ok: false,
      code: status === 'expired' ? 410 : 403,
      reason:
        status === 'expired'
          ? '演练授权已过期，页面已停止服务。'
          : '当前无有效演练授权，请先在「演练授权」中登记授权范围与有效期。',
    };
  }
  if (host && !isHostAuthorized(auth, host)) {
    return { ok: false, code: 404, reason: `访问用的域名 ${host} 不在授权名单内，已拒绝服务。` };
  }
  return { ok: true, auth };
}

function toHostList(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return String(value || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function validate(input) {
  const b = input || {};
  if (!b.scope || !b.start_at || !b.end_at) return { error: '授权主体与有效期必填' };
  if (b.pledge !== REQUIRED_PLEDGE) return { error: '使用承诺文本不正确，请完整输入要求的承诺语句' };
  const hosts = toHostList(b.allowed_hosts);
  if (!hosts.length) return { error: '必须逐行登记允许仿冒的域名或 IP' };
  if (new Date(b.end_at).getTime() <= new Date(b.start_at).getTime()) return { error: '有效期止必须晚于有效期起' };
  return { hosts };
}

export function register(input) {
  const v = validate(input);
  if (v.error) return v;
  const b = input;
  const row = {
    id: crypto.randomUUID(),
    scope: b.scope,
    contact: b.contact || null,
    start_at: b.start_at,
    end_at: b.end_at,
    allowed_hosts: JSON.stringify(v.hosts),
    pledge: b.pledge,
    status: 'active',
    note: b.note || null,
    created_at: nowIso(),
  };
  insert('authorizations', row);
  return { row: { ...row, allowed_hosts: v.hosts } };
}

export function revise(id, input) {
  const current = findById(id);
  if (!current) return { error: '授权记录不存在', status: 404 };
  if (current.status !== 'active') {
    return { error: '已吊销的授权不可修改，请重新登记一条授权', status: 409 };
  }
  const v = validate(input);
  if (v.error) return v;
  const b = input;
  update('authorizations', current.id, {
    scope: b.scope,
    contact: b.contact || null,
    start_at: b.start_at,
    end_at: b.end_at,
    allowed_hosts: JSON.stringify(v.hosts),
    pledge: b.pledge,
    note: b.note || null,
    // 续期场景：过期的授权把有效期改回当前窗口即可重新解锁平台
    status: 'active',
  });
  return { row: findById(id) };
}

export function revoke(id) {
  update('authorizations', id, { status: 'revoked' });
  return findById(id);
}

/** 对外输出用：白名单还原成数组，并补上按当前时间算出的生效状态 */
export function toView(auth) {
  if (!auth) return null;
  return { ...auth, allowed_hosts: hostWhitelist(auth), effective: effectiveStatus(auth) };
}

export const DEPLOY_MESSAGE = '请先在「演练授权」里登记授权主体、有效期和允许仿冒的域名，平台才允许建钓鱼网站与发信。';

/**
 * 建站与发信的授权门禁：没有落在窗口内的授权就直接 403。
 * 放在这里而不是各路由里，是为了让「投放」的判定只有一处定义。
 */
export function assertDeployment(res) {
  if (!config.exercise.require_authorization) return true;
  if (findActive()) return true;
  forbidden(res, DEPLOY_MESSAGE);
  return false;
}

/** 仿冒域名必须落在授权白名单里，否则建站等于授权越界 */
export function isDomainCovered(auth, domain) {
  const target = String(domain).toLowerCase();
  return hostWhitelist(auth).some((pattern) => {
    const p = String(pattern).toLowerCase();
    if (p === '#ip') return false;
    return target === p.replace(/^\*\./, '') || target.endsWith(p.slice(1));
  });
}
