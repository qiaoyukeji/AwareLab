/**
 * 采集运行时的拼装层：配置块和上报脚本两件东西注入访客页面。
 * 端点、配置块 id、Cookie 名、事件名都是冻结协议；RUNTIME 用 String.raw 包住、ES5 写法，
 * 正文原样发到访客浏览器，注释只写在外层，动正文等于动协议。
 * boot 块要落在模板自带脚本之后、</body> 之前，否则页面的 onsubmit 先绑定，采集反而采不到。
 */
export const ENGAGE_BASE = '/alab/v2';

/** 上报端点：boot 块里的 endpoint 固定写它，运行时据此反推信标根路径 */
export const ENGAGE_ENDPOINT = `${ENGAGE_BASE}/engage`;

/** 警示学习页端点 */
export const LESSON_ENDPOINT = `${ENGAGE_BASE}/lesson`;

/** 运行时只按这个 id 找参数，端到端断言也指着它，改名即破坏协议兼容。 */
export const BOOT_ELEMENT_ID = 'alab-boot';

/**
 * 库值 learn 在这里翻译成协议值 lesson，只翻这一次，其余环节只认协议值。
 * 空值兜成 alert：少了这道兜底，没设响应动作的模板提交后页面点了没反应。
 */
export function bootAfter(responseType) {
  return responseType === 'learn' ? 'lesson' : responseType || 'alert';
}

/**
 * 配置块用 JSON 承载，浏览器不会执行它，页面上的其它脚本也拿不到全局命名空间。
 * 每个字段都给缺省值：boot 块里出现字面量 undefined 会直接在访客页面上报出怪值。
 * JSON 里的 < 转义成 \\u003c，否则模板正文含 </script> 时提前闭合配置块，把注入脚本变成可见文本。
 */
export function buildBootBlock(cfg) {
  const payload = {
    token: cfg.token ?? '',
    site: cfg.site ?? '',
    after: cfg.after ?? 'alert',
    content: cfg.content ?? '',
    endpoint: cfg.endpoint ?? ENGAGE_ENDPOINT,
  };
  // 反斜杠-u 转义小于号：模板内容里出现 </script> 时不会提前截断配置块
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<script type="application/alab+json" id="${BOOT_ELEMENT_ID}">${json}</script>`;
}

// String.raw 保住正文里的正则与反斜杠，别改成普通模板字符串；正文一个字符都不能多，它会原样发到访客浏览器。
const RUNTIME = String.raw`
(function () {
  var cfg = {};
  try {
    var node = document.getElementById('alab-boot');
    cfg = JSON.parse((node && node.textContent) || '{}') || {};
  } catch (e) { cfg = {}; }
  var engageUrl = cfg.endpoint || '/alab/v2/engage';
  // 信标根路径由上报端点反推：boot 块只需给一个 endpoint，学习页等兄弟路径自动跟着走
  var planeRoot = engageUrl.replace(/\/engage\/?$/, '');
  var bootAt = (window.performance && performance.now) ? performance.now() : Date.now();

  function token() {
    try {
      var fromUrl = new URLSearchParams(location.search).get('tk');
      if (fromUrl) { sessionStorage.setItem('alab.tk', fromUrl); return fromUrl; }
      var saved = sessionStorage.getItem('alab.tk');
      return saved || cfg.token || '';
    } catch (e) { return cfg.token || ''; }
  }

  function dwell() {
    var end = (window.performance && performance.now) ? performance.now() : Date.now();
    return Math.max(0, Math.round((end - bootAt) / 1000));
  }

  function put(fields, name, value) {
    if (!Object.prototype.hasOwnProperty.call(fields, name)) { fields[name] = value; return; }
    var current = fields[name];
    if (Object.prototype.toString.call(current) === '[object Array]') fields[name] = current.concat([value]);
    else fields[name] = [current, value];
  }

  function collect() {
    var fields = {};
    var nodes = document.querySelectorAll('input, select, textarea');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el.name || el.hasAttribute('data-al-ignore')) continue;
      if (el.type === 'submit' || el.type === 'button' || el.type === 'reset') continue;
      var value;
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (!el.checked) continue;
        value = el.value || 'on';
      } else {
        value = (el.value === null || el.value === undefined) ? '' : String(el.value);
      }
      put(fields, el.name, value);
    }
    return fields;
  }

  function report(ev, extra) {
    // href 只取路径：完整 URL 会把监听端口与令牌查询串写进取证记录，路径才是稳定的页面标识
    var payload = { ev: ev, tk: token(), dwell: dwell(), href: location.pathname, search: location.search, referer: document.referrer || '' };
    if (extra) { for (var key in extra) { if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key]; } }
    var body = JSON.stringify(payload);
    if (ev === 'open' && navigator.sendBeacon) {
      try { if (navigator.sendBeacon(engageUrl + '?tk=' + encodeURIComponent(payload.tk), body)) return Promise.resolve({}); } catch (e) {}
    }
    return fetch(engageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      // 老模板的 onclick 常在采集之后立刻跳转或 reload，不给 keepalive 这次上报会随页面卸载被取消
      keepalive: ev === 'submit',
    })
      .then(function (res) { return res.json(); })
      .catch(function () { return {}; });
  }

  function notice(text) {
    if (!document.getElementById('alab-notice-style')) {
      var style = document.createElement('style');
      style.id = 'alab-notice-style';
      style.textContent = 'dialog.alab-notice{background:#fff}dialog.alab-notice::backdrop{background:rgba(0,0,0,.45)}';
      document.head.appendChild(style);
    }
    var dialog = document.createElement('dialog');
    dialog.className = 'alab-notice';
    dialog.setAttribute('style', 'position:fixed;inset:0;margin:auto;border:0;border-radius:10px;padding:28px 32px;min-width:280px;max-width:86%;box-shadow:0 12px 40px rgba(0,0,0,.25);font-family:"Microsoft YaHei",sans-serif;');
    var message = document.createElement('div');
    message.setAttribute('style', 'font-size:15px;color:#333;line-height:1.7;white-space:pre-wrap;');
    message.textContent = text;
    var button = document.createElement('button');
    button.textContent = '确定';
    button.setAttribute('style', 'margin-top:20px;width:100%;padding:10px;border:0;border-radius:6px;background:#4a90e2;color:#fff;font-size:14px;cursor:pointer;');
    button.addEventListener('click', function () {
      if (typeof dialog.close === 'function') dialog.close();
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
    });
    dialog.appendChild(message);
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    // 老内核没有 showModal：退化成普通定居元素，保证提示一定看得见
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', 'open');
  }

  function respond() {
    var value = cfg.content || '';
    if (cfg.after === 'redirect' && value) { location.replace(value); return; }
    if (cfg.after === 'lesson') { location.replace(planeRoot + '/lesson?tk=' + encodeURIComponent(token())); return; }
    notice(value || '操作成功');
  }

  function submit() {
    // 上报失败也必须给出响应，否则演练现场会出现「点了没反应」的破绽
    return report('submit', { fields: collect() }).then(respond, respond);
  }

  // 页面自己有没有真能提交的控件？没有的话，表单里的按钮就是用户眼中的提交键
  function hasSubmitControl(form) {
    if (!form) return false;
    return !!form.querySelector('input[type=submit], input[type=image], button[type=submit], button:not([type])');
  }

  document.addEventListener('submit', function (e) {
    e.preventDefault();
    e.stopPropagation();
    submit();
  }, true);

  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var declared = e.target.closest('[data-al-collect]');
    if (declared) {
      e.preventDefault();
      submit();
      return;
    }
    // 兜底：手写或仿站来的页面常把提交做成 <input type="button" onclick="login()">，
    // 它既不触发 submit 事件也没有采集声明，不兜底就是"目标明明点了，平台一条都没记"。
    // 只在表单内、且这张表单确实没有提交控件时接管，避免把「获取验证码」这类按钮误判成提交。
    var btn = e.target.closest('button, input[type=button]');
    if (!btn || btn.hasAttribute('data-al-ignore')) return;
    var form = btn.closest('form');
    if (!form || hasSubmitControl(form) || document.querySelector('[data-al-collect]')) return;
    e.preventDefault();
    submit();
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { report('open'); });
  } else {
    report('open');
  }

  window.AwareLab = { token: token, collect: collect, report: report, submit: submit };
})();
`;

/** 把运行时包成 <script> 标签，注入位置由 pageCompiler 决定。 */
export function buildEngageScript() {
  return `<script>${RUNTIME}</script>`;
}

/**
 * 完整注入片段，配置块在前、运行时在后：运行时启动时就读 #alab-boot，顺序反了就取不到参数。
 */
export function buildEngage(cfg) {
  return buildBootBlock(cfg) + buildEngageScript();
}
