<!-- 一键仿站：产出纯 HTML 假登录页素材。提示词含站点名与字段名，发往配置的厂商，配任何一家等于开了这条出站通道。 -->
<!-- 授权与目标名单校验全在服务端，无生效授权 403；data-al-collect 一类标记是采集协议 v2 的约定。 -->
<template>
  <div class="lab-stack">
    <div class="lab-hint">
      由模型按目标网站产出一份纯 HTML 假登录页：只写 HTML + 内联 CSS、字段靠 <span class="mono-inline">name</span> 识别、采集点交给平台运行时接管。
      产物只是素材，保存后进「假登录页」继续打磨，是否在钓鱼网站开启仍受演练授权约束。
    </div>

    <!-- 只提醒不禁用：生成与保存属离线备课，硬拦在服务端 -->
    <el-alert v-if="!gate" type="warning" :closable="false" show-icon
      title="未登记有效授权，假登录页无法开启"
      description="生成与保存素材不受影响；但要对外服务，必须先在「演练授权」登记授权主体、有效期与授权名单，且只有名单里写到的域名能打开页面。" />

    <!-- 没厂商就不摆表单，免得填完半天才被服务端拦下 -->
    <LabPane title="目标与模型参数" hint="调用你配置的模型服务生成，兼容 OpenAI Chat Completions 协议">
      <template #ops>
        <!-- 只重读厂商列表，不动已生成的 html -->
        <el-button size="small" @click="loadProviders">
          <el-icon><Refresh /></el-icon>
          <span>重载模型</span>
        </el-button>
        <el-button type="primary" :loading="generating" :disabled="!providers.length" @click="generate">
          <el-icon><MagicStick /></el-icon>
          <span>开始生成</span>
        </el-button>
      </template>

      <el-alert v-if="!providers.length && !loadingProviders" type="warning" :closable="false" show-icon
        title="尚未配置模型服务"
        description="请先到「系统设置 · 模型服务」添加厂商的 base_url、API Key 与模型名，再回到这里生成。未配置时本面板不会产出任何半成品。" />

      <el-form v-else label-position="top">
        <div class="lab-grid" style="--cols: 2">
          <el-form-item label="使用大模型" required>
            <el-select v-model="form.provider_id" placeholder="请选择模型" style="width: 100%">
              <el-option v-for="p in providers" :key="p.id" :label="`${p.name}/${p.model}`" :value="p.id" />
            </el-select>
            <div class="lab-hint is-mute">{{ providers.length }} 个可用模型服务</div>
          </el-form-item>
          <!-- 原样发给模型，也是服务端核名单的输入：解析出的主机名须落在授权名单内 -->
          <el-form-item label="网站名称 / 目标地址" required>
            <el-input v-model="form.site_name" placeholder="如：内部门户 login.example.com" />
            <div class="lab-hint is-mute">生成前服务端会先核授权名单：没有生效中的授权、或目标不在名单里，一律拒绝调用模型；提示词里也不要出现员工邮箱。</div>
          </el-form-item>
        </div>

        <!-- 参数名即产物输入框的 name，也就是上报 JSON 的键 -->
        <el-form-item label="需要采集的字段" required>
          <div style="width: 100%">
            <div v-for="(_, i) in form.fields" :key="i" class="field-row">
              <el-input v-model="form.fields[i]" placeholder="参数名，如：账号 / 口令 / 工号" />
              <el-button plain type="danger" @click="form.fields.splice(i, 1)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
            <!-- 空行不拦：defaultPrompt() 与服务端各滤一次 -->
            <el-button plain type="primary" @click="form.fields.push('')">
              <el-icon><Plus /></el-icon>
              <span>添加一行</span>
            </el-button>
            <div class="lab-hint is-mute">每个参数名会成为输入框的 <span class="mono-inline">name</span>，运行时按 <span class="mono-inline">{name: value}</span> 上报到 <span class="mono-inline">/alab/v2/engage</span>。</div>
          </div>
        </el-form-item>

        <!-- 温度锁在 0~1：再高模型会自己编结构 -->
        <el-form-item label="采样温度">
          <el-input-number v-model="form.temperature" :min="0" :max="1" :step="0.1" :precision="1" />
          <div class="lab-hint is-mute">越低越贴近既有版式，越高越容易给出新排版。</div>
        </el-form-item>

        <el-form-item label="生成提示词" required>
          <el-input v-model="form.prompt" type="textarea" :rows="9" spellcheck="false" class="src-input" />
          <div style="margin-top: 8px">
            <el-button size="small" @click="rebuildPrompt">按上方信息重写提示词</el-button>
          </div>
        </el-form-item>
      </el-form>

      <!-- 服务端门禁原文就地显示，不改写 -->
      <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" class="err" />
    </LabPane>

    <LabPane flush :title="`生成结果${html ? ` · ${liveFields.length} 个可采集字段` : ''}`"
      hint="预览按假登录页协议渲染，源码可复制到「假登录页」继续编辑">
      <template #ops>
        <el-button v-if="html" size="small" @click="runDiagnose">重新诊断</el-button>
        <el-button v-if="html" size="small" :loading="previewing" @click="renderPreview">刷新预览</el-button>
      </template>

      <div v-if="!html" class="lab-empty">
        {{ generating ? '模型正在产出页面，请稍候…' : '还没有生成结果。填写目标与字段后点「开始生成」。' }}
      </div>
      <div v-else class="result-split">
        <!-- srcdoc 只挂 sanitizeHtml 净化后的文档，采集运行时一并被剥；sandbox 不给 allow-same-origin -->
        <iframe class="preview-frame" :srcdoc="previewDocSafe" title="生成结果预览"
          sandbox="allow-scripts allow-forms allow-modals allow-popups" />
        <div class="lab-stack result-side">
          <div>
            <div class="side-t">识别到的采集字段</div>
            <div class="lab-kv">
              <span v-for="n in liveFields" :key="n" class="lab-chip is-accent">{{ n }}</span>
              <span v-if="!liveFields.length" class="lab-chip is-danger">无 name 字段</span>
            </div>
          </div>
          <div>
            <div class="side-t">诊断</div>
            <div v-if="diagView" style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px">
              <span class="score">{{ diagView.score }}</span>
              <div class="lab-bar" style="flex: 1">
                <div class="lab-bar-fill" :class="barTone(diagView.score)" :style="{ width: `${diagView.score}%` }" />
              </div>
            </div>
            <div v-if="diagView" class="lab-list">
              <div v-for="c in diagView.checks" :key="c.key" class="lab-list-item">
                <span class="lab-strong">{{ c.label || CHECK_LABELS[c.key] || c.key }}</span>
                <span class="lab-chip" :class="c.ok ? 'is-ok' : 'is-danger'">{{ c.ok ? '通过' : '未通过' }}</span>
              </div>
            </div>
            <!-- issues 是服务端给的整改建议，只在管理面出现 -->
            <div v-if="diagView && diagView.issues.length">
              <div class="lab-hint" v-for="(s, i) in diagView.issues" :key="i">· {{ s }}</div>
            </div>
            <span v-if="!diagView" class="lab-hint is-mute">生成后自动跑一遍诊断；诊断不阻断保存。</span>
          </div>
          <div>
            <div class="side-t">HTML 源码（只读）</div>
            <!-- 源码只读；改 HTML 一律去假登录页标签，两处都能编辑会对不上账 -->
            <pre class="lab-mono src-box">{{ html }}</pre>
          </div>
        </div>
      </div>
      <div v-if="html" class="lab-hint" style="padding: 8px 14px 12px">
        预览已做净化处理，素材原文按原样保存。净化会剥掉脚本（连平台注入的采集运行时一起），<b>预览不等于访客实际看到的页面</b>：
        仿站页面在这里可能不会动、提交后也演不出弹窗与跳转，别拿这块预览判断上线效果。
      </div>
    </LabPane>

    <!-- 保存只是新建素材，挂到钓鱼网站上才生效、才走授权门禁 -->
    <LabPane title="存为假登录页" hint="保存后回到「假登录页」标签调整内容与采集字段">
      <!-- 没产物时整栏不出现，免得存出一条空白假登录页 -->
      <template v-if="html">
        <el-form label-position="top" inline>
          <!-- 名称 100 字上限与服务端列宽同口径；类型允许现敲新值 -->
          <el-form-item label="页面名称">
            <el-input v-model="saveName" style="width: 260px" maxlength="100" show-word-limit />
          </el-form-item>
          <el-form-item label="页面类型">
            <el-select v-model="saveType" filterable allow-create default-first-option style="width: 180px">
              <el-option v-for="t in types" :key="t" :label="t" :value="t" />
            </el-select>
          </el-form-item>
          <!-- 取值与库里 response_type 列一致；learn 由服务端 bootAfter 译成协议里的 lesson -->
          <el-form-item label="提交后响应">
            <el-select v-model="saveResponseType" style="width: 140px">
              <el-option label="弹窗提示" value="alert" />
              <el-option label="页面跳转" value="redirect" />
              <el-option label="上钩教学" value="learn" />
            </el-select>
          </el-form-item>
          <!-- 上钩教学只挑教学页，用不上的字段存 null -->
          <el-form-item :label="saveResponseType === 'learn' ? '关联教学页' : '响应内容'">
            <el-select v-if="saveResponseType === 'learn'" v-model="saveLearnPageId" placeholder="选择教学页" style="width: 240px">
              <el-option v-for="p in learnPages" :key="p.id" :label="p.name" :value="p.id" />
            </el-select>
            <el-input v-else v-model="saveResponseContent" style="width: 260px"
              :placeholder="saveResponseType === 'redirect' ? 'https://演练环境内正常地址' : '如：登录成功'" />
          </el-form-item>
        </el-form>
        <div class="lab-toolbar" style="margin-bottom: 0">
          <el-button type="primary" :loading="saving" @click="saveAsTemplate">
            <el-icon><Check /></el-icon>
            <span>存为假登录页</span>
          </el-button>
          <div class="lab-spacer" />
          <!-- 有些厂商不回 usage，缺字段显示短横线而不是 0 -->
          <span class="lab-hint is-mute">生成用量：prompt {{ usage.prompt_tokens ?? '-' }} / completion {{ usage.completion_tokens ?? '-' }} tokens</span>
        </div>
      </template>
      <div v-else class="lab-empty">上一步没有生成结果，无法存为假登录页。</div>

      <template #ft>
        <div class="lab-kv">
          <span class="lab-strong">最近生成的假登录页</span>
          <span v-for="r in recent" :key="r.id" class="lab-chip">{{ r.name }}</span>
          <span v-if="!recent.length" class="lab-hint is-mute">暂无记录。</span>
        </div>
      </template>
    </LabPane>

    <div class="lab-hint is-mute">
      边界：模型只按公开常识复现「一个长得像登录页的表单」，用于演练素材准备；平台不实现反溯源 / 反检测 / 免杀载荷，也不把采集到的口令转发到任何第三方网站。
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onActivated } from 'vue';
import { ElMessage } from 'element-plus';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
// sanitizeHtml 净化预览文档；LOGIN_PREVIEW_OPTIONS 只回捞登录表单控件
import { sanitizeHtml, LOGIN_PREVIEW_OPTIONS } from '../../utils/sanitize';

// 演练授权摘要由工作区外层透传，只决定顶部警示条亮不亮，本面板的接口都不读它：门禁全在服务端。
// 离线编写素材刻意允许，不要改成没授权就禁用生成按钮。
defineProps({ gate: { type: Object, default: null } });

// /web-templates/diagnose 回的是英文 key，这里补成中文标签；只列会用到的四项，trigger 项不展示。
// key 名属冻结协议，改名界面就显示原始英文。
const CHECK_LABELS = { binding: '采集绑定', assets: '外部资源', scripts: '自定义脚本', fields: '可采集字段' };
/** 诊断项展示顺序，未知 key 排末尾 */
const CHECK_KEYS = Object.keys(CHECK_LABELS);

/** 可用模型服务（GET /settings 的 ai.providers），为空说明没配厂商 */
const providers = ref([]);
/** 假登录页类型下拉（GET /web-templates/types，可自定义新值） */
const types = ref([]);
const learnPages = ref([]);
const recent = ref([]);
const loadingProviders = ref(false);
/** 模型出整页 HTML 可达一分钟，没反馈会被以为卡死 */
const generating = ref(false);
const saving = ref(false);
/** 模型产出的净 HTML，服务端已剥代码围栏；空串即还没生成 */
const html = ref('');
/** 体检原始报告，null 表示这版还没跑过诊断 */
const diag = ref(null);
const usage = ref({});
/** 失败文案就地显示，同时弹一次 ElMessage */
const error = ref('');

// fields 每一项就是产物输入框的 name，也就是上报 JSON 的键
// site_name 不只给模型看，服务端也拿它解析主机名去核授权名单
const form = reactive({ provider_id: '', site_name: '', fields: ['账号', '口令'], prompt: '', temperature: 0.4 });
/** 存为假登录页的字段：生成成功时自动填名称（{站点名}-AI生成），仍可改 */
const saveName = ref('');
const saveType = ref('AI生成');
const saveResponseType = ref('alert');
const saveResponseContent = ref('登录成功');
const saveLearnPageId = ref('');

// 拼默认提示词，只发往 /ai/generate，不落库也不渲染进访客页。
// 但约定的标记会原样出现在模型产物里，措辞算协议 v2 的延伸；onclick 是 v1 旧约定，已被声明式绑定替换。
function defaultPrompt() {
  // 滤掉空行，否则提示词里出现连续顿号，模型会多造一个空字段
  const fields = form.fields.filter(Boolean);
  return `请生成一个「${form.site_name || '登录页'}」的假登录页（HTML）。
要求：
1. 只输出完整 HTML 与内联 CSS：不要引用外部 js/css/图片，不要自己写 <script>。
2. 用一个 <form> 收集以下字段，每个输入框都要带 name 属性：${fields.join('、') || '账号、口令'}。
3. 提交按钮写成 type="submit"；若页面里没有 form，请用 <button data-al-collect> 显式声明采集点，不需要采集的输入框加 data-al-ignore。
4. 不要写 onclick，也不要自己发请求：平台会在 </body> 前注入 boot 配置与运行时，表单提交会被自动接管并上报到 /alab/v2/engage。
5. 版式贴近常见登录/核验页，13px 字号、1px 描边、小圆角，风格简洁；仅返回 HTML 代码，不要任何解释文字。`;
}
/** 重算默认话术并覆盖 textarea；会丢掉手写措辞，所以做成显式按钮、不在 watch 里自动触发 */
function rebuildPrompt() {
  form.prompt = defaultPrompt();
}

// 读 GET /settings 的 ai.providers（拦截器已把 {code,data} 摊平）；失败只写 error 不弹窗，provider_id 不清空
async function loadProviders() {
  loadingProviders.value = true;
  try {
    const cfg = await http.get('/settings');
    providers.value = cfg.ai?.providers || [];
    // 没选过模型时默认勾第一家，与系统设置同一口径
    if (!form.provider_id && providers.value.length) form.provider_id = providers.value[0].id;
  } catch (err) {
    error.value = err.message;
  } finally {
    loadingProviders.value = false;
  }
}
/** 读类型与教学页两个下拉的数据源；失败不捕获，交给 axios 拦截器 */
async function loadMeta() {
  types.value = await http.get('/web-templates/types');
  learnPages.value = await http.get('/learn-pages');
}
/** 读最近 6 条假登录页，只用于底部提示存到哪去了 */
async function loadRecent() {
  const data = await http.get('/web-templates', { params: { page_size: 6 } });
  recent.value = data.rows;
}

// 从 HTML 源码数出运行时能采到的字段名，与 PagePane 同名函数一份逻辑（刻意复制，两处判定要一起改）
// 正则粗扫标签，与真实 DOM 采集不等价：嵌套写法、动态生成的输入框数不到
function fieldNames(src) {
  if (!src) return [];
  const out = [];
  for (const m of String(src).matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const tag = m[0];
    // data-al-ignore 是协议 v2 的排除标记，明写不采的框一律跳过
    if (/data-al-ignore/i.test(tag)) continue;
    const type = (tag.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase() || '';
    // 动作/装饰控件没有值可采，漏掉会让字段数与诊断分虚高
    if (['submit', 'button', 'reset', 'image'].includes(type)) continue;
    const name = (tag.match(/\bname\s*=\s*["']([^"']+)["']/i) || [])[1];
    // 上报键就是 name，没 name 的框报不上来；同名字段运行时合并成数组，这里去重
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
const liveFields = computed(() => fieldNames(html.value));

/** 把体检原始报告整理成视图模型；没有 checks 数组时回 null，缺字段一律兜底 */
const diagView = computed(() => {
  const d = diag.value;
  if (!d || !Array.isArray(d.checks)) return null;
  const checks = d.checks.map((c) => ({
    key: c.key, label: c.label || CHECK_LABELS[c.key] || c.key, ok: !!c.ok,
    detail: c.detail || '', items: Array.isArray(c.items) ? c.items : [],
  }));
  checks.sort((a, b) => {
    const ia = CHECK_KEYS.indexOf(a.key);
    const ib = CHECK_KEYS.indexOf(b.key);
    // 未知 key 用 99 兜底排最后，服务端加检查项时界面只多一行
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return { score: Number(d.score ?? 0), checks, issues: Array.isArray(d.issues) ? d.issues : [] };
});
/** 进度条配色阈值 80 / 50，与 PagePane、服务端同一口径 */
function barTone(v) {
  return v >= 80 ? '' : v >= 50 ? 'is-warn' : 'is-danger';
}

// 手动重新诊断，覆盖 diag。不 try/catch：体检恒 200，真出错让拦截器抛出去
async function runDiagnose() {
  if (!html.value) return;
  diag.value = await http.post('/web-templates/diagnose', { html: html.value });
}

// 预览走服务端渲染：注入 boot 配置与运行时归 pageCompiler 管，前端不自己拼
// 管理面上没有采集面处理器，预览提交只会 404；token 带 preview- 前缀，不会算成上钩证据
const previewDoc = ref('');
// 真正挂进 srcdoc 的文档：整份先过 sanitizeHtml，script、iframe、on* 属性、javascript: 全禁，采集运行时一并被剥
// 前面补 doctype：DOMPurify 整文档返回值不带它，缺了 iframe 落进 quirks 模式
const previewDocSafe = computed(() => `<!DOCTYPE html>\n${sanitizeHtml(previewDoc.value, LOGIN_PREVIEW_OPTIONS)}`);
const previewing = ref(false);
// 把当前 html 连同响应方式交给服务端重渲染，覆盖 previewDoc
// 失败只弹 ElMessage 不写进 error：预览失败不影响已生成的 html
async function renderPreview() {
  if (!html.value) {
    // 清掉上一版预览，免得还看着旧页面
    previewDoc.value = '';
    return;
  }
  previewing.value = true;
  try {
    previewDoc.value = await http.post('/web-templates/preview', {
      html: html.value,
      response_type: saveResponseType.value,
      response_content: saveResponseType.value === 'learn' ? '' : saveResponseContent.value,
    });
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    previewing.value = false;
  }
}

// 只 watch 响应两项：html 变时 generate() 已经手动调过 renderPreview，加进 watch 会发两次请求
watch([saveResponseType, saveResponseContent], renderPreview);

// 开始生成：POST /ai/generate，成功后一次落定 html / usage / diag
// 前端这两项校验只为省一次外呼；真正的门禁在服务端：无生效授权 403，提示词含员工邮箱或目标主机不在授权名单内 400
// 厂商缺 base_url/api_key、公网 base_url 不是 https 同样 400，都以 err.message 回到 error
// 失败清空 html 与 diag，后两步一起退回空态；诊断分低于 60 只警告不阻断
async function generate() {
  if (!form.provider_id) return ElMessage.warning('请选择模型服务');
  if (!form.site_name) return ElMessage.warning('请填写网站名称 / 目标地址');
  generating.value = true;
  error.value = '';
  try {
    const data = await http.post('/ai/generate', {
      provider_id: form.provider_id,
      site_name: form.site_name,
      fields: form.fields,
      // 空提示词兜底一份默认话术，服务端有同样的兜底
      prompt: form.prompt || defaultPrompt(),
      temperature: form.temperature,
    });
    html.value = data.html || '';
    usage.value = data.usage || {};
    diag.value = data.diagnose || null;
    if (!html.value) {
      // 回 200 但正文被剥空：算没产出，不进 catch
      error.value = '模型没有返回可用内容，请调整提示词后重试。';
      return;
    }
    saveName.value = `${form.site_name}-AI生成`;
    saveType.value = 'AI生成';
    renderPreview();
    if (diagView.value && diagView.value.score < 60) {
      ElMessage.warning(`生成完成，但诊断分仅 ${diagView.value.score}，建议在「假登录页」内修正后再上线`);
    } else {
      ElMessage.success('生成完成，可预览或直接存为假登录页');
    }
  } catch (err) {
    html.value = '';
    diag.value = null;
    error.value = err.message;
    ElMessage.error(err.message);
  } finally {
    generating.value = false;
  }
}

// 存为假登录页：POST /web-templates 新建素材，不等于投放；服务端保存时同步体检，结论写进 diagnose_json
// name/type/html 缺任一项服务端回 400；"选了上钩教学却没给教学页 id"只有前端能提前发现
async function saveAsTemplate() {
  if (!html.value) return ElMessage.warning('先生成页面内容');
  if (!saveName.value || !saveType.value) return ElMessage.warning('页面名称与类型必填');
  if (saveResponseType.value === 'learn' && !saveLearnPageId.value) return ElMessage.warning('请选择关联的上钩教学页');
  saving.value = true;
  try {
    await http.post('/web-templates', {
      name: saveName.value,
      type: saveType.value,
      html: html.value,
      response_type: saveResponseType.value,
      response_content: saveResponseType.value === 'learn' ? null : saveResponseContent.value,
      learn_page_id: saveResponseType.value === 'learn' ? saveLearnPageId.value : null,
    });
    ElMessage.success(`已存为假登录页「${saveName.value}」，可在「假登录页」标签继续打磨`);
    // 刷新列表，新页面与新类型要立刻出现
    loadRecent();
    loadMeta();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

// KeepAlive 下 activated 会紧跟 mounted 触发一次，首次要跳过，免得首屏重复请求
let activates = 0;
onMounted(() => {
  // 三个只读接口并行发出，都不 await，首屏不被最慢的一个拖住
  loadProviders();
  loadMeta();
  loadRecent();
});
onActivated(() => {
  activates += 1;
  if (activates <= 1) return;
  // 切走再切回只重读列表，不清 html/diag，产物得留着
  loadProviders();
  loadMeta();
  loadRecent();
});
</script>

<style scoped>
/* 颜色与圆角走 --lab-* 令牌，别写死色值，换肤会漏 */
.field-row { display: flex; gap: 8px; margin-bottom: 8px; }
.err { margin-top: 12px; }
/* iframe 太矮会套出双层滚动条，看着像页面坏了 */
.preview-frame { display: block; width: 100%; min-height: 520px; border: 0; border-right: 1px solid var(--lab-line-2); background: #fff; }
.result-side { padding: 14px; }
.side-t { font-size: 12px; color: var(--lab-ink-3); font-weight: 700; margin-bottom: 6px; }
/* tabular-nums 让分数位宽一致，诊断重跑时数字不左右跳 */
.score { font-size: 20px; font-weight: 700; color: var(--lab-ink); font-variant-numeric: tabular-nums; }
/* 模型产出的整页 HTML 很长，限高后靠 pre 自带滚动 */
.src-box { max-height: 260px; margin: 0; }
/* 提示词框用等宽字体，要能看清标签闭合与缩进 */
.src-input :deep(.el-textarea__inner) { font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; line-height: 1.65; }
/* minmax(0, 1fr) 让左栏能压窄，否则 iframe 的内容宽度会把网格撑破 */
.result-split { display: grid; grid-template-columns: minmax(0, 1fr) 420px; align-items: stretch; }
/* 1180px 以下收成单列：右栏挤不进去时宁可换行，不把预览压成一条缝 */
@media (max-width: 1180px) {
  .result-split { grid-template-columns: 1fr; }
  .preview-frame { border-right: 0; border-bottom: 1px solid var(--lab-line-2); }
}
</style>
