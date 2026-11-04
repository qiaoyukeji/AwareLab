<template>
  <div class="lab-stack">
    <div class="lab-hint">
      由模型按目标网站产出一份纯 HTML 假登录页：只写 HTML + 内联 CSS、字段靠 <span class="mono-inline">name</span> 识别、采集点交给平台运行时接管。
      产物只是素材，保存后进「假登录页」继续打磨，是否在钓鱼网站开启仍受演练授权约束。
    </div>

    <el-alert v-if="!gate" type="warning" :closable="false" show-icon
      title="未登记有效授权，假登录页无法开启"
      description="生成与保存素材不受影响；但要对外服务，必须先在「演练授权」登记授权主体、有效期与授权名单，且只有名单里写到的域名能打开页面。" />

    <!-- ① 目标与模型参数 -->
    <LabPane title="① 目标与模型参数" hint="提交给 /ai/generate，兼容 OpenAI Chat Completions 协议的模型服务">
      <template #ops>
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
          <el-form-item label="网站名称 / 目标地址" required>
            <el-input v-model="form.site_name" placeholder="如：内部门户 login.example.com" />
            <div class="lab-hint is-mute">生成前服务端会先核授权名单：没有生效中的授权、或目标不在名单里，一律拒绝调用模型；提示词里也不要出现员工邮箱。</div>
          </el-form-item>
        </div>

        <el-form-item label="需要采集的字段" required>
          <div style="width: 100%">
            <div v-for="(_, i) in form.fields" :key="i" class="field-row">
              <el-input v-model="form.fields[i]" placeholder="参数名，如：账号 / 口令 / 工号" />
              <el-button plain type="danger" @click="form.fields.splice(i, 1)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
            <el-button plain type="primary" @click="form.fields.push('')">
              <el-icon><Plus /></el-icon>
              <span>添加一行</span>
            </el-button>
            <div class="lab-hint is-mute">每个参数名会成为输入框的 <span class="mono-inline">name</span>，运行时按 <span class="mono-inline">{name: value}</span> 上报到 <span class="mono-inline">/alab/v2/engage</span>。</div>
          </div>
        </el-form-item>

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

      <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" class="err" />
    </LabPane>

    <!-- ② 生成结果 -->
    <LabPane flush :title="`② 生成结果${html ? ` · ${liveFields.length} 个可采集字段` : ''}`"
      hint="预览按假登录页协议渲染，源码可复制到「假登录页」继续编辑">
      <template #ops>
        <el-button v-if="html" size="small" @click="runDiagnose">重新诊断</el-button>
        <el-button v-if="html" size="small" :loading="previewing" @click="renderPreview">刷新预览</el-button>
      </template>

      <div v-if="!html" class="lab-empty">
        {{ generating ? '模型正在产出页面，请稍候…' : '还没有生成结果。填写目标与字段后点「开始生成」。' }}
      </div>
      <div v-else class="result-split">
        <iframe class="preview-frame" :srcdoc="previewDoc" title="生成结果预览"
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
            <div v-if="diagView && diagView.issues.length">
              <div class="lab-hint" v-for="(s, i) in diagView.issues" :key="i">· {{ s }}</div>
            </div>
            <span v-if="!diagView" class="lab-hint is-mute">生成后自动跑一遍诊断；诊断不阻断保存。</span>
          </div>
          <div>
            <div class="side-t">HTML 源码（只读）</div>
            <pre class="lab-mono src-box">{{ html }}</pre>
          </div>
        </div>
      </div>
    </LabPane>

    <!-- ③ 存为假登录页 -->
    <LabPane title="③ 存为假登录页" hint="走 /web-templates 新建接口，保存后回到「假登录页」标签调整">
      <template v-if="html">
        <el-form label-position="top" inline>
          <el-form-item label="页面名称">
            <el-input v-model="saveName" style="width: 260px" maxlength="100" show-word-limit />
          </el-form-item>
          <el-form-item label="页面类型">
            <el-select v-model="saveType" filterable allow-create default-first-option style="width: 180px">
              <el-option v-for="t in types" :key="t" :label="t" :value="t" />
            </el-select>
          </el-form-item>
          <el-form-item label="提交后响应">
            <el-select v-model="saveResponseType" style="width: 140px">
              <el-option label="弹窗提示" value="alert" />
              <el-option label="页面跳转" value="redirect" />
              <el-option label="上钩教学" value="learn" />
            </el-select>
          </el-form-item>
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

defineProps({ gate: { type: Object, default: null } });

const CHECK_LABELS = { binding: '采集绑定', assets: '外部资源', scripts: '自定义脚本', fields: '可采集字段' };
const CHECK_KEYS = Object.keys(CHECK_LABELS);

const providers = ref([]);
const types = ref([]);
const learnPages = ref([]);
const recent = ref([]);
const loadingProviders = ref(false);
const generating = ref(false);
const saving = ref(false);
const html = ref('');
const diag = ref(null);
const usage = ref({});
const error = ref('');

const form = reactive({ provider_id: '', site_name: '', fields: ['账号', '口令'], prompt: '', temperature: 0.4 });
const saveName = ref('');
const saveType = ref('AI生成');
const saveResponseType = ref('alert');
const saveResponseContent = ref('登录成功');
const saveLearnPageId = ref('');

function defaultPrompt() {
  const fields = form.fields.filter(Boolean);
  return `请生成一个「${form.site_name || '登录页'}」的假登录页（HTML）。
要求：
1. 只输出完整 HTML 与内联 CSS：不要引用外部 js/css/图片，不要自己写 <script>。
2. 用一个 <form> 收集以下字段，每个输入框都要带 name 属性：${fields.join('、') || '账号、口令'}。
3. 提交按钮写成 type="submit"；若页面里没有 form，请用 <button data-al-collect> 显式声明采集点，不需要采集的输入框加 data-al-ignore。
4. 不要写 onclick，也不要自己发请求：平台会在 </body> 前注入 boot 配置与运行时，表单提交会被自动接管并上报到 /alab/v2/engage。
5. 版式贴近常见登录/核验页，13px 字号、1px 描边、小圆角，风格简洁；仅返回 HTML 代码，不要任何解释文字。`;
}
function rebuildPrompt() {
  form.prompt = defaultPrompt();
}

async function loadProviders() {
  loadingProviders.value = true;
  try {
    const cfg = await http.get('/settings');
    providers.value = cfg.ai?.providers || [];
    if (!form.provider_id && providers.value.length) form.provider_id = providers.value[0].id;
  } catch (err) {
    error.value = err.message;
  } finally {
    loadingProviders.value = false;
  }
}
async function loadMeta() {
  types.value = await http.get('/web-templates/types');
  learnPages.value = await http.get('/learn-pages');
}
async function loadRecent() {
  const data = await http.get('/web-templates', { params: { page_size: 6 } });
  recent.value = data.rows;
}

/* ── 字段与诊断，与假登录页面板同一套规则 ─────────────────── */
function fieldNames(src) {
  if (!src) return [];
  const out = [];
  for (const m of String(src).matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const tag = m[0];
    if (/data-al-ignore/i.test(tag)) continue;
    const type = (tag.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase() || '';
    if (['submit', 'button', 'reset', 'image'].includes(type)) continue;
    const name = (tag.match(/\bname\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
const liveFields = computed(() => fieldNames(html.value));

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
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return { score: Number(d.score ?? 0), checks, issues: Array.isArray(d.issues) ? d.issues : [] };
});
function barTone(v) {
  return v >= 80 ? '' : v >= 50 ? 'is-warn' : 'is-danger';
}

async function runDiagnose() {
  if (!html.value) return;
  diag.value = await http.post('/web-templates/diagnose', { html: html.value });
}

/* 预览走服务端渲染：与真实假登录页共用同一套运行时，只是把上报打到一个不存在的端点 */
const previewDoc = ref('');
const previewing = ref(false);
async function renderPreview() {
  if (!html.value) {
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

// 响应方式改了，预览里提交后的行为也得跟着变，否则「存为假登录页」前看到的效果是旧的
watch([saveResponseType, saveResponseContent], renderPreview);

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
      prompt: form.prompt || defaultPrompt(),
      temperature: form.temperature,
    });
    html.value = data.html || '';
    usage.value = data.usage || {};
    diag.value = data.diagnose || null;
    if (!html.value) {
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
    loadRecent();
    loadMeta();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

/* KeepAlive 下 activated 会紧跟 mounted 触发一次，跳过它避免首屏重复请求 */
let activates = 0;
onMounted(() => {
  loadProviders();
  loadMeta();
  loadRecent();
});
onActivated(() => {
  activates += 1;
  if (activates <= 1) return;
  loadProviders();
  loadMeta();
  loadRecent();
});
</script>

<style scoped>
.field-row { display: flex; gap: 8px; margin-bottom: 8px; }
.err { margin-top: 12px; }
.preview-frame { display: block; width: 100%; min-height: 520px; border: 0; border-right: 1px solid var(--lab-line-2); background: #fff; }
.result-side { padding: 14px; }
.side-t { font-size: 12px; color: var(--lab-ink-3); font-weight: 700; margin-bottom: 6px; }
.score { font-size: 20px; font-weight: 700; color: var(--lab-ink); font-variant-numeric: tabular-nums; }
.src-box { max-height: 260px; margin: 0; }
.src-input :deep(.el-textarea__inner) { font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; line-height: 1.65; }
.result-split { display: grid; grid-template-columns: minmax(0, 1fr) 420px; align-items: stretch; }
@media (max-width: 1180px) {
  .result-split { grid-template-columns: 1fr; }
  .preview-frame { border-right: 0; border-bottom: 1px solid var(--lab-line-2); }
}
</style>
