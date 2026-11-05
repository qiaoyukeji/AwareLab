<template>
  <div class="lab-stack">
    <LabPane flush title="通知记录" hint="事件推送到钉钉 / 企业微信 / 飞书的调用记录，失败不影响采集主链路；CSV 导出同样在这里记录（通道为 export）。">
      <template #ops>
        <!-- 本面板被 KeepAlive 缓存，只在挂载时拉一次，切回来不会自动刷新 -->
        <el-button size="small" :icon="Refresh" @click="load">刷新</el-button>
      </template>

      <el-table :data="rows" size="small">
        <el-table-column prop="created_at" label="时间" width="180" :formatter="(row) => ts(row.created_at, { seconds: true })" />
        <el-table-column prop="channel" label="通道" width="120" />
        <el-table-column prop="event_kind" label="事件" width="140" />
        <el-table-column label="结果" width="90">
          <template #default="{ row }">
            <!-- ok 是 0/1 落库；推送失败是常态记录，不做红字告警 -->
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
        <!-- push_logs 是全平台共用一张表（机器人推送 + CSV 导出对账），没有过滤项可做，只翻页 -->
        <el-pagination
          layout="total, prev, pager, next"
          :total="total"
          :page-size="query.page_size"
          :current-page="query.page"
          @current-change="(p) => { query.page = p; load(); }"
        />
      </template>
    </LabPane>

    <!-- 前缀是服务端写死的，改了要和 notifier.js 一起改；export 行只证明导出过，不证明对方收到 -->
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
/**
 * 通知记录面板，只读 GET /push-logs。一张表混装两类行：机器人推送（dingtalk/wecom/feishu）与
 * 取证导出的对账行（channel='export'、event_kind='csv_export'），所以这里既查通知有没有发出去，也查东西有没有发出去。
 * request 列在写入时就已过 maskUrl，令牌与查询串里的密钥已换成星，可以直接展示原文；掩码挪到显示层会让历史行里的真令牌裸奔。
 */
import { ref, reactive, onMounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
// ts = fmtTime 的别名：库里一律 UTC ISO 串，给操作员看要换本机时区；时间列宽 180px 按带秒的宽度排
import { fmtTime as ts } from '../../utils/time';

// 本页只读流水，不看授权，声明 gate 只为与其他面板签名一致
defineProps({ gate: { type: Object, default: null } });

// request/response 都是 JSON 串，点请求体才展开
const rows = ref([]);
const total = ref(0);
const dialog = ref(false);
// 美化过的 JSON，或解析失败时的原文
const detail = ref('');
const query = reactive({ page: 1, page_size: 20 });

/**
 * 不兜 catch：401 由拦截器清 token 并跳登录，其余错误让 Promise 落空、表格保留上一次数据，
 * 与同目录 GroupBoard / AuditPane 写法一致。
 */
async function load() {
  const data = await http.get('/push-logs', { params: query });
  rows.value = data.rows;
  total.value = data.total;
}

/** csv_export 行的 response 存的是文件名而不是 HTTP 响应，解析失败要原样显示，否则点开详情什么都看不到 */
function show(row) {
  try {
    detail.value = JSON.stringify(JSON.parse(row.request), null, 2);
  } catch {
    detail.value = row.request;
  }
  dialog.value = true;
}

// KeepAlive 缓存本页，切标签回来不重新请求，要新数据点刷新
onMounted(load);
</script>
