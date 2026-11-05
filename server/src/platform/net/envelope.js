/**
 * 管理面统一响应信封：成功 {code:0, data}，失败 {code, message}；HTTP 状态码与 body.code 恒等，前端拦截器只看 code。
 * message 是给操作员看的中文，同一字符串若会流到访客侧就改走中性文案，不在这里加开关。
 */
/** data 缺省是布尔 true，不代表业务成功。 */
export const ok = (res, data = true) => res.json({ code: 0, data });

/**
 * 失败信封的唯一出口。code 同时作为 HTTP 状态码与 body.code，须是 4xx/5xx，传 0 会发不出去。
 * message 用中文直说原因，不把令牌、口令、绝对路径抄进去。
 */
export const fail = (res, code, message) => res.status(code).json({ code, message });

// 状态码语义：400 入参不对、401 未登录或会话过期、403 已登录但门禁不放行、404 记录不存在、
// 409 状态冲突（已吊销的授权不可改）、410 资源曾存在但已过期（授权过期的专属链接）、429 限流与登录锁定。
// 前端按 code 分支，一种情况不要挪到另一种码上。
// 这几个 4xx 助手都直接结束响应，路由里必须 return，否则会再写一次响应头触发 ERR_HTTP_HEADERS_SENT。
// gone() 目前没有调用点，只是补全码表。500 段不在本模块暴露，内部错误由错误中间件统一回中文信封，不外传 err.message。
export const badRequest = (res, message) => fail(res, 400, message);
export const unauthorized = (res, message) => fail(res, 401, message);
export const forbidden = (res, message) => fail(res, 403, message);
export const notFound = (res, message) => fail(res, 404, message);
export const conflict = (res, message) => fail(res, 409, message);
export const gone = (res, message) => fail(res, 410, message);
export const tooManyRequests = (res, message) => fail(res, 429, message);

// 单页上限 200：列表接口背后是 SQLite 查询加 JSON 序列化，不设上限时一个 page_size=999999 就能把管理面拖到没响应。
// 这是界面翻页的量级；取证导出的下载接口不经过 paginate，不受这一档限制。
const MAX_PAGE_SIZE = 200;

/**
 * 分页参数收口：越界值夹进合法区间，page_size 上限 200，这是参数进 SQL LIMIT/OFFSET 前的唯一钳制点。
 * 非数字、空、负数、0 全部退成缺省 page=1、page_size=10 且不报错，参数写歪不该让列表页整块打不开。
 */
export function paginate(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.page_size) || 10));
  return { page, page_size: pageSize };
}

/**
 * 分页列表的成功信封，出参键名用下划线 page_size，与 paginate() 和前端请求参数保持一致。
 * total 是符合条件的总行数而非本页行数，前端分页控件靠它算总页数，传成本页长度界面只显示一页。
 */
export const paged = (res, { rows, total, page, page_size }) =>
  res.json({ code: 0, data: { rows, total, page, page_size } });
