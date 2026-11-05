/**
 * 发布前门禁：语法/lint/构建/selftest/qa/seed 副本/audit/smoke 串行跑一遍，任一步失败即退出码非 0。
 * selftest 与 qa 抢同一批端口必须串行，且都在 .selftest/.qa 隔离副本上跑，绝不落 server/data。
 * lint 两端各跑一次任一端 error 即失败；audit 标 nonBlocking 只出告警。
 * 用法：node server/scripts/ci.mjs [--skip-seed] [--only=<id>] [--with-smoke]。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SERVER_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith('--only='));
const onlyId = only ? only.slice('--only='.length) : null;

/** 低版本 Node 会在 import node:sqlite 处崩，先给一条可读错误 */
function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(`需要 Node.js ≥ 22.5（内置 node:sqlite），当前 ${process.versions.node}`);
    process.exit(1);
  }
}

/** 跑子进程，返回 { ok, seconds, tail }；tail 只留末 12 行以免几百条断言刷满终端 */
function run(cmd, argv, opts = {}) {
  const started = Date.now();
  const res = spawnSync(cmd, argv, {
    cwd: opts.cwd || SERVER_ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    // Windows 下 npm 是 .cmd，不 shell:true 会 ENOENT；本脚本不拼用户输入，无注入面
    shell: process.platform === 'win32',
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  return {
    ok: res.status === 0,
    seconds: (Date.now() - started) / 1000,
    tail: out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n'),
  };
}

const STEPS = [
  {
    id: 'syntax',
    label: '后端语法检查（node --check 全量 src）',
    // 语法检查 1 秒出结果，注释批量改动最先坏的是括号/模板串，值得单独一步
    run: () => {
      const files = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.js')) files.push(full);
        }
      };
      walk(path.join(SERVER_ROOT, 'src'));
      const bad = files.filter((f) => spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }).status !== 0);
      return {
        ok: bad.length === 0,
        seconds: 0,
        tail: bad.length ? `语法错误：\n${bad.join('\n')}` : `${files.length} 个文件全部通过`,
      };
    },
  },
  {
    id: 'lint',
    label: 'ESLint（两端扁平配置，只抓真问题）',
    // 两端各自 npm run lint，任一端 error 即本步失败；未使用变量/无用赋值/丢 cause 要在构建前拦下
    run: () => {
      const a = run('npm', ['run', 'lint', '--silent'], { cwd: SERVER_ROOT });
      const b = run('npm', ['run', 'lint', '--silent'], { cwd: path.join(REPO_ROOT, 'web') });
      return {
        ok: a.ok && b.ok,
        seconds: a.seconds + b.seconds,
        tail: [a.ok ? 'server：0 error' : `server：\n${a.tail}`, b.ok ? 'web：0 error' : `web：\n${b.tail}`].join('\n'),
      };
    },
  },
  {
    id: 'build',
    label: '前端构建（vite build）',
    run: () => run('npm', ['run', 'build'], { cwd: path.join(REPO_ROOT, 'web') }),
  },
  {
    id: 'selftest',
    label: '端到端自检（空库 + 隔离端口）',
    run: () => run('node', ['scripts/selftest.mjs']),
  },
  {
    id: 'qa',
    label: 'QA 四维用例（安全/功能/流程/人性化）',
    run: () => run('node', ['scripts/qa.mjs']),
  },
  {
    id: 'seed',
    label: '生产库只读副本回归（迁移路径 + 真实数据）',
    // selftest 以 readOnly 打开源库再 VACUUM INTO 副本跑迁移；对操作员数据只读，库不存在则跳过
    available: () => fs.existsSync(path.join(SERVER_ROOT, 'data', 'awarelab.db')),
    skipIf: () => args.has('--skip-seed'),
    run: () => run('node', ['scripts/selftest.mjs'], { env: { E2E_SEED: 'data/awarelab.db' } }),
  },
  {
    id: 'audit',
    label: '依赖漏洞扫描（npm audit）',
    // 上游公告常滞后，nonBlocking 只把结果打进摘要供发布前看一眼
    nonBlocking: true,
    run: () => {
      const a = run('npm', ['audit', '--omit=dev', '--no-fund'], { cwd: SERVER_ROOT });
      const b = run('npm', ['audit', '--omit=dev', '--no-fund'], { cwd: path.join(REPO_ROOT, 'web') });
      return {
        ok: true,
        seconds: a.seconds + b.seconds,
        tail: `server：${(a.tail.match(/[\d.]+ vulnerabilities?/) || ['无公告'])[0]}\nweb：${(b.tail.match(/[\d.]+ vulnerabilities?/) || ['无公告'])[0]}`,
      };
    },
  },
  {
    id: 'smoke',
    label: '实机只读体检（需服务已在跑）',
    available: () => true,
    // 只读探针，需要实例已在跑；默认跳过，用 --with-smoke 才纳入
    skipIf: () => !args.has('--with-smoke'),
    run: () => run('node', ['scripts/smoke.mjs']),
  },
];

assertNodeVersion();
const results = [];
for (const step of STEPS) {
  if (onlyId && step.id !== onlyId) continue;
  if (step.skipIf && step.skipIf()) {
    results.push({ ...step, state: 'skip', note: '按参数跳过' });
    console.log(`⏭  ${step.label}（按参数跳过）`);
    continue;
  }
  if (step.available && !step.available()) {
    results.push({ ...step, state: 'skip', note: '前置条件不满足' });
    console.log(`⏭  ${step.label}（前置条件不满足，跳过）`);
    continue;
  }
  console.log(`\n▶ ${step.label}`);
  const r = step.run();
  if (r.ok) {
    results.push({ ...step, state: 'pass', seconds: r.seconds, note: r.tail });
    console.log(`   通过（${r.seconds.toFixed(1)}s）`);
  } else {
    results.push({ ...step, state: step.nonBlocking ? 'warn' : 'fail', seconds: r.seconds, note: r.tail });
    console.log(step.nonBlocking ? `   有告警（不阻断）：\n${r.tail}` : `   失败：\n${r.tail}`);
  }
  if (results.at(-1).state === 'fail' && !onlyId) {
    // 失败即停：后面每一步都比前面贵，先把最靠前的问题解决再往下走
    console.log('\n后续步骤已取消（先修上面这一步）。');
    break;
  }
}

console.log('\n================ CI 摘要 ================');
for (const r of results) {
  const icon = { pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭' }[r.state];
  console.log(`${icon} ${r.label}${r.seconds ? `（${r.seconds.toFixed(1)}s）` : ''}`);
}
const failed = results.filter((r) => r.state === 'fail');
console.log(failed.length ? `\n${failed.length} 步失败，禁止发布。` : '\n无失败步骤。');
process.exit(failed.length ? 1 : 0);
