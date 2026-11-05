/**
 * 行级数据门面：全仓唯一把 SQL + 参数丢给 node:sqlite 的出口，不懂业务也不判存在性。
 * insert/update/pagedRows 的表名、列名、idColumn、where 片段是直接拼进 SQL 的，只许传代码常量；条件值必须走 ? + params。
 */
import { db } from './connection.js';

/**
 * node:sqlite 只接受 null/number/bigint/string/buffer，业务布尔与缺省值在这一层统一落形。
 * 这是布尔与 SQLite 0/1 唯一的翻译点：dry_run/secure/ok/redact 都靠它。
 */
function normalize(params) {
  return params.map((p) => {
    // undefined→null：驱动对 undefined 抛错，缺字段应当作这列没值而非整条失败
    if (p === undefined) return null;
    // SQLite 无布尔列，这里统一 true/false→1/0，调用方不必每处自己转
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

/** 执行写语句（INSERT/UPDATE/DELETE/PRAGMA/DDL）。值用 ? 占位，表名列名只来自代码常量；changes=0 不报错，调用方自判。 */
export function run(sql, params = []) {
  return db.prepare(sql).run(...normalize(params));
}

/** 读一行，命中给列名→值，没命中给 null（驱动返回 undefined，这里归一，调用方只判 null）。 */
export function get(sql, params = []) {
  return db.prepare(sql).get(...normalize(params)) ?? null;
}

/** 读多行，空结果给 []（不是 undefined）。大表全量 all() 前先看有没有 pagedRows 可用。 */
export function all(sql, params = []) {
  return db.prepare(sql).all(...normalize(params));
}

/**
 * 整行插入，原样返回 row 方便调用方插完直接回前端。列名取自对象键，必须真是表里的列名。
 * 不校验存在性、不生成 id（id/token 由调用方造好放进 row）；主键或 UNIQUE 冲突直接抛错。
 */
export function insert(table, row) {
  const keys = Object.keys(row);
  run(
    `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    keys.map((k) => row[k])
  );
  return row;
}

/**
 * 按主键局部更新，无返回值（改 0 行也算成功，是改不存在的记录还回成功的根因，api 层要先判存在性）。
 * patch 里 undefined 会被 normalize 成 null 即清空该列；idColumn 默认 'id'，非 id 主键要显式传；不自动刷新 updated_at。
 */
export function update(table, id, patch, idColumn = 'id') {
  const keys = Object.keys(patch);
  // patch 为空提前返回，否则拼出 UPDATE t SET WHERE 的非法 SQL
  if (!keys.length) return;
  run(
    `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE ${idColumn}=?`,
    [...keys.map((k) => patch[k]), id]
  );
}

/**
 * 全库唯一时间戳口径：UTC ISO 文本。created_at/updated_at/sent_at/opened_at 等 TEXT 时间列一律用它。
 * 存 UTC，展示要过 web/src/utils/time.js 转本机时区，否则同一批记录不同页面能差 8 小时。sessions.expires_at 是唯一例外（INTEGER 毫秒）。
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * 分页取整行，返回 {rows,total,page,page_size}。where 须自带 WHERE，值走 ?；排序固定 created_at DESC，表要有这列。
 * total 是条件命中总行数（不是本页），前端分页靠它算页数。
 */
export function pagedRows(table, where, params, page, pageSize) {
  const total = get(`SELECT COUNT(*) AS n FROM ${table} ${where}`, params).n;
  const rows = all(
    `SELECT * FROM ${table} ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    // 页码从 1 起，偏移是 (page-1)*pageSize；先算 total 让空页也返回真实总数
    [...params, pageSize, (page - 1) * pageSize]
  );
  return { rows, total, page, page_size: pageSize };
}

// 列原始文本（form_json/feature_json/settings.value）解不出就回落 fallback
// 容错是刻意的：这些列是历史版本/手工改库/审计 detail 截断留下的脏值，一个坏字段不该把列表页打成 500
/** 以 JSON 文本存放的列（配置项、采集内容、终端特征）统一解码，脏数据按空处理 */
export function parseJson(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    // "null" 能解析成功却给出 null：照样回落 fallback
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 读运行参数（settings 表，value 存 JSON 文本），没登记过返回 fallback。
 * 解析失败原样返回那段文本是刻意的：早期有版本把值当裸串写过，读侧宁可拿到 "true" 也不能让设置页打不开。
 */
export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key=?', [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    // 裸文本兜底：脏值不抛错，交给上层按未配置处理
    return row.value;
  }
}

/**
 * 写运行参数（存在则整值替换），原样返回 value。UPSERT 一行并刷新 updated_at，本函数不写审计（留痕归 api 层）。
 * 值统一 JSON.stringify，布尔与数字不会退化成 "true"/"1"；用 UPSERT 是因为先查再写之间有并发窗口会撞主键。
 */
export function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [key, JSON.stringify(value), nowIso()]
  );
  return value;
}
