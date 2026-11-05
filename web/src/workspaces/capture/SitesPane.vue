<template>
  <div class="lab-stack">
    <!-- 未授权时可建档，但不能开站对外监听 -->
    <el-alert v-if="!gate" type="warning" :closable="false" show-icon
      title="未登记有效授权，钓鱼网站无法开启"
      description="网站可以先建好、先关着；但要真正监听端口对目标提供服务，必须先在「演练授权」登记授权主体、有效期与授权名单。" />
    <!-- 有授权时显示作用域与名单条数；名单外域名在访客侧直接拒绝 -->
    <el-alert v-else type="info" :closable="false" show-icon
      :title="`授权生效中 · ${gate.scope} · 授权名单 ${gate.allowed_hosts?.length || 0} 条`"
      description="钓鱼网站只对授权名单里的域名开放，名单外的访问直接拒绝；授权到期或被吊销时，名下网站会同步停止监听。" />

    <div class="lab-grid" style="--cols: 4">
      <LabMetric label="钓鱼网站" :value="rows.length" unit="个" :extra="`本页 ${shownCount} 条`" />
      <!-- 监听中按 running 实时值计，不含 status=open 但端口没起的 -->
      <LabMetric label="监听中" :value="liveCount" unit="个" :tone="liveCount ? 'accent' : ''" extra="保存为开启状态即占用端口" />
      <LabMetric label="未监听" :value="rows.length - liveCount" unit="个" extra="关闭或异常，不占用任何端口" />
      <LabMetric label="端口占用" :value="portCount" unit="个" :extra="`可用区间 ${portRange[0]}-${portRange[1]}`" />
    </div>

    <!-- 网站监听主表：一行=一张假登录页 + 一个监听地址端口 -->
    <LabPane flush title="网站监听" hint="每个网站独占一个端口，保存即按 监听地址:端口 开启采集">
      <template #ops>
        <el-button size="small" plain type="danger" :disabled="!selection.length" @click="batchRemove">
          删除选中 {{ selection.length }}
        </el-button>
        <el-button size="small" type="primary" :icon="Plus" @click="openCreate">新建钓鱼网站</el-button>
        <el-button size="small" :icon="Refresh" @click="reload">刷新</el-button>
      </template>

      <!-- 多选只服务于批量删除；不分页，站点数被端口区间封顶 -->
      <el-table :data="rows" size="small" @selection-change="(v) => (selection = v)">
        <el-table-column type="selection" width="40" />
        <!-- 状态列合读 status 与 running，标签与配色走函数 -->
        <el-table-column label="状态" width="86">
          <template #default="{ row }">
            <span class="lab-chip" :class="statusTone(row)">
              <span class="lab-dot" :class="{ 'is-live': row.running }" />{{ statusLabel(row) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="template_name" label="假登录页" min-width="150" show-overflow-tooltip />
        <!-- 访问地址是服务端派生的对外服务地址（域名/0.0.0.0→127.0.0.1/默认端口省略），不是专属链接 -->
        <el-table-column label="访问地址" min-width="210">
          <template #default="{ row }">
            <a class="lab-hint site-link" :href="row.url" target="_blank" rel="noreferrer">{{ row.url }}</a>
          </template>
        </el-table-column>
        <el-table-column label="监听" width="140">
          <template #default="{ row }"><span class="mono-inline">{{ row.listen_ip }}:{{ row.listen_port }}</span></template>
        </el-table-column>
        <el-table-column label="协议" width="76">
          <template #default="{ row }">{{ row.tls_cert ? 'HTTPS' : 'HTTP' }}</template>
        </el-table-column>
        <!-- 授权主体是建站时绑定的授权，级联下线与续期复服都按它算 -->
        <el-table-column prop="auth_scope" label="授权主体" min-width="130" show-overflow-tooltip />
        <el-table-column label="操作" width="268" fixed="right">
          <template #default="{ row }">
            <!-- 按钮方向由 status 决定；停止不设前端门禁，开启无授权时服务端 403 -->
            <el-button link type="primary" @click="toggle(row)">{{ row.status === 'open' ? '停止' : '开启' }}</el-button>
            <el-button link type="primary" @click="openPeek(row)">链接与上钩</el-button>
            <el-button link type="primary" @click="issueLink(row)">生成专属链接</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="lab-empty">还没有钓鱼网站。先在「钓鱼素材」备好假登录页，再回到这里挂到监听端口。</div>
        </template>
      </el-table>
    </LabPane>

    <!-- 新建抽屉：三段对应服务端建站的三组校验；close-on-click-modal=false 防止误点空白丢建档 -->
    <el-drawer v-model="drawer" size="620px" :close-on-click-modal="false">
      <template #header><span class="lab-pane-t">新建钓鱼网站</span></template>

      <div class="lab-stack drawer-sections">
        <section>
          <div class="section-t">绑定素材</div>
          <el-form label-position="top">
            <!-- 素材只选已保存的假登录页；一张素材可被多端口复用，历史取证不随草稿丢 -->
            <el-form-item label="假登录页" required>
              <el-select v-model="form.template_id" placeholder="选择钓鱼素材里已保存的假登录页" style="width: 100%">
                <el-option v-for="t in templates" :key="t.id" :label="`${t.type} · ${t.name}`" :value="t.id" />
              </el-select>
              <div class="lab-hint is-mute">共 {{ templates.length }} 份可用素材；需要新增请切到「钓鱼素材 · 假登录页」。</div>
            </el-form-item>
            <!-- 先关闭时 close_reason=manual，授权续期不会被误复活；立即开启是建站的通常意图 -->
            <el-form-item label="开启状态">
              <el-radio-group v-model="form.status">
                <el-radio-button value="open">立即开启</el-radio-button>
                <el-radio-button value="closed">先关闭</el-radio-button>
              </el-radio-group>
            </el-form-item>
          </el-form>
        </section>

        <section>
          <div class="section-t">监听地址</div>
          <el-form label-position="top">
            <el-form-item label="监听 IP">
              <el-input v-model="form.listen_ip" placeholder="对本机所有网卡服务就填 0.0.0.0" />
              <div class="lab-hint is-mute">填 0.0.0.0 时这个端口对本机所有网卡开放，同一网络内都能访问；只在本机验证就填 127.0.0.1。管理后台默认只听 127.0.0.1，与这里互不影响。</div>
            </el-form-item>
            <!-- 端口区间读自 /settings 的 capture_port_range；区间外服务端必拒，前端不写死免得口径漂移 -->
            <el-form-item label="监听端口">
              <el-input v-model.number="form.listen_port" :placeholder="`${portRange[0]}-${portRange[1]}，注意防火墙放通与端口占用`" />
              <div class="lab-hint is-mute">端口落在配置区间内才会被接受；区间在「系统设置 · 运行参数」里。</div>
            </el-form-item>
            <!-- 域名可留空（只用 IP:端口）；填了必须命中授权名单或泛域名，校验在服务端 -->
            <el-form-item label="监听域名">
              <el-input v-model="form.domain" placeholder="可选，仅当用域名访问时填写，例如 lab.example.cn" />
              <div class="lab-hint is-mute">域名必须落在「演练授权」登记的授权名单内，否则钓鱼网站会直接拒绝访问。</div>
            </el-form-item>
          </el-form>
        </section>

        <section>
          <!-- TLS 可选：两段都留空即 HTTP；只填证书不填私钥服务端 400 拒收 -->
          <div class="section-t">HTTPS（可选）</div>
          <el-form label-position="top">
            <el-form-item label="TLS 私钥">
              <el-input v-model="form.tls_key" type="textarea" :rows="3"
                placeholder="-----BEGIN PRIVATE KEY----- 开头的 PEM 私钥，留空则走 HTTP" />
            </el-form-item>
            <el-form-item label="TLS 证书">
              <el-input v-model="form.tls_cert" type="textarea" :rows="3"
                placeholder="-----BEGIN CERTIFICATE----- 开头的 PEM 证书，与私钥同时提供" />
            </el-form-item>
          </el-form>
        </section>
      </div>

      <template #footer>
        <div class="drawer-foot">
          <!-- 令牌不进表单，建好站后由专属链接携带 -->
          <span class="lab-hint is-mute footer-note">创建后令牌由专属链接携带，可在列表「生成专属链接」为每位收件人单独生成。</span>
          <el-button @click="drawer = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="save">创建钓鱼网站</el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 按站点回看抽屉：一张网的链接清单与上钩记录并列，两个只读接口 -->
    <el-drawer v-model="peek" size="820px" :close-on-click-modal="false">
      <template #header>
        <!-- 标题的站点名取自列表行，停开监听后头部跟着变 -->
        <span class="lab-pane-t">链接与上钩 · {{ peekSite?.template_name || '钓鱼网站' }}</span>
      </template>

      <div v-loading="peekLoading" class="lab-stack drawer-sections">
        <!-- 本站漏斗：签发→打开→提交→记录数；转化率分母是上钩记录条数，口径与看板一致 -->
        <div class="lab-grid" style="--cols: 4">
          <LabMetric label="专属链接" :value="peekLinks.length" unit="条" extra="本站签发，含匿名访客链接" />
          <LabMetric label="已打开" :value="peekOpenedCount" unit="条" :tone="peekOpenedCount ? 'accent' : ''" extra="按打开事件计数" />
          <LabMetric label="已提交" :value="peekSubmittedCount" unit="条" :tone="peekSubmittedCount ? 'accent' : ''" extra="采到过字段才算上钩" />
          <LabMetric label="上钩记录" :value="peekRecords.length" unit="条" :extra="`转化率 ${peekConversion}%`" />
        </div>

        <section>
          <!-- 链接清单含签了但没被点的（LEFT JOIN 保留全量台账），前端不按 opens>0 过滤 -->
          <div class="section-t">本站签发的链接</div>
          <el-table :data="peekLinks" size="small" max-height="260">
            <!-- 归属：有 target_email 是按人签发，空为匿名访客链接；匿名链接同样计打开，交付时区分两种证据强度 -->
            <el-table-column label="归属" min-width="150">
              <template #default="{ row }">
                <span v-if="row.target_email">{{ row.target_name ? `${row.target_name} · ` : '' }}{{ row.target_email }}</span>
                <span v-else class="lab-hint is-mute">匿名访客</span>
              </template>
            </el-table-column>
            <!-- 打开次数取自事件表（page_open），一条链接可被反复打开，事件才数得准 -->
            <el-table-column label="打开" width="86">
              <template #default="{ row }">
                <span class="lab-chip" :class="row.opens ? 'is-accent' : ''">{{ row.opens }} 次</span>
              </template>
            </el-table-column>
            <!-- 提交是否看 submitted_at（布尔），次数来自采集历史，两个口径 -->
            <el-table-column label="提交" width="90">
              <template #default="{ row }">
                <span class="lab-chip" :class="{ 'is-ok': row.submitted_at }">{{ row.submitted_at ? `${row.submits} 次` : '未提交' }}</span>
              </template>
            </el-table-column>
            <!-- 字段名去重清单：看出这张网采到的是 username/password 还是只采到搜索词 -->
            <el-table-column label="采到的字段" min-width="170">
              <template #default="{ row }">
                <span v-if="row.field_names.length" class="mono-inline">{{ row.field_names.join('、') }}</span>
                <span v-else class="lab-hint is-mute">—</span>
              </template>
            </el-table-column>
            <el-table-column label="签发时间" min-width="150">
              <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="96" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="copyLink(row)">复制链接</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <div class="lab-empty">还没有为这个网站签发过链接。用下方「生成专属链接」按人发，或把访问地址直接贴到内网公告里。</div>
            </template>
          </el-table>
        </section>

        <section>
          <div class="section-t">本站的上钩记录</div>
          <!-- 一行=一个终端的一次上钩（按 kind+token 唯一）；展开行的字段值来自 GET /records，已是掩码串，本抽屉没有 reveal 入口 -->
          <el-table :data="peekRecords" size="small" max-height="300">
            <el-table-column type="expand">
              <template #default="{ row }">
                <div class="field-list">
                  <!-- 只有打开没提交：老模板把提交写成 input type=button 又没声明采集点，访客点了也只留打开事件；整站如此可回素材页诊断提交触发点 -->
                  <div v-if="!row.form.length" class="lab-hint is-mute">这条只有打开，没有采集到字段。</div>
                  <!-- 逐字段一行：字段名 / 采到的值（掩码）/ 采集时刻 -->
                  <div v-for="(field, i) in row.form" :key="i" class="field-row">
                    <span class="mono-inline">{{ field.name }}</span>
                    <span class="mono-inline field-value">{{ field.value }}</span>
                    <span class="lab-hint is-mute">{{ fmtSeconds(field.at) }}</span>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="目标" min-width="150">
              <template #default="{ row }">
                <span v-if="row.target_email">{{ row.target_email }}</span>
                <span v-else class="lab-hint is-mute">匿名访客</span>
              </template>
            </el-table-column>
            <el-table-column label="首次打开" min-width="150">
              <template #default="{ row }">{{ fmtTime(row.first_seen_at) }}</template>
            </el-table-column>
            <!-- submitted 是服务端派生布尔（只看 submitted_at）；已上钩与只打开在交付报告里不能混算 -->
            <el-table-column label="提交" width="90">
              <template #default="{ row }">
                <span class="lab-chip" :class="{ 'is-ok': row.submitted }">{{ row.submitted ? '已上钩' : '只打开' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="停留" width="80">
              <template #default="{ row }">{{ row.dwell_seconds == null ? '-' : `${row.dwell_seconds}s` }}</template>
            </el-table-column>
            <el-table-column label="来源" width="130">
              <template #default="{ row }"><span class="mono-inline">{{ row.feature?.ipv4 || '-' }}</span></template>
            </el-table-column>
            <template #empty>
              <div class="lab-empty">还没有人打开这个网站。链接发出去之后，打开与提交都会实时落到这里。</div>
            </template>
          </el-table>
        </section>
      </div>

      <template #footer>
        <div class="drawer-foot">
          <!-- 一人一令：重复打开同一链接只累加次数不新增人，链接条数与上钩人数是两个分母 -->
          <span class="lab-hint is-mute footer-note">链接一人一令：同一条链接重复打开只累计次数，不新增归属。</span>
          <el-button :icon="Refresh" @click="loadPeek">刷新</el-button>
          <!-- 从抽屉内给本站补签：peekSite 取列表最新行，刚停掉的站也能继续签发 -->
          <el-button type="primary" @click="issueLink(peekSite)">生成专属链接</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
/** 采集面钓鱼网站监听：建素材、独占端口起监听、签发专属链接、按站点回看点击与采集。
 *  端口区间读自 capture_port_range，同站独占一口；起不来不返 500，事后由服务端把 status 写成 error。
 *  建站/开站/签链接过 assertDeployment，停止与删除属收网侧刻意不设门禁；只有 close_reason=authorization 的站在授权续期时自动复服。 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh } from '@element-plus/icons-vue';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';
import { fmtTime as ts } from '../../utils/time';

// gate 由 CaptureWorkspace 传入：当前生效授权摘要，null=锁定；只在模板顶部横幅用，脚本不判放行
defineProps({ gate: { type: Object, default: null } });

// 新建表单初值：status=open（建好即投放）与 0.0.0.0 是演练常态，8080 落在默认区间；
// 真占用/越界由服务端 portError 判，前端不复写规则
const BLANK = { status: 'open', template_id: '', listen_ip: '0.0.0.0', listen_port: 8080, domain: '', tls_key: '', tls_cert: '' };

// 站点列表：服务端按创建时间倒序
const rows = ref([]);
// 可选素材清单：page_size=200 一次拉满省翻页
const templates = ref([]);
// 表格勾选的行：只服务批量删除
const selection = ref([]);
const drawer = ref(false);
// 建档 loading：建站可能当场起监听，没转圈会像点没生效
const saving = ref(false);
// 端口可填区间：真实值来自 /settings 的 capture_port_range
const portRange = ref([8000, 9999]);
// 必须展开拷 BLANK，否则改脏后 Object.assign 回不到出厂值
const form = reactive({ ...BLANK });

// 在听数用 running（进程实时值），不用 status
const liveCount = computed(() => rows.value.filter((r) => r.running).length);
// 端口占用按 listen_port 去重：历史脏数据同端口多行不能按行数虚报
const portCount = computed(() => new Set(rows.value.filter((r) => r.running).map((r) => r.listen_port)).size);
// 本页条数：/web-sites 不分页，本页=全部
const shownCount = computed(() => rows.value.length);

// 链接与上钩回看抽屉
const peek = ref(false);
const peekSiteId = ref('');
// 本站签发链接与计数（GET /web-sites/:id/links）
const peekLinks = ref([]);
// 本站上钩记录，最新 50 条（GET /records?site_id=，字段值已掩码）
const peekRecords = ref([]);
const peekLoading = ref(false);
// 站点行以列表最新为准：抽屉开着时从别处停了监听，头部也要跟着变
const peekSite = computed(() => rows.value.find((r) => r.id === peekSiteId.value) || null);
// 已打开链接条数（opens>0 的链接数，不是打开次数）
const peekOpenedCount = computed(() => peekLinks.value.filter((l) => l.opens > 0).length);
// 已提交链接条数（submitted_at 有值）
const peekSubmittedCount = computed(() => peekLinks.value.filter((l) => l.submitted_at).length);
// 转化率＝已提交 / 上钩记录条数，分母是"多少人上钩"；Math.round 取整，一位小数留给看板大屏
const peekConversion = computed(() =>
  peekRecords.value.length ? Math.round((peekRecords.value.filter((r) => r.submitted).length / peekRecords.value.length) * 100) : 0
);

/** 日期时间展示：转调 utils/time 的 fmtTime，UTC 存、本机时区显示。 */
function fmtTime(v) {
  return ts(v);
}
// 字段级采集时间留到秒：同表单多字段常在同一分钟落库，判先后看这一秒差
function fmtSeconds(v) {
  return ts(v, { seconds: true, dash: '-' });
}

/** 打开回看抽屉：记 id 后立刻 loadPeek；不记整行，头部与按钮跟列表最新状态。 */
function openPeek(row) {
  peekSiteId.value = row.id;
  peek.value = true;
  loadPeek();
}

/**
 * 拉本站链接与上钩记录（GET /web-sites/:id/links + GET /records?site_id=&page_size=50）。
 * Promise.all 并发，50 条够判断"有没有人上钩"，全量证据去上钩记录页；站点已删时静默返回。
 * 请求失败弹服务端中文原因，已拿到的那份数据保留不清空。
 */
async function loadPeek() {
  const site = peekSite.value;
  if (!site) return;
  peekLoading.value = true;
  try {
    const [links, records] = await Promise.all([
      http.get(`/web-sites/${site.id}/links`),
      http.get('/records', { params: { site_id: site.id, page_size: 50 } }),
    ]);
    // || [] 兜底旧响应形状，防模板 .length 炸
    peekLinks.value = links.rows || [];
    peekRecords.value = records.rows || [];
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    peekLoading.value = false;
  }
}

/** 复制专属链接到剪贴板；非安全上下文 navigator.clipboard 会被浏览器拒，退回弹窗显示原文让人手动复制。 */
async function copyLink(row) {
  try {
    await navigator.clipboard.writeText(row.url);
    ElMessage.success('链接已复制，可直接发给这一位');
  } catch {
    await ElMessageBox.alert(row.url, '专属链接', { confirmButtonText: '知道了', customClass: 'link-box' });
  }
}

/** 状态列合读两字段：'待恢复'=行写 open 但进程没在听，不等于已关闭；close_reason 区分自动复服与人工收网。 */
function statusLabel(row) {
  if (row.status === 'error') return '异常';
  return row.status === 'open' ? (row.running ? '监听中' : '待恢复') : '已关闭';
}
/** 只有真的在服务才给绿色：意图与实况必须一眼能分，否则待恢复会被读成在跑。 */
function statusTone(row) {
  if (row.status === 'error') return 'is-danger';
  if (row.running) return 'is-ok';
  return '';
}

/** 重拉列表：running/url 由服务端派生，写完必须重拉才与实况一致，前端不自己改状态。 */
async function load() {
  const data = await http.get('/web-sites');
  rows.value = data.rows || [];
}

/** 拉表单元数据：素材清单 + 运行参数；并发发两条，settings 缺字段时保留本地兜底区间。 */
async function loadMeta() {
  const [t, s] = await Promise.all([http.get('/web-templates', { params: { page_size: 200 } }), http.get('/settings')]);
  templates.value = t.rows || [];
  portRange.value = s.capture_port_range || portRange.value;
}

/** 打开新建抽屉：每次都 Object.assign(form, BLANK)，上一站的私钥域名不留到下一次。 */
function openCreate() {
  Object.assign(form, BLANK);
  drawer.value = true;
}

/**
 * 建档：POST /web-sites，status=open 时服务端当场 startSite 占端口并写审计 site.create（记"有没有配 TLS"，不记私钥）。
 * 前置校验只做"没选素材"这一项，其他交服务端给中文原因，前端不复写规则免得两处漂移。
 */
async function save() {
  if (!form.template_id) return ElMessage.warning('请选择假登录页');
  saving.value = true;
  try {
    const data = await http.post('/web-sites', form);
    ElMessage.success(`网站已就绪：${data.url}`);
    drawer.value = false;
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

/**
 * 开站/收网：/start 过投放门禁 403，/stop 刻意不过门禁（撤页面是失控时第一件事）；两者都写审计。
 * 停止不删证据，records 全部保留；端口冲突不在此报错，由服务 error 回调事后把 status 写成 error。
 */
async function toggle(row) {
  // 走 stop 还是 start 看运维意图 status，不看 running：
  // 否则待恢复行点"停止"会对同一行连发 start，端口注册表里可能出现两个监听体
  const stop = row.status === 'open';
  try {
    await http.post(`/web-sites/${row.id}/${stop ? 'stop' : 'start'}`);
    ElMessage.success(stop ? '已停止监听，历史采集记录保留' : '已开启监听');
    load();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

/**
 * 签发一条专属投放链接：POST /web-sites/:id/links → INSERT capture_tokens（site_id=本站、task_id=NULL，与邮件令牌同表），过投放门禁。
 * 弹框登记归属邮箱，留空即匿名访客链接只计打开不认人；归属写错=证据挂到不存在的人名下，校验器与服务端 siteApi 同一形状。
 * 链接形态由服务端拼（访问地址 + /?tk=<uuid>），前端只搬运；弹窗取消静默返回不报错。
 */
async function issueLink(row) {
  if (!row) return;
  // 提到 try 外面：两个 try 都要读它；不给初值，避免"没填就走默认"的歧义
  let email;
  try {
    const prompt = await ElMessageBox.prompt('为该链接登记归属邮箱；留空则签发匿名访客链接，只计打开不认人', '生成专属链接', {
      confirmButtonText: '签发',
      cancelButtonText: '取消',
      inputPlaceholder: 'target@corp.example',
      // 空值放行=匿名链接；非空必须像邮箱，签发时点唯一错处
      inputValidator: (value) => !value.trim() || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()) || '邮箱格式不正确',
    });
    email = prompt.value.trim();
  } catch {
    return;
  }
  try {
    const data = await http.post(`/web-sites/${row.id}/links`, { email });
    await navigator.clipboard.writeText(data.url).catch(() => {});
    ElMessage.success(email ? `已为 ${email} 签发独立链接` : '已签发匿名访客链接');
    // 非 HTTPS 剪贴板被拦时链接仍需在界面上可见
    await ElMessageBox.alert(data.url, '专属链接', { confirmButtonText: '知道了', customClass: 'link-box' });
    // 抽屉开着时 loadPeek，新签链接要立刻可见
    if (peek.value) loadPeek();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

/**
 * 删除站点：DELETE /web-sites/:id，服务端 stopSite + 删行；records 不级联删，撤配置不撤已采证据。
 * 不可逆的收网动作，必须人工确认。
 */
async function remove(row) {
  try {
    await ElMessageBox.confirm('删除会停止该网站监听，已采集的证据保留，确认删除？', '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  await http.delete(`/web-sites/${row.id}`);
  ElMessage.success('已删除');
  load();
}

/**
 * 批量删除：串行逐行 DELETE（并发会把服务端开关监听/审计挤一团），单行失败只弹 warning 继续下一行。
 * 不弹整批确认：勾选本身即表达"我要删这些"，行内删除本来就有确认。
 */
async function batchRemove() {
  for (const row of selection.value) {
    await http.delete(`/web-sites/${row.id}`).catch((e) => ElMessage.warning(e.message));
  }
  // 勾先清再刷新：列表重排后旧行对象不在数据里，留着按钮会显示脏数字
  selection.value = [];
  load();
}

/** 刷新：load 等完、loadMeta 不 await；素材与端口区间晚点不影响列表可读。 */
async function reload() {
  await load();
  loadMeta();
}

// 本页不轮询：实况靠刷新按钮和写完就 load，避免多标签页各打服务端
onMounted(reload);
</script>

<style scoped>
.site-link { text-decoration: none; word-break: break-all; }
.site-link:hover { text-decoration: underline; }
.section-t { font-size: 13px; font-weight: 700; color: var(--lab-ink); margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--lab-line-2); }
.drawer-sections :deep(.el-form-item) { margin-bottom: 14px; }
.drawer-foot { display: flex; align-items: center; gap: 8px; }
.footer-note { margin-right: auto; }
.field-list { padding: 6px 14px 6px 46px; display: flex; flex-direction: column; gap: 4px; }
.field-row { display: flex; align-items: center; gap: 12px; font-size: 12px; }
.field-value { background: var(--lab-fill-2); }
</style>
