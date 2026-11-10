/**
 * 每分钟配额的共用实现：信标面的上报回调、邮件像素、追踪链接都走这一份。
 * 纯内存固定窗口，阈值是同一维度最多 limit 次/分钟，不是精确速率限制；重启清零，多实例各算各的。
 * 放在独立模块里，是为了让 pixel/trace 与 callback 用同一张表——分开计数时攻击者换个入口就能绕过。
 */
const RATE_WINDOW_MS = 60_000;
const rateHits = new Map();

/** 返回 true 表示这一分钟内还没超过 limit 次。 */
export function rateAllowed(key, limit) {
  const now = Date.now();
  const bucket = rateHits.get(key);
  if (!bucket || now - bucket.since > RATE_WINDOW_MS) {
    rateHits.set(key, { since: now, hits: 1 });
    // 两类 key 都由攻击者可控，桶数会随流量线性膨胀；超过 2000 扫一遍清掉过期窗口，别让限流表自己变成内存 DoS
    if (rateHits.size > 2000) {
      for (const [k, v] of rateHits) if (now - v.since > RATE_WINDOW_MS) rateHits.delete(k);
    }
    return true;
  }
  bucket.hits += 1;
  return bucket.hits <= limit;
}
