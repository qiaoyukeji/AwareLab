<template>
  <div class="lab-stack">
    <div class="drill-bar">
      <el-button size="small" :icon="ArrowLeft" @click="$emit('back')">返回分组</el-button>
      <div class="drill-title">
        <span class="lab-pane-t">{{ group.label }}</span>
        <span class="lab-hint">{{ subtitle }}</span>
      </div>
    </div>

    <div v-if="group.group !== 'all'" class="lab-grid" style="--cols: 4">
      <LabMetric label="本组上钩终端" :value="group.terminals" unit="条" :extra="`累计打开 ${openCount} 次`" />
      <LabMetric label="本组已提交" :value="group.submitted" unit="条" :tone="group.submitted ? 'danger' : ''" :extra="`提交率 ${group.conversion}%`" />
      <LabMetric
        :label="thirdMetric.label"
        :value="thirdMetric.value"
        :unit="thirdMetric.unit"
        :extra="thirdMetric.extra"
      />
      <LabMetric label="本组最近活动" :value="fmt(group.last_seen_at)" extra="按记录的最后一次在线" />
    </div>

    <div class="lab-split capture-split">
      <!-- 左栏：本组命中条目 -->
      <LabPane flush :title="listTitle" :hint="`共 ${total} 条`">
        <template #ops>
          <el-button size="small" :icon="Refresh" @click="load">刷新</el-button>
        </template>

        <div class="list-col">
          <div class="lab-toolbar" style="padding: 12px 12px 0; margin-bottom: 8px">
            <el-select v-if="showKindFilter" v-model="query.kind" placeholder="类型" clearable size="small" style="width: 110px" @change="reload">
              <el-option label="网页" value="web" />
              <el-option label="邮件" value="mail" />
            </el-select>
            <el-select v-model="query.submitted" placeholder="提交" clearable size="small" style="width: 100px" @change="reload">
              <el-option label="已提交" value="1" />
              <el-option label="未提交" value="0" />
            </el-select>
            <el-input v-model="query.keyword" size="small" placeholder="邮箱 / 令牌" style="flex: 1" @keyup.enter="reload" />
            <el-button size="small" type="primary" :icon="Search" @click="reload">查询</el-button>
          </div>

          <div class="hit-list">
            <div
              v-for="row in rows"
              :key="row.id"
              class="hit-item"
              :class="{ 'is-on': current?.id === row.id }"
              @click="detail(row)"
            >
              <div class="hit-top">
                <span class="lab-chip" :class="row.kind === 'web' ? 'is-accent' : 'is-warn'">{{ row.kind === 'web' ? '网页' : '邮件' }}</span>
                <span class="hit-name lab-strong">{{ row.target_email || shortToken(row.token) }}</span>
                <span v-if="row.submitted" class="lab-chip is-danger">已提交</span>
              </div>
              <div class="hit-meta lab-hint is-mute">
                <span>{{ fmt(row.last_seen_at || row.first_seen_at) }}</span>
                <span>· {{ row.form?.length || 0 }} 条字段</span>
              </div>
            </div>
            <div v-if="!rows.length" class="lab-empty">{{ emptyHint }}</div>
          </div>

          <div class="pager-row">
            <el-pagination
              small
              layout="total, prev, pager, next"
              :total="total"
              :page-size="query.page_size"
              :current-page="query.page"
              @current-change="(p) => { query.page = p; load(); }"
            />
          </div>
        </div>
      </LabPane>

      <!-- 右栏：上钩记录详情 -->
      <div class="lab-stack">
        <template v-if="current">
          <LabPane title="上钩记录详情" :hint="`记录UUID ${current.id}`">
            <template #ops>
              <el-button size="small" type="danger" plain :icon="Delete" @click="remove(current)">删除该记录</el-button>
            </template>
            <div class="lab-kv" style="row-gap: 6px">
              <span>类型：<b>{{ current.kind === 'web' ? '网页采集' : '邮件采集' }}</b></span>
              <span>目标邮箱：<b>{{ current.target_email || '未知' }}</b></span>
              <span>令牌：<b class="lab-mono" style="padding: 1px 6px">{{ current.token || '-' }}</b></span>
              <span v-if="current.context?.task_title">发送任务：<b>{{ current.context.task_title }}</b></span>
              <span v-if="current.context?.template_name">网站模板：<b>{{ current.context.template_name }}</b></span>
              <span>首次打开：<b>{{ current.first_seen_at || '-' }}</b></span>
              <span>最后在线：<b>{{ current.last_seen_at || '-' }}</b></span>
              <span>提交时间：<b>{{ current.submitted_at || '未提交' }}</b></span>
              <span v-if="current.note">备注：<b>{{ current.note }}</b></span>
            </div>
          </LabPane>

          <LabPane title="设备与行为特征">
            <div class="lab-kv" style="row-gap: 6px">
              <span>系统：<b>{{ feature.os || '未知' }}</b></span>
              <span>浏览器：<b>{{ feature.browser || '未知' }}</b></span>
              <span>IPv4：<b class="lab-mono" style="padding: 1px 6px">{{ feature.ipv4 || '未知' }}</b></span>
              <span>IPv6：<b class="lab-mono" style="padding: 1px 6px">{{ feature.ipv6 || '-' }}</b></span>
              <span>停留时长：<b>{{ current.dwell_seconds ?? 0 }} 秒</b></span>
            </div>
            <p class="lab-hint is-mute" style="margin: 10px 0 0">UA：{{ feature['user-agent'] || '未知' }}</p>
          </LabPane>

          <LabPane title="提交历史" :hint="`共 ${submits.length} 次提交 / ${fields.length} 条字段记录`">
            <div v-if="submits.length" class="lab-list">
              <div v-for="(g, i) in submits" :key="g.at" class="lab-list-item">
                <span class="lab-chip is-accent">第 {{ i + 1 }} 次</span>
                <span class="lab-strong">{{ g.at || '时间未记录' }}</span>
                <span class="lab-spacer" />
                <span class="lab-hint is-mute">{{ g.items.length }} 个字段：{{ g.items.map((f) => f.name).join('、') }}</span>
              </div>
            </div>
            <div v-else class="lab-empty">该条目只有打开记录，尚无字段提交。</div>
          </LabPane>

          <LabPane flush title="采集字段">
            <el-table :data="fields" size="small">
              <el-table-column prop="name" label="字段" min-width="140" />
              <el-table-column prop="value" label="采集值" min-width="220" show-overflow-tooltip />
              <el-table-column prop="at" label="记录时间" width="180" />
              <template #empty><div class="lab-empty">无字段数据。</div></template>
            </el-table>
          </LabPane>

          <LabPane v-if="current.screenshot_url" title="客户端截图">
            <el-image :src="screenshotSrc" fit="contain" style="max-height: 340px; width: 100%" />
          </LabPane>
        </template>

        <LabPane v-else title="上钩记录详情">
          <div class="lab-empty">从左侧选择一条命中条目，查看它的完整上钩记录。</div>
        </LabPane>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowLeft, Delete, Search, Refresh } from '@element-plus/icons-vue';
import http, { API_BASE } from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';

// group 为 null 表示不分组（全库上钩记录），带 id 时就是看板上点下来的那一组
const props = defineProps({
  gate: { type: Object, default: null },
  group: { type: Object, required: true },
});
defineEmits(['back']);

const rows = ref([]);
const total = ref(0);
const current = ref(null);
const query = reactive({ page: 1, page_size: 15, kind: '', submitted: '', keyword: '' });

const feature = computed(() => current.value?.feature || {});
// 后端已把 form_json 归一化为 [{ name, value, at }] 扁平数组
const fields = computed(() => (Array.isArray(current.value?.form) ? current.value.form : []));
const submits = computed(() => {
  const groups = new Map();
  for (const f of fields.value) {
    const key = f.at || '';
    if (!groups.has(key)) groups.set(key, { at: key, items: [] });
    groups.get(key).items.push(f);
  }
  return [...groups.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
});

const screenshotSrc = computed(() =>
  current.value?.screenshot_url ? API_BASE + current.value.screenshot_url.replace(/^\/api/, '') : ''
);

/** 看板的口径与这里的过滤口径必须一致，否则点进去的数字对不上板上的数字 */
const scopeParams = computed(() => {
  const g = props.group;
  if (g.group === 'none') return { unassigned: '1' };
  if (!g.id) return {};
  if (g.group === 'web') return { kind: 'web', site_id: g.id };
  return { task_id: g.id };
});

// 网页组里只有网页侧记录，类型筛选没有意义；全库与邮件组才有邮件/网页两种记录
const showKindFilter = computed(() => props.group?.group !== 'web');
const listTitle = computed(() => (props.group?.group === 'all' ? '命中条目' : '本组命中条目'));
const openCount = computed(() => (props.group?.group === 'mail' ? (props.group.mail_opens || 0) + (props.group.page_opens || 0) : props.group?.page_opens || 0));
// 网页组关心"采到了哪些字段"，邮件组关心"邮件之后有没有走到网页"，同一格给两个组各说各的重点
const thirdMetric = computed(() =>
  props.group?.group === 'mail'
    ? { label: '链接点开次数', value: props.group.page_opens || 0, unit: '次', extra: '邮件打开后走到网页' }
    : { label: '采到的字段', value: props.group?.field_names.length, unit: '个', extra: props.group?.field_names.join('、') || '尚无字段' }
);
const emptyHint = computed(() => {
  if (props.group?.group === 'all') return '暂无命中条目。';
  return props.group?.terminals ? '这一组暂时没有符合条件的记录。' : '这一组还没有上钩记录：链接发出去没人打开，或打开了没人提交。';
});
const subtitle = computed(() => {
  const g = props.group;
  if (g.group === 'all') return '不分组看全部上钩记录';
  if (g.group === 'web') return `${g.address || '监听地址未知'} · 共 ${g.terminals} 个终端`;
  if (g.group === 'mail') return `收件人 ${g.recipients} · 邮件打开 ${g.mail_opens} 次 · 网页打开 ${g.page_opens} 次`;
  return `共 ${g.terminals} 条没有归属的证据`;
});

function shortToken(token) {
  return token ? `${String(token).slice(0, 8)}…` : '未知目标';
}

function fmt(value) {
  return String(value || '').replace('T', ' ').slice(0, 16) || '—';
}

async function load() {
  const data = await http.get('/records', { params: { ...scopeParams.value, ...query } });
  rows.value = data.rows;
  total.value = data.total;
}

function reload() {
  query.page = 1;
  load();
}

async function detail(row) {
  current.value = await http.get(`/records/${row.id}`);
}

async function remove(row) {
  await ElMessageBox.confirm('确认删除这条上钩记录？删除后不可恢复。', '删除确认', { type: 'warning' });
  await http.delete(`/records/${row.id}`);
  ElMessage.success('已删除');
  if (current.value?.id === row.id) current.value = null;
  load();
}

onMounted(load);
</script>

<style scoped>
.capture-split { align-items: start; }
.drill-bar { display: flex; align-items: center; gap: 12px; }
.drill-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.list-col { display: flex; flex-direction: column; min-height: 520px; }
.hit-list { flex: 1 1 auto; overflow-y: auto; max-height: 560px; padding: 0 8px; display: flex; flex-direction: column; gap: 6px; }
.hit-item {
  border: 1px solid var(--lab-line-2);
  border-radius: var(--lab-r);
  padding: 8px 10px;
  cursor: pointer;
  background: var(--lab-surface);
}
.hit-item:hover { border-color: var(--lab-accent-2); }
.hit-item.is-on { border-color: var(--lab-accent); background: var(--lab-accent-soft); }
.hit-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.hit-name { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hit-meta { display: flex; gap: 6px; margin-top: 4px; font-size: 11.5px; }
.pager-row { display: flex; justify-content: center; padding: 10px 0 12px; border-top: 1px solid var(--lab-line-2); margin-top: 8px; }
</style>
