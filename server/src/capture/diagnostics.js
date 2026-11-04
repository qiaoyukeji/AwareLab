const CHECK_WEIGHTS = { binding: 35, trigger: 25, fields: 20, assets: 10, scripts: 10 };

function countMatches(html, re) {
  return [...html.matchAll(re)];
}

function attributeOf(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function externalRefs(html) {
  const urls = [];
  for (const [, url] of countMatches(html, /(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    if (/^(https?:)?\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

/** 可采集字段：带 name 的输入控件，排除按钮类控件与显式忽略标记 */
export function collectableFields(html) {
  const names = [];
  for (const [tag] of countMatches(html, /<(?:input|select|textarea)\b[^>]*>/gi)) {
    if (/data-al-ignore/i.test(tag)) continue;
    const name = attributeOf(tag, 'name');
    if (!name) continue;
    if (/type\s*=\s*["']?(submit|button|reset)/i.test(tag)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** 能触发提交的控件：input[type=submit|image] 与 button（无 type 或 type=submit，浏览器默认就是提交） */
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

/** 只是动作按钮、不会触发提交的控件：老模板习惯把提交写成 <input type="button" onclick="login()"> */
function actionOnlyButtons(html) {
  const found = [];
  for (const [tag] of countMatches(html, /<(?:input|button)\b[^>]*>/gi)) {
    if (attributeOf(tag, 'type').toLowerCase() === 'button') found.push(tag.replace(/\s+/g, ' ').slice(0, 80));
  }
  return found;
}

function inlineHandlers(html) {
  return countMatches(html, /\son[a-z]+\s*=\s*["'][^"']*["']/gi)
    .map(([handler]) => handler.replace(/^\s+/g, '').replace(/\s+/g, ' ').slice(0, 60));
}

function buildCheck(key, label, ok, detail, items) {
  return items && items.length ? { key, label, ok, detail, items } : { key, label, ok, detail };
}

/**
 * 模板体检：只判断「能不能采到数据」，不判断模板长相。
 * 结果用于向导展示与列表标记，绝不阻断保存——演练现场常有半成品模板。
 */
export function inspectTemplate(html) {
  const source = String(html ?? '');
  const forms = countMatches(source, /<form\b/gi).length;
  const declared = countMatches(source, /\sdata-al-collect\b/gi).length;
  const urls = externalRefs(source);
  const scripts = countMatches(source, /<script\b/gi).length;
  const fields = collectableFields(source);
  const submitters = submitControls(source);
  const fallbackOnly = actionOnlyButtons(source);
  const handlers = inlineHandlers(source);

  const bindingOk = forms + declared > 0;
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

  const penalty = checks.reduce((sum, c) => (c.ok ? sum : sum + CHECK_WEIGHTS[c.key]), 0);
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
    score: Math.max(0, Math.min(100, 100 - penalty)),
    checks,
    issues,
  };
}
