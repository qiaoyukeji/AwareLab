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
};

// 虚构品牌：所有内置素材共用，避免同一次演练里十封邮件像十家公司发来的
const BRAND = '远山科技';
const BRAND_MARK = '远';

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
];

/** 学习页先行：页面模板的 learn_page_id 指向它们，顺序反了会埋下悬空引用 */
export const BUILTIN_LESSON_IDS = LEARN_PAGES.map((item) => item.id);
