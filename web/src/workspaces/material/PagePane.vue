<!-- 假登录页编辑器：手写与打磨采集页模板。模板只写 HTML + 内联 CSS，boot 配置与采集运行时由平台注入。 -->
<!-- 编辑框里的 HTML 原样入库、原样发给访客，保存与再打开是同一份文本的来回。 -->
<!-- data-al-collect、data-al-ignore、alab-boot 是协议 v2 的冻结标记，改属性名等于把模板和运行时拆开。 -->
<template>
  <div class="lab-stack">
    <!-- 素材可以写，开启监听必须授权；门禁一律在服务端，gate 只驱动这里的横幅展示 -->
    <el-alert v-if="!gate" type="warning" :closable="false" show-icon
      title="未登记有效授权，假登录页无法开启"
      description="假登录页本身可以先编写、保存、诊断；但要挂到钓鱼网站监听端口对外服务，必须先在「演练授权」登记授权主体、有效期与授权名单。" />
    <el-alert v-else type="info" :closable="false" show-icon
      :title="`授权生效中 · ${gate.scope} · 授权名单 ${gate.allowed_hosts?.length || 0} 条`"
      description="假登录页只对授权名单里的域名提供服务，名单外的访问直接拒绝；授权过期或被吊销时监听自动停止。" />

    <!-- 三个统计口径不同：模板总数是全库 total，可采集字段只数本页行，诊断均分的分母是跑过分的那几条 -->
    <div class="lab-grid" style="--cols: 3">
      <LabMetric label="假登录页" :value="total" unit="个" :extra="`本页 ${rows.length} 条 · 类型 ${types.length} 种`" />
      <LabMetric label="可采集字段" :value="fieldTotal" unit="个" tone="accent" extra="按 name 属性识别，同名多值合并为数组上报" />
      <LabMetric label="诊断均分" :value="avgScore" :tone="avgTone" extra="采集绑定 / 外部资源 / 自定义脚本 / 可采集字段" />
    </div>

    <LabPane flush title="假登录页清单" hint="模板只写纯 HTML + 内联 CSS，boot 配置与运行时由平台注入">
      <template #ops>
        <!-- 新建只开抽屉不落库；刷新按当前页与过滤条件重取 -->
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          <span>新建假登录页</span>
        </el-button>
        <el-button @click="load">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
      </template>

      <!-- 类型 change 与搜索都走 reload：先退回第 1 页再取数 -->
      <div style="padding: 14px 14px 0">
        <div class="lab-toolbar">
          <span class="lab-hint">类型</span>
          <el-select v-model="query.type" clearable placeholder="全部类型" style="width: 160px" @change="reload">
            <el-option v-for="t in types" :key="t" :label="t" :value="t" />
          </el-select>
          <el-input v-model="query.keyword" placeholder="按名称或描述搜索" style="width: 220px" @keyup.enter="reload" />
          <el-button @click="reload">
            <el-icon><Search /></el-icon>
            <span>搜索</span>
          </el-button>
          <div class="lab-spacer" />
          <span class="lab-hint is-mute">上报端点 <span class="mono-inline">/alab/v2/engage</span> · 令牌参数 <span class="mono-inline">?tk=</span></span>
        </div>
      </div>

      <!-- 字段数与诊断分在前端从行里的 html / diagnose_json 现算，不再为每行发请求 -->
      <el-table :data="rows" size="small">
        <el-table-column label="名称" min-width="220">
          <template #default="{ row }">
            <div class="lab-strong">{{ row.name }}</div>
            <div v-if="row.description" class="lab-hint is-mute clamp1">{{ row.description }}</div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="110">
          <template #default="{ row }"><span class="lab-chip">{{ row.type }}</span></template>
        </el-table-column>
        <!-- 可采集字段：对行里的 html 跑 fieldNames，与运行时按 name 识别同一套规则；多次调用没缓存，一页最多 50 行开销可忽略 -->
        <el-table-column label="可采集字段" width="180">
          <template #default="{ row }">
            <div class="lab-kv">
              <span><b>{{ fieldNames(row.html).length }}</b> 个</span>
              <span v-for="n in fieldNames(row.html).slice(0, 3)" :key="n" class="lab-chip is-accent">{{ n }}</span>
              <span v-if="fieldNames(row.html).length > 3" class="lab-hint is-mute">+{{ fieldNames(row.html).length - 3 }}</span>
            </div>
          </template>
        </el-table-column>
        <!-- 库里存 alert / redirect / learn；认不出的历史值原样显示，不藏脏数据 -->
        <el-table-column label="提交后响应" width="120">
          <template #default="{ row }">{{ RESPONSE_LABEL[row.response_type] || row.response_type }}</template>
        </el-table-column>
        <!-- 诊断分读保存时固化的 diagnose_json，不在列表上重新体检；条宽与配色阈值同抽屉口径 -->
        <el-table-column label="诊断分" width="150">
          <template #default="{ row }">
            <div v-if="scoreOf(row) !== null" style="display: flex; align-items: center; gap: 8px">
              <span style="width: 30px; font-weight: 700; font-variant-numeric: tabular-nums">{{ scoreOf(row) }}</span>
              <div class="lab-bar" style="flex: 1">
                <div class="lab-bar-fill" :class="barTone(scoreOf(row))" :style="{ width: `${scoreOf(row)}%` }" />
              </div>
            </div>
            <span v-else class="lab-chip">未跑分</span>
          </template>
        </el-table-column>
        <!-- 更新时间换本机时区显示（库里存 UTC） -->
        <el-table-column label="更新时间" width="130">
          <template #default="{ row }"><span class="lab-hint">{{ fmtTime(row.updated_at) }}</span></template>
        </el-table-column>
        <!-- 预览走行数据现渲染，不读抽屉里的草稿；删除有服务端引用保护，拒删原因直接弹出 -->
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="primary" @click="openRowPreview(row)">预览</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="lab-empty">还没有假登录页。新建一份纯 HTML 模板即可，运行时注入与字段识别由平台完成。</div>
        </template>
      </el-table>

      <!-- 换每页条数时把页码退回 1，否则会停在越界的页上 -->
      <el-pagination class="pager" layout="total, sizes, prev, pager, next" :total="total"
        :page-size="query.page_size" :current-page="query.page" :page-sizes="[10, 20, 50]"
        @current-change="(p) => { query.page = p; load(); }"
        @size-change="(s) => { query.page_size = s; query.page = 1; load(); }" />
    </LabPane>

    <!-- 产品红线（与 SECURITY.md / NOTICE 同口径）：不反检测、不免杀、不外转凭据，上报只走同源、数据只落本地库 -->
    <div class="lab-hint is-mute">
      边界约束：本面板只产出演练素材，不做反检测 / 免杀 / 载荷生成，也不把采集到的凭据转发到任何第三方网站；
      上报只走同源 <span class="mono-inline">/alab/v2/engage</span>，数据仅落平台本地库。
    </div>
  </div>

  <!-- 编辑抽屉：左栏写页面、右栏看预览与诊断；新建与编辑共用，靠 form.id 分流 -->
  <el-drawer v-model="drawer" class="page-drawer" :title="form.id ? `编辑假登录页 · ${form.name}` : '新建假登录页'"
    size="94%" :close-on-click-modal="false">
    <div class="lab-split" style="--split: 520px">
      <!-- 左栏：页面信息与提交后响应。响应动作存在平台侧的列里、不进模板 HTML，换一种提交后表现不用改 HTML -->
      <div class="lab-stack">
        <!-- name / type / html 缺任一项服务端回 400；建站点时下拉里全靠这两样认页。类型允许现敲新值（allow-create） -->
        <LabPane title="页面信息">
          <el-form label-position="top">
            <el-form-item label="页面类型" required>
              <el-select v-model="form.type" filterable allow-create default-first-option placeholder="可自定义或选择已有类型" style="width: 100%">
                <el-option v-for="t in types" :key="t" :label="t" :value="t" />
              </el-select>
            </el-form-item>
            <el-form-item label="页面名称" required>
              <el-input v-model="form.name" maxlength="100" show-word-limit placeholder="给这份假登录页起个名字" />
            </el-form-item>
            <el-form-item label="用途描述">
              <el-input v-model="form.description" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="[选填] 这份页面用于哪类演练场景" />
            </el-form-item>
            <el-form-item label="HTML 源码" required>
              <el-input v-model="form.html" class="src-input" type="textarea" :rows="18" spellcheck="false"
                placeholder="粘贴纯 HTML + 内联 CSS" />
              <div class="lab-hint">只写 HTML 与内联 CSS：不要引外部 js/css，不要自己写 <span class="mono-inline">&lt;script&gt;</span>。</div>
              <!-- 插入骨架是整框覆盖不是追加，已写内容会被顶掉；立即诊断按当前源码现算，不动库 -->
              <div style="margin-top: 8px; display: flex; gap: 8px">
                <el-button size="small" @click="insertSkeleton">插入骨架</el-button>
                <el-button size="small" @click="runDiagnose">立即诊断</el-button>
              </div>
            </el-form-item>
          </el-form>
        </LabPane>

        <LabPane title="提交后响应" hint="在平台侧配置，不写进模板 HTML">
          <el-form label-position="top">
            <!-- 三个取值即库里 response_type 列的三个值（learn 在协议内部叫 lesson，由服务端翻译）。 -->
            <!-- 三个栏位共用同一个 form.response_content，切换类型不换算，保存时按类型把用不上的字段传 null。 -->
            <el-form-item label="响应类型">
              <el-radio-group v-model="form.response_type">
                <el-radio value="alert">弹窗提示</el-radio>
                <el-radio value="redirect">页面跳转</el-radio>
                <el-radio value="learn">上钩教学</el-radio>
              </el-radio-group>
              <div class="lab-hint">参与人提交表单、数据经 <span class="mono-inline">/alab/v2/engage</span> 上报后，页面呈现的效果。</div>
            </el-form-item>
            <el-form-item v-if="form.response_type === 'alert'" label="提示文案">
              <el-input v-model="form.response_content" type="textarea" :rows="3" placeholder="如：登录成功" />
            </el-form-item>
            <!-- 跳转地址只提示不硬校验；口径是建议用演练环境内的地址，避免把访客送到真实第三方站点 -->
            <el-form-item v-if="form.response_type === 'redirect'" label="跳转地址">
              <el-input v-model="form.response_content" placeholder="https://www.example.com/ok" />
              <div class="lab-hint">建议使用演练环境内可解释的正常地址，避免真实第三方网站。</div>
            </el-form-item>
            <!-- 选上钩教学时改成挑一页教学页：运行时带当前访客令牌跳 /alab/v2/lesson?tk=，由令牌定位那一页 -->
            <el-form-item v-if="form.response_type === 'learn'" label="关联教学页">
              <el-select v-model="form.learn_page_id" placeholder="中招后引导学习的教学页" style="width: 100%">
                <el-option v-for="p in learnPages" :key="p.id" :label="p.name" :value="p.id" />
              </el-select>
              <div class="lab-hint">运行时跳转 <span class="mono-inline">/alab/v2/lesson?tk=</span>，按当前令牌定位教学页。</div>
            </el-form-item>
          </el-form>
        </LabPane>

        <!-- 与一键仿站的分工：模型产整页，这里精修，两边共用同一套表与接口 -->
        <div class="lab-hint">想用模型产出整页？切到「一键仿站」标签，生成后一键存为假登录页再回来微调。</div>
      </div>

      <!-- 右栏：预览、协议速览、诊断，只读当前草稿，不回写字段 -->
      <div class="lab-stack">
        <!-- 预览必须服务端渲染：注入 boot 配置与采集运行时的活儿在 pageCompiler，前端自己拼的预览和上线页面不是一份东西 -->
        <LabPane flush title="实时预览" hint="服务端渲染后的成品，含注入的 boot 配置与运行时">
          <template #ops>
            <!-- 自动刷新由输入防抖那条 watch 负责，这颗是"我要立刻看"的兜底 -->
            <el-button size="small" type="primary" plain :loading="previewing" @click="renderLivePreview">重载预览</el-button>
          </template>
          <!-- 两道防线：srcdoc 只挂 sanitizeHtml 净化过的文档，脚本连同平台注入的采集运行时一起被剥。 -->
          <!-- sandbox 不给 allow-same-origin；preview- 前缀令牌与上报端点不在管理面，兜住预览里提交不落成演练记录。 -->
          <iframe class="preview-frame" :srcdoc="previewDocSafe" title="假登录页预览"
            sandbox="allow-scripts allow-forms allow-modals allow-popups" />
          <div class="lab-hint" style="padding: 8px 14px 12px">
            预览已做净化处理，素材原文按原样保存。净化会剥掉脚本与部分外链，<b>预览不等于访客实际看到的页面</b>：
            仿站页面在这里可能不会动，别拿预览判断上线效果。沙箱不授予同源权限，令牌是平台签发的
            <span class="mono-inline">preview-</span> 前缀，预览里点提交不会落成演练记录。
          </div>
        </LabPane>

        <!-- 协议小抄：讲运行时怎么认采集点，标记名全部属于冻结协议；给手写模板对齐规则用 -->
        <LabPane title="页面协议速览">
          <div class="lab-list">
            <div class="lab-list-item"><span class="lab-chip is-accent">注入</span>
              <span>平台在 <span class="mono-inline">&lt;/body&gt;</span> 前注入 <span class="mono-inline">&lt;script type="application/alab+json" id="alab-boot"&gt;</span> 与运行时脚本。</span>
            </div>
            <!-- 只剩 type="button" 的老模板，运行时会兜底当提交点采，但兜底不是契约：诊断的 trigger 项照样判不过 -->
            <div class="lab-list-item"><span class="lab-chip is-accent">接管</span>
              <span>页面里所有 <span class="mono-inline">&lt;form&gt;</span> 自动接管：提交即上报并拦截；没有 form 时用 <span class="mono-inline">&lt;button data-al-collect&gt;</span> 显式声明采集点。表单里只剩 <span class="mono-inline">type="button"</span> 这种动作按钮时，运行时把它当作提交兜底采集，避免老模板点了没留痕。</span>
            </div>
            <!-- 排除与识别同一套规则：data-al-ignore 排掉、name 决定上报键、同名多值合并成数组 -->
            <div class="lab-list-item"><span class="lab-chip is-accent">排除</span>
              <span>不想被采集的输入框加 <span class="mono-inline">data-al-ignore</span>；字段靠 <span class="mono-inline">name</span> 属性识别，运行时按 <span class="mono-inline">{name: value}</span> 映射上报，同名多值合并为数组。</span>
            </div>
            <div class="lab-list-item"><span class="lab-chip is-accent">运行时</span>
              <span>公共运行时挂在 <span class="mono-inline">window.AwareLab</span>（<span class="mono-inline">token() / collect() / report() / submit()</span>）。</span>
            </div>
            <div class="lab-list-item"><span class="lab-chip is-accent">端点</span>
              <span>上报 <span class="mono-inline">/alab/v2/engage</span> · 上钩教学跳转 <span class="mono-inline">/alab/v2/lesson?tk=</span> · 令牌参数统一 <span class="mono-inline">?tk=</span>。</span>
            </div>
          </div>
          <div class="live-fields">
            <div class="lab-kv">
              <span>本页识别到的字段：<b>{{ liveFields.length }}</b> 个</span>
              <span v-for="n in liveFields.slice(0, 8)" :key="n" class="lab-chip">{{ n }}</span>
              <span v-if="!liveFields.length" class="lab-hint is-mute">没有带 name 的输入框，运行时将无数据可报。</span>
            </div>
          </div>
        </LabPane>

        <!-- 诊断结论只在管理面出现；不拦保存是刻意的（现场常有半成品），但未通过项真演练时就是采不到 -->
        <LabPane title="智能诊断" hint="诊断不阻断保存，但不通过项会让采集失效">
          <template #ops>
            <el-button size="small" :loading="diagnosing" @click="runDiagnose">重新诊断</el-button>
          </template>
          <div v-if="!diagView" class="lab-empty">填写 HTML 后自动诊断，或点「重新诊断」。</div>
          <template v-else>
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px">
              <span style="font-size: 24px; font-weight: 700; color: var(--lab-ink); font-variant-numeric: tabular-nums">{{ diagView.score }}</span>
              <div class="lab-bar" style="flex: 1">
                <div class="lab-bar-fill" :class="barTone(diagView.score)" :style="{ width: `${diagView.score}%` }" />
              </div>
              <span class="lab-chip" :class="diagView.score >= 80 ? 'is-ok' : diagView.score >= 50 ? 'is-warn' : 'is-danger'">
                {{ diagView.score >= 80 ? '可用' : diagView.score >= 50 ? '有风险' : '大概率采不到数据' }}
              </span>
            </div>
            <div class="lab-list">
              <div v-for="c in diagView.checks" :key="c.key" class="lab-list-item check-row">
                <div class="check-hd">
                  <span class="lab-strong">{{ c.label || CHECK_LABELS[c.key] || c.key }}</span>
                  <span class="lab-chip" :class="c.ok ? 'is-ok' : 'is-danger'">{{ c.ok ? '通过' : '未通过' }}</span>
                </div>
                <div class="lab-hint">{{ c.detail || CHECK_NOTES[c.key] || '—' }}</div>
                <div v-if="c.items && c.items.length" class="lab-mono check-items">{{ c.items.join('\n') }}</div>
              </div>
            </div>
            <div v-if="diagView.issues.length" style="margin-top: 10px">
              <div class="lab-hint" v-for="(s, i) in diagView.issues" :key="i">· {{ s }}</div>
            </div>
          </template>
        </LabPane>
      </div>
    </div>

    <template #footer>
      <div class="drawer-foot">
        <span class="lab-hint is-mute">页面 ID：{{ form.id || '保存后由平台签发' }}</span>
        <div class="lab-spacer" />
        <el-button @click="drawer = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存假登录页</el-button>
      </div>
    </template>
  </el-drawer>

  <!-- 列表行的预览弹窗：走同一渲染接口、令牌独立签发，提交不落演练记录；srcdoc 只挂净化后的文档 -->
  <el-dialog v-model="rowPreview.open" :title="`预览 · ${rowPreview.name}`" width="min(920px, 94%)" append-to-body>
    <iframe class="preview-frame is-tall" :srcdoc="rowPreviewDocSafe" title="假登录页预览"
      sandbox="allow-scripts allow-forms allow-modals allow-popups" />
    <div class="lab-hint" style="margin-top: 10px">
      与抽屉内预览同一套渲染结果：预览已做净化处理，素材原文按原样保存；净化会剥掉脚本，预览不等于访客实际看到的页面。
      令牌独立签发，提交动作不会落成演练记录。
    </div>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onActivated } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';
import { fmtTime as ts } from '../../utils/time';
// 预览 iframe 只挂净化后的文档；LOGIN_PREVIEW_OPTIONS 是给假登录页回捞表单控件的那份配置
import { sanitizeHtml, LOGIN_PREVIEW_OPTIONS } from '../../utils/sanitize';

/** gate：演练授权摘要，只驱动顶部横幅展示；门禁在建站监听与访客取页那两处。 */
defineProps({ gate: { type: Object, default: null } });

const RESPONSE_LABEL = { alert: '弹窗提示', redirect: '页面跳转', learn: '上钩教学' };
// 体检五项的中文名，key 与服务端 inspectTemplate 一一对应（协议冻结，改名等于换检查项）。
// 比一键仿站那张表多一项 trigger：这里接手的多是手工粘贴的老模板，只有动作按钮是常态问题。
const CHECK_LABELS = { binding: '采集绑定', trigger: '提交触发点', assets: '外部资源', scripts: '自定义脚本', fields: '可采集字段' };
/** 五项检查的解释文案，服务端没给 detail 时兜底；都指向同一个后果：能不能采到数据、会不会泄露痕迹 */
const CHECK_NOTES = {
  binding: '页面里有 <form>，或有 <button data-al-collect> 声明的采集点。',
  trigger: '表单里有 <button type="submit"> 或标了 data-al-collect 的按钮。只有 type="button" + onclick 的老写法也能采到，但那是靠运行时兜底，别把证据押在兜底上。',
  assets: '不引用 http(s):// 外部 js/css/图片，外链不可达会在演练现场留下破绽。',
  scripts: '模板里不写 <script>，boot 配置与运行时由平台注入。',
  fields: '至少一个带 name 的 input / select / textarea，运行时按 {name: value} 上报。',
};
/** 诊断明细的展示顺序（不按服务端返回顺序）：绑定与触发点排最前 */
const CHECK_ORDER = ['binding', 'trigger', 'assets', 'scripts', 'fields'];

const rows = ref([]);
const total = ref(0);
const types = ref([]);
/** 教学页下拉项（/learn-pages 全量），响应类型选上钩教学时用 */
const learnPages = ref([]);
/** 列表查询条件整份当 params 交给服务端；改过滤条件必须走 reload() 把 page 退回 1 */
const query = reactive({ page: 1, page_size: 10, type: '', keyword: '' });

const drawer = ref(false);
/** 保存按钮 loading，防连点存出两条同名模板 */
const saving = ref(false);
const diagnosing = ref(false);
/** 体检原始报告 {score, checks, issues}，null 表示这份草稿还没跑过 */
const diag = ref(null);
const previewDoc = ref('');
const previewing = ref(false);
const rowPreview = reactive({ open: false, name: '', doc: '' });
// 进 iframe srcdoc 的一定是净化过的文档：脚本、iframe、on* 事件属性、javascript: 协议全被剥掉。
// LOGIN_PREVIEW_OPTIONS 回捞 form/input，否则默认白名单会把登录框本身禁掉，预览只剩空壳。
// 注入的采集运行时同属 script，也被剥，所以预览不等于访客实际看到的页面；库里原文不净化。
// DOMPurify 整文档返回值不带 doctype，补一句 <!DOCTYPE html> 免得 srcdoc 落进 quirks 模式。
const previewDocSafe = computed(() => `<!DOCTYPE html>\n${sanitizeHtml(previewDoc.value, LOGIN_PREVIEW_OPTIONS)}`);
const rowPreviewDocSafe = computed(() => `<!DOCTYPE html>\n${sanitizeHtml(rowPreview.doc, LOGIN_PREVIEW_OPTIONS)}`);
// 抽屉草稿，字段与 web_templates 的列一一对应；id 有值走 PUT，没值走 POST。
// response_content 由弹窗文案和跳转地址共用，保存时按类型把用不上的那个传 null。
const form = reactive({
  id: '', name: '', type: '', description: '', html: '',
  response_type: 'alert', response_content: '登录成功', learn_page_id: '',
});
/** 新建时摊平上一份草稿的空白初值，必须与 form 初值逐字一致 */
const EMPTY_FORM = {
  id: '', name: '', type: '', description: '', html: '',
  response_type: 'alert', response_content: '登录成功', learn_page_id: '',
};
// 「插入骨架」的模板片段：一个 form、两个带 name 的输入框、一个 submit 按钮，五项体检天然全过。
// 原样进编辑框、原样入库、原样发给访客；username / password 是最常见的两个上报键，别顺手改字段名。
const SKELETON = `<main style="max-width:420px;margin:96px auto;font-family:'Segoe UI','Microsoft YaHei',sans-serif">
  <h1 style="font-size:18px;margin:0 0 6px">统一身份认证</h1>
  <p style="font-size:13px;color:#5c6b7a;margin:0 0 20px">请使用工号与口令登录。</p>
  <form style="display:flex;flex-direction:column;gap:12px">
    <input name="username" placeholder="工号" style="padding:10px 12px;border:1px solid #d9e1e8;border-radius:5px;font-size:13px" />
    <input name="password" type="password" placeholder="口令" style="padding:10px 12px;border:1px solid #d9e1e8;border-radius:5px;font-size:13px" />
    <button type="submit" style="padding:10px;border:0;border-radius:5px;background:#0f766e;color:#fff;font-size:14px">登录</button>
  </form>
</main>`;

/** 拉列表：过滤与分页都在服务端做，page_size 会被夹到 1-200；失败交给拦截器。 */
async function load() {
  const data = await http.get('/web-templates', { params: query });
  rows.value = data.rows;
  total.value = data.total;
}
function reload() {
  query.page = 1;
  load();
}
/** 类型列表与教学页全量；保存后与每次切回本页重取，新建的值才立刻能选到。 */
async function loadMeta() {
  types.value = await http.get('/web-templates/types');
  learnPages.value = await http.get('/learn-pages');
}

// 采集字段：与运行时的 name 识别规则保持一致
// 抠出运行时会当成上报键的 name，与一键仿站面板里的同名函数一份逻辑（刻意各留一份，两处判定要一起改）。
// 正则粗扫标签，与运行时拿真实 DOM 的结果不等价，所以界面写作"识别到的字段"而不是最终采集结果。
function fieldNames(html) {
  if (!html) return [];
  const out = [];
  // 三类可采集控件，属性顺序任意，先捞整段标签再一个个抠属性
  for (const m of String(html).matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const tag = m[0];
    // 协议 v2 的排除标记：明写不采的框一律跳过
    if (/data-al-ignore/i.test(tag)) continue;
    const type = (tag.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase() || '';
    // 动作/装饰控件没有值可采，漏掉会让字段数虚高、连带把诊断口径带偏
    if (['submit', 'button', 'reset', 'image'].includes(type)) continue;
    const name = (tag.match(/\bname\s*=\s*["']([^"']+)["']/i) || [])[1];
    // 没 name 的框运行时报不上键名；同名多值运行时合并成数组，这里只留一个名字
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
const liveFields = computed(() => fieldNames(form.html));
/** 统计卡「可采集字段」：只累计本页 rows，与 total 的口径不同 */
const fieldTotal = computed(() => rows.value.reduce((n, r) => n + fieldNames(r.html).length, 0));

// 读某一行保存时固化的诊断分；没跑过或报告读不出回 null。
// 空值走 JSON.parse('') 抛异常再由 catch 收成 null：老数据里这列可能是 NULL，也可能是半截坏 JSON。
function scoreOf(row) {
  try {
    const s = JSON.parse(row.diagnose_json || '').score;
    return typeof s === 'number' ? s : null;
  } catch {
    return null;
  }
}
const scored = computed(() => rows.value.map(scoreOf).filter((v) => v !== null));
const avgScore = computed(() => (scored.value.length ? Math.round(scored.value.reduce((a, b) => a + b, 0) / scored.value.length) : '-'));
/** 均分卡颜色：'-' 不着色，80 / 50 两档与进度条同一把尺子 */
const avgTone = computed(() => {
  if (typeof avgScore.value !== 'number') return '';
  return avgScore.value >= 80 ? 'accent' : avgScore.value >= 50 ? 'warn' : 'danger';
});
/** 进度条配色：80 以上默认主色，50-79 黄，50 以下红（三处口径一致，改就一起改） */
function barTone(v) {
  return v >= 80 ? '' : v >= 50 ? 'is-warn' : 'is-danger';
}
/** 「更新时间」列转给 utils/time 的 ts()；包一层是让时间口径只有一个改动点。 */
function fmtTime(v) {
  return ts(v);
}

// 把原始报告整形成右栏可渲染的结构：按 CHECK_ORDER 排序（未知 key 给 99 沉底），
// label / detail 缺失时回填本文件的字典，items 与 issues 非数组时补空。纯计算，只读 diag。
const diagView = computed(() => {
  const d = diag.value;
  if (!d || !Array.isArray(d.checks)) return null;
  const order = (k) => {
    const i = CHECK_ORDER.indexOf(k);
    return i < 0 ? 99 : i;
  };
  const checks = d.checks
    .map((c) => ({
      key: c.key,
      label: c.label || CHECK_LABELS[c.key] || c.key,
      ok: !!c.ok,
      detail: c.detail || CHECK_NOTES[c.key] || '',
      items: Array.isArray(c.items) ? c.items : [],
    }))
    .sort((a, b) => order(a.key) - order(b.key));
  return { score: Number(d.score ?? 0), checks, issues: Array.isArray(d.issues) ? d.issues : [] };
});

// 跑一次可采集性诊断：POST /web-templates/diagnose 只吃 html、不落库。
// 服务端从不返回"必须改掉才能保存"，前端也绝不因低分禁用保存（见 save()）。
// html 为空时只弹提示；失败保留上一次报告，免得一次抖动把历史结论弄丢。
async function runDiagnose() {
  if (!form.html) return ElMessage.warning('先填写 HTML 源码');
  diagnosing.value = true;
  try {
    diag.value = await http.post('/web-templates/diagnose', { html: form.html });
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    diagnosing.value = false;
  }
}

// 预览：渲染接口是 POST 且要带会话头，结果写进 iframe 的 srcdoc
/** 单行预览弹窗打开瞬间的占位文档。这是会塞进 iframe srcdoc 的数据，字符串本身不要动。 */
const BLANK_PREVIEW = '<p style="font-family:sans-serif;padding:20px;color:#93a1ae">左侧还没有 HTML 源码</p>';

// 请求服务端把 HTML 渲染成可塞进 iframe 的完整文档（POST /web-templates/preview，返回 text/html）。
// 必须服务端渲染：预览要含 boot 注入后的真实结果，这一步用的就是采集协议 v2 的同一段注入代码。
// 预览令牌形如 preview-<uuid>，iframe 不给同源，不会命中 /alab/v2/* 的真实采集路径。
function fetchPreview(html, responseType, responseContent) {
  return http.post('/web-templates/preview', {
    html,
    response_type: responseType || 'alert',
    // learn 时清空 response_content：去向由 learn_page_id 决定，带残留文案会和服务端真实行为不一致
    response_content: responseType === 'learn' ? '' : (responseContent || ''),
  });
}

// 刷新抽屉的「实时预览」。源码为空时把 previewDoc 置空显示空态，别留旧代码让人以为改动生效了。
// 失败只弹提示、保留上一版预览，不清空也不重试。
async function renderLivePreview() {
  if (!form.html) {
    previewDoc.value = '';
    return;
  }
  previewing.value = true;
  try {
    previewDoc.value = await fetchPreview(form.html, form.response_type, form.response_content);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    previewing.value = false;
  }
}

// 列表行的「预览」按钮：渲染库里存的那份，用于核对已存版本，不受编辑器未保存改动影响。
// 先写 name、再填占位文档、最后置 open；顺序反了弹窗会闪一下上一次的文档。失败主动关弹窗。
async function openRowPreview(row) {
  rowPreview.name = row.name;
  rowPreview.doc = BLANK_PREVIEW;
  rowPreview.open = true;
  try {
    rowPreview.doc = await fetchPreview(row.html, row.response_type, row.response_content);
  } catch (err) {
    ElMessage.error(err.message);
    rowPreview.open = false;
  }
}

/** 编辑防抖计时器句柄：不参与渲染，所以用模块级 let 而不是 ref。 */
let typingTimer = null;
// 边写边看：html / response_type / response_content 任一变化，800ms 防抖后重跑预览与诊断。
// 两个响应字段会影响服务端注入的 bootAfter，只监听 html 会漏；没做请求取消，靠防抖把并发压成一次。
// 两个动作不对称：renderLivePreview 自己负责空态；runDiagnose 要先判空，否则每删空一次就弹一次警告。
watch(
  () => [form.html, form.response_type, form.response_content],
  () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      renderLivePreview();
      if (form.html) runDiagnose();
    }, 800);
  }
);

// 新建空白页：整体重置回 EMPTY_FORM（id 清空，save() 靠它判新增/更新）。
// diag 与 previewDoc 一起清掉，否则空白页会挂着上一页的分数。
function openCreate() {
  Object.assign(form, EMPTY_FORM);
  diag.value = null;
  previewDoc.value = '';
  drawer.value = true;
}
// 编辑某一行：库里那份原文整份灌进响应式表单，随即手动渲染预览并跑诊断。
// Object.assign 同时会触发防抖 watch，多跑一轮预览与诊断，结果幂等，是要留的取舍。
function openEdit(row) {
  Object.assign(form, row);
  diag.value = null;
  drawer.value = true;
  renderLivePreview();
  runDiagnose();
}
/** 「插入骨架」：用协议 v2 的采集骨架整体覆盖 form.html，不判空不二次确认；防抖 watch 会接着刷新预览与诊断。 */
function insertSkeleton() {
  form.html = SKELETON;
}

// 保存整页：有 form.id 走 PUT /web-templates/:id，没有走 POST；失败保持抽屉打开，让人改完重试。
// 前端只校验三个必填，刻意与服务端的要求对齐。
// 红线：可采集性诊断分数再低也不会禁用保存，诊断是建议，不是门禁。
async function save() {
  if (!form.name || !form.type || !form.html) return ElMessage.warning('页面类型、名称、HTML 源码必填');
  saving.value = true;
  try {
    // 载荷按字段白名单手挑，不 spread form：里面还挂着 id / created_at / diagnose_json 等只读列
    const payload = {
      name: form.name, type: form.type, description: form.description, html: form.html,
      // 「提交后响应」两个字段互斥，用不上的传 null 而不是空串：
      // learn 留 learn_page_id，其余档留 response_content，库里不会出现自相矛盾的行
      response_type: form.response_type,
      response_content: form.response_type === 'learn' ? null : form.response_content,
      learn_page_id: form.response_type === 'learn' ? form.learn_page_id : null,
    };
    if (form.id) await http.put(`/web-templates/${form.id}`, payload);
    else await http.post('/web-templates', payload);
    // 存好了却在列表里看不见，比没存更让人慌：类型筛选和新素材不一致时把话说清，不偷偷改别人的筛选条件
    ElMessage.success(
      query.type && query.type !== payload.type
        ? `已保存为「${payload.type}」类型；当前列表正按「${query.type}」筛选，清空筛选就能看到这一条`
        : '已保存'
    );
    drawer.value = false;
    // 两次刷新都在写入完成后 await 串行：类型下拉的选项来自服务端 DISTINCT type，写没落库就读不到新类型
    await load();
    await loadMeta();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

// 删除一行：先二次确认，再 DELETE /web-templates/:id。
// 确认框放在 try 外面，用户点「取消」的 reject 不会被 catch 误报成删除失败。
// 引用保护在服务端（被钓鱼网站用到的页面不允许删），这里只原样弹出服务端理由。
async function remove(row) {
  await ElMessageBox.confirm(
    `确认删除假登录页「${row.name}」？仍被钓鱼网站引用的页面会被服务端拒绝删除。`,
    '删除确认',
    { type: 'warning' }
  );
  try {
    await http.delete(`/web-templates/${row.id}`);
    ElMessage.success('已删除');
    load();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

// KeepAlive 下 activated 会紧跟 mounted 多触发一次，用计数让过那一次重复，免得首屏请求打双份
let activates = 0;
onMounted(() => {
  load();
  loadMeta();
});
/** 切回本页只重读列表：类型/教学页下拉由本工作区自己维护（见 save()），不值得每次刷两个下拉。 */
onActivated(() => {
  activates += 1;
  if (activates <= 1) return;
  load();
});
</script>

<style scoped>
/* 分页条顶到右边；12/14px 内边距与统计卡、表格外壳同一套留白 */
.pager { padding: 12px 14px; justify-content: flex-end; }
/* 单行省略；max-width 用 ch 而不是 px，中文/宽字体下才不会提前断或溢出 */
.clamp1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40ch; }
/* 预览 iframe 压到 360px，和左栏源码框同屏才留得住"边改边看"；预览文档自己白底，只留一条下边框 */
.preview-frame { display: block; width: 100%; height: 360px; border: 0; border-bottom: 1px solid var(--lab-line-2); background: #fff; }
.preview-frame.is-tall { height: 520px; border: 1px solid var(--lab-line-2); border-radius: var(--lab-r); }
/* 诊断项竖排、左对齐：默认居中会让长短不一的检查项文字左右跳动 */
.check-row { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
/* 三条负外边距顶掉卡片自身内边距，让分隔线贴着卡片三边贯通；改成普通 margin 会露出悬空横线 */
.live-fields { margin: 12px -14px -14px; padding: 10px 14px; border-top: 1px solid var(--lab-line-2); }
/* 检查项标题行：文案与状态横排 */
.check-hd { display: flex; align-items: center; gap: 8px; }
/* 检查项的字段清单限高 120px 内部滚动：烂页面能列几十条，不限高会撑爆整张诊断卡 */
.check-items { width: 100%; max-height: 120px; font-size: 11.5px; margin-top: 4px; }
/* 源码框等宽字体；:deep 是必须的，.el-textarea__inner 是 Element 内部节点，不加选不中 */
.src-input :deep(.el-textarea__inner) {
  font-family: Consolas, "Cascadia Mono", monospace;
  font-size: 12px;
  line-height: 1.65;
}
/* 抽屉底部操作条：说明在左、按钮在右，同一基线 */
.drawer-foot { display: flex; align-items: center; gap: 10px; }
</style>

<style>
/* 抽屉被 teleport 到 body，宽度约束只能写成组件级全局选择器，不能并进 scoped */
/* 1180px 与 styles/panes.css 里三列降两列的断点同值：再宽就会在窄屏把右栏挤出可视区 */
.page-drawer { max-width: 1180px; }
</style>
