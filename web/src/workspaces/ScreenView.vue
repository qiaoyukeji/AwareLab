<template>
  <div class="screen">
    <!-- 风险评分口径由后端算：100 表示无人提交内容，越低越危险 -->
    <header class="scr-top">
      <div class="scr-id">
        <span class="scr-mark">AL</span>
        <div class="scr-name">
          <b>AwareLab</b>
          <small>安全意识演练 · 观测视图</small>
        </div>
      </div>

      <div class="scr-state">
        <!-- 无生效授权时平台已锁、站点全部停听 -->
        <span class="scr-chip" :class="basic.authorization ? 'is-ok' : 'is-danger'">
          <i class="scr-dot" :class="{ 'is-live': !!basic.authorization }" />
          {{ basic.authorization ? `授权生效 · ${basic.authorization}` : '平台已锁 · 无生效授权' }}
        </span>
        <span class="scr-chip">运行中网站 {{ basic.running_sites ?? 0 }}</span>
        <span class="scr-chip">风险评分 {{ basic.risk_score ?? 100 }}</span>
      </div>

      <div class="scr-side">
        <span class="scr-clock">{{ clock }}</span>
        <button class="scr-btn" type="button" @click="fullscreen">全屏</button>
        <router-link to="/console" class="scr-btn is-back">返回控制台</router-link>
      </div>
    </header>

    <main class="scr-grid">
      <!-- 左列：累计与漏斗，数据来自 /stats/home 一次聚合，不做前端二次计算 -->
      <section class="scr-col">
        <div class="scr-card">
          <h3 class="scr-t">累计情况</h3>
          <div class="scr-kpis">
            <div v-for="k in kpis" :key="k.label" class="scr-kpi">
              <div class="scr-kpi-v" :style="{ color: k.color }">{{ k.value }}</div>
              <div class="scr-kpi-k">{{ k.label }}</div>
            </div>
          </div>
        </div>

        <div class="scr-card scr-grow">
          <h3 class="scr-t">中招漏斗<span class="scr-sub">以打开数为基准</span></h3>
          <!-- 三条横道分母统一是打开数，第一条恒满格；2% 起底见 funnelRows -->
          <div class="scr-funnel">
            <div v-for="f in funnelRows" :key="f.key" class="scr-frow">
              <div class="scr-fline">
                <span>{{ f.label }}</span>
                <b>{{ f.value }}</b>
              </div>
              <div class="scr-track">
                <i class="scr-fill" :style="{ width: f.pct + '%', background: f.color }" />
              </div>
            </div>
          </div>
          <!-- 邮件侧转化率分母是全部登记收件人，与网页侧口径不可混用 -->
          <p class="scr-note">
            邮件链路：收件人 {{ mail.recipients ?? 0 }} · 已打开 {{ mail.opened ?? 0 }} · 已提交 {{ mail.submitted ?? 0 }} · 转化率 {{ mail.conversion ?? 0 }}%。
            风险评分 100 代表本次演练无人提交内容。
          </p>
        </div>
      </section>

      <section class="scr-col">
        <div class="scr-card scr-grow">
          <h3 class="scr-t">近七日打开 / 未提交 / 已提交<span class="scr-sub">10 秒轮询</span></h3>
          <Chart :option="trendOption" :height="trendHeight" />
        </div>
        <div class="scr-card">
          <h3 class="scr-t">网站分布<span class="scr-sub">端口占用</span></h3>
          <!-- 模板读 s.listen_port 与 s.domain，site_overview 目前回的是 port / template_name，取不到的项渲染成空串 -->
          <div class="scr-sites">
            <div v-for="s in sites" :key="s.id" class="scr-site">
              <span class="scr-site-name">{{ s.template_name || s.domain || '网站' }}:{{ s.listen_port }}</span>
              <div class="scr-track"><i class="scr-fill" :style="{ width: sitePct(s) + '%' }" /></div>
              <b>{{ s.opened }} / {{ s.submitted }}</b>
            </div>
            <p v-if="!sites.length" class="scr-note">当前没有钓鱼网站。</p>
          </div>
        </div>
      </section>

      <section class="scr-col">
        <div class="scr-card">
          <h3 class="scr-t">UA 分布<span class="scr-sub">浏览器 / 终端</span></h3>
          <Chart :option="uaOption" height="200px" />
          <div class="scr-os">
            <span v-for="o in osList" :key="o.name" class="scr-chip">{{ o.name }} {{ o.value }}</span>
            <span v-if="!osList.length" class="scr-note">暂无终端信息</span>
          </div>
        </div>

        <div class="scr-card scr-grow">
          <h3 class="scr-t">最新命中<span class="scr-sub">{{ records.length }} 条记录</span></h3>
          <div class="scr-feed">
            <div class="scr-track-list">
              <div v-for="(r, i) in feedLoop" :key="`${r.id}-${i}`" class="scr-item">
                <!-- 无邮箱的行只露令牌前 8 位；/stats/bigscreen 不发 form_json，口令不进这一层 -->
                <i class="scr-dot" :class="r.submitted_at ? 'is-hot' : 'is-open'" />
                <span class="scr-time">{{ clockOf(r.first_seen_at || r.submitted_at) }}</span>
                <span class="scr-target">{{ r.target_email || `令牌 ${String(r.token || '').slice(0, 8)}` }}</span>
                <span class="scr-kind" :class="r.kind === 'web' ? 'is-web' : 'is-mail'">{{ r.kind === 'web' ? '假登录页' : '邮件' }}</span>
                <span class="scr-dwell">{{ r.dwell_seconds ?? 0 }}s</span>
              </div>
              <p v-if="!records.length" class="scr-note">暂无命中：网站未开启或还没有目标访问。</p>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
/** 观测大屏（/screen 独立整屏页，不套管理端外壳）：只读投屏，数据来自 /stats/home（10 秒轮询）与 /stats/bigscreen。
 *  屏上 target_email 与 token 是明文，只允许本机或受控内网投影，不进截图外发；管理路径与端口不显示在本屏。 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import http from '../api/client';
import Chart from '../components/Chart.vue';
import { fmtClock } from '../utils/time';

// TEAL/GOLD/RED 是已打开/未提交/已提交的语义色，KPI、漏斗、趋势共用，集中在这里改
const AXIS = '#7d94b0';
const SPLIT = 'rgba(126, 156, 196, .14)';
const TEAL = '#2fb8a6';
const GOLD = '#e0b15c';
const RED = '#e0596b';

// /stats/home 整包响应；先给空骨架，模板 ?? 兜底才不会首帧报 undefined
const stats = ref({ basic: {}, web_stats: {}, mail_stats: {}, os_buckets: {}, browser_buckets: {}, funnel: {}, trend: [], site_overview: [] });
// /stats/bigscreen 最新 50 条上钩流水，只喂右侧滚动条带
const records = ref([]);
const clock = ref('');
// 趋势图高度：挂载时按视口算一次，中途拉伸窗口不重算
const trendHeight = ref('300px');
// 数据 10 秒 / 时钟 1 秒两条独立定时器，卸载时必须各自 clear
let timer = null;
let clockTimer = null;

// 以下 computed 只取子树兜空对象：轮询失败也不该把整屏炸成白页
/** 顶栏基础量：running_sites / risk_score / authorization（null=平台已锁） */
const basic = computed(() => stats.value.basic || {});
/** 网页侧统计，转化率分母是打开数 */
const web = computed(() => stats.value.web_stats || {});
/** 邮件侧统计，分母是全部登记收件人，与网页侧口径不可混用 */
const mail = computed(() => stats.value.mail_stats || {});
/** 漏斗三元组，与 web_stats 同源 */
const funnel = computed(() => stats.value.funnel || {});
/** 站点分布只取前 6：大屏扫一眼场景，全量去钓鱼网站工作区看 */
const sites = computed(() => (stats.value.site_overview || []).slice(0, 6));

/**
 * 左上 KPI；?? 0 兜底，空格会被读成组件坏了。
 * 第一格取 running_sites 但标签写"进行中任务"，取值与文案口径不一致，只标注不改展示。
 */
const kpis = computed(() => [
  { label: '进行中任务', value: basic.value.running_sites ?? 0, color: TEAL },
  { label: '已打开终端', value: web.value.opened ?? 0, color: '#9fd0c8' },
  { label: '已提交内容', value: web.value.submitted ?? 0, color: RED },
  { label: '整体转化率', value: `${web.value.conversion ?? 0}%`, color: GOLD },
]);

/** 漏斗三行，宽度分母是打开数；分母 0 时 pct=0，非零值兜 2% 起底防止画出来像没渲染 */
const funnelRows = computed(() => {
  const base = funnel.value.opened || 0;
  const row = (key, label, color) => {
    const value = funnel.value[key] ?? 0;
    return { key, label, value, color, pct: base ? Math.max(2, Math.round((value / base) * 100)) : 0 };
  };
  return [row('opened', '已打开', TEAL), row('not_submitted', '打开未提交', GOLD), row('submitted', '已提交内容', RED)];
});

/** os_buckets 是 {名称: 计数} 对象，转数组只为 v-for 写 key */
const osList = computed(() => Object.entries(stats.value.os_buckets || {}).map(([name, value]) => ({ name, value })));

/** 滚动条带数据：整份记录铺两遍，配合样式 translateY(-50%) 循环动画才无缝；空列表返回空数组 */
const feedLoop = computed(() => (records.value.length ? [...records.value, ...records.value] : []));

/** 站点横条宽度相对列表最热站点而非总量，用总量会把主次抹平；max(1,…) 防除零，3% 起底 */
function sitePct(s) {
  const max = Math.max(1, ...sites.value.map((x) => x.opened || 0));
  return Math.max(3, Math.round(((s.opened || 0) / max) * 100));
}

/** 后端 UTC 串转本机时区 HH:MM:SS */
function clockOf(iso) {
  return fmtClock(iso);
}

/** 浏览器分布环形饼图；前三个色沿用三态语义色，配色只保证头几名 */
const uaOption = computed(() => {
  const entries = Object.entries(stats.value.browser_buckets || {});
  return {
    color: [TEAL, GOLD, RED, '#5ec5d6', '#8fa9cd', '#3aa871', '#6c7a89'],
    tooltip: { trigger: 'item', textStyle: { fontSize: 12 } },
    legend: { bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { color: AXIS, fontSize: 11 } },
    series: [{
      type: 'pie',
      radius: ['48%', '70%'],
      center: ['50%', '42%'],
      itemStyle: { borderColor: '#15202b', borderWidth: 2 },
      label: { color: AXIS, fontSize: 11, formatter: '{b} {d}%' },
      // 无命中时画占位扇区，空图在投屏上像组件挂了
      data: entries.length ? entries.map(([name, value]) => ({ name, value })) : [{ name: '暂无数据', value: 1 }],
    }],
  };
});

/**
 * 近七日三条折线。后端按 UTC 日历日分桶、本机时区展示，跨零点"今天"先低后补不是丢数据；
 * 缺数据的日子后端已补 0，前端不插值，补出来的点会变成假趋势。
 */
const trendOption = computed(() => {
  const rows = stats.value.trend || [];
  return {
    grid: { left: 40, right: 16, top: 30, bottom: 28 },
    tooltip: { trigger: 'axis', textStyle: { fontSize: 12 } },
    legend: { top: 0, right: 0, itemWidth: 8, textStyle: { color: AXIS, fontSize: 11 } },
    // slice(5) 只留 MM-DD
    xAxis: { type: 'category', data: rows.map((r) => String(r.date).slice(5)), axisLabel: { color: AXIS }, axisTick: { show: false }, axisLine: { lineStyle: { color: SPLIT } } },
    // minInterval: 1 防出半格刻度，整数命中数不该出现 0.5 刻度线
    yAxis: { type: 'value', minInterval: 1, axisLabel: { color: AXIS }, splitLine: { lineStyle: { color: SPLIT } } },
    series: [
      // 已打开是另两条的分母，铺面积底
      { name: '已打开', type: 'line', smooth: true, data: rows.map((r) => r.opened), itemStyle: { color: TEAL }, areaStyle: { opacity: 0.12 } },
      { name: '未提交', type: 'line', smooth: true, data: rows.map((r) => r.not_submitted), itemStyle: { color: GOLD } },
      { name: '已提交', type: 'line', smooth: true, data: rows.map((r) => r.submitted), itemStyle: { color: RED } },
    ],
  };
});

/**
 * 一轮拉取都是只读 GET。home 展开合并，字段缺失时保留上一轮值，数字不跳回 0；home 不 catch，失败留旧值、控制台报错。
 * bigscreen 单独 try：流水拉不到只清右侧列表，不带走整屏数字。
 */
async function load() {
  stats.value = { ...stats.value, ...(await http.get('/stats/home')) };
  try {
    const screen = await http.get('/stats/bigscreen');
    records.value = screen?.records || [];
  } catch {
    records.value = [];
  }
}

/** 全屏；可选链防非安全上下文下 requestFullscreen 为 undefined 抛 TypeError，且只能由用户手势触发 */
function fullscreen() {
  document.documentElement.requestFullscreen?.();
}

/** 顶栏挂钟本地刷新不打接口，hour12:false 取 24 小时制 */
function tick() {
  clock.value = new Date().toLocaleString('zh-CN', { hour12: false });
}

onMounted(() => {
  load();
  tick();
  // 10 秒轮询是值守场景折中，不至于让后端每轮全捞三张表
  timer = setInterval(load, 10000);
  clockTimer = setInterval(tick, 1000);
  // 高度=视口 34%，下限 280px；只在挂载算一次，缩放窗口后需重开大屏
  trendHeight.value = `${Math.max(280, Math.round(window.innerHeight * 0.34))}px`;
});

// /screen 是路由级组件，不清定时器会切页后继续打统计接口
onUnmounted(() => {
  clearInterval(timer);
  clearInterval(clockTimer);
});
</script>

<style scoped>
.screen {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 14px 18px 18px;
  background: radial-gradient(circle at 18% -10%, #22384a 0%, var(--lab-ink) 48%, #0c141c 100%);
  color: #d6e2ea;
}

.scr-top { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 1px solid rgba(126, 156, 196, .18); }
.scr-id { display: flex; align-items: center; gap: 10px; }
.scr-mark { width: 30px; height: 30px; display: grid; place-items: center; border-radius: var(--lab-r); background: var(--lab-accent); color: #fff; font-size: 12px; font-weight: 800; }
.scr-name b { display: block; font-size: 15px; letter-spacing: 1px; color: #eaf2f6; }
.scr-name small { display: block; font-size: 11px; color: #7d94b0; }
.scr-state { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.scr-side { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.scr-clock { font-family: Consolas, "Cascadia Mono", monospace; font-size: 13px; color: #9fb6c9; font-variant-numeric: tabular-nums; }
.scr-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 10px; border-radius: var(--lab-r);
  background: transparent; border: 1px solid rgba(126, 156, 196, .32);
  color: #bcd0e0; font-size: 12px; cursor: pointer; text-decoration: none;
}
.scr-btn:hover { border-color: var(--lab-accent-2); color: #eafaf6; }
.scr-btn.is-back { border-color: rgba(47, 184, 166, .45); color: #8fd8cb; }
.scr-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
  background: rgba(126, 156, 196, .12); border: 1px solid rgba(126, 156, 196, .22); color: #b7c8d6;
}
.scr-chip.is-ok { background: rgba(47, 184, 166, .16); border-color: rgba(47, 184, 166, .4); color: #7fd8c9; }
.scr-chip.is-danger { background: rgba(224, 89, 107, .16); border-color: rgba(224, 89, 107, .42); color: #f0a2ac; }

.scr-grid { flex: 1 1 auto; display: grid; grid-template-columns: 300px minmax(0, 1fr) 360px; gap: 14px; padding-top: 14px; }
.scr-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.scr-card { background: rgba(255, 255, 255, .035); border: 1px solid rgba(126, 156, 196, .18); border-radius: var(--lab-r); padding: 12px 14px; }
.scr-grow { flex: 1 1 auto; min-height: 0; }
.scr-t { margin: 0 0 10px; font-size: 13px; font-weight: 700; color: #cfe3ea; letter-spacing: .5px; }
.scr-sub { margin-left: 8px; font-size: 11px; font-weight: 400; color: #6f869e; }

.scr-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.scr-kpi { background: rgba(126, 156, 196, .07); border: 1px solid rgba(126, 156, 196, .14); border-radius: var(--lab-r-sm); padding: 10px; text-align: center; }
.scr-kpi-v { font-size: 22px; font-weight: 700; font-family: Consolas, "Cascadia Mono", monospace; line-height: 1.2; }
.scr-kpi-k { font-size: 11.5px; color: #8aa2b8; margin-top: 3px; }

.scr-funnel { display: flex; flex-direction: column; gap: 12px; }
.scr-fline { display: flex; justify-content: space-between; font-size: 12px; color: #a9bfd0; margin-bottom: 4px; }
.scr-fline b { font-family: Consolas, "Cascadia Mono", monospace; color: #eaf2f6; }
.scr-track { height: 6px; border-radius: 3px; background: rgba(126, 156, 196, .18); overflow: hidden; }
.scr-fill { display: block; height: 100%; background: var(--lab-accent-2); border-radius: 3px; transition: width .5s; }

.scr-note { margin: 10px 0 0; font-size: 11.5px; color: #7d94b0; line-height: 1.7; }

.scr-sites { display: flex; flex-direction: column; gap: 9px; }
.scr-site { display: grid; grid-template-columns: 150px minmax(0, 1fr) 62px; align-items: center; gap: 10px; font-size: 11.5px; color: #a9bfd0; }
.scr-site-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scr-site b { font-family: Consolas, "Cascadia Mono", monospace; color: #eaf2f6; text-align: right; }

.scr-os { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }

.scr-feed { height: 240px; overflow: hidden; position: relative; }
.scr-feed:hover .scr-track-list { animation-play-state: paused; }
.scr-track-list { animation: scr-scroll 26s linear infinite; }
.scr-item { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 6px 0; border-bottom: 1px dashed rgba(126, 156, 196, .16); }
.scr-time { font-family: Consolas, "Cascadia Mono", monospace; color: #8aa2b8; }
.scr-target { color: #dbe7ee; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.scr-kind { font-size: 11px; padding: 0 6px; border-radius: 999px; border: 1px solid rgba(126, 156, 196, .28); color: #a9bfd0; }
.scr-kind.is-web { border-color: rgba(47, 184, 166, .45); color: #7fd8c9; }
.scr-kind.is-mail { border-color: rgba(224, 177, 92, .45); color: #e0b15c; }
.scr-dwell { color: #7d94b0; font-family: Consolas, "Cascadia Mono", monospace; }
.scr-dot { width: 7px; height: 7px; border-radius: 50%; background: #5c7389; display: inline-block; flex: 0 0 auto; }
.scr-dot.is-open { background: #7d94b0; }
.scr-dot.is-hot { background: #e0596b; box-shadow: 0 0 8px rgba(224, 89, 107, .8); }
.scr-dot.is-live { background: var(--lab-accent-2); box-shadow: 0 0 8px rgba(47, 184, 166, .75); animation: scr-pulse 2s infinite; }

@keyframes scr-scroll { from { transform: translateY(0); } to { transform: translateY(-50%); } }
@keyframes scr-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

@media (max-width: 1400px) {
  .scr-grid { grid-template-columns: 260px minmax(0, 1fr) 300px; }
}
@media (max-width: 1100px) {
  .scr-grid { grid-template-columns: 1fr; }
}
</style>
