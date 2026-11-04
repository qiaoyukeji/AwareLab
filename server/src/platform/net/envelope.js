/**
 * 管理面统一响应形：{code, data} 成功、{code, message} 失败。
 * 形状固定下来，前端只需要在拦截器里判一次 code。
 */
export const ok = (res, data = true) => res.json({ code: 0, data });

export const fail = (res, code, message) => res.status(code).json({ code, message });

export const badRequest = (res, message) => fail(res, 400, message);
export const unauthorized = (res, message) => fail(res, 401, message);
export const forbidden = (res, message) => fail(res, 403, message);
export const notFound = (res, message) => fail(res, 404, message);
export const conflict = (res, message) => fail(res, 409, message);
export const gone = (res, message) => fail(res, 410, message);
export const tooManyRequests = (res, message) => fail(res, 429, message);

const MAX_PAGE_SIZE = 200;

/** 分页参数收口：越界值一律夹到合法区间，避免恶意 page_size 拖库 */
export function paginate(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.page_size) || 10));
  return { page, page_size: pageSize };
}

export const paged = (res, { rows, total, page, page_size }) =>
  res.json({ code: 0, data: { rows, total, page, page_size } });
