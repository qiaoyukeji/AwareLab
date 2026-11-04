<template>
  <div class="lab-stack">
    <el-alert
      v-if="!gate"
      class="gate-alert"
      type="warning"
      :closable="false"
      show-icon
      title="未登记有效授权，发送任务不会真正发出"
    >
      <template #default>
        <span class="lab-hint">
          平台把演练授权作为硬性要求：没有处于生效窗口的授权时，服务端会拒绝发送请求。
          请先前往「演练授权」登记授权主体、有效期与授权名单。沙箱模式仍可用于渲染复核。
        </span>
      </template>
    </el-alert>

    <LabPane flush title="发送任务" hint="任务是一次次演练：默认沙箱发送，不真的寄出邮件。">
      <template #ops>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建发送任务</el-button>
      </template>

      <el-table :data="rows" size="small">
        <el-table-column prop="title" label="任务标题" min-width="150" show-overflow-tooltip />
        <el-table-column prop="subject" label="邮件主题" min-width="160" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <span class="lab-chip" :class="TASK_CHIP[row.status] || ''">{{ TASK_LABEL[row.status] || row.status }}</span>
          </template>
        </el-table-column>
        <el-table-column label="发送方式" width="110">
          <template #default="{ row }">
            <span class="lab-chip" :class="row.dry_run ? 'is-accent' : 'is-danger'">{{ row.dry_run ? '沙箱' : '真实发信' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="收件人 / 已提交" width="170">
          <template #default="{ row }">
            <span class="lab-hint">
              共 {{ row.stats.total }} · 已投 {{ row.stats.sent + row.stats.sandboxed }} · 失败 {{ row.stats.failed }} · 待发 {{ row.stats.pending }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="updated_at" label="更新时间" width="170" />
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="primary" :disabled="!row.stats.total" @click="send(row)">发送</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty><div class="lab-empty">还没有发送任务，先新建一个：默认沙箱，随时可复核。</div></template>
      </el-table>

      <template #ft>
        <span class="lab-hint is-mute">
          前置条件：演练授权生效中 + 邮件文案素材 + 发信邮箱。沙箱任务只渲染并落 .eml 文件，供人工复核后才切真实发送。
        </span>
      </template>
    </LabPane>
  </div>

  <!-- 新建 / 编辑抽屉：分组小节 -->
  <el-drawer v-model="editor" :title="form.id ? `编辑任务 - ${form.title || ''}` : '新建发送任务'" size="680px" :close-on-click-modal="false">
    <div class="lab-stack editor-body">
      <div class="lab-stack">
        <div class="sec-title lab-strong">基础信息</div>
        <el-form label-width="112px" label-position="left">
          <el-form-item label="任务标题" required><el-input v-model="form.title" placeholder="请输入任务标题" /></el-form-item>
          <el-form-item label="邮件主题" required><el-input v-model="form.subject" placeholder="邮件主题" /></el-form-item>
        </el-form>
      </div>

      <div class="lab-stack">
        <div class="sec-title lab-strong">素材绑定</div>
        <el-form label-width="112px" label-position="left">
          <el-form-item label="邮件文案">
            <el-select v-model="form.mail_template_id" clearable filterable placeholder="可选：选择邮件文案素材并自动同步（uuid----模板名称）" style="width: 100%" @change="syncTemplate">
              <el-option v-for="t in mailTemplates" :key="t.id" :label="`${t.id}----${t.name}`" :value="t.id" />
            </el-select>
            <div style="width: 100%; margin-top: 8px"><RichEditor v-model="form.body_html" /></div>
            <div class="lab-hint is-mute">
              打开像素与链接跳转凭据由服务端 composer 在发送时逐人注入，正文里无需手写；
              正文中指向监听网站的链接会自动带上收件人专属令牌。
            </div>
          </el-form-item>
          <el-form-item label="发信邮箱">
            <el-select v-model="form.smtp_profile_id" clearable placeholder="选择「发信邮箱」里留存的配置" style="width: 300px">
              <el-option v-for="p in smtpProfiles" :key="p.id" :label="`${p.name} <${p.from_addr}>`" :value="p.id" />
            </el-select>
            <el-button style="margin-left: 10px" :loading="testing" @click="testSmtp">连通性测试</el-button>
            <div class="lab-hint is-mute">账号在「发信邮箱」页留存，任务里一键复用；关闭沙箱时必选。</div>
          </el-form-item>
          <el-form-item label="发件人显示"><el-input v-model="form.sender" placeholder="可选，如 企业IT服务中心" style="width: 300px" /></el-form-item>
          <el-form-item label="绑定网站">
            <div class="site-chips">
              <span v-for="s in openSites" :key="s.id" class="lab-chip is-accent">{{ siteLabel(s) }}</span>
              <span v-if="!openSites.length" class="lab-hint is-mute">当前没有开启中的钓鱼网站</span>
            </div>
            <div class="lab-hint is-mute">这里不用选网站：发送时链接会自动指向「钓鱼网站」里已按授权开启的页面，任务不需逐条绑定。</div>
          </el-form-item>
          <el-form-item label="邮件附件">
            <template v-if="form.id">
              <el-upload :http-request="uploadAttachment" :show-file-list="false">
                <el-button type="primary">上传/替换附件</el-button>
              </el-upload>
              <el-button style="margin-left: 8px" type="danger" plain :disabled="!form.attachment_name" @click="dropAttachment">删除附件</el-button>
            </template>
            <el-button v-else disabled>保存后可上传附件</el-button>
            <div class="lab-hint is-mute">
              当前附件：{{ form.attachment_name || '未上传附件（无需附件下载可忽略）' }}。
              附件内程序请把上钩状态回调到 <code>/alab/v2/callback?tk=收件人令牌&amp;mail=邮箱</code>，multipart 表单字段即采集内容，截图字段固定为 capture。
            </div>
          </el-form-item>
        </el-form>
      </div>

      <div class="lab-stack">
        <div class="sec-title lab-strong">收件人</div>
        <el-form label-width="112px" label-position="left">
          <el-form-item label="批量导入">
            <el-input
              v-model="recipientText"
              type="textarea"
              :rows="7"
              :disabled="!form.id"
              :placeholder="form.id ? RECIPIENT_PLACEHOLDER : '先保存任务基础信息后启用'"
            />
            <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center">
              <el-button type="primary" :loading="importing" :disabled="!form.id" @click="importRecipients">导入收件人</el-button>
              <span v-if="importResult" class="lab-hint">
                新增 {{ importResult.added }}，重复跳过 {{ importResult.skipped }}，格式非法 {{ importResult.invalid }}
              </span>
            </div>
          </el-form-item>
          <el-form-item label="已导入">
            <el-table :data="recipients" size="small" max-height="220">
              <el-table-column prop="email" label="邮箱" min-width="170" />
              <el-table-column prop="name" label="姓名" width="100" />
              <el-table-column prop="token" label="专属令牌" min-width="200" show-overflow-tooltip />
              <el-table-column prop="status" label="状态" width="90" />
              <template #empty><div class="lab-empty">尚未导入收件人。</div></template>
            </el-table>
          </el-form-item>
        </el-form>
      </div>

      <div class="lab-stack">
        <div class="sec-title lab-strong">发送设置</div>
        <el-form label-width="112px" label-position="left">
          <el-form-item label="沙箱模式">
            <el-switch v-model="form.dry_run" active-text="沙箱（不真实发信）" inactive-text="真实发信" />
            <div class="lab-hint is-mute">
              沙箱只做模板渲染、令牌注入与发送记账，邮件文案落到 server/data/outbox/*.eml 供人工复核；
              关闭沙箱才会走 SMTP 真实发送。
            </div>
          </el-form-item>
          <el-alert
            v-if="!form.dry_run"
            class="risk-alert"
            type="error"
            :closable="false"
            show-icon
            title="风险提示：真实发信已开启"
            description="邮件将真实发送到收件人邮箱，请确认已获得书面授权、目标都在授权名单内，且内容与授权范围一致。"
          />
          <el-form-item label="发送间隔">
            <el-input-number v-model="form.send_interval_ms" :min="0" :max="60000" :step="1000" />
            <div class="lab-hint is-mute">单封之间的等待毫秒数，规避高频发信被服务商拦截。</div>
          </el-form-item>
        </el-form>
      </div>
    </div>
    <template #footer>
      <el-button @click="editor = false">关闭</el-button>
      <el-button :loading="saving" @click="saveOnly">保存</el-button>
      <el-button type="primary" :loading="sending" :disabled="!gate" @click="finish">保存并发送</el-button>
    </template>
  </el-drawer>

  <!-- 详情抽屉 -->
  <el-drawer v-model="detailDrawer" :title="`任务详情 - ${detailTask?.title || ''}`" size="760px">
    <div v-if="detailTask" class="lab-stack detail-body">
      <div class="lab-stack">
        <div class="sec-title lab-strong">发送设置</div>
        <div class="lab-kv">
          <span>发送方式：<b class="lab-strong">{{ Boolean(detailTask.dry_run) ? '沙箱（不真实发信）' : '真实发信' }}</b></span>
          <span>发送间隔：<b class="lab-mono" style="padding: 1px 6px">{{ detailTask.send_interval_ms }} ms</b></span>
          <span>附件：<b>{{ detailTask.attachment_name || '无' }}</b></span>
          <span>任务ID：<b class="lab-mono" style="padding: 1px 6px">{{ detailTask.id }}</b></span>
        </div>
        <div class="ops-row">
          <el-button type="primary" :disabled="!gate || !recipientCount" :loading="sending" @click="sendDetail">开始发送</el-button>
          <el-button :disabled="!gate || !(failedCount + pendingCount)" :loading="sending" @click="sendDetail">
            重发待投 / 失败（{{ failedCount + pendingCount }} 位）
          </el-button>
          <el-button v-if="!Boolean(detailTask.dry_run)" type="warning" plain @click="stopReal">拉回沙箱（停止真实发信）</el-button>
        </div>
        <div v-if="!gate" class="lab-hint" style="color: var(--lab-warn)">未登记有效授权，发送按钮已禁用，任务不会真正发出。</div>
        <p class="lab-hint is-mute">
          限速说明：按「发送间隔」逐封串行发送，仅处理待投与失败状态的收件人，已发送成功的不会被重复发出。
        </p>
      </div>

      <div class="lab-stack">
        <div class="sec-title lab-strong">收件人状态矩阵</div>
        <el-table :data="detailRecipients" size="small" max-height="320">
          <el-table-column prop="email" label="邮箱" min-width="160" show-overflow-tooltip />
          <el-table-column label="送达" width="160">
            <template #default="{ row }">
              <span class="lab-chip" :class="STATUS_CHIP[row.status] || ''">{{ STATUS_LABEL[row.status] || row.status }}</span>
              <div v-if="row.sent_at" class="lab-hint is-mute">{{ row.sent_at }}</div>
            </template>
          </el-table-column>
          <el-table-column label="打开" width="160">
            <template #default="{ row }">{{ row.opened_at || '-' }}</template>
          </el-table-column>
          <el-table-column label="点击" width="160">
            <template #default="{ row }">{{ row.clicked_at || '-' }}</template>
          </el-table-column>
          <el-table-column label="提交" width="160">
            <template #default="{ row }">{{ row.submitted_at || '-' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="resend(row)">重发</el-button>
            </template>
          </el-table-column>
          <template #empty><div class="lab-empty">尚未导入收件人。</div></template>
        </el-table>
      </div>

      <div class="lab-stack">
        <div class="sec-title lab-strong">附件</div>
        <div class="ops-row">
          <el-upload :http-request="uploadDetailAttachment" :show-file-list="false">
            <el-button>上传/替换附件</el-button>
          </el-upload>
          <el-button type="danger" plain :disabled="!detailTask.attachment_name" @click="dropDetailAttachment">删除附件</el-button>
        </div>
        <p class="lab-hint is-mute">
          当前附件：{{ detailTask.attachment_name || '无' }}。
          附件内程序请把上钩状态回调到 <code>/alab/v2/callback?tk=收件人令牌&amp;mail=邮箱</code>，multipart 表单字段即采集内容，截图字段固定为 capture。
        </p>
      </div>
    </div>
  </el-drawer>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh } from '@element-plus/icons-vue';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import RichEditor from '../../components/RichEditor.vue';

const props = defineProps({ gate: { type: Object, default: null } });

const TASK_LABEL = { draft: '草稿', sending: '发送中', sent: '已发送' };
const TASK_CHIP = { draft: 'is-warn', sending: 'is-accent', sent: 'is-ok' };
const STATUS_LABEL = { pending: '待发送', sent: '已发送', sandboxed: '沙箱已发送', failed: '失败' };
const STATUS_CHIP = { sent: 'is-ok', sandboxed: 'is-accent', failed: 'is-danger', pending: 'is-warn' };

const RECIPIENT_PLACEHOLDER = '每行一位收件人，格式：邮箱,姓名\nzhangsan@corp.example,张三';

const rows = ref([]);
const mailTemplates = ref([]);
const smtpProfiles = ref([]);
const openSites = ref([]);

const editor = ref(false);
const saving = ref(false);
const sending = ref(false);
const testing = ref(false);
const importing = ref(false);
const recipientText = ref('');
const recipients = ref([]);
const importResult = ref(null);

const detailDrawer = ref(false);
const detailTask = ref(null);
const detailRecipients = ref([]);

const form = reactive({
  id: '', title: '', mail_template_id: '', subject: '', body_html: '',
  attachment_name: '', smtp_profile_id: '', sender: '',
  send_interval_ms: 3000, dry_run: true,
});

const recipientCount = computed(() => detailRecipients.value.length);
const failedCount = computed(() => detailRecipients.value.filter((r) => r.status === 'failed').length);
const pendingCount = computed(() => detailRecipients.value.filter((r) => r.status === 'pending').length);

async function load() {
  const data = await http.get('/mail-tasks', { params: { page_size: 100 } });
  rows.value = data.rows;
}

async function loadMeta() {
  const [t, s, w] = await Promise.all([
    http.get('/mail-templates', { params: { page_size: 200 } }),
    http.get('/smtp-profiles'),
    http.get('/web-sites'),
  ]);
  mailTemplates.value = t.rows;
  smtpProfiles.value = s.rows;
  openSites.value = w.rows.filter((x) => x.status === 'open');
}

function siteLabel(s) {
  return `${s.domain || '监听'} : ${s.listen_port}`;
}

function resetForm(task) {
  Object.assign(form, {
    id: task?.id || '',
    title: task?.title || '',
    mail_template_id: task?.mail_template_id || '',
    subject: task?.subject || '',
    body_html: task?.body_html || '<p>您好：</p><p>请点击 <a href="#">链接</a> 完成核验。</p>',
    attachment_name: task?.attachment_name || '',
    smtp_profile_id: task?.smtp_profile_id || '',
    sender: task?.sender || '',
    send_interval_ms: task?.send_interval_ms ?? 3000,
    dry_run: task ? Boolean(task.dry_run) : true,
  });
}

function openCreate() {
  resetForm(null);
  recipients.value = [];
  importResult.value = null;
  recipientText.value = '';
  editor.value = true;
}

async function openEdit(row) {
  const data = await http.get(`/mail-tasks/${row.id}`);
  resetForm(data.task);
  recipients.value = data.recipients;
  importResult.value = null;
  recipientText.value = '';
  editor.value = true;
}

function syncTemplate(id) {
  const t = mailTemplates.value.find((x) => x.id === id);
  if (!t) return;
  form.subject = t.subject || form.subject;
  form.body_html = t.body_html || form.body_html;
}

async function ensureTask() {
  if (!form.title || !form.subject || !form.body_html) {
    ElMessage.warning('任务标题、邮件主题、正文必填');
    return null;
  }
  if (!form.dry_run && !form.smtp_profile_id) {
    ElMessage.warning('关闭沙箱后必须选择发信邮箱');
    return null;
  }
  const payload = {
    title: form.title,
    mail_template_id: form.mail_template_id || null,
    subject: form.subject,
    body_html: form.body_html,
    smtp_profile_id: form.smtp_profile_id || null,
    sender: form.sender || null,
    send_interval_ms: form.send_interval_ms,
    dry_run: form.dry_run,
  };
  const data = form.id ? await http.put(`/mail-tasks/${form.id}`, payload) : await http.post('/mail-tasks', payload);
  form.id = data.id;
  return data;
}

async function saveOnly() {
  saving.value = true;
  try {
    if (await ensureTask()) ElMessage.success('任务已保存');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
    load();
  }
}

async function uploadAttachment(opt) {
  const fd = new FormData();
  fd.append('file', opt.file);
  const data = await http.post(`/mail-tasks/${form.id}/attachment`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  form.attachment_name = data.name;
  ElMessage.success(`附件已上传：${data.name}`);
  load();
}

async function dropAttachment() {
  await http.put(`/mail-tasks/${form.id}`, { attachment_reset: true });
  form.attachment_name = '';
  load();
}

async function testSmtp() {
  if (!form.smtp_profile_id) return ElMessage.warning('请先选择发信邮箱');
  testing.value = true;
  try {
    const data = await http.post(`/smtp-profiles/${form.smtp_profile_id}/test`);
    ElMessage.success(`SMTP 连接成功：${data.host}:${data.port}`);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    testing.value = false;
  }
}

async function importRecipients() {
  importing.value = true;
  try {
    if (!(await ensureTask())) return;
    importResult.value = await http.post(`/mail-tasks/${form.id}/recipients`, { text: recipientText.value });
    const detail = await http.get(`/mail-tasks/${form.id}`);
    recipients.value = detail.recipients;
    ElMessage.success(`导入完成，新增 ${importResult.value.added} 位收件人`);
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    importing.value = false;
  }
}

async function finish() {
  if (!props.gate) return ElMessage.warning('未登记有效授权，任务不会真正发出');
  sending.value = true;
  try {
    if (!(await ensureTask())) return;
    const detail = await http.get(`/mail-tasks/${form.id}`);
    if (!detail.recipients.length) return ElMessage.warning('请先导入收件人');
    const data = await http.post(`/mail-tasks/${form.id}/send`);
    ElMessage.success(
      data.dry_run
        ? `沙箱发送完成 ${data.sent} 封，正文已落到 server/data/outbox 供复核`
        : `真实发送完成 ${data.sent} 封，失败 ${data.failed} 封`
    );
    editor.value = false;
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    sending.value = false;
  }
}

async function send(row) {
  if (!props.gate) return ElMessage.warning('未登记有效授权，发送任务不会真正发出');
  try {
    const data = await http.post(`/mail-tasks/${row.id}/send`);
    ElMessage.success(`本次处理 ${data.total} 位收件人${data.dry_run ? '（沙箱）' : ''}`);
    load();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

async function openDetail(row) {
  const data = await http.get(`/mail-tasks/${row.id}`);
  detailTask.value = data.task;
  detailRecipients.value = data.recipients;
  detailDrawer.value = true;
}

async function refreshDetail() {
  const data = await http.get(`/mail-tasks/${detailTask.value.id}`);
  detailTask.value = data.task;
  detailRecipients.value = data.recipients;
}

async function sendDetail() {
  if (!props.gate) return ElMessage.warning('未登记有效授权，发送任务不会真正发出');
  sending.value = true;
  try {
    const data = await http.post(`/mail-tasks/${detailTask.value.id}/send`);
    ElMessage.success(`本次处理 ${data.total} 位收件人${data.dry_run ? '（沙箱）' : ''}`);
    await refreshDetail();
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    sending.value = false;
  }
}

async function stopReal() {
  await http.put(`/mail-tasks/${detailTask.value.id}`, { dry_run: true });
  ElMessage.success('已拉回沙箱，后续发送不再真实发信');
  await refreshDetail();
  load();
}

async function uploadDetailAttachment(opt) {
  const fd = new FormData();
  fd.append('file', opt.file);
  await http.post(`/mail-tasks/${detailTask.value.id}/attachment`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  ElMessage.success('附件已上传');
  await refreshDetail();
  load();
}

async function dropDetailAttachment() {
  await http.put(`/mail-tasks/${detailTask.value.id}`, { attachment_reset: true });
  await refreshDetail();
  load();
}

async function resend(r) {
  if (!props.gate) return ElMessage.warning('未登记有效授权，发送任务不会真正发出');
  await http.post(`/mail-tasks/${detailTask.value.id}/recipients/${r.id}/resend`);
  ElMessage.success('已重新发送');
  await refreshDetail();
  load();
}

async function remove(row) {
  await ElMessageBox.confirm(`确认删除任务「${row.title}」及其收件人队列？`, '删除确认', { type: 'warning' });
  await http.delete(`/mail-tasks/${row.id}`);
  ElMessage.success('已删除');
  load();
}

onMounted(() => {
  load();
  loadMeta();
});
</script>

<style scoped>
.gate-alert { margin-bottom: var(--lab-gap); }
.editor-body { padding: 2px; }
.detail-body { padding: 2px 4px; }
.sec-title {
  font-size: 12.5px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--lab-line-2);
}
.risk-alert { margin: 0 0 12px; }
.site-chips { display: flex; flex-wrap: wrap; gap: 6px; width: 100%; }
.ops-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
</style>
