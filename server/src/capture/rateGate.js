/**
 * 每分钟配额的共用实现：信标面的上报回调、邮件像素、追踪链接都走这一份。
 * 纯内存固定窗口，阈值是同一维度最多 limit 次/分钟，不是精确速率限制；重启清零，多实例各算各的。
 * 放在独立模块里，是为了让 pixel/trace 与 callback 用同一张表——分开计数时攻击者换个入口就能绕过。
 */
const RATE_WINDOW_MS = 60_000;
// 桶数硬上限：只清过期项的话，攻击者在同一分钟里刷几百万个不同 key（不同令牌、不同 IP 头），
// 全是"没过期"的桶，一张表就能把内存吃干净——过期扫描反过来成了纯开销。
const MAX_BUCKETS = 20_000;
const rateHits = new Map();

/** 返回 true 表示这一分钟内还没超过 limit 次。 */
export function rateAllowed(key, limit) {
  const now = Date.now();
  const bucket = rateHits.get(key);
  if (!bucket || now - bucket.since > RATE_WINDOW_MS) {
    // 满了先扫过期；扫完还满就丢掉最早那个桶（Map 按插入序迭代，取第一个即最早），
    // 宁可少限住一个最老的 key，也不让这张表无限长。
    if (rateHits.size >= MAX_BUCKETS) {
      for (const [k, v] of rateHits) if (now - v.since > RATE_WINDOW_MS) rateHits.delete(k);
      while (rateHits.size >= MAX_BUCKETS) {
        const oldest = rateHits.keys().next();
        if (oldest.done) break;
        rateHits.delete(oldest.value);
      }
    }
    rateHits.set(key, { since: now, hits: 1 });
    return true;
  }
  bucket.hits += 1;
  return bucket.hits <= limit;
}
