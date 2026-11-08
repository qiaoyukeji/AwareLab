/**
 * 打包桌面版 Windows 程序。
 *
 * 产物只有 dist/AwareLab.exe 一个文件，双击即用：
 * 1) 服务端仍用 Node SEA 打成 AwareLabServer.exe（无控制台窗口地跑，只管服务）；
 * 2) 再写一个 C# 启动器（WinForms + WebView2），把服务端、WebView2 运行库、图标全部内嵌；
 * 3) 启动器解包到 %LOCALAPPDATA%\AwareLab\app\<版本>，拉起服务端，等它报出管理面地址，
 *    用自己的窗口打开——不经过系统浏览器，任务栏里是 AwareLab 自己的图标；
 * 4) 服务端挂在作业对象上，启动器一退出（正常关窗、崩溃、被任务管理器结束）它也跟着结束。
 *
 * 前置：web 已构建；server 装了 esbuild / postject / rcedit / png-to-ico；
 *       本机有 .NET Framework 的 csc.exe（Windows 自带）与 WebView2 运行时（Win10 1803+ 普遍自带）。
 * 用法：node scripts/build-exe.mjs [--skip-web] [--skip-launcher]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(SERVER_DIR, '..');
const WEB_DIR = path.join(REPO_DIR, 'web', 'dist');
const BUILD_DIR = path.join(SERVER_DIR, 'build');
const LAUNCHER_DIR = path.join(REPO_DIR, 'launcher');
const LAUNCHER_LIB = path.join(LAUNCHER_DIR, 'lib');
const OUT_DIR = path.join(REPO_DIR, 'dist');
const ASSETS_MODULE = path.join(BUILD_DIR, 'web-assets.js');
const BUNDLE = path.join(BUILD_DIR, 'sea-main.cjs');
const SEA_CONFIG = path.join(BUILD_DIR, 'sea-config.json');
const BLOB = path.join(BUILD_DIR, 'sea-prep.blob');
const SERVER_EXE = path.join(BUILD_DIR, 'AwareLabServer.exe');
const INFO_EXE = path.join(BUILD_DIR, 'AwareLabInfo.exe');
const ICON = path.join(BUILD_DIR, 'awarelab.ico');
const APP_EXE = path.join(OUT_DIR, 'AwareLab.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', cwd: SERVER_DIR, ...options });
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function findCsc() {
  const roots = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const version of fs.readdirSync(root).sort().reverse()) {
      const candidate = path.join(root, version, 'csc.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function buildWeb() {
  const indexHtml = path.join(WEB_DIR, 'index.html');
  if (process.argv.includes('--skip-web')) {
    console.log('[1/7] 跳过 vite 构建，直接内联现有 web/dist');
  } else {
    console.log('[1/7] 构建前端（npm --prefix web run build）');
    execFileSync('npm', ['--prefix', 'web', 'run', 'build'], { cwd: REPO_DIR, stdio: 'inherit', shell: true });
  }
  if (!fs.existsSync(indexHtml)) {
    console.error(`缺少前端产物：${indexHtml}\n先跑 npm --prefix web run build。`);
    process.exit(1);
  }
  const files = walk(WEB_DIR).filter((rel) => !rel.startsWith('.asset-version')).sort();
  const hash = crypto.createHash('sha256');
  const entries = [];
  for (const rel of files) {
    const raw = fs.readFileSync(path.join(WEB_DIR, rel));
    hash.update(rel).update('\0').update(raw);
    entries.push([rel, zlib.gzipSync(raw, { level: 9 }).toString('base64')]);
  }
  const version = hash.digest('hex').slice(0, 16);
  const body = entries.map(([rel, b64]) => `  ${JSON.stringify(rel)}: ${JSON.stringify(b64)},`).join('\n');
  fs.writeFileSync(
    ASSETS_MODULE,
    `// 由 scripts/build-exe.mjs 生成，勿手改。前端产物的 gzip+base64，运行时解到 <数据目录>/web。\n` +
      `export const ASSET_VERSION = ${JSON.stringify(version)};\nexport const ASSETS = {\n${body}\n};\n`
  );
  console.log(`      ${files.length} 个文件，版本 ${version}`);
}

function bundleServer() {
  console.log('[2/7] 打包服务端代码（esbuild → CJS）');
  const esbuild = path.join(SERVER_DIR, 'node_modules', 'esbuild', 'bin', 'esbuild');
  run(process.execPath, [
    esbuild,
    'src/boot/seaEntry.js',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    '--log-level=warning',
    `--outfile=${BUNDLE}`,
  ]);
  const size = (fs.statSync(BUNDLE).size / 1024 / 1024).toFixed(2);
  console.log(`      ${BUNDLE}（${size} MB）`);
}

function makeBlob() {
  console.log('[3/7] 生成 SEA blob');
  fs.writeFileSync(
    SEA_CONFIG,
    JSON.stringify({ main: BUNDLE, output: BLOB, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2)
  );
  run(process.execPath, ['--experimental-sea-config', SEA_CONFIG]);
}

function buildServerExe() {
  console.log('[4/7] 生成服务端 AwareLabServer.exe（Node SEA）');
  fs.writeFileSync(path.join(BUILD_DIR, '.keep'), '');
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.copyFileSync(process.execPath, SERVER_EXE);
  const postject = path.join(SERVER_DIR, 'node_modules', 'postject', 'dist', 'cli.js');
  run(process.execPath, [postject, SERVER_EXE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE]);
}

/** 控制台小程序：只打印启动信息，关掉它不影响主程序。 */
function buildInfoExe() {
  console.log('[5/7] 编译启动信息小程序（AwareLabInfo.exe）');
  const csc = findCsc();
  if (!csc) throw new Error('找不到 csc.exe（.NET Framework），无法编译启动器');
  run(csc, ['/nologo', '/target:exe', '/platform:x64', `/out:${INFO_EXE}`, path.join(LAUNCHER_DIR, 'InfoConsole.cs')]);
}

/** 桌面启动器：WinForms + WebView2，把服务端与运行库内嵌成单个 exe。 */
function buildLauncher() {
  console.log('[6/7] 编译桌面启动器并内嵌服务端（AwareLab.exe）');
  const csc = findCsc();
  for (const needed of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']) {
    if (!fs.existsSync(path.join(LAUNCHER_LIB, needed))) {
      throw new Error(`缺少 WebView2 运行库：${path.join(LAUNCHER_LIB, needed)}`);
    }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const args = [
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    `/out:${APP_EXE}`,
    `/win32icon:${ICON}`,
    `/win32manifest:${path.join(LAUNCHER_DIR, 'app.manifest')}`,
    `/r:${path.join(LAUNCHER_LIB, 'Microsoft.Web.WebView2.Core.dll')}`,
    `/r:${path.join(LAUNCHER_LIB, 'Microsoft.Web.WebView2.WinForms.dll')}`,
    '/r:System.dll',
    '/r:System.Core.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll',
    // 资源名必须和运行时的解包名一致：启动器按资源名直接写到解包目录
    `/resource:${SERVER_EXE},AwareLabServer.exe`,
    `/resource:${INFO_EXE},AwareLabInfo.exe`,
    `/resource:${path.join(LAUNCHER_LIB, 'Microsoft.Web.WebView2.Core.dll')},Microsoft.Web.WebView2.Core.dll`,
    `/resource:${path.join(LAUNCHER_LIB, 'Microsoft.Web.WebView2.WinForms.dll')},Microsoft.Web.WebView2.WinForms.dll`,
    `/resource:${path.join(LAUNCHER_LIB, 'WebView2Loader.dll')},WebView2Loader.dll`,
    `/resource:${ICON},app.ico`,
    path.join(LAUNCHER_DIR, 'AwareLab.cs'),
    path.join(LAUNCHER_DIR, 'Shell.cs'),
  ];
  run(csc, args);
}

async function brand() {
  console.log('[7/7] 写图标与版本信息');
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8'));
  const meta = {
    icon: ICON,
    'file-version': pkg.version,
    'product-version': pkg.version,
    'version-string': {
      CompanyName: 'AwareLab',
      FileDescription: 'AwareLab 安全意识演练平台',
      ProductName: 'AwareLab 安全意识演练平台',
      LegalCopyright: 'Apache-2.0',
      OriginalFilename: 'AwareLab.exe',
    },
  };
  // 启动器只有 1MB 出头，正常几十毫秒；卡住就给个上限，别让打包命令挂死
  await brandOne(APP_EXE, meta, 60000);
  // 服务端 exe 有 100MB 多，rcedit 要整份读改写，遇到杀软实时扫描会久到几分钟。
  // 它只是让任务管理器里看得懂，写不进去不影响运行，所以给 45 秒上限、超时就跳过。
  await brandOne(SERVER_EXE, { ...meta, 'version-string': { ...meta['version-string'], OriginalFilename: 'AwareLabServer.exe' } }, 45000);
}

async function brandOne(file, meta, timeoutMs) {
  const bin = path.join(SERVER_DIR, 'node_modules', 'rcedit', 'bin', process.arch === 'x64' ? 'rcedit-x64.exe' : 'rcedit.exe');
  const args = [file, '--set-icon', meta.icon,
    '--set-file-version', meta['file-version'], '--set-product-version', meta['product-version']];
  for (const [key, value] of Object.entries(meta['version-string'])) args.push('--set-version-string', key, value);

  await new Promise((resolve) => {
    const child = execFile(bin, args, { windowsHide: true }, (error) => {
      if (error) console.warn(`      ${path.basename(file)} 图标/版本信息写入失败（不影响运行）：${error.message}`);
      resolve();
    });
    // 大文件遇到杀软实时扫描会卡几分钟，超时就直接掐掉这个子进程，别拖住打包
    const timer = setTimeout(() => {
      console.warn(`      ${path.basename(file)} 图标/版本信息超过 ${Math.round(timeoutMs / 1000)} 秒未完成，已跳过（不影响运行）`);
      try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
      resolve();
    }, timeoutMs);
    child.on('exit', () => clearTimeout(timer));
  });
}

function report() {
  const size = (fs.statSync(APP_EXE).size / 1024 / 1024).toFixed(1);
  console.log(`[完成] 产物：${APP_EXE}（${size} MB）`);
  console.log('双击即用：自带窗口、任务栏显示 AwareLab 图标；数据写在 exe 同级的 AwareLab-data 目录。');
}

buildWeb();
bundleServer();
makeBlob();
buildServerExe();
if (process.argv.includes('--skip-launcher')) {
  console.log('[5/7] [6/7] 跳过启动器（--skip-launcher），只产出服务端 exe');
  fs.copyFileSync(SERVER_EXE, path.join(OUT_DIR, 'AwareLabServer.exe'));
  console.log(`[完成] ${path.join(OUT_DIR, 'AwareLabServer.exe')}`);
  process.exit(0);
}
buildInfoExe();
buildLauncher();
await brand();
report();
// 子进程（postject / rcedit）偶尔留个句柄让事件循环不退出，显式收尾
process.exit(0);
