import fs from 'node:fs';
import path from 'node:path';
import { config } from '../settings.js';
import { applySchema } from './schema.js';

const SQLITE_HEADER = 'SQLite format 3\0';

function isSqliteFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) < 16) return false;
    return head.toString('latin1') === SQLITE_HEADER;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * 库文件改名后，历史部署留下的单文件库必须自动接上，否则升级即「数据消失」。
 * 按数据目录里现存的 SQLite 文件识别前身，不依赖具体历史命名。
 */
function migratePredecessorDatabase(target, DatabaseSync) {
  if (fs.existsSync(target)) return null;
  const dir = path.dirname(target);
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => path.join(dir, f))
    .filter((f) => f !== target && isSqliteFile(f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates.length) return null;

  const source = candidates[0];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const src = new DatabaseSync(source, { readOnly: true });
    try {
      src.prepare('VACUUM INTO ?').run(target);
    } finally {
      src.close();
    }
  } catch (err) {
    // 半截新库会让下一轮启动误判为「已迁移」，必须清掉再中止
    fs.rmSync(target, { force: true });
    throw new Error(`历史库迁移失败，已放弃写入新库：${err.message}`);
  }

  // 主文件与 WAL/SHM 一起改名，避免残留日志被新库重新吸收
  for (const suffix of ['', '-wal', '-shm']) {
    const file = source + suffix;
    if (!fs.existsSync(file)) continue;
    try {
      fs.renameSync(file, `${file}.bak-${stamp}`);
    } catch (err) {
      console.warn(`[storage] ${path.basename(file)} 就地保留（重命名失败：${err.message}），新库已是完整副本`);
    }
  }
  console.log(`[storage] 已将 ${path.basename(source)} 完整迁移为 ${path.basename(target)}`);
  return source;
}

/**
 * Node 内置 SQLite：无原生编译、无外部数据库服务，单文件即可部署。
 * WAL 让信标面的高频写入不阻塞管理面读取，foreign_keys 保证级联约束生效。
 */
async function openDatabase() {
  const { DatabaseSync } = await import('node:sqlite');
  migratePredecessorDatabase(config.paths.db, DatabaseSync);
  const db = new DatabaseSync(config.paths.db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  applySchema(db);
  return { driver: 'node:sqlite', db };
}

const { driver, db } = await openDatabase();

export { db, driver };
