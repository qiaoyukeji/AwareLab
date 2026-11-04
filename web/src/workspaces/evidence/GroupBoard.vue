<template>
  <div class="lab-stack">
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

    <LabPane flush title="按钓鱼网页分组" hint="一行一个网站：挂在哪、几个人打开、几个人交了内容，点任意一行进入本站的上钩记录">
      <template #ops>
        <el-button size="small" plain @click="$emit('open', null)">全部上钩记录</el-button>
        <el-button size="small" :icon="Refresh" @click="load">刷新</el-button>
      </template>
      <el-table :data="web" size="small" class="group-table" @row-click="(row) => $emit('open', row)">
        <el-table-column label="钓鱼网页" min-width="180">
          <template #default="{ row }">
            <div class="cell-main">
              <span class="lab-strong">{{ row.label }}</span>
              <span v-if="!row.exists" class="lab-chip is-danger">已收网</span>
            </div>
            <div class="lab-hint is-mute cell-sub">{{ row.id.slice(0, 8) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="监听" min-width="140">
          <template #default="{ row }"><span class="lab-mono">{{ row.address || '—' }}</span></template>
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
        <el-table-column label="页面打开" width="92" align="right">
          <template #default="{ row }">{{ row.page_opens }}</template>
        </el-table-column>
        <el-table-column label="已提交" width="86" align="right">
          <template #default="{ row }">
            <span :class="row.submitted ? 'lab-strong is-hot' : ''">{{ row.submitted }}</span>
          </template>
        </el-table-column>
        <el-table-column label="提交率" width="86" align="right">
          <template #default="{ row }">{{ row.conversion }}%</template>
        </el-table-column>
        <el-table-column label="采到的字段" min-width="150">
          <template #default="{ row }">
            <span class="lab-hint is-mute">{{ row.field_names.join('、') || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最近活动" width="150">
          <template #default="{ row }"><span class="lab-hint is-mute">{{ fmt(row.last_seen_at) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="96" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="$emit('open', row)">查看上钩记录</el-button>
          </template>
        </el-table-column>
        <template #empty><div class="lab-empty">还没有钓鱼网站。到「钓鱼网站」挂一个假登录页，这里就会按网站分组。</div></template>
      </el-table>
    </LabPane>

    <LabPane flush title="按钓鱼邮件分组" hint="一行一个发送任务：邮件被打开、链接被点开、页面上交了内容，都算在同一条链上">
      <el-table :data="mail" size="small" class="group-table" @row-click="(row) => $emit('open', row)">
        <el-table-column label="钓鱼邮件" min-width="180">
          <template #default="{ row }">
            <div class="cell-main">
              <span class="lab-strong">{{ row.label }}</span>
              <span v-if="!row.exists" class="lab-chip is-danger">任务已删</span>
            </div>
            <div class="lab-hint is-mute cell-sub">{{ row.subject || row.id.slice(0, 8) }}</div>
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
        <el-table-column label="网页打开" width="92" align="right">
          <template #default="{ row }">{{ row.page_opens }}</template>
        </el-table-column>
        <el-table-column label="已提交" width="86" align="right">
          <template #default="{ row }">
            <span :class="row.submitted ? 'lab-strong is-hot' : ''">{{ row.submitted }}</span>
          </template>
        </el-table-column>
        <el-table-column label="提交率" width="86" align="right">
          <template #default="{ row }">{{ row.conversion }}%</template>
        </el-table-column>
        <el-table-column label="采到的字段" min-width="150">
          <template #default="{ row }">
            <span class="lab-hint is-mute">{{ row.field_names.join('、') || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最近活动" width="150">
          <template #default="{ row }"><span class="lab-hint is-mute">{{ fmt(row.last_seen_at) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="96" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="$emit('open', row)">查看上钩记录</el-button>
          </template>
        </el-table-column>
        <template #empty><div class="lab-empty">还没有发送任务。到「钓鱼邮件」建一个任务并导入收件人，这里就会按任务分组。</div></template>
      </el-table>
    </LabPane>

    <LabPane v-if="unassigned.terminals" title="未归属记录" :hint="`共 ${unassigned.terminals} 条，已提交 ${unassigned.submitted} 条`">
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
import { ref, onMounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';

const emit = defineEmits(['open']);

const web = ref([]);
const mail = ref([]);
const unassigned = ref({ group: 'none', id: null, label: '未归属记录', terminals: 0, submitted: 0, field_names: [], exists: false });
const totals = ref({ web_groups: 0, mail_groups: 0, terminals: 0, submitted: 0 });

const hitCount = (rows) => rows.filter((r) => r.terminals > 0).length;
const fmt = (value) => String(value || '').replace('T', ' ').slice(0, 16) || '—';
// 与「钓鱼网站」列表同一套状态口径：删站只是收网，证据还在，所以状态要说"已收网"而不是"不存在"
const siteStatus = (row) =>
  !row.exists ? '已收网' : row.status === 'error' ? '异常' : row.status === 'open' ? (row.running ? '监听中' : '待恢复') : '已关闭';
const siteTone = (row) => (!row.exists || row.status === 'error' ? 'is-danger' : row.running ? 'is-ok' : 'is-warn');
const sendLabel = (row) => (row.exists ? `${row.dry_run === 0 ? '真实发送' : '沙箱'}${row.status === 'sent' ? '·已完成' : ''}` : '—');

async function load() {
  const data = await http.get('/records/groups');
  web.value = data.web;
  mail.value = data.mail;
  unassigned.value = data.unassigned;
  totals.value = data.totals;
}

onMounted(load);
</script>

<style scoped>
.group-table :deep(.el-table__row) { cursor: pointer; }
.cell-main { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cell-sub { font-size: 11.5px; margin-top: 2px; }
.is-hot { color: var(--lab-danger); }
.mono-inline { font-family: var(--lab-mono, inherit); }
</style>
