<template>
  <div class="lab-stack">
    <!-- 演练授权前置：素材可以写，钓鱼网站开启必须授权生效 -->
    <el-alert v-if="!gate" type="warning" :closable="false" show-icon
      title="未登记有效授权，假登录页无法开启"
      description="假登录页本身可以先编写、保存、诊断；但要挂到钓鱼网站监听端口对外服务，必须先在「演练授权」登记授权主体、有效期与授权名单。" />
    <el-alert v-else type="info" :closable="false" show-icon
      :title="`授权生效中 · ${gate.scope} · 授权名单 ${gate.allowed_hosts?.length || 0} 条`"
      description="假登录页只对授权名单里的域名提供服务，名单外的访问直接拒绝；授权过期或被吊销时监听自动停止。" />

    <div class="lab-grid" style="--cols: 3">
      <LabMetric label="假登录页" :value="total" unit="个" :extra="`本页 ${rows.length} 条 · 类型 ${types.length} 种`" />
      <LabMetric label="可采集字段" :value="fieldTotal" unit="个" tone="accent" extra="按 name 属性识别，同名多值合并为数组上报" />
      <LabMetric label="诊断均分" :value="avgScore" :tone="avgTone" extra="采集绑定 / 外部资源 / 自定义脚本 / 可采集字段" />
    </div>

    <LabPane flush title="假登录页清单" hint="模板只写纯 HTML + 内联 CSS，boot 配置与运行时由平台注入">
      <template #ops>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          <span>新建假登录页</span>
        </el-button>
        <el-button @click="load">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
      </template>

      <div style="padding: 14px 14px 0">
        <div class="lab-toolbar">
          <span class="lab-hint">类型</span>
          <el-select v-model="query.type" clearable placeholder="全部类型" style="width: 160px" @change="reload">
            <el-option v-for="t in types" :key="t" :label="t" :value="t" />
          </el-select>
          <el-input v-model="query.keyword" placeholder="按名称或描述搜索" style="width: 220px" @keyup.enter="reload" />
          <el-button @click="reload">
            <el-icon><Search /></el-icon>
            <span>搜索</span>
          </el-button>
          <div class="lab-spacer" />
          <span class="lab-hint is-mute">上报端点 <span class="mono-inline">/alab/v2/engage</span> · 令牌参数 <span class="mono-inline">?tk=</span></span>
        </div>
      </div>

      <el-table :data="rows" size="small">
        <el-table-column label="名称" min-width="220">
          <template #default="{ row }">
            <div class="lab-strong">{{ row.name }}</div>
            <div v-if="row.description" class="lab-hint is-mute clamp1">{{ row.description }}</div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="110">
          <template #default="{ row }"><span class="lab-chip">{{ row.type }}</span></template>
        </el-table-column>
        <el-table-column label="可采集字段" width="180">
          <template #default="{ row }">
            <div class="lab-kv">
              <span><b>{{ fieldNames(row.html).length }}</b> 个</span>
              <span v-for="n in fieldNames(row.html).slice(0, 3)" :key="n" class="lab-chip is-accent">{{ n }}</span>
              <span v-if="fieldNames(row.html).length > 3" class="lab-hint is-mute">+{{ fieldNames(row.html).length - 3 }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="提交后响应" width="120">
          <template #default="{ row }">{{ RESPONSE_LABEL[row.response_type] || row.response_type }}</template>
        </el-table-column>
        <el-table-column label="诊断分" width="150">
          <template #default="{ row }">
            <div v-if="scoreOf(row) !== null" style="display: flex; align-items: center; gap: 8px">
              <span style="width: 30px; font-weight: 700; font-variant-numeric: tabular-nums">{{ scoreOf(row) }}</span>
              <div class="lab-bar" style="flex: 1">
                <div class="lab-bar-fill" :class="barTone(scoreOf(row))" :style="{ width: `${scoreOf(row)}%` }" />
              </div>
            </div>
            <span v-else class="lab-chip">未跑分</span>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="130">
          <template #default="{ row }"><span class="lab-hint">{{ fmtTime(row.updated_at) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="primary" @click="openRowPreview(row)">预览</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="lab-empty">还没有假登录页。新建一份纯 HTML 模板即可，运行时注入与字段识别由平台完成。</div>
        </template>
      </el-table>

      <el-pagination class="pager" layout="total, sizes, prev, pager, next" :total="total"
        :page-size="query.page_size" :current-page="query.page" :page-sizes="[10, 20, 50]"
        @current-change="(p) => { query.page = p; load(); }"
        @size-change="(s) => { query.page_size = s; query.page = 1; load(); }" />
    </LabPane>

    <div class="lab-hint is-mute">
      边界约束：本面板只产出演练素材，不做反检测 / 免杀 / 载荷生成，也不把采集到的凭据转发到任何第三方网站；
      上报只走同源 <span class="mono-inline">/alab/v2/engage</span>，数据仅落平台本地库。
    </div>
  </div>

  <!-- 编辑抽屉：左栏写页面，右栏看预览与诊断 -->
  <el-drawer v-model="drawer" class="page-drawer" :title="form.id ? `编辑假登录页 · ${form.name}` : '新建假登录页'"
    size="94%" :close-on-click-modal="false">
    <div class="lab-split" style="--split: 520px">
      <!-- 左栏 -->
      <div class="lab-stack">
        <LabPane title="页面信息">
          <el-form label-position="top">
            <el-form-item label="页面类型" required>
              <el-select v-model="form.type" filterable allow-create default-first-option placeholder="可自定义或选择已有类型" style="width: 100%">
                <el-option v-for="t in types" :key="t" :label="t" :value="t" />
              </el-select>
            </el-form-item>
            <el-form-item label="页面名称" required>
              <el-input v-model="form.name" maxlength="100" show-word-limit placeholder="给这份假登录页起个名字" />
            </el-form-item>
            <el-form-item label="用途描述">
              <el-input v-model="form.description" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="[选填] 这份页面用于哪类演练场景" />
            </el-form-item>
            <el-form-item label="HTML 源码" required>
              <el-input v-model="form.html" class="src-input" type="textarea" :rows="18" spellcheck="false"
                placeholder="粘贴纯 HTML + 内联 CSS" />
              <div class="lab-hint">只写 HTML 与内联 CSS：不要引外部 js/css，不要自己写 <span class="mono-inline">&lt;script&gt;</span>。</div>
              <div style="margin-top: 8px; display: flex; gap: 8px">
                <el-button size="small" @click="insertSkeleton">插入骨架</el-button>
                <el-button size="small" @click="runDiagnose">立即诊断</el-button>
              </div>
            </el-form-item>
          </el-form>
        </LabPane>

        <LabPane title="提交后响应" hint="在平台侧配置，不写进模板 HTML">
          <el-form label-position="top">
            <el-form-item label="响应类型">
              <el-radio-group v-model="form.response_type">
                <el-radio value="alert">弹窗提示</el-radio>
                <el-radio value="redirect">页面跳转</el-radio>
                <el-radio value="learn">上钩教学</el-radio>
              </el-radio-group>
              <div class="lab-hint">参与人提交表单、数据经 <span class="mono-inline">/alab/v2/engage</span> 上报后，页面呈现的效果。</div>
            </el-form-item>
            <el-form-item v-if="form.response_type === 'alert'" label="提示文案">
              <el-input v-model="form.response_content" type="textarea" :rows="3" placeholder="如：登录成功" />
            </el-form-item>
            <el-form-item v-if="form.response_type === 'redirect'" label="跳转地址">
              <el-input v-model="form.response_content" placeholder="https://www.example.com/ok" />
              <div class="lab-hint">建议使用演练环境内可解释的正常地址，避免真实第三方网站。</div>
            </el-form-item>
            <el-form-item v-if="form.response_type === 'learn'" label="关联教学页">
              <el-select v-model="form.learn_page_id" placeholder="中招后引导学习的教学页" style="width: 100%">
                <el-option v-for="p in learnPages" :key="p.id" :label="p.name" :value="p.id" />
              </el-select>
              <div class="lab-hint">运行时跳转 <span class="mono-inline">/alab/v2/lesson?tk=</span>，按当前令牌定位教学页。</div>
            </el-form-item>
          </el-form>
        </LabPane>

        <div class="lab-hint">想用模型产出整页？切到「一键仿站」标签，生成后一键存为假登录页再回来微调。</div>
      </div>

      <!-- 右栏 -->
      <div class="lab-stack">
        <LabPane flush title="实时预览" hint="服务端渲染后的成品，含注入的 boot 配置与运行时">
          <template #ops>
            <el-button size="small" type="primary" plain :loading="previewing" @click="renderLivePreview">重载预览</el-button>
          </template>
          <iframe class="preview-frame" :srcdoc="previewDoc" title="假登录页预览"
            sandbox="allow-scripts allow-forms allow-modals allow-popups" />
          <div class="lab-hint" style="padding: 8px 14px 12px">
            预览沙箱不授予同源权限，令牌是平台签发的 <span class="mono-inline">preview-</span> 前缀，点击提交只触发响应动作，不会落成演练记录。
          </div>
        </LabPane>

        <LabPane title="页面协议速览">
          <div class="lab-list">
            <div class="lab-list-item"><span class="lab-chip is-accent">注入</span>
              <span>平台在 <span class="mono-inline">&lt;/body&gt;</span> 前注入 <span class="mono-inline">&lt;script type="application/alab+json" id="alab-boot"&gt;</span> 与运行时脚本。</span>
            </div>
            <div class="lab-list-item"><span class="lab-chip is-accent">接管</span>
              <span>页面里所有 <span class="mono-inline">&lt;form&gt;</span> 自动接管：提交即上报并拦截；没有 form 时用 <span class="mono-inline">&lt;button data-al-collect&gt;</span> 显式声明采集点。表单里只剩 <span class="mono-inline">type="button"</span> 这种动作按钮时，运行时把它当作提交兜底采集，避免老模板点了没留痕。</span>
            </div>
            <div class="lab-list-item"><span class="lab-chip is-accent">排除</span>
              <span>不想被采集的输入框加 <span class="mono-inline">data-al-ignore</span>；字段靠 <span class="mono-inline">name</span> 属性识别，运行时按 <span class="mono-inline">{name: value}</span> 映射上报，同名多值合并为数组。</span>
            </div>
            <div class="lab-list-item"><span class="lab-chip is-accent">运行时</span>
              <span>公共运行时挂在 <span class="mono-inline">window.AwareLab</span>（<span class="mono-inline">token() / collect() / report() / submit()</span>）。</span>
            </div>
            <div class="lab-list-item"><span class="lab-chip is-accent">端点</span>
              <span>上报 <span class="mono-inline">/alab/v2/engage</span> · 上钩教学跳转 <span class="mono-inline">/alab/v2/lesson?tk=</span> · 令牌参数统一 <span class="mono-inline">?tk=</span>。</span>
            </div>
          </div>
          <div class="live-fields">
            <div class="lab-kv">
              <span>本页识别到的字段：<b>{{ liveFields.length }}</b> 个</span>
              <span v-for="n in liveFields.slice(0, 8)" :key="n" class="lab-chip">{{ n }}</span>
              <span v-if="!liveFields.length" class="lab-hint is-mute">没有带 name 的输入框，运行时将无数据可报。</span>
            </div>
          </div>
        </LabPane>

        <LabPane title="智能诊断" hint="诊断不阻断保存，但不通过项会让采集失效">
          <template #ops>
            <el-button size="small" :loading="diagnosing" @click="runDiagnose">重新诊断</el-button>
          </template>
          <div v-if="!diagView" class="lab-empty">填写 HTML 后自动诊断，或点「重新诊断」。</div>
          <template v-else>
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px">
              <span style="font-size: 24px; font-weight: 700; color: var(--lab-ink); font-variant-numeric: tabular-nums">{{ diagView.score }}</span>
              <div class="lab-bar" style="flex: 1">
                <div class="lab-bar-fill" :class="barTone(diagView.score)" :style="{ width: `${diagView.score}%` }" />
              </div>
              <span class="lab-chip" :class="diagView.score >= 80 ? 'is-ok' : diagView.score >= 50 ? 'is-warn' : 'is-danger'">
                {{ diagView.score >= 80 ? '可用' : diagView.score >= 50 ? '有风险' : '大概率采不到数据' }}
              </span>
            </div>
            <div class="lab-list">
              <div v-for="c in diagView.checks" :key="c.key" class="lab-list-item check-row">
                <div class="check-hd">
                  <span class="lab-strong">{{ c.label || CHECK_LABELS[c.key] || c.key }}</span>
                  <span class="lab-chip" :class="c.ok ? 'is-ok' : 'is-danger'">{{ c.ok ? '通过' : '未通过' }}</span>
                </div>
                <div class="lab-hint">{{ c.detail || CHECK_NOTES[c.key] || '—' }}</div>
                <div v-if="c.items && c.items.length" class="lab-mono check-items">{{ c.items.join('\n') }}</div>
              </div>
            </div>
            <div v-if="diagView.issues.length" style="margin-top: 10px">
              <div class="lab-hint" v-for="(s, i) in diagView.issues" :key="i">· {{ s }}</div>
            </div>
          </template>
        </LabPane>
      </div>
    </div>

    <template #footer>
      <div class="drawer-foot">
        <span class="lab-hint is-mute">页面 ID：{{ form.id || '保存后由平台签发' }}</span>
        <div class="lab-spacer" />
        <el-button @click="drawer = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存假登录页</el-button>
      </div>
    </template>
  </el-drawer>

  <el-dialog v-model="rowPreview.open" :title="`预览 · ${rowPreview.name}`" width="min(920px, 94%)" append-to-body>
    <iframe class="preview-frame is-tall" :srcdoc="rowPreview.doc" title="假登录页预览"
      sandbox="allow-scripts allow-forms allow-modals allow-popups" />
    <div class="lab-hint" style="margin-top: 10px">与抽屉内预览同一套渲染结果，令牌独立签发，提交动作不会落成演练记录。</div>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onActivated } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';

defineProps({ gate: { type: Object, default: null } });

const RESPONSE_LABEL = { alert: '弹窗提示', redirect: '页面跳转', learn: '上钩教学' };
const CHECK_LABELS = { binding: '采集绑定', trigger: '提交触发点', assets: '外部资源', scripts: '自定义脚本', fields: '可采集字段' };
const CHECK_NOTES = {
  binding: '页面里有 <form>，或有 <button data-al-collect> 声明的采集点。',
  trigger: '表单里有 <button type="submit"> 或标了 data-al-collect 的按钮。只有 type="button" + onclick 的老写法也能采到，但那是靠运行时兜底，别把证据押在兜底上。',
  assets: '不引用 http(s):// 外部 js/css/图片，外链不可达会在演练现场留下破绽。',
  scripts: '模板里不写 <script>，boot 配置与运行时由平台注入。',
  fields: '至少一个带 name 的 input / select / textarea，运行时按 {name: value} 上报。',
};
const CHECK_ORDER = ['binding', 'trigger', 'assets', 'scripts', 'fields'];

const rows = ref([]);
const total = ref(0);
const types = ref([]);
const learnPages = ref([]);
const query = reactive({ page: 1, page_size: 10, type: '', keyword: '' });

const drawer = ref(false);
const saving = ref(false);
const diagnosing = ref(false);
const diag = ref(null);
const previewDoc = ref('');
const previewing = ref(false);
const rowPreview = reactive({ open: false, name: '', doc: '' });
const form = reactive({
  id: '', name: '', type: '', description: '', html: '',
  response_type: 'alert', response_content: '登录成功', learn_page_id: '',
});
const EMPTY_FORM = {
  id: '', name: '', type: '', description: '', html: '',
  response_type: 'alert', response_content: '登录成功', learn_page_id: '',
};
const SKELETON = `<main style="max-width:420px;margin:96px auto;font-family:'Segoe UI','Microsoft YaHei',sans-serif">
  <h1 style="font-size:18px;margin:0 0 6px">统一身份认证</h1>
  <p style="font-size:13px;color:#5c6b7a;margin:0 0 20px">请使用工号与口令登录。</p>
  <form style="display:flex;flex-direction:column;gap:12px">
    <input name="username" placeholder="工号" style="padding:10px 12px;border:1px solid #d9e1e8;border-radius:5px;font-size:13px" />
    <input name="password" type="password" placeholder="口令" style="padding:10px 12px;border:1px solid #d9e1e8;border-radius:5px;font-size:13px" />
    <button type="submit" style="padding:10px;border:0;border-radius:5px;background:#0f766e;color:#fff;font-size:14px">登录</button>
  </form>
</main>`;

async function load() {
  const data = await http.get('/web-templates', { params: query });
  rows.value = data.rows;
  total.value = data.total;
}
function reload() {
  query.page = 1;
  load();
}
async function loadMeta() {
  types.value = await http.get('/web-templates/types');
  learnPages.value = await http.get('/learn-pages');
}

/* ── 采集字段：与运行时的 name 识别规则保持一致 ───────────── */
function fieldNames(html) {
  if (!html) return [];
  const out = [];
  for (const m of String(html).matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const tag = m[0];
    if (/data-al-ignore/i.test(tag)) continue;
    const type = (tag.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase() || '';
    if (['submit', 'button', 'reset', 'image'].includes(type)) continue;
    const name = (tag.match(/\bname\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
const liveFields = computed(() => fieldNames(form.html));
const fieldTotal = computed(() => rows.value.reduce((n, r) => n + fieldNames(r.html).length, 0));

function scoreOf(row) {
  try {
    const s = JSON.parse(row.diagnose_json || '').score;
    return typeof s === 'number' ? s : null;
  } catch {
    return null;
  }
}
const scored = computed(() => rows.value.map(scoreOf).filter((v) => v !== null));
const avgScore = computed(() => (scored.value.length ? Math.round(scored.value.reduce((a, b) => a + b, 0) / scored.value.length) : '-'));
const avgTone = computed(() => {
  if (typeof avgScore.value !== 'number') return '';
  return avgScore.value >= 80 ? 'accent' : avgScore.value >= 50 ? 'warn' : 'danger';
});
function barTone(v) {
  return v >= 80 ? '' : v >= 50 ? 'is-warn' : 'is-danger';
}
function fmtTime(v) {
  return String(v || '').replace('T', ' ').slice(0, 16) || '—';
}

/* ── 诊断：{ score, checks[], issues[] } ───────────────── */
const diagView = computed(() => {
  const d = diag.value;
  if (!d || !Array.isArray(d.checks)) return null;
  const order = (k) => {
    const i = CHECK_ORDER.indexOf(k);
    return i < 0 ? 99 : i;
  };
  const checks = d.checks
    .map((c) => ({
      key: c.key,
      label: c.label || CHECK_LABELS[c.key] || c.key,
      ok: !!c.ok,
      detail: c.detail || CHECK_NOTES[c.key] || '',
      items: Array.isArray(c.items) ? c.items : [],
    }))
    .sort((a, b) => order(a.key) - order(b.key));
  return { score: Number(d.score ?? 0), checks, issues: Array.isArray(d.issues) ? d.issues : [] };
});

async function runDiagnose() {
  if (!form.html) return ElMessage.warning('先填写 HTML 源码');
  diagnosing.value = true;
  try {
    diag.value = await http.post('/web-templates/diagnose', { html: form.html });
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    diagnosing.value = false;
  }
}

/* ── 预览：渲染接口是 POST 且要带会话头，结果写进 iframe 的 srcdoc ── */
const BLANK_PREVIEW = '<p style="font-family:sans-serif;padding:20px;color:#93a1ae">左侧还没有 HTML 源码</p>';

function fetchPreview(html, responseType, responseContent) {
  return http.post('/web-templates/preview', {
    html,
    response_type: responseType || 'alert',
    response_content: responseType === 'learn' ? '' : (responseContent || ''),
  });
}

async function renderLivePreview() {
  if (!form.html) {
    previewDoc.value = '';
    return;
  }
  previewing.value = true;
  try {
    previewDoc.value = await fetchPreview(form.html, form.response_type, form.response_content);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    previewing.value = false;
  }
}

async function openRowPreview(row) {
  rowPreview.name = row.name;
  rowPreview.doc = BLANK_PREVIEW;
  rowPreview.open = true;
  try {
    rowPreview.doc = await fetchPreview(row.html, row.response_type, row.response_content);
  } catch (err) {
    ElMessage.error(err.message);
    rowPreview.open = false;
  }
}

let typingTimer = null;
watch(
  () => [form.html, form.response_type, form.response_content],
  () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      renderLivePreview();
      if (form.html) runDiagnose();
    }, 800);
  }
);

/* ── 抽屉开关 ───────────────────────────────────────────── */
function openCreate() {
  Object.assign(form, EMPTY_FORM);
  diag.value = null;
  previewDoc.value = '';
  drawer.value = true;
}
function openEdit(row) {
  Object.assign(form, row);
  diag.value = null;
  drawer.value = true;
  renderLivePreview();
  runDiagnose();
}
function insertSkeleton() {
  form.html = SKELETON;
}

async function save() {
  if (!form.name || !form.type || !form.html) return ElMessage.warning('页面类型、名称、HTML 源码必填');
  saving.value = true;
  try {
    const payload = {
      name: form.name, type: form.type, description: form.description, html: form.html,
      response_type: form.response_type,
      response_content: form.response_type === 'learn' ? null : form.response_content,
      learn_page_id: form.response_type === 'learn' ? form.learn_page_id : null,
    };
    if (form.id) await http.put(`/web-templates/${form.id}`, payload);
    else await http.post('/web-templates', payload);
    ElMessage.success('已保存');
    drawer.value = false;
    await load();
    await loadMeta();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

async function remove(row) {
  await ElMessageBox.confirm(
    `确认删除假登录页「${row.name}」？仍被钓鱼网站引用的页面会被服务端拒绝删除。`,
    '删除确认',
    { type: 'warning' }
  );
  try {
    await http.delete(`/web-templates/${row.id}`);
    ElMessage.success('已删除');
    load();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

/* KeepAlive 下 activated 会紧跟 mounted 触发一次，跳过它避免首屏重复请求 */
let activates = 0;
onMounted(() => {
  load();
  loadMeta();
});
onActivated(() => {
  activates += 1;
  if (activates <= 1) return;
  load();
});
</script>

<style scoped>
.pager { padding: 12px 14px; justify-content: flex-end; }
.clamp1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40ch; }
.preview-frame { display: block; width: 100%; height: 360px; border: 0; border-bottom: 1px solid var(--lab-line-2); background: #fff; }
.preview-frame.is-tall { height: 520px; border: 1px solid var(--lab-line-2); border-radius: var(--lab-r); }
.check-row { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.live-fields { margin: 12px -14px -14px; padding: 10px 14px; border-top: 1px solid var(--lab-line-2); }
.check-hd { display: flex; align-items: center; gap: 8px; }
.check-items { width: 100%; max-height: 120px; font-size: 11.5px; margin-top: 4px; }
.src-input :deep(.el-textarea__inner) {
  font-family: Consolas, "Cascadia Mono", monospace;
  font-size: 12px;
  line-height: 1.65;
}
.drawer-foot { display: flex; align-items: center; gap: 10px; }
</style>

<style>
/* 抽屉被 teleport 到 body，宽度约束只能写成组件级全局选择器 */
.page-drawer { max-width: 1180px; }
</style>
