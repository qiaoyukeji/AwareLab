<!--
  上钩教学页：参与人在假登录页提交后被导向的安全教育页，只写复盘与识别要点，页面本身不参与采集。
  保存只走 POST 新建修订版，不做原地更新，旧版本自己删；删除不清 learn_page_id，采集面遇到悬空引用回落到内置提示页。
  查看/预览弹窗挂 sanitizeHtml 洗过的 HTML，脚本与危险协议在渲染前剥掉，原文入库不动，所以预览不等于访客实际看到的页面。
-->
<template>
  <div class="lab-stack">
    <div class="lab-hint">
      上钩教学页是参与人在假登录页提交之后被导向的页面：假登录页的「提交后响应」选择 <span class="lab-chip is-accent">上钩教学</span>
      并绑定某一页，运行时按 <span class="mono-inline">/alab/v2/lesson?tk=</span> 携带该参与人的令牌跳转，做到「演练即培训」。教学页按钓鱼网站绑定，可被多个假登录页复用。
    </div>

    <!-- gate 为空只提示不禁用按钮：教学页随时能写，有没有人跳过来取决于钓鱼网站是否在授权名单内开启监听 -->
    <el-alert v-if="!gate" type="warning" :closable="false" show-icon
      title="未登记有效授权，假登录页无法开启"
      description="教学页可以随时准备；只有钓鱼网站在授权名单内开启监听后，提交才会有跳转过来的一刻。" />

    <!-- 三个统计口径不同：已绑定数的是假登录页条数，不是教学页条数 -->
    <div class="lab-grid" style="--cols: 3">
      <LabMetric label="教学页" :value="rows.length" unit="页" extra="按假登录页绑定，可被多个页面复用" />
      <LabMetric label="已绑定" :value="boundCount" unit="个页面" tone="accent" extra="提交后响应选择「上钩教学」的假登录页" />
      <LabMetric label="未被引用" :value="unboundCount" unit="页" :tone="unboundCount ? 'warn' : ''" extra="可删除或在假登录页里选上" />
    </div>

    <LabPane flush title="上钩教学页" hint="内容用富文本或 HTML 源码编写，只写教育性内容">
      <template #ops>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          <span>新建教学页</span>
        </el-button>
        <el-button @click="load">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
      </template>

      <!-- 全量列表，服务端不分页；created_at 倒序也在服务端排好 -->
      <el-table :data="rows" size="small">
        <el-table-column label="名称" min-width="200">
          <template #default="{ row }">
            <div class="lab-strong">{{ row.name }}</div>
            <div class="lab-hint is-mute">{{ excerpt(row.html) }}</div>
          </template>
        </el-table-column>
        <!-- 绑定关系在前端反查：从假登录页里挑 learn_page_id 指向本页的，只摊前 3 个再加 +N -->
        <el-table-column label="绑定的假登录页" min-width="240">
          <template #default="{ row }">
            <div v-if="usersOf(row.id).length" class="lab-kv">
              <span v-for="p in usersOf(row.id).slice(0, 3)" :key="p.id" class="lab-chip is-accent">{{ p.name }}</span>
              <span v-if="usersOf(row.id).length > 3" class="lab-hint is-mute">+{{ usersOf(row.id).length - 3 }}</span>
            </div>
            <span v-else class="lab-chip is-warn">未被引用</span>
          </template>
        </el-table-column>
        <el-table-column label="篇幅" width="110">
          <template #default="{ row }"><span class="lab-hint">{{ plainLength(row.html) }} 字</span></template>
        </el-table-column>
        <!-- 库里存 UTC，过 utils/time 换本机时区；教学页只增不改，所以看创建时间 -->
        <el-table-column label="创建时间" width="130">
          <template #default="{ row }"><span class="lab-hint">{{ fmtTime(row.created_at) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="view(row)">查看</el-button>
            <el-button link type="primary" @click="openRevise(row)">修改</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="lab-empty">还没有上钩教学页。新建一页写明「刚才发生了什么 + 三条识别要点」即可。</div>
        </template>
      </el-table>
    </LabPane>

    <div class="lab-hint is-mute">
      教学页只做安全教育与要点复盘，不写获取口令的技巧、不引导重复提交；页面内容不参与采集，运行时不会在教学页里声明 <span class="mono-inline">data-al-collect</span> 采集点。
    </div>
  </div>

  <!-- 新建与修订共用这一个抽屉；close-on-click-modal 关掉，免得点空白丢掉写了一半的正文 -->
  <el-drawer v-model="drawer" class="lesson-drawer" :title="drawerTitle" size="70%" :close-on-click-modal="false">
    <div class="lab-stack">
      <el-alert v-if="form.id" type="info" :closable="false" show-icon
        title="教学页只增不改：保存会生成一条新的教学页记录"
        description="接口按新建登记。保存后请到「假登录页」的「提交后响应 · 关联教学页」改选新版本，旧版本确认无用后删除即可。" />

      <LabPane title="基本信息">
        <el-form label-position="top">
          <el-form-item label="名称" required>
            <el-input v-model="form.name" maxlength="100" show-word-limit placeholder="如：识别钓鱼邮件四步法" style="max-width: 420px" />
          </el-form-item>
          <!-- 富文本与 HTML 源码两种模式写同一个 form.html，存进去就是访客看到的原文，
               平台不注入运行时、不做变量替换，也不参与采集 -->
          <el-form-item label="页面内容" required>
            <RichEditor v-model="form.html" />
          </el-form-item>
        </el-form>
      </LabPane>

      <LabPane title="写作要点">
        <div class="lab-list">
          <div class="lab-list-item"><span class="lab-chip is-accent">1</span><span>先说清「你刚才提交了什么」，再给识别要点，不要一上来讲课。</span></div>
          <div class="lab-list-item"><span class="lab-chip is-accent">2</span><span>三条以内可执行的动作：核对发件人域名、警惕紧急话术、不在仿冒页输入口令。</span></div>
          <div class="lab-list-item"><span class="lab-chip is-accent">3</span><span>给出反馈渠道（安全值班邮箱/内部工单），让参与者知道下一步找谁。</span></div>
        </div>
      </LabPane>
    </div>

    <template #footer>
      <div class="drawer-foot">
        <span class="lab-hint is-mute">{{ plainLength(form.html) }} 字纯文本</span>
        <div class="lab-spacer" />
        <el-button @click="drawer = false">取消</el-button>
        <el-button @click="dialogVisible = true">预览</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存教学页</el-button>
      </div>
    </template>
  </el-drawer>

  <!-- 查看/预览弹窗：srcdoc 挂 sanitizeHtml 洗过的 HTML，脚本、on* 属性与 javascript: 协议在进弹窗前剥掉；sandbox 设空值不给任何权限 -->
  <el-dialog v-model="dialogVisible" :title="viewing.name ? `查看教学页 · ${viewing.name}` : '预览教学页'" width="820px" top="6vh">
    <iframe v-if="viewing.html" class="lesson-frame" :srcdoc="viewingHtmlSafe" title="上钩教学页预览" sandbox="" />
    <div v-else class="lab-empty">页面内容为空。</div>
    <!-- 用 :srcdoc 绑定而不是手拼字符串：Vue 自动转义引号，正文里的双引号截不断属性 -->
    <div class="lab-hint" style="margin-top: 10px">预览已做净化处理，素材原文按原样保存；净化会剥掉脚本，预览不等于访客实际看到的页面。</div>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onActivated } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';
import RichEditor from '../../components/RichEditor.vue';
import { fmtTime as ts } from '../../utils/time';
import { sanitizeHtml } from '../../utils/sanitize';

/** gate 为 null 时只亮顶部警示条；教学页是素材，门禁在采集面那侧 */
defineProps({ gate: { type: Object, default: null } });

const rows = ref([]);
/** 假登录页列表，只用来反查哪几个页面绑了这页 */
const templates = ref([]);
const drawer = ref(false);
const dialogVisible = ref(false);
/** 接口只有新建，连点会存出两条同内容的修订版，所以必须锁 */
const saving = ref(false);
const viewing = reactive({ id: '', name: '', html: '' });
/**
 * 弹窗 iframe 挂这份净化结果，而不是 viewing.html 原文；form/input 这类控件本就该禁。
 * 净化幂等，库里旧行仍是原文，再洗一次不会叠加破坏，原文不动。
 */
const viewingHtmlSafe = computed(() => sanitizeHtml(viewing.html));
/** id 有值只表示这是从某一页改出来的修订版，保存时不会拿它去更新 */
const form = reactive({ id: '', name: '', html: '' });
const drawerTitle = computed(() => (form.id ? `修改上钩教学页 · ${form.name}` : '新建上钩教学页'));

/** GET /learn-pages 直接返回摊平后的数组，所以整份赋给 rows，没有 rows/total 那层壳 */
async function load() {
  rows.value = await http.get('/learn-pages');
}
/** 反查绑定用：page_size 取 paginate 上限 200，少取会让已绑定统计与绑定标签凭空少几页 */
async function loadLinks() {
  const data = await http.get('/web-templates', { params: { page_size: 200 } });
  templates.value = data.rows || [];
}

/** 按 learn_page_id 挑出绑着这页的假登录页；引用悬空时挑不到，就是未被引用，不报错 */
const usersOf = (id) => templates.value.filter((t) => t.learn_page_id === id);
/** 数的是假登录页条数，不是教学页条数 */
const boundCount = computed(() => templates.value.filter((t) => t.response_type === 'learn' && t.learn_page_id).length);
/** 没有任何假登录页绑上的教学页数，非零时统计卡转警告色 */
const unboundCount = computed(() => rows.value.filter((r) => !usersOf(r.id).length).length);

/** HTML 拍成一行纯文本：只服务于摘要与字数，正文永远存原文 */
function strip(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
/** 名称下的摘要行：strip 后超 80 字截断，空内容显示（空内容），返回串永不为空 */
function excerpt(html) {
  const text = strip(html);
  return text ? (text.length > 80 ? `${text.slice(0, 80)}…` : text) : '（空内容）';
}
/** 篇幅列与页脚字数共用：纯文本长度，不含标签 */
const plainLength = (html) => strip(html).length;
/** 时间列显示包装：库里是 UTC 串，一律换成本机时区（见 utils/time 的说明） */
function fmtTime(v) {
  return ts(v);
}

/** 预填的起手段落没有采集标记，也不引导重复提交 */
function openCreate() {
  Object.assign(form, {
    id: '', name: '',
    html: '<h2>您刚才在演练页面提交了信息</h2><p>请学习以下要点：核对发件人域名、警惕紧急话术、不随意输入账号密码。</p>',
  });
  drawer.value = true;
}
/** 抄原页内容进草稿，id 只用来决定标题和那句提示；保存仍新建，旧版本要操作员自己删 */
function openRevise(row) {
  Object.assign(form, { id: row.id, name: `${row.name}（修订）`, html: row.html });
  drawer.value = true;
}
/** 整行抄进 viewing 后开弹窗；弹窗只认 viewing，不认抽屉草稿 */
function view(row) {
  Object.assign(viewing, { id: row.id, name: row.name, html: row.html });
  dialogVisible.value = true;
}

/**
 * POST /learn-pages，永远新建；name 与 html 必填，正文原样入库，不做变量替换也不注入运行时。
 * 从修改进来时成功文案额外提醒去假登录页改选新版本，否则新页没人跳得到；失败不关抽屉，草稿留着。
 */
async function save() {
  if (!form.name || !form.html) return ElMessage.warning('名称与内容必填');
  saving.value = true;
  try {
    await http.post('/learn-pages', { name: form.name, html: form.html });
    ElMessage.success(form.id ? '已保存为新版本，请在假登录页改选该教学页' : '已保存');
    drawer.value = false;
    // 两次刷新串行 await：新页落库后马上重读，绑定标签与"未被引用"计数才不会停在旧数据上
    await load();
    await loadLinks();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

/**
 * 服务端只删 learn_pages 这一行，不清假登录页上的 learn_page_id，引用会悬空；
 * 采集面遇到悬空引用回落到内置提示页，访客看到的不是白屏。确认框点取消的 reject 落在 try 之外，正好跳过删除。
 */
async function remove(row) {
  const used = usersOf(row.id).length;
  await ElMessageBox.confirm(
    used ? `「${row.name}」仍被 ${used} 个假登录页绑定，删除后这些页面的学习跳转会失效。确认删除？` : `确认删除「${row.name}」？`,
    '删除确认',
    { type: 'warning' }
  );
  try {
    await http.delete(`/learn-pages/${row.id}`);
    ElMessage.success('已删除');
    await load();
    await loadLinks();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

/* KeepAlive 下 activated 会紧跟 mounted 触发一次，第一次让它空跑，避免首屏重复请求 */
let activates = 0;
onMounted(() => {
  // 两个只读请求并发，不互相等
  load();
  loadLinks();
});
onActivated(() => {
  activates += 1;
  if (activates <= 1) return;
  // 切回本页时重拉：教学页和绑定关系都可能在别处改过
  load();
  loadLinks();
});
</script>

<style scoped>
/* 预览 iframe 定高 60vh，长页让它内部滚动，弹窗不跟着无限变高 */
.lesson-frame { display: block; width: 100%; height: 60vh; border: 1px solid var(--lab-line); border-radius: var(--lab-r-sm); background: #fff; }
.drawer-foot { display: flex; align-items: center; gap: 10px; }
</style>

<style>
/* 抽屉被 teleport 到 body，宽度约束只能写成全局选择器；880px 之外由抽屉 size=70% 收 */
.lesson-drawer { max-width: 880px; }
</style>
