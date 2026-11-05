/**
 * 管理面壳页与信标面的统一响应头基线：CSP default-src 'self'、frame-ancestors 'none'、nosniff、no-referrer，TLS 下再加 HSTS；x-powered-by 在 app 创建处关掉。
 * 采集面的仿冒页由站点自己的监听端口出页，不经过这里，给它们套后台安全头反而是破绽。
 */

/**
 * script-src 保留 'unsafe-inline'：壳页要用一段内联脚本把随机后台路径注入 window.__ALAB_PANEL__，
 * 这个值不能编译进构建产物。素材预览走 iframe srcdoc，继承父页策略，而预览的假登录页与教学页本身就是内联脚本。
 * CSP 只规定浏览器在哪里执行脚本，注入执行由渲染前的净化拦截，净化挡得住脚本注入，挡不住外链引用。
 * 随机后台路径等于入口地址，不写进任何头值，也不进日志。
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

// 每一条都会被浏览器强制执行，收紧之前先想清楚前端哪块会当场死掉：CSP 写漏一条的表现是请求静默失败、界面空白，没有明确报错。
// img/font/frame 放开 data: 与 blob: 是因为素材预览和图标走 base64、Object URL，收掉就看不见图。
// connect-src 'self' 让 XHR/fetch 只能打本进程，form-action 'self' 让表单只能提交回本进程，
// 后台页面里渲染的假登录页素材与教学页交出的内容就出不了本机。
// frame-ancestors 'none' 与下面的 X-Frame-Options 是同一件事的新旧写法，两条都要留。
// 分隔符由 join('; ') 统一生成，单项里再写分号会变成双分号策略。

/**
 * 当前请求是否走 https，只有为真才下发 HSTS：http 下发会把浏览器锁死在 https，本地调试直接打不开。
 * 只看 x-forwarded-proto 第一跳，链尾那条是上一跳给的协议，可能已被降级终止。
 * 该头可被客户端伪造，伪造它只会让浏览器多收到一份 HSTS 或让 Cookie 少个 Secure，拿不到权限，所以没设 trust_proxy 闸门。
 */
function isTls(req) {
  return Boolean(req.secure) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

/** 只写头、不发体、无条件放行，没有拒绝路径。这些头是发出去的声明，改了要重启才对新请求生效。 */
export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  // DENY：任何站点包括同源都不许内嵌后台页面，防的是把管理面塞进诱饵页里点击劫持
  res.setHeader('X-Frame-Options', 'DENY');
  // 信标面回的内容多，这条挡住老浏览器把 JSON 和文本嗅成脚本或 HTML
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 管理面跳出去或被外部资源引用时不带来源
  res.setHeader('Referrer-Policy', 'no-referrer');
  // 15552000 秒即 180 天，includeSubDomains 是因为后台可能挂在子域上，只锁精确主机不够
  if (isTls(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}
