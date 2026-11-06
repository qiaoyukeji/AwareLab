/**
 * 打包单文件 Windows 可执行程序（Node SEA）。
 *
 * 做法：esbuild 把 server/src/boot/seaEntry.js 连同依赖打成一个 CJS 文件，前端 web/dist 以
 * gzip+base64 的形式内联进同一个文件，再用 Node 官方的单可执行程序机制（sea-config + postject）
 * 塞进一份 node.exe，产出 dist/AwareLab.exe。双击即起服务并打开浏览器，无需安装 Node。
 *
 * 前置：web 已构建（`npm --prefix web run build`），server 装了 devDependencies 里的 esbuild / postject。
 * 用法：node scripts/build-exe.mjs [--skip-web]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(SERVER_DIR, '..');
const WEB_DIR = path.join(REPO_DIR, 'web', 'dist');
const BUILD_DIR = path.join(SERVER_DIR, 'build');
const OUT_DIR = path.join(REPO_DIR, 'dist');
const ASSETS_MODULE = path.join(BUILD_DIR, 'web-assets.js');
const BUNDLE = path.join(BUILD_DIR, 'sea-main.cjs');
const SEA_CONFIG = path.join(BUILD_DIR, 'sea-config.json');
const BLOB = path.join(BUILD_DIR, 'sea-prep.blob');
const EXE = path.join(OUT_DIR, 'AwareLab.exe');
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

function buildWeb() {
  const indexHtml = path.join(WEB_DIR, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    console.error(`缺少前端产物：${indexHtml}\n先跑 npm --prefix web run build。`);
    process.exit(1);
  }
  if (process.argv.includes('--skip-web')) console.log('[1/6] 跳过 vite 构建，直接内联现有 web/dist');
  else console.log(`[1/6] 内联前端产物：${WEB_DIR}（如需更新先 npm --prefix web run build）`);
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
  console.log('[2/6] 打包服务端代码（esbuild → CJS）');
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
  console.log('[3/6] 生成 SEA blob');
  fs.writeFileSync(
    SEA_CONFIG,
    JSON.stringify({ main: BUNDLE, output: BLOB, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2)
  );
  run(process.execPath, ['--experimental-sea-config', SEA_CONFIG]);
}

function copyNode() {
  console.log('[4/6] 复制一份 node.exe');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(process.execPath, EXE);
}

function inject() {
  console.log('[6/6] 注入 SEA blob');
  const postject = path.join(SERVER_DIR, 'node_modules', 'postject', 'dist', 'cli.js');
  run(process.execPath, [postject, EXE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE]);
}

/**
 * 图标与版本信息要赶在注入 blob 之前写：rcedit 改的是 PE 资源段，blob 是追加在文件尾的，
 * 顺序反了虽不一定坏，但让「资源改写」作用在纯净的 node.exe 副本上更稳。
 */
async function brandExe() {
  console.log('[5/6] 写图标与版本信息');
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8'));
  const png = path.join(REPO_DIR, 'brand', 'awarelab-icon-1024.png');
  const ico = path.join(BUILD_DIR, 'awarelab.ico');
  try {
    const { default: pngToIco } = await import('png-to-ico');
    const { rcedit } = await import('rcedit');
    if (!fs.existsSync(ico)) fs.writeFileSync(ico, await pngToIco(png));
    await rcedit(EXE, {
      icon: ico,
      'file-version': pkg.version,
      'product-version': pkg.version,
      'version-string': {
        CompanyName: 'AwareLab',
        FileDescription: 'AwareLab 安全意识演练平台',
        ProductName: 'AwareLab',
        LegalCopyright: 'Apache-2.0',
        OriginalFilename: 'AwareLab.exe',
      },
    });
  } catch (error) {
    // 图标只是观感，装不上不该让整个打包失败；但要说清楚，免得以为生效了
    console.warn(`      图标/版本信息写入失败（不影响运行）：${error.message}`);
  }
}

function report() {
  const size = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
  console.log(`[完成] 产物：${EXE}（${size} MB）`);
  console.log('双击即可运行；首次启动会生成 config.yaml、初始化数据库并打开浏览器。');
}

buildWeb();
bundleServer();
makeBlob();
copyNode();
await brandExe();
inject();
report();
