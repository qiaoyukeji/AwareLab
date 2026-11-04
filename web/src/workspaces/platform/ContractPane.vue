<template>
  <div class="lab-stack contract">
    <!-- ① 协议总览 -->
    <LabPane title="AwareLab 采集协议 v2" hint="这一页是平台与你的页面之间的契约：写页面、上报、响应、信标，四段各有唯一入口">
      <template #ops>
        <span class="lab-chip is-accent">协议版本 v2</span>
        <span class="lab-chip">旧版 onclick 约定已废弃</span>
      </template>
      <el-table :data="SURFACE" size="small">
        <el-table-column prop="face" label="网络面" width="110" />
        <el-table-column prop="entry" label="入口" min-width="230" />
        <el-table-column prop="auth" label="鉴权" width="130" />
        <el-table-column prop="note" label="说明" min-width="200" show-overflow-tooltip />
      </el-table>
      <p class="lab-hint is-mute" style="margin: 12px 0 0">
        旧文档里 <span class="mono-inline">{{ T.onclick }}</span> 手工挂载采集、以及早期私有上报路径那一套约定全部作废；
        现在页面不需要写任何采集代码，运行时由平台注入，字段名与端点以本页为准。
      </p>
    </LabPane>

    <!-- ② 页面写作约定 -->
    <LabPane title="1 · 页面写作约定" hint="你只负责内容与样式，注入的事交给平台">
      <ul class="doc-list">
        <li>模板只写纯 HTML + 内联 CSS，不引用外链 js/css —— 外链不可达会让页面在目标环境里露出破绽。</li>
        <li>平台在 <span class="mono-inline">{{ T.bodyEnd }}</span> 之前注入 boot 配置块与运行时脚本，<span class="lab-strong">不改写你的标签结构</span>：DOM 层级、类名、表单布局都保持原样。</li>
        <li>boot 块是页面里唯一的平台痕迹，用 <span class="mono-inline">{{ T.bootType }}</span> 作为脚本类型，浏览器不会执行它，只作为配置载体。</li>
      </ul>
      <div class="lab-mono">{{ BOOT_BLOCK }}</div>
      <el-table :data="BOOT_FIELDS" size="small" style="margin-top: 12px">
        <el-table-column prop="key" label="字段" width="110" />
        <el-table-column prop="meaning" label="含义" min-width="220" />
        <el-table-column prop="example" label="示例" min-width="180" />
      </el-table>
    </LabPane>

    <!-- ③ 采集绑定 -->
    <LabPane title="2 · 采集绑定" hint="默认全自动接管，只有例外需要显式声明">
      <el-table :data="BINDING" size="small">
        <el-table-column prop="case" label="场景" min-width="180" />
        <el-table-column prop="rule" label="规则" min-width="300" />
        <el-table-column prop="result" label="结果" min-width="180" />
      </el-table>
      <div class="lab-mono" style="margin-top: 12px">{{ BINDING_SAMPLE }}</div>
      <p class="lab-hint is-mute" style="margin: 10px 0 0">
        字段一律以 <span class="mono-inline">{{ T.nameAttr }}</span> 属性识别：自定义、数量不限，最终按 JSON 记录；
        没有 name 的输入框不会被采集，也不会有任何提示。
      </p>
    </LabPane>

    <!-- ④ 上报格式 -->
    <LabPane title="3 · 上报格式" hint="一次演练只依赖这一个端点">
      <p class="lab-hint">
        <span class="lab-strong">{{ 'POST /alab/v2/engage' }}</span>，请求体为 JSON：
      </p>
      <div class="lab-mono">{{ ENGAGE_BODY }}</div>
      <el-table :data="ENGAGE_FIELDS" size="small" style="margin-top: 12px">
        <el-table-column prop="key" label="键" width="110" />
        <el-table-column prop="type" label="类型" width="130" />
        <el-table-column prop="desc" label="说明" min-width="260" />
      </el-table>
      <ul class="doc-list" style="margin-top: 12px">
        <li>同名多值合并为数组：<span class="mono-inline">{{ 'name=a&name=b' }}</span> 归一为 <span class="mono-inline">{{ '"a","b"' }}</span>。</li>
        <li><span class="mono-inline">ev: "open"</span> 事件允许用 <span class="mono-inline">{{ 'navigator.sendBeacon' }}</span> 发出，页面跳转也不会丢事件。</li>
        <li><span class="mono-inline">ev: "submit"</span> 一定走 fetch，需要拿到响应里的响应动作再决定下一步。</li>
      </ul>
    </LabPane>

    <!-- ⑤ 令牌与会话 -->
    <LabPane title="4 · 令牌与会话" hint="令牌是把一次命中归到某个人、某个任务上的唯一线索">
      <div class="lab-kv token-kv">
        <span>URL 参数 <b>{{ '?tk=' }}</b></span>
        <span>会话缓存 <b>sessionStorage.alab.tk</b></span>
        <span>上报字段 <b>tk</b></span>
      </div>
      <ul class="doc-list">
        <li>专属链接里的 <span class="mono-inline">{{ '?tk=' }}</span> 由平台签发，页面内跳转、表单提交都会由运行时自动带上，无需自己拼参数。</li>
        <li>运行时首次解析到令牌后写入 <span class="mono-inline">{{ 'sessionStorage' }}</span> 的 <span class="mono-inline">{{ 'alab.tk' }}</span>，同一标签页内后续访问沿用同一目标身份；关闭标签页即失效。</li>
        <li>令牌不可枚举、不携带邮箱明文；归属关系只在平台侧的收件人表里解析。</li>
      </ul>
    </LabPane>

    <!-- ⑥ 提交后响应 -->
    <LabPane title="5 · 提交后响应" hint="现场必须有反馈，这是体验问题也是取证问题">
      <el-table :data="RESPONSES" size="small">
        <el-table-column prop="key" label="after" width="110" />
        <el-table-column prop="behavior" label="行为" min-width="300" />
        <el-table-column prop="detail" label="细节" min-width="220" />
      </el-table>
      <ul class="doc-list" style="margin-top: 12px">
        <li><span class="mono-inline">alert</span> 用原生 <span class="mono-inline">{{ 'dialog' }}</span> 元素呈现（<span class="mono-inline">{{ 'showModal()' }}</span>），不再是手搓遮罩层，键盘 Esc 与焦点返回都交给浏览器。</li>
        <li><span class="mono-inline">lesson</span> 跳转 <span class="mono-inline">{{ 'GET /alab/v2/lesson?tk=' }}</span>，展示关联的上钩教学页；<span class="lab-strong">未绑定教学页时回落为通用提示页</span>，不会出现空白。</li>
        <li><span class="lab-strong">上报失败也必须执行响应动作。</span>网络异常、端点不可达时运行时照样弹窗或跳转，保证现场不会出现「点了没反应」——这是最容易被目标识破的破绽。</li>
      </ul>
    </LabPane>

    <!-- ⑦ 信标面端点 -->
    <LabPane title="6 · 邮件回传端点（信标面）" hint="公开、无鉴权，只接受演练令牌，不返回任何平台数据">
      <el-table :data="BEACONS" size="small">
        <el-table-column prop="method" label="方法" width="80" />
        <el-table-column prop="path" label="路径" min-width="230" />
        <el-table-column prop="params" label="参数" min-width="180" />
        <el-table-column prop="purpose" label="用途" min-width="200" />
      </el-table>
      <div class="lab-mono" style="margin-top: 12px">{{ CALLBACK_SAMPLE }}</div>
      <p class="lab-hint is-mute" style="margin: 10px 0 0">
        附件回传是 <span class="mono-inline">{{ 'multipart/form-data' }}</span>，截图字段名固定为
        <span class="mono-inline">capture</span>，其余字段按 <span class="mono-inline">{{ 'name, value' }}</span> 原样记录；
        响应恒为 <span class="mono-inline">{{ CALLBACK_RESP }}</span>，只回执一个记录 ID，不回任何平台侧数据，
        载荷被判为重复时也一样——回传方拿不到「这条是不是新记录」这种信息。
      </p>
    </LabPane>

    <!-- ⑧ 智能诊断 -->
    <LabPane title="7 · 智能诊断" hint="保存前替你把一遍页面体检，只提示、不阻断">
      <p class="lab-hint"><span class="lab-strong">{{ 'POST /web-templates/diagnose' }}</span>，请求体 <span class="mono-inline">{{ '{ "html": "…" }' }}</span>，返回：</p>
      <div class="lab-mono">{{ DIAGNOSE_RESP }}</div>
      <el-table :data="CHECKS" size="small" style="margin-top: 12px">
        <el-table-column prop="key" label="check.key" width="120" />
        <el-table-column prop="check" label="检查内容" min-width="320" />
        <el-table-column prop="level" label="缺失后果" min-width="200" />
      </el-table>
      <p class="lab-hint is-mute" style="margin: 12px 0 0">
        诊断结果不影响保存动作：即便 <span class="mono-inline">score</span> 很低也能存下模板，
        由你自己决定要不要修。<span class="lab-strong">诊断只提示不阻断</span>，因为它判断的是「像不像」，不是「能不能投」。
      </p>
    </LabPane>

    <!-- ⑨ 授权与边界 -->
    <LabPane title="8 · 谁能访问钓鱼网站，以及平台的硬边界" hint="协议能做什么，由授权决定；不能做什么，由平台决定">
      <div class="edge">
        <p class="lab-hint">
          <span class="lab-strong">域名准入：</span>钓鱼网站按访问请求里的 Host 判定归属，只服务当前生效授权名单内的域名与 IP；
          名单外的访问一律返回不可用，授权过期或被吊销时监听直接停止。
          需要 IP 直连访问时必须在授权里显式写 <span class="mono-inline">#ip</span>。
        </p>
        <div class="edge-block">
          <span class="lab-strong">以下能力被刻意不做实现，因为它们只服务于真实攻击、与演练目标无关：</span>
          <ul class="doc-list">
            <li>反溯源 / 反检测（沙箱逃逸、杀软绕过、指纹伪装、验证码规避）</li>
            <li>凭据实时转发到第三方站点（会让被采集口令直接流入攻击者）</li>
            <li>免杀载荷生成、木马投递</li>
          </ul>
        </div>
        <el-alert type="warning" :closable="false" show-icon>
          <template #title>
            <span class="lab-strong">require_authorization 是硬性要求，不提供在线关闭入口。</span>
            没有处于生效窗口的授权时，建站、开启监听与邮件发送都会被拒绝。
          </template>
        </el-alert>
      </div>
    </LabPane>

    <!-- ⑩ 隐私与数据留存 -->
    <LabPane title="9 · 隐私与数据留存" hint="数据不出这台机器，除非你自己导出">
      <ul class="doc-list">
        <li>采集到的字段只写本机 SQLite（默认 <span class="mono-inline">{{ 'server/data/' }}</span> 目录），不经过任何第三方服务。</li>
        <li>导出报表为 CSV，<span class="lab-strong">由操作者自行保管与销毁</span>；导出动作在通知记录里记录，便于事后说明数据流向。</li>
        <li>API Key、SMTP 口令等配置项读取时一律掩码回显，不会出现在导出与推送内容里。</li>
        <li>演练结束后建议吊销授权：平台立即锁回，其下钓鱼网站停止监听，历史记录仍保留用于复盘。</li>
      </ul>
    </LabPane>
  </div>
</template>

<script setup>
import LabPane from '../../ui/LabPane.vue';

defineProps({ gate: { type: Object, default: null } });

/** 模板里不能直接写这些标签，统一从常量渲染 */
const T = {
  bodyEnd: '</body>',
  bootType: 'application/alab+json',
  onclick: 'onclick="login()"',
  nameAttr: 'name',
};

const BOOT_BLOCK = `<script type="application/alab+json" id="alab-boot">
  {"token":"…","site":"…","after":"alert|redirect|lesson","content":"…","endpoint":"/alab/v2"}
<\/script>

注入位置：body 结束标签之前，紧跟你的最后一个元素；
你的标签结构、属性与顺序都不会被改写。`;

const BOOT_FIELDS = [
  { key: 'token', meaning: '本次命中的演练令牌，运行时解析后写入 sessionStorage', example: 'c1f2…（签发）' },
  { key: 'site', meaning: '站点标识，用于把上报归到某个钓鱼网站', example: '站点 UUID' },
  { key: 'after', meaning: '提交后的响应动作，三选一', example: 'alert / redirect / lesson' },
  { key: 'content', meaning: 'alert 与 lesson 动作用的文案或教学页引用', example: '登录成功' },
  { key: 'endpoint', meaning: '采集面前缀，运行时在其后拼 /engage', example: '/alab/v2' },
];

const BINDING = [
  { case: '页面里有 <form>', rule: '所有 form 自动被接管：提交即采集，并拦截默认跳转', result: '无需写任何脚本' },
  { case: '页面里没有 form', rule: '在按钮上显式声明采集点', result: `<button data-al-collect>` },
  {
    case: 'form 里只有 type="button" 的动作按钮',
    rule: '页面既没有提交控件也没声明采集点时，运行时把表单里的按钮当提交兜底采集',
    result: '老模板点了也留痕；但别把证据押在兜底上，体检会扣分',
  },
  { case: '某个输入框不想被采集', rule: '加上忽略标记', result: 'data-al-ignore' },
  { case: '字段识别', rule: '以 name 属性为准，可自定义、数量不限', result: '全部字段以 JSON 记录' },
];

const BINDING_SAMPLE = `<!-- 自动接管：写普通表单即可 -->
<form>
  <input name="username">
  <input name="password" type="password">
  <button type="submit">登录</button>
</form>

<!-- 没有 form 的页面：显式声明采集点 -->
<button data-al-collect>确认</button>

<!-- 不参与采集的字段 -->
<input name="captcha" data-al-ignore>`;

const ENGAGE_BODY = `POST /alab/v2/engage
Content-Type: application/json

{
  "ev": "open" | "submit",
  "tk": "令牌",
  "dwell": 12,
  "href": "/sso/login",
  "search": "?redirect=%2Fhome",
  "referer": "https://corp.example.com/",
  "fields": { "username": "…", "password": "…" }
}`;

const ENGAGE_FIELDS = [
  { key: 'ev', type: '"open" | "submit"', desc: '打开还是提交，同一条记录上两次事件合并记录' },
  { key: 'tk', type: 'string', desc: '令牌，取自 boot 块或 URL 的 ?tk=' },
  { key: 'dwell', type: 'number（秒）', desc: '停留在页面上的时长' },
  { key: 'href', type: 'string', desc: '当前路径' },
  { key: 'search', type: 'string', desc: '查询串，原样保留' },
  { key: 'referer', type: 'string', desc: '来源，用于判断目标从哪里点进来' },
  { key: 'fields', type: 'object', desc: '按 name 归集的字段值，同名多值合并为数组' },
];

const RESPONSES = [
  { key: 'alert', behavior: '在当前页弹出提示，模拟「操作成功」', detail: '原生 <dialog>.showModal()，不再手搓遮罩' },
  { key: 'redirect', behavior: '提交后跳转到指定地址', detail: '由运行时执行，页面自己不用写跳转' },
  { key: 'lesson', behavior: '跳转上钩教学页', detail: 'GET /alab/v2/lesson?tk=；无绑定教学页时回落提示页' },
];

const BEACONS = [
  { method: 'GET', path: '/alab/health', params: '—', purpose: '部署自检，返回纯文本 ok' },
  { method: 'GET', path: '/alab/v2/pixel', params: 'tk, task', purpose: '1×1 打开像素，邮件打开计数' },
  { method: 'GET', path: '/alab/v2/trace', params: 'tk, to, url', purpose: '链接改写跳转，to 为收件人邮箱' },
  { method: 'POST', path: '/alab/v2/callback', params: 'tk, mail + 表单字段', purpose: '附件运行回传：只有 capture 一个文件字段，其余为受约束的文本字段' },
];

const CALLBACK_SAMPLE = `POST /alab/v2/callback?tk={令牌}&mail={上线邮箱}
Content-Type: multipart/form-data

  capture   -> 截图文件，字段名固定；只收 png / jpeg / pdf / zip，
               文件头与 filename 的扩展名必须自洽，单文件 ≤ 5MB，单次 ≤ 3 个文件
  其余字段   -> 文本字段，≤ 40 个，名字 ≤ 64 字符（字母/数字/._-），单值 ≤ 4096 字符；
               令牌绑定了站点时，只收这张模板自己声明过的输入名，越界的丢弃并留事件

闸门（超出即拒，不回业务数据）：
  400 令牌不属于本次演练 · 413 文件或字段数越界 · 410 授权窗口已关闭 · 429 同令牌 > 10 次/分钟，同 IP > 200 次/分钟`;

const CALLBACK_RESP = '{"code":0,"data":{"accepted":true,"id":"…","dropped_fields":0,"rejected_files":0}}';

const DIAGNOSE_RESP = `{
  "score": 0-100,
  "checks": [
    { "key": "binding", "label": "…", "ok": true, "detail": "…", "items": ["…"] },
    { "key": "trigger", "label": "…", "ok": true, "detail": "…", "items": ["…"] },
    { "key": "assets",  "label": "…", "ok": true, "detail": "…", "items": ["…"] },
    { "key": "scripts", "label": "…", "ok": true, "detail": "…", "items": ["…"] },
    { "key": "fields",  "label": "…", "ok": true, "detail": "…", "items": ["…"] }
  ],
  "issues": ["…"]
}`;

const CHECKS = [
  { key: 'binding', check: '是否存在可采集入口：form 或 data-al-collect 声明的采集点', level: '缺失则提交动作不会记录' },
  { key: 'trigger', check: '是否有能触发提交的控件：submit/image 按钮或 data-al-collect', level: '只剩动作按钮时靠运行时兜底，证据不稳' },
  { key: 'assets', check: '外链资源可达性与混合内容风险（http 资源、失效图）', level: '页面在目标环境里露出破绽' },
  { key: 'scripts', check: '自定义 script 是否会与注入运行时冲突、是否劫持提交', level: '响应动作被覆盖，现场没反馈' },
  { key: 'fields', check: '带 name 的字段数量与命名（password 之类是否遗漏）', level: '记录字段不全，报告说服力下降' },
];

const SURFACE = [
  { face: '管理面（你自己用的后台）', entry: '/{panel}/api/*', auth: '需登录', note: '素材、站点、任务、证据都在这里读写' },
  { face: '采集面（挂出去的钓鱼网站）', entry: '站点独立端口', auth: 'Host 授权名单 + 令牌', note: '承载仿冒页面与 /alab/v2/engage 上报' },
  { face: '信标面（埋在邮件里的像素与链接）', entry: '/alab/health、/alab/v2/*', auth: '公开无鉴权', note: '像素、链接改写、附件回传，只接受演练令牌' },
];
</script>

<style scoped>
.contract { padding-bottom: 8px; }
.doc-list { margin: 10px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.95; color: var(--lab-ink-2); }
.doc-list li { margin-bottom: 4px; }
.token-kv { margin-bottom: 6px; }
.edge { display: flex; flex-direction: column; gap: 14px; }
.edge-block { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--lab-ink-2); }
</style>
