<template>
  <div class="lab-stack">
    <el-alert v-if="!gate" type="warning" :closable="false" show-icon
      title="未登记有效授权，钓鱼网站无法开启"
      description="网站可以先建好、先关着；但要真正监听端口对目标提供服务，必须先在「演练授权」登记授权主体、有效期与授权名单。" />
    <el-alert v-else type="info" :closable="false" show-icon
      :title="`授权生效中 · ${gate.scope} · 授权名单 ${gate.allowed_hosts?.length || 0} 条`"
      description="钓鱼网站只对授权名单里的域名开放，名单外的访问直接拒绝；授权到期或被吊销时，名下网站会同步停止监听。" />

    <div class="lab-grid" style="--cols: 4">
      <LabMetric label="钓鱼网站" :value="rows.length" unit="个" :extra="`本页 ${shownCount} 条`" />
      <LabMetric label="监听中" :value="liveCount" unit="个" :tone="liveCount ? 'accent' : ''" extra="保存为开启状态即占用端口" />
      <LabMetric label="未监听" :value="rows.length - liveCount" unit="个" extra="关闭或异常，不占用任何端口" />
      <LabMetric label="端口占用" :value="portCount" unit="个" :extra="`可用区间 ${portRange[0]}-${portRange[1]}`" />
    </div>

    <LabPane flush title="网站监听" hint="每个网站独占一个端口，保存即按 监听地址:端口 开启采集">
      <template #ops>
        <el-button size="small" plain type="danger" :disabled="!selection.length" @click="batchRemove">
          删除选中 {{ selection.length }}
        </el-button>
        <el-button size="small" type="primary" :icon="Plus" @click="openCreate">新建钓鱼网站</el-button>
        <el-button size="small" :icon="Refresh" @click="reload">刷新</el-button>
      </template>

      <el-table :data="rows" size="small" @selection-change="(v) => (selection = v)">
        <el-table-column type="selection" width="40" />
        <el-table-column label="状态" width="86">
          <template #default="{ row }">
            <span class="lab-chip" :class="statusTone(row)">
              <span class="lab-dot" :class="{ 'is-live': row.running }" />{{ statusLabel(row) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="template_name" label="假登录页" min-width="150" show-overflow-tooltip />
        <el-table-column label="访问地址" min-width="210">
          <template #default="{ row }">
            <a class="lab-hint site-link" :href="row.url" target="_blank" rel="noreferrer">{{ row.url }}</a>
          </template>
        </el-table-column>
        <el-table-column label="监听" width="140">
          <template #default="{ row }"><span class="mono-inline">{{ row.listen_ip }}:{{ row.listen_port }}</span></template>
        </el-table-column>
        <el-table-column label="协议" width="76">
          <template #default="{ row }">{{ row.tls_cert ? 'HTTPS' : 'HTTP' }}</template>
        </el-table-column>
        <el-table-column prop="auth_scope" label="授权主体" min-width="130" show-overflow-tooltip />
        <el-table-column label="操作" width="268" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="toggle(row)">{{ row.status === 'open' ? '停止' : '开启' }}</el-button>
            <el-button link type="primary" @click="openPeek(row)">链接与上钩</el-button>
            <el-button link type="primary" @click="issueLink(row)">生成专属链接</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="lab-empty">还没有钓鱼网站。先在「钓鱼素材」备好假登录页，再回到这里挂到监听端口。</div>
        </template>
      </el-table>
    </LabPane>

    <el-drawer v-model="drawer" size="620px" :close-on-click-modal="false">
      <template #header><span class="lab-pane-t">新建钓鱼网站</span></template>

      <div class="lab-stack drawer-sections">
        <section>
          <div class="section-t">绑定素材</div>
          <el-form label-position="top">
            <el-form-item label="假登录页" required>
              <el-select v-model="form.template_id" placeholder="选择钓鱼素材里已保存的假登录页" style="width: 100%">
                <el-option v-for="t in templates" :key="t.id" :label="`${t.type} · ${t.name}`" :value="t.id" />
              </el-select>
              <div class="lab-hint is-mute">共 {{ templates.length }} 份可用素材；需要新增请切到「钓鱼素材 · 假登录页」。</div>
            </el-form-item>
            <el-form-item label="开启状态">
              <el-radio-group v-model="form.status">
                <el-radio-button value="open">立即开启</el-radio-button>
                <el-radio-button value="closed">先关闭</el-radio-button>
              </el-radio-group>
            </el-form-item>
          </el-form>
        </section>

        <section>
          <div class="section-t">监听地址</div>
          <el-form label-position="top">
            <el-form-item label="监听 IP">
              <el-input v-model="form.listen_ip" placeholder="对本机所有网卡服务就填 0.0.0.0" />
              <div class="lab-hint is-mute">填 0.0.0.0 时这个端口对本机所有网卡开放，同一网络内都能访问；只在本机验证就填 127.0.0.1。管理后台默认只听 127.0.0.1，与这里互不影响。</div>
            </el-form-item>
            <el-form-item label="监听端口">
              <el-input v-model.number="form.listen_port" :placeholder="`${portRange[0]}-${portRange[1]}，注意防火墙放通与端口占用`" />
              <div class="lab-hint is-mute">端口落在配置区间内才会被接受；区间在「系统设置 · 运行参数」里。</div>
            </el-form-item>
            <el-form-item label="监听域名">
              <el-input v-model="form.domain" placeholder="可选，仅当用域名访问时填写，例如 lab.example.cn" />
              <div class="lab-hint is-mute">域名必须落在「演练授权」登记的授权名单内，否则钓鱼网站会直接拒绝访问。</div>
            </el-form-item>
          </el-form>
        </section>

        <section>
          <div class="section-t">HTTPS（可选）</div>
          <el-form label-position="top">
            <el-form-item label="TLS 私钥">
              <el-input v-model="form.tls_key" type="textarea" :rows="3"
                placeholder="-----BEGIN PRIVATE KEY----- 开头的 PEM 私钥，留空则走 HTTP" />
            </el-form-item>
            <el-form-item label="TLS 证书">
              <el-input v-model="form.tls_cert" type="textarea" :rows="3"
                placeholder="-----BEGIN CERTIFICATE----- 开头的 PEM 证书，与私钥同时提供" />
            </el-form-item>
          </el-form>
        </section>
      </div>

      <template #footer>
        <div class="drawer-foot">
          <span class="lab-hint is-mute footer-note">创建后令牌由专属链接携带，可在列表「生成专属链接」为每位收件人单独生成。</span>
          <el-button @click="drawer = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="save">创建钓鱼网站</el-button>
        </div>
      </template>
    </el-drawer>

    <el-drawer v-model="peek" size="820px" :close-on-click-modal="false">
      <template #header>
        <span class="lab-pane-t">链接与上钩 · {{ peekSite?.template_name || '钓鱼网站' }}</span>
      </template>

      <div v-loading="peekLoading" class="lab-stack drawer-sections">
        <div class="lab-grid" style="--cols: 4">
          <LabMetric label="专属链接" :value="peekLinks.length" unit="条" extra="本站签发，含匿名访客链接" />
          <LabMetric label="已打开" :value="peekOpenedCount" unit="条" :tone="peekOpenedCount ? 'accent' : ''" extra="按打开事件计数" />
          <LabMetric label="已提交" :value="peekSubmittedCount" unit="条" :tone="peekSubmittedCount ? 'accent' : ''" extra="采到过字段才算上钩" />
          <LabMetric label="上钩记录" :value="peekRecords.length" unit="条" :extra="`转化率 ${peekConversion}%`" />
        </div>

        <section>
          <div class="section-t">本站签发的链接</div>
          <el-table :data="peekLinks" size="small" max-height="260">
            <el-table-column label="归属" min-width="150">
              <template #default="{ row }">
                <span v-if="row.target_email">{{ row.target_name ? `${row.target_name} · ` : '' }}{{ row.target_email }}</span>
                <span v-else class="lab-hint is-mute">匿名访客</span>
              </template>
            </el-table-column>
            <el-table-column label="打开" width="86">
              <template #default="{ row }">
                <span class="lab-chip" :class="row.opens ? 'is-accent' : ''">{{ row.opens }} 次</span>
              </template>
            </el-table-column>
            <el-table-column label="提交" width="90">
              <template #default="{ row }">
                <span class="lab-chip" :class="{ 'is-ok': row.submitted_at }">{{ row.submitted_at ? `${row.submits} 次` : '未提交' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="采到的字段" min-width="170">
              <template #default="{ row }">
                <span v-if="row.field_names.length" class="mono-inline">{{ row.field_names.join('、') }}</span>
                <span v-else class="lab-hint is-mute">—</span>
              </template>
            </el-table-column>
            <el-table-column label="签发时间" min-width="150">
              <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="96" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="copyLink(row)">复制链接</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <div class="lab-empty">还没有为这个网站签发过链接。用下方「生成专属链接」按人发，或把访问地址直接贴到内网公告里。</div>
            </template>
          </el-table>
        </section>

        <section>
          <div class="section-t">本站的上钩记录</div>
          <el-table :data="peekRecords" size="small" max-height="300">
            <el-table-column type="expand">
              <template #default="{ row }">
                <div class="field-list">
                  <div v-if="!row.form.length" class="lab-hint is-mute">这条只有打开，没有采集到字段。</div>
                  <div v-for="(field, i) in row.form" :key="i" class="field-row">
                    <span class="mono-inline">{{ field.name }}</span>
                    <span class="mono-inline field-value">{{ field.value }}</span>
                    <span class="lab-hint is-mute">{{ fmtSeconds(field.at) }}</span>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="目标" min-width="150">
              <template #default="{ row }">
                <span v-if="row.target_email">{{ row.target_email }}</span>
                <span v-else class="lab-hint is-mute">匿名访客</span>
              </template>
            </el-table-column>
            <el-table-column label="首次打开" min-width="150">
              <template #default="{ row }">{{ fmtTime(row.first_seen_at) }}</template>
            </el-table-column>
            <el-table-column label="提交" width="90">
              <template #default="{ row }">
                <span class="lab-chip" :class="{ 'is-ok': row.submitted }">{{ row.submitted ? '已上钩' : '只打开' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="停留" width="80">
              <template #default="{ row }">{{ row.dwell_seconds == null ? '-' : `${row.dwell_seconds}s` }}</template>
            </el-table-column>
            <el-table-column label="来源" width="130">
              <template #default="{ row }"><span class="mono-inline">{{ row.feature?.ipv4 || '-' }}</span></template>
            </el-table-column>
            <template #empty>
              <div class="lab-empty">还没有人打开这个网站。链接发出去之后，打开与提交都会实时落到这里。</div>
            </template>
          </el-table>
        </section>
      </div>

      <template #footer>
        <div class="drawer-foot">
          <span class="lab-hint is-mute footer-note">链接一人一令：同一条链接重复打开只累计次数，不新增归属。</span>
          <el-button :icon="Refresh" @click="loadPeek">刷新</el-button>
          <el-button type="primary" @click="issueLink(peekSite)">生成专属链接</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh } from '@element-plus/icons-vue';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';

const props = defineProps({ gate: { type: Object, default: null } });

const BLANK = { status: 'open', template_id: '', listen_ip: '0.0.0.0', listen_port: 8080, domain: '', tls_key: '', tls_cert: '' };

const rows = ref([]);
const templates = ref([]);
const selection = ref([]);
const drawer = ref(false);
const saving = ref(false);
const portRange = ref([8000, 9999]);
const form = reactive({ ...BLANK });

const liveCount = computed(() => rows.value.filter((r) => r.running).length);
const portCount = computed(() => new Set(rows.value.filter((r) => r.running).map((r) => r.listen_port)).size);
const shownCount = computed(() => rows.value.length);

const peek = ref(false);
const peekSiteId = ref('');
const peekLinks = ref([]);
const peekRecords = ref([]);
const peekLoading = ref(false);
// 站点行以列表里的最新状态为准：抽屉开着时从别处停了监听，头部提示也要跟着变
const peekSite = computed(() => rows.value.find((r) => r.id === peekSiteId.value) || null);
const peekOpenedCount = computed(() => peekLinks.value.filter((l) => l.opens > 0).length);
const peekSubmittedCount = computed(() => peekLinks.value.filter((l) => l.submitted_at).length);
const peekConversion = computed(() =>
  peekRecords.value.length ? Math.round((peekRecords.value.filter((r) => r.submitted).length / peekRecords.value.length) * 100) : 0
);

function fmtTime(v) {
  return String(v || '').replace('T', ' ').slice(0, 16) || '—';
}
// 字段级的采集时间要留到秒：同一张表单里多个字段往往在同一分钟落库，只到分会看不出先后
function fmtSeconds(v) {
  return String(v || '').replace('T', ' ').replace('Z', '').slice(0, 19) || '-';
}

function openPeek(row) {
  peekSiteId.value = row.id;
  peek.value = true;
  loadPeek();
}

async function loadPeek() {
  const site = peekSite.value;
  if (!site) return;
  peekLoading.value = true;
  try {
    const [links, records] = await Promise.all([
      http.get(`/web-sites/${site.id}/links`),
      http.get('/records', { params: { site_id: site.id, page_size: 50 } }),
    ]);
    peekLinks.value = links.rows || [];
    peekRecords.value = records.rows || [];
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    peekLoading.value = false;
  }
}

async function copyLink(row) {
  try {
    await navigator.clipboard.writeText(row.url);
    ElMessage.success('链接已复制，可直接发给这一位');
  } catch {
    // 非 HTTPS 下浏览器会拒绝剪贴板，这时候把链接本身摊出来让人手动复制
    await ElMessageBox.alert(row.url, '专属链接', { confirmButtonText: '知道了', customClass: 'link-box' });
  }
}

function statusLabel(row) {
  if (row.status === 'error') return '异常';
  return row.status === 'open' ? (row.running ? '监听中' : '待恢复') : '已关闭';
}
function statusTone(row) {
  if (row.status === 'error') return 'is-danger';
  if (row.running) return 'is-ok';
  return '';
}

async function load() {
  const data = await http.get('/web-sites');
  rows.value = data.rows || [];
}

async function loadMeta() {
  const [t, s] = await Promise.all([http.get('/web-templates', { params: { page_size: 200 } }), http.get('/settings')]);
  templates.value = t.rows || [];
  portRange.value = s.capture_port_range || portRange.value;
}

function openCreate() {
  Object.assign(form, BLANK);
  drawer.value = true;
}

async function save() {
  if (!form.template_id) return ElMessage.warning('请选择假登录页');
  saving.value = true;
  try {
    const data = await http.post('/web-sites', form);
    ElMessage.success(`网站已就绪：${data.url}`);
    drawer.value = false;
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

async function toggle(row) {
  const stop = row.status === 'open';
  try {
    await http.post(`/web-sites/${row.id}/${stop ? 'stop' : 'start'}`);
    ElMessage.success(stop ? '已停止监听，历史采集记录保留' : '已开启监听');
    load();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

async function issueLink(row) {
  if (!row) return;
  let email = '';
  try {
    const prompt = await ElMessageBox.prompt('为该链接登记归属邮箱；留空则签发匿名访客链接，只计打开不认人', '生成专属链接', {
      confirmButtonText: '签发',
      cancelButtonText: '取消',
      inputPlaceholder: 'target@corp.example',
      inputValidator: (value) => !value.trim() || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()) || '邮箱格式不正确',
    });
    email = prompt.value.trim();
  } catch {
    return;
  }
  try {
    const data = await http.post(`/web-sites/${row.id}/links`, { email });
    await navigator.clipboard.writeText(data.url).catch(() => {});
    ElMessage.success(email ? `已为 ${email} 签发独立链接` : '已签发匿名访客链接');
    // 非 HTTPS 下剪贴板会被浏览器拦掉，链接必须还能在界面上看到
    await ElMessageBox.alert(data.url, '专属链接', { confirmButtonText: '知道了', customClass: 'link-box' });
    if (peek.value) loadPeek();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm('删除会停止该网站监听，已采集的证据保留，确认删除？', '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  await http.delete(`/web-sites/${row.id}`);
  ElMessage.success('已删除');
  load();
}

async function batchRemove() {
  for (const row of selection.value) {
    await http.delete(`/web-sites/${row.id}`).catch((e) => ElMessage.warning(e.message));
  }
  selection.value = [];
  load();
}

async function reload() {
  await load();
  loadMeta();
}

onMounted(reload);
</script>

<style scoped>
.site-link { text-decoration: none; word-break: break-all; }
.site-link:hover { text-decoration: underline; }
.section-t { font-size: 13px; font-weight: 700; color: var(--lab-ink); margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--lab-line-2); }
.drawer-sections :deep(.el-form-item) { margin-bottom: 14px; }
.drawer-foot { display: flex; align-items: center; gap: 8px; }
.footer-note { margin-right: auto; }
.field-list { padding: 6px 14px 6px 46px; display: flex; flex-direction: column; gap: 4px; }
.field-row { display: flex; align-items: center; gap: 12px; font-size: 12px; }
.field-value { background: var(--lab-fill-2); }
</style>
