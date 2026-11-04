<template>
  <div class="mandate">
    <!-- ① 授权状态：先回答「现在到底能不能开工」 -->
    <LabPane
      class="gate-pane"
      :class="{ 'is-open': !!current }"
      title="当前授权状态"
      :hint="current ? '以下字段改动即时生效，无需重新登记' : '平台在授权解锁前拒绝一切建站与发信'"
    >
      <template #ops>
        <span class="lab-chip" :class="current ? 'is-ok' : 'is-danger'">
          <span class="lab-dot" :class="{ 'is-live': !!current }" />
          {{ current ? STATUS_LABEL[current.effective] : '无有效授权' }}
        </span>
        <span v-if="current" class="lab-hint">{{ countdown }}</span>
        <el-button size="small" :disabled="!current" @click="current && openEdit(current)">编辑当前授权</el-button>
      </template>

      <template v-if="current">
        <div class="lab-bar gate-bar">
          <div class="lab-bar-fill" :class="barTone" :style="{ width: remainPct + '%' }" />
        </div>
        <div class="lab-kv gate-kv">
          <span>授权主体 <b>{{ current.scope }}</b></span>
          <span>对接人 <b>{{ current.contact || '—' }}</b></span>
          <span>有效期起 <b>{{ fmt(current.start_at) }}</b></span>
          <span>有效期止 <b>{{ fmt(current.end_at) }}</b></span>
          <span>授权名单条数 <b>{{ hostsOf(current).length }}</b></span>
          <span>备注 <b>{{ current.note || '—' }}</b></span>
        </div>
        <div class="host-row">
          <span v-for="h in hostsOf(current)" :key="h" class="lab-chip is-accent">{{ h }}</span>
        </div>
      </template>

      <p v-else class="lab-hint gate-off">
        <span class="lab-strong">平台已拒绝建站、开启网站与邮件发送</span>，钓鱼网站对任何访问都返回不可用。
        请在下方「授权记录」登记授权；若已有过期记录，直接对其 <span class="lab-strong">编辑续期</span> 即可，不必重新登记。
      </p>
    </LabPane>

    <!-- ② 授权记录 -->
    <LabPane flush title="授权记录" hint="每一次演练都归属到这里的一条记录">
      <template #ops>
        <el-button type="primary" size="small" @click="openCreate">登记新授权</el-button>
        <el-button size="small" @click="load">刷新</el-button>
      </template>
      <div style="padding: 0 14px" class="rule-note">
        <p class="lab-hint">
          平台把授权作为硬性要求：没有处于有效期内的记录时，钓鱼网站无法创建与开启、邮件任务拒绝发送，名单外的域名访问一律被拒绝。
          修改授权内容后，若该授权已不在生效窗口，其下网站会被自动停止监听；吊销授权同样立即停止所有网站。
          <span class="lab-strong">已吊销的记录不可修改，只能重新登记。</span>
        </p>
      </div>
      <el-table :data="rows" size="small">
        <el-table-column prop="scope" label="授权主体" min-width="150" show-overflow-tooltip />
        <el-table-column prop="contact" label="对接人" width="110" show-overflow-tooltip />
        <el-table-column label="有效期" width="170">
          <template #default="{ row }">
            <div class="win">{{ fmt(row.start_at) }}</div>
            <div class="win">~ {{ fmt(row.end_at) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="授权名单" min-width="180">
          <template #default="{ row }">
            <span v-for="h in hostsOf(row)" :key="h" class="lab-chip is-accent host-mini">{{ h }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="86">
          <template #default="{ row }">
            <span class="lab-chip" :class="STATUS_CHIP[row.effective] || ''">{{ STATUS_LABEL[row.effective] || row.effective }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="120" show-overflow-tooltip />
        <el-table-column label="操作" width="126" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="row.status !== 'active'" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" :disabled="row.status !== 'active'" @click="revoke(row)">吊销</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!rows.length" class="lab-empty">尚无授权记录，点击「登记新授权」开始第一次演练。</div>
    </LabPane>

    <!-- ③ 登记 / 编辑：右侧抽屉 -->
    <el-drawer
      v-model="drawer"
      :title="editingId ? '修改演练授权' : '登记演练授权'"
      size="560px"
      :close-on-click-modal="false"
      direction="rtl"
    >
      <div class="pledge-tip">
        <span class="lab-strong">{{ statement || '本平台仅用于授权范围内的安全意识演练。' }}</span>
        <p class="lab-hint">
          请确认你已获得被测组织的书面授权，并且演练目标、时间窗口与下方登记内容一致。
          <template v-if="editingId">修改授权内容同样需要重新输入使用承诺。</template>
        </p>
      </div>

      <el-form label-position="top" class="auth-form">
        <section>
          <h4 class="sec-t">授权主体与对接人</h4>
          <el-form-item label="授权主体" required>
            <el-input v-model="form.scope" placeholder="如：某某科技 信息安全部（对应授权文件中的被演练组织）" />
          </el-form-item>
          <el-form-item label="对接人">
            <el-input v-model="form.contact" placeholder="授权方联系人 / 工单号" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="form.note" type="textarea" :rows="2" placeholder="授权文件编号、审批链等" />
          </el-form-item>
        </section>

        <section>
          <h4 class="sec-t">有效期</h4>
          <el-form-item label="起止时间" required>
            <el-date-picker
              v-model="form.range"
              type="datetimerange"
              value-format="YYYY-MM-DDTHH:mm:ss.000Z"
              start-placeholder="开始时间"
              end-placeholder="结束时间"
              style="width: 100%"
            />
          </el-form-item>
          <p class="lab-hint is-mute">
            缩短有效期属于高危改动：保存时若该授权已滑出生效窗口，其下正在监听的网站会被立即停止，并在结果里告诉你停了几台。
          </p>
        </section>

        <section>
          <h4 class="sec-t">授权名单</h4>
          <el-form-item label="允许仿冒的域名或标记（每行一个）" required>
            <el-input
              v-model="form.hosts"
              type="textarea"
              :rows="4"
              placeholder="每行一个允许仿冒的域名或标记：&#10;corp.example.com&#10;*.mail.example.com&#10;#ip（允许直接用 IP 访问钓鱼网站）"
            />
          </el-form-item>
          <div class="host-preview">
            <span v-for="(h, i) in parsedHosts" :key="`${h}-${i}`" class="lab-chip is-accent">{{ h }}</span>
            <span v-if="!parsedHosts.length" class="lab-chip is-danger">授权名单为空，无法保存</span>
          </div>
          <p class="lab-hint is-mute">
            支持三种写法：<span class="lab-mono-inline">#ip</span>（IP 直连访问钓鱼网站）、<span class="lab-mono-inline">*.domain</span>（泛域名）、
            <span class="lab-mono-inline">corp.example.com</span>（精确域名）。钓鱼网站只服务授权名单里写到的域名。
          </p>
        </section>

        <section>
          <h4 class="sec-t">使用承诺</h4>
          <el-form-item label="手动完整输入下方承诺语句后才允许保存" required>
            <el-input v-model="form.pledge" :placeholder="`请完整输入：${requiredPledge}`" />
          </el-form-item>
          <div class="pledge-check">
            <span class="lab-chip" :class="pledgeMatched ? 'is-ok' : 'is-danger'">
              {{ pledgeMatched ? '承诺文本一致，可以保存' : '承诺文本尚未完整输入' }}
            </span>
          </div>
          <p class="lab-hint is-mute">
            这是平台的硬约束：承诺必须由操作者本人按输入框提示逐字键入，页面不提供复制、自动填充或跳过入口。
          </p>
        </section>
      </el-form>

      <template #footer>
        <div class="drawer-foot">
          <el-button @click="drawer = false">取消</el-button>
          <el-button type="primary" :loading="saving" :disabled="!pledgeMatched" @click="save">
            {{ editingId ? '保存修改并生效' : '确认并启用' }}
          </el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';

const props = defineProps({ gate: { type: Object, default: null } });

const STATUS_LABEL = { active: '生效中', expired: '已过期', pending: '未开始', revoked: '已吊销', missing: '无' };
const STATUS_CHIP = { active: 'is-ok', expired: 'is-danger', pending: 'is-warn', revoked: '' };
const BLANK = { scope: '', contact: '', range: [], hosts: '', note: '', pledge: '' };

const rows = ref([]);
const drawer = ref(false);
const saving = ref(false);
const editingId = ref(null);
const requiredPledge = ref('');
const statement = ref('');
const form = reactive({ ...BLANK });

const current = computed(() => rows.value.find((r) => r.effective === 'active') ?? (rows.value.length ? null : props.gate));

function hostsOf(row) {
  return Array.isArray(row?.allowed_hosts) ? row.allowed_hosts : [];
}

function fmt(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

const remainPct = computed(() => {
  const c = current.value;
  if (!c) return 0;
  const start = new Date(c.start_at).getTime();
  const end = new Date(c.end_at).getTime();
  if (!(end > start)) return 0;
  return Math.max(0, Math.min(100, Math.round(((end - Date.now()) / (end - start)) * 100)));
});

const barTone = computed(() => (remainPct.value < 15 ? 'is-danger' : remainPct.value < 40 ? 'is-warn' : ''));

const countdown = computed(() => {
  const c = current.value;
  if (!c) return '';
  const days = (new Date(c.end_at).getTime() - Date.now()) / 86400000;
  if (days <= 0) return '已到有效期止';
  if (days < 1) return `剩余 ${Math.max(1, Math.round(days * 24))} 小时`;
  return `剩余 ${days.toFixed(1)} 天`;
});

const parsedHosts = computed(() => form.hosts.split(/[\n,]/).map((s) => s.trim()).filter(Boolean));

const pledgeMatched = computed(() => !!requiredPledge.value && form.pledge === requiredPledge.value);

async function load() {
  rows.value = (await http.get('/authorizations')) || [];
}

function openCreate() {
  editingId.value = null;
  Object.assign(form, { ...BLANK, hosts: '#ip\n' });
  drawer.value = true;
}

function openEdit(row) {
  editingId.value = row.id;
  Object.assign(form, {
    scope: row.scope,
    contact: row.contact || '',
    // 回填成 UTC ISO，与 date-picker 的 value-format 走同一解析口径
    range: [new Date(row.start_at).toISOString(), new Date(row.end_at).toISOString()],
    hosts: hostsOf(row).join('\n'),
    note: row.note || '',
    pledge: '',
  });
  drawer.value = true;
}

function payload() {
  return {
    scope: form.scope,
    contact: form.contact,
    start_at: form.range[0],
    end_at: form.range[1],
    allowed_hosts: parsedHosts.value,
    pledge: form.pledge,
    note: form.note,
  };
}

async function save() {
  if (!form.scope || !form.range?.length) return ElMessage.warning('授权主体与有效期必填');
  if (!parsedHosts.value.length) return ElMessage.warning('授权名单必填：至少一条域名、泛域名或 #ip');
  if (!pledgeMatched.value) return ElMessage.warning('请手动完整输入使用承诺');
  saving.value = true;
  try {
    const editing = !!editingId.value;
    const res = editing
      ? await http.put(`/authorizations/${editingId.value}`, payload())
      : await http.post('/authorizations', payload());
    if (editing && res?.stopped_sites) {
      ElMessage.warning(`修改已保存；该授权已不在生效窗口，停止 ${res.stopped_sites} 个网站监听`);
    } else {
      ElMessage.success(editing ? '授权已更新并生效' : '授权已登记，平台能力解锁');
    }
    drawer.value = false;
    Object.assign(form, { ...BLANK });
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

async function revoke(row) {
  await ElMessageBox.confirm(`吊销授权「${row.scope}」将同时停止其下所有钓鱼网站监听，确认？`, '高危操作', { type: 'warning' });
  await http.post(`/authorizations/${row.id}/revoke`);
  ElMessage.success('已吊销');
  load();
}

onMounted(async () => {
  try {
    const p = await http.get('/authorizations/pledge');
    requiredPledge.value = p.pledge;
    statement.value = p.statement;
  } catch {
    requiredPledge.value = '';
  }
  load();
});
</script>

<style scoped>
.mandate { display: flex; flex-direction: column; gap: var(--lab-gap); }
.gate-pane.is-open { border-left: 3px solid var(--lab-accent); }
.gate-bar { height: 8px; margin-bottom: 12px; }
.gate-kv { margin-bottom: 12px; }
.host-row { display: flex; flex-wrap: wrap; gap: 6px; }
.host-mini { margin: 2px 3px 2px 0; }
.gate-off { margin: 0; }
.rule-note { padding-top: 12px; }
.win { font-size: 12px; color: var(--lab-ink-4); line-height: 1.6; }
.pledge-tip {
  background: var(--lab-warn-soft);
  border: 1px solid #eddcbf;
  border-radius: var(--lab-r);
  padding: 10px 12px;
  margin-bottom: 16px;
  color: var(--lab-warn);
}
.auth-form section { margin-bottom: 18px; }
.sec-t {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
  color: var(--lab-ink);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--lab-line-2);
}
.host-preview { display: flex; flex-wrap: wrap; gap: 6px; margin: -6px 0 8px; }
.lab-mono-inline {
  font-family: Consolas, "Cascadia Mono", monospace;
  font-size: 12px;
  background: var(--lab-fill);
  border: 1px solid var(--lab-line);
  border-radius: var(--lab-r-sm);
  padding: 0 4px;
  color: var(--lab-ink-2);
}
.pledge-check { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: -6px 0 8px; }
.drawer-foot { display: flex; justify-content: flex-end; gap: 8px; }
</style>
