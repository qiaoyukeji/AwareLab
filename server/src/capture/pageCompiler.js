import { buildEngage } from './engageScript.js';

const BODY_CLOSE = /<\/body\s*>/i;

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * 渲染演练页面。
 * 注入点固定在 </body> 前：模板自带的脚本先跑完，采集运行时再绑定，
 * 没有 </body> 的残缺模板直接追加，保证注入不丢。
 */
export function renderCapturePage(templateHtml, cfg) {
  const html = String(templateHtml ?? '');
  const fragment = buildEngage(cfg);
  if (BODY_CLOSE.test(html)) return html.replace(BODY_CLOSE, () => fragment + '</body>');
  return `${html}\n${fragment}`;
}

/** 门禁拦截与学习页缺省时的统一提示页：不带任何业务样式，避免被误认成真实故障 */
export function renderNoticePage(title, message) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f5f7fa;font-family:'Microsoft YaHei',sans-serif;">
<div style="max-width:520px;margin:12vh auto;padding:36px;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);">
<h2 style="margin:0 0 12px;font-size:19px;color:#1f2937;">${escapeHtml(title)}</h2>
<p style="margin:0;color:#6b7280;line-height:1.8;font-size:14px;">${escapeHtml(message)}</p>
</div></body></html>`;
}
