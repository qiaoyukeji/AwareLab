/**
 * 演练数据归属：站点、邮件任务与由其派生的上钩记录，只给创建者本人和管理员看。
 * 依据是 README 与使用手册里对普通用户的承诺——「只看到分给自己的部分」；这条以前只有文档没有实现。
 * 判定只在服务端做，入参里的任何角色/归属字段都不采信；owner_id 为空视为无主，只有管理员能看到。
 */

/** 当前请求是不是管理员；requireSession 已把库里的 role 挂到 req.user，前端传什么都不认。 */
export function isAdmin(req) {
  return req.user?.role === 'admin';
}

/** 当前登录账号的 id；老会话可能没有 user_id，此时一律按「看不到任何归属数据」处理。 */
export function viewerId(req) {
  return req.user?.id || null;
}

/** 单行归属判定：管理员通吃，其余人只认 owner_id 与自己相等；无主行（NULL）不给普通用户看。 */
export function ownsRow(req, row) {
  if (isAdmin(req)) return true;
  const uid = viewerId(req);
  return Boolean(uid && row && row.owner_id && row.owner_id === uid);
}

/**
 * 给列表 SQL 拼归属条件：管理员返回空条件，普通用户返回 `AND <alias>.owner_id = ?`。
 * alias 由调用方给，避免 JOIN 里两张表都有 owner_id 时拼错列。
 */
export function ownerClause(req, alias) {
  if (isAdmin(req)) return { sql: '', params: [] };
  const uid = viewerId(req);
  // 没有 user_id 的会话（v8 之前签发、库里已回填）看不到任何行，也不放行全部
  if (!uid) return { sql: ' AND 1=0', params: [] };
  return { sql: ` AND ${alias}.owner_id = ?`, params: [uid] };
}

/**
 * 上钩记录的归属条件：记录本身没有 owner_id，归属沿 site_id / task_id 追到站点与邮件任务。
 * 管理员不加条件；普通用户只认自己名下站点或任务产生的记录，两边都没有的记录不出现。
 */
export function recordScopeClause(req, alias = 'r') {
  if (isAdmin(req)) return { sql: '', params: [] };
  const uid = viewerId(req);
  if (!uid) return { sql: ' AND 1=0', params: [] };
  return {
    sql: ` AND (${alias}.site_id IN (SELECT id FROM web_sites WHERE owner_id=?) OR ${alias}.task_id IN (SELECT id FROM mail_tasks WHERE owner_id=?))`,
    params: [uid, uid],
  };
}

/** 记录行归属判定（详情、改处置、删、看明文、截图这些按 id 取单条的路由用）。 */
export function ownsRecord(req, row, get) {
  if (isAdmin(req)) return true;
  if (!row) return false;
  const uid = viewerId(req);
  if (!uid) return false;
  if (row.site_id) {
    const site = get('SELECT owner_id FROM web_sites WHERE id=?', [row.site_id]);
    if (site?.owner_id === uid) return true;
  }
  if (row.task_id) {
    const task = get('SELECT owner_id FROM mail_tasks WHERE id=?', [row.task_id]);
    if (task?.owner_id === uid) return true;
  }
  return false;
}
