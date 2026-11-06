/**
 * 单文件 exe 的入口（Node SEA）。真正的服务仍在 boot/main.js，这里只做三件事：
 * 1) 把数据目录定到用户目录（exe 所在目录可能只读，Program Files / 下载目录都不该落库）；
 * 2) 首次运行时把打包进来的前端产物解到 <home>/web，之后按版本号判断是否要重解；
 * 3) 设好 AWARELAB_SEA，让 main.js 知道该自动开浏览器、端口冲突时别让窗口一闪而过。
 *
 * 这个文件只在 build-exe.mjs 里被 esbuild 打成 CJS 后塞进 node.exe，源码不参与日常启动。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ASSETS, ASSET_VERSION } from '../../build/web-assets.js';

// 用户数据目录：优先用 exe 同级的 data 目录（便携版，拷走整个文件夹就能搬走数据），
// 该目录不可写时退回 %LOCALAPPDATA%\AwareLab。
function resolveHome() {
  if (process.env.AWARELAB_HOME) return path.resolve(process.env.AWARELAB_HOME);
  const exeDir = path.dirname(process.execPath);
  try {
    fs.mkdirSync(exeDir, { recursive: true });
    fs.accessSync(exeDir, fs.constants.W_OK);
    return path.join(exeDir, 'AwareLab-data');
  } catch {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'AwareLab');
  }
}

const HOME = resolveHome();
fs.mkdirSync(HOME, { recursive: true });
process.env.AWARELAB_HOME = HOME;
process.env.AWARELAB_SEA = '1';

// 前端产物：解包一次，版本没变就跳过。marker 放在 web/.asset-version，和 dist 内容同生共死。
const WEB_DIR = path.join(HOME, 'web');
const MARKER = path.join(WEB_DIR, '.asset-version');
function unpackWeb() {
  let current = '';
  try {
    current = fs.readFileSync(MARKER, 'utf8').trim();
  } catch {
    // 首次运行没有 marker：current 保持空串，下面自然会重解一遍
  }
  if (current === ASSET_VERSION && fs.existsSync(path.join(WEB_DIR, 'index.html'))) return false;
  fs.rmSync(WEB_DIR, { recursive: true, force: true });
  for (const [rel, b64] of Object.entries(ASSETS)) {
    const target = path.join(WEB_DIR, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, zlib.gunzipSync(Buffer.from(b64, 'base64')));
  }
  fs.writeFileSync(MARKER, ASSET_VERSION);
  return true;
}

const unpacked = unpackWeb();
console.log(`AwareLab 数据目录: ${HOME}`);
if (unpacked) console.log('已解包前端资源（首次运行或版本更新后只需一次）');

// 真正的服务入口。动态 import 是为了上面三件事先落定：settings.js 在 import 时就会读 AWARELAB_HOME。
// 不用顶层 await：CJS 打包产物不支持，入口这里也不需要等它——main.js 在 listen 回调里自己打印后续。
import('./main.js').catch((error) => {
  console.error('\n启动失败：', error?.stack || error?.message || error);
  console.error('\n这个窗口先留着，按 Ctrl+C 或直接关闭即可退出。');
  setInterval(() => {}, 1 << 30);
});
