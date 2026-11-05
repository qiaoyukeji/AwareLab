<template>
  <!-- 一格指标：上标签、中数字、下口径说明，最后一行留给调用方塞附加内容 -->
  <div class="lab-metric" :class="tone ? `is-${tone}` : ''">
    <div class="lab-metric-k">{{ label }}</div>
    <!-- 单位靠内联样式压回 13px，否则继承 .lab-metric-v 的 24px 粗体 -->
    <div class="lab-metric-v">{{ value }}<small v-if="unit" style="font-size: 13px; font-weight: 600"> {{ unit }}</small></div>
    <div v-if="extra" class="lab-metric-x">{{ extra }}</div>
    <slot />
  </div>
</template>

<script setup>
/**
 * 指标块，纯展示。样式来自 panes.css 的 .lab-metric 与 .is-accent|is-warn|is-danger。
 * label 与 extra 用操作员看得懂的中文口径，不写数据库字段名或开发缩写。
 */
defineProps({
  // 指标名，第一行小字
  label: { type: String, required: true },
  // 缺省画 '-'，让"还没查到"和"真的是 0"分开；传 0 会正常显示
  value: { type: [String, Number], default: '-' },
  // 单位（个 / 条 / %），不传就不渲染 <small>
  unit: { type: String, default: '' },
  // 口径说明，写清这个数字怎么统计出来的
  extra: { type: String, default: '' },
  // 底色语义，拼错不告警只丢底色；空串=默认灰底
  tone: { type: String, default: '' },
});
</script>
