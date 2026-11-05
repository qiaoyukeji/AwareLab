<template>
  <!-- 一排标签：本身不管内容，只把选中的 key 交回调用方 -->
  <div class="lab-tabs" role="tablist">
    <!-- 用真 <button> 配 role="tab" / aria-selected，让键盘与读屏能选标签 -->
    <button
      v-for="item in items"
      :key="item.key"
      class="lab-tab"
      :class="{ 'is-on': modelValue === item.key }"
      role="tab"
      :aria-selected="modelValue === item.key"
      @click="pick(item.key)"
    >
      {{ item.label }}
      <span v-if="countOf(item) != null" class="lab-tab-n">{{ countOf(item) }}</span>
    </button>
  </div>
</template>

<script setup>
/**
 * 工作区标签栏，无内部状态，只经 v-model 把选中 key 交回调用方。样式来自 panes.css 的 .lab-tabs / .lab-tab。
 * label 用操作员看得懂的名称，不出现内部代号；改 key 会改掉 URL，同事手里的旧链接随之失效。
 */
const props = defineProps({
  // key 用于路由 query 与调用方 PANES 查表，两者必须一一对应
  items: { type: Array, required: true },
  // 当前选中的 key（v-model 绑定值）
  modelValue: { type: String, required: true },
  // 各标签右侧的数字徽标，键与 items[].key 对应；各工作区目前都没传，属预留能力
  counts: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['update:modelValue']);

/** 只接受 number，其它类型当作没有数据；0 照常显示，所以模板那侧用 != null 判断。 */
function countOf(item) {
  const v = props.counts[item.key];
  return typeof v === 'number' ? v : null;
}
/**
 * 只有切到不同 key 才 emit。点当前标签也会走一遍 router.replace，
 * 白刷一次 URL，还会让 KeepAlive 之外的面板重新取数。
 */
function pick(key) {
  if (key !== props.modelValue) emit('update:modelValue', key);
}
</script>
