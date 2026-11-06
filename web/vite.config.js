import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 配置里的相对路径一律以本文件所在目录（web/）为基准：`npm --prefix web run build` 从仓库根跑时 cwd 不是 web，
// 用 process.cwd() 会在换一种启动方式后悄悄指错文件。
const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 开发态直连 Node 服务：读取 server/config.yaml 里的随机后台路径，
 * 把 /api 代理到 /{panelPath}/api，这样前端代码与生产部署形态一致。
 */
function readPanel() {
  try {
    const text = fs.readFileSync(path.resolve(WEB_DIR, '..', 'server', 'config.yaml'), 'utf8');
    const p = text.match(/^\s{2}path:\s*([0-9a-f]{32})\s*$/m)?.[1];
    const port = text.match(/^\s{2}port:\s*(\d+)\s*$/m)?.[1] || '7778';
    return { p, port };
  } catch {
    return { p: null, port: '7778' };
  }
}

/**
 * 构建期注入版本号（见 src/version.js）。版本只有一个真相：server/package.json——
 * 界面写着 v2.3.0、后端其实是别的版本，比不显示版本更误导人，所以两边不一致直接让构建失败。
 */
function readVersion() {
  const versionOf = (rel) => JSON.parse(fs.readFileSync(path.resolve(WEB_DIR, rel), 'utf8')).version;
  let web;
  let server;
  try {
    web = versionOf('package.json');
    server = versionOf(path.join('..', 'server', 'package.json'));
  } catch (error) {
    throw new Error(`读不到 package.json 的版本号：${error.message}`, { cause: error });
  }
  if (web !== server) {
    throw new Error(`版本号不一致：web/package.json=${web}，server/package.json=${server}；两处必须同步后再构建`);
  }
  return server;
}

const { p: PANEL, port: API_PORT } = readPanel();
const APP_VERSION = readVersion();

export default defineConfig({
  base: './',
  plugins: [vue()],
  define: {
    // 模板与脚本里直接写 __APP_VERSION__，构建时被替换成字符串字面量
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    port: 7777,
    proxy: PANEL
      ? {
          '/api': {
            target: `http://127.0.0.1:${API_PORT}`,
            rewrite: (p) => `/${PANEL}${p}`,
          },
        }
      : {},
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1600 },
});
