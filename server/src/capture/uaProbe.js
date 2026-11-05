/**
 * 终端指纹判定：系统看括号内段、浏览器看产品令牌，两条独立通道，新增内核只改表。
 * UA 由客户端自控、可以随便伪造，结果只作分布统计，不进授权和身份判据。
 */

// 表序即优先级：鸿蒙、苹果在前，免得安卓串里带 linux 时被 Linux 抢走。
// hints 是包含匹配不是逐字相等，段里带版本号和 -build 后缀
const OS_TABLE = [
  { label: '鸿蒙', hints: ['harmonyos', 'hongmeng'] },
  { label: '苹果', hints: ['iphone', 'ipad', 'ipod'] },
  { label: 'MacOS', hints: ['macintosh', 'mac os x'] },
  { label: 'Windows', hints: ['windows nt', 'win32', 'win64'] },
  { label: '安卓', hints: ['android'] },
  { label: 'Linux', hints: ['linux', 'x11', 'ubuntu', 'debian', 'fedora'] },
];

// 顺序即优先级：壳浏览器普遍同时带 Chrome/Safari 令牌，越具体的内核要排得越前
const BROWSER_TABLE = [
  { label: 'Edge', tokens: ['edg', 'edga', 'edgios', 'edge'] },
  { label: 'IE', tokens: ['msie', 'trident'] },
  { label: '火狐', tokens: ['firefox', 'fxios', 'fenix'] },
  { label: '谷歌', tokens: ['chrome', 'crios', 'chromium'] },
  { label: 'Safari', tokens: ['safari', 'version'] },
];

// 留着这两类，看板上才能区分是表老了还是数据坏了
const UNKNOWN_OS = '未知';
const UNKNOWN_BROWSER = '其他';

/** 取括号内的段，入参需已小写。只做一层括号，嵌套会被截断，常见 UA 里没有嵌套。 */
function commentSegments(ua) {
  const out = [];
  for (const chunk of ua.match(/\(([^)]*)\)/g) ?? []) {
    for (const seg of chunk.slice(1, -1).split(';')) {
      const value = seg.trim();
      if (value) out.push(value);
    }
  }
  return out;
}

/**
 * 浏览器侧的产品令牌，两个来源都要：串里的 product/version，和括号段行首的"名字 版本号"。
 * 版本号必须以数字开头，否则 "like Gecko" 会被当成令牌。
 */
function productTokens(ua, segments) {
  const tokens = new Set();
  for (const match of ua.matchAll(/([a-z][a-z0-9._-]*)\/([0-9][0-9a-z._-]*)/gi)) tokens.add(match[1]);
  for (const seg of segments) tokens.add(seg.split(/\s+/)[0].toLowerCase());
  return tokens;
}

/** 段里包含关键字即命中（段本身带版本与架构后缀），按 OS_TABLE 顺序返回；全不中给 UNKNOWN_OS。 */
function osOf(segments) {
  for (const rule of OS_TABLE) {
    if (segments.some((seg) => rule.hints.some((hint) => seg.includes(hint)))) return rule.label;
  }
  return UNKNOWN_OS;
}

/**
 * 令牌逐字命中，和 osOf 的包含匹配刻意不同：壳浏览器同时带 chrome/safari，
 * 包含匹配会把国产壳全认成 Chrome。
 */
function browserOf(tokens) {
  for (const rule of BROWSER_TABLE) {
    if (rule.tokens.some((token) => tokens.has(token))) return rule.label;
  }
  return UNKNOWN_BROWSER;
}

/** 唯一入口：任意入参统一转小写，返回 { os, browser } 两个中文标签，不抛错。 */
export function probe(userAgent) {
  const ua = String(userAgent ?? '').toLowerCase();
  const segments = commentSegments(ua);
  return { os: osOf(segments), browser: browserOf(productTokens(ua, segments)) };
}

// 从判定表派生，保证表里能产出的标签和界面上能筛的标签同源
export const OS_BUCKETS = [...OS_TABLE.map((r) => r.label), UNKNOWN_OS];
export const BROWSER_BUCKETS = [...BROWSER_TABLE.map((r) => r.label), UNKNOWN_BROWSER];
