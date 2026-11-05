<!-- 控制台看板：只读屏，回答现在能不能开工、战况到哪一步、还缺哪几样前置条件；缺哪项只把操作员送去对应工作区，不在这里改数据。 -->
<!-- prop gate 是 app 层缓存的当前生效授权摘要，null 即平台锁定：hero、倒计时与开工检查第一项都读它。 -->
<!-- 命中流水带 target_email 与令牌明文，这块屏只该出现在操作员本机或受控内网；整屏 15 秒轮询，onUnmounted 必须 clearInterval。 -->
<template>
  <div class="board">
    <!-- 授权 hero：先确认现在到底能不能开工 -->
    <LabPane
      class="hero-pane"
      :class="{ 'is-blocked': !gate }"
      title="授权状态"
      :hint="gate ? '建站、开启监听与邮件发送都以这条授权为准' : '平台已锁定，任何建站与发信都会被拒绝'"
    >
      <!-- 未授权时整块加红边并把 hint 换成平台已锁定：颜色和文字一起说，扫一眼就知道这屏数字还不可信 -->
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
        <!-- 这是允许仿冒哪些域名/IP 的清单，不是站内已建的网站 -->
        <div class="host-row">
          <span v-for="h in hostsOf(gate)" :key="h" class="lab-chip is-accent">{{ h }}</span>
        </div>
      </div>

      <!-- 锁定态不显示任何半截授权信息：只是到期就编辑既有授权续期，重新登记会把审计与历史站点绑到新的授权 id 上 -->
      <div v-else class="hero">
        <p class="lab-hint">
          <span class="lab-strong">建站与发送均被拒绝。</span>
          不在授权名单里的域名一律打不开，邮件任务也无法进入发送队列；若只是到期，直接编辑既有授权续期即可，无需重新登记。
        </p>
        <div class="lab-bar hero-bar"><div class="lab-bar-fill is-danger" style="width: 100%" /></div>
      </div>
    </LabPane>

    <!-- 保留期预警只在最早一批数据即将或已经到期时渲染，平时整块不存在：常年挂一条黄条会让人对颜色脱敏，真到期那次反而看不见 -->
    <!-- 摆在 hero 之后：授权状态必须是第一块，数据要被删是第二要紧的事 -->
    <div v-if="retentionNotice" class="retain-bar" :class="retentionNotice.tone">
      <span class="lab-strong">{{ retentionNotice.title }}</span>
      <span class="lab-hint">{{ retentionNotice.text }}</span>
      <span class="lab-spacer" />
      <!-- 两个出路都是"去能干这件事的那一屏"：归档去导出报表，改保留期去系统设置（那边有试算按钮） -->
      <el-button size="small" @click="go('/evidence?tab=export')">导出归档</el-button>
      <el-button size="small" @click="go('/platform?tab=config')">保留期设置</el-button>
    </div>

    <!-- 数量指标：投了几张网、几个口在听、今天有没有新命中、累计交了多少 -->
    <div class="lab-grid" style="--cols: 4">
      <!-- 这块取 basic.running_sites，口径是库里的 status=open（运维意图），和下一块的实时在听不是同一个数，并排就是要让差异自己露出来 -->
      <!-- 标签写的是进行中任务、数的却是钓鱼网站数；同一份数据的任务数在 assets.tasks（开工检查最后一项） -->
      <LabMetric
        label="进行中任务"
        :value="basic.running_sites ?? 0"
        extra="处于开启状态的演练任务；越近到期，剩余窗口越小"
        :tone="(basic.running_sites ?? 0) > 0 ? 'accent' : ''"
      />
      <!-- 活跃监听来自本页拉的 /web-sites 行：running 或 status=open 任一为真即计，比上面那块宽 -->
      <LabMetric
        label="活跃监听网站"
        :value="assets.runningSites"
        :extra="ports.length ? `端口 ${ports.join('、')}` : '当前没有在跑的钓鱼网站端口'"
        :tone="assets.runningSites > 0 ? '' : 'warn'"
      />
      <!-- 今日新增来自 trend（服务端固定含今天的 7 天），extra 把今日已提交/未提交并列 -->
      <LabMetric
        label="今日新增命中"
        :value="today.opened"
        :extra="`今日已提交 ${today.submitted} · 今日未提交 ${today.not_submitted}`"
        :tone="today.opened > 0 ? 'accent' : ''"
      />
      <!-- 已提交用 danger：这是有人交出凭据的坏消息计数，亮红是提醒不是奖励。转化率由服务端按一位小数算好，前端不再自己除一遍 -->
      <LabMetric
        label="已提交命中"
        :value="web.submitted ?? 0"
        :extra="`累计命中 ${web.total_records ?? 0} · 转化率 ${web.conversion ?? 0}%`"
        :tone="(web.submitted ?? 0) > 0 ? 'danger' : ''"
      />
    </div>

    <!-- align-items:start 让右卡按内容收高：默认 stretch 会把漏斗拉成一个半屏高的空盒子 -->
    <div class="lab-grid" style="--cols: 2; align-items: start">
      <!-- 命中流水只摆最新 8 条（shownHits），再多就把开工检查挤出首屏 -->
      <LabPane title="命中流水" :hint="`最近 ${shownHits.length} 条 · 15 秒自动刷新`">
        <template #ops>
          <el-button link size="small" @click="load">立即刷新</el-button>
          <el-button link size="small" @click="go('/evidence?tab=capture')">全部记录</el-button>
        </template>
        <div v-if="shownHits.length" class="lab-list">
          <!-- 整行可点直达证据页；看板不展开明细，凭据明文不该铺在会被截图的首页上 -->
          <div
            v-for="h in shownHits"
            :key="h.id"
            class="lab-list-item hit"
            role="button"
            tabindex="0"
            @click="go('/evidence?tab=capture')"
            @keyup.enter="go('/evidence?tab=capture')"
          >
            <!-- 实心脉动=已提交（submitted_at 有值），空心=只打开过 -->
            <span class="lab-dot" :class="{ 'is-live': !!h.submitted_at }" />
            <!-- 认得出人就直接写邮箱，匿名终端退化成令牌前 8 位：短到不可猜，又够操作员拿去证据页搜 -->
            <span class="hit-target">{{ h.target_email || `令牌 ${short(h.token)}` }}</span>
            <!-- web=假登录页上钩，mail=邮件链路命中，两类证据的取法不同 -->
            <span class="lab-chip" :class="h.kind === 'web' ? 'is-accent' : 'is-warn'">
              {{ h.kind === 'web' ? '假登录页' : '邮件链路' }}
            </span>
            <span class="lab-chip" :class="h.submitted_at ? 'is-danger' : ''">
              {{ h.submitted_at ? '已提交' : '仅打开' }}
            </span>
            <span class="lab-spacer" />
            <!-- 今天的命中只给时分秒，跨天的补上日期，免得 08:12 被读成今天 -->
            <span class="lab-mono-lite">{{ clockOf(h.first_seen_at || h.submitted_at) }}</span>
          </div>
        </div>
        <div v-else class="lab-empty">暂无命中：网站尚未开启，或还没有目标访问过钓鱼网站。</div>
      </LabPane>

      <!-- 上钩漏斗：三段共用打开数这个分母（pctOf），所以三根条长度天然可比 -->
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
          <!-- 转化率与风险分都来自服务端同一份口径：100 表示没人提交，越低越严重 -->
          <span>转化率 <b>{{ web.conversion ?? 0 }}%</b>（已提交 / 已打开）</span>
          <span>风险评分 <b>{{ basic.risk_score ?? 100 }}</b> · {{ basic.risk_level || '安全' }}</span>
        </div>
        <p class="lab-hint is-mute">
          风险评分由中招率反推，<span class="lab-strong">100 表示全员安全</span>（无人提交），低于 70 说明本次演练命中率偏高。
        </p>
      </LabPane>
    </div>

    <!-- 教育闭环：交付物不是抓到多少人，而是每个上钩的人都补完了安全教育，所以紧跟漏斗 -->
    <!-- education 是全库口径、不按授权过滤；按单次授权算的同一组数字在演练授权的演练汇总里，两处同源不同范围 -->
    <LabPane title="教育闭环" :hint="edu.total ? `全库 ${edu.total} 条上钩记录的处置进度` : '还没有上钩记录，教育闭环无从计算'">
      <template #ops>
        <!-- 覆盖率与处置率并排：结案看覆盖率，有没有人管过看处置率，只给一个会被误读 -->
        <span class="lab-chip" :class="coverage.chip">教育覆盖率 {{ coverage.rate }}%</span>
        <span class="lab-chip">处置率 {{ edu.handled_rate ?? 0 }}%</span>
      </template>

      <template v-if="edu.total">
        <div class="lab-grid" style="--cols: 4">
          <LabMetric label="未处置" :value="edu.new ?? 0" unit="条" :tone="(edu.new ?? 0) > 0 ? 'danger' : ''" extra="还没人联系过本人" />
          <LabMetric label="已联系" :value="edu.contacted ?? 0" unit="条" :tone="(edu.contacted ?? 0) > 0 ? 'warn' : ''" extra="联系上了，教育还没做完" />
          <LabMetric label="已教育" :value="edu.educated ?? 0" unit="条" tone="accent" extra="已完成安全教育" />
          <LabMetric label="已关闭" :value="edu.closed ?? 0" unit="条" tone="accent" extra="教育完成且记录已结案" />
        </div>
        <div class="lab-bar edu-bar">
          <div class="lab-bar-fill" :class="coverage.bar" :style="{ width: coverage.rate + '%' }" />
        </div>
        <p class="lab-hint is-mute">
          教育覆盖率 =（已教育 + 已关闭）/ 上钩记录总数；「已联系但未完成教育」计入处置率而不计入覆盖率，结案看的是前者。
          逐条标记在「上钩记录 → 网页与邮件分组」的下钻页里做，可以整组批量标记。
        </p>
      </template>
      <div v-else class="lab-empty">网站开启并发出专属链接后，这里会按处置状态统计教育进度。</div>
    </LabPane>

    <!-- 开工检查：六项按实际操作顺序排（授权→假登录页→邮件文案→发信邮箱→开站→建任务） -->
    <!-- 缺哪项才点亮哪项的跳转按钮，已就绪的行不给按钮，免得把操作员带离这一屏 -->
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
import { fmtTime as ts, fmtClock } from '../../utils/time';

// gate 由 ConsoleWorkspace 传下来：null 即平台锁定
const props = defineProps({ gate: { type: Object, default: null } });
const router = useRouter();

// /stats/home 的字段兜底骨架：后端少给某个键时模板读到空值，而不是 undefined.xxx 白屏
const EMPTY_HOME = {
  basic: {}, web_stats: {}, mail_stats: {}, education: {}, os_buckets: {}, browser_buckets: {},
  funnel: {}, trend: [], site_overview: [],
};

// /stats/home 的原始返回（整屏指标的唯一来源）
const data = ref({ ...EMPTY_HOME });
// /stats/bigscreen 的最新命中流水：含邮件链路，不只网页命中
const hits = ref([]);
// 本页自己数的资产量：站点/邮件文案/发信账号/任务，用于开工检查与"活跃监听网站"指标
const assets = ref({ sites: 0, runningSites: 0, mailTemplates: 0, smtp: 0, tasks: 0 });
// /maintenance/status 的返回，只喂保留期横幅。null 同时表示还没取到与取失败了：两种都不该出横幅，所以刻意不区分
const retention = ref(null);
// 定时器句柄用 let 而不是 ref（不参与渲染），卸载时必须清掉
let timer = null;

// 下面四块都是从 data 切出的只读视图：|| {} 防后端整块缺字段。basic=站点数与风险分，web=网页侧漏斗与转化率（一位小数由服务端算），funnel=三元组，ports=去重后的在听端口
const basic = computed(() => data.value.basic || {});
const web = computed(() => data.value.web_stats || {});
const funnel = computed(() => data.value.funnel || {});
const ports = computed(() => basic.value.listen_ports || []);

/** /stats/home 的 education 段，形状是服务端 educationCoverage() 的产物 {total, new, contacted, educated, closed, coverage_rate, handled_rate}。
 *  全库口径、不按授权过滤；按单次授权算的同一组数字在演练授权的演练汇总里，两处同源不同范围。 */
const edu = computed(() => data.value.education || {});

/** 教育覆盖率的数值、chip 配色类、进度条配色类合成一个 computed：chip 与进度条必须同色，分开写迟早一个说黄一个说红。
 *  空库不上色：一条记录都没有时的 0% 不是坏消息，染色会把还没开始读成做得很差。 */
const coverage = computed(() => {
  const rate = edu.value.coverage_rate ?? 0;
  if (!edu.value.total) return { rate, chip: '', bar: '' };
  const none = rate <= 0;
  const partial = rate < 100;
  return { rate, chip: none ? 'is-danger' : partial ? 'is-warn' : 'is-ok', bar: none ? 'is-danger' : partial ? 'is-warn' : '' };
});

/** 保留期横幅：已到期且确有待删行给红条，7 天以内到期给黄条，其余（含没配保留期、时间串解析不出、待删行数为 0）返回 null、整块不渲染。
 *  到期时刻用 oldest_created_at + retention_days 算；cutoff_at 是往回数 N 天的分界线，它自己不会到期，不能拿它算。 */
const retentionNotice = computed(() => {
  const r = retention.value;
  if (!r || !r.enabled) return null;
  const days = Number(r.retention_days);
  const oldest = Date.parse(r.oldest_created_at || '');
  // 三个数任一无效就不出横幅：算不出"什么时候删"时，猜一个日期比不提示更危险
  if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(oldest)) return null;
  // pending 四张表一起加总；audit_logs 走更长的 audit_retention_days，严格说不该混进来，但宁可说重也不漏报
  const pendingRows = Object.values(r.pending || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
  // 86400000 是一天的毫秒数；dueIn 是距离最早那行被删还有几天，可以为负（已过期）
  const dueIn = (oldest + days * 86400000 - Date.now()) / 86400000;
  const sweep = r.next_sweep_at ? `下次自动清理约在 ${ts(r.next_sweep_at)}。` : '';
  if (dueIn <= 0) {
    if (!pendingRows) return null;
    return {
      tone: 'is-danger',
      title: `已有 ${pendingRows} 条数据超过保留期`,
      text: `保留期 ${days} 天，最早的一条是 ${ts(r.oldest_created_at)} 留下的，下一轮自动清理会把它连同附件一起删掉。${sweep}要留证据请先导出。`,
    };
  }
  if (dueIn > 7) return null;
  return {
    tone: '',
    title: `最早的一批演练数据将在 ${Math.ceil(dueIn)} 天后到期`,
    text: `保留期 ${days} 天，到期后自动清理（本轮预计 ${pendingRows} 条）。${sweep}需要归档请先导出。`,
  };
});

/** 今日命中：用本机时区的 ISO 日历日去 trend 找同 date 那一行，trend 固定含今天的 7 天。
 *  找不到（跨天边界、后端没给）退化成三个 0：今天没命中是合法状态，不许把整块指标崩成 NaN。 */
const today = computed(() => {
  const day = new Date().toISOString().slice(0, 10);
  const row = (data.value.trend || []).find((r) => r.date === day);
  return { opened: 0, submitted: 0, not_submitted: 0, ...(row || {}) };
});

/** 域名名单：老数据或迁移前后 allowed_hosts 可能不是数组，这里保证永远可 v-for 与 .length */
function hostsOf(g) {
  return Array.isArray(g?.allowed_hosts) ? g.allowed_hosts : [];
}

/** 令牌只取前 8 位：完整令牌能冒充那位终端，首页与截图上不该出现，8 位够操作员去证据页搜 */
function short(v) {
  return String(v || '').slice(0, 8);
}

/** 授权起止精确到秒：续期谈判与到期时刻要能被逐字引用，只到分会让人误判还剩一小时 */
function fmt(iso) {
  return ts(iso, { seconds: true });
}

/** 命中时刻：直接切 ISO 是 UTC 读数，会比本机挂钟差几小时；跨天的行才退回带日期的完整时间 */
function clockOf(iso) {
  return iso ? fmtClock(iso) : fmt(iso);
}

/** 窗口剩余百分比 (end-now)/(end-start)：无授权或 end<=start（时钟倒挂）回 0，宁可显示没剩也不能给进度条 NaN 或负宽度 */
const remainPct = computed(() => {
  const g = props.gate;
  if (!g) return 0;
  const start = new Date(g.start_at).getTime();
  const end = new Date(g.end_at).getTime();
  if (!(end > start)) return 0;
  const ratio = (end - Date.now()) / (end - start);
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
});

// 倒计时紧急档与进度条配色共用 15%/40% 两档阈值，颜色和数字不会一个说紧一个说松；15% 是还来得及走续期流程的经验值
const remainClass = computed(() => {
  const g = props.gate;
  if (!g) return '';
  return remainPct.value < 15 ? 'is-crit' : remainPct.value < 40 ? 'is-low' : '';
});

const barTone = computed(() => (remainPct.value < 15 ? 'is-danger' : remainPct.value < 40 ? 'is-warn' : ''));

/** 剩余时间：不足 1 小时说分钟、不足一天说小时、其余说天，到有效期止直接说到期（此时网站会被级联停止监听）。
 *  Math.max(1, …) 让不足 1 分钟也显示剩余 1 分钟：0 会被读成已到期，而到期与没到期是能不能继续演练的分界。 */
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

// 首屏只摆 8 条命中：再多会把开工检查推到底部，全量在证据工作区按站点/任务下钻
const shownHits = computed(() => hits.value.slice(0, 8));

// 漏斗三行：打开 → 未提交 → 已提交，数值直接取服务端的同一组三元组（自洽，不前端二次统计）
const funnelRows = computed(() => [
  { key: 'opened', label: '打开假登录页', value: funnel.value.opened ?? 0, hint: 'first_seen 口径的独立终端', tone: '' },
  { key: 'not_submitted', label: '打开未提交', value: funnel.value.not_submitted ?? 0, hint: '看过但没交出内容', tone: 'warn' },
  { key: 'submitted', label: '已提交内容', value: funnel.value.submitted ?? 0, hint: '已留下完整记录', tone: 'danger' },
]);

/** 漏斗条宽以打开数为分母；Math.max(2, …) 让 500 人打开 1 人提交那种小比例也看得见一根头，画成 0% 会被读成一个都没有。
 *  值为 0 时必须真的返回 0：min 2 会把「0 人」画成左端一个橙色圆点，看着像有数据。 */
function pctOf(v) {
  const base = funnel.value.opened || 0;
  if (!base || !v) return 0;
  return Math.max(2, Math.round((v / base) * 100));
}

/** 开工检查六项是派生视图，不额外发请求；顺序就是实际操作顺序，第一项没授权后面五项全绿也没用（服务端照样 403）。
 *  page 读 basic.*（/stats/home 一起算好的），mail/sender/site/task 读 assets.*（本页另发四个请求数的），两批不同时刻取，刷新前后差一项属正常。 */
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
    // 只要在有可复用的正文就算就绪，沙箱任务同样吃这份素材，所以不要求配好 SMTP
    {
      key: 'mail',
      label: '邮件文案',
      ok: assets.value.mailTemplates > 0,
      detail: assets.value.mailTemplates ? `${assets.value.mailTemplates} 封正文可复用` : '还没有可用于发送的邮件文案',
      to: '/material?tab=email',
      cta: '写正文',
    },
    // 缺 SMTP 只挡关闭沙箱的真实发信，沙箱渲染复核不受影响，detail 里把这句说白，免得操作员以为连演练都开不了
    {
      key: 'sender',
      label: '发信邮箱',
      ok: assets.value.smtp > 0,
      detail: assets.value.smtp ? `${assets.value.smtp} 个 SMTP 配置档` : '关闭沙箱真实发信前需要一个 SMTP 配置档',
      to: '/outbound?tab=sender',
      cta: '配置账号',
    },
    // 判的是 runningSites（真的在对外服务），光有档案没人听等于没有网
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

// 就绪项数：分母永远是 readiness.length（6），写死数字会在加检查项后与右上角对不上
const readyCount = computed(() => readiness.value.filter((r) => r.ok).length);

function go(path) {
  router.push(path);
}

/** 整屏刷新：写 data / hits / assets 三份状态，是本页唯一的取数入口，onMounted、15 秒定时器与立即刷新都调它 */
async function load() {
  data.value = { ...EMPTY_HOME, ...(await http.get('/stats/home')) };

  // 命中流水单独 try：bigscreen 挂了不该让上面那块指标跟着白屏；失败清空列表也不弹错，15 秒后自己重试
  try {
    const screen = await http.get('/stats/bigscreen');
    hits.value = screen?.records || [];
  } catch {
    hits.value = [];
  }

  // 四个接口并发且用 allSettled：任意一个 403/500 只让它自己落 0，开工检查要能逐项说话而不是整块变灰
  // mail-templates 与 mail-tasks 只要计数，page_size=1 让服务端算 total；/web-sites 不分页且要看 running 实况
  const results = await Promise.allSettled([
    http.get('/web-sites'),
    http.get('/mail-templates', { params: { page_size: 1 } }),
    http.get('/smtp-profiles'),
    http.get('/mail-tasks', { params: { page_size: 1 } }),
  ]);
  // 失败项换成 null，下面统一可选链读，不给每个接口再写一遍 try
  const [sites, mailTemplates, smtp, tasks] = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
  const siteRows = sites?.rows || [];
  assets.value = {
    sites: siteRows.length || sites?.total || 0,
    // 在听放宽成 running || status==='open'：意图是开但进程没起来也算这张网还在演练里，不该念成缺失
    runningSites: siteRows.filter((s) => s.running || s.status === 'open').length,
    // 其余三项 total 优先（page_size=1 时 rows 只有一行，读 rows.length 会永远得 1），老接口没给才退行数
    mailTemplates: mailTemplates?.total ?? (mailTemplates?.rows?.length || 0),
    smtp: smtp?.total ?? (smtp?.rows?.length || 0),
    tasks: tasks?.total ?? (tasks?.rows?.length || 0),
  };
}

/** 只喂保留期横幅：这个接口带 withFiles，服务端要 stat 三个目录下的每个文件，跟着 15 秒轮询打等于每 15 秒扫一遍磁盘；保留期以天为单位变化，进页取一次够用。
 *  失败一律静默留 null：一条运维提示没资格把登录后第一屏弄出红字，尤其后端还没升到带这个接口的版本时。 */
async function loadRetention() {
  try {
    retention.value = await http.get('/maintenance/status');
  } catch {
    retention.value = null;
  }
}

// 进页先拉一次再开定时器：15 秒再短就开始抢服务端的读，再长操作员会以为卡住
onMounted(() => {
  load();
  loadRetention();
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
/* 保留期预警条只把左边框换成警示色，不整块铺底色：两条红并排时操作员分不清哪一条更要紧 */
.retain-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--lab-line-2); border-left: 3px solid var(--lab-warn); border-radius: var(--lab-r); background: var(--lab-fill-2); }
.retain-bar.is-danger { border-left-color: var(--lab-danger); }
/* 覆盖率进度条与上面四格指标之间留白：紧贴着会被读成"最后一格指标的附属装饰"，而它说的是四格加起来的成数 */
.edu-bar { height: 8px; margin: 12px 0 8px; }
</style>
