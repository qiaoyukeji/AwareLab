/**
 * 取请求来源 IP：这个地址既决定登录失败的锁定归属，也是取证证据。
 * 默认只信不可伪造的 socket 对端地址，config.panel.trust_proxy 为真才认 x-forwarded-for。
 * 返回值参与 Map 键和库列比较，规范化（去 ::ffff: 前缀、去 %zone 后缀）不能省。
 */
import { config } from '../settings.js';

/**
 * 规范化 IP 文本，空输入得空串，调用方按 falsy 兜底。去 ::ffff: 前缀，否则 Node 双栈下同一 IPv4 会以两种写法落进审计与锁定计数；去 %zone 后缀，那是链路本地地址带的接口名。
 */
function normalize(raw) {
  return String(raw || '').replace(/^::ffff:/, '').replace(/%.*$/, '');
}

/** socket 对端地址，不可伪造；挂在反向代理后面只会是代理本身，不能当来源 IP 用于取证，连接已断时为空串。拒绝伪造的场景用它。 */
export function peerIp(req) {
  return normalize(req.socket?.remoteAddress || '');
}

/**
 * 取请求来源 IP。只有 trust_proxy 为真才认 x-forwarded-for 的第一跳（那是原始客户端，后面几段由各级代理追加），
 * 并兼容同名多头的数组形态。这个头由客户端随意填写，采信它等于让锁定归属可被绕过、取证 IP 可被捏造。
 * 头缺失、空串、只写了逗号都退回 peerIp()，免得锁定计数键落成同一个空串，所有人共享一条锁定记录。
 * 第一跳同样可被客户端预置，开这个开关的前提是前置代理会重写或剥离它。
 */
export function clientIp(req) {
  if (!config.panel.trust_proxy) return peerIp(req);
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return normalize(first?.split(',')[0]?.trim()) || peerIp(req);
}
