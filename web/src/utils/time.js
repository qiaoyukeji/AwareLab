/**
 * 时间的唯一出口：给操作员看的时间都经这两个函数格式化。
 * 库存 UTC 的 ISO 串，展示换成本机时区；模板不许再自己 slice/replace ISO 字符串。
 * 解析不出来的非标准串（缺 T/时区，Safari 尤甚）原样返回，别当冗余兜底删；空值返回 '—'。
 */
// 补零，保证 MM/HH 永远两位，列表里宽度对齐、也能按字典序排
const pad = (n) => String(n).padStart(2, '0');

/**
 * 日期 + 时分（默认）或带秒的本地时间。
 * seconds=true 追加 :SS，字段级采集时间要开，同一张表单的多个字段常在同一分钟落库，只到分会看不出先后。
 * 空值返回 dash；解析失败返回 String(value)（宁可显示原始 ISO 串，也不显示 Invalid Date 或被改过读数的时间）。
 */
export function fmtTime(value, { seconds = false, dash = '—' } = {}) {
  if (!value) return dash;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  // 这些 getter 返回的都是本机时区读数；getMonth() 是 0 基所以 +1
  const head = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return seconds ? `${head}:${pad(date.getSeconds())}` : head;
}

/**
 * 本机的 HH:MM:SS，用于只看钟点的行（实时命中列表、大屏事件流）；跨天定位交给分组标题或日期列。
 * 参数同 fmtTime；空值返回 dash，解析失败原样返回 String(value)。
 */
export function fmtClock(value, dash = '—') {
  if (!value) return dash;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
