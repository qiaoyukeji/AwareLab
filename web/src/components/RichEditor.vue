<template>
  <div class="rich">
    <!-- 工具条：左切模式，右按模式给按钮或提示 -->
    <div class="bar">
      <!-- 模式只切两个编辑面的可见性，共用下面同一个 code 值 -->
      <el-radio-group v-model="mode" size="small">
        <el-radio-button value="rich">富文本</el-radio-button>
        <el-radio-button value="code">HTML源码</el-radio-button>
      </el-radio-group>
      <template v-if="mode === 'rich'">
        <!-- 源码模式下不渲染按钮：execCommand 只作用于 contenteditable -->
        <span class="tools">
          <!-- @mousedown.prevent：button 默认抢焦点会让选区消失，加粗就加不到选中字上 -->
          <button v-for="t in TOOLS" :key="t.cmd" type="button" :title="t.title" @mousedown.prevent="exec(t)">{{ t.label }}</button>
        </span>
      </template>
      <span v-else class="lab-hint">支持 HTML 实时编辑，发送时按收件人替换占位符</span>
    </div>

    <!-- 编辑面用 v-show 不用 v-if：contenteditable 的 DOM 必须常驻，否则 editable ref 变 null，灌值分支全失灵 -->
    <div
      v-show="mode === 'rich'"
      ref="editable"
      class="editable"
      contenteditable="true"
      @input="syncFromRich"
      @blur="syncFromRich"
      @paste="onPaste"
    />
    <!-- 源码面：textarea 直接绑 code -->
    <el-input
      v-show="mode === 'code'"
      v-model="code"
      type="textarea"
      :rows="14"
      placeholder="设置邮件的发送内容，支持文本编辑或HTML渲染"
      @input="syncFromCode"
    />
  </div>
</template>

<script setup>
/**
 * 富文本 / HTML 源码双模编辑器：邮件正文、教学页正文共用。标准 v-model，内部 code 这一份串是唯一真值，两个编辑面只是它的视图。
 * 凡有 HTML 进编辑面都先过 sanitizeHtml：外部粘贴、modelValue 回流、每次往 contenteditable 灌 innerHTML。
 * 素材原文保存不清化（证据要原文），本组件只净化进编辑面、随 v-model 流出的内容；没动过不回写，一动就以净化版为准。
 */
import { ref, watch, onMounted } from 'vue';
// 净化入口：HTML 走 sanitizeHtml（白名单），纯文本粘贴走 sanitizeText（实体转义）
import { sanitizeHtml, sanitizeText } from '../utils/sanitize';

// modelValue：当前 HTML 串，父表单直接绑；组件不校验内容（正文由操作员负责，服务端另有门禁）
const props = defineProps({ modelValue: { type: String, default: '' } });
// 富文本与源码改动都归同一条 update:modelValue，父级不区分来源
const emit = defineEmits(['update:modelValue']);

/**
 * 工具条按钮表，cmd 直接喂 execCommand；带冒号的 'formatBlock:h3' 是命令名:参数，exec() 里 split 开。
 * formatBlock 参数统一写裸标签名 h3，别混 '<h3>' 写法。
 */
const TOOLS = [
  { cmd: 'bold', label: 'B', title: '加粗' },
  { cmd: 'italic', label: 'I', title: '斜体' },
  { cmd: 'underline', label: 'U', title: '下划线' },
  { cmd: 'insertUnorderedList', label: '• 列表', title: '无序列表' },
  { cmd: 'insertOrderedList', label: '1. 列表', title: '有序列表' },
  { cmd: 'formatBlock:h3', label: '标题', title: '插入标题' },
  { cmd: 'removeFormat', label: '清格式', title: '清除格式' },
];

// 当前编辑面：rich 走 contenteditable，code 走 textarea，默认富文本
const mode = ref('rich');
// contenteditable 的引用，靠 v-show 常驻，否则拿到 null
const editable = ref(null);
// 唯一真值：整段 HTML。初值取 prop（打开旧素材也是外部 HTML 入口），先净化再进真值；库里原文不受影响，没编辑就不回写
// 正文里的 {{name}}/{{email}} 是发送时按收件人替换的变量，本组件只原样保存；列表页预览要显示它们得加 v-pre
const code = ref(sanitizeHtml(props.modelValue || ''));

/**
 * 点工具条按钮：对选区执行 execCommand，再把 DOM 收回 code 并 emit。
 * 仍用已废弃的 execCommand：它是唯一不重写整段 innerHTML 就能改选区格式的路子，自己拼标签容易把正文弄坏。
 */
function exec(tool) {
  const [cmd, arg] = tool.cmd.split(':');
  // 第三参缺省给 null：execCommand 传 undefined 在部分浏览器会被当成字符串 "undefined"
  document.execCommand(cmd, false, arg ?? null);
  syncFromRich();
}

/**
 * 粘贴事件：拦下默认导入，剪贴板内容净化后再插入（外部粘贴默认会把 <img onerror>、脚本壳原样塞进编辑区）。
 * 带 text/html 整段 sanitizeHtml，只有纯文本用 sanitizeText 转义、换行补 <br>；都为空（只粘了文件）就不插，宁可不粘不粘脏的。
 * 用 execCommand('insertHTML') 插入以保留浏览器撤销栈，随后 syncFromRich 回读 emit。
 */
function onPaste(e) {
  e.preventDefault();
  const clipHtml = e.clipboardData.getData('text/html');
  const clipText = e.clipboardData.getData('text/plain');
  const safe = clipHtml ? sanitizeHtml(clipHtml) : sanitizeText(clipText);
  if (!safe) return;
  document.execCommand('insertHTML', false, safe);
  syncFromRich();
}

/**
 * 富文本 → code → 父级：读 innerHTML、改 code、emit。
 * editable 为 null（未挂载）时直接返回，不 emit 空串清空父表单；此处 DOM 只可能来自已净化内容 + 本机编辑，不再二次净化。
 */
function syncFromRich() {
  if (!editable.value) return;
  code.value = editable.value.innerHTML;
  emit('update:modelValue', code.value);
}

/**
 * 源码面 → 父级：textarea 已用 v-model 写进 code，这里只补 emit，不回灌 contenteditable（切回富文本由 watch(mode) 统一灌）。
 * 打字途中不清洗源码原文（半截标签、占位注释会被静默吃掉），但它灌回编辑区或被渲染前一律先过 sanitizeHtml。
 */
function syncFromCode() {
  emit('update:modelValue', code.value);
}

// 切回富文本把源码灌进编辑区，灌前净化（源码面可能躺着未清洗的原文）；切到源码面不用管，textarea 绑的就是 code
watch(mode, (m) => {
  if (m === 'rich' && editable.value) {
    const clean = sanitizeHtml(code.value);
    if (editable.value.innerHTML !== clean) editable.value.innerHTML = clean;
  }
});

/**
 * 外部改值（打开另一条素材、清空、仿站回填）时同步进来，回流串先 sanitizeHtml 再进真值。
 * 两道判等是刻意的：v !== code 打断 emit→写回 prop→又赋值 的回声（否则打字光标跳），innerHTML !== code 只在真变了才写编辑区（否则父级每次渲染重建 DOM 丢选区）。
 * 这里不 emit：打开素材不等于编辑，没动手不回写；DOMPurify 幂等，父级再带原文回来也只重算出同一份。
 */
watch(
  () => props.modelValue,
  (v) => {
    if (v !== code.value) code.value = sanitizeHtml(v || '');
    if (mode.value === 'rich' && editable.value && editable.value.innerHTML !== code.value) {
      editable.value.innerHTML = code.value;
    }
  }
);

// 首次挂载把初值灌进 contenteditable：它没有 value 属性，不写 innerHTML 就是空编辑区；code 初值已在声明处净化过
onMounted(() => {
  if (editable.value) editable.value.innerHTML = code.value;
});
</script>

<style scoped>
/* 只用 tokens.css 变量，跟全站一套尺 */
.rich { border: 1px solid var(--lab-line); border-radius: var(--lab-r); overflow: hidden; }
/* overflow hidden 配圆角，裁掉盖住圆角的工具条底色 */
.bar { display: flex; align-items: center; gap: 12px; padding: 8px 10px; background: var(--lab-fill-2); border-bottom: 1px solid var(--lab-line); flex-wrap: wrap; }
/* flex-wrap 必留：7 个按钮在右侧抽屉里排不下，宁可换行不要横向溢出 */
.tools { display: flex; gap: 4px; }
.tools button {
  border: 1px solid var(--lab-line);
  background: var(--lab-surface);
  border-radius: var(--lab-r-sm);
  padding: 3px 9px;
  font-size: 12px;
  cursor: pointer;
}
.tools button:hover { border-color: var(--lab-accent); color: var(--lab-accent); }
/* min-height 给正文一个信封高度，max-height 再高会把保存按钮挤出屏幕 */
.editable { min-height: 300px; max-height: 460px; overflow: auto; padding: 14px; outline: none; font-size: 13px; }
.editable :deep(img) { max-width: 100%; }
/* :deep 必需：正文里的图不带 scoped 属性，命中不到；不裁宽横幅图会撑出横向滚动条 */
</style>
