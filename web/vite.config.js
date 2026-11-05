import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 开发态直连 Node 服务：读取 server/config.yaml 里的随机后台路径，
 * 把 /api 代理到 /{panelPath}/api，这样前端代码与生产部署形态一致。
 */
function readPanel() {
  try {
    const text = fs.readFileSync(path.resolve(process.cwd(), '..', 'server', 'config.yaml'), 'utf8');
    const p = text.match(/^\s{2}path:\s*([0-9a-f]{32})\s*$/m)?.[1];
    const port = text.match(/^\s{2}port:\s*(\d+)\s*$/m)?.[1] || '7778';
    return { p, port };
  } catch {
    return { p: null, port: '7778' };
  }
}

const { p: PANEL, port: API_PORT } = readPanel();

export default defineConfig({
  base: './',
  plugins: [vue()],
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
