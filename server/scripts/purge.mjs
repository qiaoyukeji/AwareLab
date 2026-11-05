/**
 * 演练数据收尾：--status 体检、--sweep 按保留期清理、--purge-all 一键清空整轮产物。
 * 直接对 AWARELAB_DATA/AWARELAB_CONFIG 指向的库动手；不设这两个变量就是操作员的生产数据，
 * 想在副本上试请先导出这两个变量。audit_logs 永不清空；服务在跑时 --purge-all 默认拒绝，
 * 除非显式加 --allow-running。退出码 0 成功 / 1 参数或前置不过 / 2 执行期异常。
 */
import { retentionStatus, runRetentionSweep, purgeAll, CONFIRM_PHRASE } from '../src/platform/maintenance.js';
import { config } from '../src/platform/settings.js';

/** 把 --a=b 与 --flag 两种写法解析成一个对象；不认识的参数原样留着，由调用方报错 */
function parseArgs(argv) {
  const out = { _: [] };
  for (const raw of argv) {
    if (!raw.startsWith('--')) { out._.push(raw); continue; }
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq < 0) out[body] = true;
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

const HELP = `AwareLab 演练数据收尾

只读体检      node server/scripts/purge.mjs --status
按保留期清理  node server/scripts/purge.mjs --sweep [--dry-run]
演练收尾清空  node server/scripts/purge.mjs --purge-all --confirm=${CONFIRM_PHRASE}
                [--no-backup] [--files] [--materials] [--include-authorizations] [--allow-running]

环境隔离      AWARELAB_DATA=... AWARELAB_CONFIG=... 指向副本即可在副本上演练本脚本。
              不设这两个变量 = 直接操作 server/data 里的生产数据。
说明          --purge-all 默认保留 authorizations 与模板素材，默认先备份数据库。
              audit_logs 永不清空：清空动作本身必须留痕。`;

/** 各表待删行数拼成一行，全 0 时说人话而不是打一排 0 */
function formatPending(pending) {
  const parts = Object.entries(pending || {}).filter(([, n]) => Number(n) > 0).map(([table, n]) => `${table}=${n}`);
  return parts.length ? parts.join('  ') : '无过期待删数据';
}

/** 探一次信标面健康检查；purgeAll 删 web_sites 但监听由服务进程持有，避免库里没记录页面上还挂着 */
async function serviceRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${config.panel.port}/alab/health`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h || (!args.status && !args.sweep && !args['purge-all'])) {
  console.log(HELP);
  // 没给动作时按参数不过退出，方便 CI 与 shell 脚本发现其实什么都没做
  process.exit(args.help || args.h ? 0 : 1);
}

console.log('AwareLab 演练数据收尾');
console.log(`数据库: ${config.paths.db}`);
console.log(`保留期: 数据 ${config.exercise.retention_days} 天　审计 ${config.exercise.audit_retention_days} 天`);

try {
  if (args.status) {
    const status = retentionStatus({ withFiles: true });
    console.log('');
    console.log(`清理是否启用: ${status.enabled ? '是' : `否（${status.reason || 'retention_days 未配置或 <= 0'}）`}`);
    console.log(`数据 cutoff: ${status.cutoff_at || '—'}　审计 cutoff: ${status.audit_cutoff_at || '—'}`);
    console.log(`最老一条数据: ${status.oldest_created_at || '—'}`);
    console.log(`下次巡检: ${status.next_sweep_at || '—（未注册定时器）'}`);
    console.log(`过期待删: ${formatPending(status.pending)}`);
    if (status.files_pending) {
      const files = Object.entries(status.files_pending).filter(([, n]) => Number(n) > 0);
      console.log(`过期文件: ${files.length ? files.map(([dir, n]) => `${dir}=${n}`).join('  ') : '无'}`);
    }
    process.exit(0);
  }

  if (args.sweep) {
    const dryRun = args['dry-run'] === true;
    if (dryRun) console.log('\n[dry-run] 只计算，不删除、不写审计');
    const summary = runRetentionSweep({ actor: 'cli', ip: null, dryRun });
    if (summary.skipped) {
      console.log(`\n已跳过：${summary.reason}`);
      console.log('要启用清理，请在 config.yaml 里把 exercise.retention_days 设成正数天数。');
      process.exit(0);
    }
    const rows = Object.entries(summary.removed).filter(([, n]) => n > 0);
    const files = Object.entries(summary.files).filter(([, n]) => n > 0);
    console.log('');
    console.log(`cutoff: ${summary.cutoff_at}　审计 cutoff: ${summary.audit_cutoff_at}`);
    console.log(`数据行: ${rows.length ? rows.map(([t, n]) => `${t}=${n}`).join('  ') : '0 行'}`);
    console.log(`文件: ${files.length ? files.map(([t, n]) => `${t}=${n}`).join('  ') : '0 个'}　释放 ${summary.files_bytes} 字节　失败 ${summary.files_failed} 个`);
    console.log(`${dryRun ? '预计' : '实际'}耗时 ${summary.seconds} 秒${dryRun ? '' : '（已写 data.prune 审计）'}`);
    process.exit(0);
  }

  if (args.confirm !== CONFIRM_PHRASE) {
    console.error(`\n拒绝执行：--purge-all 必须带 --confirm=${CONFIRM_PHRASE}`);
    console.error('这个动作会删除本轮演练的全部产物（上钩记录、事件、专属链接令牌、发送任务与收件人、站点、推送流水）。');
    console.error('audit_logs 不在删除范围内；authorizations 与模板素材默认保留。');
    process.exit(1);
  }
  if (await serviceRunning() && args['allow-running'] !== true) {
    console.error(`\n拒绝执行：检测到 127.0.0.1:${config.panel.port} 上的服务还在跑。`);
    console.error('清空会删掉 web_sites 行，但采集监听是服务进程持有的。先停服务（Ctrl+C 或 systemctl stop）再收尾。');
    console.error('确实要在服务运行时清空，请加 --allow-running，并自己处理"页面上线着、库里没记录"的现场。');
    process.exit(1);
  }

  const backup = args['no-backup'] !== true;
  console.log('');
  console.log(`备份: ${backup ? '清空前先 VACUUM INTO 一份到 data/backup/' : '已用 --no-backup 关闭（不可回滚）'}`);
  console.log(`落盘文件: ${args.files === true ? '一并清空 attachments/screenshots/outbox' : '保留（加 --files 才删）'}`);
  console.log(`授权记录: ${args['include-authorizations'] === true ? '一并删除' : '保留（合规前提）'}`);
  console.log(`模板素材: ${args.materials === true ? '一并删除' : '保留（下次演练不必从头配）'}`);

  const result = purgeAll({
    confirm: args.confirm,
    backup,
    actor: 'cli',
    ip: null,
    files: args.files === true,
    materials: args.materials === true,
    includeAuthorizations: args['include-authorizations'] === true,
  });
  console.log('');
  if (result.backed_up_to) console.log(`已备份到: ${result.backed_up_to}`);
  for (const [table, n] of Object.entries(result.removed)) console.log(`  ${table}: 删除 ${n} 行`);
  console.log(`落盘文件: 删除 ${result.files_removed} 个（失败 ${result.files_failed} 个）`);
  console.log(`耗时 ${result.seconds} 秒（已写 data.purge_all 审计，audit_logs 未被清空）`);
  process.exit(0);
} catch (err) {
  // 未确认与备份失败都抛中文 Error，这里统一打印给操作员
  console.error(`\n执行失败：${err.message}`);
  process.exit(2);
}
