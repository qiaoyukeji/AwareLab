<template>
  <!-- 概览与导出入口在上，口径说明在下：让人在点下去之前就知道导出来的是什么口径 -->
  <div class="lab-stack">
    <LabPane title="导出范围" hint="按演练类型导出上钩明细 CSV，用于演练复盘与全员安全意识评估报告。">
      <template #ops>
        <el-button :icon="Refresh" @click="load">刷新概览</el-button>
      </template>

      <!-- 已提交是算中招率的分子，给 danger 色 -->
      <div class="lab-grid" style="--cols: 4; margin-bottom: 14px">
        <LabMetric label="网页上钩明细" :value="stats.web" :extra="`其中已提交 ${stats.webSubmitted}`" />
        <LabMetric label="网页已提交" :value="stats.webSubmitted" tone="danger" />
        <LabMetric label="邮件上钩明细" :value="stats.mail" :extra="`其中已提交 ${stats.mailSubmitted}`" />
        <LabMetric label="邮件已提交" :value="stats.mailSubmitted" tone="danger" />
      </div>

      <!-- 按钮文案与落盘文件名都跟着 kind 走；导出属复盘动作，无授权时不禁按钮，只要求仅本地留存 -->
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

    <!-- 四条规则各管一件事：漏斗怎么数、转化率怎么算、评分怎么读、导出的边界在哪 -->
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
            <span>导出内容含令牌、目标邮箱、时间、停留时长、终端特征与采集字段明文，属敏感数据，按公司数据分级要求保管或销毁，不得外发。</span>
          </div>
        </div>
        <!-- 抄的是后端 CSV_HEADER，两处必须同步改；CSV 里的时间是库里 UTC ISO 原值，不走 fmtTime -->
        <p class="lab-hint is-mute">
          CSV 列固定为：记录UUID、令牌、目标邮箱、站点/任务、首次打开、提交时间、停留秒、IP、系统、浏览器、处置状态、采集内容。
        </p>
      </div>
    </LabPane>
  </div>
</template>

<script setup>
/**
 * 证据导出面板：概览读 GET /records?kind=...，导出走 GET /reports/export?kind=...。
 * CSV 里的采集内容是明文，这条通道一次留两道痕：push_logs 一行加 audit_logs 一条 evidence.export，
 * 缺一处事后就说不清证据去了哪。本页自身不发写请求。
 */
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { Download, Refresh } from '@element-plus/icons-vue';
import http, { download } from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';

// gate 只决定右上角 chip 的措辞，不阻断导出按钮
defineProps({ gate: { type: Object, default: null } });

// 按钮文案、文件名、请求参数三处都读它
const kind = ref('web');
// 点一次就在后端多落两条流水，转圈同时防连点
const exporting = ref(false);
// 初始全 0，请求没回来时也是完整的四格
const stats = ref({ web: 0, webSubmitted: 0, mail: 0, mailSubmitted: 0 });

/**
 * 两发 GET /records 并发取概览。page_size 50 只为抽样数已提交条数：
 * total 是全库口径，submitted 是这 50 行里数出来的，某侧超过 50 条时两个数不同源（导出的 CSV 本身全量）。
 * 取太多会把 records 行连 form_json 一起扛回浏览器。失败时 stats 保持上一次数字。
 */
async function load() {
  const [web, mail] = await Promise.all([
    http.get('/records', { params: { kind: 'web', page_size: 50 } }),
    http.get('/records', { params: { kind: 'mail', page_size: 50 } }),
  ]);
  stats.value = {
    // r.submitted 是后端由 submitted_at 派生的布尔
    web: web.total,
    webSubmitted: web.rows.filter((r) => r.submitted).length,
    mail: mail.total,
    mailSubmitted: mail.rows.filter((r) => r.submitted).length,
  };
}

/**
 * kind 由单选按钮组保证只有 web/mail 两个取值，后端其余一律 400，顺带挡住文件名与响应头注入。
 * 用 download() 不用 http.get()：CSV 是 blob 且不是信封响应，过 axios 拦截器会被当 JSON 解析失败。
 */
async function doExport() {
  exporting.value = true;
  try {
    await download(`/reports/export?kind=${kind.value}`, `awarelab-${kind.value}-evidence.csv`);
    ElMessage.success('导出完成');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    // 放 finally：失败也要让按钮回到可点，否则一次网络抖动就把导出锁死
    exporting.value = false;
  }
}

// 导出成功后不自动刷新：导的是全库，概览数字不会因为导出而变化
onMounted(load);
</script>
