/**
 * 取请求来源 IP。
 * 平台常被放在反向代理后面，socket 地址只会是 127.0.0.1，
 * 取证口径必须落在 x-forwarded-for 的第一跳（最早的外部来源）。
 */
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const raw = String(first?.split(',')[0]?.trim() || req.socket?.remoteAddress || '');
  return raw.replace(/^::ffff:/, '').replace(/%.*$/, '');
}
