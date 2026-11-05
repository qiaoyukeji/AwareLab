<template>
  <div class="mandate">
    <!-- 平台总开关：current 为空时显示平台已锁住的说明，进度条按剩余百分比着色 -->
    <LabPane
      class="gate-pane"
      :class="{ 'is-open': !!current }"
      title="当前授权状态"
      :hint="current ? '以下字段改动即时生效，无需重新登记' : '平台在授权解锁前拒绝一切建站与发信'"
    >
      <template #ops>
        <span class="lab-chip" :class="current ? 'is-ok' : 'is-danger'">
          <span class="lab-dot" :class="{ 'is-live': !!current }" />
          {{ current ? STATUS_LABEL[current.effective] : '无有效授权' }}
        </span>
        <span v-if="current" class="lab-hint">{{ countdown }}</span>
        <el-button size="small" :disabled="!current" @click="current && openEdit(current)">编辑当前授权</el-button>
      </template>

      <!-- 起止一律 fmt() 到秒：有效期是硬边界，只到分会让 9:00 整开的站看起来提前一分钟就生效 -->
      <template v-if="current">
        <div class="lab-bar gate-bar">
          <div class="lab-bar-fill" :class="barTone" :style="{ width: remainPct + '%' }" />
        </div>
        <div class="lab-kv gate-kv">
          <span>授权主体 <b>{{ current.scope }}</b></span>
          <span>对接人 <b>{{ current.contact || '—' }}</b></span>
          <span>有效期起 <b>{{ fmt(current.start_at) }}</b></span>
          <span>有效期止 <b>{{ fmt(current.end_at) }}</b></span>
          <span>授权名单条数 <b>{{ hostsOf(current).length }}</b></span>
          <span>备注 <b>{{ current.note || '—' }}</b></span>
        </div>
        <div class="host-row">
          <span v-for="h in hostsOf(current)" :key="h" class="lab-chip is-accent">{{ h }}</span>
        </div>
      </template>

      <!-- 过期记录直接编辑续期即可，不必重新登记 -->
      <p v-else class="lab-hint gate-off">
        <span class="lab-strong">平台已拒绝建站、开启网站与邮件发送</span>，钓鱼网站对任何访问都返回不可用。
        请在下方「授权记录」登记授权；若已有过期记录，直接对其 <span class="lab-strong">编辑续期</span> 即可，不必重新登记。
      </p>
    </LabPane>

    <!-- 授权记录：一次演练 = 一条授权 -->
    <LabPane flush title="授权记录" hint="每一次演练都归属到这里的一条记录">
      <template #ops>
        <el-button type="primary" size="small" @click="openCreate">登记新授权</el-button>
        <el-button size="small" @click="load">刷新</el-button>
      </template>
      <div style="padding: 0 14px" class="rule-note">
        <p class="lab-hint">
          平台把授权作为硬性要求：没有处于有效期内的记录时，钓鱼网站无法创建与开启、邮件任务拒绝发送，名单外的域名访问一律被拒绝。
          修改授权内容后，若该授权已不在生效窗口，其下网站会被自动停止监听；吊销授权同样立即停止所有网站。
          <span class="lab-strong">已吊销的记录不可修改，只能重新登记。</span>
        </p>
        <p class="lab-hint">
          「生成报告」与「导出交付CSV」每按一次都会各写一条 <span class="lab-mono-inline">report.export</span> 审计（谁在什么时候为哪条授权导走了什么形态）；
          两份交付物中口令一律掩码、邮箱部分掩码，可以直接交给甲方。
        </p>
      </div>
      <!-- 状态列读 row.effective（后端按此刻算出的档），按钮读 row.status（是否吊销），两回事 -->
      <el-table :data="rows" size="small">
        <el-table-column prop="scope" label="授权主体" min-width="150" show-overflow-tooltip />
        <el-table-column prop="contact" label="对接人" width="110" show-overflow-tooltip />
        <el-table-column label="有效期" width="170">
          <template #default="{ row }">
            <div class="win">{{ fmt(row.start_at) }}</div>
            <div class="win">~ {{ fmt(row.end_at) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="授权名单" min-width="180">
          <template #default="{ row }">
            <span v-for="h in hostsOf(row)" :key="h" class="lab-chip is-accent host-mini">{{ h }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="86">
          <template #default="{ row }">
            <span class="lab-chip" :class="STATUS_CHIP[row.effective] || ''">{{ STATUS_LABEL[row.effective] || row.effective }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="120" show-overflow-tooltip />
        <!-- 下行三个按钮不按 status 禁用：复盘动作在吊销之后照样要做，不受授权门禁管 -->
        <el-table-column label="操作" width="248" fixed="right">
          <template #default="{ row }">
            <div class="ops-row">
              <el-button link type="primary" :disabled="row.status !== 'active'" @click="openEdit(row)">编辑</el-button>
              <el-button link type="danger" :disabled="row.status !== 'active'" @click="revoke(row)">吊销</el-button>
            </div>
            <div class="ops-row">
              <el-button link type="primary" @click="openSummary(row)">演练汇总</el-button>
              <!-- 两条出口都走 window.open，鉴权靠登录时落下的 HttpOnly Cookie -->
              <el-dropdown trigger="click" @command="(cmd) => openReport(row, cmd)">
                <el-button link type="primary">生成报告</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="inline">在新标签页打开（可打印为 PDF）</el-dropdown-item>
                    <el-dropdown-item command="download">下载 HTML 文件</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-button link type="primary" @click="exportCsv(row)">导出交付CSV</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!rows.length" class="lab-empty">尚无授权记录，点击「登记新授权」开始第一次演练。</div>
      <!-- 取证 CSV 含明文凭据、仅限本机，交付 CSV 与 HTML 报告是掩码版，三者不能混用 -->
      <template #ft>
        <p class="lab-hint" style="margin: 0">
          三份导出物用途不同：<span class="lab-strong">取证 CSV</span>（「上钩记录 · 导出」）含<span class="lab-strong">明文凭据</span>，供操作员自查与教育对账，仅限本机留存；
          本页的<span class="lab-strong">交付 CSV</span>与<span class="lab-strong">HTML 报告</span>（可打印为 PDF）都是<span class="lab-strong">掩码交付件</span>：口令一律掩码、邮箱部分掩码，可以交给甲方。
          交付 CSV 与 HTML 报告每生成一次各写一条 report.export 审计；取证 CSV 另有导出留痕，两套留痕互不替代。
        </p>
      </template>
    </LabPane>

    <!-- 登记与编辑共用抽屉，editingId 决定标题与 POST/PUT；close-on-click-modal=false 防止误点空白清掉填了一半的内容 -->
    <el-drawer
      v-model="drawer"
      :title="editingId ? '修改演练授权' : '登记演练授权'"
      size="560px"
      :close-on-click-modal="false"
      direction="rtl"
    >
      <!-- statement 由后端 /authorizations/pledge 下发，平台不自己编免责话；取不到时兜底中性文案 -->
      <div class="pledge-tip">
        <span class="lab-strong">{{ statement || '本平台仅用于授权范围内的安全意识演练。' }}</span>
        <p class="lab-hint">
          请确认你已获得被测组织的书面授权，并且演练目标、时间窗口与下方登记内容一致。
          <template v-if="editingId">修改授权内容同样需要重新输入使用承诺。</template>
        </p>
      </div>

      <!-- 四段顺序对应后端的校验要件，承诺栏放在最后一段 -->
      <el-form label-position="top" class="auth-form">
        <section>
          <h4 class="sec-t">授权主体与对接人</h4>
          <el-form-item label="授权主体" required>
            <el-input v-model="form.scope" placeholder="如：某某科技 信息安全部（对应授权文件中的被演练组织）" />
          </el-form-item>
          <el-form-item label="对接人">
            <el-input v-model="form.contact" placeholder="授权方联系人 / 工单号" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="form.note" type="textarea" :rows="2" placeholder="授权文件编号、审批链等" />
          </el-form-item>
        </section>

        <section>
          <h4 class="sec-t">有效期</h4>
          <!-- 起止存 UTC ISO（value-format 带 .000Z），显示给操作员的是本机时区（见 fmt()） -->
          <el-form-item label="起止时间" required>
            <el-date-picker
              v-model="form.range"
              type="datetimerange"
              value-format="YYYY-MM-DDTHH:mm:ss.000Z"
              start-placeholder="开始时间"
              end-placeholder="结束时间"
              style="width: 100%"
            />
          </el-form-item>
          <p class="lab-hint is-mute">
            缩短有效期属于高危改动：保存时若该授权已滑出生效窗口，其下正在监听的网站会被立即停止，并在结果里告诉你停了几台。
          </p>
        </section>

        <section>
          <h4 class="sec-t">授权名单</h4>
          <el-form-item label="允许仿冒的域名或标记（每行一个）" required>
            <el-input
              v-model="form.hosts"
              type="textarea"
              :rows="4"
              placeholder="每行一个允许仿冒的域名或标记：&#10;corp.example.com&#10;*.mail.example.com&#10;#ip（允许直接用 IP 访问钓鱼网站）"
            />
          </el-form-item>
          <!-- 名单实时预览：解析只做换行与逗号切分、去空，域名合法性由后端把关 -->
          <div class="host-preview">
            <span v-for="(h, i) in parsedHosts" :key="`${h}-${i}`" class="lab-chip is-accent">{{ h }}</span>
            <span v-if="!parsedHosts.length" class="lab-chip is-danger">授权名单为空，无法保存</span>
          </div>
          <p class="lab-hint is-mute">
            支持三种写法：<span class="lab-mono-inline">#ip</span>（IP 直连访问钓鱼网站）、<span class="lab-mono-inline">*.domain</span>（泛域名）、
            <span class="lab-mono-inline">corp.example.com</span>（精确域名）。钓鱼网站只服务授权名单里写到的域名。
          </p>
        </section>

        <section>
          <h4 class="sec-t">使用承诺</h4>
          <el-form-item label="手动完整输入下方承诺语句后才允许保存" required>
            <el-input v-model="form.pledge" :placeholder="`请完整输入：${requiredPledge}`" />
          </el-form-item>
          <!-- 逐字比对用 ===，大小写与空白都算；页面不给复制入口，也不提示错在哪一位 -->
          <div class="pledge-check">
            <span class="lab-chip" :class="pledgeMatched ? 'is-ok' : 'is-danger'">
              {{ pledgeMatched ? '承诺文本一致，可以保存' : '承诺文本尚未完整输入' }}
            </span>
          </div>
          <p class="lab-hint is-mute">
            这是平台的硬约束：承诺必须由操作者本人按输入框提示逐字键入，页面不提供复制、自动填充或跳过入口。
          </p>
        </section>
      </el-form>

      <template #footer>
        <!-- 禁用只看 pledgeMatched；名单与主体为空由 save() 的提示负责 -->
        <div class="drawer-foot">
          <el-button @click="drawer = false">取消</el-button>
          <el-button type="primary" :loading="saving" :disabled="!pledgeMatched" @click="save">
            {{ editingId ? '保存修改并生效' : '确认并启用' }}
          </el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 汇总按后端返回形状原样渲染：数字要与甲方报告一字不差（同一数据源），前端不再算一遍 -->
    <el-drawer v-model="sumDrawer" :title="sumTitle" size="720px" direction="rtl">
      <div v-if="sumLoading" class="lab-empty">汇总加载中…</div>
      <div v-else-if="summary" class="sum-body">
        <section>
          <h4 class="sec-t">授权依据与范围</h4>
          <!-- 起止与登记时间走 fmt() 带秒，和登记抽屉、报告页脚同一口径 -->
          <div class="lab-kv" style="row-gap: 6px">
            <span>授权主体 <b>{{ summary.authorization.scope }}</b></span>
            <span>对接人 <b>{{ summary.authorization.contact || '—' }}</b></span>
            <span>记录状态 <b>{{ summary.authorization.status === 'revoked' ? '已吊销' : '未吊销' }}</b></span>
            <span>有效期起 <b>{{ fmt(summary.authorization.start_at) }}</b></span>
            <span>有效期止 <b>{{ fmt(summary.authorization.end_at) }}</b></span>
            <span>登记时间 <b>{{ fmt(summary.authorization.created_at) }}</b></span>
            <span>承诺原文 <b>{{ summary.authorization.pledge || '—' }}</b></span>
            <span>备注 <b>{{ summary.authorization.note || '—' }}</b></span>
          </div>
          <div class="host-row" style="margin-top: 8px">
            <span v-for="h in summary.authorization.allowed_hosts" :key="h" class="lab-chip is-accent">{{ h }}</span>
            <span v-if="!summary.authorization.allowed_hosts.length" class="lab-hint is-mute">未登记授权名单</span>
          </div>
        </section>

        <section>
          <h4 class="sec-t">总体结果与时间跨度</h4>
          <div class="lab-grid" style="--cols: 4">
            <LabMetric label="投放目标" :value="summary.overall.targets" unit="个" extra="登记收件人 + 网页打开终端，按令牌去重" />
            <LabMetric label="命中终端" :value="summary.overall.hooked" unit="个" tone="danger" extra="真正提交过凭据的终端" />
            <LabMetric label="整体中招率" :value="summary.overall.hook_rate" unit="%" tone="danger" />
            <LabMetric label="演练跨度" :value="summary.window.days" unit="天" :extra="`${fmt(summary.window.first_at)} ~ ${fmt(summary.window.last_at)}`" />
          </div>
          <p class="lab-hint is-mute" style="margin: 8px 0 0">
            本次上钩记录共 {{ summary.overall.record_total }} 条；跨度按记录与收件人两侧时间的极值计算，同一天起止也算 1 天，无任何数据时为 0 天。
          </p>
        </section>

        <section>
          <h4 class="sec-t">钓鱼网页漏斗</h4>
          <div class="lab-grid" style="--cols: 4">
            <LabMetric label="钓鱼网页数" :value="summary.web.sites" unit="个" />
            <LabMetric label="打开" :value="summary.web.opened" unit="次" />
            <LabMetric label="打开未提交" :value="summary.web.not_submitted" unit="次" />
            <LabMetric label="提交凭据" :value="summary.web.submitted" unit="次" tone="danger" :extra="`网页转化率 ${summary.web.conversion}%（以打开数为分母）`" />
          </div>
          <p class="lab-hint is-mute" style="margin: 8px 0 0">
            网页侧上钩记录 {{ summary.web.records }} 条；另有邮件链记录 {{ summary.web.mail_records }} 条，计入下方邮件漏斗。
          </p>
        </section>

        <section>
          <h4 class="sec-t">钓鱼邮件漏斗</h4>
          <div class="lab-grid" style="--cols: 4">
            <LabMetric label="发送任务" :value="summary.mail.tasks" unit="个" :extra="`其中 ${summary.mail.real_send_tasks} 个关掉沙箱、真实外发`" />
            <LabMetric label="登记收件人" :value="summary.mail.recipients" unit="人" />
            <LabMetric label="投递 / 打开" :value="`${summary.mail.sent} / ${summary.mail.opened}`" extra="打开依赖图片信标，被客户端拦截时偏保守" />
            <LabMetric label="提交凭据" :value="summary.mail.submitted" unit="人" tone="danger" :extra="`邮件转化率 ${summary.mail.conversion}%（以登记收件人为分母）`" />
          </div>
        </section>

        <section>
          <h4 class="sec-t">教育覆盖</h4>
          <div class="lab-grid" style="--cols: 4">
            <LabMetric label="上钩记录" :value="summary.education.total" unit="条" />
            <LabMetric label="未处置" :value="summary.education.new" unit="条" :tone="summary.education.new ? 'danger' : ''" />
            <LabMetric label="已联系" :value="summary.education.contacted" unit="条" tone="warn" />
            <LabMetric label="已教育" :value="summary.education.educated" unit="条" tone="accent" />
            <LabMetric label="已关闭" :value="summary.education.closed" unit="条" tone="accent" />
            <LabMetric label="教育覆盖率" :value="summary.education.coverage_rate" unit="%" tone="accent" />
            <LabMetric label="处置率" :value="summary.education.handled_rate" unit="%" />
          </div>
          <!-- 口径说明与甲方报告同源，两处说法不能分叉 -->
          <p class="lab-hint" style="margin: 8px 0 0">
            教育覆盖率 =（已教育 + 已关闭）/ 上钩记录总数；「已联系但未完成教育」计入处置率而不计入覆盖率，与交付报告同一口径。
          </p>
        </section>

        <section>
          <h4 class="sec-t">终端环境分布</h4>
          <template v-if="hasDevices">
            <div class="host-row">
              <span v-for="(n, name) in summary.devices.os_buckets" :key="`os-${name}`" class="lab-chip">{{ name }} · {{ n }} 台</span>
            </div>
            <div class="host-row" style="margin-top: 6px">
              <span v-for="(n, name) in summary.devices.browser_buckets" :key="`br-${name}`" class="lab-chip is-accent">{{ name }} · {{ n }} 台</span>
            </div>
            <p class="lab-hint is-mute" style="margin: 8px 0 0">第一行按操作系统、第二行按浏览器分桶；只统计网页侧上钩记录。</p>
          </template>
          <div v-else class="lab-empty">本轮未采到终端信息（没有网页侧上钩记录）。</div>
        </section>

        <section>
          <h4 class="sec-t">逐站点明细</h4>
          <el-table v-if="summary.sites.length" :data="summary.sites" size="small">
            <el-table-column prop="listen_port" label="端口" width="70" />
            <el-table-column label="仿冒域名" min-width="140" show-overflow-tooltip>
              <template #default="{ row }">{{ row.domain || '（未绑定域名）' }}</template>
            </el-table-column>
            <el-table-column label="页面素材" min-width="120" show-overflow-tooltip>
              <template #default="{ row }">{{ row.template_name || '（素材已删除）' }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="90" />
            <el-table-column prop="opened" label="打开" width="64" />
            <el-table-column prop="submitted" label="提交" width="64" />
          </el-table>
          <div v-else class="lab-empty">该授权名下未创建钓鱼网站。</div>
        </section>

        <section>
          <h4 class="sec-t">逐任务明细</h4>
          <el-table v-if="summary.tasks.length" :data="summary.tasks" size="small">
            <el-table-column prop="title" label="任务" min-width="120" show-overflow-tooltip />
            <el-table-column prop="subject" label="主题" min-width="140" show-overflow-tooltip />
            <el-table-column label="沙箱" width="150">
              <template #default="{ row }">
                <span class="lab-chip" :class="row.dry_run ? '' : 'is-danger'">{{ row.dry_run ? '开启（未真实外发）' : '已关闭（真实外发）' }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="90" />
            <el-table-column prop="recipients" label="收件人" width="70" />
            <el-table-column prop="sent" label="投递" width="60" />
            <el-table-column prop="opened" label="打开" width="60" />
            <el-table-column prop="submitted" label="提交" width="60" />
          </el-table>
          <div v-else class="lab-empty">该授权名下未创建发送任务。</div>
        </section>

        <section>
          <h4 class="sec-t">交付物</h4>
          <p class="lab-hint" style="margin: 0">
            这一屏供内部核对；要带出本机请用列表「操作」列的 <span class="lab-strong">生成报告</span>（HTML，可打印为 PDF）与
            <span class="lab-strong">导出交付CSV</span>，两者口令已掩码、邮箱部分掩码，且各写一条 report.export 审计。
          </p>
        </section>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
/**
 * 演练授权面板：授权记录、登记与编辑、演练汇总与交付三件套，三个写动作在后端各落一条 authorization.* 审计。
 */
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
// CSV 是非信封响应，不能过 http 拦截器，所以单独用 download；API_BASE 给 window.open 拼报告地址
import http, { download, API_BASE } from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';
import { fmtTime as ts } from '../../utils/time';

// gate 由 AppShell 传下来，只在本页还没取到列表时当兜底的当前授权用（见 current）
const props = defineProps({ gate: { type: Object, default: null } });

/** effective → 中文标签。missing 是后端查不到授权时的哨兵值；吊销是主动拉闸，过期是窗口走完，两个词不混用。 */
const STATUS_LABEL = { active: '生效中', expired: '已过期', pending: '未开始', revoked: '已吊销', missing: '无' };
/** effective → 芯片配色。revoked 给灰不给红：吊销是演练的正常收尾，不是告警。missing 由模板的 `|| ''` 兜住。 */
const STATUS_CHIP = { active: 'is-ok', expired: 'is-danger', pending: 'is-warn', revoked: '' };
// 表单初值：打开抽屉前整体铺一遍，避免上一条记录的 pledge 残留
const BLANK = { scope: '', contact: '', range: [], hosts: '', note: '', pledge: '' };

// GET /authorizations 的全量结果，不分页：一家单位通常就几条
const rows = ref([]);
const drawer = ref(false);
const saving = ref(false);
// editingId 为 null 表示这次是新建，决定标题、按钮文案与提交方式
const editingId = ref(null);
// 后端下发的承诺原文与平台声明；pledge 取不到时 requiredPledge 保持空串，于是永远存不下去（fail-closed）
const requiredPledge = ref('');
const statement = ref('');
const form = reactive({ ...BLANK });

// 演练汇总抽屉：sumRow 供标题取 scope，summary 存后端返回原样，不裁剪、不换算
const sumDrawer = ref(false);
const sumLoading = ref(false);
const sumRow = ref(null);
const summary = ref(null);

/**
 * 页头总开关与进度条的数据源：列表里 effective 为 active 的行。
 * 列表为空时回落 props.gate，免得刷新瞬间闪成"无有效授权"；只剩过期或未开始记录时返回 null。
 */
const current = computed(() => rows.value.find((r) => r.effective === 'active') ?? (rows.value.length ? null : props.gate));

/** 读出某条授权的名单数组。后端已把 allowed_hosts 还原成数组，这里再兜一层：旧形状是 JSON 串，返回空数组而不是让 v-for 炸掉整页。 */
function hostsOf(row) {
  return Array.isArray(row?.allowed_hosts) ? row.allowed_hosts : [];
}

/**
 * 授权页时间显示：UTC → 本机时区，固定带秒。
 * 窗口按秒判定，只到分会让"11:00 整到期"的授权在 10:59:50 看起来还有余量，据此发起的发送会被门禁拒掉。
 */
function fmt(iso) {
  return ts(iso, { seconds: true });
}

/**
 * 有效期剩余百分比：剩余时间 / 整个窗口长度，钳在 0~100。
 * 未开始的授权能算出大于 100，不夹住进度条会溢出容器。
 */
const remainPct = computed(() => {
  const c = current.value;
  if (!c) return 0;
  const start = new Date(c.start_at).getTime();
  const end = new Date(c.end_at).getTime();
  // 起止倒挂的窗口与解析不出日期的 NaN 都走这里：NaN 参与比较恒为 false，按 0 画
  // 与后端 mandate.js 的 effectiveStatus 一样保守：宁可显示没余量，也不把无法判定的授权画成还有大半程
  if (!(end > start)) return 0;
  return Math.max(0, Math.min(100, Math.round(((end - Date.now()) / (end - start)) * 100)));
});

/** 进度条配色：剩余 15% 以内红，40% 以内黄，其余不着色。 */
const barTone = computed(() => (remainPct.value < 15 ? 'is-danger' : remainPct.value < 40 ? 'is-warn' : ''));

/**
 * 倒计时文案：按剩余量换单位，只给一个数。
 * 不足 1 天时改用小时且强制至少 1 小时，显示"剩余 0 小时"会让人以为已经过期。
 */
const countdown = computed(() => {
  const c = current.value;
  if (!c) return '';
  const days = (new Date(c.end_at).getTime() - Date.now()) / 86400000;
  if (days <= 0) return '已到有效期止';
  if (days < 1) return `剩余 ${Math.max(1, Math.round(days * 24))} 小时`;
  return `剩余 ${days.toFixed(1)} 天`;
});

/**
 * 名单输入解析成 allowed_hosts：换行和逗号都切，逐段去空白丢空项。
 * 不校验域名合法性，这里抢先判定会把后端的错误文案顶掉。
 */
const parsedHosts = computed(() => form.hosts.split(/[\n,]/).map((s) => s.trim()).filter(Boolean));

/**
 * 承诺是否与后端原文逐字一致（=== 全等，大小写标点空白都算）。
 * requiredPledge 为空时恒为 false，保存按钮永远点不动：连承诺原文都拿不到就不该放行登记。
 */
const pledgeMatched = computed(() => !!requiredPledge.value && form.pledge === requiredPledge.value);

/**
 * 重取授权列表，连带刷新页头总开关、进度条、倒计时与状态芯片。
 * effective 是按此刻算出的派生值，本地猜不出级联结果，所以每个写操作后都要重读一次。
 */
async function load() {
  rows.value = (await http.get('/authorizations')) || [];
}

/**
 * 打开登记抽屉：editingId 归 null，表单铺 BLANK，hosts 预填 '#ip'。
 * 漏了 #ip 就只能用域名访问钓鱼网站，IP 直连会被名单挡掉，而空栏的报错只说"名单必填"。
 */
function openCreate() {
  editingId.value = null;
  // 换行只是把光标留在下一行；空行在解析时被 filter(Boolean) 丢掉
  Object.assign(form, { ...BLANK, hosts: '#ip\n' });
  drawer.value = true;
}

/**
 * 打开修改抽屉，用列表行回填表单；过期与未开始的行照样能进来续期。
 * pledge 强制留空：修改同样要求重新逐字输入承诺，回填旧文本等于拆掉这道闸门。
 */
function openEdit(row) {
  editingId.value = row.id;
  Object.assign(form, {
    scope: row.scope,
    contact: row.contact || '',
    // 回填成 UTC ISO，与 date-picker 的 value-format 同一解析口径，否则窗口整体平移一个时区差
    range: [new Date(row.start_at).toISOString(), new Date(row.end_at).toISOString()],
    hosts: hostsOf(row).join('\n'),
    note: row.note || '',
    pledge: '',
  });
  drawer.value = true;
}

/** 组装提交给后端的授权对象，新建与修改同形状（后端按整条替换处理）。range 原样提交，二次换算会错一个时区差。 */
function payload() {
  return {
    scope: form.scope,
    contact: form.contact,
    start_at: form.range[0],
    end_at: form.range[1],
    allowed_hosts: parsedHosts.value,
    pledge: form.pledge,
    note: form.note,
  };
}

/**
 * 保存：editingId 有值走 PUT，否则 POST。三条前置守卫在这里收口，按钮的 disabled 只挡承诺那一条。
 * 新窗口滑出生效期时后端会级联停站并回传 stopped_sites，反之复服并回传 reopened_sites；两个数字必须原样进提示。
 */
async function save() {
  if (!form.scope || !form.range?.length) return ElMessage.warning('授权主体与有效期必填');
  if (!parsedHosts.value.length) return ElMessage.warning('授权名单必填：至少一条域名、泛域名或 #ip');
  if (!pledgeMatched.value) return ElMessage.warning('请手动完整输入使用承诺');
  saving.value = true;
  try {
    const editing = !!editingId.value;
    const res = editing
      ? await http.put(`/authorizations/${editingId.value}`, payload())
      : await http.post('/authorizations', payload());
    if (editing && res?.stopped_sites) {
      ElMessage.warning(`修改已保存；该授权已不在生效窗口，停止 ${res.stopped_sites} 个网站监听`);
    } else if (editing && res?.reopened_sites) {
      ElMessage.success(`授权已更新并生效；恢复 ${res.reopened_sites} 个此前因出窗口而下线的网站监听`);
    } else {
      ElMessage.success(editing ? '授权已更新并生效' : '授权已登记，平台能力解锁');
    }
    drawer.value = false;
    Object.assign(form, { ...BLANK });
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

/**
 * 吊销：危险确认后 POST /authorizations/:id/revoke。软删除，授权内容、站点配置与已采证据都留着以便复盘。
 * 其下所有网站立即停监听，并落一条带停站数的 authorization.revoke 审计；确认框点取消时 ElMessageBox reject，什么都不改。
 */
async function revoke(row) {
  await ElMessageBox.confirm(`吊销授权「${row.scope}」将同时停止其下所有钓鱼网站监听，确认？`, '高危操作', { type: 'warning' });
  try {
    await http.post(`/authorizations/${row.id}/revoke`);
    ElMessage.success('已吊销');
    load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

/** 汇总抽屉标题带上授权主体，同时比对多条授权时它是"这屏数字属于谁"的唯一线索。 */
const sumTitle = computed(() => (sumRow.value ? `演练汇总 · ${sumRow.value.scope}` : '演练汇总'));

/** 两个分桶都为空时回 false，模板显示一行 lab-empty：两排空芯片会被读成渲染坏了而不是没有数据。 */
const hasDevices = computed(() => {
  const d = summary.value?.devices;
  return !!d && (Object.keys(d.os_buckets || {}).length > 0 || Object.keys(d.browser_buckets || {}).length > 0);
});

/**
 * 打开汇总抽屉，现取 GET /insight/authorizations/:id/summary。任何 status 都能进来：复盘不受授权门禁管，纯读不落审计。
 * 漏斗、按终端去重、覆盖率都由后端 drillReport.js 一份实现，与甲方报告同源，前端再算一遍早晚差出一个数。
 * 404 时关抽屉：留着一屏空壳会被读成这次演练一个人没上钩。
 */
async function openSummary(row) {
  sumRow.value = row;
  summary.value = null;
  sumDrawer.value = true;
  sumLoading.value = true;
  try {
    summary.value = await http.get(`/insight/authorizations/${row.id}/summary`);
  } catch (err) {
    ElMessage.error(err.message);
    sumDrawer.value = false;
  } finally {
    sumLoading.value = false;
  }
}

/**
 * 打开甲方级报告：window.open GET /insight/authorizations/:id/report；mode 为 download 时带 ?download=1 另存为文件。
 * 新标签页带不上 x-alab-token 头，过鉴权靠 login 时落下的 HttpOnly alab_token Cookie（requireSession 兜底）；
 * 这条兜底哪天被删，这里要改回 fetch 带令牌头 → blob → objectURL。授权不存在时新标签页直出 404 信封 JSON。
 * 每导一次写一条 report.export 审计；samples 不做控件，后端默认 5、钳 1-20，样本越多掩码前的明文读取面越大。
 */
function openReport(row, mode) {
  const suffix = mode === 'download' ? '?download=1' : '';
  window.open(`${API_BASE}/insight/authorizations/${row.id}/report${suffix}`, '_blank');
}

/**
 * 导出交付 CSV：GET /insight/authorizations/:id/export.csv，口令全掩、邮箱部分掩，可以交甲方，每导一次写一条 report.export 审计。
 * 走 download() 而不是 http：CSV 是非信封响应，过拦截器会被当 JSON 解析坏。
 */
async function exportCsv(row) {
  try {
    await download(`/insight/authorizations/${row.id}/export.csv`, reportName(row, 'csv'));
    ElMessage.success('交付 CSV 已导出（凭据已掩码，可交甲方）');
  } catch (err) {
    ElMessage.error(err.message);
  }
}

/**
 * 交付物落盘文件名 awarelab-report-<scope 安全字符>-<今日>.<ext>，只含 [A-Za-z0-9._-]，scope 空时兜底 id 前 8 位。
 * download() 忽略后端的 Content-Disposition、必须传 filename；净化规则要与 insightApi.reportFilename 逐字同步，
 * 否则同一份交付物会有两种文件名，对不上审计里记的那一份。
 */
function reportName(row, ext) {
  const safe =
    String(row.scope || row.id)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || String(row.id).slice(0, 8);
  return `awarelab-report-${safe}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

/**
 * 进场先取承诺原文再取列表：pledge 是保存闸门的判据，必须先落地，列表慢一点没关系。
 * 取承诺失败时静默置空 requiredPledge，pledgeMatched 恒为 false、按钮全程禁用（fail-closed），列表照样继续读。
 */
onMounted(async () => {
  try {
    const p = await http.get('/authorizations/pledge');
    requiredPledge.value = p.pledge;
    statement.value = p.statement;
  } catch {
    requiredPledge.value = '';
  }
  load();
});
</script>

<style scoped>
.mandate { display: flex; flex-direction: column; gap: var(--lab-gap); }
.gate-pane.is-open { border-left: 3px solid var(--lab-accent); }
.gate-bar { height: 8px; margin-bottom: 12px; }
.gate-kv { margin-bottom: 12px; }
.host-row { display: flex; flex-wrap: wrap; gap: 6px; }
.host-mini { margin: 2px 3px 2px 0; }
.gate-off { margin: 0; }
.rule-note { padding-top: 12px; }
.win { font-size: 12px; color: var(--lab-ink-4); line-height: 1.6; }
.pledge-tip {
  background: var(--lab-warn-soft);
  border: 1px solid #eddcbf;
  border-radius: var(--lab-r);
  padding: 10px 12px;
  margin-bottom: 16px;
  color: var(--lab-warn);
}
.auth-form section { margin-bottom: 18px; }
.sec-t {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
  color: var(--lab-ink);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--lab-line-2);
}
.host-preview { display: flex; flex-wrap: wrap; gap: 6px; margin: -6px 0 8px; }
.lab-mono-inline {
  font-family: Consolas, "Cascadia Mono", monospace;
  font-size: 12px;
  background: var(--lab-fill);
  border: 1px solid var(--lab-line);
  border-radius: var(--lab-r-sm);
  padding: 0 4px;
  color: var(--lab-ink-2);
}
.pledge-check { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: -6px 0 8px; }
.drawer-foot { display: flex; justify-content: flex-end; gap: 8px; }
/* 相邻 el-button 的默认 margin-left 必须归零，否则与 gap 叠出双倍缝；el-dropdown 不吃那条规则 */
.ops-row { display: flex; align-items: center; gap: 12px; }
.ops-row + .ops-row { margin-top: 5px; }
.ops-row .el-button + .el-button { margin-left: 0; }
/* 两排指标格上下叠时留一行缝 */
.sum-body section { margin-bottom: 18px; }
.sum-body .lab-grid + .lab-grid { margin-top: 10px; }
</style>
