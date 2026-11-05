/**
 * 富文本入库前的 XSS 净化边界：全仓唯一一处脏 HTML → 可安全挂进管理面的门。
 * 素材原文保存不清化（库里的 html 字段是演练证据），净化只发生在渲染到屏幕的预览与编辑路径，本文件不参与保存请求。
 * 配置是白名单，没在清单上的默认剥掉；DOMPurify 依赖浏览器 DOM，只能在浏览器里验效果，别挪进 Node/构建。
 */
import DOMPurify from 'dompurify';

/**
 * 基础放行标签白名单，底线是管理员自己写的富文本照常显示；不在清单上的默认剥掉。
 * 放行 class/style 与 html/head/img：版式、整文档预览与贴图全靠它们。style 里的危险协议由 stripDangerousCss 剥，
 *   src 协议 DOMPurify 恒检（javascript: 恒禁），meta 只掐危险的 http-equiv=refresh。
 * 放行 id 靠 SANITIZE_DOM 防 DOM clobbering；默认不放 script/iframe/form/input 等执行结构与表单控件，
 *   假登录页预览是唯一例外，用 LOGIN_PREVIEW_OPTIONS 临时回捞。
 */
const BASE_ALLOWED_TAGS = [
  // 整文档骨架：保证 charset、标题与样式不丢
  'html', 'head', 'body', 'title', 'meta', 'style',
  'div', 'span', 'p', 'br', 'hr', 'pre', 'code', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // 老邮件客户端还在用 font/center，禁了邮件正文会大面积掉版式
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'small', 'big', 'sub', 'sup',
  'del', 'ins', 'mark', 'abbr', 'cite', 'dfn', 'kbd', 'samp', 'var', 'tt',
  'font', 'center', 'nobr', 'wbr', 'bdi', 'bdo', 'ruby', 'rt', 'rp', 'time', 'q',
  // 表格全家：营销邮件与仿站页面的排版主力
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'article', 'section', 'aside', 'header', 'footer', 'nav', 'main',
  'figure', 'figcaption', 'details', 'summary',
  'img', 'picture', 'source',
];

/**
 * 永远禁止的标签：FORBID 压过任何 addTags，执行结构不给任何一档配置顺手放开的机会。
 * script 是脚本执行本体；noscript/template 会被二次解析（老牌绕过净化器的入口）；
 *   iframe/frame/portal/fence 内嵌外部文档；object/embed/applet 是插件时代的脚本载体；
 *   base 劫持整份预览文档的相对链接，link 拉外部 js/css 既是执行入口又泄露访问痕迹。
 */
const NEVER_ALLOWED_TAGS = [
  'script', 'noscript', 'template',
  'iframe', 'frame', 'frameset', 'portal', 'fence',
  'object', 'embed', 'applet', 'noembed', 'noframes',
  'base', 'link',
];

/**
 * 永远禁止的属性：FORBID 压过一切 addAttrs。srcdoc 是 iframe 的文档注入通道（双保险）；
 *   http-equiv 配合 meta 的 refresh 自动跳转，预览页不许把操作员浏览器导航走；ping 是点击回传信标。
 * on* 事件属性（onclick/onerror/…）不用列这里：DOMPurify 内置拦截恒剥它，白名单也没给它们进场资格。
 */
const NEVER_ALLOWED_ATTRS = ['srcdoc', 'http-equiv', 'ping'];

/**
 * 基础放行属性：排版与链接够用的那一圈。
 * href/src/srcset/background 都是 URL 属性，协议由 DOMPurify 恒检：javascript:/vbscript: 一律剥，
 *   data: 只允许出现在 img 等 DATA_URI_TAGS 上，所以 <a href="data:text/html,..."> 被掐掉、base64 贴图不受影响。
 * 表格排版属性（width/colspan/bgcolor/cellpadding…）禁了版式当场塌；title/alt/target/rel 等纯展示无风险。
 */
const BASE_ALLOWED_ATTRS = [
  'href', 'src', 'srcset', 'sizes', 'media', 'alt', 'title', 'class', 'id', 'style',
  'width', 'height', 'align', 'valign', 'colspan', 'rowspan', 'border', 'bgcolor', 'background',
  'cellpadding', 'cellspacing', 'target', 'rel', 'lang', 'dir', 'loading', 'decoding',
  'datetime', 'start', 'scope', 'summary', 'headers', 'color',
];

/**
 * CSS 层第二道粗网：DOMPurify 只管属性存不存在，不逐条解析 style 内部，这里专剥 style 属性与 <style> 里的危险写法。
 * url(javascript:/vbscript:) 换成 url(#) 保声明形状；裸 javascript:/vbscript: 协议抹掉；expression() 换成 0 让它变无效值。
 * 宁可多剥：误伤一段文案样式只是版式小瑕疵，漏放一条可执行声明是管理面 XSS，代价不对称。
 */
function stripDangerousCss(css) {
  return String(css)
    .replace(/url\(\s*['"]?\s*(?:javascript|vbscript)\s*:[^)]*\)/gi, 'url(#)')
    .replace(/(?:javascript|vbscript)\s*:[^;}"']*/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '0');
}

/**
 * 属性级钩子：收尾再洗一遍 style 属性，只剥紧不放宽，任何调用方都不会被它坑到。
 * 洗完若只剩空白就整个摘掉（空 style 是纯噪声）。
 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.getAttribute && node.hasAttribute('style')) {
    const raw = node.getAttribute('style');
    const cleaned = stripDangerousCss(raw);
    if (cleaned !== raw) {
      if (cleaned.trim()) node.setAttribute('style', cleaned);
      else node.removeAttribute('style');
    }
  }
});

/** 元素级钩子：整段 <style> 文本也过一遍 stripDangerousCss。不删整个 <style>（版式全靠它），逐条替换危险声明更贴合只不让它执行的目标。 */
DOMPurify.addHook('afterSanitizeElements', (node) => {
  if (node.nodeName === 'STYLE' && node.textContent) {
    const cleaned = stripDangerousCss(node.textContent);
    if (cleaned !== node.textContent) node.textContent = cleaned;
  }
});

/**
 * 净化一段来路不明的 HTML，产出可安全挂进管理面的字符串；null/undefined 回空串（调用方常在 computed 传 ref 初值）。
 * options.addTags/addAttrs 只往白名单加、救不回 NEVER_ALLOWED_*，其余键透传 DOMPurify。幂等，多道净化不叠加破坏；只在浏览器里跑。
 */
export function sanitizeHtml(dirty, options = {}) {
  if (dirty == null || dirty === '') return '';
  const { addTags = [], addAttrs = [], ...rest } = options;
  return DOMPurify.sanitize(String(dirty), {
    ALLOWED_TAGS: BASE_ALLOWED_TAGS.concat(addTags),
    ALLOWED_ATTR: BASE_ALLOWED_ATTRS.concat(addAttrs),
    FORBID_TAGS: NEVER_ALLOWED_TAGS,
    FORBID_ATTR: NEVER_ALLOWED_ATTRS,
    // KEEP_CONTENT：剥危险标签时保留其中文字；但 script 无论这项怎么设都被整体丢弃
    KEEP_CONTENT: true,
    // SANITIZE_DOM：放行 id 后全靠它防 id="innerHTML" 这类 DOM clobbering
    SANITIZE_DOM: true,
    // ALLOW_DATA_ATTR：协议 v2 的 data-al-collect / data-al-ignore 靠 data-* 存活，预览字段结构才和线上一致
    ALLOW_DATA_ATTR: true,
    ...rest,
  });
}

/**
 * 纯文本转成安全 HTML：实体转义 + 换行转 <br>，除自加的 <br> 外不含任何标签（目标就是不留标签，故用转义而非 DOMPurify，也是本文件唯一不依赖浏览器 DOM 处）。
 * & 必须最先替换，否则 &lt; 会被再转义成 &amp;lt;，屏幕上露出转义符。
 */
export function sanitizeText(dirty) {
  return String(dirty == null ? '' : dirty)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, '<br>');
}

/**
 * 假登录页预览专用配置：临时回捞 form/input/button 等登录控件，执行结构照旧全禁。
 * 安全前提是这份 HTML 只落在管理面自己的 sandbox iframe（无 allow-same-origin、读不到会话），预览不接真实采集，放开的是长相不是行为。
 * addAttrs 都是值属性（type/placeholder/name…），无执行能力。
 * WHOLE_DOCUMENT：DOMPurify 整文档返回不带 <!DOCTYPE html>，调用方要自己补上，否则 iframe 落进 quirks 模式版式错乱。
 */
export const LOGIN_PREVIEW_OPTIONS = {
  addTags: [
    'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea',
    'label', 'fieldset', 'legend', 'progress', 'meter',
  ],
  addAttrs: [
    'type', 'placeholder', 'name', 'value', 'checked', 'selected', 'disabled', 'readonly',
    'required', 'maxlength', 'min', 'max', 'step', 'autocomplete', 'autofocus', 'size', 'rows', 'cols',
  ],
  WHOLE_DOCUMENT: true,
};
