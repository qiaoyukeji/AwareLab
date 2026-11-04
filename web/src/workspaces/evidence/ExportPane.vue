<template>
  <div class="lab-stack">
    <LabPane title="导出范围" hint="按演练类型导出上钩明细 CSV，用于演练复盘与全员安全意识评估报告。">
      <template #ops>
        <el-button :icon="Refresh" @click="load">刷新概览</el-button>
      </template>

      <div class="lab-grid" style="--cols: 4; margin-bottom: 14px">
        <LabMetric label="网页上钩明细" :value="stats.web" :extra="`其中已提交 ${stats.webSubmitted}`" />
        <LabMetric label="网页已提交" :value="stats.webSubmitted" tone="danger" />
        <LabMetric label="邮件上钩明细" :value="stats.mail" :extra="`其中已提交 ${stats.mailSubmitted}`" />
        <LabMetric label="邮件已提交" :value="stats.mailSubmitted" tone="danger" />
      </div>

      <div class="lab-toolbar" style="margin-bottom: 0">
        <el-radio-group v-model="kind">
          <el-radio-button value="web">网页采集</el-radio-button>
          <el-radio-button value="mail">邮件采集</el-radio-button>
        </el-radio-group>
        <el-button type="primary" :icon="Download" :loading="exporting" @click="doExport">
          导出{{ kind === 'web' ? '网页' : '邮件' }}证据（awarelab-{{ kind }}-evidence.csv）
        </el-button>
        <div class="lab-spacer" />
        <span class="lab-chip" :class="gate ? 'is-ok' : 'is-warn'">
          {{ gate ? '导出属于授权内复盘动作' : '未登记有效授权，请仅本地留存' }}
        </span>
      </div>
    </LabPane>

    <LabPane title="口径说明">
      <div class="lab-stack">
        <div class="lab-list">
          <div class="lab-list-item">
            <span class="lab-chip is-accent">漏斗</span>
            <span>打开 → 未提交 / 已提交：以「打开像素」回传计打开，以「链接跳转」后的表单记录计提交。</span>
          </div>
          <div class="lab-list-item">
            <span class="lab-chip">转化率</span>
            <span>转化率 = 提交人数 ÷ 打开人数；打开为空时不计转化率，避免除零误读。</span>
          </div>
          <div class="lab-list-item">
            <span class="lab-chip is-ok">评分</span>
            <span>风险评分 100 表示全员安全（无人提交），中招率越高分数越低。</span>
          </div>
          <div class="lab-list-item">
            <span class="lab-chip is-warn">边界</span>
            <span>导出内容含令牌、目标邮箱、时间、停留时长、终端特征与采集字段，仅供授权范围内使用；导出不含、也不得外发真实凭据。</span>
          </div>
        </div>
        <p class="lab-hint is-mute">
          CSV 列固定为：记录UUID、令牌、目标邮箱、网站/任务、首次打开、提交时间、停留秒、IP、系统、浏览器、采集内容。
        </p>
      </div>
    </LabPane>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { Download, Refresh } from '@element-plus/icons-vue';
import http, { download } from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';

defineProps({ gate: { type: Object, default: null } });

const kind = ref('web');
const exporting = ref(false);
const stats = ref({ web: 0, webSubmitted: 0, mail: 0, mailSubmitted: 0 });

async function load() {
  const [web, mail] = await Promise.all([
    http.get('/records', { params: { kind: 'web', page_size: 50 } }),
    http.get('/records', { params: { kind: 'mail', page_size: 50 } }),
  ]);
  stats.value = {
    web: web.total,
    webSubmitted: web.rows.filter((r) => r.submitted).length,
    mail: mail.total,
    mailSubmitted: mail.rows.filter((r) => r.submitted).length,
  };
}

async function doExport() {
  exporting.value = true;
  try {
    await download(`/reports/export?kind=${kind.value}`, `awarelab-${kind.value}-evidence.csv`);
    ElMessage.success('导出完成');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    exporting.value = false;
  }
}

onMounted(load);
</script>
