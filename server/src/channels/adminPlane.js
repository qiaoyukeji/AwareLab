import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from '../platform/settings.js';
import { apiRoot } from '../api/index.js';

const PANEL_PLACEHOLDER = '__ALAB_PANEL_VALUE__';

function readShell() {
  return fs.readFileSync(path.join(config.paths.webDist, 'index.html'), 'utf8').replaceAll(PANEL_PLACEHOLDER, config.panel.path);
}

/**
 * 管理面装配。
 * 后台路径由配置随机生成，入口值只能在运行时注入壳页面，不能编译进产物，
 * 否则构建产物一旦泄露，随机路径也就形同虚设。
 */
export function mountAdminPlane(app) {
  const panel = `/${config.panel.path}`;
  app.get('/', (_req, res) => res.redirect(`${panel}/`));
  app.use(`${panel}/api`, apiRoot);

  const hasShell = fs.existsSync(path.join(config.paths.webDist, 'index.html'));
  if (hasShell) {
    app.use(panel, express.static(config.paths.webDist, { index: false }));
    const shell = readShell();
    app.get(`${panel}/*`, (_req, res) => res.type('html').send(shell));
  } else {
    app.get(`${panel}/*`, (_req, res) =>
      res.status(503).type('text/plain').send('管理端尚未构建：请在 web 目录执行 npm run build 后重试。')
    );
  }

  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    res.status(500).json({ code: 500, message: err.message || '服务内部错误' });
  });

  return panel;
}
