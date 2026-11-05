<!--
  邮件文案素材库，只写和存标题与正文；打开像素与链接改写由任务侧发送时注入，正文里手写会重复计数。
  subject 与 body_html 原样存取，{{name}} / {{email}} 以双花括号原文入库，界面展示处要挂 v-pre 才不会被插值吃掉。
-->
<template>
  <div class="lab-stack">
    <!-- gate 为空表示当前没有生效授权；拦的是任务真实发信那一步，这里只提示不禁用按钮 -->
    <el-alert v-if="!gate" type="warning" :closable="false" show-icon
      title="未登记有效授权，假登录页无法开启"
      description="邮件文案可以先编写保存；发送任务是否在沙箱外真实发信、指向哪个钓鱼网站，都以「演练授权」的生效窗口与授权名单为准。" />

    <div class="lab-grid" style="--cols: 3">
      <LabMetric label="邮件文案" :value="total" unit="封模板" :extra="`本页 ${rows.length} 条`" />
      <LabMetric label="含变量占位" :value="withVar" unit="条" tone="accent" extra="发送时按收件人替换 {{name}} / {{email}}" />
      <LabMetric label="含超链接" :value="withLink" unit="条" extra="链接发送时自动改写为专属令牌链路" />
    </div>

    <LabPane flush title="邮件文案清单" hint="正文只写给人看的内容，追踪链路与像素由平台在发送时嵌入">
      <template #ops>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          <span>新建邮件文案</span>
        </el-button>
        <el-button @click="load">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
      </template>

      <div style="padding: 14px 14px 0">
        <div class="lab-toolbar">
          <el-input v-model="keyword" placeholder="按名称、标题或描述搜索" style="width: 240px" @keyup.enter="load" />
          <el-button @click="load">
            <el-icon><Search /></el-icon>
            <span>搜索</span>
          </el-button>
          <div class="lab-spacer" />
          <span class="lab-hint is-mute">打开像素 <span class="mono-inline">/alab/v2/pixel</span> · 链接改写 <span class="mono-inline">/alab/v2/trace</span></span>
        </div>
      </div>

      <!-- 列表顺序（updated_at 倒序）由服务端排好；keyword 走服务端参数化 LIKE，命中名称、主题、描述 -->
      <el-table :data="rows" size="small">
        <!-- 主题在前、名称在后；主题留空合法，最终标题由发送任务补上 -->
        <el-table-column label="主题" min-width="260">
          <template #default="{ row }">
            <div class="lab-strong">{{ row.subject || '（主题留给发送任务填写）' }}</div>
            <div class="lab-hint is-mute clamp1">{{ row.name }}<template v-if="row.description"> · {{ row.description }}</template></div>
          </template>
        </el-table-column>
        <el-table-column label="正文摘要" min-width="300">
          <template #default="{ row }"><span class="lab-hint">{{ excerpt(row.body_html) }}</span></template>
        </el-table-column>
        <el-table-column label="素材" width="130">
          <template #default="{ row }">
            <div class="lab-kv">
              <span v-if="hasVar(row.body_html)" class="lab-chip is-accent">变量</span>
              <span v-if="hasLink(row.body_html)" class="lab-chip">链接</span>
              <span v-if="hasImage(row.body_html)" class="lab-chip">图片</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="130">
          <template #default="{ row }"><span class="lab-hint">{{ fmtTime(row.updated_at) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="primary" @click="preview(row)">预览</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="lab-empty">还没有邮件文案。新建一份后，发送任务只引用这里的素材，不在任务里重复编辑。</div>
        </template>
      </el-table>
    </LabPane>

    <!-- 不做规避邮件网关、伪造发件域的能力，发送范围由授权名单决定 -->
    <div class="lab-hint is-mute">
      正文里的外链图片会让邮件在收件人客户端发起外部请求，容易被邮件网关标记；素材请尽量内联或使用钓鱼网站地址。
      平台不做规避邮件网关、伪造发件域之类的能力，发送范围始终受授权名单约束。
    </div>
  </div>

  <!-- 新建与编辑共用一个抽屉，form.id 有无决定走 POST 还是 PUT；close-on-click-modal 关掉是防止点空白丢掉草稿 -->
  <el-drawer v-model="drawer" class="mail-drawer" :title="form.id ? `编辑邮件文案 · ${form.name}` : '新建邮件文案'"
    size="72%" :close-on-click-modal="false">
    <div class="lab-stack">
      <LabPane title="基本信息">
        <el-form label-position="top">
          <el-form-item label="模板名称" required>
            <el-input v-model="form.name" maxlength="100" show-word-limit placeholder="自定义起个名字" style="max-width: 420px" />
          </el-form-item>
          <el-form-item label="邮件标题">
            <el-input v-model="form.subject" placeholder="留空则由发送任务填写" style="max-width: 560px" />
          </el-form-item>
          <el-form-item label="描述">
            <el-input v-model="form.description" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="[选填] 这份正文用在什么场景" />
          </el-form-item>
        </el-form>
      </LabPane>

      <!-- 富文本与 HTML 源码两种模式共用同一个 v-model，也就共用 body_html 这一个存储字段，面板与服务端都不改写正文 -->
      <LabPane flush title="邮件文案" hint="支持富文本与 HTML 源码两种模式">
        <div style="padding: 14px">
          <RichEditor v-model="form.body_html" />
        </div>
        <template #ft>
          <div class="lab-hint">
            发送时正文会自动嵌入打开像素与链接改写（<span class="mono-inline">/alab/v2/pixel</span>、<span class="mono-inline">/alab/v2/trace</span>），不需要在正文里手写。
            按收件人替换的变量：<span class="mono-inline" v-pre>{{name}}</span> 姓名、<span class="mono-inline" v-pre>{{email}}</span> 邮箱；
            正文中指向钓鱼网站的链接会自动附加该收件人的专属令牌（<span class="mono-inline">?tk=</span>）。
          </div>
        </template>
      </LabPane>
    </div>

    <template #footer>
      <div class="drawer-foot">
        <span class="lab-hint is-mute">{{ plainLength }} 字纯文本</span>
        <div class="lab-spacer" />
        <el-button @click="drawer = false">取消</el-button>
        <el-button @click="previewDraft">预览渲染</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存邮件文案</el-button>
      </div>
    </template>
  </el-drawer>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onActivated } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';
import RichEditor from '../../components/RichEditor.vue';
import { fmtTime as ts } from '../../utils/time';

/** gate 为 null 表示没有生效授权；素材层的请求都不过门禁 */
defineProps({ gate: { type: Object, default: null } });

const rows = ref([]);
/** 全库总数，不等于 rows.length */
const total = ref(0);
const keyword = ref('');
const drawer = ref(false);
/** 防连点重复建模板 */
const saving = ref(false);
/** 字段与 mail_templates 列一一对应，id 有值即编辑 */
const form = reactive({ id: '', name: '', subject: '', description: '', body_html: '' });
/** 新建前先用它摊平上一份草稿，否则编辑过的内容会串进新建 */
const EMPTY = { id: '', name: '', subject: '', description: '', body_html: '' };

/** page_size=100：列表没有分页控件，默认 20 条会让顶部统计只算到一小截；服务端会把它夹到 1-200 */
async function load() {
  const data = await http.get('/mail-templates', { params: { page_size: 100, keyword: keyword.value } });
  rows.value = data.rows;
  total.value = data.total;
}

/** HTML 拍成一行纯文本：只用于摘要与字数，绝不写回 body_html */
function strip(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
/** 正文摘要列：strip 后超 90 字截断，空正文显示（空正文），返回串永不为空 */
function excerpt(html) {
  const text = strip(html);
  return text ? (text.length > 90 ? `${text.slice(0, 90)}…` : text) : '（空正文）';
}
/** 容忍 {{ name }} 这种带空格的写法，与任务侧替换口径一致 */
const hasVar = (html) => /\{\{\s*(name|email)\s*\}\}/.test(String(html || ''));
/** 含链接的文案发送时会被改写成带专属令牌的链路 */
const hasLink = (html) => /<a\b/i.test(String(html || ''));
/** 外链图片会让收件人客户端发外部请求 */
const hasImage = (html) => /<img\b/i.test(String(html || ''));
/** 顶部统计只算本页 rows，不等于全库 */
const withVar = computed(() => rows.value.filter((r) => hasVar(r.body_html)).length);
const withLink = computed(() => rows.value.filter((r) => hasLink(r.body_html)).length);
/** 不含标签，也不含发送时才注入的像素与链路 */
const plainLength = computed(() => strip(form.body_html).length);
/** 库里存 UTC，直接切字符串会差出几个小时 */
function fmtTime(v) {
  return ts(v);
}

/** 预置正文只有一个 <a href="#">，不含追踪地址；像素与专属链接由任务侧发送时注入，这里手写会串错人 */
function openCreate() {
  Object.assign(form, EMPTY, { body_html: '<p>您好：</p><p>请点击 <a href="#">链接</a> 完成核验。</p>' });
  drawer.value = true;
}
/** 整份行抄进 form，含 created_at 等只读列，保存时只挑需要的字段 */
function openEdit(row) {
  Object.assign(form, row);
  drawer.value = true;
}

/** 有 id 走 PUT，没 id 走 POST；name 与 body_html 必填，服务端同样校验，这里省一次往返；失败时抽屉保持打开 */
async function save() {
  if (!form.name || !form.body_html) return ElMessage.warning('模板名称与正文必填');
  saving.value = true;
  try {
    const payload = { name: form.name, subject: form.subject, description: form.description, body_html: form.body_html };
    if (form.id) await http.put(`/mail-templates/${form.id}`, payload);
    else await http.post('/mail-templates', payload);
    ElMessage.success('已保存');
    drawer.value = false;
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

/**
 * 本机新开空白窗口渲染正文，不经过任务侧渲染，没有像素与改写链接，不会污染上钩记录。
 * HTML 只 write 进这个本机窗口，不入库不外发。
 */
function renderDoc(title, html) {
  const win = window.open('', '_blank');
  if (!win) return ElMessage.warning('浏览器拦截了新窗口');
  win.document.write(`<html><head><meta charset="utf-8"><title>${title || '邮件预览'}</title></head><body>${html}</body></html>`);
  win.document.close();
}
function preview(row) {
  renderDoc(row.subject || '邮件预览', row.body_html);
}
/** 抽屉里的预览：还没保存的草稿 */
function previewDraft() {
  renderDoc(form.subject || '邮件预览', form.body_html);
}

/**
 * 不检查任务引用是刻意的：建任务时标题正文已快照进任务行，删素材不影响已发出的邮件。
 * 确认框点取消时 ElMessageBox 的 reject 从 await 处冒出，正好跳过删除。
 */
async function remove(row) {
  await ElMessageBox.confirm(`确认删除邮件文案「${row.name}」？已被发送任务引用的历史发送记录仍会保留。`, '删除确认', { type: 'warning' });
  try {
    await http.delete(`/mail-templates/${row.id}`);
    ElMessage.success('已删除');
    load();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

/* KeepAlive 下 activated 会紧跟 mounted 触发一次，第一次让它空跑，避免首屏重复请求 */
let activates = 0;
onMounted(load);
onActivated(() => {
  activates += 1;
  if (activates <= 1) return;
  // 切回本页时重拉：文案可能在别处改过
  load();
});
</script>

<style scoped>
/* 名称/描述行压在一行内，46ch 是列宽经验值 */
.clamp1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46ch; }
.drawer-foot { display: flex; align-items: center; gap: 10px; }
</style>

<style>
/* 抽屉被 teleport 到 body，宽度约束只能写成全局选择器；900px 之外由抽屉 size=72% 收 */
.mail-drawer { max-width: 900px; }
</style>
