/**
 * 管理面装配：操作员侧的静态壳 + API 挂载 + 统一错误出口，与信标面共用 boot/main.js 的应用和端口。
 * 默认绑定 config.panel.bind（只听 127.0.0.1），入口路径 config.panel.path 随机生成。
 * 管理面文案是给操作员看的，可以说演练、授权；访客可见文案在 capture 那边，不能串台。
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from '../platform/settings.js';
import { apiRoot } from '../api/index.js';

// 前端构建时埋下的占位符，运行时才换成真值
const PANEL_PLACEHOLDER = '__ALAB_PANEL_VALUE__';

/** 同步读 web/dist/index.html 并换掉占位符；产物缺失由调用方的 hasShell 分支避开，不让它抛穿进程。 */
function readShell() {
  return fs.readFileSync(path.join(config.paths.webDist, 'index.html'), 'utf8').replaceAll(PANEL_PLACEHOLDER, config.panel.path);
}

/**
 * 依次挂出：`/` 302 到随机入口、`<panel>/api` 管理接口（鉴权在 api 层）、静态产物、壳页面兜底、错误中间件。
 * 随机路径就是入口地址，只在运行时注入；没有构建产物时给 503 中文提示，接口写错由 api/index.js 的 404 兜住，不能让壳页面返回 200 + HTML。
 */
export function mountAdminPlane(app) {
  const panel = `/${config.panel.path}`;
  // 闸门是 api 层的会话鉴权，随机路径只让入口猜不中
  app.get('/', (_req, res) => res.redirect(`${panel}/`));
  app.use(`${panel}/api`, apiRoot);

  const hasShell = fs.existsSync(path.join(config.paths.webDist, 'index.html'));
  if (hasShell) {
    // 指名要 index.html 时先回入口：静态目录里那份带的是未替换占位符，前端据此会把接口前缀退成 /api，整页查不到数据还显示成"没有记录"
    app.get(`${panel}/index.html`, (_req, res) => res.redirect(`${panel}/`));
    // index:false：静态目录里的 index.html 带着未替换的占位符，直接发出去前端拿不到后台路径
    app.use(panel, express.static(config.paths.webDist, { index: false }));
    // 壳常驻内存：前端 build 后必须重启后端，否则一直在发旧壳
    const shell = readShell();
    // SPA 兜底：深链接也回壳页面，由前端路由自己解析
    app.get(`${panel}/*`, (_req, res) => res.type('html').send(shell));
  } else {
    app.get(`${panel}/*`, (_req, res) =>
      res.status(503).type('text/plain').send('管理端尚未构建：请在 web 目录执行 npm run build 后重试。')
    );
  }

  /**
   * 统一失败信封，形状同 platform/net/envelope.js 的 fail；413 是请求体超 express.json 的 8MB 或 multer 超限，400 是 JSON 不合法，其余 500。
   * 必须挂在所有路由之后并保留四个参数，Express 按参数个数识别错误中间件。
   */
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') {
      console.warn('[error] 请求体超限', err.message);
      return res.status(413).json({ code: 413, message: '请求体超过 8MB 上限，请精简内容或改用附件上传。' });
    }
    if (err instanceof SyntaxError) {
      console.warn('[error] 请求体解析失败', err.message);
      return res.status(400).json({ code: 400, message: '请求体不是合法的 JSON，请检查内容是否被截断。' });
    }
    // multer 的超限也算 413，不透出英文原文
    if (err?.code === 'LIMIT_FILE_SIZE' || err?.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(413).json({ code: 413, message: '上传文件超出大小限制，请压缩后重试。' });
    }
    // 回显 err.message 会把模块路径、SQL 片段交给调用方，原文只落日志
    console.error('[error]', err);
    res.status(500).json({ code: 500, message: '服务内部错误，请稍后重试；如需排查请看服务端日志。' });
  });

  // 返回后台路径给启动横幅：口令不进日志，入口路径只在本机可见
  return panel;
}
