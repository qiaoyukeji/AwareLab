<template>
  <div class="board">
    <!-- ① 授权 hero：先确认「现在到底能不能开工」 -->
    <LabPane
      class="hero-pane"
      :class="{ 'is-blocked': !gate }"
      title="授权状态"
      :hint="gate ? '建站、开启监听与邮件发送都以这条授权为准' : '平台已锁定，任何建站与发信都会被拒绝'"
    >
      <template #ops>
        <span class="lab-chip" :class="gate ? 'is-ok' : 'is-danger'">
          <span class="lab-dot" :class="{ 'is-live': !!gate }" />
          {{ gate ? '授权生效中' : '平台已锁' }}
        </span>
        <el-button size="small" @click="go('/mandate')">{{ gate ? '调整授权' : '去登记授权' }}</el-button>
      </template>

      <div v-if="gate" class="hero">
        <div class="hero-top">
          <div class="hero-scope">
            <span class="lab-strong hero-subject">{{ gate.scope }}</span>
            <span class="lab-hint">对接人 {{ gate.contact || '—' }} · 授权名单 {{ hostsOf(gate).length }} 条</span>
          </div>
          <div class="hero-count" :class="remainClass">{{ countdown }}</div>
        </div>
        <div class="lab-bar hero-bar">
          <div class="lab-bar-fill" :class="barTone" :style="{ width: remainPct + '%' }" />
        </div>
        <div class="lab-kv">
          <span>有效期起 <b>{{ fmt(gate.start_at) }}</b></span>
          <span>有效期止 <b>{{ fmt(gate.end_at) }}</b></span>
          <span>窗口剩余 <b>{{ remainPct }}%</b></span>
        </div>
        <div class="host-row">
          <span v-for="h in hostsOf(gate)" :key="h" class="lab-chip is-accent">{{ h }}</span>
        </div>
      </div>

      <div v-else class="hero">
        <p class="lab-hint">
          <span class="lab-strong">建站与发送均被拒绝。</span>
          不在授权名单里的域名一律打不开，邮件任务也无法进入发送队列；若只是到期，直接编辑既有授权续期即可，无需重新登记。
        </p>
        <div class="lab-bar hero-bar"><div class="lab-bar-fill is-danger" style="width: 100%" /></div>
      </div>
    </LabPane>

    <!-- ② 数量指标 -->
    <div class="lab-grid" style="--cols: 4">
      <LabMetric
        label="进行中任务"
        :value="basic.running_sites ?? 0"
        extra="处于开启状态的演练任务；越近到期，剩余窗口越小"
        :tone="(basic.running_sites ?? 0) > 0 ? 'accent' : ''"
      />
      <LabMetric
        label="活跃监听网站"
        :value="assets.runningSites"
        :extra="ports.length ? `端口 ${ports.join('、')}` : '当前没有在跑的钓鱼网站端口'"
        :tone="assets.runningSites > 0 ? '' : 'warn'"
      />
      <LabMetric
        label="今日新增命中"
        :value="today.opened"
        :extra="`今日已提交 ${today.submitted} · 今日未提交 ${today.not_submitted}`"
        :tone="today.opened > 0 ? 'accent' : ''"
      />
      <LabMetric
        label="已提交命中"
        :value="web.submitted ?? 0"
        :extra="`累计命中 ${web.total_records ?? 0} · 转化率 ${web.conversion ?? 0}%`"
        :tone="(web.submitted ?? 0) > 0 ? 'danger' : ''"
      />
    </div>

    <!-- ③ 左：命中流水　右：上钩漏斗 -->
    <div class="lab-grid" style="--cols: 2">
      <LabPane title="命中流水" :hint="`最近 ${shownHits.length} 条 · 15 秒自动刷新`">
        <template #ops>
          <el-button link size="small" @click="load">立即刷新</el-button>
          <el-button link size="small" @click="go('/evidence?tab=capture')">全部记录</el-button>
        </template>
        <div v-if="shownHits.length" class="lab-list">
          <div
            v-for="h in shownHits"
            :key="h.id"
            class="lab-list-item hit"
            role="button"
            tabindex="0"
            @click="go('/evidence?tab=capture')"
            @keyup.enter="go('/evidence?tab=capture')"
          >
            <span class="lab-dot" :class="{ 'is-live': !!h.submitted_at }" />
            <span class="hit-target">{{ h.target_email || `令牌 ${short(h.token)}` }}</span>
            <span class="lab-chip" :class="h.kind === 'web' ? 'is-accent' : 'is-warn'">
              {{ h.kind === 'web' ? '假登录页' : '邮件链路' }}
            </span>
            <span class="lab-chip" :class="h.submitted_at ? 'is-danger' : ''">
              {{ h.submitted_at ? '已提交' : '仅打开' }}
            </span>
            <span class="lab-spacer" />
            <span class="lab-mono-lite">{{ clockOf(h.first_seen_at || h.submitted_at) }}</span>
          </div>
        </div>
        <div v-else class="lab-empty">暂无命中：网站尚未开启，或还没有目标访问过钓鱼网站。</div>
      </LabPane>

      <LabPane title="上钩漏斗" hint="以打开数为基准对比三个阶段">
        <div class="funnel">
          <div v-for="row in funnelRows" :key="row.key" class="funnel-row">
            <div class="funnel-line">
              <span class="lab-strong">{{ row.label }}</span>
              <span class="lab-hint">{{ row.hint }}</span>
              <span class="lab-kv" style="margin-left:auto">数量 <b>{{ row.value }}</b></span>
            </div>
            <div class="lab-bar">
              <div
                class="lab-bar-fill"
                :class="row.tone ? `is-${row.tone}` : ''"
                :style="{ width: pctOf(row.value) + '%' }"
              />
            </div>
          </div>
        </div>
        <div class="lab-kv funnel-foot">
          <span>转化率 <b>{{ web.conversion ?? 0 }}%</b>（已提交 / 已打开）</span>
          <span>风险评分 <b>{{ basic.risk_score ?? 100 }}</b> · {{ basic.risk_level || '安全' }}</span>
        </div>
        <p class="lab-hint is-mute">
          风险评分由中招率反推，<span class="lab-strong">100 表示全员安全</span>（无人提交），低于 70 说明本次演练命中率偏高。
        </p>
      </LabPane>
    </div>

    <!-- ④ 开工检查 -->
    <LabPane title="开工检查" hint="授权之外的六个前置条件，缺一项这一步就会被后端拒绝">
      <template #ops>
        <span class="lab-chip" :class="readyCount === readiness.length ? 'is-ok' : 'is-warn'">
          {{ readyCount }} / {{ readiness.length }} 就绪
        </span>
      </template>
      <div class="lab-list">
        <div v-for="item in readiness" :key="item.key" class="lab-list-item">
          <span class="lab-strong ready-label">{{ item.label }}</span>
          <span class="lab-hint ready-detail">{{ item.detail }}</span>
          <span class="lab-spacer" />
          <span class="lab-chip" :class="item.ok ? 'is-ok' : 'is-danger'">{{ item.ok ? '就绪' : '缺失' }}</span>
          <el-button v-if="!item.ok" size="small" @click="go(item.to)">{{ item.cta }}</el-button>
        </div>
      </div>
    </LabPane>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';

const props = defineProps({ gate: { type: Object, default: null } });
const router = useRouter();

const EMPTY_HOME = {
  basic: {}, web_stats: {}, mail_stats: {}, os_buckets: {}, browser_buckets: {},
  funnel: {}, trend: [], site_overview: [],
};

const data = ref({ ...EMPTY_HOME });
const hits = ref([]);
const assets = ref({ sites: 0, runningSites: 0, mailTemplates: 0, smtp: 0, tasks: 0 });
let timer = null;

const basic = computed(() => data.value.basic || {});
const web = computed(() => data.value.web_stats || {});
const funnel = computed(() => data.value.funnel || {});
const ports = computed(() => basic.value.listen_ports || []);

const today = computed(() => {
  const day = new Date().toISOString().slice(0, 10);
  const row = (data.value.trend || []).find((r) => r.date === day);
  return { opened: 0, submitted: 0, not_submitted: 0, ...(row || {}) };
});

function hostsOf(g) {
  return Array.isArray(g?.allowed_hosts) ? g.allowed_hosts : [];
}

function short(v) {
  return String(v || '').slice(0, 8);
}

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
}

function clockOf(iso) {
  const s = String(iso || '');
  return s.length >= 19 ? s.slice(11, 19) : fmt(iso);
}

const remainPct = computed(() => {
  const g = props.gate;
  if (!g) return 0;
  const start = new Date(g.start_at).getTime();
  const end = new Date(g.end_at).getTime();
  if (!(end > start)) return 0;
  const ratio = (end - Date.now()) / (end - start);
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
});

const remainClass = computed(() => {
  const g = props.gate;
  if (!g) return '';
  return remainPct.value < 15 ? 'is-crit' : remainPct.value < 40 ? 'is-low' : '';
});

const barTone = computed(() => (remainPct.value < 15 ? 'is-danger' : remainPct.value < 40 ? 'is-warn' : ''));

const countdown = computed(() => {
  const g = props.gate;
  if (!g) return '';
  const ms = new Date(g.end_at).getTime() - Date.now();
  if (ms <= 0) return '已到有效期止';
  const hours = ms / 3600000;
  if (hours < 1) return `剩余 ${Math.max(1, Math.round(hours * 60))} 分钟`;
  if (hours < 24) return `剩余 ${Math.round(hours)} 小时`;
  return `剩余 ${(hours / 24).toFixed(1)} 天`;
});

const shownHits = computed(() => hits.value.slice(0, 8));

const funnelRows = computed(() => [
  { key: 'opened', label: '打开假登录页', value: funnel.value.opened ?? 0, hint: 'first_seen 口径的独立终端', tone: '' },
  { key: 'not_submitted', label: '打开未提交', value: funnel.value.not_submitted ?? 0, hint: '看过但没交出内容', tone: 'warn' },
  { key: 'submitted', label: '已提交内容', value: funnel.value.submitted ?? 0, hint: '已留下完整记录', tone: 'danger' },
]);

function pctOf(v) {
  const base = funnel.value.opened || 0;
  if (!base) return 0;
  return Math.max(2, Math.round((v / base) * 100));
}

const readiness = computed(() => {
  const g = props.gate;
  return [
    {
      key: 'auth',
      label: '演练授权',
      ok: !!g,
      detail: g ? `${g.scope} · 授权名单 ${hostsOf(g).length} 条` : '没有处于生效窗口的授权记录',
      to: '/mandate',
      cta: '登记授权',
    },
    {
      key: 'page',
      label: '假登录页',
      ok: (basic.value.web_template_count ?? 0) > 0,
      detail: `${basic.value.web_template_count ?? 0} 个模板 · 分类 ${(basic.value.template_types || []).join('、') || '无'}`,
      to: '/material?tab=page',
      cta: '准备页面',
    },
    {
      key: 'mail',
      label: '邮件文案',
      ok: assets.value.mailTemplates > 0,
      detail: assets.value.mailTemplates ? `${assets.value.mailTemplates} 封正文可复用` : '还没有可用于发送的邮件文案',
      to: '/material?tab=email',
      cta: '写正文',
    },
    {
      key: 'sender',
      label: '发信邮箱',
      ok: assets.value.smtp > 0,
      detail: assets.value.smtp ? `${assets.value.smtp} 个 SMTP 配置档` : '关闭沙箱真实发信前需要一个 SMTP 配置档',
      to: '/outbound?tab=sender',
      cta: '配置账号',
    },
    {
      key: 'site',
      label: '监听网站',
      ok: assets.value.runningSites > 0,
      detail: `${assets.value.sites} 个网站档案 · ${assets.value.runningSites} 个正在监听`,
      to: '/capture',
      cta: '开启网站',
    },
    {
      key: 'task',
      label: '发送任务',
      ok: assets.value.tasks > 0,
      detail: assets.value.tasks ? `${assets.value.tasks} 个发送任务` : '尚未创建任何发送任务',
      to: '/outbound?tab=campaign',
      cta: '建任务',
    },
  ];
});

const readyCount = computed(() => readiness.value.filter((r) => r.ok).length);

function go(path) {
  router.push(path);
}

async function load() {
  data.value = { ...EMPTY_HOME, ...(await http.get('/stats/home')) };

  try {
    const screen = await http.get('/stats/bigscreen');
    hits.value = screen?.records || [];
  } catch {
    hits.value = [];
  }

  const results = await Promise.allSettled([
    http.get('/web-sites'),
    http.get('/mail-templates', { params: { page_size: 1 } }),
    http.get('/smtp-profiles'),
    http.get('/mail-tasks', { params: { page_size: 1 } }),
  ]);
  const [sites, mailTemplates, smtp, tasks] = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
  const siteRows = sites?.rows || [];
  assets.value = {
    sites: siteRows.length || sites?.total || 0,
    runningSites: siteRows.filter((s) => s.running || s.status === 'open').length,
    mailTemplates: mailTemplates?.total ?? (mailTemplates?.rows?.length || 0),
    smtp: smtp?.total ?? (smtp?.rows?.length || 0),
    tasks: tasks?.total ?? (tasks?.rows?.length || 0),
  };
}

onMounted(() => {
  load();
  timer = setInterval(load, 15000);
});

onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.board { display: flex; flex-direction: column; gap: var(--lab-gap); }
.hero-pane.is-blocked { border-left: 3px solid var(--lab-danger); }
.hero { display: flex; flex-direction: column; gap: 10px; }
.hero-top { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.hero-scope { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.hero-subject { font-size: 15px; }
.hero-count { margin-left: auto; font-size: 13px; font-weight: 700; color: var(--lab-accent); font-variant-numeric: tabular-nums; }
.hero-count.is-low { color: var(--lab-warn); }
.hero-count.is-crit { color: var(--lab-danger); }
.hero-bar { height: 8px; }
.host-row { display: flex; flex-wrap: wrap; gap: 6px; }
.hit { cursor: pointer; }
.hit:hover { border-color: var(--lab-accent); background: var(--lab-accent-soft); }
.hit-target { font-weight: 600; color: var(--lab-ink); max-width: 34ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lab-mono-lite { font-family: Consolas, "Cascadia Mono", monospace; font-size: 11.5px; color: var(--lab-ink-4); }
.funnel { display: flex; flex-direction: column; gap: 12px; }
.funnel-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 5px; }
.funnel-foot { margin: 12px 0 4px; }
.ready-label { min-width: 6em; }
.ready-detail { flex: 1 1 auto; }
</style>
