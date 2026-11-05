<template>
  <!-- 下钻第二屏：返回条、本组四格指标、左列表右详情。右栏未选中时只放占位，不残留上一条的证据 -->
  <div class="lab-stack">
    <div class="drill-bar">
      <el-button size="small" :icon="ArrowLeft" @click="$emit('back')">返回分组</el-button>
      <div class="drill-title">
        <span class="lab-pane-t">{{ group.label }}</span>
        <span class="lab-hint">{{ subtitle }}</span>
      </div>
    </div>

    <!-- 全库视图不摆这四格：ALL_GROUP 是前端造的壳，聚合字段一律 0，摆上去就成了"本组 0 条"的假数字 -->
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
      <!-- 左栏一行 = 一个上钩终端（一条 records 行），同一令牌反复打开只占一行，逐次提交看右栏提交历史 -->
      <LabPane flush :title="listTitle" :hint="`共 ${total} 条`">
        <template #ops>
          <el-button size="small" :icon="Refresh" @click="load">刷新</el-button>
        </template>

        <div class="list-col">
          <!-- 筛选只作用于本组记录，不覆盖归属过滤；提交值用字符串 '1'/'0'，后端按字面量比较。
               处置枚举与后端 DISPOSITION_LABEL 逐字对齐，选未处置时后端连带命中 disposition 为 NULL 的老行 -->
          <div class="lab-toolbar" style="padding: 12px 12px 0; margin-bottom: 8px">
            <el-select v-if="showKindFilter" v-model="query.kind" placeholder="类型" clearable size="small" style="width: 110px" @change="reload">
              <el-option label="网页" value="web" />
              <el-option label="邮件" value="mail" />
            </el-select>
            <el-select v-model="query.submitted" placeholder="提交" clearable size="small" style="width: 100px" @change="reload">
              <el-option label="已提交" value="1" />
              <el-option label="未提交" value="0" />
            </el-select>
            <el-select v-model="query.disposition" placeholder="处置" clearable size="small" style="width: 100px" @change="reload">
              <el-option v-for="(label, value) in DISPOSITIONS" :key="value" :label="label" :value="value" />
            </el-select>
            <el-input v-model="query.keyword" size="small" placeholder="邮箱 / 令牌" style="flex: 1" @keyup.enter="reload" />
            <el-button size="small" type="primary" :icon="Search" @click="reload">查询</el-button>
          </div>

          <!-- 批量标记条：勾选状态自己管（左栏是卡片列，没有选择列），上限与后端 BATCH_LIMIT 同值 -->
          <div v-if="selected.size" class="lab-toolbar batch-bar">
            <span class="lab-strong">已选 {{ selected.size }} 条</span>
            <el-select v-model="batchDisposition" size="small" style="width: 100px">
              <el-option v-for="(label, value) in DISPOSITIONS" :key="value" :label="label" :value="value" />
            </el-select>
            <el-button size="small" type="primary" :loading="batchSaving" @click="markBatch">批量标记</el-button>
            <el-button size="small" link @click="clearSelected">清空</el-button>
          </div>

          <!-- 列表行只放邮箱（或令牌前 8 位）、处置与字段条数，采集值一律留在右栏；is-on 标出右栏正在看的那条 -->
          <div class="hit-list">
            <div
              v-for="row in rows"
              :key="row.id"
              class="hit-item"
              :class="{ 'is-on': current?.id === row.id }"
              @click="detail(row)"
            >
              <div class="hit-top">
                <!-- @click.stop：勾选一条记录不该顺带把它的详情拉进右栏 -->
                <el-checkbox :model-value="selected.has(row.id)" @click.stop @change="(v) => toggleSelect(row.id, v)" />
                <span class="lab-chip" :class="row.kind === 'web' ? 'is-accent' : 'is-warn'">{{ row.kind === 'web' ? '网页' : '邮件' }}</span>
                <span class="hit-name lab-strong">{{ row.target_email || shortToken(row.token) }}</span>
                <span v-if="row.submitted" class="lab-chip is-danger">已提交</span>
              </div>
              <div class="hit-meta lab-hint is-mute">
                <span class="lab-chip" :class="dispositionTone(row.disposition)">{{ row.disposition_label }}</span>
                <span>{{ fmt(row.last_seen_at || row.first_seen_at) }}</span>
                <span>· {{ row.form?.length || 0 }} 条字段</span>
              </div>
            </div>
            <div v-if="!rows.length" class="lab-empty">{{ emptyHint }}</div>
          </div>

          <!-- 翻页只换左栏，不清右栏已打开的详情 -->
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

      <!-- 右栏四段顺序：记录本身、设备特征、提交轮次、采集字段，截图最后；取值一律用后端视图 -->
      <div class="lab-stack">
        <template v-if="current">
          <!-- 令牌与 IP 整串展示不截断：它们是跨表串人的主键 -->
          <LabPane title="上钩记录详情" :hint="`记录编号 ${current.id}`">
            <!-- 删除是这一屏唯一的破坏性写操作：走二次确认，后端落 evidence.delete 审计；事件行与截图文件不级联删除 -->
            <template #ops>
              <el-button size="small" type="danger" plain :icon="Delete" @click="remove(current)">删除该记录</el-button>
            </template>
            <div class="lab-kv" style="row-gap: 6px">
              <span>类型：<b>{{ current.kind === 'web' ? '网页采集' : '邮件采集' }}</b></span>
              <span>目标邮箱：<b>{{ current.target_email || '未知' }}</b></span>
              <span>令牌：<b class="lab-mono" style="padding: 1px 6px">{{ current.token || '-' }}</b></span>
              <span v-if="current.context?.task_title">发送任务：<b>{{ current.context.task_title }}</b></span>
              <span v-if="current.context?.site_label">钓取的网址：<b>{{ current.context.site_label }}</b></span>
              <span v-if="current.context?.template_name">网站模板：<b>{{ current.context.template_name }}</b></span>
              <span>首次打开：<b>{{ fmt2(current.first_seen_at) }}</b></span>
              <span>最后在线：<b>{{ fmt2(current.last_seen_at) }}</b></span>
              <span>提交时间：<b>{{ current.submitted_at ? fmt2(current.submitted_at) : '未提交' }}</b></span>
              <span v-if="current.note">备注：<b>{{ current.note }}</b></span>
            </div>
            <!-- 处置标记绑本地副本 markForm，请求成功前不碰 current；备注只在改动后才随请求走，
                 后端语义是不带 note 保留原值、带空串清空 -->
            <div class="mark-block">
              <div class="lab-toolbar" style="margin-bottom: 8px">
                <span class="lab-hint">处置状态：</span>
                <el-select v-model="markForm.disposition" size="small" style="width: 110px">
                  <el-option v-for="(label, value) in DISPOSITIONS" :key="value" :label="label" :value="value" />
                </el-select>
                <el-button size="small" type="primary" :disabled="!markDirty" :loading="markSaving" @click="saveMark">保存标记</el-button>
              </div>
              <el-input
                v-model="markForm.note"
                type="textarea"
                :rows="2"
                size="small"
                :maxlength="NOTE_LIMIT"
                show-word-limit
                placeholder="备注（可选）：联系与教育情况的短句；改动过才会随保存提交，清空后保存即删除原备注"
              />
              <p class="lab-hint is-mute" style="margin: 6px 0 0">
                保存即写一条 record.disposition 审计（from→to），事后在「操作审计」页查得到是谁、什么时候标的。
              </p>
            </div>
          </LabPane>

          <!-- 设备特征只读 uaProbe 归类好的现成字段；停留时长用 ?? 不用 ||，0 秒（打开就走）也是证据 -->
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

          <!-- 提交历史按同一时刻上交的一批字段归轮，时间正序；只有打开没有提交时给一句白话说明 -->
          <LabPane title="提交历史" :hint="`共 ${submits.length} 次提交 / ${fields.length} 条字段记录`">
            <div v-if="submits.length" class="lab-list">
              <div v-for="(g, i) in submits" :key="g.at" class="lab-list-item">
                <span class="lab-chip is-accent">第 {{ i + 1 }} 次</span>
                <span class="lab-strong">{{ g.at ? fmt2(g.at) : '时间未记录' }}</span>
                <span class="lab-spacer" />
                <span class="lab-hint is-mute">{{ g.items.length }} 个字段：{{ g.items.map((f) => f.name).join('、') }}</span>
              </div>
            </div>
            <div v-else class="lab-empty">该条目只有打开记录，尚无字段提交。</div>
          </LabPane>

          <!-- 采集字段默认掩码：secret=true 的行给固定掩码串，原值不随任何 GET 到达浏览器。
               明文只能逐字段点显示明文（POST /records/:id/reveal），每看一个凭据字段后端写一条 record.secret_reveal 审计；
               取回的明文只存进本页内存的 revealed Map，切换记录即整体清空。
               成批取原值只能走导出报表的取证 CSV，那条通道有 push_logs 与 audit_logs 双留痕 -->
          <LabPane flush title="采集字段">
            <el-table :data="fields" size="small">
              <el-table-column prop="name" label="字段" min-width="140" />
              <el-table-column label="采集值" min-width="220" show-overflow-tooltip>
                <template #default="{ row, $index }">
                  <span v-if="isRevealedAt(row.name, $index)" class="lab-strong">{{ revealed.get(row.name) }}</span>
                  <span v-else>{{ row.value }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="at" label="记录时间" width="180" :formatter="(row) => fmt2(row.at)" />
              <!-- 按钮只给该字段的最后一轮：reveal 返回最后一次提交的值，挂到更早行上就是错轮次 -->
              <el-table-column label="明文" width="96">
                <template #default="{ row, $index }">
                  <el-button
                    v-if="row.secret && isLastOccurrence(row.name, $index) && !revealed.has(row.name)"
                    link
                    type="primary"
                    size="small"
                    :loading="revealing.has(row.name)"
                    @click="reveal(row.name)"
                  >显示明文</el-button>
                </template>
              </el-table-column>
              <template #empty><div class="lab-empty">无字段数据。</div></template>
            </el-table>
            <template #ft>
              <p class="lab-hint is-mute" style="margin: 0">
                有 {{ current.secret_count || 0 }} 项凭据已掩码（固定圆点串，不反映原值长度）。「显示明文」逐字段放行，
                每看一个凭据字段就写一条 record.secret_reveal 审计；同名字段多轮提交时明文取最后一轮的值。
                本页不做批量明文：要成批拿走原值只能走「导出报表」的取证 CSV，导出会同时留下推送与审计两条痕迹。
              </p>
            </template>
          </LabPane>

          <!-- 截图：有 screenshot_url 才渲染，src 走 screenshotSrc 重拼管理面前缀 -->
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
/**
 * 上钩记录下钻屏：一行一个上钩终端，证据以只读为主，删除是唯一破坏性写操作。
 * scopeParams 的过滤条件必须与看板 /records/groups 的分组口径逐字对齐，否则会出现板上 3 条、点进去 2 条。
 * 列表行不带 form/feature 大字段，点开某条才单独取一次详情。
 */
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowLeft, Delete, Search, Refresh } from '@element-plus/icons-vue';
import http, { API_BASE } from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';
import { fmtTime as ts } from '../../utils/time';

// group 是看板上点下来的那一行；全库视图由父组件造的 ALL_GROUP（group:'all'、id:null）表达
// gate 只做权限语境透传，本屏不读它
const props = defineProps({
  gate: { type: Object, default: null },
  group: { type: Object, required: true },
});
defineEmits(['back']);

// rows 是当前页命中条目，total 按当前筛选计数
const rows = ref([]);
const total = ref(0);
// current 是详情行，与左栏列表行不是同一对象（列表行没有 form/feature 大字段）
const current = ref(null);
const query = reactive({ page: 1, page_size: 15, kind: '', submitted: '', disposition: '', keyword: '' });

// 与后端 drillReport.js 的 DISPOSITION_LABEL 逐字对齐，三个下拉共用这一份
const DISPOSITIONS = { new: '未处置', contacted: '已联系', educated: '已教育', closed: '已关闭' };
// 与后端 evidenceApi.js 同名的两个上限，改了必须两边一起改
const NOTE_LIMIT = 500;
const BATCH_LIMIT = 500;

// 勾选跨页保留（批量标记常要跨页凑一批），标记成功后才整体清掉
const selected = ref(new Set());
const batchDisposition = ref('educated');
const batchSaving = ref(false);

// 单条标记绑本地副本，请求成功前不碰 current
const markForm = reactive({ disposition: 'new', note: '' });
const markSaving = ref(false);

// 明文只活在本页内存，current 一变就整体清空
const revealed = ref(new Map());
// revealing 防连点：每多一次请求后端就多一条 record.secret_reveal 审计
const revealing = ref(new Set());

/**
 * current 被整体换成另一条记录时清明文、重置标记副本：上一条的明文不能渗进下一条的同名字段行。
 * detail 取回新记录与 saveMark 合并结果都走这里。
 */
watch(current, (row) => {
  revealed.value.clear();
  markForm.disposition = row?.disposition ?? 'new';
  markForm.note = row?.note ?? '';
});

/** 详情未取到时回空对象，模板各特征字段靠 || '未知' 兜底 */
const feature = computed(() => current.value?.feature || {});
// 后端已把 form_json 归一化为 [{name,value,at,secret}]，老库的 record_content 也汇成同一形状，
// secret=true 的 value 已是掩码串；形状不对时宁可渲染空表，别让取证详情白屏
const fields = computed(() => (Array.isArray(current.value?.form) ? current.value.form : []));
/**
 * 按上交时刻 at 把扁平字段聚成一轮轮提交历史，at 缺失的归入没有时间那一轮。
 * UTC ISO 串的字典序即时间序，排序直接比字符串。
 */
const submits = computed(() => {
  const groups = new Map();
  for (const f of fields.value) {
    const key = f.at || '';
    if (!groups.has(key)) groups.set(key, { at: key, items: [] });
    groups.get(key).items.push(f);
  }
  return [...groups.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
});

/**
 * 备注按与库里现值比较，不看碰没碰过输入框：改回去等于没改。
 * 没改动就保存会给审计留一条 from==to 的噪音行。
 */
const markDirty = computed(
  () => markForm.disposition !== (current.value?.disposition ?? 'new') || markForm.note !== (current.value?.note ?? '')
);

/** 每个字段名最后一次出现的下标：reveal 只回最后一轮的值，按钮与回显都钉在那一行 */
const lastOccurrence = computed(() => {
  const map = new Map();
  fields.value.forEach((f, i) => map.set(f.name, i));
  return map;
});

/** 同名字段只提交过一次时恒为 true */
function isLastOccurrence(name, index) {
  return lastOccurrence.value.get(name) === index;
}

/** 明文只回填最后一轮那一格：回显到更早轮次等于把值错安到别的提交时刻 */
function isRevealedAt(name, index) {
  return revealed.value.has(name) && isLastOccurrence(name, index);
}

/** 处置芯片配色与看板、演练报告同一套语义：未处置黄、已联系主色、已教育绿、已关闭不上色 */
function dispositionTone(disposition) {
  return disposition === 'new' ? 'is-warn' : disposition === 'contacted' ? 'is-accent' : disposition === 'educated' ? 'is-ok' : '';
}

/** 上限 BATCH_LIMIT 在这里挡；checkbox 读 selected 本身，拒绝后自己弹回未勾选 */
function toggleSelect(id, checked) {
  if (checked && selected.value.size >= BATCH_LIMIT) {
    ElMessage.warning(`一次最多标记 ${BATCH_LIMIT} 条，请先「批量标记」掉已选的再挑`);
    return;
  }
  if (checked) selected.value.add(id);
  else selected.value.delete(id);
}

function clearSelected() {
  selected.value.clear();
}

/**
 * 后端给的 screenshot_url 是 /api/... 相对路径，管理面前缀可能是 /<面板名>/api，
 * 先剥掉 /api 再补 API_BASE，否则改过面板路径的实例上会 404。
 */
const screenshotSrc = computed(() =>
  current.value?.screenshot_url ? API_BASE + current.value.screenshot_url.replace(/^\/api/, '') : ''
);

// 未归属只认 unassigned=1（后端展开成既没任务也没站点）；全库不加归属条件；
// 网页组按 site_id 过滤并限定 kind=web；邮件组按 task_id 过滤但不限 kind：
// 邮件点开后又交了网页表单的记录 kind 是 web，仍属这条邮件链
const scopeParams = computed(() => {
  const g = props.group;
  if (g.group === 'none') return { unassigned: '1' };
  if (!g.id) return {};
  if (g.group === 'web') return { kind: 'web', site_id: g.id };
  return { task_id: g.id };
});

// 网页组里只有网页记录，类型筛选无意义；邮件组出现 kind='web' 的行是同一条链，正常
const showKindFilter = computed(() => props.group?.group !== 'web');
// 全库视图不叫"本组"，避免误读成还有一个没看到的组
const listTitle = computed(() => (props.group?.group === 'all' ? '命中条目' : '本组命中条目'));
/** 邮件组把 mail_opens 与 page_opens 相加：同一目标在一条链上的两个环节都算打开 */
const openCount = computed(() => (props.group?.group === 'mail' ? (props.group.mail_opens || 0) + (props.group.page_opens || 0) : props.group?.page_opens || 0));
// 网页组看采到的字段，邮件组看有没有走到网页；返回值直接喂 LabMetric，四个键必须齐全
const thirdMetric = computed(() =>
  props.group?.group === 'mail'
    ? { label: '链接点开次数', value: props.group.page_opens || 0, unit: '次', extra: '邮件打开后走到网页' }
    : { label: '采到的字段', value: props.group?.field_names.length, unit: '个', extra: props.group?.field_names.join('、') || '尚无字段' }
);
/** 空态分三种说法，避免操作员把筛空了读成证据丢了 */
const emptyHint = computed(() => {
  if (props.group?.group === 'all') return '暂无命中条目。';
  return props.group?.terminals ? '这一组暂时没有符合条件的记录。' : '这一组还没有上钩记录：链接发出去没人打开，或打开了没人提交。';
});
/** 返回条副标题按组类型给一行上下文；地址与收件人数取自看板的聚合结果，本屏不再回查载体表 */
const subtitle = computed(() => {
  const g = props.group;
  if (g.group === 'all') return '不分组看全部上钩记录';
  if (g.group === 'web') return `${g.address || '监听地址未知'} · 共 ${g.terminals} 个终端`;
  if (g.group === 'mail') return `收件人 ${g.recipients} · 邮件打开 ${g.mail_opens} 次 · 网页打开 ${g.page_opens} 次`;
  return `共 ${g.terminals} 条没有归属的证据`;
});

/** 没邮箱时宁可显示令牌前 8 位：匿名记录全写成未知目标就分不清是哪台终端 */
function shortToken(token) {
  return token ? `${String(token).slice(0, 8)}…` : '未知目标';
}

function fmt(value) {
  return ts(value);
}

// 详情时间是拿去取证的：只到分会把首次打开和提交时间看成同一分钟
function fmt2(value) {
  return ts(value, { seconds: true, dash: '-' });
}

/**
 * 取本组命中条目：GET /records。空串条件照发，后端把 falsy 值当不加条件。
 * 只覆写 rows/total 不动 current；请求失败时左栏保持上次的行，免得被读成记录被删了。
 */
async function load() {
  const data = await http.get('/records', { params: { ...scopeParams.value, ...query } });
  rows.value = data.rows;
  total.value = data.total;
}

/** 筛选变化时页码归 1，带着旧偏移查新条件会得到一张空列表 */
function reload() {
  query.page = 1;
  load();
}

/**
 * 取单条完整证据：GET /records/:id。列表不带 form_json/feature_json 大字段，
 * 既是为性能，也是让采集值的最小可见范围停在逐条点开。
 */
async function detail(row) {
  current.value = await http.get(`/records/${row.id}`);
}

/**
 * 删除一条上钩证据：取消确认时 ElMessageBox reject，什么都不发生。事件行与截图文件不级联清理，后端写 evidence.delete 审计。
 * 删完必须 load()：当前页会错位，末页删空就是一片空白。只删右栏正看着那条时才清 current。
 */
async function remove(row) {
  await ElMessageBox.confirm('确认删除这条上钩记录？删除后不可恢复。', '删除确认', { type: 'warning' });
  try {
    await http.delete(`/records/${row.id}`);
    ElMessage.success('已删除');
    if (current.value?.id === row.id) current.value = null;
    load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

/**
 * 批量标记：POST /records/disposition。updated < requested 说明勾着已被删掉的记录，差额必须让操作员看见。
 * 后端写 record.disposition_batch 审计；右栏那条也在批量里时重取详情，否则处置下拉停在旧状态。失败保留勾选，可直接重试。
 */
async function markBatch() {
  batchSaving.value = true;
  try {
    const data = await http.post('/records/disposition', { ids: [...selected.value], disposition: batchDisposition.value });
    const label = DISPOSITIONS[batchDisposition.value];
    if (data.updated < data.requested) {
      ElMessage.warning(`已标记 ${data.updated} 条为「${label}」，另有 ${data.requested - data.updated} 条记录已不存在`);
    } else {
      ElMessage.success(`已标记 ${data.updated} 条为「${label}」`);
    }
    if (current.value && selected.value.has(current.value.id)) detail({ id: current.value.id });
    clearSelected();
    load();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    batchSaving.value = false;
  }
}

/**
 * 保存单条标记：PATCH /records/:id。没动备注时不发 note 键，否则审计里的 note_changed 会记成 true。
 * 返回的行没有 context/screenshot_url，用展开合并；整体替换会抹掉右栏的归属与截图块。
 */
async function saveMark() {
  const body = { disposition: markForm.disposition };
  // 与 markDirty 同口径：清空到 '' 也算改动，后端会照单清空
  if (markForm.note !== (current.value?.note ?? '')) body.note = markForm.note;
  markSaving.value = true;
  try {
    const data = await http.patch(`/records/${current.value.id}`, body);
    current.value = { ...current.value, ...data };
    ElMessage.success('处置标记已保存');
    load();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    markSaving.value = false;
  }
}

/**
 * 取一个字段明文：POST /records/:id/reveal。同名字段多轮提交时后端只回最后一轮的值。
 * 凭据字段每次查看都落一条 record.secret_reveal 审计；失败时单元格保持掩码。
 */
async function reveal(name) {
  if (revealing.value.has(name)) return;
  revealing.value.add(name);
  try {
    const data = await http.post(`/records/${current.value.id}/reveal`, { field: name });
    revealed.value.set(name, data.value);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    revealing.value.delete(name);
  }
}

// 本屏每次由看板点出来都是新建的组件（返回时 v-else 销毁），所以不需要 watch(props.group)
onMounted(load);
</script>

<style scoped>
.capture-split { align-items: start; }
.drill-bar { display: flex; align-items: center; gap: 12px; }
.drill-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.list-col { display: flex; flex-direction: column; min-height: 520px; }
/* 底色取 fill-2，嵌在面板里的那一档 */
.batch-bar { padding: 6px 12px; margin-bottom: 8px; border: 1px solid var(--lab-line-2); border-radius: var(--lab-r); background: var(--lab-fill-2); }
/* 写操作区与只读证据之间隔一条线 */
.mark-block { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--lab-line-2); }
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
