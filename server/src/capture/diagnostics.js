/**
 * 采集面的模板体检：纯正则扫描，只判断能不能采到数据，不判断模板长相。
 * 不解析也不执行模板（仿站内容不可信），字段与触发点口径要和 engageScript 运行时逐条对齐，否则白名单会丢掉体检认为没问题的字段。
 * 结论只进管理面，从不阻断保存。
 */
// 权重合计 100：绑定和触发点是采不到数据的两项，占大头；外链与脚本只算次要项
const CHECK_WEIGHTS = { binding: 35, trigger: 25, fields: 20, assets: 10, scripts: 10 };

/** 把正则的全部匹配结果摊成数组（matchAll 给的是迭代器，这里统一成可解构的数组） */
function countMatches(html, re) {
  return [...html.matchAll(re)];
}

/** 抠单个标签的属性值，双引号、单引号、裸值都认，取不到给空串；不做完整属性解析，属性值里有 > 会截断。 */
function attributeOf(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

/** 站外的 src/href；相对路径不算，它跟着这个监听自己走。外链在断网演练时拉不到会让页面露白，还会让访客浏览器去请求第三方。 */
function externalRefs(html) {
  const urls = [];
  for (const [, url] of countMatches(html, /(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    if (/^(https?:)?\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

/** 带 name 的输入控件，按页面顺序去重。口径要和 engageScript 运行时一致：多收的会被回传白名单丢掉，漏报让操作员看到 0 字段。 */
export function collectableFields(html) {
  const names = [];
  for (const [tag] of countMatches(html, /<(?:input|select|textarea)\b[^>]*>/gi)) {
    // 显式标记"这个框不要采"，搜索框和伪装验证码输入常见
    if (/data-al-ignore/i.test(tag)) continue;
    const name = attributeOf(tag, 'name');
    if (!name) continue;
    // 提交类控件带 name 也没有值可采，收进来只在证据里多一个空字段
    if (/type\s*=\s*["']?(submit|button|reset)/i.test(tag)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** 能触发提交的控件，截到 80 字符当摘要。button 不带 type 也算：HTML 里它的默认 type 就是 submit，仿站页面大量这么写。 */
export function submitControls(html) {
  const found = [];
  for (const [tag] of countMatches(html, /<(?:input|button)\b[^>]*>/gi)) {
    const type = attributeOf(tag, 'type').toLowerCase();
    const isInput = /^<input/i.test(tag);
    const submitCapable = isInput ? type === 'submit' || type === 'image' : type === '' || type === 'submit';
    if (submitCapable) found.push(tag.replace(/\s+/g, ' ').slice(0, 80));
  }
  return found;
}

/** type=button 的动作按钮。老模板把提交写成这样，运行时靠它们兜底，列出来操作员才知道要改模板。 */
function actionOnlyButtons(html) {
  const found = [];
  for (const [tag] of countMatches(html, /<(?:input|button)\b[^>]*>/gi)) {
    if (attributeOf(tag, 'type').toLowerCase() === 'button') found.push(tag.replace(/\s+/g, ' ').slice(0, 80));
  }
  return found;
}

/** 内联事件属性（onclick / onsubmit 之类），截到 60 字符；模板自带的处理函数可能在采集之前把页面跳走。 */
function inlineHandlers(html) {
  return countMatches(html, /\son[a-z]+\s*=\s*["'][^"']*["']/gi)
    .map(([handler]) => handler.replace(/^\s+/g, '').replace(/\s+/g, ' ').slice(0, 60));
}

/** items 为空时不挂这个键：前端按 items 决定展不展开，空数组会显示成可展开但没内容。 */
function buildCheck(key, label, ok, detail, items) {
  return items && items.length ? { key, label, ok, detail, items } : { key, label, ok, detail };
}

/**
 * 返回 { score, checks, issues }：score 按 CHECK_WEIGHTS 扣分夹到 0-100，issues 是给操作员的中文建议。
 * 纯函数，不写库；一键仿站的产物也走这里。
 */
export function inspectTemplate(html) {
  const source = String(html ?? '');
  const forms = countMatches(source, /<form\b/gi).length;
  // 协议 v2 的两种绑定：<form> 由运行时拦 submit 事件，[data-al-collect] 由运行时认点击
  const declared = countMatches(source, /\sdata-al-collect\b/gi).length;
  const urls = externalRefs(source);
  const scripts = countMatches(source, /<script\b/gi).length;
  const fields = collectableFields(source);
  const submitters = submitControls(source);
  const fallbackOnly = actionOnlyButtons(source);
  const handlers = inlineHandlers(source);

  const bindingOk = forms + declared > 0;
  // 显式采集点或真有提交控件；只有动作按钮的老模板在这里判不过，运行时仍会兜底，所以只提示不否决
  const triggerOk = declared + submitters.length > 0;
  const checks = [
    buildCheck(
      'binding',
      '采集绑定',
      bindingOk,
      bindingOk ? `<form> ${forms} 个、[data-al-collect] ${declared} 处` : '未发现 <form> 或 [data-al-collect] 标记'
    ),
    buildCheck(
      'trigger',
      '提交触发点',
      triggerOk,
      triggerOk
        ? `[data-al-collect] ${declared} 处、提交控件 ${submitters.length} 个`
        : '页面里没有能触发提交的控件，只能靠运行时兜底认表单按钮',
      triggerOk ? [] : [...fallbackOnly, ...handlers]
    ),
    buildCheck('assets', '外部资源', urls.length === 0, urls.length ? `外链 ${urls.length} 处` : '无外链', urls),
    buildCheck('scripts', '自定义脚本', scripts === 0, scripts ? `自定义 script ${scripts} 处` : '无自定义 script'),
    buildCheck(
      'fields',
      '可采集字段',
      fields.length > 0,
      `${fields.length} 个命名字段`,
      fields
    ),
  ];

  // 只减不奖：不通过的项按权重扣分。权重合计 100，绑定+触发点+字段全挂就是 20 分
  const penalty = checks.reduce((sum, c) => (c.ok ? sum : sum + CHECK_WEIGHTS[c.key]), 0);
  // 按严重程度排：采不到数据最前，外链与脚本算隐患。这些句子不进访客屏
  const issues = [];
  if (!bindingOk) issues.push('未发现采集入口：请使用 <form> 或在提交控件上标记 data-al-collect，否则采不到任何数据。');
  if (!triggerOk) {
    issues.push(
      '没有 <button type="submit"> 或 data-al-collect：提交动作靠运行时兜底识别表单按钮，建议改成显式提交控件，别把证据押在兜底上。'
    );
  }
  if (urls.length) issues.push(`存在外部资源引用，外链不可达时会影响页面呈现：${urls.join('、')}`);
  if (scripts) issues.push('模板内含自定义 script，可能干扰平台的数据上报逻辑。');
  if (!fields.length) issues.push('页面没有带 name 的输入控件，平台无法确定要采集哪些字段。');

  return {
    // 两头都夹：将来加检查项后扣分可能超 100，界面直接拿这个数画进度条
    score: Math.max(0, Math.min(100, 100 - penalty)),
    checks,
    issues,
  };
}
