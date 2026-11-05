<template>
  <!-- 下钻第一屏：总览四格、教育覆盖率、网页分组表、邮件分组表、未归属格。这一屏只选组，字段值都不在这里 -->
  <div class="lab-stack">
    <!-- 上钩终端是全库记录数口径；未归属非 0 才转警告色 -->
    <div class="lab-grid" style="--cols: 4">
      <LabMetric label="钓鱼网页分组" :value="web.length" unit="组" :extra="`${hitCount(web)} 组采到过内容`" />
      <LabMetric label="钓鱼邮件分组" :value="mail.length" unit="组" :extra="`${hitCount(mail)} 组采到过内容`" />
      <LabMetric label="上钩终端" :value="totals.terminals" unit="条" tone="accent" :extra="`其中已提交 ${totals.submitted} 条`" />
      <LabMetric
        label="未归属记录"
        :value="unassigned.terminals"
        unit="条"
        :tone="unassigned.terminals ? 'warn' : ''"
        extra="没挂在任何网站或任务下的历史证据"
      />
    </div>

    <!-- 六个数全来自后端 education 对象，与首页统计、演练报告共用 educationCoverage 算的，前端只摆不算 -->
    <LabPane title="教育覆盖率" hint="处置状态由操作员在下钻屏逐条或批量标记（未处置 / 已联系 / 已教育 / 已关闭）">
      <div class="lab-grid" style="--cols: 3; margin-bottom: 10px">
        <LabMetric label="教育覆盖率" :value="education.coverage_rate" unit="%" tone="accent" extra="（已教育 + 已关闭）÷ 总记录数" />
        <LabMetric label="已处置率" :value="education.handled_rate" unit="%" extra="（已联系 + 已教育 + 已关闭）÷ 总记录数" />
        <LabMetric
          label="未处置"
          :value="education.new"
          unit="条"
          :tone="education.new ? 'warn' : ''"
          extra="还没人跟进的终端（含未回填状态的老记录）"
        />
        <LabMetric label="已联系" :value="education.contacted" unit="条" extra="接触过但还没完成教育：算已处置、不算覆盖" />
        <LabMetric label="已教育" :value="education.educated" unit="条" extra="完成安全教育，计入覆盖率" />
        <LabMetric label="已关闭" :value="education.closed" unit="条" extra="教育完成且记录归档，计入覆盖率" />
      </div>
      <p class="lab-hint is-mute" style="margin: 0">
        覆盖率 =（已教育 + 已关闭）÷ 总数；「已联系」只计入已处置率、不计入覆盖率，联系过不等于教过了。
        分母是记录数口径（与顶上「上钩终端」同源，跨链记录会双计），总数为 0 时两个比率都是 0。
      </p>
    </LabPane>

    <LabPane flush title="按钓鱼网页分组" hint="一行一个网站：挂在哪、几个人打开、几个人交了内容，点任意一行进入本站的上钩记录">
      <template #ops>
        <el-button size="small" plain @click="$emit('open', null)">全部上钩记录</el-button>
        <el-button size="small" :icon="Refresh" @click="load">刷新</el-button>
      </template>
      <!-- 一行 = 一个钓鱼网站，不是一条记录。整行可点与按钮 emit 同一个 open 事件，按钮上的 .stop 防它触发两次 -->
      <el-table :data="web" size="small" class="group-table" @row-click="(row) => $emit('open', row)">
        <el-table-column label="钓鱼网页" min-width="200">
          <template #default="{ row }">
            <div class="cell-main">
              <span class="lab-strong cell-label" :title="row.label">{{ row.label }}</span>
              <span v-if="!row.exists" class="lab-chip is-danger">已收网</span>
            </div>
            <!-- 监听地址降为副行：单开一列会把「最近活动」和操作列挤出可视区 -->
            <div class="lab-hint is-mute cell-sub">
              <span class="cell-addr">{{ row.address || '—' }}</span>
              <span class="cell-sep">·</span>{{ row.id.slice(0, 8) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="86">
          <template #default="{ row }">
            <span class="lab-chip" :class="siteTone(row)">
              <span class="lab-dot" :class="{ 'is-live': row.running }" />{{ siteStatus(row) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="上钩终端" width="92" align="right">
          <template #default="{ row }">{{ row.terminals }}</template>
        </el-table-column>
        <el-table-column label="已提交" width="86" align="right">
          <template #default="{ row }">
            <span :class="row.submitted ? 'lab-strong is-hot' : ''">{{ row.submitted }}</span>
          </template>
        </el-table-column>
        <el-table-column label="提交率" width="86" align="right">
          <template #default="{ row }">{{ row.conversion }}%</template>
        </el-table-column>
        <!-- 未教育是后端归一后仍为未处置的终端数（含 NULL 老行），与已提交不是一回事 -->
        <el-table-column label="未教育" width="86" align="right">
          <template #default="{ row }">
            <span :class="row.unhandled ? 'is-pending' : 'lab-hint is-mute'">{{ row.unhandled }}</span>
          </template>
        </el-table-column>
        <el-table-column label="采到的字段" min-width="140">
          <template #default="{ row }">
            <span class="lab-hint is-mute">{{ row.field_names.join('、') || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最近活动" width="140">
          <template #default="{ row }"><span class="lab-hint is-mute">{{ fmt(row.last_seen_at) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="118" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="$emit('open', row)">查看上钩记录</el-button>
          </template>
        </el-table-column>
        <template #empty><div class="lab-empty">还没有钓鱼网站。到「钓鱼网站」挂一个假登录页，这里就会按网站分组。</div></template>
      </el-table>
    </LabPane>

    <LabPane flush title="按钓鱼邮件分组" hint="一行一个发送任务：邮件被打开、链接被点开、页面上交了内容，都算在同一条链上">
      <!-- 一行 = 一个发送任务。收件人是分母，上钩终端是分子；打开拆成邮件与网页两个环节，是同一条链的两段 -->
      <el-table :data="mail" size="small" class="group-table" @row-click="(row) => $emit('open', row)">
        <el-table-column label="钓鱼邮件" min-width="180">
          <template #default="{ row }">
            <div class="cell-main">
              <span class="lab-strong cell-label" :title="row.label">{{ row.label }}</span>
              <span v-if="!row.exists" class="lab-chip is-danger">任务已删</span>
            </div>
            <div class="lab-hint is-mute cell-sub cell-label" :title="row.subject">{{ row.subject || row.id.slice(0, 8) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="发送方式" width="110">
          <template #default="{ row }">
            <span class="lab-chip" :class="row.dry_run === 0 ? 'is-danger' : 'is-accent'">{{ sendLabel(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="收件人" width="86" align="right">
          <template #default="{ row }">{{ row.recipients }}</template>
        </el-table-column>
        <el-table-column label="上钩终端" width="92" align="right">
          <template #default="{ row }">{{ row.terminals }}</template>
        </el-table-column>
        <el-table-column label="邮件打开" width="92" align="right">
          <template #default="{ row }">{{ row.mail_opens }}</template>
        </el-table-column>
        <el-table-column label="已提交" width="86" align="right">
          <template #default="{ row }">
            <span :class="row.submitted ? 'lab-strong is-hot' : ''">{{ row.submitted }}</span>
          </template>
        </el-table-column>
        <el-table-column label="提交率" width="86" align="right">
          <template #default="{ row }">{{ row.conversion }}%</template>
        </el-table-column>
        <!-- 与网页表同一列：后端每个分组桶都带 unhandled，不在前端重算 -->
        <el-table-column label="未教育" width="86" align="right">
          <template #default="{ row }">
            <span :class="row.unhandled ? 'is-pending' : 'lab-hint is-mute'">{{ row.unhandled }}</span>
          </template>
        </el-table-column>
        <el-table-column label="采到的字段" min-width="140">
          <template #default="{ row }">
            <span class="lab-hint is-mute">{{ row.field_names.join('、') || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最近活动" width="130">
          <template #default="{ row }"><span class="lab-hint is-mute">{{ fmt(row.last_seen_at) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="118" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="$emit('open', row)">查看上钩记录</el-button>
          </template>
        </el-table-column>
        <template #empty><div class="lab-empty">还没有发送任务。到「钓鱼邮件」建一个任务并导入收件人，这里就会按任务分组。</div></template>
      </el-table>
    </LabPane>

    <!-- 未归属格只在有条数时出现；行形状与分组行一致，按钮能直接把 open 事件发给父组件，下钻走 unassigned=1 -->
    <LabPane v-if="unassigned.terminals" title="未归属记录" :hint="`共 ${unassigned.terminals} 条，已提交 ${unassigned.submitted} 条，未教育 ${unassigned.unhandled || 0} 条`">
      <template #ops>
        <el-button size="small" type="primary" plain @click="$emit('open', unassigned)">查看未归属记录</el-button>
      </template>
      <p class="lab-hint is-mute" style="margin: 0">
        这些记录建库时没写下归属的网站或任务（老库迁移或手工写入的居多），所以进不了上面任何一个分组。单列出来是为了账能对上：分组数加未归属等于全库条数。
      </p>
    </LabPane>
  </div>
</template>

<script setup>
/**
 * 上钩证据分组看板：只读 GET /records/groups，不写数据，删证据、标处置、导 CSV 都在别的屏。
 * 分组条件必须与 /records 的过滤逐字对齐（网页 site_id、邮件 task_id、未归属 unassigned=1），一边改了就会出现板上 3 条、点进去 2 条。
 * 站点收网、任务删除后证据照样列成一组（exists=false，显示已收网/任务已删）是刻意的；跨链记录同进两组，两组相加不等于全库条数。
 */
import { ref, onMounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';
import { fmtTime as ts } from '../../utils/time';

// 只有一种事件 open：载荷是分组行，null 表示看全部、不加归属过滤
defineEmits(['open']);

// field_names 后端只给前 8 个（看板格宽有限），不是全量字段清单
const web = ref([]);
const mail = ref([]);
// 初始摆成一个零值的分组行，形状与 web/mail 一致，未归属格的按钮能整行 emit 出去
const unassigned = ref({ group: 'none', id: null, label: '未归属记录', terminals: 0, submitted: 0, unhandled: 0, field_names: [], exists: false });
// 本页只用 terminals/submitted，另两个键留着与返回形状对齐；
// 别拿 web.length + mail.length 凑终端数，跨链双计会让两个数天然不等
const totals = ref({ web_groups: 0, mail_groups: 0, terminals: 0, submitted: 0 });
// coverage_rate/handled_rate 与 conversion 都由后端按一位小数取好，前端只拼 '%' 不重算；
// 分母是记录数（与 totals.terminals 同源，跨链记录双计），四个桶相加恒等于 total
const education = ref({ total: 0, new: 0, contacted: 0, educated: 0, closed: 0, coverage_rate: 0, handled_rate: 0 });

/** terminals>0 的组数；用 >0 而不是 submitted，有人打开没交也是有效结果 */
const hitCount = (rows) => rows.filter((r) => r.terminals > 0).length;
const fmt = (value) => ts(value);
// 判级顺序不能反：exists 必须在 status 之前，已收网的站库里照样留着 status，直接读它会把停掉的站说成还在监听
// running 取自监听注册表的实时值，status='open' 只是运维意图，进程没起来就是待恢复
const siteStatus = (row) =>
  !row.exists ? '已收网' : row.status === 'error' ? '异常' : row.status === 'open' ? (row.running ? '监听中' : '待恢复') : '已关闭';
/** 已收网与异常给红（这两档现在采不到新证据），在监听给绿，其余给黄 */
const siteTone = (row) => (!row.exists || row.status === 'error' ? 'is-danger' : row.running ? 'is-ok' : 'is-warn');
/**
 * 任务已删时给 '—'：发信配置已经没了，再断言它当初怎么发的没有依据。
 * dry_run 用 === 0 严格比较：库里是 0/1 整数，值以字符串 '0' 传过来时真值判断会把真实发送误标成沙箱。
 */
const sendLabel = (row) => (row.exists ? `${row.dry_run === 0 ? '真实发送' : '沙箱'}${row.status === 'sent' ? '·已完成' : ''}` : '—');

/**
 * 只读聚合 GET /records/groups。五块必须整批覆写：totals 与 education 由同一份记录集算出，
 * 只换一块会出现表里加总跟顶上格子对不上。失败时保持上一次的值，空库也出全零看板，这条路由不返回 4xx。
 */
async function load() {
  const data = await http.get('/records/groups');
  web.value = data.web;
  mail.value = data.mail;
  unassigned.value = data.unassigned;
  totals.value = data.totals;
  education.value = data.education;
}

// 本页不轮询，要看新命中点刷新
onMounted(load);
</script>

<style scoped>
.group-table :deep(.el-table__row) { cursor: pointer; }
.cell-main { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cell-sub { font-size: 11.5px; margin-top: 2px; }
/* 组名可能很长，撑成两行会把副行挤到行外：统一单行省略，完整值放 title 提示 */
.cell-label { display: block; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell-sep { margin: 0 5px; color: var(--lab-ink-4); }
.cell-addr { font-family: Consolas, "Cascadia Mono", monospace; }
.is-hot { color: var(--lab-danger); }
/* 未教育非 0 用 warn 不用 danger：欠的是要办的账，不是已经发生的事故 */
.is-pending { color: var(--lab-warn); font-weight: 700; }
.mono-inline { font-family: var(--lab-mono, inherit); }
</style>
