<template>
  <div class="lib">
    <!-- 顶栏：类型切换 + 搜索 + 一键补齐内置素材。类型是分段按钮而不是下拉，三类素材一眼看全 -->
    <div class="lib-bar">
      <el-radio-group v-model="kind" size="small">
        <el-radio-button value="page">页面模板 · {{ pages.length }}</el-radio-button>
        <el-radio-button value="mail">邮件模板 · {{ mails.length }}</el-radio-button>
        <el-radio-button value="lesson">教学页 · {{ lessons.length }}</el-radio-button>
      </el-radio-group>
      <el-input v-model="keyword" size="small" placeholder="搜索名称、用途或类型" clearable class="lib-search">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-button size="small" :loading="seeding" @click="reseed">补齐内置素材</el-button>
    </div>

    <p class="lab-hint lib-note">
      以下模板随平台内置，点「使用」会复制一份到「假登录页 / 邮件文案 / 教学页」，之后可自由改 HTML 与字段；
      内置原件不会被改动，随时可以再复制一份。
    </p>

    <div v-if="loading" class="lab-empty">模板加载中…</div>
    <div v-else-if="!filtered.length" class="lab-empty">没有匹配的模板，换个关键词或点「补齐内置素材」。</div>
    <div v-else class="lib-grid">
      <article v-for="item in filtered" :key="item.key" class="lib-card">
        <!-- 缩略图用 iframe 原样渲染，页面模板能看出排版；sandbox 去掉脚本，内置模板本身也没有 script -->
        <div class="lib-thumb" @click="preview = item">
          <iframe :srcdoc="item.html" sandbox="" tabindex="-1" title="模板预览" />
          <span v-if="item.type" class="lib-type">{{ typeLabel(item.type) }}</span>
          <span v-if="item.clones" class="lib-used">已复制 {{ item.clones }} 份</span>
        </div>
        <div class="lib-body">
          <h4>{{ item.name }}</h4>
          <p>{{ item.description }}</p>
          <div class="lib-ops">
            <el-button link type="primary" @click="preview = item">预览</el-button>
            <el-button link type="primary" :loading="usingKey === item.key" @click="use(item)">使用此模板</el-button>
          </div>
        </div>
      </article>
    </div>

    <!-- 预览弹窗：整页原样展示，邮件模板也能看到 600px 版心与按钮 -->
    <el-dialog v-model="previewOpen" :title="preview?.name || '模板预览'" width="760px" append-to-body>
      <iframe v-if="preview" :srcdoc="preview.html" sandbox="" class="lib-frame" title="模板预览" />
      <template #footer>
        <el-button @click="previewOpen = false">关闭</el-button>
        <el-button type="primary" :loading="usingKey === preview?.key" @click="preview && use(preview)">使用此模板</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
/**
 * 内置模板库：页面、邮件、教学页三类素材的陈列与一键复制。
 * 数据来自 GET /library（只读，内置原件不随用户编辑变化）；「使用」走 POST /library/use，后端复制成一条普通素材记录。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import http from '../../api/client';

const emit = defineEmits(['used']);

const kind = ref('page');
const keyword = ref('');
const loading = ref(true);
const seeding = ref(false);
const usingKey = ref('');
const pages = ref([]);
const mails = ref([]);
const lessons = ref([]);
const preview = ref(null);

const TYPE_LABEL = { login: '登录页', verify: '验证页', notice: '通知页' };

const previewOpen = computed({
  get: () => !!preview.value,
  set: (v) => {
    if (!v) preview.value = null;
  },
});

// 教学页没有 type 字段，统一补成 '教学页'，卡片右上角才不会空着
const source = computed(() => {
  if (kind.value === 'mail') return mails.value;
  if (kind.value === 'lesson') return lessons.value;
  return pages.value;
});

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return source.value;
  return source.value.filter((item) =>
    [item.name, item.description, item.subject].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
  );
});

function typeLabel(type) {
  return TYPE_LABEL[type] || type;
}

async function load() {
  loading.value = true;
  try {
    const data = await http.get('/library');
    pages.value = (data.pages || []).map((p) => ({ ...p, kind: 'page' }));
    mails.value = (data.mails || []).map((m) => ({ ...m, kind: 'mail', html: m.body_html }));
    lessons.value = (data.lessons || []).map((l) => ({ ...l, kind: 'lesson' }));
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    loading.value = false;
  }
}

/**
 * 复制内置模板。成功后通知父级切到对应标签并强制重挂载，否则 KeepAlive 里的列表还是旧的，会让人以为没复制上。
 */
async function use(item) {
  usingKey.value = item.key;
  try {
    const res = await http.post('/library/use', { kind: item.kind, key: item.key });
    ElMessage.success(`已复制「${res?.name || item.name}」，已切到对应标签，可直接编辑`);
    item.clones = (item.clones || 0) + 1;
    preview.value = null;
    emit('used', item.kind);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    usingKey.value = '';
  }
}

/** 补齐内置素材：升级后新增的模板靠它落库，已有同 key 的跳过，不会覆盖用户复制出来的副本。 */
async function reseed() {
  seeding.value = true;
  try {
    await http.post('/library/seed');
    await load();
    ElMessage.success('内置素材已补齐');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    seeding.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.lib-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 14px 0; }
.lib-search { width: 240px; margin-left: auto; }
.lib-note { margin: 10px 14px 0; }
.lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
  gap: 14px;
  padding: 14px;
}
.lib-card {
  display: flex; flex-direction: column;
  border: 1px solid var(--lab-line);
  border-radius: var(--lab-r);
  background: var(--lab-surface);
  overflow: hidden;
  transition: border-color .15s, box-shadow .15s;
}
.lib-card:hover { border-color: var(--lab-accent); box-shadow: 0 4px 14px rgba(15, 118, 110, .08); }
/* 缩略图容器固定 4:3，iframe 用 1200×900 再整体缩到 25%，比截图片更真实且不占体积 */
.lib-thumb {
  position: relative;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  background: var(--lab-fill);
  border-bottom: 1px solid var(--lab-line-2);
  cursor: zoom-in;
}
.lib-thumb iframe {
  width: 1200px; height: 900px;
  border: 0;
  transform: scale(.25);
  transform-origin: top left;
  pointer-events: none;
}
.lib-type, .lib-used {
  position: absolute; top: 8px;
  padding: 1px 7px; border-radius: var(--lab-r-sm);
  font-size: 11px; font-weight: 600;
}
.lib-type { left: 8px; background: var(--lab-accent-soft); color: var(--lab-accent); }
.lib-used { right: 8px; background: rgba(255, 255, 255, .92); color: var(--lab-ink-3); }
.lib-body { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 8px; flex: 1 1 auto; }
.lib-body h4 { margin: 0; font-size: 13.5px; font-weight: 700; color: var(--lab-ink); }
.lib-body p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--lab-ink-3); flex: 1 1 auto; }
.lib-ops { display: flex; justify-content: flex-end; gap: 4px; }
.lib-ops .el-button + .el-button { margin-left: 0; }
.lib-frame { width: 100%; height: 62vh; border: 1px solid var(--lab-line); border-radius: var(--lab-r); background: #fff; }
</style>
