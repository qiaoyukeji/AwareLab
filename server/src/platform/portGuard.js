/**
 * 端口占用体检：起监听之前先问一句「这个端口上坐着谁」，必要时让操作员当场把它请走。
 *
 * 为什么放在 boot 层而不是 listen 的错误回调里：EADDRINUSE 是异步到的，那时进程已经初始化完数据库、
 * 种完素材，控制台窗口也弹出来了；exe 用户看到的是「一闪而过的黑窗」，学不到任何信息。
 * 这里在起监听之前主动探测一次，能在同一屏里说清 PID、进程名、可执行路径与命令行，并给出选项。
 *
 * 边界：
 * - 只杀「明确不是系统关键进程」的目标；System / csrss / lsass / svchost 这类一律拒绝，免得把机器搞坏。
 * - 非交互式（systemd、计划任务、容器）不弹问题，只打印诊断与建议，由上层决定退出还是挂住窗口。
 * - 允许用 AWARELAB_PORT_FREE=1 跳过询问直接释放：给无人值守部署一个显式开关，默认不开。
 */
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const IS_WINDOWS = process.platform === 'win32';

/** 这些进程动了会伤系统：即使占了端口也只报告，不动手 */
const PROTECTED = new Set([
  'system',
  'idle',
  'registry',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'svchost.exe',
  'fontdrvhost.exe',
  'dwm.exe',
  'explorer.exe',
  'init',
  'systemd',
  'launchd',
]);

function runQuiet(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // 查不到就是查不到：调用方按「未知占用者」降级展示，不把异常抛给启动流程
    return '';
  }
}

/** 端口上有没有人在听：连一下比读 netstat 更接近「我能不能 bind」这个事实 */
export function portBusy(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host });
    let settled = false;
    const done = (busy) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 从 netstat / lsof 里找出监听该端口的 PID（找不到返回 null） */
export function findListenerPid(port) {
  if (IS_WINDOWS) {
    const out = runQuiet('netstat', ['-ano', '-p', 'TCP']);
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      // 列：协议 本地地址 外部地址 状态 PID
      if (cols.length < 5 || cols[3] !== 'LISTENING') continue;
      const local = cols[1];
      const idx = local.lastIndexOf(':');
      if (idx < 0) continue;
      if (Number(local.slice(idx + 1)) === Number(port)) return Number(cols[4]);
    }
    return null;
  }
  // lsof 可能没装，ss 作为兜底
  const lsof = runQuiet('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  const hit = lsof.split(/\r?\n/).find((line) => line.startsWith('p'));
  if (hit) return Number(hit.slice(1)) || null;
  const ss = runQuiet('ss', ['-lptnH', `sport = :${port}`]);
  const pid = ss.match(/pid=(\d+)/);
  return pid ? Number(pid[1]) : null;
}

/** 进程详情：名称、可执行路径、命令行。查不到返回 null 字段，不要伪造 */
export function describePid(pid) {
  if (!pid) return null;
  if (IS_WINDOWS) {
    const csv = runQuiet('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).trim();
    const name = /^"([^"]+)"/.exec(csv)?.[1] || '';
    // Get-CimInstance 在 Win8+ 都有；老机器没有 PowerShell 时退到 wmic。
    // 用 ConvertTo-Json 而不是拼分隔符：命令行里本来就可能有引号、空格与换行，分隔符方案必然踩坑。
    const ps = runQuiet('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
        // 先强制 UTF-8 输出：中文路径按 GBK 落到 stdout 时，Node 侧按 utf8 解码就是一片乱码
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
        'if($p){$p | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress}',
    ]).replace(/^\uFEFF/, '');
    const raw = ps.trim() || '{}';
    const info = (() => {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        // 输出不是 JSON（PowerShell 被策略拦、版本太老）就继续走 wmic 兜底
        return {};
      }
    })();
    let exePath = info.ExecutablePath || '';
    let commandLine = info.CommandLine || '';
    if (!commandLine) {
      const wmic = runQuiet('wmic', ['process', 'where', `processid=${pid}`, 'get', 'ExecutablePath,CommandLine', '/format:list']);
      exePath = exePath || /ExecutablePath=(.+)/.exec(wmic)?.[1]?.trim() || '';
      commandLine = /CommandLine=(.+)/.exec(wmic)?.[1]?.trim() || '';
    }
    return { pid, name: name || path.win32.basename(exePath) || '未知进程', path: exePath || '', commandLine: commandLine || '' };
  }
  const args = runQuiet('ps', ['-p', String(pid), '-o', 'comm=,args=']).trim();
  const comm = args.split(/\s+/)[0] || '';
  const commandLine = args.slice(comm.length).trim();
  return { pid, name: comm || '未知进程', path: '', commandLine };
}

/** 这个占用者像不像另一个 AwareLab：用来自动给出「先关旧窗口」的建议 */
export function looksLikeAwareLab(owner) {
  const text = `${owner?.name || ''} ${owner?.path || ''} ${owner?.commandLine || ''}`;
  return /awarelab/i.test(text) || /src[\\/]boot[\\/]main\.js/i.test(text);
}

export function formatOwner(owner) {
  if (!owner) return ['       占用进程: 查不到（权限不足或端口刚被释放）'];
  const lines = [`       占用进程: ${owner.name}（PID ${owner.pid}）`];
  if (owner.path) lines.push(`       可执行文件: ${owner.path}`);
  if (owner.commandLine) {
    const cmd = owner.commandLine.length > 220 ? `${owner.commandLine.slice(0, 217)}...` : owner.commandLine;
    lines.push(`       命令行: ${cmd}`);
  }
  return lines;
}

export function canKill(owner) {
  if (!owner) return { ok: false, reason: '拿不到占用者信息' };
  const name = String(owner.name || '').toLowerCase();
  if (PROTECTED.has(name)) return { ok: false, reason: `${owner.name} 是系统关键进程，不能结束` };
  if (IS_WINDOWS && [0, 4].includes(owner.pid)) return { ok: false, reason: `PID ${owner.pid} 是系统进程` };
  if (!IS_WINDOWS && owner.pid <= 1) return { ok: false, reason: `PID ${owner.pid} 是系统进程` };
  return { ok: true };
}

/** 结束进程：Windows 走 taskkill /T（连子进程），POSIX 先 TERM 再 KILL */
export function killOwner(owner) {
  const verdict = canKill(owner);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  try {
    if (IS_WINDOWS) execFileSync('taskkill', ['/PID', String(owner.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(owner.pid, 'SIGTERM');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/** 给 listen 的 EADDRINUSE 兜底用：只取展示行，不做交互 */
export function portOwnerLines(port) {
  const owner = describePid(findListenerPid(port));
  const lines = formatOwner(owner);
  if (looksLikeAwareLab(owner)) lines.push('       判断: 看起来是另一个 AwareLab 实例——先关掉那个窗口最稳妥。');
  return lines;
}

async function waitUntilFree(port, host, timeoutMs = 6000) {  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portBusy(port, host))) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return !(await portBusy(port, host));
}

function printConflict(port, owner) {
  console.error(`\n端口 ${port} 已被占用。`);
  for (const line of formatOwner(owner)) console.error(line);
  if (looksLikeAwareLab(owner)) {
    console.error('       判断: 看起来是另一个 AwareLab 实例——先关掉那个窗口最稳妥。');
  }
}

/**
 * 起监听前确认端口可用。
 * 返回 true 表示端口已空（本来就没占，或用户同意后清掉了）；false 表示仍然被占，调用方自行决定退出/挂窗口。
 * 交互式终端（双击 exe 的控制台）会问一句是否结束占用进程；非交互式只打印诊断。
 */
export async function ensurePortFree(port, host = '127.0.0.1') {
  if (!(await portBusy(port, host))) return true;

  const owner = describePid(findListenerPid(port));
  printConflict(port, owner);
  const verdict = canKill(owner);
  // 明确说了不能杀（系统进程 / 查不到），就别再问，直接给建议
  if (!verdict.ok) {
    console.error(`       处理: ${verdict.reason}；请手动停掉它，或改 config.yaml 的 panel.port。`);
    return false;
  }
  const autoYes = process.env.AWARELAB_PORT_FREE === '1';
  if (!autoYes && !process.stdin.isTTY) {
    // 非交互：说清怎么手动解决，别只丢一句「被占用」
    console.error(
      looksLikeAwareLab(owner)
        ? '       处理: 先关掉那个 AwareLab 窗口；关不掉就手动结束它。'
        : '       处理: 结束该进程，或给平台换一个端口。'
    );
    console.error(`       手动释放: ${IS_WINDOWS ? `taskkill /PID ${owner.pid} /T /F` : `kill -TERM ${owner.pid}`}`);
    console.error('       换端口: 改 config.yaml 的 panel.port（单文件 exe 改数据目录里的那份）');
    return false;
  }
  if (!autoYes) {
    console.error('       处理: 关掉那个窗口即可；也可以直接在这里输入 y 结束它。');
  }

  let answer = 'y';
  if (!autoYes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      answer = (await rl.question(`\n是否结束 ${owner.name}（PID ${owner.pid}）并释放端口？[y/N] `)).trim().toLowerCase();
    } finally {
      rl.close();
    }
  }
  if (!['y', 'yes', '是'].includes(answer)) {
    console.error('       已保留该进程；要换端口就改 config.yaml 的 panel.port。');
    return false;
  }

  const killed = killOwner(owner);
  if (!killed.ok) {
    console.error(`       结束失败：${killed.reason}。请手动处理或改端口。`);
    return false;
  }
  console.error(`       已发送结束指令，等待端口 ${port} 释放…`);
  if (await waitUntilFree(port, host)) {
    console.error(`       端口 ${port} 已释放，继续启动。`);
    return true;
  }
  console.error('       进程已结束但端口仍被占用（可能还有别的监听者），请检查后重试。');
  return false;
}
