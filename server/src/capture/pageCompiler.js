/**
 * 采集面的渲染层：把模板 HTML 与采集运行时编译成访客看到的那一屏。
 * 注入片段由 engageScript.js 生成，端点与 boot 块形状是冻结协议，不在这里改。
 */
import { buildEngage } from './engageScript.js';

// </body> 只认第一个匹配（正则不带 g），免得把运行时注进注释或脚本串里
const BODY_CLOSE = /<\/body\s*>/i;

/** 文本节点转义；入参先 String()。属性值都是写死的常量，不做属性级转义。 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * 渲染访客打开仿冒页拿到的 HTML。templateHtml 可能来自一键仿站，内容不可信。
 * 注入点固定在 </body> 前，让模板自带脚本先跑完；残缺模板直接追加到末尾，否则页面能看但一条都采不到。
 */
export function renderCapturePage(templateHtml, cfg) {
  const html = String(templateHtml ?? '');
  const fragment = buildEngage(cfg);
  // 回调用函数形式：片段里的 $&、$1 会被当成替换模式悄悄改写
  if (BODY_CLOSE.test(html)) return html.replace(BODY_CLOSE, () => fragment + '</body>');
  return `${html}\n${fragment}`;
}

/** 拒绝屏。文案直接给演练对象看，只能写"暂时无法访问 / 页面不存在 / 链接已失效"，出现演练、授权、采集字样就作废这次演练；状态码由调用方决定。 */
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

/** 兜底学习页：模板没挂学习页或学习页被删时的最后一屏。人已经交出凭据了，这一屏可以说明是演练，继续瞒着只会让他以为账号真的被盗；要点必须是可执行的动作。 */
export function renderLessonFallbackPage() {
  // 顺序按离开这屏后的风险排：认仿冒域名、断掉点链接的习惯、守住验证码口令、再给一条核实路径
  const tips = [
    ['先看域名，别看页面样子', '登录页可以做得跟真的一模一样，域名不会。差一个字母、多一段后缀、陌生顶级域，都是最常见的仿冒手法。'],
    ['不从邮件和聊天里的链接进系统', '需要处理时，自己打开常用的官方入口或 App，而不是点发过来的地址。光看链接文字判断不出它真正通向哪里。'],
    ['验证码和一次性密码不外传', '自称客服、同事、IT 支持的人索要短信验证码、动态口令或扫码确认，一律拒绝。'],
    ['拿不准就换一条路核实', '用你本来存的对方号码或官方渠道回拨一次，而不是回拨邮件里给的号码；不要直接转发可疑邮件给同事群。'],
  ];
  // 常量也走一遍转义，保住"进 HTML 先转义"这条规矩
  const list = tips.map(([head, body]) => `<li style="margin:0 0 14px;"><strong style="color:#1f2937;">${escapeHtml(head)}</strong><br><span style="color:#6b7280;">${escapeHtml(body)}</span></li>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>安全意识提示</title></head>
<body style="margin:0;background:#f5f7fa;font-family:'Microsoft YaHei',sans-serif;">
<div style="max-width:640px;margin:8vh auto;padding:32px 36px;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);">
<h2 style="margin:0 0 10px;font-size:20px;color:#1f2937;">这是一次安全意识演练</h2>
<p style="margin:0 0 20px;color:#6b7280;line-height:1.8;font-size:14px;">
您刚才访问的是一个模拟的登录页面，您填写的内容只用于本次单位内部演练，不是真实账号被盗。请把这一次当成练习，记住下面四条判断方法：</p>
<ol style="margin:0;padding-left:20px;font-size:14px;line-height:1.7;">${list}</ol>
<p style="margin:22px 0 0;color:#9ca3af;font-size:13px;">如果确认自己遇到了真实钓鱼，请立刻联系信息安全团队修改密码。</p>
</div></body></html>`;
}
