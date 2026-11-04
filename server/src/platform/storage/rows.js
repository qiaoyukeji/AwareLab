import { db } from './connection.js';

/**
 * node:sqlite 只接受 null/number/bigint/string/buffer，
 * 业务侧的布尔与缺省值在这一层统一落形，避免每条语句重复处理。
 */
function normalize(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

export function run(sql, params = []) {
  return db.prepare(sql).run(...normalize(params));
}

export function get(sql, params = []) {
  return db.prepare(sql).get(...normalize(params)) ?? null;
}

export function all(sql, params = []) {
  return db.prepare(sql).all(...normalize(params));
}

export function insert(table, row) {
  const keys = Object.keys(row);
  run(
    `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    keys.map((k) => row[k])
  );
  return row;
}

export function update(table, id, patch, idColumn = 'id') {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  run(
    `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE ${idColumn}=?`,
    [...keys.map((k) => patch[k]), id]
  );
}

export function nowIso() {
  return new Date().toISOString();
}

export function pagedRows(table, where, params, page, pageSize) {
  const total = get(`SELECT COUNT(*) AS n FROM ${table} ${where}`, params).n;
  const rows = all(
    `SELECT * FROM ${table} ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  return { rows, total, page, page_size: pageSize };
}

/** 以 JSON 文本存放的列（配置项、采集内容、终端特征）统一解码，脏数据按空处理 */
export function parseJson(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key=?', [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [key, JSON.stringify(value), nowIso()]
  );
  return value;
}
