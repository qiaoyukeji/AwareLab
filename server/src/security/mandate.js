/**
 * 授权门禁：所有投放与采集动作的唯一放行口。
 * gate() 的 reason 原样印在演练对象页面上，只能说访问不了，不能出现演练/授权/采集；操作员看的拒绝原因在 DEPLOY_MESSAGE 与审计里。
 * 有效期不可解析会得 NaN、比不过任何比较而被判成 active，等于发了一张永久授权；域名匹配只认逐字相等或 *. 泛域名，后缀比对会把 example.com 放大成 evil-example.com。
 */
import { get, all, insert, update, nowIso } from '../platform/storage/rows.js';
import { config } from '../platform/settings.js';
import { forbidden } from '../platform/net/envelope.js';

export const REQUIRED_PLEDGE = '我承诺仅在授权范围内使用本平台开展安全意识演练';

// REQUIRED_PLEDGE 登记授权时要求原样抄写，validate() 做全等比较，改这个字符串会让前端提示与后端校验各说一套。

export const PLEDGE_STATEMENT =
  '本平台仅用于授权范围内的安全意识演练，禁止用于任何未授权攻击或侵犯第三方权益的行为。';

// PLEDGE_STATEMENT 给操作员读懂，REQUIRED_PLEDGE 必须逐字抄写才能登记授权，两条别合并。

/**
 * 授权行的实时状态：库里 status 只表达有没有被吊销，是否落在有效期窗口要按当前时间现算，否则过期授权会继续放行采集与投递。
 * 只接受 validate() 校验过的行，否则不可解析的日期得 NaN 会判成 active。
 */
export function effectiveStatus(auth) {
  if (!auth) return 'missing';
  if (auth.status !== 'active') return auth.status;
  const now = Date.now();
  // 日期不可解析得 NaN 时两扇门都打不开、直接判成 active，拦它是 validate() 的职责，这里保持纯判定
  // 两个边界都按严格越界判：正好等于 now 视为已在窗口内，避免续期瞬间被算成过期
  if (new Date(auth.start_at).getTime() > now) return 'pending';
  if (new Date(auth.end_at).getTime() < now) return 'expired';
  return 'active';
}

/** 最近一条仍在窗口内的授权：平台一次演练只认一个授权主体，避免多份授权互相越权 */
// 返回原始行，对外前过 toView()；未命中返回 null（falsy）。只 SELECT status='active'，但仍要过 effectiveStatus：没被吊销不等于在有效期里。
export function findActive() {
  const rows = all("SELECT * FROM authorizations WHERE status='active' ORDER BY created_at DESC");
  return rows.find((r) => effectiveStatus(r) === 'active') ?? null;
}

/**
 * 按 id 取当前可用的授权，已过期/吊销在这里变成 null，调用方无需再判状态；空值不发 SQL。
 * null 可能是记录不存在也可能已过期/吊销，需要区分时用 findById()。
 */
export function resolve(id) {
  if (!id) return null;
  const auth = get('SELECT * FROM authorizations WHERE id=?', [id]);
  return auth && effectiveStatus(auth) === 'active' ? auth : null;
}

/**
 * 按 id 取授权的原始行，不做任何有效期/吊销判定；记录不存在返回 null。
 * 管理面要显示已吊销的行所以用它，访客链路上的判定一律用 resolve()。
 */
export function findById(id) {
  return get('SELECT * FROM authorizations WHERE id=?', [id]);
}

/** 白名单历史上可能是 JSON 数组，也可能是逗号/换行分隔的文本，两种都要能读；空/缺失返回 [] */
// 老数据手填过纯文本白名单，不能因为换了存储格式就集体失效，所以这里只放宽不收紧。
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

/**
 * 白名单条目与实际 Host 的匹配规则（本模块唯一的主机判定实现）：非泛域名只认逐字相等，
 * 早期 endsWith 后缀比对会把 example.com 放大成 evil-example.com，不能再改回去；*. 连裸域一起放开（p.slice(1) 的点是防线）；#ip 只允许 IP 直连，命中不等于放开任何域名。
 */
function hostMatches(pattern, host) {
  const p = String(pattern).toLowerCase().trim();
  if (!p) return false;
  // #ip 只允许 IP 直连；正则只校验四段数字的形状（不查越界）够用，localhost 一并放行给本机验证脚本
  if (p === '#ip') return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost';
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) || host === p.slice(2);
  return host === p;
}

/**
 * Host 头是否落在授权白名单里；false 表示越界访问，调用方（gate）回 404 而不是 403。
 * 先剥端口比一次、再拿带端口整串比一次：登记条目允许写 :8080，只比剥端口的会误判成越界。
 */
export function isHostAuthorized(auth, hostHeader) {
  const header = String(hostHeader || '').toLowerCase();
  const host = header.split(':')[0];
  if (!host) return false;
  return hostWhitelist(auth).some((p) => hostMatches(p, host) || hostMatches(p, header));
}

/**
 * 采集面与投递链路的统一门禁：无授权/已吊销/不在窗口内一律拒绝，白名单外的 Host 回 404 而不是 403，越界请求既拿不到页面也留不下记录。
 * reason 原样出现在演练对象页面，只能中性地说访问不了，内部词进 DEPLOY_MESSAGE 与审计；不传 host 只判有效期（投递链路发信前用）；只读判定，不写库不落审计。
 */
export function gate(auth, { host } = {}) {
  const status = effectiveStatus(auth);
  if (status !== 'active') {
    return {
      ok: false,
      // 过期与没授权给不同码（410 有缓存死链语义），但访客文案两者都要中性
      code: status === 'expired' ? 410 : 403,
      reason: '该页面暂时无法访问。请稍后重试，或向发送方确认链接是否仍然有效。',
    };
  }
  // host 为空时不校验白名单是投递链路的有意行为，不是漏判
  if (host && !isHostAuthorized(auth, host)) {
    return { ok: false, code: 404, reason: '页面不存在或已下线。请确认访问地址是否正确。' };
  }
  return { ok: true, auth };
}

/** 把表单白名单输入统一成条目数组（登记/续期入口用，与 hostWhitelist 的读侧解析对称），无输入返回 []。 */
function toHostList(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return String(value || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 登记/续期共用的入参校验（纯函数，不碰库）：失败返回中文 error，成功返回规范化 hosts，调用方先判 v.error 不要把 hosts 当布尔。
 * 校验顺序即优先级：必填、承诺逐字、白名单非空、时间可解析、止晚于起。时间可解析这条是 NaN 变永久授权的闸门。
 */
function validate(input) {
  const b = input || {};
  if (!b.scope || !b.start_at || !b.end_at) return { error: '授权主体与有效期必填' };
  // 承诺逐字全等、不做归一化：登记授权要操作员主动抄一句，不是勾个框就放行整条投放链路
  if (b.pledge !== REQUIRED_PLEDGE) return { error: '使用承诺文本不正确，请完整输入要求的承诺语句' };
  const hosts = toHostList(b.allowed_hosts);
  // 白名单为空一律拒绝：没有域名范围的有效授权等于对任意 Host 放行采集，比没有授权更危险
  if (!hosts.length) return { error: '必须逐行登记允许仿冒的域名或 IP' };
  // 时间必须可解析：Date.parse 失败留下 NaN，比不过任何比较，effectiveStatus 会一路判成 active 等于发了一张永久授权
  const start = Date.parse(b.start_at);
  const end = Date.parse(b.end_at);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return { error: '有效期不是可识别的时间格式，请用 2026-01-01T00:00:00Z 这样的写法' };
  }
  if (end <= start) return { error: '有效期止必须晚于有效期起' };
  return { hosts };
}

/**
 * 登记一条新授权：校验失败原样返回中文 error，成功返回 row（allowed_hosts 是数组，落库那份是 JSON 字符串）。
 * INSERT authorizations 一行，status 写 active，id 用 UUID；不限制 active 条数，多条并存时 findActive() 取最新一条。
 */
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
    // 库里 status 只表达有没有被吊销，未开始/已过期由时间窗口现算，新登记直接写 active
    status: 'active',
    note: b.note || null,
    // created_at 是 findActive() 多条并存时的仲裁依据（按它倒序取最新一条）
    created_at: nowIso(),
  };
  insert('authorizations', row);
  return { row: { ...row, allowed_hosts: v.hosts } };
}

/**
 * 修改（含续期）一条授权：覆盖式更新，没传的可选字段写成 null；status 由路由当 HTTP 码用，已吊销的记录不可逆只能重新登记。
 * 返回的行里 allowed_hosts 仍是 JSON 字符串，与 register() 的形状不同，路由侧各自 toView()。
 */
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
    // 必须显式写回 active：过期行 status 本来就是 active，能否放行由上面的时间窗口决定；已吊销的行在 409 就返回了，到不了这里
    status: 'active',
  });
  return { row: findById(id) };
}

/**
 * 吊销一条授权（软删除：只改 status='revoked'，历史与关联演练数据保留，取证要能用）；id 不存在返回 null。
 * 存在性由路由先判：update() 对不存在的 id 改 0 行不报错，别拿它当成功标志。连带下线由调用方 closeSitesOfAuthorization() 标 close_reason='authorization'，续期只复活被平台强制下线的、不碰操作员主动收网的。
 */
export function revoke(id) {
  update('authorizations', id, { status: 'revoked' });
  return findById(id);
}

/** 对外输出用：白名单还原成数组，补上按当前时间算出的 effective；null 直接返回 null。 */
// effective 必须有：库里 status 只有 active/revoked 两种，过期只体现在按当前时间算的这个字段，绕过 toView() 直发库行过期授权会显示成生效中。
export function toView(auth) {
  if (!auth) return null;
  return { ...auth, allowed_hosts: hostWhitelist(auth), effective: effectiveStatus(auth) };
}

// 给管理面看的放行前提文案，与 gate() 的访客文案两套，这里可以直说授权；建站/开站/发信被挡时统一回这句，改字要同步 docs/使用手册.md。
export const DEPLOY_MESSAGE = '请先在「演练授权」里登记授权主体、有效期和允许仿冒的域名，平台才允许建钓鱼网站与发信。';

/**
 * 建站与发信的授权硬门禁：没有落在窗口内的授权就直接 403，会结束响应，调用方必须立刻 return。
 * require_authorization=false 时无条件放行（只该在隔离测试实例上设，生产关掉等于没授权也能建钓鱼站）；只看有没有生效授权，域名范围由 isDomainCovered() 把关。
 */
export function assertDeployment(res) {
  if (!config.exercise.require_authorization) return true;
  if (findActive()) return true;
  forbidden(res, DEPLOY_MESSAGE);
  return false;
}

/** 仿冒域名必须落在授权白名单里，否则建站等于授权越界；空域名返回 false，不让漏填的记录变成不限域名。 */
// false 时 api/siteApi 挡下并回中文原因，那是管理面文案可直说授权，与 gate() 的访客中性文案不同口径。
export function isDomainCovered(auth, domain) {
  const target = String(domain || '').toLowerCase().trim();
  if (!target) return false;
  // 判定与门禁共用 hostMatches：非泛域名只认逐字相等，后缀比对会把 example.com 放大成 evil-example.com、越过授权书
  return hostWhitelist(auth).some((pattern) => hostMatches(pattern, target));
}
