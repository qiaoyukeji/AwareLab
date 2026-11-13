<!--
  发送任务面板：一轮演练的正文、收件人名册、发信账号与沙箱开关都在这里配。
  沙箱默认开启，只渲染落 server/data/outbox/*.eml 不出网；真发必经确认弹窗手输待投人数，这一步不能省。
  gate 为 null 表示没有生效授权，所有真发入口置灰；附件与收件人导入要任务 id，故都先过 ensureTask。
-->
<template>
  <div class="lab-stack">
    <!-- 授权提示置顶：最常见的疑问是"点了发送怎么一封都没出去" -->
    <el-alert
      v-if="!gate"
      class="gate-alert"
      type="warning"
      :closable="false"
      show-icon
      title="未登记有效授权，发送任务不会真正发出"
    >
      <template #default>
        <span class="lab-hint">
          平台把演练授权作为硬性要求：没有处于生效窗口的授权时，服务端会拒绝发送请求。
          请先前往「演练授权」登记授权主体、有效期与授权名单。沙箱模式仍可用于渲染复核。
        </span>
      </template>
    </el-alert>

    <!-- 任务列表：一行=一轮投递 -->
    <LabPane flush title="发送任务" hint="任务是一次次演练：默认沙箱发送，不真的寄出邮件。">
      <template #ops>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建发送任务</el-button>
      </template>

      <!-- 不做分页控件：page_size=100 够覆盖一次演练的任务量，服务端上限 200 -->
      <el-table :data="rows" size="small">
        <el-table-column prop="title" label="任务标题" min-width="150" show-overflow-tooltip />
        <el-table-column prop="subject" label="邮件主题" min-width="160" show-overflow-tooltip />
        <!-- 状态由 runner 按真实成败落库，未知值原样显示 -->
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <span class="lab-chip" :class="TASK_CHIP[row.status] || ''">{{ TASK_LABEL[row.status] || row.status }}</span>
          </template>
        </el-table-column>
        <!-- 这一列是"有没有真寄出去"的分界，两种配色拉开 -->
        <el-table-column label="发送方式" width="110">
          <template #default="{ row }">
            <span class="lab-chip" :class="row.dry_run ? 'is-accent' : 'is-danger'">{{ row.dry_run ? '沙箱' : '真实发信' }}</span>
          </template>
        </el-table-column>
        <!-- 已投 = sent + sandboxed：沙箱落 .eml 算投过一轮，但没进收件箱 -->
        <el-table-column label="收件人 / 已提交" width="170">
          <template #default="{ row }">
            <span class="lab-hint">
              共 {{ row.stats.total }} · 已投 {{ row.stats.sent + row.stats.sandboxed }} · 失败 {{ row.stats.failed }} · 待发 {{ row.stats.pending }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="130">
          <template #default="{ row }"><span class="lab-hint">{{ ts(row.updated_at) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <!-- 空名册发一次只会吃服务端 400，先把按钮按住 -->
            <el-button link type="primary" :disabled="!row.stats.total" @click="send(row)">发送</el-button>
            <el-button link type="primary" @click="openScreen(row)">大屏</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty><div class="lab-empty">还没有发送任务，先新建一个：默认沙箱，随时可复核。</div></template>
      </el-table>

      <!-- 页脚那句要留着：沙箱→人工复核→真实发送的顺序得在页面上体现 -->
      <template #ft>
        <span class="lab-hint is-mute">
          前置条件：演练授权生效中 + 邮件文案素材 + 发信邮箱。沙箱任务只渲染并落 .eml 文件，供人工复核后才切真实发送。
        </span>
      </template>
    </LabPane>
  </div>

  <!-- 新建/编辑抽屉：小节按投递装配顺序排；附件与收件人要任务 id，故保存后才放开 -->
  <el-drawer v-model="editor" :title="form.id ? `编辑任务 - ${form.title || ''}` : '新建发送任务'" size="680px" :close-on-click-modal="false">
    <div class="lab-stack editor-body">
      <div class="lab-stack">
        <div class="sec-title lab-strong">基础信息</div>
        <el-form label-width="112px" label-position="left">
          <!-- 标题与主题必填：ensureTask 先拦一道，服务端再拦一道 -->
          <el-form-item label="任务标题" required><el-input v-model="form.title" placeholder="请输入任务标题" /></el-form-item>
          <el-form-item label="邮件主题" required><el-input v-model="form.subject" placeholder="邮件主题" /></el-form-item>
        </el-form>
      </div>

      <div class="lab-stack">
        <div class="sec-title lab-strong">素材绑定</div>
        <el-form label-width="112px" label-position="left">
          <!-- 邮件文案可选引用，选中即覆盖本任务的主题与正文；之后改素材不会回写已建的任务 -->
          <el-form-item label="邮件文案">
            <!-- 同名素材靠 id 前八位区分，完整 id 仍是下拉的取值 -->
            <el-select v-model="form.mail_template_id" clearable filterable placeholder="可选：选一份邮件文案，主题与正文会自动带入" style="width: 100%" @change="syncTemplate">
              <el-option v-for="t in mailTemplates" :key="t.id" :label="`${t.name} · ${t.id.slice(0, 8)}`" :value="t.id" />
            </el-select>
            <div style="width: 100%; margin-top: 8px"><RichEditor v-model="form.body_html" /></div>
            <div class="lab-hint is-mute">
              打开像素与链接跳转凭据由服务端 composer 在发送时逐人注入，正文里无需手写；
              正文中指向监听网站的链接会自动带上收件人专属令牌。
            </div>
          </el-form-item>
          <!-- 发信邮箱只在这里选，下拉给的是掩码值，真口令不进前端 -->
          <el-form-item label="发信邮箱">
            <el-select v-model="form.smtp_profile_id" clearable placeholder="选择「发信邮箱」里留存的配置" style="width: 300px">
              <el-option v-for="p in smtpProfiles" :key="p.id" :label="`${p.name} <${p.from_addr}>`" :value="p.id" />
            </el-select>
            <!-- 真连一次 SMTP 并登录，关沙箱前必点，否则整批发送一起失败 -->
            <el-button style="margin-left: 10px" :loading="testing" @click="testSmtp">连通性测试</el-button>
            <div class="lab-hint is-mute">账号在「发信邮箱」页留存，任务里一键复用；关闭沙箱时必选。</div>
          </el-form-item>
          <!-- 显示名可与 from_addr 不同，收件人看到的就是这行，仿冒点在此 -->
          <el-form-item label="发件人显示"><el-input v-model="form.sender" placeholder="可选，如 企业IT服务中心" style="width: 300px" /></el-form-item>
          <!-- 绑定站点决定"邮件里的域名:端口"：不绑时只能按任务里写死的绝对链接走，绑了以后
               {{site_url}}、链接改写与像素都落在该站点的监听端口（例如 8080），而不是管理端 7778 -->
          <el-form-item label="绑定网站">
            <el-select v-model="form.site_id" clearable filterable placeholder="选择一封邮件指向的钓鱼网站（推荐）" style="width: 360px">
              <!-- 地址在前、模板名在后：窄屏先截断的应是模板名，域名端口才是操作员要核对的信息 -->
              <el-option v-for="s in openSites" :key="s.id" :label="`${siteLabel(s)} · ${s.template_name || '钓鱼页'}`" :value="s.id" />
            </el-select>
            <div class="lab-hint is-mute">
              绑定后，正文里的 <code v-pre>{{site_url}}</code>、站内链接与打开像素都指向这个站点的端口；
              未绑定时若只有一台开启中的站点会自动用它，一台都没有时含 <code v-pre>{{site_url}}</code> 的任务会被拦下。
              收件人看到的跳转域名以这里为准。
            </div>
          </el-form-item>
          <!-- 已保存的任务才能传：服务端按任务 id 命名文件，防跨任务撞名。
               回调地址是协议 v2 的冻结约定，改措辞等于改协议 -->
          <el-form-item label="邮件附件">
            <template v-if="form.id">
              <el-upload :http-request="uploadAttachment" :show-file-list="false">
                <el-button type="primary">上传/替换附件</el-button>
              </el-upload>
              <el-button style="margin-left: 8px" type="danger" plain :disabled="!form.attachment_name" @click="dropAttachment">删除附件</el-button>
            </template>
            <el-button v-else disabled>保存后可上传附件</el-button>
            <div class="lab-hint is-mute">
              当前附件：{{ form.attachment_name || '未上传附件（无需附件下载可忽略）' }}。
              附件内程序请把上钩状态回调到 <code>/alab/v2/callback?tk=收件人令牌&amp;mail=邮箱</code>，multipart 表单字段即采集内容，截图字段固定为 capture。
            </div>
          </el-form-item>
        </el-form>
      </div>

      <div class="lab-stack">
        <div class="sec-title lab-strong">收件人</div>
        <el-form label-width="112px" label-position="left">
          <!-- 一人一令要在服务端落 capture_tokens，得有 task id 才能挂，所以没保存过就锁住 -->
          <el-form-item label="批量导入">
            <el-input
              v-model="recipientText"
              type="textarea"
              :rows="7"
              :disabled="!form.id"
              :placeholder="form.id ? RECIPIENT_PLACEHOLDER : '先保存任务基础信息后启用'"
            />
            <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center">
              <el-button type="primary" :loading="importing" :disabled="!form.id" @click="importRecipients">导入收件人</el-button>
              <!-- 三个数都由服务端给：同任务去重、格式不合格整行丢弃都在后端，前端不自计 -->
              <span v-if="importResult" class="lab-hint">
                新增 {{ importResult.added }}，重复跳过 {{ importResult.skipped }}，格式非法 {{ importResult.invalid }}
              </span>
            </div>
          </el-form-item>
          <!-- 专属令牌展示给操作员：它本来就是跟踪链接的身份，不算机密 -->
          <el-form-item label="已导入">
            <el-table :data="recipients" size="small" max-height="220">
              <el-table-column prop="email" label="邮箱" min-width="170" />
              <el-table-column prop="name" label="姓名" width="100" />
              <el-table-column prop="token" label="专属令牌" min-width="200" show-overflow-tooltip />
              <!-- 同一张状态表在编辑抽屉里也要说人话：下面详情屏用 STATUS_LABEL，这里直接 prop 会漏出 sandboxed 这种库内原值 -->
              <el-table-column prop="status" label="状态" width="110" :formatter="(r) => STATUS_LABEL[r.status] || r.status" />
              <template #empty><div class="lab-empty">尚未导入收件人。</div></template>
            </el-table>
          </el-form-item>
        </el-form>
      </div>

      <div class="lab-stack">
        <div class="sec-title lab-strong">发送设置</div>
        <el-form label-width="112px" label-position="left">
          <!-- 沙箱开关是这一页的分界线，默认留在沙箱侧 -->
          <el-form-item label="沙箱模式">
            <el-switch v-model="form.dry_run" active-text="沙箱（不真实发信）" inactive-text="真实发信" />
            <div class="lab-hint is-mute">
              沙箱只做模板渲染、令牌注入与发送记账，邮件文案落到 server/data/outbox/*.eml 供人工复核；
              关闭沙箱才会走 SMTP 真实发送。
            </div>
          </el-form-item>
          <!-- 风险提示只在关掉沙箱时出现，不许删 -->
          <el-alert
            v-if="!form.dry_run"
            class="risk-alert"
            type="error"
            :closable="false"
            show-icon
            title="风险提示：真实发信已开启"
            description="邮件将真实发送到收件人邮箱，请确认已获得书面授权、目标都在授权名单内，且内容与授权范围一致。"
          />
          <!-- 0 表示不限速；真发留几秒是防高频外发被服务商整批拦成垃圾 -->
          <el-form-item label="发送间隔">
            <el-input-number v-model="form.send_interval_ms" :min="0" :max="60000" :step="1000" />
            <div class="lab-hint is-mute">单封之间的等待毫秒数，规避高频发信被服务商拦截。</div>
          </el-form-item>
        </el-form>
      </div>
    </div>
    <!-- 保存并发送没有授权就置灰，是三个按钮里最危险的一个 -->
    <template #footer>
      <el-button @click="editor = false">关闭</el-button>
      <el-button :loading="saving" @click="saveOnly">保存</el-button>
      <el-button type="primary" :loading="sending" :disabled="!gate" @click="finish">保存并发送</el-button>
    </template>
  </el-drawer>

  <!-- 详情抽屉：台账行的 stats 不够用，数据每次都重拉 -->
  <el-drawer v-model="detailDrawer" :title="`任务详情 - ${detailTask?.title || ''}`" size="760px">
    <div v-if="detailTask" class="lab-stack detail-body">
      <div class="lab-stack">
        <div class="sec-title lab-strong">发送设置</div>
        <div class="lab-kv">
          <!-- 交付时要说明这一轮到底有没有真寄、按什么节奏寄 -->
          <span>发送方式：<b class="lab-strong">{{ Boolean(detailTask.dry_run) ? '沙箱（不真实发信）' : '真实发信' }}</b></span>
          <span>发送间隔：<b class="lab-mono" style="padding: 1px 6px">{{ detailTask.send_interval_ms }} ms</b></span>
          <span>附件：<b>{{ detailTask.attachment_name || '无' }}</b></span>
          <span>任务ID：<b class="lab-mono" style="padding: 1px 6px">{{ detailTask.id }}</b></span>
        </div>
        <div class="ops-row">
          <!-- 重发只在还有 pending/failed 时放开：runner 跳过已成功的收件人 -->
          <el-button type="primary" :disabled="!gate || !recipientCount" :loading="sending" @click="sendDetail">开始发送</el-button>
          <el-button :disabled="!gate || !(failedCount + pendingCount)" :loading="sending" @click="sendDetail">
            重发待投 / 失败（{{ failedCount + pendingCount }} 位）
          </el-button>
          <!-- 只在真发状态出现，把 dry_run 拨回 true -->
          <el-button v-if="!Boolean(detailTask.dry_run)" type="warning" plain @click="stopReal">拉回沙箱（停止真实发信）</el-button>
        </div>
        <div v-if="!gate" class="lab-hint" style="color: var(--lab-warn)">未登记有效授权，发送按钮已禁用，任务不会真正发出。</div>
        <p class="lab-hint is-mute">
          限速说明：按「发送间隔」逐封串行发送，仅处理待投与失败状态的收件人，已发送成功的不会被重复发出。
        </p>
      </div>

      <div class="lab-stack">
        <div class="sec-title lab-strong">收件人状态矩阵</div>
        <!-- 时间戳按服务端 ISO 串原样显示，人话解读在证据工作区 -->
        <el-table :data="detailRecipients" size="small" max-height="320">
          <el-table-column prop="email" label="邮箱" min-width="160" show-overflow-tooltip />
          <el-table-column label="送达" width="160">
            <template #default="{ row }">
              <span class="lab-chip" :class="STATUS_CHIP[row.status] || ''">{{ STATUS_LABEL[row.status] || row.status }}</span>
              <div v-if="row.sent_at" class="lab-hint is-mute">{{ ts(row.sent_at, { seconds: true }) }}</div>
            </template>
          </el-table-column>
          <!-- 三个时间列与上面「送达」同一口径：库里是带 Z 的 UTC，摊在名册表里要转成本地时区到秒 -->
          <el-table-column label="打开" width="170">
            <template #default="{ row }">{{ row.opened_at ? ts(row.opened_at, { seconds: true }) : '-' }}</template>
          </el-table-column>
          <el-table-column label="点击" width="170">
            <template #default="{ row }">{{ row.clicked_at ? ts(row.clicked_at, { seconds: true }) : '-' }}</template>
          </el-table-column>
          <el-table-column label="提交" width="170">
            <template #default="{ row }">{{ row.submitted_at ? ts(row.submitted_at, { seconds: true }) : '-' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="130" fixed="right">
            <template #default="{ row }">
              <!-- 预览：把这一封按任务当前配置现渲染，沙箱轮还会给出已落盘 .eml 的下载口 -->
              <el-button link type="primary" @click="openPreview(row)">预览</el-button>
              <!-- 单人补发：只把这一位拨回 pending，不重过整张队列 -->
              <el-button link type="primary" @click="resend(row)">重发</el-button>
            </template>
          </el-table-column>
          <template #empty><div class="lab-empty">尚未导入收件人。</div></template>
        </el-table>
      </div>

      <div class="lab-stack">
        <div class="sec-title lab-strong">附件</div>
        <div class="ops-row">
          <el-upload :http-request="uploadDetailAttachment" :show-file-list="false">
            <el-button>上传/替换附件</el-button>
          </el-upload>
          <el-button type="danger" plain :disabled="!detailTask.attachment_name" @click="dropDetailAttachment">删除附件</el-button>
        </div>
        <!-- 回调说明在编辑与详情两处各写一遍，详情里也要看得到 -->
        <p class="lab-hint is-mute">
          当前附件：{{ detailTask.attachment_name || '无' }}。
          附件内程序请把上钩状态回调到 <code>/alab/v2/callback?tk=收件人令牌&amp;mail=邮箱</code>，multipart 表单字段即采集内容，截图字段固定为 capture。
        </p>
      </div>
    </div>
  </el-drawer>

  <!-- 单封预览：正文由服务端按任务当前配置现渲染，iframe 里 sandbox 空集，脚本与表单都不执行 -->
  <el-dialog v-model="previewDlg" title="这一封长什么样" width="760px" destroy-on-close>
    <div class="lab-stack">
      <div class="lab-kv">
        <span>收件人：<b>{{ previewData.to }}</b></span>
        <span>
          状态：
          <span class="lab-chip" :class="STATUS_CHIP[previewData.status] || ''">{{ STATUS_LABEL[previewData.status] || previewData.status }}</span>
        </span>
      </div>
      <div class="lab-kv">
        <span>主题：<b>{{ previewData.subject }}</b></span>
      </div>
      <iframe class="mail-preview" :srcdoc="previewData.html" sandbox="" title="邮件正文预览" />
      <p class="lab-hint is-mute">
        正文按任务当前配置现渲染，改完任务再点预览就是新的；沙箱轮真正落盘的那一封可以用「下载 .eml」取走，用邮件客户端打开能看到原始头部。
      </p>
    </div>
    <template #footer>
      <el-button @click="previewDlg = false">关闭</el-button>
      <el-button type="primary" :disabled="!previewData.sandbox_file" @click="downloadEml">下载 .eml</el-button>
    </template>
  </el-dialog>

  <!-- 真实发送确认弹窗：非沙箱任务的所有投放入口必经这里，须手输服务端返回的待投人数并等满 5 秒倒计时。
       沙箱不进弹窗，各入口按 dry_run 分流，刻意不对称 -->
  <el-dialog v-model="confirmDlg" title="真实发送确认" width="580px" :close-on-click-modal="false" @closed="stopConfirmCountdown">
    <div class="lab-stack confirm-body">
      <el-alert
        type="error"
        :closable="false"
        show-icon
        title="这会向真实邮箱投递"
        :description="`邮件将经 ${confirmInfo.smtpFrom || '（未选择发信邮箱）'} 真实投递到收件人邮箱，一旦发出收不回。`"
      />
      <div class="lab-kv">
        <span>任务名称：<b>{{ confirmInfo.title || '—' }}</b></span>
        <span>本次将投递：<b class="lab-strong">{{ confirmCountText }}</b></span>
        <span>名册收件人共：<b>{{ confirmTotal }} 位</b></span>
      </div>
      <div class="lab-kv">
        <span>SMTP 发件地址：<b>{{ confirmInfo.smtpFrom || '未选择发信邮箱' }}</b></span>
        <span>链接指向的域名：<b>{{ confirmInfo.domains || '当前没有开启中的钓鱼网站' }}</b></span>
      </div>
      <div class="lab-kv">
        <span>当前授权范围：<b>{{ confirmInfo.scope }}</b></span>
        <span>授权有效期：<b>{{ confirmInfo.window }}</b></span>
      </div>
      <div class="lab-stack">
        <div class="sec-title lab-strong">手动输入人数以确认</div>
        <div class="lab-hint">
          请在下面输入本次要投递的收件人数量（阿拉伯数字）。输入与接口返回的实际待投人数不一致时，
          「开始真实发送」按钮保持禁用，卡住的原因会显示在输入框下方。
        </div>
        <!-- 掐掉回车：真发必须落到点按钮这一下 -->
        <el-input v-model="confirmInput" style="width: 220px" placeholder="输入待投递人数" @keydown.enter.prevent />
        <div v-if="confirmMismatchHint" class="lab-hint" style="color: var(--lab-warn)">{{ confirmMismatchHint }}</div>
        <div v-if="confirmServerError" class="lab-hint" style="color: var(--lab-danger)">
          服务端返回：{{ confirmServerError }}（点「刷新状态」重新拉授权与人数后才可能恢复可点）
        </div>
        <div v-if="confirmCountdown > 0" class="lab-hint">防手滑等待：还需 {{ confirmCountdown }} 秒。</div>
      </div>
    </div>
    <template #footer>
      <el-button @click="confirmDlg = false">取消</el-button>
      <el-button :loading="confirmRefreshing" @click="refreshConfirmStatus">刷新状态</el-button>
      <el-button type="danger" :disabled="!canRealSend" :loading="confirmSubmitting" @click="submitRealSend">
        {{ confirmCountdown > 0 ? `开始真实发送（${confirmCountdown} 秒后可点）` : '开始真实发送' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
// http 已拆掉 {code,data} 信封，await 的结果直接是业务数据（data.rows / data.task / data.recipients）。
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh } from '@element-plus/icons-vue';
import http, { download } from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import RichEditor from '../../components/RichEditor.vue';
// 详情里要带参调用，别名 ts 防止整行过长。
import { fmtTime as ts } from '../../utils/time';

// gate 是外层查好的生效授权，本面板只读；null 时所有真发入口都要拦下来。
const props = defineProps({ gate: { type: Object, default: null } });

// 后端存英文枚举，中文与色调只在这里翻译一次，模板里不再写 if。
// TASK_*：已发送指全发完，不等于都成功，失败数看详情抽屉的计数。
const TASK_LABEL = { draft: '草稿', sending: '发送中', sent: '已发送', partial: '部分失败', failed: '全部失败' };
const TASK_CHIP = { draft: 'is-warn', sending: 'is-accent', sent: 'is-ok', partial: 'is-warn', failed: 'is-danger' };
// STATUS_*：sandboxed 是沙箱落 .eml 成功，与 sent 分开配色，免得和真邮件混。
const STATUS_LABEL = { pending: '待发送', sent: '已发送', sandboxed: '沙箱已发送', failed: '失败' };
const STATUS_CHIP = { sent: 'is-ok', sandboxed: 'is-accent', failed: 'is-danger', pending: 'is-warn' };

// 单封预览弹窗：previewData 里 rid 只在本地记，用于拼 .eml 下载地址，服务端不返回
const previewDlg = ref(false);
const previewData = reactive({ rid: '', to: '', name: '', subject: '', status: '', html: '', sandbox_file: null });

// 解析与去重都在服务端，这里只是格式示例（每行 邮箱,姓名，姓名可省）。
const RECIPIENT_PLACEHOLDER = '每行一位收件人，格式：邮箱,姓名\nzhangsan@corp.example,张三';

// GET /mail-tasks 的当前页，只在本面板增删改与发送之后被 load() 整体重拉。
const rows = ref([]);
// 抽屉下拉用的三份目录：邮件素材、发信邮箱、监听中的网站。
const mailTemplates = ref([]);
const smtpProfiles = ref([]);
const openSites = ref([]);

// 新建与编辑共用同一套表单，靠 form.id 区分。
const editor = ref(false);
// sending 被两个抽屉的发送按钮共用：一次投放只发生在一处，拆成两份会出现点 A 时 B 还亮着。
const saving = ref(false);
const sending = ref(false);
const testing = ref(false);
const importing = ref(false);
// 导入文本整包 POST，前端不切行、不校验邮箱。
const recipientText = ref('');
// 已入库收件人，来自 GET /mail-tasks/:id 的 data.recipients。
const recipients = ref([]);
// 上次导入的回包，计数由服务端算，前端不自计。
const importResult = ref(null);

// 详情抽屉自成一套状态，与编辑抽屉的数据不互相覆盖。
const detailDrawer = ref(false);
const detailTask = ref(null);
const detailRecipients = ref([]);

// 字段名与 POST/PUT /mail-tasks 的入参一一对应。附件只存服务端回的名字，文件本身在磁盘上。
const form = reactive({
  id: '', title: '', mail_template_id: '', subject: '', body_html: '',
  attachment_name: '', smtp_profile_id: '', sender: '', site_id: '',
  send_interval_ms: 3000, dry_run: true,
});

// 三个计数从 detailRecipients 现算，保证和抽屉里那张名册表始终对得上。
const recipientCount = computed(() => detailRecipients.value.length);
const failedCount = computed(() => detailRecipients.value.filter((r) => r.status === 'failed').length);
const pendingCount = computed(() => detailRecipients.value.filter((r) => r.status === 'pending').length);

/** 重拉台账。page_size 被服务端钳到 200；本页不轮询，每个写动作之后都要显式调一次。 */
async function load() {
  const data = await http.get('/mail-tasks', { params: { page_size: 100 } });
  rows.value = data.rows;
}

/** 三份目录并发拉取。openSites 的判据是 status==='open' 而非 running，重启后没自动重开的站点仍会列出来。 */
async function loadMeta() {
  const [t, s, w] = await Promise.all([
    http.get('/mail-templates', { params: { page_size: 200 } }),
    http.get('/smtp-profiles'),
    http.get('/web-sites'),
  ]);
  mailTemplates.value = t.rows;
  smtpProfiles.value = s.rows;
  openSites.value = w.rows.filter((x) => x.status === 'open');
}

/** 站点行压成 域名:端口；domain 为空时退成"监听"，避免出现 " : 8080" 这种断头文本。 */
function siteLabel(s) {
  // 站点表没有独立 name 列（标题取模板名），域名优先、否则用监听地址:端口
  return s.domain ? `${s.domain}:${s.listen_port}` : `${s.listen_ip || '127.0.0.1'}:${s.listen_port}`;
}

/** 覆盖式重置表单，新建传 null，字段一律兜空串防后端回 null。
 *  send_interval_ms 用 ?? 而非 ||：0（不限速）是合法值；dry_run 强制 Boolean，后端可能回 0/1。 */
function resetForm(task) {
  Object.assign(form, {
    id: task?.id || '',
    title: task?.title || '',
    mail_template_id: task?.mail_template_id || '',
    subject: task?.subject || '',
    body_html: task?.body_html || '<p>您好：</p><p>请点击 <a href="#">链接</a> 完成核验。</p>',
    attachment_name: task?.attachment_name || '',
    smtp_profile_id: task?.smtp_profile_id || '',
    sender: task?.sender || '',
    site_id: task?.site_id || '',
    send_interval_ms: task?.send_interval_ms ?? 3000,
    dry_run: task ? Boolean(task.dry_run) : true,
  });
}

/** 打开新建抽屉，清掉上一个任务的残留，免得带着旧收件人和旧草稿提交。
 *  本页被外层 KeepAlive，素材与发信邮箱是打开抽屉这一刻才现登记的，不重新拉目录就会选不到。 */
function openCreate() {
  resetForm(null);
  recipients.value = [];
  importResult.value = null;
  recipientText.value = '';
  loadMeta();
  editor.value = true;
}

/** 单任务大屏：新标签页开深链，投屏与名单操作互不打断。 */
function openScreen(row) {
  window.open(`#/screen/task/${row.id}`, '_blank', 'noopener');
}

/** 打开编辑抽屉：台账行只是概览、正文可能没带全，必须回读 GET /mail-tasks/:id 拿 task 与 recipients。 */
async function openEdit(row) {
  loadMeta();
  const data = await http.get(`/mail-tasks/${row.id}`);
  resetForm(data.task);
  recipients.value = data.recipients;
  importResult.value = null;
  recipientText.value = '';
  editor.value = true;
}

/** 选素材时覆盖主题与正文，不合并；素材刚被删、id 找不到时静默返回，任务里仍存原正文。 */
function syncTemplate(id) {
  const t = mailTemplates.value.find((x) => x.id === id);
  if (!t) return;
  form.subject = t.subject || form.subject;
  form.body_html = t.body_html || form.body_html;
}

/**
 * 保存、导入、发送三条路共用的前置动作，校验不过回 null 让调用方中止；
 * 先查内容必填，再查关了沙箱有没有选发信邮箱。
 * 空值转 null 而非空串；每次发整份表单，PUT 只认白名单、没传的列保持原值。
 */
async function ensureTask() {
  if (!form.title || !form.subject || !form.body_html) {
    ElMessage.warning('任务标题、邮件主题、正文必填');
    return null;
  }
  if (!form.dry_run && !form.smtp_profile_id) {
    ElMessage.warning('关闭沙箱后必须选择发信邮箱');
    return null;
  }
  const payload = {
    title: form.title,
    mail_template_id: form.mail_template_id || null,
    subject: form.subject,
    body_html: form.body_html,
    smtp_profile_id: form.smtp_profile_id || null,
    sender: form.sender || null,
    site_id: form.site_id || null,
    send_interval_ms: form.send_interval_ms,
    dry_run: form.dry_run,
  };
  const data = form.id ? await http.put(`/mail-tasks/${form.id}`, payload) : await http.post('/mail-tasks', payload);
  form.id = data.id;
  return data;
}

/** 只落库不投递。ensureTask 校验失败时已弹过 warning，这里靠 falsy 静默跳过。 */
async function saveOnly() {
  saving.value = true;
  try {
    if (await ensureTask()) ElMessage.success('任务已保存');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
    load();
  }
}

/**
 * 上传附件。multipart 字段名固定 file，走 axios 实例时必须显式带 multipart 头，否则边界分隔符交不到服务端。
 * 回包的 name 是服务端净化过的落盘名，与 opt.file.name 多半不同，界面以它为准；旧附件留在磁盘不回收。
 */
async function uploadAttachment(opt) {
  const fd = new FormData();
  fd.append('file', opt.file);
  const data = await http.post(`/mail-tasks/${form.id}/attachment`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  form.attachment_name = data.name;
  ElMessage.success(`附件已上传：${data.name}`);
  load();
}

/** 只发 attachment_reset 标志，服务端把 name/path 置 NULL，磁盘文件不动；这里不能调 ensureTask 重写整份表单。 */
async function dropAttachment() {
  await http.put(`/mail-tasks/${form.id}`, { attachment_reset: true });
  form.attachment_name = '';
  load();
}

/** 真连一次 SMTP 并走完登录，不投递任何邮件。提示带 host:port，只说"成功"看不出地址配错。 */
async function testSmtp() {
  if (!form.smtp_profile_id) return ElMessage.warning('请先选择发信邮箱');
  testing.value = true;
  try {
    const data = await http.post(`/smtp-profiles/${form.smtp_profile_id}/test`);
    ElMessage.success(`SMTP 连接成功：${data.host}:${data.port}`);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    testing.value = false;
  }
}

/** 文本整包交给服务端解析，回 {added,skipped,invalid}；收件人挂在任务下，先走 ensureTask，完事重查详情。 */
async function importRecipients() {
  importing.value = true;
  try {
    if (!(await ensureTask())) return;
    importResult.value = await http.post(`/mail-tasks/${form.id}/recipients`, { text: recipientText.value });
    const detail = await http.get(`/mail-tasks/${form.id}`);
    recipients.value = detail.recipients;
    ElMessage.success(`导入完成，新增 ${importResult.value.added} 位收件人`);
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    importing.value = false;
  }
}

/**
 * 保存并发送：落库→确认有人→投放。先卡 props.gate（服务端 assertDeployment 的 403 才是最终裁决），
 * 再 ensureTask，再查名册非空。结果按 dry_run 分流，真发要说失败几封，全发完不等于全成功。
 */
/**
 * 投放结果给操作员的一句话：本轮没人可投要说清是「名册都投过了」，别让人以为发失败了；沙箱与真发各报各的数。
 */
function deliverNote(data) {
  if (!data.total) return `本轮没有待投收件人：名册 ${data.skipped} 位此前都已投递`;
  return data.dry_run
    ? `沙箱发送完成 ${data.sent} 封，正文已落到 server/data/outbox 供复核`
    : `真实发送完成 ${data.sent} 封，失败 ${data.failed} 封`;
}

/** 本轮投出去给绿条、空转给黄条：颜色也是口径的一部分，扫一眼就知道这一趟有没有干活 */
const deliverKind = (data) => (data.total ? 'success' : 'warning');

// —— 真实发送确认弹窗（非沙箱投放的唯一入口）——
// 邮件一旦寄出收不回，所以关掉沙箱之后，台账发送、抽屉发送、保存并发送、单人补发四条路都要在这里停一下。
const confirmDlg = ref(false);
const confirmTask = ref(null);
const confirmRoster = ref([]);
// confirmResendTo 有值表示这次只补一个人；null 是整队列投放，人数按待投口径算。
const confirmResendTo = ref(null);
const confirmInput = ref('');
const confirmServerError = ref('');
const confirmRefreshing = ref(false);
const confirmSubmitting = ref(false);
const confirmCountdown = ref(0);
let confirmTimer = null;

const CONFIRM_WAIT_SECONDS = 5;

/**
 * 本次真发的人数：单人补发固定 1 位；整队列算待投、失败，外加沙箱轮剩下的那批。
 * 沙箱发送把收件人标成 sandboxed 却没真投出去，转正式发送时它们必须重新入队，
 * 口径要与服务端 campaignRunner.pendingRecipients 第三参（dryRun=false）一致。
 */
const confirmCount = computed(() =>
  confirmResendTo.value
    ? 1
    : confirmRoster.value.filter((r) => r.status === 'pending' || r.status === 'failed' || r.status === 'sandboxed').length,
);
const confirmTotal = computed(() => confirmRoster.value.length);
const confirmCountText = computed(() => `${confirmCount.value} 位`);

/**
 * 弹窗里供人核对的上下文：任务、发信地址、链接落点、授权范围与窗口。
 * 全部取自本页已有的目录和 props.gate，不为这个弹窗另开端点。
 */
const confirmInfo = computed(() => {
  const task = confirmTask.value;
  const profile = smtpProfiles.value.find((p) => p.id === task?.smtp_profile_id);
  const lands = [...new Set(openSites.value.map((s) => s.domain || `${s.listen_ip}:${s.listen_port}`))];
  return {
    title: task?.title || '',
    smtpFrom: profile ? profile.from_addr : (task?.sender || ''),
    domains: lands.join('、'),
    scope: props.gate ? props.gate.scope : '（当前没有生效中的授权）',
    window: props.gate ? `${ts(props.gate.start_at)} → ${ts(props.gate.end_at)}` : '—',
  };
});

/** 只说对不对，不报该输几：手输这一位的意义就是操作员自己数过。 */
const confirmMismatchHint = computed(() => {
  if (!confirmInput.value) return '';
  return String(confirmInput.value).trim() === String(confirmCount.value) ? '' : '与本次待投人数不一致，按钮不会放开。';
});

/** 四道都过才放行：有授权、有真发对象、人数输对、防手滑等待走完。服务端拒绝过还要显式刷新才重试。 */
const canRealSend = computed(
  () =>
    !!props.gate &&
    !!confirmTask.value &&
    confirmCount.value > 0 &&
    !confirmServerError.value &&
    confirmCountdown.value === 0 &&
    String(confirmInput.value).trim() === String(confirmCount.value),
);

function startConfirmCountdown() {
  stopConfirmCountdown();
  confirmCountdown.value = CONFIRM_WAIT_SECONDS;
  confirmTimer = setInterval(() => {
    confirmCountdown.value -= 1;
    if (confirmCountdown.value <= 0) stopConfirmCountdown();
  }, 1000);
}

/** 关窗即清零：倒计时是这一轮确认的一部分，不能留着上一轮的进度。 */
function stopConfirmCountdown() {
  if (confirmTimer) {
    clearInterval(confirmTimer);
    confirmTimer = null;
  }
  confirmCountdown.value = 0;
}

/**
 * 打开弹窗前先回读任务与名册：台账行只有概览字段，待投人数必须以服务端为准，
 * 顺手把「别人在这期间把任务拉回沙箱」这种情况挡在门外。
 */
async function openRealSendConfirm(taskId, resendRow = null) {
  const detail = await http.get(`/mail-tasks/${taskId}`);
  if (detail.task.dry_run) return ElMessage.info('该任务处于沙箱模式，无需真实发送确认');
  if (!resendRow && !detail.recipients.some((r) => r.status === 'pending' || r.status === 'failed' || r.status === 'sandboxed'))
    return ElMessage.warning('名册里没有待投的收件人：这一轮的收件人都已经真发过了');
  confirmTask.value = detail.task;
  confirmRoster.value = detail.recipients;
  confirmResendTo.value = resendRow;
  confirmInput.value = '';
  confirmServerError.value = '';
  confirmDlg.value = true;
  startConfirmCountdown();
}

/** 重新拉一次任务与名册：授权掉窗口、别人改了沙箱、人数变了，都靠这一下摊开说清。 */
async function refreshConfirmStatus() {
  if (!confirmTask.value) return;
  confirmRefreshing.value = true;
  confirmServerError.value = '';
  try {
    const detail = await http.get(`/mail-tasks/${confirmTask.value.id}`);
    confirmTask.value = detail.task;
    confirmRoster.value = detail.recipients;
    if (detail.task.dry_run) {
      confirmDlg.value = false;
      ElMessage.info('任务已回到沙箱模式，本轮确认作废');
    }
  } catch (err) {
    confirmServerError.value = err.message;
  } finally {
    confirmRefreshing.value = false;
  }
}

/** 点「开始真实发送」才真正打投递接口；服务端拒绝留在弹窗里说理由，不让人关开重来。 */
async function submitRealSend() {
  if (!canRealSend.value) return;
  confirmSubmitting.value = true;
  try {
    if (confirmResendTo.value) {
      await http.post(`/mail-tasks/${confirmTask.value.id}/recipients/${confirmResendTo.value.id}/resend`);
      ElMessage.success(`已按确认向 ${confirmResendTo.value.email} 真实投递 1 封`);
    } else {
      const data = await http.post(`/mail-tasks/${confirmTask.value.id}/send`);
      ElMessage[deliverKind(data)](deliverNote(data));
    }
    confirmDlg.value = false;
    if (detailTask.value?.id === confirmTask.value.id) await refreshDetail();
    await load();
  } catch (err) {
    confirmServerError.value = err.message;
  } finally {
    confirmSubmitting.value = false;
  }
}

async function finish() {
  if (!props.gate) return ElMessage.warning('未登记有效授权，任务不会真正发出');
  sending.value = true;
  try {
    if (!(await ensureTask())) return;
    const detail = await http.get(`/mail-tasks/${form.id}`);
    if (!detail.recipients.length) return ElMessage.warning('请先导入收件人');
    // 刚把沙箱拨到真发就用这条按钮，同样不能直接寄出去：先落库关抽屉，再进确认弹窗
    if (!detail.task.dry_run) {
      editor.value = false;
      load();
      return openRealSendConfirm(form.id);
    }
    const data = await http.post(`/mail-tasks/${form.id}/send`);
    ElMessage[deliverKind(data)](deliverNote(data));
    editor.value = false;
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    sending.value = false;
  }
}

/** 台账行直接投放整张队列，不碰表单：库里已是最新内容，空队列由服务端 400 拦下。 */
async function send(row) {
  if (!props.gate) return ElMessage.warning('未登记有效授权，发送任务不会真正发出');
  // 真发不在这一步寄出去：行上的 dry_run 是库里最新的开关，非沙箱一律走确认弹窗
  if (!row.dry_run) return openRealSendConfirm(row.id);
  try {
    const data = await http.post(`/mail-tasks/${row.id}/send`);
    ElMessage[deliverKind(data)](deliverNote(data));
    load();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

/** 打开详情抽屉：台账行只有概览字段，附件名、沙箱开关、逐人状态都得回读，且要先替换数据再开抽屉。 */
async function openDetail(row) {
  const data = await http.get(`/mail-tasks/${row.id}`);
  detailTask.value = data.task;
  detailRecipients.value = data.recipients;
  detailDrawer.value = true;
}

/** 重查任务与名册。逐人状态由服务端 runner 推进，失败原因和时间戳都由它算，不做本地增量更新。 */
async function refreshDetail() {
  const data = await http.get(`/mail-tasks/${detailTask.value.id}`);
  detailTask.value = data.task;
  detailRecipients.value = data.recipients;
}

/** "开始发送"与"重发待投/失败"都走这里：runner 只处理 pending 与 failed 的收件人，已成功的不会重复发出。
 *  抽屉与台账两处都要刷，只刷一处当场对不上。 */
async function sendDetail() {
  if (!props.gate) return ElMessage.warning('未登记有效授权，发送任务不会真正发出');
  if (!detailTask.value.dry_run) return openRealSendConfirm(detailTask.value.id);
  sending.value = true;
  try {
    const data = await http.post(`/mail-tasks/${detailTask.value.id}/send`);
    ElMessage[deliverKind(data)](deliverNote(data));
    await refreshDetail();
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    sending.value = false;
  }
}

/**
 * 拉回沙箱：只传 dry_run 这一个键，PUT 整份表单会覆盖别人期间的改动。
 * 服务端翻这个标志时写 mail_task.sandbox_toggle 审计；已发出的真邮件收不回来，只影响还没发的收件人。
 */
async function stopReal() {
  await http.put(`/mail-tasks/${detailTask.value.id}`, { dry_run: true });
  ElMessage.success('已拉回沙箱，后续发送不再真实发信');
  await refreshDetail();
  load();
}

/** 详情抽屉的附件上传，与编辑抽屉同端点，只是任务 id 取自 detailTask；两个抽屉各刷各的视图。 */
async function uploadDetailAttachment(opt) {
  const fd = new FormData();
  fd.append('file', opt.file);
  await http.post(`/mail-tasks/${detailTask.value.id}/attachment`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  ElMessage.success('附件已上传');
  await refreshDetail();
  load();
}

/** 详情抽屉的删除附件：只发 attachment_reset 标志摘掉库里的引用，磁盘文件不回收。 */
async function dropDetailAttachment() {
  await http.put(`/mail-tasks/${detailTask.value.id}`, { attachment_reset: true });
  await refreshDetail();
  load();
}

/**
 * 单封预览：只读，不改任何状态。正文由服务端 renderMailBody 现渲染，
 * 沙箱轮还会带上 sandbox_file（.eml 是否已落盘），据此决定「下载 .eml」按钮亮不亮。
 */
async function openPreview(r) {
  try {
    const data = await http.get(`/mail-tasks/${detailTask.value.id}/recipients/${r.id}/preview`);
    Object.assign(previewData, data, { rid: r.id });
    previewDlg.value = true;
  } catch (e) {
    ElMessage.error(e.message);
  }
}

/** 下载沙箱产物：走 client 的原生 fetch 下载口（绕开 axios 拦截器才拿得到 blob），文件名带上收件人便于归档。 */
async function downloadEml() {
  if (!previewData.rid) return;
  try {
    const name = `${detailTask.value.title || 'mail'}-${previewData.to}.eml`;
    await download(`/mail-tasks/${detailTask.value.id}/recipients/${previewData.rid}/eml`, name);
  } catch (e) {
    ElMessage.error(e.message);
  }
}

/**
 * 单人补发：只把这一位拨回 pending 单独投递，不重过整张队列。
 * 服务端按 id AND task_id 一起查，别家的 rid 冒不了本任务的名；这条路由没有 assertDeployment，
 * 前端仍先卡 props.gate，补发同样算投放动作——任务在真发档时，一位也要过确认弹窗。
 */
async function resend(r) {
  if (!props.gate) return ElMessage.warning('未登记有效授权，发送任务不会真正发出');
  if (!detailTask.value.dry_run) return openRealSendConfirm(detailTask.value.id, r);
  await http.post(`/mail-tasks/${detailTask.value.id}/recipients/${r.id}/resend`);
  ElMessage.success('已重新发送');
  await refreshDetail();
  load();
}

/** 库里没有外键级联，服务端显式先删 mail_recipients 再删 mail_tasks；磁盘附件、events、capture_tokens 与已采记录都保留。
 *  撤计划不算投放，不设授权门禁。确认框放在 try 外面，点取消的 reject 不会被误报成删除失败。 */
async function remove(row) {
  await ElMessageBox.confirm(`确认删除任务「${row.title}」及其收件人队列？`, '删除确认', { type: 'warning' });
  try {
    await http.delete(`/mail-tasks/${row.id}`);
    ElMessage.success('已删除');
    load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

// 本页被外层 KeepAlive，切回来不重新挂载，要看新状态点"刷新"；两个请求都不 await。
onMounted(() => {
  load();
  loadMeta();
});
</script>

<style scoped>
/* .editor-body/.detail-body 的 2px 是给 Element 抽屉自带 padding 兜底的微调，不是魔术数字。 */
.gate-alert { margin-bottom: var(--lab-gap); }
.editor-body { padding: 2px; }
.detail-body { padding: 2px 4px; }
.sec-title {
  font-size: 12.5px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--lab-line-2);
}
.risk-alert { margin: 0 0 12px; }
/* el-space 横排不换行，参考网站的 chip 自己开 flex-wrap 才能占满整行。 */
.site-chips { display: flex; flex-wrap: wrap; gap: 6px; width: 100%; }
/* 附件与收件人两处都用它排按钮和上传控件，靠 gap 而不是 margin 撑开。 */
.ops-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
/* 预览正文按邮件本身的窄版式渲染，白底黑字，别继承管理面的深色主题 */
.mail-preview { width: 100%; height: 420px; border: 1px solid var(--lab-line-2); border-radius: 6px; background: #fff; }
</style>
