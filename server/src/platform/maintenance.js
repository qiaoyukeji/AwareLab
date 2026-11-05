/**
 * 数据保留与清理：按保留期删除过期演练数据与落盘产物，并提供演练收尾的一键清空。
 * 审计走独立更长的保留期；purgeAll 永不删 audit_logs，清空动作本身要留痕。
 * DELETE 审计表是全仓仅此一处；清空只碰白名单目录（attachments/screenshots/outbox），绝不删目录本身或 db/config。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './settings.js';
import { run, get, all } from './storage/rows.js';
import { db as defaultDb } from './storage/connection.js';

/** 按天配、按毫秒比较，避开 Date 加减的时区坑 */
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 首跑延迟 30 秒：等站点恢复与路由挂载跑完，不抢启动期 IO */
const FIRST_SWEEP_DELAY_MS = 30 * 1000;
/** 一键清空的二次确认口令；CLI 与界面共用同一字面量，导出给 purge.mjs 做 --confirm 比对 */
export const CONFIRM_PHRASE = 'DELETE-ALL';

/**
 * 走保留期清理的表及 cutoff 归属；表名拼进 SQL，必须是代码常量不能来自输入。
 */
const RETENTION_TARGETS = [
  { table: 'records', useAuditCutoff: false },
  { table: 'events', useAuditCutoff: false },
  { table: 'push_logs', useAuditCutoff: false },
  // 审计单独一档：保留期必须 >= 数据保留期
  { table: 'audit_logs', useAuditCutoff: true },
];

/**
 * 允许删文件的白名单目录键；不含 uploads 与 data 根目录（db 与 config.yaml 在那儿）。
 */
const FILE_DIR_KEYS = ['attachments', 'screenshots', 'outbox'];

/**
 * 收尾默认清空的表：只清演练产物。authorizations 不在内（合规前提），
 * smtp_profiles/settings/sessions 也不在内（平台配置与登录态，收尾不该清掉自己）。
 */
const PURGE_TABLES = ['records', 'events', 'capture_tokens', 'mail_recipients', 'mail_tasks', 'push_logs', 'web_sites'];

/** --materials 才清的模板类表，日常收尾保留免得下次从头配 */
const MATERIAL_TABLES = ['learn_pages', 'web_templates', 'mail_templates'];

/**
 * 把可能是脏值的保留期读成正数天数，0 表示不清理。
 * NaN 也落到 0：脏配置不该触发大规模删除。
 */
function positiveDays(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** node:sqlite 参数落形，与 rows.js 的 normalize 同口径（注入的连接不走 rows.js）。 */
function bindParams(params) {
  return params.map((p) => {
    // undefined→null：驱动对 undefined 抛错，调用方常写 {x: obj?.field}
    if (p === undefined) return null;
    // SQLite 无布尔列，ok/dry_run 一律 0/1
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

/**
 * 把默认库与注入库两条路收敛成同一套 run/get/all 调用形状。
 * 默认路径复用 rows.js 的 run/get/all，保持全仓唯一执行出口、口径一致。
 */
function makeExecutor(injected) {
  if (!injected || injected === defaultDb) {
    return { run, get, all, usingDefault: true };
  }
  return {
    usingDefault: false,
    run: (sql, params = []) => injected.prepare(sql).run(...bindParams(params)),
    // 与 rows.js 的 get 同口径：没命中给 null，调用方只判 null
    get: (sql, params = []) => injected.prepare(sql).get(...bindParams(params)) ?? null,
    all: (sql, params = []) => injected.prepare(sql).all(...bindParams(params)),
  };
}

/**
 * 判断 target 是否仍在 baseDir 内，防 ../ 穿越与符号链接跳出。
 * 不用 startsWith：data/screenshots-evil 也以 data/screenshots 开头，path.relative 判得准。
 */
function isInsideDir(baseDir, target) {
  const rel = path.relative(baseDir, target);
  // rel 为空表示 target 就是目录本身，不能删目录自身
  if (rel === '') return false;
  // rel 为 '..' 或以 '../' 开头 = 跳出目录；绝对值只可能跨盘符（Windows），同样出界
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

/**
 * 扫描白名单目录里可删的普通文件，只读不删；越界、符号链接、脏 stat 都跳过。
 * 只看直接子层：递归删除爆炸半径不可控，出现子目录宁可留给人看。
 */
function collectPrunableFiles(olderThanMs) {
  const byDir = {};
  const entries = [];
  let bytes = 0;
  let links = 0;
  for (const key of FILE_DIR_KEYS) {
    byDir[key] = 0;
    const baseDir = path.resolve(config.paths[key] || '');
    let names;
    try {
      names = fs.readdirSync(baseDir);
    } catch {
      // 目录缺失当作没有文件，不中断整轮清理
      continue;
    }
    for (const name of names) {
      // join 后 resolve，断言它还在目录内
      const candidate = path.resolve(path.join(baseDir, name));
      if (!isInsideDir(baseDir, candidate)) continue;
      let stat;
      try {
        // lstat 认出符号链接就不删：出现链接多有人在借它做映射，交人工判断
        stat = fs.lstatSync(candidate);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        links += 1;
        continue;
      }
      // 只删普通文件：目录/FIFO/socket 不碰（rmSync 不带 recursive）
      if (!stat.isFile()) continue;
      if (olderThanMs !== null && !(stat.mtimeMs < olderThanMs)) continue;
      byDir[key] += 1;
      bytes += stat.size;
      // 带上目录键：删除阶段按它归集计数，不用 basename 反推（Windows 上混用 / 与 \ 会判错）
      entries.push({ key, dir: baseDir, file: candidate, size: stat.size });
    }
  }
  return { byDir, entries, bytes, links };
}

/**
 * 删除扫描收出来的文件，单个删不掉（占用/已消失）只累加 failed 并继续。
 * 删除前再断言一次路径在目录内：扫描与删除之间隔着一段时间。
 */
function removeFiles(entries) {
  const counts = {};
  for (const key of FILE_DIR_KEYS) counts[key] = 0;
  let bytes = 0;
  let failed = 0;
  for (const entry of entries) {
    const baseDir = path.resolve(entry.dir);
    const target = path.resolve(entry.file);
    if (!isInsideDir(baseDir, target)) continue;
    try {
      fs.rmSync(target, { force: true });
      counts[path.basename(baseDir)] = (counts[path.basename(baseDir)] || 0) + 1;
      bytes += entry.size;
    } catch {
      failed += 1;
    }
  }
  return { counts, bytes, failed };
}

/**
 * 写一条清理审计（data.prune / data.purge_all），永不抛错。
 * 不用 security/audit.js 的 writeAudit：它要 req 拿 actor/ip 且写死默认库连接，
 * 注入内存库时会清了 A 库把审计写进 B 库。这里复用它的列口径与 detail 4000 字符上限，
 * 代价是 audit.js 列形状变动要同步改。detail 只放计数与 cutoff。
 */
function insertPruneAudit(exec, { action, targetKind, targetId, actor, ip, detail }) {
  try {
    exec.run(
      'INSERT INTO audit_logs (id,actor,action,target_kind,target_id,detail,ip,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [
        crypto.randomUUID(),
        // 未登录上下文（定时器、CLI）留 null 不编 "system"：取证要能区分人点的和不是人点的
        actor ?? null,
        action,
        targetKind,
        targetId,
        // 4000 字符上限照抄 audit.js：detail 无界写入会撑爆审计表、卡住证据页
        detail === null || detail === undefined ? null : JSON.stringify(detail).slice(0, 4000),
        ip ?? null,
        // 审计时间戳用真实时间，不吃入参 now（那是 cutoff 的模拟时钟）
        new Date().toISOString(),
      ]
    );
    return true;
  } catch (err) {
    // 审计挂了只留一行控制台，不打断清理本身
    console.error('[maintenance] 清理审计写入失败：', err.message);
    return false;
  }
}

/** 数某表早于 cutoff 的行数（只读）；cutoff 为 null 给 0。表名来自本文件常量。 */
function countExpired(exec, table, cutoff) {
  if (!cutoff) return 0;
  const row = exec.get(`SELECT COUNT(*) AS n FROM ${table} WHERE created_at < ?`, [cutoff]);
  return Number(row?.n ?? 0);
}

/** 删某表早于 cutoff 的行，返回实际删除条数；cutoff 为 null 时不删返回 0。 */
function deleteExpired(exec, table, cutoff) {
  if (!cutoff) return 0;
  const result = exec.run(`DELETE FROM ${table} WHERE created_at < ?`, [cutoff]);
  return Number(result?.changes ?? 0);
}

/** 秒数保留三位小数，给界面看 */
function roundSeconds(ms) {
  return Number((ms / 1000).toFixed(3));
}

/**
 * 按 exercise.retention_days 删除过期数据与落盘产物，并写两条 data.prune 审计（删前 plan、删后 applied）。
 * options：now（只影响 cutoff 不影响审计时间戳）、actor/ip、dryRun（只算不删也不写审计）、db（注入内存库）。
 * 保留期缺失/0/负数时一条不删、一条审计不写：没配保留期不等于把证据全删光。
 * audit_logs 用独立的更长 cutoff，审计要比它记录的证据活得久；plan 行是为 DELETE 中途被杀准备的。
 */
export function runRetentionSweep(options = {}) {
  const { now = new Date(), actor = null, ip = null, dryRun = false, db = null } = options;
  const startedAt = Date.now();
  const exec = makeExecutor(db);
  const days = positiveDays(config.exercise?.retention_days);
  const auditDays = positiveDays(config.exercise?.audit_retention_days);

  const removed = { records: 0, events: 0, push_logs: 0, audit_logs: 0 };
  const files = { attachments: 0, screenshots: 0, outbox: 0 };

  // 保留期未启用：什么都不动，0/负数是长期留存部署的退路
  if (!days) {
    return {
      skipped: true,
      reason: '保留期未启用',
      cutoff_at: null,
      audit_cutoff_at: null,
      removed: { ...removed },
      files: { ...files },
      files_bytes: 0,
      files_failed: 0,
      dry_run: !!dryRun,
      seconds: roundSeconds(Date.now() - startedAt),
    };
  }

  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  // 审计保留期没配/配 0 → null，语义是审计永不清理，不是跟数据一起删
  const auditCutoff = auditDays ? new Date(now.getTime() - auditDays * DAY_MS).toISOString() : null;
  const cutoffMs = now.getTime() - days * DAY_MS;

  // 先算摘要再删，审计里要能对账删了多少
  const pending = {};
  for (const target of RETENTION_TARGETS) {
    pending[target.table] = countExpired(exec, target.table, target.useAuditCutoff ? auditCutoff : cutoff);
  }
  const scan = collectPrunableFiles(cutoffMs);
  // files_bytes 在 dryRun/真删两分支下含义切换，同键复用省磁盘这一行
  let filesBytes = scan.bytes;
  let filesFailed = 0;

  if (!dryRun) {
    insertPruneAudit(exec, {
      action: 'data.prune',
      targetKind: 'retention',
      targetId: 'plan',
      actor,
      ip,
      detail: {
        phase: 'plan',
        dry_run: false,
        retention_days: days,
        audit_retention_days: auditDays || null,
        cutoff_at: cutoff,
        audit_cutoff_at: auditCutoff,
        rows: { ...pending },
        files: { ...scan.byDir, bytes: scan.bytes, skipped_links: scan.links },
      },
    });
  }

  // 删除阶段：dryRun 时整段跳过，applied 审计也不写（没发生的事不留痕）
  if (!dryRun) {
    for (const target of RETENTION_TARGETS) {
      removed[target.table] = deleteExpired(exec, target.table, target.useAuditCutoff ? auditCutoff : cutoff);
    }
    const deletedFiles = removeFiles(scan.entries);
    for (const key of FILE_DIR_KEYS) files[key] = deletedFiles.counts[key] ?? 0;
    filesBytes = deletedFiles.bytes;
    filesFailed = deletedFiles.failed;
    insertPruneAudit(exec, {
      action: 'data.prune',
      targetKind: 'retention',
      targetId: 'applied',
      actor,
      ip,
      detail: {
        phase: 'applied',
        retention_days: days,
        audit_retention_days: auditDays || null,
        cutoff_at: cutoff,
        audit_cutoff_at: auditCutoff,
        // 计划数与实际数都记：两者不等就说明并发写入或删不掉的脏文件，运维要看得到
        rows_planned: { ...pending },
        rows: { ...removed },
        files: { ...files, bytes: deletedFiles.bytes, failed: deletedFiles.failed },
      },
    });
  }

  return {
    skipped: false,
    cutoff_at: cutoff,
    audit_cutoff_at: auditCutoff,
    removed,
    files,
    files_bytes: filesBytes,
    files_failed: filesFailed,
    dry_run: !!dryRun,
    // 到期未删条数：dryRun 时是全部信息，真删时是计划数，与 removed 并列对账
    pending,
    seconds: roundSeconds(Date.now() - startedAt),
  };
}

/**
 * 只读体检：保留期配成多少、现在到期多少行、下次清理大概什么时候，绝不删除任何东西。
 * withFiles 默认 false：扫白名单目录是同步磁盘 IO，不跟着界面每次刷新跑，要显示待清理文件数才传 true。
 * files_pending 在 withFiles=false 时恒为 null（没扫，不是 0 个）；保留期未启用时 cutoff/pending/next_sweep 归零、enabled=false。
 * oldest_created_at 取四表 created_at 最小值，未启用时也算出来，给哪张表在无限增长的线索。
 */
export function retentionStatus(options = {}) {
  const { now = new Date(), db = null, withFiles = false } = options;
  const exec = makeExecutor(db);
  const days = positiveDays(config.exercise?.retention_days);
  const auditDays = positiveDays(config.exercise?.audit_retention_days);
  const cutoff = days ? new Date(now.getTime() - days * DAY_MS).toISOString() : null;
  const auditCutoff = auditDays ? new Date(now.getTime() - auditDays * DAY_MS).toISOString() : null;

  const pending = { records: 0, events: 0, push_logs: 0, audit_logs: 0 };
  let oldest = null;
  for (const target of RETENTION_TARGETS) {
    const scopedCutoff = target.useAuditCutoff ? auditCutoff : cutoff;
    // 表名来自 RETENTION_TARGETS 常量
    if (scopedCutoff) pending[target.table] = countExpired(exec, target.table, scopedCutoff);
    const row = exec.get(`SELECT MIN(created_at) AS m FROM ${target.table}`);
    const value = row?.m ?? null;
    // ISO 文本定长，字典序即时间序，直接比字符串
    if (value && (oldest === null || value < oldest)) oldest = value;
  }

  // 下次清理时间：内存变量重启即丢，用最近一条 data.prune 推算（含手动清理，是提示不是承诺）
  let nextSweepAt = null;
  if (days) {
    const last = exec.get("SELECT created_at FROM audit_logs WHERE action='data.prune' ORDER BY created_at DESC LIMIT 1");
    if (last?.created_at) {
      const t = Date.parse(last.created_at);
      // 时间列是脏值得 NaN，toISOString 会抛错，判掉后返回 null
      if (Number.isFinite(t)) nextSweepAt = new Date(t + SWEEP_INTERVAL_MS).toISOString();
    }
  }

  return {
    retention_days: days,
    audit_retention_days: auditDays,
    cutoff_at: cutoff,
    audit_cutoff_at: auditCutoff,
    pending,
    oldest_created_at: oldest,
    next_sweep_at: nextSweepAt,
    enabled: !!days,
    files_pending: withFiles ? collectPrunableFiles(days ? now.getTime() - days * DAY_MS : null).byDir : null,
  };
}

/**
 * 注册定时清理，boot/main.js 在 listen 成功后调用一次；每轮都 DELETE 并写审计。
 * intervalMs/firstDelayMs 只给验证脚本留钩子，onSweep 给自检断言用。
 * retention_days <= 0 时压根不注册，返回 started=false；stop() 清掉两个定时器，未注册时是空函数。
 * 定时器都 unref 不拖住退出；runRetentionSweep 全程同步，单线程不会两轮交叠，无需重入标志。
 */
export function startMaintenanceTimer(options = {}) {
  const { db = null, actor = null, ip = null, intervalMs = SWEEP_INTERVAL_MS, firstDelayMs = FIRST_SWEEP_DELAY_MS, onSweep = null } = options;

  if (!positiveDays(config.exercise?.retention_days)) {
    return { stop: () => {}, started: false, reason: '保留期未启用' };
  }

  const tick = () => {
    try {
      const summary = runRetentionSweep({ actor, ip, db });
      if (typeof onSweep === 'function') onSweep(summary);
      const rowCount = Object.values(summary.removed).reduce((a, b) => a + b, 0);
      const fileCount = Object.values(summary.files).reduce((a, b) => a + b, 0);
      // 没删就不打日志：天天报 0 会把异常淹没在噪声里
      if (rowCount || fileCount || summary.files_failed) {
        console.log(`[maintenance] 保留期清理：数据 ${rowCount} 行、文件 ${fileCount} 个（失败 ${summary.files_failed}）`);
      }
    } catch (err) {
      console.error('[maintenance] 保留期清理异常：', err.message);
    }
  };

  // 首跑 setTimeout、后续 setInterval，两者都 unref 否则子进程被定时器吊住
  const first = setTimeout(tick, firstDelayMs);
  const loop = setInterval(tick, intervalMs);
  first.unref?.();
  loop.unref?.();

  return {
    started: true,
    reason: null,
    stop: () => {
      clearTimeout(first);
      clearInterval(loop);
    },
  };
}

/**
 * 清理时刻用的文件名后缀（UTC，yyyyMMdd-HHmmss）。
 * 不用整串 toISOString：带冒号，Windows 文件名不允许。
 */
function stampFor(now) {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/**
 * 备份当前库到 data/backup/purge-<时间戳>.db（VACUUM INTO 出紧凑单文件）。
 * 任一步抛错先 rmSync 半份备份再上抛：半份会被误认成可恢复的完整备份。
 * VACUUM INTO 要求目标不存在，同一秒撞名就追加毫秒再试一次。
 */
function backupDatabase(exec, now) {
  const dir = path.join(config.paths.data, 'backup');
  fs.mkdirSync(dir, { recursive: true });
  let name = `purge-${stampFor(now)}.db`;
  let target = path.join(dir, name);
  if (fs.existsSync(target)) {
    // 追加毫秒：第二份备份不该覆盖第一份（那是删前那一刻的副本）
    name = `purge-${stampFor(now)}-${now.getMilliseconds()}.db`;
    target = path.join(dir, name);
  }
  try {
    exec.run('VACUUM INTO ?', [target]);
  } catch (err) {
    fs.rmSync(target, { force: true });
    throw new Error(`清空前备份失败，已拒绝清空：${err.message}`, { cause: err });
  }
  return { absolute: target, relative: path.relative(config.paths.data, target).split(path.sep).join('/') };
}

/**
 * 演练收尾一键清空演练产物（--purge-all）。confirm 必须逐字等于 DELETE-ALL，否则抛错拒绝清空。
 * backup 默认 true：先 VACUUM INTO 备份再删，备份失败即拒绝清空；backed_up_to 给相对路径不给绝对路径。
 * includeAuthorizations/materials/files 默认 false：授权记录是合规前提，sessions/settings/smtp_profiles 是平台配置不是产物。
 * audit_logs 永不清空，清空动作本身要留痕。
 * 删掉 web_sites 行不会关掉采集监听，务必先停服务或后台下线再收尾。
 */
export function purgeAll(options = {}) {
  const {
    confirm,
    backup = true,
    db = null,
    actor = null,
    ip = null,
    includeAuthorizations = false,
    materials = false,
    files = false,
    now = new Date(),
  } = options;
  const startedAt = Date.now();

  // 参数即承诺，不做 CLI 里问 y/N 的交互，脚本与界面口径一致
  if (confirm !== CONFIRM_PHRASE) throw new Error('未确认，已拒绝清空');

  const exec = makeExecutor(db);
  const backedUpTo = backup ? backupDatabase(exec, now) : null;

  const tables = [...PURGE_TABLES];
  if (includeAuthorizations) tables.push('authorizations');
  if (materials) tables.push(...MATERIAL_TABLES);

  const removed = {};
  for (const table of tables) {
    // 表名来自本文件常量数组
    removed[table] = Number(exec.run(`DELETE FROM ${table}`).changes ?? 0);
  }

  let filesRemoved = 0;
  let filesFailed = 0;
  if (files) {
    // 清空不带 mtime 条件，但仍走同一套白名单目录 + 路径断言，绝不越界
    const scan = collectPrunableFiles(null);
    const result = removeFiles(scan.entries);
    filesRemoved = Object.values(result.counts).reduce((a, b) => a + b, 0);
    filesFailed = result.failed;
  }

  insertPruneAudit(exec, {
    action: 'data.purge_all',
    targetKind: 'purge',
    targetId: 'applied',
    actor,
    ip,
    detail: {
      // 只记清了什么、多少条、备份在哪：不记任何内容字段、邮箱、令牌，也不记绝对路径
      rows: removed,
      files_removed: filesRemoved,
      files_failed: filesFailed,
      backup: backedUpTo ? backedUpTo.relative : null,
      kept_authorizations: !includeAuthorizations,
      materials: !!materials,
    },
  });

  return {
    backed_up_to: backedUpTo ? backedUpTo.relative : null,
    removed,
    files_removed: filesRemoved,
    files_failed: filesFailed,
    kept_authorizations: !includeAuthorizations,
    seconds: roundSeconds(Date.now() - startedAt),
  };
}
