/**
 * 内置素材库：开箱可用的仿冒页面、邮件文案与学习页。
 *
 * 为什么内置而不是让操作员从空白页开始：同类产品都带一批常见场景，现场演练往往当天就要开跑，
 * 手写 HTML 既慢又容易漏掉可采集字段（<form>、name、提交控件），落库后体检分还很低。
 * 这一批全部是通用企业系统形态（邮箱、SSO、VPN、云盘、人事、会议、快递），不复制任何真实品牌的
 * 标识、配色与文案；品牌名是虚构的"远山科技"，只提供版式与话术骨架，操作员按自己的授权范围替换。
 *
 * 每份 HTML 都是自包含的：样式内联、无外链、无 script，断网演练也能完整渲染；
 * 采集靠平台注入的运行时（见 capture/engageScript.js），模板本身不许再带脚本，否则会和注入逻辑打架。
 * 页面的 id 固定成 bt-page-* 这类前缀，重复播种按 id 幂等：已有行不覆盖，操作员改过的内容不会被重启抹掉。
 */

/** 内置页面的类型口径；与前端素材页的类型下拉、建站时的模板选择保持同一组词 */
export const PAGE_TYPES = {
  login: '登录页',
  verify: '验证页',
  notice: '通知页',
  form: '采集页',
};

// 虚构品牌：所有内置素材共用，避免同一次演练里十封邮件像十家公司发来的
const BRAND = '远山科技';
const BRAND_MARK = '远';

// 复制模板时要把品牌换成本单位的名字，这里导出去给 library/branding.js 用
export const BUILTIN_BRAND = BRAND;
export const BUILTIN_MARK = BRAND_MARK;

/** 页面的公共骨架：左侧品牌信息 + 右侧表单卡；移动端收成单列并隐藏品牌栏 */
function pageHtml({ accent, accentDark, product, title, subtitle, fields, submit, note = '', aside = [] }) {
  const inputs = fields
    .map(
      (field) => `        <label class="field">
          <span>${field.label}</span>
          <input name="${field.name}" type="${field.type || 'text'}" placeholder="${field.placeholder || ''}" autocomplete="${field.autocomplete || 'off'}" spellcheck="false">
        </label>`
    )
    .join('\n');
  const bullets = aside.map((item) => `          <li>${item}</li>`).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${product}</title>
<style>
  :root { --brand: ${accent}; --brand-dark: ${accentDark}; --ink: #0f172a; --muted: #64748b; --line: #dbe3ec; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
         font-family: "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink);
         background: radial-gradient(circle at 12% 18%, #e8eefb 0%, transparent 42%), radial-gradient(circle at 88% 82%, #e6f5f1 0%, transparent 40%), #f6f8fb; }
  .card { width: 100%; max-width: 940px; display: grid; grid-template-columns: 1.05fr 400px; background: #fff;
          border: 1px solid #e6ecf3; border-radius: 18px; overflow: hidden; box-shadow: 0 24px 60px rgba(15, 23, 42, .12); }
  .aside { padding: 44px 40px; color: #fff; display: flex; flex-direction: column; justify-content: space-between;
           background: linear-gradient(155deg, var(--brand) 0%, var(--brand-dark) 100%); }
  .logo { width: 46px; height: 46px; border-radius: 12px; background: rgba(255, 255, 255, .18);
          display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 700; letter-spacing: 1px; }
  .aside h1 { margin: 22px 0 6px; font-size: 22px; letter-spacing: .5px; }
  .aside .product { margin: 0; font-size: 13px; opacity: .82; }
  .aside ul { margin: 28px 0 0; padding: 0; list-style: none; font-size: 12.5px; line-height: 2; opacity: .9; }
  .aside li::before { content: "·"; margin-right: 8px; opacity: .7; }
  .aside .copy { font-size: 11.5px; opacity: .55; }
  .panel { padding: 44px 40px 38px; }
  .panel h2 { margin: 0 0 6px; font-size: 20px; }
  .panel .sub { margin: 0 0 26px; color: var(--muted); font-size: 12.5px; line-height: 1.7; }
  .field { display: block; margin-bottom: 16px; }
  .field span { display: block; font-size: 12.5px; color: #475569; margin-bottom: 7px; font-weight: 600; }
  .field input { width: 100%; height: 42px; padding: 0 13px; border: 1px solid var(--line); border-radius: 9px;
                 font-size: 13.5px; color: var(--ink); background: #fbfdff; outline: none; transition: border-color .15s, box-shadow .15s; }
  .field input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 16%, transparent); background: #fff; }
  button { width: 100%; height: 43px; margin-top: 8px; border: 0; border-radius: 9px; cursor: pointer;
           background: var(--brand); color: #fff; font-size: 14px; font-weight: 600; letter-spacing: .5px; }
  button:hover { filter: brightness(1.06); }
  .note { margin: 18px 0 0; color: var(--muted); font-size: 11.5px; line-height: 1.8; }
  .note a { color: var(--brand); text-decoration: none; }
  @media (max-width: 760px) {
    .card { grid-template-columns: 1fr; max-width: 420px; }
    .aside { display: none; }
    .panel { padding: 32px 24px; }
  }
</style>
</head>
<body>
<main class="card">
  <section class="aside">
    <div>
      <div class="logo">${BRAND_MARK}</div>
      <h1>${BRAND}</h1>
      <p class="product">${product}</p>
      <ul>
${bullets}
      </ul>
    </div>
    <p class="copy">© 2026 ${BRAND} · 内部系统，请勿对外分享账号</p>
  </section>
  <section class="panel">
    <h2>${title}</h2>
    <p class="sub">${subtitle}</p>
    <form method="post" action="#" novalidate>
${inputs}
      <button type="submit">${submit}</button>
    </form>
    <p class="note">${note}</p>
  </section>
</main>
</body>
</html>`;
}

/**
 * 单卡骨架：居中一张窄卡，只有一个输入区，适合"认证、验证码、停机通知"这类轻页面。
 * 和双栏版式并列存在，是为了让模板库的缩略图一眼能分出两种页面结构，而不是十几张同一张脸。
 * extra 给二维码、进度条这类一次性块用；表格、脚本一律不进来。
 */
function pageCenterHtml({ accent, accentDark, product, title, subtitle, fields, submit, note = '', extra = '', footer = '' }) {
  const inputs = fields
    .map(
      (field) => `      <label class="field">
        <span>${field.label}</span>
        <input name="${field.name}" type="${field.type || 'text'}" placeholder="${field.placeholder || ''}" autocomplete="${field.autocomplete || 'off'}" spellcheck="false">
      </label>`
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${product}</title>
<style>
  :root { --brand: ${accent}; --brand-dark: ${accentDark}; --ink: #0f172a; --muted: #64748b; --line: #dde5ef; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
         font-family: "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink);
         background: linear-gradient(180deg, color-mix(in srgb, var(--brand) 9%, #ffffff) 0%, #f7f9fc 46%, #f2f5f9 100%); }
  .card { width: 100%; max-width: 420px; background: #fff; border: 1px solid #e7edf5; border-radius: 16px;
          padding: 32px 30px 26px; box-shadow: 0 18px 44px rgba(15, 23, 42, .10); }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
  .logo { width: 40px; height: 40px; border-radius: 11px; background: linear-gradient(150deg, var(--brand), var(--brand-dark));
          color: #fff; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700; }
  .head .product { font-size: 12.5px; color: var(--muted); letter-spacing: .3px; }
  h1 { margin: 0 0 8px; font-size: 19px; line-height: 1.45; }
  .sub { margin: 0 0 22px; font-size: 12.5px; line-height: 1.8; color: var(--muted); }
  .field { display: block; margin-bottom: 14px; }
  .field span { display: block; font-size: 12.5px; color: #475569; margin-bottom: 7px; font-weight: 600; }
  .field input { width: 100%; height: 42px; padding: 0 13px; border: 1px solid var(--line); border-radius: 9px;
                 font-size: 13.5px; color: var(--ink); background: #fbfdff; outline: none; transition: border-color .15s, box-shadow .15s; }
  .field input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 16%, transparent); background: #fff; }
  button { width: 100%; height: 43px; margin-top: 6px; border: 0; border-radius: 9px; cursor: pointer;
           background: var(--brand); color: #fff; font-size: 14px; font-weight: 600; letter-spacing: .5px; }
  button:hover { filter: brightness(1.06); }
  .extra { margin: 0 0 18px; padding: 14px; border: 1px dashed var(--line); border-radius: 10px; background: #fafcff; text-align: center; }
  .note { margin: 16px 0 0; color: var(--muted); font-size: 11.5px; line-height: 1.8; }
  .foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid #eef3f8; color: #98a4b2; font-size: 11px; line-height: 1.7; text-align: center; }
</style>
</head>
<body>
<main class="card">
  <div class="head">
    <div class="logo">${BRAND_MARK}</div>
    <div class="product">${product}</div>
  </div>
  <h1>${title}</h1>
  <p class="sub">${subtitle}</p>
${extra ? `  <div class="extra">${extra}</div>\n` : ''}  <form method="post" action="#" novalidate>
${inputs}
    <button type="submit">${submit}</button>
  </form>
  <p class="note">${note}</p>
  <p class="foot">${footer || `© 2026 ${BRAND} · 内部系统，请勿对外分享账号`}</p>
</main>
</body>
</html>`;
}

/** 邮件正文骨架：表格布局 + 内联样式，兼容 Outlook / 企业邮箱；正文里只出现 {{name}} 与 {{site_url}} 两个占位符 */
function mailHtml({ accent, product, heading, intro, bullets = [], cta, path, closing = '如非本人操作，请忽略本邮件。' }) {
  const list = bullets.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 6px;border-left:3px solid ${accent};background:#f8fafc">
        <tr><td style="padding:12px 16px;font-size:13px;color:#475569;line-height:1.9">${bullets.join('<br>')}</td></tr>
      </table>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${heading}</title></head>
<body style="margin:0;padding:0;background:#eef2f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:28px 12px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:'PingFang SC','Microsoft YaHei',Arial,sans-serif">
      <tr><td style="padding:18px 28px;background:${accent};color:#ffffff;font-size:14px;font-weight:700;letter-spacing:.5px">${BRAND} · ${product}</td></tr>
      <tr><td style="padding:30px 28px 8px">
        <h1 style="margin:0 0 16px;font-size:19px;line-height:1.5;color:#0f172a">${heading}</h1>
        <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.9">${intro}</p>
        ${list}
        <p style="margin:22px 0 26px">
          <a href="{{site_url}}${path}" style="display:inline-block;padding:11px 26px;background:${accent};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:7px">${cta}</a>
        </p>
        <p style="margin:0 0 22px;font-size:12px;color:#7b8794;line-height:1.8">如果按钮无法点击，请复制以下地址到浏览器打开：<br><span style="color:${accent};word-break:break-all">{{site_url}}${path}</span></p>
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #e8eef5;font-size:11.5px;color:#8b98a5;line-height:1.8">
        ${closing}<br>本邮件由 ${BRAND} 信息系统自动发送，请勿直接回复。
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** 学习页骨架：给上钩后的教育页用，语气中性、只讲识别要点 */
function lessonHtml(title, lead, items) {
  const list = items
    .map(
      (item, index) => `      <li>
        <b>${index + 1}. ${item.title}</b>
        <p>${item.text}</p>
      </li>`
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; padding: 40px 18px; background: #f5f8fb; color: #0f172a;
         font-family: "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e4ebf3; border-radius: 16px; padding: 36px 40px; }
  .tag { display: inline-block; padding: 3px 10px; border-radius: 999px; background: #e8f5f0; color: #0f766e; font-size: 12px; font-weight: 600; }
  h1 { margin: 14px 0 8px; font-size: 22px; }
  .lead { margin: 0 0 22px; color: #64748b; font-size: 13.5px; line-height: 1.9; }
  ol { margin: 0; padding: 0; list-style: none; }
  li { padding: 16px 0; border-top: 1px solid #eef3f8; }
  li b { font-size: 14px; }
  li p { margin: 6px 0 0; color: #55657a; font-size: 13px; line-height: 1.9; }
  .foot { margin-top: 24px; padding-top: 18px; border-top: 1px solid #eef3f8; color: #8b98a5; font-size: 12px; line-height: 1.8; }
</style>
</head>
<body>
  <main class="wrap">
    <span class="tag">安全意识提示</span>
    <h1>${title}</h1>
    <p class="lead">${lead}</p>
    <ol>
${list}
    </ol>
    <p class="foot">如果你刚在仿冒页面上填写了账号或口令，请立刻修改密码并联系信息安全团队。本页只用于安全提醒，不会记录你在此处输入的任何内容。</p>
  </main>
</body>
</html>`;
}

/** 内置学习页：上钩后的教育落点，也是建站时的可选"提交后跳转" */
export const LEARN_PAGES = [
  {
    id: 'bt-lesson-identify',
    key: 'lesson-identify',
    name: '识别钓鱼邮件与仿冒登录页',
    html: lessonHtml(
      '刚才那封邮件，问题出在哪？',
      '这封邮件和它指向的页面都是安全意识演练的一部分。真实攻击里，只要少看一眼地址栏，账号口令就已经交出去了。下面几处是最常见的破绽。',
      [
        {
          title: '发件人域名与显示名不是一回事',
          text: '显示名可以随便写成"IT 服务台"，真正的域名要看 @ 后面的部分。把鼠标悬停在发件人上，核对域名拼写是否有细微差别。',
        },
        {
          title: '链接地址要在点击前看清',
          text: '把鼠标悬停在按钮上，浏览器状态栏会显示真实地址。内部系统不会使用陌生域名，也不会用 IP 加高端口。',
        },
        {
          title: '紧急与恐吓是最常用的钩子',
          text: '"24 小时内不处理将停用"这类话术是为了让你跳过核对。遇到时限压力，先从内部通讯录找到官方入口自行登录。',
        },
        {
          title: '登录页不会索要多余信息',
          text: '正常登录只要账号与口令。凡是同时索要身份证号、银行卡、短信验证码的页面，都应当先停下来核实。',
        },
      ]
    ),
  },
  {
    id: 'bt-lesson-password',
    key: 'lesson-password',
    name: '口令与多因素认证',
    html: lessonHtml(
      '口令泄露之后，攻击者能做什么？',
      '一次口令泄露往往不会立刻被发现：攻击者会先登录邮箱翻找财务与人事往来，再以此为跳板重置其他系统。多因素认证是最后一道、也是最有效的一道闸。',
      [
        { title: '不同系统不要复用同一口令', text: '一个系统被拖库，复用同一口令的账号会接连失守。用密码管理器为每个系统生成独立口令。' },
        { title: '短信验证码也会被转发', text: '不要向任何人朗读验证码，也不要在陌生页面输入。正规客服不会索要验证码。' },
        { title: '发现异常先改口令再排查', text: '怀疑泄露时，先改口令并踢掉已登录会话，再检查邮箱转发规则与代收设置。' },
        { title: '把可疑邮件交给安全团队', text: '保留原始邮件（不要转发正文），交给信息安全团队分析发件域与链接，比自行删除更有价值。' },
      ]
    ),
  },
  {
    id: 'bt-lesson-report',
    key: 'lesson-report',
    name: '中招之后的处置步骤',
    html: lessonHtml(
      '已经填了账号口令，现在做什么？',
      '在演练里这只是记一次上钩；在真实事件里，前十分钟的处理决定了损失大小。按下面的顺序做，不要因为担心被责备而隐瞒。',
      [
        { title: '立即修改口令', text: '从确认安全的设备与网络登录官方入口修改口令，不要点邮件里的"改密"链接。' },
        { title: '检查会话与转发规则', text: '退出所有已登录设备，检查邮箱自动转发、代收、签名与规则，攻击者常借此长期潜伏。' },
        { title: '上报给信息安全团队', text: '说明填写了哪些信息、大概时间、页面地址。越早处置，越容易判断是否已被利用。' },
        { title: '留意后续的二次钓鱼', text: '攻击者会用已掌握的信息伪造"安全提醒"再次接触你。任何索要验证码的来电与邮件都要先核实。' },
      ]
    ),
  },
  {
    id: 'bt-lesson-drill',
    key: 'lesson-drill',
    name: '什么是安全意识演练',
    html: lessonHtml(
      '这是一次授权范围内的安全意识演练',
      '你刚刚访问的页面由本单位信息安全团队在授权范围内搭建，用于检验大家对钓鱼邮件与仿冒登录页的识别能力。采集到的信息只用于本次演练复盘，不会对外提供。',
      [
        { title: '演练有明确授权与期限', text: '组织方需登记授权主体、允许仿冒的域名与有效时间；超出范围或过期后，页面与链接会自动失效。' },
        { title: '只采集判断所需的字段', text: '平台记录提交时间、字段名与来源地址，用于统计上钩率与安排培训；敏感数据默认只保留在本机。' },
        { title: '结果用于改进而不是追责', text: '演练的价值在于发现流程与培训的缺口。发现有人上钩，应优先补上该岗位的识别培训与验证手段。' },
        { title: '有疑问就问安全团队', text: '任何看起来像演练又拿不准的邮件，都可以先按可疑邮件上报，由安全团队确认。' },
      ]
    ),
  },
  {
    id: 'bt-lesson-code',
    key: 'lesson-code',
    name: '验证码与电话社工',
    html: lessonHtml(
      '验证码就是你的第二把钥匙',
      '短信验证码、动态口令、扫码确认，本质都是"证明是你本人"的第二把钥匙。一旦交给别人，等于亲手把门打开——而这一步往往只需一通电话。',
      [
        { title: '真客服不会索要验证码', text: '任何自称银行、运营商、平台客服或 IT 支持的人要你念出验证码、读出短信内容，都是骗局。验证码只输在你自己打开的页面里。' },
        { title: '留意"帮助操作"的话术', text: '"我帮你取消会员""我帮你退款""我帮你解冻账号"，都是让你在不知情下完成别人发起的验证。先挂断，再从官方 App 自行核实。' },
        { title: '短信里的链接同样可疑', text: '验证码短信常被塞进"点击查看详情"的短链，点开就是仿冒页。核对发件号码没用，号码可以被伪造。' },
        { title: '被索要过就这样处理', text: '立即修改口令、退出其他设备登录、检查是否新增了陌生设备或授权应用，并上报安全团队。' },
      ]
    ),
  },
  {
    id: 'bt-lesson-mobile',
    key: 'lesson-mobile',
    name: '二维码与移动端风险',
    html: lessonHtml(
      '手机屏幕上更容易漏看的几处细节',
      '移动端地址栏短、弹窗小、输入法会联想，仿冒页面在手机上比在电脑上更难分辨。下面四条是移动端上钩最常见的入口。',
      [
        { title: '扫码前先看落地域名', text: '二维码本身看不出指向。扫开后先看地址栏的主域名，再看是否需要登录；陌生域名上的"登录"一律先退出。' },
        { title: '工作群里的二维码不等于可信', text: '账号被盗后，攻击者会用本人身份在群里发"投票""报名""领补贴"二维码。发件人可信不代表内容可信。' },
        { title: '不要在小程序与内嵌页里输口令', text: '真正的登录会跳到官方域名或官方 App。若页面要求你在聊天窗口、内嵌网页里直接输入企业口令，先停下。' },
        { title: '权限申请要看清楚', text: '伪装成"文件预览""扫码签到"的页面常见索取通讯录、短信、无障碍权限。与功能不相称的权限申请，直接拒绝。' },
      ]
    ),
  },
];

/** 内置仿冒页面：覆盖最常见的几类内部系统入口 */
export const PAGE_TEMPLATES = [
  {
    id: 'bt-page-mail-login',
    key: 'page-mail-login',
    name: '企业邮箱登录（经典双栏）',
    type: PAGE_TYPES.login,
    description: '最常见的邮箱登录页版式：左侧品牌说明、右侧账号口令表单，提交后显示登录成功。',
    response_content: '登录成功，正在进入邮箱…',
    html: pageHtml({
      accent: '#2563eb',
      accentDark: '#132a63',
      product: '企业邮箱 · 邮件与日程',
      title: '登录企业邮箱',
      subtitle: '使用你的公司账号登录，继续处理邮件与日程。',
      fields: [
        { label: '邮箱账号', name: 'username', type: 'text', placeholder: 'name@yuanshan.com', autocomplete: 'username' },
        { label: '登录密码', name: 'password', type: 'password', placeholder: '请输入登录密码', autocomplete: 'current-password' },
      ],
      submit: '登 录',
      note: '忘记密码？请联系 IT 服务台重置。连续 5 次输错将锁定 30 分钟。',
      aside: ['全端同步：网页、桌面与移动端', '邮件、日程、云盘一个账号打通', '支持双因素认证与登录审计'],
    }),
  },
  {
    id: 'bt-page-sso',
    key: 'page-sso',
    name: '统一身份认证 SSO',
    type: PAGE_TYPES.login,
    description: '单点登录入口，适合作为"点击邮件后被带到公司登录页"的落点。',
    response_content: '认证成功，正在返回应用…',
    html: pageHtml({
      accent: '#4f46e5',
      accentDark: '#231a5e',
      product: '统一身份认证中心',
      title: '统一身份认证',
      subtitle: '一个账号访问邮箱、OA、云盘与业务系统。',
      fields: [
        { label: '工号 / 邮箱', name: 'username', type: 'text', placeholder: '请输入工号或邮箱', autocomplete: 'username' },
        { label: '密码', name: 'password', type: 'password', placeholder: '请输入密码', autocomplete: 'current-password' },
      ],
      submit: '登录并继续',
      note: '登录即表示你同意《信息系统使用规范》。异常登录会被记录并通知安全团队。',
      aside: ['一次登录，访问全部已授权应用', '登录行为全程留痕', '支持扫码与双因素认证'],
    }),
  },
  {
    id: 'bt-page-vpn',
    key: 'page-vpn',
    name: 'VPN 远程接入门户',
    type: PAGE_TYPES.login,
    description: '远程办公场景的 VPN 登录页，适合配合"出差/居家办公"主题邮件。',
    response_content: '认证通过，正在建立安全隧道…',
    html: pageHtml({
      accent: '#0f766e',
      accentDark: '#083c39',
      product: '远程接入 · VPN 门户',
      title: '远程接入认证',
      subtitle: '在办公网络之外访问内部系统，需要先完成身份认证。',
      fields: [
        { label: '域账号', name: 'username', type: 'text', placeholder: 'yuanshan\\name', autocomplete: 'username' },
        { label: '密码', name: 'password', type: 'password', placeholder: '请输入域账号密码', autocomplete: 'current-password' },
      ],
      submit: '连接',
      note: '仅限公司配发的设备接入。连续失败会触发账号保护，请联系服务台。',
      aside: ['加密隧道，适配家庭与出差网络', '按部门下发访问权限', '接入记录保留 180 天'],
    }),
  },
  {
    id: 'bt-page-share',
    key: 'page-share',
    name: '云盘共享文件确认',
    type: PAGE_TYPES.notice,
    description: '同事共享了一份文件，需要登录后查看；适合"共享文档"主题邮件。',
    response_content: '验证通过，正在打开共享文件…',
    html: pageHtml({
      accent: '#ea580c',
      accentDark: '#6b2606',
      product: '企业云盘 · 共享空间',
      title: '查看共享文件',
      subtitle: '「2026 年度预算（终版）.xlsx」由 财务部 共享给你，验证身份后即可查看。',
      fields: [
        { label: '你的邮箱', name: 'username', type: 'text', placeholder: 'name@yuanshan.com', autocomplete: 'username' },
        { label: '邮箱密码', name: 'password', type: 'password', placeholder: '请输入邮箱密码', autocomplete: 'current-password' },
      ],
      submit: '验证并查看',
      note: '该文件仅限被共享人访问，请勿转发链接。共享有效期 7 天。',
      aside: ['文件在线预览，无需下载', '共享范围与下载记录可追溯', '支持水印与外发审批'],
    }),
  },
  {
    id: 'bt-page-mail-quota',
    key: 'page-mail-quota',
    name: '邮箱容量已满 · 扩容验证',
    type: PAGE_TYPES.notice,
    description: '以"容量已满、需验证扩容"为由索要账号口令，是钓鱼邮件里最常见的一类。',
    response_content: '扩容申请已提交，正在同步配额…',
    html: pageHtml({
      accent: '#dc2626',
      accentDark: '#5f1010',
      product: '企业邮箱 · 容量管理',
      title: '邮箱容量已达上限',
      subtitle: '你的邮箱已使用 98% 配额，新邮件将被暂时退回。验证账号后可立即扩容至 50GB。',
      fields: [
        { label: '邮箱账号', name: 'username', type: 'text', placeholder: 'name@yuanshan.com', autocomplete: 'username' },
        { label: '登录密码', name: 'password', type: 'password', placeholder: '请输入登录密码', autocomplete: 'current-password' },
      ],
      submit: '立即扩容',
      note: '扩容在验证后 5 分钟内生效。若持续提示已满，请联系 IT 服务台。',
      aside: ['当前配额 10GB，已用 9.8GB', '扩容后保留全部历史邮件', '支持按部门批量申请'],
    }),
  },
  {
    id: 'bt-page-meeting',
    key: 'page-meeting',
    name: '会议邀请确认',
    type: PAGE_TYPES.notice,
    description: '会议邀请落点：需要登录确认参会，常用于"季度经营分析会"一类主题。',
    response_content: '已确认参会，会议链接将发送到你的邮箱。',
    html: pageHtml({
      accent: '#059669',
      accentDark: '#064e3b',
      product: '会议与协作',
      title: '确认参加会议',
      subtitle: '「2026 年 Q1 经营分析会」邀请你参加，验证身份后确认席位并获取会议链接。',
      fields: [
        { label: '姓名', name: 'username', type: 'text', placeholder: '请输入姓名', autocomplete: 'name' },
        { label: '企业邮箱', name: 'email', type: 'text', placeholder: 'name@yuanshan.com', autocomplete: 'email' },
      ],
      submit: '确认参会',
      note: '会议时间：3 月 18 日 14:00–16:00 · 线上会议。席位确认后不可转让。',
      aside: ['自动同步到日历', '支持会前材料预读', '会议纪要与录播回放'],
    }),
  },
  {
    id: 'bt-page-payslip',
    key: 'page-payslip',
    name: '工资条查看（人事系统）',
    type: PAGE_TYPES.notice,
    description: '以工资条、补贴、个税核对为诱饵的页面，员工最容易放下戒心。',
    response_content: '验证成功，正在加载工资条…',
    html: pageHtml({
      accent: '#7c3aed',
      accentDark: '#3b1a70',
      product: '人事系统 · 薪酬服务',
      title: '查看本月工资条',
      subtitle: '2026 年 2 月工资条已发布，验证身份后可查看明细并确认个税专项扣除。',
      fields: [
        { label: '工号', name: 'username', type: 'text', placeholder: '例如 YS1024', autocomplete: 'off' },
        { label: '身份证后六位', name: 'password', type: 'password', placeholder: '请输入证件后六位', autocomplete: 'off' },
      ],
      submit: '查看工资条',
      note: '工资条含个人敏感信息，请勿截图外传。对金额有疑问请在 5 个工作日内联系 HRBP。',
      aside: ['月度工资、奖金与补贴明细', '个税专项附加扣除确认', '历史工资条在线查询'],
    }),
  },
  {
    id: 'bt-page-parcel',
    key: 'page-parcel',
    name: '快递待领取通知',
    type: PAGE_TYPES.notice,
    description: '快递、发票、文件签收类通知，常用于跨部门、跨楼层的社工场景。',
    response_content: '已登记领取信息，请到前台出示工牌领取。',
    html: pageHtml({
      accent: '#0891b2',
      accentDark: '#083344',
      product: '行政服务 · 收发室',
      title: '你有一件快递待领取',
      subtitle: '单号 SF1234567890 的包裹已到达 3 号楼前台，请登记后于 18:00 前领取。',
      fields: [
        { label: '姓名', name: 'username', type: 'text', placeholder: '请输入姓名', autocomplete: 'name' },
        { label: '手机号后四位', name: 'phone', type: 'text', placeholder: '用于核对收件信息', autocomplete: 'off' },
      ],
      submit: '登记领取',
      note: '超过 3 天未领取将退回发件方。代领需出示被代领人工牌照片。',
      aside: ['工作日 9:00–18:00 前台领取', '大件物品可预约送到工位', '发票与合同请当场核验'],
    }),
  },
  {
    id: 'bt-page-mfa',
    key: 'page-mfa',
    name: '二次验证 / 动态口令',
    type: PAGE_TYPES.verify,
    description: '要求输入 6 位动态口令的验证页，用来演练"验证码被套取"这一类手法。',
    response_content: '验证通过，正在完成登录…',
    html: pageHtml({
      accent: '#1d4ed8',
      accentDark: '#12275c',
      product: '身份验证 · 双因素认证',
      title: '输入动态口令',
      subtitle: '我们已向你的认证器应用发送 6 位动态口令，请在 60 秒内输入完成验证。',
      fields: [{ label: '6 位动态口令', name: 'code', type: 'text', placeholder: '000000', autocomplete: 'one-time-code' }],
      submit: '验证',
      note: '动态口令 60 秒刷新一次。请勿向任何人透露，包括自称 IT 支持的人员。',
      aside: ['支持认证器 App 与硬件令牌', '新设备登录需二次验证', '异常验证会触发账号保护'],
    }),
  },
  {
    id: 'bt-page-oa',
    key: 'page-oa',
    name: 'OA 协同办公门户',
    type: PAGE_TYPES.login,
    description: '审批、公文、待办都在 OA 里；适合"你有单据待审批"这类日常办公主题。',
    response_content: '登录成功，正在加载待办…',
    html: pageHtml({
      accent: '#0284c7',
      accentDark: '#082f49',
      product: 'OA 协同办公',
      title: '登录 OA 办公门户',
      subtitle: '待办、审批、公文与考勤都在这里，登录后继续处理。',
      fields: [
        { label: '工号 / 手机号', name: 'username', type: 'text', placeholder: '请输入工号或手机号', autocomplete: 'username' },
        { label: '登录密码', name: 'password', type: 'password', placeholder: '请输入登录密码', autocomplete: 'current-password' },
      ],
      submit: '登 录',
      note: '长时间未操作会自动退出。审批类操作全程留痕，请勿代他人操作。',
      aside: ['待办与审批一处处理', '公文流转全程留痕', '移动端支持扫码登录'],
    }),
  },
  {
    id: 'bt-page-erp',
    key: 'page-erp',
    name: '财务 ERP / 费控平台',
    type: PAGE_TYPES.login,
    description: '报销、借款、付款申请的门户；财务与经办人最常打开的系统之一。',
    response_content: '登录成功，正在载入财务共享平台…',
    html: pageHtml({
      accent: '#1d4ed8',
      accentDark: '#172554',
      product: '财务共享 · 费控与核算',
      title: '登录财务共享平台',
      subtitle: '报销、借款、付款申请与预算查询，使用公司账号登录。',
      fields: [
        { label: '工号', name: 'username', type: 'text', placeholder: '例如 YS1024', autocomplete: 'username' },
        { label: '密码', name: 'password', type: 'password', placeholder: '请输入登录密码', autocomplete: 'current-password' },
      ],
      submit: '登录平台',
      note: '仅限授权经办人登录。涉及付款的操作需要二次确认，异常登录会被记录。',
      aside: ['报销、借款与付款申请', '预算占用实时可见', '凭证与发票自动关联'],
    }),
  },
  {
    id: 'bt-page-wifi',
    key: 'page-wifi',
    name: '企业无线网络认证',
    type: PAGE_TYPES.login,
    description: '连上办公 WiFi 后的准入认证页，单卡片版式；适合钓鱼热点、办公区网络主题。',
    response_content: '认证成功，已接入办公网络。',
    html: pageCenterHtml({
      accent: '#0e7490',
      accentDark: '#083344',
      product: '企业网络 · 无线准入',
      title: '连接 YS-WiFi',
      subtitle: '首次连接办公无线网络需要用工号与密码完成认证，认证后 30 天内免重复登录。',
      fields: [
        { label: '工号', name: 'username', type: 'text', placeholder: '请输入工号', autocomplete: 'username' },
        { label: '密码', name: 'password', type: 'password', placeholder: '请输入登录密码', autocomplete: 'current-password' },
      ],
      submit: '连接网络',
      note: '办公区与访客区网络策略不同。认证失败请联系 IT 服务台 8888。',
    }),
  },
  {
    id: 'bt-page-sms',
    key: 'page-sms',
    name: '短信验证码验证',
    type: PAGE_TYPES.verify,
    description: '以短信验证码为由索要第二因素，常与电话社工配合使用；单卡片版式。',
    response_content: '验证通过，正在完成登录…',
    html: pageCenterHtml({
      accent: '#c026d3',
      accentDark: '#701a75',
      product: '账号安全 · 短信验证',
      title: '输入短信验证码',
      subtitle: '验证码已发送至 138****6688，5 分钟内有效。请勿把验证码告诉任何人。',
      fields: [{ label: '6 位短信验证码', name: 'code', type: 'text', placeholder: '000000', autocomplete: 'one-time-code' }],
      submit: '验证并登录',
      note: '平台不会通过电话、短信或聊天工具向你索要验证码。收不到验证码可稍后重试。',
    }),
  },
  {
    id: 'bt-page-qr',
    key: 'page-qr',
    name: '扫码确认登录',
    type: PAGE_TYPES.verify,
    description: '要求用手机 App 扫码确认的登录页，演练"扫码即授权"这类无口令钓鱼。',
    response_content: '已在手机端确认，正在进入系统…',
    html: pageCenterHtml({
      accent: '#15803d',
      accentDark: '#052e16',
      product: '统一登录 · 扫码确认',
      title: '扫描二维码确认登录',
      subtitle: '打开手机上的企业 App，扫描二维码并点击「确认登录」。若扫码失败，可在下方输入手机号后四位。',
      extra: `<div style="width:132px;height:132px;margin:0 auto;background:
        repeating-linear-gradient(90deg,#0f172a 0 6px,transparent 6px 12px),
        repeating-linear-gradient(0deg,#0f172a 0 6px,transparent 6px 12px);
        border:6px solid #fff;box-shadow:0 0 0 1px #dbe3ec;border-radius:4px"></div>
        <p style="margin:10px 0 0;font-size:11.5px;color:#64748b">二维码 120 秒后失效</p>`,
      fields: [{ label: '手机号后四位', name: 'phone', type: 'text', placeholder: '例如 6688', autocomplete: 'off' }],
      submit: '继续',
      note: '确认前请核对登录设备与地点。不是你本人发起的登录，请直接拒绝并修改密码。',
    }),
  },
  {
    id: 'bt-page-reimburse',
    key: 'page-reimburse',
    name: '报销单待审批',
    type: PAGE_TYPES.notice,
    description: '以"单据待审批、即将超时"为由的头衔，适合财务与部门负责人岗位。',
    response_content: '审批已提交，正在返回待办列表…',
    html: pageHtml({
      accent: '#b45309',
      accentDark: '#451a03',
      product: '费控 · 报销审批',
      title: '有一张报销单待你审批',
      subtitle: '「3 月差旅报销 · ¥4,860.00」由 市场部 李昊 提交，需在 24 小时内完成审批。',
      fields: [
        { label: '企业邮箱', name: 'username', type: 'text', placeholder: 'name@yuanshan.com', autocomplete: 'username' },
        { label: '邮箱密码', name: 'password', type: 'password', placeholder: '请输入邮箱密码', autocomplete: 'current-password' },
      ],
      submit: '登录并审批',
      note: '超时未审批将自动流转至上级。审批记录与金额明细可在费控平台查询。',
      aside: ['单据金额、事由与附件一目了然', '支持批量审批与加签', '审批痕迹不可删除'],
    }),
  },
  {
    id: 'bt-page-attendance',
    key: 'page-attendance',
    name: '考勤异常待确认',
    type: PAGE_TYPES.notice,
    description: '以缺勤、漏打卡为由施压，员工为了不影响考核容易直接登录。',
    response_content: '异常记录已提交确认，等待 HR 复核。',
    html: pageHtml({
      accent: '#a16207',
      accentDark: '#422006',
      product: '考勤与工时',
      title: '考勤异常待确认',
      subtitle: '你在 3 月 12 日有一次未打卡记录，需本人确认补录，否则将按缺勤处理。',
      fields: [
        { label: '工号', name: 'username', type: 'text', placeholder: '例如 YS1024', autocomplete: 'username' },
        { label: '登录密码', name: 'password', type: 'password', placeholder: '请输入登录密码', autocomplete: 'current-password' },
      ],
      submit: '确认打卡记录',
      note: '本月累计异常 1 次。补录需在当月 25 日前完成，逾期由部门负责人处理。',
      aside: ['打卡、请假与加班统一记录', '异常提醒自动推送', '月度工时报表可导出'],
    }),
  },
  {
    id: 'bt-page-invoice',
    key: 'page-invoice',
    name: '电子发票待下载',
    type: PAGE_TYPES.notice,
    description: '发票、票据类通知，诱饵具体（金额、开票方），落点是邮箱登录。',
    response_content: '验证通过，正在生成发票下载链接…',
    html: pageHtml({
      accent: '#0369a1',
      accentDark: '#082f49',
      product: '发票与税务',
      title: '电子发票待下载',
      subtitle: '一张增值税电子普通发票（¥1,280.00）已开具，请登录后下载，30 天后需重新申请。',
      fields: [
        { label: '邮箱账号', name: 'username', type: 'text', placeholder: 'name@yuanshan.com', autocomplete: 'username' },
        { label: '登录密码', name: 'password', type: 'password', placeholder: '请输入登录密码', autocomplete: 'current-password' },
      ],
      submit: '登录下载',
      note: '发票仅供报销使用，请勿转发他人。下载记录会与报销单自动关联。',
      aside: ['电子发票在线下载与验真', '与报销单自动关联', '开票信息可自助修改'],
    }),
  },
  {
    id: 'bt-page-maintenance',
    key: 'page-maintenance',
    name: '系统停机维护通知',
    type: PAGE_TYPES.notice,
    description: '以"维护后需重新登录"为由的轻页面，单卡片版式，适合全员群发。',
    response_content: '已重新登录，正在同步维护后的配置…',
    html: pageCenterHtml({
      accent: '#475569',
      accentDark: '#1e293b',
      product: 'IT 服务台 · 系统公告',
      title: '邮箱与 OA 停机维护',
      subtitle: '为修复安全漏洞，邮箱与 OA 将于今晚 22:00–23:30 停机维护。维护完成后需重新登录一次。',
      fields: [
        { label: '邮箱账号', name: 'username', type: 'text', placeholder: 'name@yuanshan.com', autocomplete: 'username' },
        { label: '登录密码', name: 'password', type: 'password', placeholder: '请输入登录密码', autocomplete: 'current-password' },
      ],
      submit: '立即重新登录',
      note: '维护期间未发送的邮件会在恢复后自动重试。本次维护不会索要你的密码或验证码。',
    }),
  },
  {
    id: 'bt-page-policy',
    key: 'page-policy',
    name: '安全策略更新 · 重新登录',
    type: PAGE_TYPES.notice,
    description: '以"口令策略更新"为由要求重新登录，是年度安全通知里最常见的仿冒点。',
    response_content: '策略已同步，正在引导你设置新口令…',
    html: pageHtml({
      accent: '#be123c',
      accentDark: '#4c0519',
      product: '信息安全 · 策略中心',
      title: '安全策略已更新',
      subtitle: '新的口令策略要求 90 天更换一次，且不得与前 5 次重复。请重新登录完成设置。',
      fields: [
        { label: '工号 / 邮箱', name: 'username', type: 'text', placeholder: '请输入工号或邮箱', autocomplete: 'username' },
        { label: '当前密码', name: 'password', type: 'password', placeholder: '请输入当前密码', autocomplete: 'current-password' },
      ],
      submit: '重新登录',
      note: '未在 7 天内完成设置的账号将被限制登录。策略调整由信息安全团队发布。',
      aside: ['口令强度与轮换策略统一管理', '弱口令账号自动提醒', '多因素认证可自助开通'],
    }),
  },
  {
    id: 'bt-page-exam',
    key: 'page-exam',
    name: '年度安全考试',
    type: PAGE_TYPES.notice,
    description: '培训考试类通知，参与门槛低、填写意愿高，适合全员演练。',
    response_content: '已记录参加信息，正在进入考试页面…',
    html: pageHtml({
      accent: '#6d28d9',
      accentDark: '#2e1065',
      product: '培训与考试',
      title: '年度安全考试待参加',
      subtitle: '2026 年度信息安全考试已开放，共 20 题，需在 3 月 31 日前完成。',
      fields: [
        { label: '姓名', name: 'username', type: 'text', placeholder: '请输入姓名', autocomplete: 'name' },
        { label: '工号', name: 'employee_id', type: 'text', placeholder: '例如 YS1024', autocomplete: 'off' },
      ],
      submit: '进入考试',
      note: '未参加将影响部门年度考核。考试可重复作答，取最高分计入。',
      aside: ['20 道单选与判断，约 15 分钟', '考后可查看错题解析', '成绩自动同步培训档案'],
    }),
  },
  {
    id: 'bt-page-idverify',
    key: 'page-idverify',
    name: '身份核验 · 补充资料',
    type: PAGE_TYPES.form,
    description: '借用"异常登录需核验"索取姓名、证件号与手机号，属于超出凭据范围的个人信息采集。',
    response_content: '资料已提交，核验结果将在 24 小时内通知。',
    html: pageCenterHtml({
      accent: '#b91c1c',
      accentDark: '#450a0a',
      product: '账号安全 · 身份核验',
      title: '完成身份核验',
      subtitle: '系统检测到你的账号存在异常登录，为恢复使用，请补充核验以下信息。',
      fields: [
        { label: '姓名', name: 'username', type: 'text', placeholder: '请输入真实姓名', autocomplete: 'name' },
        { label: '身份证号', name: 'id_number', type: 'text', placeholder: '请输入 18 位身份证号', autocomplete: 'off' },
        { label: '手机号', name: 'phone', type: 'text', placeholder: '请输入常用手机号', autocomplete: 'off' },
      ],
      submit: '提交核验',
      note: '核验完成后可恢复正常登录。平台不会通过邮件索要完整的身份证号与银行卡信息。',
    }),
  },
];

/** 内置邮件文案：与上面的页面按主题配对，正文里的链接统一写 {{site_url}}，发送时替换成绑定站点的地址 */
export const MAIL_TEMPLATES = [
  {
    id: 'bt-mail-quota',
    key: 'mail-quota',
    name: '邮箱容量告警',
    subject: '【提醒】{{name}} 的邮箱容量已使用 98%，请及时处理',
    description: '容量告急 + 时限压力，最常见的账号类钓鱼主题。',
    body_html: mailHtml({
      accent: '#dc2626',
      product: '企业邮箱',
      heading: '邮箱容量即将用尽',
      intro: '{{name}}，您好：<br>系统检测到你的邮箱已使用 9.8GB / 10GB 配额。容量用尽后，新邮件将被暂时退回，可能影响你正常接收工作邮件。',
      bullets: ['当前配额：10GB', '已使用：9.8GB（98%）', '影响范围：收发邮件、日历邀请'],
      cta: '立即扩容邮箱',
      path: '/mail',
      closing: '扩容在验证账号后自动生效。如非本人操作，请及时修改密码并联系 IT 服务台。',
    }),
  },
  {
    id: 'bt-mail-share',
    key: 'mail-share',
    name: '共享文件待查看',
    subject: '财务部向你共享了「2026 年度预算（终版）.xlsx」',
    description: '以共享文档为诱饵，点击后落到云盘登录页。',
    body_html: mailHtml({
      accent: '#ea580c',
      product: '企业云盘',
      heading: '你收到一份共享文件',
      intro: '{{name}}，您好：<br>财务部 王琳 向你共享了一份文件，共享有效期 7 天。点击下方按钮登录后即可在线查看。',
      bullets: ['文件名称：2026 年度预算（终版）.xlsx', '共享人：财务部 王琳', '有效期至：2026-03-25'],
      cta: '查看共享文件',
      path: '/share',
      closing: '该文件仅限被共享人访问，请勿转发链接或截图外传。',
    }),
  },
  {
    id: 'bt-mail-password',
    key: 'mail-password',
    name: '密码即将过期',
    subject: '你的域账号密码将在 24 小时后过期',
    description: '利用"到期停用"的紧迫感诱导改密，落点是 SSO 登录页。',
    body_html: mailHtml({
      accent: '#4f46e5',
      product: '统一身份认证',
      heading: '域账号密码即将过期',
      intro: '{{name}}，您好：<br>你的域账号密码将在 24 小时后过期。过期后将无法登录邮箱、OA 与业务系统。请尽快完成密码更新。',
      bullets: ['账号：{{email}}', '到期时间：24 小时内', '影响系统：邮箱、OA、云盘、VPN'],
      cta: '立即更新密码',
      path: '/sso',
      closing: '如已更新请忽略本邮件。密码更新不会通过邮件索要你的原密码。',
    }),
  },
  {
    id: 'bt-mail-vpn',
    key: 'mail-vpn',
    name: '异地登录提醒',
    subject: '【安全提醒】检测到你的账号在新设备登录',
    description: '伪造异地登录告警，诱导用户"验证身份"从而交出账号。',
    body_html: mailHtml({
      accent: '#0f766e',
      product: '账号安全中心',
      heading: '检测到新的设备登录',
      intro: '{{name}}，您好：<br>你的账号于 03:12 在一台未登记的设备上登录，来源地显示为「境外」。如果这不是你本人操作，请立即验证身份并修改密码。',
      bullets: ['登录时间：2026-03-16 03:12', '设备：Windows 11 · Chrome', '来源地：新加坡'],
      cta: '验证身份并保护账号',
      path: '/vpn',
      closing: '若确认是本人操作，可忽略本提醒。',
    }),
  },
  {
    id: 'bt-mail-payslip',
    key: 'mail-payslip',
    name: '工资条已发布',
    subject: '2026 年 2 月工资条已发布，请查收',
    description: '薪酬主题打开率高，适合演练人事系统相关的凭据窃取。',
    body_html: mailHtml({
      accent: '#7c3aed',
      product: '人事系统',
      heading: '本月工资条已发布',
      intro: '{{name}}，您好：<br>2026 年 2 月工资条已发布，请登录人事系统查看明细，并在 3 月 20 日前完成个税专项附加扣除确认。',
      bullets: ['发放月份：2026 年 2 月', '确认截止：2026-03-20', '包含项目：基本工资、绩效、补贴、个税'],
      cta: '查看工资条',
      path: '/payslip',
      closing: '工资条含个人敏感信息，请勿截图外传。',
    }),
  },
  {
    id: 'bt-mail-meeting',
    key: 'mail-meeting',
    name: '会议邀请',
    subject: '邀请：2026 年 Q1 经营分析会（需确认参会）',
    description: '会议邀请类邮件，落点为确认参会页面。',
    body_html: mailHtml({
      accent: '#059669',
      product: '会议与协作',
      heading: '邀请你参加 Q1 经营分析会',
      intro: '{{name}}，您好：<br>诚邀你参加 2026 年 Q1 经营分析会，请于 3 月 17 日前确认参会，会议链接将在确认后发送到你的邮箱。',
      bullets: ['时间：3 月 18 日 14:00–16:00', '形式：线上会议（Teams）', '议程：经营回顾、预算执行、Q2 规划'],
      cta: '确认参会',
      path: '/meeting',
      closing: '如需请假或委托他人参会，请直接回复本邮件说明。',
    }),
  },
  {
    id: 'bt-mail-parcel',
    key: 'mail-parcel',
    name: '快递待领取',
    subject: '你有一件快递在前台待领取（单号 SF1234567890）',
    description: '行政通知类邮件，适合低频但高打开率的场景。',
    body_html: mailHtml({
      accent: '#0891b2',
      product: '行政服务',
      heading: '快递已到达前台',
      intro: '{{name}}，您好：<br>你有一件快递已到达 3 号楼前台，请携带工牌在 18:00 前领取。超过 3 天未领取将退回发件方。',
      bullets: ['快递单号：SF1234567890', '到达时间：今天 09:40', '领取地点：3 号楼 1 层收发室'],
      cta: '登记领取信息',
      path: '/parcel',
      closing: '代领需出示被代领人工牌照片。',
    }),
  },
  {
    id: 'bt-mail-upgrade',
    key: 'mail-upgrade',
    name: '系统安全升级通知',
    subject: '【IT 通知】邮箱系统安全升级，需重新登录',
    description: '以系统升级、需重新登录为由，把用户引到仿冒 SSO。',
    body_html: mailHtml({
      accent: '#1d4ed8',
      product: 'IT 服务台',
      heading: '邮箱系统完成安全升级',
      intro: '{{name}}，您好：<br>为提升账号安全，邮箱系统已于今日凌晨完成升级。所有用户需重新登录一次以同步新的安全策略。',
      bullets: ['升级时间：2026-03-16 02:00–04:00', '影响范围：网页版邮箱、移动端 App', '需要操作：重新登录一次'],
      cta: '重新登录邮箱',
      path: '/sso',
      closing: '本次升级不会索要你的密码或验证码。如有疑问请联系 IT 服务台 8888。',
    }),
  },
  {
    id: 'bt-mail-oa',
    key: 'mail-oa',
    name: '待办审批即将超时',
    subject: '【待办】你有 3 条审批将在 2 小时后超时',
    description: 'OA 待办类主题，工作节奏紧张时打开率极高，落点是 OA 登录页。',
    body_html: mailHtml({
      accent: '#0284c7',
      product: 'OA 协同办公',
      heading: '你有 3 条待办即将超时',
      intro: '{{name}}，您好：<br>以下审批将在 2 小时后超时并自动流转至上级，请尽快处理。超时记录会进入部门月度统计。',
      bullets: ['费用报销 · 市场部 李昊 · ¥4,860.00', '用印申请 · 法务部 周珊 · 合同 2 份', '请假审批 · 研发部 陈默 · 3 月 20–21 日'],
      cta: '前往 OA 处理待办',
      path: '/oa',
      closing: '如已处理请忽略本提醒。待办可在移动端 App 中批量审批。',
    }),
  },
  {
    id: 'bt-mail-reimburse',
    key: 'mail-reimburse',
    name: '报销单被退回',
    subject: '你的报销单被退回：缺少发票影像（单据号 BX20260312001）',
    description: '以"单据被退回、需补充材料"为由，把财务与经办人引到费控登录页。',
    body_html: mailHtml({
      accent: '#b45309',
      product: '费控平台',
      heading: '报销单被退回，需补充材料',
      intro: '{{name}}，您好：<br>你提交的「3 月差旅报销 · ¥4,860.00」因缺少发票影像被退回，请在 3 个工作日内补充后重新提交。',
      bullets: ['单据号：BX20260312001', '退回原因：缺少发票影像', '补交期限：3 个工作日内'],
      cta: '登录费控平台补充材料',
      path: '/erp',
      closing: '逾期未补充的单据将自动作废，需重新发起申请。',
    }),
  },
  {
    id: 'bt-mail-attendance',
    key: 'mail-attendance',
    name: '考勤异常提醒',
    subject: '【考勤】你有 1 条未打卡记录待确认（3 月 12 日）',
    description: '考勤异常直接影响工资与考核，这类通知的点击几乎没有犹豫。',
    body_html: mailHtml({
      accent: '#a16207',
      product: '考勤与工时',
      heading: '有一条考勤异常待确认',
      intro: '{{name}}，您好：<br>系统检测到你在 3 月 12 日 18:00 有一次未打卡记录。请在当月 25 日前确认补录，逾期将按缺勤处理。',
      bullets: ['异常日期：2026-03-12', '异常类型：下班未打卡', '确认截止：2026-03-25'],
      cta: '确认打卡记录',
      path: '/attendance',
      closing: '如为设备故障导致，请联系部门考勤员统一说明。',
    }),
  },
  {
    id: 'bt-mail-invoice',
    key: 'mail-invoice',
    name: '电子发票已开具',
    subject: '电子发票已开具：¥1,280.00（30 天内有效）',
    description: '票据类邮件自带可信度，落点是邮箱登录页。',
    body_html: mailHtml({
      accent: '#0369a1',
      product: '发票服务',
      heading: '你的电子发票已开具',
      intro: '{{name}}，您好：<br>你申请的增值税电子普通发票已开具，可在 30 天内下载。逾期需重新提交开票申请。',
      bullets: ['发票金额：¥1,280.00', '开票方：远山科技（杭州）有限公司', '有效期：2026-03-16 至 2026-04-15'],
      cta: '下载电子发票',
      path: '/invoice',
      closing: '发票仅限本人报销使用，请勿转发或公开分享。',
    }),
  },
  {
    id: 'bt-mail-maintenance',
    key: 'mail-maintenance',
    name: '停机维护通知',
    subject: '【IT 通知】邮箱与 OA 将于今晚 22:00 停机维护',
    description: '全员群发类通知，落点是"维护后重新登录"页。',
    body_html: mailHtml({
      accent: '#475569',
      product: 'IT 服务台',
      heading: '今晚进行停机维护',
      intro: '{{name}}，您好：<br>为修复一处安全漏洞，邮箱与 OA 将于今晚 22:00–23:30 停机维护。维护完成后，所有用户需重新登录一次。',
      bullets: ['维护窗口：22:00–23:30', '影响系统：邮箱、OA、移动端 App', '维护后操作：重新登录一次'],
      cta: '提前重新登录',
      path: '/maintenance',
      closing: '维护期间发送的邮件会在恢复后自动重试。本次维护不会索要密码或验证码。',
    }),
  },
  {
    id: 'bt-mail-policy',
    key: 'mail-policy',
    name: '口令策略更新',
    subject: '【安全】口令策略已更新，请重新登录完成设置',
    description: '以合规要求为名义的策略通知，比"账号异常"更容易被当真。',
    body_html: mailHtml({
      accent: '#be123c',
      product: '信息安全中心',
      heading: '口令策略已更新',
      intro: '{{name}}，您好：<br>根据新的安全基线要求，口令需每 90 天更换一次且不得与前 5 次重复。请重新登录完成设置，未在 7 天内完成的账号将被限制登录。',
      bullets: ['最短长度：12 位', '轮换周期：90 天', '生效时间：2026-03-16'],
      cta: '重新登录并设置新口令',
      path: '/policy',
      closing: '本通知由信息安全中心发布。设置新口令请从官方入口进入，不要点击陌生链接。',
    }),
  },
  {
    id: 'bt-mail-exam',
    key: 'mail-exam',
    name: '安全考试通知',
    subject: '2026 年度信息安全考试已开放（3 月 31 日截止）',
    description: '培训考试类主题，参与成本低、填写意愿高，适合作为全员演练的引子。',
    body_html: mailHtml({
      accent: '#6d28d9',
      product: '培训与考试',
      heading: '年度信息安全考试已开放',
      intro: '{{name}}，您好：<br>2026 年度信息安全考试已开放，共 20 题，约需 15 分钟。请在 3 月 31 日前完成，未参加将影响部门年度考核。',
      bullets: ['题量：20 题（单选 + 判断）', '截止时间：2026-03-31 18:00', '计分方式：取最高分'],
      cta: '开始考试',
      path: '/exam',
      closing: '考试入口仅支持公司网络或 VPN 访问，遇到打不开请联系培训管理员。',
    }),
  },
  {
    id: 'bt-mail-wifi',
    key: 'mail-wifi',
    name: '无线网络认证方式变更',
    subject: '【网络】办公无线网络认证方式将于本周五变更',
    description: '网络准入类通知，落点是 WiFi 认证页，适合办公区现场演练。',
    body_html: mailHtml({
      accent: '#0e7490',
      product: '网络与基础设施',
      heading: '办公无线网络认证方式变更',
      intro: '{{name}}，您好：<br>本周五起，办公区无线网络将启用新的准入认证。首次连接需用工号与密码完成认证，此前保存的配置将被清除。',
      bullets: ['变更时间：2026-03-20 08:00', '影响范围：YS-WiFi、YS-Guest', '需要操作：重新认证一次'],
      cta: '查看认证方式',
      path: '/wifi',
      closing: '认证过程不会要求你安装任何客户端软件。遇到问题请联系 IT 服务台 8888。',
    }),
  },
  {
    id: 'bt-mail-lock',
    key: 'mail-lock',
    name: '账号被临时锁定',
    subject: '【紧急】你的账号因异常登录被临时锁定',
    description: '制造"账号已被锁定"的紧迫感，是索取凭据与验证码的经典组合。',
    body_html: mailHtml({
      accent: '#dc2626',
      product: '账号安全中心',
      heading: '账号已被临时锁定',
      intro: '{{name}}，您好：<br>系统检测到你的账号在 10 分钟内连续 5 次登录失败，已临时锁定 30 分钟。如非本人操作，请立即验证身份并修改密码。',
      bullets: ['锁定时间：2026-03-16 09:42', '失败次数：5 次', '来源地址：103.24.**.**（境外）'],
      cta: '验证身份并解锁',
      path: '/policy',
      closing: '解锁后请检查登录设备与邮件转发规则。安全中心不会通过电话索要验证码。',
    }),
  },
  {
    id: 'bt-mail-idcheck',
    key: 'mail-idcheck',
    name: '身份核验提醒',
    subject: '【账号安全】请完成身份核验以恢复账号使用',
    description: '索取姓名、证件号、手机号的采集页，用来演练"超出凭据范围"的个人信息采集。',
    body_html: mailHtml({
      accent: '#b91c1c',
      product: '账号安全中心',
      heading: '请完成身份核验',
      intro: '{{name}}，您好：<br>你的账号存在异常登录，部分功能已被限制。请补充核验姓名、证件号与手机号，核验通过后恢复使用。',
      bullets: ['限制功能：邮件发送、文件外发', '核验时限：24 小时内', '核验方式：在线填写'],
      cta: '立即完成核验',
      path: '/idverify',
      closing: '正规核验不会通过邮件链接收集完整证件号。如有疑问，请直接联系信息安全团队。',
    }),
  },
];

/** 学习页先行：页面模板的 learn_page_id 指向它们，顺序反了会埋下悬空引用 */
export const BUILTIN_LESSON_IDS = LEARN_PAGES.map((item) => item.id);
