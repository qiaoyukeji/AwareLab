<template>
  <div class="rich">
    <div class="bar">
      <el-radio-group v-model="mode" size="small">
        <el-radio-button value="rich">富文本</el-radio-button>
        <el-radio-button value="code">HTML源码</el-radio-button>
      </el-radio-group>
      <template v-if="mode === 'rich'">
        <span class="tools">
          <button v-for="t in TOOLS" :key="t.cmd" type="button" :title="t.title" @mousedown.prevent="exec(t)">{{ t.label }}</button>
        </span>
      </template>
      <span v-else class="lab-hint">支持 HTML 实时编辑，发送时按收件人替换占位符</span>
    </div>

    <div
      v-show="mode === 'rich'"
      ref="editable"
      class="editable"
      contenteditable="true"
      @input="syncFromRich"
      @blur="syncFromRich"
    />
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
import { ref, watch, onMounted } from 'vue';

const props = defineProps({ modelValue: { type: String, default: '' } });
const emit = defineEmits(['update:modelValue']);

const TOOLS = [
  { cmd: 'bold', label: 'B', title: '加粗' },
  { cmd: 'italic', label: 'I', title: '斜体' },
  { cmd: 'underline', label: 'U', title: '下划线' },
  { cmd: 'insertUnorderedList', label: '• 列表', title: '无序列表' },
  { cmd: 'insertOrderedList', label: '1. 列表', title: '有序列表' },
  { cmd: 'formatBlock:h3', label: '标题', title: '插入标题' },
  { cmd: 'removeFormat', label: '清格式', title: '清除格式' },
];

const mode = ref('rich');
const editable = ref(null);
const code = ref(props.modelValue || '');

function exec(tool) {
  const [cmd, arg] = tool.cmd.split(':');
  document.execCommand(cmd, false, arg ?? null);
  syncFromRich();
}

function syncFromRich() {
  if (!editable.value) return;
  code.value = editable.value.innerHTML;
  emit('update:modelValue', code.value);
}

function syncFromCode() {
  emit('update:modelValue', code.value);
}

watch(mode, (m) => {
  if (m === 'rich' && editable.value) editable.value.innerHTML = code.value;
});

watch(
  () => props.modelValue,
  (v) => {
    if (v !== code.value) code.value = v || '';
    if (mode.value === 'rich' && editable.value && editable.value.innerHTML !== code.value) {
      editable.value.innerHTML = code.value;
    }
  }
);

onMounted(() => {
  if (editable.value) editable.value.innerHTML = code.value;
});
</script>

<style scoped>
.rich { border: 1px solid var(--lab-line); border-radius: var(--lab-r); overflow: hidden; }
.bar { display: flex; align-items: center; gap: 12px; padding: 8px 10px; background: var(--lab-fill-2); border-bottom: 1px solid var(--lab-line); flex-wrap: wrap; }
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
.editable { min-height: 300px; max-height: 460px; overflow: auto; padding: 14px; outline: none; font-size: 13px; }
.editable :deep(img) { max-width: 100%; }
</style>
