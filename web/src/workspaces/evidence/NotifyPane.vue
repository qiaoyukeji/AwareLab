<template>
  <div class="lab-stack">
    <LabPane flush title="通知记录" hint="事件推送到钉钉 / 企业微信 / 飞书的调用记录，失败不影响采集主链路；CSV 导出同样在这里记录（通道为 export）。">
      <template #ops>
        <el-button size="small" :icon="Refresh" @click="load">刷新</el-button>
      </template>

      <el-table :data="rows" size="small">
        <el-table-column prop="created_at" label="时间" width="180" />
        <el-table-column prop="channel" label="通道" width="120" />
        <el-table-column prop="event_kind" label="事件" width="140" />
        <el-table-column label="结果" width="90">
          <template #default="{ row }">
            <span class="lab-chip" :class="row.ok ? 'is-ok' : 'is-danger'">{{ row.ok ? '成功' : '失败' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="response" label="响应" min-width="220" show-overflow-tooltip />
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="show(row)">请求体</el-button>
          </template>
        </el-table-column>
        <template #empty><div class="lab-empty">还没有推送记录，触发通知事件后这里会有记录。</div></template>
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

    <LabPane title="通道说明">
      <div class="lab-kv" style="row-gap: 6px">
        <span>推送文案统一前缀：<b class="lab-mono" style="padding: 1px 6px">[AwareLab 演练通知]</b></span>
        <span>通道在「系统设置」配置 Webhook；推送失败仅记录本表，<b>不影响打开像素与链接跳转的采集链路</b>。</span>
      </div>
    </LabPane>
  </div>

  <el-drawer v-model="dialog" title="推送请求体" size="640px">
    <pre class="lab-mono">{{ detail }}</pre>
  </el-drawer>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';

defineProps({ gate: { type: Object, default: null } });

const rows = ref([]);
const total = ref(0);
const dialog = ref(false);
const detail = ref('');
const query = reactive({ page: 1, page_size: 20 });

async function load() {
  const data = await http.get('/push-logs', { params: query });
  rows.value = data.rows;
  total.value = data.total;
}

function show(row) {
  try {
    detail.value = JSON.stringify(JSON.parse(row.request), null, 2);
  } catch {
    detail.value = row.request;
  }
  dialog.value = true;
}

onMounted(load);
</script>
