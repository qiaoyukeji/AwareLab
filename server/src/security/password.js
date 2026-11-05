/**
 * 口令哈希：scrypt + 每账号独立盐，存 `scrypt$N$r$p$salt$hash` 单串。
 * 之前管理员口令是 config.yaml 里的明文全等比较，多账号体系下必须换成哈希：库文件会被备份、导出、拷走。
 * scrypt 参数取 Node 默认的 N=16384/r=8/p=1（约 16MB 内存），单次校验 30~60ms，足够压住离线爆破又不拖慢登录。
 * 校验用 timingSafeEqual：字符串 === 会在第一个不同字节返回，给计时侧信道留口子。
 */
import crypto from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const ALGO = 'scrypt';

/** 生成哈希串；明文口令只在这个函数里存在一次，不写日志、不进审计。 */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(String(plain), salt, KEY_LEN, { N, r: R, p: P });
  return [ALGO, N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * 校验口令。格式不认识（老库里可能被人塞过明文）一律按不匹配处理，不抛异常：
 * 登录路径上抛错会变成 500，把「口令错」暴露成「服务坏」，还给爆破者多一个信号。
 */
export function verifyPassword(plain, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== ALGO) return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (!salt.length || !expected.length) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(plain), salt, expected.length, {
      N: Number(n) || N,
      r: Number(r) || R,
      p: Number(p) || P,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** 口令强度：8~64 位，与原有管理员口令规则一致；新账号建立与重置共用。 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;

/** 返回 null 表示合规，否则返回中文原因（调用方直接 400）。 */
export function passwordProblem(plain) {
  const value = String(plain == null ? '' : plain);
  if (value.length < PASSWORD_MIN) return `口令至少 ${PASSWORD_MIN} 位`;
  if (value.length > PASSWORD_MAX) return `口令最多 ${PASSWORD_MAX} 位`;
  return null;
}
