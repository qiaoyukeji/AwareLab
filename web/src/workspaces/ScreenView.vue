<template>
  <div class="screen">
    <div class="scr-bg" aria-hidden="true" />

    <header class="scr-top">
      <div class="scr-id">
        <span class="scr-mark">AL</span>
        <div class="scr-name">
          <b>AwareLab</b>
          <small>安全意识演练 · 观测视图</small>
        </div>
      </div>

      <!-- 切屏选择器：总屏 + 每个钓鱼网站 + 每个发送任务，都在这一处；点选即时换屏，不跳回控制台 -->
      <div class="scr-pick-wrap" :class="{ 'is-open': picker }">
        <button class="scr-pick" type="button" @click="picker = !picker">
          <span class="scr-pick-kind">{{ KIND_LABEL[kind] }}</span>
          <b class="scr-pick-title">{{ title }}</b>
          <span class="scr-caret">▾</span>
        </button>
        <div v-if="picker" class="scr-panel">
          <button type="button" class="scr-panel-item" :class="{ 'is-on': kind === 'all' }" @click="goScreen('all', 'all')">
            <span class="scr-dot is-live" />
            <span class="scr-panel-t">全局观测</span>
            <span class="scr-panel-n">{{ catalogue.overall?.opened ?? 0 }} / {{ catalogue.overall?.submitted ?? 0 }}</span>
          </button>

          <div class="scr-panel-h">钓鱼网站 · {{ catalogue.sites.length }}</div>
          <button v-for="s in catalogue.sites" :key="s.id" type="button" class="scr-panel-item"
            :class="{ 'is-on': kind === 'site' && screenId === s.id }" @click="goScreen('site', s.id)">
            <span class="scr-dot" :class="{ 'is-live': s.status === 'open' }" />
            <span class="scr-panel-t">{{ s.title }}</span>
            <span class="scr-panel-n">{{ s.opened }} / {{ s.submitted }}</span>
          </button>
          <p v-if="!catalogue.sites.length" class="scr-panel-empty">还没有钓鱼网站。</p>

          <div class="scr-panel-h">发送任务 · {{ catalogue.tasks.length }}</div>
          <button v-for="t in catalogue.tasks" :key="t.id" type="button" class="scr-panel-item"
            :class="{ 'is-on': kind === 'task' && screenId === t.id }" @click="goScreen('task', t.id)">
            <span class="scr-dot" :class="{ 'is-live': t.status === 'sent' }" />
            <span class="scr-panel-t">{{ t.title }}</span>
            <span class="scr-panel-n">{{ t.opened }} / {{ t.submitted }}</span>
          </button>
          <p v-if="!catalogue.tasks.length" class="scr-panel-empty">还没有发送任务。</p>
        </div>
      </div>

      <div class="scr-state">
        <span class="scr-chip" :class="basic.authorization ? 'is-ok' : 'is-danger'">
          <i class="scr-dot" :class="{ 'is-live': !!basic.authorization }" />
          {{ basic.authorization ? `授权生效 · ${basic.authorization}` : '平台已锁 · 无生效授权' }}
        </span>
        <span class="scr-chip">运行中网站 {{ basic.running_sites ?? 0 }}</span>
        <span class="scr-chip">风险 {{ basic.risk_score ?? 100 }} · {{ basic.risk_level || '安全' }}</span>
      </div>

      <div class="scr-side">
        <span class="scr-tick" :class="{ 'is-on': rotate }">{{ rotate ? `轮播 ${rotateLeft}s` : '轮播关' }}</span>
        <button class="scr-btn" type="button" @click="toggleRotate">{{ rotate ? '停止轮播' : '自动轮播' }}</button>
        <span class="scr-clock">{{ clock }}</span>
        <button class="scr-btn" type="button" @click="toggleFullscreen">{{ isFull ? '退出全屏' : '全屏' }}</button>
        <router-link to="/console" class="scr-btn is-back">控制台</router-link>
      </div>
    </header>

    <p v-if="error" class="scr-error">{{ error }}</p>

    <main class="scr-body">
      <!-- 一行 KPI：不同屏换的是指标，不换版式，投屏时视线落点固定 -->
      <section class="scr-kpis">
        <div v-for="k in kpis" :key="k.label" class="scr-kpi" :class="k.tone ? `is-${k.tone}` : ''">
          <div class="scr-kpi-k">{{ k.label }}</div>
          <div class="scr-kpi-v">{{ k.value }}<small v-if="k.unit">{{ k.unit }}</small></div>
          <div class="scr-kpi-x">{{ k.extra }}</div>
        </div>
      </section>

      <div class="scr-grid">
        <div class="scr-col is-left">
          <section class="scr-card">
            <h3 class="scr-t">中招漏斗<span class="scr-sub">以打开数为基准</span></h3>
            <div class="scr-funnel">
              <div v-for="f in funnelRows" :key="f.key" class="scr-frow">
                <div class="scr-fline"><span>{{ f.label }}</span><b>{{ f.value }}</b></div>
                <div class="scr-track"><i class="scr-fill" :style="{ width: f.pct + '%', background: f.color }" /></div>
              </div>
            </div>
            <p class="scr-note">未提交 = 打开数 − 提交数，三个数永远自洽；裸访问也计入打开。</p>
          </section>

          <!-- 站点屏讲"人从哪来"，总屏与任务屏讲"邮件链路走到哪一步" -->
          <section v-if="kind === 'site'" class="scr-card">
            <h3 class="scr-t">访问来源<span class="scr-sub">打开人数构成</span></h3>
            <div class="scr-funnel">
              <div v-for="f in sourceRows" :key="f.key" class="scr-frow">
                <div class="scr-fline"><span>{{ f.label }}</span><b>{{ f.value }}</b></div>
                <div class="scr-track"><i class="scr-fill" :style="{ width: f.pct + '%', background: f.color }" /></div>
              </div>
            </div>
            <p class="scr-note">带邮件令牌进入的访问计为「邮件导流」；其余为直接访问或站内跳转。</p>
          </section>

          <section v-else class="scr-card">
            <h3 class="scr-t">邮件链路<span class="scr-sub">登记收件人为分母</span></h3>
            <div class="scr-funnel">
              <div v-for="f in mailRows" :key="f.label" class="scr-frow">
                <div class="scr-fline"><span>{{ f.label }}</span><b>{{ f.value }}</b></div>
                <div class="scr-track"><i class="scr-fill" :style="{ width: f.pct + '%', background: f.color }" /></div>
              </div>
            </div>
            <p class="scr-note">邮件打开依赖图片信标，被客户端拦截时偏保守；转化率分母用投递名单，与网页口径不可混用。</p>
          </section>

          <section v-if="kind !== 'task'" class="scr-card scr-grow">
            <h3 class="scr-t">终端分布<span class="scr-sub">系统 / 浏览器</span></h3>
            <div class="scr-os">
              <span v-for="o in osList" :key="o.name" class="scr-chip">{{ o.name }} {{ o.value }}</span>
              <span v-if="!osList.length" class="scr-note">暂无终端信息。</span>
            </div>
            <div class="scr-bars">
              <div v-for="b in browserList" :key="b.name" class="scr-bar-row">
                <span class="scr-bar-k">{{ b.name }}</span>
                <div class="scr-track"><i class="scr-fill" :style="{ width: b.pct + '%', background: 'linear-gradient(90deg, #2fb8a6, #5ec5d6)' }" /></div>
                <b>{{ b.value }}</b>
              </div>
            </div>
            <p class="scr-note is-pin">
              共 {{ web.opened ?? 0 }} 个终端 · {{ osList.length }} 类系统 · {{ browserList.length }} 种浏览器
            </p>
          </section>

          <!-- 任务屏没有网页终端数据，这一格换成比率，别留一块空白 -->
          <section v-else class="scr-card scr-grow">
            <h3 class="scr-t">关键比率<span class="scr-sub">分母均为登记收件人</span></h3>
            <div class="scr-bars">
              <div v-for="r in taskRates" :key="r.label" class="scr-bar-row">
                <span class="scr-bar-k">{{ r.label }}</span>
                <div class="scr-track"><i class="scr-fill" :style="{ width: r.pct + '%', background: r.color }" /></div>
                <b>{{ r.value }}%</b>
              </div>
            </div>
            <p class="scr-note">点击率低于打开率是常态：邮件客户端会预取图片，但不会替人点链接。</p>
          </section>
        </div>

        <div class="scr-col is-center">
          <section class="scr-card">
            <h3 class="scr-t">{{ trendTitle }}<span class="scr-sub">{{ trendSub }}</span></h3>
            <Chart :option="trendOption" :height="trendHeight" />
          </section>

          <section v-if="kind === 'all'" class="scr-card scr-grow">
            <h3 class="scr-t">网站墙<span class="scr-sub">点卡片进入单站大屏</span></h3>
            <div class="scr-wall">
              <button v-for="s in siteTiles" :key="s.id" type="button" class="scr-tile" @click="goScreen('site', s.id)">
                <span class="scr-tile-top">
                  <i class="scr-dot" :class="{ 'is-live': s.status === 'open' }" />
                  <b class="scr-tile-t">{{ s.title }}</b>
                </span>
                <span class="scr-tile-n"><b>{{ s.opened }}</b> 打开 · <b>{{ s.submitted }}</b> 提交</span>
                <span class="scr-track is-mini"><i class="scr-fill" :style="{ width: tilePct(s) + '%' }" /></span>
                <span class="scr-tile-x">{{ s.status === 'open' ? `监听中 · ${s.port}` : '已停止' }}</span>
              </button>
              <button v-if="kind === 'all' && boards.sites.length > siteTiles.length" type="button" class="scr-tile is-more"
                @click="goScreen('all', 'all')">
                还有 {{ boards.sites.length - siteTiles.length }} 个站点
                <small>去「钓鱼网站」查看全部</small>
              </button>
              <p v-if="!boards.sites.length" class="scr-note">还没有钓鱼网站。</p>
            </div>
          </section>

          <section v-else class="scr-card scr-grow">
            <h3 class="scr-t">最新命中<span class="scr-sub">{{ records.length }} 条</span></h3>
            <div class="scr-feed">
              <div class="scr-feed-h"><span>时间</span><span>对象</span><span>类型</span><span>停留</span></div>
              <div class="scr-feed-b">
                <div v-for="r in records" :key="r.id" class="scr-item">
                  <span class="scr-time">
                    <i class="scr-dot" :class="r.submitted_at ? 'is-hot' : 'is-open'" />{{ clockOf(r.first_seen_at || r.submitted_at) }}
                  </span>
                  <span class="scr-target">{{ r.target_email || `令牌 ${String(r.token || '').slice(0, 8)}` }}</span>
                  <span class="scr-kind" :class="r.kind === 'web' ? 'is-web' : 'is-mail'">{{ r.kind === 'web' ? '网页' : '邮件' }}</span>
                  <span class="scr-dwell">{{ r.kind === 'web' ? `${r.dwell_seconds ?? 0}s` : '—' }}</span>
                </div>
                <p v-if="!records.length" class="scr-note">暂无命中：网站未开启或还没有目标访问。</p>
              </div>
            </div>
          </section>
        </div>

        <div class="scr-col is-right">
          <section v-if="kind === 'all'" class="scr-card scr-grow">
            <h3 class="scr-t">任务墙<span class="scr-sub">点卡片进入单任务大屏</span></h3>
            <div class="scr-wall is-col">
              <button v-for="t in taskTiles" :key="t.id" type="button" class="scr-tile" @click="goScreen('task', t.id)">
                <span class="scr-tile-top">
                  <i class="scr-dot" :class="{ 'is-live': t.status === 'sent' }" />
                  <b class="scr-tile-t">{{ t.title }}</b>
                </span>
                <span class="scr-tile-n"><b>{{ t.recipients }}</b> 收件人 · <b>{{ t.opened }}</b> 打开 · <b>{{ t.submitted }}</b> 提交</span>
                <span class="scr-tile-x">{{ t.dry_run ? '沙箱发送' : '真实发送' }} · {{ STATUS[t.status] || t.status }}</span>
              </button>
              <p v-if="!boards.tasks.length" class="scr-note">还没有发送任务。</p>
            </div>
          </section>

          <section v-else-if="kind === 'site'" class="scr-card">
            <h3 class="scr-t">站点信息<span class="scr-sub">只读</span></h3>
            <dl class="scr-kv">
              <dt>素材</dt><dd>{{ site?.template_name || '（素材已删）' }}</dd>
              <dt>监听</dt><dd class="scr-mono">{{ site?.listen_ip }}:{{ site?.listen_port }}</dd>
              <dt>协议</dt><dd>{{ site?.url?.startsWith('https') ? 'HTTPS' : 'HTTP' }}</dd>
              <dt>状态</dt><dd>{{ site?.status === 'open' ? '监听中' : '已停止' }}</dd>
              <dt>授权</dt><dd>{{ basic.authorization || '未登记' }}</dd>
              <dt>对外地址</dt><dd class="scr-mono scr-break">{{ site?.url }}</dd>
            </dl>
            <p class="scr-note">本屏只读：站点开关、专属链接与取证导出都在控制台「钓鱼网站」里操作。</p>
          </section>

          <section v-else class="scr-card">
            <h3 class="scr-t">任务信息<span class="scr-sub">只读</span></h3>
            <dl class="scr-kv">
              <dt>主题</dt><dd class="scr-break">{{ task?.subject || '（无主题）' }}</dd>
              <dt>发件人</dt><dd class="scr-break">{{ task?.sender || '（未设置）' }}</dd>
              <dt>投递</dt><dd>{{ task?.dry_run ? '沙箱留底 · 未真实外发' : '真实 SMTP' }}</dd>
              <dt>附件</dt><dd>{{ task?.attachment_name || '无' }}</dd>
              <dt>授权</dt><dd>{{ basic.authorization || '未登记' }}</dd>
              <dt>状态</dt><dd>{{ STATUS[task?.status] || task?.status }}</dd>
            </dl>
            <p class="scr-note">本屏只读：收件人名单、补发与详情都在控制台「钓鱼邮件」里操作。</p>
          </section>

          <section v-if="kind === 'task'" class="scr-card scr-grow">
            <h3 class="scr-t">收件人构成<span class="scr-sub">{{ mail?.recipients ?? 0 }} 人</span></h3>
            <div class="scr-chart-fill"><Chart :option="recipientOption" height="240px" /></div>
            <p class="scr-note is-pin">
              登记 {{ mail?.recipients ?? 0 }} 人 · 点开 {{ mail?.opened ?? 0 }} · 点击 {{ mail?.clicked ?? 0 }} · 提交 {{ mail?.submitted ?? 0 }}
            </p>
          </section>

          <!-- 站点屏右栏改摆"最近提交"：浏览器分布已在左栏终端分布里，重复一块不如给刚中招的名字 -->
          <section v-else-if="kind === 'site'" class="scr-card scr-grow">
            <h3 class="scr-t">最近提交<span class="scr-sub">最近 6 条</span></h3>
            <div class="scr-subs">
              <div v-for="r in recentSubmits" :key="r.id" class="scr-sub-row">
                <i class="scr-dot is-hot" />
                <span class="scr-target">{{ r.target_email || '匿名终端' }}</span>
                <span class="scr-dwell">{{ r.dwell_seconds ?? 0 }}s</span>
                <span class="scr-time">{{ clockOf(r.submitted_at) }}</span>
              </div>
              <p v-if="!recentSubmits.length" class="scr-note">还没有人提交内容。</p>
              <p class="scr-note is-pin">
                共 {{ web.submitted ?? 0 }} 条提交 · 平均停留 {{ web.avg_dwell ?? 0 }} 秒 · 邮件导流 {{ web.mail_source ?? 0 }} 人
              </p>
            </div>
          </section>

          <section v-else class="scr-card">
            <h3 class="scr-t">浏览器分布<span class="scr-sub">去标识</span></h3>
            <Chart :option="uaOption" height="180px" />
          </section>

          <section v-if="kind === 'all'" class="scr-card scr-grow">
            <h3 class="scr-t">最新命中<span class="scr-sub">{{ records.length }} 条</span></h3>
            <div class="scr-feed">
              <div class="scr-feed-h"><span>时间</span><span>对象</span><span>类型</span><span>停留</span></div>
              <div class="scr-feed-b">
                <div v-for="r in records" :key="r.id" class="scr-item">
                  <span class="scr-time">
                    <i class="scr-dot" :class="r.submitted_at ? 'is-hot' : 'is-open'" />{{ clockOf(r.first_seen_at || r.submitted_at) }}
                  </span>
                  <span class="scr-target">{{ r.target_email || `令牌 ${String(r.token || '').slice(0, 8)}` }}</span>
                  <span class="scr-kind" :class="r.kind === 'web' ? 'is-web' : 'is-mail'">{{ r.kind === 'web' ? '网页' : '邮件' }}</span>
                  <span class="scr-dwell">{{ r.kind === 'web' ? `${r.dwell_seconds ?? 0}s` : '—' }}</span>
                </div>
                <p v-if="!records.length" class="scr-note">暂无命中：网站未开启或还没有目标访问。</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>

    <footer class="scr-foot">
      <span>网页转化率分母为打开数，邮件转化率分母为登记收件人，两套口径不混算。</span>
      <span>{{ basic.authorization ? `授权：${basic.authorization}` : '未登记有效授权' }} · 刷新于 {{ age }} 秒前 · 每 8 秒自动刷新</span>
      <span class="scr-warn">仅限本机或受控内网投屏，请勿截图外发 · AwareLab {{ VERSION_TAG }}</span>
    </footer>
  </div>
</template>

<script setup>
/**
 * 观测大屏：一块总屏（/screen）+ 每个钓鱼网站（/screen/site/:id）+ 每个发送任务（/screen/task/:id）。
 * 三种屏共用同一套版式，只换标题、KPI 与两栏内容；数据来自 /stats/screen，切屏不刷新整页。
 * 屏上 target_email 与令牌是明文，只允许本机/受控内网投影；管理路径、后台密码不进入本组件。
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import http from '../api/client';
import Chart from '../components/Chart.vue';
import { fmtClock } from '../utils/time';
import { VERSION_TAG } from '../version';

// 深色屏的语义色：TEAL 已打开 / GOLD 未提交与提醒 / RED 已提交 / BLUE 中性
const AXIS = '#7d94b0';
const SPLIT = 'rgba(126, 156, 196, .14)';
const TEAL = '#2fb8a6';
const GOLD = '#e0b15c';
const RED = '#e0596b';
const BLUE = '#5ec5d6';

const KIND_LABEL = { all: '总览大屏', site: '站点大屏', task: '任务大屏' };
const STATUS = { draft: '草稿', sending: '发送中', sent: '已发送', failed: '失败', sandboxed: '沙箱' };
const ROTATE_SECONDS = 18;
const REFRESH_MS = 8000;

const route = useRoute();
const router = useRouter();

/** 当前屏类型：路由段优先，兼容旧链接 /screen 当总屏。 */
const kind = computed(() => (route.path.startsWith('/screen/site') ? 'site' : route.path.startsWith('/screen/task') ? 'task' : 'all'));
const screenId = computed(() => String(route.params.id || ''));

/** 空骨架：首帧与拉取失败时模板里的 ?? 都靠它兜底，不至于整屏白掉。 */
function blank() {
  return {
    meta: {}, basic: {}, web_stats: {}, mail_stats: null, funnel: {},
    trend: [], os_buckets: {}, browser_buckets: {}, records: [], site: null, task: null, boards: null,
  };
}

const data = ref(blank());
const catalogue = ref({ overall: null, sites: [], tasks: [] });
const clock = ref('');
const age = ref(0);
const error = ref('');
const picker = ref(false);
const rotate = ref(false);
const rotateLeft = ref(ROTATE_SECONDS);
const isFull = ref(false);
const trendHeight = ref('320px');

const basic = computed(() => data.value.basic || {});
const web = computed(() => data.value.web_stats || {});
const mail = computed(() => data.value.mail_stats || null);
const meta = computed(() => data.value.meta || {});
const site = computed(() => data.value.site || null);
const task = computed(() => data.value.task || null);
const records = computed(() => data.value.records || []);
// 站点屏右栏的"最近提交"：只列真的交过内容的记录，给投屏观众看"刚刚谁中招"
const recentSubmits = computed(() => records.value.filter((r) => r.submitted_at).slice(0, 6));
const boards = computed(() => data.value.boards || { sites: [], tasks: [] });

/** 屏标题：404 时还能显示"这条线"，比空标题好定位。 */
const title = computed(() => meta.value.title || (kind.value === 'all' ? '全局观测' : '观测对象'));

/** 百分比：分母 0 回 0，避免 NaN 上屏。 */
function pct(n, d) {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

/** 顶栏 KPI 随屏类型换指标，版式不动。 */
const kpis = computed(() => {
  if (kind.value === 'task') {
    const m = mail.value || {};
    return [
      { label: '登记收件人', value: m.recipients ?? 0, unit: '人', extra: '任务名单总数' },
      { label: '已发出', value: m.sent ?? 0, unit: '封', extra: task.value?.dry_run ? '沙箱留底，未真实外发' : '真实 SMTP 投递' },
      { label: '已打开', value: m.opened ?? 0, unit: '人', extra: `打开率 ${pct(m.opened, m.recipients)}%` },
      { label: '已点击', value: m.clicked ?? 0, unit: '人', extra: `点击率 ${pct(m.clicked, m.recipients)}%` },
      { label: '已提交', value: m.submitted ?? 0, unit: '人', extra: '交回内容的人数', tone: 'hot' },
      { label: '提交转化', value: `${m.conversion ?? 0}%`, extra: '分母为登记收件人' },
    ];
  }
  if (kind.value === 'site') {
    return [
      { label: '已打开', value: web.value.opened ?? 0, unit: '人', extra: '唯一终端计一次' },
      { label: '已提交', value: web.value.submitted ?? 0, unit: '人', extra: `未提交 ${web.value.not_submitted ?? 0}` },
      { label: '转化率', value: `${web.value.conversion ?? 0}%`, extra: '提交 / 打开', tone: 'hot' },
      { label: '平均停留', value: web.value.avg_dwell ?? 0, unit: '秒', extra: '仅统计已提交记录' },
      { label: '邮件导流', value: web.value.mail_source ?? 0, unit: '人', extra: '带邮件令牌进入' },
      { label: '未受骗率', value: `${basic.value.risk_score ?? 100}%`, extra: basic.value.risk_level || '安全', tone: 'warn' },
    ];
  }
  return [
    { label: '运行中网站', value: basic.value.running_sites ?? 0, unit: '个', extra: '授权内正在监听' },
    { label: '已打开终端', value: web.value.opened ?? 0, unit: '人', extra: '网页侧去重' },
    { label: '已提交内容', value: web.value.submitted ?? 0, unit: '人', extra: '真的把内容交回来了', tone: 'hot' },
    { label: '邮件收件人', value: mail.value?.recipients ?? 0, unit: '人', extra: `已打开 ${mail.value?.opened ?? 0}` },
    { label: '整体转化率', value: `${web.value.conversion ?? 0}%`, extra: '网页侧提交 / 打开' },
    { label: '未受骗率', value: `${basic.value.risk_score ?? 100}%`, extra: basic.value.risk_level || '安全', tone: 'warn' },
  ];
});

/** 网页漏斗三行，分母是打开数；非零值 2% 起底，否则细线看着像没渲染。 */
const funnelRows = computed(() => {
  const f = data.value.funnel || {};
  const base = f.opened || 0;
  const row = (key, label, color) => {
    const value = f[key] ?? 0;
    return { key, label, value, color, pct: base ? Math.max(2, Math.round((value / base) * 100)) : 0 };
  };
  return [row('opened', '已打开', TEAL), row('not_submitted', '打开未提交', GOLD), row('submitted', '已提交内容', RED)];
});

/** 邮件链路四行，分母是登记收件人；mail_stats 为空时（站点屏）不渲染这一块。 */
const mailRows = computed(() => {
  const m = mail.value;
  if (!m) return [];
  const base = m.recipients || 0;
  const row = (label, value, color) => ({
    label,
    value: value ?? 0,
    color,
    pct: base ? (value ? Math.max(2, Math.round((value / base) * 100)) : 0) : 0,
  });
  return [
    row('登记收件人', m.recipients, BLUE),
    row('已打开邮件', m.opened, TEAL),
    row('点过链接', m.clicked ?? 0, GOLD),
    row('已提交内容', m.submitted, RED),
  ];
});

/** 站点屏的访问来源：带 task_id 的网页记录算邮件导流，其余算直接访问。 */
const sourceRows = computed(() => {
  const fromMail = web.value.mail_source ?? 0;
  const direct = Math.max(0, (web.value.opened ?? 0) - fromMail);
  const base = Math.max(1, web.value.opened ?? 0);
  return [
    { key: 'mail', label: '邮件导流', value: fromMail, color: GOLD, pct: fromMail ? Math.max(2, Math.round((fromMail / base) * 100)) : 0 },
    { key: 'direct', label: '直接访问', value: direct, color: TEAL, pct: direct ? Math.max(2, Math.round((direct / base) * 100)) : 0 },
  ];
});

/** 任务屏的关键比率，三条都除以登记收件人，横向可比。 */
const taskRates = computed(() => {
  const m = mail.value || {};
  const base = m.recipients || 0;
  return [
    { label: '打开率', value: pct(m.opened, base), pct: pct(m.opened, base), color: TEAL },
    { label: '点击率', value: pct(m.clicked, base), pct: pct(m.clicked, base), color: GOLD },
    { label: '提交率', value: pct(m.submitted, base), pct: pct(m.submitted, base), color: RED },
  ];
});

/** os_buckets 是 {名称: 计数}，转数组排序后取前 8，长尾不占屏。 */
const osList = computed(() => Object.entries(data.value.os_buckets || {})
  .map(([name, value]) => ({ name, value }))
  .sort((a, b) => b.value - a.value)
  .slice(0, 8));

/** 浏览器横条：宽度相对最多的那个，3% 起底保证可见。 */
const browserList = computed(() => {
  const entries = Object.entries(data.value.browser_buckets || {})
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
  const max = Math.max(1, ...entries.map((e) => e.value));
  return entries.map((e) => ({ ...e, pct: Math.max(3, Math.round((e.value / max) * 100)) }));
});

/** 网站墙只摆前 8 个：投屏一屏扫得完，其余去控制台看。 */
const siteTiles = computed(() => (boards.value.sites || []).slice(0, 8));
const taskTiles = computed(() => (boards.value.tasks || []).slice(0, 8));

/** 墙上的小横条相对最热站点，不用总量，否则主次被抹平。 */
function tilePct(s) {
  const max = Math.max(1, ...siteTiles.value.map((x) => x.opened || 0));
  return Math.max(3, Math.round(((s.opened || 0) / max) * 100));
}

/** 趋势图标题与口径随屏类型换。 */
const trendTitle = computed(() => (kind.value === 'task' ? '邮件触达趋势' : '近七日打开与提交'));
const trendSub = computed(() => (kind.value === 'task' ? '按收件人打开/提交日期分桶' : '按首次访问日期分桶 · 8 秒轮询'));

/** 趋势：网页屏三条线（打开/未提交/提交），任务屏打开用柱、提交用线，避免两条线贴在一起分不清。 */
const trendOption = computed(() => {
  const rows = data.value.trend || [];
  const dates = rows.map((r) => String(r.date).slice(5));
  const base = {
    grid: { left: 44, right: 20, top: 34, bottom: 26 },
    tooltip: { trigger: 'axis', textStyle: { fontSize: 12 } },
    legend: { top: 0, right: 0, itemWidth: 8, itemHeight: 8, textStyle: { color: AXIS, fontSize: 11 } },
    xAxis: { type: 'category', data: dates, axisLabel: { color: AXIS }, axisTick: { show: false }, axisLine: { lineStyle: { color: SPLIT } } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { color: AXIS }, splitLine: { lineStyle: { color: SPLIT } } },
  };
  if (kind.value === 'task') {
    return {
      ...base,
      series: [
        { name: '打开', type: 'bar', barWidth: '38%', data: rows.map((r) => r.opened), itemStyle: { color: 'rgba(47,184,166,.55)', borderRadius: [3, 3, 0, 0] } },
        { name: '提交', type: 'line', smooth: true, symbolSize: 6, data: rows.map((r) => r.submitted), itemStyle: { color: RED }, lineStyle: { width: 2 } },
      ],
    };
  }
  return {
    ...base,
    series: [
      { name: '已打开', type: 'line', smooth: true, showSymbol: false, data: rows.map((r) => r.opened), itemStyle: { color: TEAL }, areaStyle: { opacity: 0.16 } },
      { name: '未提交', type: 'line', smooth: true, showSymbol: false, data: rows.map((r) => r.not_submitted), itemStyle: { color: GOLD } },
      { name: '已提交', type: 'line', smooth: true, showSymbol: false, data: rows.map((r) => r.submitted), itemStyle: { color: RED } },
    ],
  };
});

/** 浏览器环形图；无数据时画占位扇区，空图在投屏上像组件挂了。 */
const uaOption = computed(() => {
  const entries = Object.entries(data.value.browser_buckets || {});
  return {
    color: [TEAL, GOLD, RED, BLUE, '#8fa9cd', '#3aa871', '#6c7a89'],
    tooltip: { trigger: 'item', textStyle: { fontSize: 12 } },
    legend: { bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { color: AXIS, fontSize: 11 } },
    series: [{
      type: 'pie',
      radius: ['46%', '68%'],
      center: ['50%', '42%'],
      itemStyle: { borderColor: '#0f1a24', borderWidth: 2 },
      label: { color: AXIS, fontSize: 11, formatter: '{b} {d}%' },
      data: entries.length ? entries.map(([name, value]) => ({ name, value })) : [{ name: '暂无数据', value: 1 }],
    }],
  };
});

/** 任务屏的收件人构成：已提交 / 打开未提交 / 未打开，三段之和等于名单数。 */
const recipientOption = computed(() => {
  const m = mail.value || {};
  const submitted = m.submitted || 0;
  const opened = Math.max(0, (m.opened || 0) - submitted);
  const untouched = Math.max(0, (m.recipients || 0) - (m.opened || 0));
  return {
    color: [RED, GOLD, 'rgba(126,156,196,.45)'],
    tooltip: { trigger: 'item', textStyle: { fontSize: 12 } },
    legend: { bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { color: AXIS, fontSize: 11 } },
    series: [{
      type: 'pie',
      radius: ['48%', '70%'],
      center: ['50%', '46%'],
      itemStyle: { borderColor: '#0f1a24', borderWidth: 2 },
      // 右栏只有 380px，外置标签会被裁掉；占比在左栏"关键比率"与顶栏 KPI 里已经给过
      label: { show: false },
      labelLine: { show: false },
      data: [
        { name: '已提交', value: submitted },
        { name: '打开未提交', value: opened },
        { name: '未打开', value: untouched },
      ],
    }],
  };
});

/** 后端 UTC 串转本机 HH:MM:SS。 */
const clockOf = (iso) => fmtClock(iso);

/** 切屏：选择器点选与网站墙/任务墙共用；replace 不进历史，轮播不会把返回键塞满。 */
function goScreen(nextKind, id) {
  picker.value = false;
  const target = nextKind === 'all' ? { name: 'screen' } : { name: `screen-${nextKind}`, params: { id } };
  if (kind.value === nextKind && (nextKind === 'all' || screenId.value === id)) return;
  router.push(target);
}

/** 目录只用于选择器与墙；新站点/新任务在下一轮刷新出现。 */
async function loadCatalogue() {
  try {
    catalogue.value = await http.get('/stats/screens');
  } catch {
    // 目录挂了不该把屏打空：保留上一份，选择器还能切已有屏
  }
}

/** 一轮数据；失败保留上一轮数字并显示提示，投屏最怕的是突然全 0。 */
async function load() {
  try {
    const params = kind.value === 'all' ? { kind: 'all' } : { kind: kind.value, id: screenId.value };
    data.value = { ...blank(), ...(await http.get('/stats/screen', { params })) };
    error.value = '';
  } catch (e) {
    error.value = e.message || '数据拉取失败，稍后自动重试';
  }
  age.value = 0;
}

/** 浏览器原生全屏；只能由用户手势触发，失败静默（非安全上下文下 API 可能不存在）。 */
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.();
}

const onFullChange = () => { isFull.value = !!document.fullscreenElement; };

/** 轮播：按目录顺序循环总屏 → 各站点 → 各任务；切到不存在的屏由后端 404，下一轮会自动跳过。 */
const screens = computed(() => {
  const list = [{ kind: 'all', id: 'all' }];
  for (const s of catalogue.value.sites || []) list.push({ kind: 'site', id: s.id });
  for (const t of catalogue.value.tasks || []) list.push({ kind: 'task', id: t.id });
  return list;
});

function nextScreen() {
  const list = screens.value;
  if (list.length <= 1) return;
  const at = list.findIndex((s) => s.kind === kind.value && (s.kind === 'all' || s.id === screenId.value));
  const next = list[(at + 1) % list.length];
  goScreen(next.kind, next.id);
}

function toggleRotate() {
  rotate.value = !rotate.value;
  rotateLeft.value = ROTATE_SECONDS;
}

/** 秒针：时钟、刷新龄、轮播倒计时共用一次节流，别为三个数字挂三个定时器。 */
function tick() {
  clock.value = new Date().toLocaleString('zh-CN', { hour12: false });
  age.value += 1;
  if (!rotate.value) return;
  rotateLeft.value -= 1;
  if (rotateLeft.value <= 0) {
    rotateLeft.value = ROTATE_SECONDS;
    nextScreen();
  }
}

/** 点空白关选择器：只认面板外部，按钮自身的点击由 @click.stop 处理。 */
function onDocClick(e) {
  if (!picker.value) return;
  if (!e.target.closest?.('.scr-pick-wrap')) picker.value = false;
}

let dataTimer = null;
let clockTimer = null;

onMounted(() => {
  loadCatalogue();
  load();
  tick();
  trendHeight.value = `${Math.max(240, Math.round(window.innerHeight * 0.3))}px`;
  dataTimer = setInterval(() => { load(); loadCatalogue(); }, REFRESH_MS);
  clockTimer = setInterval(tick, 1000);
  document.addEventListener('fullscreenchange', onFullChange);
  document.addEventListener('click', onDocClick);
});

onUnmounted(() => {
  clearInterval(dataTimer);
  clearInterval(clockTimer);
  document.removeEventListener('fullscreenchange', onFullChange);
  document.removeEventListener('click', onDocClick);
});

// 切屏复用同一个组件：路由参数一变就重新拉数据，缓存目录不必重拉
watch([kind, screenId], () => { load(); });
</script>

<style scoped>
.screen {
  position: relative;
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 14px 18px 12px;
  overflow: hidden;
  color: #d6e2ea;
  background:
    radial-gradient(1100px 640px at 14% -14%, rgba(47, 184, 166, .16), transparent 62%),
    radial-gradient(900px 520px at 92% 0%, rgba(94, 197, 214, .1), transparent 58%),
    linear-gradient(160deg, #101d28 0%, #0c141c 52%, #0a1118 100%);
}

/* 极淡的网格：让整屏有"监控墙"的质感，但不跟数字抢注意力 */
.scr-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(126, 156, 196, .05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(126, 156, 196, .05) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(circle at 50% 12%, #000 0%, transparent 82%);
}

.scr-top {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(126, 156, 196, .18);
}
.scr-id { display: flex; align-items: center; gap: 10px; }
.scr-mark {
  width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px;
  background: linear-gradient(145deg, var(--lab-accent), var(--lab-accent-2));
  color: #fff; font-size: 12px; font-weight: 800; letter-spacing: .5px;
  box-shadow: 0 0 18px rgba(47, 184, 166, .35);
}
.scr-name b { display: block; font-size: 15px; letter-spacing: 1.2px; color: #eaf2f6; }
.scr-name small { display: block; font-size: 11px; color: #7d94b0; }

/* 切屏选择器 */
.scr-pick-wrap { position: relative; }
.scr-pick {
  display: inline-flex; align-items: center; gap: 8px;
  max-width: 380px; padding: 5px 10px 5px 8px;
  background: rgba(126, 156, 196, .08);
  border: 1px solid rgba(126, 156, 196, .26);
  border-radius: 999px; color: #e6f1f5; cursor: pointer;
}
.scr-pick:hover { border-color: rgba(47, 184, 166, .5); }
.scr-pick-kind {
  font-size: 10.5px; font-weight: 700; letter-spacing: .5px;
  padding: 1px 7px; border-radius: 999px; color: #8fe0d2;
  background: rgba(47, 184, 166, .16); border: 1px solid rgba(47, 184, 166, .32);
}
.scr-pick-title { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scr-caret { font-size: 10px; color: #8aa2b8; }
.scr-panel {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 20;
  width: 340px; max-height: 62vh; overflow: auto;
  padding: 6px; border-radius: 10px;
  background: #121f2a; border: 1px solid rgba(126, 156, 196, .3);
  box-shadow: 0 18px 40px rgba(0, 0, 0, .55);
}
.scr-panel-h { padding: 8px 8px 4px; font-size: 10.5px; letter-spacing: .8px; color: #6f869e; }
.scr-panel-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 8px; border: 0; border-radius: 6px;
  background: transparent; color: #c3d4e0; font-size: 12px; text-align: left; cursor: pointer;
}
.scr-panel-item:hover { background: rgba(126, 156, 196, .12); }
.scr-panel-item.is-on { background: rgba(47, 184, 166, .14); color: #eafaf6; }
.scr-panel-t { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scr-panel-n { font-family: Consolas, "Cascadia Mono", monospace; font-size: 11px; color: #8aa2b8; }
.scr-panel-empty { margin: 2px 8px 6px; font-size: 11.5px; color: #6f869e; }

.scr-state { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.scr-side { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.scr-clock { font-family: Consolas, "Cascadia Mono", monospace; font-size: 13px; color: #9fb6c9; font-variant-numeric: tabular-nums; }
.scr-tick { font-size: 11px; color: #6f869e; }
.scr-tick.is-on { color: #8fe0d2; }
.scr-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 10px; border-radius: 6px;
  background: rgba(126, 156, 196, .06);
  border: 1px solid rgba(126, 156, 196, .3);
  color: #bcd0e0; font-size: 12px; cursor: pointer; text-decoration: none;
}
.scr-btn:hover { border-color: rgba(47, 184, 166, .55); color: #eafaf6; }
.scr-btn.is-back { border-color: rgba(47, 184, 166, .42); color: #8fd8cb; }

.scr-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
  background: rgba(126, 156, 196, .12); border: 1px solid rgba(126, 156, 196, .22); color: #b7c8d6;
}
.scr-chip.is-ok { background: rgba(47, 184, 166, .16); border-color: rgba(47, 184, 166, .4); color: #7fd8c9; }
.scr-chip.is-danger { background: rgba(224, 89, 107, .16); border-color: rgba(224, 89, 107, .42); color: #f0a2ac; }

.scr-error {
  position: relative; z-index: 1; margin: 8px 0 0; padding: 6px 12px;
  border-radius: 6px; font-size: 12px; color: #f0c2c8;
  background: rgba(224, 89, 107, .14); border: 1px solid rgba(224, 89, 107, .35);
}

.scr-body { position: relative; z-index: 1; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding-top: 10px; }

.scr-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.scr-kpi {
  position: relative; padding: 10px 12px; border-radius: 10px;
  background: linear-gradient(180deg, rgba(255, 255, 255, .055), rgba(255, 255, 255, .028));
  border: 1px solid rgba(126, 156, 196, .18);
  overflow: hidden;
}
.scr-kpi::before { content: ""; position: absolute; left: 0; top: 0; width: 3px; height: 100%; background: rgba(47, 184, 166, .55); }
.scr-kpi.is-hot::before { background: rgba(224, 89, 107, .7); }
.scr-kpi.is-warn::before { background: rgba(224, 177, 92, .7); }
.scr-kpi-k { font-size: 11px; color: #8aa2b8; letter-spacing: .3px; }
.scr-kpi-v {
  margin-top: 4px; font-family: "DIN Alternate", Consolas, "Cascadia Mono", monospace;
  font-size: clamp(22px, 1.9vw, 34px); font-weight: 700; line-height: 1.1; color: #eef6f9;
  font-variant-numeric: tabular-nums;
}
.scr-kpi-v small { margin-left: 3px; font-size: 11px; font-weight: 500; color: #7d94b0; }
.scr-kpi-x { margin-top: 3px; font-size: 10.5px; color: #6f869e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.scr-grid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 330px minmax(0, 1fr) 380px; gap: 12px; }
.scr-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; }
.scr-card {
  position: relative;
  background: linear-gradient(180deg, rgba(255, 255, 255, .05), rgba(255, 255, 255, .02));
  border: 1px solid rgba(126, 156, 196, .18);
  border-radius: 10px;
  padding: 12px 14px;
  min-height: 0;
  display: flex; flex-direction: column;
}
.scr-card::before {
  content: ""; position: absolute; left: 14px; right: 14px; top: 0; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(47, 184, 166, .5), transparent);
}
.scr-grow { flex: 1 1 auto; }
.scr-t { margin: 0 0 8px; font-size: 12.5px; font-weight: 700; color: #cfe3ea; letter-spacing: .4px; }
.scr-sub { margin-left: 8px; font-size: 10.5px; font-weight: 400; color: #6f869e; letter-spacing: 0; }

.scr-funnel { display: flex; flex-direction: column; gap: 11px; }
.scr-fline { display: flex; justify-content: space-between; font-size: 11.5px; color: #a9bfd0; margin-bottom: 4px; }
.scr-fline b { font-family: Consolas, "Cascadia Mono", monospace; color: #eaf2f6; }
.scr-track { display: block; height: 6px; border-radius: 3px; background: rgba(126, 156, 196, .18); overflow: hidden; }
.scr-track.is-mini { height: 4px; }
.scr-fill { display: block; height: 100%; border-radius: 3px; transition: width .6s ease; box-shadow: 0 0 10px rgba(47, 184, 166, .25); }

.scr-note { margin: 8px 0 0; font-size: 10.5px; color: #7d94b0; line-height: 1.65; }
/* 卡片底部钉一行口径：数据少时也不至于整块空着 */
.scr-note.is-pin { margin-top: auto; padding-top: 10px; border-top: 1px dashed rgba(126, 156, 196, .14); }

.scr-os { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.scr-bars { display: flex; flex-direction: column; gap: 8px; }
.scr-bar-row { display: grid; grid-template-columns: 74px minmax(0, 1fr) 34px; align-items: center; gap: 8px; font-size: 11px; color: #a9bfd0; }
.scr-bar-k { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scr-bar-row b { font-family: Consolas, "Cascadia Mono", monospace; color: #eaf2f6; text-align: right; }

.scr-wall { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 8px; align-content: start; overflow: auto; }
.scr-wall.is-col { grid-template-columns: 1fr; }
.scr-tile {
  display: flex; flex-direction: column; gap: 5px;
  padding: 9px 10px; text-align: left; cursor: pointer;
  border-radius: 8px; color: #c3d4e0;
  background: rgba(126, 156, 196, .07);
  border: 1px solid rgba(126, 156, 196, .18);
}
.scr-tile:hover { border-color: rgba(47, 184, 166, .5); background: rgba(47, 184, 166, .08); transform: translateY(-1px); }
.scr-tile.is-more { align-items: center; justify-content: center; color: #7d94b0; font-size: 11.5px; text-align: center; }
.scr-tile.is-more small { display: block; margin-top: 3px; font-size: 10px; color: #5f7488; }
.scr-tile-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.scr-tile-t { font-size: 12px; color: #e6f1f5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scr-tile-n { font-size: 11px; color: #8aa2b8; }
.scr-tile-n b { font-family: Consolas, "Cascadia Mono", monospace; color: #dbe7ee; }
.scr-tile-x { font-size: 10px; color: #6f869e; }

.scr-kv { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 6px 10px; margin: 0; font-size: 11.5px; }
.scr-kv dt { color: #6f869e; }
.scr-kv dd { margin: 0; color: #dbe7ee; }
.scr-mono { font-family: Consolas, "Cascadia Mono", monospace; }
.scr-break { word-break: break-all; }

.scr-feed { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
.scr-feed-h {
  display: grid; grid-template-columns: 88px minmax(0, 1fr) 56px 44px; gap: 8px;
  padding: 0 0 6px; font-size: 10px; color: #6f869e; border-bottom: 1px solid rgba(126, 156, 196, .16);
}
.scr-feed-b { flex: 1 1 auto; min-height: 0; overflow: auto; }
.scr-item {
  display: grid; grid-template-columns: 88px minmax(0, 1fr) 56px 44px; gap: 8px; align-items: center;
  padding: 6px 0; font-size: 11.5px; border-bottom: 1px dashed rgba(126, 156, 196, .14);
}
.scr-time { display: flex; align-items: center; gap: 6px; font-family: Consolas, "Cascadia Mono", monospace; color: #8aa2b8; }
.scr-target { color: #dbe7ee; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scr-kind { font-size: 10px; padding: 0 5px; border-radius: 999px; border: 1px solid rgba(126, 156, 196, .28); color: #a9bfd0; text-align: center; white-space: nowrap; }
.scr-kind.is-web { border-color: rgba(47, 184, 166, .45); color: #7fd8c9; }
.scr-kind.is-mail { border-color: rgba(224, 177, 92, .45); color: #e0b15c; }
.scr-dwell { color: #7d94b0; font-family: Consolas, "Cascadia Mono", monospace; text-align: right; white-space: nowrap; }
.scr-subs { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: auto; }
/* 高卡片里的环图垂直居中；子元素拉满宽度，否则 echarts 初始化时容器宽为 0 */
.scr-chart-fill { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; justify-content: center; }
.scr-chart-fill > * { width: 100%; }
.scr-sub-row {
  display: grid; grid-template-columns: 10px minmax(0, 1fr) 44px 62px; gap: 8px; align-items: center;
  padding: 7px 0; font-size: 11.5px; border-bottom: 1px dashed rgba(126, 156, 196, .14);
}
.scr-dot { width: 7px; height: 7px; border-radius: 50%; background: #5c7389; display: inline-block; flex: 0 0 auto; }
.scr-dot.is-open { background: #7d94b0; }
.scr-dot.is-hot { background: #e0596b; box-shadow: 0 0 8px rgba(224, 89, 107, .8); }
.scr-dot.is-live { background: var(--lab-accent-2); box-shadow: 0 0 8px rgba(47, 184, 166, .75); animation: scr-pulse 2s infinite; }

.scr-foot {
  position: relative; z-index: 1;
  display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
  padding-top: 8px; margin-top: 10px; border-top: 1px solid rgba(126, 156, 196, .16);
  font-size: 10.5px; color: #6f869e;
}
.scr-foot .scr-warn { color: #a8815c; }

@keyframes scr-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

@media (max-width: 1560px) {
  .scr-grid { grid-template-columns: 300px minmax(0, 1fr) 340px; }
  .scr-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 1180px) {
  .screen { height: auto; min-height: 100vh; overflow: visible; }
  .scr-grid { grid-template-columns: 1fr; }
  .scr-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .scr-feed-b { max-height: 320px; }
  .scr-wall { max-height: 420px; }
}
</style>
