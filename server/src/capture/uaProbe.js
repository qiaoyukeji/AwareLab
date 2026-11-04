/**
 * 终端指纹判定：UA 拆分 + 优先级表。
 * 采集面的 UA 串形态千差万别，把「系统看括号内段、浏览器看产品令牌」拆成两条独立通道，
 * 新增内核或国产壳浏览器时只改表，不用动判定流程。
 */

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

const UNKNOWN_OS = '未知';
const UNKNOWN_BROWSER = '其他';

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

/** 产品令牌来自两处：串里的 product/version 与括号段行首的「名字 版本号」写法 */
function productTokens(ua, segments) {
  const tokens = new Set();
  for (const match of ua.matchAll(/([a-z][a-z0-9._-]*)\/([0-9][0-9a-z._-]*)/gi)) tokens.add(match[1]);
  for (const seg of segments) tokens.add(seg.split(/\s+/)[0].toLowerCase());
  return tokens;
}

function osOf(segments) {
  for (const rule of OS_TABLE) {
    if (segments.some((seg) => rule.hints.some((hint) => seg.includes(hint)))) return rule.label;
  }
  return UNKNOWN_OS;
}

function browserOf(tokens) {
  for (const rule of BROWSER_TABLE) {
    if (rule.tokens.some((token) => tokens.has(token))) return rule.label;
  }
  return UNKNOWN_BROWSER;
}

export function probe(userAgent) {
  const ua = String(userAgent ?? '').toLowerCase();
  const segments = commentSegments(ua);
  return { os: osOf(segments), browser: browserOf(productTokens(ua, segments)) };
}

export const OS_BUCKETS = [...OS_TABLE.map((r) => r.label), UNKNOWN_OS];
export const BROWSER_BUCKETS = [...BROWSER_TABLE.map((r) => r.label), UNKNOWN_BROWSER];
