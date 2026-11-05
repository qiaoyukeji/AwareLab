/**
 * 数据库连接唯一出口：打开 data/awarelab.db、设 PRAGMA、跑表结构迁移。
 * 全仓只有 rows.js 持有它，一个进程一条连接一份 WAL；import 即打开并迁好结构，出错就直接起不来（半开最危险）。
 * 历史库搬迁只做 VACUUM INTO 复制 + 源文件改名 .bak，绝不删源文件：数据不可逆丢失比启动失败严重。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../settings.js';
import { applySchema } from './schema.js';

// SQLite 文件固定头（前 16 字节，结尾 NUL），比看扩展名可靠
const SQLITE_HEADER = 'SQLite format 3\0';

/**
 * 只读文件头 16 字节判断是不是真 SQLite 库；打不开/读不满/头不对/空文件都返回 false。
 * 全部吞成 false：语义就是不确定当不是库，抛错会让启动误报迁移失败。
 */
function isSqliteFile(file) {
  let fd;
  try {
    // 只申请读权限：文件被别的进程占着时宁可判 false 也不去动它
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(16);
    // 短读说明空/被截断，读偏移 0 不动文件指针
    if (fs.readSync(fd, head, 0, 16, 0) < 16) return false;
    // latin1 逐字节映射保证头字节一比一对上，utf8 遇非 ASCII 出替换字符不可信
    return head.toString('latin1') === SQLITE_HEADER;
  } catch {
    return false;
  } finally {
    // finally 关句柄：Windows 上不释放，renameSync 会 EBUSY，整条搬迁路径失效
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * 库文件改名后自动接上历史部署的库，否则升级即数据消失。按目录里现存 SQLite 文件识别前身，不依赖命名。
 */
// 可能新建 target（VACUUM INTO 副本）、把旧主文件与 -wal/-shm 改名 .bak、打日志，绝不删任何文件
// 复制出错 rm 掉半截新库并抛错中止启动；只是改名失败（占用）新库已完整，降级 warn 继续
function migratePredecessorDatabase(target, DatabaseSync) {
  // 新库已存在就是正常路径，直接返回（幂等，重复启动零风险）
  if (fs.existsSync(target)) return null;
  // 候选是同目录的 .db，靠文件头认库，不写死历史名，也不跨目录乱找
  const dir = path.dirname(target);
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => path.join(dir, f))
    // 排除目标自身，用文件头把空 .db / 不是 SQLite 的伪候选筛掉
    .filter((f) => f !== target && isSqliteFile(f))
    // 按修改时间从新到旧：留着好几个旧库时，最近写过的那个才是前身
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates.length) return null;

  // 只搬第一个（最新）候选：全搬会把多份历史库拼成一堆
  const source = candidates[0];
  // 备份后缀去掉 - 和 :（Windows 文件名不许带冒号），多次搬迁不互相覆盖
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  try {
    // 目录可能不存在（首次运行/被清理），recursive 保证 mkdir 不报 ENOENT
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 只读打开旧库：绝不改原件，且 SQLite 想写 -wal 时会报错，占用情况复制前就拦下
    const src = new DatabaseSync(source, { readOnly: true });
    try {
      // VACUUM INTO 重写成新单文件、不带残留 WAL，比 copyFile 稳（拷贝可能带脏 WAL 复活）
      src.prepare('VACUUM INTO ?').run(target);
    } finally {
      // 关源连接释放句柄（Windows 不释放则 renameSync EBUSY），新库已由 VACUUM INTO 落盘
      src.close();
    }
  } catch (err) {
    // 半截新库会让下次启动误判为已迁移，必须清掉再中止
    // 只删 target，绝不删 source：原件还在，下次启动能重来
    fs.rmSync(target, { force: true });
    throw new Error(`历史库迁移失败，已放弃写入新库：${err.message}`, { cause: err });
  }

  // 主文件与 -wal/-shm 一起改名，避免残留日志被新库吸收
  // 真实数据可能还全在 -wal 里没落回主文件，只改主文件会把两次演练的数据串成一份
  for (const suffix of ['', '-wal', '-shm']) {
    const file = source + suffix;
    // -wal/-shm 干净关闭后本就不存在，缺文件是正常状态，跳过不算失败
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
// 返回 {driver, db}，driver 给启动横幅/自检显示；任何一步抛错原样上抛 → 顶层 await 失败 → 进程起不来
// 内存库兜底不做：演练数据落不到盘比启动失败更糟；node:sqlite 要 Node≥22.5，动态 import 让缺模块错误带上下文冒出
async function openDatabase() {
  const { DatabaseSync } = await import('node:sqlite');
  // 先搬迁再打开：新库一旦存在，applySchema 会以为是老库正常启动，历史数据永远接不上（顺序不能倒）
  migratePredecessorDatabase(config.paths.db, DatabaseSync);
  const db = new DatabaseSync(config.paths.db);
  // WAL 让信标面高频小写入不阻塞管理面翻页读，否则访客提交后台查询就整段等锁
  db.exec('PRAGMA journal_mode = WAL');
  // node:sqlite 默认关外键（SQLite 历史兼容），显式开才生效
  // 基线表都没写 FOREIGN KEY 子句，级联清理全靠调用方显式 DELETE（删任务先删 mail_recipients），删父行不会自动带走子行
  db.exec('PRAGMA foreign_keys = ON');
  // 每次启动都调，靠 schema.js 的 user_version 判断要不要动结构（已到位就直接返回）
  applySchema(db);
  return { driver: 'node:sqlite', db };
}

// 顶层 await：import 本文件即等于库已打开且结构已迁移
// 全进程只这一处 new DatabaseSync，下游拿到同一连接同一 WAL；这里抛错就没重试机会，服务起不来（刻意保守）
const { driver, db } = await openDatabase();

export { db, driver };
