/**
 * 本进程（管理面 + 信标面）的统一响应头基线。
 * 采集面的钓鱼页由站点自己的监听端口出页，不经过这里，因此不受本策略约束。
 *
 * script-src 保留 'unsafe-inline' 是两个既成事实：
 * 1) 壳页面用一段内联脚本把随机后台路径注入 window.__ALAB_PANEL__（入口值不能编译进产物）；
 * 2) 素材预览走 iframe 的 srcdoc，而 srcdoc 文档继承父页策略，假登录页与教学页本身就是内联脚本的产物。
 * 真正封堵注入执行的位置在渲染前净化，见 docs/整改与优化方案.md 的 SEC-07。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' data: blob:",
  'frame-ancestors \'none\'',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** 只在真的走 https 时才有意义，http 下发 HSTS 会把浏览器永久锁死 */
function isTls(req) {
  return Boolean(req.secure) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (isTls(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}
