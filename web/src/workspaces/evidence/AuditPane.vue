<template>
  <div class="lab-stack">
    <LabPane flush title="操作审计" hint="谁、什么时候、从哪里做了哪一步高危动作：授权登记与吊销、沙箱开关、真实发送、证据导出、证据与站点删除、运行参数变更。这张表只读，改不了也删不掉。">
      <template #ops>
        <el-select v-model="query.action" size="small" clearable placeholder="全部动作" style="width: 170px" @change="reload">
          <el-option v-for="(label, key) in ACTION_LABELS" :key="key" :label="label" :value="key" />
        </el-select>
        <el-input v-model="query.actor" size="small" clearable placeholder="操作人" style="width: 130px" @change="reload" />
        <el-button size="small" :icon="Refresh" @click="load">刷新</el-button>
      </template>

      <el-table :data="rows" size="small">
        <el-table-column prop="created_at" label="时间" width="180" />
        <el-table-column prop="actor" label="操作人" width="120" />
        <el-table-column label="动作" width="150">
          <template #default="{ row }">
            <span class="lab-chip" :class="severity(row.action)">{{ ACTION_LABELS[row.action] || row.action }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="ip" label="来源" width="150" />
        <el-table-column label="对象" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="lab-mono">{{ row.target_kind || '-' }}</span> {{ row.target_id }}
          </template>
        </el-table-column>
        <el-table-column label="详情" width="90">
          <template #default="{ row }">
            <el-button link type="primary" @click="show(row)">查看</el-button>
          </template>
        </el-table-column>
        <template #empty><div class="lab-empty">还没有审计记录，做过授权登记或发信后这里会留下痕迹。</div></template>
      </el-table>

      <template #ft>
        <el-pagination
          layout="total, prev, pager, next"
          :total="total"
          :page-size="query.page_size"
          :current-page="query.page"
          @current-change="(p) => { query.page = p; load(); }"
        />
      </template>
    </LabPane>

    <LabPane title="为什么留这些">
      <div class="lab-kv" style="row-gap: 6px">
        <span>审计只记<b>动作与当时的取值</b>，模型密钥与机器人令牌进表前已掩码，这里不会成为第二份密码本。</span>
        <span>授权窗口一改，其下站点当场下线，停了几个也一并记在详情里，事后能自证"这段时间是谁授的权"。</span>
        <span>写入失败只告警、不阻断演练链路，所以某条动作若缺失，先看服务控制台。</span>
      </div>
    </LabPane>
  </div>

  <el-drawer v-model="dialog" :title="`审计详情 · ${ACTION_LABELS[active?.action] || active?.action || ''}`" size="640px">
    <div class="lab-kv" style="row-gap: 6px; margin-bottom: 12px">
      <span>操作人：<b>{{ active?.actor || '未知' }}</b></span>
      <span>来源地址：<b class="lab-mono">{{ active?.ip || '未知' }}</b></span>
      <span>时间：<b class="lab-mono">{{ active?.created_at }}</b></span>
    </div>
    <pre class="lab-mono">{{ detail }}</pre>
  </el-drawer>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';

defineProps({ gate: { type: Object, default: null } });

const ACTION_LABELS = {
  'authorization.create': '登记授权',
  'authorization.update': '修改授权',
  'authorization.revoke': '吊销授权',
  'mail_task.sandbox_toggle': '关闭发信沙箱',
  'mail_task.sandbox_send': '沙箱发信',
  'mail_task.real_send': '真实发送',
  'mail_task.delete': '删除发信任务',
  'evidence.export': '导出证据',
  'evidence.delete': '删除上钩记录',
  'site.delete': '删除钓鱼站点',
  'settings.update': '修改运行参数',
};

/** 红标留给"一旦做错就收不回来"的动作：真发、吊销、删除、开沙箱 */
const SEVERE = new Set(['mail_task.real_send', 'mail_task.sandbox_toggle', 'authorization.revoke', 'evidence.delete', 'site.delete']);

const rows = ref([]);
const total = ref(0);
const dialog = ref(false);
const detail = ref('');
const active = ref(null);
const query = reactive({ page: 1, page_size: 20, action: '', actor: '' });

const severity = (action) => (SEVERE.has(action) ? 'is-danger' : 'is-accent');

async function load() {
  const params = { page: query.page, page_size: query.page_size };
  if (query.action) params.action = query.action;
  if (query.actor) params.actor = query.actor;
  const data = await http.get('/audit-logs', { params });
  rows.value = data.rows;
  total.value = data.total;
}

function reload() {
  query.page = 1;
  load();
}

function show(row) {
  active.value = row;
  detail.value = row.detail ? JSON.stringify(row.detail, null, 2) : '（该动作未附带取值）';
  dialog.value = true;
}

onMounted(load);
</script>
