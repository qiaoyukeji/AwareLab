/**
 * 自测装配器：在隔离目录里起一个完整的服务，再跑 e2e 断言。
 *
 * 隔离是硬性要求——e2e 会真实建站监听、真实投递沙箱邮件、真实吊销授权，
 * 这些动作绝不能落在 server/data 里的演练数据上。
 *
 * 用法：
 *   node scripts/selftest.mjs                                  # 空库跑全流程
 *   E2E_SEED=../data/awarelab.db node scripts/selftest.mjs    # 用生产库只读副本跑（含迁移路径）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import yaml from 'js-yaml';

const SERVER_ROOT = path.resolve(import.meta.dirname, '..');
const SELF_ROOT = path.join(SERVER_ROOT, '.selftest');
const CONFIG_FILE = path.join(SELF_ROOT, 'config.yaml');
const DATA_DIR = path.join(SELF_ROOT, 'data');
const PANEL_PORT = Number(process.env.E2E_PANEL_PORT) || 4111;
const CAPTURE_PORT = Number(process.env.E2E_PORT) || 8123;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

const randomString = (len) =>
  Array.from(crypto.randomBytes(len), (b) => ALPHABET[b % ALPHABET.length]).join('');

function writeConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const panelPassword = randomString(8);
  fs.writeFileSync(
    CONFIG_FILE,
    yaml.dump({
      panel: { path: crypto.randomBytes(16).toString('hex'), port: PANEL_PORT, username: randomString(8), password: panelPassword },
      capture: { port_range: [8000, 9999], bind_host: '127.0.0.1' },
      mail: { default_dry_run: true, default_send_interval_ms: 120 },
      exercise: { require_authorization: true },
      session_ttl_hours: 12,
    }),
    'utf8'
  );
  return panelPassword;
}

/** 历史库往往带着 WAL，直接复制文件会丢掉日志里的数据，用 VACUUM INTO 折成单文件 */
function foldSeed(source) {
  const target = path.join(DATA_DIR, 'awarelab.db');
  const src = new DatabaseSync(source, { readOnly: true });
  try {
    src.prepare('VACUUM INTO ?').run(target);
  } finally {
    src.close();
  }
  console.log(`[selftest] 已用历史库副本起步：${path.basename(source)}`);
}

function prepareData() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const panelPassword = writeConfig();
  const seed = process.env.E2E_SEED ? path.resolve(SERVER_ROOT, process.env.E2E_SEED) : null;
  if (!seed) return panelPassword;
  if (!fs.existsSync(seed)) throw new Error(`E2E_SEED 指向的库不存在：${seed}`);
  if (/-wal$/.test(seed)) throw new Error('E2E_SEED 请指向主库文件（不含 -wal）');
  foldSeed(seed);
  return panelPassword;
}

async function waitForHealth(childDone) {
  for (let i = 0; i < 60; i += 1) {
    if (childDone.exited) throw new Error(`服务提前退出（code=${childDone.code}），见上方日志`);
    try {
      const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/alab/health`);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('等待服务健康检查超时');
}

function startServer() {
  const done = { exited: false, code: null, log: '' };
  const child = spawn(process.execPath, [path.join(SERVER_ROOT, 'src/boot/main.js')], {
    cwd: SERVER_ROOT,
    env: { ...process.env, AWARELAB_CONFIG: CONFIG_FILE, AWARELAB_DATA: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 照常回显（服务提前退出时要靠这段日志定位），同时留一份给输出泄露断言
  const tee = (stream) => stream.on('data', (buf) => { done.log += buf.toString(); process.stdout.write(buf); });
  tee(child.stdout);
  tee(child.stderr);
  child.on('exit', (code) => {
    done.exited = true;
    done.code = code;
  });
  return { child, done };
}

/** 启动横幅泄露口令 = 演练口令被复制进 journald / nohup.out / 容器日志，属于硬性失败 */
function assertBannerSafe(log, panelPassword) {
  if (log.includes(panelPassword)) throw new Error('启动输出泄露了明文口令');
  if (!log.includes('密码: 见 config.yaml')) throw new Error('启动输出缺少「密码: 见 config.yaml」指引，横幅口径已变');
  console.log('[selftest] PASS  启动输出不含明文口令');
}

const stop = (child) =>
  new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once('exit', resolve);
    // Windows 上 kill 即强杀，POSIX 上先发 SIGTERM 让服务自己收掉采集面监听
    child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  });

let child;
try {
  const panelPassword = prepareData();
  const started = startServer();
  child = started.child;
  await waitForHealth(started.done);
  console.log(`[selftest] 服务就绪，采集面端口 ${CAPTURE_PORT}`);
  assertBannerSafe(started.done.log, panelPassword);
  const code = await new Promise((resolve) => {
    const runner = spawn(process.execPath, [path.join(SERVER_ROOT, 'scripts/e2e.mjs')], {
      cwd: SERVER_ROOT,
      env: { ...process.env, AWARELAB_CONFIG: CONFIG_FILE, AWARELAB_DATA: DATA_DIR, E2E_PORT: String(CAPTURE_PORT) },
      stdio: 'inherit',
    });
    runner.on('exit', resolve);
  });
  await stop(child);
  child = null;
  process.exit(code ?? 1);
} catch (err) {
  console.error(`[selftest] ${err.message}`);
  if (child) close(child.pid);
  process.exit(1);
}
