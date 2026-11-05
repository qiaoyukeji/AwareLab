<template>
  <!-- 只读审计流水、口径说明，外加与主区平级的详情抽屉（套在 .lab-stack 里盖不住整页） -->
  <div class="lab-stack">
    <LabPane flush title="操作审计" hint="记录授权登记与吊销、沙箱开关、真实发送、证据导出、证据与站点删除、运行参数变更。只读，不可修改删除。">
      <!-- 本页唯一的输入口：动作下拉 + 操作人 + 刷新，没有任何写动作 -->
      <template #ops>
        <el-select v-model="query.action" size="small" clearable placeholder="全部动作" style="width: 170px" @change="reload">
          <el-option v-for="(label, key) in ACTION_LABELS" :key="key" :label="label" :value="key" />
        </el-select>
        <el-input v-model="query.actor" size="small" clearable placeholder="操作人" style="width: 130px" @change="reload" />
        <el-button size="small" :icon="Refresh" @click="load">刷新</el-button>
      </template>

      <!-- 列序即取证顺序：时间、操作人、动作、来源 IP、对象、详情。对象只给 kind+id 不做中文名，对象可能早被删掉，主键才可核对 -->
      <!-- 时间列库里存 UTC，经 fmtTime 换本机时区显示，跟服务日志对表时要换回 UTC -->
      <!-- 定时清理与命令行收尾不在请求上下文里，actor/ip 落库为空，由 actorOf / ipOf 补成「非人工触发」，不显示成未知 -->
      <el-table :data="rows" size="small">
        <el-table-column prop="created_at" label="时间" width="180" :formatter="(row) => ts(row.created_at, { seconds: true })" />
        <el-table-column prop="actor" label="操作人" width="150" :formatter="(row) => actorOf(row)" />
        <el-table-column label="动作" width="150">
          <template #default="{ row }">
            <span class="lab-chip" :class="severity(row.action)">{{ ACTION_LABELS[row.action] || row.action }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="ip" label="来源" width="150" :formatter="(row) => ipOf(row)" />
        <el-table-column label="对象" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <!-- 对象 id 是 uuid，整串铺开会把「详情」挤出可视区：只留前 8 位，完整值进 title 与详情抽屉 -->
            <span class="lab-mono">{{ row.target_kind || '-' }}</span>
            <span :title="row.target_id">{{ (row.target_id || '').slice(0, 8) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="详情" width="90">
          <template #default="{ row }">
            <el-button link type="primary" @click="show(row)">查看</el-button>
          </template>
        </el-table-column>
        <template #empty><div class="lab-empty">还没有审计记录，做过授权登记或发信后这里会留下痕迹。</div></template>
      </el-table>

      <!-- 审计表只增不改，翻页不会看到重复或漂移的行，所以不做自动刷新 -->
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

    <!-- 把三条最容易事后扯皮的规则摆在页面上，接手的人不用翻文档就知道这张表能证明什么 -->
    <LabPane title="审计口径">
      <div class="lab-kv" style="row-gap: 6px">
        <span>审计只记<b>动作与当时的取值</b>，模型密钥与机器人令牌入库前已掩码，这里查不出可用的密钥。</span>
        <span>授权窗口一改，其下站点当场下线，停站数量一并记在详情里。</span>
        <span>审计写入失败只告警、不阻断演练链路，某条动作缺失时先查服务控制台。</span>
      </div>
    </LabPane>
  </div>

  <!-- 详情抽屉：标题跟动作码，正文是 detail 的缩进 JSON。密钥与令牌入库前已掩码，这里原样渲染，不再遮一道 -->
  <el-drawer v-model="dialog" :title="`审计详情 · ${ACTION_LABELS[active?.action] || active?.action || ''}`" size="640px">
    <div class="lab-kv" style="row-gap: 6px; margin-bottom: 12px">
      <span>操作人：<b>{{ actorOf(active) }}</b></span>
      <span>来源地址：<b class="lab-mono">{{ ipOf(active) }}</b></span>
      <span>时间：<b class="lab-mono">{{ ts(active?.created_at, { seconds: true }) }}</b></span>
    </div>
    <pre class="lab-mono">{{ detail }}</pre>
  </el-drawer>
</template>

<script setup>
/**
 * 操作审计面板：只读 GET /audit-logs。审计表在后端只开读接口，能事后修饰的记录就不叫审计。
 * detail 里的模型密钥与机器人令牌写库前已掩码，所以这里能整坨展开；本页不提供编辑与删除。
 * action 与 actor 是后端精确匹配，改筛选必须回第 1 页；某动作查无记录先怀疑服务控制台，审计写入失败只告警、不阻断演练链路。
 */
import { ref, reactive, onMounted } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import { fmtTime as ts } from '../../utils/time';

// 本面板用不上 gate，EvidenceWorkspace 对所有面板统一透传，保留签名一致
defineProps({ gate: { type: Object, default: null } });

/**
 * 键与后端 writeAudit 写入的 action 字段一一对应。库里冒出未登记的新码时模板回落到原始英文码，
 * 宁可露出英文也不显示成空白。
 */
const ACTION_LABELS = {
  'authorization.create': '登记授权',
  'authorization.update': '修改授权',
  'authorization.revoke': '吊销授权',
  'site.create': '新建钓鱼网站',
  'site.start': '开启网站监听',
  'site.stop': '停止网站监听',
  'site.delete': '删除钓鱼站点',
  'smtp.create': '新增发信邮箱',
  'smtp.update': '修改发信邮箱',
  'smtp.delete': '删除发信邮箱',
  'mail_task.sandbox_toggle': '关闭发信沙箱',
  'mail_task.sandbox_send': '沙箱发信',
  'mail_task.real_send': '真实发送',
  'mail_task.delete': '删除发信任务',
  'evidence.export': '导出证据',
  'evidence.delete': '删除上钩记录',
  'record.disposition': '标记处置状态',
  'record.disposition_batch': '批量标记处置',
  'record.secret_reveal': '查看采集明文',
  'report.export': '导出交付报告',
  'session.revoke_all': '吊销全部会话',
  'panel.password_change': '修改后台口令',
  'data.prune': '按保留期清理数据',
  'data.purge_all': '清空演练数据',
  'settings.update': '修改运行参数',
};

// 红标给一旦做错就收不回来的动作：真发、吊销、删除。关闭沙箱本身只是改配置，但一改之后每次发信都是真的，
// 所以与 real_send 同级；这里只决定配色，不决定可见性，审计表对所有动作一律全量可读
const SEVERE = new Set(['mail_task.real_send', 'mail_task.sandbox_toggle', 'authorization.revoke', 'evidence.delete', 'site.delete']);

const rows = ref([]);
// 只喂给 el-pagination 算页数，前端不拿它裁剪 rows
const total = ref(0);
const dialog = ref(false);
// 抽屉正文是 show() 现拼的字符串，不是接口字段，关掉后留着旧值无害
const detail = ref('');
// 存整行：抽屉标题要用 action，键值区要用 actor 与 ip
const active = ref(null);
const query = reactive({ page: 1, page_size: 20, action: '', actor: '' });

/** 命中 SEVERE 给红，其余给强调色；恒有返回值，保证每行动作都有底色 */
const severity = (action) => (SEVERE.has(action) ? 'is-danger' : 'is-accent');

/** 保留期清理与命令行收尾由服务进程自己写库，不带请求上下文，actor/ip 在库里就是空 */
const isSystemAction = (action) => action === 'data.prune' || action === 'data.purge_all';
const actorOf = (row) => row?.actor || (isSystemAction(row?.action) ? '非人工触发' : '未知');
const ipOf = (row) => row?.ip || (isSystemAction(row?.action) ? '本机进程' : '未知');

/**
 * 取当前页流水：GET /audit-logs。action/actor 为空时不进 query，后端两个条件都是精确匹配。
 * 不兜 catch：审计读不到必须让操作员看见报错，静默显示空表会被误读成没发生过。
 */
async function load() {
  const params = { page: query.page, page_size: query.page_size };
  if (query.action) params.action = query.action;
  if (query.actor) params.actor = query.actor;
  const data = await http.get('/audit-logs', { params });
  // detail 已由后端从 JSON 串解成对象，前端不用再 JSON.parse
  rows.value = data.rows;
  total.value = data.total;
}

/** 先归第 1 页：带着旧偏移查新条件会翻出一张空页 */
function reload() {
  query.page = 1;
  load();
}

/** detail 为空时给固定文案：空白块会被读成记录被抹掉了，实际只是这个动作没有附带取值 */
function show(row) {
  active.value = row;
  // 两格缩进：detail 里通常是改动前后的对照，压成一行看不出层级
  detail.value = row.detail ? JSON.stringify(row.detail, null, 2) : '（该动作未附带取值）';
  dialog.value = true;
}

// 外层 KeepAlive 会缓存本页，切走再切回不重发请求，要看最新流水点刷新
onMounted(load);
</script>
