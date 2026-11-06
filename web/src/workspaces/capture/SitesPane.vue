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
        <!-- 访问地址是服务端派生的对外服务地址（域名/0.0.0.0→127.0.0.1/默认端口省略），不是专属链接；
             监听端口与协议并入副行，避免三列重复说同一件事把操作列挤出去 -->
        <el-table-column label="访问地址" min-width="230">
          <template #default="{ row }">
            <a class="lab-hint site-link" :href="row.url" target="_blank" rel="noreferrer">{{ row.url }}</a>
            <div class="lab-hint is-mute site-addr-sub">
              <span v-if="row.public_url" class="site-addr-proxy">反代 →</span>
              <span class="site-addr-ip">{{ row.listen_ip }}:{{ row.listen_port }}</span>
              <span class="site-addr-dot">·</span>{{ row.tls_cert ? 'HTTPS' : 'HTTP' }}
              <!-- 只监听回环又没配对外地址：链接里的 127.0.0.1 出了本机就打不开，列表上先标出来 -->
              <span v-if="!row.public_url && isLoopback(row.listen_ip)" class="site-addr-warn">仅本机可达</span>
            </div>
          </template>
        </el-table-column>
        <!-- 授权主体是建站时绑定的授权，级联下线与续期复服都按它算 -->
        <el-table-column prop="auth_scope" label="授权主体" min-width="120" show-overflow-tooltip />
        <!-- 5 个动作并排，宽度按"生成专属链接"不换行留够，避免"删除"被挤到第二行 -->
        <el-table-column label="操作" width="380" fixed="right">
          <template #default="{ row }">
            <!-- 按钮方向由 status 决定；停止不设前端门禁，开启无授权时服务端 403 -->
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="primary" @click="toggle(row)">{{ row.status === 'open' ? '停止' : '开启' }}</el-button>
            <el-button link type="primary" @click="openPeek(row)">链接与上钩</el-button>
            <el-button link type="primary" @click="issueLink(row)">生成专属链接</el-button>
            <el-button link type="primary" @click="openScreen(row)">大屏</el-button>
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
      <template #header><span class="lab-pane-t">{{ editing ? '编辑钓鱼网站' : '新建钓鱼网站' }}</span></template>

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

        <!-- 访问方式放在最前：它决定链接里有没有端口，是整张表唯一的口径开关。
             以前「监听域名 + 监听端口」两个字段谁都像对外地址，外网域名配 8080 就被拼成 域名:8080 -->
        <section>
          <div class="section-t">访客怎么访问</div>
          <el-form label-position="top">
            <el-form-item label="访问方式">
              <el-radio-group v-model="form.access_mode" @change="onModeChange">
                <el-radio-button value="proxy">域名反代（nginx）</el-radio-button>
                <el-radio-button value="direct">IP:端口直连</el-radio-button>
              </el-radio-group>
              <!-- 两种方式的差别就一句：访客地址里带不带端口 -->
              <div v-if="proxyMode" class="lab-hint is-mute">
                访客只看到 <code>http://域名/…</code> 或 <code>https://域名/…</code>，不带 :8080；哪个协议取决于下面的「对外协议」，nginx 再把请求反代到本机监听端口。
              </div>
              <div v-else class="lab-hint is-mute">
                访客直接访问 <code>ip:端口</code>，链接里会带上监听端口；适合内网演习或端口本来就对公网开放的情况。
              </div>
            </el-form-item>
            <!-- 域名可留空（直连时退回监听 IP）；填了必须命中授权名单或泛域名，校验在服务端 -->
            <el-form-item :label="proxyMode ? '对外域名' : '访问域名（可选）'">
              <el-input v-model="form.domain" :placeholder="proxyMode ? 'phish.example.com' : '留空就用下面的监听 IP'" @blur="tidyDomain" />
              <div v-if="proxyMode" class="lab-hint is-mute">
                只写域名（nginx 不在 443/80 时可带端口，如 phish.example.com:8443），不要写 <code>http://</code> 和路径。
                必须落在「演练授权」的授权名单内，否则访客会被直接拒绝。
              </div>
              <div v-else class="lab-hint is-mute">
                可选：目标机能访问到的域名或 IP，链接里就用它代替监听 IP。留空时按监听 IP 拼（0.0.0.0 会写成 127.0.0.1，只在本机有效）。
                域名同样要落在授权名单内。
              </div>
            </el-form-item>
            <!-- 协议只决定链接前缀，与 nginx 回源到本机用的是 http 还是 https 无关；两种都合法，不强制 https -->
            <el-form-item v-if="proxyMode" label="对外协议">
              <el-radio-group v-model="form.public_scheme">
                <el-radio-button value="https">https</el-radio-button>
                <el-radio-button value="http">http</el-radio-button>
              </el-radio-group>
              <div class="lab-hint is-mute">
                按访客浏览器地址栏里看到的协议选，不是 nginx 回源用的协议：nginx 只监听 80 明文就选 http，
                平台不会把 http 擅自改成 https；选 https 要在 nginx 上装好证书，否则浏览器先报证书错误。
              </div>
            </el-form-item>
          </el-form>
        </section>

        <section>
          <div class="section-t">{{ proxyMode ? '本机监听（nginx 反代到这里）' : '本机监听地址' }}</div>
          <el-form label-position="top">
            <el-form-item label="监听 IP">
              <el-input v-model="form.listen_ip" :disabled="Boolean(editing)" placeholder="对本机所有网卡服务就填 0.0.0.0" />
              <div v-if="proxyMode" class="lab-hint is-mute">
                反代场景通常填 127.0.0.1：只有本机的 nginx 回源过来，这个口不对外；nginx 在另一台机器上时才填内网 IP。
              </div>
              <div v-else class="lab-hint is-mute">
                填 0.0.0.0 时这个端口对本机所有网卡开放，同一网络内都能访问；只在本机验证就填 127.0.0.1。管理后台默认只听 127.0.0.1，与这里互不影响。
              </div>
              <div v-if="editing" class="lab-hint is-mute">监听地址建站后不可改，要换端口请新建一个站点。</div>
            </el-form-item>
            <!-- 端口区间读自 /settings 的 capture_port_range；区间外服务端必拒，前端不写死免得口径漂移 -->
            <el-form-item label="监听端口">
              <el-input v-model.number="form.listen_port" :disabled="Boolean(editing)" :placeholder="`${portRange[0]}-${portRange[1]}，注意防火墙放通与端口占用`" />
              <div v-if="proxyMode" class="lab-hint is-mute">
                nginx 里 <code>proxy_pass</code> 指向的就是这个口；它只在内网出现，不会写进任何链接。
              </div>
              <div v-else class="lab-hint is-mute">访客会在链接里看到这个端口，注意防火墙放通与端口占用。</div>
              <div class="lab-hint is-mute">端口落在配置区间 {{ portRange[0] }}-{{ portRange[1] }} 内才会被接受；区间在「系统设置 · 运行参数」里。</div>
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

        <!-- 拼接结果预览：字段一改这里就跟着变，口径与服务端 siteAddress.js 的 siteUrl 一致；
             以前要用户自己脑补"域名后面到底带不带 :8080"，填错只能等邮件发出去才发现 -->
        <section>
          <div class="section-t">链接拼接结果</div>
          <div class="link-preview">
            <div class="preview-row">
              <span class="preview-k">访客打开的页面</span>
              <code class="preview-v">{{ draft.pageUrl }}</code>
            </div>
            <div class="preview-row">
              <span class="preview-k">专属链接（一人一条）</span>
              <code class="preview-v">{{ draft.linkUrl }}</code>
            </div>
            <div class="preview-row">
              <span class="preview-k">邮件变量 {{ SITE_VAR }}</span>
              <code class="preview-v">{{ draft.origin }}</code>
            </div>
            <div class="preview-row">
              <span class="preview-k">实际监听</span>
              <code class="preview-v">{{ draft.listen }}</code>
            </div>
          </div>
          <div class="lab-hint is-mute">令牌由服务端按人签发，创建后在列表「生成专属链接」里取；保存后以接口返回的地址为准。</div>
          <el-alert v-if="draft.warn" class="preview-warn" :title="draft.warn" type="warning" :closable="false" show-icon />
        </section>
      </div>

      <template #footer>
        <div class="drawer-foot">
          <!-- 令牌不进表单，建好站后由专属链接携带 -->
          <span class="lab-hint is-mute footer-note">创建后令牌由专属链接携带，可在列表「生成专属链接」为每位收件人单独生成。</span>
          <el-button @click="drawer = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="save">{{ editing ? '保存修改' : '创建钓鱼网站' }}</el-button>
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
// 真占用/越界由服务端 portError 判，前端不复写规则。
// access_mode 是界面口径，不落库：proxy 时把域名写进 public_url（链接只剩域名），direct 时清空 public_url 按监听口拼。
const BLANK = {
  status: 'open',
  template_id: '',
  access_mode: 'direct',
  public_scheme: 'https',
  listen_ip: '0.0.0.0',
  listen_port: 8080,
  domain: '',
  tls_key: '',
  tls_cert: '',
};

// 邮件正文里的站点变量名，模板中用常量插值，避免和 Vue 的 {{ }} 语法打架
const SITE_VAR = '{{site_url}}';

// 站点列表：服务端按创建时间倒序
const rows = ref([]);
// 可选素材清单：page_size=200 一次拉满省翻页
const templates = ref([]);
// 表格勾选的行：只服务批量删除
const selection = ref([]);
const drawer = ref(false);
// 编辑中的站点行；null 表示新建。监听 IP/端口建站后不可改，表单里上锁
const editing = ref(null);
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

// 访问方式：proxy=外网域名 + nginx 反代（链接里没有端口），direct=访客直连 ip:端口（链接里带监听口）
const proxyMode = computed(() => form.access_mode !== 'direct');

/** 是否回环监听（含 IPv6 写法）：只有本机可达，直连链接发给别人一定打不开。 */
function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

/**
 * 把用户填的域名拆成「协议 + 主机 + 端口」。域名列只存主机名——授权名单是逐字比对，带端口必然失配；
 * 端口只进对外地址。顺手吃掉 http:// 前缀、路径与查询串，从地址栏整段粘进来也能用；
 * scheme 只在原文真的写了协议时才有值，供「用户粘了 http:// 就按 http 走」使用。
 */
function splitHost(value) {
  const text = String(value || '').trim();
  if (!text) return { scheme: '', host: '', port: '' };
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text);
  try {
    const url = new URL(hasScheme ? text : `http://${text}`);
    return { scheme: hasScheme ? url.protocol.replace(':', '') : '', host: url.hostname, port: url.port };
  } catch {
    return { scheme: '', host: '', port: '' };
  }
}

/** 失焦收敛：反代保留 :端口（nginx 不在 443/80 时要它），直连只留主机名，端口由监听端口决定。 */
function tidyDomain() {
  const { scheme, host, port } = splitHost(form.domain);
  if (!host) {
    form.domain = String(form.domain || '').trim();
    return;
  }
  // 连协议一起粘进来的（http://phish.example.com），按用户写的协议走，不被上面的默认 https 覆盖
  if (proxyMode.value && (scheme === 'http' || scheme === 'https')) form.public_scheme = scheme;
  form.domain = proxyMode.value && port ? `${host}:${port}` : host;
}

/** 默认端口不写进链接：https 配 443、http 配 80，与服务端 URL.origin 的归一保持一致。 */
function trimPort(scheme, port) {
  if (!port) return '';
  return String(port) === (scheme === 'https' ? '443' : '80') ? '' : `:${port}`;
}

/** 切换访问方式时顺手把监听 IP 填成常用配对：只在还是出厂默认值时动，改过的不覆盖。 */
function onModeChange() {
  if (editing.value) return; // 监听地址建站后不可改，别动它
  if (proxyMode.value && form.listen_ip === '0.0.0.0') form.listen_ip = '127.0.0.1';
  else if (!proxyMode.value && form.listen_ip === '127.0.0.1') form.listen_ip = '0.0.0.0';
}

/**
 * 拼接结果预览。口径与服务端 server/src/capture/siteAddress.js 的 siteUrl 保持一致：
 * 有对外地址就用它，否则协议取证书、主机取域名或监听 IP（0.0.0.0 记为 127.0.0.1），默认端口省略。
 * 两处要同步，否则预览与保存后拿到的真实链接会互相打架。
 */
const draft = computed(() => {
  const { scheme, host, port } = splitHost(form.domain);
  const listenPort = String(Number(form.listen_port) || '');
  const listenIp = form.listen_ip || '127.0.0.1';
  const tls = Boolean(form.tls_cert && form.tls_key);
  // 直连：协议跟着证书走，没填域名时退回监听 IP
  const directScheme = tls ? 'https' : 'http';
  const directHost = host || (listenIp === '0.0.0.0' ? '127.0.0.1' : listenIp);
  const directOrigin = `${directScheme}://${directHost}${trimPort(directScheme, listenPort)}`;
  // 反代：链接只剩对外域名；协议按「对外协议」，用户直接粘了 http:// 时以他写的为准
  const proxyScheme = scheme === 'http' || scheme === 'https' ? scheme : form.public_scheme;
  // 域名没填时退回直连口径，让"会生成什么链接"当场可见而不是悄悄拼成空的
  const origin = proxyMode.value && host
    ? `${proxyScheme}://${host}${trimPort(proxyScheme, port)}`
    : directOrigin;
  const listen = `${listenIp === '0.0.0.0' ? '0.0.0.0（全部网卡）' : listenIp}:${listenPort || '-'}`;
  // 三种填法会拼出访客打不开的链接，先在预览里点出来，不等到邮件发出去才发现
  let warn = '';
  if (proxyMode.value && !host) {
    warn = '域名反代必须填对外域名，否则链接会退回「监听 IP:端口」那种带端口的写法。';
  } else if (!proxyMode.value && isLoopback(listenIp) && host) {
    warn = `监听在 ${listenIp} 却填了访问域名：链接会变成 ${origin}，外网访客打不开；走 nginx 反代请把访问方式改成「域名反代」。`;
  } else if (!proxyMode.value && isLoopback(listenIp)) {
    warn = '监听在回环地址，链接只能在本机打开；要让别人访问就把监听 IP 改成 0.0.0.0，或改用「域名反代」。';
  }
  return {
    origin,
    pageUrl: `${origin}/`,
    linkUrl: `${origin}/?tk=<每人一个的令牌>`,
    listen: proxyMode.value && host ? `${listen}（仅 nginx 回源，不出现在链接里）` : listen,
    warn,
  };
});

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

/** 单站大屏：新标签页开深链，投屏与列表操作互不打断。 */
function openScreen(row) {
  window.open(`#/screen/site/${row.id}`, '_blank', 'noopener');
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
  editing.value = null;
  Object.assign(form, BLANK);
  drawer.value = true;
}

/** 编辑已有站点：只回填 PUT 接受的字段；监听 IP/端口建站后不可改，界面上锁并说明原因。 */
function openEdit(row) {
  editing.value = row;
  // 有 public_url 就是反代站，域名框要把它的端口一并带出来，否则改完保存会丢 :8443
  const pub = row.public_url ? splitHost(row.public_url) : null;
  Object.assign(form, BLANK, {
    template_id: row.template_id || '',
    access_mode: row.public_url ? 'proxy' : 'direct',
    public_scheme: String(row.public_url || '').startsWith('http://') ? 'http' : 'https',
    domain: pub?.host ? `${pub.host}${pub.port ? `:${pub.port}` : ''}` : row.domain || '',
    tls_key: row.tls_key || '',
    tls_cert: row.tls_cert || '',
    listen_ip: row.listen_ip,
    listen_port: row.listen_port,
    status: row.status,
  });
  drawer.value = true;
}

/**
 * 建档：POST /web-sites，status=open 时服务端当场 startSite 占端口并写审计 site.create（记"有没有配 TLS"，不记私钥）。
 * 改档：PUT /web-sites/:id，只发白名单字段；监听地址端口不在其中。
 * 前置校验只做"没选素材""反代没填域名"这两项，其他交服务端给中文原因，前端不复写规则免得两处漂移。
 */
async function save() {
  if (!form.template_id) return ElMessage.warning('请选择假登录页');
  const { scheme, host, port } = splitHost(form.domain);
  if (proxyMode.value && !host) return ElMessage.warning('域名反代要填对外域名：访客访问的那个域名，不要填 127.0.0.1');
  // 原文写了 http:// 就以用户写的为准（失焦收敛已同步，这里兜一层：直接点保存时 input 可能还没 blur）
  const publicScheme = scheme === 'http' || scheme === 'https' ? scheme : form.public_scheme;
  // 域名列只放主机名（授权名单逐字比对，带端口/协议必然失配）；对外地址只在反代时写，直连清空让服务端按监听口拼
  const editable = {
    template_id: form.template_id,
    domain: host || null,
    public_url: proxyMode.value && host ? `${publicScheme}://${host}${port ? `:${port}` : ''}` : '',
    tls_key: form.tls_key,
    tls_cert: form.tls_cert,
  };
  saving.value = true;
  try {
    const data = editing.value
      ? await http.put(`/web-sites/${editing.value.id}`, editable)
      : await http.post('/web-sites', {
        ...editable,
        status: form.status,
        listen_ip: form.listen_ip,
        listen_port: form.listen_port,
      });
    ElMessage.success(`${editing.value ? '已保存' : '网站已就绪'}，对外地址：${data.url}`);
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
/* 监听与协议降为地址副行：同一件事只说一遍，主列留给可点的对外地址 */
.site-addr-sub { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 11px; }
/* 副行是地址的补充说明，不再画底色块：主行已经是可点链接，副行再加一块会像另一个控件 */
.site-addr-ip { font-family: Consolas, "Cascadia Mono", monospace; color: var(--lab-ink-3); }
.site-addr-proxy { color: var(--lab-accent); font-weight: 600; }
.site-addr-dot { color: var(--lab-ink-4); }
/* 回环监听又没配对外地址：链接出了本机就打不开，列表上直接标出来 */
.site-addr-warn { color: var(--lab-danger); font-weight: 600; }
/* 拼接结果预览：贴成一块等宽面板，"到底带不带 :8080"一眼可读 */
.link-preview { border: 1px solid var(--lab-line-2); border-radius: 6px; background: var(--lab-fill-2); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.preview-row { display: flex; align-items: baseline; gap: 10px; font-size: 12px; }
.preview-k { flex: 0 0 132px; color: var(--lab-ink-3); }
.preview-v { flex: 1 1 auto; font-family: Consolas, "Cascadia Mono", monospace; color: var(--lab-ink); word-break: break-all; }
.preview-warn { margin-top: 8px; }
/* 提示里的行内代码：与正文区分又不抢眼 */
.lab-hint code { font-family: Consolas, "Cascadia Mono", monospace; background: var(--lab-fill-2); border-radius: 3px; padding: 0 3px; }
.section-t { font-size: 13px; font-weight: 700; color: var(--lab-ink); margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--lab-line-2); }
.drawer-sections :deep(.el-form-item) { margin-bottom: 14px; }
.drawer-foot { display: flex; align-items: center; gap: 8px; }
.footer-note { margin-right: auto; }
.field-list { padding: 6px 14px 6px 46px; display: flex; flex-direction: column; gap: 4px; }
.field-row { display: flex; align-items: center; gap: 12px; font-size: 12px; }
.field-value { background: var(--lab-fill-2); }
</style>
